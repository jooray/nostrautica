/**
 * Multi-relay event deduplication. When streaming events from several relays,
 * every relay returns its own copy — regular events dedupe by id, while
 * replaceable/addressable events (NIP-01) resolve latest-wins per identity key
 * under the shared §3.1 comparator (`supersedes`), so every reader — fetch and
 * stream, app and coordinator — agrees on the current version.
 */
import { supersedes } from "@nostrautica/protocol";

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
    // §3.1 tie-break (audit P2): replace the retained winner whenever the
    // candidate SUPERSEDES it — strictly newer created_at, OR equal created_at
    // with a lexicographically LOWER id. Relay arrival order is not
    // deterministic, so the old "first arrival stays on a tie" rule let two
    // clients disagree on the current 31600 config, roster, coordinator
    // assignment, theme, page, etc. Discarding the loser here (before snapshots
    // and live callbacks) is what makes `pickLatest` downstream a no-op rather
    // than a repair it cannot perform.
    if (prev && !supersedes(e, prev)) return false;
    this.latest.set(key, e);
    return true;
  }

  /** Current winners: all regular events + the latest version per replaceable key. */
  snapshot(): T[] {
    return [...this.regular, ...this.latest.values()];
  }
}
