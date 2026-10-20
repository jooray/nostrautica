import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "DmChat.svelte"), "utf8");
const fn = src.slice(
  src.indexOf("async function loadSharedEvents"),
  src.indexOf("// --- Header peer actions"),
);

/**
 * Audit DS41-024. Opening one DM ran loadEventContext + fetchRoster for every
 * event the account holds a key for, all in parallel, to fill the "Also
 * attending" line, competing with the conversation's own first refresh.
 */
describe("DmChat shared-events lookup", () => {
  it("does not fan out over every event at once", () => {
    expect(fn).not.toMatch(/Promise\.all\(\s*withEck\.map/);
    expect(fn).toMatch(/mapLimit\(misses, SHARED_EVENTS_CONCURRENCY/);
  });

  it("waits for the thread's first refresh before any network read", () => {
    const wait = fn.indexOf("await afterFirstRefresh");
    expect(wait).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(fn.indexOf("await loadEventContext"));
    expect(wait).toBeLessThan(fn.indexOf("await fetchRoster"));
  });
});
