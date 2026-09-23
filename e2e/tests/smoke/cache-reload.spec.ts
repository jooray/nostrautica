import { test, expect, type Page } from "@playwright/test";
import { nip19, getPublicKey, generateSecretKey, finalizeEvent, matchFilters } from "nostr-tools";

// The same isolated fixtures can verify the deployed /app bundle. All relay
// sockets are intercepted below; these checks publish no production events.
const APP_PATH = new URL(process.env.NOSTRAUTICA_URL ?? "http://127.0.0.1:4173/").pathname.replace(/\/$/, "");
const appRoute = (path = "/") => `${APP_PATH}/#${path}`;

async function putEntries(page: Page, dbName: string, storeName: string, entries: [string, unknown][]) {
  await page.evaluate(async ({ dbName, storeName, entries }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(storeName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      for (const [key, value] of entries) tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { dbName, storeName, entries });
}

test("a DM read survives real IndexedDB persistence and reload without a signer decrypt", async ({ page }) => {
  const owner = getPublicKey(generateSecretKey());
  const peer = getPublicKey(generateSecretKey());
  const id = "a".repeat(64);
  const at = Math.floor(Date.now() / 1000) - 60;
  // No network copy of read state is available to conceal a failed local write.
  await page.routeWebSocket(/.*/, (socket) => socket.close());
  await page.addInitScript((pubkey) => {
    Object.assign(window, { nostr: { getPublicKey: async () => pubkey } });
  }, owner);
  await page.goto(appRoute());
  await expect(page.getByText("Meet the right people")).toBeVisible();
  await putEntries(page, "nostrautica", "keystore", [["login-method", "nip07"]]);
  await putEntries(page, "nostrautica-appcache", "kv", [
    [`${owner}\x1fdmwraps`, {
      at, touchedAt: at,
      data: { wrap: { id, at, from: peer, peer, text: "Already read regression message" } },
    }],
  ]);
  await page.goto(appRoute(`/dm/${nip19.npubEncode(peer)}`));
  await page.reload();
  await expect(page.getByText("Already read regression message", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async (owner) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open("nostrautica-appcache", 1);
      req.onsuccess = () => resolve(req.result);
    });
    const result = await new Promise<unknown>((resolve) => {
      const req = db.transaction("kv").objectStore("kv").get(`${owner}\x1fdm-read-watermarks`);
      req.onsuccess = () => resolve(req.result?.data);
    });
    db.close();
    return result;
  }, owner)).toEqual({ [peer]: { at, id } });
  await page.goto(appRoute());
  await page.reload();
  await expect(page.getByRole("heading", { name: "Meet the right people" })).toBeVisible();
  await expect(page.locator(".badge-count")).toHaveCount(0);
});

test("cached event cards render while the remote signer is still reconnecting", async ({ page }) => {
  const owner = getPublicKey(generateSecretKey());
  const eid = getPublicKey(generateSecretKey());
  const naddr = nip19.naddrEncode({ kind: 31612, pubkey: eid, identifier: "cached-community" });
  await page.routeWebSocket(/.*/, () => { /* a signer that never answers */ });
  await page.goto(appRoute());
  await expect(page.getByText("Meet the right people")).toBeVisible();
  await putEntries(page, "nostrautica", "keystore", [
    ["login-method", "nip46"],
    ["nip46-session", {
      clientSkHex: "11".repeat(32), userPubkey: owner,
      bunker: { pubkey: getPublicKey(generateSecretKey()), relays: ["wss://signer.example"] },
    }],
  ]);
  await page.evaluate(({ owner, eid, naddr }) => {
    localStorage.setItem(`nostrautica:recent-events:${owner}`, JSON.stringify([
      { coordinate: `31612:${eid}:cached-community`, naddr, title: "My cached community", role: "organizer", at: 1 },
    ]));
  }, { owner, eid, naddr });
  await page.reload();
  await expect(page.getByText("My cached community", { exact: true })).toBeVisible({ timeout: 3000 });
  await expect(page.getByText("Reconnecting your signer…", { exact: true })).toBeVisible();
});

test("Check again refreshes the pending badge and member navigation after a key arrives", async ({ page }) => {
  const owner = getPublicKey(generateSecretKey());
  const eventKey = generateSecretKey();
  const eid = getPublicKey(eventKey);
  const identifier = "late-key";
  const coordinate = `31612:${eid}:${identifier}`;
  const naddr = nip19.naddrEncode({ kind: 31612, pubkey: eid, identifier });
  const at = Math.floor(Date.now() / 1000);
  const events = [
    finalizeEvent({ kind: 31600, created_at: at, content: "", tags: [
      ["d", identifier], ["v", "2"], ["inbox", getPublicKey(generateSecretKey())],
      ["matching", "off"], ["approval", "manual"], ["eck", "1"],
    ] }, eventKey),
    finalizeEvent({ kind: 31612, created_at: at, content: "", tags: [
      ["d", identifier], ["title", "Late key community"],
    ] }, eventKey),
  ];
  await page.routeWebSocket(/.*/, (socket) => {
    socket.onMessage((raw) => {
      const [type, id, ...filters] = JSON.parse(String(raw));
      if (type === "REQ") {
        for (const event of events) {
          if (matchFilters(filters, event)) socket.send(JSON.stringify(["EVENT", id, event]));
        }
        socket.send(JSON.stringify(["EOSE", id]));
      } else if (type === "EVENT") {
        socket.send(JSON.stringify(["OK", id.id, true, ""]));
      }
    });
  });
  await page.addInitScript((pubkey) => {
    Object.assign(window, { nostr: { getPublicKey: async () => pubkey } });
  }, owner);
  await page.goto(appRoute());
  await expect(page.getByText("Meet the right people")).toBeVisible();
  await putEntries(page, "nostrautica", "keystore", [["login-method", "nip07"]]);
  await page.evaluate(({ owner, coordinate, at }) => {
    localStorage.setItem("nostrautica:join-sent-owner", owner);
    localStorage.setItem("nostrautica:join-sent", JSON.stringify({ [coordinate]: { at } }));
  }, { owner, coordinate, at });
  await page.goto(appRoute(`/e/${naddr}`));
  await page.reload();
  await expect(page.getByText("Waiting for the organizer's approval.", { exact: true })).toBeVisible();
  await expect(page.getByText("Pending", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check again", exact: true })).toBeVisible();
  // A grant delivered by another tab becomes durable while this page is open.
  await page.evaluate(async ({ owner, coordinate }) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open("nostrautica-eventkeys", 3);
      req.onsuccess = () => resolve(req.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("keys2", "readwrite");
      tx.objectStore("keys2").put({ owner, coordinate, role: "attendee", eck: [
        { id: 1, key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
      ] });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { owner, coordinate });
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  // Before the 20s poll can conceal stale page/shell state.
  await expect(page.getByText("Pending", { exact: true })).toHaveCount(0, { timeout: 5000 });
  await expect(page.getByRole("navigation").getByRole("button", { name: /^People/ })).toBeVisible({ timeout: 5000 });
});
