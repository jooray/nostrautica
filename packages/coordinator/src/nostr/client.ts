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

export class NostrClient {
  private pool = new SimplePool();

  constructor(private readonly defaultRelays: string[]) {}

  /** Long-lived subscription; returns a closer. */
  subscribe(
    filter: Filter,
    onEvent: (event: NostrEvent) => void,
    relays: string[] = this.defaultRelays,
  ): () => void {
    const sub = this.pool.subscribe(relays, filter as any, {
      onevent: (e: NostrEvent) => onEvent(e),
    });
    return () => sub.close();
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

  /** Publish a signed event to the given relays; resolves when any accepts. The
   *  outcome's `replaced` flag is set when a relay answered "replaced/have newer" for
   *  a replaceable event, so the coordinator can reconcile via the §3.1 comparator
   *  (reliability tail) instead of silently dropping the genuinely-newest event. */
  async publish(event: NostrEvent, relays: string[] = this.defaultRelays): Promise<{ replaced?: boolean }> {
    let replaced = false;
    await Promise.any(
      this.pool.publish(relays, event).map((p) =>
        p.catch((err) => {
          // OK=false with "duplicate"/"replaced" means the relay already holds
          // this event (or a newer version of the addressable coordinate) — the
          // data is durably there, which is what publish promises. Burst
          // republishes of 31605 lists otherwise fail every retry against
          // strfry's "replaced: have newer event".
          const reason = String((err as Error)?.message ?? err);
          if (/\b(duplicate|replaced)\b/i.test(reason)) {
            // A "replaced: have newer" (not a plain "duplicate") means a competing
            // event superseded ours — flag it so the coordinator reconciles (audit
            // COORD-27): with clock skew this can silently drop the newest event.
            if (/\breplaced\b/i.test(reason)) replaced = true;
            console.debug(
              `[nostr] kind ${event.kind} ${event.id.slice(0, 8)} already-stored (${reason.slice(0, 80)}) — treating as success`,
            );
            return "already-stored";
          }
          throw err;
        }),
      ),
    );
    return { replaced };
  }

  close(): void {
    this.pool.close(this.defaultRelays);
  }
}

export type { NostrEvent };
