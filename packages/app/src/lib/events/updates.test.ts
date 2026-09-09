/**
 * Who is allowed to author an event update (spec §7.1 kind 30023 by E_id).
 *
 * Updates render as the organizer speaking — "venue change", "schedule posted" —
 * with no author attribution anywhere in the UI, because within this feed there
 * is only one possible author. That is exactly why the READ has to enforce it:
 * `authors` in a relay filter is what we ask for, not what we are guaranteed to
 * get back, so an unpinned read let any relay in the event's set put words in
 * the organizer's mouth.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { KIND_LONGFORM, makeCoordinate } from "@nostrautica/protocol";

const { fetchEvents } = vi.hoisted(() => ({ fetchEvents: vi.fn() }));
vi.mock("$lib/nostr/ndk.js", () => ({
  fetchEvents,
  fetchEventsRelayOnly: vi.fn(),
  publishSigned: vi.fn(),
  isAcceptedRelayUrl: (value: string) => value.startsWith("wss://"),
}));
vi.mock("$lib/nostr/verify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/nostr/verify.js")>()),
  onlyVerified: <T,>(events: T[]) => events,
}));

import { fetchEventUpdates } from "./updates.js";

const EID = "e".repeat(64);
const IMPOSTOR = "f".repeat(64);
const COORD = makeCoordinate(EID, "conf-2026");

function update(pubkey: string, d: string, title: string, createdAt: number) {
  return {
    id: `u-${d}-${createdAt}`,
    kind: KIND_LONGFORM,
    pubkey,
    created_at: createdAt,
    tags: [
      ["d", d],
      ["title", title],
      ["published_at", String(createdAt)],
      ["a", COORD],
    ],
    content: "body",
  };
}

describe("fetchEventUpdates author pinning", () => {
  beforeEach(() => fetchEvents.mockReset());

  it("keeps only E_id's own updates", async () => {
    fetchEvents.mockResolvedValue([
      update(IMPOSTOR, "fake", "The venue has moved to…", 9_000),
      update(EID, "real", "Schedule posted", 1_000),
    ]);
    expect((await fetchEventUpdates(COORD)).map((u) => u.title)).toEqual(["Schedule posted"]);
  });

  it("drops the forgery BEFORE the per-`d` dedupe, so it can't take an address", async () => {
    // Same `d` as a genuine update, newer: an unpinned reader would treat it as
    // an EDIT of the organizer's post and show it in place of the real text.
    fetchEvents.mockResolvedValue([
      update(IMPOSTOR, "venue", "Send bitcoin to…", 9_000),
      update(EID, "venue", "Doors at 9", 1_000),
    ]);
    expect((await fetchEventUpdates(COORD)).map((u) => u.title)).toEqual(["Doors at 9"]);
  });
});
