import { test, expect } from "@playwright/test";
import { newUser } from "../helpers.js";

/**
 * P2 walking skeleton (IMPLEMENTATION_PLAN §2 acceptance): two browsers run the
 * full create → join → approve → roster loop; a third outsider sees only public
 * data. Requires the dockerized relay (docker/docker-compose.yml).
 *
 * This drives the real UI; it is skipped unless a relay is reachable so `pnpm
 * test` stays green without infra.
 */
const RELAY_UP = !!process.env.NOSTRAUTICA_E2E_RELAY;

test.describe(RELAY_UP ? "walking skeleton" : "walking skeleton (needs relay — skipped)", () => {
  test.skip(!RELAY_UP, "set NOSTRAUTICA_E2E_RELAY to run against a live relay");

  test("create → join → approve → both see roster; outsider cannot", async ({ browser }) => {
    const organizerCtx = await browser.newContext();
    const attendeeCtx = await browser.newContext();

    const organizer = await newUser(organizerCtx, "Olga Organizer");
    await organizer.goto("/#/create");
    await organizer.getByLabel("Title").fill("E2E Assembly");
    await organizer.getByLabel("Start").fill("2026-09-01T10:00");
    await organizer.getByRole("button", { name: /create event/i }).click();
    await expect(organizer.getByText(/event created/i)).toBeVisible();

    // Grab the share link and hand it to the attendee.
    const shareLink = await organizer.locator(".mono").first().innerText();
    const naddr = shareLink.match(/#\/e\/([^/\s]+)/)?.[1];
    expect(naddr).toBeTruthy();

    // A logged-in attendee's name comes read-only from their kind-0 profile —
    // the join form has no name field for them.
    const attendee = await newUser(attendeeCtx, "Attendee One");
    await attendee.goto(`/#/e/${naddr}/join`);
    await attendee.getByRole("button", { name: /send join request/i }).click();
    await expect(attendee.getByText(/request sent/i)).toBeVisible();

    // Organizer approves. Match the per-card "Approved ✓" (the section header
    // "Approved" alone can appear before the grant publish finishes). The
    // organizer is self-enrolled at creation, so one "Approved ✓" card exists
    // from the start — wait for the SECOND one (the just-approved attendee),
    // which is the signal that the attendee's grant publish is durable.
    await organizer.goto(`/#/e/${naddr}/admin`);
    await organizer.getByRole("button", { name: /^approve$/i }).first().click();
    await expect(organizer.getByText(/approved ✓/i)).toHaveCount(2, { timeout: 20_000 });

    // The event page runs the receiveGrants poll — visit it first so the roster
    // decrypts (going straight to /attendees races the one-shot grant fetch).
    await attendee.goto(`/#/e/${naddr}`);
    await expect(attendee.getByText(/see who's here/i)).toBeVisible({ timeout: 20_000 });
    await attendee.goto(`/#/e/${naddr}/attendees`);
    await expect(attendee.getByText("Attendee One")).toBeVisible({ timeout: 15_000 });

    // An outsider cannot see the roster (no ECK).
    const outsiderCtx = await browser.newContext();
    const outsider = await newUser(outsiderCtx, "Otto Outsider");
    await outsider.goto(`/#/e/${naddr}/attendees`);
    await expect(outsider.getByText(/no attendees visible/i)).toBeVisible();
  });
});
