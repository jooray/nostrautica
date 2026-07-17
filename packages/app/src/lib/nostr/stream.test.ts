import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Fake NDK subscription: tests drive `emit` directly.
type Handler = (...args: unknown[]) => void;
class FakeSub {
  handlers = new Map<string, Handler[]>();
  stopped = 0;
  on(name: string, fn: Handler) {
    const list = this.handlers.get(name) ?? [];
    list.push(fn);
    this.handlers.set(name, list);
  }
  emit(name: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(name) ?? []) fn(...args);
  }
  stop() {
    this.stopped++;
  }
}

let currentSub: FakeSub;
vi.mock("./ndk.js", () => ({
  getNdk: () => ({
    subscribe: () => {
      currentSub = new FakeSub();
      return currentSub;
    },
  }),
  relaySet: () => undefined,
}));

import { streamEvents } from "./stream.js";

let seq = 0;
function fakeEvent(raw: Partial<{ id: string; kind: number; pubkey: string; created_at: number; tags: string[][] }>) {
  const full = {
    id: raw.id ?? `id${seq++}`,
    kind: raw.kind ?? 1,
    pubkey: raw.pubkey ?? "pk",
    created_at: raw.created_at ?? 1,
    tags: raw.tags ?? [],
  };
  return { rawEvent: () => full, ...full };
}

beforeEach(() => {
  vi.useFakeTimers();
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
});
