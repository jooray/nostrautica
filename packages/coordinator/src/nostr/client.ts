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
import WebSocket from "ws";

// nostr-tools uses a global WebSocket; provide one for Node.
useWebSocketImplementation(WebSocket as unknown as typeof globalThis.WebSocket);

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

  /** One-shot fetch: collect events until EOSE or timeout, then close. */
  fetch(
    filter: Filter,
    relays: string[] = this.defaultRelays,
    timeoutMs = 5000,
  ): Promise<NostrEvent[]> {
    return new Promise((resolve) => {
      const events: NostrEvent[] = [];
      const seen = new Set<string>();
      const done = () => {
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
          }
        },
        oneose: () => done(),
      });
      const timer = setTimeout(done, timeoutMs);
    });
  }

  /** Publish a signed event to the given relays; resolves when any accepts. */
  async publish(event: NostrEvent, relays: string[] = this.defaultRelays): Promise<void> {
    await Promise.any(
      this.pool.publish(relays, event).map((p) =>
        p.catch((err) => {
          // OK=false with "duplicate"/"replaced" means the relay already holds
          // this event (or a newer version of the addressable coordinate) — the
          // data is durably there, which is what publish promises. Burst
          // republishes of 31605 lists otherwise fail every retry against
          // strfry's "replaced: have newer event".
          const reason = String((err as Error)?.message ?? err);
          if (/\b(duplicate|replaced)\b/i.test(reason)) return "already-stored";
          throw err;
        }),
      ),
    );
  }

  close(): void {
    this.pool.close(this.defaultRelays);
  }
}

export type { NostrEvent };
