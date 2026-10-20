import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "MyProfile.svelte"), "utf8");
const mount = src.slice(src.indexOf("onMount(async"), src.indexOf("const parseLines"));

/**
 * Audit DS41-019. My Profile read the cached directory entry and called
 * loadFromEntry(), but the whole page is gated on `loading`, which was cleared
 * only in the `finally` after connectNdk(), loadEventContext() and
 * fetchDirectoryEntry() all settled. On venue Wi-Fi the member stared at
 * "Loading…" for seconds, or indefinitely, with their profile already in memory.
 */
describe("My Profile cache-first paint", () => {
  it("clears loading at the cache paint, before any network await", () => {
    const paint = mount.indexOf("loadFromEntry(entry);\n          loading = false;");
    expect(paint).toBeGreaterThan(-1);
    expect(paint).toBeLessThan(mount.indexOf("await connectNdk()"));
    expect(paint).toBeLessThan(mount.indexOf("await loadEventContext"));
  });

  it("does not overwrite AI-field edits made on the cached paint", () => {
    expect(mount).toMatch(/if \(!aiFieldsEdited\(\)\) loadFromEntry\(entry\);/);
  });
});
