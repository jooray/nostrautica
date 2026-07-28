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
  addRelays,
  publishSigned,
  __dynamicRelayCount,
  __resetDynamicRelaysForTests,
} from "./ndk.js";
import { DEFAULT_RELAYS } from "./relays.js";
import { normalizeRelayUrl } from "@nostr-dev-kit/ndk";
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

describe("addRelays: bounded event-relay growth (audit U16)", () => {
  function poolNdk() {
    const removed: string[] = [];
    const added: string[] = [];
    const ndk = {
      addExplicitRelay: (url: string) => {
        added.push(url);
        return { url: new URL(url).href };
      },
      pool: {
        connectedRelays: () => [],
        removeRelay: (url: string) => {
          removed.push(url);
          return true;
        },
      },
    } as unknown as NDK;
    return { ndk, removed, added };
  }

  beforeEach(() => {
    __resetDynamicRelaysForTests();
  });
  afterEach(() => {
    __setNdkForTests(null);
    __resetDynamicRelaysForTests();
  });

  it("caps the dynamic pool and evicts the least-recently-added relay", () => {
    const { ndk, removed } = poolNdk();
    __setNdkForTests(ndk);
    const urls = Array.from({ length: 25 }, (_, i) => `wss://r${i}.example`);
    for (const u of urls) addRelays([u]);
    // Never grows past the cap, and the overflow evicted the OLDEST relays first.
    expect(__dynamicRelayCount()).toBe(20);
    expect(removed).toHaveLength(5);
    expect(removed).toEqual(urls.slice(0, 5).map((u) => new URL(u).href));
  });

  it("re-visiting a relay refreshes its recency so it isn't evicted next", () => {
    const { ndk, removed } = poolNdk();
    __setNdkForTests(ndk);
    for (let i = 0; i < 20; i++) addRelays([`wss://r${i}.example`]);
    // Touch the oldest (r0) again → it becomes newest.
    addRelays(["wss://r0.example"]);
    // One more distinct relay overflows: r1 (now the oldest) is evicted, not r0.
    addRelays(["wss://r20.example"]);
    expect(removed).toEqual([new URL("wss://r1.example").href]);
    expect(__dynamicRelayCount()).toBe(20);
  });

  it("never tracks or evicts the app's permanent default relays", () => {
    const { ndk, removed } = poolNdk();
    __setNdkForTests(ndk);
    // The first default relay is permanent — adding it must not consume a slot.
    addRelays([DEFAULT_RELAYS[0]!]);
    expect(__dynamicRelayCount()).toBe(0);
    for (let i = 0; i < 25; i++) addRelays([`wss://d${i}.example`]);
    expect(__dynamicRelayCount()).toBe(20);
    // The default relay was never a removeRelay target.
    expect(removed).not.toContain(new URL(DEFAULT_RELAYS[0]!).href);
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

// ── Per-relay publish failures never surface as exceptions ───────────────────
// Firefox, prod, 2026-07-28: with DevTools "pause on exceptions" on, publishing a
// 31600 (or the NIP-09 kind-5 that retires the legacy chat backup) halted the
// debugger on `Error: blocked: kind 31600 is not accepted by this relay`. A
// chat-enabled event's relay set includes the two whitenoise relays, which accept
// ONLY kinds 0/3/445/1059/10000/10002/10050/30443 and refuse everything else with
// exactly that message — so those two refusals happen on EVERY such publish, by
// design. NDK routed them through `.catch(onError)` ending in a bare `throw err`,
// which a debugger sees as uncaught (its only enclosing try is inside the engine's
// self-hosted promise job). publishSigned now fans out itself, attaching both
// handlers to each per-relay promise at creation and never re-throwing.
describe("publishSigned: a relay refusing the kind is handled, not thrown", () => {
  type FakeRelay = ReturnType<typeof fakeRelay>;

  function fakeRelay(url: string, behaviour: (resolve: () => void, reject: (e: Error) => void) => void) {
    const listeners = new Map<string, Array<() => void>>();
    const relay = {
      url: normalizeRelayUrl(url),
      status: 5 /* NDKRelayStatus.CONNECTED */,
      publishCalls: 0,
      connect: async () => {},
      connectivity: {
        publish: () => {
          relay.publishCalls++;
          return new Promise<string>((res, rej) => behaviour(() => res("ok"), rej));
        },
      },
      // NDK's throwing publisher — if publishSigned ever calls this again, the
      // `throw err` that pauses the debugger is back.
      publish: () => {
        throw new Error("NDKRelay.publish must not be used by publishSigned");
      },
      on: (name: string, fn: () => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), fn]);
      },
      removeListener: (name: string, fn: () => void) => {
        listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== fn));
      },
      emit: () => {},
    };
    return relay;
  }

  function ndkWithRelays(relays: FakeRelay[]) {
    const pool = {
      relays: new Map(relays.map((r) => [r.url, r])),
      useTemporaryRelay: () => {},
      connectedRelays: () => relays,
    };
    return {
      pool,
      debug: Object.assign(() => {}, { extend: () => Object.assign(() => {}, { extend: () => () => {} }) }),
    } as unknown as NDK;
  }

  const BLOCKED = "blocked: kind 31600 is not accepted by this relay";
  const signed = { id: "e".repeat(64), kind: 31600, pubkey: "a".repeat(64), created_at: 1, tags: [], content: "", sig: "s" };

  const refusing = (url: string) => fakeRelay(url, (_ok, fail) => fail(new Error(BLOCKED)));
  const accepting = (url: string) => fakeRelay(url, (ok) => ok());

  afterEach(() => {
    __setNdkForTests(null);
    vi.restoreAllMocks();
  });

  it("resolves when one relay accepts and two refuse the kind", async () => {
    const relays = [
      refusing("wss://relay.us.whitenoise.chat"),
      accepting("wss://nostr.cypherpunk.today"),
      refusing("wss://relay.eu.whitenoise.chat"),
    ];
    __setNdkForTests(ndkWithRelays(relays));
    const outcomes = await publishSigned(signed as never, relays.map((r) => r.url));
    expect(outcomes.filter((o) => o.ok).map((o) => o.url)).toEqual([
      normalizeRelayUrl("wss://nostr.cypherpunk.today"),
    ]);
    expect(outcomes.filter((o) => !o.ok).map((o) => o.reason)).toEqual([BLOCKED, BLOCKED]);
  });

  it("logs each refusal quietly (debug, not error) so it stays diagnosable", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const relays = [refusing("wss://relay.us.whitenoise.chat"), accepting("wss://nostr.cypherpunk.today")];
    __setNdkForTests(ndkWithRelays(relays));
    await publishSigned(signed as never, relays.map((r) => r.url));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining(BLOCKED));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("a refusal that lands AFTER the publish resolved is still handled (no orphan)", async () => {
    const orphans: unknown[] = [];
    const onOrphan = (r: unknown) => orphans.push(r);
    process.on("unhandledRejection", onOrphan);
    try {
      let rejectLate: (e: Error) => void = () => {};
      const slow = fakeRelay("wss://relay.eu.whitenoise.chat", (_ok, fail) => {
        rejectLate = fail;
      });
      const relays = [slow, accepting("wss://nostr.cypherpunk.today")];
      __setNdkForTests(ndkWithRelays(relays));
      vi.useFakeTimers();
      const p = publishSigned(signed as never, relays.map((r) => r.url));
      // The slow relay loses the per-relay budget; the publish already succeeded.
      await vi.advanceTimersByTimeAsync(3000);
      await p;
      vi.useRealTimers();
      // ...and only NOW does it answer OK=false. In production this is the exact
      // shape that used to reach `unhandledrejection`.
      rejectLate(new Error(BLOCKED));
      await new Promise((r) => setTimeout(r, 20));
      expect(orphans).toEqual([]);
    } finally {
      vi.useRealTimers();
      process.off("unhandledRejection", onOrphan);
    }
  });

  it("throws only when EVERY relay refused, keeping the wording publishOrQueue keys off", async () => {
    const relays = [refusing("wss://relay.us.whitenoise.chat"), refusing("wss://relay.eu.whitenoise.chat")];
    __setNdkForTests(ndkWithRelays(relays));
    await expect(publishSigned(signed as never, relays.map((r) => r.url))).rejects.toThrow(
      /not enough relays received the event/i,
    );
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
