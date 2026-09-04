/**
 * Multi-tab leadership handoff in the chat session (H-7).
 *
 * Reported from a real two-tab session on 2026-09-04: with the chat already open
 * in another tab, the room flickered between "setting up your secure chat" and
 * "no messages yet" several times a second, unusably fast.
 *
 * The cause was the fix that came before it. A tab promoted from follower to
 * leader has no client — the follower branch deliberately constructs none — so
 * the promotion handler called `begin()` to build one. But `begin()` disposes the
 * current coordinator, and disposing RELEASES THE WEB LOCK the tab was just
 * promoted into. With two tabs open, each release promoted the other, each
 * promotion tore down and re-elected, and they traded leadership forever, each
 * one flipping its phase between "setup" and "ready" on every round.
 *
 * The invariant these tests pin is therefore not "the client gets built" (the
 * broken version did that too, eventually) but "the promoted tab KEEPS the
 * coordinator it was promoted into".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChatTabCoordinator, type TabCoordinatorOptions } from "./tab-leader.js";

const chatCreate = vi.hoisted(() => vi.fn());
const resolveChatIdentity = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  MarmotChat: {
    create: chatCreate,
  },
}));
vi.mock("./identity.js", () => ({ resolveChatIdentity }));
vi.mock("./legacy-cleanup.js", () => ({ deleteLegacyChatDeviceKeyBackup: vi.fn() }));

import { chatSession, __setChatCoordinatorFactoryForTests } from "./session.svelte.js";

/** A browser-wide exclusive lock table, shared by every "tab" in a test. */
class FakeLockManager {
  private held = new Set<string>();
  private waiters = new Map<string, Array<() => void>>();
  async request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown | null) => Promise<unknown>,
  ): Promise<unknown> {
    if (options.ifAvailable) {
      if (this.held.has(name)) return callback(null);
      return this.hold(name, callback);
    }
    if (this.held.has(name)) {
      await new Promise<void>((resume, reject) => {
        const w = () => resume();
        (this.waiters.get(name) ?? this.waiters.set(name, []).get(name)!).push(w);
        options.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
      });
    }
    return this.hold(name, callback);
  }
  private async hold(name: string, callback: (lock: unknown | null) => Promise<unknown>) {
    // Real Web Locks grant asynchronously.
    await Promise.resolve();
    this.held.add(name);
    try {
      return await callback({});
    } finally {
      this.held.delete(name);
      this.waiters.get(name)?.shift()?.();
    }
  }
}

class FakeChannel {
  static buses = new Map<string, Set<FakeChannel>>();
  private listeners = new Set<(ev: { data: unknown }) => void>();
  constructor(private name: string) {
    (FakeChannel.buses.get(name) ?? FakeChannel.buses.set(name, new Set()).get(name)!).add(this);
  }
  postMessage(msg: unknown): void {
    for (const ch of FakeChannel.buses.get(this.name) ?? []) {
      if (ch === this) continue;
      for (const l of ch.listeners) queueMicrotask(() => l({ data: structuredClone(msg) }));
    }
  }
  addEventListener(_t: "message", l: (ev: { data: unknown }) => void) {
    this.listeners.add(l);
  }
  removeEventListener(_t: "message", l: (ev: { data: unknown }) => void) {
    this.listeners.delete(l);
  }
  close(): void {
    FakeChannel.buses.get(this.name)?.delete(this);
  }
}

const OWNER = "a".repeat(64);
const ctx = {
  coordinate: "31923:" + "f".repeat(64) + ":ev",
  config: { relays: ["wss://r"] },
} as never;
const signer = { getPublicKey: async () => OWNER } as never;

function fakeChat() {
  return {
    identity: { pubkey: "c".repeat(64) },
    dispose: vi.fn(),
    ensurePublished: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    nostrGroupId: vi.fn().mockResolvedValue("gid"),
    onMessage: undefined,
    onStateChange: undefined,
  };
}

describe("chat session — promotion keeps the lock it was promoted into", () => {
  let locks: FakeLockManager;

  beforeEach(() => {
    vi.clearAllMocks();
    FakeChannel.buses.clear();
    locks = new FakeLockManager();
    resolveChatIdentity.mockResolvedValue({ pubkey: "c".repeat(64) });
    chatCreate.mockImplementation(async () => fakeChat());
    __setChatCoordinatorFactoryForTests(
      (opts: TabCoordinatorOptions) =>
        new ChatTabCoordinator({
          ...opts,
          locks: locks as never,
          createChannel: (n: string) => new FakeChannel(n) as never,
        }),
    );
  });

  afterEach(() => {
    chatSession.dispose();
    __setChatCoordinatorFactoryForTests(null);
  });

  it("builds a client on promotion WITHOUT replacing the coordinator", async () => {
    // Another tab already holds the lock, so this session starts as a follower.
    const otherTab = new ChatTabCoordinator({
      scope: OWNER,
      locks: locks as never,
      createChannel: (n: string) => new FakeChannel(n) as never,
      onRoleChange: () => {},
    });
    await otherTab.whenSettled;
    expect(otherTab.role).toBe("leader");

    await chatSession.ensure("naddr1", ctx, signer, OWNER);
    expect(chatSession.tabRole).toBe("follower");
    expect(chatSession.chat).toBeUndefined();
    const coordinatorWhileFollower = chatSession.__coordinatorForTests;
    expect(coordinatorWhileFollower).toBeDefined();

    // The other tab closes; this one inherits the lock.
    otherTab.dispose();
    await vi.waitFor(() => expect(chatSession.chat).toBeDefined());

    // The client exists AND the coordinator is the same object — the promoted
    // tab still holds the lock it was promoted into.
    expect(chatSession.tabRole).toBe("leader");
    expect(chatSession.__coordinatorForTests).toBe(coordinatorWhileFollower);
    expect(chatCreate).toHaveBeenCalledTimes(1);
  });

  it("does not flip the phase back to setup while promoting", async () => {
    const otherTab = new ChatTabCoordinator({
      scope: OWNER,
      locks: locks as never,
      createChannel: (n: string) => new FakeChannel(n) as never,
      onRoleChange: () => {},
    });
    await otherTab.whenSettled;
    await chatSession.ensure("naddr1", ctx, signer, OWNER);
    expect(chatSession.phase).toBe("ready");

    const seen: string[] = [];
    const stop = $effect.root(() => {
      $effect(() => {
        seen.push(chatSession.phase);
      });
    });

    otherTab.dispose();
    await vi.waitFor(() => expect(chatSession.chat).toBeDefined());
    stop();

    // The room was already showing the departed leader's messages; a promotion
    // must not drop it back to "setting up" for the duration of a client build.
    expect(seen).not.toContain("setup");
    expect(chatSession.phase).toBe("ready");
  });
});
