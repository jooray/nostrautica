import { describe, it, expect } from "vitest";
import {
  InMemoryKvBackend,
  namespacedStore,
  makeMarmotStores,
  MARMOT_NAMESPACES,
} from "./stores.js";
import type { StoredKeyPackage, StoredInviteEntry } from "@internet-privacy/marmot-ts/client";

const idA = "a".repeat(64);
const idB = "b".repeat(64);

describe("namespacedStore (GenericKeyValueStore contract)", () => {
  it("round-trips values and returns null (not undefined) for a miss", async () => {
    const store = namespacedStore<{ n: number }>(new InMemoryKvBackend(), idA, "group-state");
    expect(await store.getItem("missing")).toBeNull();
    const ret = await store.setItem("g1", { n: 1 });
    expect(ret).toEqual({ n: 1 }); // setItem returns the stored value
    expect(await store.getItem("g1")).toEqual({ n: 1 });
    await store.removeItem("g1");
    expect(await store.getItem("g1")).toBeNull();
  });

  it("keys() returns un-prefixed keys, scoped to this namespace", async () => {
    const backend = new InMemoryKvBackend();
    const gs = namespacedStore<number>(backend, idA, "group-state");
    const kp = namespacedStore<number>(backend, idA, "key-package");
    await gs.setItem("one", 1);
    await gs.setItem("two", 2);
    await kp.setItem("three", 3);
    expect((await gs.keys()).sort()).toEqual(["one", "two"]);
    expect(await kp.keys()).toEqual(["three"]); // other namespace not leaked
  });

  it("clear() wipes only the calling store's namespace", async () => {
    const backend = new InMemoryKvBackend();
    const gs = namespacedStore<number>(backend, idA, "group-state");
    const kp = namespacedStore<number>(backend, idA, "key-package");
    await gs.setItem("x", 1);
    await kp.setItem("y", 2);
    await gs.clear();
    expect(await gs.keys()).toEqual([]);
    expect(await kp.getItem("y")).toBe(2); // sibling namespace survives
  });

  it("isolates state per chat identity (§5 per-identity namespacing)", async () => {
    const backend = new InMemoryKvBackend();
    const a = namespacedStore<string>(backend, idA, "group-state");
    const b = namespacedStore<string>(backend, idB, "group-state");
    await a.setItem("k", "alice");
    await b.setItem("k", "bob");
    expect(await a.getItem("k")).toBe("alice");
    expect(await b.getItem("k")).toBe("bob"); // same key, different identity
    await a.clear();
    expect(await a.getItem("k")).toBeNull();
    expect(await b.getItem("k")).toBe("bob"); // clearing A leaves B intact
  });

  it("stores by value, not by reference (structured-clone semantics)", async () => {
    const store = namespacedStore<{ arr: number[] }>(new InMemoryKvBackend(), idA, "group-state");
    const input = { arr: [1, 2, 3] };
    await store.setItem("k", input);
    input.arr.push(4); // mutate caller's copy after storing
    expect((await store.getItem("k"))?.arr).toEqual([1, 2, 3]);
  });

  it("preserves Uint8Array values (rewind store type)", async () => {
    const store = namespacedStore<Uint8Array>(new InMemoryKvBackend(), idA, MARMOT_NAMESPACES.rewind);
    const bytes = new Uint8Array([9, 8, 7, 0, 255]);
    await store.setItem("tree", bytes);
    const back = await store.getItem("tree");
    expect(back).toBeInstanceOf(Uint8Array);
    expect(Array.from(back!)).toEqual([9, 8, 7, 0, 255]);
  });
});

describe("makeMarmotStores", () => {
  it("builds the four marmot stores over one backend, mutually isolated", async () => {
    const backend = new InMemoryKvBackend();
    const stores = makeMarmotStores(backend, idA);
    await stores.groupStateStore.setItem("g", new Uint8Array([1])); // SerializedClientState = Uint8Array
    await stores.keyPackageStore.setItem("kp", { slot: "d1" } as unknown as StoredKeyPackage);
    await stores.rewindStore.setItem("r", new Uint8Array([1]));
    await stores.inviteStore.setItem("i", { id: "x" } as unknown as StoredInviteEntry);
    expect(await stores.groupStateStore.keys()).toEqual(["g"]);
    expect(await stores.keyPackageStore.keys()).toEqual(["kp"]);
    expect(await stores.rewindStore.keys()).toEqual(["r"]);
    expect(await stores.inviteStore.keys()).toEqual(["i"]);
  });
});
