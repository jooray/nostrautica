/**
 * Multi-relay event deduplication. When streaming events from several relays,
 * every relay returns its own copy — regular events dedupe by id, while
 * replaceable/addressable events (NIP-01) resolve latest-wins per identity key,
 * matching the sort-by-created_at-take-first reduction the fetchers already do.
 */

export interface MinimalEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at?: number;
  tags: string[][];
}

/**
 * The NIP-01 replaceable/addressable identity key for an event, or null for
 * regular (immutable) events that dedupe by id alone.
 */
export function replaceableKey(e: MinimalEvent): string | null {
  const k = e.kind;
  if (k === 0 || k === 3 || (k >= 10000 && k < 20000)) return `${k}:${e.pubkey}`;
  if (k >= 30000 && k < 40000) {
    const d = e.tags.find((t) => t[0] === "d")?.[1] ?? "";
    return `${k}:${e.pubkey}:${d}`;
  }
  return null;
}

/**
 * Stateful streaming deduper: `accept` returns true when the event is new (or a
 * strictly newer version of a replaceable event) and should be surfaced.
 */
export class EventDeduper<T extends MinimalEvent = MinimalEvent> {
  private seenIds = new Set<string>();
  private latest = new Map<string, T>();
  private regular: T[] = [];

  accept(e: T): boolean {
    if (this.seenIds.has(e.id)) return false;
    this.seenIds.add(e.id);
    const key = replaceableKey(e);
    if (key === null) {
      this.regular.push(e);
      return true;
    }
    const prev = this.latest.get(key);
    // Latest wins; on an equal timestamp the first arrival stays (deterministic).
    if (prev && (prev.created_at ?? 0) >= (e.created_at ?? 0)) return false;
    this.latest.set(key, e);
    return true;
  }

  /** Current winners: all regular events + the latest version per replaceable key. */
  snapshot(): T[] {
    return [...this.regular, ...this.latest.values()];
  }
}
