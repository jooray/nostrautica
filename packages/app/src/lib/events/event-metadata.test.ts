import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { VerifiedEvent } from "nostr-tools/pure";
import {
  KIND_CALENDAR_EVENT,
  KIND_PROFILE,
  bytesToHex,
  makeCoordinate,
  type EventConfig,
} from "@nostrautica/protocol";

const eidSk = generateSecretKey();
const eid = getPublicKey(eidSk);
const identifier = "editable-event";
const coordinate = makeCoordinate(eid, identifier);

// event-metadata now routes both republishes through publishMonotonic (R6). The
// mock invokes the caller's `sign` at a deterministic created_at and records the
// resulting signed event, so the tests still inspect the exact events published.
const { fetchEvents, publishMonotonic, loadEventKeys, cacheEventContext } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  publishMonotonic: vi.fn(),
  loadEventKeys: vi.fn(),
  cacheEventContext: vi.fn(),
}));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents }));
vi.mock("$lib/nostr/monotonic.js", () => ({ publishMonotonic }));
vi.mock("$lib/nostr/publish-queue.js", () => ({
  toOutcome: (b: boolean) => (b ? "published" : "queued"),
}));
vi.mock("$lib/nostr/verify.js", () => ({ onlyVerified: (e: unknown) => e }));
vi.mock("./keystore.js", () => ({ loadEventKeys }));
vi.mock("./event-context.js", () => ({ cacheEventContext }));

import { updateEventMetadata } from "./event-metadata.js";

const config = {
  d: identifier,
  eidPubkey: eid,
  inbox: getPublicKey(generateSecretKey()),
  relays: ["wss://relay.example"],
  chatRelays: [],
  blossom: [],
  maxVideoSec: 90,
  maxTalkSec: 900,
  matching: "on",
  matchVisibility: "pair",
  approval: "manual",
  eck: 1,
  nostrContext: 100,
  lang: "en",
  talks: "off",
  chat: [],
} satisfies EventConfig;

const ctx = {
  naddr: "naddr1test",
  coordinate,
  config,
  title: "Old title",
  summary: "Old summary",
  start: 100,
  icon: "https://old.example/icon.jpg",
  banner: "https://old.example/banner.jpg",
  hashtags: ["nostr"],
  contextAt: 10,
};

/** Signed events captured from the publishMonotonic mock, by kind. */
let published: VerifiedEvent[] = [];
let publishedOk = true;

// Realistic UTC timestamps so the day-index assertions read as real conformance.
const DAY = 86400;
const start = Date.UTC(2026, 6, 24, 12, 0, 0) / 1000; // 2026-07-24 12:00Z
const startDayIndex = String(Math.floor(start / DAY));

beforeEach(() => {
  published = [];
  publishedOk = true;
  fetchEvents.mockReset();
  publishMonotonic.mockReset().mockImplementation(
    async (input: {
      sign: (createdAt: number) => VerifiedEvent | Promise<VerifiedEvent>;
    }) => {
      const createdAt = 1_000;
      const event = await input.sign(createdAt);
      published.push(event);
      return { published: publishedOk, createdAt };
    },
  );
  loadEventKeys.mockReset().mockResolvedValue({
    role: "organizer",
    eidNsecHex: bytesToHex(eidSk),
  });
  cacheEventContext.mockReset();
});

describe("updateEventMetadata", () => {
  it("replaces managed metadata while preserving the coordinate and unknown NIP-52 tags", async () => {
    const calendar = finalizeEvent(
      {
        kind: KIND_CALENDAR_EVENT,
        created_at: 20,
        tags: [
          ["d", identifier],
          ["title", "Old title"],
          ["start", "100"],
          ["summary", "Old summary"],
          ["image", "https://old.example/banner.jpg"],
          ["start_tzid", "Europe/Bratislava"],
          ["g", "u2s1"],
          ["t", "nostr"],
        ],
        content: "Old summary",
      },
      eidSk,
    );
    const profile = finalizeEvent(
      {
        kind: KIND_PROFILE,
        created_at: 19,
        tags: [],
        content: JSON.stringify({
          name: "Old title",
          about: "Old summary",
          picture: "https://old.example/icon.jpg",
          banner: "https://old.example/banner.jpg",
          website: "https://event.example",
        }),
      },
      eidSk,
    );
    fetchEvents.mockImplementation((filter: { kinds?: number[] }) =>
      Promise.resolve(filter.kinds?.[0] === KIND_CALENDAR_EVENT ? [calendar] : [profile]),
    );

    const { ctx: updated, outcome } = await updateEventMetadata(ctx, {
      title: "New title",
      summary: "New summary",
      start,
      end: start + DAY, // ends exactly 24h later, before midnight-of-day+2
      location: "Prague",
      icon: "https://new.example/icon.jpg",
      banner: "https://new.example/banner.jpg",
    });

    const nextCalendar = published.find((event) => event.kind === KIND_CALENDAR_EVENT)!;
    const nextProfile = published.find((event) => event.kind === KIND_PROFILE)!;
    expect(nextCalendar.pubkey).toBe(eid);
    expect(nextCalendar.tags).toContainEqual(["d", identifier]);
    expect(nextCalendar.tags).toContainEqual(["title", "New title"]);
    expect(nextCalendar.tags).toContainEqual(["start_tzid", "Europe/Bratislava"]);
    expect(nextCalendar.tags).toContainEqual(["g", "u2s1"]);
    expect(nextCalendar.tags).toContainEqual(["t", "nostr"]);
    expect(nextCalendar.tags).not.toContainEqual(["title", "Old title"]);
    // R5: decimal day-index D tags rebuilt from the new dates (2 UTC days).
    expect(nextCalendar.tags).toContainEqual(["D", startDayIndex]);
    expect(nextCalendar.tags).toContainEqual(["D", String(Number(startDayIndex) + 1)]);
    expect(JSON.parse(nextProfile.content)).toEqual({
      name: "New title",
      about: "New summary",
      picture: "https://new.example/icon.jpg",
      banner: "https://new.example/banner.jpg",
      website: "https://event.example",
    });
    expect(updated).toMatchObject({ coordinate, naddr: ctx.naddr, title: "New title", start });
    expect(outcome).toBe("published");
    expect(cacheEventContext).toHaveBeenCalledWith(updated, 1_000);
  });

  it("removes optional image, end, and location fields when cleared", async () => {
    fetchEvents.mockResolvedValue([]);
    await updateEventMetadata(ctx, { title: "No extras", summary: "", start });

    const nextCalendar = published.find((event) => event.kind === KIND_CALENDAR_EVENT)!;
    const nextProfile = published.find((event) => event.kind === KIND_PROFILE)!;
    expect(
      nextCalendar.tags.some((tag: string[]) => ["end", "location", "image"].includes(tag[0]!)),
    ).toBe(false);
    // No end → a single start-day D tag.
    expect(nextCalendar.tags.filter((t: string[]) => t[0] === "D")).toEqual([["D", startDayIndex]]);
    expect(JSON.parse(nextProfile.content)).toEqual({ name: "No extras", about: "" });
  });

  it("rebuilds stale D tags on a date change and drops the old ones (R5)", async () => {
    // Prior calendar indexed under a DIFFERENT day than the new start.
    const oldDayIndex = String(Math.floor(start / DAY) - 30);
    const calendar = finalizeEvent(
      {
        kind: KIND_CALENDAR_EVENT,
        created_at: 20,
        tags: [
          ["d", identifier],
          ["title", "Old title"],
          ["start", String(start - 30 * DAY)],
          ["D", oldDayIndex],
        ],
        content: "Old summary",
      },
      eidSk,
    );
    fetchEvents.mockImplementation((filter: { kinds?: number[] }) =>
      Promise.resolve(filter.kinds?.[0] === KIND_CALENDAR_EVENT ? [calendar] : []),
    );

    await updateEventMetadata(ctx, { title: "Moved", summary: "s", start });
    const nextCalendar = published.find((event) => event.kind === KIND_CALENDAR_EVENT)!;
    const dTags = nextCalendar.tags.filter((t: string[]) => t[0] === "D");
    expect(dTags).toEqual([["D", startDayIndex]]);
    expect(nextCalendar.tags).not.toContainEqual(["D", oldDayIndex]);
  });

  it("reports a queued outcome when a republish only lands in the outbox (R9)", async () => {
    fetchEvents.mockResolvedValue([]);
    publishedOk = false; // both republishes queued
    const { outcome } = await updateEventMetadata(ctx, { title: "T", summary: "", start });
    expect(outcome).toBe("queued");
  });
});
