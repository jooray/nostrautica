/**
 * Static docs-site generator: docs/*.md → docs-site-build/ (HTML).
 *
 * - EVERY public top-level `docs/*.md` file is built to a page so that
 *   `.md`→`.html` link rewriting never points at a page that was never emitted
 *   (audit O6). `docs/internal/**` and `docs/archive/**` are intentionally NOT
 *   published; they live in subdirectories and are skipped because we only scan
 *   the top level of `docs/`.
 * - `SECTIONS` controls INDEX visibility and order only. A doc absent from
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
 * - Internal `*.md` links become `*.html`, and every link the generator writes
 *   is relative. The site is deployed under /docs/ beside /app, and the "Open
 *   the app" links assume exactly that (`../app/`); other bases need that link
 *   changed (audit SB-116).
 * - A link that leaves docs/ (`../packages/…`) points at a repo file that is not
 *   deployed, so it is rewritten to the file on GitHub, and the link checker
 *   fails on any other relative target the built site does not contain (audit
 *   SB-106, SB-111). External links are not fetched.
 * - Each page declares its language from the filename (`-sk.md` → `sk`) and
 *   links its translations with hreflang (audit SB-105).
 * - The output directory's previously built pages and images are removed first,
 *   so a deleted or renamed doc stops being published (audit SB-110).
 *
 * Usage: node scripts/build-docs.mjs [outDir]   (default docs-site-build)
 * `outDir` may be relative (resolved against the repo root) or absolute
 * (used as-is, audit O7).
 */
import { marked } from "marked";
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
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
    blurb: "Start here: how to run or attend an event.",
    docs: [
      { file: "ORGANIZER-GUIDE.md", title: "Event Organizer Guide" },
      { file: "PARTICIPANT-GUIDE.md", title: "Participant Guide" },
      { file: "ORGANIZER-GUIDE-sk.md", title: "Príručka organizátora (Slovensky)" },
      { file: "PARTICIPANT-GUIDE-sk.md", title: "Príručka účastníka (Slovensky)" },
      { file: "ORGANIZER-GUIDE-cs.md", title: "Průvodce pro organizátory (Česky)" },
      { file: "PARTICIPANT-GUIDE-cs.md", title: "Průvodce pro účastníky (Česky)" },
      { file: "ORGANIZER-GUIDE-de.md", title: "Leitfaden für Veranstalter (Deutsch)" },
      { file: "PARTICIPANT-GUIDE-de.md", title: "Leitfaden für Teilnehmende (Deutsch)" },
      { file: "ORGANIZER-GUIDE-es.md", title: "Guía para organizadores (Español)" },
      { file: "PARTICIPANT-GUIDE-es.md", title: "Guía para asistentes (Español)" },
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
header.site nav { display:flex; align-items:center; gap:0.85rem; font-size:0.9rem; }
header.site .langs { display:flex; gap:0.4rem; }
header.site .langs a[aria-current] { color:var(--text); font-weight:600; }
a.skip { position:absolute; left:-9999px; top:0; z-index:10; background:var(--bg-elev);
  padding:0.5rem 0.9rem; border:1px solid var(--border); border-radius:8px; }
a.skip:focus { left:0.75rem; top:0.75rem; }
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

/**
 * Theme bootstrap. Every storage access is guarded: with cookies blocked (Safari
 * private mode and friends) `localStorage` throws, which used to abort the whole
 * script before the toggle was wired, leaving a dead button stuck on dark
 * (audit SB-107). The key is the landing page's, so a choice made on one of the
 * two static sites carries to the other; the old docs-only key is still read
 * once (audit SB-119). The app keeps its own key on purpose: its preference has
 * a third value ("system") and is mirrored into the account's settings.
 */
const THEME_KEY = "nostrautica-theme";
export const THEME_JS = /* js */ `
(function () {
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  var saved = get("${THEME_KEY}") || get("nostrautica-docs:theme");
  var theme = saved === "light" || saved === "dark" ? saved
    : (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.setAttribute("data-theme", theme);
  function toggle() {
    theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("${THEME_KEY}", theme); } catch (e) { /* session only */ }
  }
  document.addEventListener("DOMContentLoaded", function () {
    var b = document.getElementById("theme-toggle");
    if (b) b.addEventListener("click", toggle);
  });
})();
`;
/** CSP hash of the one inline script, so the policy needs no 'unsafe-inline' for scripts. */
const THEME_JS_HASH = `sha256-${createHash("sha256").update(THEME_JS).digest("base64")}`;

/**
 * The docs render `marked` output, which passes raw HTML through. A CSP keeps a
 * stray <script> or remote embed in a markdown file from running or loading
 * (audit SB-114): the only script allowed is the theme bootstrap, by hash.
 */
export const DOCS_CSP = [
  "default-src 'self'",
  `script-src '${THEME_JS_HASH}'`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

// Same mark as the landing page's favicon.
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cpath fill='%236d28d9' d='M50 2c4 38 8 42 46 48-38 6-42 10-46 48-4-38-8-42-46-48 38-6 42-10 46-48Z'/%3E%3C/svg%3E";

const LANG_NAMES = { en: "English", sk: "Slovensky", cs: "Česky", de: "Deutsch", es: "Español" };

/** `ORGANIZER-GUIDE-sk.md` → "sk"; anything without a language suffix is English. */
export function langOf(file) {
  return /-(sk|cs|de|es)\.md$/.exec(file)?.[1] ?? "en";
}

/**
 * The translations of `file` that exist in `files`, as [lang, html filename]
 * pairs (including `file` itself). Empty when the doc has no translation.
 */
export function alternatesOf(file, files) {
  const base = file.replace(/-(sk|cs|de|es)\.md$/, ".md").replace(/-en\.md$/, ".md");
  const stem = base.replace(/\.md$/, "");
  const out = [];
  for (const lang of Object.keys(LANG_NAMES)) {
    const candidates = lang === "en" ? [`${stem}.md`, `${stem}-en.md`] : [`${stem}-${lang}.md`];
    const hit = candidates.find((c) => files.includes(c));
    if (hit) out.push([lang, hit.replace(/\.md$/, ".html")]);
  }
  return out.length > 1 ? out : [];
}

const escapeAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** First paragraph of the rendered body as plain text, for <meta name="description">. */
export function summaryOf(html) {
  const p = /<p>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
  const text = p
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 160 ? `${text.slice(0, 157).replace(/\s+\S*$/, "")}…` : text;
}

function page(title, body, { home = false, lang = "en", description = "", alternates = [] } = {}) {
  const altLinks = alternates
    .map(([l, href]) => `<link rel="alternate" hreflang="${l}" href="${href}" />`)
    .concat(alternates.length ? [`<link rel="alternate" hreflang="x-default" href="${alternates[0][1]}" />`] : [])
    .join("\n");
  const langNav = alternates
    .map(([l, href]) =>
      l === lang
        ? `<a aria-current="page" lang="${l}" hreflang="${l}" href="${href}">${l.toUpperCase()}</a>`
        : `<a lang="${l}" hreflang="${l}" href="${href}" title="${LANG_NAMES[l]}">${l.toUpperCase()}</a>`,
    )
    .join(" ");
  return `<!doctype html>
<html lang="${lang}" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="${DOCS_CSP}" />
<title>${title} · Nostrautica Docs</title>
${description ? `<meta name="description" content="${escapeAttr(description)}" />\n` : ""}<link rel="icon" href="${FAVICON}" />
${altLinks}
<style>${CSS}</style>
<script>${THEME_JS}</script>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="site"><div class="wrap">
  <a class="brand" href="${home ? "#" : "index.html"}"><span aria-hidden="true">✦</span> Nostrautica docs</a>
  <nav aria-label="Documentation">
    ${home ? "" : `<a href="index.html">All docs</a>`}
    ${langNav ? `<span class="langs" aria-label="Language">${langNav}</span>` : ""}
    <button type="button" class="theme" id="theme-toggle" aria-label="Toggle dark or light theme" title="Toggle dark/light"><span aria-hidden="true">◐</span></button>
  </nav>
</div></header>
<main class="wrap" id="content">
${body}
<footer>Nostrautica: Nostr-native event matchmaking. <a href="../app/">Open the app</a> · <a href="index.html">Docs index</a></footer>
</main>
</body>
</html>`;
}

/**
 * GitHub-compatible heading slugger. marked v18 emits no heading ids, so in-page
 * table-of-contents links and cross-doc `#anchor` links would all 404 without
 * this, and the anchor checker needs real ids to validate against. Reset per
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

/** Where a repo file outside docs/ can be read, since the site doesn't deploy it. */
export const REPO_BLOB = "https://github.com/jooray/nostrautica/blob/main/";

/**
 * Rewrite links that climb out of docs/ (`../packages/…`) to the file on
 * GitHub. On GitHub the relative link works; on the deployed site it was a 404
 * in all five organizer guides (audit SB-106). Only files that exist in the repo
 * are rewritten, so a typo stays relative and the link checker catches it.
 */
export function rewriteRepoLinks(html, root) {
  return html.replace(/href="\.\.\/([^"#]+)(#[^"]*)?"/g, (m, path, hash = "") =>
    existsSync(join(root, path)) ? `href="${REPO_BLOB}${path}${hash}"` : m,
  );
}

function render(mdFile) {
  let md = readFileSync(join(DOCS, mdFile), "utf8");
  md = md.replace(/<!--[\s\S]*?-->/g, ""); // strip build/TODO comments
  let html = mdToHtml(md);
  html = html.replace(/href="(?:\.\/)?([A-Za-z0-9_-]+)\.md(#[^"]*)?"/g, 'href="$1.html$2"');
  html = rewriteRepoLinks(html, ROOT);
  html = themeAwareImages(html);
  return html;
}

/**
 * Post-build link + anchor checker (audit O6). `pages` is a Map of built
 * filename → HTML string. Returns `{ errors, warnings }`:
 *   - errors:   a rewritten internal link points at a page that was never built,
 *               or at an anchor that does not exist. These fail the build.
 *   - warnings: a link still ends in `.md`, i.e. it points into the
 *               deliberately-unpublished `archive/`/`internal/` areas (or any
 *               source doc that isn't published). Reported, not fatal.
 */
/** Relative links to what is deployed next to the docs (see the header comment). */
const SIBLING_ROUTES = ["../app/"];

export function checkInternalLinks(pages, { exists } = {}) {
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
      if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue; // external, data:, mailto: …
      if (href.startsWith("/")) continue; // site-absolute (e.g. /app)
      if (href === "#") continue;
      if (SIBLING_ROUTES.includes(href)) continue; // deployed beside /docs/, not in it
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
        continue;
      }
      // Any other relative target (images/…, a stray ../ path) must be a file in
      // the built site. This used to be skipped, so a ../packages/….toml link
      // 404'd in production behind a green "link check passed" (SB-106/SB-111).
      if (exists && !exists(decodeURI(path)))
        errors.push(`${name}: link "${href}" points at a file the site does not contain`);
    }
  }
  return { errors, warnings };
}

/** Build the whole docs site into `outDir`. Exits non-zero on broken links. */
/**
 * Remove what a previous build wrote: top-level pages and the images copy.
 * Without this a deleted or renamed doc kept its old page, the deploy rsynced
 * it, and the link checker never saw it because it only checks this run's
 * pages (audit SB-110). Deliberately narrow (not an rm -rf of outDir), since
 * outDir may be any absolute path the caller passes.
 */
export function cleanOutDir(outDir) {
  if (!existsSync(outDir)) return;
  for (const e of readdirSync(outDir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".html")) rmSync(join(outDir, e.name));
  }
  rmSync(join(outDir, "images"), { recursive: true, force: true });
}

export function build(outDir) {
  cleanOutDir(outDir);
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
    const body = render(file);
    const html = page(title, body, {
      lang: langOf(file),
      description: summaryOf(body),
      alternates: alternatesOf(file, topLevelDocs),
    });
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
    const body = mdToHtml(md);
    const html = page(r.replace(/\.md$/, ""), body, { description: summaryOf(body) });
    writeFileSync(join(outDir, out), html);
    pages.set(out, html);
  }

  const indexBody = [
    `<h1>Nostrautica documentation</h1>`,
    `<p class="section-blurb">Meet the right people at events: intro videos, AI matchmaking, and a portable identity you keep. <a href="../app/">Open the app →</a></p>`,
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
  const indexHtml = page("Documentation", indexBody, {
    home: true,
    description: "Nostrautica documentation: guides for organizers and attendees in five languages, plus the protocol, threat model and operations docs.",
  });
  writeFileSync(join(outDir, "index.html"), indexHtml);
  pages.set("index.html", indexHtml);

  const { errors, warnings } = checkInternalLinks(pages, {
    exists: (p) => existsSync(join(outDir, p)),
  });
  for (const w of warnings) console.warn(`[docs] warning: ${w}`);
  if (errors.length) {
    console.error(`[docs] link check FAILED: ${errors.length} broken internal link(s):`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exitCode = 1;
    throw new Error(`docs link check failed: ${errors.length} broken internal link(s)`);
  }

  const missingAssets = checkLandingAssets(ROOT);
  if (missingAssets.length) {
    console.error(`[docs] landing-page asset check FAILED: ${missingAssets.length} missing file(s):`);
    for (const m of missingAssets) console.error(`  ✗ web/${m}`);
    process.exitCode = 1;
    throw new Error(`landing page references ${missingAssets.length} file(s) that do not exist`);
  }

  const staleVersions = checkLandingAssetVersions(ROOT);
  if (staleVersions.length) {
    console.error(`[docs] landing asset version check FAILED: ${staleVersions.length} stale stamp(s):`);
    for (const m of staleVersions) console.error(`  ✗ ${m}`);
    console.error(`  run: node scripts/stamp-landing-assets.mjs`);
    process.exitCode = 1;
    throw new Error(`landing page references ${staleVersions.length} asset(s) with a stale ?v= stamp`);
  }

  const missingImages = checkGuideImages(ROOT);
  if (missingImages.length) {
    console.error(`[docs] guide image check FAILED: ${missingImages.length} missing file(s):`);
    for (const m of missingImages) console.error(`  ✗ docs/${m}`);
    process.exitCode = 1;
    throw new Error(`the guides reference ${missingImages.length} image(s) that do not exist`);
  }

  console.log(
    `[docs] built ${pages.size} pages → ${outDir}` +
      (warnings.length ? ` (${warnings.length} link warning(s))` : "") +
      `; internal link check passed (external links are not fetched); landing assets OK; asset stamps OK; guide images OK`,
  );
  return { pages, errors, warnings };
}


/**
 * Every local asset `web/index.html` embeds must exist on disk.
 *
 * The landing page is hand-written and its images are produced by a different
 * tool (`e2e/screenshot-refresh.mjs`), so nothing connected the two: when the
 * People/Matches merge renamed the `11-matches` stem to `11-people-matches`,
 * index.html kept pointing at the old name and the site's HERO image — the one
 * carrying `fetchpriority="high"` — was a 404 in production until 2026-09-14.
 * Nobody noticed because a missing <img> renders as empty space, and the docs
 * link checker below only ever looked at the docs pages.
 *
 * Deliberately part of the deploy build rather than a unit test: the build is
 * what the post-receive hook runs, so a broken reference stops the deploy
 * instead of shipping and waiting to be spotted.
 */
/**
 * Every local CSS/JS the landing page loads must carry a `?v=` matching its
 * current contents.
 *
 * nginx serves index.html with `cache-control: no-cache` and its assets with
 * `max-age=86400`, so the two can be a day out of step on a returning visitor.
 * That is how the five-language switcher shipped broken: new markup carrying a
 * <select> the cached CSS had no rule for (so both switchers rendered), driven by
 * cached JS that still listed three languages (so DE and ES silently loaded
 * English). Nothing was wrong with what was deployed; the browser simply held
 * half of it.
 *
 * The stamp is what breaks the tie, and this is what makes forgetting it loud.
 * In the deploy build rather than a unit test, for the same reason as the checks
 * around it: the build is what the post-receive hook runs.
 */
export function checkLandingAssetVersions(root) {
  const landing = join(root, "web", "index.html");
  if (!existsSync(landing)) return [];
  const html = readFileSync(landing, "utf8");
  const stale = [];
  const re = /(?:href|src)="([^"]+\.(?:css|js))(?:\?v=([0-9a-f]+))?"/g;
  for (const m of html.matchAll(re)) {
    const [, ref, declared] = m;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(ref)) continue;
    const abs = join(root, "web", ref);
    if (!existsSync(abs)) continue; // checkLandingAssets already reports this
    const actual = createHash("sha256").update(readFileSync(abs)).digest("hex").slice(0, 8);
    if (!declared) stale.push(`web/${ref} has no ?v= stamp`);
    else if (declared !== actual) stale.push(`web/${ref}?v=${declared} but the file hashes to ${actual}`);
  }
  return stale;
}

/**
 * Every image the docs reference must exist, in both themes.
 *
 * The same class of bug as checkLandingAssets above, one directory over: a
 * missing <img> renders as blank space, the link checker only ever looked at
 * links between pages, and `e2e/screenshot-refresh.mjs` exits 0 when a stem is
 * SKIPPED rather than captured (a skip is a normal outcome there, since the
 * coordinator double can go inert mid-run). So a guide can ship pointing at an
 * image nobody ever took and the only symptom is a gap on the page.
 *
 * Both themes, because of the pairing rule this generator implements: a
 * reference ending `-light.png` also renders its `-dark.png` sibling. A missing
 * dark file is invisible while you are reading in light mode.
 *
 * Shares its implementation with `scripts/check-guide-images.mjs`, which is the
 * same check runnable on its own while editing a guide.
 */
export function checkGuideImages(root) {
  const docsDir = join(root, "docs");
  if (!existsSync(docsDir)) return [];
  const missing = new Set();
  for (const file of readdirSync(docsDir).filter((f) => f.endsWith(".md"))) {
    const md = readFileSync(join(docsDir, file), "utf8");
    const refs = new Set();
    for (const m of md.matchAll(/!\[[^\]]*\]\((images\/[^)\s]+\.png)\)/g)) refs.add(m[1]);
    for (const m of md.matchAll(/<img[^>]+src="(images\/[^"]+\.png)"/g)) refs.add(m[1]);
    for (const ref of refs) {
      const needed = ref.endsWith("-light.png")
        ? [ref, ref.replace(/-light\.png$/, "-dark.png")]
        : [ref];
      for (const need of needed) {
        if (!existsSync(join(docsDir, need))) missing.add(need);
      }
    }
  }
  return [...missing].sort();
}

export function checkLandingAssets(root) {
  const landing = join(root, "web", "index.html");
  if (!existsSync(landing)) return [];
  const html = readFileSync(landing, "utf8");
  const refs = new Set();
  // The lookbehind matters: without it `data-i18n-href="footer.x_href"` matches
  // on its `-href` tail and every i18n key is reported as a missing file.
  for (const m of html.matchAll(/(?<![-\w])(src|srcset|href)="([^"]+)"/g)) {
    const [, attr, value] = m;
    // Only srcset is a comma-separated candidate list with descriptors. Splitting
    // src/href the same way tears a `data:image/svg+xml,...` URI apart at its
    // commas and spaces and reports the fragments as missing files.
    const candidates =
      attr === "srcset" ? value.split(",").map((c) => c.trim().split(/\s+/)[0]) : [value.trim()];
    for (const ref of candidates) {
      if (!ref) continue;
      // Local, relative, and a real file reference: skip absolute URLs, anchors,
      // protocol-relative links, data URIs, and root-relative app/docs routes the
      // static server resolves outside web/.
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(ref)) continue;
      refs.add(ref.split("?")[0].split("#")[0]);
    }
  }
  const missing = [];
  for (const ref of refs) {
    if (!existsSync(join(root, "web", ref))) missing.push(ref);
  }
  return missing.sort();
}

// Only build when invoked directly (so tests can import the helpers above).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  build(resolveOutDir(ROOT, process.argv[2]));
}
