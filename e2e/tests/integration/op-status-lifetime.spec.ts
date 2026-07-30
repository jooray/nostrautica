import { test, expect } from "@playwright/test";
import { newUser } from "../helpers.js";

/**
 * The operation-status line's lifetime (user report 2026-07-30).
 *
 * "I changed event details (location) and all was correct, I got 'Your event
 * details were updated and published.' but that stayed forever — whatever I do in
 * the app (move around, ...), it stays written."
 *
 * The line renders in the ROOT layout, above every screen, and its documented
 * lifetime was "until the user's next edit" — which silently assumed the user
 * stays on the form. `clearOnEdit()` was called from exactly one page
 * (Record.svelte) in the whole app, so on the settings form there was no escape
 * at all: the confirmation followed the organizer across People, Chat, Matches
 * and everything else until a reload.
 *
 * The fix is two hooks in the layout — clear on navigation, clear on any input —
 * and the risk is REACTIVE, not logical: in Svelte 5 a `$state` read inside an
 * `$effect` subscribes to it, so an effect that watched the route and also read
 * the status would re-run on every publish and wipe the message before anyone
 * could read it. That hazard only exists in a real browser (effects are no-ops in
 * the SSR/node test environment), which is why this lives in e2e and asserts BOTH
 * directions: the message must appear and survive, then go when the user leaves.
 */
const RELAY_UP = !!process.env.NOSTRAUTICA_E2E_RELAY;

test.describe(RELAY_UP ? "operation-status lifetime" : "operation-status lifetime (needs relay — skipped)", () => {
  test.skip(!RELAY_UP, "set NOSTRAUTICA_E2E_RELAY to run against a live relay");

  test("a publish confirmation survives on its own screen and clears on navigation", async ({ browser }) => {
    const ctx = await browser.newContext();
    const organizer = await newUser(ctx, "Status Organizer");

    await organizer.goto("/#/create");
    await organizer.getByLabel("Title").fill("Op Status E2E");
    await organizer.getByLabel("Start").fill("2026-09-01T10:00");
    await organizer.getByRole("button", { name: /create event/i }).click();
    // NB: "Event created" is the Create page's own <h2>, which unmounts on
    // navigation no matter what the status line does — assert on the STATUS text
    // ("Your event was created and published.") or this proves nothing.
    await expect(organizer.getByText(/created and published/i)).toBeVisible();
    const shareLink = await organizer.locator(".mono").first().innerText();
    const naddr = shareLink.match(/#\/e\/([^/\s]+)/)?.[1];
    expect(naddr).toBeTruthy();

    // The event-created confirmation is itself a status line — leaving the create
    // screen must end it (this is the reported bug, on the very first publish).
    await organizer.goto(`/#/e/${naddr}`);
    await expect(organizer.getByText(/created and published/i)).toHaveCount(0);

    // Now the exact flow from the report: change the location and publish.
    await organizer.goto(`/#/e/${naddr}/settings`);
    const location = organizer.locator("#metadata-location");
    await expect(location).toBeVisible({ timeout: 20_000 });
    await location.fill("Nová Dedinka");
    await organizer.getByRole("button", { name: /save (event )?details/i }).click();

    const published = organizer.getByText(/updated and published/i);
    await expect(published).toBeVisible({ timeout: 20_000 });

    // It must STAY while the organizer is still on the form — the whole point of
    // the persistent line (audit §7.3.9), and what a self-subscribing effect
    // would have destroyed. Re-asserted after a beat so an async wipe can't hide.
    await organizer.waitForTimeout(1_500);
    await expect(published).toBeVisible();

    // Editing again means the confirmation is stale — the store's documented
    // "next edit" lifetime, which no form outside Record.svelte ever honored.
    await location.fill("Nová Dedinka, SK");
    await expect(published).toHaveCount(0);

    // Publish once more, then walk around the app: the line must not follow.
    await organizer.getByRole("button", { name: /save (event )?details/i }).click();
    await expect(published).toBeVisible({ timeout: 20_000 });
    for (const path of [`/#/e/${naddr}/people`, `/#/e/${naddr}/talks`, `/#/e/${naddr}`, "/#/me"]) {
      await organizer.goto(path);
      await expect(published, `status must not follow the user to ${path}`).toHaveCount(0);
    }

    await ctx.close();
  });
});
