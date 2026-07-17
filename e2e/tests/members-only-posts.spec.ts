import { test, expect, type BrowserContext } from "@playwright/test";

/**
 * Event customization (P9) — members-only encrypted posts (kind 31607).
 * Verifies the organizer's visibility toggle genuinely gates content: an
 * outsider (no ECK) sees a lock + join prompt, never the plaintext, while an
 * approved attendee reads it. (feature-verification 2026-07-16, deliverable C.)
 *
 * The gap that used to block this test (manual/no-coordinator approval's key
 * grant being rejected as forged) is fixed — the no-coordinator approval path
 * works end to end as of the caching-verification pass (2026-07-17).
 */
const RELAY_UP = !!process.env.NOSTRAUTICA_E2E_RELAY;

test.describe(RELAY_UP ? "members-only posts" : "members-only posts (needs relay — skipped)", () => {
  test.skip(!RELAY_UP, "set NOSTRAUTICA_E2E_RELAY to run against a live relay");

  async function newUser(context: BrowserContext, name: string) {
    const page = await context.newPage();
    await page.goto("/#/login");
    await page.getByLabel(/your name/i).fill(name);
    await page.getByRole("button", { name: /create my identity/i }).click();
    await expect(page.getByText(/you're in/i)).toBeVisible();
    return page;
  }

  test("a members-only post is locked for an outsider and readable for an attendee", async ({ browser }) => {
    const organizerCtx = await browser.newContext();
    const attendeeCtx = await browser.newContext();
    const outsiderCtx = await browser.newContext();

    const organizer = await newUser(organizerCtx, "Posts Organizer");
    const attendee = await newUser(attendeeCtx, "Posts Attendee");
    const outsider = await newUser(outsiderCtx, "Posts Outsider");

    await organizer.goto("/#/create");
    await organizer.getByLabel("Title").fill("Members-Only Posts E2E");
    await organizer.getByLabel("Start").fill("2026-09-01T10:00");
    await organizer.getByRole("button", { name: /create event/i }).click();
    await expect(organizer.getByText(/event created/i)).toBeVisible();
    const shareLink = await organizer.locator(".mono").first().innerText();
    const naddr = shareLink.match(/#\/e\/([^/\s]+)/)?.[1];
    expect(naddr).toBeTruthy();

    await attendee.goto(`/#/e/${naddr}/join`);
    await attendee.getByRole("button", { name: /send join request/i }).click();
    await expect(attendee.getByText(/request sent/i)).toBeVisible();
    await organizer.goto(`/#/e/${naddr}/admin`);
    await organizer.getByRole("button", { name: /^approve$/i }).first().click();
    // The organizer is self-enrolled at creation, so one "Approved ✓" card exists
    // from the start — wait for the SECOND one (the just-approved attendee).
    await expect(organizer.getByText(/approved ✓/i)).toHaveCount(2, { timeout: 20_000 });

    // Organizer authors a members-only post (Admin's inline PostEditor, §7.4) —
    // publishMembersPost genuinely branches to an encrypted 31607, not a
    // cosmetic toggle (feature-verification 2026-07-15 §5).
    await organizer.goto(`/#/e/${naddr}/admin`);
    const secretText = `Members-only secret ${Date.now()}`;
    await organizer.getByRole("radio", { name: /members/i }).check();
    const postTitle = "A members-only update";
    await organizer.getByRole("textbox", { name: /^title$/i }).fill(postTitle);
    await organizer.locator("textarea").first().fill(secretText);
    await organizer.getByRole("button", { name: /^publish post$/i }).click();
    // The editor clears (and re-disables Publish) once the post round-trips —
    // it then appears in the "published so far" list below the composer.
    await expect(organizer.getByText(postTitle, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

    // Attendee (has the ECK) should see the plaintext. Grant delivery is async
    // (the "Pending" badge can briefly outlive the actual approval — a known UX
    // gap, feature-verification 2026-07-15 §1) so poll instead of a single read.
    // The Posts list is a preview/title list (UI change since this spec was
    // written) — the decrypted body only renders on the individual post page,
    // reached via "Read ›", so click through before checking for the secret.
    await attendee.goto(`/#/e/${naddr}`);
    await expect(attendee.getByText(/see who's here/i)).toBeVisible({ timeout: 20_000 });
    await expect(async () => {
      await attendee.goto(`/#/e/${naddr}/posts`);
      await expect(attendee.getByText(postTitle, { exact: false }).first()).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000, intervals: [2_000] });
    await attendee.getByText(/read ›/i).first().click();
    await expect(attendee.getByText(secretText, { exact: false })).toBeVisible({ timeout: 10_000 });

    // Outsider (no ECK, never joined) should see a lock, never the plaintext —
    // not even the real title, which the encrypted-post placeholder now hides too.
    await outsider.goto(`/#/e/${naddr}/posts`);
    await expect(outsider.getByText(secretText, { exact: false })).toHaveCount(0);
    await expect(outsider.getByText(postTitle, { exact: false })).toHaveCount(0);
    await expect(outsider.getByText(/members-only post/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
