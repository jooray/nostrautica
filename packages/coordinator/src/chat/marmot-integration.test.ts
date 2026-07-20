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
import { getEpoch } from "@internet-privacy/marmot-ts/core";
import type {
  NostrNetworkInterface,
  PublishResponse,
  Subscribable,
} from "@internet-privacy/marmot-ts/client";
import { Store } from "../store/db.js";
import { makeMarmotStores } from "./stores.js";
import { makeCoordinatorSigner, makeCoordinatorProofSigner } from "./signer.js";
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
    accountProofSigner: makeCoordinatorProofSigner(sk),
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
});
