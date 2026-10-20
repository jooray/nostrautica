import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { newUser, ownPubkeyHex } from "../helpers.js";

/**
 * Space hierarchy E2E (PROTOCOL-NIP.md §15): a community and the dated events that
 * belong to it. Membership flows UP only — approval for a linked event lets a person
 * join the community without a second approval.
 *
 * Coordinator tier (chat/full): the community and its events each have the chat
 * coordinator double attached, which is what auto-approves a `member_of` join. The
 * double tees its console to NOSTRAUTICA_E2E_COORDINATOR_LOG so the first scenario
 * can assert on the daemon's DECISION ("AUTO-APPROVED"), not only on what the UI
 * shows afterwards.
 *
 * One shared stack, serial: the setup (two spaces, linked, with invites) is the
 * expensive part, and later scenarios build on earlier state.
 *
 *   S1  organizer creates a community + a linked event; both Overviews show the link
 *   S2  invite-join the EVENT with the disclosure ON → auto-approved into the COMMUNITY
 *   S3  same with the disclosure OFF → event member only, no community, no offer
 *   S4  approved BEFORE the link existed → coordinator re-issues a proof → one-tap offer
 *   S5  a direct join to the community (its own invite code) is unaffected
 *   S6  manual-approval community with no coordinator: admin queue badges verified
 *       event members and "approve verified" works
 */
const COORD_NPUB = process.env.NOSTRAUTICA_E2E_COORDINATOR_NPUB;
const COORD_LOG = process.env.NOSTRAUTICA_E2E_COORDINATOR_LOG;
const RELAY_UP = !!process.env.NOSTRAUTICA_E2E_RELAY;

const RUN = Date.now().toString(36);
const COMMUNITY = `Hier Community ${RUN}`;
const EVENT = `Hier Meetup ${RUN}`;
const EARLY_EVENT = `Hier Early Meetup ${RUN}`;
const MANUAL_COMMUNITY = `Hier Manual Community ${RUN}`;
const MANUAL_EVENT = `Hier Manual Meetup ${RUN}`;

function coordinatorLog(): string {
  try {
    return COORD_LOG ? readFileSync(COORD_LOG, "utf8") : "";
  } catch {
    return "";
  }
}

async function naddrFromCreated(page: Page): Promise<string> {
  await expect(page.getByText(/event created|community created|created/i).first()).toBeVisible({ timeout: 30_000 });
  const shareLink = await page.locator(".mono").first().innerText();
  const naddr = shareLink.match(/#\/e\/([^/\s?]+)/)?.[1];
  if (!naddr) throw new Error("no naddr captured from the share link: " + shareLink);
  return naddr;
}

/** Attach the coordinator double on the settings page (same flow as chat-helpers). */
async function attachCoordinator(page: Page, naddr: string): Promise<void> {
  await page.goto(`/#/e/${naddr}/settings`);
  const already = page.getByText(/coordinator attached/i);
  const paste = page.locator("details").filter({ hasText: /paste.*npub/i });
  await expect(paste.or(already).first()).toBeVisible({ timeout: 30_000 });
  if (await paste.count()) {
    await paste.locator("summary").click();
    await paste.locator('input[placeholder*="coordinator" i]').fill(COORD_NPUB!);
    await page.getByRole("button", { name: /attach coordinator/i }).first().click();
    await expect(page.getByText(/coordinator attached/i)).toBeVisible({ timeout: 30_000 });
  }
}

/** Same-hash goto is not a navigation: after a create the receipt would stay on screen. */
async function openCreate(page: Page): Promise<void> {
  await page.goto("/#/");
  await page.goto("/#/create");
}

async function createCommunity(page: Page, title: string, approval: "manual" | "invite" | "manual+invite"): Promise<string> {
  await openCreate(page);
  await page.getByRole("button", { name: /^a community$/i }).click();
  await page.getByLabel("Title").fill(title);
  await page.locator("#approval").selectOption(approval);
  await page.getByRole("button", { name: /create community/i }).click();
  return naddrFromCreated(page);
}

/** Create a dated event; `parentTitle` picks it in the "Part of a community" picker. */
async function createEvent(
  page: Page,
  title: string,
  opts: { parentTitle?: string; approval?: "manual" | "invite" | "manual+invite" } = {},
): Promise<string> {
  await openCreate(page);
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Start").fill("2099-09-01T10:00");
  await page.locator("#match").selectOption("off");
  if (opts.approval) await page.locator("#approval").selectOption(opts.approval);
  if (opts.parentTitle) {
    // The picker fills in from the keystore asynchronously: wait for the option.
    await expect(page.locator("#parent option", { hasText: opts.parentTitle })).toHaveCount(1, { timeout: 20_000 });
    await page.locator("#parent").selectOption({ label: opts.parentTitle });
  }
  await page.getByRole("button", { name: /create event/i }).click();
  return naddrFromCreated(page);
}

/** Generate invite codes and return the first `n` links. */
async function inviteLinks(page: Page, naddr: string, n: number): Promise<string[]> {
  await page.goto(`/#/e/${naddr}/admin`);
  const generate = page.locator('.row:has(input[type="number"]) button').first();
  await generate.waitFor({ timeout: 30_000 });
  await generate.click();
  const links = page.locator("p.mono", { hasText: "code=" });
  await expect(links.first()).toBeVisible({ timeout: 30_000 });
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push((await links.nth(i).innerText()).trim());
  return out;
}

function hashPath(link: string): string {
  return "/" + link.slice(link.indexOf("#"));
}

/** Open an invite link as `page`, optionally untick the community disclosure, send. */
async function joinWithInvite(page: Page, link: string, opts: { communityTitle?: string; consent?: boolean } = {}): Promise<void> {
  await page.goto(hashPath(link));
  if (opts.communityTitle) {
    const box = page.getByRole("checkbox", { name: new RegExp(`join the community ${opts.communityTitle}`, "i") });
    await expect(box).toBeVisible({ timeout: 30_000 });
    await expect(box).toBeChecked(); // §15.5: on by default
    if (opts.consent === false) await box.uncheck();
  }
  await page.getByRole("button", { name: /send join request/i }).click();
}

async function expectApproved(page: Page, naddr: string): Promise<void> {
  await expect(async () => {
    await page.goto(`/#/e/${naddr}`);
    await expect(page.getByText(/see who's here/i)).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 90_000, intervals: [3_000] });
}

test.describe.serial(
  COORD_NPUB && RELAY_UP ? "space hierarchy" : "space hierarchy (needs coordinator — skipped)",
  () => {
    test.skip(!COORD_NPUB || !RELAY_UP, "run via `pnpm e2e:chat` / `pnpm e2e:full` — needs the chat coordinator double");

    let ctxs: BrowserContext[] = [];
    let olga: Page;
    let communityNaddr: string;
    let eventNaddr: string;
    let invites: string[];

    test.afterAll(async () => {
      for (const c of ctxs) await c.close().catch(() => {});
    });

    async function user(browser: import("@playwright/test").Browser, name: string): Promise<Page> {
      const c = await browser.newContext();
      ctxs.push(c);
      return newUser(c, name);
    }

    test("S1 — organizer links an event to a community; both Overviews show it", async ({ browser }) => {
      test.setTimeout(240_000);
      olga = await user(browser, "Olga Hier");
      communityNaddr = await createCommunity(olga, COMMUNITY, "manual");
      await attachCoordinator(olga, communityNaddr);

      // The picker only offers communities this device organizes.
      eventNaddr = await createEvent(olga, EVENT, { parentTitle: COMMUNITY });
      await attachCoordinator(olga, eventNaddr);

      // Community Overview lists the event; the row opens it.
      await olga.goto(`/#/e/${communityNaddr}`);
      const row = olga.getByRole("button", { name: `Open event ${EVENT}` });
      await expect(row).toBeVisible({ timeout: 45_000 });

      // Event Overview links back.
      await olga.goto(`/#/e/${eventNaddr}`);
      const back = olga.getByRole("button", { name: `Open the community ${COMMUNITY}` });
      await expect(back).toBeVisible({ timeout: 45_000 });
      await back.click();
      await expect(olga).toHaveURL(new RegExp(communityNaddr), { timeout: 20_000 });
      await expect(olga.getByRole("button", { name: `Open event ${EVENT}` })).toBeVisible({ timeout: 30_000 });

      // The settings picker shows the saved link and the community lists the child
      // with its remove control.
      await olga.goto(`/#/e/${eventNaddr}/settings`);
      await expect(olga.locator("#hier-parent")).toHaveValue(/^31612:/, { timeout: 30_000 });
      await olga.goto(`/#/e/${communityNaddr}/settings`);
      await expect(olga.getByRole("button", { name: `Remove ${EVENT} from this community` })).toBeVisible({ timeout: 30_000 });

      invites = await inviteLinks(olga, eventNaddr, 4);
    });

    test("S2 — joining the event with the disclosure on makes the person a community member", async ({ browser }) => {
      test.setTimeout(240_000);
      const nina = await user(browser, "Nina Joiner");
      // The daemon logs a join decision as `[join] <first 8 hex of the attendee
      // pubkey> invite=yes|no [member_of <child>] → AUTO-APPROVED` (coordinator.ts,
      // entitlement.ts). The attendee pubkey is the signer's own, the one /#/me shows.
      const ninaShort = (await ownPubkeyHex(nina)).slice(0, 8);
      await joinWithInvite(nina, invites[0], { communityTitle: COMMUNITY });
      await expectApproved(nina, eventNaddr);

      // Automatically a member of the community: the coordinator decided it, on
      // the member_of proof. Scoped to NINA, no invite, granted by member_of (audit
      // SB-60). Her event join used a valid invite and logs `invite=yes →
      // AUTO-APPROVED` first, and the log is cumulative across the suite, so the old
      // bare /AUTO-APPROVED/ (behind a poll whose /member_of/i disjunct any mention
      // satisfied) passed even if the community join was granted some other way.
      const communityDecision = new RegExp(`\\[join\\] ${ninaShort} invite=no member_of .*→ AUTO-APPROVED`);
      await expect.poll(() => communityDecision.test(coordinatorLog()), { timeout: 90_000 }).toBe(true);

      // ...and so does the app: the community opens as a member and Nina is on its roster.
      await expectApproved(nina, communityNaddr);
      await olga.goto(`/#/e/${communityNaddr}/attendees`);
      await expect(olga.getByText("Nina Joiner").first()).toBeVisible({ timeout: 60_000 });
      // The event page says nothing more to her: she is in, no offer card.
      await nina.goto(`/#/e/${eventNaddr}`);
      await expect(nina.getByRole("region", { name: "Community invitation" })).toHaveCount(0);
    });

    test("S3 — disclosure off: event member only, never joined, never nagged", async ({ browser }) => {
      test.setTimeout(240_000);
      const omar = await user(browser, "Omar Optout");
      await joinWithInvite(omar, invites[1], { communityTitle: COMMUNITY, consent: false });
      await expectApproved(omar, eventNaddr);

      // Give a wrongly-automatic join time to happen before asserting it did not.
      await omar.waitForTimeout(12_000);
      await omar.goto(`/#/e/${eventNaddr}`);
      await expect(omar.getByText(/see who's here/i)).toBeVisible();
      // No card: "no" at the form is an answer; only a person who was never asked is offered.
      await expect(omar.getByRole("region", { name: "Community invitation" })).toHaveCount(0);
      // The link back to the community is still shown (it is information, not an offer).
      await expect(omar.getByRole("button", { name: `Open the community ${COMMUNITY}` })).toBeVisible();

      // Not a member: the community's roster does not list him, and he is not approved there.
      await olga.goto(`/#/e/${communityNaddr}/attendees`);
      await expect(olga.getByText("Nina Joiner").first()).toBeVisible({ timeout: 60_000 });
      await expect(olga.getByText("Omar Optout")).toHaveCount(0);
      await omar.goto(`/#/e/${communityNaddr}`);
      await expect(omar.getByText(/see who's here/i)).toHaveCount(0);
    });

    test("S4 — approved before the link existed: re-issued proof, one-tap offer, join", async ({ browser }) => {
      test.setTimeout(300_000);
      // An event with a coordinator that is NOT yet part of the community.
      const earlyNaddr = await createEvent(olga, EARLY_EVENT);
      await attachCoordinator(olga, earlyNaddr);
      const early = await inviteLinks(olga, earlyNaddr, 1);

      const dana = await user(browser, "Dana Early");
      await joinWithInvite(dana, early[0]); // no disclosure: nothing to disclose yet
      await expectApproved(dana, earlyNaddr);

      // The organizer now links it. Dana was never asked, so she is offered, not joined.
      await olga.goto(`/#/e/${earlyNaddr}/settings`);
      await expect(olga.locator("#hier-parent option", { hasText: COMMUNITY })).toHaveCount(1, { timeout: 20_000 });
      await olga.locator("#hier-parent").selectOption({ label: COMMUNITY });
      await olga.getByRole("button", { name: /save community/i }).click();
      await expect(olga.getByText(new RegExp(`Now part of ${COMMUNITY}`))).toBeVisible({ timeout: 60_000 });

      const card = dana.getByRole("region", { name: "Community invitation" });
      await expect(async () => {
        // A reload, not a goto: the same hash is not a navigation, and an approved
        // member's grant poll has stopped, so only a fresh visit rescans the inbox.
        await dana.goto(`/#/e/${earlyNaddr}`);
        await dana.reload();
        await expect(card).toBeVisible({ timeout: 15_000 });
      }).toPass({ timeout: 120_000, intervals: [4_000] });

      await card.getByRole("button", { name: `Join the community ${COMMUNITY}` }).click();
      await expect(dana.getByText(new RegExp(`Request to join ${COMMUNITY} sent`))).toBeVisible({ timeout: 30_000 });

      await expectApproved(dana, communityNaddr);
      await olga.goto(`/#/e/${communityNaddr}/attendees`);
      await expect(olga.getByText("Dana Early").first()).toBeVisible({ timeout: 60_000 });
    });

    test("S5 — a direct join to the manual community with its own invite code waits for the organizer", async ({ browser }) => {
      test.setTimeout(240_000);
      const own = await inviteLinks(olga, communityNaddr, 1);
      const rita = await user(browser, "Rita Direct");
      const ritaShort = (await ownPubkeyHex(rita)).slice(0, 8);
      await joinWithInvite(rita, own[0]);
      // `approval: "manual"` is enforced (SB-124): a valid code alone does not
      // admit; only member_of proofs from linked events do (§15.4, S2).
      const queued = new RegExp(`\\[join\\] ${ritaShort} invite=yes approval=manual → manual queue`);
      await expect.poll(() => queued.test(coordinatorLog()), { timeout: 90_000 }).toBe(true);
      await olga.goto(`/#/e/${communityNaddr}/admin`);
      await expect(olga.getByText("Rita Direct").first()).toBeVisible({ timeout: 60_000 });
      await olga.getByRole("button", { name: /^approve$/i }).first().click();
      await expectApproved(rita, communityNaddr);
      await olga.goto(`/#/e/${communityNaddr}/attendees`);
      await expect(olga.getByText("Rita Direct").first()).toBeVisible({ timeout: 60_000 });
    });

    test("S6 — manual community, no coordinator: the queue badges verified event members", async ({ browser }) => {
      test.setTimeout(300_000);
      const mCommunity = await createCommunity(olga, MANUAL_COMMUNITY, "manual");
      const mEvent = await createEvent(olga, MANUAL_EVENT, { parentTitle: MANUAL_COMMUNITY, approval: "manual" });

      const vera = await user(browser, "Vera Verified");
      await vera.goto(`/#/e/${mEvent}/join`);
      await expect(vera.getByRole("checkbox", { name: new RegExp(`join the community ${MANUAL_COMMUNITY}`, "i") })).toBeChecked({ timeout: 30_000 });
      await vera.getByRole("button", { name: /send join request/i }).click();
      await expect(vera.getByText(/request sent/i)).toBeVisible({ timeout: 30_000 });

      // The event's own organizer client approves (no coordinator): the grant it seals
      // carries the proof, so Vera's client then sends the community join itself.
      await olga.goto(`/#/e/${mEvent}/admin`);
      await olga.getByRole("button", { name: /^approve$/i }).first().click();
      await expect(olga.getByText(/approved ✓/i).first()).toBeVisible({ timeout: 30_000 });
      await expectApproved(vera, mEvent);

      // The community queue shows the badge and the one-action approval.
      await expect(async () => {
        await olga.goto(`/#/e/${mCommunity}/admin`);
        await expect(olga.getByText(`Member of ${MANUAL_EVENT}`)).toBeVisible({ timeout: 8_000 });
      }).toPass({ timeout: 120_000, intervals: [4_000] });
      await olga.getByRole("button", { name: /Approve the 1 requests from verified event members/i }).click();
      await expect(olga.getByText(/approved ✓/i).first()).toBeVisible({ timeout: 30_000 });
      await expectApproved(vera, mCommunity);
    });

    test("S7 — a settings page opened before the link was made does not undo it", async ({ browser }) => {
      test.setTimeout(300_000);
      // Two settings pages (the community's and the event's) are loaded BEFORE the
      // link exists, then the link is made elsewhere. Attaching a coordinator from
      // either page republishes that space's 31600; built from the page's cached
      // context it would silently drop the community's newest `child` / the event's
      // `parent`, ending the link with no error anywhere.
      const staleCommunity = await createCommunity(olga, `Hier Stale Community ${RUN}`, "manual");
      const staleEvent = await createEvent(olga, `Hier Stale Meetup ${RUN}`);

      const ctx = olga.context();
      const tabCommunity = await ctx.newPage();
      const tabEvent = await ctx.newPage();
      await tabCommunity.goto(`/#/e/${staleCommunity}/settings`);
      await tabEvent.goto(`/#/e/${staleEvent}/settings`);
      const paste = (p: Page) => p.locator("details").filter({ hasText: /paste.*npub/i });
      await expect(paste(tabCommunity)).toBeVisible({ timeout: 30_000 });
      await expect(paste(tabEvent)).toBeVisible({ timeout: 30_000 });
      await expect(tabEvent.locator("#hier-parent")).toBeVisible({ timeout: 30_000 });

      // The link is made on a third page.
      await olga.goto(`/#/e/${staleEvent}/settings`);
      await expect(olga.locator("#hier-parent option", { hasText: `Hier Stale Community ${RUN}` })).toHaveCount(1, { timeout: 20_000 });
      await olga.locator("#hier-parent").selectOption({ label: `Hier Stale Community ${RUN}` });
      await olga.getByRole("button", { name: /save community/i }).click();
      await expect(olga.getByText(/Now part of/)).toBeVisible({ timeout: 60_000 });

      const attach = async (p: Page) => {
        await paste(p).locator("summary").click();
        await paste(p).locator('input[placeholder*="coordinator" i]').fill(COORD_NPUB!);
        await p.getByRole("button", { name: /attach coordinator/i }).first().click();
        await expect(p.getByText(/coordinator attached/i)).toBeVisible({ timeout: 30_000 });
      };
      const expectLinked = async () => {
        await olga.goto("/#/");
        await olga.goto(`/#/e/${staleCommunity}`);
        await expect(olga.getByRole("button", { name: `Open event Hier Stale Meetup ${RUN}` })).toBeVisible({ timeout: 45_000 });
        await olga.goto(`/#/e/${staleEvent}`);
        await expect(olga.getByRole("button", { name: `Open the community Hier Stale Community ${RUN}` })).toBeVisible({ timeout: 45_000 });
      };

      await attach(tabCommunity); // stale community context: must keep its child
      await expectLinked();
      await attach(tabEvent); // stale event context: must keep its parent
      await expectLinked();
    });
  },
);
