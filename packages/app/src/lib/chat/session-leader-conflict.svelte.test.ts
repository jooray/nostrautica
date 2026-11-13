/**
 * Two chat sessions that both settled as leader without Web Locks (audit KIMIK31
 * W-7).
 *
 * The ping election (the fallback when `navigator.locks` is missing or its request
 * rejects) asks "who leads?" and leads after two silent windows. Two tabs that ask
 * at the same moment hear nothing from each other and both lead, and each builds a
 * live MarmotClient over the one IndexedDB MLS store of the account: concurrent
 * MLS mutation, the corruption leader election exists to prevent. A late
 * leader-hello was ignored once settled, and the session had no way back from
 * leader anyway.
 *
 * Each `ChatSessionStore` here stands for one tab; they share a channel bus that
 * can be held (both elect without hearing each other) and then released or
 * dropped (the election hellos crossed and were lost).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChatTabCoordinator, type TabCoordinatorOptions } from "./tab-leader.js";

const chatCreate = vi.hoisted(() => vi.fn());
const resolveChatIdentity = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({ MarmotChat: { create: chatCreate } }));
vi.mock("./identity.js", () => ({ resolveChatIdentity }));
vi.mock("./legacy-cleanup.js", () => ({ deleteLegacyChatDeviceKeyBackup: vi.fn() }));

import { __createChatSessionForTests, __setChatCoordinatorFactoryForTests } from "./session.svelte.js";

type Session = ReturnType<typeof __createChatSessionForTests>;

class Bus {
  channels = new Set<Chan>();
  held = false;
  queue: Array<{ id?: string; deliver: () => void }> = [];
  release(firstId?: string): void {
    this.held = false;
    const q = this.queue;
    this.queue = [];
    if (firstId) q.sort((x, y) => (x.id === firstId ? 0 : 1) - (y.id === firstId ? 0 : 1));
    for (const item of q) item.deliver();
  }
  drop(): void {
    this.held = false;
    this.queue = [];
  }
}
class Chan {
  private listeners = new Set<(ev: { data: unknown }) => void>();
  constructor(private bus: Bus) {
    bus.channels.add(this);
  }
  postMessage(msg: unknown): void {
    const data = structuredClone(msg);
    const deliver = () => {
      for (const ch of this.bus.channels) {
        if (ch === this) continue;
        for (const l of ch.listeners) queueMicrotask(() => l({ data }));
      }
    };
    if (this.bus.held) this.bus.queue.push({ id: (data as { id?: string }).id, deliver });
    else deliver();
  }
  addEventListener(_t: "message", l: (ev: { data: unknown }) => void) {
    this.listeners.add(l);
  }
  removeEventListener(_t: "message", l: (ev: { data: unknown }) => void) {
    this.listeners.delete(l);
  }
  close(): void {
    this.bus.channels.delete(this);
  }
}

class Locks {
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
        (this.waiters.get(name) ?? this.waiters.set(name, []).get(name)!).push(() => resume());
        options.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
      });
    }
    return this.hold(name, callback);
  }
  private async hold(name: string, callback: (lock: unknown | null) => Promise<unknown>) {
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

const OWNER = "a".repeat(64);
const ctx = { coordinate: "31923:" + "f".repeat(64) + ":ev", config: { relays: ["wss://r"] } } as never;
const signer = { getPublicKey: async () => OWNER } as never;
const HEARTBEAT_MS = 40;

function fakeChat() {
  return {
    identity: { pubkey: "c".repeat(64) },
    dispose: vi.fn(),
    ensurePublished: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    nostrGroupId: vi.fn().mockResolvedValue("gid"),
    send: vi.fn().mockResolvedValue(undefined),
    groupMemberPubkeys: vi.fn().mockResolvedValue(["c".repeat(64)]),
    membershipVerdict: vi.fn().mockResolvedValue({ kind: "member" }),
    lastVerdict: undefined as unknown,
    damagedGroupIds: vi.fn(() => [] as string[]),
    recheckDamaged: vi.fn().mockResolvedValue([]),
    syncIssueCount: vi.fn(() => 0),
    rejoin: vi.fn().mockResolvedValue("requested"),
    onMessage: undefined,
    onStateChange: undefined,
  };
}
type FakeChat = ReturnType<typeof fakeChat>;

describe("chat session — two leaders without Web Locks resolve to one (audit W-7)", () => {
  let bus: Bus;
  let locks: Locks | null;
  /** Tab identities handed out in factory-call order: the first tab started first. */
  let identities: Array<{ tabId: string; startedAt: number }>;
  const sessions: Session[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    bus = new Bus();
    locks = null;
    identities = [
      { tabId: "tab-a", startedAt: 1000 },
      { tabId: "tab-b", startedAt: 2000 },
    ];
    resolveChatIdentity.mockResolvedValue({ pubkey: "c".repeat(64) });
    chatCreate.mockImplementation(async () => fakeChat());
    __setChatCoordinatorFactoryForTests(
      (opts: TabCoordinatorOptions) =>
        new ChatTabCoordinator({
          ...opts,
          locks: locks as never,
          createChannel: () => new Chan(bus) as never,
          pingWindowMs: 5,
          heartbeatMs: HEARTBEAT_MS,
          ...identities.shift()!,
        }),
    );
  });

  afterEach(() => {
    for (const s of sessions.splice(0)) s.dispose();
    __setChatCoordinatorFactoryForTests(null);
  });

  function newTab(): Session {
    const s = __createChatSessionForTests();
    sessions.push(s);
    return s;
  }

  /** Two tabs elect with the bus held: neither hears the other, both lead and build a client. */
  async function twoLeaders(): Promise<{ a: Session; b: Session; chatA: FakeChat; chatB: FakeChat }> {
    bus.held = true;
    const a = newTab();
    const b = newTab();
    // a takes the first identity (the earlier start), so it is the expected winner.
    const pa = a.ensure("naddr1", ctx, signer, OWNER);
    await vi.waitFor(() => expect(a.__coordinatorForTests).toBeDefined());
    await Promise.all([pa, b.ensure("naddr1", ctx, signer, OWNER)]);
    expect(a.tabRole).toBe("leader");
    expect(b.tabRole).toBe("leader");
    expect(a.chat).toBeDefined();
    expect(b.chat).toBeDefined();
    return { a, b, chatA: a.chat as unknown as FakeChat, chatB: b.chat as unknown as FakeChat };
  }

  it("within one heartbeat exactly one stays leader, and the other's client is disposed", async () => {
    const { a, b, chatA, chatB } = await twoLeaders();
    // The election hellos crossed and were lost: only the heartbeat can tell them.
    bus.drop();
    await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 1.5));
    expect(a.tabRole).toBe("leader");
    expect(b.tabRole).toBe("follower");
    expect(a.chat).toBe(chatA);
    expect(b.chat).toBeUndefined();
    expect(chatB.dispose).toHaveBeenCalledTimes(1);
    expect(chatA.dispose).not.toHaveBeenCalled();
  });

  for (const first of ["tab-a", "tab-b"]) {
    it(`the same tab wins whichever late hello is delivered first (${first} first)`, async () => {
      const { a, b, chatA, chatB } = await twoLeaders();
      bus.release(first);
      await vi.waitFor(() => expect(b.tabRole).toBe("follower"));
      expect(a.tabRole).toBe("leader");
      expect(b.chat).toBeUndefined();
      expect(chatB.dispose).toHaveBeenCalledTimes(1);
      expect(chatA.dispose).not.toHaveBeenCalled();
    });
  }

  it("the demoted tab sends through the winner's client", async () => {
    const { a, b, chatA, chatB } = await twoLeaders();
    bus.release();
    // Interactive once the winner's snapshot (asked for on demotion) names the event.
    await vi.waitFor(() => {
      expect(b.tabRole).toBe("follower");
      expect(b.readOnly).toBe(false);
    });
    await b.send("hello from the demoted tab");
    expect(chatA.send).toHaveBeenCalledWith("hello from the demoted tab");
    expect(chatB.send).not.toHaveBeenCalled();
    expect(a.tabRole).toBe("leader");
  });

  it("a send in flight on the demoted tab finishes with its real outcome, not silently dropped", async () => {
    const { b, chatB } = await twoLeaders();
    let finish!: () => void;
    chatB.send.mockImplementationOnce(() => new Promise<void>((res) => (finish = res)));
    const sending = b.send("typed before the demotion");
    let settled = false;
    void sending.then(() => (settled = true));
    bus.release();
    await vi.waitFor(() => expect(b.tabRole).toBe("follower"));
    // Subscriptions are down (no more ingest), but the send still runs to its end.
    expect(chatB.dispose).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    finish();
    await expect(sending).resolves.toBeUndefined();
    expect(chatB.send).toHaveBeenCalledWith("typed before the demotion");
  });

  it("a tab demoted while its client is still being built never puts it live", async () => {
    let releaseCreate!: () => void;
    const late = fakeChat();
    chatCreate.mockImplementationOnce(async () => fakeChat());
    chatCreate.mockImplementationOnce(
      () => new Promise((res) => (releaseCreate = () => res(late))),
    );
    bus.held = true;
    const a = newTab();
    const b = newTab();
    const pa = a.ensure("naddr1", ctx, signer, OWNER);
    await vi.waitFor(() => expect(a.__coordinatorForTests).toBeDefined());
    const pb = b.ensure("naddr1", ctx, signer, OWNER);
    await pa;
    await vi.waitFor(() => expect(b.tabRole).toBe("leader"));
    bus.release();
    await vi.waitFor(() => expect(b.tabRole).toBe("follower"));
    releaseCreate();
    await pb;
    expect(b.chat).toBeUndefined();
    expect(late.dispose).toHaveBeenCalled();
    expect(late.start).not.toHaveBeenCalled();
    expect(b.phase).not.toBe("error");
  });

  it("with Web Locks, heartbeats change nothing: one leader, one follower, no client disposed", async () => {
    locks = new Locks();
    const a = newTab();
    await a.ensure("naddr1", ctx, signer, OWNER);
    const b = newTab();
    await b.ensure("naddr1", ctx, signer, OWNER);
    expect(a.tabRole).toBe("leader");
    expect(b.tabRole).toBe("follower");
    const chatA = a.chat as unknown as FakeChat;
    await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 3));
    expect(a.tabRole).toBe("leader");
    expect(b.tabRole).toBe("follower");
    expect(b.chat).toBeUndefined();
    expect(chatA.dispose).not.toHaveBeenCalled();
    expect(chatCreate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(b.readOnly).toBe(false));
    await b.send("via the lock holder");
    expect(chatA.send).toHaveBeenCalledWith("via the lock holder");
  });
});

// W-7 follow-up: a follower whose ping-path leader goes silent takes over, through
// the same tracked promotion as a Web Locks takeover (W-6).
describe("chat session — taking over from a silent ping-path leader", () => {
  let bus: Bus;
  let identities: Array<{ tabId: string; startedAt: number }>;
  const sessions: Session[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    bus = new Bus();
    identities = [
      { tabId: "tab-a", startedAt: 1000 },
      { tabId: "tab-b", startedAt: 2000 },
    ];
    resolveChatIdentity.mockResolvedValue({ pubkey: "c".repeat(64) });
    chatCreate.mockImplementation(async () => fakeChat());
    __setChatCoordinatorFactoryForTests(
      (opts: TabCoordinatorOptions) =>
        new ChatTabCoordinator({
          ...opts,
          locks: null,
          createChannel: () => new Chan(bus) as never,
          pingWindowMs: 5,
          heartbeatMs: HEARTBEAT_MS,
          ...identities.shift()!,
        }),
    );
  });

  afterEach(() => {
    for (const s of sessions.splice(0)) s.dispose();
    __setChatCoordinatorFactoryForTests(null);
  });

  async function leaderAndFollower(): Promise<{ a: Session; b: Session }> {
    const a = __createChatSessionForTests();
    const b = __createChatSessionForTests();
    sessions.push(a, b);
    await a.ensure("naddr1", ctx, signer, OWNER);
    await b.ensure("naddr1", ctx, signer, OWNER);
    expect(a.tabRole).toBe("leader");
    expect(b.tabRole).toBe("follower");
    expect(b.chat).toBeUndefined();
    return { a, b };
  }

  it("the follower builds a live client once the leader tab dies", async () => {
    const { a, b } = await leaderAndFollower();
    const coordinatorBefore = b.__coordinatorForTests;
    a.dispose(); // the tab closes: it sends nothing more
    await vi.waitFor(() => expect(b.chat).toBeDefined(), { timeout: HEARTBEAT_MS * 8 });
    expect(b.tabRole).toBe("leader");
    expect(b.phase).toBe("ready");
    // In place, on the coordinator it already held (the W-6 promotion path).
    expect(b.__coordinatorForTests).toBe(coordinatorBefore);
    expect(chatCreate).toHaveBeenCalledTimes(2);
  });

  it("a failed takeover shows the retryable state, never a false ready", async () => {
    const { a, b } = await leaderAndFollower();
    expect(b.phase).toBe("ready");
    chatCreate.mockRejectedValueOnce(new Error("identity locked"));
    a.dispose();
    await vi.waitFor(() => expect(b.tabRole).toBe("leader"), { timeout: HEARTBEAT_MS * 8 });
    await vi.waitFor(() => expect(b.phase).toBe("unreachable"));
    expect(b.chat).toBeUndefined();
    expect((b.error as Error).message).toBe("identity locked");
  });
});
