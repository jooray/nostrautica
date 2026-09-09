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

test("logged-out idle home does not claim relays are blocked", async ({ page }) => {
  const sockets: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await page.goto("/#/");
  await expect(page.getByText("Meet the right people")).toBeVisible();
  await expect(page.getByText(/no relay is reachable|network may be blocking/i)).toHaveCount(0);
  expect(sockets).toEqual([]);
});

/**
 * The invite link's landing screen must offer a way out (2026-09-09 audit, UX-N-1).
 *
 * Invite links are `#/e/<naddr>/join?code=…` (organizer.ts), so Join — not
 * EventHome — is the FIRST screen a newcomer sees. The UX-3 fix gave EventHome a
 * 12 s guard, a categorized error and a working retry on exactly that reasoning,
 * and the screen the link actually opens did not get it: a bare "Loading event…"
 * with no timeout and no retry, which on venue Wi-Fi that blocks WSS is a spinner
 * with no way forward but a reload the newcomer has no reason to think of.
 *
 * The smoke tier has no relay at all, which is precisely that condition.
 */
test("a join deep link with no reachable relay ends in a retryable error, not a spinner", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await page.goto(
    "/#/e/naddr1qqrxw6t5wd68yatcv4ex2mrp0yhxxmmdqgsx7arwsxvvdxvxpjrgnkjqu4rcs0v3rvkq6c9j5xk0aehz7uz2q0grqsqqqa28dhzjuf/join",
  );
  // It does start out loading — the guard is a backstop, not a replacement.
  await expect(page.getByText(/loading event/i)).toBeVisible();
  // …and then says something, with a button.
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /try again|retry/i })).toBeVisible();
});
