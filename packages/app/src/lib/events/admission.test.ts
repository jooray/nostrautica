/**
 * Organizer-only (no-coordinator) admission ordering (audit P4). `fetchPending`
 * must select profile submissions by the shared (rev, created_at, lowest id)
 * revision comparator — mirroring the coordinator-backed path — and apply the
 * global §3.1 tie-break to join requests, not first-arrival-wins.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  wrapRumor,
  unwrapRumor,
  bytesToHex,
  KIND_JOIN_REQUEST,
  KIND_PROFILE_SUBMISSION,
  type AttendeeProfile,
} from "@nostrautica/protocol";
import type { GiftWrap } from "@nostrautica/protocol";

const { fetchEventsRelayOnly } = vi.hoisted(() => ({ fetchEventsRelayOnly: vi.fn() }));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents: vi.fn(), fetchEventsRelayOnly }));

import { fetchPending } from "./organizer.js";
import type { EventContext } from "./event-context.js";
import type { EventKeys } from "./keystore.js";

const einboxSk = generateSecretKey();
const einboxPubkey = getPublicKey(einboxSk);
const attendeeSk = generateSecretKey();

const ctx = {
  coordinate: `31600:${"e".repeat(64)}:party`,
  config: { relays: ["wss://r"] },
} as unknown as EventContext;
const keys: EventKeys = {
  coordinate: ctx.coordinate,
  role: "organizer",
  eck: [],
  einboxNsecHex: bytesToHex(einboxSk),
};

function profile(about: string): AttendeeProfile {
  return { about, skills: [], looking_for: "", links: [] };
}

function joinWrap(message: string, created_at: number): GiftWrap {
  return wrapRumor(attendeeSk, einboxPubkey, {
    kind: KIND_JOIN_REQUEST,
    content: { v: 2, name: "Ann", message, rsvp_public: false },
    created_at,
  });
}

function subWrap(about: string, rev: number, created_at: number): GiftWrap {
  return wrapRumor(attendeeSk, einboxPubkey, {
    kind: KIND_PROFILE_SUBMISSION,
    content: { v: 2, rev, profile: profile(about), media: [] },
    created_at,
  });
}

beforeEach(() => {
  fetchEventsRelayOnly.mockReset();
});

describe("fetchPending profile-submission revision ordering (audit P4)", () => {
  it("keeps the higher rev even when it has an OLDER wall-clock timestamp", async () => {
    // rev 2 was authored first (older created_at); a delayed rev 1 arrives with a
    // newer clock. `rev` is the primary key, so rev 2's profile must win.
    const rev2 = subWrap("rev-2 bio", 2, 1000);
    const rev1 = subWrap("rev-1 bio", 1, 5000);
    const join = joinWrap("hi", 1000);
    for (const order of [
      [join, rev2, rev1],
      [join, rev1, rev2],
    ]) {
      fetchEventsRelayOnly.mockResolvedValue(order);
      const pending = await fetchPending(ctx, keys);
      expect(pending).toHaveLength(1);
      expect(pending[0].profile?.about).toBe("rev-2 bio");
    }
  });

  it("breaks an equal (rev, created_at) tie on the lowest rumor id", async () => {
    // Same rev and created_at, different content → different ids. The §3.3
    // comparator's final key is the lowest rumor id.
    const a = subWrap("bio A", 3, 2000);
    const b = subWrap("bio B", 3, 2000);
    const idA = unwrapRumor(a, einboxSk).id;
    const idB = unwrapRumor(b, einboxSk).id;
    const lowerAbout = idA < idB ? "bio A" : "bio B";
    const join = joinWrap("hi", 2000);
    for (const order of [
      [join, a, b],
      [join, b, a],
    ]) {
      fetchEventsRelayOnly.mockResolvedValue(order);
      const pending = await fetchPending(ctx, keys);
      expect(pending[0].profile?.about).toBe(lowerAbout);
    }
  });
});

describe("fetchPending join-request tie-break (audit P4)", () => {
  it("breaks an equal-created_at join tie on the lowest rumor id, both orders", async () => {
    const a = joinWrap("message A", 3000);
    const b = joinWrap("message B", 3000);
    const idA = unwrapRumor(a, einboxSk).id;
    const idB = unwrapRumor(b, einboxSk).id;
    const lowerMessage = idA < idB ? "message A" : "message B";
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      fetchEventsRelayOnly.mockResolvedValue(order);
      const pending = await fetchPending(ctx, keys);
      expect(pending).toHaveLength(1);
      expect(pending[0].message).toBe(lowerMessage);
    }
  });

  it("still prefers a strictly newer join request", async () => {
    const older = joinWrap("old", 1000);
    const newer = joinWrap("new", 9000);
    fetchEventsRelayOnly.mockResolvedValue([newer, older]);
    const pending = await fetchPending(ctx, keys);
    expect(pending[0].message).toBe("new");
  });
});
