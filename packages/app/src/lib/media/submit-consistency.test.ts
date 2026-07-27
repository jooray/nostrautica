import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "$lib/events/event-context.js";
import type { AttendeeProfile } from "@nostrautica/protocol";

const mocks = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  fetchEvents: vi.fn(),
  publishOrQueue: vi.fn(),
  signerWrap: vi.fn(),
}));

vi.mock("$lib/cache/persist.js", () => ({
  cacheGet: mocks.cacheGet,
  cacheSet: mocks.cacheSet,
}));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents: mocks.fetchEvents }));
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

import { submitProfileAndMedia } from "./submit.js";

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
  mocks.cacheGet.mockReturnValue(undefined);
  mocks.fetchEvents.mockResolvedValue([]);
  mocks.publishOrQueue.mockResolvedValue(true);
  mocks.signerWrap.mockResolvedValue({ id: "wrap", pubkey: PK, created_at: 1, kind: 1059, tags: [], content: "", sig: "" });
});

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
