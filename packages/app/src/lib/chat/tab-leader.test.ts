/**
 * Leader-election + follower-proxy unit tests for the multi-tab coordinator (H-7).
 *
 * A shared FakeLockManager models the browser-wide exclusive lock table (all "tabs"
 * inject the same instance, exactly as real tabs share one origin lock table), and a
 * FakeBus wires several FakeBroadcastChannels together (delivering to peers, never to
 * self, asynchronously — like the real BroadcastChannel). No real browser is needed;
 * dual-context crash-takeover timing still needs the e2e phase.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ChatTabCoordinator,
  type LockManagerLike,
  type BroadcastChannelLike,
  type TabRole,
} from "./tab-leader.js";

// ── a browser-wide exclusive lock table ───────────────────────────────────────
class FakeLockManager implements LockManagerLike {
  private held = new Set<string>();
  private waiters = new Map<string, Array<() => void>>();

  async request(
    name: string,
    options: { mode?: "exclusive" | "shared"; ifAvailable?: boolean; signal?: AbortSignal },
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
        options.signal?.addEventListener("abort", () => {
          const arr = this.waiters.get(name);
          const i = arr?.indexOf(w) ?? -1;
          if (arr && i >= 0) arr.splice(i, 1);
          reject(new Error("AbortError"));
        });
      });
    }
    return this.hold(name, callback);
  }

  private async hold(name: string, callback: (lock: unknown | null) => Promise<unknown>): Promise<unknown> {
    this.held.add(name);
    try {
      return await callback({});
    } finally {
      this.held.delete(name);
      const next = this.waiters.get(name)?.shift();
      if (next) next();
    }
  }
}

// ── a BroadcastChannel bus ────────────────────────────────────────────────────
class FakeBus {
  channels = new Map<string, Set<FakeChannel>>();
  make = (name: string): BroadcastChannelLike => new FakeChannel(this, name);
}
class FakeChannel implements BroadcastChannelLike {
  private listeners = new Set<(ev: { data: unknown }) => void>();
  constructor(
    private bus: FakeBus,
    private name: string,
  ) {
    (bus.channels.get(name) ?? bus.channels.set(name, new Set()).get(name)!).add(this);
  }
  postMessage(msg: unknown): void {
    const data = typeof structuredClone === "function" ? structuredClone(msg) : JSON.parse(JSON.stringify(msg));
    for (const ch of this.bus.channels.get(this.name) ?? []) {
      if (ch === this) continue; // BroadcastChannel never echoes to the sender
      for (const l of ch.listeners) queueMicrotask(() => l({ data }));
    }
  }
  addEventListener(_t: "message", l: (ev: { data: unknown }) => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_t: "message", l: (ev: { data: unknown }) => void): void {
    this.listeners.delete(l);
  }
  close(): void {
    this.bus.channels.get(this.name)?.delete(this);
  }
}

const SCOPE = "a".repeat(64);
const COORD = "31923:" + "f".repeat(64) + ":ev";

function msg(id: string, content = "hi"): import("./messages.js").ChatMessage {
  return {
    id,
    pubkey: "c".repeat(64),
    kind: 9,
    content,
    createdAt: 1,
    tags: [],
  };
}

describe("ChatTabCoordinator — Web Locks leader election", () => {
  let bus: FakeBus;
  let locks: FakeLockManager;
  beforeEach(() => {
    bus = new FakeBus();
    locks = new FakeLockManager();
  });

  it("the first (uncontended) tab becomes leader", async () => {
    const roles: TabRole[] = [];
    const c = new ChatTabCoordinator({
      scope: SCOPE,
      locks,
      createChannel: bus.make,
      onRoleChange: (r) => roles.push(r),
    });
    await c.whenSettled;
    expect(c.role).toBe("leader");
    expect(c.usingWebLocks).toBe(true);
    expect(roles).toEqual(["leader"]);
    c.dispose();
  });

  it("a second tab becomes a follower while the first holds the lock", async () => {
    const leader = new ChatTabCoordinator({ scope: SCOPE, locks, createChannel: bus.make, onRoleChange: () => {} });
    await leader.whenSettled;
    const follower = new ChatTabCoordinator({ scope: SCOPE, locks, createChannel: bus.make, onRoleChange: () => {} });
    await follower.whenSettled;
    expect(leader.role).toBe("leader");
    expect(follower.role).toBe("follower");
    leader.dispose();
    follower.dispose();
  });

  it("promotes a follower to leader when the leader releases (crash/close takeover)", async () => {
    const leader = new ChatTabCoordinator({ scope: SCOPE, locks, createChannel: bus.make, onRoleChange: () => {} });
    await leader.whenSettled;
    const follower = new ChatTabCoordinator({ scope: SCOPE, locks, createChannel: bus.make, onRoleChange: () => {} });
    await follower.whenSettled;
    expect(follower.role).toBe("follower");

    // The leader tab closes → its held lock releases → the follower is promoted.
    leader.dispose();
    await vi.waitFor(() => expect(follower.role).toBe("leader"));
    follower.dispose();
  });
});

describe("ChatTabCoordinator — leader→follower broadcast + send proxy", () => {
  let bus: FakeBus;
  let locks: FakeLockManager;
  beforeEach(() => {
    bus = new FakeBus();
    locks = new FakeLockManager();
  });

  it("delivers the leader's message-list broadcast to a follower for the same coordinate", async () => {
    const leader = new ChatTabCoordinator({ scope: SCOPE, locks, createChannel: bus.make, onRoleChange: () => {} });
    await leader.whenSettled;
    let got: { coordinate: string; messages: unknown[] } | undefined;
    const follower = new ChatTabCoordinator({
      scope: SCOPE,
      locks,
      createChannel: bus.make,
      onRoleChange: () => {},
      onLeaderState: (coordinate, messages) => (got = { coordinate, messages }),
    });
    await follower.whenSettled;

    leader.broadcastState(COORD, [msg("m1"), msg("m2")]);
    await vi.waitFor(() => expect(got?.messages).toHaveLength(2));
    expect(got!.coordinate).toBe(COORD);
    expect(follower.leaderCoordinate).toBe(COORD);
    leader.dispose();
    follower.dispose();
  });

  it("broadcasts a Svelte-$state-like Proxy message list without DataCloneError", async () => {
    // Mirrors production: session.svelte.ts hands `this.messages` (a deep $state
    // Proxy) straight to broadcastState. FakeChannel structuredClones like a real
    // BroadcastChannel, so a Proxy input used to throw.
    const leader = new ChatTabCoordinator({ scope: SCOPE, locks, createChannel: bus.make, onRoleChange: () => {} });
    await leader.whenSettled;
    let got: import("./messages.js").ChatMessage[] | undefined;
    const follower = new ChatTabCoordinator({
      scope: SCOPE,
      locks,
      createChannel: bus.make,
      onRoleChange: () => {},
      onLeaderState: (_c, messages) => (got = messages),
    });
    await follower.whenSettled;

    const plain = [msg("m1", "hello"), msg("m2", "world")];
    plain[0].tags = [["e", "abc"], ["client", "web"]];
    const proxied = new Proxy(plain, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        // Deep-proxy array elements the way Svelte $state does.
        if (typeof prop === "string" && /^\d+$/.test(prop) && value && typeof value === "object") {
          return new Proxy(value as object, {});
        }
        return value;
      },
    });

    expect(() => leader.broadcastState(COORD, proxied as typeof plain)).not.toThrow();
    await vi.waitFor(() => expect(got).toHaveLength(2));
    expect(got![0]).toEqual({
      id: "m1",
      pubkey: "c".repeat(64),
      kind: 9,
      content: "hello",
      createdAt: 1,
      tags: [
        ["e", "abc"],
        ["client", "web"],
      ],
    });
    // Delivered value must be a plain object, not a Proxy (follower UI + further
    // re-broadcasts stay structured-clone-safe).
    expect(Object.getPrototypeOf(got![0])).toBe(Object.prototype);
    leader.dispose();
    follower.dispose();
  });

  it("proxies a follower send to the leader and resolves on ack", async () => {
    const sent: string[] = [];
    const leader = new ChatTabCoordinator({
      scope: SCOPE,
      locks,
      createChannel: bus.make,
      onRoleChange: () => {},
      onSendRequest: async (text) => void sent.push(text),
    });
    await leader.whenSettled;
    const follower = new ChatTabCoordinator({ scope: SCOPE, locks, createChannel: bus.make, onRoleChange: () => {} });
    await follower.whenSettled;

    await follower.proxySend("hello from the follower tab");
    expect(sent).toEqual(["hello from the follower tab"]);
    leader.dispose();
    follower.dispose();
  });

  it("rejects a proxied send when the leader's handler throws", async () => {
    const leader = new ChatTabCoordinator({
      scope: SCOPE,
      locks,
      createChannel: bus.make,
      onRoleChange: () => {},
      onSendRequest: async () => {
        throw new Error("removed from chat");
      },
    });
    await leader.whenSettled;
    const follower = new ChatTabCoordinator({ scope: SCOPE, locks, createChannel: bus.make, onRoleChange: () => {} });
    await follower.whenSettled;

    await expect(follower.proxySend("nope")).rejects.toThrow("removed from chat");
    leader.dispose();
    follower.dispose();
  });
});

describe("ChatTabCoordinator — no Web Locks (ping fallback, read-only followers)", () => {
  let bus: FakeBus;
  beforeEach(() => {
    bus = new FakeBus();
  });

  it("a lone tab leads even without Web Locks", async () => {
    const c = new ChatTabCoordinator({
      scope: SCOPE,
      locks: null,
      createChannel: bus.make,
      onRoleChange: () => {},
      pingWindowMs: 5,
    });
    await c.whenSettled;
    expect(c.role).toBe("leader");
    expect(c.usingWebLocks).toBe(false);
    c.dispose();
  });

  it("a second tab hears the leader's ping answer and becomes a read-only follower", async () => {
    const leader = new ChatTabCoordinator({
      scope: SCOPE,
      locks: null,
      createChannel: bus.make,
      onRoleChange: () => {},
      pingWindowMs: 5,
    });
    await leader.whenSettled;
    const follower = new ChatTabCoordinator({
      scope: SCOPE,
      locks: null,
      createChannel: bus.make,
      onRoleChange: () => {},
      pingWindowMs: 50,
    });
    await follower.whenSettled;
    expect(leader.role).toBe("leader");
    expect(follower.role).toBe("follower");
    // Off the Web Locks path, the send proxy is disabled — the session shows the
    // read-only notice instead.
    await expect(follower.proxySend("x")).rejects.toThrow(/unavailable/);
    leader.dispose();
    follower.dispose();
  });
});

describe("ChatTabCoordinator — neither Web Locks nor BroadcastChannel", () => {
  it("assumes a single tab and leads", async () => {
    const c = new ChatTabCoordinator({
      scope: SCOPE,
      locks: null,
      createChannel: () => null,
      onRoleChange: () => {},
    });
    await c.whenSettled;
    expect(c.role).toBe("leader");
    c.dispose();
  });
});
