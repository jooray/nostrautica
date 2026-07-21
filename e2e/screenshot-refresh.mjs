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
import { mkdirSync, copyFileSync, existsSync } from "node:fs";

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
    ninaIntro: "Rust developer working on privacy tooling. Looking for a co-founder who cares about usability.",
    nadiaIntro: "Product designer who loves making cryptography approachable. Looking for engineers to collaborate with.",
    dm: "Hey! Looking forward to the event.",
    chatWelcome: "Welcome everyone! Excited to see you all here.",
    chatReply: "Thanks for organizing this, looking forward to it!",
    chatProof: /organizing|looking forward/i,
  },
  sk: {
    ninaIntro: "Rust vývojárka, pracujem na nástrojoch pre súkromie. Hľadám spoluzakladateľa, ktorému záleží na použiteľnosti.",
    nadiaIntro: "Produktová dizajnérka, ktorá rada robí kryptografiu zrozumiteľnou. Hľadám vývojárov na spoluprácu.",
    dm: "Ahoj! Teším sa na podujatie.",
    chatWelcome: "Vitajte všetci! Teším sa, že vás tu vidím.",
    chatReply: "Ďakujem za organizáciu, teším sa na to!",
    chatProof: /organizáci|teším sa/i,
  },
  cs: {
    ninaIntro: "Rust vývojářka, pracuji na nástrojích pro soukromí. Hledám spoluzakladatele, kterému záleží na použitelnosti.",
    nadiaIntro: "Produktová designérka, která ráda dělá kryptografii srozumitelnou. Hledám vývojáře ke spolupráci.",
    dm: "Ahoj! Těším se na akci.",
    chatWelcome: "Vítejte všichni! Těším se, že vás tu vidím.",
    chatReply: "Děkuji za organizaci, těším se na to!",
    chatProof: /organizac|těším se/i,
  },
}[LOCALE];

const shots = [];
const skipped = [];

async function shoot(page, dir, stem, theme) {
  mkdirSync(`${DOCS}/${dir}`, { recursive: true });
  const path = `${DOCS}/${dir}/${stem}-${theme}.png`;
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
  await page.waitForTimeout(400);
  // Tab order is [video, audio, text?] — text tab only renders when a
  // coordinator is attached (hasCoordinator). It's the LAST tab.
  const tabs = page.locator('button[role="tab"]');
  const tabCount = await tabs.count();
  if (tabCount < 3) {
    skip("text-intro", `only ${tabCount} record tabs — no coordinator attached yet?`);
    return false;
  }
  await tabs.nth(tabCount - 1).click();
  await page.waitForTimeout(300);
  const textarea = page.locator("textarea").first();
  await textarea.fill(text);
  const ack = page.locator('input[type="checkbox"]');
  if (await ack.count()) await ack.first().check();
  const submitBtn = page.locator('button.primary:not([role="tab"])').last();
  await submitBtn.click();
  await page.waitForTimeout(1500);
  return true;
}

async function recordAudioIntro(page) {
  await page.waitForTimeout(400);
  const tabs = page.locator('button[role="tab"]');
  if ((await tabs.count()) < 2) {
    skip("audio-intro", "audio tab not found");
    return false;
  }
  await tabs.nth(1).click(); // [video, audio, text] — audio is index 1
  await page.waitForTimeout(300);
  const enableMic = page.getByRole("button", { name: /^enable microphone$/i });
  if (await enableMic.count()) {
    await enableMic.click();
    await page.waitForTimeout(500);
  }
  const ack = page.locator('input[type="checkbox"]');
  if (await ack.count()) await ack.first().check();
  const recordBtn = page.locator('button.primary:not([role="tab"])').filter({ hasNotText: "" });
  const btns = page.getByRole("button", { name: /record/i });
  if (!(await btns.count())) {
    skip("audio-intro", "no record button found");
    return false;
  }
  await btns.first().click();
  await page.waitForTimeout(2500); // let MediaRecorder collect a couple chunks
  const stopBtn = page.getByRole("button", { name: /stop/i });
  if (await stopBtn.count()) await stopBtn.first().click();
  await page.waitForTimeout(500);
  const useBtn = page.getByRole("button", { name: /use this/i });
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

function copyIfExists(src, dest) {
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
    const langTrigger = olga.locator("#lang");
    await langTrigger.click({ timeout: 5000 });
    await olga.waitForTimeout(300);
    await shoot(olga, orgDir, "10-language-picker", "light");
    await olga.keyboard.press("Escape");
  } catch (e) {
    skip("10-language-picker", String(e).slice(0, 150));
  }

  // ---- organizer/01-create-form + create the event ----
  await olga.locator("#t").fill("Nostrautica Screenshot Assembly");
  await olga.locator("#st").fill("2026-09-15T10:00");
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

  // ---- organizer/01b-create-coordinator: the discovery picker now available
  //      directly on the create form (CoordinatorPicker.svelte) ----
  try {
    const createCoordCards = olga.locator(".coord-card");
    await createCoordCards.first().waitFor({ timeout: 10000 });
    await createCoordCards.first().scrollIntoViewIfNeeded();
    await olga.waitForTimeout(300);
    await shoot(olga, orgDir, "01b-create-coordinator", "light");
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
  // Ephemeral, client-side-only state (no route param) — a reload for the dark
  // shot would lose it entirely, so light-only here, and grab the naddr BEFORE
  // doing anything else with this page.
  await shoot(olga, orgDir, "02-created", "light");
  const shareLink = await olga.locator(".mono").first().innerText();
  const naddr = shareLink.match(/#\/e\/([^/\s]+)/)?.[1];
  if (!naddr) throw new Error("no naddr captured");
  console.log("naddr:", naddr);

  // ---- organizer/03-admin-empty ----
  await olga.goto(`/#/e/${naddr}/admin`);
  await olga.waitForTimeout(1500);
  await shoot(olga, orgDir, "03-admin-empty", "light");
  copyIfExists(`${DOCS}/${orgDir}/03-admin-empty-light.png`, `${WEB}/03-admin-empty-light.png`);

  // Coordinator attach/discovery, theme CSS, and the chat toggle now live on
  // the Event settings page (#/e/<naddr>/settings), split out of Admin.
  await olga.goto(`/#/e/${naddr}/settings`);

  // ---- organizer/05a-coordinator-picker + 05-coordinator: attach the mock coordinator ----
  try {
    await olga.waitForTimeout(1500); // discovery fetch (streamEvents, up to 8s)
    const coordCards = olga.locator(".coord-card");
    await coordCards.first().waitFor({ timeout: 10000 });
    await shoot(olga, orgDir, "05a-coordinator-picker", "light");
    await setTheme(olga, "dark");
    await shoot(olga, orgDir, "05a-coordinator-picker", "dark");
    await setTheme(olga, "light");
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
    await setTheme(olga, "dark");
    await shoot(olga, orgDir, "05-coordinator", "dark");
    await setTheme(olga, "light");
  } catch (e) {
    skip("05-coordinator / 05a-coordinator-picker", String(e).slice(0, 150));
  }

  // ---- organizer/10-theme-editor ----
  try {
    const themeCard = olga.locator(".card").filter({ has: olga.locator("textarea.mono") });
    await themeCard.scrollIntoViewIfNeeded();
    await olga.locator("textarea.mono").fill(":root { --accent: #7c5cff; }");
    await olga.waitForTimeout(300);
    await shoot(olga, orgDir, "10-theme-editor", "light");
  } catch (e) {
    skip("10-theme-editor", String(e).slice(0, 150));
  }

  // ---- organizer/11-chat-toggle (chat=marmot was set at creation, so this is
  //      the already-on persisted state — reload-safe) ----
  try {
    await olga.goto(`/#/e/${naddr}/settings`);
    await olga.waitForTimeout(1200);
    await olga.locator("button, [role=switch]").last().scrollIntoViewIfNeeded().catch(() => {});
    await shoot(olga, orgDir, "11-chat-toggle", "light");
    await setTheme(olga, "dark");
    await shoot(olga, orgDir, "11-chat-toggle", "dark");
    await setTheme(olga, "light");
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
    await generateBtn.first().click();
    await olga.waitForTimeout(1000);
    await shoot(olga, orgDir, "04-invites", "light");
  } else {
    skip("04-invites", "generate button not found");
  }

  // ---- Nina joins without a code: participant/02-event-page + 02-event-overview (same screen, both stem names) ----
  await nina.goto(`/#/e/${naddr}`);
  await nina.waitForTimeout(800);
  for (const stem of ["02-event-page", "02-event-overview"]) {
    await shoot(nina, partDir, stem, "light");
  }
  copyIfExists(`${DOCS}/${partDir}/02-event-page-light.png`, `${WEB}/02-event-page-light.png`);
  await setTheme(nina, "dark");
  for (const stem of ["02-event-page", "02-event-overview"]) {
    await shoot(nina, partDir, stem, "dark");
  }
  copyIfExists(`${DOCS}/${partDir}/02-event-page-dark.png`, `${WEB}/02-event-page-dark.png`);
  await setTheme(nina, "light");

  await nina.goto(`/#/e/${naddr}/join`);
  await nina.waitForTimeout(500);
  const ninaNameField = nina.locator("#n");
  if (await ninaNameField.count()) await ninaNameField.fill("Nina Newcomer");
  const aboutField = nina.locator("#a");
  if (await aboutField.count()) await aboutField.fill("New to Nostr, excited to meet people.");
  await nina.waitForTimeout(300);
  await shoot(nina, partDir, "04-join-form", "light");

  const joinBtn = nina.locator(".card").last().locator("button.primary");
  if (await joinBtn.count()) await joinBtn.click();
  await nina.waitForURL("**", { timeout: 20000 }).catch(() => nina.locator("body").waitFor({ timeout: 20000 }));
  await nina.waitForTimeout(500);
  await shoot(nina, partDir, "05-request-sent", "light");

  await nina.goto("/#/me");
  await nina.waitForTimeout(500);
  await shoot(nina, partDir, "03-backup", "light");

  // ---- organizer: pending + approve ----
  // Scoped to the join-requests section specifically (CSS general-sibling
  // combinator: the h2#join-requests heading and the .stack of request cards
  // are siblings). The admin page now has MANY .btn.primary buttons elsewhere
  // (theme publish, coordinator attach, ...) — a page-wide `buttons.first()`
  // is a coin flip about which one it actually hits once those sections exist.
  const approveScope = () => olga.locator("#join-requests ~ .stack .card button.primary");
  await olga.goto(`/#/e/${naddr}/admin`);
  await approveScope().first().waitFor({ timeout: 20000 }).catch(() => {});
  await olga.waitForTimeout(500);
  await shoot(olga, orgDir, "06-pending", "light");

  const approveBtn = approveScope().first();
  if (await approveBtn.count()) await approveBtn.click();
  await olga.waitForTimeout(1500);
  await shoot(olga, orgDir, "07-approved", "light");
  await setTheme(olga, "dark");
  await shoot(olga, orgDir, "07-approved", "dark");
  await setTheme(olga, "light");

  // ---- Nadia (second attendee) ----
  await newUser(nadia, "Nadia Nostrnative");
  await nadia.goto(`/#/e/${naddr}/join`);
  await nadia.waitForTimeout(500);
  await shoot(nadia, partDir, "07-signin-options", "light");
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
  await setTheme(nina, "dark");
  await shoot(nina, partDir, "06-approved", "dark");
  await setTheme(nina, "light");

  // ---- participant/08-attendees ----
  await nina.goto(`/#/e/${naddr}/attendees`);
  await nina.waitForTimeout(1500);
  await shoot(nina, partDir, "08-attendees", "light");
  copyIfExists(`${DOCS}/${partDir}/08-attendees-light.png`, `${WEB}/08-attendees-light.png`);
  await setTheme(nina, "dark");
  await shoot(nina, partDir, "08-attendees", "dark");
  copyIfExists(`${DOCS}/${partDir}/08-attendees-dark.png`, `${WEB}/08-attendees-dark.png`);
  await setTheme(nina, "light");

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
      await titleField.fill("Welcome to the assembly");
      await postCard.locator("textarea").first().fill("Looking forward to seeing everyone — schedule and details inside.");
      await olga.waitForTimeout(300);
      await shoot(olga, orgDir, "09-posts-editor", "light");
      const publishBtn = postCard.locator("button.primary").first();
      if (await publishBtn.count()) {
        await publishBtn.click();
        await postCard.getByText("Welcome to the assembly", { exact: false }).first().waitFor({ timeout: 15000 }).catch(() => {});
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

  if (!INCLUDE_FLAKY) {
    skip("21-transcript", "INCLUDE_FLAKY not set — coordinator dependency, deferred");
    skip("23-my-profile-edited", "INCLUDE_FLAKY not set — coordinator dependency, deferred");
    skip("11-matches", "INCLUDE_FLAKY not set — coordinator dependency, deferred");
  } else {
    // ---- participant/21-transcript (Olga's own profile, if the audio intro landed) ----
    if (transcriptOk) {
      try {
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
          const transcriptBtn = olga.getByRole("button", { name: /transcript/i });
          if (await transcriptBtn.count()) {
            await transcriptBtn.first().click();
            await olga.waitForTimeout(400);
            await shoot(olga, partDir, "21-transcript", "light");
            await setTheme(olga, "dark");
            await shoot(olga, partDir, "21-transcript", "dark");
            await setTheme(olga, "light");
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
    try {
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
    try {
      await olga.goto(`/#/e/${naddr}/admin`);
      await olga.waitForTimeout(800);
      const recomputeBtn = olga.getByRole("button", { name: /recompute/i });
      if (await recomputeBtn.count()) await recomputeBtn.first().click();
      await nina.goto(`/#/e/${naddr}/matches`);
      await nina.waitForTimeout(1500);
      const gotMatches = await pollReload(nina, async () => (await nina.locator(".card.match").count()) > 0);
      if (!gotMatches) skip("11-matches", "no match rows appeared within the poll budget — showing empty state anyway");
      await shoot(nina, partDir, "11-matches", "light");
      await setTheme(nina, "dark");
      await shoot(nina, partDir, "11-matches", "dark");
      await setTheme(nina, "light");
    } catch (e) {
      skip("11-matches", String(e).slice(0, 150));
    }
  }

  // ---- participant/13-me ----
  await nina.goto("/#/me");
  await nina.waitForTimeout(500);
  await shoot(nina, partDir, "13-me", "light");
  copyIfExists(`${DOCS}/${partDir}/13-me-light.png`, `${WEB}/13-me-light.png`);
  await setTheme(nina, "dark");
  await shoot(nina, partDir, "13-me", "dark");
  copyIfExists(`${DOCS}/${partDir}/13-me-dark.png`, `${WEB}/13-me-dark.png`);
  await setTheme(nina, "light");

  // ---- participant/14-more, 14-messages, 15-dm-chat, 18-mute-confirm ----
  try {
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
        await setTheme(nina, "dark");
        await shoot(nina, partDir, "15-dm-chat", "dark");
        await setTheme(nina, "light");

        // mute-confirm: toggle mute, capture the inline confirmation line.
        const muteBtn = nina.locator(".row button.inline").first();
        if (await muteBtn.count()) {
          await muteBtn.click();
          await nina.waitForTimeout(500);
          await shoot(nina, partDir, "18-mute-confirm", "light");
          await setTheme(nina, "dark");
          await shoot(nina, partDir, "18-mute-confirm", "dark");
          await setTheme(nina, "light");
          await muteBtn.click(); // unmute, so the thread reappears in 14-messages
          await nina.waitForTimeout(400);
        } else {
          skip("18-mute-confirm", "mute button not found");
        }

        await nina.goto("/#/dm");
        await nina.waitForTimeout(1000);
        await shoot(nina, partDir, "14-messages", "light");
        await setTheme(nina, "dark");
        await shoot(nina, partDir, "14-messages", "dark");
        await setTheme(nina, "light");
      } else {
        skip("15-dm-chat / 14-messages / 18-mute-confirm", "DM composer not found");
      }
    } catch (e) {
      skip("15-dm-chat / 14-messages / 18-mute-confirm", String(e).slice(0, 150));
    }
  }

  // ---- organizer/08-revoke ----
  await olga.goto(`/#/e/${naddr}/admin`);
  await olga.waitForTimeout(1500);
  const revokeButtons = olga.locator("button").filter({ hasText: /revoke|odvolať|odvolat/i });
  if (await revokeButtons.count()) {
    await revokeButtons.first().click();
    await olga.waitForTimeout(500);
  }
  await shoot(olga, orgDir, "08-revoke", "light");

  // ---- Talks list ----
  await olga.goto(`/#/e/${naddr}/talks`);
  await olga.waitForTimeout(1500);
  await shoot(olga, partDir, "26-talks-empty", "light");
  copyIfExists(`${DOCS}/${partDir}/26-talks-empty-light.png`, `${WEB}/26-talks-empty-light.png`);
  await setTheme(olga, "dark");
  await shoot(olga, partDir, "26-talks-empty", "dark");
  copyIfExists(`${DOCS}/${partDir}/26-talks-empty-dark.png`, `${WEB}/26-talks-empty-dark.png`);
  await setTheme(olga, "light");

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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
