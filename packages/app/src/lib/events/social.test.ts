/**
 * Avatar wiring (Bug 3): a talk card / detail header must show the AUTHOR's kind-0
 * avatar (name + picture), not fall back to bare initials. The bug was that the
 * talk surfaces never passed the resolved `picture` to <Avatar>, so an author with
 * a real photo rendered as initials — and when the author was the viewer, that
 * looked identical to the nav "More" tab's own initials. `avatarInfo` is the pure
 * resolver both surfaces now use.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// The freshness/caching cases below drive the real cache through an in-memory
// backend and a stubbed relay layer, so "did this hit the relays?" is an
// assertion rather than a guess.
const { streamEvents } = vi.hoisted(() => ({ streamEvents: vi.fn() }));
vi.mock("$lib/nostr/stream.js", () => ({ streamEvents }));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents: vi.fn(), fetchEventsRelayOnly: vi.fn() }));

import { avatarInfo, fetchProfiles, profileNeedsFetch, type ProfileMeta } from "./social.js";
import {
  __setPersistBackend,
  __resetPersistForTests,
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

const AUTHOR = "a".repeat(64);
const VIEWER = "b".repeat(64);

describe("avatarInfo (Bug 3: talk avatars)", () => {
  it("carries the author's picture through when the profile has one", () => {
    const profiles = new Map<string, ProfileMeta>([
      [AUTHOR, { name: "Ada", picture: "https://example/ada.jpg" }],
    ]);
    expect(avatarInfo(AUTHOR, profiles)).toEqual({
      name: "Ada",
      picture: "https://example/ada.jpg",
    });
  });

  it("resolves by the author's pubkey, never leaking another person's profile", () => {
    const profiles = new Map<string, ProfileMeta>([
      [VIEWER, { name: "Me", picture: "https://example/me.jpg" }],
    ]);
    // The card asks for the AUTHOR; the viewer's profile must not answer.
    expect(avatarInfo(AUTHOR, profiles)).toEqual({ name: undefined, picture: undefined });
  });

  it("returns undefined fields for an unresolved profile (initials fallback)", () => {
    expect(avatarInfo(AUTHOR, new Map())).toEqual({ name: undefined, picture: undefined });
  });
});

describe("profile freshness is a FETCH clock, not the kind-0's own timestamp", () => {
  const NOW = 1_800_000_000;
  const ANCIENT = NOW - 90 * 24 * 3600; // a profile last edited three months ago

  it("does not re-fetch a profile we asked about a minute ago, however old it is", () => {
    // The bug: the test used to be `now - hit.at > 10min` where `hit.at` is the
    // kind-0's created_at. Every profile older than ten minutes — i.e. essentially
    // every profile in existence — was permanently "stale", so every People paint,
    // every Matches paint and every Chat open re-streamed all of them.
    expect(
      profileNeedsFetch({ cached: true, fetchedAt: NOW - 60, nowSec: NOW }),
    ).toBe(false);
    // Same entry, stamped by the fetch that produced it — the profile's own age
    // (ANCIENT) must play no part in the decision.
    expect(
      profileNeedsFetch({ cached: true, fetchedAt: ANCIENT, nowSec: NOW }),
    ).toBe(true);
  });

  it("revalidates a cached profile once the fetch TTL has passed", () => {
    expect(profileNeedsFetch({ cached: true, fetchedAt: NOW - 9 * 60, nowSec: NOW })).toBe(false);
    expect(profileNeedsFetch({ cached: true, fetchedAt: NOW - 11 * 60, nowSec: NOW })).toBe(true);
  });

  it("re-asks much sooner for a pubkey the relays had nothing for", () => {
    // There is nothing to paint for a miss, and the usual cause is a profile still
    // propagating — but it must still be bounded, or a pubkey with no kind-0
    // anywhere is re-streamed by every caller forever.
    expect(profileNeedsFetch({ cached: false, fetchedAt: NOW - 30, nowSec: NOW })).toBe(false);
    expect(profileNeedsFetch({ cached: false, fetchedAt: NOW - 90, nowSec: NOW })).toBe(true);
  });

  it("always fetches a pubkey never asked about, and always honours force", () => {
    expect(profileNeedsFetch({ cached: true, fetchedAt: undefined, nowSec: NOW })).toBe(true);
    expect(
      profileNeedsFetch({ cached: true, fetchedAt: NOW - 1, nowSec: NOW, force: true }),
    ).toBe(true);
  });
});

describe("fetchProfiles cache behaviour", () => {
  const PK = "c".repeat(64);

  beforeEach(() => {
    __resetPersistForTests();
    __setPersistBackend(memPersist());
    streamEvents.mockReset();
  });

  it("streams a pubkey once, then paints repeat calls from cache with no relay read", async () => {
    // This is the chat/People open path: the second visit must not re-stream.
    streamEvents.mockReturnValue({
      ready: Promise.resolve([
        {
          pubkey: PK,
          // Deliberately an OLD kind-0 — the case the broken freshness test could
          // never serve from cache.
          created_at: Math.floor(Date.now() / 1000) - 90 * 24 * 3600,
          content: JSON.stringify({ name: "Ada" }),
        },
      ]),
    });

    const first = await fetchProfiles([PK]);
    expect(first.get(PK)?.name).toBe("Ada");
    expect(streamEvents).toHaveBeenCalledTimes(1);

    const second = await fetchProfiles([PK]);
    expect(second.get(PK)?.name).toBe("Ada");
    expect(streamEvents).toHaveBeenCalledTimes(1); // no second relay read
  });

  it("does not re-stream a pubkey the relays had no profile for, twice in a row", async () => {
    streamEvents.mockReturnValue({ ready: Promise.resolve([]) });
    await fetchProfiles([PK]);
    await fetchProfiles([PK]);
    expect(streamEvents).toHaveBeenCalledTimes(1);
  });
});
