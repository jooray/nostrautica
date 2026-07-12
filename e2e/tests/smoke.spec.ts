import { test, expect } from "@playwright/test";

/**
 * P1 smoke: the static PWA loads via hash routing, a normie can create an identity
 * with no jargon, and the key backup card appears (spec §5.2, §5.4).
 */
test("loads and creates a local identity with a backup card", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.getByText("Meet the right people")).toBeVisible();

  await page.goto("/#/login");
  await page.getByRole("button", { name: /create an identity/i }).click();

  // The "you're in" backup nag appears with the not-confidential warning.
  await expect(page.getByText(/back it up now/i)).toBeVisible();
  await expect(page.getByText(/email is not confidential/i)).toBeVisible();

  // The hand-off screen shows a portable npub.
  await page.goto("/#/me");
  await expect(page.getByText(/your nostr profile is ready/i)).toBeVisible();
  await expect(page.getByText(/^npub1/)).toBeVisible();
});

test("deep link to an unknown event route renders (hash routing, nsite-safe)", async ({ page }) => {
  await page.goto("/#/e/naddr1invalid");
  // The app shell renders (no server 404 breakage); an error/loading state shows.
  await expect(page.locator(".app-shell")).toBeVisible();
});
