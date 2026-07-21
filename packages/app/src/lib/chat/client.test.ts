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
/** The event's configured coordinator (the only welcome author joinPending accepts). */
const COORD = "d".repeat(64);
const ATTACKER = "e".repeat(64);

interface FakeRumor {
  id: string;
  pubkey?: string;
  joinable?: boolean;
  /** MLS members the joined group ends up with (defaults to [COORD]). */
  members?: string[];
  /** nostr_group_id the joined group reports (defaults to gid-<id>). */
  nostrGroupId?: string;
}

interface FakeGroup {
  idStr: string;
  id: Uint8Array;
  state: { members: string[]; nostrGroupId: string };
  on: () => void;
}

class FakeInvites extends TinyEmitter {
  unread: FakeRumor[] = [];
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
  deliver(rumor: FakeRumor) {
    const full = { pubkey: COORD, ...rumor };
    this.unread.push(full);
    this.emit("decrypted", full);
  }
}

class FakeGroups {
  groups: FakeGroup[] = [];
  connectAllCalls = 0;
  send = vi.fn(async (_groupId: Uint8Array, _intent: unknown) => {});
  destroy = vi.fn(async (_groupId: Uint8Array) => {});
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
  async joinGroupFromWelcome({ welcomeRumor }: { welcomeRumor: FakeRumor }) {
    this.joinedFrom.push(welcomeRumor.id);
    this.groups.groups.push({
      idStr: "group-" + welcomeRumor.id,
      id: new Uint8Array([this.groups.groups.length + 1]),
      state: {
        members: welcomeRumor.members ?? [COORD],
        nostrGroupId: welcomeRumor.nostrGroupId ?? "gid-" + welcomeRumor.id,
      },
      on: () => {},
    });
    return { group: this.groups.groups[this.groups.groups.length - 1] };
  }
}

let lastClient: FakeMarmotClient;
// Keep the real rumor codec (createChatRumor / serialize / deserialize) so the
// optimistic-echo path (Bug 4) exercises the actual bytes — only the client shell
// and the group-id/member helpers are faked.
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
  return {
    ...actual,
    getNostrGroupIdHex: (state: { nostrGroupId?: string }) => state?.nostrGroupId ?? "deadbeef",
    getPubkeyLeafNodes: (state: { members?: string[] }, pubkey: string) =>
      (state?.members ?? []).includes(pubkey) ? [{}] : [],
  };
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
// The REAL stores module (namespacing logic under test for APPK-3), but every
// chat gets a fresh in-memory backend instead of the shared IndexedDB one.
vi.mock("./stores.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    marmotKvBackend: () =>
      new (actual.InMemoryKvBackend as new () => unknown)(),
  };
});
vi.mock("./network.js", () => ({ createMarmotNetwork: () => ({}) }));
vi.mock("./attest.js", () => ({ sendChatKeyAttestation: vi.fn(async () => {}) }));
vi.mock("$lib/nostr/ndk.js", () => ({
  publishSigned: vi.fn(async () => {}),
  fetchEventsRelayOnly: vi.fn(async () => []),
}));

import { MarmotChat } from "./client.js";

const ctx = {
  config: { relays: ["wss://r"], coordinator: COORD },
  coordinate: "31923:" + "f".repeat(64) + ":my-event",
} as never;
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
    expect(await chat.nostrGroupId()).toBe("gid-welcome-1");
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

describe("MarmotChat welcome provenance (audit APPK-2)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("never joins a welcome that wasn't sealed by the event's coordinator", async () => {
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();

    // The stray-group attack: an attacker fetched our public kind-30443 key
    // package, built THEIR OWN MLS group including our leaf, and gift-wrapped a
    // Welcome — sealed by THEIR key, not the coordinator's.
    lastClient.invites.deliver({ id: "attacker-group", pubkey: ATTACKER });
    await new Promise((r) => setTimeout(r, 20));

    // The client does not join, does not purge anything (nothing was joined),
    // and reports no group — the attacker's room never renders in this event.
    expect(lastClient.joinedFrom).toEqual([]);
    expect(lastClient.groups.destroy).not.toHaveBeenCalled();
    expect(await chat.nostrGroupId()).toBeUndefined();
    // The invite stays unread so its real owner (another event's session, or
    // nobody) is not robbed of it.
    expect(lastClient.invites.unread.map((u) => u.id)).toContain("attacker-group");
  });

  it("purges a joined group whose roster lacks the coordinator (post-join check)", async () => {
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();

    // Defense in depth: the seal check passed (pubkey = coordinator), but the
    // resulting group's MLS roster does not contain the coordinator's leaf.
    lastClient.invites.deliver({ id: "rogue", members: [ATTACKER] });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["rogue"]));
    await vi.waitFor(() => expect(lastClient.groups.destroy).toHaveBeenCalledOnce());

    // No binding is recorded, the event's chat stays un-joined — and the
    // invite is NOT marked read (a retry is possible).
    expect(await chat.nostrGroupId()).toBeUndefined();
    expect(lastClient.invites.unread.map((u) => u.id)).toContain("rogue");
  });
});

describe("MarmotChat per-event group scoping (audit APPK-3)", () => {
  beforeEach(() => vi.clearAllMocks());

  function foreignGroup(nostrGroupId: string, members: string[]): FakeGroup {
    return {
      idStr: "group-foreign",
      id: new Uint8Array([99]),
      state: { members, nostrGroupId },
      on: () => {},
    };
  }

  it("sends only to the current event's recorded group, never a foreign one", async () => {
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();
    lastClient.invites.deliver({ id: "welcome-a", nostrGroupId: "gid-event-a" });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["welcome-a"]));

    // A second event's group lives in the same per-identity store (the other
    // event's session joined it). It must be invisible to THIS event's client.
    lastClient.groups.groups.push(foreignGroup("gid-event-b", ["b".repeat(64)]));

    await chat.send("hello event A");
    expect(lastClient.groups.send).toHaveBeenCalledOnce();
    // group.id of the event-A group (first join → id [1]), not the foreign [99].
    expect(lastClient.groups.send.mock.calls[0]![0]).toEqual(new Uint8Array([1]));
    expect(await chat.nostrGroupId()).toBe("gid-event-a");
  });

  it("a second verified join does not clobber this event's existing binding", async () => {
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();
    lastClient.invites.deliver({ id: "welcome-a", nostrGroupId: "gid-event-a" });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["welcome-a"]));

    // Same-coordinator multi-event: a late welcome for ANOTHER event's group
    // (the welcome carries no event coordinate, so it passes the seal check)…
    lastClient.invites.deliver({ id: "welcome-b", nostrGroupId: "gid-event-b" });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["welcome-a", "welcome-b"]));

    // …but this event's room stays bound to the FIRST verified join.
    expect(await chat.nostrGroupId()).toBe("gid-event-a");
    await chat.send("still event A");
    expect(lastClient.groups.send.mock.calls[0]![0]).toEqual(new Uint8Array([1]));
  });

  it("a foreign group does not suppress this event's bootstrap (ensurePublished)", async () => {
    const chat = await MarmotChat.create({ accountSigner, ctx });
    // Before start(): only a foreign (other-event) group exists locally.
    lastClient.groups.groups.push(foreignGroup("gid-event-b", ["b".repeat(64)]));

    await chat.ensurePublished();
    // Not-yet-joined FOR THIS EVENT → the key package IS advertised (the old
    // loadAll()-based check would have early-returned and never bootstrapped).
    expect(lastClient.keyPackages.ensurePublished).toHaveBeenCalled();
  });

  it("adopts a single pre-scoping group when its roster holds the coordinator", async () => {
    const chat = await MarmotChat.create({ accountSigner, ctx });
    // Legacy install: joined group, no recorded coordinate→group binding.
    lastClient.groups.groups.push(foreignGroup("gid-legacy", [COORD]));

    await chat.start();
    // Exactly one coordinator-verified group → adopted as this event's room.
    expect(await chat.nostrGroupId()).toBe("gid-legacy");
  });

  it("refuses to guess when several coordinator-verified groups lack a binding", async () => {
    const chat = await MarmotChat.create({ accountSigner, ctx });
    lastClient.groups.groups.push(foreignGroup("gid-one", [COORD]));
    lastClient.groups.groups.push({
      ...foreignGroup("gid-two", [COORD]),
      idStr: "group-foreign-2",
      id: new Uint8Array([98]),
    });

    await chat.start();
    // Ambiguous — operate on none rather than risk the wrong room.
    expect(await chat.nostrGroupId()).toBeUndefined();
    await expect(chat.send("oops")).rejects.toThrow("no joined chat group yet");
  });
});
