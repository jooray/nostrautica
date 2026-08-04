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
// Writes the preference AND flips `data-theme` on <html> — app.css keys every
// colour off that attribute alone, and localStorage is only read at boot. Setting
// storage by itself changed nothing on an already-loaded page, so every "light"
// and "dark" pair this script produced was the same pixels twice: the guides'
// `participant/marmot-chat-roundtrip-light.png` was byte-identical to its dark
// sibling, and both showed the dark UI. Same failure the sibling capture script
// hit and fixed (see `setThemeNoReload` in e2e/screenshot-refresh.mjs).
const setTheme = (p, mode) =>
  p.evaluate((v) => {
    try {
      localStorage.setItem("nostrautica:theme", v);
    } catch {
      /* private mode */
    }
    document.documentElement.setAttribute("data-theme", v);
  }, mode);

async function shot(page, stem, mode) {
  await setTheme(page, mode);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT_DIR}/${stem}-${mode}.png` });
  log("shot", `${stem}-${mode}.png`);
}

// Backend relay for direct nak polling (NOT the browser-facing wss proxy —
// nak talks plain ws straight to nak-serve, same event store).
const RELAY_WS = process.env.MARMOT_E2E_RELAY_WS ?? "ws://localhost:7777";

/**
 * Login.svelte flips to "You're in" the instant the local key exists
 * client-side and publishes the new kind-0 profile in the BACKGROUND — it
 * never blocks on that publish landing on the relay. But Join.svelte's
 * logged-in branch re-fetches this same identity's OWN kind-0 to prefill the
 * join form, bounded to 8s with no retry once it settles on "failed"/"empty"
 * (profile-load.ts canSubmitLoggedIn then keeps "Send join request" disabled
 * until a name is typed by hand — which is exactly the timeout this script
 * hit: the button stayed disabled the whole 30s Playwright waited on it).
 * This is a documented, already-fixed race — see e2e/tests/helpers.ts's own
 * `newUser`, which closes it by polling the relay directly for the kind-0
 * before returning, instead of assuming the background publish won the race.
 * Mirrored here with `nak req` (already a dependency of this script via
 * `nak decode`) rather than a raw ws client.
 */
function waitForOwnKind0(pubkeyHex, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const out = execSync(`nak req -k 0 -a ${pubkeyHex} -l 1 ${RELAY_WS}`, {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) return true;
    } catch {
      /* relay hiccup or not-yet-published — retry */
    }
    // Synchronous sleep (this helper runs before any page work, so blocking
    // the event loop briefly is harmless) — guards against a fast-failing nak
    // invocation (e.g. connection refused) spinning the loop with no backoff.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
  return false;
}

async function newUser(ctx, name) {
  const page = await ctx.newPage();
  page.on("console", (m) => { log(`[console:${name}:${m.type()}]`, m.text().slice(0, 300)); });
  page.on("pageerror", (e) => log(`[pageerror:${name}]`, String(e).slice(0, 300)));
  await fresh(page)("#/login");
  await page.getByLabel(/your name/i).fill(name);
  await page.getByRole("button", { name: /create my identity/i }).click();
  await page.getByText(/you're in|welcome/i).first().waitFor({ timeout: 15000 });
  // Deliberately NOT `fresh()` (which hops through about:blank first, a hard
  // reload) — Login.svelte's identity-creation flow keeps publishing in the
  // BACKGROUND after "You're in" appears (publishProfile → ensureRelayList →
  // ensureDmRelayList, all still in flight), and a hard reload tears down the
  // page's JS realm and open sockets, silently killing that in-flight publish
  // mid-request (this is why the first attempt at this guard made things WORSE:
  // it navigated via `fresh()` right here and every kind-0 came back empty even
  // after 20s of polling — not a slow relay, a cancelled request). A same-origin
  // hash-only `page.goto` is a client-side SPA route swap, not a real
  // navigation, so it doesn't touch the in-flight request — same pattern
  // e2e/tests/helpers.ts's `ownPubkeyHex` already relies on.
  await page.goto(`${BASE}#/me`);
  await page.waitForTimeout(500);
  const body = await page.locator("body").innerText().catch(() => "");
  const npub = (body.match(/npub1[0-9a-z]{20,}/i) || [])[0];
  if (npub) {
    const hex = execSync(`nak decode ${npub}`, { encoding: "utf8" }).trim();
    const gotIt = waitForOwnKind0(hex);
    log(`${name} kind-0 landed on relay before /join:`, gotIt);
  } else {
    log(`${name}: could not read own npub from /me — skipping kind-0 relay-poll guard`);
  }
  return page;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults",
      // The build's relay is wss://localhost:7778 (wss-relay-proxy's throwaway
      // self-signed cert — see that file's header: Marmot's key-package publish
      // requires a wss:// relay URL, so chat tiers front the plain relay with TLS).
      // Without this flag every WS connection attempt fails with
      // ERR_CERT_AUTHORITY_INVALID and the app never reaches the relay at all —
      // this is what playwright.config.ts's launchOptions.args already carries
      // for the scripted suite; this standalone script had drifted from that and
      // was missing it, which is why the create-event form hung (relay-gated
      // state never arrived) and the "group chat" checkbox locator timed out.
      "--ignore-certificate-errors",
    ],
  });
  const opts = {
    viewport: { width: 1280, height: 900 },
    // Paired with the launch flag above — Playwright's page-level HTTPS handling
    // is separate from Chromium's own flag, and both are needed (mirrors
    // playwright.config.ts's `use.ignoreHTTPSErrors`).
    ignoreHTTPSErrors: true,
  };

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
    // Create.svelte swapped the raw <input type="checkbox"> for the styled
    // ToggleSwitch component (label.toggle, not label.check) — the real input is
    // visually hidden (1px, clip-path) behind its track, so a plain `.check()`
    // fails Playwright's actionability (visibility) check; `force: true`
    // dispatches straight to the real input, same as e2e/tests/chat/chat-helpers.ts
    // (createChatEvent) and e2e/screenshot-refresh.mjs already do for this control.
    await olga.locator('label.toggle', { hasText: /group chat/i }).locator('input[type="checkbox"]').check({ force: true });
    await olga.getByRole("button", { name: /^create event$/i }).click();
    await olga.getByText(/event created/i).waitFor({ timeout: 20000 });
    const shareLink = await olga.locator(".mono").first().innerText();
    const naddr = shareLink.match(/#\/e\/([^/\s]+)/)?.[1];
    if (!naddr) throw new Error("no naddr captured from event-created share link");
    record("1-event-created", { naddr, matching: "off", chat: true });

    // ── 2. Attach the coordinator ────────────────────────────────────────────
    // Attaching moved off the Admin page to Event settings (Admin.svelte now
    // only shows a hint + a button that navigates to Settings — "Attaching /
    // swapping a coordinator is one-time setup, so it lives on Event settings").
    // The paste-npub control lives inside a collapsed <details> (advanced/fallback
    // path), same as e2e/tests/chat/chat-helpers.ts's createChatEvent.
    await gotoOlga(`#/e/${naddr}/settings`);
    const paste = olga.locator("details").filter({ hasText: /paste.*npub/i });
    await paste.locator("summary").click();
    await paste.locator('input[placeholder*="coordinator" i]').fill(COORD_NPUB);
    await olga.getByRole("button", { name: /attach coordinator/i }).first().click();
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
    // PersonId.svelte's admin-card chip used to print raw hex ("2e5124a9…0024")
    // — matching `shortPk` above — but a 2026-07-30 change ("the chip did
    // nothing") swapped it for a short NPUB (`npub.slice(0,10) + "…" +
    // npub.slice(-4)`), shown in a `.badge.id` next to the name (which itself
    // now renders even when it came from a plain join request, not just an
    // approved one — request.name flows straight into it). Neither the old
    // hex-slice format NOR an assumption that the badge is the only visible
    // identifier still holds, so `bobShort` below must match what's actually
    // on screen today.
    const shortNpub = (pk) => {
      if (!pk) return undefined;
      const npub = execSync(`nak encode npub ${pk}`, { encoding: "utf8" }).trim();
      return npub.slice(0, 10) + "…" + npub.slice(-4);
    };
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
    const bobShort = shortNpub(bobPubkeyHex);
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
