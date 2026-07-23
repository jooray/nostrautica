import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  selfConversationKey,
  mediaDescriptorSchema,
  MAX_LIBRARY_TEXTS,
  type MediaDescriptor,
} from "@nostrautica/protocol";

// The reuse library lives in a single per-user 31602 event. We mock the relay
// layer so publishOrQueue records the latest library event and fetchEvents serves
// it straight back — exercising the real NIP-44 self-encrypt/decrypt + merge logic
// end to end (same relay-mock pattern as posts.test.ts).
const published: { kind: number; tags: string[][]; content: string; created_at: number }[] = [];
const { fetchEvents } = vi.hoisted(() => ({ fetchEvents: vi.fn() }));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents, fetchEventsRelayOnly: vi.fn() }));
vi.mock("$lib/nostr/publish-queue.js", () => ({
  publishOrQueue: vi.fn(async (ev: { kind: number; tags: string[][]; content: string; created_at: number }) => {
    published.push(ev);
  }),
}));

import { addToLibrary, loadLibraryFull, loadLibrary } from "./submit.js";
import { LocalSigner } from "$lib/signer/local.js";
import {
  __setPersistBackend,
  __resetPersistForTests,
  setActiveCacheOwner,
  type CacheEntry,
  type PersistBackend,
} from "$lib/cache/persist.js";

function memPersist(): PersistBackend {
  const store = new Map<string, CacheEntry>();
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

/** Serve the newest library event of the given d-tag back through fetchEvents. */
function serveLatestLibrary(): void {
  fetchEvents.mockImplementation(async (filter: { "#d"?: string[] }) => {
    const d = filter["#d"]?.[0];
    const matching = published.filter((e) => e.tags.some((t) => t[0] === "d" && t[1] === d));
    return matching.slice(-1); // loader takes the newest; last published wins
  });
}

/** A valid intro media descriptor with a distinct ciphertext hash `x`. */
function descriptor(x: string, mime = "video/webm"): MediaDescriptor {
  return mediaDescriptorSchema.parse({
    kind: "intro",
    url: ["https://blossom.example/blob"],
    x,
    ox: "b".repeat(64),
    size: 1024,
    m: mime,
    duration: 12,
    "encryption-algorithm": "aes-gcm",
    "decryption-key": "A".repeat(43) + "=", // 44 chars → 32-byte base64
    "decryption-nonce": "B".repeat(16), // 16 chars, no pad → 12-byte base64
  });
}

describe("cross-event reuse library (media + text)", () => {
  let signer: LocalSigner;
  let bk: Uint8Array;

  beforeEach(async () => {
    published.length = 0;
    __resetPersistForTests();
    __setPersistBackend(memPersist());
    signer = LocalSigner.generate();
    setActiveCacheOwner(await signer.getPublicKey());
    // The library d-tag is blinded over the user's self-conversation key.
    bk = selfConversationKey(signer.getSecretKey());
    serveLatestLibrary();
  });

  it("round-trips a recorded intro AND an authored text through one library entry", async () => {
    await addToLibrary(signer, bk, { media: [descriptor("a".repeat(64))] });
    await addToLibrary(signer, bk, { texts: ["Hi, I build Nostr tools."] });

    const lib = await loadLibraryFull(signer, bk);
    expect(lib.media.map((m) => m.x)).toEqual(["a".repeat(64)]);
    expect(lib.texts).toEqual(["Hi, I build Nostr tools."]);
    // The media-only shim still works for callers (e.g. Join.svelte).
    expect(await loadLibrary(signer, bk)).toHaveLength(1);
  });

  it("stores media + text in the SAME 31602 entry (one d-tag, not two events)", async () => {
    await addToLibrary(signer, bk, {
      media: [descriptor("c".repeat(64))],
      texts: ["one shared entry"],
    });
    // A single library write: media and text share the a:null entry.
    expect(published).toHaveLength(1);
    const dTags = new Set(published[0]!.tags.filter((t) => t[0] === "d").map((t) => t[1]));
    expect(dTags.size).toBe(1);
  });

  it("does not leak the source event: the stored content carries a:null, no coordinate", async () => {
    await addToLibrary(signer, bk, { texts: ["portable intro"] });
    const pubkey = await signer.getPublicKey();
    const plaintext = await signer.nip44Decrypt(pubkey, published.at(-1)!.content);
    const parsed = JSON.parse(plaintext);
    // The cross-event store must never record WHICH event a text was authored for.
    expect(parsed.a).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain("31923"); // no event coordinate anywhere
  });

  it("dedups an identical text and bumps it to most-recent instead of duplicating", async () => {
    await addToLibrary(signer, bk, { texts: ["alpha"] });
    await addToLibrary(signer, bk, { texts: ["beta"] });
    await addToLibrary(signer, bk, { texts: ["alpha"] }); // re-add alpha

    const lib = await loadLibraryFull(signer, bk);
    // No duplicate, and the re-added one moves to the end (most-recent).
    expect(lib.texts).toEqual(["beta", "alpha"]);
  });

  it("caps the text library to the most recent MAX_LIBRARY_TEXTS", async () => {
    for (let i = 0; i < MAX_LIBRARY_TEXTS + 5; i++) {
      await addToLibrary(signer, bk, { texts: [`intro number ${i}`] });
    }
    const lib = await loadLibraryFull(signer, bk);
    expect(lib.texts).toHaveLength(MAX_LIBRARY_TEXTS);
    // Oldest overflow dropped, newest kept.
    expect(lib.texts).not.toContain("intro number 0");
    expect(lib.texts.at(-1)).toBe(`intro number ${MAX_LIBRARY_TEXTS + 4}`);
  });

  it("reads a legacy library entry (media only, no intro_texts) as an empty text list", async () => {
    // Simulate an entry written by a client that predates text reuse.
    await addToLibrary(signer, bk, { media: [descriptor("d".repeat(64))] });
    const pubkey = await signer.getPublicKey();
    const decoded = JSON.parse(await signer.nip44Decrypt(pubkey, published.at(-1)!.content));
    // Regression guard: the pre-text library shape has no intro_texts field at all.
    expect(decoded.intro_texts).toBeUndefined();

    const lib = await loadLibraryFull(signer, bk);
    expect(lib.texts).toEqual([]);
    expect(lib.media).toHaveLength(1);
  });

  it("a no-op call (no media, no non-empty text) publishes nothing", async () => {
    await addToLibrary(signer, bk, { texts: ["   "] }); // whitespace trimmed away
    expect(published).toHaveLength(0);
  });
});
