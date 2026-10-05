import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { Store } from "../store/db.js";
import { MarmotAdmin, HELD_KEY_PACKAGE_TTL_MS, MAX_HELD_KEY_PACKAGES } from "./admin.js";
import type { ChatMls } from "./mls.js";
import {
  makeChatDeviceProof,
  MAX_CHAT_KEYS_PER_ACCOUNT,
  type ChatKeyAttestationContent,
  type CoordinatorStatusContent,
} from "@nostrautica/protocol";

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

  async createGroup(opts?: { name?: string; adminPubkeys?: string[] }): Promise<{ mlsGroupIdHex: string; nostrGroupIdHex: string }> {
    this.created++;
    this.createdNames.push(opts?.name ?? "");
    this.createdWithAdmins = opts?.adminPubkeys;
    const id = "mls-" + this.created;
    if (opts?.adminPubkeys) this.admins.set(id, opts.adminPubkeys);
    return { mlsGroupIdHex: id, nostrGroupIdHex: "ng-" + this.created };
  }
  /** Reasons the library would give for a refusal; drives the ineligible log line. */
  ineligibleReasons: string[] = [];
  /** Key-package event ids that are pre-0x8009 (legacy proof) — see keyPackageProfile. */
  legacyKps = new Set<string>();
  async isEligible(): Promise<boolean> {
    return this.eligible;
  }
  /**
   * Membership-aware, because the REAL library is
   * (`packages/vendor/marmot-ts/lib/core/key-package-eligibility.js`): it pushes
   * "already a member" onto `reasons` whenever the credential pubkey is in the
   * group, and returns `eligible: reasons.length === 0`. So a member is ALWAYS
   * ineligible.
   *
   * This double used to return a fixed `this.eligible` with no membership
   * awareness — modelling a library that cannot exist — which is exactly why the
   * re-enrolment repair could be unreachable in production while its trajectory
   * test passed. Any future change to the add path is now tested against the
   * shape the real library actually has.
   */
  async evaluateKeyPackage(
    group: string,
    kp: AnyEvent,
  ): Promise<{ eligible: boolean; reasons: string[]; alreadyMember: boolean; legacy?: boolean }> {
    if (this.legacyKps.has(kp.id)) {
      return { eligible: false, reasons: ["not a current (0x8009) KeyPackage: legacy-extension-present"], alreadyMember: false, legacy: true };
    }
    const alreadyMember = this.members.get(group)?.has(kp.pubkey) ?? false;
    const reasons = [
      ...(alreadyMember ? ["already a member"] : []),
      ...(this.eligible ? [] : this.ineligibleReasons),
    ];
    return { eligible: reasons.length === 0, reasons, alreadyMember };
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
  avatars = new Map<string, string>();
  avatarCommits: { group: string; url: string }[] = [];
  async getAvatar(group: string): Promise<string> {
    return this.avatars.get(group) ?? "";
  }
  async setAvatar(group: string, url: string): Promise<boolean> {
    if ((this.avatars.get(group) ?? "") === url) return false;
    this.avatars.set(group, url);
    this.avatarCommits.push({ group, url });
    return true;
  }
  async getAdmins(group: string): Promise<string[]> {
    return this.admins.get(group) ?? [];
  }
  async setAdmins(group: string, adminPubkeys: string[]): Promise<void> {
    this.admins.set(group, [...adminPubkeys]);
  }
  /** Every sendText, in order: the link-confirmation code message lands here. */
  sent: { group: string; content: string }[] = [];
  destroyed: string[] = [];
  createdNames: string[] = [];
  async sendText(group: string, content: string): Promise<void> {
    this.sent.push({ group, content });
  }
  async destroyGroup(group: string): Promise<void> {
    this.destroyed.push(group);
    this.members.delete(group);
  }
}

function kpEvent(pubkey: string, id: string): AnyEvent {
  return { id, pubkey, kind: 30443, tags: [] };
}

/** The coordinator's own pubkey — always retained in the MLS admin set. */
const COORDINATOR = "c".repeat(64);

/** Build an admin whose key-package fetch returns the pre-seeded events per author. */
function makeAdmin(
  store: Store,
  mls: FakeMls,
  kps: AnyEvent[] = [],
  log?: (m: string) => void,
  extra?: {
    enqueueSync?: (coordinate: string, pubkey: string, reenrolling?: string) => void;
    withMemberLock?: (coordinate: string, pubkey: string, fn: () => Promise<void>) => Promise<void>;
    fetchKeyPackages?: (coordinate: string, authors: string[]) => Promise<AnyEvent[]>;
    onRosterChanged?: (coordinate: string) => void;
    notifyAttendee?: (
      coordinate: string,
      accountPubkey: string,
      content: CoordinatorStatusContent,
    ) => void;
    /** Mutable clock, for the held-key-package TTL. Defaults to the fixed CREATED_AT
     *  the proof challenges are signed against. */
    now?: () => number;
  },
) {
  const now = extra?.now ?? (() => 1000);
  return new MarmotAdmin({
    store,
    mls,
    now,
    log,
    coordinatorPubkey: COORDINATOR,
    enqueueSync: extra?.enqueueSync,
    withMemberLock: extra?.withMemberLock,
    onRosterChanged: extra?.onRosterChanged,
    notifyAttendee: extra?.notifyAttendee,
    fetchKeyPackages:
      extra?.fetchKeyPackages ??
      (async (_coordinate, authors) => kps.filter((e) => authors.includes(e.pubkey))),
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

  // The stuck state this reconcile exists for: the device is a listed, active chat
  // key of an approved attendee (so the roster shows it and the app's device list
  // renders it), its key package was consumed — yet it holds no leaf, so it can
  // neither read nor send. Before this, the consumption check returned first and
  // the member was stuck until the row aged out (30 days): their client keeps
  // re-advertising the SAME addressable 30443, so the event id never changes.
  it("re-adds an attested device whose key package was consumed but which holds no leaf", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });

    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.invited).toEqual([CHATKEY]);

    // The leaf goes away without the key package id changing — a lost Welcome the
    // client never joined, a removal, or a restored/rolled-back group state.
    mls.members.get("mls-1")!.delete(CHATKEY);

    // Any deliberate sync of this member (approval, a fresh attestation, the
    // startup backfill) now reconsiders it instead of skipping on the consumed id.
    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.invited).toEqual([CHATKEY, CHATKEY]);
    expect(await mls.isMember("mls-1", CHATKEY)).toBe(true);

    // ...and once they ARE back in, a further sync is inert again.
    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.invited).toEqual([CHATKEY, CHATKEY]);
  });

  // prod 2026-07-30, the second half of the same incident: the member's client
  // could not send and re-attested (it only does that while it holds no membership
  // of its own), but our leaf for it was still in the group — the two states had
  // diverged. The "already a member" short-circuit consumed the fresh key package
  // and returned silently, leaving them stuck with nothing in the log.
  it("re-enrols a member whose fresh key package says its own state disagrees with ours", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });
    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.invited).toEqual([CHATKEY]);

    // Their client rotated its key package and re-attested; our leaf for them
    // never went away. The stale leaf is removed, then the new one is added.
    // Driven through handleAttestation, not syncMember: the device's own
    // attestation for this event is what authorizes dropping a live leaf, so
    // the test has to go through the path that carries that signal.
    const admin2 = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp2")]);
    expect(await admin2.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(true);

    expect(mls.removed).toEqual([[CHATKEY]]);
    expect(mls.invited).toEqual([CHATKEY, CHATKEY]);
    expect(await mls.isMember("mls-1", CHATKEY)).toBe(true);
    expect(store.isKpConsumed(COORD, "kp2")).toBe(true);
  });

  // The two halves of the re-enrolment handshake race each other on the wire: the
  // client publishes its rotated key package, THEN attests. The watcher therefore
  // sees the key package first, and must leave it unspent for the attestation.
  it("the watcher leaves a member's fresh key package unconsumed, so the attestation can still use it", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });
    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.invited).toEqual([CHATKEY]);

    // Their rotated key package lands on the relay first — the watcher sees a
    // member and does nothing, WITHOUT burning the event id.
    await admin.handleKeyPackageEvent(COORD, kpEvent(CHATKEY, "kp-rotated"));
    expect(store.isKpConsumed(COORD, "kp-rotated")).toBe(false);
    expect(mls.invited).toEqual([CHATKEY]);

    // The attestation follows a second later and the re-enrolment goes through.
    const admin2 = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp-rotated")]);
    expect(await admin2.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(true);
    expect(mls.removed).toEqual([[CHATKEY]]);
    expect(mls.invited).toEqual([CHATKEY, CHATKEY]);
  });

  it("does NOT re-enrol a member off the passive watcher (a rotation for another event)", async () => {
    // One key-package slot serves every event, so a rotation driven by ANOTHER
    // event's enrolment shows up here as a fresh 30443 from a healthy member. That
    // must not churn this group's epoch — only the deliberate sync paths re-enrol.
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });
    await admin.syncMember(COORD, ACCOUNT);

    await admin.handleKeyPackageEvent(COORD, kpEvent(CHATKEY, "kp-rotated-elsewhere"));

    expect(mls.removed).toEqual([]);
    expect(mls.invited).toEqual([CHATKEY]);
  });

  // The same cross-event rotation reaching the DELIBERATE sync paths. `reconcile`
  // is true for all of them, so guarding only the passive watcher left the hole
  // wide open on the two triggers that carry no word from the device at all:
  // the startup backfill (which runs on every coordinator restart, i.e. every
  // deploy) and a sibling device's attestation (syncMember fetches key packages
  // for every device of the account). Evicting a healthy member here is not a
  // recoverable hiccup: an offline client loses every message sent before its
  // next open, and MLS forward secrecy means they are gone for good.
  it("does NOT re-enrol a healthy member on backfill when its key package was rotated for another event", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });
    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.invited).toEqual([CHATKEY]);

    // The device rejoined some OTHER event, rotating the one shared 30443 slot.
    // Nothing about this event changed; the member is healthy and still in.
    const afterRestart = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp-rotated-elsewhere")]);
    await afterRestart.backfillApproved(COORD);

    expect(mls.removed).toEqual([]);
    expect(mls.invited).toEqual([CHATKEY]);
    expect(await mls.isMember("mls-1", CHATKEY)).toBe(true);
  });

  it("does NOT re-enrol a healthy device when a SIBLING device of the same account attests", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });
    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.invited).toEqual([CHATKEY]);

    // Device 1 rotated its key package for another event; device 2 now attests
    // here for the first time. syncMember fetches key packages for BOTH devices,
    // so device 1's fresh 30443 rides along on a sync it never asked for.
    const withBoth = makeAdmin(store, mls, [
      kpEvent(CHATKEY, "kp-rotated-elsewhere"),
      kpEvent(CHATKEY2, "kp2-first"),
    ]);
    expect(
      await withBoth.handleAttestation(
        COORD,
        ACCOUNT,
        attest("add", CHATKEY2, { deviceSk: DEVICE_SK2 }),
        CREATED_AT,
      ),
    ).toBe(true);

    // Device 2 joins; device 1 keeps its leaf untouched.
    expect(mls.removed).toEqual([]);
    expect(mls.invited).toEqual([CHATKEY, CHATKEY2]);
    expect(await mls.isMember("mls-1", CHATKEY)).toBe(true);
  });

  it("the passive 30443 watcher still skips a consumed key package (no Add per relay replay)", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });

    await admin.syncMember(COORD, ACCOUNT);
    mls.members.get("mls-1")!.delete(CHATKEY);

    // A relay replaying the same (already consumed) key package must NOT drive a
    // fresh Add commit — the reconcile is for the deliberate sync paths only.
    await admin.handleKeyPackageEvent(COORD, kpEvent(CHATKEY, "kp1"));
    expect(mls.invited).toEqual([CHATKEY]);

    // A genuinely new key package (the client rotated it — what the app's rejoin
    // does) is still added through the watcher as usual.
    await admin.handleKeyPackageEvent(COORD, kpEvent(CHATKEY, "kp2"));
    expect(mls.invited).toEqual([CHATKEY, CHATKEY]);
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

  // prod 2026-08-04: with the group-state write finally succeeding, refused
  // devices started logging a bare "ineligible" — one line with no way to tell
  // "already a member" from a ciphersuite mismatch. The library computes the
  // reasons; the old boolean threw them away at the door.
  it("says WHY a key package is ineligible instead of just that it is", async () => {
    const logs: string[] = [];
    const store = freshStore();
    const mls = new FakeMls();
    mls.eligible = false;
    mls.ineligibleReasons = ["already a member", "cipher suite 0x0002 ≠ group 0x0001"];
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp-refused")], (m) => logs.push(m));
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });

    await admin.backfillApproved(COORD);

    const line = logs.find((l) => l.includes("ineligible"));
    expect(line).toBeDefined();
    expect(line).toContain("already a member");
    expect(line).toContain("cipher suite 0x0002 ≠ group 0x0001");
    expect(mls.invited).toEqual([]);
  });

  /**
   * The mirror image of the re-enrolment repair (2026-09-04 audit): a key package
   * refused for a REAL reason must still be refused and still be consumed, so we
   * do not re-evaluate it on every relay replay. Only the "already a member"-only
   * refusal is special, because that is the condition the repair exists to fix.
   */
  it("a genuinely ineligible key package is still refused and still consumed", async () => {
    const logs: string[] = [];
    const store = freshStore();
    const mls = new FakeMls();
    mls.eligible = false;
    mls.ineligibleReasons = ["cipher suite 0x0002 ≠ group 0x0001"];
    const kp = kpEvent(CHATKEY, "kp-badsuite");
    const admin = makeAdmin(store, mls, [kp], (m) => logs.push(m));
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });

    await admin.backfillApproved(COORD);

    expect(mls.invited).toEqual([]);
    expect(store.isKpConsumed(COORD, kp.id)).toBe(true);
    expect(logs.find((l) => l.includes("ineligible"))).toContain("cipher suite");
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

  it("enforces the per-account device cap: the key past MAX_CHAT_KEYS_PER_ACCOUNT is rejected", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    // Bind exactly the cap, then one more. Driven off the constant rather than a
    // literal 5: this test asserted "a 6th is rejected" and started failing the
    // moment the cap was raised to 10, which is the constant's job to decide.
    const cap = MAX_CHAT_KEYS_PER_ACCOUNT;
    const devices = Array.from({ length: cap + 1 }, () => generateSecretKey());
    for (let i = 0; i < cap; i++) {
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
    // …the one past the cap is refused.
    const overCap = devices[cap]!;
    const overCapPk = getPublicKey(overCap);
    const ok = await admin.handleAttestation(
      COORD,
      ACCOUNT,
      attest("add", overCapPk, { deviceSk: overCap }),
      CREATED_AT,
    );
    expect(ok).toBe(false);
    expect(store.getChatKey(COORD, overCapPk)).toBeUndefined();
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

/**
 * Audit B-5. `tryAddKeyPackage` catches its own `mls.invite` failure on purpose —
 * one undecodable key package from a newer peer client must not abort a startup
 * backfill that every other event's chat depends on (prod 2026-07-20). But it then
 * returned normally, which told every caller the member was synced. The attestation
 * path only queued its durable `chat_sync_member` on a THROW, so a transient relay
 * or marmot failure left the member on "Setting up…" with the attestation rumor
 * marked seen and nothing anywhere re-driving it. The no-crash property had
 * silently become "and no retry either".
 */
describe("MarmotAdmin — a failed Add asks for a durable retry (audit B-5)", () => {
  const kpFor = (pubkey: string, id: string) => kpEvent(pubkey, id);

  it("syncMember reports false when the invite fails, without throwing", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    mls.throwOnInvite.add(CHATKEY);
    const admin = makeAdmin(store, mls, [kpFor(CHATKEY, "kp1")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });

    await expect(admin.syncMember(COORD, ACCOUNT)).resolves.toBe(false);
    expect(mls.members.get("mls-1")?.size ?? 0).toBe(0); // nobody added
  });

  it("an attestation whose inline sync fails queues the durable retry, carrying reenrolling", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    mls.throwOnInvite.add(CHATKEY);
    const retries: { coordinate: string; pubkey: string; reenrolling?: string }[] = [];
    const admin = makeAdmin(store, mls, [kpFor(CHATKEY, "kp1")], undefined, {
      enqueueSync: (coordinate, pubkey, reenrolling) => retries.push({ coordinate, pubkey, reenrolling }),
    });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });

    expect(await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(true);
    expect(retries).toEqual([{ coordinate: COORD, pubkey: ACCOUNT, reenrolling: CHATKEY }]);
  });

  it("a successful sync queues nothing", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const retries: string[] = [];
    const admin = makeAdmin(store, mls, [kpFor(CHATKEY, "kp1")], undefined, {
      enqueueSync: (_c, pubkey) => retries.push(pubkey),
    });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });

    expect(await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(true);
    expect(retries).toEqual([]);
    expect(mls.members.get("mls-1")?.has(CHATKEY)).toBe(true);
  });

  it("a device REFUSED as ineligible is not retried (it is reported instead)", async () => {
    // The boolean has to distinguish "failed, try again" from "refused, told the
    // owner" — a permanent refusal retried forever is a spin, not a repair.
    const store = freshStore();
    const mls = new FakeMls();
    mls.eligible = false;
    mls.ineligibleReasons = ["cipher suite 0x0002 ≠ group 0x0001"];
    const retries: string[] = [];
    const refusals: string[] = [];
    const admin = makeAdmin(store, mls, [kpFor(CHATKEY, "kp1")], undefined, {
      enqueueSync: (_c, pubkey) => retries.push(pubkey),
      notifyAttendee: (_c, _pk, content) => refusals.push(content.error_category ?? ""),
    });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });

    expect(await admin.syncMember(COORD, ACCOUNT)).toBe(true); // nothing to retry
    expect(retries).toEqual([]);
    expect(refusals).toContain("chat_key_package_ineligible");
  });

  it("a PRE-0x8009 key package is skipped quietly — consumed, not reported, not retried", async () => {
    // After the marmot-ts upgrade every device still advertises its old 0xF2F1
    // KeyPackage until it next runs current code. That is not a refusal to report:
    // the owner did nothing wrong and the device fixes it by itself.
    const store = freshStore();
    const mls = new FakeMls();
    const kp = kpFor(CHATKEY, "kp-legacy");
    mls.legacyKps.add(kp.id);
    const retries: string[] = [];
    const refusals: string[] = [];
    const admin = makeAdmin(store, mls, [kp], undefined, {
      enqueueSync: (_c, pubkey) => retries.push(pubkey),
      notifyAttendee: (_c, _pk, content) => refusals.push(content.error_category ?? ""),
    });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });

    expect(await admin.syncMember(COORD, ACCOUNT)).toBe(true);
    expect(retries).toEqual([]);
    expect(refusals).toEqual([]);
    expect(store.isKpConsumed(COORD, kp.id)).toBe(true);
    expect(await mls.isMember(store.getMarmotGroup(COORD)!.mls_group_id, CHATKEY)).toBe(false);
  });

  it("the startup backfill queues a retry for a member it could not add", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    mls.throwOnInvite.add(CHATKEY);
    const retries: string[] = [];
    const admin = makeAdmin(store, mls, [kpFor(CHATKEY, "kp1")], undefined, {
      enqueueSync: (_c, pubkey) => retries.push(pubkey),
    });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });

    await admin.backfillApproved(COORD);
    expect(retries).toEqual([ACCOUNT]);
  });
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

  /**
   * Audit B-9. `delete_data: true` is the DEFAULT on an attendee withdrawal, and
   * the withdrawal handler purges the attendee's artifacts — `marmot_chat_keys`
   * included — in the same per-member lock that enqueues `chat_revoke_member`.
   * The job then ran minutes later against a store that no longer knew which
   * leaves belonged to the leaver, so it removed the ACCOUNT key only and the
   * leaver's DEVICE kept its leaf: it could still decrypt everything the group
   * said until some unrelated add/remove happened to churn the epoch. The MLS
   * Remove is the one genuinely post-compromise part of a revoke, so it cannot
   * depend on rows the same operation deletes.
   */
  it("removes a leaf whose binding was already purged, from the captured device list", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp2")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });
    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.members.get("mls-1")?.size).toBe(1);

    // What a delete_data withdrawal does before the queued job ever runs.
    store.purgeAttendeeArtifacts(COORD, ACCOUNT);
    expect(store.chatKeysForAccount(COORD, ACCOUNT)).toEqual([]);

    await admin.handleRevoke(COORD, ACCOUNT, { chatPubkeys: [CHATKEY] });
    expect(mls.removed.at(-1)!.sort()).toEqual([ACCOUNT, CHATKEY].sort());
    expect(mls.members.get("mls-1")?.size).toBe(0); // the device leaf is really gone
  });

  it("a legacy payload with no captured device list still removes the stored keys", async () => {
    // Rows enqueued before the payload carried `chatPubkeys` must keep working: the
    // union means "whatever is still stored" is the whole list in that case.
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp2")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });
    await admin.syncMember(COORD, ACCOUNT);

    await admin.handleRevoke(COORD, ACCOUNT, { chatPubkeys: undefined });
    expect(mls.removed.at(-1)!.sort()).toEqual([ACCOUNT, CHATKEY].sort());
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

/**
 * Attestation-path durability (MLS-R4, 2026-09-04).
 *
 * The approval path has durable `chat_sync_member` retries; the attestation path
 * called `syncMember` inline and only logged a failure. Since the rumor is marked
 * seen either way, a transient relay failure stranded the member in "setting up"
 * until a restart or another manual Rejoin.
 *
 * A key-package fetch that throws is the realistic trigger — an invite failure is
 * already caught per key package inside `syncMember`, deliberately, so one bad
 * peer cannot take down the loop.
 */
describe("the startup backfill takes the same per-member lock the live paths do", () => {
  // CHAT-N-5. `backfillApproved` walked a roster SNAPSHOT calling `syncMember` and
  // took no lock, while every live path (approve, revoke, attestation) serializes
  // on `member:<pubkey>`. An attestation or a revoke arriving for the same member
  // mid-walk could therefore interleave with the backfill's add, so the two
  // orderings could land in either sequence — a revoked device left in the group,
  // or a legitimate rejoin undone. The window widened once install started
  // subscribing to the event inbox BEFORE ensureChat, which is the right delivery
  // order and means live traffic really can arrive during a backfill.
  it("wraps every member's sync in withMemberLock", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const locked: string[] = [];
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")], undefined, {
      withMemberLock: async (_c: string, pubkey: string, fn: () => Promise<void>) => {
        locked.push(pubkey);
        await fn();
      },
    });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });

    await admin.backfillApproved(COORD);
    expect(locked).toEqual([ACCOUNT]);
    expect(mls.invited).toEqual([CHATKEY]); // and the sync still happened
  });
});

describe("a failed attestation sync is retried, not just logged", () => {
  it("queues durable work when the inline sync throws", async () => {
    const logs: string[] = [];
    const queued: Array<{ coordinate: string; pubkey: string; reenrolling?: string }> = [];
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [], (m) => logs.push(m), {
      enqueueSync: (coordinate, pubkey, reenrolling) => queued.push({ coordinate, pubkey, reenrolling }),
      fetchKeyPackages: async () => {
        throw new Error("simulated relay outage");
      },
    });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });

    const ok = await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT);

    // The attestation itself is still accepted and the binding recorded — only the
    // group add is deferred.
    expect(ok).toBe(true);
    // `reenrolling` must ride along. Without it the retry is a PLAIN add, and the
    // eligibility gate refuses it because the stale leaf is still there ("already a
    // member" / "likely rotated for another event") — which is exactly the state
    // this attestation exists to repair. The user pressed Rejoin, saw "requested",
    // and stayed out; the inline attempt's transient failure had quietly turned the
    // durable retry into a no-op.
    expect(queued).toEqual([{ coordinate: COORD, pubkey: ACCOUNT, reenrolling: CHATKEY }]);
    expect(logs.some((l) => l.includes("queued for durable retry"))).toBe(true);
  });

  it("the queued retry actually REPAIRS the member — a plain add would be refused", async () => {
    // The behavioural half of the finding. `tryAddKeyPackage` refuses to drop a
    // leaf it still holds unless `reenrolling` names that very device, so a retry
    // that lost the flag is a no-op dressed as work: the user pressed Rejoin, the
    // inline attempt failed transiently, the durable retry ran, and they were still
    // out with nothing further queued.
    const store = freshStore();
    const mls = new FakeMls();
    const queued: Array<{ pubkey: string; reenrolling?: string }> = [];
    let failFetch = true;
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")], undefined, {
      enqueueSync: (_c, pubkey, reenrolling) => queued.push({ pubkey, reenrolling }),
    });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });
    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.invited).toEqual([CHATKEY]);

    // Rejoin: the device rotated its key package and attested — but the relay is
    // down for the inline sync, so it is queued.
    const admin2 = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp2")], undefined, {
      enqueueSync: (_c, pubkey, reenrolling) => queued.push({ pubkey, reenrolling }),
      fetchKeyPackages: async () => {
        if (failFetch) throw new Error("simulated relay outage");
        return [kpEvent(CHATKEY, "kp2")];
      },
    });
    expect(await admin2.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(true);
    expect(queued).toHaveLength(1);
    expect(mls.removed).toEqual([]); // nothing repaired yet

    // The job runner comes back with what it was given.
    failFetch = false;
    await admin2.syncMember(COORD, ACCOUNT, { reenrolling: queued[0]!.reenrolling });
    expect(mls.removed).toEqual([[CHATKEY]]);
    expect(mls.invited).toEqual([CHATKEY, CHATKEY]);
  });

  it("says so plainly when there is no queue to fall back on", async () => {
    const logs: string[] = [];
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [], (m) => logs.push(m), {
      fetchKeyPackages: async () => {
        throw new Error("simulated relay outage");
      },
    });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });

    expect(await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(true);
    expect(logs.some((l) => l.includes("no retry queue"))).toBe(true);
  });
});

/**
 * The 31604 roster is the ONLY channel a client can read the device list from:
 * `ChatHandoffCard` renders `devicesForAccount(roster)` and re-fetches ~4s after
 * every action. Nothing on the attestation or chat-revoke paths published one, so
 * every device-management action visibly undid itself in front of the user — a
 * revoked device reappeared, a rename reverted, a newly-added device stayed a raw
 * pubkey — until an UNRELATED approval happened to republish. The app even carried
 * a comment claiming the coordinator republished here. It did not.
 */
describe("MarmotAdmin — roster republish on every chat_keys change", () => {
  function setup(extra: Parameters<typeof makeAdmin>[4] = {}) {
    const published: string[] = [];
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")], undefined, {
      ...extra,
      onRosterChanged: (c) => published.push(c),
    });
    return { published, store, mls, admin };
  }

  it("republishes when the group is CREATED — a replacement group is invisible until then", async () => {
    const { published, admin } = setup();
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    expect(published).toEqual([COORD]);
    // Re-ensuring an existing group is not a change.
    published.length = 0;
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    expect(published).toEqual([]);
  });

  it("republishes when a device binds (op:add)", async () => {
    const { published, store, admin } = setup();
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    published.length = 0; // creating the group republishes too (its own test below)
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });

    expect(await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(true);

    expect(published).toEqual([COORD]);
  });

  it("republishes for a still-PENDING attendee too — the roster is how the device list renders", async () => {
    const { published, store, admin } = setup();
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    published.length = 0; // creating the group republishes too (its own test below)
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "pending", now: 1 });

    expect(await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(true);

    expect(published).toEqual([COORD]);
  });

  it("republishes when a device is revoked (op:revoke)", async () => {
    const { published, store, admin } = setup();
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    published.length = 0; // creating the group republishes too (its own test below)
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT);
    published.length = 0;

    expect(await admin.handleAttestation(COORD, ACCOUNT, attest("revoke"), CREATED_AT)).toBe(true);

    expect(published).toEqual([COORD]);
  });

  it("republishes when an attendee is removed from the chat entirely", async () => {
    const { published, store, admin } = setup();
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    published.length = 0; // creating the group republishes too (its own test below)
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT);
    published.length = 0;

    await admin.handleRevoke(COORD, ACCOUNT);

    expect(published).toEqual([COORD]);
  });

  it("does NOT republish for a rejected attestation — nothing changed", async () => {
    const { published, store, admin } = setup();
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    published.length = 0; // creating the group republishes too (its own test below)
    // A stranger: no attendee row at all.
    expect(await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(false);
    expect(published).toEqual([]);

    // And an enrolled attendee whose proof doesn't verify.
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    expect(
      await admin.handleAttestation(COORD, ACCOUNT, attest("add", CHATKEY, { deviceSk: null }), CREATED_AT),
    ).toBe(false);
    expect(published).toEqual([]);
  });
});

/**
 * A refused attestation used to be a log line and nothing else. The device had
 * published a key package, sent its 21607, and then sat in "setting up your secure
 * chat" forever — while the app's only hint said the coordinator might be offline,
 * which for a device-cap or rebind refusal points at exactly the wrong thing. The
 * reasons were already computed; they are now sealed to the attendee over the same
 * 21606 channel a failed talk/submission already uses.
 */
describe("MarmotAdmin — telling the attendee WHY their device was refused", () => {
  function setup() {
    const notices: { account: string; content: CoordinatorStatusContent }[] = [];
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp1")], undefined, {
      notifyAttendee: (_c, account, content) => notices.push({ account, content }),
    });
    return { notices, store, mls, admin };
  }

  it("names the device cap, addressed to the attendee, not retryable", async () => {
    const { notices, store, admin } = setup();
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    // Fill the cap with keys that are not CHATKEY/CHATKEY2.
    for (let i = 0; i < MAX_CHAT_KEYS_PER_ACCOUNT; i++) {
      store.upsertChatKey({
        coordinate: COORD,
        accountPubkey: ACCOUNT,
        chatPubkey: `${i}`.repeat(64),
        status: "active",
        now: 1,
      });
    }

    expect(await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(false);

    expect(notices).toHaveLength(1);
    expect(notices[0]!.account).toBe(ACCOUNT);
    expect(notices[0]!.content.error_category).toBe("chat_device_cap_reached");
    expect(notices[0]!.content.stage).toBe("chat_attestation");
    expect(notices[0]!.content.pubkey).toBe(ACCOUNT);
    // Waiting cannot clear a cap hit; saying "retryable" would keep them staring
    // at the spinner instead of removing a device.
    expect(notices[0]!.content.retryable).toBe(false);
  });

  it("names a chat key already bound to a different account", async () => {
    const { notices, store, admin } = setup();
    const other = "b".repeat(64);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: other, status: "approved", now: 1 });
    store.upsertChatKey({
      coordinate: COORD,
      accountPubkey: other,
      chatPubkey: CHATKEY,
      status: "active",
      now: 1,
    });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });

    expect(await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(false);

    expect(notices.map((n) => n.content.error_category)).toEqual(["chat_key_bound_to_other_account"]);
  });

  it("names a proof of possession that does not verify", async () => {
    const { notices, store, admin } = setup();
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });

    expect(
      await admin.handleAttestation(COORD, ACCOUNT, attest("add", CHATKEY, { deviceSk: null }), CREATED_AT),
    ).toBe(false);

    expect(notices.map((n) => n.content.error_category)).toEqual(["chat_proof_invalid"]);
  });

  it("names an unusable key package — the most invisible refusal of the lot", async () => {
    // The attestation SUCCEEDS (the device is bound, listed in the roster, and the
    // UI shows it), and then the add fails and the key package is marked consumed
    // so no later pass reconsiders it. Nothing else in the system says a word.
    const { notices, store, mls, admin } = setup();
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    mls.eligible = false;
    mls.ineligibleReasons = ["unsupported ciphersuite"];

    expect(await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(true);

    expect(notices.map((n) => n.content.error_category)).toEqual(["chat_key_package_ineligible"]);
    expect(notices[0]!.account).toBe(ACCOUNT);
  });

  it("says nothing to a stranger — an unenrolled sender must not make us publish", async () => {
    // Otherwise anyone who can reach the inbox can drive gift-wrap publishes.
    const { notices, admin } = setup();
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });

    expect(await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(false);

    expect(notices).toEqual([]);
  });

  it("says nothing when the attestation is accepted", async () => {
    const { notices, store, admin } = setup();
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });

    expect(await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(true);

    expect(notices).toEqual([]);
  });
});

/**
 * A kind-30443 and its kind-21607 attestation are published by the same client at
 * the same moment and nothing orders them on the wire. When the key package won
 * the race, the coordinator had no binding for its author yet and DISCARDED it —
 * "ignored 30443 …: not an authorized chat identity" — leaving the attestation a
 * second later to re-find it on a relay. When the relay had not settled, the
 * member sat on "Setting up your secure chat…" with both sides silent.
 */
describe("a key package that arrives before its attestation is held, not dropped", () => {
  it("adds the device when the attestation lands, even though the relay read finds nothing", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    // The relay read returns NOTHING — the exact case that made this unrecoverable:
    // the only copy of the key package we will ever see is the one the watcher
    // already had in its hand.
    const admin = makeAdmin(store, mls, [], undefined, { fetchKeyPackages: async () => [] });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });

    // 30443 first, from an author nothing has authorized yet.
    await admin.handleKeyPackageEvent(COORD, kpEvent(CHATKEY, "kp-early"));
    expect(mls.invited).toEqual([]);
    expect(admin.heldKeyPackageCount()).toBe(1);

    // …then its 21607, with a real §10.2 possession proof.
    expect(await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(true);

    expect(mls.invited).toEqual([CHATKEY]);
    expect(admin.heldKeyPackageCount()).toBe(0); // consumed, not leaked
  });

  it("still refuses a held key package whose attestation carries no valid proof", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [], undefined, { fetchKeyPackages: async () => [] });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });

    await admin.handleKeyPackageEvent(COORD, kpEvent(CHATKEY, "kp-early"));
    // A 21607 for CHATKEY signed by a DIFFERENT device key: the proof of possession
    // fails, which is the v1 mis-binding/griefing gap. Holding the key package must
    // not become a way past it.
    const forged = attest("add", CHATKEY, { deviceSk: DEVICE_SK2 });
    expect(await admin.handleAttestation(COORD, ACCOUNT, forged, CREATED_AT)).toBe(false);

    expect(mls.invited).toEqual([]);
  });

  it("forgets a held key package once its TTL passes — an attestation that never comes leaks nothing", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const clock = { t: CREATED_AT };
    const admin = makeAdmin(store, mls, [], undefined, {
      fetchKeyPackages: async () => [],
      now: () => clock.t,
    });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });

    await admin.handleKeyPackageEvent(COORD, kpEvent(CHATKEY, "kp-early"));
    expect(admin.heldKeyPackageCount()).toBe(1);

    clock.t += HELD_KEY_PACKAGE_TTL_MS + 1;
    expect(admin.heldKeyPackageCount()).toBe(0);
    // …and the stale copy is genuinely gone, not merely uncounted.
    expect(await admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT)).toBe(true);
    expect(mls.invited).toEqual([]);
  });

  it("bounds the hold: a flood of unauthorized key packages cannot grow without limit", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [], undefined, { fetchKeyPackages: async () => [] });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });

    for (let i = 0; i < MAX_HELD_KEY_PACKAGES + 50; i++) {
      const author = getPublicKey(generateSecretKey());
      await admin.handleKeyPackageEvent(COORD, kpEvent(author, `flood-${i}`));
    }
    expect(admin.heldKeyPackageCount()).toBe(MAX_HELD_KEY_PACKAGES);

    // One author republishing replaces its own entry rather than adding a second —
    // and the newest copy is the one kept (inviting with a superseded key package
    // sends a Welcome the device can no longer decrypt).
    const before = admin.heldKeyPackageCount();
    const author = getPublicKey(generateSecretKey());
    await admin.handleKeyPackageEvent(COORD, kpEvent(author, "rot-1"));
    await admin.handleKeyPackageEvent(COORD, kpEvent(author, "rot-2"));
    expect(admin.heldKeyPackageCount()).toBe(before);
  });
});

/**
 * The startup/chat-toggle roster walk used to open ONE relay read per member.
 * Measured on a four-event daemon with twelve members each, that was 48 serialized
 * round trips and 84% of the whole boot — the per-event startup cost
 * docs/DEPLOYMENT.md records, growing with both the event count and the roster
 * size, against a deploy that fails at 240 s.
 */
describe("the chat roster backfill reads key packages once for the whole roster", () => {
  it("issues one fetch covering every member, and still adds each member's own device", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const accounts = Array.from({ length: 12 }, () => getPublicKey(generateSecretKey()));
    const devices = accounts.map(() => getPublicKey(generateSecretKey()));
    const kps = devices.map((d, i) => kpEvent(d, `kp-${i}`));
    const calls: string[][] = [];
    const admin = makeAdmin(store, mls, [], undefined, {
      fetchKeyPackages: async (_c, authors) => {
        calls.push([...authors]);
        return kps.filter((e) => authors.includes(e.pubkey));
      },
    });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    accounts.forEach((a, i) => {
      store.upsertAttendee({ coordinate: COORD, pubkey: a, status: "approved", now: 1 });
      store.upsertChatKey({ coordinate: COORD, accountPubkey: a, chatPubkey: devices[i]!, now: 1 });
    });

    await admin.backfillApproved(COORD);

    expect(calls).toHaveLength(1);
    expect([...calls[0]!].sort()).toEqual([...devices].sort());
    expect([...mls.invited].sort()).toEqual([...devices].sort());
  });

  it("falls back to a per-member read for a device attested after the batch was taken", async () => {
    // The batch is a snapshot; a 21607 landing mid-walk must not leave that member
    // acting on a roster older than the one they were handed.
    const store = freshStore();
    const mls = new FakeMls();
    const early = getPublicKey(generateSecretKey());
    const second = getPublicKey(generateSecretKey());
    const late = getPublicKey(generateSecretKey());
    const kps = [kpEvent(early, "kp-early"), kpEvent(late, "kp-late")];
    const calls: string[][] = [];
    const admin = makeAdmin(store, mls, [], undefined, {
      fetchKeyPackages: async (_c, authors) => {
        calls.push([...authors]);
        return kps.filter((e) => authors.includes(e.pubkey));
      },
      withMemberLock: async (coordinate, pubkey, fn) => {
        // The second member's device is bound only once the walk is under way, so
        // it cannot be in the batch the walk started from.
        if (pubkey === second) {
          store.upsertChatKey({ coordinate, accountPubkey: pubkey, chatPubkey: late, now: 1 });
        }
        await fn();
      },
    });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: early, now: 1 });
    store.upsertAttendee({ coordinate: COORD, pubkey: second, status: "approved", now: 1 });

    await admin.backfillApproved(COORD);

    // The batch read for the roster as it stood, plus one read for the member whose
    // device the batch could not have covered.
    expect(calls).toEqual([[early], [late]]);
    expect([...mls.invited].sort()).toEqual([early, late].sort());
  });
});

// ── External Marmot client link (21607 op:"link"/"link_confirm", NIP §10.5) ──
describe("MarmotAdmin — linking an external Marmot client (White Noise)", () => {
  const W = getPublicKey(generateSecretKey()); // the White Noise npub, ≠ ACCOUNT
  const EVENT_GROUP = "mls-1";

  function kpAt(pubkey: string, id: string, created_at: number): AnyEvent {
    return { ...kpEvent(pubkey, id), created_at } as AnyEvent;
  }
  function linkReq(chatPubkey = W, label = "White Noise"): ChatKeyAttestationContent {
    return { v: 2, a: COORD, op: "link", chat_pubkey: chatPubkey, label };
  }
  function linkConfirm(code: string, chatPubkey = W): ChatKeyAttestationContent {
    return { v: 2, a: COORD, op: "link_confirm", chat_pubkey: chatPubkey, code };
  }
  /** The code the coordinator posted in the confirmation group: the latest message, on its own. */
  function postedCode(mls: FakeMls): string {
    const last = mls.sent[mls.sent.length - 1];
    if (!/^[A-Z0-9]{8}$/.test(last?.content ?? "")) throw new Error("no code posted");
    return last!.content;
  }

  async function setup(opts: { kps?: AnyEvent[]; role?: "attendee" | "organizer" } = {}) {
    const store = freshStore();
    const mls = new FakeMls();
    const clock = { t: 1_000_000 };
    const notices: CoordinatorStatusContent[] = [];
    const queued: string[] = [];
    const rosterChanges: string[] = [];
    const admin = makeAdmin(store, mls, opts.kps ?? [kpAt(W, "kpW1", 10)], undefined, {
      now: () => clock.t,
      notifyAttendee: (_c, _p, content) => notices.push(content),
      enqueueSync: (_c, pubkey) => queued.push(pubkey),
      onRosterChanged: (c) => rosterChanges.push(c),
    });
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: ["wss://chat.example"] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1, ...(opts.role ? { role: opts.role } : {}) });
    const lastCategory = () => notices[notices.length - 1]?.error_category;
    return { store, mls, clock, notices, queued, rosterChanges, admin, lastCategory };
  }

  it("self-link (W = the account key): the seal is the proof — bound and invited at once, no code", async () => {
    const h = await setup({ kps: [kpAt(ACCOUNT, "kpA", 10)] });
    expect(await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(ACCOUNT), CREATED_AT)).toBe(true);
    const row = h.store.getChatKey(COORD, ACCOUNT)!;
    expect(row).toMatchObject({ account_pubkey: ACCOUNT, status: "active", external: 1, label: "White Noise" });
    expect(h.mls.created).toBe(1); // only the event group — no confirmation group
    expect(h.mls.sent).toEqual([]);
    expect(await h.mls.isMember(EVENT_GROUP, ACCOUNT)).toBe(true);
    expect(h.rosterChanges).toContain(COORD);
    expect(h.notices.at(-1)).toMatchObject({ stage: "chat_link", state: "cleared" });
  });

  it("a different key: confirmation group with the code, then link_confirm binds W and adds it to the room", async () => {
    // Two key packages: the confirmation group spends the newest, the event group
    // must use the other one (a Welcome to a spent init key is undecryptable).
    const h = await setup({ kps: [kpAt(W, "kpW-old", 5), kpAt(W, "kpW-new", 10)] });
    expect(await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT)).toBe(true);

    // A 2-member confirmation group, named so White Noise shows what it is for.
    expect(h.mls.created).toBe(2);
    expect(h.mls.createdNames[1]).toBe("Nostrautica: confirm White Noise link");
    expect(h.mls.admins.get("mls-2")).toEqual([COORDINATOR]);
    expect(await h.mls.isMember("mls-2", W)).toBe(true);
    expect(h.mls.sent).toHaveLength(2);
    expect(h.mls.sent.map((m) => m.group)).toEqual(["mls-2", "mls-2"]);
    expect(h.mls.sent[0]!.content).toMatch(/Don't share it/);
    expect(h.mls.sent[1]!.content).toMatch(/^[A-Z0-9]{8}$/);
    // Not bound, not in the room, and the code is not stored in the clear.
    expect(h.store.getChatKey(COORD, W)).toBeUndefined();
    expect(await h.mls.isMember(EVENT_GROUP, W)).toBe(false);
    const code = postedCode(h.mls);
    const link = h.store.getChatLink(COORD, ACCOUNT)!;
    expect(link.status).toBe("pending");
    expect(link.code_hash).not.toContain(code.replace("-", ""));
    expect(link.confirm_kp_id).toBe("kpW-new");

    // Typed sloppily: lower case with a space instead of the dash.
    const typed = code.toLowerCase().replace("-", " ");
    expect(await h.admin.handleAttestation(COORD, ACCOUNT, linkConfirm(typed), CREATED_AT)).toBe(true);
    expect(h.store.getChatKey(COORD, W)).toMatchObject({ account_pubkey: ACCOUNT, status: "active", external: 1 });
    expect(await h.mls.isMember(EVENT_GROUP, W)).toBe(true);
    expect(h.mls.invited.at(-1)).toBe(W);
    // The confirmation group is left behind: W removed, local state destroyed.
    expect(h.mls.removed).toContainEqual([W]);
    expect(h.mls.destroyed).toEqual(["mls-2"]);
    expect(h.store.getChatLink(COORD, ACCOUNT)!.status).toBe("linked");
    expect(h.queued).toEqual([]); // the rotated key package was there: no retry needed
    expect(h.notices.at(-1)).toMatchObject({ stage: "chat_link", state: "cleared" });
  });

  it("holds off on the key package the confirmation group spent, then uses it after the grace", async () => {
    const h = await setup({ kps: [kpAt(W, "kpOnly", 10)] });
    await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT);
    await h.admin.handleAttestation(COORD, ACCOUNT, linkConfirm(postedCode(h.mls)), CREATED_AT);
    // Bound, but not invited with the spent key package — a durable retry is queued.
    expect(h.store.getChatKey(COORD, W)?.status).toBe("active");
    expect(await h.mls.isMember(EVENT_GROUP, W)).toBe(false);
    expect(h.queued).toEqual([ACCOUNT]);
    // Past the grace a last-resort (reusable) key package is used after all.
    h.clock.t += 91_000;
    expect(await h.admin.syncMember(COORD, ACCOUNT)).toBe(true);
    expect(await h.mls.isMember(EVENT_GROUP, W)).toBe(true);
  });

  it("a wrong code counts an attempt; the fifth closes the link for good", async () => {
    const h = await setup();
    await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT);
    const code = postedCode(h.mls);
    for (let i = 1; i <= 4; i++) {
      expect(await h.admin.handleAttestation(COORD, ACCOUNT, linkConfirm("ZZZZ-ZZZZ"), CREATED_AT)).toBe(false);
      expect(h.lastCategory()).toBe("chat_link_code_wrong");
      expect(h.store.getChatLink(COORD, ACCOUNT)!.attempts).toBe(i);
    }
    expect(await h.admin.handleAttestation(COORD, ACCOUNT, linkConfirm("ZZZZ-ZZZZ"), CREATED_AT)).toBe(false);
    expect(h.lastCategory()).toBe("chat_link_too_many_attempts");
    expect(h.mls.destroyed).toEqual(["mls-2"]);
    // The right code is now worthless: the request is gone.
    expect(await h.admin.handleAttestation(COORD, ACCOUNT, linkConfirm(code), CREATED_AT)).toBe(false);
    expect(h.lastCategory()).toBe("chat_link_no_pending");
    expect(h.store.getChatKey(COORD, W)).toBeUndefined();
  });

  it("an expired code is refused and its group torn down", async () => {
    const h = await setup();
    await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT);
    const code = postedCode(h.mls);
    h.clock.t += 30 * 60_000;
    expect(await h.admin.handleAttestation(COORD, ACCOUNT, linkConfirm(code), CREATED_AT)).toBe(false);
    expect(h.lastCategory()).toBe("chat_link_expired");
    expect(h.mls.destroyed).toEqual(["mls-2"]);
    expect(h.store.getChatKey(COORD, W)).toBeUndefined();
  });

  it("the expiry sweep tears down codes nobody confirmed", async () => {
    const h = await setup();
    await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT);
    expect(await h.admin.sweepExpiredLinks()).toBe(0);
    h.clock.t += 30 * 60_000 + 1;
    expect(await h.admin.sweepExpiredLinks()).toBe(1);
    expect(h.mls.destroyed).toEqual(["mls-2"]);
    expect(h.store.getChatLink(COORD, ACCOUNT)!.status).toBe("closed");
  });

  it("a code only confirms the key it was issued for", async () => {
    const h = await setup();
    await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT);
    const other = getPublicKey(generateSecretKey());
    expect(await h.admin.handleAttestation(COORD, ACCOUNT, linkConfirm(postedCode(h.mls), other), CREATED_AT)).toBe(false);
    expect(h.lastCategory()).toBe("chat_link_no_pending");
    expect(h.store.getChatKey(COORD, other)).toBeUndefined();
  });

  it("a new request supersedes the pending one: old group torn down, old code dead", async () => {
    const h = await setup();
    await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT);
    const first = postedCode(h.mls);
    await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT);
    expect(h.mls.destroyed).toEqual(["mls-2"]);
    const second = postedCode(h.mls);
    if (first !== second) {
      expect(await h.admin.handleAttestation(COORD, ACCOUNT, linkConfirm(first), CREATED_AT)).toBe(false);
    }
    expect(await h.admin.handleAttestation(COORD, ACCOUNT, linkConfirm(second), CREATED_AT)).toBe(true);
  });

  it("refuses a key already bound to another account (first binder wins) — no group, no invite", async () => {
    const h = await setup();
    h.store.upsertChatKey({ coordinate: COORD, accountPubkey: "b".repeat(64), chatPubkey: W, now: 1 });
    expect(await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT)).toBe(false);
    expect(h.lastCategory()).toBe("chat_key_bound_to_other_account");
    expect(h.mls.created).toBe(1);
  });

  it("W counts toward the device cap", async () => {
    const h = await setup();
    for (let i = 0; i < MAX_CHAT_KEYS_PER_ACCOUNT; i++) {
      h.store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: i.toString(16).padStart(64, "0"), now: 1 });
    }
    expect(await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT)).toBe(false);
    expect(h.lastCategory()).toBe("chat_device_cap_reached");
    expect(h.mls.created).toBe(1);
  });

  it("no key package for W anywhere → a refusal the user can act on", async () => {
    const h = await setup({ kps: [] });
    expect(await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT)).toBe(false);
    expect(h.lastCategory()).toBe("chat_link_no_key_package");
    expect(h.mls.created).toBe(1);
  });

  it("an ineligible key package (e.g. an identity-proof version we can't read) is reported, group torn down", async () => {
    const h = await setup();
    h.mls.eligible = false;
    h.mls.ineligibleReasons = ["unsupported identity proof"];
    expect(await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT)).toBe(false);
    expect(h.lastCategory()).toBe("chat_key_package_ineligible");
    expect(h.mls.destroyed).toEqual(["mls-2"]);
    expect(h.mls.sent).toEqual([]);
  });

  it("a failed invite (e.g. marmot can't decode the key package) is reported, not thrown", async () => {
    const h = await setup();
    h.mls.throwOnInvite.add(W);
    expect(await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT)).toBe(false);
    expect(h.lastCategory()).toBe("chat_link_failed");
    expect(h.mls.destroyed).toEqual(["mls-2"]);
    expect(h.store.getChatLink(COORD, ACCOUNT)!.status).toBe("closed");
  });

  it("rate-limits link requests per account", async () => {
    const h = await setup({ kps: [] }); // each request is refused for want of a key package…
    for (let i = 0; i < 5; i++) await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT);
    expect(h.lastCategory()).toBe("chat_link_no_key_package");
    // …but still counts, so the sixth inside the hour is refused before any work.
    await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT);
    expect(h.lastCategory()).toBe("chat_link_rate_limited");
    h.clock.t += 60 * 60_000;
    await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT);
    expect(h.lastCategory()).toBe("chat_link_no_key_package");
  });

  it("a non-approved attendee gets nothing — no group, no notice", async () => {
    const h = await setup();
    h.store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "pending", now: 2 });
    expect(await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(), CREATED_AT)).toBe(false);
    expect(h.mls.created).toBe(1);
    expect(h.notices).toEqual([]);
  });

  it("a linked key is revocable like any device (real MLS Remove from the event group)", async () => {
    const h = await setup({ kps: [kpAt(ACCOUNT, "kpA", 10)] });
    await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(ACCOUNT), CREATED_AT);
    expect(await h.mls.isMember(EVENT_GROUP, ACCOUNT)).toBe(true);
    expect(await h.admin.handleAttestation(COORD, ACCOUNT, attest("revoke", ACCOUNT), CREATED_AT)).toBe(true);
    expect(await h.mls.isMember(EVENT_GROUP, ACCOUNT)).toBe(false);
    expect(h.store.getChatKey(COORD, ACCOUNT)?.status).toBe("revoked");
  });

  it("an organizer's linked external key is a member, never an MLS co-admin", async () => {
    const h = await setup({ kps: [kpAt(ACCOUNT, "kpA", 10), kpEvent(CHATKEY, "kpDev")], role: "organizer" });
    await h.admin.handleAttestation(COORD, ACCOUNT, attest("add"), CREATED_AT);
    await h.admin.handleAttestation(COORD, ACCOUNT, linkReq(ACCOUNT), CREATED_AT);
    const admins = h.admin.desiredAdminPubkeys(COORD);
    expect(admins).toContain(CHATKEY);
    expect(admins).not.toContain(ACCOUNT);
    expect(await h.mls.isMember(EVENT_GROUP, ACCOUNT)).toBe(true);
  });
});

/**
 * The group avatar mirrors the event icon (E_id kind-0 `picture`), through the
 * same idempotent reconciliation as relays and admins.
 */
describe("MarmotAdmin.ensureAvatar — the group avatar follows the event icon", () => {
  function setup() {
    const store = freshStore();
    const mls = new FakeMls();
    const logs: string[] = [];
    const admin = makeAdmin(store, mls, [], (m) => logs.push(m));
    return { store, mls, admin, logs };
  }

  it("a newly created group gets the icon, normalized", async () => {
    const { mls, admin } = setup();
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    await admin.ensureAvatar(COORD, "  HTTPS://Img.Example.COM:443/a/../icon.png ");
    expect(mls.avatarCommits).toEqual([{ group: "mls-1", url: "https://img.example.com/icon.png" }]);
  });

  it("commits a changed icon, and nothing when it is unchanged", async () => {
    const { mls, admin } = setup();
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    await admin.ensureAvatar(COORD, "https://img.example.com/a.png");
    await admin.ensureAvatar(COORD, "https://img.example.com/a.png"); // restart / re-ensure
    await admin.ensureAvatar(COORD, "https://img.example.com/b.png");
    expect(mls.avatarCommits.map((c) => c.url)).toEqual([
      "https://img.example.com/a.png",
      "https://img.example.com/b.png",
    ]);
  });

  it("clears the avatar when the icon is removed", async () => {
    const { mls, admin } = setup();
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    await admin.ensureAvatar(COORD, "https://img.example.com/a.png");
    await admin.ensureAvatar(COORD, undefined);
    expect(mls.avatarCommits.map((c) => c.url)).toEqual(["https://img.example.com/a.png", ""]);
  });

  it("no icon on a new group is no commit at all", async () => {
    const { mls, admin } = setup();
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    await admin.ensureAvatar(COORD, undefined);
    expect(mls.avatarCommits).toEqual([]);
  });

  it("an invalid icon URL is skipped with a log line and the avatar left as it was", async () => {
    const { mls, admin, logs } = setup();
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    await admin.ensureAvatar(COORD, "https://img.example.com/a.png");
    for (const bad of ["http://img.example.com/a.png", "https://u:p@img.example.com/a.png", "https://img.example.com/a.png#x", "not a url"]) {
      await expect(admin.ensureAvatar(COORD, bad)).resolves.toBeUndefined();
    }
    expect(mls.avatarCommits.map((c) => c.url)).toEqual(["https://img.example.com/a.png"]);
    expect(logs.filter((l) => l.includes("not usable as the group avatar"))).toHaveLength(4);
  });

  it("does nothing for an event without an active group", async () => {
    const { mls, admin } = setup();
    await admin.ensureAvatar(COORD, "https://img.example.com/a.png");
    expect(mls.avatarCommits).toEqual([]);
  });
});
