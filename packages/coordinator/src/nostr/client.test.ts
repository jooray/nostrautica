import { describe, it, expect, vi } from "vitest";
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

/**
 * Long-lived subscriptions must survive a socket drop (2026-09-04 audit).
 *
 * nostr-tools defaults BOTH reconnect and keepalive-ping to off
 * (`enableReconnect = opts.enableReconnect || false`, `enablePing = opts.enablePing`).
 * With them off, any close drops the relay from the pool and kills every
 * subscription on it, so the daemon went permanently deaf to that relay until the
 * process restarted — silently, and masked by the fact that every deploy restarts it.
 *
 * This asserts the pool OPTIONS rather than simulating a drop, deliberately: the
 * regression is a missing constructor argument, and the library's own reconnect
 * machinery is not ours to re-test.
 */
describe("NostrClient relay pool durability (audit 2026-09-04)", () => {
  it("enables reconnect and keepalive ping on the pool", () => {
    const client = new NostrClient(["wss://stub"]);
    const pool = (client as unknown as { pool: { enableReconnect: boolean; enablePing: boolean } })
      .pool;
    expect(pool.enableReconnect).toBe(true);
    expect(pool.enablePing).toBe(true);
  });
});


/**
 * Publish outcomes (audit COORD-27 + operator diagnosis).
 *
 * `Promise.any` threw away both halves of what a publish knows: a "replaced/have
 * newer" answer arriving after a faster relay's OK (so the §3.1 reconciliation never
 * fired), and — when every relay refused — the per-relay reasons, replaced by
 * AggregateError's fixed "All promises were rejected", which is the string that
 * reached the daemon log and the organizer's status notice.
 */
describe("NostrClient.publish outcomes", () => {
  const EVENT = {
    id: "f".repeat(64),
    pubkey: "a".repeat(64),
    kind: 31605,
    created_at: 1,
    tags: [["d", "matches"]],
    content: "",
    sig: "s",
  } as unknown as NostrEvent;

  /** Install a fake pool whose per-relay promises the test controls. */
  function withPool(client: NostrClient, make: (relays: string[]) => Promise<unknown>[]): void {
    (client as any).pool = { publish: (relays: string[]) => make(relays), close() {} };
  }

  const later = <T>(ms: number, v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));
  const failLater = (ms: number, msg: string): Promise<never> =>
    new Promise((_r, rej) => setTimeout(() => rej(new Error(msg)), ms));

  it("names every relay and its reason when ALL of them refuse", async () => {
    const client = new NostrClient(["wss://a.example", "wss://b.example"]);
    withPool(client, () => [
      failLater(1, "blocked: pubkey not allowed"),
      failLater(2, "rate-limited: slow down"),
    ]);
    await expect(client.publish(EVENT)).rejects.toThrow(
      /wss:\/\/a\.example: blocked: pubkey not allowed;.*wss:\/\/b\.example: rate-limited: slow down/s,
    );
    // The old message, verbatim, carried none of that.
    await expect(client.publish(EVENT)).rejects.not.toThrow(/^All promises were rejected$/);
  });

  it("resolves on the FIRST ack without waiting for a slow relay", async () => {
    const client = new NostrClient(["wss://fast.example", "wss://slow.example"]);
    withPool(client, () => [later(1, "ok"), later(5_000, "ok")]);
    const started = Date.now();
    await expect(client.publish(EVENT)).resolves.toEqual({ replaced: false });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("reports `replaced` when a relay answers \"have newer\" before any plain ack", async () => {
    const client = new NostrClient(["wss://strfry.example", "wss://slow.example"]);
    withPool(client, () => [failLater(1, "replaced: have newer event"), later(200, "ok")]);
    // "replaced" is an ACK for publish's purposes (the data is durably there) AND the
    // signal the coordinator reconciles on.
    await expect(client.publish(EVENT)).resolves.toEqual({ replaced: true });
  });

  it("a LATE \"have newer\" is no longer swallowed — it is logged, loudly", async () => {
    // The exact bug: a fast relay's plain OK resolved `Promise.any`, the code read
    // `replaced` in that instant, and the slower relay's "replaced: have newer"
    // wrote into a variable nobody would ever read again. Publishing resolves on the
    // first ack by design (waiting for the slowest relay costs nostr-tools' full
    // 4.4s timeout on every publish), so the late answer cannot be in the returned
    // flag — but it must not vanish.
    const client = new NostrClient(["wss://fast.example", "wss://strfry.example"]);
    withPool(client, () => [later(1, "ok"), failLater(30, "replaced: have newer event")]);
    const warned: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((m: unknown) => void warned.push(String(m)));
    try {
      await client.publish(EVENT);
      await new Promise((r) => setTimeout(r, 80)); // let the slow relay settle
    } finally {
      spy.mockRestore();
    }
    expect(warned.join("\n")).toMatch(/strfry\.example answered "replaced\/have newer" AFTER/);
  });

  it("a plain `duplicate` is an ack but is NOT a reconcile signal", async () => {
    const client = new NostrClient(["wss://a.example"]);
    withPool(client, () => [failLater(1, "duplicate: already have this event")]);
    await expect(client.publish(EVENT)).resolves.toEqual({ replaced: false });
  });

  it("rejects with a clear message when there are no relays at all", async () => {
    const client = new NostrClient([]);
    withPool(client, () => []);
    await expect(client.publish(EVENT)).rejects.toThrow(/no relays configured/);
  });
});

/**
 * A relay that is DOWN when we subscribe must be retried (2026-09-09 audit,
 * CORE-N-1).
 *
 * nostr-tools' reconnect only ever covers a socket that was established and then
 * dropped. When `ensureRelay` fails at subscribe time — the relay is unreachable,
 * or slower than `maxWaitForConnection` (3 s) — it sets `skipReconnection = true`
 * and calls the subscription's close handler for that relay. Nothing retried it,
 * and because the pool's group `onclose` only fires once EVERY relay has closed,
 * on a multi-relay event nothing even logged it. On a single-relay event the
 * daemon was simply deaf to every join request until the next restart.
 */
describe("NostrClient.subscribe per-relay retry (2026-09-09 audit)", () => {
  interface FakeSub {
    url: string;
    params: { onevent: (e: NostrEvent) => void; onclose: (r: string[]) => void };
    closed: boolean;
  }
  /** A pool that records each per-relay subscribe and lets the test drive closes. */
  function fakePool(client: NostrClient): FakeSub[] {
    const subs: FakeSub[] = [];
    (client as any).pool = {
      subscribe(relays: string[], _f: unknown, params: FakeSub["params"]) {
        const sub: FakeSub = { url: relays[0]!, params, closed: false };
        subs.push(sub);
        return { close: () => (sub.closed = true) };
      },
      close() {},
    };
    return subs;
  }

  const ev = (id: string): NostrEvent =>
    ({ id, pubkey: "a".repeat(64), kind: 1059, created_at: 1, tags: [], content: "", sig: "s" }) as unknown as NostrEvent;

  it("opens ONE subscription per relay, not one group subscription", () => {
    const client = new NostrClient([]);
    const subs = fakePool(client);
    const close = client.subscribe({ kinds: [1059] }, () => {}, ["wss://a", "wss://b", "wss://a"]);
    expect(subs.map((s) => s.url)).toEqual(["wss://a", "wss://b"]); // deduped
    close();
    expect(subs.every((s) => s.closed)).toBe(true);
  });

  it("resubscribes the one relay that closed, and leaves the healthy one alone", async () => {
    vi.useFakeTimers();
    try {
      const client = new NostrClient([]);
      const subs = fakePool(client);
      const close = client.subscribe({ kinds: [1059] }, () => {}, ["wss://down", "wss://up"]);
      expect(subs).toHaveLength(2);

      // The unreachable relay's subscribe fails: nostr-tools calls onclose for it.
      subs[0]!.params.onclose(["connection failed"]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(subs).toHaveLength(3);
      expect(subs[2]!.url).toBe("wss://down");

      // Still down: it keeps trying, with a longer gap each time.
      subs[2]!.params.onclose(["connection failed"]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(subs).toHaveLength(3); // 15s backoff, not yet
      await vi.advanceTimersByTimeAsync(10_000);
      expect(subs).toHaveLength(4);
      expect(subs[3]!.url).toBe("wss://down");

      close();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(subs).toHaveLength(4); // a deliberate close stops the retry loop
    } finally {
      vi.useRealTimers();
    }
  });

  it("dedupes by event id across relays (the group subscribe used to do this)", () => {
    const client = new NostrClient([]);
    const subs = fakePool(client);
    const got: string[] = [];
    client.subscribe({ kinds: [1059] }, (e) => got.push(e.id), ["wss://a", "wss://b"]);
    subs[0]!.params.onevent(ev("w1"));
    subs[1]!.params.onevent(ev("w1")); // same wrap, second relay
    subs[1]!.params.onevent(ev("w2"));
    expect(got).toEqual(["w1", "w2"]);
  });
});
