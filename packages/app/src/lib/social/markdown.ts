/**
 * Minimal markdown → HTML for event updates and posts (spec §7.1 / §7.4 / §16.3).
 * The source is HTML-escaped BEFORE any markdown transformation, so the output
 * can only contain the tags this module emits — safe to bind with {@html} even
 * though post content is organizer-authored, not app-authored. Never raw HTML.
 *
 * Supported: headings, bold/italic, inline code, links, images, fenced code
 * blocks, tables, nested (un)ordered lists, paragraphs. Anything fancier
 * renders as its literal markdown, which is honest and harmless.
 */

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const SAFE_URL = /^https?:\/\/[^\s<>"')]+$/;

function inline(s: string): string {
  return (
    s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      // ![alt](url) — only http(s); alt/url were already entity-escaped
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) =>
        SAFE_URL.test(url)
          ? `<img src="${url}" alt="${alt}" loading="lazy" />`
          : m,
      )
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      // [text](url) — only http(s), and the url was already entity-escaped
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) =>
        SAFE_URL.test(url)
          ? `<a href="${url}" target="_blank" rel="noopener">${text}</a>`
          : m,
      )
      // bare urls — but NOT inside an already-emitted tag (e.g. the alt="…" of
      // an <img> emitted above) or inside an emitted <a> (audit APPR-6). The
      // source was HTML-escaped first, so raw `<`/`>` only ever come from OUR
      // tags: an unclosed `<` before the match means "inside a tag", and an
      // unclosed `<a ` means "inside a link" (nesting <a> is invalid HTML).
      .replace(
        /(^|\s)(https?:\/\/[^\s<>"')]+)/g,
        (m, pre, url, offset: number, whole: string) => {
          const before = whole.slice(0, offset);
          if (before.lastIndexOf("<") > before.lastIndexOf(">")) return m;
          if (before.lastIndexOf("<a ") > before.lastIndexOf("</a>")) return m;
          return `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`;
        },
      )
  );
}

// ── Nested lists ─────────────────────────────────────────────────────────────

const LIST_ITEM = /^(\s*)(?:([-*])|(\d+)[.)])\s+(.*)$/;

function isListBlock(lines: string[]): boolean {
  return lines.every((l) => LIST_ITEM.test(l));
}

/** Render a run of list-item lines into (possibly nested) <ul>/<ol>. */
function listBlock(lines: string[]): string {
  const stack: { indent: number; tag: "ul" | "ol" }[] = [];
  let out = "";
  const closeOne = () => {
    const top = stack.pop()!;
    out += `</li></${top.tag}>`;
  };
  for (const line of lines) {
    const m = line.match(LIST_ITEM)!;
    const indent = m[1].length;
    const tag: "ul" | "ol" = m[2] ? "ul" : "ol";
    const text = inline(m[4]);
    while (stack.length && stack[stack.length - 1].indent > indent) closeOne();
    const top = stack[stack.length - 1];
    if (top && top.indent === indent && top.tag !== tag) closeOne();
    if (!stack.length || stack[stack.length - 1].indent < indent) {
      stack.push({ indent, tag });
      out += `<${tag}><li>${text}`;
    } else {
      out += `</li><li>${text}`;
    }
  }
  while (stack.length) closeOne();
  return out;
}

// ── Tables ───────────────────────────────────────────────────────────────────

// Header row, then a separator row of |---|:---:|… (at least one dash).
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isTableBlock(lines: string[]): boolean {
  return (
    lines.length >= 2 &&
    lines[0].includes("|") &&
    TABLE_SEPARATOR.test(lines[1]) &&
    lines[1].includes("-")
  );
}

function tableCells(line: string): string[] {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|")) l = l.slice(0, -1);
  return l.split("|").map((c) => c.trim());
}

function tableBlock(lines: string[]): string {
  const header = tableCells(lines[0])
    .map((c) => `<th>${inline(c)}</th>`)
    .join("");
  const body = lines
    .slice(2)
    .filter((l) => l.trim().length > 0)
    .map(
      (l) =>
        `<tr>${tableCells(l)
          .map((c) => `<td>${inline(c)}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  // Wrapper so wide tables scroll inside the card instead of breaking layout.
  return `<div class="md-table"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ── Blocks ───────────────────────────────────────────────────────────────────

function renderBlocks(escaped: string): string {
  const blocks = escaped.split(/\n{2,}/);
  const html = blocks.map((block) => {
    const b = block.replace(/^\n+|\n+$/g, "");
    if (!b.trim()) return "";
    const lines = b.split("\n");
    const h = b.match(/^(#{1,3})\s+(.*)$/s);
    if (h) {
      const level = h[1].length + 2; // #→h3 … ###→h5 (page h1/h2 stay unique)
      return `<h${level}>${inline(h[2].trim())}</h${level}>`;
    }
    if (isListBlock(lines)) return listBlock(lines);
    if (isTableBlock(lines)) return tableBlock(lines);
    return `<p>${inline(b.trim()).replaceAll("\n", "<br />")}</p>`;
  });
  return html.filter(Boolean).join("\n");
}

export function renderMarkdown(md: string): string {
  // Escape EVERYTHING first (the non-negotiable invariant), then carve out
  // fenced code blocks so their contents skip all further transformation.
  const escaped = escapeHtml(md.replaceAll("\r\n", "\n"));
  const parts: string[] = [];
  // ```lang\n code \n``` — fences must sit on their own lines.
  const fence = /(?:^|\n)```[^\n`]*\n([\s\S]*?)\n```(?=\n|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(escaped)) !== null) {
    const before = escaped.slice(last, m.index);
    if (before.trim()) parts.push(renderBlocks(before));
    parts.push(`<pre><code>${m[1]}</code></pre>`);
    last = m.index + m[0].length;
  }
  const rest = escaped.slice(last);
  if (rest.trim()) parts.push(renderBlocks(rest));
  return parts.join("\n");
}
