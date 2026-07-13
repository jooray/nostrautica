/**
 * Minimal markdown → HTML for event updates (spec §7.1 / §16.3). The source is
 * HTML-escaped BEFORE any markdown transformation, so the output can only
 * contain the tags this module emits — safe to bind with {@html} even though
 * update content is organizer-authored, not app-authored. Deliberately tiny:
 * headings, bold/italic, inline code, links, lists, paragraphs. Anything
 * fancier renders as its literal markdown, which is honest and harmless.
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
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      // [text](url) — only http(s), and the url was already entity-escaped
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) =>
        SAFE_URL.test(url)
          ? `<a href="${url}" target="_blank" rel="noopener">${text}</a>`
          : m,
      )
      // bare urls
      .replace(
        /(^|\s)(https?:\/\/[^\s<>"')]+)/g,
        (_m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`,
      )
  );
}

export function renderMarkdown(md: string): string {
  const blocks = escapeHtml(md.replaceAll("\r\n", "\n")).split(/\n{2,}/);
  const html = blocks.map((block) => {
    const b = block.trim();
    if (!b) return "";
    const h = b.match(/^(#{1,3})\s+(.*)$/s);
    if (h) {
      const level = h[1].length + 2; // #→h3 … ###→h5 (page h1/h2 stay unique)
      return `<h${level}>${inline(h[2].trim())}</h${level}>`;
    }
    if (b.split("\n").every((l) => /^[-*]\s+/.test(l))) {
      const items = b
        .split("\n")
        .map((l) => `<li>${inline(l.replace(/^[-*]\s+/, ""))}</li>`)
        .join("");
      return `<ul>${items}</ul>`;
    }
    return `<p>${inline(b).replaceAll("\n", "<br />")}</p>`;
  });
  return html.filter(Boolean).join("\n");
}
