/**
 * Screenshot refresh (caching verification 2026-07-17): the UI has changed
 * since the last screenshot pass. Re-captures a core subset of the existing
 * stems in docs/images/{organizer,participant,app}/ and web/assets/screenshots/
 * at the repo's 390x844 mobile-viewport convention, light + dark, using a
 * seeded multi-persona session (Olga organizer, Nina newcomer, Nadia second
 * attendee, Otto outsider). Does NOT invent new stems.
 */
import { chromium } from "@playwright/test";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";

const BASE_URL = process.env.NOSTRAUTICA_URL ?? "http://localhost:4173";
const DOCS = process.env.NOSTRAUTICA_DOCS_DIR ?? "/Users/juraj/projects/nostrautica/docs/images";
const WEB = process.env.NOSTRAUTICA_WEB_DIR ?? "/Users/juraj/projects/nostrautica/web/assets/screenshots";

const LAUNCH_ARGS = [
  "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--ignore-certificate-errors",
];

const shots = []; // { stem, dir, page, theme }

async function shoot(page, dir, stem, theme) {
  const path = `${DOCS}/${dir}/${stem}-${theme}.png`;
  await page.waitForTimeout(400);
  await page.screenshot({ path });
  shots.push({ stem: `${dir}/${stem}`, theme, path });
  console.log(`  shot: ${dir}/${stem}-${theme}.png`);
}

async function setTheme(page, mode) {
  const current = await page.evaluate(() => document.documentElement.getAttribute("data-theme") ?? "");
  const isDark = current.includes("dark") || (await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches) && !current);
  // Just click until we're in the right state, reading the actual attribute after.
  for (let i = 0; i < 2; i++) {
    const attr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    if ((mode === "dark" && attr === "dark") || (mode === "light" && attr === "light")) return;
    const btn = page.getByRole("button", { name: /toggle theme/i });
    if (await btn.count()) await btn.first().click();
    await page.waitForTimeout(200);
  }
}

/** Wait for a locator, retrying once with a reload (relay timing in this env is occasionally slow). */
async function waitForWithReload(page, locator, timeout = 20000) {
  try {
    await locator.waitFor({ timeout });
  } catch {
    await page.reload();
    await locator.waitFor({ timeout });
  }
}

async function newUser(page, name) {
  await page.goto(`${BASE_URL}/#/login`);
  await page.getByLabel(/your name/i).fill(name);
  await page.getByRole("button", { name: /create my identity/i }).click();
  await page.getByText(/you're in/i).waitFor({ timeout: 20000 });
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const mobile = { viewport: { width: 390, height: 844 }, permissions: ["camera", "microphone"], ignoreHTTPSErrors: true, baseURL: BASE_URL };

  const olgaCtx = await browser.newContext(mobile);
  const ninaCtx = await browser.newContext(mobile);
  const nadiaCtx = await browser.newContext(mobile);
  const ottoCtx = await browser.newContext(mobile);
  const olga = await olgaCtx.newPage();
  const nina = await ninaCtx.newPage();
  const nadia = await nadiaCtx.newPage();
  const otto = await ottoCtx.newPage();

  // ---- participant/01-home: landing screen, logged out ----
  await olga.goto("/#/");
  await olga.waitForTimeout(500);
  await shoot(olga, "participant", "01-home", "light");
  await setTheme(olga, "dark");
  await shoot(olga, "participant", "01-home", "dark");
  await setTheme(olga, "light");

  // ---- app/settings ----
  await olga.goto("/#/settings");
  await olga.waitForTimeout(500);
  await shoot(olga, "app", "settings", "light");
  await setTheme(olga, "dark");
  await shoot(olga, "app", "settings", "dark");
  await setTheme(olga, "light");

  // ---- Olga creates identity + event ----
  await newUser(olga, "Olga Organizer");
  await olga.goto("/#/create");
  await olga.getByLabel("Title").fill("Nostrautica Screenshot Assembly");
  await olga.getByLabel("Start").fill("2026-09-15T10:00");
  const talksSelect = olga.locator("#talks");
  if (await talksSelect.count()) await talksSelect.selectOption("on");
  await olga.waitForTimeout(300);
  await shoot(olga, "organizer", "01-create-form", "light");

  await olga.getByRole("button", { name: /create event/i }).click();
  await olga.getByText(/event created/i).waitFor({ timeout: 20000 });
  await olga.waitForTimeout(500);
  await shoot(olga, "organizer", "02-created", "light");
  const shareLink = await olga.locator(".mono").first().innerText();
  const naddr = shareLink.match(/#\/e\/([^/\s]+)/)?.[1];
  if (!naddr) throw new Error("no naddr captured");
  console.log("naddr:", naddr);

  // key backup card, if shown right after identity creation — capture via a
  // fresh persona at the moment "you're in" state includes a backup card.
  // (Olga's own creation flow already passed "you're in"; capture the backup
  // affordance from the "Me" page instead, which always has one.)

  // ---- organizer/03-admin-empty: admin with no pending requests yet ----
  await olga.goto(`/#/e/${naddr}/admin`);
  await olga.waitForTimeout(1500);
  await shoot(olga, "organizer", "03-admin-empty", "light");
  await copyIfExists(`${DOCS}/organizer/03-admin-empty-light.png`, `${WEB}/03-admin-empty-light.png`);

  // ---- organizer/04-invites ----
  const generateBtn = olga.getByRole("button", { name: /^generate$/i });
  if (await generateBtn.count()) {
    await generateBtn.first().click();
    await olga.waitForTimeout(1000);
    await shoot(olga, "organizer", "04-invites", "light");
  }

  // ---- Nina joins without a code (participant/02-event-page, 04-join-form, 05-request-sent) ----
  await nina.goto(`/#/e/${naddr}`);
  await nina.waitForTimeout(800);
  await shoot(nina, "participant", "02-event-page", "light");
  await copyIfExists(`${DOCS}/participant/02-event-page-light.png`, `${WEB}/02-event-page-light.png`);
  await setTheme(nina, "dark");
  await shoot(nina, "participant", "02-event-page", "dark");
  await copyIfExists(`${DOCS}/participant/02-event-page-dark.png`, `${WEB}/02-event-page-dark.png`);
  await setTheme(nina, "light");

  await nina.goto(`/#/e/${naddr}/join`);
  await nina.waitForTimeout(500);
  const ninaNameField = nina.getByLabel(/display name/i);
  if (await ninaNameField.count()) await ninaNameField.fill("Nina Newcomer");
  const aboutField = nina.getByLabel(/about you/i);
  if (await aboutField.count()) await aboutField.first().fill("New to Nostr, excited to meet people.");
  await nina.waitForTimeout(300);
  await shoot(nina, "participant", "04-join-form", "light");

  // Nina isn't logged in yet at this point — the button reads "Create identity
  // & join" (not "Send join request", which only appears once logged in).
  await nina.getByRole("button", { name: /create identity.*join/i }).click();
  await nina.getByText(/request sent/i).waitFor({ timeout: 20000 });
  await nina.waitForTimeout(500);
  await shoot(nina, "participant", "05-request-sent", "light");

  // Backup card, from Nina's fresh-identity flow (created during join) — check "Me".
  await nina.goto("/#/me");
  await nina.waitForTimeout(500);
  await shoot(nina, "participant", "03-backup", "light");

  // ---- organizer: pending + approve (organizer/06-pending, 07-approved) ----
  await olga.goto(`/#/e/${naddr}/admin`);
  await waitForWithReload(olga, olga.getByRole("button", { name: /^approve$/i }).first());
  await olga.waitForTimeout(500);
  await shoot(olga, "organizer", "06-pending", "light");

  await olga.getByRole("button", { name: /^approve$/i }).first().click();
  await olga.getByText(/approved ✓/i).nth(1).waitFor({ timeout: 20000 });
  await olga.waitForTimeout(500);
  await shoot(olga, "organizer", "07-approved", "light");
  await setTheme(olga, "dark");
  await shoot(olga, "organizer", "07-approved", "dark");
  await setTheme(olga, "light");

  // ---- Nadia (second attendee, existing-style flow simplified to a fresh identity) ----
  await newUser(nadia, "Nadia Nostrnative");
  await nadia.goto(`/#/e/${naddr}/join`);
  await nadia.waitForTimeout(500);
  await shoot(nadia, "participant", "07-signin-options", "light"); // best-effort: join form as an already-identified user
  await nadia.getByRole("button", { name: /send join request/i }).click();
  await nadia.getByText(/request sent/i).waitFor({ timeout: 20000 });

  await olga.goto(`/#/e/${naddr}/admin`);
  await waitForWithReload(olga, olga.getByRole("button", { name: /^approve$/i }).first());
  await olga.getByRole("button", { name: /^approve$/i }).first().click();
  try {
    await olga.getByText(/approved ✓/i).nth(2).waitFor({ timeout: 20000 });
  } catch {
    // Occasional transient relay congestion (documented in
    // docs/CACHING-VERIFICATION-2026-07-17.md) — reload once to flush any
    // queued publish, and give the pending-queue re-scan another chance.
    await olga.reload();
    await olga.waitForTimeout(3000);
    const stillPending = olga.getByRole("button", { name: /^approve$/i });
    if (await stillPending.count()) await stillPending.first().click();
    await olga.getByText(/approved ✓/i).nth(2).waitFor({ timeout: 20000 });
  }
  console.log("Nadia approved");

  // ---- Nina: "you're in" / approved state (participant/06-approved) ----
  await nina.goto(`/#/e/${naddr}`);
  await nina.getByText(/see who's here/i).waitFor({ timeout: 20000 });
  await nina.waitForTimeout(500);
  await shoot(nina, "participant", "06-approved", "light");
  await setTheme(nina, "dark");
  await shoot(nina, "participant", "06-approved", "dark");
  await setTheme(nina, "light");

  // ---- participant/08-attendees ----
  await nina.goto(`/#/e/${naddr}/attendees`);
  await nina.waitForTimeout(1500);
  await shoot(nina, "participant", "08-attendees", "light");
  await copyIfExists(`${DOCS}/participant/08-attendees-light.png`, `${WEB}/08-attendees-light.png`);
  await setTheme(nina, "dark");
  await shoot(nina, "participant", "08-attendees", "dark");
  await copyIfExists(`${DOCS}/participant/08-attendees-dark.png`, `${WEB}/08-attendees-dark.png`);
  await setTheme(nina, "light");

  // ---- participant/10-attendee-detail: Nina opens Nadia's card ----
  const openButtons = nina.locator(".roster button.open");
  const rosterCount = await openButtons.count();
  for (let i = 0; i < rosterCount; i++) {
    await openButtons.nth(i).click();
    await nina.waitForTimeout(500);
    const bodyText = await nina.locator("main").innerText().catch(() => "");
    if (/Nadia/i.test(bodyText)) break;
    await nina.goBack();
    await nina.waitForTimeout(400);
  }
  await nina.waitForTimeout(500);
  await shoot(nina, "participant", "10-attendee-detail", "light");
  await setTheme(nina, "dark");
  await shoot(nina, "participant", "10-attendee-detail", "dark");
  await setTheme(nina, "light");

  // ---- participant/09-record: recording UI mid-capture (video, fake device) ----
  await nina.goto(`/#/e/${naddr}/record`);
  await nina.waitForTimeout(500);
  const enableCam = nina.getByRole("button", { name: /^enable camera$/i });
  if (await enableCam.count()) await enableCam.click();
  await nina.waitForTimeout(500);
  const recordBtn = nina.getByRole("button", { name: /^record$/i });
  if (await recordBtn.count()) {
    await recordBtn.click();
    await nina.waitForTimeout(1200);
    await shoot(nina, "participant", "09-record", "light");
    const stopBtn = nina.getByRole("button", { name: /stop/i });
    if (await stopBtn.count()) await stopBtn.click();
  }

  // ---- organizer/09-posts-editor + participant/12-posts-feed ----
  await olga.goto(`/#/e/${naddr}/admin`);
  await olga.waitForTimeout(800);
  const titleField = olga.getByRole("textbox", { name: /^title$/i });
  if (await titleField.count()) {
    await titleField.fill("Welcome to the assembly");
    await olga.locator("textarea").first().fill("Looking forward to seeing everyone — schedule and details inside.");
    await olga.waitForTimeout(300);
    await shoot(olga, "organizer", "09-posts-editor", "light");
    const publishBtn = olga.getByRole("button", { name: /^publish post$/i });
    if (await publishBtn.count()) {
      await publishBtn.click();
      await olga.getByText("Welcome to the assembly", { exact: false }).first().waitFor({ timeout: 15000 });
    }
  }

  await nina.goto(`/#/e/${naddr}/posts`);
  await nina.waitForTimeout(1500);
  await shoot(nina, "participant", "12-posts-feed", "light");

  // ---- participant/13-me ----
  await nina.goto("/#/me");
  await nina.waitForTimeout(500);
  await shoot(nina, "participant", "13-me", "light");
  await copyIfExists(`${DOCS}/participant/13-me-light.png`, `${WEB}/13-me-light.png`);
  await setTheme(nina, "dark");
  await shoot(nina, "participant", "13-me", "dark");
  await copyIfExists(`${DOCS}/participant/13-me-dark.png`, `${WEB}/13-me-dark.png`);
  await setTheme(nina, "light");

  // ---- organizer/08-revoke ----
  await olga.goto(`/#/e/${naddr}/admin`);
  await waitForWithReload(olga, olga.getByText(/approved ✓/i).nth(2));
  const revokeButtons = olga.getByRole("button", { name: /^revoke$/i });
  if (await revokeButtons.count()) {
    await revokeButtons.first().click();
    await olga.waitForTimeout(500);
    await shoot(olga, "organizer", "08-revoke", "light");
  }

  // ---- Talks list, empty-ish state (web/assets 26-talks-empty) ----
  await olga.goto(`/#/e/${naddr}/talks`);
  await olga.waitForTimeout(1500);
  await shoot(olga, "participant", "26-talks-empty", "light");
  await copyIfExists(`${DOCS}/participant/26-talks-empty-light.png`, `${WEB}/26-talks-empty-light.png`);
  await setTheme(olga, "dark");
  await shoot(olga, "participant", "26-talks-empty", "dark");
  await copyIfExists(`${DOCS}/participant/26-talks-empty-dark.png`, `${WEB}/26-talks-empty-dark.png`);
  await setTheme(olga, "light");

  // ---- Otto (outsider): participant/12-outsider ----
  await newUser(otto, "Otto Outsider");
  await otto.goto(`/#/e/${naddr}`);
  await otto.waitForTimeout(800);
  await shoot(otto, "participant", "12-outsider", "light");
  await setTheme(otto, "dark");
  await shoot(otto, "participant", "12-outsider", "dark");
  await setTheme(otto, "light");

  await browser.close();
  console.log(`\nCaptured ${shots.length} screenshots.`);
}

function copyIfExists(src, dest) {
  try {
    if (existsSync(src)) copyFileSync(src, dest);
  } catch {
    /* best-effort mirror into web/assets/screenshots */
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
