import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { Store } from "../store/db.js";
import { MarmotAdmin } from "./admin.js";
import type { ChatMls } from "./mls.js";
import type { ChatKeyAttestationContent } from "@nostrautica/protocol";

type AnyEvent = { id: string; pubkey: string; kind: number; tags: string[][] };

const COORD = "31923:" + "e".repeat(64) + ":devcon";
const ACCOUNT = "a".repeat(64);
const CHATKEY = "c".repeat(64);
const CHATKEY2 = "d".repeat(64);

/** An in-memory ChatMls: tracks membership per group in a Set, records all calls. */
class FakeMls implements ChatMls {
  members = new Map<string, Set<string>>();
  invited: string[] = [];
  removed: string[][] = [];
  ingested: AnyEvent[][] = [];
  eligible = true;
  created = 0;

  async createGroup(): Promise<{ mlsGroupIdHex: string; nostrGroupIdHex: string }> {
    this.created++;
    return { mlsGroupIdHex: "mls-" + this.created, nostrGroupIdHex: "ng-" + this.created };
  }
  async isEligible(): Promise<boolean> {
    return this.eligible;
  }
  async isMember(group: string, pubkey: string): Promise<boolean> {
    return this.members.get(group)?.has(pubkey) ?? false;
  }
  async invite(group: string, kp: AnyEvent): Promise<void> {
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
}

function kpEvent(pubkey: string, id: string): AnyEvent {
  return { id, pubkey, kind: 30443, tags: [] };
}

/** Build an admin whose key-package fetch returns the pre-seeded events per author. */
function makeAdmin(store: Store, mls: FakeMls, kps: AnyEvent[] = []) {
  const now = () => 1000;
  return new MarmotAdmin({
    store,
    mls,
    now,
    fetchKeyPackages: async (_coordinate, authors) =>
      kps.filter((e) => authors.includes(e.pubkey)),
  });
}

function freshStore(): Store {
  return new Store(":memory:", generateSecretKey());
}

function attest(op: "add" | "revoke", chatPubkey = CHATKEY): ChatKeyAttestationContent {
  return { v: 1, a: COORD, op, chat_pubkey: chatPubkey };
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
});

describe("MarmotAdmin — add on approve / key package (§4.2)", () => {
  it("adds an approved attendee's local key from their 30443, deduped by event id", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(ACCOUNT, "kp1")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });

    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.invited).toEqual([ACCOUNT]);
    expect(store.isKpConsumed(COORD, "kp1")).toBe(true);

    // Re-sync: already a member + consumed → no second invite.
    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.invited).toEqual([ACCOUNT]);
  });

  it("multi-device: an account's attested chat key is added alongside the account key", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(ACCOUNT, "kp1"), kpEvent(CHATKEY, "kp2")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });

    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.invited.sort()).toEqual([ACCOUNT, CHATKEY].sort());
  });

  it("the 30443 watcher adds an authorized author and ignores an unauthorized one", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });

    // Authorized: the approved account's own key.
    await admin.handleKeyPackageEvent(COORD, kpEvent(ACCOUNT, "kpA"));
    expect(mls.invited).toEqual([ACCOUNT]);

    // Unauthorized: a stranger's key package is ignored (not an authorized identity).
    const stranger = "f".repeat(64);
    await admin.handleKeyPackageEvent(COORD, kpEvent(stranger, "kpS"));
    expect(mls.invited).toEqual([ACCOUNT]);
  });

  it("does not add a pending (unapproved) attendee", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(ACCOUNT, "kp1")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "pending", now: 1 });
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
    const ok = await admin.handleAttestation(COORD, ACCOUNT, attest("add"));
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

    const ok = await admin.handleAttestation(COORD, ACCOUNT, attest("add"));
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

    await admin.handleAttestation(COORD, ACCOUNT, attest("add"));
    expect(store.getChatKey(COORD, CHATKEY)?.status).toBe("active"); // recorded
    expect(mls.invited).toEqual([]); // but not added
  });

  it("op:revoke marks the key revoked and MLS-removes its leaves", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [kpEvent(CHATKEY, "kp2")]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    await admin.handleAttestation(COORD, ACCOUNT, attest("add"));
    expect(mls.members.get("mls-1")?.has(CHATKEY)).toBe(true);

    await admin.handleAttestation(COORD, ACCOUNT, attest("revoke"));
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
    expect(authors).toEqual([ACCOUNT, CHATKEY].sort());
    expect(authors).not.toContain(CHATKEY2); // revoked
    expect(authors).not.toContain(pending); // not approved
  });
});

describe("MarmotAdmin — remove on revoke (§4.2) & ingest", () => {
  it("handleRevoke MLS-removes the account key AND every attested chat key", async () => {
    const store = freshStore();
    const mls = new FakeMls();
    const admin = makeAdmin(store, mls, [
      kpEvent(ACCOUNT, "kp1"),
      kpEvent(CHATKEY, "kp2"),
    ]);
    await admin.ensureGroup({ coordinate: COORD, name: "n", description: "d", relays: [] });
    store.upsertAttendee({ coordinate: COORD, pubkey: ACCOUNT, status: "approved", now: 1 });
    store.upsertChatKey({ coordinate: COORD, accountPubkey: ACCOUNT, chatPubkey: CHATKEY, now: 1 });
    await admin.syncMember(COORD, ACCOUNT);
    expect(mls.members.get("mls-1")?.size).toBe(2);

    await admin.handleRevoke(COORD, ACCOUNT);
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
