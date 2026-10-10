/**
 * Real marmot-ts round-trip against the vendored library with the coordinator's
 * encrypted SQLite stores (MARMOT-GROUP-CHAT §4, Phase-3 acceptance). Proves the
 * wiring end-to-end in Node: the coordinator creates a group, a separate member
 * client publishes a real kind-30443 key package, the coordinator evaluates and
 * adds it (its leaf appears), and a Remove takes it back out — the add-on-approve
 * and remove-on-revoke state transitions, exercised through the actual MLS engine.
 */
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { MarmotClient } from "@internet-privacy/marmot-ts/client";
import {
  getEpoch,
  getNostrGroupIdHex,
  deserializeApplicationData,
} from "@internet-privacy/marmot-ts/core";
import type {
  NostrNetworkInterface,
  PublishResponse,
  Subscribable,
} from "@internet-privacy/marmot-ts/client";
import { Store } from "../store/db.js";
import { makeMarmotStores } from "./stores.js";
import { makeCoordinatorSigner } from "./signer.js";
import { createMarmotClientMls } from "./mls.js";

type Ev = { id: string; pubkey: string; kind: number; created_at: number; tags: string[][]; content: string; [k: string]: unknown };

const RELAYS = ["wss://test.relay"];

/** A shared in-memory relay both clients publish to and read from. */
class FakeNetwork implements NostrNetworkInterface {
  events: Ev[] = [];
  private observers: { filters: any[]; next: (e: Ev) => void }[] = [];

  private matches(e: Ev, f: any): boolean {
    if (f.kinds && !f.kinds.includes(e.kind)) return false;
    if (f.authors && !f.authors.includes(e.pubkey)) return false;
    if (f.ids && !f.ids.includes(e.id)) return false;
    for (const key of Object.keys(f)) {
      if (key.startsWith("#")) {
        const tag = key.slice(1);
        const want: string[] = f[key];
        const have = e.tags.filter((t) => t[0] === tag).map((t) => t[1]);
        if (!have.some((v) => want.includes(v!))) return false;
      }
    }
    return true;
  }

  async publish(_relays: string[], event: Ev): Promise<Record<string, PublishResponse>> {
    this.events.push(event);
    for (const o of this.observers) if (o.filters.some((f) => this.matches(event, f))) o.next(event);
    return { [RELAYS[0]!]: { from: RELAYS[0]!, ok: true } };
  }
  async request(_relays: string[], filters: any): Promise<Ev[]> {
    const fs = Array.isArray(filters) ? filters : [filters];
    return this.events.filter((e) => fs.some((f) => this.matches(e, f)));
  }
  subscription(_relays: string[], filters: any): Subscribable<never> {
    const fs = Array.isArray(filters) ? filters : [filters];
    const observers = this.observers;
    return {
      subscribe(observer) {
        const entry = { filters: fs, next: (e: Ev) => observer.next?.(e as never) };
        observers.push(entry);
        return {
          unsubscribe() {
            const i = observers.indexOf(entry);
            if (i >= 0) observers.splice(i, 1);
          },
        };
      },
    };
  }
  async getUserInboxRelays(): Promise<string[]> {
    return RELAYS; // welcomes go back to the shared relay
  }
}

/** A plain member MarmotClient over in-memory-encrypted stores. */
function makeMemberClient(sk: Uint8Array, network: NostrNetworkInterface): MarmotClient {
  const store = new Store(":memory:", sk);
  const stores = makeMarmotStores(store);
  return new MarmotClient({
    signer: makeCoordinatorSigner(sk) as never,
    network,
    groupStateStore: stores.groupStateStore,
    keyPackageStore: stores.keyPackageStore,
    inviteStore: stores.inviteStore,
    rewindStore: stores.rewindStore,
    clientId: "member-device",
  });
}

describe("marmot-ts real round-trip (coordinator admin bot)", () => {
  it(
    "creates a group, adds a member's real 30443, then removes them",
    async () => {
      const network = new FakeNetwork();
      const coordSk = generateSecretKey();
      const coordStore = new Store(":memory:", coordSk);
      const { mls } = createMarmotClientMls({ store: coordStore, coordSk, network });

      // A member publishes a real kind-30443 key package (carrying a valid proof).
      const memberSk = generateSecretKey();
      const memberPub = getPublicKey(memberSk);
      const member = makeMemberClient(memberSk, network);
      await member.keyPackages.ensurePublished({ relays: RELAYS });

      // Coordinator creates the group and persists the mapping.
      const ids = await mls.createGroup({ name: "Devcon chat", description: "hi", relays: RELAYS });
      expect(ids.mlsGroupIdHex).toMatch(/^[0-9a-f]+$/);
      expect(ids.nostrGroupIdHex).toMatch(/^[0-9a-f]+$/);
      // The group state is now encrypted at rest in the coordinator's SQLite.
      expect(coordStore.marmotKvKeys("group-state").length).toBeGreaterThan(0);

      // Fetch the member's published key package and add it.
      const [kpEvent] = await network.request(RELAYS, { kinds: [30443], authors: [memberPub] });
      expect(kpEvent).toBeDefined();
      expect(await mls.isEligible(ids.mlsGroupIdHex, kpEvent as never)).toBe(true);

      await mls.invite(ids.mlsGroupIdHex, kpEvent as never);
      expect(await mls.isMember(ids.mlsGroupIdHex, memberPub)).toBe(true);

      // Remove them (real MLS Remove via the flatten workaround).
      await mls.removePubkeys(ids.mlsGroupIdHex, [memberPub]);
      expect(await mls.isMember(ids.mlsGroupIdHex, memberPub)).toBe(false);
    },
    30_000,
  );

  // Prod 2026-10-05 (0.9.0): every commit in an event room failed with "N admin
  // key(s) have no member leaf in the resulting epoch". The new library enforces
  // MDK's admin-leaf coupling: each admin must hold a member leaf. The room was
  // created listing organizer chat devices that had not joined yet, and removing
  // an admin device was a plain Remove that left it in the admin policy. So no
  // invite could commit, and the organizer was stuck in a remove/re-add loop.
  it(
    "promotes an organizer device only once it holds a leaf, and demotes it in the same commit that removes it",
    async () => {
      const network = new FakeNetwork();
      const coordSk = generateSecretKey();
      const coordPub = getPublicKey(coordSk);
      const { mls } = createMarmotClientMls({ store: new Store(":memory:", coordSk), coordSk, network });
      const ids = await mls.createGroup({ name: "Devcon chat", description: "", relays: RELAYS });
      const gid = ids.mlsGroupIdHex;

      const join = async () => {
        const sk = generateSecretKey();
        const pub = getPublicKey(sk);
        await makeMemberClient(sk, network).keyPackages.ensurePublished({ relays: RELAYS });
        const [kp] = await network.request(RELAYS, { kinds: [30443], authors: [pub] });
        return { pub, kp };
      };

      const organizer = await join();
      // Desired before the device has joined: a no-op, not a poisoned admin set.
      await mls.setAdmins(gid, [coordPub, organizer.pub]);
      expect(await mls.getAdmins(gid)).toEqual([coordPub]);

      // So other members can still be added.
      const alice = await join();
      await mls.invite(gid, alice.kp as never);
      expect(await mls.isMember(gid, alice.pub)).toBe(true);

      // Once the organizer device holds a leaf it is promoted.
      await mls.invite(gid, organizer.kp as never);
      await mls.setAdmins(gid, [coordPub, organizer.pub]);
      expect((await mls.getAdmins(gid)).sort()).toEqual([coordPub, organizer.pub].sort());

      // Removing it drops it from the admin policy in the same commit.
      await mls.removePubkeys(gid, [organizer.pub]);
      expect(await mls.isMember(gid, organizer.pub)).toBe(false);
      expect(await mls.getAdmins(gid)).toEqual([coordPub]);

      // And the room keeps working afterwards.
      const bob = await join();
      await mls.invite(gid, bob.kp as never);
      expect(await mls.isMember(gid, bob.pub)).toBe(true);
    },
    60_000,
  );

  // NIP §10.5: the external-client link confirmation group, through the real
  // engine. The external key joins from the coordinator's Welcome and decrypts the
  // one kind-9 message carrying the code — the whole proof of possession rests on
  // that message being readable by the invited key and nobody else.
  it(
    "link confirmation group: the invited key joins and reads the coordinator's code message; destroyGroup drops it",
    async () => {
      const network = new FakeNetwork();
      const coordSk = generateSecretKey();
      const coordStore = new Store(":memory:", coordSk);
      const { mls } = createMarmotClientMls({ store: coordStore, coordSk, network });

      const wSk = generateSecretKey();
      const wPub = getPublicKey(wSk);
      const external = makeMemberClient(wSk, network);
      await external.keyPackages.ensurePublished({ relays: RELAYS });
      const [kp] = await network.request(RELAYS, { kinds: [30443], authors: [wPub] });

      const ids = await mls.createGroup({
        name: "Nostrautica: confirm White Noise link",
        description: "one-time code",
        relays: RELAYS,
        adminPubkeys: [getPublicKey(coordSk)],
      });
      await mls.invite(ids.mlsGroupIdHex, kp as never);
      await mls.sendText(ids.mlsGroupIdHex, "Your Nostrautica link code: ABCD-EFGH");

      // The external client picks up its gift-wrapped Welcome and joins.
      await external.invites.ingestEvents(network.events.filter((e) => e.kind === 1059) as never);
      await external.invites.decryptGiftWraps();
      const [invite] = await external.invites.getUnread();
      expect(invite).toBeDefined();
      const { group } = await external.joinGroupFromWelcome({ welcomeRumor: invite! });
      const texts: string[] = [];
      group.on("applicationMessage", (bytes: Uint8Array) => {
        texts.push((deserializeApplicationData(bytes) as { content: string }).content);
      });
      const routed = network.events.filter(
        (e) => e.kind === 445 && e.tags.some((t) => t[0] === "h" && t[1] === getNostrGroupIdHex(group.state)),
      );
      for await (const _ of group.ingest(routed as never)) void _;
      expect(texts).toContain("Your Nostrautica link code: ABCD-EFGH");

      // Teardown: remove W, then the coordinator forgets the group entirely.
      await mls.removePubkeys(ids.mlsGroupIdHex, [wPub]);
      await mls.destroyGroup(ids.mlsGroupIdHex);
      expect(coordStore.marmotKvKeys("group-state")).toEqual([]);
    },
    30_000,
  );

  // group.avatar-url.v1 through the real engine: the coordinator commits the
  // avatar, a member joining afterwards reads it from the Welcome, follows a
  // later change and a clear, and an unchanged avatar costs no epoch.
  it(
    "setAvatar: a joining member sees the avatar, follows a change and a clear; unchanged is a no-op",
    async () => {
      const network = new FakeNetwork();
      const coordSk = generateSecretKey();
      const coordStore = new Store(":memory:", coordSk);
      const { mls, client } = createMarmotClientMls({ store: coordStore, coordSk, network });
      const epochOf = async (idHex: string) => getEpoch((await client.groups.get(idHex)).state as never);

      const ids = await mls.createGroup({ name: "Devcon chat", description: "hi", relays: RELAYS });
      expect(await mls.getAvatar(ids.mlsGroupIdHex)).toBe("");
      expect(await mls.setAvatar(ids.mlsGroupIdHex, "https://img.example.com/icon.png")).toBe(true);
      const epoch = await epochOf(ids.mlsGroupIdHex);
      expect(await mls.setAvatar(ids.mlsGroupIdHex, "https://img.example.com/icon.png")).toBe(false);
      expect(await epochOf(ids.mlsGroupIdHex)).toBe(epoch);

      const memberSk = generateSecretKey();
      const member = makeMemberClient(memberSk, network);
      await member.keyPackages.ensurePublished({ relays: RELAYS });
      const [kp] = await network.request(RELAYS, { kinds: [30443], authors: [getPublicKey(memberSk)] });
      await mls.invite(ids.mlsGroupIdHex, kp as never);
      await member.invites.ingestEvents(network.events.filter((e) => e.kind === 1059) as never);
      await member.invites.decryptGiftWraps();
      const [invite] = await member.invites.getUnread();
      const { group } = await member.joinGroupFromWelcome({ welcomeRumor: invite! });
      expect(group.groupData?.avatarUrl).toBe("https://img.example.com/icon.png");

      const seen = new Set(network.events.map((e) => e.id));
      const followNew = async () => {
        const fresh = network.events.filter((e) => e.kind === 445 && !seen.has(e.id));
        for (const e of fresh) seen.add(e.id);
        for await (const _ of group.ingest(fresh as never)) void _;
      };
      expect(await mls.setAvatar(ids.mlsGroupIdHex, "https://img.example.com/icon2.png")).toBe(true);
      await followNew();
      expect(group.groupData?.avatarUrl).toBe("https://img.example.com/icon2.png");
      expect(await mls.setAvatar(ids.mlsGroupIdHex, "")).toBe(true);
      await followNew();
      expect(group.groupData?.avatarUrl ?? "").toBe("");
      expect(await mls.getAvatar(ids.mlsGroupIdHex)).toBe("");
    },
    30_000,
  );

  it(
    "ensureRelays additively unions new relays into the group's routing state, idempotently",
    async () => {
      const network = new FakeNetwork();
      const coordSk = generateSecretKey();
      const coordStore = new Store(":memory:", coordSk);
      const { mls, client } = createMarmotClientMls({ store: coordStore, coordSk, network });
      const epochOf = async (idHex: string) => getEpoch((await client.groups.get(idHex)).state as never);

      const ids = await mls.createGroup({ name: "Devcon chat", description: "hi", relays: RELAYS });
      expect(new Set(await mls.getRelays(ids.mlsGroupIdHex))).toEqual(new Set(RELAYS));

      // A no-op when every relay is already present — no epoch-bumping commit.
      const epochBefore = await epochOf(ids.mlsGroupIdHex);
      await mls.ensureRelays(ids.mlsGroupIdHex, RELAYS);
      expect(new Set(await mls.getRelays(ids.mlsGroupIdHex))).toEqual(new Set(RELAYS));
      expect(await epochOf(ids.mlsGroupIdHex)).toBe(epochBefore);

      // Adds new relays without dropping the existing one; bumps the epoch (a real commit).
      const whitenoise = ["wss://relay.us.whitenoise.chat", "wss://relay.eu.whitenoise.chat"];
      await mls.ensureRelays(ids.mlsGroupIdHex, whitenoise);
      expect(new Set(await mls.getRelays(ids.mlsGroupIdHex))).toEqual(
        new Set([...RELAYS, ...whitenoise]),
      );
      expect(await epochOf(ids.mlsGroupIdHex)).toBeGreaterThan(epochBefore);

      // Calling again with an overlapping set only appends the genuinely new one.
      await mls.ensureRelays(ids.mlsGroupIdHex, [...whitenoise, "wss://relay.new.example"]);
      expect(new Set(await mls.getRelays(ids.mlsGroupIdHex))).toEqual(
        new Set([...RELAYS, ...whitenoise, "wss://relay.new.example"]),
      );
    },
    30_000,
  );

  // prod 2026-08-04. The serialized client state grows ~2.5 KB per device, so at
  // ~25 devices it crossed NIP-44's 65,535-byte plaintext ceiling and every
  // subsequent GroupSession.save() threw — but only AFTER publishCommit had put
  // the Add commit on the relays. So the group advanced for everyone else while
  // the coordinator's on-disk state stayed frozen at the last epoch that fit, and
  // reverted to it on every restart. This drives real MLS invites past that point
  // and checks the state that survives a reload, which is exactly what broke.
  it(
    "keeps persisting group state past the device count where the at-rest ceiling used to break every invite",
    async () => {
      const network = new FakeNetwork();
      const coordSk = generateSecretKey();
      const coordStore = new Store(":memory:", coordSk);
      const { mls } = createMarmotClientMls({ store: coordStore, coordSk, network });
      const ids = await mls.createGroup({ name: "big room", description: "", relays: RELAYS });

      const members: string[] = [];
      for (let i = 0; i < 30; i++) {
        const memberSk = generateSecretKey();
        const memberPub = getPublicKey(memberSk);
        const member = makeMemberClient(memberSk, network);
        await member.keyPackages.ensurePublished({ relays: RELAYS });
        const [kpEvent] = await network.request(RELAYS, { kinds: [30443], authors: [memberPub] });
        // Before the fix this threw "NIP-44 plaintext is NNNNN bytes — the
        // ceiling is 65535" from roughly the 25th iteration onward.
        await mls.invite(ids.mlsGroupIdHex, kpEvent as never);
        members.push(memberPub);
      }

      const stateKey = coordStore.marmotKvKeys("group-state")[0]!;
      const stored = coordStore.marmotKvGet("group-state", stateKey)!;
      // Genuinely past the old ceiling — otherwise this test proves nothing.
      expect(Buffer.byteLength(stored, "utf8")).toBeGreaterThan(65535);

      // A FRESH client over the SAME store: this is the restart that used to roll
      // the coordinator back to a stale epoch and orphan every commit since.
      const reloaded = createMarmotClientMls({ store: coordStore, coordSk, network });
      for (const pub of members) {
        expect(await reloaded.mls.isMember(ids.mlsGroupIdHex, pub)).toBe(true);
      }
    },
    180_000,
  );
});
