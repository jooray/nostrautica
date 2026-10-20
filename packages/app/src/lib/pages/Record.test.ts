import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "Record.svelte"), "utf8");
const init = src.slice(src.indexOf("async function init()"), src.indexOf("async function resolveRole"));

/**
 * Audit DS41-017. Record awaited connectNdk + loadEventContext (three relay
 * queries) before resolving the role, although a cached context was in hand.
 * If anything threw, the catch set `error` but left `role` on "loading", so the
 * recording screen showed an ErrorState with no retry AND a permanent
 * "Resolving your membership…" card under it. The only way out was Back.
 */
describe("Record load failure is recoverable", () => {
  it("resolves the role on a cached context without awaiting a network context read", () => {
    const cachedBranch = init.slice(init.indexOf("if (ctx) {"), init.indexOf("} else {"));
    expect(cachedBranch).toMatch(/void ensureEventContext\(/);
    expect(cachedBranch).not.toMatch(/await loadEventContext/);
  });

  it("moves the role out of loading when init throws", () => {
    expect(init).toMatch(/catch \(e\) \{\s*error = e;\s*if \(role === "loading"\) role = "failed";/);
    // and "failed" renders its own (empty) branch instead of falling into the
    // visitor card via `role !== "approved"`.
    expect(src.indexOf('{:else if role === "failed"}')).toBeGreaterThan(-1);
    expect(src.indexOf('{:else if role === "failed"}')).toBeLessThan(src.indexOf('{:else if role !== "approved"}'));
  });

  it("offers a retry on the error", () => {
    expect(src).toMatch(/<ErrorState \{error\} onRetry=\{\(\) => void retry\(\)\} \{retrying\} \/>/);
  });
});
