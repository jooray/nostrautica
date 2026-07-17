import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { Store } from "../store/db.js";
import {
  encodeValue,
  decodeValue,
  sqliteStore,
  makeMarmotStores,
  MARMOT_NAMESPACES,
} from "./stores.js";

const ENC_PREFIX = "nip44:";

/** Read the raw (still-encrypted) marmot_kv value column, bypassing reveal(). */
function rawKv(store: Store, namespace: string, key: string): string | undefined {
  const row = (store as any).db
    .prepare("SELECT v FROM marmot_kv WHERE namespace = ? AND k = ?")
    .get(namespace, key) as { v: string } | undefined;
  return row?.v;
}

describe("structured-clone codec (encodeValue/decodeValue)", () => {
  it("round-trips a bare Uint8Array (group-state value shape)", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const back = decodeValue<Uint8Array>(encodeValue(bytes));
    expect(back).toBeInstanceOf(Uint8Array);
    expect([...back]).toEqual([0, 1, 2, 250, 255]);
  });

  it("round-trips nested Uint8Array, bigint, arrays and plain fields (key-package shape)", () => {
    const value = {
      keyPackageRef: new Uint8Array([9, 8, 7]),
      publicPackage: { epoch: 42n, leaf: { sig: new Uint8Array([1, 2, 3]) } },
      published: [{ id: "abc", kind: 30443 }],
      used: false,
      name: "kp",
    };
    const back = decodeValue<typeof value>(encodeValue(value));
    expect(back.keyPackageRef).toBeInstanceOf(Uint8Array);
    expect([...back.keyPackageRef]).toEqual([9, 8, 7]);
    expect(back.publicPackage.epoch).toBe(42n);
    expect([...back.publicPackage.leaf.sig]).toEqual([1, 2, 3]);
    expect(back.published[0]!.kind).toBe(30443);
    expect(back.used).toBe(false);
    expect(back.name).toBe("kp");
  });
});

describe("sqliteStore (GenericKeyValueStore over encrypted SQLite)", () => {
  it("round-trips values and returns null (not undefined) for a miss", async () => {
    const store = new Store(":memory:", generateSecretKey());
    const kv = sqliteStore<{ n: number }>(store, MARMOT_NAMESPACES.groupState);
    expect(await kv.getItem("missing")).toBeNull();
    const ret = await kv.setItem("g1", { n: 1 });
    expect(ret).toEqual({ n: 1 });
    expect(await kv.getItem("g1")).toEqual({ n: 1 });
    await kv.removeItem("g1");
    expect(await kv.getItem("g1")).toBeNull();
  });

  it("keys()/clear() are scoped to the namespace", async () => {
    const store = new Store(":memory:", generateSecretKey());
    const gs = sqliteStore<number>(store, MARMOT_NAMESPACES.groupState);
    const kp = sqliteStore<number>(store, MARMOT_NAMESPACES.keyPackage);
    await gs.setItem("one", 1);
    await gs.setItem("two", 2);
    await kp.setItem("three", 3);
    expect((await gs.keys()).sort()).toEqual(["one", "two"]);
    expect(await kp.keys()).toEqual(["three"]);
    await gs.clear();
    expect(await gs.keys()).toEqual([]);
    expect(await kp.keys()).toEqual(["three"]); // other namespace untouched
  });

  it("ENCRYPTS the MLS state at rest — ciphertext in the column, plaintext never", async () => {
    const store = new Store(":memory:", generateSecretKey());
    const kv = sqliteStore<Uint8Array>(store, MARMOT_NAMESPACES.groupState);
    // A recognizable plaintext marker inside the serialized MLS state.
    const secret = new TextEncoder().encode("SUPER-SECRET-MLS-STATE");
    await kv.setItem("group-1", secret);

    const raw = rawKv(store, MARMOT_NAMESPACES.groupState, "group-1")!;
    expect(raw.startsWith(ENC_PREFIX)).toBe(true); // NIP-44 marker
    expect(raw).not.toContain("SUPER-SECRET-MLS-STATE"); // plaintext absent
    expect(raw).not.toContain("U1VQRVI"); // base64 of the marker absent too

    // …but reveal() through the store decrypts it losslessly.
    const back = await kv.getItem("group-1");
    expect(back).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(back!)).toBe("SUPER-SECRET-MLS-STATE");
  });

  it("makeMarmotStores exposes the four isolated namespaces", async () => {
    const store = new Store(":memory:", generateSecretKey());
    const s = makeMarmotStores(store);
    await s.groupStateStore.setItem("a", new Uint8Array([1]));
    await s.rewindStore.setItem("a", new Uint8Array([2]));
    expect([...(await s.groupStateStore.getItem("a"))!]).toEqual([1]);
    expect([...(await s.rewindStore.getItem("a"))!]).toEqual([2]); // same key, distinct store
  });
});
