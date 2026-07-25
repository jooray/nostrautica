import { expect, type Page } from "@playwright/test";
import { ownPubkeyHex } from "../helpers.js";

/**
 * Helpers for the Marmot group-chat suite (audit O8). These drive the REAL app UI
 * against the chat coordinator double the orchestrator's chat/full tiers start
 * (e2e/local-infra/mock-coordinator-chat.mjs, the real Marmot admin bot). They are
 * the scenario plumbing the old chat tier lacked — the app + coordinator already
 * implement everything; nothing here is a stub.
 *
 * The moving parts, so the waits below read sensibly:
 *  - An event is chat-capable only with `chat=marmot` AND a coordinator attached
 *    (event-shell `showChat` / protocol `isMarmotChatEnabled`).
 *  - The coordinator is the MLS admin: it installs the event from its 31600 config,
 *    processes approvals into ECK grants, consumes each member's kind-30443 key
 *    package, and Adds them to the group (welcome → the member joins).
 *  - So "ready" for a member is: approved (grant received) → key package published →
 *    coordinator Add → welcome consumed. The composer is disabled until then.
 */

/** The short "aaaaaaaa…zzzz" badge AdminPeople renders for an attendee card. */
export function shortPubkey(hex: string): string {
  return hex.slice(0, 8) + "…" + hex.slice(-4);
}

/**
 * Create a `chat=marmot`, matching-off event and attach `coordNpub`, returning its
 * naddr. Chat is enabled at creation; the coordinator is attached afterward via the
 * proven EventSettings paste flow (the CoordinatorPicker's create-time button sits
 * under the fixed bottom nav, where a force-click lands on the overlay — the settings
 * page's attach control is reachable, as organizer-pages.spec.ts drives it headlessly
 * at a mobile viewport with no force). Matching is off so the coordinator never needs
 * an LLM/STT call — chat delivery is independent of the AI pipeline.
 */
export async function createChatEvent(page: Page, coordNpub: string, title: string): Promise<string> {
  await page.goto("/#/create");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Start").fill("2026-09-01T10:00");
  // Chat needs no matching; turning it off keeps the coordinator off the AI path.
  await page.locator("#match").selectOption("off");
  // Enable Marmot group chat. The ToggleSwitch's real checkbox is visually hidden
  // (1px, under its styled track), so `force` dispatches straight to the real
  // <input> and `check` verifies it ends up checked (which drives `chatEnabled`).
  await page
    .locator("label.toggle", { hasText: /group chat/i })
    .locator('input[type="checkbox"]')
    .check({ force: true });
  await page.getByRole("button", { name: /create event/i }).click();
  await expect(page.getByText(/event created/i)).toBeVisible({ timeout: 20_000 });
  const shareLink = await page.locator(".mono").first().innerText();
  const naddr = shareLink.match(/#\/e\/([^/\s]+)/)?.[1];
  if (!naddr) throw new Error("no naddr captured from the event-created share link");

  // Attach the coordinator on the settings page (chat=marmot + coordinator ⇒
  // isMarmotChatEnabled). This republishes the 31600 config with the coordinator tag
  // AND gift-wraps the install grant (21603) to the coordinator.
  await page.goto(`/#/e/${naddr}/settings`);
  const paste = page.locator("details").filter({ hasText: /paste.*npub/i });
  await paste.locator("summary").click();
  await paste.locator('input[placeholder*="coordinator" i]').fill(coordNpub);
  await page.getByRole("button", { name: /attach coordinator/i }).first().click();
  await expect(page.getByText(/coordinator attached/i)).toBeVisible({ timeout: 20_000 });

  // The attach config + grant race is handled by the coordinator itself now: a
  // fetched config that names NO coordinator yet is a retryable condition (bounded
  // backoff, ~35s window), so the single grant sent by attach installs once the
  // coordinator-bearing config propagates. No harness re-send needed.
  return naddr;
}

/** An approved attendee sends a plain (no-code) join request. */
export async function sendJoinRequest(page: Page, naddr: string): Promise<void> {
  await page.goto(`/#/e/${naddr}/join`);
  await page.getByRole("button", { name: /send join request/i }).click();
  await expect(page.getByText(/request sent/i)).toBeVisible({ timeout: 20_000 });
}

/**
 * Organizer approves every pending request. With a coordinator attached, "Approve"
 * routes an admin command and the button transitions queued → publishing → confirmed
 * (it DISABLES in place, it does not vanish), so re-clicking the same button would
 * hang on a disabled control. Use the bulk "Approve all (n)" control (one click, all
 * pending), then wait for the approved cards — mirrors join-approve-directory.spec.
 */
export async function approveAll(page: Page, naddr: string, expectedApproved: number): Promise<void> {
  await page.goto(`/#/e/${naddr}/admin`);
  // The requests summary can read "0 pending" before the join events decrypt — wait
  // for a real per-item Approve button, not the summary text.
  await page.getByRole("button", { name: /^approve$/i }).first().waitFor({ timeout: 30_000 });
  const bulk = page.getByRole("button", { name: /approve all/i });
  if (await bulk.count()) {
    await bulk.first().click();
  } else {
    // Single pending request (no bulk control): click its Approve once.
    await page.getByRole("button", { name: /^approve$/i }).first().click();
  }
  // The organizer is self-enrolled, so an extra Approved ✓ card exists from creation.
  // Generous: the coordinator round-trips the approve → grant → roster before the
  // card flips to "Approved ✓".
  await expect(page.getByText(/approved ✓/i)).toHaveCount(expectedApproved + 1, { timeout: 60_000 });
}

/**
 * Open an approved member's Chat and wait until the room is usable (composer
 * enabled). This is the setup → ready transition: key package published, coordinator
 * Add + welcome consumed. Generous timeout — the coordinator double has to install
 * the event, grant, and run the MLS Add.
 *
 * Visit the event page FIRST and confirm membership ("see who's here"): that page
 * runs receiveGrants + eventShell.sync so the ECK grant is ingested and the shell
 * resolves this viewer as a member (which also PREWARMS the chat session — publishes
 * the kind-30443 key package). Going straight to /chat can race the grant fetch and
 * latch the gate on "not a member yet" with nothing to re-trigger it (the exact
 * failure this replaced).
 */
export async function openChatAwaitReady(page: Page, naddr: string, timeoutMs = 90_000): Promise<void> {
  await page.goto(`/#/e/${naddr}`);
  await expect(page.getByText(/see who's here/i)).toBeVisible({ timeout: timeoutMs });
  await page.goto(`/#/e/${naddr}/chat`);
  const composer = page.locator("form.compose textarea");
  try {
    await expect(composer).toBeEnabled({ timeout: timeoutMs });
  } catch (e) {
    // Surface the chat page's own error (session failures show ErrorState with a
    // collapsed "Technical details") so a failure is diagnosable, not just a timeout.
    const det = page.locator("details").filter({ hasText: /technical details/i });
    if (await det.count().catch(() => 0)) await det.first().locator("summary").click().catch(() => {});
    const main = (await page.getByRole("main").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400);
    throw new Error(`chat never became ready. page shows: ${main}\n(original: ${(e as Error).message})`);
  }
}

/** Send a chat message from a ready (leader or interactive-follower) tab. */
export async function sendChat(page: Page, text: string): Promise<void> {
  const ta = page.locator("form.compose textarea").first();
  await ta.fill(text);
  // Scope to the compose form: a bare button[aria-label] would match a nav button.
  // `force`: the sticky composer can sit against the fixed bottom nav.
  await page.locator("form.compose button.send").first().click({ force: true });
  // The composer clears on a successful send.
  await expect(ta).toHaveValue("", { timeout: 15_000 });
}

/** Assert a message with `text` is visible in the message pane. */
export async function expectMessage(page: Page, text: string, timeoutMs = 30_000): Promise<void> {
  await expect(page.locator(".messages")).toContainText(text, { timeout: timeoutMs });
}

/** Assert a message is NOT present after a settle window (for revocation lockout). */
export async function expectNoMessage(page: Page, text: string, settleMs = 8_000): Promise<void> {
  await page.waitForTimeout(settleMs);
  await expect(page.locator(".messages")).not.toContainText(text);
}

export { ownPubkeyHex };
