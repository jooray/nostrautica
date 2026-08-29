/**
 * Static docs-site generator: docs/*.md → docs-site-build/ (HTML).
 *
 * - EVERY public top-level `docs/*.md` file is built to a page so that
 *   `.md`→`.html` link rewriting never points at a page that was never emitted
 *   (audit O6). `docs/internal/**` and `docs/archive/**` are intentionally NOT
 *   published; they live in subdirectories and are skipped because we only scan
 *   the top level of `docs/`.
 * - `SECTIONS` controls INDEX visibility and order only — a doc absent from
 *   SECTIONS is still built (so inbound links resolve), it just isn't featured
 *   on the index page.
 * - A post-build link + anchor checker (audit O6) fails the build if any
 *   rewritten internal link points at a page that wasn't built or an anchor
 *   that doesn't exist. Links into the deliberately-unpublished `archive/` and
 *   `internal/` areas are reported as warnings, not hard failures (whether to
 *   publish that content is a docs-content decision, not a build-integrity bug).
 * - Heading `id`s are generated with a GitHub-compatible slugger so in-page and
 *   cross-page `#anchor` links resolve (marked v18 emits no heading ids on its
 *   own), and so the anchor checker has real ids to validate against.
 * - Dark/light toggle (persisted, defaults to prefers-color-scheme) using the
 *   same design tokens as the app.
 * - Theme-aware screenshots: an image reference ending in `-light.png` with an
 *   existing `-dark.png` sibling renders BOTH, and CSS shows the one matching
 *   the active theme.
 * - Internal `*.md` links become `*.html`; everything is relative so the site
 *   works from any base path (deployed under /docs/, same origin as /app).
 *
 * Usage: node scripts/build-docs.mjs [outDir]   (default docs-site-build)
 * `outDir` may be relative (resolved against the repo root) or absolute
 * (used as-is — audit O7).
 */
import { marked } from "marked";
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");

/**
 * Resolve the output directory (audit O7). A relative argument is resolved
 * against the repo root (preserving the historical `join(ROOT, arg)` behaviour);
 * an absolute argument is honoured verbatim instead of being nailed under ROOT.
 */
export function resolveOutDir(root, arg) {
  const target = arg ?? "docs-site-build";
  return isAbsolute(target) ? target : resolve(root, target);
}

/** Site structure: sections + the docs in them (order = display order). */
const SECTIONS = [
  {
    title: "User guides",
    blurb: "Start here — how to run or attend an event.",
    docs: [
      { file: "ORGANIZER-GUIDE.md", title: "Event Organizer Guide" },
      { file: "PARTICIPANT-GUIDE.md", title: "Participant Guide" },
      { file: "ORGANIZER-GUIDE-sk.md", title: "Príručka organizátora (Slovensky)" },
      { file: "PARTICIPANT-GUIDE-sk.md", title: "Príručka účastníka (Slovensky)" },
      { file: "ORGANIZER-GUIDE-cs.md", title: "Průvodce pro organizátory (Česky)" },
      { file: "PARTICIPANT-GUIDE-cs.md", title: "Průvodce pro účastníky (Česky)" },
    ],
  },
  {
    title: "About Nostrautica",
    blurb: "What this is and why it exists.",
    docs: [
      { file: "ELEVATOR-PITCH-en.md", title: "Elevator Pitch (English)" },
      { file: "ELEVATOR-PITCH-sk.md", title: "Elevator Pitch (Slovensky)" },
    ],
  },
  {
    title: "Design & internals",
    blurb: "For the technically curious: protocol, architecture, security.",
    docs: [
      { file: "SPECIFICATION.md", title: "Specification" },
      { file: "PROTOCOL-NIP.md", title: "Protocol (NIP)" },
      { file: "PROTOCOL-REGISTRY.md", title: "Protocol Registry" },
      { file: "THREAT-MODEL.md", title: "Threat Model" },
      { file: "ENCRYPTION-AND-PRIVACY.md", title: "Encryption & Privacy" },
      { file: "VERSIONING.md", title: "Versioning" },
      { file: "MULTIDEVICE-CHAT.md", title: "Multi-device Chat" },
      { file: "MARMOT-GROUP-CHAT.md", title: "Marmot Group Chat" },
    ],
  },
  {
    title: "Operations & deployment",
    blurb: "Running a coordinator and deploying the site.",
    docs: [
      { file: "DEPLOYMENT.md", title: "Deployment" },
      { file: "COORDINATOR-OPERATOR-GUIDE.md", title: "Coordinator Operator Guide" },
      { file: "COORDINATOR-DISCOVERY-PLAN.md", title: "Coordinator Discovery Plan" },
    ],
  },
  {
    title: "Testing & quality",
    docs: [
      { file: "E2E-TESTING-GUIDE.md", title: "End-to-End Testing Guide" },
      { file: "MATCHING-BENCHMARK.md", title: "Matching Benchmark (models & prompts)" },
      { file: "MODEL-BAKEOFF.md", title: "Model Bake-off (newer models vs production)" },
    ],
  },
];

const CSS = /* css */ `
:root { --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --maxw: 46rem; }
:root, [data-theme="dark"] {
  color-scheme: dark;
  --bg:#0e0e15; --bg-elev:#17171f; --bg-elev2:#22222e; --text:#ededf4; --text-dim:#a2a2ba;
  --border:#272734; --accent:#a18aff; --accent-bg:#7c5cff; --shadow:none;
}
[data-theme="light"] {
  color-scheme: light;
  --bg:#fafafc; --bg-elev:#ffffff; --bg-elev2:#f2f1f7; --text:#17171f; --text-dim:#5c5b70;
  --border:#e6e5ef; --accent:#6544e6; --accent-bg:#6c4cf2;
  --shadow:0 1px 2px rgba(22,18,48,.05),0 4px 16px rgba(22,18,48,.06);
}
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--text); font-family:var(--font); line-height:1.6; }
.wrap { max-width:var(--maxw); margin:0 auto; padding:0 1.25rem 4rem; }
header.site { position:sticky; top:0; z-index:5; backdrop-filter:blur(8px);
  background:color-mix(in srgb, var(--bg) 85%, transparent); border-bottom:1px solid var(--border); }
header.site .wrap { display:flex; align-items:center; justify-content:space-between; padding:0.6rem 1.25rem; }
header.site a.brand { color:var(--text); text-decoration:none; font-weight:700; letter-spacing:-0.02em; }
header.site a.brand span { color:var(--accent) }
button.theme { background:var(--bg-elev2); color:var(--text); border:1px solid var(--border);
  border-radius:999px; width:2.2rem; height:2.2rem; cursor:pointer; font-size:1rem; }
h1 { font-size:2rem; letter-spacing:-0.03em; line-height:1.15; margin:2rem 0 1rem; text-wrap:balance }
h2 { font-size:1.35rem; letter-spacing:-0.02em; margin-top:2.25rem; text-wrap:balance }
h3 { font-size:1.1rem; margin-top:1.75rem }
a { color:var(--accent); text-decoration:none } a:hover { text-decoration:underline }
code { background:var(--bg-elev2); padding:0.1rem 0.35rem; border-radius:6px; font-size:0.88em }
pre { background:var(--bg-elev); border:1px solid var(--border); border-radius:12px;
  padding:1rem; overflow-x:auto; box-shadow:var(--shadow) }
pre code { background:none; padding:0 }
blockquote { margin:1rem 0; padding:0.5rem 1rem; border-left:3px solid var(--accent);
  background:var(--bg-elev); border-radius:0 10px 10px 0; color:var(--text-dim) }
table { border-collapse:collapse; width:100%; display:block; overflow-x:auto; font-size:0.92rem }
th, td { border:1px solid var(--border); padding:0.45rem 0.6rem; text-align:left; vertical-align:top }
th { background:var(--bg-elev2) }
img { max-width:100%; border-radius:12px }
.shot { display:block; margin:1rem auto; max-width:min(100%, 26rem);
  border:1px solid var(--border); box-shadow:var(--shadow) }
.shot.wide { max-width:100% }
[data-theme="dark"] .shot-light { display:none }
[data-theme="dark"] .shot-dark { display:block }
[data-theme="light"] .shot-dark { display:none }
[data-theme="light"] .shot-light { display:block }
.card { background:var(--bg-elev); border:1px solid var(--border); border-radius:14px;
  box-shadow:var(--shadow); padding:1.1rem 1.25rem; margin:0.85rem 0 }
.card a.doc { display:block; font-weight:600; font-size:1.05rem }
.card p { margin:0.35rem 0 0; color:var(--text-dim); font-size:0.92rem }
.section-blurb { color:var(--text-dim); margin-top:-0.5rem }
footer { margin-top:3rem; color:var(--text-dim); font-size:0.85rem; border-top:1px solid var(--border); padding-top:1rem }
`;

const THEME_JS = /* js */ `
(function () {
  var saved = localStorage.getItem("nostrautica-docs:theme");
  var theme = saved || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.setAttribute("data-theme", theme);
  window.__toggleTheme = function () {
    theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("nostrautica-docs:theme", theme);
  };
})();
`;

function page(title, body, { home = false } = {}) {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — Nostrautica Docs</title>
<style>${CSS}</style>
<script>${THEME_JS}</script>
</head>
<body>
<header class="site"><div class="wrap">
  <a class="brand" href="${home ? "#" : "index.html"}"><span>✦</span> Nostrautica docs</a>
  <button class="theme" title="Toggle dark/light" onclick="__toggleTheme()">◐</button>
</div></header>
<main class="wrap">
${body}
<footer>Nostrautica — Nostr-native event matchmaking. <a href="/app">Open the app</a> · <a href="index.html">Docs index</a></footer>
</main>
</body>
</html>`;
}

/**
 * GitHub-compatible heading slugger. marked v18 emits no heading ids, so in-page
 * table-of-contents links and cross-doc `#anchor` links would all 404 without
 * this — and the anchor checker needs real ids to validate against. Reset per
 * document via `mdToHtml` so duplicate-heading disambiguation is document-local.
 */
let slugCounts = new Map();
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "") // drop punctuation, keep unicode letters/digits
    .replace(/\s+/g, "-");
}
function uniqueSlug(text) {
  const base = slugify(text) || "section";
  const seen = slugCounts.get(base) ?? 0;
  slugCounts.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen}`;
}

marked.use({
  renderer: {
    heading({ tokens, text, depth }) {
      const id = uniqueSlug(text);
      const inner = this.parser.parseInline(tokens);
      return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
    },
  },
});

/** Parse markdown → HTML with a fresh, document-local slug namespace. */
function mdToHtml(md) {
  slugCounts = new Map();
  return marked.parse(md, { gfm: true });
}

/** Turn image refs into theme-aware pairs when a -dark sibling exists. */
function themeAwareImages(html) {
  return html.replace(/<img src="(images\/[^"]+)-light\.png"([^>]*)>/g, (m, stem, rest) => {
    const darkPath = join(DOCS, `${stem}-dark.png`);
    const alt = /alt="([^"]*)"/.exec(rest)?.[1] ?? "";
    if (!existsSync(darkPath)) return `<img class="shot" src="${stem}-light.png" alt="${alt}">`;
    return (
      `<img class="shot shot-light" src="${stem}-light.png" alt="${alt}" loading="lazy">` +
      `<img class="shot shot-dark" src="${stem}-dark.png" alt="${alt}" loading="lazy">`
    );
  });
}

function render(mdFile) {
  let md = readFileSync(join(DOCS, mdFile), "utf8");
  md = md.replace(/<!--[\s\S]*?-->/g, ""); // strip build/TODO comments
  let html = mdToHtml(md);
  html = html.replace(/href="(?:\.\/)?([A-Za-z0-9_-]+)\.md(#[^"]*)?"/g, 'href="$1.html$2"');
  html = themeAwareImages(html);
  return html;
}

/**
 * Post-build link + anchor checker (audit O6). `pages` is a Map of built
 * filename → HTML string. Returns `{ errors, warnings }`:
 *   - errors:   a rewritten internal link points at a page that was never built,
 *               or at an anchor that does not exist. These fail the build.
 *   - warnings: a link still ends in `.md` — i.e. it points into the
 *               deliberately-unpublished `archive/`/`internal/` areas (or any
 *               source doc that isn't published). Reported, not fatal.
 */
export function checkInternalLinks(pages) {
  const idsByPage = new Map();
  for (const [name, html] of pages) {
    const set = new Set();
    for (const m of html.matchAll(/\b(?:id|name)="([^"]+)"/g)) set.add(m[1]);
    idsByPage.set(name, set);
  }
  const errors = [];
  const warnings = [];
  for (const [name, html] of pages) {
    for (const m of html.matchAll(/href="([^"#][^"]*)"|href="(#[^"]*)"/g)) {
      const href = m[1] ?? m[2];
      if (/^(https?:|mailto:|tel:|\/\/)/i.test(href)) continue; // external
      if (href.startsWith("/")) continue; // site-absolute (e.g. /app)
      if (href === "#") continue;
      const hashAt = href.indexOf("#");
      const path = hashAt === -1 ? href : href.slice(0, hashAt);
      const anchor = hashAt === -1 ? "" : href.slice(hashAt + 1);
      if (path === "") {
        // same-page anchor
        if (anchor && !idsByPage.get(name).has(anchor))
          errors.push(`${name}: same-page anchor "#${anchor}" has no matching id`);
        continue;
      }
      if (path.endsWith(".md")) {
        // Not rewritten → points at a source doc we don't publish (archive/…, internal/…).
        warnings.push(`${name}: link to unpublished doc "${href}"`);
        continue;
      }
      if (path.endsWith(".html")) {
        if (!pages.has(path)) {
          errors.push(`${name}: link to page "${path}" that was not built ("${href}")`);
          continue;
        }
        if (anchor && !idsByPage.get(path).has(anchor))
          errors.push(`${name}: link "${href}" → anchor "#${anchor}" missing in ${path}`);
      }
      // other relative targets (e.g. images/) are not link-checked here
    }
  }
  return { errors, warnings };
}

/** Build the whole docs site into `outDir`. Exits non-zero on broken links. */
export function build(outDir) {
  mkdirSync(outDir, { recursive: true });
  if (existsSync(join(DOCS, "images"))) cpSync(join(DOCS, "images"), join(outDir, "images"), { recursive: true });

  // Titles for index cards come from SECTIONS; docs not in SECTIONS are still
  // built (so inbound links resolve) but not featured on the index.
  const titleByFile = new Map();
  for (const s of SECTIONS) for (const d of s.docs) titleByFile.set(d.file, d.title);

  const pages = new Map(); // filename.html -> html string (for the link checker)

  // Build EVERY public top-level doc. readdirSync is non-recursive, so the
  // internal/ and archive/ subdirectories are excluded automatically.
  const topLevelDocs = readdirSync(DOCS, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();

  for (const file of topLevelDocs) {
    const out = file.replace(/\.md$/, ".html");
    const title = titleByFile.get(file) ?? file.replace(/\.md$/, "");
    const html = page(title, render(file));
    writeFileSync(join(outDir, out), html);
    pages.set(out, html);
  }

  // Any testing reports get built too (linked from the testing section dynamically).
  const reports = existsSync(join(DOCS, "testing"))
    ? readdirSync(join(DOCS, "testing")).filter((f) => f.endsWith(".md"))
    : [];
  for (const r of reports) {
    const out = `testing-${r.replace(/\.md$/, ".html")}`;
    const md = readFileSync(join(DOCS, "testing", r), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const html = page(r.replace(/\.md$/, ""), mdToHtml(md));
    writeFileSync(join(outDir, out), html);
    pages.set(out, html);
  }

  const indexBody = [
    `<h1>Nostrautica documentation</h1>`,
    `<p class="section-blurb">Meet the right people at events — intro videos, AI matchmaking, and a portable identity you keep. <a href="/app">Open the app →</a></p>`,
    ...SECTIONS.map((s) => {
      const cards = s.docs
        .filter((d) => existsSync(join(DOCS, d.file)))
        .map(
          (d) =>
            `<div class="card"><a class="doc" href="${d.file.replace(/\.md$/, ".html")}">${d.title}</a></div>`,
        )
        .join("\n");
      const reportCards =
        s.title === "Testing & quality"
          ? reports
              .map(
                (r) =>
                  `<div class="card"><a class="doc" href="testing-${r.replace(/\.md$/, ".html")}">Test report: ${r.replace(/^TEST-REPORT-|\.md$/g, "")}</a></div>`,
              )
              .join("\n")
          : "";
      return `<h2>${s.title}</h2>${s.blurb ? `<p class="section-blurb">${s.blurb}</p>` : ""}\n${cards}\n${reportCards}`;
    }),
  ].join("\n");
  const indexHtml = page("Documentation", indexBody, { home: true });
  writeFileSync(join(outDir, "index.html"), indexHtml);
  pages.set("index.html", indexHtml);

  const { errors, warnings } = checkInternalLinks(pages);
  for (const w of warnings) console.warn(`[docs] warning: ${w}`);
  if (errors.length) {
    console.error(`[docs] link check FAILED — ${errors.length} broken internal link(s):`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exitCode = 1;
    throw new Error(`docs link check failed: ${errors.length} broken internal link(s)`);
  }

  console.log(
    `[docs] built ${pages.size} pages → ${outDir}` +
      (warnings.length ? ` (${warnings.length} link warning(s))` : "") +
      `; link check passed`,
  );
  return { pages, errors, warnings };
}

// Only build when invoked directly (so tests can import the helpers above).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  build(resolveOutDir(ROOT, process.argv[2]));
}
