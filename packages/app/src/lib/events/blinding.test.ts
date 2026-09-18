/**
 * The blinding seed must never be MINTED on an unproven absence.
 *
 * It lives in a replaceable kind-30078, so publishing a fresh one overwrites the
 * stored one on every relay — unrecoverably. And it derives the blinded `d`
 * literals for the user's reuse library and per-event settings, so a new seed
 * silently orphans every intro they ever recorded and every "want to meet" they
 * ever ticked, on every device, with nothing on screen to say so.
 *
 * This path runs only for REMOTE signers (a local key derives the same secret
 * arithmetically), which is the population whose reads are slowest and most
 * likely to come back empty for reasons unrelated to the seed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { fetchEventsAnswered, publishOrQueue } = vi.hoisted(() => ({
  fetchEventsAnswered: vi.fn(),
  publishOrQueue: vi.fn(async () => true),
}));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEventsAnswered }));
vi.mock("$lib/nostr/publish-queue.js", () => ({ publishOrQueue }));

import {
  deriveBlindingKey,
  clearBlindingCache,
  BlindSeedUnavailableError,
} from "./blinding.js";
import {
  __setPersistBackend,
  __resetPersistForTests,
  hydrateAppCache,
  type CacheEntry,
  type PersistBackend,
} from "$lib/cache/persist.js";
import type { AppSigner } from "$lib/signer/types.js";

const PUBKEY = "a".repeat(64);

function memPersist(seed: Array<[string, CacheEntry]> = []): PersistBackend {
  const store = new Map<string, CacheEntry>(seed);
  return {
    async getAll() {
      return [...store.entries()];
    },
    async put(k, v) {
      store.set(k, v);
    },
    async delete(keys) {
      for (const k of keys) store.delete(k);
    },
  };
}

/** A remote signer: no `getSecretKey`, so the seed path is the one taken. */
function remoteSigner(over: Partial<AppSigner> = {}): AppSigner {
  return {
    method: "nip46",
    getPublicKey: async () => PUBKEY,
    nip44Encrypt: async (_p: string, plaintext: string) => `cipher:${plaintext}`,
    nip44Decrypt: async (_p: string, cipher: string) => cipher.replace(/^cipher:/, ""),
    signEvent: async (e: Record<string, unknown>) => ({ ...e, id: "x".repeat(64), sig: "s" }),
    ...over,
  } as unknown as AppSigner;
}

beforeEach(() => {
  clearBlindingCache();
  fetchEventsAnswered.mockReset();
  publishOrQueue.mockClear();
  __resetPersistForTests();
  __setPersistBackend(memPersist());
});

describe("blinding seed", () => {
  it("mints one only when a relay actually said there is none", async () => {
    fetchEventsAnswered.mockResolvedValue({ events: [], answered: true });
    const key = await deriveBlindingKey(remoteSigner());
    expect(key).toHaveLength(32);
    expect(publishOrQueue).toHaveBeenCalledTimes(1);
  });

  it("refuses when nobody answered, rather than replacing the stored seed", async () => {
    // An empty result with no EOSE is a read bounded by a timeout, not an
    // answer — offline, venue Wi-Fi, a relay still connecting.
    fetchEventsAnswered.mockResolvedValue({ events: [], answered: false });
    await expect(deriveBlindingKey(remoteSigner())).rejects.toBeInstanceOf(
      BlindSeedUnavailableError,
    );
    expect(publishOrQueue).not.toHaveBeenCalled();
  });

  it("refuses when the stored seed is there but will not decrypt", async () => {
    // The one case where "no seed" is definitely the wrong conclusion.
    fetchEventsAnswered.mockResolvedValue({
      events: [{ content: "cipher:whatever", created_at: 5 }],
      answered: true,
    });
    const signer = remoteSigner({
      nip44Decrypt: async () => {
        throw new Error("signer dropped the request");
      },
    });
    await expect(deriveBlindingKey(signer)).rejects.toThrow();
    expect(publishOrQueue).not.toHaveBeenCalled();
  });

  it("waits for the cache mirror before deciding the seed is missing", async () => {
    // Boot does not await IndexedDB, so a cold read here is the norm for the
    // first moment of every session — and it used to go straight on to mint.
    const stored: CacheEntry = { at: 5, touchedAt: 5, data: btoa("k".repeat(32)) };
    __setPersistBackend(memPersist([[`${PUBKEY}\x1fblindseed`, stored]]));
    fetchEventsAnswered.mockResolvedValue({ events: [], answered: true });

    const pending = deriveBlindingKey(remoteSigner());
    await hydrateAppCache();
    const key = await pending;

    expect(new TextDecoder().decode(key)).toBe("k".repeat(32));
    expect(publishOrQueue).not.toHaveBeenCalled();
    expect(fetchEventsAnswered).not.toHaveBeenCalled();
  });
});
