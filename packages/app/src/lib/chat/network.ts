/**
 * Marmot `NostrNetworkInterface` over the app's NDK pool (MARMOT-GROUP-CHAT §2,
 * Phase 2). marmot-ts publishes/reads kinds 30443 (key packages), 1059 (welcome
 * gift wraps), and 445 (group messages) through this adapter; the app supplies one
 * backed by its existing NDK singleton so chat shares the same relay connections,
 * cache, and offline behaviour as the rest of the event.
 */
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { NDKFilter, NDKSubscription } from "@nostr-dev-kit/ndk";
import { getNdk, relaySet, fetchEvents, type Filter } from "$lib/nostr/ndk.js";
import { KIND_DM_RELAY_LIST } from "@nostrautica/protocol";

/** A per-relay publish result (marmot's `PublishResponse`). */
interface PublishResponse {
  from: string;
  ok: boolean;
  message?: string;
}
/** Minimal Observer/Subscribable (marmot's interop Observable shape). */
interface Observer<T> {
  next: (value: T) => void;
  error: (err: unknown) => void;
  complete: () => void;
}
interface Unsubscribable {
  unsubscribe(): void;
}
interface Subscribable<T> {
  subscribe(observer: Partial<Observer<T>>): Unsubscribable;
}
type NostrEventLike = ReturnType<NDKEvent["rawEvent"]>;
type FilterLike = NDKFilter | NDKFilter[];

/** The marmot network interface implemented over NDK. */
export interface MarmotNetwork {
  publish(relays: string[], event: NostrEventLike): Promise<Record<string, PublishResponse>>;
  request(relays: string[], filters: FilterLike): Promise<NostrEventLike[]>;
  subscription(relays: string[], filters: FilterLike): Subscribable<NostrEventLike>;
  getUserInboxRelays(pubkey: string): Promise<string[]>;
}

export function createMarmotNetwork(): MarmotNetwork {
  return {
    async publish(relays, event) {
      const ndkEvent = new NDKEvent(getNdk(), event as unknown as NostrEventLike);
      const result: Record<string, PublishResponse> = {};
      try {
        const reached = await ndkEvent.publish(relaySet(relays));
        // NDK returns the set of relays that accepted the event.
        const ok = new Set<string>();
        reached.forEach((r) => ok.add(r.url));
        for (const url of relays) result[url] = { from: url, ok: ok.has(url) };
        // Include any accepting relay not in the requested list (pool fallback).
        for (const url of ok) if (!(url in result)) result[url] = { from: url, ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const url of relays) result[url] = { from: url, ok: false, message };
      }
      return result;
    },

    async request(relays, filters) {
      // Bounded fetch (UX-1): NDK's own fetchEvents can hang on a dead-relay
      // majority; the wrapper resolves with partial results at the timeout.
      const events = await fetchEvents(filters as unknown as Filter | Filter[], relays);
      return events.map((e) => e.rawEvent());
    },

    subscription(relays, filters) {
      return {
        subscribe(observer) {
          let sub: NDKSubscription | undefined;
          try {
            sub = getNdk().subscribe(filters, { closeOnEose: false, relaySet: relaySet(relays) });
            sub.on("event", (e: NDKEvent) => observer.next?.(e.rawEvent()));
            sub.on("eose", () => {
              /* keep open — marmot wants a live subscription, not a one-shot */
            });
          } catch (err) {
            observer.error?.(err);
          }
          return {
            unsubscribe() {
              sub?.stop();
            },
          };
        },
      };
    },

    async getUserInboxRelays(pubkey) {
      // NIP-17 kind-10050 inbox relay list: where this user receives gift-wrapped
      // welcomes (the transport target for a 444/1059 to them).
      const events = await fetchEvents({ kinds: [KIND_DM_RELAY_LIST], authors: [pubkey], limit: 1 });
      const latest = events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
      if (!latest) return [];
      return latest.tags
        .filter((t) => t[0] === "relay" && typeof t[1] === "string")
        .map((t) => t[1] as string);
    },
  };
}
