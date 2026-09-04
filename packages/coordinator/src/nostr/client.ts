/**
 * Coordinator's Nostr transport (spec §9: interface is Nostr only). Thin wrapper
 * over nostr-tools SimplePool: long-lived subscriptions for the event loop, a
 * one-shot fetch for context/roster reads, and publish.
 *
 * Node needs a WebSocket implementation injected into nostr-tools.
 */
import { SimplePool } from "nostr-tools/pool";
import { useWebSocketImplementation } from "nostr-tools/relay";
import type { Event as NostrEvent } from "nostr-tools/core";
import { GuardedWebSocket } from "../net/relay-guard.js";

// nostr-tools uses a global WebSocket; provide the SSRF-guarded one for Node (audit
// C4): every relay connection is pinned to a public-address-only lookup, so a relay
// host that resolves to a private/loopback address (or rebinds) is refused at connect.
useWebSocketImplementation(GuardedWebSocket as unknown as typeof globalThis.WebSocket);

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
}

/** Hard cap on events accumulated by one `fetch()` (audit C3): a hostile relay can
 *  otherwise return an arbitrarily large historical result set that piles up in
 *  memory. Once reached, collection stops and the subscription is closed. */
export const MAX_FETCH_EVENTS = 5000;

function relayLog(msg: string): void {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
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
  private pool = new SimplePool({ enableReconnect: true, enablePing: true });

  constructor(private readonly defaultRelays: string[]) {}

  /** Long-lived subscription; returns a closer. */
  subscribe(
    filter: Filter,
    onEvent: (event: NostrEvent) => void,
    relays: string[] = this.defaultRelays,
  ): () => void {
    // `onclose` fires once every relay in the group has closed — including when we
    // close deliberately (`SubCloser.close()` closes each relay sub, which lands in
    // the same handler). Only an UNPROMPTED close is worth a line; the coordinator
    // re-subscribes on every relay-set change, and logging those would spam a log
    // that is already never rotated.
    let closingDeliberately = false;
    const sub = this.pool.subscribe(relays, filter as any, {
      onevent: (e: NostrEvent) => onEvent(e),
      // A drop is now recoverable (the pool reconnects and resubscribes from
      // `since = lastEmitted + 1`), but it must never again be SILENT: an
      // operator diagnosing a stuck event needs to see that the wire went away.
      onclose: (reasons: string[]) => {
        if (closingDeliberately) return;
        const why = reasons.filter(Boolean).join("; ") || "no reason given";
        relayLog(`[relay] subscription dropped on ${relays.join(", ")}: ${why}`);
      },
    });
    return () => {
      closingDeliberately = true;
      sub.close();
    };
  }

  /**
   * PAGINATED full-history fetch (audit R4): the one-shot {@link fetch} stops at the
   * {@link MAX_FETCH_EVENTS} cap and SILENTLY TRUNCATES, so an adversary who floods a
   * public inbox with kind-1059 wraps can crowd a legitimate older install/join out of
   * startup recovery. This walks the whole history in `until`-windowed pages, bounding
   * MEMORY PER PAGE (not per history), deduping across pages, and detecting completeness
   * (a short page = the end of history). Each page's window is `until = <oldest seen> +
   * overlapSec` so an event exactly on a page boundary is never skipped (deduped by id).
   *
   * Termination: stops on a short page (complete), on a page that adds no NEW events
   * (no forward progress — e.g. a dense same-second cluster the relay can't page past),
   * or at `maxTotal` (a hard safety bound). Callers process every returned event through
   * the normal seen-ledger-deduped path, so re-fetched boundary/overlap events are free.
   */
  async fetchAll(
    filter: Filter,
    relays: string[] = this.defaultRelays,
    opts: { pageSize?: number; overlapSec?: number; maxTotal?: number; timeoutMs?: number } = {},
  ): Promise<NostrEvent[]> {
    const pageSize = opts.pageSize ?? MAX_FETCH_EVENTS;
    const overlapSec = opts.overlapSec ?? 1;
    const maxTotal = opts.maxTotal ?? Number.POSITIVE_INFINITY;
    const timeoutMs = opts.timeoutMs ?? 5000;
    const seen = new Set<string>();
    const all: NostrEvent[] = [];
    let until = filter.until;
    for (;;) {
      const page = await this.fetch({ ...filter, until, limit: pageSize }, relays, timeoutMs, pageSize);
      let added = 0;
      let oldest = Number.POSITIVE_INFINITY;
      for (const e of page) {
        if (e.created_at < oldest) oldest = e.created_at;
        if (!seen.has(e.id)) {
          seen.add(e.id);
          all.push(e);
          added++;
        }
      }
      // Complete: the relay returned fewer than a full page → end of history reached.
      if (page.length < pageSize) break;
      // No forward progress (all duplicates / can't page past a same-second cluster).
      if (added === 0 || !Number.isFinite(oldest)) break;
      if (all.length >= maxTotal) break;
      // Next window: at/just after the oldest we saw, WITH overlap (deduped by id).
      const nextUntil = oldest + overlapSec;
      if (until !== undefined && nextUntil >= until) break; // window can't advance
      until = nextUntil;
    }
    return all;
  }

  /** One-shot fetch: collect events until EOSE or timeout, then close. */
  fetch(
    filter: Filter,
    relays: string[] = this.defaultRelays,
    timeoutMs = 5000,
    maxEvents = MAX_FETCH_EVENTS,
  ): Promise<NostrEvent[]> {
    return new Promise((resolve) => {
      const events: NostrEvent[] = [];
      const seen = new Set<string>();
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          sub.close();
        } catch {
          /* already closed */
        }
        resolve(events);
      };
      const sub = this.pool.subscribe(relays, filter as any, {
        onevent: (e: NostrEvent) => {
          if (!seen.has(e.id)) {
            seen.add(e.id);
            events.push(e);
            // Bounded accumulation (audit C3): stop once the cap is hit so a relay
            // flooding history can't grow this array without limit.
            if (events.length >= maxEvents) done();
          }
        },
        oneose: () => done(),
      });
      const timer = setTimeout(done, timeoutMs);
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
  probe(relays: string[], timeoutMs = 5000): Promise<boolean> {
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
   */
  async publish(event: NostrEvent, relays: string[] = this.defaultRelays): Promise<{ replaced?: boolean }> {
    type Outcome = { url: string; ok: boolean; replaced: boolean; reason: string };
    let settledCount = 0;
    let resolvedToCaller = false;
    const outcomes: Outcome[] = [];

    const classify = (url: string, err: unknown): Outcome => {
      // OK=false with "duplicate"/"replaced" means the relay already holds this
      // event (or a newer version of the addressable coordinate) — the data is
      // durably there, which is what publish promises. Burst republishes of 31605
      // lists otherwise fail every retry against strfry's "replaced: have newer event".
      const reason = String((err as Error)?.message ?? err);
      if (/\b(duplicate|replaced)\b/i.test(reason)) {
        console.debug(
          `[nostr] kind ${event.kind} ${event.id.slice(0, 8)} already-stored on ${url} (${reason.slice(0, 80)}) — treating as success`,
        );
        // A "replaced: have newer" (not a plain "duplicate") means a competing event
        // superseded ours — flag it so the coordinator reconciles (audit COORD-27):
        // with clock skew this can otherwise silently drop the newest event.
        return { url, ok: true, replaced: /\breplaced\b/i.test(reason), reason };
      }
      return { url, ok: false, replaced: false, reason };
    };

    // `this.pool.publish` returns one promise per relay, in the order given.
    const wrapped = this.pool.publish(relays, event).map((p, i) => {
      const url = relays[i] ?? "(unknown relay)";
      return p.then(
        (): Outcome => ({ url, ok: true, replaced: false, reason: "OK" }),
        (err: unknown): Outcome => classify(url, err),
      );
    });

    return await new Promise<{ replaced?: boolean }>((resolve, reject) => {
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
            resolve({ replaced: outcomes.some((x) => x.replaced) });
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
              new Error(
                `publish of kind ${event.kind} ${event.id.slice(0, 8)} failed on all ${wrapped.length} relay(s) — ${why}`,
              ),
            );
          }
        });
      }
    });
  }

  close(): void {
    this.pool.close(this.defaultRelays);
  }
}

export type { NostrEvent };
