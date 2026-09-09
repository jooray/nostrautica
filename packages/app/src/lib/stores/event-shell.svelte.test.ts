/**
 * The event shell's role resolution (§4.4, CACHING-PLAN §2.13).
 *
 * Whether the viewer is an attendee or an organizer is answerable entirely from
 * this device — the persisted label, ECK custody, the join marker — and it
 * changes about once per event. It has no business waiting for a relay, and
 * these tests pin that it doesn't: `loadEventContext` is the network, and the
 * role must be right before it resolves (and right even if it never does).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  cachedEventContext: vi.fn(),
  loadEventContext: vi.fn(),
  isApproved: vi.fn(),
  loadEventKeys: vi.fn(),
  recoverEventKeys: vi.fn(),
  joinSentAt: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("$lib/events/event-context.js", () => ({
  cachedEventContext: mocks.cachedEventContext,
  loadEventContext: mocks.loadEventContext,
}));
vi.mock("$lib/events/attendee.js", () => ({ isApproved: mocks.isApproved }));
vi.mock("$lib/events/keystore.js", () => ({ loadEventKeys: mocks.loadEventKeys }));
vi.mock("$lib/events/recover.js", () => ({ recoverEventKeys: mocks.recoverEventKeys }));
vi.mock("$lib/stores/join-sent.svelte.js", () => ({ joinSentAt: mocks.joinSentAt }));
vi.mock("$lib/cache/persist.js", () => ({ cacheGet: mocks.cacheGet, cacheSet: mocks.cacheSet }));
vi.mock("$lib/signer/session.svelte.js", () => ({
  session: { pubkey: "a".repeat(64), custodyReady: true, signer: null },
}));
vi.mock("$lib/stores/visitor-preview.svelte.js", () => ({
  visitorPreview: { isActive: () => false },
  previewedRole: (role: string) => role,
}));

import { eventShell } from "./event-shell.svelte.js";
import { coordinateToNaddr } from "@nostrautica/protocol";

const COORD = `31923:${"b".repeat(64)}:lunarpunk`;
const NADDR = coordinateToNaddr(COORD, []);

/** A relay call that never answers — the offline / unreachable case. */
const neverResolves = () => new Promise<never>(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  eventShell.role = "visitor";
  mocks.cachedEventContext.mockReturnValue(undefined);
  mocks.loadEventContext.mockImplementation(neverResolves);
  mocks.isApproved.mockResolvedValue(false);
  mocks.loadEventKeys.mockResolvedValue(undefined);
  mocks.joinSentAt.mockReturnValue(undefined);
  mocks.cacheGet.mockReturnValue(undefined);
});

describe("eventShell.sync — the role never waits on a relay", () => {
  it("resolves an organizer from local custody while the context load hangs", async () => {
    mocks.loadEventKeys.mockResolvedValue({ role: "organizer" });
    // Deliberately not awaited to completion: loadEventContext never settles,
    // exactly as it does not when the venue Wi-Fi is a captive portal.
    void eventShell.sync(NADDR);
    await vi.waitFor(() => expect(eventShell.role).toBe("organizer"));
    expect(eventShell.isOrganizer).toBe(true);
  });

  it("resolves an approved attendee from ECK custody with no context", async () => {
    mocks.isApproved.mockResolvedValue(true);
    void eventShell.sync(NADDR);
    await vi.waitFor(() => expect(eventShell.role).toBe("attendee"));
    expect(eventShell.isMember).toBe(true);
  });

  it("paints the persisted role synchronously, before any await", () => {
    mocks.cacheGet.mockImplementation((key: string) =>
      key === `role:${COORD}` ? { at: 1, data: "organizer" } : undefined,
    );
    void eventShell.sync(NADDR);
    // No await: the seeding must happen on the synchronous prefix, or the nav
    // renders a visitor view for a frame and the tabs jump.
    expect(eventShell.role).toBe("organizer");
  });

  it("reads the persisted role by coordinate even when the context is not cached", () => {
    // The regression: seeding used to hang off `cachedEventContext`, so a cold
    // cache mirror meant no seed at all — and the mirror is cold on exactly the
    // boot where the seed matters. The coordinate comes from the naddr itself.
    mocks.cachedEventContext.mockReturnValue(undefined);
    mocks.cacheGet.mockImplementation((key: string) =>
      key === `role:${COORD}` ? { at: 1, data: "attendee" } : undefined,
    );
    void eventShell.sync(NADDR);
    expect(eventShell.role).toBe("attendee");
  });

  it("records the resolved role so the next cold boot can seed from it", async () => {
    mocks.isApproved.mockResolvedValue(true);
    void eventShell.sync(NADDR);
    await vi.waitFor(() =>
      expect(mocks.cacheSet).toHaveBeenCalledWith(`role:${COORD}`, "attendee", expect.any(Number)),
    );
  });

  it("does not throw on an undecodable address", async () => {
    await expect(eventShell.sync("not-an-naddr")).resolves.toBeUndefined();
  });
});

/**
 * An approval that lands while the event is already open (production report,
 * 2026-09-04).
 *
 * `sync()` runs from a layout effect keyed on the route and the session, so
 * nothing re-ran it when the ECK grant arrived mid-visit. The attendee stayed on
 * the visitor-shaped bottom nav — no People, no Matches — while the page itself
 * had already noticed and was offering "see who's here". Navigating away to "all
 * events" and back was the only way to get the tabs.
 */
describe("approval landing mid-visit moves the nav without a navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cacheGet.mockReturnValue(undefined);
    mocks.loadEventKeys.mockResolvedValue(undefined);
    mocks.loadEventContext.mockResolvedValue(undefined);
    mocks.cachedEventContext.mockReturnValue(undefined);
  });

  it("promotes pending → attendee on refreshRole, and opens the member tabs", async () => {
    mocks.isApproved.mockResolvedValue(false);
    mocks.joinSentAt.mockReturnValue(1);
    await eventShell.sync(NADDR);
    expect(eventShell.role).toBe("pending");
    expect(eventShell.showPeople).toBe(false);

    // The grant lands: local custody now says approved.
    mocks.isApproved.mockResolvedValue(true);
    await eventShell.refreshRole();

    expect(eventShell.role).toBe("attendee");
    expect(eventShell.showPeople).toBe(true);
    expect(mocks.cacheSet).toHaveBeenCalledWith(`role:${COORD}`, "attendee", expect.any(Number));
  });

  it("watches on its own while pending, so no page has to call in", async () => {
    vi.useFakeTimers();
    mocks.isApproved.mockResolvedValue(false);
    mocks.joinSentAt.mockReturnValue(1);
    await eventShell.sync(NADDR);
    expect(eventShell.role).toBe("pending");

    mocks.isApproved.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(eventShell.role).toBe("attendee"));
  });

  it("refreshRole is a no-op once the role is settled", async () => {
    mocks.isApproved.mockResolvedValue(true);
    mocks.joinSentAt.mockReturnValue(undefined);
    await eventShell.sync(NADDR);
    expect(eventShell.role).toBe("attendee");
    mocks.cacheSet.mockClear();
    await eventShell.refreshRole();
    expect(mocks.cacheSet).not.toHaveBeenCalled();
  });
});

/**
 * Role must not bleed from one event to the next (audit EV-15).
 *
 * The shell is a singleton and `sync` is the only place `role` is seeded on
 * navigation. It seeded only `if (cachedRole)`, so opening an event with no
 * persisted label kept whatever the PREVIOUS event resolved to: an organizer of X
 * opening Y for the first time rendered Y with Admin, People and Matches until
 * the custody read landed. The no-flash guarantee that guard exists for is about
 * a previously-visited event, where a cached label is present.
 */
describe("eventShell.sync — the previous event's role does not carry over", () => {
  const OTHER = coordinateToNaddr(`31923:${"c".repeat(64)}:another`, []);

  it("falls back to visitor for an event with no persisted label", async () => {
    eventShell.role = "organizer"; // resolved for the event we are navigating away from
    mocks.cacheGet.mockReturnValue(undefined); // nothing cached for the new one
    void eventShell.sync(OTHER);
    // Synchronously, before any custody read or relay call settles.
    expect(eventShell.role).toBe("visitor");
  });

  it("still paints a previously-visited event's cached role with no flash", () => {
    eventShell.role = "visitor";
    mocks.cacheGet.mockReturnValue({ data: "organizer" });
    void eventShell.sync(OTHER);
    expect(eventShell.role).toBe("organizer");
  });

  it("resets on an undecodable address instead of keeping the old role", () => {
    eventShell.role = "organizer";
    void eventShell.sync("naddr1thisisnotdecodable");
    expect(eventShell.role).toBe("visitor");
  });
});
