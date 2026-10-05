import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { finalizeEvent } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { newUser, ownPubkeyHex } from "../helpers.js";
import { createChatEvent, sendJoinRequest, approveAll, openChatAwaitReady, sendChat, expectMessage } from "./chat-helpers.js";

/**
 * Live White Noise interop (MDK `wn` CLI) against the full local stack: app in a
 * browser, the coordinator double with the real Marmot admin bot, and a real
 * White Noise client on the same relay. OPT-IN — it needs the `wn`/`wnd` binaries:
 *
 *   NOSTRAUTICA_E2E_WN_BIN=/path/to/mdk/target/release \
 *   MOCK_EXTRA_GROUP_RELAYS=ws://127.0.0.1:7777 \
 *   node e2e/orchestrator.mjs chat -- --grep "white noise interop"
 *
 * MOCK_EXTRA_GROUP_RELAYS puts the plain nak relay into the group's routing state:
 * wn cannot trust the stack's self-signed wss proxy, and that relay is the same
 * nak instance the proxy fronts, so every party still sees one event stream.
 *
 * Covers: the own-npub link and the one-time-code link, wn accepting both
 * Welcomes, messages both ways, coordinator metadata commits (the group avatar
 * following the event icon — set, change, clear, set) with wn still converged
 * afterwards, and a revoke removing wn.
 */
const WN_BIN = process.env.NOSTRAUTICA_E2E_WN_BIN;
const COORD_NPUB = process.env.NOSTRAUTICA_E2E_COORDINATOR_NPUB;
const NAK = "ws://127.0.0.1:7777";

const WN_HOME = join(tmpdir(), `wn-e2e-home-${process.pid}`);
// The daemon socket path must be short (sun_path) and its directory mode 700.
const WN_SOCK_DIR = `/private/tmp/wne2e-${process.pid}`;
const wnEnv = {
  ...process.env,
  WN_HOME,
  WN_SECRET_STORE: "file",
  WN_ALLOW_LOOPBACK_RELAYS: "1",
  WN_SOCKET: `${WN_SOCK_DIR}/d.sock`,
};

function wn(account: string | undefined, args: string[], input?: string): any {
  const out = execFileSync(`${WN_BIN}/wn`, ["--json", ...(account ? ["--account", account] : []), ...args], {
    input,
    encoding: "utf8",
    env: wnEnv,
  });
  const parsed = JSON.parse(out);
  if (!parsed.ok) throw new Error(`wn ${args.join(" ")}: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 90_000): Promise<NonNullable<T>> {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

/** Accept the newest pending invite whose group name matches; returns its group id. */
async function acceptInvite(account: string, name: RegExp): Promise<string> {
  const id = await until(`wn invite "${name}" for ${account.slice(0, 8)}`, () => {
    const invites = (wn(account, ["groups", "invites"]).invites ?? []) as any[];
    const hit = invites.find((i) => name.test(JSON.stringify(i.profile ?? i.name ?? i)));
    return hit?.group_id as string | undefined;
  });
  wn(account, ["groups", "accept", id]);
  return id;
}

const messagesText = (account: string, group: string) => JSON.stringify(wn(account, ["messages", "list", group]));
const groupShow = (account: string, group: string) => wn(account, ["groups", "show", group]);

/** Read a value straight out of the page's IndexedDB. */
async function idbAll(page: Page, db: string, store: string): Promise<unknown[]> {
  return page.evaluate(
    ([dbName, storeName]) =>
      new Promise<unknown[]>((resolve, reject) => {
        const req = indexedDB.open(dbName!);
        req.onsuccess = () => {
          const tx = req.result.transaction(storeName!, "readonly");
          const all = tx.objectStore(storeName!).getAll();
          all.onsuccess = () => resolve(all.result as unknown[]);
          all.onerror = () => reject(all.error);
        };
        req.onerror = () => reject(req.error);
      }),
    [db, store],
  );
}

async function localSecretKey(page: Page): Promise<Uint8Array> {
  const values = await page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const req = indexedDB.open("nostrautica");
        req.onsuccess = () => {
          const get = req.result.transaction("keystore", "readonly").objectStore("keystore").get("local-sk");
          get.onsuccess = () => resolve(Array.from(get.result as Uint8Array));
          get.onerror = () => reject(get.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
  return Uint8Array.from(values as number[]);
}

/** Publish one event straight to the nak relay and wait for its OK. */
function publishToRelay(event: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(NAK);
    const timer = setTimeout(() => reject(new Error("relay publish timeout")), 10_000);
    ws.on("open", () => ws.send(JSON.stringify(["EVENT", event])));
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg[0] === "OK") {
        clearTimeout(timer);
        ws.close();
        msg[2] ? resolve() : reject(new Error(`relay refused: ${msg[3]}`));
      }
    });
    ws.on("error", reject);
  });
}

test.describe.serial(WN_BIN && COORD_NPUB ? "white noise interop" : "white noise interop (opt-in — skipped)", () => {
  test.skip(!WN_BIN || !COORD_NPUB, "set NOSTRAUTICA_E2E_WN_BIN and run via the chat tier");

  let orgCtx: BrowserContext;
  let aliceCtx: BrowserContext;
  let organizer: Page;
  let alice: Page;
  let naddr: string;
  let aliceHex: string;
  let wHex: string;
  let eventGroupA: string;
  let eventGroupW: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    rmSync(WN_HOME, { recursive: true, force: true });
    mkdirSync(WN_HOME, { recursive: true });
    mkdirSync(WN_SOCK_DIR, { recursive: true });
    chmodSync(WN_SOCK_DIR, 0o700);
    execFileSync(`${WN_BIN}/wn`, ["daemon", "start", "--discovery-relays", NAK, "--default-account-relays", NAK], {
      env: wnEnv,
      stdio: "inherit",
    });

    orgCtx = await browser.newContext();
    aliceCtx = await browser.newContext();
    organizer = await newUser(orgCtx, "Olga Organizer");
    naddr = await createChatEvent(organizer, COORD_NPUB!, "WN Interop E2E");
    alice = await newUser(aliceCtx, "Alice Attendee");
    aliceHex = await ownPubkeyHex(alice);

    // Alice's own account key in White Noise (the own-npub path), and a separate
    // White Noise identity W (the one-time-code path).
    const aliceNsec = nip19.nsecEncode(await localSecretKey(alice));
    wn(undefined, ["login", "--nsec-stdin"], `${aliceNsec}\n`);
    wHex = wn(undefined, ["create-identity"]).account_id;

    await sendJoinRequest(alice, naddr);
    await approveAll(organizer, naddr, 1);
    await openChatAwaitReady(alice, naddr);
  });

  test.afterAll(async () => {
    try {
      execFileSync(`${WN_BIN}/wn`, ["daemon", "stop"], { env: wnEnv });
    } catch {
      /* already down */
    }
    await orgCtx?.close();
    await aliceCtx?.close();
  });

  test("own-npub link: White Noise joins and messages flow both ways", async () => {
    test.setTimeout(240_000);
    const card = alice.getByRole("group", { name: "Also chat from White Noise or another Marmot client" });
    await card.getByRole("button", { name: "Use my account npub" }).click();
    await card.getByRole("button", { name: "Link", exact: true }).click();
    await expect(card.getByText(/Invite sent to White Noise/)).toBeVisible({ timeout: 30_000 });

    eventGroupA = await acceptInvite(aliceHex, /WN Interop E2E/);
    await sendChat(alice, "browser to white noise A");
    await until("wn A sees the browser message", () => messagesText(aliceHex, eventGroupA).includes("browser to white noise A"));
    wn(aliceHex, ["messages", "send", eventGroupA, "white noise A to browser"]);
    await expectMessage(alice, "white noise A to browser", 90_000);
  });

  test("one-time-code link: confirmation group, code, then the event room", async () => {
    test.setTimeout(240_000);
    const card = alice.getByRole("group", { name: "Also chat from White Noise or another Marmot client" });
    const another = card.getByRole("button", { name: "Link another account" });
    if (await another.count()) await another.click();
    await card.getByLabel("White Noise npub").fill(nip19.npubEncode(wHex));
    await card.getByRole("button", { name: "Link", exact: true }).click();
    await expect(card.getByText(/accept the invite/)).toBeVisible({ timeout: 30_000 });

    const confirmGroup = await acceptInvite(wHex, /confirm White Noise link/);
    const code = await until("the code message", () => messagesText(wHex, confirmGroup).match(/\b[A-Z0-9]{8}\b/)?.[0]);
    await card.getByLabel("Code from White Noise").fill(code);
    await card.getByRole("button", { name: "Confirm" }).click();
    await expect(card.getByText(/Invite sent to White Noise/)).toBeVisible({ timeout: 60_000 });

    eventGroupW = await acceptInvite(wHex, /WN Interop E2E/);
    expect(eventGroupW).toBe(eventGroupA);
    wn(wHex, ["messages", "send", eventGroupW, "white noise W to browser"]);
    await expectMessage(alice, "white noise W to browser", 90_000);
    await sendChat(alice, "browser to both");
    await until("wn W sees the browser message", () => messagesText(wHex, eventGroupW).includes("browser to both"));
  });

  test("admin metadata commits (group avatar follows the event icon): White Noise follows", async () => {
    test.setTimeout(240_000);
    const keys = (await idbAll(organizer, "nostrautica-eventkeys", "keys2")) as { eidNsecHex?: string }[];
    const eidHex = keys.find((k) => k.eidNsecHex)?.eidNsecHex;
    expect(eidHex).toBeTruthy();
    const eidSk = Uint8Array.from(Buffer.from(eidHex!, "hex"));
    const setIcon = async (picture: string | undefined, at: number) =>
      publishToRelay(
        finalizeEvent(
          { kind: 0, created_at: at, tags: [], content: JSON.stringify({ name: "WN Interop E2E", ...(picture ? { picture } : {}) }) },
          eidSk,
        ),
      );
    const avatar = () => groupShow(aliceHex, eventGroupA).group?.avatar_url?.url ?? "";
    const now = Math.floor(Date.now() / 1000);

    await setIcon("HTTPS://Img.Example.com/icon-1.png", now + 1);
    await until("wn shows the event icon as the avatar", () => avatar() === "https://img.example.com/icon-1.png");
    await setIcon("https://img.example.com/icon-2.png", now + 2);
    await until("wn follows the icon change", () => avatar() === "https://img.example.com/icon-2.png");

    // Removing the icon clears the avatar (the component's empty state).
    await setIcon(undefined, now + 3);
    await until("wn sees the avatar cleared", () => avatar() === "");
    await setIcon("https://img.example.com/icon-3.png", now + 4);
    await until("wn sees the avatar set again", () => avatar() === "https://img.example.com/icon-3.png");

    // Still converged in both directions after the commits.
    wn(aliceHex, ["messages", "send", eventGroupA, "white noise after commits"]);
    await expectMessage(alice, "white noise after commits", 90_000);
    await sendChat(alice, "browser after commits");
    await until("wn W sees the post-commit message", () => messagesText(wHex, eventGroupW).includes("browser after commits"));
  });

  test("revoke removes White Noise from the room", async () => {
    test.setTimeout(240_000);
    await alice.goto(`/#/e/${naddr}/chat`);
    const devices = alice.getByRole("region", { name: "Chat devices" });
    const row = devices.locator("li").filter({ hasText: /White Noise/ }).last();
    await row.getByRole("button", { name: "Remove" }).click();
    await row.getByRole("button", { name: "Remove" }).click(); // confirm
    const membership = (a: string, g: string) => JSON.stringify(groupShow(a, g).group?.self_membership ?? "");
    const removed = await until("one White Noise account removed", () => {
      const a = membership(aliceHex, eventGroupA);
      const w = membership(wHex, eventGroupW);
      return /removed/.test(a) || /removed/.test(w) ? { a, w } : undefined;
    });
    // Exactly one of the two linked accounts was revoked; the other stays in.
    expect([removed.a, removed.w].filter((m) => /removed/.test(m))).toHaveLength(1);
  });
});
