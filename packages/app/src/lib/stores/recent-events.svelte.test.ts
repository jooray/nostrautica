/**
 * "My events" identity invariants. Home and the Chat pane both render this list
 * with `naddr` as the {#each} key, and a duplicate key is a hard throw in
 * Svelte 5 that kills the route mid-creation — the Chat tab sat on "Loading…"
 * forever in prod (2026-07-24) with only a minified `each_key_duplicate` in the
 * console. So the store must leave `list` unique on the RENDER key, not just on
 * `coordinate`, after every write.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { coordinateToNaddr } from "@nostrautica/protocol";
import { recentEvents } from "./recent-events.svelte.js";

const KEY = "nostrautica:recent-events";
const PK = "a".repeat(64);
const COORD = `31923:${PK}:my-event`;
const NADDR = coordinateToNaddr(COORD);
const OTHER_COORD = `31923:${"b".repeat(64)}:other`;
const OTHER_NADDR = coordinateToNaddr(OTHER_COORD);

let store: Map<string, string>;

function seed(entries: unknown[]): void {
  store.set(KEY, JSON.stringify(entries));
}

beforeEach(() => {
  store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("recentEvents identity", () => {
  it("repairs an entry carrying another event's naddr WITHOUT losing either", () => {
    // The exact prod shape (2026-07-24): a destroyed EventHome's in-flight
    // onMount recorded its own ctx.coordinate against the LIVE route's naddr, so
    // "virtual assembly" ended up holding "lunarpunk"'s naddr. Two real events,
    // one naddr — the card opened the wrong event AND the list crashed on the
    // duplicate key. Merging them would delete an event; the coordinate is
    // authoritative, so re-derive the naddr from it.
    seed([
      { coordinate: COORD, naddr: NADDR, title: "Lunarpunk", role: "organizer", at: 20 },
      { coordinate: OTHER_COORD, naddr: NADDR, title: "Virtual Assembly", role: "organizer", at: 10 },
    ]);
    recentEvents.init();

    expect(recentEvents.list).toHaveLength(2); // neither event is dropped
    const byTitle = new Map(recentEvents.list.map((e) => [e.title, e]));
    expect(byTitle.get("Lunarpunk")!.naddr).toBe(NADDR); // the rightful owner keeps it
    expect(byTitle.get("Virtual Assembly")!.naddr).toBe(OTHER_NADDR); // repaired
    // Every entry's naddr must now decode back to its own coordinate.
    for (const e of recentEvents.list) {
      expect(coordinateToNaddr(e.coordinate)).toBe(e.naddr);
    }
  });

  it("record() cannot leave a duplicate naddr behind", () => {
    // `existing` drops prior entries by coordinate STRING only, so an entry
    // holding another event's naddr survived alongside the incoming one — and
    // `list` was assigned without dedupe(), so the bad state was live (and
    // crashing) until the next reload.
    seed([{ coordinate: OTHER_COORD, naddr: NADDR, title: "Virtual Assembly", role: "organizer", at: 5 }]);
    recentEvents.init();
    recentEvents.record({ coordinate: COORD, naddr: NADDR, title: "Lunarpunk", role: "organizer" });

    const naddrs = recentEvents.list.map((e) => e.naddr);
    expect(new Set(naddrs).size).toBe(naddrs.length);
    expect(naddrs.sort()).toEqual([NADDR, OTHER_NADDR].sort());
    // Persisted too — a reload must not resurrect the duplicate.
    expect(JSON.parse(store.get(KEY)!)).toHaveLength(2);
  });

  it("keeps valid relay hints on an naddr that already agrees with its coordinate", () => {
    // Only a DISAGREEING naddr is rebuilt. Rewriting every entry would strip the
    // relay hints that loadEventContext() feeds to addRelays().
    const hinted = coordinateToNaddr(COORD, ["wss://relay.example"]);
    seed([{ coordinate: COORD, naddr: hinted, title: "Lunarpunk", role: "organizer", at: 1 }]);
    recentEvents.init();
    expect(recentEvents.list[0].naddr).toBe(hinted);
  });

  it("keeps genuinely distinct events apart and orders them newest-first", () => {
    seed([
      { coordinate: COORD, naddr: NADDR, title: "A", role: "attendee", at: 1 },
      { coordinate: OTHER_COORD, naddr: OTHER_NADDR, title: "B", role: "attendee", at: 2 },
    ]);
    recentEvents.init();
    expect(recentEvents.list.map((e) => e.title)).toEqual(["B", "A"]);
  });

  it("still merges same-coordinate duplicates without downgrading the role", () => {
    seed([
      { coordinate: COORD, naddr: NADDR, title: "A", role: "organizer", at: 1 },
      { coordinate: COORD, naddr: NADDR, title: "A (renamed)", role: "visitor", at: 9 },
    ]);
    recentEvents.init();
    expect(recentEvents.list).toHaveLength(1);
    expect(recentEvents.list[0].role).toBe("organizer");
    expect(recentEvents.list[0].title).toBe("A (renamed)"); // newest title
  });
});
