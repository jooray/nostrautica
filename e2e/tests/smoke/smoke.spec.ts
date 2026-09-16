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

/**
 * Paste-a-link on Home.
 *
 * Installed as a PWA, Nostrautica is a separate browser from the one that opens
 * links: an invite tapped in a chat app lands in the system browser, which holds
 * none of this device's identity. The paste box on Home is the only way across
 * that gap, so it has to accept the exact string an organizer hands out — code
 * and all — and it has to refuse anything else out loud rather than navigating
 * to a card that can never load.
 *
 * Lives in the relay-free smoke tier because none of this needs a relay: what is
 * under test is the parse and the navigation, not what the event turns out to be.
 */
const SMOKE_NADDR =
  "naddr1qvzqqqrukvpzqyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3qq9hxmt0ddjj6etkv4h8gyzs8z7";

test("pasting an invite link on Home opens the join screen it names", async ({ page }) => {
  await page.goto("/#/");
  // The whole link, as copied out of a chat app: another origin, an invite code,
  // and the organizer's `lang=`.
  await page
    .getByLabel(/event link/i)
    .fill(
      `https://nostrautica.cypherpunk.today/app/#/e/${SMOKE_NADDR}/join?code=nsec1pyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyyszg5c4n&lang=sk`,
    );
  await page.getByRole("button", { name: /^open$/i }).click();
  // Join consumes the code and strips it from the URL on arrival (spec §5.2),
  // so the assertion is the screen, not the query string.
  await expect(page).toHaveURL(new RegExp(`#/e/${SMOKE_NADDR}/join`));
  await expect(page.getByText(/loading event/i)).toBeVisible();
});

test("pasting a bare address opens the event", async ({ page }) => {
  await page.goto("/#/");
  await page.getByLabel(/event link/i).fill(`nostr:${SMOKE_NADDR}`);
  await page.getByRole("button", { name: /^open$/i }).click();
  await expect(page).toHaveURL(new RegExp(`#/e/${SMOKE_NADDR}$`));
});

test("pasting something that isn't an event link says so and stays on Home", async ({ page }) => {
  await page.goto("/#/");
  await page.getByLabel(/event link/i).fill("https://example.org/not-an-event");
  await page.getByRole("button", { name: /^open$/i }).click();
  await expect(page.getByRole("alert")).toContainText(/no event link/i);
  expect(new URL(page.url()).hash).toBe("#/");
  await expect(page.getByText("Meet the right people")).toBeVisible();
});
