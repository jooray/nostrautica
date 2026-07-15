/**
 * Static docs-site generator: docs/*.md → docs-site-build/ (HTML).
 *
 * - Index page groups the docs into sections (user guides first).
 * - Dark/light toggle (persisted, defaults to prefers-color-scheme) using the
 *   same design tokens as the app.
 * - Theme-aware screenshots: an image reference ending in `-light.png` with an
 *   existing `-dark.png` sibling renders BOTH, and CSS shows the one matching
 *   the active theme.
 * - Internal `*.md` links become `*.html`; everything is relative so the site
 *   works from any base path (deployed under /docs/, same origin as /app).
 *
 * Usage: node scripts/build-docs.mjs [outDir]   (default docs-site-build)
 */
import { marked } from "marked";
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const OUT = join(ROOT, process.argv[2] ?? "docs-site-build");

/** Site structure: sections + the docs in them (order = display order). */
const SECTIONS = [
  {
    title: "User guides",
    blurb: "Start here — how to run or attend an event.",
    docs: [
      { file: "ORGANIZER-GUIDE.md", title: "Event Organizer Guide" },
      { file: "PARTICIPANT-GUIDE.md", title: "Participant Guide" },
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
      { file: "THREAT-MODEL.md", title: "Threat Model" },
      { file: "IMPLEMENTATION_PLAN.md", title: "Implementation Plan" },
    ],
  },
  {
    title: "Testing & quality",
    docs: [
      { file: "E2E-TESTING-GUIDE.md", title: "End-to-End Testing Guide" },
      { file: "UI-SUGGESTIONS.md", title: "UI Suggestions" },
      { file: "MATCHING-BENCHMARK.md", title: "Matching Benchmark (models & prompts)" },
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
  let html = marked.parse(md, { gfm: true });
  html = html.replace(/href="(?:\.\/)?([A-Za-z0-9_-]+)\.md(#[^"]*)?"/g, 'href="$1.html$2"');
  html = themeAwareImages(html);
  return html;
}

mkdirSync(OUT, { recursive: true });
if (existsSync(join(DOCS, "images"))) cpSync(join(DOCS, "images"), join(OUT, "images"), { recursive: true });

const built = [];
for (const section of SECTIONS) {
  for (const doc of section.docs) {
    if (!existsSync(join(DOCS, doc.file))) continue;
    const out = doc.file.replace(/\.md$/, ".html");
    writeFileSync(join(OUT, out), page(doc.title, render(doc.file)));
    built.push(out);
  }
}
// Any testing reports get built too (linked from the testing section dynamically).
const reports = existsSync(join(DOCS, "testing"))
  ? readdirSync(join(DOCS, "testing")).filter((f) => f.endsWith(".md"))
  : [];
for (const r of reports) {
  const out = `testing-${r.replace(/\.md$/, ".html")}`;
  let md = readFileSync(join(DOCS, "testing", r), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  writeFileSync(join(OUT, out), page(r.replace(/\.md$/, ""), marked.parse(md, { gfm: true })));
  built.push(out);
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
writeFileSync(join(OUT, "index.html"), page("Documentation", indexBody, { home: true }));

console.log(`[docs] built ${built.length + 1} pages → ${OUT}`);
