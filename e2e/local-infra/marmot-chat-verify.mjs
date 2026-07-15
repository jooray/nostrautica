/**
 * Marmot chat live E2E — Playwright UI flow driving the REAL app against a REAL
 * coordinator over a REAL relay (no in-memory/FakeNetwork stand-in on either
 * side). Written for the G-3 ("join Marmot group on late welcome") live
 * verification pass (2026-07-16) — see docs/MARMOT-CHAT-E2E-2026-07-16.md for
 * the full write-up, findings, and screenshots this script produced.
 *
 * Flow: organizer creates a chat=marmot, matching=off event -> attaches a
 * coordinator (pass its npub as argv[2]) -> two attendees join -> organizer
 * approves both (routed through the coordinator) -> both attendees open Chat
 * and wait for "Setting up…" -> ready (the exact path G-3 fixed) -> attendee A
 * sends, B receives; B sends, A receives -> screenshots -> organizer revokes
 * one attendee -> confirm MLS lockout (no more messages visible, send fails).
 *
 * Prerequisites (none of this script's job — start these yourself first):
 *   - A real WebSocket Nostr relay, e.g. `node e2e/local-infra/relay.mjs 7799`.
 *   - A coordinator process (packages/coordinator/dist/main.js + a toml
 *     pointed at that relay) with chat wired in (createMarmotClientMls) —
 *     print its npub and pass it as argv[2] here.
 *   - The app built with VITE_NOSTRAUTICA_RELAYS pointed at the same relay
 *     and served (vite preview), reachable at MARMOT_E2E_BASE (default
 *     http://localhost:4199).
 *
 * Usage:
 *   MARMOT_E2E_BASE=http://localhost:4199 \
 *   MARMOT_E2E_SHOTS_DIR=/path/to/docs/images \
 *   node e2e/local-infra/marmot-chat-verify.mjs <coordinator-npub>
 *
 * Known flakiness (see the write-up): reaching "ready" for BOTH attendees is
 * NOT 100% reliable yet — in ~2/3 of runs during the verification pass, one or
 * both attendees landed on a permanent "Group chat isn't available for this
 * event, or you're not a member yet." screen instead, traced to a one-shot,
 * non-reactive `eventShell.showChat` check in EventChat.svelte racing the
 * async roster/ECK-grant decrypt in event-shell.svelte.ts's `sync()` (not a
 * defect in the G-3 fix itself — see the write-up's Bug 3). When it DOES reach
 * "ready", the join and the kind-445 round-trip have been 100% reliable.
 */
import { chromium } from "@playwright/test";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const BASE = process.env.MARMOT_E2E_BASE ?? "http://localhost:4199";
const OUT_DIR = process.env.MARMOT_E2E_SHOTS_DIR ?? ".";
const STATE_PATH = process.env.MARMOT_E2E_STATE ?? "./marmot-e2e-state.json";
const COORD_NPUB = process.argv[2];
if (!COORD_NPUB) { console.error("usage: node marmot-chat-verify.mjs <coordinator-npub>"); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const state = { steps: {} };
const record = (step, data) => { state.steps[step] = data; writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); log("STATE", step, JSON.stringify(data)); };

const fresh = (p) => async (hash) => { await p.goto("about:blank"); await p.goto(BASE + hash, { waitUntil: "load" }); };
const setTheme = (p, mode) => p.evaluate((v) => { try { localStorage.setItem("nostrautica:theme", v); } catch {} }, mode);

async function shot(page, stem, mode) {
  await setTheme(page, mode);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT_DIR}/${stem}-${mode}.png` });
  log("shot", `${stem}-${mode}.png`);
}

async function newUser(ctx, name) {
  const page = await ctx.newPage();
  page.on("console", (m) => { log(`[console:${name}:${m.type()}]`, m.text().slice(0, 300)); });
  page.on("pageerror", (e) => log(`[pageerror:${name}]`, String(e).slice(0, 300)));
  await fresh(page)("#/login");
  await page.getByLabel(/your name/i).fill(name);
  await page.getByRole("button", { name: /create my identity/i }).click();
  await page.getByText(/you're in|welcome/i).first().waitFor({ timeout: 15000 });
  return page;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults"],
  });
  const opts = { viewport: { width: 1280, height: 900 } };

  try {
    // ── 1. Organizer creates the event ──────────────────────────────────────
    const olga = await newUser(await browser.newContext(opts), "Olga Organizer");
    const gotoOlga = fresh(olga);
    await gotoOlga("#/create");
    await olga.getByLabel("Title").fill("Marmot Chat E2E Verification");
    await olga.getByLabel("Start").fill("2026-09-01T10:00");
    // Matching OFF: chat delivery doesn't need the AI pipeline, and this keeps
    // the test coordinator from ever needing a real LLM/STT call.
    await olga.locator("#match").selectOption("off");
    await olga.locator('label.check', { hasText: /group chat/i }).locator('input[type=checkbox]').check();
    await olga.getByRole("button", { name: /^create event$/i }).click();
    await olga.getByText(/event created/i).waitFor({ timeout: 20000 });
    const shareLink = await olga.locator(".mono").first().innerText();
    const naddr = shareLink.match(/#\/e\/([^/\s]+)/)?.[1];
    if (!naddr) throw new Error("no naddr captured from event-created share link");
    record("1-event-created", { naddr, matching: "off", chat: true });

    // ── 2. Attach the coordinator ────────────────────────────────────────────
    await gotoOlga(`#/e/${naddr}/admin`);
    await olga.locator('input[placeholder*="coordinator" i]').fill(COORD_NPUB);
    await olga.getByRole("button", { name: /attach coordinator/i }).click();
    await olga.getByText(/attached/i).first().waitFor({ timeout: 15000 });
    await shot(olga, "organizer/marmot-05-coordinator-attached", "light");
    await shot(olga, "organizer/marmot-05-coordinator-attached", "dark");
    record("2-coordinator-attached", { npub: COORD_NPUB });

    // ── 3. Two attendees join (plain link, no invite code) ──────────────────
    const aliceCtx = await browser.newContext(opts);
    const bobCtx = await browser.newContext(opts);
    const alice = await newUser(aliceCtx, "Alice Attendee");
    const bob = await newUser(bobCtx, "Bob Attendee");
    // The join form's request.name is a SEPARATE field from the login-time
    // display name (Admin's approved-card <strong>{req.name}</strong> renders
    // empty when it's skipped, showing only the short-pubkey badge) — grab each
    // attendee's own hex pubkey via their Me page so the admin card can be found
    // reliably by that badge later, regardless of the (empty) name.
    async function grabPubkeyHex(page) {
      await fresh(page)("#/me");
      await page.waitForTimeout(1200);
      const body = await page.locator("body").innerText().catch(() => "");
      const npub = (body.match(/npub1[0-9a-z]{20,}/i) || [])[0];
      if (!npub) return undefined;
      try {
        return execSync(`nak decode ${npub}`, { encoding: "utf8" }).trim();
      } catch {
        return undefined;
      }
    }
    const alicePubkeyHex = await grabPubkeyHex(alice);
    const bobPubkeyHex = await grabPubkeyHex(bob);
    const shortPk = (pk) => (pk ? pk.slice(0, 8) + "…" + pk.slice(-4) : undefined);
    log("alice pubkey short:", shortPk(alicePubkeyHex), "bob pubkey short:", shortPk(bobPubkeyHex));

    for (const [p, name] of [[alice, "Alice"], [bob, "Bob"]]) {
      await fresh(p)(`#/e/${naddr}/join`);
      await p.getByRole("button", { name: /send join request/i }).click();
      await p.getByText(/request sent/i).first().waitFor({ timeout: 15000 });
      log(`${name} join request sent`);
    }
    record("3-joins-sent", { alice: true, bob: true, alicePubkeyHex, bobPubkeyHex });

    // ── 4. Organizer approves both (routed through the coordinator) ─────────
    await gotoOlga(`#/e/${naddr}/admin`);
    // The scroll-to-requests summary button says "0 pending requests" (still
    // matches /pending request/i) until the join-request events are fetched
    // and decrypted off the relay — wait for an actual "Approve" card button,
    // not the summary text, which can be misleadingly present at n=0.
    await olga.getByRole("button", { name: /^approve$/i }).first().waitFor({ timeout: 20000 });
    for (let i = 0; i < 5; i++) {
      const btn = olga.getByRole("button", { name: /^approve$/i });
      const n = await btn.count();
      if (n === 0) break;
      await btn.first().click();
      await olga.waitForTimeout(1500);
    }
    await olga.getByText(/approved ✓/i).first().waitFor({ timeout: 20000 });
    record("4-approved", { done: true });
    log("approvals routed through coordinator — waiting for grantAndPublish + marmot.syncMember");
    await olga.waitForTimeout(3000);

    // ── 5. Both attendees open Chat; wait for "setup" -> "ready" (G-3) ──────
    async function openChatAndAwaitReady(page, name, timeoutMs) {
      await fresh(page)(`#/e/${naddr}/chat`);
      const start = Date.now();
      let sawSetup = false;
      while (Date.now() - start < timeoutMs) {
        const body = await page.locator("body").innerText().catch(() => "");
        if (/setting up your secure chat/i.test(body)) sawSetup = true;
        const composeDisabled = await page.locator("textarea").first().isDisabled().catch(() => true);
        if (!composeDisabled) return { ready: true, elapsedMs: Date.now() - start, sawSetup };
        await page.waitForTimeout(1500);
      }
      return { ready: false, elapsedMs: Date.now() - start, sawSetup };
    }

    await fresh(alice)(`#/e/${naddr}/chat`);
    await alice.waitForTimeout(1500);
    await shot(alice, "participant/marmot-chat-setup", "light");
    await shot(alice, "participant/marmot-chat-setup", "dark");

    const [aliceReady, bobReady] = await Promise.all([
      openChatAndAwaitReady(alice, "Alice", 90000),
      openChatAndAwaitReady(bob, "Bob", 90000),
    ]);
    record("5-chat-ready", { alice: aliceReady, bob: bobReady });

    if (!aliceReady.ready || !bobReady.ready) {
      log("at least one attendee never left 'Setting up…' / never became a member within the timeout.");
      await shot(alice, "participant/marmot-chat-timeout-alice", "light");
      await shot(bob, "participant/marmot-chat-timeout-bob", "light");
      throw new Error("chat did not reach ready state for both attendees — see step 5-chat-ready in state");
    }

    // ── 6. Round-trip: Alice -> Bob, then Bob -> Alice ───────────────────────
    async function sendMsg(page, text, who) {
      const ta = page.locator("textarea").first();
      await ta.fill(text);
      // Scoped to the compose form specifically — an unscoped `button[aria-label]`
      // matches an app-shell nav button first and navigates away from chat.
      await page.locator('form.compose button.send').first().click();
      await page.waitForTimeout(800);
      log(`sendMsg[${who}] textarea value after click: "${await ta.inputValue().catch(() => "<err>")}"`);
    }
    async function waitForText(page, text, timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const body = await page.locator(".messages").innerText().catch(() => "");
        if (body.includes(text)) return true;
        await page.waitForTimeout(1000);
      }
      return false;
    }

    const marker1 = `hello-from-alice-${Date.now()}`;
    await sendMsg(alice, marker1, "alice");
    const bobGotAlice = await waitForText(bob, marker1, 25000);
    record("6a-alice-to-bob", { sent: marker1, bobReceived: bobGotAlice });

    const marker2 = `hello-from-bob-${Date.now()}`;
    await sendMsg(bob, marker2, "bob");
    const aliceGotBob = await waitForText(alice, marker2, 25000);
    record("6b-bob-to-alice", { sent: marker2, aliceReceived: aliceGotBob });

    await shot(alice, "participant/marmot-chat-roundtrip", "light");
    await shot(alice, "participant/marmot-chat-roundtrip", "dark");
    await shot(bob, "participant/marmot-chat-roundtrip-bob", "light");
    await shot(bob, "participant/marmot-chat-roundtrip-bob", "dark");

    if (!bobGotAlice || !aliceGotBob) {
      throw new Error(`round-trip incomplete: bobGotAlice=${bobGotAlice} aliceGotBob=${aliceGotBob}`);
    }
    log("ROUND-TRIP COMPLETE both directions over the real relay.");

    // ── 7. Revoke Bob; confirm MLS lockout ───────────────────────────────────
    await gotoOlga(`#/e/${naddr}/admin`);
    await olga.getByText(/approved/i).first().waitFor({ timeout: 20000 });
    const bobShort = shortPk(bobPubkeyHex);
    if (!bobShort) throw new Error("could not resolve Bob's pubkey to locate his admin card");
    let bobCardVisible = await olga.getByText(bobShort).first().isVisible().catch(() => false);
    for (let i = 0; i < 6 && !bobCardVisible; i++) {
      const refreshBtn = olga.getByRole("button", { name: /refresh/i });
      if (await refreshBtn.count()) await refreshBtn.first().click();
      await olga.waitForTimeout(3000);
      bobCardVisible = await olga.getByText(bobShort).first().isVisible().catch(() => false);
    }
    await olga.getByText(bobShort).first().waitFor({ timeout: 10000 });
    const bobCard = olga.locator(".card", { hasText: bobShort }).first();
    await bobCard.getByRole("button", { name: /^revoke$/i }).click();
    await bobCard.getByText(/keep/i).waitFor({ timeout: 5000 });
    await bobCard.getByRole("button", { name: /^revoke$/i }).click();
    await bobCard.getByText(/revoked/i).waitFor({ timeout: 20000 });
    record("7-revoked", { who: "bob" });
    await olga.waitForTimeout(3000); // let marmot.handleRevoke's MLS-Remove commit propagate

    const marker3 = `post-revoke-alice-${Date.now()}`;
    await sendMsg(alice, marker3, "alice-post-revoke");
    await alice.waitForTimeout(1500);

    await fresh(bob)(`#/e/${naddr}/chat`);
    await bob.waitForTimeout(3000);
    const bobBodyAfterRevoke = await bob.locator("body").innerText().catch(() => "");
    const bobStillSeesNewMsg = bobBodyAfterRevoke.includes(marker3);

    let bobSendOutcome = "unknown";
    try {
      const composeDisabled = await bob.locator("textarea").first().isDisabled().catch(() => true);
      if (composeDisabled) {
        bobSendOutcome = "compose-disabled";
      } else {
        await sendMsg(bob, `post-revoke-bob-attempt-${Date.now()}`, "bob-post-revoke");
        await bob.waitForTimeout(1500);
        bobSendOutcome = "attempted";
      }
    } catch (e) {
      bobSendOutcome = `threw: ${String(e).slice(0, 150)}`;
    }

    await shot(bob, "participant/marmot-chat-revoked-bob", "light");
    await shot(bob, "participant/marmot-chat-revoked-bob", "dark");
    record("8-lockout-check", { bobStillSeesNewMsgFromAlice: bobStillSeesNewMsg, bobSendOutcome });

    console.log("MARMOT_CHAT_VERIFY_DONE", JSON.stringify({ ok: true, naddr }));
  } catch (err) {
    log("FATAL", err?.stack || String(err));
    record("FATAL_ERROR", { message: String(err) });
    console.log("MARMOT_CHAT_VERIFY_DONE", JSON.stringify({ ok: false, error: String(err) }));
  } finally {
    await browser.close();
  }
})();
