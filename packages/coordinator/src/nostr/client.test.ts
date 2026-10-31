import { describe, it, expect, vi } from "vitest";
import {
  NostrClient,
  MAX_FETCH_EVENTS,
  MAX_FETCH_ALL_EVENTS,
  MAX_FETCH_REQS_PER_RELAY,
  MAX_LONG_LIVED_REQS_PER_RELAY,
  DEGRADED_FETCH_REQS_PER_RELAY,
  type NostrEvent,
  type Filter,
  type ReqHandlers,
} from "./client.js";

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

  it("stops once a short page brings nothing new (one confirming round trip)", async () => {
    const events = makeEvents(10, 1_000_000);
    const client = new StubClient(events);
    const all = await client.fetchAll({ kinds: [1059] }, undefined, { pageSize: 100 });
    expect(all).toHaveLength(10);
    expect(client.fetchCalls).toBe(2); // short page, then one below it that adds nothing
  });

  /**
   * Audit DS41-026. `fetch()` settles on EOSE or on its timeout alike (and
   * nostr-tools fires a synthetic EOSE after 4.4 s), so a slow relay's partial
   * page looked like the end of history and everything older was never fetched.
   */
  it("keeps walking past a timeout-truncated short page", async () => {
    const events = makeEvents(30, 1_000_000);
    class SlowClient extends StubClient {
      override fetch(filter: Filter, relays?: string[], t?: number, max?: number): Promise<NostrEvent[]> {
        // The relay gets through only 4 events before the timeout, every time.
        return super.fetch(filter, relays, t, max).then((page) => page.slice(0, 4));
      }
    }
    const client = new SlowClient(events);
    const all = await client.fetchAll({ kinds: [1059] }, undefined, { pageSize: 100 });
    expect(all).toHaveLength(30);
  });

  /** Audit SB-04 / SB-132 / DS41-027: the walk held every event it ever saw. */
  it("caps a flood by default instead of holding the whole history in memory", async () => {
    const client = new StubClient(makeEvents(3000, 1_000_000));
    const all = await client.fetchAll({ kinds: [1059] }, undefined, { pageSize: 100, maxTotal: 1000 });
    expect(all).toHaveLength(1000);
    // The default is finite (it used to be Infinity) and bounds pages too.
    const pagesOnly = new StubClient(makeEvents(3000, 1_000_000));
    await pagesOnly.fetchAll({ kinds: [1059] }, undefined, { pageSize: 10, maxPages: 5 });
    expect(pagesOnly.fetchCalls).toBe(5);
    expect(MAX_FETCH_ALL_EVENTS).toBeLessThan(Number.POSITIVE_INFINITY);
  });

  /**
   * Audit B-6. The walk stopped as soon as a page added nothing new, calling that
   * "no forward progress" and returning what it had. A page of >pageSize events
   * sharing ONE `created_at` produces exactly that: the next window is
   * `oldest + overlapSec`, which re-serves the same cluster, so everything OLDER
   * than the cluster was silently never fetched — the very silent-truncation
   * failure this pagination was written to close, and reachable without an
   * attacker by one busy second of a live event's inbox.
   */
  it("walks PAST a dense same-second cluster to reach older history", async () => {
    const cluster = Array.from({ length: 6 }, (_, i) => ({
      id: `dense-${i}`,
      pubkey: "a".repeat(64),
      kind: 1059,
      created_at: 1_000_000, // all in the same second, more than one page of them
      tags: [],
      content: "",
      sig: "sig",
    })) as unknown as NostrEvent[];
    const older = {
      id: "buried-install-grant",
      pubkey: "a".repeat(64),
      kind: 1059,
      created_at: 999_000, // an hour earlier, and the whole point of the walk
      tags: [],
      content: "",
      sig: "sig",
    } as unknown as NostrEvent;
    const client = new StubClient([...cluster, older]);

    const all = await client.fetchAll({ kinds: [1059] }, undefined, { pageSize: 2 });

    expect(all.some((e) => e.id === older.id)).toBe(true);
    // The cluster events sharing `oldest` exactly are the acknowledged cost of
    // stepping below it; what must never happen again is losing everything older.
    expect(all.length).toBeGreaterThan(2);
  });

  it("gives up after a bounded number of no-progress pages", async () => {
    // A relay that answers every window with the same full page must not turn the
    // walk into an unbounded crawl.
    class StuckClient extends StubClient {
      override fetch(): Promise<NostrEvent[]> {
        this.fetchCalls++;
        return Promise.resolve(makeEvents(2, 1_000_000)); // identical page, forever
      }
    }
    const client = new StuckClient([]);
    const all = await client.fetchAll({ kinds: [1059] }, undefined, { pageSize: 2 });
    expect(all).toHaveLength(2);
    expect(client.fetchCalls).toBeLessThanOrEqual(102); // the bound, not forever
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
describe("NostrClient.close (audit SB-33)", () => {
  it("closes every relay in the pool, not only the defaults", () => {
    const client = new NostrClient(["wss://default.example"]);
    const pool = (client as any).pool;
    pool.relays.set("wss://event-only.example/", { close() {} });
    const spy = vi.spyOn(pool, "close").mockImplementation(() => {});
    client.close();
    expect(spy.mock.calls[0]![0]).toEqual(expect.arrayContaining(["wss://default.example", "wss://event-only.example/"]));
  });
});

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
    await expect(client.publish(EVENT)).resolves.toMatchObject({ replaced: false });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("reports `replaced` when a relay answers \"have newer\" before any plain ack", async () => {
    const client = new NostrClient(["wss://strfry.example", "wss://slow.example"]);
    withPool(client, () => [failLater(1, "replaced: have newer event"), later(200, "ok")]);
    // "replaced" is an ACK for publish's purposes (the data is durably there) AND the
    // signal the coordinator reconciles on.
    await expect(client.publish(EVENT)).resolves.toMatchObject({ replaced: true });
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
    await expect(client.publish(EVENT)).resolves.toMatchObject({ replaced: false });
  });

  /**
   * Audit DS41-025. nostr-tools' `SimplePool.publish` normalizes the list and
   * rejects a repeated url with the bare string "duplicate url" in the same tick,
   * before anything is sent. That matched the relay "duplicate:" ack, so a publish
   * whose only real relay failed reported success. `wss://nos.lol` and
   * `wss://nos.lol/` both reach publish in normal config (event relays are stored
   * without the slash, `relays.default` with it).
   */
  it("never counts nostr-tools' synthetic `duplicate url` refusal as an ack", async () => {
    const client = new NostrClient(["wss://nos.lol", "wss://nos.lol/"]);
    const seenRelays: string[][] = [];
    withPool(client, (relays) => {
      seenRelays.push(relays);
      // nostr-tools 2.25 pool.publish, verbatim in shape: one promise per entry,
      // a repeat (after normalization) rejected with a string.
      const norm = relays.map((u) => u.replace(/\/+$/, ""));
      return norm.map((u, i) =>
        norm.indexOf(u) !== i ? Promise.reject("duplicate url") : failLater(20, "blocked: not allowed"),
      );
    });
    await expect(client.publish(EVENT)).rejects.toThrow(/blocked: not allowed/);
    // And the duplicate spelling was never handed to the pool in the first place.
    expect(seenRelays[0]).toEqual(["wss://nos.lol"]);
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
    filters: Record<string, unknown>[];
    handlers: ReqHandlers;
    closed: boolean;
  }
  /** Replace the one place a long-lived REQ touches nostr-tools (`openReq`). */
  function fakeReqs(client: NostrClient): FakeSub[] {
    const subs: FakeSub[] = [];
    (client as any).openReq = (url: string, filters: Record<string, unknown>[], handlers: ReqHandlers) => {
      const sub: FakeSub = { url, filters, handlers, closed: false };
      subs.push(sub);
      return { close: () => (sub.closed = true) };
    };
    return subs;
  }
  const flush = () => vi.advanceTimersByTimeAsync(0);

  const ev = (id: string): NostrEvent =>
    ({ id, pubkey: "a".repeat(64), kind: 1059, created_at: 1, tags: [], content: "", sig: "s" }) as unknown as NostrEvent;

  it("opens ONE subscription per relay, not one group subscription", async () => {
    vi.useFakeTimers();
    try {
      const client = new NostrClient([], { reqDebounceMs: 0 });
      const subs = fakeReqs(client);
      const close = client.subscribe({ kinds: [1059] }, () => {}, ["wss://a", "wss://b", "wss://a"]);
      await flush();
      expect(subs.map((s) => s.url)).toEqual(["wss://a/", "wss://b/"]); // deduped
      close();
      expect(subs.every((s) => s.closed)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resubscribes the one relay that closed, and leaves the healthy one alone", async () => {
    vi.useFakeTimers();
    try {
      const client = new NostrClient([], { reqDebounceMs: 0 });
      const subs = fakeReqs(client);
      const close = client.subscribe({ kinds: [1059] }, () => {}, ["wss://down", "wss://up"]);
      await flush();
      expect(subs).toHaveLength(2);

      // The unreachable relay's subscribe fails: its REQ reports a close.
      subs[0]!.handlers.onclose("connection failed");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(subs).toHaveLength(3);
      expect(subs[2]!.url).toBe("wss://down/");

      // Still down: it keeps trying, with a longer gap each time.
      subs[2]!.handlers.onclose("connection failed");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(subs).toHaveLength(3); // 15s backoff, not yet
      await vi.advanceTimersByTimeAsync(10_000);
      expect(subs).toHaveLength(4);
      expect(subs[3]!.url).toBe("wss://down/");

      close();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(subs).toHaveLength(4); // a deliberate close stops the retry loop
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the backoff over once a resubscription reaches EOSE", async () => {
    // Without the reset the attempt count only ever grew: after a day of uptime
    // every blip on a relay cost the full 300 s ceiling before the next try.
    vi.useFakeTimers();
    try {
      const client = new NostrClient([], { reqDebounceMs: 0 });
      const subs = fakeReqs(client);
      client.subscribe({ kinds: [1059] }, () => {}, ["wss://flaky"]);
      await flush();

      // Climb the ladder: 5 s, 15 s, 60 s, 300 s.
      for (const wait of [5_000, 15_000, 60_000, 300_000]) {
        subs.at(-1)!.handlers.onclose("connection failed");
        await vi.advanceTimersByTimeAsync(wait);
      }
      expect(subs).toHaveLength(5);

      // The relay is back and answers the subscription...
      subs.at(-1)!.handlers.oneose();
      // ...then drops again: the retry comes after 5 s, not 300 s.
      subs.at(-1)!.handlers.onclose("relay connection closed");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(subs).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives every relay, and every resubscribe, its own filter object (audit R-45)", async () => {
    // nostr-tools writes `since = lastEmitted + 1` into the filter object it was
    // handed when a relay reconnects; one relay's far-future event must not move
    // the `since` of any other relay's subscription, or of the caller's filter.
    vi.useFakeTimers();
    try {
      const client = new NostrClient([], { reqDebounceMs: 0 });
      const subs = fakeReqs(client);
      const callerFilter = { kinds: [31600], authors: ["a".repeat(64)] };
      client.subscribe(callerFilter, () => {}, ["wss://evil", "wss://good"]);
      await flush();
      subs[0]!.filters[0]!.since = 4_000_000_000; // what the pool does after evil's reconnect
      expect(subs[1]!.filters[0]!.since).toBeUndefined();
      expect((callerFilter as Record<string, unknown>).since).toBeUndefined();
      subs[1]!.handlers.onclose("connection failed");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(subs[2]!.filters[0]).not.toBe(subs[0]!.filters[0]);
      expect(subs[2]!.filters[0]!.since).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dedupes by event id across relays (the group subscribe used to do this)", async () => {
    vi.useFakeTimers();
    try {
      const client = new NostrClient([], { reqDebounceMs: 0 });
      const subs = fakeReqs(client);
      const got: string[] = [];
      client.subscribe({ kinds: [1059] }, (e) => got.push(e.id), ["wss://a", "wss://b"]);
      await flush();
      subs[0]!.handlers.onevent(ev("w1"));
      subs[1]!.handlers.onevent(ev("w1")); // same wrap, second relay
      subs[1]!.handlers.onevent(ev("w2"));
      expect(got).toEqual(["w1", "w2"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Audit R-2. Fifteen events held ~60-75 concurrent REQs on each shared relay
 * against strfry's default of 20, and relay.primal.net / nostr.oxtr.dev answered
 * "too many concurrent REQs" ~28,000 times a day.
 */
describe("NostrClient subscription pressure (audit R-2)", () => {
  interface FakeSub {
    url: string;
    filters: Record<string, any>[];
    handlers: ReqHandlers;
    closed: boolean;
  }
  function fakeReqs(client: NostrClient): FakeSub[] {
    const subs: FakeSub[] = [];
    (client as any).openReq = (url: string, filters: Record<string, any>[], handlers: ReqHandlers) => {
      const sub: FakeSub = { url, filters, handlers, closed: false };
      subs.push(sub);
      return { close: () => (sub.closed = true) };
    };
    return subs;
  }
  const open = (subs: FakeSub[]) => subs.filter((s) => !s.closed);
  const wrap = (id: string, p: string): NostrEvent =>
    ({ id, pubkey: "a".repeat(64), kind: 1059, created_at: 1, tags: [["p", p]], content: "", sig: "s" }) as unknown as NostrEvent;

  it("multiplexes many subscriptions to one relay into one REQ and routes events by filter", async () => {
    vi.useFakeTimers();
    try {
      const client = new NostrClient([], { reqDebounceMs: 100 });
      const subs = fakeReqs(client);
      const got = new Map<string, string[]>();
      for (const inbox of ["i1", "i2", "i3"]) {
        got.set(inbox, []);
        client.subscribe({ kinds: [1059], "#p": [inbox] }, (e) => got.get(inbox)!.push(e.id), ["wss://primal"]);
      }
      await vi.advanceTimersByTimeAsync(100);
      expect(subs).toHaveLength(1);
      expect(subs[0]!.filters.map((f) => f["#p"][0])).toEqual(["i1", "i2", "i3"]);
      subs[0]!.handlers.onevent(wrap("w2", "i2"));
      subs[0]!.handlers.onevent(wrap("w3", "i3"));
      expect(got.get("i1")).toEqual([]);
      expect(got.get("i2")).toEqual(["w2"]);
      expect(got.get("i3")).toEqual(["w3"]);
      expect(client.reqCounts("wss://primal").longLived).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps different kind sets in different REQs, and caps the REQs per relay", async () => {
    vi.useFakeTimers();
    try {
      const client = new NostrClient([], { reqDebounceMs: 0 });
      const subs = fakeReqs(client);
      client.subscribe({ kinds: [1059], "#p": ["x"] }, () => {}, ["wss://r"]);
      client.subscribe({ kinds: [445], "#h": ["g"] }, () => {}, ["wss://r"]);
      await vi.advanceTimersByTimeAsync(0);
      expect(subs).toHaveLength(2);
      // Fill up to the cap with already-sent REQs, then one more: it must JOIN an
      // existing REQ of its class instead of becoming REQ number cap+1.
      for (let i = 0; i < MAX_LONG_LIVED_REQS_PER_RELAY; i++) {
        client.subscribe({ kinds: [1059], "#p": [`p${i}`] }, () => {}, ["wss://r"]);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(client.reqCounts("wss://r").longLived).toBeLessThanOrEqual(MAX_LONG_LIVED_REQS_PER_RELAY);
      expect(open(subs).reduce((n, s) => n + s.filters.length, 0)).toBe(MAX_LONG_LIVED_REQS_PER_RELAY + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a closer drops its filter, and the last closer closes the REQ", async () => {
    vi.useFakeTimers();
    try {
      const client = new NostrClient([], { reqDebounceMs: 10 });
      const subs = fakeReqs(client);
      const a = client.subscribe({ kinds: [1059], "#p": ["a"] }, () => {}, ["wss://r"]);
      const b = client.subscribe({ kinds: [1059], "#p": ["b"] }, () => {}, ["wss://r"]);
      await vi.advanceTimersByTimeAsync(10);
      a();
      await vi.advanceTimersByTimeAsync(10);
      expect(open(subs)).toHaveLength(1);
      expect(open(subs)[0]!.filters.map((f) => f["#p"][0])).toEqual(["b"]);
      b();
      expect(open(subs)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a 'too many concurrent REQs' NOTICE as back-pressure: logged once, refused REQ re-sent later", async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const dbg = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      let t = 1_000_000;
      const client = new NostrClient([], { reqDebounceMs: 0, now: () => t });
      const subs = fakeReqs(client);
      client.subscribe({ kinds: [1059], "#p": ["a"] }, () => {}, ["wss://primal"]);
      await vi.advanceTimersByTimeAsync(0);
      expect(subs).toHaveLength(1);
      // The relay refuses the REQ with a NOTICE (strfry's wording) and never answers it.
      const pool = (client as any).pool;
      for (let i = 0; i < 50; i++) pool.onNotice("wss://primal/", "ERROR: too many concurrent REQs");
      expect(client.isDegraded("wss://primal")).toBe(true);
      expect(subs[0]!.closed).toBe(true);
      const lines = () => out.mock.calls.map((c) => c.join(" ")).filter((l) => l.includes("is refusing REQs"));
      expect(lines()).toHaveLength(1); // once per window, not 50 times
      expect(dbg).not.toHaveBeenCalled();
      // Not resubscribed a second later...
      await vi.advanceTimersByTimeAsync(5_000);
      expect(subs).toHaveLength(1);
      // ...but after the pressure back-off.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(subs).toHaveLength(2);
      expect(subs[1]!.closed).toBe(false);
      // A REQ that already reached EOSE was accepted, so a later NOTICE leaves it alone.
      subs[1]!.handlers.oneose();
      pool.onNotice("wss://primal/", "ERROR: too many concurrent REQs");
      expect(subs[1]!.closed).toBe(false);
      // The window passes: the relay is healthy again.
      t += 6 * 60_000;
      expect(client.isDegraded("wss://primal")).toBe(false);
      // Other notices are passed through as before.
      pool.onNotice("wss://primal/", "hello");
      expect(dbg).toHaveBeenCalledTimes(1);
    } finally {
      out.mockRestore();
      dbg.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a CLOSED 'too many subscriptions' backs off instead of retrying after 5 s", async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const client = new NostrClient([], { reqDebounceMs: 0 });
      const subs = fakeReqs(client);
      client.subscribe({ kinds: [1059] }, () => {}, ["wss://oxtr"]);
      await vi.advanceTimersByTimeAsync(0);
      subs[0]!.handlers.onclose("error: too many subscriptions");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(subs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(subs).toHaveLength(2);
      expect(client.isDegraded("wss://oxtr")).toBe(true);
    } finally {
      out.mockRestore();
      vi.useRealTimers();
    }
  });

  it("queues fetches beyond the per-relay cap, and lowers the cap while degraded", async () => {
    let t = 0;
    const client = new NostrClient([], { now: () => t });
    const reqs: Array<{ params: { oneose?: () => void } }> = [];
    (client as any).pool = {
      subscribe(_relays: string[], _f: unknown, params: { oneose?: () => void }) {
        reqs.push({ params });
        return { close() {} };
      },
      close() {},
    };
    const pending = Array.from({ length: MAX_FETCH_REQS_PER_RELAY + 3 }, () => client.fetch({ kinds: [1] }, ["wss://r"], 60_000));
    expect(reqs).toHaveLength(MAX_FETCH_REQS_PER_RELAY);
    expect(client.reqCounts("wss://r").queuedFetches).toBe(3);
    // One answers: its slot goes to the next in the queue.
    reqs[0]!.params.oneose?.();
    await pending[0];
    expect(reqs).toHaveLength(MAX_FETCH_REQS_PER_RELAY + 1);
    // Degraded: nothing more starts until the open count is under the lower cap.
    (client as any).noteBackpressure("wss://r/", "too many concurrent REQs");
    vi.spyOn(console, "log").mockImplementation(() => {});
    reqs[1]!.params.oneose?.();
    await pending[1];
    expect(reqs).toHaveLength(MAX_FETCH_REQS_PER_RELAY + 1);
    for (let i = 2; i < MAX_FETCH_REQS_PER_RELAY + 1; i++) reqs[i]!.params.oneose?.();
    await Promise.all(pending.slice(2, MAX_FETCH_REQS_PER_RELAY + 1));
    expect(reqs.length).toBeGreaterThan(MAX_FETCH_REQS_PER_RELAY + 1);
    expect(client.reqCounts("wss://r").fetches).toBeLessThanOrEqual(DEGRADED_FETCH_REQS_PER_RELAY);
    for (const r of reqs) r.params.oneose?.();
    for (const r of reqs) r.params.oneose?.();
    await Promise.all(pending);
    t = 0;
    vi.restoreAllMocks();
  });

  it("a fetch still waiting in the queue gives up at its own timeout", async () => {
    const client = new NostrClient([]);
    const reqs: Array<{ params: { oneose?: () => void } }> = [];
    (client as any).pool = {
      subscribe(_relays: string[], _f: unknown, params: { oneose?: () => void }) {
        reqs.push({ params });
        return { close() {} };
      },
      close() {},
    };
    for (let i = 0; i < MAX_FETCH_REQS_PER_RELAY; i++) void client.fetch({ kinds: [1] }, ["wss://r"], 60_000);
    const started = Date.now();
    await expect(client.fetch({ kinds: [1] }, ["wss://r"], 30)).resolves.toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(client.reqCounts("wss://r").queuedFetches).toBe(0); // cancelled, not left to start later
    for (const r of reqs) r.params.oneose?.();
  });
});

describe("NostrClient relays.exclude", () => {
  /** Records every relay set the client hands the pool (fetch, publish) or opens a
   *  long-lived REQ on (subscribe), per call. */
  function recordingPool(client: NostrClient) {
    const dialled: string[][] = [];
    (client as any).pool = {
      subscribe(relays: string[], _f: unknown, params: { oneose?: () => void }) {
        dialled.push(relays);
        queueMicrotask(() => params.oneose?.());
        return { close() {} };
      },
      publish(relays: string[]) {
        dialled.push(relays);
        return relays.map(() => Promise.resolve("ok"));
      },
      close() {},
    };
    (client as any).openReq = (url: string) => {
      dialled.push([url]);
      return { close() {} };
    };
    return dialled;
  }
  const EXCLUDE = { exclude: ["wss://relay.nostr.net"], reqDebounceMs: 0 };
  const flush = () => new Promise((r) => setTimeout(r, 5));
  const ev = { id: "e".repeat(64), kind: 1, pubkey: "a".repeat(64), created_at: 1, tags: [], content: "", sig: "s" } as unknown as NostrEvent;

  it("never subscribes to an excluded relay, however the URL is spelled", async () => {
    const client = new NostrClient([], EXCLUDE);
    const dialled = recordingPool(client);
    client.subscribe({ kinds: [1059] }, () => {}, ["wss://nos.lol", "wss://relay.nostr.net/", "wss://Relay.Nostr.Net"]);
    await flush();
    expect(dialled).toEqual([["wss://nos.lol/"]]);
  });

  it("drops excluded relays from fetch and publish", async () => {
    const client = new NostrClient([], EXCLUDE);
    const dialled = recordingPool(client);
    await client.fetch({ kinds: [1] }, ["wss://relay.nostr.net", "wss://nos.lol"]);
    await client.publish(ev, ["wss://relay.nostr.net", "wss://nos.lol"]);
    expect(dialled).toEqual([["wss://nos.lol/"], ["wss://nos.lol"]]);
  });

  it("keeps the original set when every relay in it is excluded, rather than going deaf", async () => {
    const client = new NostrClient([], EXCLUDE);
    const dialled = recordingPool(client);
    client.subscribe({ kinds: [1059] }, () => {}, ["wss://relay.nostr.net"]);
    await flush();
    expect(dialled).toEqual([["wss://relay.nostr.net/"]]);
  });

  it("never lets an all-excluded candidate set pass a handover probe", async () => {
    const client = new NostrClient([], EXCLUDE);
    const dialled = recordingPool(client);
    await expect(client.probe(["wss://relay.nostr.net"], 50)).resolves.toBe(false);
    expect(dialled).toEqual([]);
  });

  it("excludes nothing when constructed without the option", async () => {
    const client = new NostrClient([], { reqDebounceMs: 0 });
    const dialled = recordingPool(client);
    client.subscribe({ kinds: [1059] }, () => {}, ["wss://relay.nostr.net"]);
    await flush();
    expect(dialled).toEqual([["wss://relay.nostr.net/"]]);
  });
});
