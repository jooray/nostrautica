import { describe, it, expect, beforeEach, vi } from "vitest";

const { cachedRoster, fetchRoster, fetchProfiles } = vi.hoisted(() => ({
  cachedRoster: vi.fn(),
  fetchRoster: vi.fn(),
  fetchProfiles: vi.fn(),
}));
vi.mock("$lib/events/attendee.js", () => ({ cachedRoster, fetchRoster }));
vi.mock("$lib/events/social.js", () => ({ fetchProfiles }));

import { warmChatTab, chatProfilePubkeys, __resetChatWarmForTests } from "./warm.js";
import type { EventContext } from "$lib/events/event-context.js";
import type { RosterContent } from "@nostrautica/protocol";

const ACCOUNT_A = "a".repeat(64);
const DEVICE_A1 = "1".repeat(64);
const DEVICE_A2 = "2".repeat(64);
const ACCOUNT_B = "b".repeat(64);

const roster = {
  v: 2,
  eck_current: 1,
  attendees: [
    {
      pubkey: ACCOUNT_A,
      role: "attendee",
      chat_keys: [
        { pubkey: DEVICE_A1, added_at: 1 },
        { pubkey: DEVICE_A2, added_at: 2 },
      ],
    },
    { pubkey: ACCOUNT_B, role: "organizer" },
  ],
} as unknown as RosterContent;

const ctx = { coordinate: "31923:eid:ev", config: { relays: [] } } as unknown as EventContext;

/** Let the warmer's detached async body run to completion. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("chatProfilePubkeys", () => {
  it("covers both halves of a chat name: the account AND each attested device key", () => {
    // A bubble is signed by the DEVICE key and attributed to the ACCOUNT after the
    // roster dedupe, so warming only one of the two still leaves the room painting
    // truncated pubkeys for the other.
    expect(chatProfilePubkeys(roster).sort()).toEqual(
      [ACCOUNT_A, ACCOUNT_B, DEVICE_A1, DEVICE_A2].sort(),
    );
  });

  it("is empty (and harmless) with no roster yet", () => {
    expect(chatProfilePubkeys(undefined)).toEqual([]);
  });
});

describe("warmChatTab", () => {
  beforeEach(() => {
    __resetChatWarmForTests();
    cachedRoster.mockReset();
    fetchRoster.mockReset();
    fetchProfiles.mockReset();
    fetchProfiles.mockResolvedValue(new Map());
  });

  it("warms every chat profile from the cached roster without re-fetching it", async () => {
    cachedRoster.mockReturnValue(roster);
    warmChatTab(ctx);
    await settle();
    expect(fetchRoster).not.toHaveBeenCalled();
    expect(fetchProfiles).toHaveBeenCalledTimes(1);
    expect((fetchProfiles.mock.calls[0]![0] as string[]).sort()).toEqual(
      [ACCOUNT_A, ACCOUNT_B, DEVICE_A1, DEVICE_A2].sort(),
    );
  });

  it("falls back to fetching the roster when none is cached", async () => {
    cachedRoster.mockReturnValue(undefined);
    fetchRoster.mockResolvedValue(roster);
    warmChatTab(ctx);
    await settle();
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(fetchProfiles).toHaveBeenCalledTimes(1);
  });

  it("is a no-op on a repeat trigger — bouncing between event tabs costs nothing", async () => {
    cachedRoster.mockReturnValue(roster);
    warmChatTab(ctx);
    await settle();
    warmChatTab(ctx);
    await settle();
    expect(fetchProfiles).toHaveBeenCalledTimes(1);
  });

  it("swallows a failing roster read — a warmer must never fail a chat session", async () => {
    cachedRoster.mockReturnValue(undefined);
    fetchRoster.mockRejectedValue(new Error("relay down"));
    expect(() => warmChatTab(ctx)).not.toThrow();
    await settle();
    expect(fetchProfiles).not.toHaveBeenCalled();
    // ...and the failure is still stamped, so a dead relay can't turn every
    // re-entry into another full timeout (prefetch.ts's own lesson).
    fetchRoster.mockResolvedValue(roster);
    warmChatTab(ctx);
    await settle();
    expect(fetchRoster).toHaveBeenCalledTimes(1);
  });
});
