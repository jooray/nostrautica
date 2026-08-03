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
