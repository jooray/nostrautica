import { test, expect } from "@playwright/test";
import { newUser } from "../helpers.js";

/**
 * F2 — the prerecorded-talks journey's per-event gate (spec F2, audit U11).
 * A talks=off event must show NO Talks destination anywhere and refuse the
 * route directly; a talks=on event must expose it. (feature-verification
 * 2026-07-16, deliverable C.)
 *
 * NOTE ON KNOWN GAP: this spec deliberately stops at "talk submitted" — it does
 * NOT assert the talk becomes visible in the Talks list, because as of this
 * pass there is no organizer moderation UI to publish a submitted talk (the
 * coordinator supports `talk_publish`/`talk_reject` admin commands —
 * packages/coordinator/src/coordinator.ts:1188-1197 — but nothing in
 * packages/app calls them). See docs/FEATURE-VERIFICATION-2026-07-16.md G-1.
 */
const RELAY_UP = !!process.env.NOSTRAUTICA_E2E_RELAY;

test.describe(RELAY_UP ? "talks gating" : "talks gating (needs relay — skipped)", () => {
  test.skip(!RELAY_UP, "set NOSTRAUTICA_E2E_RELAY to run against a live relay");

  async function createEvent(organizer: import("@playwright/test").Page, title: string, talks: "off" | "on") {
    await organizer.goto("/#/create");
    await organizer.getByLabel("Title").fill(title);
    await organizer.getByLabel("Start").fill("2026-09-01T10:00");
    if (talks === "on") await organizer.locator("#talks").selectOption("on");
    await organizer.getByRole("button", { name: /create event/i }).click();
    await expect(organizer.getByText(/event created/i)).toBeVisible();
    const shareLink = await organizer.locator(".mono").first().innerText();
    const naddr = shareLink.match(/#\/e\/([^/\s]+)/)?.[1];
    expect(naddr).toBeTruthy();
    return naddr!;
  }

  async function joinAndApprove(
    organizer: import("@playwright/test").Page,
    attendee: import("@playwright/test").Page,
    naddr: string,
  ) {
    await attendee.goto(`/#/e/${naddr}/join`);
    await attendee.getByRole("button", { name: /send join request/i }).click();
    await expect(attendee.getByText(/request sent/i)).toBeVisible();
    await organizer.goto(`/#/e/${naddr}/admin`);
    await organizer.getByRole("button", { name: /^approve$/i }).first().click();
    // The organizer is self-enrolled at creation, so one "Approved ✓" card exists
    // from the start — wait for the SECOND one (the just-approved attendee).
    await expect(organizer.getByText(/approved ✓/i)).toHaveCount(2, { timeout: 20_000 });
    await attendee.goto(`/#/e/${naddr}`);
    await expect(attendee.getByText(/see who's here/i)).toBeVisible({ timeout: 20_000 });
  }

  test("talks=off: no Talks tab in the event nav, and the /talks route refuses", async ({ browser }) => {
    const organizerCtx = await browser.newContext();
    const attendeeCtx = await browser.newContext();
    const organizer = await newUser(organizerCtx, "Talks-off Organizer");
    const attendee = await newUser(attendeeCtx, "Talks-off Attendee");
    const naddr = await createEvent(organizer, "Talks Off E2E", "off");
    await joinAndApprove(organizer, attendee, naddr);

    await expect(attendee.getByRole("button", { name: /^talks$/i })).toHaveCount(0);

    await attendee.goto(`/#/e/${naddr}/talks`);
    await expect(attendee.getByText(/talks aren't enabled/i)).toBeVisible();
    await expect(attendee.getByRole("button", { name: /submit a talk/i })).toHaveCount(0);
  });

  test("talks=on: the Talks tab is present and a talk can be submitted", async ({ browser }) => {
    const organizerCtx = await browser.newContext();
    const attendeeCtx = await browser.newContext();
    const organizer = await newUser(organizerCtx, "Talks-on Organizer");
    const attendee = await newUser(attendeeCtx, "Talks-on Attendee");
    const naddr = await createEvent(organizer, "Talks On E2E", "on");
    await joinAndApprove(organizer, attendee, naddr);

    await attendee.goto(`/#/e/${naddr}/talks`);
    await expect(attendee.getByRole("button", { name: /submit a talk/i })).toBeVisible();

    await attendee.getByRole("button", { name: /submit a talk/i }).click();
    await attendee.getByLabel(/title/i).fill("A Talk About Nostr");
    await attendee.getByLabel(/description/i).fill("Why relays matter.");
    await attendee.locator('input[type=checkbox]').first().check();
    await attendee.getByRole("button", { name: /^enable camera$/i }).click();
    await attendee.getByRole("button", { name: /record/i }).click();
    await attendee.waitForTimeout(1500);
    await attendee.getByRole("button", { name: /stop/i }).click();
    await attendee.getByRole("button", { name: /use this/i }).click();
    await expect(attendee.getByText(/uploaded/i)).toBeVisible({ timeout: 30_000 });
  });
});
