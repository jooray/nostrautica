/**
 * Owner-scoped keystore (audit G2 part 2). Records are keyed by [owner, coordinate]
 * so two identities on one device never collide. Legacy coordinate-only records
 * are NEVER auto-adopted (audit APPK-6): adoption would hand custody to whichever
 * identity read first — recovery goes through the relay backup (recover.ts).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  __setKeystoreBackend,
  setActiveOwner,
  saveEventKeys,
  loadEventKeys,
  listEventKeys,
  addEckVersions,
  applyOrganizerGrant,
  currentEck,
  lockEventKeysForLogout,
  unlockEventKeysForLogin,
  type EventKeys,
  type KeystoreBackend,
  type LockedEventKeys,
} from "./keystore.js";

type Stored = EventKeys & { owner: string };

/** In-memory backend (the test env has no IndexedDB). */
function memBackend() {
  const composite = new Map<string, Stored>();
  const legacy = new Map<string, EventKeys>();
  const locked = new Map<string, LockedEventKeys>();
  const k = (o: string, c: string) => `${o}\x1f${c}`;
  const backend: KeystoreBackend = {
    async get(o, c) {
      return composite.get(k(o, c));
    },
    async put(rec) {
      composite.set(k(rec.owner, rec.coordinate), { ...rec });
    },
    async list(o) {
      return [...composite.values()].filter((r) => r.owner === o);
    },
    async delete(o, c) {
      composite.delete(k(o, c));
    },
    async legacyGet(c) {
      return legacy.get(c);
    },
    async legacyList() {
      return [...legacy.values()];
    },
    async legacyDelete(c) {
      legacy.delete(c);
    },
    async lockedPut(rec) {
      locked.set(k(rec.owner, rec.coordinate), { ...rec });
    },
    async lockedList(o) {
      return [...locked.values()].filter((r) => r.owner === o);
    },
    async lockedDelete(o, c) {
      locked.delete(k(o, c));
    },
  };
  return { backend, composite, legacy, locked };
}

const A = "a".repeat(64);
const B = "b".repeat(64);
const COORD = "31923:" + "e".repeat(64) + ":my-event";

function organizerKeys(coord = COORD): EventKeys {
  return {
    coordinate: coord,
    role: "organizer",
    eck: [{ id: 1, key: "k1" }],
    eidNsecHex: "1".repeat(64),
    einboxNsecHex: "2".repeat(64),
  };
}

describe("keystore owner scoping", () => {
  let mem: ReturnType<typeof memBackend>;
  beforeEach(() => {
    mem = memBackend();
    __setKeystoreBackend(mem.backend);
    setActiveOwner(A);
  });

  it("keeps two identities' records separate on one device", async () => {
    await saveEventKeys(organizerKeys());
    expect((await loadEventKeys(COORD))?.role).toBe("organizer");

    // Switch identity: B must not see A's custody.
    setActiveOwner(B);
    expect(await loadEventKeys(COORD)).toBeUndefined();
    await saveEventKeys({ coordinate: COORD, role: "attendee", eck: [{ id: 1, key: "kB" }] });
    expect((await loadEventKeys(COORD))?.role).toBe("attendee");

    // Back to A: their organizer record is intact, not clobbered by B.
    setActiveOwner(A);
    const a = await loadEventKeys(COORD);
    expect(a?.role).toBe("organizer");
    expect(a?.eidNsecHex).toBe("1".repeat(64));
  });

  it("reads/writes with no active identity are safe", async () => {
    setActiveOwner(null);
    expect(await loadEventKeys(COORD)).toBeUndefined();
    expect(await listEventKeys()).toEqual([]);
    await expect(saveEventKeys(organizerKeys())).rejects.toThrow();
  });

  it("addEckVersions merges under the active owner", async () => {
    await addEckVersions(COORD, [{ id: 1, key: "k1" }], "attendee");
    await addEckVersions(COORD, [{ id: 2, key: "k2" }], "attendee");
    const keys = await loadEventKeys(COORD);
    expect(keys?.eck.map((v) => v.id)).toEqual([1, 2]);
    expect(currentEck(keys)?.id).toBe(2);
    // B holds nothing for this coordinate.
    setActiveOwner(B);
    expect(await loadEventKeys(COORD)).toBeUndefined();
  });
});

describe("keystore legacy records (audit APPK-6)", () => {
  let mem: ReturnType<typeof memBackend>;
  beforeEach(() => {
    mem = memBackend();
    __setKeystoreBackend(mem.backend);
    setActiveOwner(A);
  });

  it("does NOT adopt a legacy coordinate-only record into the reading owner", async () => {
    mem.legacy.set(COORD, organizerKeys()); // pre-scoping record, no owner
    // A (who may well be the legit owner) gets nothing — custody must be
    // re-established from the relay backup (recover.ts), which proves ownership.
    expect(await loadEventKeys(COORD)).toBeUndefined();
    // The legacy record is left in place (not consumed, not deleted)…
    expect(mem.legacy.has(COORD)).toBe(true);
    // …and never copied into ANY owner's scoped store.
    expect(await mem.backend.get(A, COORD)).toBeUndefined();
    // A different identity on the same device inherits nothing either.
    setActiveOwner(B);
    expect(await loadEventKeys(COORD)).toBeUndefined();
    expect(await mem.backend.get(B, COORD)).toBeUndefined();
  });

  it("listEventKeys ignores leftover legacy records (and leaves them in place)", async () => {
    mem.legacy.set(COORD, organizerKeys());
    const list = await listEventKeys();
    expect(list.map((k) => k.coordinate)).not.toContain(COORD);
    expect(mem.legacy.size).toBe(1);
  });
});

describe("applyOrganizerGrant (audit APPK-4)", () => {
  let mem: ReturnType<typeof memBackend>;
  beforeEach(() => {
    mem = memBackend();
    __setKeystoreBackend(mem.backend);
    setActiveOwner(A);
  });

  it("unions ECK versions: a stale 21605 (v1) after a fresh 21602 (v2) keeps v2", async () => {
    // Fresh 21602 key grant lands first, carrying ECK v2.
    await addEckVersions(COORD, [{ id: 2, key: "k2" }], "attendee");
    // Authentic-but-stale 21605 organizer grant arrives later, carrying only v1.
    await applyOrganizerGrant(COORD, {
      eck: [{ id: 1, key: "k1" }],
      eidNsecHex: "1".repeat(64),
      einboxNsecHex: "2".repeat(64),
    });
    const keys = await loadEventKeys(COORD);
    // The version set only ever GROWS — v2 survives.
    expect(keys?.eck.map((v) => v.id)).toEqual([1, 2]);
    expect(currentEck(keys)?.id).toBe(2);
    // Role + custody secrets DO update from the grant.
    expect(keys?.role).toBe("organizer");
    expect(keys?.eidNsecHex).toBe("1".repeat(64));
    expect(keys?.einboxNsecHex).toBe("2".repeat(64));
  });

  it("creates the organizer record when none exists yet", async () => {
    await applyOrganizerGrant(COORD, {
      eck: [{ id: 1, key: "k1" }],
      eidNsecHex: "1".repeat(64),
      einboxNsecHex: "2".repeat(64),
    });
    const keys = await loadEventKeys(COORD);
    expect(keys?.role).toBe("organizer");
    expect(keys?.eck.map((v) => v.id)).toEqual([1]);
  });
});

describe("lockEventKeysForLogout / unlockEventKeysForLogin (audit UX-6)", () => {
  let mem: ReturnType<typeof memBackend>;
  beforeEach(() => {
    mem = memBackend();
    __setKeystoreBackend(mem.backend);
    setActiveOwner(A);
  });

  // Stand-in for the caller's real self-encrypt (NIP-44 to the owner's own
  // pubkey) — the crypto itself is proven in packages/protocol; these tests
  // only need something reversible to prove the lock/unlock plumbing.
  const selfEncrypt = async (pt: string) => `enc:${pt}`;
  const selfDecrypt = async (ct: string) => {
    if (!ct.startsWith("enc:")) throw new Error("bad ciphertext");
    return ct.slice(4);
  };

  it("moves a live record into an encrypted snapshot and clears the plaintext", async () => {
    await saveEventKeys(organizerKeys());
    await lockEventKeysForLogout(selfEncrypt, selfDecrypt);
    expect(await mem.backend.get(A, COORD)).toBeUndefined();
    expect(mem.locked.size).toBe(1);
    const snap = [...mem.locked.values()][0]!;
    expect(snap.owner).toBe(A);
    expect(snap.coordinate).toBe(COORD);
    // Passed through the caller's encrypt function, not copied raw (real
    // opacity — NIP-44 self-encryption — is proven in packages/protocol).
    expect(snap.ciphertext.startsWith("enc:")).toBe(true);
  });

  it("round-trips: lock then unlock restores the exact record", async () => {
    await saveEventKeys(organizerKeys());
    await lockEventKeysForLogout(selfEncrypt, selfDecrypt);
    await unlockEventKeysForLogin(selfDecrypt);
    const keys = await loadEventKeys(COORD);
    expect(keys?.role).toBe("organizer");
    expect(keys?.eidNsecHex).toBe("1".repeat(64));
    expect(keys?.einboxNsecHex).toBe("2".repeat(64));
    expect(keys?.eck.map((v) => v.id)).toEqual([1]);
    // The snapshot is consumed — the live record is the source of truth again.
    expect(mem.locked.size).toBe(0);
  });

  it("a record that fails to encrypt is left in plaintext, not lost", async () => {
    await saveEventKeys(organizerKeys());
    await lockEventKeysForLogout(async () => {
      throw new Error("signer unreachable");
    }, selfDecrypt);
    expect(await loadEventKeys(COORD)).toBeDefined();
    expect(mem.locked.size).toBe(0);
  });

  it("a snapshot that fails to decrypt (wrong/no signer yet) is left locked, not lost", async () => {
    await saveEventKeys(organizerKeys());
    await lockEventKeysForLogout(selfEncrypt, selfDecrypt);
    await unlockEventKeysForLogin(async () => {
      throw new Error("wrong owner");
    });
    expect(await loadEventKeys(COORD)).toBeUndefined();
    expect(mem.locked.size).toBe(1);
  });

  it("unlock unions ECK versions instead of clobbering a fresher live write", async () => {
    await saveEventKeys(organizerKeys()); // eck v1, organizer
    await lockEventKeysForLogout(selfEncrypt, selfDecrypt);
    // A 21602 grant landed right after login, before the unlock finished.
    await saveEventKeys({ coordinate: COORD, role: "attendee", eck: [{ id: 2, key: "k2" }] });
    await unlockEventKeysForLogin(selfDecrypt);
    const keys = await loadEventKeys(COORD);
    expect(keys?.eck.map((v) => v.id)).toEqual([1, 2]);
    // Organizer authority from the snapshot is never downgraded by the race.
    expect(keys?.role).toBe("organizer");
  });

  // The key-loss chain found in review, reproduced end to end. Every step here
  // is a normal thing that happens; only the combination destroys the keys.
  it("a logout after a FAILED unlock merges into the snapshot instead of clobbering it", async () => {
    // 1. Organizer logs out normally: full record (E_id + E_inbox + eck v1) locked.
    await saveEventKeys(organizerKeys());
    await lockEventKeysForLogout(selfEncrypt, selfDecrypt);
    expect(mem.locked.size).toBe(1);

    // 2. Next login, the NIP-46 signer is unreachable — unlock fails, so the
    //    snapshot correctly stays locked and the live store stays empty.
    await unlockEventKeysForLogin(async () => {
      throw new Error("signer unreachable");
    });
    expect(await loadEventKeys(COORD)).toBeUndefined();
    expect(mem.locked.size).toBe(1);

    // 3. A 21602 grant lands and writes a STUB live record: one ECK, no nsecs.
    await saveEventKeys({ coordinate: COORD, role: "attendee", eck: [{ id: 2, key: "k2" }] });

    // 4. The user logs out again. Locking the stub over the snapshot is what
    //    used to destroy E_id/E_inbox locally.
    await lockEventKeysForLogout(selfEncrypt, selfDecrypt);

    // 5. Signer is back: unlock must return the organizer INTACT.
    await unlockEventKeysForLogin(selfDecrypt);
    const restored = await loadEventKeys(COORD);
    expect(restored?.eidNsecHex).toBe(organizerKeys().eidNsecHex); // the whole point
    expect(restored?.einboxNsecHex).toBe(organizerKeys().einboxNsecHex);
    expect(restored?.role).toBe("organizer"); // authority not downgraded by the stub
    expect(restored?.eck.map((v) => v.id).sort()).toEqual([1, 2]); // both ECKs survive
  });

  it("locking is scoped to the active owner only", async () => {
    await saveEventKeys(organizerKeys());
    setActiveOwner(B);
    await saveEventKeys({ coordinate: COORD, role: "attendee", eck: [{ id: 1, key: "kB" }] });
    await lockEventKeysForLogout(selfEncrypt, selfDecrypt); // locks B only
    expect(mem.locked.size).toBe(1);
    expect([...mem.locked.values()][0]!.owner).toBe(B);
    setActiveOwner(A);
    expect(await loadEventKeys(COORD)).toBeDefined(); // A's plaintext untouched
  });
});
