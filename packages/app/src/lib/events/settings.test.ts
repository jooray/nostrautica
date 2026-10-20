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

const { fetchEvents, publishMonotonic, relay } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  publishMonotonic: vi.fn(),
  /** Whether the stubbed read reports a relay EOSE (StreamHandle.answered). */
  relay: { answered: true },
}));
vi.mock("$lib/nostr/ndk.js", () => ({
  fetchEvents,
  fetchEventsAnswered: async (...args: unknown[]) => ({
    events: await fetchEvents(...args),
    answered: relay.answered,
  }),
  fetchEventsRelayOnly: vi.fn(),
  publishSigned: vi.fn(),
  isAcceptedRelayUrl: (value: string) => value.startsWith("wss://"),
}));
vi.mock("$lib/nostr/monotonic.js", () => ({ publishMonotonic }));
vi.mock("$lib/nostr/verify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/nostr/verify.js")>()),
  onlyVerified: <T,>(events: T[]) => events,
}));

import { loadPerEventSettings, toggleSetting, setNote, cachedPerEventSettings } from "./settings.js";
import type { EventContext } from "./event-context.js";
import type { AppSigner } from "$lib/signer/types.js";
import { __resetPersistForTests, setActiveCacheOwner, cacheGet } from "$lib/cache/persist.js";

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
    relay.answered = true;
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

  // Audit SB-01: an 8 s read that no relay answered resolves to [] — the same
  // answer as "never saved". Publishing over that replaced everything.
  it("refuses to write when no relay answered and this device has no copy", async () => {
    relay.answered = false;
    fetchEvents.mockResolvedValue([]);
    const store = { content: "sentinel" };

    await expect(setNote(signer(store), ctx, BLINDING, OTHER, "met at the bar")).rejects.toThrow(
      /Couldn't read your saved notes/,
    );
    expect(publishMonotonic).not.toHaveBeenCalled();
    expect(store.content).toBe("sentinel");
  });

  it("builds on this device's own copy when no relay answered", async () => {
    // First a successful save, so the device holds a copy…
    fetchEvents.mockResolvedValue([storedEvent(ME, `enc:${JSON.stringify(SAVED)}`)]);
    await loadPerEventSettings(signer({ content: "" }), ctx, BLINDING);
    expect(cachedPerEventSettings(COORD)?.favorites).toEqual([FRIEND]);
    // …then the venue Wi-Fi: nothing comes back.
    relay.answered = false;
    fetchEvents.mockResolvedValue([]);
    const store = { content: "" };

    await toggleSetting(signer(store), ctx, BLINDING, "want_to_meet", OTHER);

    const written: PerEventSettings = JSON.parse(store.content.replace(/^enc:/, ""));
    expect(written.want_to_meet).toEqual([OTHER]);
    expect(written.notes[FRIEND]).toBe(SAVED.notes[FRIEND]);
    expect(written.met).toEqual([FRIEND]);
  });

  // DS41-003 pattern: an account switch while the read is in flight must not
  // file A's decrypted settings under B.
  it("writes the settings cache under the identity that started the save", async () => {
    fetchEvents.mockImplementation(async () => {
      setActiveCacheOwner(OTHER); // switched accounts mid-read
      return [storedEvent(ME, `enc:${JSON.stringify(SAVED)}`)];
    });
    await toggleSetting(signer({ content: "" }), ctx, BLINDING, "met", OTHER);
    expect(cacheGet(`evsettings:${COORD}`, OTHER)).toBeUndefined();
    // The switch bumped the cache generation (DS41-003), so the late write is
    // dropped rather than filed anywhere — not even back under ME.
    expect(cacheGet(`evsettings:${COORD}`, ME)).toBeUndefined();
  });

  // Audit DS41-007: two taps in a row used to read the same baseline, and the
  // second publish erased the first one's change.
  it("serializes concurrent edits so neither erases the other", async () => {
    // A tiny in-memory relay: reads return what the last publish wrote.
    let onRelay = storedEvent(ME, `enc:${JSON.stringify(SAVED)}`, 100);
    let clock = 100;
    fetchEvents.mockImplementation(async () => {
      const served = onRelay; // what the relay held when the REQ arrived
      await new Promise((r) => setTimeout(r, 5)); // a real read takes time
      return [served];
    });
    publishMonotonic.mockImplementation(
      async (input: { sign: (t: number) => Promise<{ content: string }> }) => {
        await new Promise((r) => setTimeout(r, 5)); // the monotonic floor read
        const createdAt = ++clock;
        const ev = await input.sign(createdAt);
        onRelay = storedEvent(ME, ev.content, createdAt);
        return { published: true, createdAt };
      },
    );
    const store = { content: "" };
    const s = signer(store);

    await Promise.all([
      toggleSetting(s, ctx, BLINDING, "want_to_meet", OTHER),
      toggleSetting(s, ctx, BLINDING, "favorites", OTHER),
      setNote(s, ctx, BLINDING, OTHER, "rust person"),
    ]);

    const final: PerEventSettings = JSON.parse(onRelay.content.replace(/^enc:/, ""));    expect(final.want_to_meet).toEqual([OTHER]);
    expect(final.favorites).toEqual([FRIEND, OTHER]);
    expect(final.notes[OTHER]).toBe("rust person");
    expect(final.notes[FRIEND]).toBe(SAVED.notes[FRIEND]);
  });
});
