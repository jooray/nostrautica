import { test, expect } from "@playwright/test";
import { newUser } from "../helpers.js";

/**
 * F1 — the record→submit path (feature-verification 2026-07-16, deliverable C,
 * G7). This is the highest-priority new spec: it exercises the REAL
 * encrypt → BUD-06 preflight → BUD-02 upload → descriptor-revalidation path
 * against a live Blossom server, which is exactly the path that broke in the
 * prior pass (docs/FEATURE-VERIFICATION-2026-07-15.md G1 — a placeholder
 * "about:blank" media URL failed the newly-https-only descriptor schema).
 * A test that only asserts UI state (without actually uploading) would NOT
 * have caught G1; this one drives the real upload.
 *
 * Requires a Blossom origin that returns **https** upload URLs — the
 * media descriptor schema is https-only (audit C3). `e2e/local-infra/blossom.mjs`
 * accepts `BLOSSOM_PUBLIC_BASE_URL` for exactly this (see
 * docs/E2E-TESTING-GUIDE.md §1.1 "HTTPS Blossom for the record flow").
 */
const RELAY_UP = !!process.env.NOSTRAUTICA_E2E_RELAY;

test.describe(RELAY_UP ? "intro composer" : "intro composer (needs relay — skipped)", () => {
  test.skip(!RELAY_UP, "set NOSTRAUTICA_E2E_RELAY to run against a live relay + https Blossom");

  async function createAndApprove(organizer: import("@playwright/test").Page, attendee: import("@playwright/test").Page) {
    await organizer.goto("/#/create");
    await organizer.getByLabel("Title").fill("Intro Composer E2E");
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

    // Grants propagate async — visit the event page first so receiveGrants runs.
    await attendee.goto(`/#/e/${naddr}`);
    await expect(attendee.getByText(/see who's here/i)).toBeVisible({ timeout: 20_000 });
    return naddr!;
  }

  test("video intro: record → encrypt → upload → submit succeeds end-to-end", async ({ browser }) => {
    const organizerCtx = await browser.newContext();
    const attendeeCtx = await browser.newContext();
    const organizer = await newUser(organizerCtx, "Composer Organizer");
    const attendee = await newUser(attendeeCtx, "Composer Attendee");
    const naddr = await createAndApprove(organizer, attendee);

    await attendee.goto(`/#/e/${naddr}/record`);
    await expect(attendee.getByRole("button", { name: /^video$/i })).toBeVisible();

    // Pre-submit disclosure (H10) gates every submit path.
    await attendee.locator('input[type=checkbox]').first().check();

    await attendee.getByRole("button", { name: /^enable camera$/i }).click();
    await attendee.getByRole("button", { name: /record/i }).click();
    await attendee.waitForTimeout(1500);
    await attendee.getByRole("button", { name: /stop/i }).click();
    await attendee.getByRole("button", { name: /use this/i }).click();

    // This assertion is the one G1 broke: a real Blossom round-trip must
    // finish and the descriptor must revalidate (https-only) before "Uploaded".
    // U2: the flat "uploaded" claim was replaced by truthful per-outcome states.
    // A no-coordinator intro that reached the relay reads "Published ✓".
    await expect(attendee.getByText(/published ✓/i)).toBeVisible({ timeout: 30_000 });
  });

  test("audio intro: audio-only mode records and submits", async ({ browser }) => {
    const organizerCtx = await browser.newContext();
    const attendeeCtx = await browser.newContext();
    const organizer = await newUser(organizerCtx, "Composer Organizer 2");
    const attendee = await newUser(attendeeCtx, "Composer Attendee 2");
    const naddr = await createAndApprove(organizer, attendee);

    await attendee.goto(`/#/e/${naddr}/record`);
    await attendee.getByRole("button", { name: /^audio$/i }).click();
    await attendee.locator('input[type=checkbox]').first().check();
    await attendee.getByRole("button", { name: /enable mic/i }).click();
    await attendee.getByRole("button", { name: /record/i }).click();
    await attendee.waitForTimeout(1500);
    await attendee.getByRole("button", { name: /stop/i }).click();
    await attendee.getByRole("button", { name: /use this/i }).click();
    // U2: the flat "uploaded" claim was replaced by truthful per-outcome states.
    // A no-coordinator intro that reached the relay reads "Published ✓".
    await expect(attendee.getByText(/published ✓/i)).toBeVisible({ timeout: 30_000 });
  });

  test("text intro: skips capture entirely and submits the typed text", async ({ browser }) => {
    const organizerCtx = await browser.newContext();
    const attendeeCtx = await browser.newContext();
    const organizer = await newUser(organizerCtx, "Composer Organizer 3");
    const attendee = await newUser(attendeeCtx, "Composer Attendee 3");
    const naddr = await createAndApprove(organizer, attendee);

    await attendee.goto(`/#/e/${naddr}/record`);
    await attendee.getByRole("button", { name: /^text$/i }).click();
    // Text mode swaps in the "Write your intro" composer (no capture UI at all).
    await expect(attendee.getByRole("heading", { name: /write your intro/i })).toBeVisible();
    await attendee.locator('input[type=checkbox]').first().check();
    await attendee.locator("textarea").last().fill(
      "Hi, I'm here to meet people building open protocols.",
    );
    await attendee.getByRole("button", { name: /use this intro/i }).click();
    // U2: the flat "uploaded" claim was replaced by truthful per-outcome states.
    // A no-coordinator intro that reached the relay reads "Published ✓".
    await expect(attendee.getByText(/published ✓/i)).toBeVisible({ timeout: 30_000 });
  });
});
