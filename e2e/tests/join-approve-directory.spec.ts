import { test, expect, type BrowserContext } from "@playwright/test";

/**
 * The join → approve → directory loop, focused on the DIRECTORY ENTRY content
 * (not just roster presence, which walking-skeleton.spec.ts already covers):
 * an approved attendee's authored profile fields decrypt correctly for another
 * approved attendee, and a revoke removes them from the directory going
 * forward. (feature-verification 2026-07-16, deliverable C — G7.)
 *
 * KNOWN FAILURE as of this pass (P0, see docs/FEATURE-VERIFICATION-2026-07-16.md
 * gap G-2): the manual (no-coordinator) approval path signs the 21602 key grant
 * with the organizer's PERSONAL signer (packages/app/src/lib/events/organizer.ts:201,
 * `signerWrap(organizer, ...)`), but the receiving client's C2 grant-authentication
 * (packages/app/src/lib/events/attendee.ts:95-111, `authenticateKeyGrant`) only
 * accepts a grant sealed by E_id or the configured coordinator — so every
 * no-coordinator grant is logged "ignored forged/invalid key grant" and rejected.
 * This test is expected to fail (timeout waiting for "see who's here") until
 * that's fixed; walking-skeleton.spec.ts fails the same way for the same reason.
 */
const RELAY_UP = !!process.env.NOSTRAUTICA_E2E_RELAY;

test.describe(RELAY_UP ? "join-approve-directory" : "join-approve-directory (needs relay — skipped)", () => {
  test.skip(!RELAY_UP, "set NOSTRAUTICA_E2E_RELAY to run against a live relay");

  async function newUser(context: BrowserContext, name: string) {
    const page = await context.newPage();
    await page.goto("/#/login");
    await page.getByLabel(/your name/i).fill(name);
    await page.getByRole("button", { name: /create my identity/i }).click();
    await expect(page.getByText(/you're in/i)).toBeVisible();
    return page;
  }

  test("an approved attendee's directory entry is readable by another approved attendee", async ({ browser }) => {
    const organizerCtx = await browser.newContext();
    const aCtx = await browser.newContext();
    const bCtx = await browser.newContext();

    const organizer = await newUser(organizerCtx, "Directory Organizer");
    const alice = await newUser(aCtx, "Directory Alice");
    const bob = await newUser(bCtx, "Directory Bob");

    await organizer.goto("/#/create");
    await organizer.getByLabel("Title").fill("Directory Loop E2E");
    await organizer.getByLabel("Start").fill("2026-09-01T10:00");
    await organizer.getByRole("button", { name: /create event/i }).click();
    await expect(organizer.getByText(/event created/i)).toBeVisible();
    const shareLink = await organizer.locator(".mono").first().innerText();
    const naddr = shareLink.match(/#\/e\/([^/\s]+)/)?.[1];
    expect(naddr).toBeTruthy();

    for (const p of [alice, bob]) {
      await p.goto(`/#/e/${naddr}/join`);
      await p.getByRole("button", { name: /send join request/i }).click();
      await expect(p.getByText(/request sent/i)).toBeVisible();
    }

    await organizer.goto(`/#/e/${naddr}/admin`);
    const approveAll = organizer.getByRole("button", { name: /approve all/i });
    if (await approveAll.count()) {
      await approveAll.first().click();
    } else {
      const buttons = organizer.getByRole("button", { name: /^approve$/i });
      const n = await buttons.count();
      for (let i = 0; i < n; i++) await buttons.first().click();
    }
    // Organizer self-enrolled card + Alice + Bob — wait for all three so the
    // grant publishes are durable before the attendees move on.
    await expect(organizer.getByText(/approved ✓/i)).toHaveCount(3, { timeout: 20_000 });

    // Alice authors a distinctive profile field via the intro composer's text
    // mode (no camera needed) so it shows up verbatim in Bob's directory read.
    await alice.goto(`/#/e/${naddr}`);
    await expect(alice.getByText(/see who's here/i)).toBeVisible({ timeout: 20_000 });
    await alice.goto(`/#/e/${naddr}/record`);
    await alice.getByRole("tab", { name: /^text$/i }).click();
    await alice.locator('input[type=checkbox]').first().check();
    const marker = `directory-loop-marker-${Date.now()}`;
    await alice.locator("textarea").last().fill(`Hi, I'm Alice. ${marker}`);
    await alice.getByRole("button", { name: /use this intro/i }).click();
    await expect(alice.getByText(/uploaded/i)).toBeVisible({ timeout: 30_000 });

    // Bob reads Alice's directory entry — the roster decrypt + attendee detail
    // path, not just her display name.
    await bob.goto(`/#/e/${naddr}`);
    await expect(bob.getByText(/see who's here/i)).toBeVisible({ timeout: 20_000 });
    await bob.goto(`/#/e/${naddr}/attendees`);
    await expect(bob.getByText("Directory Alice")).toBeVisible({ timeout: 15_000 });
    await bob.getByText("Directory Alice").first().click();
    await expect(bob.getByText(marker, { exact: false })).toBeVisible({ timeout: 15_000 });

    // Revoke: organizer removes Alice specifically. The card carries her short
    // pubkey, so scope both the trigger and the inline confirm click to it —
    // Bob's own (untouched) "Revoke" button must not be ambiguous with hers.
    await organizer.goto(`/#/e/${naddr}/admin`);
    await organizer.getByText("Directory Alice").first().waitFor({ timeout: 15_000 });
    const aliceCard = organizer.locator(".card", { hasText: "Directory Alice" }).first();
    await aliceCard.getByRole("button", { name: /^revoke$/i }).click();
    await expect(aliceCard.getByText(/keep/i)).toBeVisible();
    await aliceCard.getByRole("button", { name: /^revoke$/i }).click();
    await expect(aliceCard.getByText(/revoked/i)).toBeVisible({ timeout: 20_000 });
  });
});
