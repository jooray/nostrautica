/**
 * The 0x8009 flag day against REAL legacy bytes: `__fixtures__/legacy-marmot-0.6.json`
 * was produced by the previous vendored marmot-ts 0.6.0 (0xF2F1 identity proof) —
 * a coordinator group with one member added, the member's kind-30443, and the
 * coordinator's raw `marmot_kv` contents. It is loaded here into a fresh store
 * exactly as a production database would look after the upgrade deploy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { generateSecretKey } from "nostr-tools/pure";
import { MarmotClient } from "@internet-privacy/marmot-ts/client";
import type { NostrNetworkInterface, PublishResponse, Subscribable } from "@internet-privacy/marmot-ts/client";
import { hexToBytes } from "@nostrautica/protocol";
import { Store } from "../store/db.js";
import { makeMarmotStores } from "./stores.js";
import { makeCoordinatorSigner } from "./signer.js";
import { createMarmotClientMls, keyPackageProfile } from "./mls.js";
import { retireStaleGroups } from "./retire.js";

type Ev = { id: string; pubkey: string; kind: number; created_at: number; tags: string[][]; content: string };

const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/legacy-marmot-0.6.json", import.meta.url), "utf8"),
) as {
  coordSkHex: string;
  group: { mlsGroupIdHex: string; nostrGroupIdHex: string };
  keyPackageEvent: Ev;
  memberSkHex: string;
  coordinatorKv: Record<string, Record<string, string>>;
  memberKeyPackageStore: Record<string, Record<string, string>>;
};

const RELAYS = ["wss://test.relay"];
const COORD = "31923:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee:legacy";

class FakeNetwork implements NostrNetworkInterface {
  events: Ev[] = [];
  async publish(_relays: string[], event: Ev): Promise<Record<string, PublishResponse>> {
    this.events.push(event);
    return { [RELAYS[0]!]: { from: RELAYS[0]!, ok: true } };
  }
  async request(_relays: string[], filters: any): Promise<Ev[]> {
    const fs = Array.isArray(filters) ? filters : [filters];
    return this.events.filter((e) =>
      fs.some((f) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey))),
    );
  }
  subscription(): Subscribable<never> {
    return { subscribe: () => ({ unsubscribe() {} }) };
  }
  async getUserInboxRelays(): Promise<string[]> {
    return RELAYS;
  }
}

/** A coordinator store holding exactly what the legacy daemon left behind. */
function legacyStore(): { store: Store; coordSk: Uint8Array } {
  const coordSk = hexToBytes(fixture.coordSkHex);
  const store = new Store(":memory:", coordSk);
  for (const [ns, entries] of Object.entries(fixture.coordinatorKv)) {
    for (const [k, v] of Object.entries(entries)) store.marmotKvSet(ns, k, v);
  }
  store.upsertMarmotGroup({
    coordinate: COORD,
    mlsGroupId: fixture.group.mlsGroupIdHex,
    nostrGroupId: fixture.group.nostrGroupIdHex,
    status: "active",
    now: 1,
  });
  return { store, coordSk };
}

describe("0x8009 flag day — retiring legacy MLS groups", () => {
  it("classifies the 0.6.0 KeyPackage as not current, and a fresh one as current", async () => {
    expect(keyPackageProfile(fixture.keyPackageEvent as never).current).toBe(false);

    const network = new FakeNetwork();
    const sk = generateSecretKey();
    const stores = makeMarmotStores(new Store(":memory:", sk));
    const member = new MarmotClient({
      signer: makeCoordinatorSigner(sk) as never,
      network,
      groupStateStore: stores.groupStateStore,
      keyPackageStore: stores.keyPackageStore,
      clientId: "fresh-device",
    });
    await member.keyPackages.ensurePublished({ relays: RELAYS });
    expect(keyPackageProfile(network.events[0] as never)).toEqual({ current: true });
  });

  it("a device's stored 0.6.0 KeyPackage is flagged nonCurrent, so ensurePublished makes a fresh one", async () => {
    // The app's retireLegacyState purges exactly these; this proves the flag is set
    // on real legacy bytes, not just on a test double.
    const sk = hexToBytes(fixture.memberSkHex);
    const store = new Store(":memory:", sk);
    for (const [k, v] of Object.entries(fixture.memberKeyPackageStore["key-package"]!)) store.marmotKvSet("key-package", k, v);
    const stores = makeMarmotStores(store);
    const network = new FakeNetwork();
    const device = new MarmotClient({
      signer: makeCoordinatorSigner(sk) as never,
      network,
      groupStateStore: stores.groupStateStore,
      keyPackageStore: stores.keyPackageStore,
      clientId: "web-legacy",
    });
    const listed = await device.keyPackages.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.nonCurrent).toBe(true);
    await device.keyPackages.ensurePublished({ relays: RELAYS, identifier: "web-legacy" });
    expect(network.events).toHaveLength(1);
    expect(keyPackageProfile(network.events[0] as never).current).toBe(true);
  });

  it("retires the legacy room and its state, then a fresh current group takes its place", async () => {
    const { store, coordSk } = legacyStore();
    const { mls } = createMarmotClientMls({ store, coordSk, network: new FakeNetwork() });
    // It still loads — it is the profile that is wrong, not the bytes.
    expect(await mls.groupProfile(fixture.group.mlsGroupIdHex)).toBe("unsupported");

    const logs: string[] = [];
    const result = await retireStaleGroups({ store, mls, log: (m) => logs.push(m) });

    expect(result.coordinates).toEqual([COORD]);
    expect(result.groups).toEqual([fixture.group.mlsGroupIdHex]);
    expect(store.getMarmotGroup(COORD)).toBeUndefined();
    // No byte of the old group's state survives in any per-group namespace.
    for (const ns of ["group-state", "rewind", "lifecycle", "ingest-state", "removed-marker"]) {
      expect(store.marmotKvKeys(ns).filter((k) => k.startsWith(fixture.group.mlsGroupIdHex))).toEqual([]);
    }
    expect(logs.join("\n")).toMatch(/retired the (unsupported|unreadable) MLS group/);

    // The replacement is a current-profile group, and a legacy KeyPackage is told
    // apart from an ordinary refusal when evaluated against it.
    const ids = await mls.createGroup({ name: "n", description: "d", relays: RELAYS });
    expect(await mls.groupProfile(ids.mlsGroupIdHex)).toBe("current");
    const evaluation = await mls.evaluateKeyPackage(ids.mlsGroupIdHex, fixture.keyPackageEvent as never);
    expect(evaluation.legacy).toBe(true);
    expect(evaluation.eligible).toBe(false);
  });

  it("is idempotent: a second start finds nothing to retire", async () => {
    const { store, coordSk } = legacyStore();
    const { mls } = createMarmotClientMls({ store, coordSk, network: new FakeNetwork() });
    await retireStaleGroups({ store, mls });
    const ids = await mls.createGroup({ name: "n", description: "d", relays: RELAYS });
    store.upsertMarmotGroup({ coordinate: COORD, mlsGroupId: ids.mlsGroupIdHex, nostrGroupId: ids.nostrGroupIdHex, status: "active", now: 2 });

    // A restart: a new client over the same store.
    const again = createMarmotClientMls({ store, coordSk, network: new FakeNetwork() });
    const result = await retireStaleGroups({ store, mls: again.mls });
    expect(result).toEqual({ coordinates: [], groups: [] });
    expect(store.getMarmotGroup(COORD)?.mls_group_id).toBe(ids.mlsGroupIdHex);
  });

  it("purges an orphan legacy group no event row names (e.g. a stale link-confirmation group)", async () => {
    const { store, coordSk } = legacyStore();
    store.deleteMarmotGroup(COORD); // state present, no row
    const { mls } = createMarmotClientMls({ store, coordSk, network: new FakeNetwork() });
    const result = await retireStaleGroups({ store, mls });
    expect(result).toEqual({ coordinates: [], groups: [fixture.group.mlsGroupIdHex] });
    expect(await mls.storedGroupIds()).toEqual([]);
  });
});
