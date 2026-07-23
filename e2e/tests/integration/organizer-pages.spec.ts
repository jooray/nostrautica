import { test, expect, type Page } from "@playwright/test";
import { newUser } from "../helpers.js";

/**
 * Organizer-page render regression (BUG-3, validation pass 2026-07-23).
 *
 * Admin and Report were reported "hung on their loading state indefinitely,
 * reproduced repeatedly incl. after hard reload." The root cause was NOT a
 * never-settling promise (every load helper is bounded by streamEvents' 8s cap
 * or IDB completion): it was the RefreshGuard effect loop (BUG-1). Admin embeds
 * PostEditor, whose `refreshGuard.hold()` runs inside an $effect keyed on the
 * compose fields; a cache-restored draft makes those fields non-empty on mount,
 * so the effect fired immediately and threw effect_update_depth_exceeded —
 * wedging the whole Admin render at its spinner. Because the draft persists in
 * IndexedDB, every hard reload re-crashed it ("reproduced after hard reload").
 *
 * This spec drives an organizer to both pages with a persisted PostEditor draft
 * in play and asserts (a) neither is stuck on its loading indicator and (b) no
 * effect_update_depth_exceeded reaches the console. It FAILS against the
 * reverted RefreshGuard (version++) implementation.
 */
const RELAY_UP = !!process.env.NOSTRAUTICA_E2E_RELAY;

test.describe(RELAY_UP ? "organizer pages render (BUG-3)" : "organizer pages render (needs relay — skipped)", () => {
  test.skip(!RELAY_UP, "set NOSTRAUTICA_E2E_RELAY to run against a live relay");

  /** Fail the test if the RefreshGuard effect loop ever surfaces. */
  function trackEffectLoop(page: Page): { seen: () => boolean } {
    let saw = false;
    page.on("console", (m) => {
      if (/effect_update_depth_exceeded/i.test(m.text())) saw = true;
    });
    page.on("pageerror", (e) => {
      if (/effect_update_depth_exceeded/i.test(String(e))) saw = true;
    });
    return { seen: () => saw };
  }

  test("Admin and Report leave their loading state for an organizer with seeded data", async ({ browser }) => {
    const organizerCtx = await browser.newContext();
    const attendeeCtx = await browser.newContext();
    const organizer = await newUser(organizerCtx, "Pages Organizer");
    const attendee = await newUser(attendeeCtx, "Pages Attendee");
    const loop = trackEffectLoop(organizer);

    await organizer.goto("/#/create");
    await organizer.getByLabel("Title").fill("Organizer Pages E2E");
    await organizer.getByLabel("Start").fill("2026-09-01T10:00");
    await organizer.getByRole("button", { name: /create event/i }).click();
    await expect(organizer.getByText(/event created/i)).toBeVisible();
    const shareLink = await organizer.locator(".mono").first().innerText();
    const naddr = shareLink.match(/#\/e\/([^/\s]+)/)?.[1];
    expect(naddr).toBeTruthy();

    // Attendee joins so the roster/directory has real data for the pages to load.
    await attendee.goto(`/#/e/${naddr}/join`);
    await attendee.getByRole("button", { name: /send join request/i }).click();
    await expect(attendee.getByText(/request sent/i)).toBeVisible();

    // Admin renders and is interactive (the Approve button proves the page left
    // its loading state — a wedged render would never paint the pending queue).
    await organizer.goto(`/#/e/${naddr}/admin`);
    await organizer.getByRole("button", { name: /^approve$/i }).first().click();
    await expect(organizer.getByText(/approved ✓/i)).toHaveCount(2, { timeout: 20_000 });

    // Dirty Admin's embedded PostEditor: this is the exact BUG-1 call site that
    // wedged Admin. Typing a title fires the hold() effect; the page must stay
    // alive (the composer keeps the typed value, no crash).
    const postTitle = "Draft that persists across reloads";
    await organizer.getByRole("textbox", { name: /^title$/i }).fill(postTitle);
    await organizer.locator("textarea").first().fill("Body copy for the draft.");
    await expect(organizer.getByRole("textbox", { name: /^title$/i })).toHaveValue(postTitle);

    // Hard reload WITH the draft persisted — the old bug re-crashed here every
    // time. Admin must come back up and repaint its interactive controls.
    await organizer.reload();
    await expect(organizer.getByRole("button", { name: /refresh/i }).first()).toBeVisible({ timeout: 20_000 });

    // Report must leave its "Assembling your report…" loading state (its header
    // always paints; the loading line must clear once the bounded load settles).
    await organizer.goto(`/#/e/${naddr}/report`);
    await expect(organizer.getByText(/post-event report/i)).toBeVisible({ timeout: 20_000 });
    await expect(organizer.getByText(/assembling your report/i)).toHaveCount(0, { timeout: 20_000 });

    expect(loop.seen(), "effect_update_depth_exceeded must never fire").toBe(false);
  });
});
