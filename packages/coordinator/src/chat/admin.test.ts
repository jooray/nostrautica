import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { Store } from "../store/db.js";
import { MarmotAdmin } from "./admin.js";
import type { ChatMls } from "./mls.js";
import { makeChatDeviceProof, type ChatKeyAttestationContent } from "@nostrautica/protocol";

type AnyEvent = { id: string; pubkey: string; kind: number; tags: string[][] };

const COORD = "31923:" + "e".repeat(64) + ":devcon";
const ACCOUNT = "a".repeat(64);
// Real device keys: CHATKEY/CHATKEY2 are the pubkeys of DEVICE_SK/DEVICE_SK2, so a
// 21607-add proof of possession (NIP §10.2) can actually be signed and verified.
const DEVICE_SK = generateSecretKey();
const CHATKEY = getPublicKey(DEVICE_SK);
const DEVICE_SK2 = generateSecretKey();
const CHATKEY2 = getPublicKey(DEVICE_SK2);
/** The rumor created_at bound into the proof challenge (also the admin's now()). */
const CREATED_AT = 1000;

/** An in-memory ChatMls: tracks membership per group in a Set, records all calls. */
class FakeMls implements ChatMls {
  members = new Map<string, Set<string>>();
  invited: string[] = [];
  removed: string[][] = [];
  ingested: AnyEvent[][] = [];
  relays = new Map<string, string[]>();
  admins = new Map<string, string[]>();
  createdWithAdmins: string[] | undefined;
  eligible = true;
  created = 0;
  throwOnInvite = new Set<string>();

  async createGroup(opts?: { adminPubkeys?: string[] }): Promise<{ mlsGroupIdHex: string; nostrGroupIdHex: string }> {
    this.created++;
    this.createdWithAdmins = opts?.adminPubkeys;
    const id = "mls-" + this.created;
    if (opts?.adminPubkeys) this.admins.set(id, opts.adminPubkeys);
    return { mlsGroupIdHex: id, nostrGroupIdHex: "ng-" + this.created };
  }
  async isEligible(): Promise<boolean> {
    return this.eligible;
  }
  async isMember(group: string, pubkey: string): Promise<boolean> {
    return this.members.get(group)?.has(pubkey) ?? false;
  }
  async invite(group: string, kp: AnyEvent): Promise<void> {
    if (this.throwOnInvite.has(kp.pubkey)) {
      throw new Error(`simulated: unsupported proof version 2 (${kp.pubkey})`);
    }
    (this.members.get(group) ?? this.members.set(group, new Set()).get(group)!).add(kp.pubkey);
    this.invited.push(kp.pubkey);
  }
  async removePubkeys(group: string, pubkeys: string[]): Promise<void> {
    const set = this.members.get(group);
    for (const p of pubkeys) set?.delete(p);
    this.removed.push(pubkeys);
  }
  async ingest(_group: string, events: AnyEvent[]): Promise<void> {
    this.ingested.push(events);
  }
  async getRelays(group: string): Promise<string[]> {
    return this.relays.get(group) ?? [];
  }
  async ensureRelays(group: string, relays: string[]): Promise<void> {
    const have = new Set(this.relays.get(group) ?? []);
    const missing = relays.filter((r) => !have.has(r));
    if (missing.length === 0) return;
    this.relays.set(group, [...(this.relays.get(group) ?? []), ...missing]);
  }
  async getAdmins(group: string): Promise<string[]> {
    return this.admins.get(group) ?? [];
  }
  async setAdmins(group: string, adminPubkeys: string[]): Promise<void> {
    this.admins.set(group, [...adminPubkeys]);
  }
}

function kpEvent(pubkey: string, id: string): AnyEvent {
  return { id, pubkey, kind: 30443, tags: [] };
}

/** The coordinator's own pubkey — always retained in the MLS admin set. */
const COORDINATOR = "c".repeat(64);

/** Build an admin whose key-package fetch returns the pre-seeded events per author. */
function makeAdmin(store: Store, mls: FakeMls, kps: AnyEvent[] = []) {
  const now = () => 1000;
  return new MarmotAdmin({
    store,
    mls,
    now,
    coordinatorPubkey: COORDINATOR,
    fetchKeyPackages: async (_coordinate, authors) =>
      kps.filter((e) => authors.includes(e.pubkey)),
  });
}

function freshStore(): Store {
  return new Store(":memory:", generateSecretKey());
}

/**
 * Build a 21607 v2 attestation content. For op:"add" it attaches a real proof of
 * possession signed by the device key (`deviceSk`, default DEVICE_SK) over the
 * §10.2 challenge for `account` (default ACCOUNT) at CREATED_AT. `op:"revoke"`
 * carries no proof. Pass `deviceSk: undefined` to omit the proof entirely (to test
 * the missing-proof rejection).
 */
function attest(
  op: "add" | "revoke",
  chatPubkey = CHATKEY,
  opts: { deviceSk?: Uint8Array | null; account?: string; label?: string } = {},
): ChatKeyAttestationContent {
  const base = { v: 2 as const, a: COORD, op, chat_pubkey: chatPubkey };
  if (op !== "add") return base;
  const account = opts.account ?? ACCOUNT;
  const deviceSk = "deviceSk" in opts ? opts.deviceSk : DEVICE_SK;
  const proof = deviceSk ? makeChatDeviceProof(deviceSk, COORD, account, CREATED_AT) : undefined;
  return { ...base, label: opts.label ?? "Test device", ...(proof ? { proof } : {}) };
}

describe("MarmotAdmin — group lifecycle & chat-off inertness", () => {
  it("chat-off inertness: with no group, add/remove/ingest paths are no-ops", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(ACCOUNT, "kp1")]);
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });

    // No ensureGroup was called → nothing happens anywhere.
    await admin.syncMember(COORD, ACCOUNT);
    await admin.handleRevoke(COORD, ACCOUNT);
    await admin.ingest(COORD, [kpEvent(ACCOUNT, "x")]);
    await admin.handleKeyPackageEvent(COORD, kpEvent(ACCOUNT, "kp1"));

    expect(mls.created).toBe(0);
    expect(mls.invited).toEqual([]);
    expect(mls.removed).toEqual([]);
    expect(mls.ingested).toEqual([]);
    expect(store.getMarmotGroup(COORD)).toBeUndefined();
  });

  it("ensureGroup creates once and persists the mapping; re-ensure reuses it", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls);
    const a = await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    const b = await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    expect(mls.created).toBe(1);
    expect(a).toEqual(b);
    const row = store.getMarmotGroup(COORD)!;
    expect(row.mls_group_id).toBe("mls-1");
    expect(row.nostr_group_id).toBe("ng-1");
    expect(row.status).toBe("active");
  });

  it("freeze stops adds; a frozen group re-activates on re-ensure", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(ACCOUNT, "kp1")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    admin.freeze(COORD);
    expect(store.getMarmotGroup(COORD)!.status).toBe("frozen");
    await admin.syncMember(COORD, ACCOUNT); // frozen → no add
    expect(mls.invited).toEqual([]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    expect(store.getMarmotGroup(COORD)!.status).toBe("active");
  });

  // Re-attach-with-chat after a detach (NIP §3.5 detach + §3.7 handover + §10.4
  // routing). When a DIFFERENT coordinator re-attaches — the handover case — its
  // marmot_groups is empty, so it mints a FRESH group with a new routing id, and
  // clients re-route to it via the roster's new nostr_group_id and rejoin. (The
  // same-coordinator reuse/re-activate path is the "freeze re-activates" test above.)
  it("a re-attaching coordinator creates a fresh group, invites the eligible set, and advertises a new routing id", async () => {
    // P6: only ATTESTED DEVICE keys are chat identities — each approved account
    // brings its own attested device (CHATKEY, CHATKEY2). Account keys are never
    // eligible on their own.
    const ACCOUNT2 = "b".repeat(64);
    const kps = [kpEvent(CHATKEY, "kpChat"), kpEvent(CHATKEY2, "kpChat2")];
    const eligible = [CHATKEY, CHATKEY2].sort();

    // ── Coordinator A: chat live, the full eligible set (each account's attested
    //    device key) added to group ng-1. ──
    const storeA = freshStore();
    const mlsA = new FakeMls();
    const adminA = makeAdmin(storeA, mlsA, kps);
    await adminA.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    storeA.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    storeA.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT2, status: "approved", now: 1 });
    storeA.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });
    storeA.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT2, chatPubkey: CHATKEY2, now: 1 });
    await adminA.backfillApproved(COORD);
    expect(mlsA.invited.sort()).toEqual(eligible);
    const idA = storeA.getMarmotGroup(COORD)!.nostr_group_id;

    // ── Detach: coordinator A freezes its group (chat administration orphaned). ──
    adminA.freeze(COORD);
    expect(storeA.getMarmotGroup(COORD)!.status).toBe("frozen");

    // ── Coordinator B re-attaches with a fresh store; its §3.7 roster bootstrap
    //    re-seeds the same eligible attendee set. Empty marmot_groups ⇒ a brand-new
    //    group with a new routing id (offset so it's visibly ≠ A's ng-1). ──
    const storeB = freshStore();
    const mlsB = new FakeMls();
    mlsB.created = 10;
    const adminB = makeAdmin(storeB, mlsB, kps);
    storeB.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 2 });
    storeB.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT2, status: "approved", now: 2 });
    storeB.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 2 });
    storeB.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT2, chatPubkey: CHATKEY2, now: 2 });

    const idsB = await adminB.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    await adminB.backfillApproved(COORD);

    // A fresh group was minted (not a reuse of A's), active, with a NEW routing id —
    // the roster's §10.4 nostr_group_id clients route to and rejoin under.
    expect(mlsB.created).toBe(11);
    const rowB = storeB.getMarmotGroup(COORD)!;
    expect(rowB.status).toBe("active");
    expect(rowB.nostr_group_id).toBe("ng-11");
    expect(rowB.nostr_group_id).not.toBe(idA);
    expect(idsB.nostrGroupIdHex).toBe("ng-11");
    // The full eligible set (each account's attested device key) is invited into it.
    expect(mlsB.invited.sort()).toEqual(eligible);
  });
});

describe("MarmotAdmin — add on approve / key package (§4.2)", () => {
  it("adds an approved attendee's attested device key from their 30443, deduped by event id", async () => {
    // P6: the account attests a device key (CHATKEY); the DEVICE key is the chat
    // identity added to the group, never the account key itself.
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });

    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.invited).toEqual([CHATKEY]);
    expect(store.isKpConsumed(COORD, "kp1")).toBe(true);

    // Re-sync: already a member + consumed → no second invite.
    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.invited).toEqual([CHATKEY]);
  });

  it("an approved account with no attested device brings NO chat identity (P6)", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    // The 30443 is signed by the ACCOUNT key, but the account key is not a chat
    // identity and no device is attested → nothing is added.
    const admin = makeAdmin(store, mls, [kpEvent(ACCOUNT, "kp1")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });

    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.invited).toEqual([]);
    // The account key's own 30443 is likewise ignored by the watcher.
    await admin.handleKeyPackageEvent(COORD, kpEvent(ACCOUNT, "kpAcct"));
    expect(mls.invited).toEqual([]);
  });

  it("multi-device: two attested device keys of one account are both added", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1"), kpEvent(CHATKEY2, "kp2")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY2, now: 1 });

    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.invited.sort()).toEqual([CHATKEY, CHATKEY2].sort());
  });

  it("a key package that fails to invite (e.g. unsupported proof version) is logged, not thrown, and doesn't block other members or leave it wrongly marked ineligible", async () => {
    // Two accounts, each with its own attested device (CHATKEY / CHATKEY2). One
    // device's invite throws deep inside marmot-ts; the other still gets in.
    const ACCOUNT2 = "b".repeat(64);
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp-good"), kpEvent(CHATKEY2, "kp-bad")]);
    mls.throwOnInvite.add(CHATKEY2);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT2, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT2, chatPubkey: CHATKEY2, now: 1 });

    // Neither backfillApproved nor syncMember should throw even though one
    // member's invite fails deep inside the (real) marmot-ts engine.
    await expect(admin.backfillApproved(COORD)).resolves.toBeUndefined();

    expect(mls.invited).toEqual([CHATKEY]); // the good one still got in
    expect(store.isKpConsumed(COORD, "kp-good")).toBe(true);
    expect(store.isKpConsumed(COORD, "kp-bad")).toBe(false); // not blackholed — eligible for retry

    // A later retry (e.g. next coordinator restart) tries again rather than
    // silently skipping it forever.
    await admin.syncMember(COORD, ACCOUNT2);
    expect(mls.invited).toEqual([CHATKEY]);
  });

  it("the 30443 watcher adds an authorized author and ignores an unauthorized one", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });

    // Authorized: the approved account's attested device key.
    await admin.handleKeyPackageEvent(COORD, kpEvent(CHATKEY, "kpA"));
    expect(mls.invited).toEqual([CHATKEY]);

    // Unauthorized: a stranger's key package is ignored (not an authorized identity).
    const stranger = "f".repeat(64);
    await admin.handleKeyPackageEvent(COORD, kpEvent(stranger, "kpS"));
    expect(mls.invited).toEqual([CHATKEY]);
  });

  it("does not add a pending (unapproved) attendee", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "pending", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });
    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.invited).toEqual([]);
  });
});

describe("MarmotAdmin — attestation authentication (§3.3)", () => {
  it("rejects an attestation from a non-enrolled account", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    // ACCOUNT is not an attendee row → rejected, nothing recorded.
    const ok = await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT);
    expect(ok).toBe(false);
    expect(store.getChatKey(COORD, CHATKEY)).toBeUndefined();
    expect(mls.invited).toEqual([]);
  });

  it("records an enrolled attendee's chat key and (when approved) syncs it in", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp2")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });

    const ok = await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT);
    expect(ok).toBe(true);
    expect(store.getChatKey(COORD, CHATKEY)?.status).toBe("active");
    expect(mls.invited).toEqual([CHATKEY]); // synced in on attest
  });

  it("records but does NOT add a chat key for a pending account", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp2")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "pending", now: 1 });

    await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT);
    expect(store.getChatKey(COORD, CHATKEY)?.status).toBe("active"); // recorded
    expect(mls.invited).toEqual([]); // but not added
  });

  it("op:revoke marks the key revoked and MLS-removes its leaves", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp2")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT);
    expect(mls.members.get("mls-1")?.has(CHATKEY)).toBe(true);

    await admin.handleAttestation(COORD, ACCOUNT, attest("revoke"), CREATED_AT);
    expect(store.getChatKey(COORD, CHATKEY)?.status).toBe("revoked");
    expect(mls.removed.at(-1)).toEqual([CHATKEY]);
    expect(mls.members.get("mls-1")?.has(CHATKEY)).toBe(false);
  });

  it("eligibleChatAuthors: only approved accounts' active identities are authorized", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    // Approved account with two attested keys, one later revoked.
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY2, now: 1 });
    store.setChatKeyStatus(COORD, CHATKEY2, "revoked", 2);
    // A pending account with an attested key — not authorized.
    const pending = "b".repeat(64);
    const pendingChat = "9".repeat(64);
    store.upsertAttendee({ coordinate: COORD, pubkey: pending, status: "pending", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: pending, chatPubkey: pendingChat, now: 1 });

    const authors = admin.eligibleChatAuthors(COORD).sort();
    expect(authors).toEqual([CHATKEY]); // P6: only the active attested device, not the account key
    expect(authors).not.toContain(ACCOUNT); // account key is never a chat identity
    expect(authors).not.toContain(CHATKEY2); // revoked
    expect(authors).not.toContain(pending); // not approved
  });
});

describe("MarmotAdmin — attestation authorization (audit COORD-1/COORD-10)", () => {
  it("a stranger cannot revoke another member's chat key", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp2")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    const stranger = "f".repeat(64);
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertAttendee({ coordinate: COORD, pubkey: stranger, status: "approved", now: 1 });
    await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT);
    expect(mls.members.get("mls-1")?.has(CHATKEY)).toBe(true);

    // The enrolled stranger tries to evict ACCOUNT's chat key — rejected, key intact.
    const ok = await admin.handleAttestation(COORD, stranger, attest("revoke"), CREATED_AT);
    expect(ok).toBe(false);
    expect(store.getChatKey(COORD, CHATKEY)?.status).toBe("active");
    expect(mls.members.get("mls-1")?.has(CHATKEY)).toBe(true);
    // The owner CAN still revoke it.
    expect(await admin.handleAttestation(COORD, ACCOUNT, attest("revoke"), CREATED_AT)).toBe(true);
    expect(store.getChatKey(COORD, CHATKEY)?.status).toBe("revoked");
  });

  it("a pending account's revoke is rejected outright (add is recorded-only)", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "pending", now: 1 });
    await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT);

    const ok = await admin.handleAttestation(COORD, ACCOUNT, attest("revoke"), CREATED_AT);
    expect(ok).toBe(false);
    expect(store.getChatKey(COORD, CHATKEY)?.status).toBe("active"); // not revoked
    expect(mls.removed).toEqual([]); // no MLS removal happened
  });

  it("attendee B cannot rebind (steal) a chat_pubkey bound to attendee A", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    const b = "b".repeat(64);
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertAttendee({ coordinate: COORD, pubkey: b, status: "approved", now: 1 });

    expect(await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(true);
    // B attests the SAME chat key with a genuine proof of possession (B even holds
    // the device secret) — still rejected at the store layer (COORD-10): a chat
    // pubkey is never rebound to a different account.
    const bProof = attest("add", CHATKEY, { account: b, deviceSk: DEVICE_SK });
    expect(await admin.handleAttestation(COORD, b, bProof, CREATED_AT)).toBe(false);
    const row = store.getChatKey(COORD, CHATKEY)!;
    expect(row.account_pubkey).toBe(ACCOUNT); // binding unchanged
    // And B can't revoke what they never owned either.
    expect(await admin.handleAttestation(COORD, b, attest("revoke"), CREATED_AT)).toBe(false);
  });
});

describe("MarmotAdmin — 21607 v2 proof of possession & device cap (NIP §10)", () => {
  it("rejects an add with no proof of possession", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp2")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    // deviceSk:null → no proof attached at all.
    const ok = await admin.handleAttestation(COORD, ACCOUNT, attest("add", CHATKEY, { deviceSk: null }), CREATED_AT);
    expect(ok).toBe(false);
    expect(store.getChatKey(COORD, CHATKEY)).toBeUndefined();
    expect(mls.invited).toEqual([]);
  });

  it("rejects an add whose proof was signed by the WRONG key", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp2")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    // The attested chat_pubkey is CHATKEY, but the proof is signed by DEVICE_SK2
    // (whose pubkey is CHATKEY2) — the coordinator can't verify possession.
    const forged = attest("add", CHATKEY, { deviceSk: DEVICE_SK2 });
    const ok = await admin.handleAttestation(COORD, ACCOUNT, forged, CREATED_AT);
    expect(ok).toBe(false);
    expect(store.getChatKey(COORD, CHATKEY)).toBeUndefined();
  });

  it("rejects an add whose proof was signed over a DIFFERENT created_at (replay guard)", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp2")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    const content = attest("add"); // proof over CREATED_AT
    // Coordinator uses a different rumor created_at → challenge differs → invalid.
    const ok = await admin.handleAttestation(COORD, ACCOUNT, content, CREATED_AT + 1);
    expect(ok).toBe(false);
    expect(store.getChatKey(COORD, CHATKEY)).toBeUndefined();
  });

  it("enforces the per-account device cap: a 6th distinct key is rejected", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    // Five distinct device keys bind successfully…
    const devices = Array.from({ length: 6 }, () => generateSecretKey());
    for (let i = 0; i < 5; i++) {
      const sk = devices[i]!;
      const pk = getPublicKey(sk);
      const ok = await admin.handleAttestation(
        COORD,
        ACCOUNT,
        attest("add", pk, { deviceSk: sk }),
        CREATED_AT,
      );
      expect(ok).toBe(true);
    }
    // …the sixth is over the cap.
    const sixth = devices[5]!;
    const sixthPk = getPublicKey(sixth);
    const ok = await admin.handleAttestation(
      COORD,
      ACCOUNT,
      attest("add", sixthPk, { deviceSk: sixth }),
      CREATED_AT,
    );
    expect(ok).toBe(false);
    expect(store.getChatKey(COORD, sixthPk)).toBeUndefined();
    // A refresh of an already-active key is NOT counted against the cap.
    const refresh = await admin.handleAttestation(
      COORD,
      ACCOUNT,
      attest("add", getPublicKey(devices[0]!), { deviceSk: devices[0]! }),
      CREATED_AT,
    );
    expect(refresh).toBe(true);
  });

  it("stores the device label from the attestation on the binding", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp2")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    await admin.handleAttestation(
      COORD,
      ACCOUNT,
      attest("add", CHATKEY, { label: "Firefox on Linux" }),
      CREATED_AT,
    );
    expect(store.getChatKey(COORD, CHATKEY)?.label).toBe("Firefox on Linux");
  });
});

describe("MarmotAdmin — watcher fast-path gate (audit COORD-17)", () => {
  it("the cached eligible-author set drops unknown authors and refreshes on invalidation", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });

    // Prime the cache (CHATKEY eligible), then approve a NEW attendee with its own
    // device — without invalidation the stale cache still drops it (fail-closed).
    await admin.handleKeyPackageEvent(COORD, kpEvent(CHATKEY, "kpA"));
    expect(mls.invited).toEqual([CHATKEY]);
    const newcomer = "b".repeat(64);
    store.upsertAttendee({ coordinate: COORD, pubkey: newcomer, status: "approved", now: 2 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: newcomer, chatPubkey: CHATKEY2, now: 2 });
    await admin.handleKeyPackageEvent(COORD, kpEvent(CHATKEY2, "kpB"));
    expect(mls.invited).toEqual([CHATKEY]); // dropped by the stale cache

    // After invalidation (what approve/attest/revoke do), the new author is eligible.
    admin.invalidateEligibility(COORD);
    await admin.handleKeyPackageEvent(COORD, kpEvent(CHATKEY2, "kpB2"));
    expect(mls.invited).toEqual([CHATKEY, CHATKEY2]);
  });

describe("MarmotAdmin — remove on revoke (§4.2) & ingest", () => {
  it("handleRevoke MLS-removes every attested chat key (and defensively the account key)", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp2")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });
    await admin.syncMember(COORD, ACCOUNT);
    // P6: only the attested device is a member — the account key was never added.
    expect(mls.members.get("mls-1")?.size).toBe(1);

    await admin.handleRevoke(COORD, ACCOUNT);
    // Removal still targets the account key defensively plus every attested device.
    expect(mls.removed.at(-1)!.sort()).toEqual([ACCOUNT, CHATKEY].sort());
    expect(mls.members.get("mls-1")?.size).toBe(0);
    expect(store.getChatKey(COORD, CHATKEY)?.status).toBe("revoked");
  });

  it("ingest forwards 445 events to the MLS layer for the event's group", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    const evs = [{ id: "m1", pubkey: "x".repeat(64), kind: 445, tags: [["h", "ng-1"]] }];
    await admin.ingest(COORD, evs);
    expect(mls.ingested).toEqual([evs]);
  });
});
});

describe("MarmotAdmin — second admin: organizer device promotion (§13.2 recovery)", () => {
  it("creates the group with the coordinator as the sole admin when no organizer is approved", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    // No approved organizer yet → the coordinator is the only admin.
    expect(mls.createdWithAdmins).toEqual([COORDINATOR]);
    expect(mls.admins.get("mls-1")).toEqual([COORDINATOR]);
  });

  it("promotes an approved organizer's attested device to co-admin", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")]);
    // ACCOUNT is an approved ORGANIZER, but under P6 the account key is not a chat
    // identity — only its attested device becomes a co-admin.
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, role: "organizer", status: "approved", now: 1 });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    // At creation the organizer has no attested device yet → coordinator sole admin.
    expect(mls.admins.get("mls-1")!.sort()).toEqual([COORDINATOR]);

    // Attesting the organizer's chat device promotes THAT device to admin.
    const ok = await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT);
    expect(ok).toBe(true);
    expect(mls.admins.get("mls-1")!.sort()).toEqual([COORDINATOR, CHATKEY].sort());
  });

  it("does NOT promote a non-organizer attendee's device", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")]);
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 }); // role defaults to attendee
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT);
    // The device is a member but never an admin — the admin set stays coordinator-only.
    expect(mls.members.get("mls-1")?.has(CHATKEY)).toBe(true);
    expect(mls.admins.get("mls-1")).toEqual([COORDINATOR]);
  });

  it("drops a revoked organizer device from the admin set", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")]);
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, role: "organizer", status: "approved", now: 1 });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT);
    expect(mls.admins.get("mls-1")!.sort()).toEqual([COORDINATOR, CHATKEY].sort());

    // Revoking that device removes it from the admin set (its key is no longer active).
    await admin.handleAttestation(COORD, ACCOUNT, attest("revoke"), CREATED_AT);
    expect(mls.admins.get("mls-1")!.sort()).toEqual([COORDINATOR]);
  });

  it("drops a removed organizer entirely from the admin set", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")]);
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, role: "organizer", status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.admins.get("mls-1")!.sort()).toEqual([COORDINATOR, CHATKEY].sort());

    // The revoke effect chain marks the attendee non-approved, then removes them;
    // desiredAdminPubkeys keys off approved organizers, so they drop out.
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, role: "organizer", status: "revoked", now: 2 });
    await admin.handleRevoke(COORD, ACCOUNT);
    expect(mls.admins.get("mls-1")).toEqual([COORDINATOR]);
  });

  it("re-asserts the admin set on ensureGroup for an existing group (recovery re-sync)", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    expect(mls.admins.get("mls-1")).toEqual([COORDINATOR]);

    // An organizer (with an attested device) is approved AFTER the group already
    // existed; re-ensuring the group (e.g. next install/config reload) promotes the
    // organizer's DEVICE (P6: never the account key).
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, role: "organizer", status: "approved", now: 3 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 3 });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    expect(mls.admins.get("mls-1")!.sort()).toEqual([COORDINATOR, CHATKEY].sort());
  });
});
