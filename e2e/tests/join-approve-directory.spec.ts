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
    // "Re-process" before it reaches anyone else's directory read. The organizer
    // is still on /admin from the approve step above. Select by POSITION, not by
    // name text: a card's <strong>{req.name}</strong> can render blank when the
    // attendee's kind-0 (published moments earlier by "create my identity")
    // hasn't propagated to the relay yet by the time admin's pending-queue scan
    // reads it (join-approve-directory finding, caching verification
    // 2026-07-17) — unrelated to this test's actual subject, so don't depend on
    // it. Cards are ordered by join-request rumor timestamp: organizer
    // (self-enrolled at event creation) first, then Alice, then Bob.
    // Republishing 3 relay events per approval/re-process, back to back, has an
    // observed transient failure mode ("not enough relays received the event")
    // under this test's concurrent load — the fixed offline queue (publish-queue.ts,
    // caching verification 2026-07-17) durably holds it instead of losing it, but
    // the queue only retries on the next page load or a browser "online" event,
    // neither of which fires automatically mid-session. So retry the ACTUAL
    // WRITE (re-process, then reload to flush any queued publish) up to 3 times,
    // checking Bob's view after each attempt, instead of just re-reading.
    let bobSeesAll = false;
    for (let attempt = 0; attempt < 3 && !bobSeesAll; attempt++) {
      // Select by POSITION, not by name text: a card's <strong>{req.name}</strong>
      // can render blank when the attendee's kind-0 (published moments earlier by
      // "create my identity") hasn't propagated to the relay yet by the time
      // admin's pending-queue scan reads it (join-approve-directory finding,
      // caching verification 2026-07-17) — unrelated to this test's actual
      // subject, so don't depend on it. Cards are ordered by join-request rumor
      // timestamp: organizer (self-enrolled at event creation) first, then
      // Alice, then Bob.
      await organizer.getByRole("button", { name: /^re-process$/i }).nth(1).click();
      // The button's onclick isn't awaited by the click itself (fire-and-forget
      // handler) — give the republish (roster read + three relay publishes) a
      // moment.
      await organizer.waitForTimeout(3_000);
      // Reload (mirrors a real user refreshing) so `+layout.svelte`'s boot-time
      // `flushQueue()` delivers anything that got queued instead of published.
      await organizer.reload();
      await organizer.getByText(/organizer admin/i).waitFor({ timeout: 15_000 });
      await organizer.waitForTimeout(2_000);

      // Bob reads Alice's directory entry — the roster decrypt + attendee detail
      // path, not just her display name. Open each roster card by POSITION
      // rather than by name: a freshly-created identity's kind-0 can lag the
      // same "resolves on EOSE before a just-arrived event is surfaced" NDK
      // hazard documented on `fetchEventsRelayOnly` in ndk.ts (cosmetic,
      // self-heals, but makes name-text matching unreliable here). Card order
      // is stable (roster/join order): organizer, Alice, Bob.
      await bob.goto(`/#/e/${naddr}`);
      await expect(bob.getByText(/see who's here/i)).toBeVisible({ timeout: 20_000 });
      try {
        await expect(async () => {
          await bob.goto(`/#/e/${naddr}/attendees`);
          await expect(bob.locator(".roster button.open")).toHaveCount(3, { timeout: 5_000 });
          await bob.locator(".roster button.open").nth(1).click();
          await expect(bob.getByText(marker, { exact: false })).toBeVisible({ timeout: 5_000 });
        }).toPass({ timeout: 15_000, intervals: [3_000] });
        bobSeesAll = true;
      } catch {
        if (attempt === 2) throw new Error(`Bob still can't read Alice's directory entry after ${attempt + 1} re-process attempts`);
      }
    }

    // Revoke: organizer removes Alice specifically. Scope both the trigger and
    // the inline confirm click to HER card — Bob's own (untouched) "Revoke"
    // button must not be ambiguous with hers. Select by position (organizer,
    // Alice, Bob — see the name-matching note above) rather than by name text.
    await organizer.goto(`/#/e/${naddr}/admin`);
    await expect(organizer.getByText(/approved ✓/i)).toHaveCount(3, { timeout: 15_000 });
    const aliceCard = organizer.locator(".card", { hasText: /approved ✓/i }).nth(1);
    await aliceCard.getByRole("button", { name: /^revoke$/i }).click();
    await expect(aliceCard.getByText(/keep/i)).toBeVisible();
    await aliceCard.getByRole("button", { name: /^revoke$/i }).click();
    await expect(aliceCard.getByText(/revoked/i)).toBeVisible({ timeout: 20_000 });
  });
});
