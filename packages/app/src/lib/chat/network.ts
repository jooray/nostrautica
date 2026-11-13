/**
 * Marmot `NostrNetworkInterface` over the app's NDK pool (MARMOT-GROUP-CHAT §2,
 * Phase 2). marmot-ts publishes/reads kinds 30443 (key packages), 1059 (welcome
 * gift wraps), and 445 (group messages) through this adapter; the app supplies one
 * backed by its existing NDK singleton so chat shares the same relay connections,
 * cache, and offline behaviour as the rest of the event.
 */
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { NDKFilter, NDKSubscription } from "@nostr-dev-kit/ndk";
import {
  getNdk,
  relaySet,
  fetchEvents,
  publishSignedOutcomes,
  type Filter,
  type RelayPublishOutcome,
} from "$lib/nostr/ndk.js";
import { streamEvents } from "$lib/nostr/stream.js";
import { RelaysUnansweredError } from "$lib/nostr/unanswered.js";
import { KIND_DM_RELAY_LIST } from "@nostrautica/protocol";
import { latestDmRelayList, relayUrlsFromDmList } from "$lib/events/dm.js";

/** A per-relay publish result (marmot's `PublishResponse`). */
interface PublishResponse {
  from: string;
  ok: boolean;
  message?: string;
  /** No answer from the relay: it may have stored it, so marmot retries the same bytes. */
  uncertain?: boolean;
}

/**
 * NIP-01 machine-readable OK=false prefixes: the relay answered and did NOT store
 * the event. Anything else on a failed publish (our own timeout, a closed socket,
 * "Relay is disconnected") is the absence of an answer, not a refusal.
 */
const RELAY_REFUSAL = /^(blocked|rate-limited|invalid|pow|restricted|error|auth-required|mute):/i;

/** One relay's publish outcome as marmot's three-valued response (audit K-7). */
export function classifyRelayOutcome(o: RelayPublishOutcome): PublishResponse {
  if (o.ok) return { from: o.url, ok: true };
  const reason = (o.reason ?? "").trim();
  // "duplicate:" means the relay already holds exactly this event, i.e. stored.
  if (/^duplicate:/i.test(reason)) return { from: o.url, ok: true, message: reason };
  if (RELAY_REFUSAL.test(reason)) return { from: o.url, ok: false, message: reason };
  return { from: o.url, ok: false, message: reason || "no answer", uncertain: true };
}

function sameRelay(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().toLowerCase().replace(/\/+$/, "");
  return norm(a) === norm(b);
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
      // Per relay, three outcomes, not two (audit K-7). marmot-ts keeps a commit's
      // exact bytes for retry ONLY when a response is marked `uncertain`; a plain
      // `ok:false` everywhere makes it roll the commit back
      // (group-runtime.js `#publishToGroupRelays`). Reporting a timeout as a
      // definite failure therefore forked the committer: a relay that stored the
      // commit but whose OK arrived late (or never) let every other member apply
      // epoch N+1 while this device stayed at N and later committed a DIFFERENT
      // N+1. So `ok:false` only when the relay explicitly said no; a timeout, a
      // dropped socket or a transport error is "may have been stored": uncertain.
      const result: Record<string, PublishResponse> = {};
      let outcomes: RelayPublishOutcome[];
      try {
        outcomes = await publishSignedOutcomes(
          event as unknown as Parameters<typeof publishSignedOutcomes>[0],
          relays,
        );
      } catch (err) {
        // Nothing went out (no relay set could be built). Not a refusal by any
        // relay, so it stays uncertain rather than a definite "no".
        const message = err instanceof Error ? err.message : String(err);
        for (const url of relays) result[url] = { from: url, ok: false, message, uncertain: true };
        return result;
      }
      // Key each outcome by the relay string marmot ASKED for, not NDK's
      // normalized spelling (`wss://host` comes back as `wss://host/`). marmot-ts
      // reads acks as `responses[requestedRelay]`: since the 8040bfa vendor a
      // KeyPackage publish or deletion rejects when no requested relay acks, and a
      // commit's ack only counts for a relay in the group's list. Keyed by the
      // normalized URL, a relay that DID store the event read as no answer.
      const matched = new Set<RelayPublishOutcome>();
      for (const url of relays) {
        const o = outcomes.find((x) => !matched.has(x) && sameRelay(x.url, url));
        if (!o) continue;
        matched.add(o);
        result[url] = { ...classifyRelayOutcome(o), from: url };
      }
      for (const o of outcomes) if (!matched.has(o)) result[o.url] = classifyRelayOutcome(o);
      // A requested relay with no outcome of its own (NDK dropped it from the
      // set) never told us anything: uncertain.
      for (const url of relays) {
        if (url in result) continue;
        result[url] = { from: url, ok: false, message: "no answer", uncertain: true };
      }
      return result;
    },

    async request(relays, filters) {
      // Bounded fetch (UX-1): NDK's own fetchEvents can hang on a dead-relay
      // majority, so this settles at a timeout too. But it must not RESOLVE then:
      // marmot-ts 0.8.0 backfills one relay per call and records a resolved
      // answer as "this relay holds nothing more in that window" in a persisted
      // per-relay cursor, so partial results after a timeout would skip the
      // rest of that window's history for good. Only an EOSE from every relay
      // asked counts as an answer; anything else rejects and is retried.
      const handle = streamEvents(filters as unknown as Filter | Filter[], { relays });
      const events = await handle.ready;
      if (!handle.allAnswered()) throw new RelaysUnansweredError();
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
      // Author-pinned, and through the same scheme filter + cap as DMs (audit
      // R-83): this list decides where a welcome to this user is sent.
      const latest = latestDmRelayList(events, pubkey);
      return latest ? relayUrlsFromDmList(latest.tags) : [];
    },
  };
}
