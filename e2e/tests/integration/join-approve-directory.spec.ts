import { test, expect, type BrowserContext } from "@playwright/test";

/**
 * The join → approve → directory loop, focused on the DIRECTORY ENTRY content
 * (not just roster presence, which walking-skeleton.spec.ts already covers):
 * an approved attendee's authored profile fields decrypt correctly for another
 * approved attendee, and a revoke removes them from the directory going
 * forward. (feature-verification 2026-07-16, deliverable C — G7.)
 *
 * The gap that used to block this test (manual/no-coordinator approval's key
 * grant being rejected as forged) is fixed — the no-coordinator approval path
 * works end to end as of the caching-verification pass (2026-07-17).
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
    // Admin now paints instantly from the (empty, first-visit) persistent cache
    // and populates the pending queue in the background (CACHING-PLAN §2.11) —
    // a bare `.count()` right after navigation can race that fetch and see zero
    // buttons. Wait for the first real "Approve" button before deciding whether
    // "Approve all" is offered (both render from the same pending-queue fetch,
    // so once one attendee's button exists, all of them do).
    await organizer.getByRole("button", { name: /^approve$/i }).first().waitFor({ timeout: 20_000 });
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

    // A submitted intro is a 21601 rumor to E_inbox, not a direct directory-entry
    // write (only the organizer/E_id, or a coordinator, publishes 31603) — in
    // this no-coordinator (Tier 1) flow the organizer must pull it in via
    // "Re-process". Target Alice's card by NAME, not position: the approved list
    // is ordered by join-rumor created_at, and the organizer's own self-enrolled
    // card does NOT reliably sort first (the enrollment rumor's timestamp can
    // land before Alice's), so a `.nth(1)` re-process button sometimes hit the
    // ORGANIZER's card instead — which has no intro, so Alice's entry never got
    // the text (caching verification 2026-07-17: the sole remaining flake here).
    // Her card's <strong>{req.name}</strong> comes from the join request, so it's
    // present regardless of kind-0 propagation. Re-process re-reads the E_inbox
    // before republishing (Admin.reprocess → fresh fetchPending), so it threads
    // Alice's just-submitted intro into her 31603 entry without a page reload.
    // Bob reads Alice's entry via the roster decrypt + attendee-detail path. The
    // attendees list sorts by resolved NAME (falling back to raw pubkey hex until
    // a name resolves), so POSITION isn't stable there the way it is on the admin
    // page — open every roster card in turn and stop at the marker instead. Drive
    // Alice's re-process click INSIDE the retry loop (each click re-reads pending
    // fresh) so a slow relay propagation of her intro or the republished entry
    // just costs another iteration rather than failing outright.
    const aliceAdminCard = organizer.locator(".card", { hasText: "Directory Alice" });
    await bob.goto(`/#/e/${naddr}`);
    await expect(bob.getByText(/see who's here/i)).toBeVisible({ timeout: 20_000 });
    await expect(async () => {
      await aliceAdminCard.getByRole("button", { name: /^re-process$/i }).click();
      await organizer.waitForTimeout(1_000); // let the fetch + three relay publishes land
      await bob.goto(`/#/e/${naddr}/attendees`);
      const openButtons = bob.locator(".roster button.open");
      await expect(openButtons).toHaveCount(3, { timeout: 5_000 });
      const n = await openButtons.count();
      for (let i = 0; i < n; i++) {
        await openButtons.nth(i).click();
        if (await bob.getByText(marker, { exact: false }).count()) return; // found it
        await bob.goBack();
        await expect(openButtons).toHaveCount(3, { timeout: 5_000 });
      }
      throw new Error("marker not found on any roster card yet");
    }).toPass({ timeout: 30_000, intervals: [2_000] });

    // Revoke: organizer removes Alice specifically. Scope both the trigger and
    // the inline confirm click to HER card by NAME, not by an "approved ✓" text
    // filter: clicking Revoke swaps the card to the confirm copy (Revoke/Keep),
    // which drops "Approved ✓" — so a `.card` filtered on that text would
    // re-resolve to a DIFFERENT card mid-flow (Bob's) once Alice's changes. Her
    // name (<strong>{req.name}</strong>, from the join request) stays put through
    // the confirm and revoked states, so it's the stable anchor for all three
    // steps. Bob's untouched "Revoke" button never gets mistaken for hers.
    await organizer.goto(`/#/e/${naddr}/admin`);
    await expect(organizer.getByText(/approved ✓/i)).toHaveCount(3, { timeout: 15_000 });
    const aliceCard = organizer.locator(".card", { hasText: "Directory Alice" });
    await aliceCard.getByRole("button", { name: /^revoke$/i }).click();
    await expect(aliceCard.getByText(/keep/i)).toBeVisible();
    await aliceCard.getByRole("button", { name: /^revoke$/i }).click();
    await expect(aliceCard.getByText(/revoked/i)).toBeVisible({ timeout: 20_000 });
  });
});
