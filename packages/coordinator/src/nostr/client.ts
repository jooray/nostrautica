/**
 * Coordinator's Nostr transport (spec §9: interface is Nostr only). Thin wrapper
 * over nostr-tools SimplePool: long-lived subscriptions for the event loop, a
 * one-shot fetch for context/roster reads, and publish.
 *
 * Node needs a WebSocket implementation injected into nostr-tools.
 */
import { SimplePool, useWebSocketImplementation as usePoolWebSocketImplementation } from "nostr-tools/pool";
import { useWebSocketImplementation } from "nostr-tools/relay";
import { normalizeURL } from "nostr-tools/utils";
import { matchFilter } from "nostr-tools/filter";
import type { Event as NostrEvent } from "nostr-tools/core";
import { GuardedWebSocket } from "../net/relay-guard.js";
import { logStamp } from "../log-line.js";

// nostr-tools uses a global WebSocket; provide the SSRF-guarded one for Node (audit
// C4): every relay connection is pinned to a public-address-only lookup, so a relay
// host that resolves to a private/loopback address (or rebinds) is refused at connect.
useWebSocketImplementation(GuardedWebSocket as unknown as typeof globalThis.WebSocket);
// ...and separately for the pool. nostr-tools' pool module keeps its own WebSocket
// reference (>= 2.24), so the call above does not reach it, and SimplePool would
// quietly fall back to Node's global undici WebSocket. That skips the guard, and
// undici re-dispatches `error` synchronously from close(), which recurses through
// nostr-tools' onerror until the stack overflows: 0.8.1 crash-looped on exactly that.
usePoolWebSocketImplementation(GuardedWebSocket as unknown as typeof globalThis.WebSocket);

export interface Filter {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  "#p"?: string[];
  "#d"?: string[];
  "#a"?: string[];
  "#h"?: string[];
}

/** Hard cap on events accumulated by one `fetch()` (audit C3): a hostile relay can
 *  otherwise return an arbitrarily large historical result set that piles up in
 *  memory. Once reached, collection stops and the subscription is closed. */
export const MAX_FETCH_EVENTS = 5000;

function relayLog(msg: string): void {
  const t = logStamp();
  console.log(`[${t}] ${msg}`);
}

/**
 * Per-relay resubscribe backoff (ms); the last entry repeats forever.
 *
 * "Forever" is the point. A relay that was down when the daemon booted and comes
 * back three hours later has to be picked up without a restart — the daemon's
 * subscriptions are the only thing standing between an attendee's join request and
 * nobody ever seeing it.
 */
const RESUBSCRIBE_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

// ── subscription pressure (audit R-2) ────────────────────────────────────────
//
// The daemon held one REQ per long-lived subscription per relay: per installed
// event its E_inbox, its config watcher, its E_id kind-0, its 445 ingest and its
// 30443 watcher, on every relay the event names. Fifteen events put ~60-75
// concurrent REQs on each shared relay, and strfry's default is 20 per
// connection: relay.primal.net and nostr.oxtr.dev answered "too many concurrent
// REQs" ~28,000 times a day, every refused REQ was a subscription that silently
// never ran, and the pressure made publishes time out (the K-7 fork trigger).
//
// So long-lived subscriptions to the same relay are MULTIPLEXED: one REQ carries
// up to MAX_FILTERS_PER_REQ filters, and events are dispatched back to each
// subscriber by matchFilter. One-shot fetches get a per-relay concurrency cap with
// a FIFO queue. A "too many REQs" NOTICE or CLOSED marks the relay degraded:
// fewer fetches at once, no new REQs where an existing one can take the filter,
// and refused REQs are re-sent after a back-off instead of a second later.

/** Filters carried by one multiplexed long-lived REQ. */
export const MAX_FILTERS_PER_REQ = 20;
/** Long-lived REQs per relay before a new filter joins an existing REQ instead. */
export const MAX_LONG_LIVED_REQS_PER_RELAY = 8;
/** One-shot fetch REQs open at once per relay; the rest wait in a queue. With the
 *  long-lived cap this stays under strfry's default of 20 subscriptions. */
export const MAX_FETCH_REQS_PER_RELAY = 8;
/** The fetch cap while a relay is degraded. */
export const DEGRADED_FETCH_REQS_PER_RELAY = 2;
/** How long a "too many REQs" answer keeps a relay degraded. */
export const RELAY_DEGRADED_MS = 5 * 60_000;
/** Re-send delays (ms) for a REQ a relay refused for pressure; the last repeats. */
const REFUSED_REQ_RETRY_MS = [30_000, 60_000, 120_000, 300_000];
/** A brand-new or changed multiplexed REQ waits this long for company, so a burst
 *  of subscribes (a boot, a relay handover) is one REQ rather than many. */
const DEFAULT_REQ_DEBOUNCE_MS = 500;
/** How long a connect may take before the REQ counts as closed and is retried. */
const CONNECT_TIMEOUT_MS = 3_000;

/** A relay telling us it is over its subscription limit, as a NOTICE or a CLOSED. */
export const TOO_MANY_REQS =
  /too many (concurrent )?(reqs?|subscriptions?|subs)\b|max(imum)? (number of )?(concurrent )?(reqs|subscriptions)|subscription limit/i;

/** A long-lived subscription's share of a multiplexed REQ: one filter, one sink. */
interface Member {
  filter: Filter;
  deliver: (event: NostrEvent) => void;
}

/** One multiplexed long-lived REQ on one relay. */
interface Bundle {
  url: string;
  /** Only filters of the same kind set share a REQ, so one busy kind cannot make
   *  every re-send of an unrelated subscription re-download its history. */
  classKey: string;
  members: Map<number, Member>;
  /** The REQ currently on the wire, if any. */
  sub?: { close: () => void };
  /** Bumped on every (re-)send and on close; callbacks of an older REQ are ignored. */
  generation: number;
  /** The relay answered the current REQ with EOSE (never nostr-tools' synthetic one). */
  eosed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  attempt: number;
  closed: boolean;
}

/** Per-relay pressure bookkeeping. */
interface RelayPressure {
  bundles: Bundle[];
  fetchActive: number;
  fetchQueue: Array<{ start: () => void; cancelled: boolean }>;
  degradedUntil: number;
  /** When the degraded state was last logged, and what was suppressed since. */
  loggedAt: number;
  suppressed: number;
  /** Already said that this relay needs more REQs than the cap. */
  overCapLogged: boolean;
}

/** The parameters {@link NostrClient.openReq} hands to one relay-level REQ. */
export interface ReqHandlers {
  onevent: (event: NostrEvent) => void;
  /** The relay sent EOSE for this REQ. Only ever a real EOSE (see {@link realEoseOnly}). */
  oneose: () => void;
  /** The REQ ended without us closing it: refused, connection lost, or never opened. */
  onclose: (reason: string) => void;
  /** nostr-tools re-sent the REQ on a reconnected socket; the relay has not answered it yet. */
  onresend?: () => void;
}

/**
 * Make a nostr-tools subscription report only the relay's own EOSE (audit
 * KIMIK31 R-5).
 *
 * `Subscription.fire()` arms a `baseEoseTimeout` (4.4 s) timer that calls the
 * same `receivedEose()` a protocol EOSE does, so `oneose` cannot tell "the relay
 * answered" from "4.4 s passed". A long-lived bundle uses EOSE as its evidence
 * that the relay accepted the REQ: a "too many REQs" NOTICE names no
 * subscription, so the ones re-sent are those not answered yet. A REQ the relay
 * silently dropped therefore counted as accepted after 4.4 s and was never
 * re-sent. The timer is set synchronously inside `fire()`, so clearing it right
 * after each fire disarms exactly the synthetic path; a reconnect re-fires the
 * subscription, which is reported through `onResend`.
 */
export function realEoseOnly(
  sub: { fire: () => void; eoseTimeoutHandle?: ReturnType<typeof setTimeout> },
  onResend?: () => void,
): void {
  clearTimeout(sub.eoseTimeoutHandle);
  const fire = sub.fire.bind(sub);
  sub.fire = () => {
    fire();
    clearTimeout(sub.eoseTimeoutHandle);
    onResend?.();
  };
}

/**
 * Safety bound on {@link NostrClient.fetchAll}'s dense-cluster stepping (audit
 * B-6): how many CONSECUTIVE pages may add nothing new before the walk gives up.
 * Each such page costs one relay round trip and moves `until` back by a second, so
 * a relay that answers every window with the same events cannot turn the walk into
 * an unbounded crawl. Reset by any page that adds something, so a genuinely long
 * history broken up by a few flooded seconds still completes.
 */
const MAX_NO_PROGRESS_PAGES = 100;

/**
 * Default ceilings on one {@link NostrClient.fetchAll} walk (audit SB-04/SB-132,
 * DS41-027). The walk keeps every event it returns in memory, and both of its
 * callers read public inboxes: anyone can p-tag a gift wrap at the coordinator,
 * and an event's E_inbox lives on relays its organizer chose. Without a ceiling
 * the number of events held was exactly the number an attacker published, so a
 * flood could OOM the daemon at boot, every boot.
 *
 * 50,000 is ten full pages: about 25 wraps per member of a 2,000-person event,
 * well above what a real inbox holds, and well under the daemon's memory cap. The
 * walk is newest-first, so a truncated walk loses the OLDEST history, and it says
 * so in the log. The page ceiling bounds the round trips separately, because a
 * hostile relay can make every page add a single new event.
 */
export const MAX_FETCH_ALL_EVENTS = 50_000;
export const MAX_FETCH_ALL_PAGES = 200;

/**
 * Cross-relay event dedupe with a bounded memory footprint.
 *
 * `SimplePool.subscribe` deduped by id across the relay group for us. Subscribing
 * per relay (so one dead relay can be retried on its own) gives that up, and
 * without it every wrap arrives once per relay: three redundant NIP-44 decrypt
 * attempts per join request on a three-relay event, and a config watcher that
 * re-applies the same 31600 N times.
 *
 * Two generations rather than one unbounded Set: a long-lived subscription runs for
 * weeks. Dedupe is guaranteed over at least the last `limit` ids and at most `2 ×
 * limit`, which is all a stream of relay deliveries needs — anything older than
 * 20k events is being deduped by the coordinator's durable `seen_rumors` ledger
 * anyway. (nostr-tools' own `_knownIds` grows without bound here; this does not.)
 */
class BoundedSeenIds {
  private current = new Set<string>();
  private previous = new Set<string>();
  constructor(private readonly limit = 20_000) {}
  /** True when `id` was already delivered; records it either way. */
  seenBefore(id: string): boolean {
    if (this.current.has(id) || this.previous.has(id)) return true;
    this.current.add(id);
    if (this.current.size >= this.limit) {
      this.previous = this.current;
      this.current = new Set();
    }
    return false;
  }
  /** Un-record `id`, so another relay's copy is delivered after all. */
  forget(id: string): void {
    this.current.delete(id);
    this.previous.delete(id);
  }
}

/**
 * SimplePool that never lets a relay object outlive its place in the pool.
 *
 * nostr-tools keys the pool by URL but hands each relay an `onclose` that deletes
 * the URL — not that relay. And when `ensureRelay` fails it drops the relay from
 * the map without closing it, so a relay that was mid-reconnect, or whose socket
 * finished a slow handshake after the 3 s timeout, carries on outside the pool:
 * connected, pinged every 29 s, and invisible to `close()`. When that orphan later
 * hard-closes, its `onclose` evicts whichever relay now holds the URL, subscriptions
 * and all, and makes another orphan. And `reconnect()` overwrites its timer handle
 * without clearing the old timer, so `close()` alone does not stop a relay that
 * dropped and then timed out. In production this left ~113 connected
 * relay.damus.io orphans and ~4,000 sockets after a day, until the daemon hit its
 * memory cap and aborted. 2.25 closes the timed-out socket; none of the three
 * problems above is fixed upstream.
 *
 * So: a relay may only remove its OWN map entry, and a relay that `ensureRelay`
 * gave up on is closed. Closing it fires its subscriptions' `onclose`, which hands
 * them back to {@link NostrClient.subscribe}'s per-relay retry loop.
 */
export class OrphanSafePool extends SimplePool {
  /** Every NOTICE any relay sends (audit R-2), with the normalized relay url. Unset,
   *  notices go to `console.debug` as nostr-tools does by default. */
  onNotice?: (url: string, message: string) => void;

  /** Every relay url currently in the pool. */
  knownRelayUrls(): string[] {
    return [...this.relays.keys()];
  }

  override ensureRelay(url: string, params?: Parameters<SimplePool["ensureRelay"]>[1]) {
    const key = normalizeURL(url);
    // super's body runs synchronously up to its first await, so the relay it
    // creates or reuses is already in the map when this returns.
    const pending = super.ensureRelay(url, params);
    const relay = this.relays.get(key);
    if (relay) {
      relay.onclose = () => {
        if (this.relays.get(key) === relay) this.relays.delete(key);
      };
      relay.onnotice = (msg: string) => {
        if (this.onNotice) this.onNotice(key, msg);
        else console.debug(`NOTICE from ${key}: ${msg}`);
      };
    }
    return pending.catch((err: unknown) => {
      if (relay && this.relays.get(key) !== relay) {
        relay.onclose = null;
        relay.close();
        // close() cancels only the reconnect timer the relay still holds a handle
        // to. `reconnect()` overwrites that handle without clearing the old timer,
        // so a relay that dropped and then timed out has an earlier timer still
        // armed, and it would call connect() and revive this relay outside the
        // pool. Make that call fail; the timer's own try/catch swallows it.
        relay.connect = () => Promise.reject(new Error(`relay ${key} was retired by the pool`));
      }
      throw err;
    });
  }
}

/**
 * How one relay answered a publish (audit K-7).
 *
 * - `acked`: OK=true, or OK=false with "duplicate:"/"replaced:" (it holds the event).
 * - `rejected`: the relay answered OK=false. It did not store the event.
 * - `timeout`: no OK within the timeout. The relay may have stored it.
 * - `transport`: the connection failed or closed around the send. The relay may
 *   have stored it, and nothing here can tell.
 */
export interface RelayPublishOutcome {
  url: string;
  status: "acked" | "rejected" | "timeout" | "transport";
  reason: string;
}

/** A publish no relay acked. `outcomes` says how each one failed. */
export class PublishFailedError extends Error {
  constructor(
    message: string,
    readonly outcomes: RelayPublishOutcome[],
  ) {
    super(message);
    this.name = "PublishFailedError";
  }
}

/**
 * NIP-01 machine-readable prefixes of an OK=false. Only these are read as the
 * relay's own refusal. Everything else nostr-tools rejects with (the closing
 * socket's reason, a send error, its own "connection failure" strings) says
 * nothing about whether the event reached the relay.
 */
const RELAY_REFUSAL = /^(pow|blocked|rate-limited|invalid|restricted|mute|error|auth-required|payment-required):/i;

function classifyPublishFailure(err: unknown): "rejected" | "timeout" | "transport" {
  if (!(err instanceof Error)) return "transport";
  if (/^publish timed out$/i.test(err.message)) return "timeout";
  // An OK=false with no reason at all arrives as `new Error(undefined)`.
  if (err.message === "" || RELAY_REFUSAL.test(err.message)) return "rejected";
  return "transport";
}

export class NostrClient {
  // Reconnect and keepalive are BOTH off by default in nostr-tools
  // (`AbstractSimplePool`: `enableReconnect = opts.enableReconnect || false`, and
  // `enablePing = opts.enablePing`, i.e. undefined ⇒ falsy). With them off, any
  // socket close takes `AbstractRelay.handleHardClose`'s terminal branch, which
  // drops the relay from the pool and closes EVERY subscription on it — and with
  // no ping there is nothing keeping an idle socket alive through an nginx or NAT
  // timeout in the first place. The daemon's subscriptions are long-lived by
  // design (coordinator inbox, each event's E_inbox, each config watcher, each
  // Marmot watcher), so the failure mode was: one relay drops, the coordinator
  // goes permanently deaf to it, nothing is logged, and only a restart recovers —
  // which is why deploys masked it. The app has always set both explicitly
  // (`packages/app/src/lib/signer/nip46.ts`); the daemon was the outlier.
  // OrphanSafePool, not SimplePool: see its doc comment for what reconnect does to
  // relay objects that fall out of the pool.
  private pool = new OrphanSafePool({ enableReconnect: true, enablePing: true });

  /** Normalized URLs from `relays.exclude`: never dialled (see {@link usable}). */
  private readonly excluded: Set<string>;
  /** Excluded URLs already reported once, so the log names each one a single time. */
  private readonly reportedExcluded = new Set<string>();

  /** Per-relay multiplexing and back-pressure state (audit R-2), by normalized url. */
  private readonly pressure = new Map<string, RelayPressure>();
  private memberSeq = 0;
  private readonly reqDebounceMs: number;
  private readonly now: () => number;

  constructor(
    private readonly defaultRelays: string[],
    opts: { exclude?: string[]; reqDebounceMs?: number; now?: () => number } = {},
  ) {
    this.excluded = new Set((opts.exclude ?? []).map((u) => normalizeURL(u)));
    this.reqDebounceMs = opts.reqDebounceMs ?? DEFAULT_REQ_DEBOUNCE_MS;
    this.now = opts.now ?? (() => Date.now());
    this.pool.onNotice = (url, msg) => this.handleNotice(url, msg);
  }

  private relayPressure(url: string): RelayPressure {
    let p = this.pressure.get(url);
    if (!p) {
      p = { bundles: [], fetchActive: 0, fetchQueue: [], degradedUntil: 0, loggedAt: 0, suppressed: 0, overCapLogged: false };
      this.pressure.set(url, p);
    }
    return p;
  }

  /** True while `url` is backing off after a "too many REQs" answer (audit R-2). */
  isDegraded(url: string): boolean {
    return (this.pressure.get(normalizeURL(url))?.degradedUntil ?? 0) > this.now();
  }

  /** Diagnostics/tests: how many long-lived REQs and fetches are open on `url`. */
  reqCounts(url: string): { longLived: number; fetches: number; queuedFetches: number } {
    const p = this.pressure.get(normalizeURL(url));
    return {
      longLived: p?.bundles.filter((b) => b.sub).length ?? 0,
      fetches: p?.fetchActive ?? 0,
      queuedFetches: p?.fetchQueue.filter((q) => !q.cancelled).length ?? 0,
    };
  }

  /**
   * A relay said it is over its subscription limit (audit R-2). Mark it degraded
   * for {@link RELAY_DEGRADED_MS}, say so once per window, and re-send — later —
   * every long-lived REQ on it that had not reached EOSE yet: a NOTICE names no
   * subscription, and a REQ the relay refused gets neither events nor EOSE, so
   * "not answered yet" is the best evidence of which one it dropped.
   */
  private handleNotice(url: string, msg: string): void {
    if (!TOO_MANY_REQS.test(msg)) {
      console.debug(`NOTICE from ${url}: ${msg}`);
      return;
    }
    this.noteBackpressure(url, msg);
    for (const b of this.relayPressure(url).bundles) {
      if (b.sub && !b.eosed && !b.closed) this.requeueRefused(b);
    }
  }

  private noteBackpressure(url: string, msg: string): void {
    const p = this.relayPressure(url);
    const now = this.now();
    p.degradedUntil = Math.max(p.degradedUntil, now + RELAY_DEGRADED_MS);
    if (now - p.loggedAt < RELAY_DEGRADED_MS) {
      p.suppressed++;
      return;
    }
    const open = p.bundles.filter((b) => b.sub).length;
    relayLog(
      `[relay] ${url} is refusing REQs ("${msg.slice(0, 120)}") — backing off for ${RELAY_DEGRADED_MS / 60_000} min: ` +
        `at most ${DEGRADED_FETCH_REQS_PER_RELAY} fetches at a time and refused subscriptions re-sent later ` +
        `(${open} long-lived REQ(s), ${p.fetchActive} fetch(es) open)` +
        (p.suppressed > 0 ? `; ${p.suppressed} more refusal(s) since the last line` : ""),
    );
    p.loggedAt = now;
    p.suppressed = 0;
  }

  /** Drop a REQ the relay refused and send it again after a pressure back-off. */
  private requeueRefused(b: Bundle): void {
    const old = b.sub;
    b.sub = undefined;
    b.generation++;
    try {
      old?.close();
    } catch {
      /* already gone */
    }
    const delay = REFUSED_REQ_RETRY_MS[Math.min(b.attempt, REFUSED_REQ_RETRY_MS.length - 1)]!;
    b.attempt++;
    this.scheduleFire(b, delay, true);
  }

  /**
   * Open one relay-level REQ carrying `filters`. The only place a long-lived REQ
   * touches nostr-tools, so tests replace this method instead of faking a pool.
   *
   * nostr-tools' reconnect rewrites every filter of a re-sent REQ to
   * `since = <newest created_at seen> + 1`. With several filters in one REQ, one
   * filter's fresh event would cut the history of all the others, and for gift
   * wraps, whose created_at is randomized into the past (NIP-59), even a lone
   * filter loses live events that way (see R-45). So the rewrite is switched off
   * for these subscriptions: a reconnect re-reads each filter's own window, and
   * the per-subscriber dedupe drops what was already delivered.
   */
  protected openReq(url: string, filters: Filter[], handlers: ReqHandlers): { close: () => void } {
    let cancelled = false;
    let sub: { close: (reason?: string) => void } | undefined;
    this.pool.ensureRelay(url, { connectionTimeout: CONNECT_TIMEOUT_MS }).then(
      (relay) => {
        if (cancelled) return;
        try {
          const s = relay.subscribe(filters as any, {
            onevent: (e: NostrEvent) => handlers.onevent(e),
            oneose: () => handlers.oneose(),
            onclose: (reason: string) => {
              if (!cancelled) handlers.onclose(reason);
            },
          });
          Object.defineProperty(s, "lastEmitted", { get: () => undefined, set: () => {}, configurable: true });
          realEoseOnly(s as any, () => {
            if (!cancelled) handlers.onresend?.();
          });
          sub = s;
        } catch (err) {
          handlers.onclose(err instanceof Error ? err.message : String(err));
        }
      },
      (err: unknown) => {
        if (!cancelled) handlers.onclose(err instanceof Error ? err.message : String(err));
      },
    );
    return {
      close: () => {
        cancelled = true;
        try {
          sub?.close();
        } catch {
          /* already closed */
        }
      },
    };
  }

  /** Where a new long-lived filter of `classKey` goes on `url` (see the R-2 notes above). */
  private bundleFor(url: string, classKey: string): Bundle {
    const p = this.relayPressure(url);
    const sameClass = p.bundles.filter((b) => b.classKey === classKey && b.members.size < MAX_FILTERS_PER_REQ);
    // 1. A REQ of this class that has not gone out yet: joining it is free.
    const pending = sameClass.find((b) => !b.sub);
    if (pending) return pending;
    // 2. Room for another REQ, and the relay is not pushing back: a new REQ, so no
    //    REQ already on the wire has to be re-sent (which re-reads its history).
    const degraded = p.degradedUntil > this.now();
    if (!degraded && p.bundles.length < MAX_LONG_LIVED_REQS_PER_RELAY) return this.newBundle(p, url, classKey);
    // 3. Join the emptiest REQ of this class; it is re-sent with the filter added.
    const emptiest = sameClass.sort((a, b) => a.members.size - b.members.size)[0];
    if (emptiest) return emptiest;
    // 4. Nowhere to put it. A subscription is never dropped: one more REQ, said once.
    if (p.bundles.length >= MAX_LONG_LIVED_REQS_PER_RELAY && !p.overCapLogged) {
      p.overCapLogged = true;
      relayLog(
        `[relay] ${url}: more than ${MAX_LONG_LIVED_REQS_PER_RELAY} long-lived REQs needed (${p.bundles.length + 1}) — opening another rather than dropping a subscription`,
      );
    }
    return this.newBundle(p, url, classKey);
  }

  private newBundle(p: RelayPressure, url: string, classKey: string): Bundle {
    const b: Bundle = { url, classKey, members: new Map(), generation: 0, eosed: false, attempt: 0, closed: false };
    p.bundles.push(b);
    return b;
  }

  /** (Re-)send `b` after `delayMs`. A pending send is kept unless `replace`. */
  private scheduleFire(b: Bundle, delayMs: number, replace = false): void {
    if (b.closed) return;
    if (b.timer) {
      if (!replace) return;
      clearTimeout(b.timer);
    }
    const timer = setTimeout(() => {
      if (b.timer === timer) b.timer = undefined;
      this.fire(b);
    }, delayMs);
    if (typeof (timer as any).unref === "function") (timer as any).unref();
    b.timer = timer;
  }

  /** Put `b`'s current filters on the wire: open the new REQ, then close the old. */
  private fire(b: Bundle): void {
    if (b.closed) return;
    if (b.members.size === 0) {
      this.closeBundle(b);
      return;
    }
    const gen = ++b.generation;
    const old = b.sub;
    b.eosed = false;
    // Fresh copies (audit R-45): nostr-tools keeps the array it is given.
    const filters = [...b.members.values()].map((m) => ({ ...m.filter }));
    b.sub = this.openReq(b.url, filters, {
      onevent: (e) => {
        if (gen !== b.generation) return;
        // Every member gets its own try (audit KIMIK31 R-4). One subscriber's throw
        // used to end this loop, and nostr-tools swallows it, so every later member
        // of the shared REQ lost the event for good.
        for (const m of b.members.values()) {
          if (!matchFilter(m.filter as any, e)) continue;
          try {
            m.deliver(e);
          } catch (err) {
            relayLog(
              `[relay] a subscriber on ${b.url} threw on event ${e.id.slice(0, 8)} (kind ${e.kind}): ` +
                `${err instanceof Error ? err.message : String(err)} — delivering to the rest`,
            );
          }
        }
      },
      oneose: () => {
        if (gen !== b.generation) return;
        b.eosed = true;
        // EOSE is the relay answering, so the back-off ladder starts over.
        b.attempt = 0;
      },
      onresend: () => {
        // A reconnect put the REQ on the wire again: until the relay answers it,
        // it is as unconfirmed as a brand-new one.
        if (gen === b.generation) b.eosed = false;
      },
      onclose: (reason) => {
        if (gen !== b.generation || b.closed) return;
        b.sub = undefined;
        if (TOO_MANY_REQS.test(reason)) {
          this.noteBackpressure(b.url, reason);
          b.generation++;
          const delay = REFUSED_REQ_RETRY_MS[Math.min(b.attempt, REFUSED_REQ_RETRY_MS.length - 1)]!;
          b.attempt++;
          this.scheduleFire(b, delay, true);
          return;
        }
        const delay = RESUBSCRIBE_BACKOFF_MS[Math.min(b.attempt, RESUBSCRIBE_BACKOFF_MS.length - 1)]!;
        // Never silent: an operator diagnosing a stuck event has to be able to see
        // that this relay went away and that we are still trying.
        relayLog(
          `[relay] subscription closed on ${b.url}: ${reason || "no reason given"} — resubscribing in ${delay}ms (attempt ${b.attempt + 1}, ${b.members.size} filter(s))`,
        );
        b.attempt++;
        this.scheduleFire(b, delay, true);
      },
    });
    old?.close();
  }

  private closeBundle(b: Bundle): void {
    if (b.closed) return;
    b.closed = true;
    b.generation++;
    if (b.timer) clearTimeout(b.timer);
    b.timer = undefined;
    b.sub?.close();
    b.sub = undefined;
    const p = this.pressure.get(b.url);
    if (p) p.bundles = p.bundles.filter((x) => x !== b);
  }

  /**
   * Run `start` once `url` has a free fetch slot (audit R-2). Returns a cancel for a
   * fetch that finishes (or times out) while still queued. `start` receives the
   * slot's release, which must be called exactly once.
   */
  private withFetchSlot(url: string, start: (release: () => void) => void): () => void {
    const p = this.relayPressure(url);
    const entry = { start: () => {}, cancelled: false };
    entry.start = () => {
      p.fetchActive++;
      let released = false;
      start(() => {
        if (released) return;
        released = true;
        p.fetchActive--;
        this.pumpFetches(p);
      });
    };
    p.fetchQueue.push(entry);
    this.pumpFetches(p);
    return () => {
      entry.cancelled = true;
    };
  }

  private pumpFetches(p: RelayPressure): void {
    const cap = p.degradedUntil > this.now() ? DEGRADED_FETCH_REQS_PER_RELAY : MAX_FETCH_REQS_PER_RELAY;
    while (p.fetchActive < cap && p.fetchQueue.length > 0) {
      const next = p.fetchQueue.shift()!;
      if (!next.cancelled) next.start();
    }
  }

  /**
   * `relays` minus the excluded ones. Every dial goes through here, because relay
   * sets arrive from places the operator does not control: an event's
   * organizer-signed config, a grant, an attendee's inbox list.
   *
   * If exclusion would leave nothing, the original set is kept. An event whose
   * only relays are excluded would otherwise be one the coordinator can never
   * hear, which is worse than paying for a bad relay.
   */
  private usable(relays: string[]): string[] {
    if (this.excluded.size === 0) return relays;
    const kept: string[] = [];
    for (const url of relays) {
      const key = normalizeURL(url);
      if (!this.excluded.has(key)) {
        kept.push(url);
      } else if (!this.reportedExcluded.has(key)) {
        this.reportedExcluded.add(key);
        relayLog(`[relay] not dialling ${key}: listed in relays.exclude`);
      }
    }
    if (kept.length === 0 && relays.length > 0) {
      relayLog(`[relay] every relay in [${relays.join(", ")}] is excluded — using them anyway rather than none`);
      return relays;
    }
    return kept;
  }

  /**
   * Long-lived subscription; returns a closer.
   *
   * ONE SUBSCRIPTION PER RELAY, retried individually. `SimplePool.subscribe` takes
   * the whole relay set as a group, and nostr-tools' reconnect only ever covers a
   * socket that was ESTABLISHED and then dropped: when `ensureRelay` fails at
   * subscribe time — the relay is down, or slower than `maxWaitForConnection`
   * (3 s) — the pool sets `skipReconnection = true`, calls the group's
   * `handleClose` for that one relay, and never touches it again. Nothing retried
   * it, and because the group's `onclose` only fires once EVERY relay has closed,
   * nothing logged it either. A relay that was down for the ten seconds the daemon
   * happened to boot in was silently dropped until the next restart, which on an
   * event whose relay set is one relay long means every join request goes nowhere.
   *
   * Per relay we therefore keep our own backoff and resubscribe forever. The
   * pool's own reconnect still handles the "was up, socket dropped" case (it does
   * not surface an `onclose` in that branch, so the two cannot double up), and a
   * deliberate close stops both.
   *
   * MULTIPLEXED per relay (audit R-2). The filter joins a shared REQ on each relay
   * with other subscriptions of the same kind set (see `bundleFor`), and events
   * come back to this subscriber only when they match its own filter. Retry,
   * back-off and back-pressure are per shared REQ. The dedupe across relays is per
   * subscriber, as before.
   */
  subscribe(
    filter: Filter,
    onEvent: (event: NostrEvent) => void,
    relays: string[] = this.defaultRelays,
  ): () => void {
    const seen = new BoundedSeenIds();
    let closed = false;
    const deliver = (e: NostrEvent) => {
      // Per subscriber, across relays: without it every wrap is handled once per relay.
      if (closed || seen.seenBefore(e.id)) return;
      try {
        onEvent(e);
      } catch (err) {
        // Not consumed: another relay's copy of this event gets another go.
        seen.forget(e.id);
        throw err;
      }
    };
    const classKey = JSON.stringify([...(filter.kinds ?? [])].sort((a, b) => a - b));
    const joined: Array<{ bundle: Bundle; id: number }> = [];
    const urls = new Set<string>();
    for (const url of this.usable(relays)) urls.add(normalizeURL(url));
    for (const url of urls) {
      const bundle = this.bundleFor(url, classKey);
      const id = ++this.memberSeq;
      bundle.members.set(id, { filter: { ...filter }, deliver });
      joined.push({ bundle, id });
      // A REQ already on the wire is re-sent with the new filter; a pending one
      // simply goes out with it. Both after the debounce.
      this.scheduleFire(bundle, this.reqDebounceMs);
    }
    return () => {
      if (closed) return;
      closed = true;
      for (const { bundle, id } of joined) {
        bundle.members.delete(id);
        if (bundle.members.size === 0) this.closeBundle(bundle);
        // Re-sent without the filter, so the relay stops serving it. Debounced, so
        // a make-before-break replacement (open new, close old) is one re-send.
        else this.scheduleFire(bundle, this.reqDebounceMs);
      }
    };
  }

  /**
   * PAGINATED full-history fetch (audit R4): the one-shot {@link fetch} stops at the
   * {@link MAX_FETCH_EVENTS} cap and SILENTLY TRUNCATES, so an adversary who floods a
   * public inbox with kind-1059 wraps can crowd a legitimate older install/join out of
   * startup recovery. This walks the whole history in `until`-windowed pages, bounding
   * each relay response to one page and the whole walk to `maxTotal` events (it
   * returns everything it collected, so that is the memory bound), deduping across
   * pages, and detecting completeness
   * (see Termination below). Each page's window is `until = <oldest seen> +
   * overlapSec` so an event exactly on a page boundary is never skipped (deduped by id).
   *
   * Termination: stops when a page comes back empty, or short with nothing new in
   * it (complete), or at `maxTotal` / `maxPages` (hard safety bounds, logged). A
   * full page that adds no NEW events does NOT stop the walk — see below.
   * Callers process every returned event through the normal seen-ledger-deduped
   * path, so re-fetched boundary/overlap events are free.
   *
   * A short page is NOT on its own the end of history (audit DS41-026). `fetch()`
   * settles on EOSE or on its timeout alike, and nostr-tools fires a synthetic EOSE
   * after 4.4 s on a relay that has not answered, so a slow relay's partial page
   * looks exactly like a complete one. The walk therefore asks once more below the
   * short page's oldest event, and only a page that brings nothing new ends it.
   * That costs one extra round trip per walk.
   */
  async fetchAll(
    filter: Filter,
    relays: string[] = this.defaultRelays,
    opts: { pageSize?: number; overlapSec?: number; maxTotal?: number; maxPages?: number; timeoutMs?: number } = {},
  ): Promise<NostrEvent[]> {
    const pageSize = opts.pageSize ?? MAX_FETCH_EVENTS;
    const overlapSec = opts.overlapSec ?? 1;
    const maxTotal = opts.maxTotal ?? MAX_FETCH_ALL_EVENTS;
    const maxPages = opts.maxPages ?? MAX_FETCH_ALL_PAGES;
    const timeoutMs = opts.timeoutMs ?? 5000;
    const seen = new Set<string>();
    const all: NostrEvent[] = [];
    let until = filter.until;
    let pages = 0;
    // Consecutive pages that added nothing (see the cluster step below). Each one
    // costs a relay round trip and moves `until` back by a second, so a relay
    // serving nothing but duplicates can't turn the walk into an unbounded crawl.
    let noProgress = 0;
    for (;;) {
      const page = await this.fetch({ ...filter, until, limit: pageSize }, relays, timeoutMs, pageSize);
      pages++;
      let added = 0;
      let oldest = Number.POSITIVE_INFINITY;
      for (const e of page) {
        if (e.created_at < oldest) oldest = e.created_at;
        if (all.length >= maxTotal) break;
        if (!seen.has(e.id)) {
          seen.add(e.id);
          all.push(e);
          added++;
        }
      }
      // Complete: nothing at all, or a short page that brought nothing new.
      if (page.length === 0) break;
      if (page.length < pageSize && added === 0) break;
      if (!Number.isFinite(oldest)) break; // defensive: a page with no timestamps
      if (all.length >= maxTotal || pages >= maxPages) {
        relayLog(
          `[relay] fetchAll: stopped at ${all.length} event(s) after ${pages} page(s) — the ${all.length >= maxTotal ? `${maxTotal}-event` : `${maxPages}-page`} ceiling; anything older than created_at ${oldest} was NOT fetched`,
        );
        break;
      }
      // Next window: at/just after the oldest we saw, WITH overlap (deduped by id).
      //
      // Unless nothing new arrived. A full page of already-seen ids means the
      // `oldest + overlapSec` window cannot move: that is what a dense same-second
      // cluster looks like from here (more than `pageSize` events sharing one
      // `created_at`, served newest-first), and it needs no attacker — one busy
      // second of a live event's inbox does it. Stopping there was the bug (audit
      // B-6): the walk returned the cluster and reported itself complete, so every
      // OLDER event in the history — an install grant, a join request from an hour
      // ago — was never fetched, which is the exact silent-truncation failure this
      // pagination was written to close. Step strictly BELOW the cluster instead.
      // That can skip an unseen event sharing `oldest` exactly, which is a far
      // smaller loss than abandoning all older history, and the `until` value
      // strictly decreases so the walk still terminates.
      if (added === 0 && ++noProgress > MAX_NO_PROGRESS_PAGES) {
        relayLog(
          `[relay] fetchAll: ${MAX_NO_PROGRESS_PAGES} consecutive pages added nothing new — stopping the walk at until=${until}`,
        );
        break;
      }
      if (added > 0) noProgress = 0;
      let nextUntil = added === 0 ? oldest - 1 : oldest + overlapSec;
      // The overlap window would not move (every event on the page shares the
      // current `until` second): step strictly below it, as for a dense cluster,
      // so `until` always decreases and the walk terminates.
      if (until !== undefined && nextUntil >= until) nextUntil = oldest - 1;
      if (until !== undefined && nextUntil >= until) break; // defensive
      until = nextUntil;
    }
    return all;
  }

  /**
   * One-shot fetch: collect events until every relay reached EOSE (or closed), or
   * until the timeout, then close.
   *
   * One REQ per relay, each behind that relay's fetch slot (audit R-2): a relay
   * already serving MAX_FETCH_REQS_PER_RELAY fetches (two while it is degraded)
   * queues the rest instead of being sent REQs it will refuse. The timeout covers
   * the wait in the queue too, so a fetch never takes longer than it did; a relay
   * that gets no slot in time simply contributes nothing to this fetch, like one
   * that did not answer.
   */
  fetch(
    filter: Filter,
    relays: string[] = this.defaultRelays,
    timeoutMs = 5000,
    maxEvents = MAX_FETCH_EVENTS,
  ): Promise<NostrEvent[]> {
    return new Promise((resolve) => {
      const events: NostrEvent[] = [];
      const seen = new Set<string>();
      const urls = [...new Set(this.usable(relays).map((u) => normalizeURL(u)))];
      const subs: Array<{ close: () => void }> = [];
      const releases: Array<() => void> = [];
      const cancels: Array<() => void> = [];
      let outstanding = urls.length;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        for (const c of cancels) c();
        for (const sub of subs) {
          try {
            sub.close();
          } catch {
            /* already closed */
          }
        }
        for (const r of releases) r();
        resolve(events);
      };
      const timer = setTimeout(done, timeoutMs);
      if (outstanding === 0) {
        done();
        return;
      }
      for (const url of urls) {
        cancels.push(
          this.withFetchSlot(url, (release) => {
            if (finished) {
              release();
              return;
            }
            releases.push(release);
            let settled = false;
            const relayDone = () => {
              if (settled) return;
              settled = true;
              if (--outstanding === 0) done();
            };
            // Copied for the same reason as in subscribe() (audit R-45): the pool may
            // write `since` into it, and the caller's filter is not ours to edit.
            const sub = this.pool.subscribe([url], { ...filter } as any, {
              onevent: (e: NostrEvent) => {
                if (finished || seen.has(e.id)) return;
                seen.add(e.id);
                events.push(e);
                // Bounded accumulation (audit C3): stop once the cap is hit so a relay
                // flooding history can't grow this array without limit.
                if (events.length >= maxEvents) done();
              },
              oneose: relayDone,
              onclose: (reasons: { url: string; reason: string }[] | string) => {
                const why = Array.isArray(reasons) ? reasons.map((r) => r?.reason ?? "").join("; ") : String(reasons ?? "");
                if (TOO_MANY_REQS.test(why)) this.noteBackpressure(url, why);
                relayDone();
              },
            });
            subs.push(sub);
          }),
        );
      }
    });
  }

  /**
   * Ask each relay whether it holds the event `id`, and say which relays actually
   * ANSWERED (audit KIMIK31 C-2). `fetch()` cannot: it settles on EOSE and on its
   * timeout alike, and nostr-tools fires a synthetic EOSE after 4.4 s on a relay
   * that never replied, so "no events" there does not mean "not stored".
   *
   * Here the subscription's `maxWait` (nostr-tools' EOSE timeout) is set past our
   * own deadline, so any EOSE seen before that deadline came from the relay. A
   * relay that closed the REQ, never got a fetch slot, or did not reach EOSE in
   * time is `unanswered`. Excluded relays are not dialled, so they are not listed.
   * Never rejects.
   */
  lookupEvent(
    id: string,
    relays: string[],
    timeoutMs = 10_000,
  ): Promise<{ found: boolean; unanswered: string[] }> {
    return new Promise((resolve) => {
      const urls = [...new Set(this.usable(relays).map((u) => normalizeURL(u)))];
      // Nothing to ask is not "nobody has it".
      if (urls.length === 0) {
        resolve({ found: false, unanswered: relays.length ? [...relays] : ["(no relays)"] });
        return;
      }
      const pending = new Set(urls);
      const subs: Array<{ close: () => void }> = [];
      const releases: Array<() => void> = [];
      const cancels: Array<() => void> = [];
      let finished = false;
      const done = (found: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        for (const c of cancels) c();
        for (const sub of subs) {
          try {
            sub.close();
          } catch {
            /* already closed */
          }
        }
        for (const r of releases) r();
        resolve({ found, unanswered: [...pending] });
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      for (const url of urls) {
        cancels.push(
          this.withFetchSlot(url, (release) => {
            if (finished) {
              release();
              return;
            }
            releases.push(release);
            const sub = this.pool.subscribe([url], { ids: [id] } as any, {
              maxWait: timeoutMs * 2,
              onevent: (e: NostrEvent) => {
                if (e.id === id) done(true);
              },
              oneose: () => {
                pending.delete(url);
                if (pending.size === 0) done(false);
              },
              onclose: (reasons: { url: string; reason: string }[] | string) => {
                const why = Array.isArray(reasons) ? reasons.map((r) => r?.reason ?? "").join("; ") : String(reasons ?? "");
                if (TOO_MANY_REQS.test(why)) this.noteBackpressure(url, why);
              },
            } as any);
            subs.push(sub);
          }),
        );
      }
    });
  }

  /**
   * Prove a relay set is usable BEFORE a make-before-break handover promotes it
   * (audit C9). Opens a cheap short-lived subscription and resolves `true` as soon
   * as ANY relay in the set connects and reaches EOSE (or returns an event);
   * resolves `false` if none does before `timeoutMs`. A typo'd or dead relay set
   * therefore never replaces a healthy subscription — the caller keeps the
   * last-known-good relays live until this returns true.
   */
  probe(candidates: string[], timeoutMs = 5000): Promise<boolean> {
    // Strict here, unlike usable(): a candidate set that is excluded in full is
    // not one to hand over to, so it never "proves" itself usable.
    const relays = candidates.filter((u) => !this.excluded.has(normalizeURL(u)));
    if (relays.length === 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          sub.close();
        } catch {
          /* already closed */
        }
        resolve(v);
      };
      // limit:0 asks only for EOSE (no historical events) — the cheapest possible
      // liveness probe. Reaching EOSE proves a relay connection was established.
      const sub = this.pool.subscribe(relays, { kinds: [1], limit: 0 } as any, {
        onevent: () => finish(true),
        oneose: () => finish(true),
      });
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  /**
   * Publish a signed event to the given relays; resolves as soon as ANY relay
   * accepts it, rejects only when every relay refused.
   *
   * Two things used to be thrown away here, both of them the answer to a question
   * an operator or the coordinator would later ask.
   *
   * 1. `Promise.any` resolved on the first ack and the code then read a `replaced`
   *    variable that the OTHER relays' handlers were still racing to write. A relay
   *    answering "replaced: have newer event" a few milliseconds after a faster
   *    relay's plain OK set the flag into a value nobody would ever read again, so
   *    the §3.1 reconciliation that exists for exactly that case never fired and a
   *    genuinely-newest event could be silently dropped.
   * 2. When every relay failed, `Promise.any` rejects with an `AggregateError`
   *    whose `.message` is the fixed string "All promises were rejected". That
   *    string — carrying no relay URL and no reason — is what reached the daemon
   *    log and the organizer's 21606 status notice, while the actual per-relay
   *    reasons sat unread in `err.errors[]`.
   *
   * So: EVERY relay's outcome is now recorded — each publish promise is wrapped so
   * it can never reject, and all of them are allowed to settle — while the caller is
   * still resolved by the first ack rather than made to wait for the slowest relay — a stalled-but-connected relay costs
   * nostr-tools' full 4.4s publish timeout, and the daemon publishes many events
   * per pipeline run.
   *
   * The consequence of that choice is deliberate and bounded: a "replaced" answer
   * arriving AFTER the first ack cannot be in the returned flag, so it is logged
   * loudly instead. It is self-correcting — the competing event is still newer on
   * that relay, so the next publish to the same coordinate hits "replaced" again,
   * this time with a fair chance of being the first outcome seen.
   *
   * 3. A total failure said nothing about HOW each relay failed (audit K-7). "The
   *    relay answered OK=false" means it did not store the event; "the OK never
   *    came" or "the socket died after we sent it" means it may well have. Marmot
   *    needs that difference: rolling back a commit that a relay quietly stored
   *    forks the coordinator off its own group. So a total failure now rejects
   *    with a {@link PublishFailedError} whose `outcomes` classify every relay,
   *    and a success reports which relays had acked by then.
   *
   * `opts.timeoutMs` replaces nostr-tools' 4.4 s per-relay OK timeout for this one
   * publish. Group commits use it: an OK arriving after 4.4 s is still an OK, and
   * counting it as a failure is what turned a slow relay into a fork.
   */
  async publish(
    event: NostrEvent,
    requested: string[] = this.defaultRelays,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ replaced?: boolean; acked?: string[] }> {
    // One entry per NORMALIZED url (audit DS41-025). nostr-tools' pool rejects a
    // repeat spelling of a url already in the list with the bare string
    // "duplicate url", in the same tick and before anything is sent. Event relays
    // are stored without a trailing slash and `relays.default` with one, so
    // `wss://nos.lol` and `wss://nos.lol/` both reach here in normal config, and
    // that synthetic rejection matched the relay "duplicate:" ack below: publish
    // resolved "success" before any relay had answered at all.
    const relays: string[] = [];
    const keys = new Set<string>();
    for (const url of this.usable(requested)) {
      const key = normalizeURL(url);
      if (keys.has(key)) continue;
      keys.add(key);
      relays.push(url);
    }
    type Outcome = {
      url: string;
      ok: boolean;
      replaced: boolean;
      reason: string;
      status: RelayPublishOutcome["status"];
    };
    let settledCount = 0;
    let resolvedToCaller = false;
    const outcomes: Outcome[] = [];

    const classify = (url: string, err: unknown): Outcome => {
      // OK=false with "duplicate"/"replaced" means the relay already holds this
      // event (or a newer version of the addressable coordinate) — the data is
      // durably there, which is what publish promises. Burst republishes of 31605
      // lists otherwise fail every retry against strfry's "replaced: have newer event".
      const reason = String((err as Error)?.message ?? err);
      // Only a RELAY's answer can be an ack. nostr-tools rejects with an Error
      // carrying the relay's OK reason; its own client-side refusals ("duplicate
      // url", "connection skipped by …") are bare strings and were never sent.
      if (err instanceof Error && /\b(duplicate|replaced)\b/i.test(reason)) {
        console.debug(
          `[nostr] kind ${event.kind} ${event.id.slice(0, 8)} already-stored on ${url} (${reason.slice(0, 80)}) — treating as success`,
        );
        // A "replaced: have newer" (not a plain "duplicate") means a competing event
        // superseded ours — flag it so the coordinator reconciles (audit COORD-27):
        // with clock skew this can otherwise silently drop the newest event.
        return { url, ok: true, replaced: /\breplaced\b/i.test(reason), reason, status: "acked" };
      }
      return { url, ok: false, replaced: false, reason, status: classifyPublishFailure(err) };
    };

    // One promise per relay, in the order given.
    const wrapped = this.relayPublishes(relays, event, opts.timeoutMs).map((p, i) => {
      const url = relays[i] ?? "(unknown relay)";
      return p.then(
        (): Outcome => ({ url, ok: true, replaced: false, reason: "OK", status: "acked" }),
        (err: unknown): Outcome => classify(url, err),
      );
    });

    return await new Promise<{ replaced?: boolean; acked?: string[] }>((resolve, reject) => {
      if (wrapped.length === 0) {
        reject(new Error(`publish of kind ${event.kind} ${event.id.slice(0, 8)}: no relays configured`));
        return;
      }
      for (const w of wrapped) {
        // Never rejects (both arms of the `.then` above return an Outcome), so this
        // bookkeeping cannot itself produce an unhandled rejection.
        void w.then((o) => {
          outcomes.push(o);
          settledCount++;
          if (o.ok && !resolvedToCaller) {
            resolvedToCaller = true;
            // Whatever is known AT THIS MOMENT — including a "replaced" that landed
            // in the same tick as, or before, the first plain ack.
            resolve({
              replaced: outcomes.some((x) => x.replaced),
              acked: outcomes.filter((x) => x.ok).map((x) => x.url),
            });
          } else if (o.replaced && resolvedToCaller) {
            console.warn(
              `[nostr] kind ${event.kind} ${event.id.slice(0, 8)}: ${o.url} answered "replaced/have newer" AFTER ` +
                "another relay had already acked — reconciliation not triggered for this publish; " +
                "the next publish to this coordinate will see it again",
            );
          }
          if (settledCount === wrapped.length && !resolvedToCaller) {
            // Total failure. Join the per-relay reasons: this message is what the
            // operator's log and the organizer's status notice actually show.
            const why = outcomes.map((x) => `${x.url}: ${x.reason}`).join("; ");
            reject(
              new PublishFailedError(
                `publish of kind ${event.kind} ${event.id.slice(0, 8)} failed on all ${wrapped.length} relay(s) — ${why}`,
                outcomes.map(({ url, status, reason }) => ({ url, status, reason })),
              ),
            );
          }
        });
      }
    });
  }

  /**
   * One publish promise per relay. Without `timeoutMs` this is nostr-tools' own
   * `pool.publish`. With it, the same steps by hand (connect through the pool,
   * then `relay.publish`), because the OK timeout is a property of the shared
   * relay object and the pool has no per-call override. `relay.publish` reads it
   * only in its synchronous prologue, where the timer is armed, so setting it
   * around that one call cannot leak into a concurrent publish on the same relay.
   * Rejections keep the pool's shapes: a connect failure is a bare string, a relay
   * answer or a timeout an Error.
   */
  private relayPublishes(relays: string[], event: NostrEvent, timeoutMs?: number): Promise<unknown>[] {
    if (!timeoutMs) return this.pool.publish(relays, event);
    return relays.map(async (url) => {
      let relay: Awaited<ReturnType<OrphanSafePool["ensureRelay"]>>;
      try {
        relay = await this.pool.ensureRelay(url, { connectionTimeout: 3_000 });
      } catch (err) {
        throw "connection failure: " + String(err);
      }
      const previous = relay.publishTimeout;
      relay.publishTimeout = timeoutMs;
      let sent: Promise<string>;
      try {
        sent = relay.publish(event);
      } finally {
        relay.publishTimeout = previous;
      }
      return sent;
    });
  }

  /** Close every relay the pool holds, not only the defaults (audit SB-33): each
   *  event's E_inbox/config/chat subscriptions run on its own config relays. */
  close(): void {
    this.pool.close([...new Set([...this.defaultRelays, ...this.pool.knownRelayUrls()])]);
  }
}

export type { NostrEvent };
