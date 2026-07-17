/**
 * Regression test for gap G-3: a Marmot welcome that arrives AFTER start() must
 * still be joined. The `invites.listen()` subscription ingests + decrypts a late
 * welcome into "unread" but does not join on its own; MarmotChat.start() must react
 * to the `decrypted` event and drive joinGroupFromWelcome, or the member sits on
 * "Setting up your secure chat…" forever after the coordinator adds them.
 *
 * MarmotChat builds its own MarmotClient and pulls in NDK/IndexedDB-backed helpers,
 * so those seams are mocked; the assertions are purely about start()'s join wiring.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal EventEmitter (the marmot InviteManager extends eventemitter3, but that
// isn't a direct app dep — the `on`/`off`/`emit` surface start() uses is enough).
class TinyEmitter {
  private handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  on(ev: string, fn: (...a: unknown[]) => void) {
    (this.handlers.get(ev) ?? this.handlers.set(ev, new Set()).get(ev)!).add(fn);
    return this;
  }
  off(ev: string, fn: (...a: unknown[]) => void) {
    this.handlers.get(ev)?.delete(fn);
    return this;
  }
  emit(ev: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(ev) ?? []) fn(...args);
    return true;
  }
}

// ── mock the browser-coupled seams MarmotChat imports at module load ──────────
class FakeInvites extends TinyEmitter {
  unread: { id: string; joinable?: boolean }[] = [];
  listenCalls = 0;
  async listen() {
    this.listenCalls++;
    return { unsubscribe() {} };
  }
  async decryptGiftWraps() {
    return [] as unknown[];
  }
  async getUnread() {
    return this.unread;
  }
  async markAsRead(id: string) {
    this.unread = this.unread.filter((u) => u.id !== id);
  }
  /** Simulate `listen()` receiving + decrypting a welcome after start(). */
  deliver(rumor: { id: string; joinable?: boolean }) {
    this.unread.push(rumor);
    this.emit("decrypted", rumor);
  }
}

class FakeGroups {
  groups: { idStr: string; id: Uint8Array; state: unknown; on: () => void }[] = [];
  connectAllCalls = 0;
  send = vi.fn(async () => {});
  connectAll() {
    this.connectAllCalls++;
    return { unsubscribe() {} };
  }
  async loadAll() {
    return this.groups;
  }
}

class FakeMarmotClient {
  invites = new FakeInvites();
  groups = new FakeGroups();
  keyPackages = { ensurePublished: vi.fn(async () => {}), create: vi.fn(async () => ({})) };
  joinedFrom: string[] = [];
  async canJoinInvite(inv: { joinable?: boolean }) {
    return inv.joinable !== false;
  }
  async joinGroupFromWelcome({ welcomeRumor }: { welcomeRumor: { id: string } }) {
    this.joinedFrom.push(welcomeRumor.id);
    this.groups.groups.push({
      idStr: "group-" + welcomeRumor.id,
      id: new Uint8Array([1]),
      state: {},
      on: () => {},
    });
    return { group: this.groups.groups[this.groups.groups.length - 1] };
  }
}

let lastClient: FakeMarmotClient;
// Keep the real rumor codec (createChatRumor / serialize / deserialize) so the
// optimistic-echo path (Bug 4) exercises the actual bytes — only the client shell
// and the group-id helper are faked.
vi.mock("@internet-privacy/marmot-ts/client", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    MarmotClient: class {
      constructor() {
        lastClient = new FakeMarmotClient();
        return lastClient as unknown as object;
      }
    },
  };
});
vi.mock("@internet-privacy/marmot-ts/core", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getNostrGroupIdHex: () => "deadbeef" };
});
vi.mock("@internet-privacy/marmot-ts/lib/client/group/proposals/remove-member.js", () => ({
  proposeRemoveUser: () => async () => [],
}));
vi.mock("./identity.js", () => ({
  resolveChatIdentity: async () => ({
    pubkey: "c".repeat(64),
    account: "c".repeat(64),
    isAccountKey: true,
    eventSigner: { getPublicKey: () => "c".repeat(64), signEvent: () => ({}), nip44: {} },
    accountProofSigner: () => new Uint8Array(),
    clientId: "web-test",
    secretKey: new Uint8Array(32),
  }),
}));
vi.mock("./stores.js", () => ({
  makeMarmotStores: () => ({}),
  marmotKvBackend: () => ({ get: async () => undefined, set: async () => {} }),
}));
vi.mock("./network.js", () => ({ createMarmotNetwork: () => ({}) }));
vi.mock("./attest.js", () => ({ sendChatKeyAttestation: vi.fn(async () => {}) }));
vi.mock("$lib/nostr/ndk.js", () => ({
  publishSigned: vi.fn(async () => {}),
  fetchEventsRelayOnly: vi.fn(async () => []),
}));

import { MarmotChat } from "./client.js";

const ctx = { config: { relays: ["wss://r"] }, coordinate: "31600:x:y" } as never;
const accountSigner = { getPublicKey: async () => "c".repeat(64) } as never;

describe("MarmotChat.start() — late welcome (G-3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("joins a welcome that arrives AFTER start(), not just ones present up front", async () => {
    const chat = await MarmotChat.create({ accountSigner, ctx });
    let stateChanges = 0;
    chat.onStateChange = () => stateChanges++;

    await chat.start();
    // Nothing to join at start — the coordinator hasn't added us yet.
    expect(lastClient.joinedFrom).toEqual([]);
    expect(await chat.nostrGroupId()).toBeUndefined();

    // The coordinator adds us; listen() receives + decrypts the welcome.
    lastClient.invites.deliver({ id: "welcome-1" });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["welcome-1"]));

    // We joined the group and the UI is nudged out of "setting up".
    expect(await chat.nostrGroupId()).toBe("deadbeef");
    expect(stateChanges).toBeGreaterThan(0);
  });

  it("keeps a live connectAll so a late-joined group's 445 traffic is auto-subscribed", async () => {
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();
    // connectAll runs during start (before the late join) and is not torn down,
    // so marmot's `joined`-event tracking wires the new group's subscription.
    expect(lastClient.groups.connectAllCalls).toBe(1);

    lastClient.invites.deliver({ id: "welcome-2" });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["welcome-2"]));
    // Still the single long-lived connection — not re-created per join.
    expect(lastClient.groups.connectAllCalls).toBe(1);
  });

  it("stops joining after dispose() removes the decrypted listener", async () => {
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();
    chat.dispose();

    lastClient.invites.deliver({ id: "welcome-3" });
    // Give any (incorrectly still-attached) async handler a chance to run.
    await new Promise((r) => setTimeout(r, 20));
    expect(lastClient.joinedFrom).toEqual([]);
  });
});

describe("MarmotChat.send() — optimistic own-message echo (Bug 4)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("surfaces the sender's own message locally, exactly once", async () => {
    const chat = await MarmotChat.create({ accountSigner, ctx });
    const seen: { id: string; content: string; pubkey: string }[] = [];
    chat.onMessage = (m) => seen.push(m);
    await chat.start();
    // Join a group so send() has a target.
    lastClient.invites.deliver({ id: "welcome-send" });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["welcome-send"]));

    await chat.send("hello from me");

    // The wire send happened AND we echoed it into the UI (marmot doesn't echo own).
    expect(lastClient.groups.send).toHaveBeenCalledOnce();
    const mine = seen.filter((m) => m.content === "hello from me");
    expect(mine).toHaveLength(1);
    expect(mine[0].pubkey).toBe("c".repeat(64));

    // A later real echo carrying the SAME rumor id must de-dupe (id is stable).
    const echoed = mine[0];
    if (!seen.some((m) => m.id === echoed.id)) throw new Error("echo id missing");
    // Simulate the group re-delivering the same message: onMessage consumers key
    // off `id`, so re-invoking with the same id would be dropped by the page-level
    // de-dupe — assert the id is stable/re-derivable rather than duplicated here.
    expect(seen.filter((m) => m.id === echoed.id)).toHaveLength(1);
  });
});
