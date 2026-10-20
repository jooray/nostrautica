/**
 * Audit DS41-022. Dates and times formatted with no locale (or `undefined`/`[]`)
 * follow the BROWSER language, not the one the user picked in the app. A Slovak
 * UI on an English phone showed English month names and 12-hour times in post
 * dates, chat timestamps, the event header and the printed report, next to a
 * People list that formats in Slovak. Every toLocale*String call in the UI must
 * name the app's locale.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";

const libRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(svelte|ts)$/.test(f) && !f.endsWith(".test.ts") ? [p] : [];
  });
}

describe("date/time formatting uses the app locale", () => {
  it("no toLocale*String call falls back to the browser locale", () => {
    const offenders: string[] = [];
    for (const f of walk(libRoot)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\.toLocale(Date|Time)?String\(([^,)]*)/g)) {
        const arg = m[2].trim();
        if (arg === "i18n.locale" || arg === "locale") continue;
        offenders.push(`${f.slice(libRoot.length + 1)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
