import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown.js";

describe("renderMarkdown — escape-first invariant (spec §7.4: never raw HTML)", () => {
  it("neutralizes <script> payloads", () => {
    const html = renderMarkdown('hello <script>alert("xss")</script> world');
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("neutralizes onerror= injection via fake img markup", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> and ![a](x" onerror="alert(1))');
    expect(html).not.toContain("<img src=x");
    expect(html).not.toMatch(/<img[^>]*onerror/);
    expect(html).toContain("&lt;img");
  });

  it("refuses javascript: URLs in links and images", () => {
    const html = renderMarkdown("[click](javascript:alert(1)) ![pic](javascript:alert(1))");
    // Stays literal text — never an element whose href/src could execute.
    expect(html).not.toContain("<a");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('src="javascript:');
  });

  it("escapes HTML inside fenced code blocks too", () => {
    const html = renderMarkdown('```\n<script>alert("x")</script>\n```');
    expect(html).toContain("<pre><code>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes HTML inside table cells and list items", () => {
    const html = renderMarkdown(
      "| a | b |\n|---|---|\n| <b onclick=x>hi</b> | ok |\n\n- <svg onload=alert(1)>",
    );
    expect(html).not.toMatch(/<b\s/);
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;svg");
  });

  it("quotes in text cannot terminate emitted attributes", () => {
    const html = renderMarkdown('![al"t](https://x.example/a.png)');
    expect(html).toContain("&quot;");
    expect(html).not.toContain('al"t');
  });
});

describe("renderMarkdown — features", () => {
  it("keeps the original basics: headings, bold, italic, code, links", () => {
    expect(renderMarkdown("# Title")).toBe("<h3>Title</h3>");
    expect(renderMarkdown("**b** *i* `c`")).toBe(
      "<p><strong>b</strong> <em>i</em> <code>c</code></p>",
    );
    expect(renderMarkdown("[t](https://x.example)")).toBe(
      '<p><a href="https://x.example" target="_blank" rel="noopener noreferrer">t</a></p>',
    );
  });

  it("renders https images", () => {
    expect(renderMarkdown("![alt text](https://x.example/p.png)")).toBe(
      '<p><img src="https://x.example/p.png" alt="alt text" loading="lazy" /></p>',
    );
  });

  it("renders fenced code blocks verbatim (no inline markdown inside)", () => {
    const html = renderMarkdown("```js\nconst a = **not bold**;\n```");
    expect(html).toBe("<pre><code>const a = **not bold**;</code></pre>");
  });

  it("renders blocks around a fence normally", () => {
    const html = renderMarkdown("before\n\n```\ncode\n```\n\nafter");
    expect(html).toContain("<p>before</p>");
    expect(html).toContain("<pre><code>code</code></pre>");
    expect(html).toContain("<p>after</p>");
  });

  it("renders tables with header and body", () => {
    const html = renderMarkdown("| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |");
    expect(html).toContain('<div class="md-table"><table>');
    expect(html).toContain("<thead><tr><th>A</th><th>B</th></tr></thead>");
    expect(html).toContain("<tr><td>1</td><td>2</td></tr>");
    expect(html).toContain("<tr><td>3</td><td>4</td></tr>");
  });

  it("renders nested unordered lists", () => {
    const html = renderMarkdown("- a\n  - a1\n  - a2\n- b");
    expect(html).toBe("<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>");
  });

  it("renders ordered lists and mixed nesting", () => {
    const html = renderMarkdown("1. one\n2. two\n  - sub\n3. three");
    expect(html).toBe(
      "<ol><li>one</li><li>two<ul><li>sub</li></ul></li><li>three</li></ol>",
    );
  });

  it("plain paragraphs and line breaks still work", () => {
    expect(renderMarkdown("a\nb\n\nc")).toBe("<p>a<br />b</p>\n<p>c</p>");
  });

  it("non-list, non-table pipe/dash text stays a paragraph", () => {
    expect(renderMarkdown("a | b")).toBe("<p>a | b</p>");
    expect(renderMarkdown("- not a list because\nthis line is plain")).toContain("<p>");
  });
});

describe("renderMarkdown — autolink stays out of emitted tags (audit APPR-6)", () => {
  it("does not splice an <a> inside an emitted img's alt attribute", () => {
    const html = renderMarkdown("![x https://e.com](https://ok.png)");
    expect(html).toBe('<p><img src="https://ok.png" alt="x https://e.com" loading="lazy" /></p>');
  });

  it("does not nest an <a> inside an emitted link's text", () => {
    const html = renderMarkdown("[a https://e.com b](https://ok)");
    expect(html).toBe(
      '<p><a href="https://ok" target="_blank" rel="noopener noreferrer">a https://e.com b</a></p>',
    );
  });

  it("still autolinks genuine bare urls around emitted tags", () => {
    const html = renderMarkdown("see https://a.com and ![x https://e.com](https://ok.png) done");
    expect(html).toBe(
      '<p>see <a href="https://a.com" target="_blank" rel="noopener noreferrer">https://a.com</a> and <img src="https://ok.png" alt="x https://e.com" loading="lazy" /> done</p>',
    );
  });
});


/**
 * Emitted HTML must never be re-read by a later pass (2026-09-04 audit).
 *
 * The renderer used to chain `.replace()` passes over the whole string, so each
 * pass could rewrite the output of the ones before it. The image pass emitted an
 * `alt="..."` built from source text, and the later emphasis and bare-URL passes
 * then rewrote the inside of that attribute — producing an `href="` inside the
 * `alt="`, terminating the attribute and injecting attributes onto the `<img>`.
 *
 * Never exploitable as script (an injected attribute name is forced to start with
 * `https`, and SAFE_URL excludes the space an event handler needs), but the
 * module's stated invariant — "the output can only contain the tags this module
 * emits" — was simply false, and its content comes from any npub whose feed an
 * organizer merged in.
 */
describe("renderMarkdown — emitted tags are opaque to later passes", () => {
  it("does not let an image's alt text grow an href", () => {
    const html = renderMarkdown("![a *b https://evil.com* c](https://e/x.png)");
    // Exactly one tag, and it is the image.
    expect(html.match(/<img /g)?.length).toBe(1);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    // The alt attribute is closed before anything else can start.
    const alt = /alt="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(alt).not.toContain("<");
    expect(alt).not.toContain("=");
  });

  it("does not put an emitted code span inside an alt attribute", () => {
    const html = renderMarkdown("![a `code` b](https://e/x.png)");
    const alt = /alt="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(alt).toBe("a code b");
    expect(html).not.toContain("<code>");
  });

  it("does not autolink a URL that is already inside an emitted href", () => {
    const html = renderMarkdown("[t](https://x.example/a?b=https://y.example)");
    expect(html.match(/<a /g)?.length).toBe(1);
  });

  it("still renders emphasis inside link text, and code inside it", () => {
    const html = renderMarkdown("[a *b* `c`](https://x.example)");
    expect(html).toContain("<em>b</em>");
    expect(html).toContain("<code>c</code>");
    expect(html.match(/<a /g)?.length).toBe(1);
  });

  it("post content cannot forge a placeholder", () => {
    // NUL is the sentinel; escapeHtml strips it, so a source NUL cannot become one.
    const forged = "before " + String.fromCharCode(0) + "0" + String.fromCharCode(0) + " after";
    const html = renderMarkdown(forged);
    expect(html).not.toContain(String.fromCharCode(0));
    expect(html).toContain("before 0 after");
  });
});
