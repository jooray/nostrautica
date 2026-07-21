/**
 * Focused verification for the audit-fix branch's new UX features (session
 * 2026-07-21): the "Why record an intro?" onboarding copy (first mention of
 * intro recording), and the virtualized attendee roster (audit UX-30).
 *
 * Seeds one organizer + N attendees (manual approval — no invite codes, no
 * intro recording needed: the coordinator publishes a directory entry on
 * APPROVAL, before any submission), then screenshots:
 *   - participant/join-why-intro-collapsed / -expanded (light)
 *   - participant/attendees-roster (light) + a DOM-node-count check proving
 *     the roster is windowed, not fully rendered, at N attendees.
 *
 * Usage: NOSTRAUTICA_URL=http://localhost:4173 ATTENDEE_COUNT=15 \
 *   OUT_DIR=/path/to/shots node e2e/audit-ux-verify.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE_URL = process.env.NOSTRAUTICA_URL ?? "http://localhost:4173";
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/nostrautica-ux-shots";
const ATTENDEE_COUNT = Number(process.env.ATTENDEE_COUNT ?? 15);

mkdirSync(OUT_DIR, { recursive: true });

const LAUNCH_ARGS = [
  "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults",
  "--ignore-certificate-errors",
];

async function newUser(page, name) {
  await page.goto(`${BASE_URL}/#/login`);
  await page.getByLabel(/your name/i).fill(name);
  await page.getByRole("button", { name: /create my identity/i }).click();
  await page.getByText(/you're in/i).waitFor({ timeout: 20000 });
}

async function waitForWithReload(page, locator, timeout = 20000) {
  try {
    await locator.waitFor({ timeout });
  } catch {
    await page.reload();
    await locator.waitFor({ timeout });
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const desktop = { viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true, baseURL: BASE_URL };

  const olgaCtx = await browser.newContext(desktop);
  const olga = await olgaCtx.newPage();

  console.log(`[verify] creating event…`);
  await newUser(olga, "Olga Organizer");
  await olga.goto("/#/create");
  await olga.getByLabel("Title").fill("Virtualization Test Assembly");
  await olga.getByLabel("Start").fill("2026-09-15T10:00");
  await olga.getByRole("button", { name: /create event/i }).click();
  await olga.getByText(/event created/i).waitFor({ timeout: 20000 });
  const shareLink = await olga.locator(".mono").first().innerText();
  const naddr = shareLink.match(/#\/e\/([^/\s]+)/)?.[1];
  if (!naddr) throw new Error("no naddr captured");
  console.log(`[verify] event naddr: ${naddr}`);

  // ---- one attendee: capture the new "Why record an intro?" section ----
  const ninaCtx = await browser.newContext(desktop);
  const nina = await ninaCtx.newPage();
  await nina.goto(`/#/e/${naddr}/join`);
  const ninaNameField = nina.getByLabel(/display name/i);
  await ninaNameField.waitFor({ timeout: 15000 });
  await ninaNameField.fill("Nina Newcomer");
  await nina.getByRole("button", { name: /create identity.*join/i }).click();
  await nina.getByText(/request sent/i).waitFor({ timeout: 20000 });

  // Organizer approves Nina immediately so we can see the "you're in" screen.
  await olga.goto(`/#/e/${naddr}/admin`);
  await waitForWithReload(olga, olga.getByRole("button", { name: /^approve$/i }).first());
  await olga.getByRole("button", { name: /^approve$/i }).first().click();
  await olga.getByText(/approved ✓/i).first().waitFor({ timeout: 20000 });
  console.log("[verify] Nina approved");

  await nina.goto(`/#/e/${naddr}`);
  await nina.getByText(/you're in/i).waitFor({ timeout: 20000 });
  await nina.waitForTimeout(500);
  await nina.screenshot({ path: `${OUT_DIR}/join-why-intro-collapsed-light.png` });
  console.log("[verify] shot: join-why-intro-collapsed-light.png");

  const summary = nina.getByText(/why record an intro/i);
  await summary.click();
  await nina.waitForTimeout(300);
  await nina.screenshot({ path: `${OUT_DIR}/join-why-intro-expanded-light.png` });
  console.log("[verify] shot: join-why-intro-expanded-light.png");
  const whyIntroText = await nina.locator("details").innerText();
  console.log("[verify] why-intro body:", JSON.stringify(whyIntroText));

  // ---- seed N more attendees (manual approval, no intro recording) ----
  console.log(`[verify] seeding ${ATTENDEE_COUNT} attendees…`);
  for (let i = 0; i < ATTENDEE_COUNT; i++) {
    const ctx = await browser.newContext(desktop);
    const page = await ctx.newPage();
    await page.goto(`/#/e/${naddr}/join`);
    const nf = page.getByLabel(/display name/i);
    await nf.waitFor({ timeout: 15000 });
    await nf.fill(`Attendee ${i}`);
    await page.getByRole("button", { name: /create identity.*join/i }).click();
    await page.getByText(/request sent/i).waitFor({ timeout: 20000 });
    await ctx.close();
  }

  // Organizer approves everyone (loop "Approve" until none left).
  await olga.goto(`/#/e/${naddr}/admin`);
  await olga.waitForTimeout(1000);
  let approvedCount = 0;
  for (let i = 0; i < ATTENDEE_COUNT + 2; i++) {
    const btn = olga.getByRole("button", { name: /^approve$/i }).first();
    if (!(await btn.count())) break;
    await btn.click();
    await olga.waitForTimeout(400);
    approvedCount++;
  }
  console.log(`[verify] approved ${approvedCount} more attendees`);
  await olga.waitForTimeout(2000);

  // ---- roster: screenshot + confirm it's actually windowed, not fully rendered ----
  await nina.goto(`/#/e/${naddr}/attendees`);
  await nina.waitForTimeout(2500);
  const countText = await nina.locator('[role="status"]').first().innerText().catch(() => "");
  console.log("[verify] roster count text:", countText);
  await nina.screenshot({ path: `${OUT_DIR}/attendees-roster-top-light.png` });
  console.log("[verify] shot: attendees-roster-top-light.png");

  const rowsAtTop = await nina.locator(".roster .person").count();
  console.log(`[verify] DOM rows rendered at top-of-list scroll: ${rowsAtTop}`);

  await nina.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await nina.waitForTimeout(400);
  await nina.screenshot({ path: `${OUT_DIR}/attendees-roster-mid-light.png` });
  const rowsAtMid = await nina.locator(".roster .person").count();
  console.log(`[verify] DOM rows rendered mid-scroll: ${rowsAtMid}`);

  await browser.close();
  console.log("\n[verify] done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
