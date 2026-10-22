import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, SCHEMA_VERSION } from "./db.js";

describe("hierarchy re-issue ledger (§15.3)", () => {
  it("is keyed by (child, parent, gen) and survives a reopen without bumping the schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "hier-"));
    try {
      const path = join(dir, "c.sqlite");
      const a = new Store(path);
      expect(a.hierarchyReissued("31923:c:x", "31612:p:y", 1)).toBe(false);
      a.markHierarchyReissued("31923:c:x", "31612:p:y", 1, 5);
      a.markHierarchyReissued("31923:c:x", "31612:p:y", 1, 9); // idempotent
      a.close();
      const b = new Store(path);
      expect(b.hierarchyReissued("31923:c:x", "31612:p:y", 1)).toBe(true);
      expect(b.hierarchyReissued("31923:c:x", "31612:p:y", 2)).toBe(false); // new coordinator gen
      expect(b.hierarchyReissued("31923:c:x", "31612:other:y", 1)).toBe(false);
      // This table is additive and needs no migration of its own. (The version moved
      // to 7 with the R-01 revocation tombstone, not for this table.)
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
