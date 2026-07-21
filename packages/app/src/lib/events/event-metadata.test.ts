import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
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

const { fetchEvents, publishOrQueue, loadEventKeys, cacheEventContext } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  publishOrQueue: vi.fn(),
  loadEventKeys: vi.fn(),
  cacheEventContext: vi.fn(),
}));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents }));
vi.mock("$lib/nostr/publish-queue.js", () => ({ publishOrQueue }));
vi.mock("./keystore.js", () => ({ loadEventKeys }));
vi.mock("./event-context.js", () => ({ cacheEventContext }));

import { updateEventMetadata } from "./event-metadata.js";

const config = {
  d: identifier,
  eidPubkey: eid,
  inbox: getPublicKey(generateSecretKey()),
  relays: ["wss://relay.example"],
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

describe("updateEventMetadata", () => {
  beforeEach(() => {
    fetchEvents.mockReset();
    publishOrQueue.mockReset().mockResolvedValue(undefined);
    loadEventKeys.mockReset().mockResolvedValue({
      role: "organizer",
      eidNsecHex: bytesToHex(eidSk),
    });
    cacheEventContext.mockReset();
  });

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

    const updated = await updateEventMetadata(ctx, {
      title: "New title",
      summary: "New summary",
      start: 200,
      end: 300,
      location: "Prague",
      icon: "https://new.example/icon.jpg",
      banner: "https://new.example/banner.jpg",
    });

    const published = publishOrQueue.mock.calls.map(([event]) => event);
    const nextCalendar = published.find((event) => event.kind === KIND_CALENDAR_EVENT)!;
    const nextProfile = published.find((event) => event.kind === KIND_PROFILE)!;
    expect(nextCalendar.pubkey).toBe(eid);
    expect(nextCalendar.tags).toContainEqual(["d", identifier]);
    expect(nextCalendar.tags).toContainEqual(["title", "New title"]);
    expect(nextCalendar.tags).toContainEqual(["start_tzid", "Europe/Bratislava"]);
    expect(nextCalendar.tags).toContainEqual(["g", "u2s1"]);
    expect(nextCalendar.tags).toContainEqual(["t", "nostr"]);
    expect(nextCalendar.tags).not.toContainEqual(["title", "Old title"]);
    expect(JSON.parse(nextProfile.content)).toEqual({
      name: "New title",
      about: "New summary",
      picture: "https://new.example/icon.jpg",
      banner: "https://new.example/banner.jpg",
      website: "https://event.example",
    });
    expect(updated).toMatchObject({
      coordinate,
      naddr: ctx.naddr,
      title: "New title",
      start: 200,
      end: 300,
    });
    expect(cacheEventContext).toHaveBeenCalledWith(updated, nextCalendar.created_at);
  });

  it("removes optional image, end, and location fields when cleared", async () => {
    fetchEvents.mockResolvedValue([]);
    await updateEventMetadata(ctx, {
      title: "No extras",
      summary: "",
      start: 200,
    });

    const published = publishOrQueue.mock.calls.map(([event]) => event);
    const nextCalendar = published.find((event) => event.kind === KIND_CALENDAR_EVENT)!;
    const nextProfile = published.find((event) => event.kind === KIND_PROFILE)!;
    expect(nextCalendar.tags.some((tag: string[]) => ["end", "location", "image"].includes(tag[0]!))).toBe(false);
    expect(JSON.parse(nextProfile.content)).toEqual({
      name: "No extras",
      about: "",
    });
  });
});
