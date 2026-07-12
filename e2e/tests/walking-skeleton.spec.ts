import { test, expect, type BrowserContext } from "@playwright/test";

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

  async function newUser(context: BrowserContext) {
    const page = await context.newPage();
    await page.goto("/#/login");
    await page.getByRole("button", { name: /create an identity/i }).click();
    await page.getByRole("button", { name: /continue/i }).click();
    return page;
  }

  test("create → join → approve → both see roster; outsider cannot", async ({ browser }) => {
    const organizerCtx = await browser.newContext();
    const attendeeCtx = await browser.newContext();

    const organizer = await newUser(organizerCtx);
    await organizer.goto("/#/create");
    await organizer.getByLabel("Title").fill("E2E Assembly");
    await organizer.getByLabel("Start").fill("2026-09-01T10:00");
    await organizer.getByRole("button", { name: /create event/i }).click();
    await expect(organizer.getByText(/event created/i)).toBeVisible();

    // Grab the share link and hand it to the attendee.
    const shareLink = await organizer.locator(".mono").first().innerText();
    const naddr = shareLink.match(/#\/e\/([^/\s]+)/)?.[1];
    expect(naddr).toBeTruthy();

    const attendee = await newUser(attendeeCtx);
    await attendee.goto(`/#/e/${naddr}/join`);
    await attendee.getByLabel(/display name/i).fill("Attendee One");
    await attendee.getByRole("button", { name: /send join request/i }).click();
    await expect(attendee.getByText(/request sent/i)).toBeVisible();

    // Organizer approves.
    await organizer.goto(`/#/e/${naddr}/admin`);
    await organizer.getByRole("button", { name: /^approve$/i }).first().click();
    await expect(organizer.getByText(/approved/i)).toBeVisible();

    // Both approved parties see the attendee in the roster.
    await attendee.goto(`/#/e/${naddr}/attendees`);
    await expect(attendee.getByText("Attendee One")).toBeVisible({ timeout: 15_000 });

    // An outsider cannot see the roster (no ECK).
    const outsiderCtx = await browser.newContext();
    const outsider = await newUser(outsiderCtx);
    await outsider.goto(`/#/e/${naddr}/attendees`);
    await expect(outsider.getByText(/no attendees visible/i)).toBeVisible();
  });
});
