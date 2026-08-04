/**
 * Screenshot refresh (docs pass 2026-07-21): captures every stem the guides
 * reference — organizer + participant journeys, matches, chat, DM — across
 * en/sk/cs, light + dark, at the repo's 390x844 mobile-viewport convention.
 *
 * Locale and theme are both set via localStorage (`nostrautica:lang` /
 * `nostrautica:theme`) BEFORE any page script runs, never by clicking a
 * button whose accessible name is itself translated — that was the failure
 * mode of the previous version of this script (English text landed in the
 * sk/cs folders, and every "dark" shot was a byte-identical copy of light
 * because the theme-toggle button's English name never matched in sk/cs).
 *
 * Requires a coordinator with real Marmot chat support running against the
 * local relay (see e2e/local-infra/mock-coordinator-chat.mjs) and a matching
 * kind-31611 announcement already published — see docs/E2E-TESTING-GUIDE.md.
 */
import { chromium } from "@playwright/test";
import { mkdirSync, copyFileSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const BASE_URL = process.env.NOSTRAUTICA_URL ?? "http://localhost:4173";
const DOCS = process.env.NOSTRAUTICA_DOCS_DIR ?? "/Users/juraj/projects/nostrautica/docs/images";
const WEB = process.env.NOSTRAUTICA_WEB_DIR ?? "/Users/juraj/projects/nostrautica/web/assets/screenshots";
const LOCALE = process.env.LOCALE ?? "en";
const COORDINATOR_NPUB =
  process.env.COORDINATOR_NPUB ?? "npub1ersh9uzpyp3xafd04xjweuwchjfyhpu6edrkzddhm5chx52t8jas30gjfz";

const LAUNCH_ARGS = [
  "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--ignore-certificate-errors",
];

// Expected landing-page fragments per locale — used to prove the UI is
// ACTUALLY translated before we capture a single pixel, not just that we
// asked it to be. Pulled from packages/app/src/lib/i18n/messages.ts.
const LOCALE_PROOF = {
  en: ["Meet the right people", "Get started"],
  sk: ["Stretnite", "Začať"],
  cs: ["Poznejte", "Začít"],
};

// The mock coordinator (e2e/local-infra/mock-coordinator-chat.mjs) has proven
// unreliable across a multi-persona, multi-minute run — it sometimes silently
// stops processing E_inbox events (confirmed alive, connected, and simply
// inert; not a crash, not the Docker relay, root cause not found after
// substantial isolated testing 2026-07-21/22). The six stems that depend on
// it staying responsive for the WHOLE run (transcript, my-profile-edited,
// matches, DM/messages/mute, chat-conversation) are gated behind this flag so
// normal runs (all three locales) stay fast and 100% reliable on the other 44
// stems. Set INCLUDE_FLAKY=1 to attempt them anyway.
const INCLUDE_FLAKY = process.env.INCLUDE_FLAKY === "1";

const orgDir = LOCALE === "en" ? "organizer" : `organizer-${LOCALE}`;
const partDir = LOCALE === "en" ? "participant" : `participant-${LOCALE}`;
const appDir = LOCALE === "en" ? "app" : `app-${LOCALE}`;

// Demo content that ends up VISIBLE in screenshots (intros, chat, DMs) — kept
// in the event's own language per locale rather than left in English, since
// these are real rendered text, not internal-only fixture data.
const COPY = {
  en: {
    eventSummary:
      "A relaxed evening for Nostr builders and curious newcomers — short intros, good conversations, and a few lightning talks by the water.",
    eventLocation: "Bratislava",
    ninaIntro: "Rust developer working on privacy tooling. Looking for a co-founder who cares about usability.",
    nadiaIntro: "Product designer who loves making cryptography approachable. Looking for engineers to collaborate with.",
    ninaAbout: "New to Nostr, excited to meet people.",
    dm: "Hey! Looking forward to the event.",
    chatWelcome: "Welcome everyone! Excited to see you all here.",
    chatReply: "Thanks for organizing this, looking forward to it!",
    chatProof: /organizing|looking forward/i,
    postTitle: "Welcome to the assembly",
    postBody: "Looking forward to seeing everyone — schedule and details inside.",
    talkTitle: "Lightning talk: Nostr for newcomers",
  },
  sk: {
    eventSummary:
      "Uvoľnený večer pre Nostr nadšencov a zvedavých nováčikov — krátke predstavenia, dobré rozhovory a pár bleskových prednášok pri vode.",
    eventLocation: "Bratislava",
    ninaIntro: "Rust vývojárka, pracujem na nástrojoch pre súkromie. Hľadám spoluzakladateľa, ktorému záleží na použiteľnosti.",
    nadiaIntro: "Produktová dizajnérka, ktorá rada robí kryptografiu zrozumiteľnou. Hľadám vývojárov na spoluprácu.",
    ninaAbout: "Som nová na Nostri, teším sa, že spoznám nových ľudí.",
    dm: "Ahoj! Teším sa na podujatie.",
    chatWelcome: "Vitajte všetci! Teším sa, že vás tu vidím.",
    chatReply: "Ďakujem za organizáciu, teším sa na to!",
    chatProof: /organizáci|teším sa/i,
    postTitle: "Vitajte na zraze",
    postBody: "Tešíme sa na všetkých — program a podrobnosti nájdete vnútri.",
    talkTitle: "Bleskovka: Nostr pre nováčikov",
  },
  cs: {
    eventSummary:
      "Uvolněný večer pro Nostr nadšence a zvědavé nováčky — krátká představení, dobré rozhovory a pár bleskových přednášek u vody.",
    eventLocation: "Bratislava",
    ninaIntro: "Rust vývojářka, pracuji na nástrojích pro soukromí. Hledám spoluzakladatele, kterému záleží na použitelnosti.",
    nadiaIntro: "Produktová designérka, která ráda dělá kryptografii srozumitelnou. Hledám vývojáře ke spolupráci.",
    ninaAbout: "Jsem nová na Nostru, těším se, že poznám nové lidi.",
    dm: "Ahoj! Těším se na akci.",
    chatWelcome: "Vítejte všichni! Těším se, že vás tu vidím.",
    chatReply: "Děkuji za organizaci, těším se na to!",
    chatProof: /organizac|těším se/i,
    postTitle: "Vítejte na srazu",
    postBody: "Těšíme se na všechny — program a podrobnosti uvnitř.",
    talkTitle: "Bleskovka: Nostr pro nováčky",
  },
}[LOCALE];

const shots = [];
const skipped = [];

function stemPath(dir, stem, theme) {
  return `${DOCS}/${dir}/${stem}-${theme}.png`;
}

/**
 * A durable-queue item that exhausts its retries surfaces as a red "N
 * couldn't be sent" pill (`.chip.failed`) in TopBar's OutboxIndicator —
 * global chrome rendered on every route, not scoped to any one page — and it
 * stays lit for the rest of the run once something fails: nothing clears a
 * `failed` item except an explicit user retry (a plain reload deliberately
 * skips terminal items — publish-queue.ts flushQueueCore, `if (item.failed)
 * continue`). That's how eight Slovak files ended up carrying "1 sa
 * nepodarilo odoslať" — some earlier publish under this multi-persona load
 * failed all its attempts and the banner rode along into every later shot.
 * Called from shoot() before every capture: if the pill is up, open it and
 * click Retry on each failed item against the (already healthy, still-
 * running) local relay rather than let it silently ship. Structural only —
 * outbox.retry's own button carries translated text (outbox.retry), so it's
 * targeted by position: the non-danger .btn.inline in each item's action
 * pair (discard is .btn.inline.ghost.danger).
 */
async function clearOutboxErrors(page) {
  const chip = page.locator(".chip.failed");
  if (!(await chip.count().catch(() => 0))) return;
  console.warn("  [outbox] red error pill present before a shot — retrying failed item(s)...");
  for (let i = 0; i < 6; i++) {
    if (!(await chip.count().catch(() => 0))) break;
    const expanded = await chip.first().getAttribute("aria-expanded").catch(() => null);
    if (expanded !== "true") await chip.first().click().catch(() => {});
    await page.waitForTimeout(300);
    const retryBtns = page.locator(".panel .acts button.inline:not(.danger)");
    const n = await retryBtns.count().catch(() => 0);
    for (let j = 0; j < n; j++) {
      await retryBtns.first().click().catch(() => {});
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(1500);
  }
  if (await chip.count().catch(() => 0)) {
    console.warn("  [outbox] FAILED to clear the red error pill after retries — this shot may still carry it.");
  } else {
    console.log("  [outbox] error pill cleared.");
  }
}

async function shoot(page, dir, stem, theme) {
  mkdirSync(`${DOCS}/${dir}`, { recursive: true });
  const path = stemPath(dir, stem, theme);
  await clearOutboxErrors(page);
  await page.waitForTimeout(350);
  await page.screenshot({ path });
  shots.push(`${dir}/${stem}-${theme}.png`);
  console.log(`  shot: ${dir}/${stem}-${theme}.png`);
}

function skip(label, reason) {
  skipped.push({ label, reason });
  console.warn(`  SKIP ${label}: ${reason}`);
}

/**
 * Delete any pre-existing file(s) for a stem BEFORE attempting a fresh
 * capture of it. Call this once, right as a stem's try{} begins — not on
 * failure. That ordering is what makes a failed/partial attempt this run
 * leave NO file rather than a stale one from some earlier run silently
 * standing in for it: a wrong screenshot ships straight into the guides and
 * nobody notices (that's how `18-mute-confirm-*` and `07-signin-options-dark`
 * ended up byte-identical to unrelated stems in the shipped docs — the run
 * that "produced" them actually skipped, and an old file from a previous,
 * differently-buggy version of this script sat there looking legitimate). A
 * missing file is visible in review; a plausible-but-wrong one isn't.
 * Deliberately NOT called for the `INCLUDE_FLAKY not set — deferred` skips:
 * those are a decision not to attempt a stem this run, not a failure, and
 * must not delete a good capture from a previous INCLUDE_FLAKY=1 run.
 */
function clearStem(dir, stem, themes = ["light", "dark"]) {
  for (const theme of themes) {
    const p = stemPath(dir, stem, theme);
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * End-of-run self-check (not a hypothesis — this is what the 2026-08 vision
 * audit actually used to catch the silent-substitution bug): hash every file
 * THIS RUN wrote and flag any two that are byte-identical. A light/dark pair
 * of the SAME stem being identical is always a bug — the two themes recolor
 * everything, so real content can never render pixel-for-pixel the same — and
 * is called out distinctly from an incidental cross-stem match (rarer, and
 * not automatically a bug: two genuinely-empty states could coincide).
 */
function checkDuplicateOutput() {
  const byHash = new Map();
  for (const rel of shots) {
    let hash;
    try {
      hash = createHash("sha256").update(readFileSync(`${DOCS}/${rel}`)).digest("hex");
    } catch {
      continue; // file reported shot but unreadable now — don't crash the report over it
    }
    const list = byHash.get(hash) ?? [];
    list.push(rel);
    byHash.set(hash, list);
  }
  const dupGroups = [...byHash.values()].filter((list) => list.length > 1);
  if (dupGroups.length === 0) {
    console.log(`\n[duplicate-check] OK — no two files this run are byte-identical.`);
    return;
  }
  console.log(`\n[duplicate-check] FAILURE — ${dupGroups.length} group(s) of byte-identical files this run:`);
  for (const group of dupGroups) {
    const stems = new Set(group.map((g) => g.replace(/-(light|dark)\.png$/, "")));
    const sameStemPair = stems.size === 1 && group.length === 2;
    const tag = sameStemPair ? "light/dark IDENTICAL (always a bug)" : "cross-stem match (verify by hand)";
    console.log(`  [${tag}] ${group.join("  ==  ")}`);
  }
}

/**
 * Theme via localStorage + reload — never a button click. The button's
 * accessible name ("Toggle theme") is itself translated per locale, which is
 * exactly what made every previous "dark" shot in sk/cs a copy of light: the
 * click silently matched zero elements and the function returned early.
 * A reload loses in-progress form input, so callers on a route with unsaved
 * text (theme editor, language picker open state) should only ever ask for
 * "light" and skip dark for that one stem.
 */
async function setTheme(page, mode) {
  await page.evaluate((m) => {
    try {
      localStorage.setItem("nostrautica:theme", m);
    } catch {
      /* private mode */
    }
  }, mode);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
}

/**
 * Theme flip WITHOUT a reload — for stems with unsaved, ephemeral component
 * state (a filled-in title, a picked talk-source tab, a pasted URL) that a
 * `page.reload()` would wipe, since none of that is route-derived or drafted
 * to storage. `data-theme` on <html> is the ONLY thing app.css keys its colors
 * off (packages/app/src/lib/stores/theme.svelte.ts) — the CSS custom
 * properties recompute the instant the attribute changes, no reload or even a
 * Svelte re-render required, so this is safe to use mid-form.
 */
async function setThemeNoReload(page, mode) {
  await page.evaluate((m) => {
    try {
      localStorage.setItem("nostrautica:theme", m);
    } catch {
      /* private mode */
    }
    document.documentElement.setAttribute("data-theme", m);
  }, mode);
  await page.waitForTimeout(200);
}

async function waitForWithReload(page, locator, timeout = 20000) {
  try {
    await locator.waitFor({ timeout });
  } catch {
    await page.reload();
    await locator.waitFor({ timeout });
  }
}

async function verifyLocale(page) {
  const proof = LOCALE_PROOF[LOCALE];
  const text = await page.locator("body").innerText();
  const ok = proof.some((p) => text.includes(p));
  if (!ok) {
    throw new Error(
      `Locale '${LOCALE}' NOT verified on landing page — expected one of ${JSON.stringify(proof)}, ` +
        `got: ${text.slice(0, 200).replace(/\n/g, " ")}`,
    );
  }
  console.log(`[locale] '${LOCALE}' verified on landing page`);
}

async function newUser(page, name) {
  await page.goto(`${BASE_URL}/#/login`);
  await page.waitForTimeout(800);
  const nameInput = page.locator("#nm");
  if (await nameInput.count()) await nameInput.fill(name);
  const createBtn = page.locator(".card").last().locator("button.primary");
  if (await createBtn.count()) await createBtn.click();
  await page.waitForTimeout(2000);
}

/** Submit a TEXT intro (fast, deterministic, no transcription needed). */
async function submitTextIntro(page, text) {
  // Tab order is [video, audio, text?] — text tab only renders when a
  // coordinator is attached (hasCoordinator). It's the LAST tab. The mode
  // switcher dropped the ARIA tabs widget for plain aria-pressed buttons
  // (audit §7.3.3, 2026-07-24) — `button[role="tab"]` no longer matches
  // anything, so scope by the labelled group instead (Record.svelte:729,
  // `role="group" aria-labelledby="mode-label"`), which is structural, not
  // translated text, so this holds across locales too.
  //
  // Record.svelte now resolves membership role BEFORE rendering the composer
  // at all (audit U5, 2026-07-24) — an extra relay round-trip that a flat
  // 400ms sleep doesn't reliably outlast under concurrent-context load, so
  // wait for the group itself (generously) rather than guess a fixed delay.
  const tabs = page.locator('[role="group"][aria-labelledby="mode-label"] button');
  await tabs.first().waitFor({ timeout: 15000 }).catch(() => {});
  const tabCount = await tabs.count();
  if (tabCount < 3) {
    skip("text-intro", `only ${tabCount} record mode buttons — no coordinator attached yet?`);
    return false;
  }
  await tabs.nth(tabCount - 1).click();
  await page.waitForTimeout(300);
  const textarea = page.locator("textarea").first();
  await textarea.fill(text);
  const ack = page.locator('input[type="checkbox"]');
  if (await ack.count()) await ack.first().check();
  const submitBtn = page.locator("button.primary").last();
  await submitBtn.click();
  await page.waitForTimeout(1500);
  return true;
}

/**
 * Structural mirror of the 09-record video-path selectors below (same DOM
 * shape in Record.svelte ~886-930, just the audio branch of the same {#if
 * mode === "audio"} conditionals) — this used to select by the buttons'
 * accessible NAME ("enable microphone" / "record" / "stop" / "use this"),
 * which is translated per locale (record.audio.enableMic /
 * record.audio.record / record.stop / record.useThis in messages.ts) and
 * matched nothing in sk/cs, so the whole function silently no-opped there
 * (logged "SKIP audio-intro: no record button found") and the sk/cs
 * 21-transcript / 23-my-profile-edited stems never captured at all — the
 * files sitting in docs/images for those locales were stale English
 * captures. None of the selectors below depend on translated text:
 *  - enableMic renders as a plain, unclassed "btn" (no .inline/.primary/
 *    .danger) — same shape as enableCamera's button, and it's simply absent
 *    once a stream is already granted.
 *  - the Record button is the only button.primary without aria-pressed (the
 *    mode-toggle buttons reuse .primary for their pressed state, but do
 *    carry aria-pressed).
 *  - Stop is the only button.danger while recording.
 *  - "Use this" is the only button.primary once `recorded` is set — the
 *    Record button from the branch above no longer exists in that mutually
 *    exclusive template branch.
 */
async function recordAudioIntro(page) {
  const tabs = page.locator('[role="group"][aria-labelledby="mode-label"] button');
  await tabs.first().waitFor({ timeout: 15000 }).catch(() => {});
  if ((await tabs.count()) < 2) {
    skip("audio-intro", "audio mode button not found");
    return false;
  }
  await tabs.nth(1).click(); // [video, audio, text] — audio is index 1
  await page.waitForTimeout(300);
  const enableMic = page.locator(".btn:not(.inline):not(.primary):not(.danger)").first();
  if (await enableMic.count()) {
    await enableMic.click();
    await page.waitForTimeout(500);
  }
  const ack = page.locator('input[type="checkbox"]');
  if (await ack.count()) await ack.first().check();
  const recordBtn = page.locator("button.primary:not([aria-pressed])").first();
  if (!(await recordBtn.count())) {
    skip("audio-intro", "no record button found");
    return false;
  }
  await recordBtn.click();
  await page.waitForTimeout(2500); // let MediaRecorder collect a couple chunks
  const stopBtn = page.locator("button.danger").first();
  if (await stopBtn.count()) await stopBtn.first().click();
  await page.waitForTimeout(500);
  const useBtn = page.locator("button.primary:not([aria-pressed])").first();
  if (await useBtn.count()) {
    await useBtn.first().click();
    await page.waitForTimeout(2000);
  }
  return true;
}

async function waitForCoordinatorJobs(ms) {
  console.log(`  waiting ${ms}ms for the coordinator job queue to drain...`);
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Reload `page` and check `check()` every `stepMs` until it returns truthy or
 * `maxMs` elapses. The mock coordinator has an occasional stall (its relay
 * subscription can go quiet for minutes with no error), so a single
 * sleep-then-check is a coin flip on whether the wait was long enough — this
 * polls the ACTUAL UI state instead of guessing a fixed delay, and gives up
 * loudly (returns false) rather than hanging forever if it really did stall.
 */
async function pollReload(page, check, { maxMs = 40000, stepMs = 4000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await check().catch(() => false)) return true;
    await page.waitForTimeout(stepMs);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  }
  return check().catch(() => false);
}

/**
 * Mirror a just-captured DOCS screenshot into web/assets/screenshots too, for
 * the handful of stems the landing page also embeds. Takes ONE stem identity
 * — not two independent path strings — so src and dest are always the exact
 * same basename by construction: there is no way to call this with one
 * stem's bytes landing under a DIFFERENT stem's name in web/, which is
 * exactly the silent-substitution failure mode this file needs to never
 * reproduce (see clearStem's comment). If the source wasn't captured this
 * run (or ever), this silently no-ops — it mirrors, it never substitutes.
 */
function mirrorToWeb(dir, stem, theme) {
  const name = `${stem}-${theme}.png`;
  const src = `${DOCS}/${dir}/${name}`;
  const dest = `${WEB}/${name}`;
  try {
    if (existsSync(src)) copyFileSync(src, dest);
  } catch {
    /* best-effort mirror into web/assets/screenshots */
  }
}

async function main() {
  mkdirSync(`${DOCS}/${orgDir}`, { recursive: true });
  mkdirSync(`${DOCS}/${partDir}`, { recursive: true });
  mkdirSync(`${DOCS}/${appDir}`, { recursive: true });

  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const mobile = {
    viewport: { width: 390, height: 844 },
    permissions: ["camera", "microphone"],
    ignoreHTTPSErrors: true,
    baseURL: BASE_URL,
    locale: LOCALE === "sk" ? "sk-SK" : LOCALE === "cs" ? "cs-CZ" : "en-US",
  };

  const olgaCtx = await browser.newContext(mobile);
  const ninaCtx = await browser.newContext(mobile);
  const nadiaCtx = await browser.newContext(mobile);
  const ottoCtx = await browser.newContext(mobile);
  for (const ctx of [olgaCtx, ninaCtx, nadiaCtx, ottoCtx]) {
    await ctx.addInitScript((lang) => {
      try {
        localStorage.setItem("nostrautica:lang", lang);
      } catch {
        /* private mode */
      }
    }, LOCALE);
  }

  const olga = await olgaCtx.newPage();
  const nina = await ninaCtx.newPage();
  const nadia = await nadiaCtx.newPage();
  const otto = await ottoCtx.newPage();

  // ---- participant/01-home + locale verification ----
  await olga.goto("/#/");
  await olga.waitForTimeout(900);
  await verifyLocale(olga);
  await shoot(olga, partDir, "01-home", "light");
  await setTheme(olga, "dark");
  await shoot(olga, partDir, "01-home", "dark");
  await setTheme(olga, "light");

  // ---- app/settings ----
  await olga.goto("/#/settings");
  await olga.waitForTimeout(500);
  await shoot(olga, appDir, "settings", "light");
  await setTheme(olga, "dark");
  await shoot(olga, appDir, "settings", "dark");
  await setTheme(olga, "light");

  // ---- Olga creates identity ----
  await newUser(olga, "Olga Organizer");

  // ---- organizer/10-language-picker: open the combobox on Create BEFORE filling anything ----
  await olga.goto("/#/create");
  await olga.waitForTimeout(600);
  try {
    clearStem(orgDir, "10-language-picker");
    const langTrigger = olga.locator("#lang");
    await langTrigger.click({ timeout: 5000 });
    await olga.waitForTimeout(300);
    await shoot(olga, orgDir, "10-language-picker", "light");
    await setThemeNoReload(olga, "dark");
    await shoot(olga, orgDir, "10-language-picker", "dark");
    await setThemeNoReload(olga, "light");
    await olga.keyboard.press("Escape");
  } catch (e) {
    skip("10-language-picker", String(e).slice(0, 150));
  }

  // ---- organizer/01-create-form + create the event ----
  // The docs' running example: "Nostrautica meetup", an evening on 1 Aug 2026.
  // Fill summary/end/location too so the event pages and the post-event report
  // render with a real description, date range and place (not just a bare title).
  await olga.locator("#t").fill("Nostrautica meetup");
  const summaryField = olga.locator("#s");
  if (await summaryField.count()) await summaryField.fill(COPY.eventSummary);
  await olga.locator("#st").fill("2026-08-01T18:00");
  const endField = olga.locator("#en");
  if (await endField.count()) await endField.fill("2026-08-01T22:00");
  const locField = olga.locator("#loc");
  if (await locField.count()) await locField.fill(COPY.eventLocation);
  const talksSelect = olga.locator("#talks");
  if (await talksSelect.count()) await talksSelect.selectOption("on");
  // Group chat defaults OFF (chatEnabled = $state(false) in Create.svelte) —
  // toggle it on now so the created event carries chat:["marmot"] from the
  // start. ToggleSwitch's real <input> is visually hidden (clip-path) behind a
  // styled track span, wrapped in a <label> — click the LABEL (native
  // label-for-control association), not the hidden input, which Playwright's
  // actionability check correctly refuses to click directly. talks=on above
  // means the conditional maxTalkUnlimited toggle also renders, so chatEnabled
  // is reliably the LAST toggle on the page, not the first.
  const chatToggle = olga.locator("label.toggle").last();
  if (await chatToggle.count()) await chatToggle.click();
  await olga.waitForTimeout(300);
  await shoot(olga, orgDir, "01-create-form", "light");
  await setThemeNoReload(olga, "dark");
  await shoot(olga, orgDir, "01-create-form", "dark");
  await setThemeNoReload(olga, "light");

  // ---- organizer/01b-create-coordinator: the discovery picker now available
  //      directly on the create form (CoordinatorPicker.svelte) ----
  try {
    clearStem(orgDir, "01b-create-coordinator");
    const createCoordCards = olga.locator(".coord-card");
    await createCoordCards.first().waitFor({ timeout: 10000 });
    await createCoordCards.first().scrollIntoViewIfNeeded();
    await olga.waitForTimeout(300);
    await shoot(olga, orgDir, "01b-create-coordinator", "light");
    await setThemeNoReload(olga, "dark");
    await shoot(olga, orgDir, "01b-create-coordinator", "dark");
    await setThemeNoReload(olga, "light");
  } catch (e) {
    skip("01b-create-coordinator", String(e).slice(0, 150));
  }

  // NOT .card.last() — CoordinatorPicker's discovered coord-cards are NESTED
  // .card elements inside the form's outer card and each has its own
  // button.primary ("attach this"), so .card.last() now resolves to a
  // coordinator's card, not the form's wrapping card. The actual submit
  // button is the LAST button.primary on the page regardless of how many
  // coordinators are discovered.
  const createBtn = olga.locator("button.primary").last();
  await createBtn.scrollIntoViewIfNeeded();
  await createBtn.click();
  // NOT a bare .mono wait — CoordinatorPicker's discovered coord-cards each
  // show their npub in a `.mono` element too, already on the page BEFORE
  // submit resolves, so that wait returned instantly against the WRONG
  // element and the "02-created" shot below caught the form mid-submit
  // ("Creating…") instead of the actual share-link screen. `{#if created}`
  // swaps the whole template, so the pre-creation form's #t title input
  // reliably disappears the moment the real created state lands — wait for
  // ITS absence first, THEN it's safe to look for .mono (the share link).
  await olga.locator("#t").waitFor({ state: "detached", timeout: 60000 });
  await olga.locator(".mono").first().waitFor({ timeout: 10000 });
  await olga.waitForTimeout(500);
  // Ephemeral, client-side-only state (no route param) — a page.reload() (setTheme)
  // would lose it entirely, but setThemeNoReload flips data-theme in place, so
  // dark is safe here too. Grab the naddr BEFORE doing anything else with this page.
  await shoot(olga, orgDir, "02-created", "light");
  await setThemeNoReload(olga, "dark");
  await shoot(olga, orgDir, "02-created", "dark");
  await setThemeNoReload(olga, "light");
  const shareLink = await olga.locator(".mono").first().innerText();
  const naddr = shareLink.match(/#\/e\/([^/\s]+)/)?.[1];
  if (!naddr) throw new Error("no naddr captured");
  console.log("naddr:", naddr);

  // ---- organizer/03-admin-empty ----
  await olga.goto(`/#/e/${naddr}/admin`);
  await olga.waitForTimeout(1500);
  await shoot(olga, orgDir, "03-admin-empty", "light");
  mirrorToWeb(orgDir, "03-admin-empty", "light");
  await setThemeNoReload(olga, "dark");
  await shoot(olga, orgDir, "03-admin-empty", "dark");
  await setThemeNoReload(olga, "light");

  // Coordinator attach/discovery, theme CSS, and the chat toggle now live on
  // the Event settings page (#/e/<naddr>/settings), split out of Admin.
  await olga.goto(`/#/e/${naddr}/settings`);

  // ---- organizer/05a-coordinator-picker + 05-coordinator: attach the mock coordinator ----
  try {
    clearStem(orgDir, "05a-coordinator-picker");
    clearStem(orgDir, "05-coordinator");
    await olga.waitForTimeout(1500); // discovery fetch (streamEvents, up to 8s)
    const coordCards = olga.locator(".coord-card");
    await coordCards.first().waitFor({ timeout: 10000 });
    // The picker sits BELOW the metadata/page/theme cards on this page, so
    // without an explicit scroll the shot just showed whatever was already in
    // the viewport — the generic Event Settings (Title/Summary/Start/End)
    // form at the top, not a coordinator picker at all.
    await coordCards.first().scrollIntoViewIfNeeded();
    await olga.waitForTimeout(200);
    await shoot(olga, orgDir, "05a-coordinator-picker", "light");
    // setThemeNoReload, not setTheme: a real reload here re-runs coordinator
    // discovery from scratch (a relay round-trip), and the fixed 400ms after
    // reload wasn't remotely enough to outlast it — the dark shot landed on
    // "Loading…" every time (confirmed on both -dark stems below). Flipping
    // data-theme in place needs no refetch, so there's nothing to race.
    await setThemeNoReload(olga, "dark");
    await shoot(olga, orgDir, "05a-coordinator-picker", "dark");
    await setThemeNoReload(olga, "light");
    const attachBtn = olga.locator(".coord-card button.primary").first();
    await attachBtn.click();
    // Poll for attaching=false (button re-enabled, or the coord-card list is
    // gone entirely once attached) instead of matching its translated label
    // ("Attaching…" is English-only) or guessing a fixed delay.
    for (let i = 0; i < 30; i++) {
      const stillDisabled = await attachBtn.isDisabled().catch(() => false);
      if (!stillDisabled) break;
      await olga.waitForTimeout(1000);
    }
    await olga.waitForTimeout(400);
    await shoot(olga, orgDir, "05-coordinator", "light");
    await setThemeNoReload(olga, "dark");
    await shoot(olga, orgDir, "05-coordinator", "dark");
    await setThemeNoReload(olga, "light");
  } catch (e) {
    skip("05-coordinator / 05a-coordinator-picker", String(e).slice(0, 150));
  }

  // ---- organizer/10-theme-editor ----
  try {
    clearStem(orgDir, "10-theme-editor");
    const themeCard = olga.locator(".card").filter({ has: olga.locator("textarea.mono") });
    await themeCard.scrollIntoViewIfNeeded();
    await olga.locator("textarea.mono").fill(":root { --accent: #7c5cff; }");
    await olga.waitForTimeout(300);
    await shoot(olga, orgDir, "10-theme-editor", "light");
    await setThemeNoReload(olga, "dark");
    await shoot(olga, orgDir, "10-theme-editor", "dark");
    await setThemeNoReload(olga, "light");
  } catch (e) {
    skip("10-theme-editor", String(e).slice(0, 150));
  }

  // ---- organizer/11-chat-toggle (chat=marmot was set at creation, so this is
  //      the already-on persisted state — reload-safe) ----
  try {
    clearStem(orgDir, "11-chat-toggle");
    await olga.goto(`/#/e/${naddr}/settings`);
    // ToggleSwitch renders <label class="toggle"> and it's the ONLY toggle on
    // this page — a stable structural handle regardless of how many buttons
    // the coordinator lifecycle view above it renders. The previous
    // `button, [role=switch]` guess had two problems: ToggleSwitch has no
    // role=switch (it's a real <input type=checkbox>, just visually hidden —
    // see the component), so that half never matched anything; and the LAST
    // <button> on this page is actually the co-organizer "Add" button further
    // down, not anything near chat — the shot landed on whatever card
    // happened to be scrolled into view already (the Appearance/CSS editor
    // from the previous step, on a page that hadn't even finished reloading).
    const chatCard = olga.locator(".card").filter({ has: olga.locator("label.toggle") });
    await chatCard.first().waitFor({ timeout: 20000 });
    await chatCard.first().scrollIntoViewIfNeeded();
    await olga.waitForTimeout(300);
    await shoot(olga, orgDir, "11-chat-toggle", "light");
    await setThemeNoReload(olga, "dark");
    await shoot(olga, orgDir, "11-chat-toggle", "dark");
    await setThemeNoReload(olga, "light");
  } catch (e) {
    skip("11-chat-toggle", String(e).slice(0, 150));
  }

  // ---- organizer/04-invites ----
  await olga.goto(`/#/e/${naddr}/admin`);
  await olga.waitForTimeout(1000);
  // "Generate" text is translated — scope structurally instead: the invite
  // count <input type=number> and the generate button share one .row. The
  // Administration page now has more above-the-fold content (AdminTabs +
  // coordinator/billing status) since the settings split, so give it a
  // couple of retries rather than a single impatient check.
  const generateBtn = olga.locator('.row:has(input[type="number"]) button');
  for (let i = 0; i < 5 && (await generateBtn.count()) === 0; i++) await olga.waitForTimeout(600);
  if (await generateBtn.count()) {
    clearStem(orgDir, "04-invites");
    await generateBtn.first().click();
    // The generated codes (each with its own QR + link) render at the BOTTOM
    // of this card — below the shared-code <details>, the used-count line and
    // the exports toggle — well past the fold. Without scrolling to them the
    // shot just showed the Generate row still in view: a button and an empty
    // count field, no codes and no QR, i.e. not what "04-invites" promises.
    // QrCode renders the per-invite codes at a fixed width=140 (the SEPARATE
    // shared-code QR below uses width=512), which makes it a precise,
    // structural way to find and wait for THIS list specifically.
    const inviteQr = olga.locator('img[width="140"]').first();
    await inviteQr.waitFor({ timeout: 10000 });
    await inviteQr.scrollIntoViewIfNeeded();
    await olga.waitForTimeout(300);
    await shoot(olga, orgDir, "04-invites", "light");
    await setThemeNoReload(olga, "dark");
    await shoot(olga, orgDir, "04-invites", "dark");
    await setThemeNoReload(olga, "light");
  } else {
    skip("04-invites", "generate button not found");
  }

  // ---- organizer/04b-shared-code: the reusable "one QR for the room" code
  // (Admin.svelte ~1250), separate from the per-person batch above — this is
  // the one an organizer projects on an opening slide rather than mails out.
  // It sits in a <details> that starts collapsed, so open it before shooting;
  // the <summary> text is translated (admin.invites.shared.title) so this is
  // the only <details> on the Admin page, checked structurally, never by text.
  // People-count and hours fields default non-empty (100 / 4) but are refilled
  // here with deliberate demo values rather than relying on that default.
  try {
    clearStem(orgDir, "04b-shared-code");
    const sharedDetails = olga.locator("details");
    await sharedDetails.waitFor({ timeout: 10000 });
    await sharedDetails.locator("summary").click();
    await olga.waitForTimeout(200);
    const sharedInputs = sharedDetails.locator('input[type="number"]');
    await sharedInputs.first().fill("40");
    await sharedInputs.nth(1).fill("6");
    // The only button.btn.inline inside <details> before a code exists — the
    // "copy link" button (also .btn.inline) only renders once sharedInvite is set.
    await sharedDetails.locator("button.btn.inline").first().click();
    // QrCode.svelte renders its <img> only once QRCode.toDataURL resolves
    // (async) — wait for the real element rather than guess a fixed delay, so
    // this never captures the "Generating QR…" placeholder text.
    await sharedDetails.locator("img").waitFor({ timeout: 10000 });
    await sharedDetails.scrollIntoViewIfNeeded();
    await olga.waitForTimeout(300);
    await shoot(olga, orgDir, "04b-shared-code", "light");
    await setThemeNoReload(olga, "dark");
    await shoot(olga, orgDir, "04b-shared-code", "dark");
    await setThemeNoReload(olga, "light");
    // Collapse again before moving on. This route (#/e/<naddr>/admin) is
    // revisited a few steps later for 06-pending WITHOUT an intervening
    // navigation elsewhere, so an expanded <details> and a scrolled-down
    // viewport left here silently became 06-pending's starting state — that
    // stem showed this shared-code QR screen instead of join requests. Each
    // stem below now also asserts its own scroll target rather than trust
    // this alone, but establishing a clean state here is the actual fix.
    await sharedDetails.locator("summary").click();
  } catch (e) {
    skip("04b-shared-code", String(e).slice(0, 150));
  }

  // ---- Nina joins without a code: participant/02-event-page + 02-event-overview (same screen, both stem names) ----
  await nina.goto(`/#/e/${naddr}`);
  await nina.waitForTimeout(800);
  for (const stem of ["02-event-page", "02-event-overview"]) {
    await shoot(nina, partDir, stem, "light");
  }
  mirrorToWeb(partDir, "02-event-page", "light");
  await setTheme(nina, "dark");
  for (const stem of ["02-event-page", "02-event-overview"]) {
    await shoot(nina, partDir, stem, "dark");
  }
  mirrorToWeb(partDir, "02-event-page", "dark");
  await setTheme(nina, "light");

  await nina.goto(`/#/e/${naddr}/join`);
  await nina.waitForTimeout(500);
  const ninaNameField = nina.locator("#n");
  if (await ninaNameField.count()) await ninaNameField.fill("Nina Newcomer");
  const aboutField = nina.locator("#a");
  if (await aboutField.count()) await aboutField.fill(COPY.ninaAbout);
  await nina.waitForTimeout(300);
  await shoot(nina, partDir, "04-join-form", "light");
  await setThemeNoReload(nina, "dark");
  await shoot(nina, partDir, "04-join-form", "dark");
  await setThemeNoReload(nina, "light");

  const joinBtn = nina.locator(".card").last().locator("button.primary");
  if (await joinBtn.count()) await joinBtn.click();
  // NOT waitForURL: submitting a join request never changes the URL at all —
  // Join.svelte swaps `sent` in as local component state on the SAME route
  // (see submit() in Join.svelte) — so "**" matched the current URL
  // instantly and the fixed 500ms that followed was nowhere near enough for
  // submit() to actually finish (profile publish + relay-list + a real
  // sendJoinRequest publish, all genuine relay round trips). The shot fired
  // on the still-pristine, blank join form instead of the waiting state.
  // #sk (the skills field) exists ONLY in that pristine form and is gone the
  // instant `sent` flips true — wait for it to detach rather than guess.
  clearStem(partDir, "05-request-sent");
  await nina.locator("#sk").waitFor({ state: "detached", timeout: 20000 }).catch(() => {});
  await nina.waitForTimeout(500);
  await shoot(nina, partDir, "05-request-sent", "light");
  await setThemeNoReload(nina, "dark");
  await shoot(nina, partDir, "05-request-sent", "dark");
  await setThemeNoReload(nina, "light");

  await nina.goto("/#/me");
  await nina.waitForTimeout(500);
  await shoot(nina, partDir, "03-backup", "light");
  await setThemeNoReload(nina, "dark");
  await shoot(nina, partDir, "03-backup", "dark");
  await setThemeNoReload(nina, "light");

  // ---- organizer: pending + approve ----
  // Scoped to the join-requests section specifically (CSS general-sibling
  // combinator: the h2#join-requests heading and the .stack of request cards
  // are siblings). The admin page now has MANY .btn.primary buttons elsewhere
  // (theme publish, coordinator attach, ...) — a page-wide `buttons.first()`
  // is a coin flip about which one it actually hits once those sections exist.
  const approveScope = () => olga.locator("#join-requests ~ .stack .card button.primary");
  await olga.goto(`/#/e/${naddr}/admin`);
  await approveScope().first().waitFor({ timeout: 20000 }).catch(() => {});
  // Explicitly establish THIS stem's own state rather than trust whatever
  // scroll position the previous step left behind — this route
  // (#/e/<naddr>/admin) was already visited for 04-invites/04b-shared-code a
  // few steps back with no full navigation away in between, and that shared-
  // code <details> now collapses itself, but scrolling here too means this
  // shot is correct even if a future step in between forgets to.
  await approveScope().first().scrollIntoViewIfNeeded().catch(() => {});
  await olga.waitForTimeout(500);
  await shoot(olga, orgDir, "06-pending", "light");
  await setThemeNoReload(olga, "dark");
  await shoot(olga, orgDir, "06-pending", "dark");
  await setThemeNoReload(olga, "light");

  const approveBtn = approveScope().first();
  if (await approveBtn.count()) await approveBtn.click();
  await olga.waitForTimeout(1500);
  await shoot(olga, orgDir, "07-approved", "light");
  // setThemeNoReload: a real reload re-fetches the roster/request list from
  // relays, and the fixed 400ms after reload wasn't enough — the dark shot
  // landed on a loading placeholder instead of the approved state.
  await setThemeNoReload(olga, "dark");
  await shoot(olga, orgDir, "07-approved", "dark");
  await setThemeNoReload(olga, "light");

  // ---- Nadia (second attendee) ----
  // ---- participant/07-signin-options: the sign-in method picker (extension /
  // key / phone signer) — this MUST be captured before Nadia has ANY session,
  // since SignInOptions only renders once "I'm already on Nostr" is tapped
  // while logged out (Join.svelte, the `{#if !session.loggedIn}` branch). The
  // previous version called newUser() first, which silently logs Nadia in
  // locally, so by the time this ran session.loggedIn was already true and
  // the picker branch never rendered at all — the shot fell through to the
  // ordinary logged-in join form instead, which is exactly what made it
  // byte-identical to 04b-join-form-signedin below (same form, same untouched
  // fields, same theme — there was nothing left to tell the two apart).
  await nadia.goto(`/#/e/${naddr}/join`);
  await nadia.waitForTimeout(500);
  try {
    clearStem(partDir, "07-signin-options");
    // The button's accessible name is icon + translated text — click by
    // position instead: it's the first button.primary on the page while
    // logged out (the only other one, the form's own submit button, doesn't
    // exist until further down and isn't in play yet).
    await nadia.locator("button.primary").first().click();
    // SignInOptions' paste-key field is the only input[inputmode="url"] on
    // the page — a stable structural marker that the picker actually
    // rendered (the nostrconnect QR is async, so don't gate on that instead).
    await nadia.locator('input[inputmode="url"]').waitFor({ timeout: 10000 });
    await nadia.waitForTimeout(300);
    await shoot(nadia, partDir, "07-signin-options", "light");
    await setThemeNoReload(nadia, "dark");
    await shoot(nadia, partDir, "07-signin-options", "dark");
    await setThemeNoReload(nadia, "light");
  } catch (e) {
    skip("07-signin-options", String(e).slice(0, 150));
  }

  // Nadia's identity is created only NOW, after the logged-out capture above.
  await newUser(nadia, "Nadia Nostrnative");
  await nadia.goto(`/#/e/${naddr}/join`);
  await nadia.waitForTimeout(500);

  // ---- participant/04b-join-form-signedin: an EXISTING Nostr user (Nadia,
  // signed in via the same newUser() session created above — reused rather
  // than a fresh persona) whose kind-0 carries no bio. Join.svelte only
  // renders the event-local "About you" textarea (#ea, join.aboutEvent) when
  // hasPublicAbout is false (profile-load.ts) — Nadia's kind-0 has a name (so
  // profileState resolves "loaded", not "empty") but newUser() never sets an
  // about, so hasPublicAbout is false and the textarea appears. Genuinely
  // different from 04-join-form above, which is the never-signed-in branch of
  // this same page.
  try {
    clearStem(partDir, "04b-join-form-signedin");
    const aboutField = nadia.locator("#ea");
    await waitForWithReload(nadia, aboutField, 20000);
    await aboutField.scrollIntoViewIfNeeded();
    await nadia.waitForTimeout(300);
    await shoot(nadia, partDir, "04b-join-form-signedin", "light");
    await setThemeNoReload(nadia, "dark");
    await shoot(nadia, partDir, "04b-join-form-signedin", "dark");
    await setThemeNoReload(nadia, "light");
  } catch (e) {
    skip(
      "04b-join-form-signedin",
      `no #ea about textarea appeared — ${String(e).slice(0, 100)}`,
    );
  }

  const nadiaJoinBtn = nadia.locator(".card").last().locator("button.primary");
  if (await nadiaJoinBtn.count()) await nadiaJoinBtn.click();
  await nadia.waitForTimeout(1000);

  await olga.goto(`/#/e/${naddr}/admin`);
  await approveScope().first().waitFor({ timeout: 20000 }).catch(() => {});
  await olga.waitForTimeout(500);
  const nadiaApproveBtn = approveScope().first();
  if (await nadiaApproveBtn.count()) {
    await nadiaApproveBtn.click();
    await olga.waitForTimeout(1500);
    console.log("Nadia approved");
  } else {
    console.warn("[warn] no pending approve button found for Nadia");
  }

  // ---- Nina: approved state ----
  await nina.goto(`/#/e/${naddr}`);
  await nina.locator("main").locator("text=/.+/").first().waitFor({ timeout: 20000 }).catch(() => {});
  await nina.waitForTimeout(500);
  await shoot(nina, partDir, "06-approved", "light");
  // setThemeNoReload: this screen carries a one-shot "just approved" toast and
  // an onboarding checklist that fills in as background checks resolve — both
  // are moving targets. A real reload re-ran the whole page from scratch, so
  // the dark shot caught a LATER, different moment (toast gone, more checklist
  // items done) instead of the same moment as light re-themed. Flipping
  // data-theme in place is instantaneous, so there's no gap for it to drift in.
  await setThemeNoReload(nina, "dark");
  await shoot(nina, partDir, "06-approved", "dark");
  await setThemeNoReload(nina, "light");

  // ---- participant/31-offline-card: the offline-pack card (EventHome.svelte
  // ~782), default not-yet-downloaded state. Gated on effApproved, so it only
  // ever renders once Nina is approved, which she is right here on the same
  // Overview route as 06-approved above. Structural class selector
  // (.card.offline), never the translated button label — and deliberately
  // never clicked: downloading would flip it into "downloading…"/"ready" with
  // no way back to this default state short of a fresh context.
  try {
    clearStem(partDir, "31-offline-card");
    const offlineCard = nina.locator(".card.offline");
    await offlineCard.waitFor({ timeout: 10000 });
    await offlineCard.scrollIntoViewIfNeeded();
    await nina.waitForTimeout(300);
    await shoot(nina, partDir, "31-offline-card", "light");
    await setThemeNoReload(nina, "dark");
    await shoot(nina, partDir, "31-offline-card", "dark");
    await setThemeNoReload(nina, "light");
  } catch (e) {
    skip("31-offline-card", String(e).slice(0, 150));
  }

  // ---- participant/08-attendees ----
  await nina.goto(`/#/e/${naddr}/attendees`);
  await nina.waitForTimeout(1500);
  await shoot(nina, partDir, "08-attendees", "light");
  mirrorToWeb(partDir, "08-attendees", "light");
  // setThemeNoReload, not setTheme: this roster reflects Nina's own live
  // approval/role state, which keeps resolving in the background right
  // around here (pending → approved, bottom-nav item count changing) — a
  // real reload re-fetched it and landed the dark shot at a LATER point in
  // that same flow than light (pending+3 nav items vs. approved+6). Flipping
  // data-theme in place needs no refetch, so both shots land on one moment.
  await setThemeNoReload(nina, "dark");
  await shoot(nina, partDir, "08-attendees", "dark");
  mirrorToWeb(partDir, "08-attendees", "dark");
  await setThemeNoReload(nina, "light");

  // ---- participant/10-attendee-detail: the guides reference this stem
  // (E2E-TESTING-GUIDE.md) but no step in this generator ever produced it —
  // the files sitting in docs/images were stale, non-refreshed captures
  // (hence light/dark being byte-identical: nothing here ever re-shot them).
  // button.open is PersonCard's own click target (packages/app/src/lib/
  // components/PersonCard.svelte) — the same structural hook 21-transcript
  // already uses for the roster — never translated text.
  try {
    clearStem(partDir, "10-attendee-detail");
    const openBtn = nina.locator(".roster button.open").first();
    await openBtn.waitFor({ timeout: 10000 });
    await openBtn.click();
    // Attendee.svelte renders a skeleton (.sk-avatar/.sk-line, no h1) while
    // loading — wait for the real h1 so this never captures the placeholder.
    await nina.locator(".card h1").first().waitFor({ timeout: 15000 });
    await nina.waitForTimeout(400);
    await shoot(nina, partDir, "10-attendee-detail", "light");
    await setThemeNoReload(nina, "dark");
    await shoot(nina, partDir, "10-attendee-detail", "dark");
    await setThemeNoReload(nina, "light");
    await nina.goBack();
    await nina.waitForTimeout(500);
  } catch (e) {
    skip("10-attendee-detail", String(e).slice(0, 150));
  }

  // ---- participant/09-record (item 5, optional): mid-recording UI. All
  // structural selectors (class/attribute, never translated button text) so
  // this actually works across locales — the sk/cs guides previously pointed
  // at a byte-identical COPY of the English screenshot for this stem, which is
  // exactly the locale-mismatch bug this generator exists to avoid. Discards
  // the take (re-record) rather than submitting, so it doesn't collide with
  // Nina's text intro submitted later in the INCLUDE_FLAKY pass.
  try {
    clearStem(partDir, "09-record");
    await nina.goto(`/#/e/${naddr}/record`);
    // enableCamera's button is plain "btn" (not "btn inline", not "btn primary")
    // — the mode-switcher and reuse-gallery buttons are ".btn.inline", so this
    // class combination is unambiguous. Fake camera/mic (E2E-TESTING-GUIDE §1.3)
    // means clicking it never hits an OS permission prompt.
    const enableCamBtn = nina.locator(".btn:not(.inline):not(.primary):not(.danger)").first();
    await enableCamBtn.waitFor({ timeout: 15000 });
    await enableCamBtn.click();
    await nina.waitForTimeout(600);
    // The Record button has no aria-pressed (unlike the mode-toggle buttons,
    // which reuse .primary for their active state) — this is the only
    // button.primary on the page that isn't a toggle.
    const recordBtn = nina.locator("button.primary:not([aria-pressed])").first();
    await recordBtn.waitFor({ timeout: 5000 });
    await recordBtn.click();
    await nina.waitForTimeout(1200); // a moment into the recording, not the first frame
    await shoot(nina, partDir, "09-record", "light");
    await setThemeNoReload(nina, "dark");
    await shoot(nina, partDir, "09-record", "dark");
    await setThemeNoReload(nina, "light");
    const stopBtn = nina.locator("button.danger").first();
    if (await stopBtn.count()) await stopBtn.click();
    await nina.waitForTimeout(500);
    // Discard: click "re-record" (plain .btn, not .primary) rather than "use
    // this" — this capture is a UI screenshot, not a real intro submission.
    const reRecordBtn = nina.locator(".card button.btn:not(.inline):not(.primary)").first();
    if (await reRecordBtn.count()) await reRecordBtn.click().catch(() => {});
  } catch (e) {
    skip("09-record", String(e).slice(0, 150));
  }

  // ---- Seed report data (item 1): Nina marks two attendees "want to meet" so
  // the post-event report below isn't empty. Each row's action pair is
  // [want-to-meet star, message] (Attendees.svelte:323, toggleWantToMeet), icon
  // buttons only, so the stars sit at even indices (0, 2, …) — no translated
  // text involved, safe across locales. Olga + Nadia are both approved and
  // visible in Nina's roster by this point, so this is exactly "~2 attendees".
  try {
    await nina.goto(`/#/e/${naddr}/attendees`);
    await nina.waitForTimeout(1200);
    await pollReload(nina, async () => (await nina.locator("button.icon-btn").count()) > 0, {
      maxMs: 30000,
      stepMs: 3000,
    });
    const iconBtns = nina.locator("button.icon-btn");
    const total = await iconBtns.count();
    let starred = 0;
    for (let i = 0; i < total && starred < 2; i += 2) {
      await iconBtns.nth(i).click();
      await nina.waitForTimeout(300);
      starred++;
    }
    if (starred === 0) skip("34-report seed", "no attendee rows with a want-to-meet star found");
  } catch (e) {
    skip("34-report seed", String(e).slice(0, 150));
  }

  // ---- participant/34-report (redesigned hero + avatar list) ----
  try {
    clearStem(partDir, "34-report");
    await nina.goto(`/#/e/${naddr}/report`);
    await nina.waitForTimeout(1200);
    await pollReload(nina, async () => (await nina.locator(".report .person").count()) > 0, {
      maxMs: 30000,
      stepMs: 3000,
    });
    await nina.waitForTimeout(400);
    await shoot(nina, partDir, "34-report", "light");
    await setTheme(nina, "dark");
    await shoot(nina, partDir, "34-report", "dark");
    await setTheme(nina, "light");
  } catch (e) {
    skip("34-report", String(e).slice(0, 150));
  }

  // ---- Text + audio intros: only useful as setup for the flaky coordinator
  //      stems (matches/my-profile-edited/transcript) — skip entirely otherwise. ----
  let transcriptOk = false;
  if (INCLUDE_FLAKY) {
    await nina.goto(`/#/e/${naddr}/record`);
    const ninaIntroOk = await submitTextIntro(nina, COPY.ninaIntro);
    await nadia.goto(`/#/e/${naddr}/record`);
    const nadiaIntroOk = await submitTextIntro(nadia, COPY.nadiaIntro);
    try {
      await olga.goto(`/#/e/${naddr}/record`);
      transcriptOk = await recordAudioIntro(olga);
    } catch (e) {
      skip("audio intro for transcript", String(e).slice(0, 150));
    }
    if (ninaIntroOk || nadiaIntroOk || transcriptOk) {
      await waitForCoordinatorJobs(20000);
    }
  }

  // ---- organizer/09-posts-editor + participant/12-posts-feed ----
  try {
    await olga.goto(`/#/e/${naddr}/admin`);
    await olga.waitForTimeout(800);
    // Admin also has an event-metadata "Title" field (icon/banner section),
    // and placeholder/button text is translated — scope structurally instead.
    // PostEditor is the only .card with BOTH a textarea (content) and a plain
    // input (title); the metadata card and the theme card each have only one
    // of the two.
    const postCard = olga.locator(".card:has(textarea):has(input)").first();
    const titleField = postCard.locator("input").first();
    if (await titleField.count()) {
      clearStem(orgDir, "09-posts-editor");
      await titleField.fill(COPY.postTitle);
      await postCard.locator("textarea").first().fill(COPY.postBody);
      // The caption says "members-only selected" (ORGANIZER-GUIDE.md) — actually
      // select it, rather than leave the default "public" radio checked. `value`
      // is a plain HTML attribute, not translated text, so this is locale-safe.
      const membersRadio = postCard.locator('input[type="radio"][value="members"]');
      if (await membersRadio.count()) await membersRadio.check();
      await olga.waitForTimeout(300);
      await shoot(olga, orgDir, "09-posts-editor", "light");
      await setThemeNoReload(olga, "dark");
      await shoot(olga, orgDir, "09-posts-editor", "dark");
      await setThemeNoReload(olga, "light");
      const publishBtn = postCard.locator("button.primary").first();
      if (await publishBtn.count()) {
        await publishBtn.click();
        await postCard.getByText(COPY.postTitle, { exact: false }).first().waitFor({ timeout: 15000 }).catch(() => {});
      }
    } else {
      skip("09-posts-editor", "title field not found");
    }
  } catch (e) {
    skip("09-posts-editor", String(e).slice(0, 150));
  }

  await nina.goto(`/#/e/${naddr}/posts`);
  await nina.waitForTimeout(1500);
  await shoot(nina, partDir, "12-posts-feed", "light");
  await setThemeNoReload(nina, "dark");
  await shoot(nina, partDir, "12-posts-feed", "dark");
  await setThemeNoReload(nina, "light");

  if (!INCLUDE_FLAKY) {
    skip("21-transcript", "INCLUDE_FLAKY not set — coordinator dependency, deferred");
    skip("23-my-profile-edited", "INCLUDE_FLAKY not set — coordinator dependency, deferred");
    skip("11-matches", "INCLUDE_FLAKY not set — coordinator dependency, deferred");
  } else {
    // ---- participant/21-transcript (Olga's own profile, if the audio intro landed) ----
    if (transcriptOk) {
      try {
        clearStem(partDir, "21-transcript");
        await olga.goto(`/#/e/${naddr}/attendees`);
        await olga.waitForTimeout(1200);
        await pollReload(olga, async () => (await olga.locator(".roster button.open").count()) > 0);
        const openButtons = olga.locator(".roster button.open");
        const n = await openButtons.count();
        let found = false;
        for (let i = 0; i < n; i++) {
          await openButtons.nth(i).click();
          await olga.waitForTimeout(700);
          const body = await olga.locator("main").innerText().catch(() => "");
          if (/Olga/i.test(body)) {
            found = true;
            break;
          }
          await olga.goBack();
          await olga.waitForTimeout(500);
        }
        if (found) {
          // Structural, not translated text (media.showTranscript is "Show
          // transcript" in en but "Zobraziť prepis" / "Zobrazit přepis" in
          // sk/cs — neither contains "transcript" at all, so the old
          // getByRole name-match never fired there). MediaPlayer.svelte's
          // toggle is the only button.linklike inside its own .transcript
          // wrapper.
          const transcriptBtn = olga.locator(".transcript button.linklike").first();
          if (await transcriptBtn.count()) {
            await transcriptBtn.first().click();
            await olga.waitForTimeout(400);
            await shoot(olga, partDir, "21-transcript", "light");
            // setThemeNoReload: the expanded transcript is local, unpersisted
            // component state inside a drawer that was itself opened by a
            // click — a real reload closes the drawer AND re-collapses the
            // transcript back to "Show transcript", so the dark shot doesn't
            // just risk a loading race, it guaranteed the wrong (collapsed)
            // state every time. Nothing here needs a refetch to re-theme.
            await setThemeNoReload(olga, "dark");
            await shoot(olga, partDir, "21-transcript", "dark");
            await setThemeNoReload(olga, "light");
          } else {
            skip("21-transcript", "no transcript button on Olga's own card");
          }
        } else {
          skip("21-transcript", "could not find Olga's own roster card");
        }
      } catch (e) {
        skip("21-transcript", String(e).slice(0, 150));
      }
    } else {
      skip("21-transcript", "audio intro did not record");
    }

    // ---- participant/23-my-profile-edited ----
    // clearStem BEFORE the attempt, not only on success: this stem's mock-
    // coordinator dependency (the AI profile field only appears once the
    // text intro has actually processed) makes it fail here often enough
    // that a stale file from some earlier, unrelated successful run was
    // sitting in docs/images untouched for weeks — exactly the silent-
    // substitution failure mode this file's clearStem() docstring warns
    // about, just not yet applied to this particular stem.
    try {
      clearStem(partDir, "23-my-profile-edited");
      await nina.goto(`/#/e/${naddr}/profile`);
      await nina.waitForTimeout(1200);
      const gotProfile = await pollReload(nina, async () =>
        (await nina.locator(".editfield input[type=checkbox]").count()) > 0,
      );
      const hideToggle = nina.locator(".editfield input[type=checkbox]").first();
      if (gotProfile) {
        await hideToggle.check();
        const saveBtn = nina.locator("button.primary");
        await saveBtn.first().click();
        await nina.waitForTimeout(1000);
        await shoot(nina, partDir, "23-my-profile-edited", "light");
        await setTheme(nina, "dark");
        await shoot(nina, partDir, "23-my-profile-edited", "dark");
        await setTheme(nina, "light");
      } else {
        skip("23-my-profile-edited", "no AI profile field to edit yet — intro may not have processed");
      }
    } catch (e) {
      skip("23-my-profile-edited", String(e).slice(0, 150));
    }

    // ---- participant/11-matches ----
    // clearStem BEFORE the attempt, matching 21-transcript / 15-dm-chat above:
    // this stem is coordinator-dependent and the mock coordinator's documented
    // stall means gotMatches below can legitimately come back false, in which
    // case there must be no file at all here rather than a stale one from an
    // earlier, unrelated successful run standing in for it unnoticed.
    try {
      clearStem(partDir, "11-matches");
      await olga.goto(`/#/e/${naddr}/admin`);
      await olga.waitForTimeout(800);
      // id, not translated text (admin.coordinator.recompute is "↻ Recompute
      // all matches" in en but "↻ Prepočítať všetky spojenia" / "↻ Přepočítat
      // všechna spojení" in sk/cs — none share the English word "recompute").
      // Admin.svelte gave this button a stable id for exactly this reason.
      const recomputeBtn = olga.locator("#recompute-matches");
      if (await recomputeBtn.count()) await recomputeBtn.first().click();
      await nina.goto(`/#/e/${naddr}/matches`);
      await nina.waitForTimeout(1500);
      // Bigger budget (the mock coordinator's stall makes 40s too tight) — and,
      // critically, GATE the shot on gotMatches. The old code logged a skip() on
      // timeout but then shot anyway, which is exactly how a past run ended up
      // shipping "Fetching your matches…" as the 11-matches screenshot: a real
      // .card.match never renders while loading is true (Matches.svelte:187-188),
      // so requiring it before ever pressing the shutter is sufficient to rule
      // out the loading state — no separate text-based wait needed.
      const gotMatches = await pollReload(
        nina,
        async () => (await nina.locator(".card.match").count()) > 0,
        { maxMs: 90000, stepMs: 5000 },
      );
      if (gotMatches) {
        await nina.waitForTimeout(400);
        await shoot(nina, partDir, "11-matches", "light");
        await setTheme(nina, "dark");
        await shoot(nina, partDir, "11-matches", "dark");
        await setTheme(nina, "light");
      } else {
        skip("11-matches", "no match rows appeared within the poll budget — skipping rather than shoot a loading/empty state");
      }
    } catch (e) {
      skip("11-matches", String(e).slice(0, 150));
    }
  }

  // ---- participant/13-me ----
  await nina.goto("/#/me");
  await nina.waitForTimeout(500);
  await shoot(nina, partDir, "13-me", "light");
  mirrorToWeb(partDir, "13-me", "light");
  await setTheme(nina, "dark");
  await shoot(nina, partDir, "13-me", "dark");
  mirrorToWeb(partDir, "13-me", "dark");
  await setTheme(nina, "light");

  // ---- participant/14-more, 14-messages, 15-dm-chat, 18-mute-confirm ----
  try {
    clearStem(partDir, "14-more");
    await nina.goto(`/#/e/${naddr}/more`);
    await nina.waitForTimeout(700);
    await shoot(nina, partDir, "14-more", "light");
    await setTheme(nina, "dark");
    await shoot(nina, partDir, "14-more", "dark");
    await setTheme(nina, "light");
  } catch (e) {
    skip("14-more", String(e).slice(0, 150));
  }

  if (!INCLUDE_FLAKY) {
    skip("15-dm-chat / 14-messages / 18-mute-confirm", "INCLUDE_FLAKY not set — coordinator dependency, deferred");
  } else {
    try {
      clearStem(partDir, "15-dm-chat");
      clearStem(partDir, "18-mute-confirm");
      clearStem(partDir, "14-messages");
      // Message someone from the attendee list (row quick-action) to seed a DM
      // thread. The action buttons are icon-only (aria-label is translated, so
      // not a stable cross-locale selector) — but they're always rendered as a
      // fixed pair, [want-to-meet star, message/send], so position is reliable.
      await nina.goto(`/#/e/${naddr}/attendees`);
      await nina.waitForTimeout(1200);
      await pollReload(nina, async () => (await nina.locator("button.icon-btn").count()) > 0);
      const msgBtn = nina.locator("button.icon-btn").nth(1);
      if (await msgBtn.count()) {
        await msgBtn.click();
      } else {
        skip("dm-seed", "no row-level message button found");
      }
      await nina.waitForTimeout(800);
      const dmTextarea = nina.locator("textarea").first();
      if (await dmTextarea.count()) {
        await dmTextarea.fill(COPY.dm);
        // Enter-to-send AND a fallback click on the composer's own primary
        // button (scoped to its row, not a page-wide English-text search).
        await nina.keyboard.press("Enter").catch(() => {});
        const sendBtn = nina.locator(".row button.primary").last();
        if (await sendBtn.count()) await sendBtn.click().catch(() => {});
        await nina.waitForTimeout(2000);
        await shoot(nina, partDir, "15-dm-chat", "light");
        // setThemeNoReload throughout this DM thread: a real reload re-decrypts
        // the conversation (DmChat.svelte shows "Decrypting messages…" while
        // `loading` is true) AND re-fetches the mute list from relays before
        // `muted` is trustworthy again — neither round trip fit in the fixed
        // 400ms this used to wait, so a reloaded dark shot could catch a
        // decrypting placeholder, or (worse, for 18-mute-confirm specifically)
        // a mute state that silently reverted because the freshly-published
        // mute list hadn't round-tripped back from the relay yet. None of that
        // needs a refetch just to re-theme the same on-screen state.
        await setThemeNoReload(nina, "dark");
        await shoot(nina, partDir, "15-dm-chat", "dark");
        await setThemeNoReload(nina, "light");

        // mute-confirm: toggle mute, capture the inline confirmation line.
        // Scoped to <main> (+layout.svelte:432, the routed page's own
        // content) — the previous unscoped ".row button.inline" matched
        // TopBar's OWN "back" button first (TopBar.svelte: also a
        // `.row > button.btn.inline`, rendered in the global layout chrome
        // BEFORE <main> in DOM order, so .first() found it ahead of DmChat's
        // mute toggle). Clicking it fired router.up() instead of muting —
        // silently navigating to /#/dm — which is exactly why
        // 18-mute-confirm shipped byte-identical to 14-messages: both ended
        // up screenshotting the same messages-list route.
        const muteBtn = nina.locator("main .row button.inline").first();
        if (await muteBtn.count()) {
          await muteBtn.click();
          // toggleMute disables the button (muteBusy) for the duration of the
          // publish — wait for it to re-enable rather than guess a fixed
          // delay, so the shot never lands mid-toggle, before the
          // confirmation line has actually rendered.
          for (let i = 0; i < 20; i++) {
            if (!(await muteBtn.isDisabled().catch(() => false))) break;
            await nina.waitForTimeout(300);
          }
          await nina.waitForTimeout(300);
          await shoot(nina, partDir, "18-mute-confirm", "light");
          await setThemeNoReload(nina, "dark");
          await shoot(nina, partDir, "18-mute-confirm", "dark");
          await setThemeNoReload(nina, "light");
          await muteBtn.click(); // unmute, so the thread reappears in 14-messages
          await nina.waitForTimeout(400);
        } else {
          skip("18-mute-confirm", "mute button not found");
        }

        await nina.goto("/#/dm");
        await nina.waitForTimeout(1000);
        await shoot(nina, partDir, "14-messages", "light");
        await setThemeNoReload(nina, "dark");
        await shoot(nina, partDir, "14-messages", "dark");
        await setThemeNoReload(nina, "light");
      } else {
        skip("15-dm-chat / 14-messages / 18-mute-confirm", "DM composer not found");
      }
    } catch (e) {
      skip("15-dm-chat / 14-messages / 18-mute-confirm", String(e).slice(0, 150));
    }
  }

  // ---- organizer/08-revoke ----
  // The old `hasText: /revoke|odvolať|odvolat/i` filter assumed Slovak/Czech
  // words that aren't the real translation (admin.revoke.revoke is "Odobrať"
  // in sk and "Odebrat" in cs — neither contains "odvolať"/"odvolat"), so it
  // matched zero buttons there. Nothing then clicked, and the shot just
  // captured whatever was already on screen: this same #/e/<naddr>/admin
  // route had been visited moments earlier for 09-posts-editor, and because
  // this SPA's `goto` to an unchanged hash URL is a no-op (no navigation, no
  // reset scroll), the leftover scrolled-to-post-editor state rode straight
  // into the sk/cs 08-revoke files. #approved-people is AdminPeople's own
  // stable, non-translated anchor (added alongside this fix, packages/app/
  // src/lib/components/AdminPeople.svelte) — but the currently-served
  // preview build predates that change (vite preview serves a static dist/
  // bundle; a Svelte source edit needs a rebuild to appear there, which
  // wasn't done for this pass), so also fall back to a page-wide
  // `.btn.inline.danger` when the scoped one isn't present yet. That fallback
  // is unambiguous on its own merits, not just luck: by this point in the
  // flow every pending request has been resolved (AdminQueue's reject-danger
  // buttons render per pending row, and there are none left) and no talk has
  // been submitted yet (AdminTalks' danger button is per-submitted-talk, and
  // the Talks section runs after this step) — so AdminPeople's per-person
  // revoke buttons (Nina + Nadia, both approved) are the ONLY
  // .btn.inline.danger buttons anywhere on the page at this moment.
  await olga.goto(`/#/e/${naddr}/admin`);
  await olga.waitForTimeout(1500);
  try {
    clearStem(orgDir, "08-revoke");
    let revokeBtn = olga.locator("#approved-people .card button.btn.inline.danger").first();
    if (!(await revokeBtn.count().catch(() => 0))) {
      revokeBtn = olga.locator("button.btn.inline.danger").first();
    }
    await revokeBtn.waitFor({ timeout: 15000 });
    await revokeBtn.scrollIntoViewIfNeeded();
    await revokeBtn.click();
    await olga.waitForTimeout(500);
    await shoot(olga, orgDir, "08-revoke", "light");
    await setThemeNoReload(olga, "dark");
    await shoot(olga, orgDir, "08-revoke", "dark");
    await setThemeNoReload(olga, "light");
  } catch (e) {
    skip("08-revoke", String(e).slice(0, 150));
  }

  // ---- organizer/13-admin-overview + -desktop: the operational dashboard
  // atop Admin (AdminOverview.svelte) had NO producer anywhere in e2e/ until
  // now — both files in docs/images were hand-captured, and both carry the
  // global "Connected to the internet, but no relay is reachable" banner
  // (+layout.svelte, connectivity.overall === "relay-blocked") across the
  // top, apparently shot against a relay that wasn't actually up at the
  // time. Every other capture in this run drives the SAME relay with no such
  // banner, so shooting it here — after invites/approvals/revoke have given
  // the metrics grid something real to show instead of an all-zero empty
  // state — reproduces it cleanly instead of by hand. Desktop reuses the
  // 1280x900 convention from audit-ux-verify.mjs / marmot-chat-verify.mjs;
  // resizing Olga's OWN page keeps her logged-in organizer session instead of
  // needing a fresh, empty context just for one wide shot. Dark added for
  // both viewports (previously light-only, leaving 6 dark files missing
  // across the three locales) — setThemeNoReload since nothing here is
  // route-derived and a real reload would just risk re-fetching the metrics
  // mid-shot.
  try {
    clearStem(orgDir, "13-admin-overview");
    clearStem(orgDir, "13-admin-overview-desktop");
    await olga.goto(`/#/e/${naddr}/admin`);
    const overviewMetric = olga.locator(".grid .metric").first();
    await overviewMetric.waitFor({ timeout: 15000 });
    await overviewMetric.scrollIntoViewIfNeeded();
    await olga.waitForTimeout(300);
    await shoot(olga, orgDir, "13-admin-overview", "light");
    await setThemeNoReload(olga, "dark");
    await overviewMetric.scrollIntoViewIfNeeded();
    await olga.waitForTimeout(200);
    await shoot(olga, orgDir, "13-admin-overview", "dark");
    await setThemeNoReload(olga, "light");

    await olga.setViewportSize({ width: 1280, height: 900 });
    await olga.waitForTimeout(300);
    await overviewMetric.scrollIntoViewIfNeeded();
    await olga.waitForTimeout(200);
    await shoot(olga, orgDir, "13-admin-overview-desktop", "light");
    await setThemeNoReload(olga, "dark");
    await overviewMetric.scrollIntoViewIfNeeded();
    await olga.waitForTimeout(200);
    await shoot(olga, orgDir, "13-admin-overview-desktop", "dark");
    await setThemeNoReload(olga, "light");
    await olga.setViewportSize({ width: 390, height: 844 });
  } catch (e) {
    skip("13-admin-overview / 13-admin-overview-desktop", String(e).slice(0, 150));
    await olga.setViewportSize({ width: 390, height: 844 }).catch(() => {});
  }

  // ---- Talks list ----
  await olga.goto(`/#/e/${naddr}/talks`);
  await olga.waitForTimeout(1500);
  await shoot(olga, partDir, "26-talks-empty", "light");
  mirrorToWeb(partDir, "26-talks-empty", "light");
  // setThemeNoReload: a real reload re-fetches the talks list, and the fixed
  // 400ms after reload wasn't enough — the dark shot landed on a loading
  // placeholder instead of the empty-state content.
  await setThemeNoReload(olga, "dark");
  await shoot(olga, partDir, "26-talks-empty", "dark");
  mirrorToWeb(partDir, "26-talks-empty", "dark");
  await setThemeNoReload(olga, "light");

  // ---- participant/27-talks-submit + 27b-talks-url (item 2): the talk-source
  // selector (Record / Upload / Paste-URL) and the matching opt-in checkbox. ----
  try {
    clearStem(partDir, "27-talks-submit");
    clearStem(partDir, "27b-talks-url");
    await olga.goto(`/#/e/${naddr}/talks`);
    await olga.waitForTimeout(800);
    // items.length === 0 at this point (no talks submitted yet), so the empty
    // state's card has no button — this is the only button.primary on the page.
    const submitBtn = olga.locator("button.primary").first();
    await submitBtn.waitFor({ timeout: 10000 });
    await submitBtn.click();
    await olga.locator("#talk-title").waitFor({ timeout: 15000 });
    await olga.locator("#talk-title").fill(COPY.talkTitle);
    await olga.waitForTimeout(300);
    // Default source is "record" (Record.svelte:62) — the source-selector row
    // and the "Process this talk for matching?" checkbox both render above it,
    // in view without scrolling.
    await shoot(olga, partDir, "27-talks-submit", "light");
    // Ephemeral, unsaved composer state (title, source tab) — a page.reload()
    // for the dark shot would wipe it and there's no draft for talk fields, so
    // flip data-theme in place instead of reloading (see setThemeNoReload).
    await setThemeNoReload(olga, "dark");
    await shoot(olga, partDir, "27-talks-submit", "dark");
    await setThemeNoReload(olga, "light");

    // Switch to "Paste a URL" — the 3rd button in the labelled source group
    // (Record.svelte:712-717); `value`/`aria-labelledby` are structural, not
    // translated text, so this selector holds across locales.
    const sourceBtns = olga.locator('[role="group"][aria-labelledby="talk-source-label"] button');
    await sourceBtns.nth(2).click();
    const talkUrlField = olga.locator("#talk-url");
    await talkUrlField.waitFor({ timeout: 10000 });
    await talkUrlField.fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await olga.waitForTimeout(400);
    // Wait for the "Detected: YouTube video" badge (talks.url.detectedYoutube)
    // before shooting — never capture the field mid-classification.
    await olga.locator(".badge.ok").first().waitFor({ timeout: 5000 });
    // The URL card renders AFTER the (tall) disclosure card (Record.svelte:806),
    // below the fold on the 390x844 viewport — explicitly scroll it (and its
    // badge) into view rather than trust fill()'s scroll, which a previous
    // capture showed landing on the disclosure card instead of the field.
    await olga.locator(".badge.ok").first().scrollIntoViewIfNeeded();
    await olga.waitForTimeout(200);
    await shoot(olga, partDir, "27b-talks-url", "light");
    await setThemeNoReload(olga, "dark");
    await shoot(olga, partDir, "27b-talks-url", "dark");
    await setThemeNoReload(olga, "light");
  } catch (e) {
    skip("27-talks-submit / 27b-talks-url", String(e).slice(0, 150));
  }

  // ---- Otto (outsider) ----
  await newUser(otto, "Otto Outsider");
  await otto.goto(`/#/e/${naddr}`);
  await otto.waitForTimeout(800);
  await shoot(otto, partDir, "12-outsider", "light");
  await setTheme(otto, "dark");
  await shoot(otto, partDir, "12-outsider", "dark");
  await setTheme(otto, "light");

  // ---- chat-conversation (organizer + participant): Olga <-> Nina in the real MLS group ----
  if (!INCLUDE_FLAKY) {
    skip("chat-conversation", "INCLUDE_FLAKY not set — coordinator dependency, deferred");
  } else {
  try {
    clearStem(orgDir, "chat-conversation");
    clearStem(partDir, "chat-conversation");
    await olga.goto(`/#/e/${naddr}/chat`);
    await olga.waitForTimeout(1500);
    await nina.goto(`/#/e/${naddr}/chat`);
    await nina.waitForTimeout(1500);

    // Enrollment (device key publish + attestation + coordinator MLS-add +
    // welcome delivery) can take a while the first time, and the mock
    // coordinator has an occasional multi-minute stall — poll each side's
    // ACTUAL enabled state independently rather than guessing a fixed delay.
    const olgaComposer = olga.locator("form.compose textarea");
    const ninaComposer = nina.locator("form.compose textarea");
    const olgaSend = olga.locator("form.compose .send");
    const ninaSend = nina.locator("form.compose .send");
    const olgaReady = await pollReload(
      olga,
      async () => (await olgaSend.count()) > 0 && !(await olgaSend.isDisabled().catch(() => true)),
      { maxMs: 60000, stepMs: 5000 },
    );
    const ninaReady = await pollReload(
      nina,
      async () => (await ninaSend.count()) > 0 && !(await ninaSend.isDisabled().catch(() => true)),
      { maxMs: 60000, stepMs: 5000 },
    );
    const enrolled = olgaReady && ninaReady;
    if (enrolled) {
      await olgaComposer.fill(COPY.chatWelcome);
      await olgaSend.click();
      await olga.waitForTimeout(3000);

      await nina.reload({ waitUntil: "domcontentloaded" });
      await nina.waitForTimeout(1500);
      await ninaComposer.fill(COPY.chatReply);
      await ninaSend.click();
      await nina.waitForTimeout(3000);

      await olga.reload({ waitUntil: "domcontentloaded" });
      await olga.waitForTimeout(1500);
      const olgaText = await olga.locator("main").innerText().catch(() => "");
      if (COPY.chatProof.test(olgaText)) {
        await shoot(olga, orgDir, "chat-conversation", "light");
        await setTheme(olga, "dark");
        await shoot(olga, orgDir, "chat-conversation", "dark");
        await setTheme(olga, "light");

        await nina.goto(`/#/e/${naddr}/chat`);
        await nina.waitForTimeout(1500);
        await shoot(nina, partDir, "chat-conversation", "light");
        await setTheme(nina, "dark");
        await shoot(nina, partDir, "chat-conversation", "dark");
        await setTheme(nina, "light");
      } else {
        skip("chat-conversation", "Nina's reply never appeared in Olga's view within the wait budget");
      }
    } else {
      skip("chat-conversation", "chat composer not found on one or both sides");
    }
  } catch (e) {
    skip("chat-conversation", String(e).slice(0, 200));
  }
  }

  await browser.close();
  console.log(`\nCaptured ${shots.length} screenshots (locale: ${LOCALE}).`);
  if (skipped.length) {
    console.log(`\n${skipped.length} stem(s) skipped:`);
    for (const s of skipped) console.log(`  - ${s.label}: ${s.reason}`);
  }
  checkDuplicateOutput();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
