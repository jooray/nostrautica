/**
 * Who is allowed to author the event page (spec §7.4 kind 31608).
 *
 * A 31608 is not decoration: its `r` tags are the event's MENU (where "Tickets"
 * and "Venue" point), and its `sources` list names the npubs whose long-form is
 * folded into the event's own feed. The read used to be
 * `fetchEvents({authors:[E_id]}).sort(created_at desc)[0]`, and a relay filter is
 * a request rather than a guarantee — so any relay in the event's set could
 * answer with its own signed 31608, repoint every menu link, and inject
 * arbitrary authors whose articles then render as the event's official posts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { KIND_EVENT_PAGE, makeCoordinate } from "@nostrautica/protocol";

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

import { fetchEventPage } from "./event-page.js";
import type { EventContext } from "./event-context.js";
import { __resetPersistForTests, setActiveCacheOwner } from "$lib/cache/persist.js";

const EID = "e".repeat(64);
const IMPOSTOR = "f".repeat(64);
const CURATED = "a".repeat(64);
const COORD = makeCoordinate(EID, "conf-2026");
const ctx = { coordinate: COORD, config: { relays: ["wss://relay.example"] } } as EventContext;

function pageEvent(
  pubkey: string,
  opts: { label: string; target: string; sources?: { pubkey: string }[]; createdAt: number },
) {
  return {
    id: `page-${opts.createdAt}`,
    kind: KIND_EVENT_PAGE,
    pubkey,
    created_at: opts.createdAt,
    tags: [
      ["d", "conf-2026"],
      ["a", COORD],
      ["v", "2"],
      ["r", opts.target, opts.label],
    ],
    content: JSON.stringify({ v: 2, sections: [], sources: opts.sources ?? [] }),
  };
}

describe("fetchEventPage author pinning", () => {
  beforeEach(() => {
    __resetPersistForTests();
    setActiveCacheOwner(null);
    fetchEvents.mockReset();
  });

  it("returns the page E_id published", async () => {
    fetchEvents.mockResolvedValue([
      pageEvent(EID, { label: "Tickets", target: "https://real.example", createdAt: 1000 }),
    ]);
    const page = await fetchEventPage(ctx);
    expect(page?.menu.map((m) => m.target)).toEqual(["https://real.example"]);
  });

  it("ignores a 31608 by anyone but E_id, even when it is the newest", async () => {
    // The menu is where people tap to buy tickets; a repointed link is a payment
    // redirect, and an injected `sources` entry launders someone else's articles
    // into the event's official feed.
    fetchEvents.mockResolvedValue([
      pageEvent(IMPOSTOR, {
        label: "Tickets",
        target: "https://phish.example",
        sources: [{ pubkey: CURATED }],
        createdAt: 9_000,
      }),
      pageEvent(EID, { label: "Tickets", target: "https://real.example", createdAt: 1_000 }),
    ]);

    const page = await fetchEventPage(ctx);
    expect(page?.menu.map((m) => m.target)).toEqual(["https://real.example"]);
    expect(page?.sources).toEqual([]);
  });

  it("behaves as if no page exists when only an impostor answered", async () => {
    // Falling back to the default layout is the right degradation: a menu nobody
    // authorised is worse than no custom menu at all.
    fetchEvents.mockResolvedValue([
      pageEvent(IMPOSTOR, { label: "Tickets", target: "https://phish.example", createdAt: 9_000 }),
    ]);
    expect(await fetchEventPage(ctx)).toBeUndefined();
  });
});
