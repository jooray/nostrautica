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
      '<p><a href="https://x.example" target="_blank" rel="noopener">t</a></p>',
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
