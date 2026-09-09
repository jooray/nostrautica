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
  return (
    s
      // NUL is the placeholder sentinel `inline()` parks emitted HTML behind.
      // Stripping it here is what makes "post content cannot forge a placeholder"
      // true rather than merely likely.
      .replaceAll("\u0000", "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
  );
}

const SAFE_URL = /^https?:\/\/[^\s<>"')]+$/;

/**
 * Placeholder sentinel for already-emitted HTML.
 *
 * `escapeHtml` strips NUL from the source, so a placeholder can never be forged
 * by post content — which is what makes "emitted HTML is invisible to later
 * passes" an invariant rather than a hope.
 */
const SLOT = "\u0000";

interface Slot {
  /** The finished HTML this placeholder stands for. */
  html: string;
  /** Its plain-text equivalent, for contexts where a tag must not appear (alt=""). */
  text: string;
}

/**
 * Inline markdown, as ONE left-to-right pass per construct with every emitted tag
 * parked behind a placeholder.
 *
 * The previous implementation chained `.replace()` passes over the whole string,
 * so each pass could see — and rewrite — the output of the passes before it. That
 * broke the module's stated invariant, which is that the output contains only tags
 * this module emits, in the places it emits them. Concretely: the image pass
 * emitted `alt="…"` from source text, and the LATER emphasis and bare-URL passes
 * then rewrote the inside of that attribute, so
 * `![a *b https://evil.com* c](https://e/x.png)` produced an `href="` inside the
 * `alt="`, terminating the attribute and injecting attributes onto the `<img>`.
 *
 * That was not exploitable as script — an injected attribute name is forced to
 * start with `https`, and SAFE_URL excludes the space an event handler would need
 * — but "not exploitable today" is not the guarantee the comment at the top of
 * this file makes, and the content it renders comes from any npub whose feed an
 * organizer has merged in. One template tweak (a `title` attribute, a reordered
 * pass, a looser URL pattern) would have turned it into stored injection.
 *
 * With placeholders the property is structural: once a construct is emitted, no
 * later pass can see inside it.
 */
function inline(s: string): string {
  const slots: Slot[] = [];
  const hold = (html: string, text: string): string => {
    slots.push({ html, text });
    return `${SLOT}${slots.length - 1}${SLOT}`;
  };
  /** Resolve placeholders to plain text — for attribute values, which take no tags. */
  const asText = (v: string): string =>
    v.replace(new RegExp(`${SLOT}(\\d+)${SLOT}`, "g"), (_m, i) => slots[Number(i)]?.text ?? "");
  /** Emphasis only. Safe to run on link text, which may legitimately carry it. */
  const emphasis = (v: string): string =>
    v.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");

  let out = s;

  // 1. Code spans first: their content is literal and must not be re-read as
  //    emphasis, a link, or a URL.
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => hold(`<code>${code}</code>`, code));

  // 2. Images. `alt` is a plain-text attribute, so any placeholder inside it
  //    resolves to TEXT — an emitted <code> must never land in an attribute.
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, url: string) =>
    SAFE_URL.test(url)
      ? hold(`<img src="${url}" alt="${asText(alt)}" loading="lazy" />`, asText(alt))
      : m,
  );

  // 3. Links. The TEXT may carry emphasis; the href may not carry anything.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) =>
    SAFE_URL.test(url)
      ? hold(
          `<a href="${url}" target="_blank" rel="noopener noreferrer">${emphasis(text)}</a>`,
          asText(text),
        )
      : m,
  );

  // 4. Emphasis over what is left — which is only ever source text now.
  out = emphasis(out);

  // 5. Bare URLs. No "am I inside a tag?" heuristic is needed any more: every tag
  //    emitted above is a placeholder, so there is nothing here to be inside of.
  out = out.replace(
    /(^|\s)(https?:\/\/[^\s<>"')]+)/g,
    (_m, pre: string, url: string) =>
      `${pre}${hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`, url)}`,
  );

  // Restore, repeatedly: held HTML can itself contain placeholders (a code span
  // inside link text). Bounded by the slot count, which only ever shrinks.
  const slotRe = new RegExp(`${SLOT}(\\d+)${SLOT}`, "g");
  for (let i = 0; i <= slots.length && slotRe.test(out); i++) {
    slotRe.lastIndex = 0;
    out = out.replace(slotRe, (_m, n) => slots[Number(n)]?.html ?? "");
  }
  return out;
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
