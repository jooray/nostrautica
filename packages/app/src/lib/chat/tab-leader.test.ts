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
  outranks,
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
    // Real Web Locks invoke the callback asynchronously — the browser grants the
    // lock on its own schedule. Modelling that matters: a synchronous fake cannot
    // express "disposed before the grant arrived", which is exactly the window in
    // which the lock used to be held for the lifetime of the tab.
    await Promise.resolve();
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
  /** While true, posts are queued instead of delivered (two tabs electing "at once"). */
  held = false;
  queue: Array<{ from: FakeChannel; deliver: () => void; data: unknown }> = [];
  /** Deliver the queued posts, in the order `sort` gives (default: as posted). */
  release(sort?: (a: { from: FakeChannel; data: unknown }, b: { from: FakeChannel; data: unknown }) => number): void {
    this.held = false;
    const q = this.queue;
    this.queue = [];
    if (sort) q.sort(sort);
    for (const item of q) item.deliver();
  }
  /** Drop the queued posts: those messages crossed and were never seen. */
  drop(): void {
    this.held = false;
    this.queue = [];
  }
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
    const deliver = () => {
      for (const ch of this.bus.channels.get(this.name) ?? []) {
        if (ch === this) continue; // BroadcastChannel never echoes to the sender
        for (const l of ch.listeners) queueMicrotask(() => l({ data }));
      }
    };
    if (this.bus.held) this.bus.queue.push({ from: this, deliver, data });
    else deliver();
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

  it("a rejected lock request asks the other tabs instead of leading blindly (SB-102)", async () => {
    const leader = new ChatTabCoordinator({ scope: SCOPE, locks, createChannel: bus.make, onRoleChange: () => {} });
    await leader.whenSettled;
    const broken: LockManagerLike = {
      request: async () => {
        throw new Error("SecurityError: lock request failed");
      },
    };
    const second = new ChatTabCoordinator({
      scope: SCOPE,
      locks: broken,
      createChannel: bus.make,
      onRoleChange: () => {},
      pingWindowMs: 50,
    });
    await second.whenSettled;
    expect(leader.role).toBe("leader");
    expect(second.role).toBe("follower"); // never two MLS writers
    expect(second.usingWebLocks).toBe(false); // read-only, like the ping path
    leader.dispose();
    second.dispose();
  });

  it("a rejected lock request with nobody else around still leads (SB-102)", async () => {
    const lone = new ChatTabCoordinator({
      scope: SCOPE,
      locks: { request: async () => Promise.reject(new Error("nope")) },
      createChannel: bus.make,
      onRoleChange: () => {},
      pingWindowMs: 5,
    });
    await lone.whenSettled;
    expect(lone.role).toBe("leader");
    lone.dispose();
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

  /**
   * Disposing before the lock callback runs used to hold the lock forever
   * (2026-09-04 audit).
   *
   * `electWithLocks` requests with `ifAvailable` and the callback fires whenever
   * the browser gets to it — by which time `dispose()` may already have run.
   * `becomeLeader()` returns early when disposed, but the hold after it did not,
   * and `dispose()` had already called and cleared `stopHolding`, so nothing was
   * left to resolve it. Every later coordinator in that tab then probed, got null,
   * became a follower, and its takeover request blocked forever: chat went
   * permanently leaderless in the whole browser profile until the tab closed.
   * Reachable from `chatSession.retry()`, which disposes and rebuilds.
   */
  it("releases the lock when disposed before its callback runs", async () => {
    const first = new ChatTabCoordinator({
      scope: SCOPE,
      locks,
      createChannel: bus.make,
      onRoleChange: () => {},
    });
    first.dispose(); // synchronously, before the lock callback is reached
    await new Promise((r) => setTimeout(r, 0));

    // The lock must be free, so a fresh coordinator in the same tab can lead.
    const second = new ChatTabCoordinator({
      scope: SCOPE,
      locks,
      createChannel: bus.make,
      onRoleChange: () => {},
    });
    await second.whenSettled;
    expect(second.role).toBe("leader");
    second.dispose();
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

  it("proxies a follower's rejoin to the leader — MLS state has a single writer", async () => {
    // The Rejoin button lives next to a failed send, and the tab the user is
    // looking at is as likely to be a follower as the leader. Only the leader owns
    // the client, so the request has to travel the same channel a send does.
    let rejoins = 0;
    const leader = new ChatTabCoordinator({
      scope: SCOPE,
      locks,
      createChannel: bus.make,
      onRoleChange: () => {},
      onRejoinRequest: async () => void rejoins++,
    });
    await leader.whenSettled;
    const follower = new ChatTabCoordinator({ scope: SCOPE, locks, createChannel: bus.make, onRoleChange: () => {} });
    await follower.whenSettled;

    await follower.proxyRejoin();
    expect(rejoins).toBe(1);

    // A failure on the leader surfaces to the follower rather than hanging.
    leader.dispose();
    follower.dispose();
  });

  it("rejects a proxied rejoin when the leader's re-enrolment throws", async () => {
    const leader = new ChatTabCoordinator({
      scope: SCOPE,
      locks,
      createChannel: bus.make,
      onRoleChange: () => {},
      onRejoinRequest: async () => {
        throw new Error("no chat session");
      },
    });
    await leader.whenSettled;
    const follower = new ChatTabCoordinator({ scope: SCOPE, locks, createChannel: bus.make, onRoleChange: () => {} });
    await follower.whenSettled;

    await expect(follower.proxyRejoin()).rejects.toThrow("no chat session");
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

  it("a second tab hears the leader's ping answer and becomes a follower that proxies to it", async () => {
    const sent: string[] = [];
    const leader = new ChatTabCoordinator({
      scope: SCOPE,
      locks: null,
      createChannel: bus.make,
      onRoleChange: () => {},
      onSendRequest: async (text) => void sent.push(text),
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
    // The leader named itself in its answer (W-7), so the follower can address it.
    expect(follower.canProxy).toBe(true);
    await follower.proxySend("x");
    expect(sent).toEqual(["x"]);
    leader.dispose();
    follower.dispose();
  });

  it("a follower of a leader that announces no id (a build before W-7) stays read-only", async () => {
    // A hand-driven leader on the previous build: a bare leader-hello.
    const oldLeader = bus.make(`nostrautica-chat:${SCOPE}`);
    oldLeader.addEventListener("message", ({ data }) => {
      if ((data as { t?: string }).t === "who-leads") oldLeader.postMessage({ t: "leader-hello", scope: SCOPE });
    });
    const follower = new ChatTabCoordinator({
      scope: SCOPE,
      locks: null,
      createChannel: bus.make,
      onRoleChange: () => {},
      pingWindowMs: 50,
    });
    await follower.whenSettled;
    expect(follower.role).toBe("follower");
    // Nobody to address, and an unaddressed request could run on two leaders.
    expect(follower.canProxy).toBe(false);
    await expect(follower.proxySend("x")).rejects.toThrow(/unavailable/);
    follower.dispose();
  });
});

// Audit KIMIK31 W-7: two tabs electing at the same moment without Web Locks can
// both settle as leader. A late leader-hello used to be ignored once settled, so
// both kept a live MarmotClient on the one shared IndexedDB MLS store.
describe("ChatTabCoordinator — two ping-path leaders resolve to one (audit W-7)", () => {
  type Seen = { roles: TabRole[]; sent: string[] };
  function tab(bus: FakeBus, id: string, startedAt: number, seen: Seen, extra: object = {}) {
    return new ChatTabCoordinator({
      scope: SCOPE,
      locks: null,
      createChannel: bus.make,
      onRoleChange: (r) => seen.roles.push(r),
      onSendRequest: async (text) => void seen.sent.push(`${id}:${text}`),
      pingWindowMs: 5,
      heartbeatMs: 40,
      tabId: id,
      startedAt,
      ...extra,
    });
  }
  const fresh = (): Seen => ({ roles: [], sent: [] });
  const isHello = (d: unknown) => (d as { t?: string }).t === "leader-hello";

  /** Both tabs elect with the bus held, so neither hears the other: both lead. */
  async function twoLeaders(bus: FakeBus) {
    const sa = fresh();
    const sb = fresh();
    bus.held = true;
    const a = tab(bus, "tab-a", 1000, sa);
    const b = tab(bus, "tab-b", 2000, sb);
    await Promise.all([a.whenSettled, b.whenSettled]);
    expect([a.role, b.role]).toEqual(["leader", "leader"]);
    return { a, b, sa, sb };
  }

  it("outranks: a lock holder beats anyone, then the earlier start, then the smaller id", () => {
    expect(outranks({ id: "z", since: 9, locked: true }, { id: "a", since: 1, locked: false })).toBe(true);
    expect(outranks({ id: "z", since: 1, locked: false }, { id: "a", since: 2, locked: false })).toBe(true);
    expect(outranks({ id: "a", since: 1, locked: false }, { id: "b", since: 1, locked: false })).toBe(true);
    expect(outranks({ id: "b", since: 1, locked: false }, { id: "a", since: 1, locked: false })).toBe(false);
  });

  for (const order of ["a's hello first", "b's hello first"] as const) {
    it(`the later tab demotes when the election hellos arrive late (${order})`, async () => {
      const bus = new FakeBus();
      const { a, b, sa, sb } = await twoLeaders(bus);
      // Deliver what crossed during the election, in the chosen order.
      const first = order === "a's hello first" ? "tab-a" : "tab-b";
      bus.release((x, y) => {
        const rank = (m: { data: unknown }) => ((m.data as { id?: string }).id === first ? 0 : 1);
        return rank(x) - rank(y);
      });
      await vi.waitFor(() => expect(b.role).toBe("follower"));
      expect(a.role).toBe("leader");
      expect(sa.roles).toEqual(["leader"]);
      expect(sb.roles).toEqual(["leader", "follower"]);
      a.dispose();
      b.dispose();
    });
  }

  it("the heartbeat resolves it when the election hellos were lost entirely", async () => {
    const bus = new FakeBus();
    const { a, b, sb } = await twoLeaders(bus);
    bus.drop();
    // Within one heartbeat (40 ms): whichever leader beats first, the other learns.
    await new Promise((r) => setTimeout(r, 60));
    expect(a.role).toBe("leader");
    expect(b.role).toBe("follower");
    expect(sb.roles).toEqual(["leader", "follower"]);
    a.dispose();
    b.dispose();
  });

  it("a demoted tab proxies to the winner, and a request reaches only its addressee", async () => {
    const bus = new FakeBus();
    const { a, b, sa, sb } = await twoLeaders(bus);
    bus.release();
    await vi.waitFor(() => expect(b.role).toBe("follower"));
    expect(b.canProxy).toBe(true);
    await b.proxySend("hi");
    expect(sa.sent).toEqual(["tab-a:hi"]);
    expect(sb.sent).toEqual([]);
    a.dispose();
    b.dispose();
  });

  it("a leader ignores a request addressed to another leader (no double run mid-conflict)", async () => {
    const bus = new FakeBus();
    const { a, b, sa, sb } = await twoLeaders(bus);
    bus.drop();
    // Still in the conflict window: both lead. A request for tab-a only.
    const probe = bus.make(`nostrautica-chat:${SCOPE}`);
    probe.postMessage({ t: "send", scope: SCOPE, reqId: "r1", text: "once", to: "tab-a" });
    await new Promise((r) => setTimeout(r, 5));
    expect(sa.sent).toEqual(["tab-a:once"]);
    expect(sb.sent).toEqual([]);
    a.dispose();
    b.dispose();
  });

  it("only leaders heartbeat, and only hellos: a follower stays silent", async () => {
    const bus = new FakeBus();
    const sa = fresh();
    const a = tab(bus, "tab-a", 1000, sa);
    await a.whenSettled;
    const b = tab(bus, "tab-b", 2000, fresh());
    await b.whenSettled;
    expect(b.role).toBe("follower");
    const posted: unknown[] = [];
    const listener = bus.make(`nostrautica-chat:${SCOPE}`);
    listener.addEventListener("message", ({ data }) => posted.push(data));
    await new Promise((r) => setTimeout(r, 130));
    expect(posted.length).toBeGreaterThanOrEqual(2);
    expect(posted.every((d) => isHello(d) && (d as { id: string }).id === "tab-a")).toBe(true);
    a.dispose();
    b.dispose();
  });
});

describe("ChatTabCoordinator — Web Locks leadership is unchanged by W-7", () => {
  it("a lock holder never demotes, even for a peer that would outrank it on the ping path", async () => {
    const bus = new FakeBus();
    const locks = new FakeLockManager();
    const roles: TabRole[] = [];
    const leader = new ChatTabCoordinator({
      scope: SCOPE,
      locks,
      createChannel: bus.make,
      onRoleChange: (r) => roles.push(r),
      heartbeatMs: 20,
      tabId: "zzz",
      startedAt: 9_999,
    });
    await leader.whenSettled;
    const rogue = bus.make(`nostrautica-chat:${SCOPE}`);
    rogue.postMessage({ t: "leader-hello", scope: SCOPE, id: "aaa", since: 1, locked: false });
    rogue.postMessage({ t: "leader-hello", scope: SCOPE, id: "bbb", since: 1, locked: true });
    await new Promise((r) => setTimeout(r, 60));
    expect(leader.role).toBe("leader");
    expect(roles).toEqual(["leader"]);
    leader.dispose();
  });

  it("a ping-path leader yields to a lock holder", async () => {
    const bus = new FakeBus();
    const locks = new FakeLockManager();
    bus.held = true;
    const pinger = new ChatTabCoordinator({
      scope: SCOPE,
      locks: null,
      createChannel: bus.make,
      onRoleChange: () => {},
      pingWindowMs: 5,
      heartbeatMs: 20,
      tabId: "aaa",
      startedAt: 1,
    });
    const holder = new ChatTabCoordinator({
      scope: SCOPE,
      locks,
      createChannel: bus.make,
      onRoleChange: () => {},
      heartbeatMs: 20,
      tabId: "zzz",
      startedAt: 9_999,
    });
    await Promise.all([pinger.whenSettled, holder.whenSettled]);
    expect([pinger.role, holder.role]).toEqual(["leader", "leader"]);
    bus.drop();
    await vi.waitFor(() => expect(pinger.role).toBe("follower"));
    expect(holder.role).toBe("leader");
    pinger.dispose();
    holder.dispose();
  });

  it("a Web Locks follower's proxied request is unaddressed, as before", async () => {
    const bus = new FakeBus();
    const locks = new FakeLockManager();
    const leader = new ChatTabCoordinator({ scope: SCOPE, locks, createChannel: bus.make, onRoleChange: () => {} });
    await leader.whenSettled;
    const follower = new ChatTabCoordinator({ scope: SCOPE, locks, createChannel: bus.make, onRoleChange: () => {} });
    await follower.whenSettled;
    const posted: Array<{ t: string; to?: string }> = [];
    const listener = bus.make(`nostrautica-chat:${SCOPE}`);
    listener.addEventListener("message", ({ data }) => posted.push(data as { t: string; to?: string }));
    void follower.proxySend("x").catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    const send = posted.find((m) => m.t === "send");
    expect(send).toBeDefined();
    expect(send!.to).toBeUndefined();
    leader.dispose();
    follower.dispose();
  });
});

// Audit R-10: one 300 ms window meant a leader busy for 300 ms (a history replay,
// an MLS commit) lost a newcomer to a second leader — two MarmotClients on one
// shared IndexedDB MLS store.
describe("ChatTabCoordinator — ping fallback tolerates a busy leader (audit R-10)", () => {
  it("a leader that misses the first ping but answers the second keeps its follower", async () => {
    const bus = new FakeBus();
    // A hand-driven 'leader' tab: deaf to the first who-leads, answers the next.
    const busyLeader = bus.make(`nostrautica-chat:${SCOPE}`);
    let pings = 0;
    busyLeader.addEventListener("message", ({ data }) => {
      if ((data as { t?: string }).t !== "who-leads") return;
      pings++;
      if (pings >= 2) busyLeader.postMessage({ t: "leader-hello", scope: SCOPE });
    });
    const newcomer = new ChatTabCoordinator({
      scope: SCOPE,
      locks: null,
      createChannel: bus.make,
      onRoleChange: () => {},
      pingWindowMs: 10,
    });
    await newcomer.whenSettled;
    expect(pings).toBe(2);
    expect(newcomer.role).toBe("follower");
    newcomer.dispose();
  });

  it("leads only after two silent windows", async () => {
    const bus = new FakeBus();
    const listener = bus.make(`nostrautica-chat:${SCOPE}`);
    let pings = 0;
    listener.addEventListener("message", ({ data }) => {
      if ((data as { t?: string }).t === "who-leads") pings++;
    });
    const lone = new ChatTabCoordinator({
      scope: SCOPE,
      locks: null,
      createChannel: bus.make,
      onRoleChange: () => {},
      pingWindowMs: 10,
    });
    await lone.whenSettled;
    expect(pings).toBe(2);
    expect(lone.role).toBe("leader");
    lone.dispose();
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

// W-7 follow-up: off Web Locks nothing replaced a leader whose tab closed or
// crashed, so every other tab stayed a follower of nobody until a reload.
describe("ChatTabCoordinator — ping-path takeover from a silent leader", () => {
  const BEAT = 20;
  function ping(bus: FakeBus, id: string, startedAt: number, roles: TabRole[] = []) {
    return new ChatTabCoordinator({
      scope: SCOPE,
      locks: null,
      createChannel: bus.make,
      onRoleChange: (r) => roles.push(r),
      pingWindowMs: 5,
      heartbeatMs: BEAT,
      tabId: id,
      startedAt,
    });
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("a follower takes over within the window once the leader stops heartbeating", async () => {
    const bus = new FakeBus();
    const leader = ping(bus, "tab-a", 1);
    await leader.whenSettled;
    const roles: TabRole[] = [];
    const follower = ping(bus, "tab-b", 2, roles);
    await follower.whenSettled;
    expect(follower.role).toBe("follower");
    // The leader tab dies: it sends nothing more, and tells nobody.
    leader.dispose();
    // 3 missed beats + one watchdog tick + two ping windows, with slack.
    await vi.waitFor(() => expect(follower.role).toBe("leader"), { timeout: BEAT * 8 });
    expect(roles).toEqual(["follower", "leader"]);
    follower.dispose();
  });

  it("two followers racing to take over end with exactly one leader", async () => {
    const bus = new FakeBus();
    const leader = ping(bus, "tab-a", 1);
    await leader.whenSettled;
    const b = ping(bus, "tab-b", 2);
    const c = ping(bus, "tab-c", 3);
    await Promise.all([b.whenSettled, c.whenSettled]);
    leader.dispose();
    await vi.waitFor(() => expect([b.role, c.role]).toContain("leader"), { timeout: BEAT * 8 });
    // Let any simultaneous takeover meet the conflict rule, then check it held.
    await sleep(BEAT * 3);
    expect([b.role, c.role].filter((r) => r === "leader")).toHaveLength(1);
    // The earlier-started follower is the one that keeps it.
    expect(b.role).toBe("leader");
    await sleep(BEAT * 5);
    expect([b.role, c.role]).toEqual(["leader", "follower"]);
    b.dispose();
    c.dispose();
  });

  it("two followers that both take over in the same instant still resolve to one", async () => {
    const bus = new FakeBus();
    const leader = ping(bus, "tab-a", 1);
    await leader.whenSettled;
    const b = ping(bus, "tab-b", 2);
    const c = ping(bus, "tab-c", 3);
    await Promise.all([b.whenSettled, c.whenSettled]);
    // Neither hears the other's who-leads or hello while taking over.
    bus.held = true;
    leader.dispose();
    await vi.waitFor(() => expect([b.role, c.role]).toEqual(["leader", "leader"]), { timeout: BEAT * 8 });
    bus.drop();
    await vi.waitFor(() => expect(c.role).toBe("follower"), { timeout: BEAT * 4 });
    expect(b.role).toBe("leader");
    b.dispose();
    c.dispose();
  });

  it("a leader that is merely slow (one missed beat) is not usurped", async () => {
    const bus = new FakeBus();
    // A hand-driven leader that skips every other beat (gaps of 2 × BEAT) and is
    // too busy to answer a takeover's who-leads: only the threshold protects it.
    const slow = bus.make(`nostrautica-chat:${SCOPE}`);
    const hello = () => slow.postMessage({ t: "leader-hello", scope: SCOPE, id: "tab-a", since: 1, locked: false });
    let answered = false;
    slow.addEventListener("message", ({ data }) => {
      if ((data as { t?: string }).t !== "who-leads" || answered) return;
      answered = true; // the newcomer's election only
      hello();
    });
    const roles: TabRole[] = [];
    const follower = ping(bus, "tab-b", 2, roles);
    await follower.whenSettled;
    const beat = setInterval(hello, BEAT * 2);
    await sleep(BEAT * 15);
    clearInterval(beat);
    expect(follower.role).toBe("follower");
    expect(roles).toEqual(["follower"]);
    follower.dispose();
  });

  it("a silent leader on a build before W-7 (no id, no heartbeat) is never usurped", async () => {
    const bus = new FakeBus();
    const old = bus.make(`nostrautica-chat:${SCOPE}`);
    old.addEventListener("message", ({ data }) => {
      if ((data as { t?: string }).t === "who-leads") old.postMessage({ t: "leader-hello", scope: SCOPE });
    });
    const follower = ping(bus, "tab-b", 2);
    await follower.whenSettled;
    await sleep(BEAT * 8);
    expect(follower.role).toBe("follower");
    follower.dispose();
  });

  it("a Web Locks follower never takes over on silence: only the lock hands over", async () => {
    const bus = new FakeBus();
    const locks = new FakeLockManager();
    // A lock holder that never heartbeats within the test.
    const leader = new ChatTabCoordinator({
      scope: SCOPE,
      locks,
      createChannel: bus.make,
      onRoleChange: () => {},
      heartbeatMs: 1_000_000,
    });
    await leader.whenSettled;
    const follower = new ChatTabCoordinator({
      scope: SCOPE,
      locks,
      createChannel: bus.make,
      onRoleChange: () => {},
      heartbeatMs: BEAT,
      pingWindowMs: 5,
    });
    await follower.whenSettled;
    await sleep(BEAT * 8);
    expect(follower.role).toBe("follower");
    expect(leader.role).toBe("leader");
    leader.dispose();
    follower.dispose();
  });
});
