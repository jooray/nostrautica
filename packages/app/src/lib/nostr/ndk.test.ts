/**
 * Relay URL acceptance (audit APPR-8): only wss:// relays are added to the pool;
 * plaintext ws:// is loopback-only (the local e2e/dev stack).
 *
 * Also covers UX-1: `fetchEvents`/`fetchEventsRelayOnly` are time-bounded —
 * built on the streamEvents collector (first-EOSE+grace, 8s hard cap), they
 * resolve with partial results instead of hanging when no relay ever EOSEs
 * (dead-relay majority, e.g. conference Wi-Fi with WSS blocked).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Real cache-dexie strips `sig` by default (`saveSig` option, default false) —
// verified against node_modules/.pnpm/@nostr-dev-kit+cache-dexie*/…/index.js.
// Spy on the constructor so a regression (forgetting `saveSig: true`) fails
// loudly instead of silently breaking every cache-served event's
// re-verification (audit APPK-1) — reproduced live: a config event served
// from the Dexie cache came back with no `sig` at all, so `onlyVerified()`
// rejected it and `loadEventContext` threw "Event config (31600) not found"
// even for the organizer's own just-created event.
const { DexieMock } = vi.hoisted(() => ({ DexieMock: vi.fn().mockImplementation(() => ({})) }));
vi.mock("@nostr-dev-kit/cache-dexie", () => ({ default: DexieMock }));

// streamEvents (audit APPK-1 self-heal, see stream.test.ts) now verifies every
// event's real signature before accepting it — this file's fake events don't
// carry one, so default verification to "pass" here; it's not what these
// UX-1 timing tests are about.
const { isVerifiedMock } = vi.hoisted(() => ({ isVerifiedMock: vi.fn((..._args: unknown[]) => true) }));
vi.mock("./verify.js", () => ({ isVerified: isVerifiedMock }));

import {
  isAcceptedRelayUrl,
  fetchEvents,
  fetchEventsRelayOnly,
  getNdk,
  connectNdk,
  relayHealth,
  __setNdkForTests,
  __resetRelayHealthForTests,
} from "./ndk.js";
import type NDK from "@nostr-dev-kit/ndk";

describe("isAcceptedRelayUrl (APPR-8)", () => {
  it("accepts wss:// relay URLs", () => {
    expect(isAcceptedRelayUrl("wss://relay.primal.net")).toBe(true);
    expect(isAcceptedRelayUrl("wss://nos.lol/")).toBe(true);
  });

  it("rejects plaintext ws:// to remote hosts", () => {
    expect(isAcceptedRelayUrl("ws://evil-relay.example")).toBe(false);
    expect(isAcceptedRelayUrl("ws://203.0.113.7:7777")).toBe(false);
  });

  it("accepts ws:// on loopback only (local e2e/dev relay)", () => {
    expect(isAcceptedRelayUrl("ws://localhost:7777")).toBe(true);
    expect(isAcceptedRelayUrl("ws://127.0.0.1:7777")).toBe(true);
    expect(isAcceptedRelayUrl("ws://[::1]:7777")).toBe(true);
  });

  it("rejects non-relay schemes and malformed URLs", () => {
    expect(isAcceptedRelayUrl("https://not-a-relay.example")).toBe(false);
    expect(isAcceptedRelayUrl("javascript:alert(1)")).toBe(false);
    expect(isAcceptedRelayUrl("not a url")).toBe(false);
    expect(isAcceptedRelayUrl("")).toBe(false);
  });
});

// ── UX-1: time-bounded fetchEvents (through the real streamEvents collector) ──

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
let capturedOpts: Record<string, unknown> | undefined;

function fakeNdk() {
  return {
    subscribe: (_filters: unknown, opts: Record<string, unknown>) => {
      capturedOpts = opts;
      currentSub = new FakeSub();
      return currentSub;
    },
    pool: { connectedRelays: () => [] },
  } as unknown as NDK;
}

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

describe("fetchEvents / fetchEventsRelayOnly (UX-1: time-bounded)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __setNdkForTests(fakeNdk());
    capturedOpts = undefined;
  });
  afterEach(() => {
    __setNdkForTests(null);
    vi.useRealTimers();
  });

  it("resolves on EOSE + grace with the deduped snapshot", async () => {
    const p = fetchEvents({ kinds: [1] });
    currentSub.emit("event", fakeEvent({ id: "a" }));
    currentSub.emit("event", fakeEvent({ id: "a" })); // same id from a second relay
    currentSub.emit("event", fakeEvent({ id: "b" }));
    currentSub.emit("eose");
    await vi.advanceTimersByTimeAsync(400);
    const events = await p;
    expect(events.map((e) => e.id).sort()).toEqual(["a", "b"]);
    expect(currentSub.stopped).toBeGreaterThan(0);
  });

  it("a never-EOSE fetch resolves at the hard timeout with partial results", async () => {
    const p = fetchEvents({ kinds: [1] });
    currentSub.emit("event", fakeEvent({ id: "partial" }));
    await vi.advanceTimersByTimeAsync(8000);
    const events = await p;
    expect(events.map((e) => e.id)).toEqual(["partial"]);
    expect(currentSub.stopped).toBeGreaterThan(0);
  });

  it("zero connected relays and zero events: resolves empty, never hangs", async () => {
    const p = fetchEvents({ kinds: [1] });
    await vi.advanceTimersByTimeAsync(8000);
    await expect(p).resolves.toEqual([]);
  });

  it("honours a caller-provided timeoutMs", async () => {
    const p = fetchEvents({ kinds: [1] }, undefined, { timeoutMs: 1500 });
    await vi.advanceTimersByTimeAsync(1500);
    await expect(p).resolves.toEqual([]);
  });

  it("fetchEventsRelayOnly subscribes with ONLY_RELAY cache usage", async () => {
    const p = fetchEventsRelayOnly({ kinds: [1059] });
    expect(capturedOpts?.cacheUsage).toBe("ONLY_RELAY");
    currentSub.emit("eose");
    await vi.advanceTimersByTimeAsync(400);
    await expect(p).resolves.toEqual([]);
  });

  it("plain fetchEvents keeps the cache-first default (no ONLY_RELAY)", async () => {
    const p = fetchEvents({ kinds: [1] });
    expect(capturedOpts?.cacheUsage).toBeUndefined();
    currentSub.emit("eose");
    await vi.advanceTimersByTimeAsync(400);
    await expect(p).resolves.toEqual([]);
  });
});

// ── item 5: relay-connection lifecycle for the connectivity banner ────────────
// The banner must not accuse the network before a single relay socket has even
// been attempted. relayHealth() distinguishes idle (never tried) / connecting
// (in flight) / connected / failed; only "failed" earns "relay-blocked".
describe("relayHealth (item 5: no false 'blocked' before an attempt)", () => {
  let connected: unknown[] = [];
  let pendingConnects: Array<() => void> = [];

  function fakeNdkWithConnect() {
    return {
      pool: { connectedRelays: () => connected },
      // connect() stays pending until the test releases it, so the in-flight
      // "connecting" window is observable.
      connect: () => new Promise<void>((res) => pendingConnects.push(res)),
    } as unknown as NDK;
  }

  beforeEach(() => {
    __resetRelayHealthForTests();
    connected = [];
    pendingConnects = [];
    __setNdkForTests(fakeNdkWithConnect());
  });
  afterEach(() => {
    __setNdkForTests(null);
    __resetRelayHealthForTests();
  });

  it("is idle before any connection has been attempted (logged-out home — NO banner)", () => {
    expect(relayHealth()).toBe("idle");
  });

  it("is connecting while an attempt is in flight, then failed once it returns empty", async () => {
    const p = connectNdk();
    expect(relayHealth()).toBe("connecting"); // attempt started, not settled, 0 connected
    pendingConnects.shift()?.();
    await p;
    expect(relayHealth()).toBe("failed"); // bounded connect returned with 0 relays → the WiFi lie
  });

  it("is connected the moment a relay socket is open, regardless of prior state", async () => {
    const p = connectNdk();
    connected = [{ url: "wss://relay.example" }];
    pendingConnects.shift()?.();
    await p;
    expect(relayHealth()).toBe("connected");
  });

  it("clears back to connected when a relay (re)connects after a failed attempt", async () => {
    const p = connectNdk();
    pendingConnects.shift()?.();
    await p;
    expect(relayHealth()).toBe("failed");
    connected = [{ url: "wss://relay.example" }]; // background reconnect succeeds
    expect(relayHealth()).toBe("connected");
  });

  it("returns to connecting while retrying after a failed attempt", async () => {
    const first = connectNdk();
    pendingConnects.shift()?.();
    await first;
    expect(relayHealth()).toBe("failed");

    const retry = connectNdk();
    expect(relayHealth()).toBe("connecting");
    pendingConnects.shift()?.();
    await retry;
    expect(relayHealth()).toBe("failed");
  });

  it("stays connecting until every overlapping attempt has settled", async () => {
    const first = connectNdk();
    const second = connectNdk();
    expect(relayHealth()).toBe("connecting");

    pendingConnects.shift()?.();
    await first;
    expect(relayHealth()).toBe("connecting");

    pendingConnects.shift()?.();
    await second;
    expect(relayHealth()).toBe("failed");
  });
});

describe("getNdk cache adapter config (audit APPK-1 regression)", () => {
  const originalIndexedDB = (globalThis as { indexedDB?: unknown }).indexedDB;

  const deleteDatabase = vi.fn();

  beforeEach(() => {
    __setNdkForTests(null);
    DexieMock.mockClear();
    deleteDatabase.mockClear();
    (globalThis as { indexedDB?: unknown }).indexedDB = { deleteDatabase };
  });
  afterEach(() => {
    __setNdkForTests(null);
    (globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDB;
  });

  it("persists event signatures in the Dexie cache — onlyVerified() can't pass a sig-less cache hit", () => {
    getNdk();
    expect(DexieMock).toHaveBeenCalledTimes(1);
    expect(DexieMock.mock.calls[0]![0]).toMatchObject({ saveSig: true });
  });

  // Incident 2026-07-21: pre-saveSig rows are unfixable in place — cache-dexie's
  // deleteEventIds can't remove them (Dexie's where({id: array}) is an equality
  // match against the whole array, never a string id) and NDK's setEventDup
  // means a relay's real copy never overwrites them. The versioned DB name is
  // the actual fix; pointing it back at the old name would silently re-wedge
  // every browser that ever loaded the app before saveSig shipped.
  it("uses a cache DB name that is NOT the poisoned pre-saveSig one", () => {
    getNdk();
    const dbName = (DexieMock.mock.calls[0]![0] as { dbName: string }).dbName;
    expect(dbName).not.toBe("nostrautica-cache");
    expect(dbName).toMatch(/^nostrautica-cache-v\d+$/);
  });

  it("drops the retired cache DB on startup so the rename doesn't strand dead storage", () => {
    getNdk();
    expect(deleteDatabase).toHaveBeenCalledWith("nostrautica-cache");
  });
});
