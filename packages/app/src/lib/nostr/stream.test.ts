import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Fake NDK subscription: tests drive `emit` directly.
type Handler = (...args: unknown[]) => void;
class FakeSub {
  handlers = new Map<string, Handler[]>();
  stopped = 0;
  // Per-relay EOSE bookkeeping (UX-18): mirrors NDKSubscription's public surface.
  eosesSeen = new Set<{ url: string }>();
  relayUrls: string[] = []; // urls the sub executed on (NDK's relayFilters keys)
  on(name: string, fn: Handler) {
    const list = this.handlers.get(name) ?? [];
    list.push(fn);
    this.handlers.set(name, list);
  }
  emit(name: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(name) ?? []) fn(...args);
  }
  relaysMissingEose(): string[] {
    return this.relayUrls.filter((u) => ![...this.eosesSeen].some((r) => r.url === u));
  }
  eoseReceived(relay: { url: string }) {
    this.eosesSeen.add(relay);
  }
  stop() {
    this.stopped++;
  }
}

let currentSub: FakeSub;
let connectedUrls: string[] = [];
const deleteEventIds = vi.fn(async (_ids: string[]) => {});
vi.mock("./ndk.js", () => ({
  getNdk: () => ({
    subscribe: () => {
      currentSub = new FakeSub();
      return currentSub;
    },
    pool: { connectedRelays: () => connectedUrls.map((url) => ({ url })) },
    cacheAdapter: { deleteEventIds },
  }),
  relaySet: () => undefined,
}));

// Real signature verification is `./verify.js`'s own concern (crypto correctness,
// not this collector's job) — default every fake event to "verified" so the
// existing tests below (which never construct real signed events) are
// unaffected, and flip it per-test to exercise the purge-on-arrival path.
const { isVerifiedMock } = vi.hoisted(() => ({
  isVerifiedMock: vi.fn((..._args: unknown[]) => true),
}));
vi.mock("./verify.js", () => ({ isVerified: isVerifiedMock }));

import { streamEvents } from "./stream.js";

let seq = 0;
function fakeEvent(
  raw: Partial<{ id: string; kind: number; pubkey: string; created_at: number; tags: string[][]; tagId: string }>,
) {
  const full = {
    id: raw.id ?? `id${seq++}`,
    kind: raw.kind ?? 1,
    pubkey: raw.pubkey ?? "pk",
    created_at: raw.created_at ?? 1,
    tags: raw.tags ?? [],
  };
  // NDKEvent.tagId(): the raw event id for regular kinds, but
  // "kind:pubkey:d-tag" for replaceable/addressable ones — cache-dexie keys
  // its store by THIS, not the raw id (see stream.ts's purge comment).
  // Defaults to something visibly different from `id` so a test that only
  // asserts on `id` would fail loudly instead of passing by accident.
  const tagId = raw.tagId ?? `tag:${full.id}`;
  return { rawEvent: () => full, tagId: () => tagId, ...full };
}

beforeEach(() => {
  vi.useFakeTimers();
  connectedUrls = [];
  isVerifiedMock.mockReset().mockReturnValue(true);
  deleteEventIds.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("streamEvents", () => {
  it("resolves ready on first EOSE + grace with the deduped snapshot", async () => {
    const h = streamEvents({ kinds: [1] }, { graceMs: 400, timeoutMs: 8000 });
    currentSub.emit("event", fakeEvent({ id: "a" }));
    currentSub.emit("event", fakeEvent({ id: "a" })); // duplicate from a second relay
    currentSub.emit("event", fakeEvent({ id: "b" }));
    currentSub.emit("eose");
    await vi.advanceTimersByTimeAsync(400);
    const events = await h.ready;
    expect(events.map((e: any) => e.id).sort()).toEqual(["a", "b"]);
    expect(currentSub.stopped).toBeGreaterThan(0); // one-shot caller: sub freed
  });

  it("resolves at the hard timeout when no EOSE ever arrives", async () => {
    const h = streamEvents({ kinds: [1] }, { timeoutMs: 6000 });
    currentSub.emit("event", fakeEvent({ id: "a" }));
    await vi.advanceTimersByTimeAsync(6000);
    const events = await h.ready;
    expect(events).toHaveLength(1);
    expect(currentSub.stopped).toBeGreaterThan(0);
  });

  it("delivers late (post-EOSE) events to onEvent and hard-stops at timeoutMs", async () => {
    const got: string[] = [];
    const h = streamEvents(
      { kinds: [1] },
      { graceMs: 100, timeoutMs: 5000, onEvent: (e: any) => got.push(e.id) },
    );
    currentSub.emit("event", fakeEvent({ id: "a" }));
    currentSub.emit("eose");
    await vi.advanceTimersByTimeAsync(100);
    await h.ready;
    expect(currentSub.stopped).toBe(0); // live caller keeps the sub open
    currentSub.emit("event", fakeEvent({ id: "late" }));
    expect(got).toEqual(["a", "late"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(currentSub.stopped).toBeGreaterThan(0); // leak guard
  });

  it("latest-wins for replaceable events, late older version rejected", async () => {
    const got: string[] = [];
    streamEvents(
      { kinds: [31600] },
      { onEvent: (e: any) => got.push(e.id) },
    );
    currentSub.emit(
      "event",
      fakeEvent({ id: "new", kind: 31600, pubkey: "a", tags: [["d", "x"]], created_at: 200 }),
    );
    currentSub.emit(
      "event",
      fakeEvent({ id: "old", kind: 31600, pubkey: "a", tags: [["d", "x"]], created_at: 100 }),
    );
    expect(got).toEqual(["new"]);
  });

  it("stop() is idempotent and always settles ready", async () => {
    const h = streamEvents({ kinds: [1] });
    h.stop();
    h.stop();
    const events = await h.ready;
    expect(events).toEqual([]);
    expect(currentSub.stopped).toBe(1);
  });

  // UX-18: a dead relay in the set must not cost the full hard timeout — the
  // stream settles (grace) once every CONNECTED relay has EOSEd individually.
  it("settles early once every connected relay has EOSEd, ignoring dead ones", async () => {
    const h = streamEvents({ kinds: [1] }, { graceMs: 400, timeoutMs: 8000 });
    currentSub.relayUrls = ["wss://alive", "wss://dead"];
    connectedUrls = ["wss://alive"]; // "wss://dead" never connected
    currentSub.emit("event", fakeEvent({ id: "a" }));
    currentSub.eoseReceived({ url: "wss://alive" });
    await vi.advanceTimersByTimeAsync(400); // grace only — nowhere near the 8s cap
    const events = await h.ready;
    expect(events.map((e: any) => e.id)).toEqual(["a"]);
    expect(currentSub.stopped).toBeGreaterThan(0);
  });

  it("keeps waiting while a CONNECTED relay is still missing EOSE", async () => {
    const h = streamEvents({ kinds: [1] }, { graceMs: 400, timeoutMs: 8000 });
    currentSub.relayUrls = ["wss://one", "wss://two"];
    connectedUrls = ["wss://one", "wss://two"]; // both alive — one EOSE isn't enough
    currentSub.emit("event", fakeEvent({ id: "a" }));
    currentSub.eoseReceived({ url: "wss://one" });
    let settled = false;
    void h.ready.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false);
    // Aggregated EOSE (both relays answered) still settles via the normal path.
    currentSub.eoseReceived({ url: "wss://two" });
    currentSub.emit("eose");
    await vi.advanceTimersByTimeAsync(400);
    await expect(h.ready).resolves.toHaveLength(1);
  });

  it("never-EOSE fetch still resolves at the hard timeout with partial results", async () => {
    const h = streamEvents({ kinds: [1] }, { graceMs: 400, timeoutMs: 8000 });
    connectedUrls = []; // zero connected relays: no EOSE of any kind ever fires
    currentSub.emit("event", fakeEvent({ id: "partial" }));
    await vi.advanceTimersByTimeAsync(8000);
    await expect(h.ready).resolves.toHaveLength(1);
  });

  // Audit APPK-1 + incident 2026-07-21: cache-dexie shipped without `saveSig`
  // for a window, so browsers that used the app then have cached events with
  // no signature — onlyVerified() rejects those forever unless something
  // purges them. streamEvents is the one place every fetch (cache-first AND
  // relay) funnels through, so the purge belongs here, not scattered across
  // every call site.
  describe("purges an event that fails signature verification (audit APPK-1 self-heal)", () => {
    it("drops it from the result and deletes it from the cache by BOTH its raw id and tagId", async () => {
      // Regression: the first version of this fix only deleted by raw.id,
      // which is a silent no-op for replaceable/addressable kinds (31600,
      // 31923, ...) — cache-dexie keys those by tagId() ("kind:pubkey:d"),
      // not the event hash. Reproduced live: the purge "succeeded" but the
      // stale entry was still served on the very next fetch, forever.
      const h = streamEvents({ kinds: [1] });
      isVerifiedMock.mockImplementation((e: unknown) => (e as { id: string }).id !== "bad");
      currentSub.emit("event", fakeEvent({ id: "bad", tagId: "31600:pk:d-tag" }));
      currentSub.emit("event", fakeEvent({ id: "good" }));
      currentSub.emit("eose");
      await vi.advanceTimersByTimeAsync(400);
      const events = await h.ready;
      expect(events.map((e: any) => e.id)).toEqual(["good"]);
      expect(deleteEventIds).toHaveBeenCalledWith(["bad", "31600:pk:d-tag"]);
    });

    it("a relay delivering the same id again with a real signature afterwards is accepted normally", async () => {
      // Simulates the self-heal: a stale sig-less cache hit arrives first and
      // is purged, then the live relay subscription delivers the SAME event id
      // moments later — now with a signature — through the same callback.
      const h = streamEvents({ kinds: [1] }, { onEvent: () => {} });
      isVerifiedMock.mockReturnValueOnce(false).mockReturnValue(true);
      currentSub.emit("event", fakeEvent({ id: "e1" })); // stale cache hit — purged
      currentSub.emit("event", fakeEvent({ id: "e1" })); // relay's real copy — accepted
      currentSub.emit("eose");
      await vi.advanceTimersByTimeAsync(400);
      const events = await h.ready;
      expect(events.map((e: any) => e.id)).toEqual(["e1"]);
      expect(deleteEventIds).toHaveBeenCalledTimes(1);
      h.stop();
    });
  });
});
