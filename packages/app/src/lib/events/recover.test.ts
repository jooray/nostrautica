/**
 * Fresh-device organizer recovery round-trip (audit G2 part 1). Proves the
 * "written but never read" 30078 eventkeys backup now round-trips: back up event
 * keys → wipe the device (empty keystore) → recover from relays → the event is
 * usable again (ECK + E_id/E_inbox custody restored) — and a second identity on
 * the same device does NOT inherit that custody.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  KIND_APP_DATA,
  KIND_EVENT_CONFIG,
  makeCoordinate,
  bytesToHex,
  bytesToBase64,
  generateEck,
  type EventKeysBackup,
} from "@nostrautica/protocol";

const { fetchEvents } = vi.hoisted(() => ({ fetchEvents: vi.fn() }));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents, fetchEventsRelayOnly: vi.fn() }));

import { LocalSigner } from "$lib/signer/local.js";
import {
  __setKeystoreBackend,
  setActiveOwner,
  loadEventKeys,
  currentEck,
  type EventKeys,
  type KeystoreBackend,
} from "./keystore.js";
import { recoverEventKeys, resetRecoveryGuard } from "./recover.js";

type Stored = EventKeys & { owner: string };
function memBackend() {
  const composite = new Map<string, Stored>();
  const k = (o: string, c: string) => `${o} ${c}`;
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
    async legacyGet() {
      return undefined;
    },
    async legacyList() {
      return [];
    },
    async legacyDelete() {},
  };
  return { backend, composite };
}

/** Build the self-encrypted 30078 eventkeys backup exactly as create.ts writes it. */
async function makeBackupEvent(
  organizer: LocalSigner,
  opts: { includeA: boolean },
): Promise<{ event: Record<string, unknown>; coordinate: string; eck: string }> {
  const eidSk = generateSecretKey();
  const einboxSk = generateSecretKey();
  const eidPk = getPublicKey(eidSk);
  const coordinate = makeCoordinate(eidPk, "cypherpunk-2026");
  const eckKey = bytesToBase64(generateEck());
  const backup: EventKeysBackup = {
    v: 1,
    ...(opts.includeA ? { a: coordinate } : {}),
    eid_nsec: bytesToHex(eidSk),
    einbox_nsec: bytesToHex(einboxSk),
    eck: [{ id: 1, key: eckKey }],
  };
  const pubkey = await organizer.getPublicKey();
  const content = await organizer.nip44Encrypt(pubkey, JSON.stringify(backup));
  const event = {
    kind: KIND_APP_DATA,
    pubkey,
    created_at: 1000,
    tags: [["d", "nostrautica:eventkeys:blinded-opaque"]],
    content,
  };
  return { event, coordinate, eck: eckKey };
}

describe("recoverEventKeys round-trip", () => {
  beforeEach(() => {
    fetchEvents.mockReset();
    resetRecoveryGuard();
  });

  it("restores organizer custody from the 30078 backup onto a wiped device", async () => {
    const organizer = LocalSigner.generate();
    const owner = await organizer.getPublicKey();
    const { event, coordinate, eck } = await makeBackupEvent(organizer, { includeA: true });

    fetchEvents.mockResolvedValue([event]);

    // Wiped device: fresh keystore, this identity active, nothing stored yet.
    const mem = memBackend();
    __setKeystoreBackend(mem.backend);
    setActiveOwner(owner);
    expect(await loadEventKeys(coordinate)).toBeUndefined();

    const restored = await recoverEventKeys(organizer);
    expect(restored).toEqual([coordinate]);

    // Event usable again: full organizer custody recovered.
    const keys = await loadEventKeys(coordinate);
    expect(keys?.role).toBe("organizer");
    expect(keys?.eidNsecHex).toBeDefined();
    expect(keys?.einboxNsecHex).toBeDefined();
    expect(currentEck(keys)?.key).toBe(eck);

    // A different identity on the same device inherits nothing.
    setActiveOwner("f".repeat(64));
    expect(await loadEventKeys(coordinate)).toBeUndefined();
  });

  it("derives the coordinate from the published config when the backup omits `a`", async () => {
    const organizer = LocalSigner.generate();
    const owner = await organizer.getPublicKey();
    const { event, coordinate } = await makeBackupEvent(organizer, { includeA: false });
    const eidPubkey = coordinate.split(":")[1];

    fetchEvents.mockImplementation(async (filter: { kinds?: number[] }) => {
      if (filter.kinds?.includes(KIND_APP_DATA)) return [event];
      if (filter.kinds?.includes(KIND_EVENT_CONFIG)) {
        return [
          { kind: KIND_EVENT_CONFIG, pubkey: eidPubkey, created_at: 1, tags: [["d", "cypherpunk-2026"]] },
        ];
      }
      return [];
    });

    const mem = memBackend();
    __setKeystoreBackend(mem.backend);
    setActiveOwner(owner);

    const restored = await recoverEventKeys(organizer);
    expect(restored).toEqual([coordinate]);
    expect((await loadEventKeys(coordinate))?.role).toBe("organizer");
  });

  it("ignores unrelated 30078s and undecryptable backups", async () => {
    const organizer = LocalSigner.generate();
    const owner = await organizer.getPublicKey();
    const stranger = LocalSigner.generate();
    const { event } = await makeBackupEvent(stranger, { includeA: true }); // encrypted to someone else

    fetchEvents.mockResolvedValue([
      { kind: KIND_APP_DATA, pubkey: owner, created_at: 1, tags: [["d", "nostrautica:blindseed"]], content: "x" },
      { ...event, pubkey: owner }, // eventkeys d, but not decryptable by owner
    ]);

    const mem = memBackend();
    __setKeystoreBackend(mem.backend);
    setActiveOwner(owner);

    const restored = await recoverEventKeys(organizer);
    expect(restored).toEqual([]);
  });
});
