/**
 * Pending-talk moderation-queue logic (spec F2.3). The organizer unwraps 21609
 * talk submissions from E_inbox; `dedupePendingTalks` collapses them to the latest
 * per (speaker, talk_d) and hides any already published as a 31610 at the
 * same-or-newer revision. This is the pure core of `fetchPendingTalks`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the network + key/authority seams so fetchTalks' cache-preservation logic
// (Bug 2) can be exercised without a relay or real decryption. The pure
// dedupePendingTalks tests below are unaffected (they touch none of these).
vi.mock("$lib/nostr/ndk.js", () => ({
  fetchEvents: vi.fn(async () => []),
  fetchEventsRelayOnly: vi.fn(async () => []),
}));
vi.mock("./organizer.js", () => ({
  directoryPublisher: () => "f".repeat(64),
  acceptedRecordAuthors: () => new Set(["f".repeat(64)]),
}));
vi.mock("$lib/nostr/verify.js", () => ({
  onlyByAuthors: (events: unknown[]) => events,
}));
vi.mock("./keystore.js", () => ({
  loadEventKeys: vi.fn(async () => ({})),
  currentEck: vi.fn(() => undefined),
}));

import { dedupePendingTalks, fetchTalks, cachedTalks, type RawTalkSubmission } from "./talks.js";
import { currentEck } from "./keystore.js";
import type {
  EventContext,
} from "./event-context.js";
import type { MediaDescriptor, TalkContent, TalkSubmissionContent } from "@nostrautica/protocol";
import {
  __setPersistBackend,
  __resetPersistForTests,
  setActiveCacheOwner,
  cacheSet,
} from "$lib/cache/persist.js";

const media = { kind: "talk", x: "a".repeat(64) } as unknown as MediaDescriptor;

function sub(
  pubkey: string,
  talkD: string,
  rev: number,
  at: number,
  title = "Talk",
): RawTalkSubmission {
  const content = {
    v: 2,
    a: "31600:host:conf",
    talk_d: talkD,
    title,
    description: "",
    speakers: [],
    media,
    revision: rev,
  } as unknown as TalkSubmissionContent;
  return { pubkey, content, rumorCreatedAt: at };
}

describe("dedupePendingTalks", () => {
  it("keeps only the latest submission per (speaker, talk_d)", () => {
    const out = dedupePendingTalks(
      [
        sub("alice", "t1", 0, 100, "old"),
        sub("alice", "t1", 1, 200, "new"),
      ],
      new Map(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("new");
    expect(out[0].revision).toBe(1);
  });

  it("treats different speakers and different talk_ds as distinct", () => {
    const out = dedupePendingTalks(
      [
        sub("alice", "t1", 0, 100),
        sub("bob", "t1", 0, 110),
        sub("alice", "t2", 0, 120),
      ],
      new Map(),
    );
    expect(out).toHaveLength(3);
  });

  it("excludes talks already published at the same-or-newer revision", () => {
    const published = new Map([["alice:t1", 0]]);
    const out = dedupePendingTalks([sub("alice", "t1", 0, 100)], published);
    expect(out).toHaveLength(0);
  });

  it("re-surfaces an edit whose revision exceeds the published one", () => {
    const published = new Map([["alice:t1", 0]]);
    const out = dedupePendingTalks([sub("alice", "t1", 1, 300)], published);
    expect(out).toHaveLength(1);
    expect(out[0].revision).toBe(1);
  });

  it("orders the queue oldest-submitted first", () => {
    const out = dedupePendingTalks(
      [
        sub("bob", "t1", 0, 300),
        sub("alice", "t1", 0, 100),
        sub("carol", "t1", 0, 200),
      ],
      new Map(),
    );
    expect(out.map((t) => t.pubkey)).toEqual(["alice", "carol", "bob"]);
  });

  it("does not exclude when a different talk is published", () => {
    const published = new Map([["alice:other", 5]]);
    const out = dedupePendingTalks([sub("alice", "t1", 0, 100)], published);
    expect(out).toHaveLength(1);
  });
});

describe("fetchTalks cache preservation (Bug 2: disappearing talk)", () => {
  const COORD = "31600:host:conf";
  const ctx = {
    coordinate: COORD,
    config: { talks: "on", relays: [] },
  } as unknown as EventContext;

  function seededTalk(): TalkContent {
    return {
      v: 2,
      pubkey: "a".repeat(64),
      talk_d: "t1",
      title: "Seen talk",
      description: "",
      speakers: [],
      lang: "en",
      revision: 0,
      status: "published",
      published_at: 1000,
    } as unknown as TalkContent;
  }

  beforeEach(() => {
    __resetPersistForTests();
    // A minimal in-memory backend; the synchronous mirror is what the reads hit.
    const store = new Map<string, { at: number; data: unknown }>();
    __setPersistBackend({
      async getAll() {
        return [...store.entries()] as Array<[string, { at: number; data: unknown }]>;
      },
      async put(k, e) {
        const ex = store.get(k);
        if (!ex || e.at >= ex.at) store.set(k, e);
      },
      async delete(ks) {
        for (const k of ks) store.delete(k);
      },
    });
    setActiveCacheOwner("owner1");
    vi.mocked(currentEck).mockReturnValue(undefined);
  });

  it("returns the last-seen talks when the ECK isn't available yet (no blank)", async () => {
    cacheSet(`talks:${COORD}`, [{ talk: seededTalk(), d: "t1" }], 1000);
    // currentEck → undefined (keys still recovering): must NOT return [].
    const out = await fetchTalks(ctx);
    expect(out).toHaveLength(1);
    expect(out[0].talk.title).toBe("Seen talk");
  });

  it("keeps a prior non-empty cache when a fetch decrypts zero talks (transient miss)", async () => {
    cacheSet(`talks:${COORD}`, [{ talk: seededTalk(), d: "t1" }], 1000);
    // ECK present, but the (mocked) relay answers empty — the reported flicker.
    vi.mocked(currentEck).mockReturnValue({ key: "AAAA" } as never);
    const out = await fetchTalks(ctx);
    expect(out).toHaveLength(1);
    // The cache is untouched, so the next paint is still non-empty.
    expect(cachedTalks(COORD)).toHaveLength(1);
  });

  it("commits an empty set only when there was no prior cache (genuinely empty)", async () => {
    vi.mocked(currentEck).mockReturnValue({ key: "AAAA" } as never);
    const out = await fetchTalks(ctx);
    expect(out).toHaveLength(0);
    expect(cachedTalks(COORD)).toEqual([]);
  });
});
