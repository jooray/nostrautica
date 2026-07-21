/**
 * Per-page time-to-full-display measurement (CACHING-PLAN §5, caching
 * verification 2026-07-17). Standalone script (not a Playwright test — it
 * needs full manual control of navigation timing and IndexedDB inspection)
 * driven by `chromium` from @playwright/test.
 *
 * For each instrumented page it measures, via `window.__nostrauticaPerf`:
 *   - COLD:        first-ever visit in this browser profile (empty
 *                   nostrautica-appcache for this data).
 *   - WARM-NAV:    navigate away (Home) and back, same session, no reload.
 *   - WARM-RELOAD: page.reload() — the persistent cache's whole point.
 *
 * Usage: node e2e/perf-measure.mjs
 * Requires: relay :7777, blossom (https-proxied to :8443 for the record flow),
 * and the app preview server already running per docs/E2E-TESTING-GUIDE.md.
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const BASE_URL = process.env.NOSTRAUTICA_URL ?? "http://localhost:4173";
const OUT_JSON = new URL("./perf-results.json", import.meta.url).pathname;
const OUT_MD = new URL("./perf-results.md", import.meta.url).pathname;

const LAUNCH_ARGS = [
  "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--ignore-certificate-errors",
];

/** Read window.__nostrauticaPerf marks recorded since `since` (ms epoch). */
async function readPerf(page) {
  return page.evaluate(() => window.__nostrauticaPerf ?? []);
}

/** Clear the in-page perf buffer (fresh slate before a navigation we're timing). */
async function clearPerf(page) {
  await page.evaluate(() => {
    window.__nostrauticaPerf = [];
  });
}

/** Wait for network-settled (or cache-paint-only, if no network phase fires) up to timeoutMs. */
async function waitForSettle(page, pageName, timeoutMs = 25000) {
  const start = Date.now();
  let marks = [];
  while (Date.now() - start < timeoutMs) {
    marks = await readPerf(page);
    const settled = marks.find((m) => m.page === pageName && m.phase === "network-settled");
    if (settled) return marks;
    await page.waitForTimeout(300);
  }
  return marks;
}

function pick(marks, pageName) {
  const cachePaint = marks.find((m) => m.page === pageName && m.phase === "cache-paint");
  const settled = marks.find((m) => m.page === pageName && m.phase === "network-settled");
  return { cachePaintMs: cachePaint?.ms ?? null, networkSettledMs: settled?.ms ?? null };
}

async function measure(page, pageName, url) {
  await clearPerf(page);
  const navStart = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const marks = await waitForSettle(page, pageName);
  const result = pick(marks, pageName);
  console.log(
    `  ${pageName.padEnd(12)} cache-paint=${result.cachePaintMs ?? "—"}ms  network-settled=${result.networkSettledMs ?? "—"}ms  (wall ${Date.now() - navStart}ms)`,
  );
  return result;
}

async function measureReload(page, pageName) {
  await clearPerf(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  const marks = await waitForSettle(page, pageName);
  return pick(marks, pageName);
}

async function newUser(page, name) {
  await page.goto(`${BASE_URL}/#/login`);
  await page.getByLabel(/your name/i).fill(name);
  await page.getByRole("button", { name: /create my identity/i }).click();
  await page.getByText(/you're in/i).waitFor({ timeout: 20000 });
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const results = {}; // pageName -> { cold, warmNav, warmReload }

  // ---- Setup: organizer + 2 approved attendees + directory content + posts +
  // a talk + a DM, all under one event, per docs/E2E-TESTING-GUIDE walking-
  // skeleton / join-approve-directory patterns. ----
  const orgCtx = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 390, height: 844 },
    permissions: ["camera", "microphone"],
    ignoreHTTPSErrors: true,
  });
  const aliceCtx = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 390, height: 844 },
    permissions: ["camera", "microphone"],
    ignoreHTTPSErrors: true,
  });
  const bobCtx = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 390, height: 844 },
    permissions: ["camera", "microphone"],
    ignoreHTTPSErrors: true,
  });

  const organizer = await orgCtx.newPage();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  console.log("Setting up event + attendees + content...");
  await newUser(organizer, "Perf Organizer");
  await newUser(alice, "Perf Alice");
  await newUser(bob, "Perf Bob");

  await organizer.goto("/#/create");
  await organizer.getByLabel("Title").fill("Perf Measurement Event");
  await organizer.getByLabel("Start").fill("2026-09-01T10:00");
  await organizer.locator("#talks").selectOption("on");
  await organizer.getByRole("button", { name: /create event/i }).click();
  await organizer.getByText(/event created/i).waitFor({ timeout: 20000 });
  const shareLink = await organizer.locator(".mono").first().innerText();
  const naddr = shareLink.match(/#\/e\/([^/\s]+)/)?.[1];
  if (!naddr) throw new Error("no naddr captured");
  console.log("naddr:", naddr);

  for (const p of [alice, bob]) {
    await p.goto(`/#/e/${naddr}/join`);
    await p.getByRole("button", { name: /send join request/i }).click();
    await p.getByText(/request sent/i).waitFor({ timeout: 20000 });
  }

  await organizer.goto(`/#/e/${naddr}/admin`);
  await organizer.getByRole("button", { name: /^approve$/i }).first().waitFor({ timeout: 20000 });
  const approveAll = organizer.getByRole("button", { name: /approve all/i });
  if (await approveAll.count()) await approveAll.first().click();
  else {
    const buttons = organizer.getByRole("button", { name: /^approve$/i });
    const n = await buttons.count();
    for (let i = 0; i < n; i++) await buttons.first().click();
  }
  await organizer.getByText(/approved ✓/i).nth(2).waitFor({ timeout: 20000 });
  console.log("organizer + alice + bob all approved");

  // Alice: text intro (fast, avoids camera/blossom entirely) so her directory
  // entry + attendee-detail page have content.
  await alice.goto(`/#/e/${naddr}`);
  await alice.getByText(/see who's here/i).waitFor({ timeout: 20000 });
  await alice.goto(`/#/e/${naddr}/record`);
  await alice.getByRole("tab", { name: /^text$/i }).click();
  await alice.locator("input[type=checkbox]").first().check();
  await alice.locator("textarea").last().fill("Hi, I'm Alice. Perf measurement fixture attendee.");
  await alice.getByRole("button", { name: /use this intro/i }).click();
  await alice.getByText(/uploaded/i).waitFor({ timeout: 30000 });
  console.log("alice text intro submitted");

  // Pull Alice's just-submitted text intro into her directory entry (no-
  // coordinator flow — organizer.ts's fetchPending/approveAttendee) via the
  // admin "Re-process" button.
  await organizer.goto(`/#/e/${naddr}/admin`);
  await organizer.getByText(/approved ✓/i).first().waitFor({ timeout: 20000 });
  await organizer.getByRole("button", { name: /^re-process$/i }).nth(1).click();
  await organizer.waitForTimeout(4000);

  // Alice's own npub, straight from her "Me" page (simpler and more reliable
  // than hunting for her card in the roster by content).
  await alice.goto("/#/me");
  await alice.waitForTimeout(1000);
  const aliceNpub = await alice.locator("p.mono").first().innerText().catch(() => undefined);
  console.log("alice npub:", aliceNpub ?? "(not found — Attendee page will be skipped)");

  // Organizer publishes a public post + a members-only post so Posts/Post have content.
  await organizer.goto(`/#/e/${naddr}/admin`);
  await organizer.getByRole("textbox", { name: /^title$/i }).fill("Perf Public Post");
  await organizer.locator("textarea").first().fill("Public post body for perf measurement.");
  await organizer.getByRole("button", { name: /^publish post$/i }).click();
  await organizer.getByText("Perf Public Post", { exact: false }).first().waitFor({ timeout: 15000 });
  console.log("public post published");

  // Capture the post's `d` for the Post-detail perf page.
  await organizer.goto(`/#/e/${naddr}/posts`);
  await organizer.waitForTimeout(2000);
  await organizer.getByText(/read ›/i).first().click();
  await organizer.waitForTimeout(1000);
  const postUrl = organizer.url();
  console.log("post url:", postUrl);

  // Alice sends a DM to the organizer so Dm/DmChat have content.
  await alice.goto(`/#/e/${naddr}/attendees`);
  await alice.waitForTimeout(2000);
  const aliceOpenButtons = alice.locator(".roster button.open");
  const aliceRosterCount = await aliceOpenButtons.count();
  for (let i = 0; i < aliceRosterCount; i++) {
    await aliceOpenButtons.nth(i).click();
    await alice.waitForTimeout(500);
    const bodyText = await alice.locator("main").innerText().catch(() => "");
    if (/perf organizer/i.test(bodyText) || /^Perf Organizer/i.test(bodyText)) {
      const sendBtn = alice.getByRole("button", { name: /send message|message/i });
      if (await sendBtn.count()) {
        await sendBtn.first().click();
        await alice.waitForTimeout(1000);
        const box = alice.locator("textarea, input[type=text]").last();
        if (await box.count()) {
          await box.fill("Hi organizer, perf measurement DM fixture.");
          const submit = alice.getByRole("button", { name: /^send$/i });
          if (await submit.count()) await submit.first().click();
        }
      }
      break;
    }
    await alice.goBack();
    await alice.waitForTimeout(500);
  }
  await alice.waitForTimeout(3000);
  console.log("alice DM attempt done");

  // Get organizer's DM peer URL (their inbox thread with Alice), if it landed.
  await organizer.goto("/#/dm");
  await organizer.waitForTimeout(4000);
  let dmPeerUrl;
  const dmThreads = organizer.locator("a, button").filter({ hasText: /Perf Alice/i });
  if (await dmThreads.count()) {
    await dmThreads.first().click();
    await organizer.waitForTimeout(1000);
    dmPeerUrl = organizer.url();
  }
  console.log("dm peer url:", dmPeerUrl ?? "(not found — Dm/DmChat measured from inbox only)");

  console.log("\n=== Setup complete. Beginning perf measurement ===\n");

  // ---- Page list + URL resolvers (organizer's session for all, per the
  // measurement's practical scope — see report methodology note). ----
  const pages = [
    { name: "Home", url: "/#/" },
    { name: "EventHome", url: `/#/e/${naddr}` },
    { name: "Attendees", url: `/#/e/${naddr}/attendees` },
    ...(aliceNpub ? [{ name: "Attendee", url: `/#/e/${naddr}/attendees/${aliceNpub}` }] : []),
    { name: "Matches", url: `/#/e/${naddr}/matches` },
    { name: "Posts", url: `/#/e/${naddr}/posts` },
    ...(postUrl ? [{ name: "Post", url: postUrl.replace(BASE_URL, "") }] : []),
    { name: "Talks", url: `/#/e/${naddr}/talks` },
    { name: "Admin", url: `/#/e/${naddr}/admin` },
    { name: "Dm", url: "/#/dm" },
    ...(dmPeerUrl ? [{ name: "DmChat", url: dmPeerUrl.replace(BASE_URL, "") }] : []),
    { name: "Record", url: `/#/e/${naddr}/record` },
  ];

  console.log("Pages to measure:", pages.map((p) => p.name).join(", "));
  console.log("(TalkDetail skipped: no organizer moderation UI publishes a submitted talk in\n" +
    " Tier 1/no-coordinator mode — known gap, docs/FEATURE-VERIFICATION-2026-07-16.md G-1 —\n" +
    " so there is no reachable talk detail URL to measure.)\n");

  for (const { name, url } of pages) {
    console.log(`\n[${name}] COLD`);
    const cold = await measure(organizer, name, url);

    console.log(`[${name}] WARM-NAV (away, back)`);
    // "Away" must be a DIFFERENT route than the one under test, or the SPA
    // router sees no route change and never re-fires perfMark's route-change
    // timer (this bit Home, whose own away-target used to be "/#/" too).
    const away = name === "Home" ? `/#/e/${naddr}` : "/#/";
    await organizer.goto(away);
    await organizer.waitForTimeout(300);
    const warmNav = await measure(organizer, name, url);

    console.log(`[${name}] WARM-RELOAD`);
    const warmReload = await measureReload(organizer, name);
    console.log(
      `  ${name.padEnd(12)} cache-paint=${warmReload.cachePaintMs ?? "—"}ms  network-settled=${warmReload.networkSettledMs ?? "—"}ms`,
    );

    results[name] = { cold, warmNav, warmReload };
  }

  // ---- Prove cache-first paint survives reload with the relay unreachable. ----
  console.log("\n=== Relay-killed reload check (EventHome) ===");
  const idbExists = await organizer.evaluate(async () => {
    const dbs = await indexedDB.databases();
    return dbs.some((d) => d.name === "nostrautica-appcache");
  });
  console.log("nostrautica-appcache IDB present:", idbExists);

  await organizer.goto(`/#/e/${naddr}`);
  await organizer.waitForTimeout(1000);
  // Stop the relay container outright (page.route() does not reliably
  // intercept WebSocket connections on this Playwright version, so a route()
  // "block" still let the socket through) — this guarantees the relay is
  // genuinely unreachable, so any paint MUST come from the persistent cache.
  execSync("docker stop docker-relay-1", { stdio: "ignore" });
  let killedPaint;
  let killedSettled;
  let bodyTextBlocked = "";
  try {
    await clearPerf(organizer);
    const reloadStart = Date.now();
    await organizer.reload({ waitUntil: "domcontentloaded" });
    const killedMarks = await waitForSettle(organizer, "EventHome", 6000);
    killedPaint = killedMarks.find((m) => m.page === "EventHome" && m.phase === "cache-paint");
    killedSettled = killedMarks.find((m) => m.page === "EventHome" && m.phase === "network-settled");
    console.log(
      `Relay-stopped reload: cache-paint=${killedPaint?.ms ?? "NONE"}ms, network-settled=${killedSettled?.ms ?? "NONE (expected — relay stopped)"} (wall ${Date.now() - reloadStart}ms)`,
    );
    bodyTextBlocked = await organizer.locator("main").innerText().catch(() => "");
  } finally {
    execSync("docker start docker-relay-1", { stdio: "ignore" });
  }
  const paintedContent = /Perf Measurement Event|see who's here|Approved/i.test(bodyTextBlocked);
  console.log("Page shows real content with relay stopped (cache-driven paint):", paintedContent);

  const relayKilledCheck = {
    idbExists,
    cachePaintMs: killedPaint?.ms ?? null,
    networkSettledFired: !!killedSettled,
    paintedRealContent: paintedContent,
  };

  await browser.close();

  // ---- Write results ----
  writeFileSync(OUT_JSON, JSON.stringify({ naddr, results, relayKilledCheck }, null, 2));

  const rows = Object.entries(results).map(([name, r]) => {
    const f = (x) => (x === null ? "—" : `${x}ms`);
    return `| ${name} | ${f(r.cold.cachePaintMs)} | ${f(r.cold.networkSettledMs)} | ${f(r.warmNav.cachePaintMs)} | ${f(r.warmNav.networkSettledMs)} | ${f(r.warmReload.cachePaintMs)} | ${f(r.warmReload.networkSettledMs)} |`;
  });
  const md = `# Per-page time-to-full-display (${new Date().toISOString()})

naddr: \`${naddr}\`

| Page | Cold cache-paint | Cold network-settled | Warm-nav cache-paint | Warm-nav network-settled | Warm-reload cache-paint | Warm-reload network-settled |
|---|---|---|---|---|---|---|
${rows.join("\n")}

## Relay-blocked reload check (EventHome)

- \`nostrautica-appcache\` IndexedDB present: **${relayKilledCheck.idbExists}**
- Reload with relay blocked — cache-paint: **${relayKilledCheck.cachePaintMs ?? "NONE"}ms**
- network-settled fired despite blocked relay: **${relayKilledCheck.networkSettledFired}** (expect false)
- Page rendered real event content with the relay blocked: **${relayKilledCheck.paintedRealContent}**
`;
  writeFileSync(OUT_MD, md);
  console.log("\nWrote", OUT_JSON, "and", OUT_MD);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
