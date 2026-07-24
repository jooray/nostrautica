import { describe, it, expect } from "vitest";
import { NostrClient, MAX_FETCH_EVENTS, type NostrEvent, type Filter } from "./client.js";

/**
 * Paginated full-history fetch (audit R4). The one-shot fetch caps at
 * MAX_FETCH_EVENTS and silently truncates; fetchAll must walk the WHOLE history in
 * `until`-windowed pages so a >5000-event flood can't crowd a legitimate older event
 * out of recovery — bounding memory PER PAGE, not per history.
 */

/** Build a set of events with the given ids, each at a distinct descending timestamp. */
function makeEvents(n: number, baseTs: number): NostrEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ev-${i}`,
    pubkey: "a".repeat(64),
    kind: 1059,
    created_at: baseTs - i, // strictly descending, unique per event
    tags: [],
    content: "",
    sig: "sig",
  })) as unknown as NostrEvent[];
}

/**
 * A NostrClient whose `fetch` is served from an in-memory event set, honoring
 * `until` (newest-first) and `limit` exactly as a relay would — so fetchAll's real
 * windowing/pagination logic is exercised. Records the largest page it ever served.
 */
class StubClient extends NostrClient {
  maxPageServed = 0;
  fetchCalls = 0;
  constructor(private readonly events: NostrEvent[]) {
    super(["wss://stub"]);
  }
  override fetch(filter: Filter, _relays?: string[], _t?: number, maxEvents = MAX_FETCH_EVENTS): Promise<NostrEvent[]> {
    this.fetchCalls++;
    const limit = filter.limit ?? maxEvents;
    const until = filter.until ?? Number.POSITIVE_INFINITY;
    const page = [...this.events]
      .filter((e) => e.created_at <= until)
      .sort((a, b) => b.created_at - a.created_at) // newest first
      .slice(0, Math.min(limit, maxEvents));
    this.maxPageServed = Math.max(this.maxPageServed, page.length);
    return Promise.resolve(page);
  }
}

describe("NostrClient.fetchAll pagination (audit R4)", () => {
  it("recovers EVERY event across many pages when history exceeds one page cap", async () => {
    // A legitimate install (the OLDEST event) buried under >5000 flood wraps: a single
    // capped fetch would return only the newest 5000 and drop it.
    const total = MAX_FETCH_EVENTS + 1234;
    const events = makeEvents(total, 2_000_000_000);
    const legitId = events[events.length - 1]!.id; // the oldest event
    const client = new StubClient(events);

    const all = await client.fetchAll({ kinds: [1059] }, undefined, { pageSize: MAX_FETCH_EVENTS });

    // Completeness: every event recovered, deduped, including the buried legit one.
    expect(all).toHaveLength(total);
    expect(new Set(all.map((e) => e.id)).size).toBe(total);
    expect(all.some((e) => e.id === legitId)).toBe(true);
    // Bounded memory PER PAGE: no single fetch returned more than the page cap.
    expect(client.maxPageServed).toBeLessThanOrEqual(MAX_FETCH_EVENTS);
    // It actually paged (more than one fetch), and terminated.
    expect(client.fetchCalls).toBeGreaterThan(1);
  });

  it("stops after a single page when history fits (short page = complete)", async () => {
    const events = makeEvents(10, 1_000_000);
    const client = new StubClient(events);
    const all = await client.fetchAll({ kinds: [1059] }, undefined, { pageSize: 100 });
    expect(all).toHaveLength(10);
    expect(client.fetchCalls).toBe(1); // short first page → done
  });

  it("honors maxTotal as a hard safety bound", async () => {
    const events = makeEvents(500, 1_000_000);
    const client = new StubClient(events);
    const all = await client.fetchAll({ kinds: [1059] }, undefined, { pageSize: 50, maxTotal: 120 });
    expect(all.length).toBeGreaterThanOrEqual(120);
    expect(all.length).toBeLessThan(500);
  });
});
