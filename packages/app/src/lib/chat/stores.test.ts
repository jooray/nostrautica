import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  InMemoryKvBackend,
  IndexedDbKvBackend,
  namespacedStore,
  makeMarmotStores,
  MARMOT_NAMESPACES,
  __resetMarmotIdbConnectionForTests,
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

  it("eventGroupStore binds event coordinates per identity, not across identities (APPK-3)", async () => {
    const backend = new InMemoryKvBackend();
    const a = makeMarmotStores(backend, idA).eventGroupStore;
    const b = makeMarmotStores(backend, idB).eventGroupStore;
    const coordA = "31923:" + "e".repeat(64) + ":event-a";
    const coordB = "31923:" + "f".repeat(64) + ":event-b";

    await a.setItem(coordA, "gid-a");
    await a.setItem(coordB, "gid-b");
    // One identity can hold a binding per event…
    expect(await a.getItem(coordA)).toBe("gid-a");
    expect(await a.getItem(coordB)).toBe("gid-b");
    // …and the same coordinate under another identity is independent.
    expect(await b.getItem(coordA)).toBeNull();
    await b.setItem(coordA, "gid-other");
    expect(await a.getItem(coordA)).toBe("gid-a");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IndexedDbKvBackend: durability, not just "the request said ok"
// ─────────────────────────────────────────────────────────────────────────────
/**
 * A deliberately small IndexedDB double. It models the one behaviour that makes
 * the production backend's old shape wrong: a REQUEST reports success while its
 * TRANSACTION later aborts. That split is not a corner of the spec — it is how
 * IndexedDB reports a commit-time failure (disk pressure, several quota paths),
 * and the only correct completion signal is `transaction.oncomplete`.
 *
 * The real `fake-indexeddb` package would not help here: it implements a storage
 * engine that works, and the failure under test is the engine failing at commit.
 */
class FakeIdb {
  openCalls = 0;
  /** Abort the transaction at commit time, AFTER every request reported success. */
  failCommit = false;
  /** Answer `open` with `blocked` (another tab holds an older version open). */
  blockOpen = false;
  data = new Map<string, unknown>();
  /** Connections handed out, so a test can drive `versionchange` like a real tab. */
  connections: FakeDb[] = [];

  open(_name: string, _version: number): FakeIdbRequest {
    this.openCalls++;
    const req: FakeIdbRequest = { result: undefined };
    queueMicrotask(() => {
      if (this.blockOpen) {
        req.onblocked?.();
        return;
      }
      const db = new FakeDb(this);
      this.connections.push(db);
      req.result = db;
      req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  }
}

interface FakeIdbRequest {
  result: unknown;
  onsuccess?: () => void;
  onerror?: () => void;
  onblocked?: () => void;
  onupgradeneeded?: () => void;
  error?: unknown;
}

class FakeDb {
  objectStoreNames = { contains: () => true };
  closed = false;
  onversionchange?: () => void;
  onclose?: () => void;
  constructor(private readonly idb: FakeIdb) {}
  createObjectStore(): void {}
  close(): void {
    this.closed = true;
  }
  transaction(_store: string, _mode: string): FakeTx {
    if (this.closed) throw new Error("InvalidStateError: connection is closed");
    return new FakeTx(this.idb);
  }
}

class FakeTx {
  error: unknown = null;
  oncomplete?: () => void;
  onabort?: () => void;
  onerror?: () => void;
  private readonly requests: FakeIdbRequest[] = [];
  constructor(private readonly idb: FakeIdb) {
    // Real transactions settle in a later task, after every request has run.
    queueMicrotask(() =>
      queueMicrotask(() => {
        if (this.idb.failCommit) {
          this.error = new Error("QuotaExceededError");
          this.onabort?.();
        } else {
          this.oncomplete?.();
        }
      }),
    );
  }
  objectStore(): FakeStore {
    return new FakeStore(this.idb, this.requests);
  }
}

class FakeStore {
  constructor(
    private readonly idb: FakeIdb,
    private readonly requests: FakeIdbRequest[],
  ) {}
  private request(run: () => unknown): FakeIdbRequest {
    const req: FakeIdbRequest = { result: undefined };
    this.requests.push(req);
    queueMicrotask(() => {
      req.result = run();
      // Success is reported EVEN WHEN the commit will later abort — that is the
      // whole point of this double.
      req.onsuccess?.();
    });
    return req;
  }
  get(key: string): FakeIdbRequest {
    return this.request(() => this.idb.data.get(key));
  }
  put(value: unknown, key: string): FakeIdbRequest {
    return this.request(() => {
      // Staged, not committed. A real abort would roll this back; the double
      // keeps it, so a test asserting on the RESOLUTION can't accidentally pass
      // because the value vanished.
      this.idb.data.set(key, value);
      return undefined;
    });
  }
  delete(key: string): FakeIdbRequest {
    return this.request(() => {
      this.idb.data.delete(key);
      return undefined;
    });
  }
  getAllKeys(): FakeIdbRequest {
    return this.request(() => [...this.idb.data.keys()]);
  }
}

describe("IndexedDbKvBackend (durability + connection lifecycle)", () => {
  let fake: FakeIdb;
  const g = globalThis as unknown as { indexedDB?: unknown; IDBKeyRange?: unknown };
  const originalIdb = g.indexedDB;
  const originalRange = g.IDBKeyRange;

  beforeEach(() => {
    fake = new FakeIdb();
    g.indexedDB = fake;
    g.IDBKeyRange = { bound: (lower: string, upper: string) => ({ lower, upper }) };
    __resetMarmotIdbConnectionForTests();
  });

  afterEach(() => {
    g.indexedDB = originalIdb;
    g.IDBKeyRange = originalRange;
    __resetMarmotIdbConnectionForTests();
  });

  it("round-trips through the real backend", async () => {
    const backend = new IndexedDbKvBackend();
    await backend.set("k", { n: 1 });
    expect(await backend.get("k")).toEqual({ n: 1 });
    await backend.del("k");
    expect(await backend.get("k")).toBeUndefined();
  });

  // THE regression. `setItem` resolving on `req.onsuccess` means marmot records an
  // MLS epoch as persisted that the transaction then threw away at commit. The next
  // load restores the previous epoch and every message from the missing one is
  // undecryptable — indistinguishable from eviction, except rejoining doesn't help
  // because the next write fails the same way.
  it("REJECTS a write whose transaction aborts at commit, even though the request succeeded", async () => {
    const backend = new IndexedDbKvBackend();
    fake.failCommit = true;
    await expect(backend.set("epoch", { epoch: 7 })).rejects.toThrow(/QuotaExceeded/);
  });

  it("rejects a read from an aborted transaction rather than returning its staged value", async () => {
    const backend = new IndexedDbKvBackend();
    await backend.set("k", "value");
    fake.failCommit = true;
    await expect(backend.get("k")).rejects.toThrow(/QuotaExceeded/);
  });

  it("opens ONE connection and reuses it across operations", async () => {
    const backend = new IndexedDbKvBackend();
    await backend.set("a", 1);
    await backend.set("b", 2);
    await backend.get("a");
    await backend.keysWithPrefix("");
    expect(fake.openCalls).toBe(1);
  });

  it("closes and re-opens when another tab needs a version change", async () => {
    const backend = new IndexedDbKvBackend();
    await backend.set("a", 1);
    expect(fake.openCalls).toBe(1);
    // Another tab is upgrading: without this handler OUR connection keeps its
    // `blocked` request pending forever and that tab's chat hangs with no error.
    fake.connections[0].onversionchange?.();
    expect(fake.connections[0].closed).toBe(true);
    await backend.set("b", 2);
    expect(fake.openCalls).toBe(2);
  });

  it("rejects (rather than hanging forever) when the open is blocked by another tab", async () => {
    const backend = new IndexedDbKvBackend();
    fake.blockOpen = true;
    await expect(backend.get("k")).rejects.toThrow(/blocked/);
    // The cached connection was dropped, so a retry after the other tab lets go
    // actually re-opens instead of replaying the same rejected promise.
    fake.blockOpen = false;
    await backend.set("k", 1);
    expect(await backend.get("k")).toBe(1);
  });
});
