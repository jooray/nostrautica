/**
 * The typed custom-kind registry is the allocation authority (audit §13.1).
 * These are the CI invariants: the registry is a bijection with the custom
 * `KIND_*` constants, covers exactly the reserved ranges, every rumor kind is in
 * `RUMOR_KINDS`, every schema export it names is real, and the generated
 * `docs/PROTOCOL-REGISTRY.md` has not drifted from it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CUSTOM_KIND_REGISTRY,
  CUSTOM_ADDRESSABLE_RANGE,
  CUSTOM_RUMOR_RANGE,
  renderRegistryDoc,
} from "./registry.js";
import { RUMOR_KINDS } from "./kinds.js";
import * as kinds from "./kinds.js";
import * as schemas from "./schemas.js";

/** Every KIND_* constant whose value falls in either custom range. */
function customKindConstants(): { name: string; value: number }[] {
  const inCustomRange = (v: number) =>
    (v >= CUSTOM_ADDRESSABLE_RANGE.min && v <= CUSTOM_ADDRESSABLE_RANGE.max) ||
    (v >= CUSTOM_RUMOR_RANGE.min && v <= CUSTOM_RUMOR_RANGE.max);
  return Object.entries(kinds as Record<string, unknown>)
    .filter(([n, v]) => n.startsWith("KIND_") && typeof v === "number" && inCustomRange(v))
    .map(([name, value]) => ({ name, value: value as number }));
}

describe("CUSTOM_KIND_REGISTRY — allocation authority (§13.1)", () => {
  it("every entry's constant resolves to its kind number", () => {
    for (const e of CUSTOM_KIND_REGISTRY) {
      expect((kinds as Record<string, unknown>)[e.constant], `${e.constant} export`).toBe(e.kind);
    }
  });

  it("is a bijection with the custom KIND_* constants (no missing, no duplicate, no orphan)", () => {
    const registryConstants = CUSTOM_KIND_REGISTRY.map((e) => e.constant).sort();
    // No duplicate constant in the registry.
    expect(new Set(registryConstants).size).toBe(registryConstants.length);
    // Exactly the set of custom KIND_* constants — no orphan constant, none missing.
    const sourceConstants = customKindConstants()
      .map((c) => c.name)
      .sort();
    expect(registryConstants).toEqual(sourceConstants);
  });

  it("covers EXACTLY the addressable range 31600–31611 and rumor range 21600–21610", () => {
    const addr = CUSTOM_KIND_REGISTRY.filter((e) => e.klass === "addressable")
      .map((e) => e.kind)
      .sort((a, b) => a - b);
    const rumor = CUSTOM_KIND_REGISTRY.filter((e) => e.klass === "rumor")
      .map((e) => e.kind)
      .sort((a, b) => a - b);
    const range = (min: number, max: number) =>
      Array.from({ length: max - min + 1 }, (_, i) => min + i);
    expect(addr).toEqual(range(CUSTOM_ADDRESSABLE_RANGE.min, CUSTOM_ADDRESSABLE_RANGE.max));
    expect(rumor).toEqual(range(CUSTOM_RUMOR_RANGE.min, CUSTOM_RUMOR_RANGE.max));
  });

  it("every rumor-class kind is in RUMOR_KINDS", () => {
    for (const e of CUSTOM_KIND_REGISTRY.filter((e) => e.klass === "rumor")) {
      expect(RUMOR_KINDS as readonly number[], `kind ${e.kind}`).toContain(e.kind);
    }
  });

  it("every named schema export exists in schemas.ts", () => {
    for (const e of CUSTOM_KIND_REGISTRY) {
      if (e.schemaExport === null) continue;
      expect(schemas as Record<string, unknown>, `${e.constant} → ${e.schemaExport}`).toHaveProperty(
        e.schemaExport,
      );
    }
  });

  it("the committed docs/PROTOCOL-REGISTRY.md matches the generated output (drift guard)", () => {
    const docPath = fileURLToPath(new URL("../../../docs/PROTOCOL-REGISTRY.md", import.meta.url));
    const committed = readFileSync(docPath, "utf8");
    expect(committed).toBe(renderRegistryDoc());
  });
});
