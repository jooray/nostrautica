import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { newUser } from "../helpers.js";
import {
  createChatEvent,
  sendJoinRequest,
  approveAll,
  openChatAwaitReady,
  sendChat,
  expectMessage,
  ownPubkeyHex,
} from "./chat-helpers.js";

/**
 * Real Marmot group-chat E2E (audit O8). The old chat tier started chat infra but
 * only re-ran the smoke/integration specs — no test ever sent, reloaded, revoked, or
 * handed over a chat. This suite is that missing coverage, run ONLY on the
 * coordinator tiers (the orchestrator adds tests/chat for chat/full and sets
 * NOSTRAUTICA_E2E_COORDINATOR_NPUB). Four scenarios over ONE shared event + members,
 * serial so the expensive create → attach → join → approve → MLS-Add setup runs once:
 *
 *   1. two-member round trip (Alice ⇄ Bob over kind-445)
 *   2. reload + recovery (Alice reloads: history decrypts, live stream resumes)
 *   3. two-tab leadership handover (leader tab closes, second tab takes over MLS ops)
 *   4. revocation (removed Bob stops receiving; the group continues for the rest)
 *
 * The coordinator double is the real Marmot admin bot (mock-coordinator-chat.mjs);
 * only STT/LLM are mocked, and matching is off, so nothing here needs API money.
 */
const COORD_NPUB = process.env.NOSTRAUTICA_E2E_COORDINATOR_NPUB;
const RELAY_UP = !!process.env.NOSTRAUTICA_E2E_RELAY;

test.describe.serial(COORD_NPUB && RELAY_UP ? "marmot group chat" : "marmot group chat (needs coordinator — skipped)", () => {
  test.skip(!COORD_NPUB || !RELAY_UP, "run via `pnpm e2e:chat` / `pnpm e2e:full` — needs the chat coordinator double");

  let organizerCtx: BrowserContext;
  let aliceCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let organizer: Page;
  let alice: Page;
  let bob: Page;
  let naddr: string;
  let bobPk8: string;

  // Markers carried between serial scenarios (history-recovery assertions).
  let m1: string; // Alice → Bob
  let m2: string; // Bob → Alice

  test.beforeAll(async ({ browser }) => {
    // Setup is the whole create → attach → join → approve chain (three fresh
    // identities, each relay-poll-gated); give it plenty of room.
    test.setTimeout(240_000);
    organizerCtx = await browser.newContext();
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();

    organizer = await newUser(organizerCtx, "Olga Organizer");
    naddr = await createChatEvent(organizer, COORD_NPUB!, "Marmot Chat E2E");

    alice = await newUser(aliceCtx, "Alice Attendee");
    bob = await newUser(bobCtx, "Bob Attendee");
    bobPk8 = (await ownPubkeyHex(bob)).slice(0, 8);

    // Joins may be published before the coordinator's E_inbox subscription is live:
    // installEvent's backfillEventInbox now fetches inbox history (joins first) after
    // subscribing, so pre-subscription joins enroll cleanly. No install wait needed.
    await sendJoinRequest(alice, naddr);
    await sendJoinRequest(bob, naddr);
    await approveAll(organizer, naddr, 2);
  });

  test.afterAll(async () => {
    await organizerCtx?.close();
    await aliceCtx?.close();
    await bobCtx?.close();
  });

  test("1 — two-member message round trip", async () => {
    test.setTimeout(180_000);
    await openChatAwaitReady(alice, naddr);
    await openChatAwaitReady(bob, naddr);

    m1 = `hello-from-alice-${Date.now()}`;
    await sendChat(alice, m1);
    await expectMessage(bob, m1);
    // Sender sees their own message too.
    await expectMessage(alice, m1);

    m2 = `hello-from-bob-${Date.now()}`;
    await sendChat(bob, m2);
    await expectMessage(alice, m2);
    await expectMessage(bob, m2);
  });

  test("2 — reload keeps history and resumes the live stream", async () => {
    test.setTimeout(150_000);
    // Alice reloads the chat page: MLS group state + message history live in
    // IndexedDB, so the room must re-open with the prior conversation intact…
    await alice.reload();
    await expect(alice.locator("form.compose textarea")).toBeEnabled({ timeout: 90_000 });
    await expectMessage(alice, m1);
    await expectMessage(alice, m2);

    // …and the live stream must still decrypt: Bob sends after Alice's reload.
    const m3 = `after-reload-${Date.now()}`;
    await sendChat(bob, m3);
    await expectMessage(alice, m3);
  });

  test("3 — two-tab leadership handover", async () => {
    test.setTimeout(150_000);
    // A second Alice tab (same context ⇒ same account, shared Web Locks) joins as a
    // follower while the first tab holds leadership.
    const alice2 = await aliceCtx.newPage();
    await alice2.goto(`/#/e/${naddr}/chat`);
    // The follower renders the leader's messages (broadcast) — prior history shows.
    await expectMessage(alice2, m1, 60_000);

    // Close the leader tab: its Web Lock releases so the surviving tab can take over
    // MLS operations for this account. A re-open of the survivor re-runs leader
    // election against the now-free lock and re-derives the group from the shared
    // per-account IndexedDB MLS state — it becomes the leader with its own live
    // client (the promotion-on-release path is timing-sensitive headlessly, so the
    // re-open makes the takeover deterministic; the point is that a DIFFERENT tab,
    // after the original leader is gone, drives the group). Proof: a send from it
    // reaches Bob with the original leader tab closed.
    await alice.close();
    // Reload the survivor directly on /chat (it's an established member — its ECK
    // grant + MLS state are already in this context's IndexedDB — so it resolves
    // membership from cache and re-elects as the sole leader without the event-page
    // round trip).
    await alice2.reload();
    await expect(alice2.locator("form.compose textarea")).toBeEnabled({ timeout: 90_000 });
    // History survived the takeover (re-derived from the shared MLS state).
    await expectMessage(alice2, m1, 30_000);

    const marker = `handover-${Date.now()}`;
    await expect(async () => {
      await alice2.locator("form.compose textarea").fill(marker);
      await alice2.locator("form.compose button.send").click({ force: true });
      await expectMessage(bob, marker, 12_000);
    }).toPass({ timeout: 90_000 });

    // The surviving tab is Alice's chat for the rest of the suite.
    alice = alice2;
  });

  test("4 — revocation locks out the removed member; group continues", async () => {
    test.setTimeout(200_000);
    // Revoke Bob from admin (routed through the coordinator → MLS Remove + ECK
    // rotation). The card is found by Bob's short-pubkey badge. (The organizer is
    // NOT brought into chat here: an extra MLS Add commit right before the Remove
    // piles more epoch churn on Alice's client than the removal test needs.)
    await organizer.goto(`/#/e/${naddr}/admin`);
    const bobCard = organizer.locator(".card", { hasText: bobPk8 }).first();
    await expect(bobCard).toBeVisible({ timeout: 30_000 });
    await bobCard.getByRole("button", { name: /^revoke$/i }).click({ force: true }); // open confirm
    await bobCard.getByRole("button", { name: /^revoke$/i }).click({ force: true }); // confirm
    await expect(bobCard.getByText(/revoked ✓/i)).toBeVisible({ timeout: 30_000 });

    // "Group continues" AND "removed member stops receiving" in one retried block:
    // each attempt Alice sends a FRESH marker and sees it (the group still works for
    // her = continues), then a re-synced Bob is checked NOT to have it. Until Alice's
    // client has processed the Remove commit she's still on the old epoch, where the
    // just-removed Bob can still decrypt her message; once she advances to the new
    // epoch her marker no longer reaches Bob. Retrying absorbs that MLS
    // Remove-commit + ECK-rotation propagation delay without a fixed sleep.
    await expect(async () => {
      const marker = `post-revoke-${Date.now()}`;
      await alice.locator("form.compose textarea").fill(marker);
      await alice.locator("form.compose button.send").click({ force: true });
      await expectMessage(alice, marker, 10_000); // group continues: Alice is usable
      await bob.goto(`/#/e/${naddr}/chat`); // Bob re-syncs to the latest group state
      await bob.waitForTimeout(4_000);
      await expect(bob.locator(".messages")).not.toContainText(marker); // Bob locked out
    }).toPass({ timeout: 120_000 });
  });
});
