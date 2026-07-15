/**
 * marmot-ts `NostrNetworkInterface` over the coordinator's Nostr transport
 * (MARMOT-GROUP-CHAT §4: "network adapter over its existing NostrClient").
 *
 * marmot needs four methods: publish, request (one-shot), subscription (live),
 * and getUserInboxRelays (kind-10050 lookup). The coordinator's `NostrClient`
 * already gives us publish / fetch / subscribe; this maps between the two shapes
 * (note the reversed `publish(relays, event)` argument order and the per-relay
 * `PublishResponse` map marmot expects).
 */
import type {
  NostrNetworkInterface,
  PublishResponse,
  Subscribable,
} from "@internet-privacy/marmot-ts/client";
import { INBOX_RELAY_LIST_KIND } from "@internet-privacy/marmot-ts/core";

/** Any Nostr event shape (structurally shared between nostr-tools and applesauce). */
type AnyEvent = { id: string; pubkey: string; kind: number; tags: string[][]; [k: string]: unknown };
type AnyFilter = Record<string, unknown>;

/** The subset of the coordinator transport this adapter drives. */
export interface ChatNetworkTransport {
  publish(event: AnyEvent, relays?: string[]): Promise<void>;
  fetch(filter: AnyFilter, relays?: string[], timeoutMs?: number): Promise<AnyEvent[]>;
  subscribe(filter: AnyFilter, onEvent: (e: AnyEvent) => void, relays?: string[]): () => void;
}

export interface ChatNetworkOptions {
  transport: ChatNetworkTransport;
  /** Relays used when a per-user lookup finds no inbox list. */
  defaultRelays: string[];
}

function asArray<T>(x: T | T[]): T[] {
  return Array.isArray(x) ? x : [x];
}

export function makeChatNetwork(opts: ChatNetworkOptions): NostrNetworkInterface {
  const { transport, defaultRelays } = opts;
  return {
    async publish(relays, event): Promise<Record<string, PublishResponse>> {
      const targets = relays.length ? relays : defaultRelays;
      try {
        await transport.publish(event as unknown as AnyEvent, targets);
        return Object.fromEntries(targets.map((r) => [r, { from: r, ok: true }]));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return Object.fromEntries(targets.map((r) => [r, { from: r, ok: false, message }]));
      }
    },

    async request(relays, filters) {
      const targets = relays.length ? relays : defaultRelays;
      const all: AnyEvent[] = [];
      const seen = new Set<string>();
      for (const filter of asArray(filters)) {
        for (const e of await transport.fetch(filter as AnyFilter, targets)) {
          if (!seen.has(e.id)) {
            seen.add(e.id);
            all.push(e);
          }
        }
      }
      return all as never;
    },

    subscription(relays, filters): Subscribable<never> {
      const targets = relays.length ? relays : defaultRelays;
      return {
        subscribe(observer) {
          const closers = asArray(filters).map((filter) =>
            transport.subscribe(
              filter as AnyFilter,
              (e) => observer.next?.(e as never),
              targets,
            ),
          );
          return {
            unsubscribe() {
              for (const c of closers) c();
            },
          };
        },
      };
    },

    async getUserInboxRelays(pubkey) {
      const events = await transport.fetch(
        { kinds: [INBOX_RELAY_LIST_KIND], authors: [pubkey] },
        defaultRelays,
      );
      const latest = events.sort(
        (a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0),
      )[0];
      if (!latest) return defaultRelays;
      const relays = latest.tags
        .filter((t) => t[0] === "relay" && typeof t[1] === "string")
        .map((t) => t[1]!);
      return relays.length ? relays : defaultRelays;
    },
  };
}
