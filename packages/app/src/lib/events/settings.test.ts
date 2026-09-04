/**
 * User-private per-event settings (spec §7.3) are a read-modify-write over a
 * REPLACEABLE kind-30078: `toggleSetting`/`setNote` load the whole payload,
 * change one field, and publish the whole payload back. So whatever the load
 * returns IS what gets written, and the load used to answer a failed
 * `nip44Decrypt` — a NIP-46 bunker that timed out, a garbled ciphertext, a
 * payload from a newer schema this build can't parse — with the SAME empty
 * object it returns for "you have never saved anything here".
 *
 * The result was that one flaky signer round-trip, during an ordinary
 * want-to-meet tap, republished an empty payload over every private note,
 * favourite and met-marker the user had for that event. Silently, with no error,
 * and with nothing to restore from: the event is replaceable and the only copy
 * was the one just overwritten.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { KIND_APP_DATA, makeCoordinate, type PerEventSettings } from "@nostrautica/protocol";
import type { VerifiedEvent } from "nostr-tools/pure";

const { fetchEvents, publishMonotonic } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  publishMonotonic: vi.fn(),
}));
vi.mock("$lib/nostr/ndk.js", () => ({
  fetchEvents,
  fetchEventsRelayOnly: vi.fn(),
  publishSigned: vi.fn(),
  isAcceptedRelayUrl: (value: string) => value.startsWith("wss://"),
}));
vi.mock("$lib/nostr/monotonic.js", () => ({ publishMonotonic }));
vi.mock("$lib/nostr/verify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/nostr/verify.js")>()),
  onlyVerified: <T,>(events: T[]) => events,
}));

import { loadPerEventSettings, toggleSetting } from "./settings.js";
import type { EventContext } from "./event-context.js";
import type { AppSigner } from "$lib/signer/types.js";
import { __resetPersistForTests, setActiveCacheOwner } from "$lib/cache/persist.js";

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);
const FRIEND = "c".repeat(64);
const COORD = makeCoordinate("e".repeat(64), "conf-2026");
const ctx = { coordinate: COORD, config: { relays: [] } } as unknown as EventContext;
const BLINDING = new Uint8Array(32).fill(7);

const SAVED: PerEventSettings = {
  v: 2,
  favorites: [FRIEND],
  want_to_meet: [],
  met: [FRIEND],
  notes: { [FRIEND]: "met at the bar, wants to talk about relays" },
};

/** A signer whose "encryption" is reversible so a test can read what was written. */
function signer(store: { content: string }, decrypt?: () => Promise<string>): AppSigner {
  return {
    method: "local" as const,
    getPublicKey: async () => ME,
    signEvent: async (tpl: { kind: number; tags: string[][]; content: string }) => {
      store.content = tpl.content;
      return { ...tpl, id: "x", pubkey: ME, sig: "s" } as unknown as VerifiedEvent;
    },
    nip44Encrypt: async (_pk: string, plain: string) => `enc:${plain}`,
    nip44Decrypt: decrypt ?? (async (_pk: string, ct: string) => ct.replace(/^enc:/, "")),
  } as unknown as AppSigner;
}

function storedEvent(pubkey: string, content: string, createdAt = 100) {
  return {
    id: `s-${createdAt}`,
    kind: KIND_APP_DATA,
    pubkey,
    created_at: createdAt,
    tags: [["d", "nostrautica:ev:whatever"]],
    content,
  };
}

describe("per-event settings read-modify-write safety", () => {
  beforeEach(() => {
    __resetPersistForTests();
    setActiveCacheOwner(ME);
    fetchEvents.mockReset();
    publishMonotonic.mockReset().mockImplementation(
      async (input: { sign: (t: number) => unknown | Promise<unknown> }) => {
        await input.sign(1_000);
        return { published: true, createdAt: 1_000 };
      },
    );
  });

  it("round-trips a saved payload and writes the changed one back", async () => {
    fetchEvents.mockResolvedValue([storedEvent(ME, `enc:${JSON.stringify(SAVED)}`)]);
    const store = { content: "" };

    const next = await toggleSetting(signer(store), ctx, BLINDING, "want_to_meet", OTHER);

    expect(next.want_to_meet).toEqual([OTHER]);
    const written: PerEventSettings = JSON.parse(store.content.replace(/^enc:/, ""));
    expect(written.notes[FRIEND]).toBe(SAVED.notes[FRIEND]); // the note survived
    expect(written.favorites).toEqual([FRIEND]);
  });

  it("refuses to write when an existing payload can't be decrypted", async () => {
    fetchEvents.mockResolvedValue([storedEvent(ME, `enc:${JSON.stringify(SAVED)}`)]);
    const store = { content: "sentinel" };
    const flaky = signer(store, async () => {
      throw new Error("bunker timed out");
    });

    await expect(toggleSetting(flaky, ctx, BLINDING, "want_to_meet", OTHER)).rejects.toThrow(
      /bunker timed out/,
    );
    expect(publishMonotonic).not.toHaveBeenCalled();
    expect(store.content).toBe("sentinel"); // nothing signed, nothing overwritten
  });

  it("refuses to write when the payload parses but this build can't validate it", async () => {
    // A payload written by a NEWER build (fields this schema rejects) is exactly
    // the case where silently replacing it with EMPTY does the most damage: the
    // user's other device knows more than this one does.
    fetchEvents.mockResolvedValue([
      storedEvent(ME, `enc:${JSON.stringify({ v: 2, favorites: "not-an-array" })}`),
    ]);
    const store = { content: "sentinel" };

    await expect(
      toggleSetting(signer(store), ctx, BLINDING, "favorites", OTHER),
    ).rejects.toThrow();
    expect(publishMonotonic).not.toHaveBeenCalled();
  });

  it("still returns an empty set when nothing has ever been saved", async () => {
    // The genuine empty case must stay cheap and silent — this is every user's
    // first tap on every event.
    fetchEvents.mockResolvedValue([]);
    const loaded = await loadPerEventSettings(signer({ content: "" }), ctx, BLINDING);
    expect(loaded).toEqual({ v: 2, favorites: [], want_to_meet: [], met: [], notes: {} });
  });

  it("ignores a 30078 by another key, so it can't wedge every later save", async () => {
    // With an unreadable payload now fatal, a foreign 30078 answered at this `d`
    // with a high created_at would otherwise mean this user could never save a
    // note for this event again. Only their own events are self-decryptable.
    fetchEvents.mockResolvedValue([
      storedEvent(OTHER, "enc:junk-nobody-can-read", 9_000),
      storedEvent(ME, `enc:${JSON.stringify(SAVED)}`, 100),
    ]);
    const loaded = await loadPerEventSettings(signer({ content: "" }), ctx, BLINDING);
    expect(loaded.favorites).toEqual([FRIEND]);
  });
});
