/**
 * streamEvents with REAL signature verification — no `./verify.js` mock.
 *
 * The sibling stream.test.ts mocks verify.js so it can drive the collector's
 * timing logic with cheap fake events. That left the integration the 2026-07-21
 * incident was actually about — a real, genuinely-signed event surviving the
 * APPK-1 check, and a sig-stripped one being dropped — completely untested. A
 * cache adapter silently storing events without their `sig` (cache-dexie's
 * default) is exactly this shape, and every mocked test in the suite passed
 * throughout the outage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";

type Handler = (...args: unknown[]) => void;
class FakeSub {
  handlers = new Map<string, Handler[]>();
  stopped = 0;
  eosesSeen = new Set<{ url: string }>();
  relayUrls: string[] = [];
  on(name: string, fn: Handler) {
    const list = this.handlers.get(name) ?? [];
    list.push(fn);
    this.handlers.set(name, list);
  }
  emit(name: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(name) ?? []) fn(...args);
  }
  relaysMissingEose(): string[] {
    return this.relayUrls;
  }
  eoseReceived() {}
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
    pool: { connectedRelays: () => [] },
    cacheAdapter: {},
  }),
  relaySet: () => undefined,
}));

import { streamEvents } from "./stream.js";

const sk = generateSecretKey();

/**
 * Wire-shape an event the way it actually reaches us. The JSON round-trip is
 * load-bearing, not cosmetic: nostr-tools memoizes a successful verify on the
 * event OBJECT under a symbol, and `finalizeEvent` sets it. A plain spread
 * carries that symbol along, so a tampered copy would be waved through without
 * any cryptography running at all — which is how the first draft of the
 * tamper test "passed". Events from a relay socket or the Dexie cache are
 * parsed from JSON and never carry it.
 */
function wire(ev: Record<string, unknown>) {
  const raw = JSON.parse(JSON.stringify(ev)) as Record<string, unknown>;
  return { rawEvent: () => raw, tagId: () => String(raw.id), ...raw } as never;
}

/** A real, validly-signed event — the thing a healthy relay/cache serves. */
function signed(over: { kind?: number; content?: string; tags?: string[][]; created_at?: number } = {}) {
  const ev = finalizeEvent(
    {
      kind: over.kind ?? 1,
      created_at: over.created_at ?? Math.floor(Date.now() / 1000),
      tags: over.tags ?? [],
      content: over.content ?? "hello",
    },
    sk,
  );
  return wire(ev as unknown as Record<string, unknown>) as unknown as {
    id: string;
    content: string;
    rawEvent: () => Record<string, unknown>;
  };
}

/** The same event as a pre-`saveSig` cache row would return it: no signature. */
function sigStripped(e: { rawEvent: () => Record<string, unknown> }) {
  const { sig: _sig, ...rest } = e.rawEvent();
  return wire(rest);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("streamEvents with real signature verification (audit APPK-1, incident 2026-07-21)", () => {
  it("accepts a genuinely signed event", async () => {
    const h = streamEvents({ kinds: [1] });
    const ev = signed({ content: "a real note" });
    currentSub.emit("event", ev);
    currentSub.emit("eose");
    await vi.advanceTimersByTimeAsync(400);
    const events = await h.ready;
    expect(events.map((e: any) => e.id)).toEqual([ev.id]);
  });

  it("drops the SAME event once its signature is stripped — the incident, exactly", async () => {
    const h = streamEvents({ kinds: [1] });
    currentSub.emit("event", sigStripped(signed({ content: "served from a pre-saveSig cache" })));
    currentSub.emit("eose");
    await vi.advanceTimersByTimeAsync(400);
    await expect(h.ready).resolves.toEqual([]);
  });

  it("drops an event whose content was tampered with after signing", async () => {
    const ev = signed({ content: "original" });
    const h = streamEvents({ kinds: [1] });
    currentSub.emit("event", wire({ ...ev.rawEvent(), content: "tampered" }));
    currentSub.emit("eose");
    await vi.advanceTimersByTimeAsync(400);
    await expect(h.ready).resolves.toEqual([]);
  });

  it("a stripped copy arriving first does not suppress the genuine one", async () => {
    // Real-signature version of the memoization guard: failures must not be
    // cached, or a bad copy racing ahead would censor the real event.
    const ev = signed({ content: "note" });
    const h = streamEvents({ kinds: [1] }, { onEvent: () => {} });
    currentSub.emit("event", sigStripped(ev));
    currentSub.emit("event", ev);
    currentSub.emit("eose");
    await vi.advanceTimersByTimeAsync(400);
    const events = await h.ready;
    expect(events.map((e: any) => e.id)).toEqual([ev.id]);
    h.stop();
  });

  it("a forged newer replaceable event cannot displace the genuine older one", async () => {
    // 31600 is the event config: whoever wins 'latest' owns the whole event.
    const tags = [["d", "my-event"]];
    const real = signed({ kind: 31600, tags, created_at: 1_700_000_000, content: "real config" });
    const forged = wire({ ...real.rawEvent(), created_at: 1_900_000_000, content: "forged config" });
    const got: string[] = [];
    streamEvents({ kinds: [31600] }, { onEvent: (e: any) => got.push(e.content) });
    currentSub.emit("event", real);
    currentSub.emit("event", forged);
    expect(got).toEqual(["real config"]);
  });
});
