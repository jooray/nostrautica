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
  /** Ordered trace of the publish-side calls a rejoin makes (order is the point). */
  calls: [] as string[],
}));

interface FakeRumor {
  id: string;
  pubkey?: string;
  joinable?: boolean;
  /** MLS members the joined group ends up with (defaults to [COORD]). */
  members?: string[];
  /** nostr_group_id the joined group reports (defaults to gid-<id>). */
  nostrGroupId?: string;
  /** MLS group id the welcome resolves to (defaults to group-<id>). A re-add
   *  carries the SAME id as the state we already hold — see joinGroupFromWelcome. */
  mlsId?: string;
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
  destroy = vi.fn(async (groupId: Uint8Array | string) => {
    // Drop the state for real, so a retried join after a purge can succeed the
    // way it does against the library (destroy is its only teardown).
    if (typeof groupId !== "string") return;
    const i = this.groups.findIndex((g) => g.idStr === groupId);
    if (i >= 0) this.groups.splice(i, 1);
  });
  async get(groupId: Uint8Array | string) {
    const found =
      typeof groupId === "string" ? this.groups.find((g) => g.idStr === groupId) : undefined;
    if (!found) throw new Error("group not found");
    return found;
  }
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
  /** Locally stored key packages `rotate` can target (a real one has private material). */
  storedKeyPackages: { keyPackageRef: Uint8Array; identifier?: string }[] = [
    { keyPackageRef: new Uint8Array([7]), identifier: "web-test" },
  ];
  keyPackages = {
    ensurePublished: vi.fn(async () => {
      shared.calls.push("kp:ensurePublished");
    }),
    create: vi.fn(async () => {
      shared.calls.push("kp:create");
      return {};
    }),
    list: vi.fn(async () => this.storedKeyPackages),
    rotate: vi.fn(async () => {
      shared.calls.push("kp:rotate");
      return {};
    }),
  };
  joinedFrom: string[] = [];
  async canJoinInvite(inv: { joinable?: boolean }) {
    return inv.joinable !== false;
  }
  async joinGroupFromWelcome({ welcomeRumor }: { welcomeRumor: FakeRumor }) {
    const idStr = welcomeRumor.mlsId ?? "group-" + welcomeRumor.id;
    // marmot refuses to adopt a state whose group id it already holds —
    // groups-manager.js `adoptClientState`, checked against the PERSISTENT
    // registry. A re-add is an Add into the same group, so this is exactly what
    // a removed-then-re-added device hits. Modelling it is the point: the old
    // fake pushed a second state per welcome, a shape the library forbids.
    if (this.groups.groups.some((g) => g.idStr === idStr)) {
      throw new Error(`Group ${idStr} already exists`);
    }
    this.joinedFrom.push(welcomeRumor.id);
    this.groups.groups.push({
      idStr,
      id: new Uint8Array([this.groups.groups.length + 1]),
      state: {
        // A real Welcome always adds THIS device's leaf alongside the coordinator's
        // — membership checks (am I still in the room?) depend on that being modelled.
        members: welcomeRumor.members ?? [COORD, "c".repeat(64)],
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
vi.mock("./attest.js", () => ({
  sendChatKeyAttestation: vi.fn(async (_signer: unknown, _ctx: unknown, input: { op: string }) => {
    shared.calls.push(`attest:${input.op}`);
  }),
}));
vi.mock("$lib/nostr/ndk.js", () => ({
  publishSigned: vi.fn(async () => {}),
  // The Bug-2 re-verification read: "is our kind-30443 actually retrievable?".
  // Model a relay that serves whatever this client last published, so a key
  // package it just rotated/created is found (and not redundantly republished).
  fetchEventsRelayOnly: vi.fn(async () =>
    shared.calls.some((c) => c === "kp:rotate" || c === "kp:create") ? [{ id: "kp-on-relay" }] : [],
  ),
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
  shared.calls.length = 0;
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
 * Re-enrolment (`rejoin`) — the recovery for a device that is a listed, active chat
 * device of an approved attendee (the app's device list shows it, "TOTO ZARIADENIE")
 * yet holds no group, so every send fails. A plain republish cannot fix that: marmot
 * re-advertises the SAME addressable 30443 while its local copy is unused, the
 * coordinator dedupes that event id for 30 days, and it skips anyone who still holds
 * a leaf. So the order below — revoke (drop the leaf), rotate (new event id),
 * re-attest — is the fix, and each step is load-bearing.
 */
describe("MarmotChat.rejoin() — re-enrolling a device that fell out of the group", () => {
  beforeEach(() => vi.clearAllMocks());

  const coord = (ctx as unknown as { coordinate: string }).coordinate;

  it("revokes this device, rotates the key package, then re-attests — in that order", async () => {
    // Stuck state: the roster names a group we never joined (welcome lost).
    shared.rosters.set(coord, { v: 2, eck_current: 1, nostr_group_id: "gid-x", attendees: [] });
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();
    expect(await chat.nostrGroupId()).toBeUndefined();
    shared.calls.length = 0;

    await chat.rejoin();

    // Revoke FIRST (or the re-add lands on a coordinator that still sees a leaf and
    // skips it), rotate SECOND (or the re-advertised 30443 keeps its consumed id),
    // attest LAST (it is what drives the coordinator's syncMember).
    expect(shared.calls).toEqual(["attest:revoke", "kp:rotate", "kp:ensurePublished", "attest:add"]);
    // The rotation reuses this device's slot, so the relay replaces in place rather
    // than leaving a second key package behind.
    const [, opts] = lastClient.keyPackages.rotate.mock.calls[0] as unknown as [
      Uint8Array,
      { d?: string; relays?: string[] },
    ];
    expect(opts.d).toBe("web-test");
    expect(opts.relays).toEqual(["wss://r"]);
  });

  it("joins the welcome that follows and routes sends to the new group", async () => {
    shared.rosters.set(coord, { v: 2, eck_current: 1, nostr_group_id: "gid-rejoined", attendees: [] });
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();
    await chat.rejoin();

    // The coordinator adds us again; the welcome lands on the listener start() left.
    lastClient.invites.deliver({ id: "welcome-rejoin", nostrGroupId: "gid-rejoined" });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["welcome-rejoin"]));

    expect(await chat.nostrGroupId()).toBe("gid-rejoined");
    await chat.send("back in the room");
    expect(lastClient.groups.send).toHaveBeenCalledOnce();
  });

  // prod 2026-07-30: pressing Rejoin reported success and published NOTHING. The
  // guard asked "do we hold this event's group?", but an MLS Remove strips only our
  // leaf — the local group state and its decrypted history stay exactly where they
  // were. So a removed member (who sees the room, the history and the member count,
  // and cannot send) took the healthy branch every time, from the button AND from
  // the bootstrap that runs on every open.
  it("rejoins a member whose leaf was removed even though the group state is still held", async () => {
    shared.rosters.set(coord, { v: 2, eck_current: 1, nostr_group_id: "gid-removed", attendees: [] });
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();
    // Joined with our own leaf present (members includes this device's chat key).
    lastClient.invites.deliver({
      id: "welcome-before-removal",
      nostrGroupId: "gid-removed",
      members: [COORD, "c".repeat(64)],
    });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["welcome-before-removal"]));

    // The coordinator removes us; the commit lands over 445 and our local state
    // loses our leaf — but the group, and everything we already decrypted, remain.
    lastClient.groups.groups[0]!.state.members = [COORD];
    expect(await chat.nostrGroupId()).toBe("gid-removed"); // still bound, still readable
    shared.calls.length = 0;

    await chat.rejoin();

    expect(shared.calls).toEqual(["attest:revoke", "kp:rotate", "kp:ensurePublished", "attest:add"]);
  });

  it("re-advertises on open for a removed member, so a reload heals without the button", async () => {
    shared.rosters.set(coord, { v: 2, eck_current: 1, nostr_group_id: "gid-removed2", attendees: [] });
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();
    lastClient.invites.deliver({
      id: "welcome-2",
      nostrGroupId: "gid-removed2",
      members: [COORD, "c".repeat(64)],
    });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["welcome-2"]));
    shared.calls.length = 0;

    // Still a member → the bootstrap stays quiet (this is the "don't re-add me on
    // every open" guarantee that the group-presence check was protecting).
    await chat.ensurePublished();
    expect(shared.calls).toEqual([]);

    // Removed → the bootstrap advertises again and re-attests. It also ROTATES:
    // the key package it would otherwise re-advertise is the one already spent on
    // the Add that created the leaf we just lost, so the coordinator has recorded
    // its event id as consumed and would skip it (prod 2026-07-30).
    lastClient.groups.groups[0]!.state.members = [COORD];
    await chat.ensurePublished();
    expect(shared.calls).toEqual(["kp:rotate", "kp:ensurePublished", "attest:add"]);
  });

  it("does NOT rotate for a client that was never added — its welcome may be in flight", async () => {
    // Never-added is not evicted: the advertised key package is unspent, and the
    // coordinator's Welcome (if it already went out) is encrypted to exactly that
    // key. Rotating would discard the private material needed to join with it.
    shared.rosters.set(coord, { v: 2, eck_current: 1, nostr_group_id: "gid-pending", attendees: [] });
    const chat = await MarmotChat.create({ accountSigner, ctx });
    shared.calls.length = 0;

    await chat.ensurePublished();

    expect(shared.calls).toEqual(["kp:ensurePublished", "kp:create", "attest:add"]);
    expect(shared.calls).not.toContain("kp:rotate");
  });

  it("routes sends to the live group state after a re-add, not the dead one", async () => {
    // A removal + re-add leaves two local states for one nostr_group_id. groups[0]
    // is the send target, so the one we still hold a leaf in has to come first.
    shared.rosters.set(coord, { v: 2, eck_current: 1, nostr_group_id: "gid-dup", attendees: [] });
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();
    lastClient.invites.deliver({ id: "w-old", nostrGroupId: "gid-dup", members: [COORD, "c".repeat(64)] });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["w-old"]));
    lastClient.groups.groups[0]!.state.members = [COORD]; // removed from the old state
    // Re-added: a second Welcome for the SAME room yields a second local state.
    lastClient.invites.deliver({ id: "w-new", nostrGroupId: "gid-dup", members: [COORD, "c".repeat(64)] });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["w-old", "w-new"]));

    await chat.send("after the re-add");
    // group.id [2] is the second (live) join; [1] is the corpse.
    expect(lastClient.groups.send.mock.calls[0]![0]).toEqual(new Uint8Array([2]));
  });

  it("is inert for a session that can still route — never tears down a working membership", async () => {
    shared.rosters.set(coord, { v: 2, eck_current: 1, nostr_group_id: "gid-healthy", attendees: [] });
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();
    lastClient.invites.deliver({ id: "welcome-healthy", nostrGroupId: "gid-healthy" });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["welcome-healthy"]));
    shared.calls.length = 0;

    await chat.rejoin();

    expect(shared.calls).toEqual([]);
    expect(await chat.nostrGroupId()).toBe("gid-healthy");
  });

  it("drops the memoized fail-closed roster lookup, so routing recovers afterwards", async () => {
    // A client that once found no advertised group id memoizes that for its whole
    // life (currentEventGroups). Without clearing it, a rejoin could succeed and the
    // very next send would still refuse to route.
    const { InMemoryKvBackend, MARMOT_NAMESPACES } = (await import("./stores.js")) as unknown as {
      InMemoryKvBackend: new () => { set(k: string, v: unknown): Promise<void> };
      MARMOT_NAMESPACES: { eventGroups: string };
    };
    const backend = new InMemoryKvBackend();
    shared.backend = backend;
    const identity = "c".repeat(64);
    await backend.set(`${identity}${MARMOT_NAMESPACES.eventGroups}${coord}`, "gid-old");

    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();
    // No roster at all → fail-closed refusal, and the empty result is memoized.
    expect(await chat.nostrGroupId()).toBeUndefined();
    expect(shared.liveFetchCount.get(coord)).toBe(1);

    // The coordinator's roster is readable again and names the group we now join.
    shared.rosters.set(coord, { v: 2, eck_current: 1, nostr_group_id: "gid-new", attendees: [] });
    await chat.rejoin();
    lastClient.invites.deliver({ id: "welcome-after-rejoin", nostrGroupId: "gid-new" });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["welcome-after-rejoin"]));

    expect(await chat.nostrGroupId()).toBe("gid-new");
  });

  it("falls back to creating a key package when there is no local one to rotate", async () => {
    shared.rosters.set(coord, { v: 2, eck_current: 1, nostr_group_id: "gid-y", attendees: [] });
    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();
    lastClient.storedKeyPackages = []; // local key-package store was cleared
    shared.calls.length = 0;

    await chat.rejoin();

    expect(shared.calls).toEqual(["attest:revoke", "kp:create", "kp:ensurePublished", "attest:add"]);
    const [opts] = lastClient.keyPackages.create.mock.calls[0] as unknown as [{ identifier?: string }];
    expect(opts.identifier).toBe("web-test");
  });

  // The state that made "Rejoin this chat" useless. A re-add is an Add into the
  // SAME MLS group, so its Welcome carries the group id we already hold — and a
  // removal does not delete that state (marmot keeps the tombstone by design).
  // adoptClientState then threw "Group <id> already exists", the caller swallowed
  // it as a console warning, the invite was never marked read, and the device
  // retried and re-threw on every open: listed under Chat devices, holding group
  // state, permanently unable to send.
  it("adopts a re-invite for a group it still holds the removed state for", async () => {
    const { InMemoryKvBackend, MARMOT_NAMESPACES } = (await import("./stores.js")) as unknown as {
      InMemoryKvBackend: new () => {
        set(k: string, v: unknown): Promise<void>;
        get(k: string): Promise<unknown>;
      };
      MARMOT_NAMESPACES: { history: string };
    };
    const backend = new InMemoryKvBackend();
    shared.backend = backend;
    const identity = "c".repeat(64);
    const MLS_ID = "abcdef0123456789";
    // The corpse: this event's group with our leaf stripped, exactly as an MLS
    // Remove leaves it — plus the decrypted backlog we can still read.
    shared.groups = [
      {
        idStr: MLS_ID,
        id: new Uint8Array([1]),
        state: { members: [COORD], nostrGroupId: "gid-readd" },
        on: () => {},
      },
    ];
    shared.rosters.set(coord, { v: 2, eck_current: 1, nostr_group_id: "gid-readd", attendees: [] });
    const historyKey = `${identity}\u001f${MARMOT_NAMESPACES.history}:${MLS_ID}\u001fmsg-1`;
    await backend.set(historyKey, { id: "msg-1", content: "said before the removal" });

    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();

    // The coordinator re-adds us: same MLS group, same id.
    lastClient.invites.deliver({
      id: "welcome-readd",
      mlsId: MLS_ID,
      nostrGroupId: "gid-readd",
      members: [COORD, identity],
    });
    await vi.waitFor(() => expect(lastClient.joinedFrom).toEqual(["welcome-readd"]));

    // Adopted: the room resolves and a send routes to the freshly joined state.
    expect(await chat.nostrGroupId()).toBe("gid-readd");
    await chat.send("back after the re-add");
    expect(lastClient.groups.send).toHaveBeenCalledOnce();
    // The welcome is consumed, so it is not re-thrown on every later open.
    expect(lastClient.invites.unread.map((u) => u.id)).not.toContain("welcome-readd");
    // Purging the corpse must not cost the user their readable backlog:
    // groups.destroy() takes the history with the state, so it is put back.
    expect(await backend.get(historyKey)).toEqual({
      id: "msg-1",
      content: "said before the removal",
    });
  });

  it("never discards a group we still hold a leaf in", async () => {
    // Same collision, but we are a LIVE member — a duplicate/replayed welcome for
    // a working room must not destroy it. The error propagates as before.
    const MLS_ID = "beefcafe00112233";
    const identity = "c".repeat(64);
    shared.groups = [
      {
        idStr: MLS_ID,
        id: new Uint8Array([2]),
        state: { members: [COORD, identity], nostrGroupId: "gid-live" },
        on: () => {},
      },
    ];
    shared.rosters.set(coord, { v: 2, eck_current: 1, nostr_group_id: "gid-live", attendees: [] });

    const chat = await MarmotChat.create({ accountSigner, ctx });
    await chat.start();
    lastClient.invites.deliver({ id: "dup-welcome", mlsId: MLS_ID, nostrGroupId: "gid-live" });
    await new Promise((r) => setTimeout(r, 20));

    expect(lastClient.groups.destroy).not.toHaveBeenCalled();
    expect(lastClient.groups.groups.map((g) => g.idStr)).toEqual([MLS_ID]);
    expect(await chat.nostrGroupId()).toBe("gid-live");
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
