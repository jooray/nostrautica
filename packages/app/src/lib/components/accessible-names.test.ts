import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";

const libRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(libRoot, p), "utf8");

function svelteFiles(dir: string): string[] {
  return readdirSync(resolve(libRoot, dir))
    .filter((f) => f.endsWith(".svelte"))
    .map((f) => join(dir, f));
}

/**
 * Audit DS41-023. FileButton's focusable control is the <button>; the label on
 * the hidden <input tabindex="-1"> is unreachable by keyboard and screen-reader
 * users. A FileButton whose children are only an image or an icon (the avatar
 * pickers on Login/Join) therefore announced "button" with no name, on the first
 * form a new user meets. Such usages must pass `iconOnly` so the button takes
 * `label` as its name.
 */
describe("FileButton accessible name", () => {
  it("gives the button the label when iconOnly is set", () => {
    expect(read("components/FileButton.svelte")).toMatch(/aria-label=\{iconOnly \? label : undefined\}/);
  });

  it("every FileButton without text children passes iconOnly", () => {
    const offenders: string[] = [];
    for (const f of [...svelteFiles("pages"), ...svelteFiles("components")]) {
      const src = read(f);
      for (const m of src.matchAll(/<FileButton\b([\s\S]*?)>([\s\S]*?)<\/FileButton>/g)) {
        const [, attrs, body] = m;
        // Text children: a t() call, a literal word, or an interpolated string.
        const stripped = body
          .replace(/<img\b[^>]*\/?>/g, "")
          .replace(/<Icon\b[^>]*\/>/g, "")
          .replace(/<\/?span\b[^>]*>/g, "")
          .replace(/\{[#:/][^}]*\}/g, "");
        const hasText = /\bt\(|[A-Za-z]{2,}|"…"/.test(stripped);
        if (!hasText && !/\biconOnly\b/.test(attrs)) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Audit SB-34. A placeholder is not an accessible name, and a <div
 * class="field-label"> above a control is not a <label>. Every text control in
 * Event settings must be named: an aria-label, an id (paired with <label for>),
 * a wrapping <label>, or be a checkbox (always wrapped in a label here).
 */
function unnamedControls(file: string): string[] {
  const src = read(file);
  const markup = src.slice(src.indexOf("</script>", src.lastIndexOf("<script")));
  const offenders: string[] = [];
  let labelDepth = 0;
  const re = /<(\/?)(label|input|select|textarea)\b([^>]*?)(\/?)>/g;
  for (const m of markup.matchAll(re)) {
    const [whole, close, tag, attrs] = m;
    if (tag === "label") {
      labelDepth += close ? -1 : 1;
      continue;
    }
    if (close) continue;
    const named =
      labelDepth > 0 ||
      /\baria-label(ledby)?=/.test(attrs) ||
      /\bid=/.test(attrs) ||
      /type="(checkbox|radio|hidden)"/.test(attrs);
    if (!named) offenders.push(whole.replace(/\s+/g, " ").slice(0, 100));
  }
  return offenders;
}

describe("Event settings form controls are named", () => {
  it("has no unnamed input, select or textarea", () => {
    expect(unnamedControls("pages/EventSettings.svelte")).toEqual([]);
  });
});

/**
 * Audit KIMIK31 W-19: the post editor named its fields by placeholder only, and
 * Admin's batch-invite count had no name at all ("spin button, 5").
 */
describe("post editor and Admin form controls are named", () => {
  it.each(["components/PostEditor.svelte", "pages/Admin.svelte"])("%s", (file) => {
    expect(unnamedControls(file)).toEqual([]);
  });
});

/**
 * Audit KIMIK31 W-19: Admin, Event settings and Create showed failures as bare
 * `{error}` cards, which assistive tech never announces. The card keeps its
 * (often already specific, localized) text and gains role="alert", the same
 * announcement ErrorState makes; retryable reads use ErrorState itself.
 */
describe("page-level errors are announced", () => {
  it.each(["pages/Admin.svelte", "pages/EventSettings.svelte", "pages/Create.svelte"])(
    "%s has no unannounced error card",
    (file) => {
      expect(read(file)).not.toMatch(/<div class="card warn">\{error\}<\/div>/);
    },
  );
});
