import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const card = readFileSync(resolve(here, "../components/ChatHandoffCard.svelte"), "utf8");
// The function's code, without its comments (which explain the old op:"add").
const saveRename = card
  .slice(card.indexOf("async function saveRename"), card.indexOf("async function doRevoke"))
  .replace(/\/\/.*$/gm, "");

/**
 * Audit K-5 (interim, until the protocol has K-1's `intent`). Renaming this
 * device sent a 21607 op:"add", and the coordinator reads every add from a
 * device it still holds a leaf for as "re-enrol me": it removed the renaming
 * device from the room and added it back. The rename is now saved locally and
 * goes out with the device's next real attestation (ensurePublished sends
 * `loadDeviceLabel() ?? defaultDeviceLabel()`, see client.test.ts "device label").
 */
describe("renaming this chat device (audit K-5)", () => {
  it("saves the label locally and sends no attestation", () => {
    expect(saveRename).toMatch(/saveDeviceLabel\(id\.pubkey, label\)/);
    expect(saveRename).not.toMatch(/sendChatKeyAttestation/);
    expect(saveRename).not.toMatch(/op:\s*"add"/);
  });

  it("tells the user when the new name reaches the others", () => {
    expect(saveRename).toMatch(/t\("chat\.devices\.renamedLocal"\)/);
  });
});
