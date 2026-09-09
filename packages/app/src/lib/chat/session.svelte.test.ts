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

import {
  chatSession,
  ChatUnroutableError,
  __setChatCoordinatorFactoryForTests,
} from "./session.svelte.js";

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

/** MLS members the fake client reports, so a test can drive membership sync. */
const groupMembers = ["c".repeat(64), "d".repeat(64)];

function fakeChat() {
  return {
    identity: { pubkey: "c".repeat(64) },
    dispose: vi.fn(),
    ensurePublished: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    nostrGroupId: vi.fn().mockResolvedValue("gid"),
    send: vi.fn().mockResolvedValue(undefined),
    // Real MLS membership. The member list is derived from this now, not from the
    // roster's attested `chat_keys`, so the double has to answer it.
    groupMemberPubkeys: vi.fn().mockResolvedValue(groupMembers),
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

/**
 * Who is actually in the room.
 *
 * The member list was derived from the ECK roster's `chat_keys` — from who
 * ATTESTED — which is a different set from MLS membership in both directions: a
 * device whose Add never landed is listed and cannot read a word, and a member
 * whose leaf was removed stays listed until the coordinator's next 31604. Only the
 * leader tab holds a client and can ask the group itself; followers hold no MLS
 * state at all, so they need it broadcast or they silently fall back to the roster.
 *
 * `broadcastMembers`/`onLeaderMembers` existed on the tab coordinator with no
 * production caller on either side. This is that caller.
 */
describe("chat session — real MLS membership, and its handoff to follower tabs", () => {
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

  it("the leader reads membership from the group once its client is up", async () => {
    await chatSession.ensure("naddr1", ctx, signer, OWNER);
    await vi.waitFor(() => expect(chatSession.memberDevices).toEqual(groupMembers));
  });

  it("re-reads membership on every MLS state change — an Add or a Remove IS one", async () => {
    await chatSession.ensure("naddr1", ctx, signer, OWNER);
    await vi.waitFor(() => expect(chatSession.memberDevices).toBeDefined());

    const chat = chatSession.chat as unknown as {
      groupMemberPubkeys: ReturnType<typeof vi.fn>;
      onStateChange?: () => void;
    };
    chat.groupMemberPubkeys.mockResolvedValue(["c".repeat(64)]); // the other device left
    chat.onStateChange?.();

    await vi.waitFor(() => expect(chatSession.memberDevices).toEqual(["c".repeat(64)]));
  });

  it("a follower tab receives the leader's membership over the channel", async () => {
    // A leader tab from another "window", sharing this test's lock table + channel.
    const leaderTab = new ChatTabCoordinator({
      scope: OWNER,
      locks: locks as never,
      createChannel: (n: string) => new FakeChannel(n) as never,
      onRoleChange: () => {},
    });
    await leaderTab.whenSettled;
    expect(leaderTab.role).toBe("leader");

    await chatSession.ensure("naddr1", ctx, signer, OWNER);
    expect(chatSession.tabRole).toBe("follower");
    // A follower holds NO client, so without the broadcast it has no membership
    // at all — which is exactly the state that used to fall back to the roster.
    expect(chatSession.memberDevices).toBeUndefined();

    leaderTab.broadcastMembers(
      (ctx as unknown as { coordinate: string }).coordinate,
      ["c".repeat(64), "d".repeat(64)],
    );
    await vi.waitFor(() =>
      expect(chatSession.memberDevices).toEqual(["c".repeat(64), "d".repeat(64)]),
    );
  });

  it("ignores a membership broadcast for a DIFFERENT event", async () => {
    // Two chat-enabled events share one per-account channel; adopting the other
    // event's membership would render its people in this room.
    const leaderTab = new ChatTabCoordinator({
      scope: OWNER,
      locks: locks as never,
      createChannel: (n: string) => new FakeChannel(n) as never,
      onRoleChange: () => {},
    });
    await leaderTab.whenSettled;
    await chatSession.ensure("naddr1", ctx, signer, OWNER);

    leaderTab.broadcastMembers("31923:" + "e".repeat(64) + ":other", ["9".repeat(64)]);
    await Promise.resolve();
    expect(chatSession.memberDevices).toBeUndefined();
  });
});

/**
 * A failed send is two different problems (2026-09-09 audit, CHAT-N-4).
 *
 * Both arrived at the composer as one error, and the only remedy offered next to
 * it was Rejoin — which revokes this device, rotates its key package and
 * re-attests: an MLS epoch change and a roster republish. Right for a lost
 * membership, and quite the wrong price for a dropped socket, where the message is
 * still in the composer and pressing Send again is the whole remedy.
 */
describe("chat session — a failed send says WHICH failure it was", () => {
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

  it("a publish failure with a routable group stays the original error", async () => {
    await chatSession.ensure("naddr1", ctx, signer, OWNER);
    await vi.waitFor(() => expect(chatSession.chat).toBeDefined());
    const chat = chatSession.chat as unknown as {
      send: ReturnType<typeof vi.fn>;
      nostrGroupId: ReturnType<typeof vi.fn>;
    };
    chat.send.mockRejectedValue(new Error("publish failed on all 2 relay(s)"));

    const thrown = await chatSession.send("hi").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ChatUnroutableError);
    expect((thrown as Error).message).toMatch(/publish failed/);
    // The room is still usable — no demotion, and no Rejoin offered, for a blip.
    expect(chatSession.phase).toBe("ready");
  });

  it("a send with no routable group is a ChatUnroutableError, and demotes the room", async () => {
    await chatSession.ensure("naddr1", ctx, signer, OWNER);
    await vi.waitFor(() => expect(chatSession.chat).toBeDefined());
    const chat = chatSession.chat as unknown as {
      send: ReturnType<typeof vi.fn>;
      nostrGroupId: ReturnType<typeof vi.fn>;
    };
    chat.send.mockRejectedValue(new Error("no joined chat group yet"));
    chat.nostrGroupId.mockResolvedValue(undefined); // removed from the group

    await expect(chatSession.send("hi")).rejects.toBeInstanceOf(ChatUnroutableError);
    expect(chatSession.phase).toBe("setup");
  });
});

/**
 * A removed member's room used to look fine (2026-09-09 audit, CHAT-N-2).
 *
 * `syncPhase` asked `nostrGroupId()` — "do I hold a group for this event?" — which
 * a removed member answers yes to forever: an MLS Remove strips their leaf but
 * leaves their local group state, and its decrypted history, exactly where it was.
 * So the room rendered `ready` with its old messages on screen, nothing new ever
 * decrypted, and the only symptom was a send that failed. A reader who does not
 * send saw a quiet room and no explanation anywhere.
 */
describe("chat session — phase follows MEMBERSHIP, not leftover group state", () => {
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

  it("goes to `evicted` when our own key holds no leaf, though the group state remains", async () => {
    // `nostrGroupId()` keeps answering — that is the whole point of the finding.
    chatCreate.mockImplementation(async () => {
      const chat = fakeChat();
      chat.groupMemberPubkeys = vi.fn().mockResolvedValue(["d".repeat(64)]); // not us
      return chat;
    });
    await chatSession.ensure("naddr1", ctx, signer, OWNER);
    await vi.waitFor(() => expect(chatSession.phase).toBe("evicted"));
  });

  it("stays `ready` while we are still a member", async () => {
    await chatSession.ensure("naddr1", ctx, signer, OWNER);
    await vi.waitFor(() => expect(chatSession.phase).toBe("ready"));
  });

  it("does NOT demote on an unreadable member list — unknown is not eviction", async () => {
    chatCreate.mockImplementation(async () => {
      const chat = fakeChat();
      // `groupMemberPubkeys` returns undefined for a state it cannot walk.
      chat.groupMemberPubkeys = vi.fn().mockResolvedValue(undefined);
      return chat;
    });
    await chatSession.ensure("naddr1", ctx, signer, OWNER);
    await vi.waitFor(() => expect(chatSession.phase).toBe("ready"));
  });
});
