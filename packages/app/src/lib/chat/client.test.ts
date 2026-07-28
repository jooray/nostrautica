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

// Shared test state, hoisted so the vi.mock factories below can read it. Lets two
// MarmotChat instances (two events, ONE chat identity) share a single storage
// backend and one joined-groups pool — the real "MLS state is namespaced per
// identity, not per event" condition the APPK-3 misdelivery bug requires — and lets
// tests drive what each event's roster advertises as its nostr_group_id.
const shared = vi.hoisted(() => ({
  backend: null as unknown, // shared InMemoryKvBackend, or null → a fresh one per client
  groups: null as unknown[] | null, // shared joined-groups pool, or null → per client
  rosters: new Map<string, { v: number; eck_current: number; nostr_group_id?: string; attendees: unknown[] }>(),
  // Coordinates where cachedRoster() should report a cold/stale cache miss even
  // though `rosters` (the live, relay-authoritative view fetchRoster reads) has
  // an entry — models a persisted roster cache decrypted before the coordinator
  // started advertising nostr_group_id (or before this event's group existed).
  staleCache: new Set<string>(),
  liveFetchCount: new Map<string, number>(),
}));

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
  // Share one joined-groups pool across clients when the test set one (two events,
  // one identity → one MLS state pool), else an isolated per-client pool.
  groups: FakeGroup[] = (shared.groups as FakeGroup[] | null) ?? [];
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
    // Per-device keys (D3): the chat key is never the account key, so every account
    // type attests and publishes a device kind-0 on bootstrap.
    isAccountKey: false,
    eventSigner: { getPublicKey: () => "c".repeat(64), signEvent: () => ({}), nip44: {} },
    accountProofSigner: () => new Uint8Array(),
    clientId: "web-test",
    secretKey: new Uint8Array(32),
  }),
  buildChatKeyProfile: () => ({ kind: 0, pubkey: "c".repeat(64), content: "{}", tags: [], sig: "" }),
  defaultDeviceLabel: () => "Test device",
}));
// Device kind-0 publish reads the account profile; keep it out of the network.
vi.mock("$lib/events/social.js", () => ({ fetchProfiles: vi.fn(async () => new Map()) }));
// The REAL stores module (namespacing logic under test for APPK-3), but every
// chat gets a fresh in-memory backend instead of the shared IndexedDB one.
vi.mock("./stores.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    marmotKvBackend: () =>
      shared.backend ?? new (actual.InMemoryKvBackend as new () => unknown)(),
  };
});
vi.mock("./network.js", () => ({ createMarmotNetwork: () => ({}) }));
vi.mock("./attest.js", () => ({ sendChatKeyAttestation: vi.fn(async () => {}) }));
vi.mock("$lib/nostr/ndk.js", () => ({
  publishSigned: vi.fn(async () => {}),
  fetchEventsRelayOnly: vi.fn(async () => []),
}));
// The roster is the coordinator's authoritative event→group binding (APPK-3).
// `cachedRoster` is the sync, hot-path read; `fetchRoster` the async one. Both
// resolve from the per-test `shared.rosters` map keyed by event coordinate.
vi.mock("$lib/events/attendee.js", () => ({
  cachedRoster: (coordinate: string) =>
    shared.staleCache.has(coordinate) ? undefined : shared.rosters.get(coordinate),
  fetchRoster: async (ctx: { coordinate: string }) => {
    shared.liveFetchCount.set(ctx.coordinate, (shared.liveFetchCount.get(ctx.coordinate) ?? 0) + 1);
    return shared.rosters.get(ctx.coordinate);
  },
}));

import { MarmotChat } from "./client.js";

const ctx = {
  config: { relays: ["wss://r"], coordinator: COORD },
  coordinate: "31923:" + "f".repeat(64) + ":my-event",
} as never;
const accountSigner = { getPublicKey: async () => "c".repeat(64) } as never;

// Reset the shared cross-instance fixtures before every test so a two-event test's
// shared backend/pool/rosters never leak into a single-event one.
beforeEach(() => {
  shared.backend = null;
  shared.groups = null;
  shared.rosters.clear();
  shared.staleCache.clear();
  shared.liveFetchCount.clear();
});

describe("MarmotChat.start() — late welcome (G-3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("joins a welcome that arrives AFTER start(), not just ones present up front", async () => {
    // The roster names this event's group id (fail-closed binding, NIP §10.4): a
    // joined welcome only binds once a verified roster id matches it.
    shared.rosters.set((ctx as unknown as { coordinate: string }).coordinate, {
      v: 2,
      eck_current: 1,
      nostr_group_id: "gid-welcome-1",
      attendees: [],
    });
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
    shared.rosters.set((ctx as unknown as { coordinate: string }).coordinate, {
      v: 2,
      eck_current: 1,
      nostr_group_id: "gid-welcome-send",
      attendees: [],
    });
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
    // Fail-closed binding: the roster must name this event's group before it binds.
    shared.rosters.set((ctx as unknown as { coordinate: string }).coordinate, {
      v: 2,
      eck_current: 1,
      nostr_group_id: "gid-event-a",
      attendees: [],
    });
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
    shared.rosters.set((ctx as unknown as { coordinate: string }).coordinate, {
      v: 2,
      eck_current: 1,
      nostr_group_id: "gid-event-a",
      attendees: [],
    });
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

  it("binds a pre-scoping group deterministically to the id the roster advertises", async () => {
    // Legacy install: joined group, no recorded coordinate→group binding. The
    // roster now names THIS event's group id, so it binds by that — not by a guess.
    shared.rosters.set((ctx as unknown as { coordinate: string }).coordinate, {
      v: 2,
      eck_current: 1,
      nostr_group_id: "gid-legacy",
      attendees: [],
    });
    const chat = await MarmotChat.create({ accountSigner, ctx });
    lastClient.groups.groups.push(foreignGroup("gid-legacy", [COORD]));

    await chat.start();
    expect(await chat.nostrGroupId()).toBe("gid-legacy");
  });

  it("refuses to guess when the roster advertises no group id (old coordinator)", async () => {
    // Roster present but WITHOUT nostr_group_id (a coordinator that predates the
    // fix, or no group yet). A single coordinator-verified group used to be adopted
    // by the old guess — that guess is exactly what could misroute a send, so with
    // ground truth absent we now refuse rather than risk the wrong room.
    shared.rosters.set((ctx as unknown as { coordinate: string }).coordinate, {
      v: 2,
      eck_current: 1,
      attendees: [],
    });
    const chat = await MarmotChat.create({ accountSigner, ctx });
    lastClient.groups.groups.push(foreignGroup("gid-legacy", [COORD]));

    await chat.start();
    expect(await chat.nostrGroupId()).toBeUndefined();
    await expect(chat.send("oops")).rejects.toThrow("no joined chat group yet");
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
    // No roster ground truth → operate on none rather than risk the wrong room.
    expect(await chat.nostrGroupId()).toBeUndefined();
    await expect(chat.send("oops")).rejects.toThrow("no joined chat group yet");
  });
});

// ── Unbound-candidate Welcome routing, fail-closed (NIP §10.4). A joined welcome
// is an UNBOUND CANDIDATE until a verified roster nostr_group_id matches it: no
// binding, no routing, no send target. Roster outage keeps chat "setting up".
describe("MarmotChat unbound-candidate routing (fail-closed, NIP §10.4)", () => {
  beforeEach(() => vi.clearAllMocks());

  const coord = (ctx as unknown as { coordinate: string }).coordinate;

  it("keeps a joined welcome unbound during a roster outage (no id, fetch fails)", async () => {
    // No cached roster and fetchRoster yields nothing (outage): the welcome joins
    // marmot's pool but must never bind — chat stays in setup, and a send throws.
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();
    lastClient.invites.deliver({ id: "welcome-outage", nostrGroupId: "gid-outage" });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["welcome-outage"]));

    expect(await chat.nostrGroupId()).toBeUndefined();
    await expect(chat.send("must not route to an unverified group")).rejects.toThrow(
      "no joined chat group yet",
    );
    expect(lastClient.groups.send).not.toHaveBeenCalled();
  });

  it("never routes a candidate whose id the roster does not name (wrong-event welcome)", async () => {
    // The roster names gid-right, but the welcome we joined is gid-wrong (another
    // same-coordinator event's group). It must never be adopted as this event's room.
    shared.rosters.set(coord, {
      v: 2,
      eck_current: 1,
      nostr_group_id: "gid-right",
      attendees: [],
    });
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();
    lastClient.invites.deliver({ id: "welcome-wrong", nostrGroupId: "gid-wrong" });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["welcome-wrong"]));

    // gid-wrong joined, but the roster names gid-right (which we do NOT hold) → unbound.
    expect(await chat.nostrGroupId()).toBeUndefined();
    await expect(chat.send("wrong room")).rejects.toThrow("no joined chat group yet");
  });

  it("binds the candidate once the roster arrives naming it (repair path)", async () => {
    // Join with no roster id yet → unbound. Then the roster publishes the id that
    // matches the joined group → currentEventGroups() repairs the binding.
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();
    lastClient.invites.deliver({ id: "welcome-late", nostrGroupId: "gid-late" });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["welcome-late"]));
    expect(await chat.nostrGroupId()).toBeUndefined();

    // The roster catches up and names this event's group.
    shared.rosters.set(coord, {
      v: 2,
      eck_current: 1,
      nostr_group_id: "gid-late",
      attendees: [],
    });
    expect(await chat.nostrGroupId()).toBe("gid-late");
    await chat.send("now that we're bound");
    expect(lastClient.groups.send).toHaveBeenCalledOnce();
  });
});

// ── The core APPK-3 misdelivery scenario: two events, ONE coordinator, ONE chat
// identity, ONE shared MLS-state pool — each event must resolve to ITS OWN group.
describe("MarmotChat two-events-one-coordinator group resolution (audit APPK-3)", () => {
  beforeEach(() => vi.clearAllMocks());

  const coordA = "31923:" + "a".repeat(64) + ":event-a";
  const coordB = "31923:" + "b".repeat(64) + ":event-b";
  const ctxA = { config: { relays: ["wss://r"], coordinator: COORD }, coordinate: coordA } as never;
  const ctxB = { config: { relays: ["wss://r"], coordinator: COORD }, coordinate: coordB } as never;

  /** A joined group in the shared pool, both events' coordinator is a member. */
  function joinedGroup(id: number, nostrGroupId: string): FakeGroup {
    return {
      idStr: "group-" + nostrGroupId,
      id: new Uint8Array([id]),
      state: { members: [COORD], nostrGroupId },
      on: () => {},
    };
  }

  it("each event resolves to its own roster-advertised group, never the other's", async () => {
    // One identity, one storage backend, one joined-groups pool holding BOTH events'
    // groups (both welcomes already joined; no bindings recorded — the migration case).
    const { InMemoryKvBackend } = await import("./stores.js");
    shared.backend = new (InMemoryKvBackend as new () => unknown)();
    shared.groups = [joinedGroup(1, "gid-A"), joinedGroup(2, "gid-B")];
    shared.rosters.set(coordA, { v: 2, eck_current: 1, nostr_group_id: "gid-A", attendees: [] });
    shared.rosters.set(coordB, { v: 2, eck_current: 1, nostr_group_id: "gid-B", attendees: [] });

    const chatA = await MarmotChat.create({ accountSigner, ctx: ctxA });
    const clientA = lastClient;
    const chatB = await MarmotChat.create({ accountSigner, ctx: ctxB });
    const clientB = lastClient;

    // The old guess saw TWO coordinator-verified groups and returned nothing (or, in
    // the single-group case, the WRONG one). The roster id disambiguates precisely.
    expect(await chatA.nostrGroupId()).toBe("gid-A");
    expect(await chatB.nostrGroupId()).toBe("gid-B");

    await chatA.send("hello event A");
    await chatB.send("hello event B");
    // Each send lands on its OWN group's id (gid-A → [1], gid-B → [2]) — no crossover.
    expect(clientA.groups.send).toHaveBeenCalledOnce();
    expect(clientA.groups.send.mock.calls[0]![0]).toEqual(new Uint8Array([1]));
    expect(clientB.groups.send).toHaveBeenCalledOnce();
    expect(clientB.groups.send.mock.calls[0]![0]).toEqual(new Uint8Array([2]));
  });

  it("corrects a pre-fix MIS-BINDING against the roster's authoritative id", async () => {
    const { InMemoryKvBackend, MARMOT_NAMESPACES } = (await import("./stores.js")) as unknown as {
      InMemoryKvBackend: new () => { set(k: string, v: unknown): Promise<void> };
      MARMOT_NAMESPACES: { eventGroups: string };
    };
    const backend = new InMemoryKvBackend();
    shared.backend = backend;
    shared.groups = [joinedGroup(1, "gid-A"), joinedGroup(2, "gid-B")];
    shared.rosters.set(coordA, { v: 2, eck_current: 1, nostr_group_id: "gid-A", attendees: [] });
    // Seed a WRONG binding: event A points at event B's group (the exact pre-fix
    // mis-bind — nothing re-points a present-but-wrong binding on its own). Identity
    // pubkey is "c"*64 (identity mock); the store key is <identity>␟<ns>␟<coordinate>.
    const identity = "c".repeat(64);
    await backend.set(`${identity}\u001f${MARMOT_NAMESPACES.eventGroups}\u001f${coordA}`, "gid-B");

    const chatA = await MarmotChat.create({ accountSigner, ctx: ctxA });
    // The roster says A is gid-A and we hold gid-A → the wrong binding is corrected.
    expect(await chatA.nostrGroupId()).toBe("gid-A");
    await chatA.send("to A after correction");
    expect(lastClient.groups.send.mock.calls[0]![0]).toEqual(new Uint8Array([1]));
  });

  it("self-heals a mis-binding via a live roster fetch when the cache is cold/stale", async () => {
    // Reproduces a real prod report: an existing member's recorded binding was
    // wrong (pre-fix), the coordinator has since started advertising the correct
    // nostr_group_id, but THIS BROWSER's persisted roster cache was decrypted
    // before that — cachedRoster() alone can't see the field and would leave the
    // wrong recorded binding in place forever, since nothing else on the
    // chat-open path is guaranteed to have refreshed the cache.
    const { InMemoryKvBackend, MARMOT_NAMESPACES } = (await import("./stores.js")) as unknown as {
      InMemoryKvBackend: new () => { set(k: string, v: unknown): Promise<void> };
      MARMOT_NAMESPACES: { eventGroups: string };
    };
    const backend = new InMemoryKvBackend();
    shared.backend = backend;
    shared.groups = [joinedGroup(1, "gid-A"), joinedGroup(2, "gid-B")];
    shared.rosters.set(coordA, { v: 2, eck_current: 1, nostr_group_id: "gid-A", attendees: [] });
    shared.staleCache.add(coordA);
    const identity = "c".repeat(64);
    await backend.set(`${identity}${MARMOT_NAMESPACES.eventGroups}${coordA}`, "gid-B");

    const chatA = await MarmotChat.create({ accountSigner, ctx: ctxA });
    // Falls back to one live fetchRoster() call, discovers the mismatch against
    // the AUTHORITATIVE (relay) roster, and re-points the binding.
    expect(await chatA.nostrGroupId()).toBe("gid-A");
    expect(shared.liveFetchCount.get(coordA)).toBe(1);
    await chatA.send("to A after live-fetch self-heal");
    expect(lastClient.groups.send.mock.calls[0]![0]).toEqual(new Uint8Array([1]));

    // Healed — a second read must not re-fetch the roster again.
    await chatA.nostrGroupId();
    expect(shared.liveFetchCount.get(coordA)).toBe(1);
  });

  it("tries the live roster fetch at most once per client even if still unresolved", async () => {
    const { InMemoryKvBackend, MARMOT_NAMESPACES } = (await import("./stores.js")) as unknown as {
      InMemoryKvBackend: new () => { set(k: string, v: unknown): Promise<void> };
      MARMOT_NAMESPACES: { eventGroups: string };
    };
    const backend = new InMemoryKvBackend();
    shared.backend = backend;
    // We only hold event A's group; event B's real group (gid-B) is NOT joined,
    // and B's roster cache is also cold.
    shared.groups = [joinedGroup(1, "gid-A")];
    shared.rosters.set(coordB, { v: 2, eck_current: 1, nostr_group_id: "gid-B", attendees: [] });
    shared.staleCache.add(coordB);
    const identity = "c".repeat(64);
    await backend.set(`${identity}${MARMOT_NAMESPACES.eventGroups}${coordB}`, "gid-A");

    const chatB = await MarmotChat.create({ accountSigner, ctx: ctxB });
    expect(await chatB.nostrGroupId()).toBeUndefined();
    expect(shared.liveFetchCount.get(coordB)).toBe(1);
    // Still refuses on a second read, and does not hammer the relay again.
    expect(await chatB.nostrGroupId()).toBeUndefined();
    expect(shared.liveFetchCount.get(coordB)).toBe(1);
  });

  it("refuses to route a mis-bound event whose real group we have NOT joined", async () => {
    const { InMemoryKvBackend, MARMOT_NAMESPACES } = (await import("./stores.js")) as unknown as {
      InMemoryKvBackend: new () => { set(k: string, v: unknown): Promise<void> };
      MARMOT_NAMESPACES: { eventGroups: string };
    };
    const backend = new InMemoryKvBackend();
    shared.backend = backend;
    // We only hold event A's group; event B's real group (gid-B) is NOT joined.
    shared.groups = [joinedGroup(1, "gid-A")];
    shared.rosters.set(coordB, { v: 2, eck_current: 1, nostr_group_id: "gid-B", attendees: [] });
    const identity = "c".repeat(64);
    // Event B is mis-bound to A's group. The roster says B is gid-B, which we don't
    // hold → refuse to route (never fall back to the recorded, wrong group A).
    await backend.set(`${identity}\u001f${MARMOT_NAMESPACES.eventGroups}\u001f${coordB}`, "gid-A");

    const chatB = await MarmotChat.create({ accountSigner, ctx: ctxB });
    expect(await chatB.nostrGroupId()).toBeUndefined();
    await expect(chatB.send("must not reach event A")).rejects.toThrow("no joined chat group yet");
  });
});

/**
 * Chat is the ONE subsystem that talks to the event's chat relays: the Marmot
 * interop pair carries exactly the kinds this class publishes (30443 key
 * packages, the chat identity's 0/10002/10050, 445/1059 traffic) and refuses
 * every other kind, which is why they live in the config's separate `chat_relay`
 * set instead of `config.relays`. If this getter ever narrows back to
 * `config.relays`, a Whitenoise attendee stops seeing our key package on the
 * relays their client actually reads — the 2026-07-20 "never joined the group"
 * report — with no error anywhere.
 */
describe("MarmotChat relay set (chat_relay)", () => {
  it("publishes chat identity + key package to the event relays UNION the chat relays", async () => {
    const chatCtx = {
      config: {
        relays: ["wss://r"],
        chatRelays: ["wss://relay.us.whitenoise.chat"],
        coordinator: COORD,
      },
      coordinate: "31923:" + "f".repeat(64) + ":my-event",
    } as never;
    const chat = await MarmotChat.create({ accountSigner, ctx: chatCtx });
    await chat.ensurePublished();
    const [arg] = lastClient.keyPackages.ensurePublished.mock.calls[0] as unknown as [
      { relays: string[] },
    ];
    expect(arg.relays).toEqual(["wss://r", "wss://relay.us.whitenoise.chat"]);
  });

  it("falls back to the event relays for a context cached before chat relays existed", async () => {
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.ensurePublished();
    const [arg] = lastClient.keyPackages.ensurePublished.mock.calls[0] as unknown as [
      { relays: string[] },
    ];
    expect(arg.relays).toEqual(["wss://r"]);
  });
});
