/**
 * NIP-51 mute-list merge invariants (audit finding U10). Proves mute/unmute is a
 * fetch-merge-write that preserves unknown public/private tags and dedupes —
 * never a blind overwrite — and that the round-trip stores muted pubkeys as
 * self-encrypted private items in the kind-10000 content.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { KIND_MUTE_LIST } from "@nostrautica/protocol";
import type { VerifiedEvent } from "nostr-tools/pure";

// saveMuteList now publishes through publishMonotonic (R6). The mock invokes the
// caller's `sign` so the round-trip still exercises the real signEvent path.
const { fetchEvents, publishMonotonic } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  publishMonotonic: vi.fn(),
}));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents }));
vi.mock("$lib/nostr/monotonic.js", () => ({ publishMonotonic }));
// Fixtures are unsigned; NDK verifies signatures in production and `onlyVerified`
// is the belt-and-braces re-check at the authority boundary. The real
// `onlyByAuthors` is kept — the own-key pin is part of what's under test.
vi.mock("$lib/nostr/verify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/nostr/verify.js")>()),
  onlyVerified: <T,>(events: T[]) => events,
}));

import {
  addPrivateMute,
  removeMute,
  mutedPubkeys,
  isMuted,
  fetchMuteList,
  setMuted,
  UnreadableMuteListError,
  type MuteListState,
} from "./mutes.js";

const PK = "b".repeat(64);
const OTHER = "c".repeat(64);

/**
 * Reversible stand-in for NIP-44 that is SHAPE-valid.
 *
 * `fetchMuteList` now refuses to spend a signer round trip on content that could
 * not be a NIP-44 payload at all (see `isNip44Ciphertext` and the 2026-09-17
 * NIP-04 mute-list report), so a fixture has to look like one: standard base64
 * alphabet, length a multiple of 4, at least the spec's 132-char floor. The
 * previous fixtures were prefixed JSON, none of those things, and would now be
 * rejected before reaching the mock signer at all, which would pass this suite
 * for entirely the wrong reason.
 *
 * A lookup table rather than a real encoding, so the fixtures stay readable.
 */
const vault = new Map<string, string>();
let ctSeq = 0;
function enc(plain: string): string {
  const ct = `A${String(ctSeq++).padStart(3, "0")}`.padEnd(132, "B");
  vault.set(ct, plain);
  return ct;
}
function dec(ct: string): string {
  const plain = vault.get(ct);
  if (plain === undefined) throw new Error("test decrypt: unknown ciphertext");
  return plain;
}

describe("mute merge (pure)", () => {
  it("mutedPubkeys unions public + private p items", () => {
    const state: MuteListState = {
      publicTags: [["p", PK], ["t", "spam"]],
      privateTags: [["p", OTHER]],
    };
    expect([...mutedPubkeys(state)].sort()).toEqual([PK, OTHER].sort());
  });

  it("addPrivateMute appends a private p item, preserving public + unknown tags", () => {
    const state: MuteListState = { publicTags: [["word", "crypto"]], privateTags: [["e", "thread1"]] };
    const next = addPrivateMute(state, PK);
    expect(next.publicTags).toEqual([["word", "crypto"]]); // untouched
    expect(next.privateTags).toContainEqual(["e", "thread1"]); // preserved
    expect(next.privateTags).toContainEqual(["p", PK]); // added privately
    expect(isMuted(next, PK)).toBe(true);
  });

  it("addPrivateMute does not duplicate an already-muted pubkey", () => {
    const pub: MuteListState = { publicTags: [["p", PK]], privateTags: [] };
    expect(addPrivateMute(pub, PK)).toBe(pub); // no-op, even if muted publicly
    const priv: MuteListState = { publicTags: [], privateTags: [["p", PK]] };
    expect(addPrivateMute(priv, PK).privateTags.filter((t) => t[1] === PK)).toHaveLength(1);
  });

  it("removeMute drops the pubkey from both lists, keeping every other tag", () => {
    const state: MuteListState = {
      publicTags: [["p", PK], ["p", OTHER], ["t", "spam"]],
      privateTags: [["p", PK], ["e", "thread1"]],
    };
    const next = removeMute(state, PK);
    expect(isMuted(next, PK)).toBe(false);
    expect(next.publicTags).toContainEqual(["p", OTHER]);
    expect(next.publicTags).toContainEqual(["t", "spam"]);
    expect(next.privateTags).toContainEqual(["e", "thread1"]);
  });
});

describe("fetch/merge/write round-trip", () => {
  function signer(store: { content: string }) {
    return {
      method: "local" as const,
      getPublicKey: async () => PK,
      signEvent: async (tpl: { kind: number; tags: string[][]; content: string }) => {
        store.content = tpl.content;
        return { ...tpl, id: "x", pubkey: PK, sig: "s" } as unknown as VerifiedEvent;
      },
      // Deterministic reversible "encryption" so the test can inspect round-trips.
      nip44Encrypt: async (_pk: string, plain: string) => enc(plain),
      nip44Decrypt: async (_pk: string, ct: string) => dec(ct),
    };
  }

  beforeEach(() => {
    fetchEvents.mockReset();
    publishMonotonic.mockReset().mockImplementation(
      async (input: { sign: (t: number) => unknown | Promise<unknown> }) => {
        await input.sign(1_000); // drives signer.signEvent → store.content
        return { published: true, createdAt: 1_000 };
      },
    );
  });

  it("decrypts existing private items and preserves unknown public tags on write", async () => {
    fetchEvents.mockResolvedValue([
      {
        id: "a1",
        pubkey: PK,
        kind: KIND_MUTE_LIST,
        created_at: 10,
        tags: [["t", "keepme"]],
        content: enc(JSON.stringify([["p", OTHER]])),
      },
    ]);
    const store = { content: "" };
    const s = signer(store);

    const list = await fetchMuteList(s);
    expect(list.publicTags).toContainEqual(["t", "keepme"]);
    expect(list.privateTags).toContainEqual(["p", OTHER]);

    const muted = await setMuted(s, PK, true);
    expect(muted.has(PK)).toBe(true);
    expect(muted.has(OTHER)).toBe(true); // pre-existing private mute survived
    expect(publishMonotonic).toHaveBeenCalledTimes(1);
    // The new pubkey went into the encrypted content, not a public tag.
    const written = JSON.parse(dec(store.content));
    expect(written).toContainEqual(["p", PK]);
    expect(written).toContainEqual(["p", OTHER]);
  });

  it("unmute leaves content empty when no private items remain", async () => {
    fetchEvents.mockResolvedValue([
      {
        id: "a1",
        pubkey: PK,
        kind: KIND_MUTE_LIST,
        created_at: 10,
        tags: [],
        content: enc(JSON.stringify([["p", PK]])),
      },
    ]);
    const store = { content: "sentinel" };
    const muted = await setMuted(signer(store), PK, false);
    expect(muted.has(PK)).toBe(false);
    expect(store.content).toBe(""); // empty private → empty content, not stale ciphertext
  });

  it("refuses to republish when the existing private items can't be decrypted", async () => {
    // A NIP-46 signer that times out mid-tap used to be indistinguishable from
    // "there is nothing private in this list": fetchMuteList swallowed the failure
    // and returned privateTags: [], and the very next step re-encrypted that empty
    // list over the user's real one — every private mute gone, silently, with no
    // second copy anywhere (kind-10000 is replaceable).
    fetchEvents.mockResolvedValue([
      {
        id: "a1",
        pubkey: PK,
        kind: KIND_MUTE_LIST,
        created_at: 10,
        tags: [["t", "keepme"]],
        content: enc(JSON.stringify([["p", OTHER]])),
      },
    ]);
    const store = { content: "sentinel" };
    const flaky = {
      ...signer(store),
      nip44Decrypt: async () => {
        throw new Error("bunker timed out");
      },
    };

    await expect(setMuted(flaky, PK, true)).rejects.toThrow(/bunker timed out/);
    expect(publishMonotonic).not.toHaveBeenCalled();
    expect(store.content).toBe("sentinel"); // nothing signed, nothing overwritten
  });

  it("never asks the signer to decrypt a legacy NIP-04 list", async () => {
    // Reported 2026-09-17. The account's kind-10000 was written in 2024 by
    // another client with NIP-04, and its content is `<base64>?iv=<base64>` —
    // which is not base64 at all. Every visit to a mute-aware screen sent it to
    // the user's signer, which is a relay round trip to their phone, and Clave
    // (iOS) shows a "Signing Failed: nip44_decrypt failed: Invalid base64" push
    // notification for each one. We could always have known the answer without
    // asking, and the refusal has to stay a refusal: flattening it to "no private
    // mutes" is what the republish below would then overwrite the list with.
    fetchEvents.mockResolvedValue([
      {
        id: "a1",
        pubkey: PK,
        kind: KIND_MUTE_LIST,
        created_at: 10,
        tags: [["t", "keepme"]],
        content: "f+/YOKe898cbiM09+vtfyA==?iv=jwq9ef0jRSVZGPVQZqltfw==",
      },
    ]);
    const store = { content: "sentinel" };
    const asked = vi.fn(async () => "[]");
    const s = { ...signer(store), nip44Decrypt: asked };

    await expect(fetchMuteList(s)).rejects.toThrow(UnreadableMuteListError);
    await expect(fetchMuteList(s)).rejects.toMatchObject({ legacy: true });
    expect(asked).not.toHaveBeenCalled();

    // And a write still refuses rather than republishing an empty private list.
    await expect(setMuted(s, OTHER, true)).rejects.toThrow(UnreadableMuteListError);
    expect(publishMonotonic).not.toHaveBeenCalled();
    expect(store.content).toBe("sentinel");
  });

  it("still refuses a non-NIP-44 list that isn't NIP-04 either", async () => {
    // kind-30078 in the wild carries plaintext; kind-10000 could too. The refusal
    // is the same, but `legacy` is false so the UI doesn't blame NIP-04 for it.
    fetchEvents.mockResolvedValue([
      {
        id: "a1",
        pubkey: PK,
        kind: KIND_MUTE_LIST,
        created_at: 10,
        tags: [],
        content: "Records read time to sync notification status across devices.",
      },
    ]);
    const s = signer({ content: "" });
    await expect(fetchMuteList(s)).rejects.toMatchObject({
      name: "UnreadableMuteListError",
      legacy: false,
    });
  });

  it("ignores a kind-10000 by another key, so it can't wedge mute/unmute", async () => {
    // The pin has to be here as well as in the relay filter: an undecryptable list
    // is now fatal, so a foreign kind-10000 answered at a high created_at would
    // otherwise mean this identity could never mute anyone again.
    fetchEvents.mockResolvedValue([
      { id: "ff", pubkey: OTHER, kind: KIND_MUTE_LIST, created_at: 9_000, tags: [], content: "junk" },
      {
        id: "a1",
        pubkey: PK,
        kind: KIND_MUTE_LIST,
        created_at: 10,
        tags: [],
        content: enc(JSON.stringify([["p", OTHER]])),
      },
    ]);
    const list = await fetchMuteList(signer({ content: "" }));
    expect(list.privateTags).toEqual([["p", OTHER]]);
  });
});
