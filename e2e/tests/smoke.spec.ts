import { test, expect } from "@playwright/test";

/**
 * P1 smoke: the static PWA loads via hash routing, a normie can create an identity
 * with no jargon, and the key backup card appears (spec §5.2, §5.4).
 */
test("loads and creates a local identity with a backup card", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.getByText("Meet the right people")).toBeVisible();

  await page.goto("/#/login");
  await page.getByLabel(/your name/i).fill("Smoke Tester");
  await page.getByRole("button", { name: /create my identity/i }).click();

  // The "you're in" backup nag appears; the email option sits under the
  // collapsed "more ways" details.
  await expect(page.getByText(/back it up now/i)).toBeVisible();
  await page.getByText(/more ways to back up/i).click();
  await expect(page.getByText(/email isn't fully private/i)).toBeVisible();

  // The hand-off screen shows a portable npub.
  await page.goto("/#/me");
  await expect(page.getByText(/you're a nostr user now/i)).toBeVisible();
  await expect(page.getByText(/^npub1/)).toBeVisible();
});

test("deep link to an unknown event route renders (hash routing, nsite-safe)", async ({ page }) => {
  await page.goto("/#/e/naddr1invalid");
  // The app shell renders (no server 404 breakage); an error/loading state shows.
  await expect(page.locator(".app-shell")).toBeVisible();
});
