/**
 * What the event-open warmers actually ask for.
 *
 * `prefetchAttendeesTab` and `prefetchEventContent` are called back to back
 * whenever a member opens an event, and both used to run the People fan-out —
 * directory, profiles, matches — under different `warm()` keys. Two keys means
 * no dedupe, so every event open fetched, signature-checked and ECK-decrypted
 * the entire roster twice, concurrently, on the main thread, while the event
 * page was still painting. On a 120-person roster that measured as 240 Schnorr
 * verifies instead of 120 (~1.2 ms each on a laptop, several times that on a
 * phone), for a result the second pass could only duplicate.
 *
 * These tests pin the call shape rather than the timing: exactly one directory
 * fetch, one profile fetch, one match fetch per event open — and matches still
 * never fetched for a signer that would have to prompt for them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "$lib/events/event-context.js";

const h = vi.hoisted(() => ({
  connectNdk: vi.fn(async () => {}),
  fetchDirectory: vi.fn(async () => [{ pubkey: "a".repeat(64) }]),
  fetchRoster: vi.fn(async () => ({ v: 2, eck_current: 1, attendees: [] })),
  fetchMatches: vi.fn(async () => undefined),
  receiveGrants: vi.fn(async () => []),
  fetchProfiles: vi.fn(async () => new Map()),
  fetchFollowSet: vi.fn(async () => new Set()),
  fetchEventPage: vi.fn(async () => undefined),
  fetchEventPosts: vi.fn(async () => []),
  fetchAttendeePosts: vi.fn(async () => []),
  fetchTalks: vi.fn(async () => []),
  fetchEventTheme: vi.fn(async () => undefined),
}));

vi.mock("$lib/nostr/ndk.js", () => ({ connectNdk: h.connectNdk }));
vi.mock("$lib/events/attendee.js", () => ({
  fetchDirectory: h.fetchDirectory,
  fetchMatches: h.fetchMatches,
  fetchRoster: h.fetchRoster,
  receiveGrants: h.receiveGrants,
}));
vi.mock("$lib/events/social.js", () => ({
  fetchProfiles: h.fetchProfiles,
  fetchFollowSet: h.fetchFollowSet,
}));
vi.mock("$lib/events/event-page.js", () => ({ fetchEventPage: h.fetchEventPage }));
vi.mock("$lib/events/posts.js", () => ({
  fetchEventPosts: h.fetchEventPosts,
  fetchAttendeePosts: h.fetchAttendeePosts,
}));
vi.mock("$lib/events/talks.js", () => ({
  fetchTalks: h.fetchTalks,
  fetchPendingTalks: vi.fn(async () => []),
}));
vi.mock("$lib/events/theme.js", () => ({ fetchEventTheme: h.fetchEventTheme }));
vi.mock("$lib/events/event-context.js", () => ({
  loadEventContext: vi.fn(async () => undefined),
  cachedEventContext: vi.fn(() => undefined),
}));
vi.mock("$lib/events/recover.js", () => ({ recoverEventKeys: vi.fn(async () => {}) }));
vi.mock("$lib/events/dm.js", () => ({
  fetchDms: vi.fn(async () => []),
  fetchDmRelays: vi.fn(async () => []),
}));
vi.mock("$lib/events/blinding.js", () => ({ deriveBlindingKey: vi.fn(async () => new Uint8Array(32)) }));
vi.mock("$lib/stores/mutes.svelte.js", () => ({ mutes: { load: vi.fn(async () => {}) } }));
vi.mock("$lib/events/organizer.js", () => ({
  fetchPending: vi.fn(async () => []),
  fetchCoordinatorLastSeen: vi.fn(async () => undefined),
}));
vi.mock("$lib/events/coordinator-status.js", () => ({
  fetchCoordinatorStatuses: vi.fn(async () => []),
}));

const { prefetchAttendeesTab, prefetchEventContent, __resetPrefetchForTests } = await import(
  "./prefetch.js"
);

const ctx = {
  coordinate: "31923:" + "e".repeat(64) + ":ev",
  naddr: "naddr1x",
  title: "Ev",
  config: { coordinator: "c".repeat(64), talks: "off" },
} as unknown as EventContext;

const localSigner = { method: "local", getSecretKey: () => new Uint8Array(32) } as unknown as AppSigner;
const remoteSigner = { method: "nip46" } as unknown as AppSigner;

/** Let every fire-and-forget warm job run to completion. */
const drain = () => new Promise<void>((r) => setTimeout(r, 10));

beforeEach(() => {
  vi.clearAllMocks();
  __resetPrefetchForTests();
});

describe("event-open warmers", () => {
  it("fetches the directory exactly once when both warmers fire", async () => {
    // The real call site: EventHome runs these one after the other.
    prefetchAttendeesTab(ctx, localSigner);
    prefetchEventContent(ctx, localSigner);
    await drain();
    expect(h.fetchDirectory).toHaveBeenCalledTimes(1);
    expect(h.fetchProfiles).toHaveBeenCalledTimes(1);
    expect(h.fetchMatches).toHaveBeenCalledTimes(1);
  });

  it("does not spend a separate roster read on the People warm", async () => {
    // fetchDirectory fetches the roster itself, so awaiting one first was a
    // serial extra round-trip that delayed the entry read by a full RTT.
    prefetchAttendeesTab(ctx, localSigner);
    await drain();
    expect(h.fetchDirectory).toHaveBeenCalledTimes(1);
    expect(h.fetchRoster).not.toHaveBeenCalled();
  });

  it("still warms the rest of the event content", async () => {
    prefetchEventContent(ctx, localSigner);
    await drain();
    expect(h.fetchEventPage).toHaveBeenCalledTimes(1);
    expect(h.fetchEventPosts).toHaveBeenCalledTimes(1);
    expect(h.fetchAttendeePosts).toHaveBeenCalledTimes(1);
    expect(h.fetchEventTheme).toHaveBeenCalledTimes(1);
  });

  it("never fetches matches for a signer that would have to prompt", async () => {
    // HARD CONSTRAINT 2: a background warmer must not make Amber pop a dialog.
    prefetchEventContent(ctx, remoteSigner);
    await drain();
    expect(h.fetchDirectory).toHaveBeenCalledTimes(1); // ECK-only, no signer
    expect(h.fetchMatches).not.toHaveBeenCalled();
  });

  it("warms the directory even when the event has no coordinator", async () => {
    const noCoordinator = {
      ...ctx,
      config: { talks: "off" },
    } as unknown as EventContext;
    prefetchAttendeesTab(noCoordinator, localSigner);
    await drain();
    expect(h.fetchDirectory).toHaveBeenCalledTimes(1);
    expect(h.fetchMatches).not.toHaveBeenCalled();
  });

  it("is a no-op on a repeat trigger inside the warm TTL", async () => {
    prefetchAttendeesTab(ctx, localSigner);
    await drain();
    prefetchAttendeesTab(ctx, localSigner);
    await drain();
    expect(h.fetchDirectory).toHaveBeenCalledTimes(1);
  });
});
