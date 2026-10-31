/**
 * Audit K-7, through the real marmot-ts engine: a relay that STORES a commit but
 * never sends its OK.
 *
 * Before the fix the chat adapter reported that as a definite failure, marmot
 * rolled the commit back, and the members, who had already fetched it from the
 * relay, moved to N+1 while the coordinator stayed on N. The coordinator's next
 * commit was then a second N→N+1′. Members keep the branch whose commit is
 * earlier, so they ignored it, and the coordinator was left alone on a dead
 * branch (audit K-7, steps 4–5). Against the old adapter this test fails exactly
 * there: the member still shows the first avatar, never the second.
 */
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { MarmotClient } from "@internet-privacy/marmot-ts/client";
import type { NostrNetworkInterface, PublishResponse, Subscribable } from "@internet-privacy/marmot-ts/client";
import { getEpoch, getNostrGroupIdHex, getPubkeyLeafNodes, deserializeApplicationData } from "@internet-privacy/marmot-ts/core";
import { Proposals, createChatRumor, createApplicationMessageIntent } from "@internet-privacy/marmot-ts/client";
import { Store } from "../store/db.js";
import { makeMarmotStores, sqliteStore, pendingPublicationKvKey } from "./stores.js";
import { makeCoordinatorSigner } from "./signer.js";
import { createMarmotClientMls, type MarmotClientMls } from "./mls.js";
import { makeChatNetwork, type ChatNetworkTransport } from "./network.js";

type Ev = { id: string; pubkey: string; kind: number; created_at: number; tags: string[][]; content: string };
const RELAY = "wss://test.relay";

/** One in-memory relay. With `silent` set it stores what it is sent and never acks. */
class SilentRelay {
  events: Ev[] = [];
  /** Member secret keys by pubkey, so a test can "reinstall" a device. */
  private secrets = new Map<string, Uint8Array>();
  rememberSecret(sk: Uint8Array): void {
    this.secrets.set(getPublicKey(sk), sk);
  }
  memberSecret(pub: string): Uint8Array {
    return this.secrets.get(pub)!;
  }
  silent = false;
  private observers: { filters: any[]; next: (e: Ev) => void }[] = [];

  matches(e: Ev, f: any): boolean {
    if (f.kinds && !f.kinds.includes(e.kind)) return false;
    if (f.authors && !f.authors.includes(e.pubkey)) return false;
    if (f.ids && !f.ids.includes(e.id)) return false;
    for (const key of Object.keys(f)) {
      if (!key.startsWith("#")) continue;
      const have = e.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1]);
      if (!have.some((v) => (f[key] as string[]).includes(v!))) return false;
    }
    return true;
  }
  store(e: Ev): void {
    if (this.events.some((x) => x.id === e.id)) return;
    this.events.push(e);
    for (const o of this.observers) if (o.filters.some((f) => this.matches(e, f))) o.next(e);
  }
  query(filters: any): Ev[] {
    const fs = Array.isArray(filters) ? filters : [filters];
    return this.events.filter((e) => fs.some((f) => this.matches(e, f)));
  }
  watch(filters: any, next: (e: Ev) => void): () => void {
    const entry = { filters: Array.isArray(filters) ? filters : [filters], next };
    this.observers.push(entry);
    return () => {
      const i = this.observers.indexOf(entry);
      if (i >= 0) this.observers.splice(i, 1);
    };
  }

  /** The coordinator's transport, shaped like NostrClient (rejects with outcomes). */
  transport(): ChatNetworkTransport {
    return {
      publish: async (event) => {
        this.store(event as Ev);
        if (this.silent) {
          throw Object.assign(new Error("publish failed on all 1 relay(s) — publish timed out"), {
            outcomes: [{ url: RELAY, status: "timeout", reason: "publish timed out" }],
          });
        }
        return { acked: [RELAY] };
      },
      fetch: async (filter) => this.query(filter) as never[],
      subscribe: (filter, onEvent) => this.watch(filter, onEvent as never),
    };
  }

  /** A member's network: a plain, always-acking relay. */
  memberNetwork(): NostrNetworkInterface {
    return {
      publish: async (_relays, event): Promise<Record<string, PublishResponse>> => {
        this.store(event as unknown as Ev);
        return { [RELAY]: { from: RELAY, ok: true } };
      },
      request: async (_relays, filters) => this.query(filters) as never,
      subscription: (_relays, filters): Subscribable<never> => ({
        subscribe: (observer) => ({ unsubscribe: this.watch(filters, (e) => observer.next?.(e as never)) }),
      }),
      getUserInboxRelays: async () => [RELAY],
    };
  }
}

function memberClient(sk: Uint8Array, network: NostrNetworkInterface): MarmotClient {
  const stores = makeMarmotStores(new Store(":memory:", sk));
  return new MarmotClient({
    signer: makeCoordinatorSigner(sk) as never,
    network,
    groupStateStore: stores.groupStateStore,
    keyPackageStore: stores.keyPackageStore,
    inviteStore: stores.inviteStore,
    rewindStore: stores.rewindStore,
    clientId: "d".repeat(64),
  });
}

/** A member that publishes a key package, is invited by the coordinator, and joins. */
async function joinMember(relay: SilentRelay, mls: MarmotClientMls, gid: string) {
  const sk = generateSecretKey();
  const pub = getPublicKey(sk);
  relay.rememberSecret(sk);
  const client = memberClient(sk, relay.memberNetwork());
  await client.keyPackages.ensurePublished({ relays: [RELAY] });
  const [kp] = relay.query({ kinds: [30443], authors: [pub] });
  await mls.invite(gid, kp as never);
  await client.invites.ingestEvents(relay.query({ kinds: [1059] }) as never);
  await client.invites.decryptGiftWraps();
  const [invite] = await client.invites.getUnread();
  const { group } = await client.joinGroupFromWelcome({ welcomeRumor: invite! });

  /** Every ingest result kind the member saw: a fork shows up as `stateInvalidated`. */
  const results: string[] = [];
  const seen = new Set(relay.events.map((e) => e.id));
  const follow = async () => {
    const fresh = relay
      .query({ kinds: [445], "#h": [getNostrGroupIdHex(group.state)] })
      .filter((e) => !seen.has(e.id));
    for (const e of fresh) seen.add(e.id);
    for await (const r of group.ingest(fresh as never)) results.push(r.kind);
  };
  return { sk, pub, client, group, follow, results };
}

/** A coordinator group with one joined member, both on the same relay. */
async function roomWithMember(relay: SilentRelay) {
  const coordSk = generateSecretKey();
  const coordStore = new Store(":memory:", coordSk);
  const network = makeChatNetwork({ transport: relay.transport(), defaultRelays: [RELAY] });
  const { mls, client } = createMarmotClientMls({ store: coordStore, coordSk, network });
  const ids = await mls.createGroup({ name: "room", description: "", relays: [RELAY] });
  const m = await joinMember(relay, mls, ids.mlsGroupIdHex);
  const coordEpoch = async () => getEpoch((await client.groups.get(ids.mlsGroupIdHex)).state as never);
  return {
    mls,
    client,
    coordSk,
    coordStore,
    network,
    ids,
    member: m.client,
    memberPub: m.pub,
    group: m.group,
    follow: m.follow,
    memberResults: m.results,
    coordEpoch,
  };
}

describe("a commit stored by a relay that never acks (audit K-7)", () => {
  it(
    "is re-sent byte for byte, and the coordinator and the member stay on one branch",
    async () => {
      const relay = new SilentRelay();
      const { mls, ids, group, follow, coordEpoch, memberResults } = await roomWithMember(relay);
      const gid = ids.mlsGroupIdHex;
      const start = await coordEpoch();

      // The relay takes the commit and never answers.
      relay.silent = true;
      await expect(mls.setAvatar(gid, "https://img.example.com/one.png")).rejects.toThrow();
      relay.silent = false;
      const stored = relay.query({ kinds: [445] }).length;

      // The member fetched it anyway and moved on.
      await follow();
      expect(getEpoch(group.state as never)).toBe(start + 1);
      expect(group.groupData?.avatarUrl).toBe("https://img.example.com/one.png");

      // A second later, so the two commits never share a created_at (within one
      // second the fork is decided by event-id tie-break, and goes either way).
      await new Promise((r) => setTimeout(r, 1_100));

      // The coordinator's next commit must build on that same N+1.
      expect(await mls.setAvatar(gid, "https://img.example.com/two.png")).toBe(true);
      // Exactly one new 445: the next commit. The retained one was re-sent as the
      // same event, which the relay already had.
      expect(relay.query({ kinds: [445] }).length).toBe(stored + 1);
      await follow();
      expect(memberResults).not.toContain("stateInvalidated"); // no fork, no rewind
      expect(group.groupData?.avatarUrl).toBe("https://img.example.com/two.png");
      expect(getEpoch(group.state as never)).toBe(await coordEpoch());
      expect(await coordEpoch()).toBe(start + 2);
    },
    60_000,
  );

  // With no new outbound intent nothing re-sent the retained commit, and while it
  // is pending the group holds inbound traffic instead of applying it. Both the
  // ingest path and the periodic sweep now drive it.
  for (const via of ["ingest", "sweep"] as const) {
    it(
      `a quiet room still converges: the ${via} re-sends the retained commit`,
      async () => {
        const relay = new SilentRelay();
        const { mls, ids, group, follow, coordEpoch } = await roomWithMember(relay);
        const gid = ids.mlsGroupIdHex;
        const start = await coordEpoch();

        relay.silent = true;
        await expect(mls.setAvatar(gid, "https://img.example.com/one.png")).rejects.toThrow();
        relay.silent = false;
        const commits = relay.query({ kinds: [445] }).length;
        await follow();
        expect(getEpoch(group.state as never)).toBe(start + 1);
        expect(await coordEpoch()).toBe(start); // pending: still on N

        if (via === "ingest") await mls.ingest(gid, []);
        else await mls.retryPendingPublications();

        expect(await coordEpoch()).toBe(start + 1);
        expect(await mls.getAvatar(gid)).toBe("https://img.example.com/one.png");
        expect(relay.query({ kinds: [445] }).length).toBe(commits); // same bytes, no new event
      },
      60_000,
    );
  }
});

/** Audit R-5: what an ingest applied is reported, so it can be logged. */
describe("MarmotClientMls.ingest report (audit R-5)", () => {
  it(
    "names a co-admin's commit: its epochs, its committer and the member it added",
    async () => {
      const relay = new SilentRelay();
      const { mls, ids, coordEpoch, network, coordSk } = await roomWithMember(relay);
      const gid = ids.mlsGroupIdHex;
      const coordPub = getPublicKey(coordSk);
      const organizer = await joinMember(relay, mls, gid);
      await mls.setAdmins(gid, [coordPub, organizer.pub]);
      await organizer.follow();
      void network;

      // The organizer device adds someone itself.
      const guestSk = generateSecretKey();
      const guestPub = getPublicKey(guestSk);
      await memberClient(guestSk, relay.memberNetwork()).keyPackages.ensurePublished({ relays: [RELAY] });
      const [guestKp] = relay.query({ kinds: [30443], authors: [guestPub] });
      await organizer.client.groups.invite(organizer.group.idStr, guestKp as never);

      const before = await coordEpoch();
      const report = await mls.ingest(gid, relay.query({ kinds: [445] }) as never);
      expect(report.commits).toEqual([
        { fromEpoch: before, toEpoch: before + 1, committer: organizer.pub, added: [guestPub], removed: [] },
      ]);
      expect(report.forks).toEqual([]);
      expect(report.epochAfter).toBe(before + 1);
    },
    60_000,
  );

  it(
    "flags a competing commit for an epoch we left",
    async () => {
      const relay = new SilentRelay();
      const { mls, ids, coordEpoch, coordSk } = await roomWithMember(relay);
      const gid = ids.mlsGroupIdHex;
      const organizer = await joinMember(relay, mls, gid);
      await mls.setAdmins(gid, [getPublicKey(coordSk), organizer.pub]);
      await organizer.follow();
      const n = await coordEpoch();

      // Both admins commit from epoch N without seeing each other: a fork. Which
      // branch wins is marmot's fork rule; either way it is a competing commit.
      expect(await mls.setAvatar(gid, "https://img.example.com/coord.png")).toBe(true);
      const ctx = organizer.group.session.proposalContext();
      const proposals = await Proposals.proposeUpdateMetadata({ avatarUrl: "https://img.example.com/org.png" })(ctx);
      await organizer.client.groups.commit(organizer.group.idStr, { extraProposals: proposals });
      const competing = relay.query({ kinds: [445] }).at(-1)!.id;

      const report = await mls.ingest(gid, relay.query({ kinds: [445] }) as never);
      expect(report.forks).toMatchObject([{ epoch: n, eventId: competing }]);

    },
    60_000,
  );

  it(
    "does not call a re-delivered commit of our own chain a fork",
    async () => {
      // A restarted coordinator has no dedup memory, so a relay replaying the
      // group's history hands it every old commit again as "past epoch". Those
      // are on our chain.
      const relay = new SilentRelay();
      const { mls, ids, coordSk, coordStore, network } = await roomWithMember(relay);
      const gid = ids.mlsGroupIdHex;
      await mls.setAvatar(gid, "https://img.example.com/a.png");
      await mls.setAvatar(gid, "https://img.example.com/b.png");
      const restarted = createMarmotClientMls({ store: coordStore, coordSk, network });
      const replay = await restarted.mls.ingest(gid, relay.query({ kinds: [445] }) as never);
      expect(replay.forks).toEqual([]);
      expect(replay.commits).toEqual([]);
    },
    60_000,
  );
});

/** Audit K-1: the evidence the re-enrolment guard reads. */
describe("MarmotClientMls.lastActivity (audit K-1)", () => {
  it(
    "records a member's message, survives a restart, and is forgotten when the leaf is removed",
    async () => {
      const relay = new SilentRelay();
      const { mls, ids, member, memberPub, group, coordEpoch, coordSk, coordStore, network } = await roomWithMember(relay);
      const gid = ids.mlsGroupIdHex;
      expect(await mls.lastActivity(gid, memberPub)).toBeUndefined();

      await member.groups.send(
        group.idStr,
        createApplicationMessageIntent(createChatRumor({ pubkey: memberPub, content: "hi" })),
      );
      await mls.ingest(gid, relay.query({ kinds: [445] }) as never);
      const epoch = await coordEpoch();
      const seen = await mls.lastActivity(gid, memberPub);
      expect(seen).toMatchObject({ epoch, currentEpoch: epoch });
      expect(seen!.ageMs).toBeLessThan(5_000);

      // Persisted: a restarted coordinator still knows (a deploy must not make
      // the eviction guard laxer for its first half hour).
      const restarted = createMarmotClientMls({ store: coordStore, coordSk, network });
      expect(await restarted.mls.lastActivity(gid, memberPub)).toMatchObject({ epoch });

      await restarted.mls.removePubkeys(gid, [memberPub]);
      expect(await restarted.mls.lastActivity(gid, memberPub)).toBeUndefined();
    },
    60_000,
  );

  it(
    "records a co-admin's commit as activity of its committer, in the epoch it produced",
    async () => {
      const relay = new SilentRelay();
      const { mls, ids, coordSk, coordEpoch } = await roomWithMember(relay);
      const gid = ids.mlsGroupIdHex;
      const organizer = await joinMember(relay, mls, gid);
      await mls.setAdmins(gid, [getPublicKey(coordSk), organizer.pub]);
      await organizer.follow();
      const ctx = organizer.group.session.proposalContext();
      const proposals = await Proposals.proposeUpdateMetadata({ avatarUrl: "https://img.example.com/o.png" })(ctx);
      await organizer.client.groups.commit(organizer.group.idStr, { extraProposals: proposals });
      await mls.ingest(gid, relay.query({ kinds: [445] }) as never);
      expect(await mls.lastActivity(gid, organizer.pub)).toMatchObject({ epoch: await coordEpoch() });
    },
    60_000,
  );
});

/** Audit K-1 point 3: a re-enrolment is one commit, not a Remove and then an Add. */
describe("MarmotClientMls.reenrol (audit K-1)", () => {
  it(
    "replaces a device's stale leaf with its fresh key package in ONE commit, with a Welcome",
    async () => {
      const relay = new SilentRelay();
      const { mls, ids, memberPub, coordEpoch } = await roomWithMember(relay);
      const gid = ids.mlsGroupIdHex;
      const memberSk = relay.memberSecret(memberPub);
      const observer = await joinMember(relay, mls, gid);
      await observer.follow();
      const before = await coordEpoch();
      const commitsBefore = relay.query({ kinds: [445] }).length;
      const welcomesBefore = relay.query({ kinds: [1059] }).length;

      // The device lost its MLS state: same key, fresh store, fresh key package.
      const oldKps = new Set(relay.query({ kinds: [30443], authors: [memberPub] }).map((e) => e.id));
      const reborn = memberClient(memberSk, relay.memberNetwork());
      await reborn.keyPackages.ensurePublished({ relays: [RELAY] });
      const [freshKp] = relay.query({ kinds: [30443], authors: [memberPub] }).filter((e) => !oldKps.has(e.id));
      await mls.reenrol(gid, freshKp as never);

      expect(relay.query({ kinds: [445] }).length).toBe(commitsBefore + 1); // one commit
      expect(relay.query({ kinds: [1059] }).length).toBeGreaterThan(welcomesBefore);
      expect(await coordEpoch()).toBe(before + 1);

      // Members see one change, and exactly one leaf for the device afterwards.
      await observer.follow();
      expect(getEpoch(observer.group.state as never)).toBe(before + 1);
      expect(getPubkeyLeafNodes(observer.group.state, memberPub)).toHaveLength(1);

      // The device joins from the Welcome and reads the room.
      await reborn.invites.ingestEvents(relay.query({ kinds: [1059] }) as never);
      await reborn.invites.decryptGiftWraps();
      // Its inbox also holds the first Welcome, for the key package it lost.
      let group: Awaited<ReturnType<typeof reborn.joinGroupFromWelcome>>["group"] | undefined;
      for (const invite of await reborn.invites.getUnread()) {
        group = await reborn.joinGroupFromWelcome({ welcomeRumor: invite }).then(
          (r) => r.group,
          () => undefined,
        );
        if (group) break;
      }
      if (!group) throw new Error("the fresh key package's Welcome did not join");
      expect(getEpoch(group.state as never)).toBe(before + 1);
      const texts: string[] = [];
      group.on("applicationMessage", (bytes: Uint8Array) => {
        texts.push((deserializeApplicationData(bytes) as { content: string }).content);
      });
      await mls.sendText(gid, "welcome back");
      const fresh = relay.query({ kinds: [445] }).slice(commitsBefore + 1);
      for await (const _ of group.ingest(fresh as never)) void _;
      expect(texts).toContain("welcome back");
    },
    60_000,
  );
});

/** Audit K-8: a group must not stay dead because of its pending-publication record. */
describe("loading a group whose pending-publication record will not restore (audit K-8)", () => {
  it(
    "backs the record up, drops it, and loads the group",
    async () => {
      const relay = new SilentRelay();
      const { mls, ids, coordSk, coordStore, network } = await roomWithMember(relay);
      const gid = ids.mlsGroupIdHex;
      const key = pendingPublicationKvKey(gid);

      // An unacknowledged commit leaves a retained record...
      relay.silent = true;
      await expect(mls.setAvatar(gid, "https://img.example.com/x.png")).rejects.toThrow();
      expect(coordStore.marmotKvGet("rewind", key)).toBeDefined();
      // ...which is then damaged (a format change, a partial write).
      await sqliteStore<Uint8Array>(coordStore, "rewind").setItem(key, new TextEncoder().encode('{"version":9}'));
      const damaged = coordStore.marmotKvGet("rewind", key);
      relay.silent = false;

      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (m: unknown) => void warned.push(String(m));
      let status;
      const restarted = createMarmotClientMls({ store: coordStore, coordSk, network });
      try {
        status = await restarted.mls.groupProfile(gid);
      } finally {
        console.warn = warn;
      }
      expect(status).toBe("current");
      expect(coordStore.marmotKvGet("rewind", key)).toBeUndefined();
      const [backup] = coordStore.marmotKvKeys("pending-publication-bak");
      expect(backup!.startsWith(`${key}.bak.`)).toBe(true);
      expect(coordStore.marmotKvGet("pending-publication-bak", backup!)).toBe(damaged);
      expect(warned.some((l) => l.includes("pending-publication record") && l.includes("Invalid pending publication record"))).toBe(true);

      // And the room works again.
      expect(await restarted.mls.setAvatar(gid, "https://img.example.com/y.png")).toBe(true);
    },
    60_000,
  );
});
