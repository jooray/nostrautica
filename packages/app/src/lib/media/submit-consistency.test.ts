import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "$lib/events/event-context.js";
import type { AttendeeProfile } from "@nostrautica/protocol";

const mocks = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  fetchEvents: vi.fn(),
  fetchEventsRelayOnly: vi.fn(),
  publishOrQueue: vi.fn(),
  signerWrap: vi.fn(),
  cachedDirectoryEntry: vi.fn(),
  fetchDirectoryEntry: vi.fn(),
}));

vi.mock("$lib/cache/persist.js", () => ({
  cacheGet: mocks.cacheGet,
  cacheSet: mocks.cacheSet,
}));
vi.mock("$lib/nostr/ndk.js", () => ({
  fetchEvents: mocks.fetchEvents,
  fetchEventsRelayOnly: mocks.fetchEventsRelayOnly,
}));
vi.mock("$lib/events/attendee.js", () => ({
  cachedDirectoryEntry: mocks.cachedDirectoryEntry,
  fetchDirectoryEntry: mocks.fetchDirectoryEntry,
}));
vi.mock("$lib/nostr/publish-queue.js", () => ({
  publishOrQueue: mocks.publishOrQueue,
  toOutcome: (published: boolean) => (published ? "published" : "queued"),
}));
vi.mock("$lib/events/giftwrap.js", () => ({ signerWrap: mocks.signerWrap }));
vi.mock("$lib/blossom/client.js", () => ({
  preflight: vi.fn(),
  uploadAndMirror: vi.fn(),
  mirror: vi.fn(),
  downloadBlob: vi.fn(),
  isAcceptedBlossomUrl: () => true,
}));

import {
  submitProfileAndMedia,
  loadAuthoredState,
  cacheSelfCopy,
  emptyProfile,
} from "./submit.js";

const PK = "a".repeat(64);
const profile: AttendeeProfile = { about: "Builder", skills: [], looking_for: "", links: [] };
let eventId = 0;

function context(coordinate: string): EventContext {
  return {
    coordinate,
    config: { inbox: "b".repeat(64), relays: [] },
  } as unknown as EventContext;
}

function signer(): AppSigner {
  return {
    method: "local",
    getPublicKey: async () => PK,
    nip44Encrypt: async (_pubkey: string, plaintext: string) => plaintext,
    nip44Decrypt: async (_pubkey: string, ciphertext: string) => ciphertext,
    signEvent: async (event: Record<string, unknown>) => ({
      ...event,
      id: `event-${++eventId}`,
      pubkey: PK,
      sig: "c".repeat(128),
    }),
  } as unknown as AppSigner;
}

/**
 * A faithful stand-in for the persistent cache, including its latest-wins rule
 * (§3.2). The revision high-water mark this module now keeps lives here, so a
 * mock that always answered `undefined` would test the exact state the fix
 * exists to stop relying on.
 */
const cacheStore = new Map<string, { at: number; data: unknown }>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
  cacheStore.clear();
  mocks.cacheGet.mockImplementation((key: string) => cacheStore.get(key));
  mocks.cacheSet.mockImplementation((key: string, data: unknown, at: number) => {
    const prev = cacheStore.get(key);
    if (!prev || at >= prev.at) cacheStore.set(key, { at, data });
  });
  mocks.fetchEvents.mockResolvedValue([]);
  mocks.fetchEventsRelayOnly.mockResolvedValue([]);
  mocks.cachedDirectoryEntry.mockReturnValue(undefined);
  mocks.fetchDirectoryEntry.mockResolvedValue(undefined);
  mocks.publishOrQueue.mockResolvedValue(true);
  mocks.signerWrap.mockResolvedValue({ id: "wrap", pubkey: PK, created_at: 1, kind: 1059, tags: [], content: "", sig: "" });
});

/** The `rev` carried by the 21601 rumor of the Nth submission in a test. */
function submittedRevs(): number[] {
  return mocks.signerWrap.mock.calls.map(
    ([, , rumor]) => (rumor as { content: { rev: number } }).content.rev,
  );
}

afterEach(() => vi.useRealTimers());

describe("profile self-copy consistency", () => {
  it.each([true, false])(
    "writes the self-copy through after a durable publish result (%s)",
    async (published) => {
      const coordinate = `31923:${PK}:cache-write-${published}`;
      mocks.publishOrQueue.mockResolvedValue(published);
      const result = await submitProfileAndMedia(signer(), context(coordinate), {
        profile,
        media: [],
        introText: "  Immediate intro  ",
        blindingKey: new Uint8Array(32),
      });

      expect(result.selfCopy).toBe(published ? "published" : "queued");
      const write = mocks.cacheSet.mock.calls.find(([key]) => key === `selfcopy:${coordinate}`);
      expect(write?.[1]).toEqual({ profile, media: [], introText: "Immediate intro", rev: 0 });
      expect(write?.[2]).toBeGreaterThan(0);
    },
  );

  it("gives same-second replacements strictly increasing created_at values", async () => {
    const coordinate = `31923:${PK}:same-second`;
    const appSigner = signer();
    const args = { profile, media: [], introText: "intro", blindingKey: new Uint8Array(32) };

    await submitProfileAndMedia(appSigner, context(coordinate), args);
    await submitProfileAndMedia(appSigner, context(coordinate), args);

    const selfEvents = mocks.publishOrQueue.mock.calls
      .map(([event]) => event as { content?: string; created_at?: number })
      .filter((event) => {
        try {
          return JSON.parse(event.content ?? "").a === coordinate;
        } catch {
          return false;
        }
      });
    expect(selfEvents).toHaveLength(2);
    expect(selfEvents[1].created_at).toBeGreaterThan(selfEvents[0].created_at!);
  });
});

describe("submission revision never regresses on a failed read", () => {
  const args = { profile, media: [], blindingKey: new Uint8Array(32) };

  it("advances across submissions even when every relay read comes back empty", async () => {
    // The relay read returning nothing is the ORDINARY failure here: fetchEvents
    // settles with whatever arrived and never rejects, so an 8s timeout on venue
    // Wi-Fi is indistinguishable from "no self-copy exists". Re-deriving the
    // counter from that answer sent rev 0 again, and the coordinator discards a
    // submission whose (rev, created_at, id) key loses to the stored one.
    const coordinate = `31923:${PK}:no-read`;
    const appSigner = signer();
    await submitProfileAndMedia(appSigner, context(coordinate), args);
    await submitProfileAndMedia(appSigner, context(coordinate), args);
    await submitProfileAndMedia(appSigner, context(coordinate), args);

    expect(submittedRevs()).toEqual([0, 1, 2]);
  });

  it("jumps ahead of a self-copy written by another device", async () => {
    const coordinate = `31923:${PK}:other-device`;
    cacheSelfCopy(coordinate, { media: [], rev: 0 }, 1);
    // The other device is at rev 7; this one has only ever seen rev 0.
    mocks.fetchEventsRelayOnly.mockResolvedValue([
      { id: "e1", created_at: 99, content: JSON.stringify({ rev: 7, media: [] }) },
    ]);

    await submitProfileAndMedia(signer(), context(coordinate), args);
    expect(submittedRevs()).toEqual([8]);
  });

  it("keeps the floor when a self-copy reports an OLDER rev than we have sent", async () => {
    const coordinate = `31923:${PK}:stale-read`;
    const appSigner = signer();
    await submitProfileAndMedia(appSigner, context(coordinate), args); // rev 0
    await submitProfileAndMedia(appSigner, context(coordinate), args); // rev 1
    // A relay serving a stale replica hands back the rev-0 self-copy.
    mocks.fetchEventsRelayOnly.mockResolvedValue([
      { id: "e1", created_at: 1, content: JSON.stringify({ rev: 0, media: [] }) },
    ]);
    await submitProfileAndMedia(appSigner, context(coordinate), args);

    expect(submittedRevs()).toEqual([0, 1, 2]);
  });
});

describe("loadAuthoredState never presents an unreadable profile as an empty one", () => {
  const authored = { about: "Builder", skills: ["rust"], looking_for: "co-founder", links: [] };

  it("falls back to the persisted self-copy when the relays answer nothing", async () => {
    const coordinate = `31923:${PK}:cache-fallback`;
    cacheSelfCopy(coordinate, { profile: authored, media: [], rev: 3 }, 10);

    const state = await loadAuthoredState(signer(), context(coordinate), new Uint8Array(32));
    expect(state?.profile).toEqual(authored);
  });

  it("falls back to the published directory entry on a cold cache", async () => {
    const coordinate = `31923:${PK}:dir-fallback`;
    mocks.cachedDirectoryEntry.mockReturnValue({
      pubkey: PK,
      profile: authored,
      media: [],
      intro_text: "hello",
    });

    const state = await loadAuthoredState(signer(), context(coordinate), new Uint8Array(32));
    expect(state?.profile).toEqual(authored);
    expect(state?.introText).toBe("hello");
  });

  it("is undefined only when relays, cache and directory all say nothing", async () => {
    const coordinate = `31923:${PK}:genuinely-new`;
    expect(
      await loadAuthoredState(signer(), context(coordinate), new Uint8Array(32)),
    ).toBeUndefined();
  });
});

describe("emptyProfile", () => {
  it("hands out a fresh object so one submission cannot mutate the next", () => {
    const first = emptyProfile();
    first.skills.push("leaked");
    expect(emptyProfile().skills).toEqual([]);
  });
});
