import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  generateEck,
  bytesToBase64,
  encryptMembersPost,
  KIND_LONGFORM,
  KIND_MEMBERS_POST,
  type EckVersion,
} from "@nostrautica/protocol";

// Cache-path setup (CACHING-PLAN §2.4): mock the relay layer so fetchEventPosts
// runs against a fixed event set and we can assert the persistent write-through.
const { fetchEvents } = vi.hoisted(() => ({ fetchEvents: vi.fn() }));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents, fetchEventsRelayOnly: vi.fn() }));
vi.mock("$lib/nostr/publish-queue.js", () => ({ publishOrQueue: vi.fn() }));
// The fixtures below are unsigned plain objects. Signature checking is NDK's job
// in production (ndk.ts pins validation to 1) and `onlyVerified` is re-applied at
// the authority boundary as defense in depth — so stub THAT one and keep the real
// `onlyByAuthors`, which is the half these tests are about.
vi.mock("$lib/nostr/verify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/nostr/verify.js")>()),
  onlyVerified: <T,>(events: T[]) => events,
}));

import {
  dedupePostsByD,
  toEventPost,
  randomPostD,
  fetchEventPosts,
  cachedEventPosts,
  fetchExternalPosts,
  cachedExternalPosts,
  fetchPostByD,
  externalFeedFilter,
  matchesFeed,
  MAX_EXTERNAL_PER_FEED,
  type RawPostEvent,
} from "./posts.js";
import type { EventContext } from "./event-context.js";
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

const EID = "e".repeat(64);

function pub(d: string, created_at: number, title = "t"): RawPostEvent {
  return {
    id: `pub-${d}-${created_at}`,
    kind: KIND_LONGFORM,
    pubkey: EID,
    created_at,
    tags: [
      ["d", d],
      ["title", title],
      ["published_at", String(created_at)],
    ],
    content: "body",
  };
}

function enc(
  d: string,
  created_at: number,
  eck: Uint8Array,
  eckId: number,
  overrides: Partial<{ title: string; published_at: number; content: string }> = {},
): RawPostEvent {
  return {
    id: `enc-${d}-${created_at}`,
    kind: KIND_MEMBERS_POST,
    pubkey: EID,
    created_at,
    tags: [
      ["d", d],
      ["v", "2"],
      ["eck", String(eckId)],
    ],
    content: encryptMembersPost(eck, {
      v: 2,
      title: overrides.title ?? "secret",
      published_at: overrides.published_at ?? created_at,
      content: overrides.content ?? "members body",
    }),
  };
}

describe("dedupePostsByD", () => {
  it("keeps the highest created_at per d ACROSS BOTH KINDS", () => {
    const eck = generateEck();
    const events = [
      pub("x", 100),
      enc("x", 200, eck, 1), // later 31607 at the same address wins
      pub("y", 300),
      pub("y", 250),
    ];
    const out = dedupePostsByD(events);
    expect(out).toHaveLength(2);
    const x = out.find((e) => e.tags[0][1] === "x")!;
    expect(x.kind).toBe(KIND_MEMBERS_POST);
    expect(x.created_at).toBe(200);
    const y = out.find((e) => e.tags[0][1] === "y")!;
    expect(y.created_at).toBe(300);
  });

  it("keys per author so attendee posts with the same d don't collide", () => {
    const a = { ...pub("dup", 100), pubkey: "1".repeat(64) };
    const b = { ...pub("dup", 90), pubkey: "2".repeat(64) };
    expect(dedupePostsByD([a, b])).toHaveLength(2);
  });
});

describe("toEventPost", () => {
  it("maps a public 30023 with cleartext tags", () => {
    const post = toEventPost(pub("d1", 123, "Hello"), []);
    expect(post).toMatchObject({
      d: "d1",
      membersOnly: false,
      locked: false,
      title: "Hello",
      content: "body",
      publishedAt: 123,
    });
  });

  it("decrypts a 31607 with the version named by its eck tag — not the current", () => {
    const v1 = generateEck();
    const v2 = generateEck();
    const granted: EckVersion[] = [
      { id: 1, key: bytesToBase64(v1) },
      { id: 2, key: bytesToBase64(v2) },
    ];
    // Post encrypted under v1 while v2 is current: must still decrypt via the tag.
    const post = toEventPost(enc("d2", 500, v1, 1, { published_at: 400 }), granted);
    expect(post.locked).toBe(false);
    expect(post.title).toBe("secret");
    expect(post.publishedAt).toBe(400); // preserved from inside the ciphertext
    expect(post.eckVersion).toBe(1);
  });

  it("returns a locked post when the named version isn't granted", () => {
    const v2 = generateEck();
    const grantedOnlyV1: EckVersion[] = [{ id: 1, key: bytesToBase64(generateEck()) }];
    const post = toEventPost(enc("d3", 500, v2, 2), grantedOnlyV1);
    expect(post.locked).toBe(true);
    expect(post.title).toBe("");
    expect(post.content).toBe("");
    expect(post.membersOnly).toBe(true);
  });

  it("returns a locked post when the reader holds no keys at all (visitor)", () => {
    const post = toEventPost(enc("d4", 500, generateEck(), 1), []);
    expect(post.locked).toBe(true);
  });

  it("clamps a future published_at so an article can't pin itself to the top forever", () => {
    // `published_at` is the feed's sort key and it is entirely author-controlled.
    // `sources` deliberately folds OTHER npubs' long-form into the official feed,
    // so without a clamp every curated author gets a permanent top slot by dating
    // an article 2099 — and the organizer's own newest post sits under it forever.
    const now = Math.floor(Date.now() / 1000);
    const year2099 = 4_070_908_800;
    const article = {
      ...pub("stuck", now - 86_400),
      tags: [["d", "stuck"], ["title", "Pinned"], ["published_at", String(year2099)]],
    };
    const post = toEventPost(article, []);
    expect(post.publishedAt).toBeLessThanOrEqual(now);
    // A genuinely dated post is untouched — the clamp is a ceiling, not a rewrite.
    expect(toEventPost(pub("normal", 1500), []).publishedAt).toBe(1500);

    // Same for a 31607, where the date lives inside the ciphertext.
    const eck = generateEck();
    const granted: EckVersion[] = [{ id: 1, key: bytesToBase64(eck) }];
    const members = toEventPost(
      enc("secret", now - 86_400, eck, 1, { published_at: year2099 }),
      granted,
    );
    expect(members.locked).toBe(false);
    expect(members.publishedAt).toBeLessThanOrEqual(now);
  });

  it("locks instead of throwing on a garbled ciphertext under the right id", () => {
    const eck = generateEck();
    const wrongKeySameId: EckVersion[] = [{ id: 1, key: bytesToBase64(generateEck()) }];
    const post = toEventPost(enc("d5", 500, eck, 1), wrongKeySameId);
    expect(post.locked).toBe(true);
  });
});

describe("randomPostD", () => {
  it("is 32 lowercase hex chars and unique per call", () => {
    const a = randomPostD();
    const b = randomPostD();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("fetchEventPosts cache write-through (§2.4)", () => {
  const OWNER = "1".repeat(64);
  const ctx = {
    coordinate: `31923:${EID}:ev`,
    config: { relays: [] },
  } as unknown as EventContext;

  beforeEach(() => {
    __resetPersistForTests();
    __setPersistBackend(memPersist());
    fetchEvents.mockReset();
  });

  it("persists the fetched feed owner-scoped so cachedEventPosts paints it", async () => {
    setActiveCacheOwner(OWNER);
    fetchEvents.mockResolvedValue([pub("x", 100, "Hello")]);
    expect(cachedEventPosts(ctx.coordinate)).toBeUndefined();

    const posts = await fetchEventPosts(ctx);
    expect(posts).toHaveLength(1);
    expect(cachedEventPosts(ctx.coordinate)?.[0].title).toBe("Hello");

    // Owner-scoped: a different identity does not see this feed.
    setActiveCacheOwner("2".repeat(64));
    expect(cachedEventPosts(ctx.coordinate)).toBeUndefined();
  });

  it("drops a 30023 by anyone but E_id, even though the filter asked for E_id", async () => {
    // A relay filter is a REQUEST, not a guarantee (the same reason `matchesFeed`
    // re-checks `pubkey`). This is the OFFICIAL feed and it renders with no author
    // attribution at all, so an article any relay in the event's set chose to
    // answer with would appear on the event page as something the organizer wrote.
    setActiveCacheOwner(OWNER);
    const impostor = { ...pub("x", 900, "Free tickets, send your nsec"), pubkey: OTHER };
    fetchEvents.mockResolvedValue([impostor, pub("y", 100, "Ours")]);

    const posts = await fetchEventPosts(ctx);

    expect(posts.map((p) => p.title)).toEqual(["Ours"]);
    // ...and it must be dropped BEFORE the per-`d` dedupe, or a newer forgery at
    // an address E_id already published would take the address instead.
    fetchEvents.mockResolvedValue([
      { ...pub("shared", 9000, "Hijacked"), pubkey: OTHER },
      pub("shared", 100, "The real one"),
    ]);
    const contested = await fetchEventPosts(ctx);
    expect(contested.map((p) => p.title)).toEqual(["The real one"]);
  });

  it("latest-wins: an older re-fetch never regresses the cached feed", async () => {
    setActiveCacheOwner(OWNER);
    fetchEvents.mockResolvedValue([pub("x", 500, "New")]);
    await fetchEventPosts(ctx);
    expect(cachedEventPosts(ctx.coordinate)?.[0].title).toBe("New");

    // A stale relay answers with an older revision — the cache keeps the newer one.
    fetchEvents.mockResolvedValue([pub("x", 100, "Old")]);
    await fetchEventPosts(ctx);
    expect(cachedEventPosts(ctx.coordinate)?.[0].title).toBe("New");
  });
});

// ── External long-form feeds (31608 `sources`, spec §7.4) ────────────────────

const OFFICIAL = "a".repeat(64); // the organization's own npub, not E_id
const OTHER = "b".repeat(64);

/** A 30023 by an arbitrary author, with hashtags and a distinct published_at. */
function ext(
  pubkey: string,
  d: string,
  createdAt: number,
  opts: { hashtags?: string[]; publishedAt?: number; title?: string } = {},
): RawPostEvent {
  return {
    id: `ext-${pubkey.slice(0, 4)}-${d}-${createdAt}`,
    kind: KIND_LONGFORM,
    pubkey,
    created_at: createdAt,
    tags: [
      ["d", d],
      ["title", opts.title ?? "Article"],
      ["published_at", String(opts.publishedAt ?? createdAt)],
      ...(opts.hashtags ?? []).map((h) => ["t", h]),
    ],
    content: "body",
  };
}

describe("externalFeedFilter", () => {
  it("narrows on author, hashtags and since, and always bounds the result", () => {
    expect(externalFeedFilter({ pubkey: OFFICIAL, tags: ["kosice"], since: 1_754_006_400 })).toEqual({
      kinds: [KIND_LONGFORM],
      authors: [OFFICIAL],
      limit: MAX_EXTERNAL_PER_FEED,
      "#t": ["kosice"],
      since: 1_754_006_400,
    });
  });

  it("bounds a feed that narrows nothing — 'everything this npub ever wrote' is not a feed", () => {
    const f = externalFeedFilter({ pubkey: OFFICIAL });
    expect(f.limit).toBe(MAX_EXTERNAL_PER_FEED);
    expect(f["#t"]).toBeUndefined();
    expect(f.since).toBeUndefined();
  });

  it("never sends `until` to the relay", () => {
    // `until` bounds published_at, but relays can only bound created_at — and a
    // qualifying article EDITED after the window would then be dropped
    // relay-side, where the client can no longer recover it. Filtered locally.
    expect(externalFeedFilter({ pubkey: OFFICIAL, until: 1_760_000_000 }).until).toBeUndefined();
  });
});

describe("matchesFeed", () => {
  const src = { pubkey: OFFICIAL, tags: ["kosice"], since: 1000, until: 2000 };

  it("rejects an article by an author the organizer never named", () => {
    // The load-bearing check: NDK verifies signatures, so `pubkey` is genuine —
    // what it cannot tell us is whether this is the pubkey we ASKED for. A relay
    // is free to answer a filter with anything.
    expect(matchesFeed(ext(OTHER, "x", 1500, { hashtags: ["kosice"] }), src)).toBe(false);
  });

  it("requires one of the declared hashtags, case-insensitively", () => {
    expect(matchesFeed(ext(OFFICIAL, "x", 1500, { hashtags: ["KOSICE"] }), src)).toBe(true);
    expect(matchesFeed(ext(OFFICIAL, "x", 1500, { hashtags: ["bratislava"] }), src)).toBe(false);
    expect(matchesFeed(ext(OFFICIAL, "x", 1500), src)).toBe(false);
  });

  it("bounds published_at, not created_at — an old article edited in-window stays out", () => {
    // The case the relay filter cannot express: published in July, corrected in
    // August. `created_at` is inside the window (so the relay returns it), but
    // the organizer said "published since 1 August" and meant it.
    const editedOldArticle = ext(OFFICIAL, "x", 1500, {
      hashtags: ["kosice"],
      publishedAt: 500,
    });
    expect(editedOldArticle.created_at).toBeGreaterThan(src.since);
    expect(matchesFeed(editedOldArticle, src)).toBe(false);

    // ...and the mirror: published in-window, edited long after, still counts.
    const editedRecentArticle = ext(OFFICIAL, "y", 9000, {
      hashtags: ["kosice"],
      publishedAt: 1500,
    });
    expect(matchesFeed(editedRecentArticle, src)).toBe(true);
  });
});

describe("fetchExternalPosts", () => {
  const OWNER = "1".repeat(64);
  const ctx = {
    coordinate: `31923:${EID}:ev`,
    config: { relays: ["wss://event.example"] },
  } as unknown as EventContext;

  beforeEach(() => {
    __resetPersistForTests();
    __setPersistBackend(memPersist());
    setActiveCacheOwner(OWNER);
    fetchEvents.mockReset();
  });

  it("merges a curated npub's tagged articles and attributes them to the feed", async () => {
    // The lunarpunk case: the event's own posts come from E_id, the org's
    // announcements from its established npub, and the reader sees one feed.
    fetchEvents.mockResolvedValue([
      ext(OFFICIAL, "kosice-1", 1500, { hashtags: ["kosice"], title: "Venue" }),
      ext(OFFICIAL, "other", 1500, { hashtags: ["bratislava"] }), // wrong hashtag
      ext(OTHER, "sneaky", 1500, { hashtags: ["kosice"] }), // wrong author
    ]);

    const posts = await fetchExternalPosts(ctx, [
      { pubkey: OFFICIAL, tags: ["kosice"], since: 1000, label: "Lunarpunk" },
    ]);

    expect(posts.map((p) => p.title)).toEqual(["Venue"]);
    expect(posts[0].source).toBe("external");
    expect(posts[0].feedLabel).toBe("Lunarpunk");
    expect(cachedExternalPosts(ctx.coordinate)?.[0].title).toBe("Venue");
  });

  it("uses the feed's own relays when it names them, the event's otherwise", async () => {
    // The failure this prevents is silent: the org's articles usually aren't on
    // the event's relays, so without the hint the feed just comes back empty.
    fetchEvents.mockResolvedValue([]);
    await fetchExternalPosts(ctx, [
      { pubkey: OFFICIAL, relays: ["wss://org.example"] },
      { pubkey: OTHER },
    ]);

    const relaySets = fetchEvents.mock.calls.map((c) => c[1]);
    expect(relaySets).toContainEqual(["wss://org.example"]);
    expect(relaySets).toContainEqual(["wss://event.example"]);
  });

  it("batches feeds that share a relay set into one subscription", async () => {
    fetchEvents.mockResolvedValue([]);
    await fetchExternalPosts(ctx, [
      { pubkey: OFFICIAL, tags: ["a"] },
      { pubkey: OTHER, tags: ["b"] },
    ]);
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(fetchEvents.mock.calls[0][0]).toHaveLength(2); // a filter array
  });

  it("ignores a source naming E_id — those are already the official feed", async () => {
    fetchEvents.mockResolvedValue([]);
    const posts = await fetchExternalPosts(ctx, [{ pubkey: EID }]);
    expect(posts).toEqual([]);
    expect(fetchEvents).not.toHaveBeenCalled();
  });

  it("clears the cache when the organizer removes every source", async () => {
    fetchEvents.mockResolvedValue([ext(OFFICIAL, "x", 1500)]);
    await fetchExternalPosts(ctx, [{ pubkey: OFFICIAL }]);
    expect(cachedExternalPosts(ctx.coordinate)).toHaveLength(1);

    // A stale cache entry would keep a removed feed alive on the page forever —
    // and writing an empty list instead of deleting would NOT work: it stamps
    // older than what it replaces and latest-wins drops it.
    await fetchExternalPosts(ctx, []);
    expect(cachedExternalPosts(ctx.coordinate)).toBeUndefined();
  });

  it("a narrowed source shrinks the cached feed instead of being dropped as stale", async () => {
    // The other half of the same hazard: narrowing (a hashtag removed, a later
    // `since`) legitimately yields a feed whose newest post is OLDER than the
    // cached one. Stamping by post time would discard the write and keep showing
    // articles the organizer just excluded.
    fetchEvents.mockResolvedValue([
      ext(OFFICIAL, "old", 1000, { hashtags: ["kosice"] }),
      ext(OFFICIAL, "new", 9000, { hashtags: ["bratislava"] }),
    ]);
    await fetchExternalPosts(ctx, [{ pubkey: OFFICIAL }]);
    expect(cachedExternalPosts(ctx.coordinate)).toHaveLength(2);

    await fetchExternalPosts(ctx, [{ pubkey: OFFICIAL, tags: ["kosice"] }]);
    expect(cachedExternalPosts(ctx.coordinate)?.map((p) => p.d)).toEqual(["old"]);
  });

  it("keeps the previous snapshot when a relay read fails", async () => {
    fetchEvents.mockResolvedValue([ext(OFFICIAL, "x", 1500)]);
    await fetchExternalPosts(ctx, [{ pubkey: OFFICIAL }]);
    expect(cachedExternalPosts(ctx.coordinate)).toHaveLength(1);

    // An unreachable relay must not be mistaken for "the organizer removed it".
    fetchEvents.mockRejectedValue(new Error("relay down"));
    const posts = await fetchExternalPosts(ctx, [{ pubkey: OFFICIAL }]);
    expect(posts).toEqual([]);
    expect(cachedExternalPosts(ctx.coordinate)).toHaveLength(1);
  });
});

describe("fetchPostByD with declared external feeds", () => {
  const ctx = {
    coordinate: `31923:${EID}:ev`,
    config: { relays: ["wss://event.example"] },
  } as unknown as EventContext;

  beforeEach(() => {
    __resetPersistForTests();
    __setPersistBackend(memPersist());
    setActiveCacheOwner("1".repeat(64));
    fetchEvents.mockReset();
  });

  it("resolves a curated article, so its 'read' link survives a cold open", () => {
    // The feed cache carries these on a warm device; a shared link or a fresh
    // browser has nothing, and an E_id-only query would 404 the article the
    // reader just tapped.
    fetchEvents.mockResolvedValue([ext(OFFICIAL, "kosice-1", 1500, { title: "Venue" })]);
    return fetchPostByD(ctx, "kosice-1", [
      { pubkey: OFFICIAL, relays: ["wss://org.example"], label: "Lunarpunk" },
    ]).then((post) => {
      expect(post).toMatchObject({ title: "Venue", source: "external", feedLabel: "Lunarpunk" });
      // Queried on the union of the event's relays and the feed's own — the
      // article is usually only on the latter.
      expect(fetchEvents.mock.calls[0][1]).toEqual(["wss://event.example", "wss://org.example"]);
      expect(fetchEvents.mock.calls[0][0].authors).toEqual([EID, OFFICIAL]);
    });
  });

  it("the event's own post wins the address when an external feed reuses the same d", async () => {
    // `d` is unique per author, not per event, so a multi-author query can
    // return two winners. E_id must not be shadowed at its own address.
    fetchEvents.mockResolvedValue([
      ext(OFFICIAL, "update-1", 9000, { title: "Someone else's" }),
      pub("update-1", 100, "Ours"),
    ]);
    const post = await fetchPostByD(ctx, "update-1", [{ pubkey: OFFICIAL }]);
    expect(post).toMatchObject({ title: "Ours", source: "event" });
  });

  it("re-applies the feed's own rules — by-`d` is not a way around the curation", async () => {
    // The list view runs every candidate through `matchesFeed`; this read widens
    // `authors` to the declared feeds and used to trust whatever came back. So the
    // single-post route — a shared link, a menu target, any cold device with no
    // cached feed — rendered articles the organizer's own curation excludes, under
    // the curated feed's label, as part of the event's official feed.
    const src = { pubkey: OFFICIAL, tags: ["kosice"], since: 1000, label: "Lunarpunk" };

    // Right author, wrong hashtag: excluded on the posts page, so excluded here.
    fetchEvents.mockResolvedValue([
      ext(OFFICIAL, "off-topic", 1500, { hashtags: ["bratislava"] }),
    ]);
    expect(await fetchPostByD(ctx, "off-topic", [src])).toBeUndefined();

    // Right author, published before the organizer's `since` (and edited after,
    // which is exactly what gets past the relay-side filter).
    fetchEvents.mockResolvedValue([
      ext(OFFICIAL, "too-old", 1500, { hashtags: ["kosice"], publishedAt: 500 }),
    ]);
    expect(await fetchPostByD(ctx, "too-old", [src])).toBeUndefined();

    // An author nobody declared, answered by a relay that ignored `authors`.
    fetchEvents.mockResolvedValue([ext(OTHER, "sneaky", 1500, { hashtags: ["kosice"] })]);
    expect(await fetchPostByD(ctx, "sneaky", [src])).toBeUndefined();

    // ...and the article that DOES satisfy the declaration still resolves.
    fetchEvents.mockResolvedValue([
      ext(OFFICIAL, "kosice-1", 1500, { hashtags: ["kosice"], title: "Venue" }),
    ]);
    expect(await fetchPostByD(ctx, "kosice-1", [src])).toMatchObject({
      title: "Venue",
      feedLabel: "Lunarpunk",
    });
  });

  it("without declared feeds it queries E_id alone, exactly as before", async () => {
    fetchEvents.mockResolvedValue([pub("x", 100, "Hello")]);
    const post = await fetchPostByD(ctx, "x");
    expect(post).toMatchObject({ title: "Hello", source: "event" });
    expect(fetchEvents.mock.calls[0][0].authors).toEqual([EID]);
    expect(fetchEvents.mock.calls[0][1]).toEqual(["wss://event.example"]);
  });
});
