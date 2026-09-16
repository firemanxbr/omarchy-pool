import { describe, expect, it } from "vitest";
import { lead, outline, renderMarkdown, sectionText, slug } from "../src/markdown";
import { MD_CHAPTERS } from "../src/pages/docs-tree";
import { resolveLink } from "../src/pages/doc";

const SAMPLE = `# The title

The first paragraph, with *emphasis*, **strong**, \`code\` and a [link](RUNBOOK.md#releasing).

## Lists

- one
- two, with a
  continuation line
  - nested
- three

1. first
2. second

## A table

| Kind | What |
|---|---|
| \`sync\` | reads upstream |
| \`promote\` | on evidence |

## Code

\`\`\`bash
pkg-repo job sync
\`\`\`

> a quote

![Publishing layer](diagrams/publishing-layer.svg)

## Code
`;

describe("the markdown the chapters are written in", () => {
  it("renders headings with anchors, lists, tables, code, quotes and figures", () => {
    const html = renderMarkdown(SAMPLE, { skipTitle: true, link: (h) => resolveLink("docs", h) });
    expect(html).not.toContain("<h1");
    expect(html).toContain('<h2 id="lists"><a class="anchor" href="#lists">Lists</a></h2>');
    expect(html).toContain('<h2 id="code-2">');
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("<strong>strong</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<a href="/docs/runbook#releasing">link</a>');
    expect(html).toContain("<ul><li>one</li><li>two, with a continuation line<ul><li>nested</li></ul></li><li>three</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(html).toContain("<th>Kind</th>");
    expect(html).toContain("<td><code>sync</code></td><td>reads upstream</td>");
    expect(html).toContain('<pre><code class="lang-bash">pkg-repo job sync</code></pre>');
    expect(html).toContain("<blockquote><p>a quote</p></blockquote>");
    expect(html).toContain('<img src="/docs/diagrams/publishing-layer.svg" alt="Publishing layer">');
    // Text is escaped, never interpreted.
    expect(renderMarkdown("a <script>alert(1)</script> b")).toBe("<p>a &lt;script&gt;alert(1)&lt;/script&gt; b</p>");
  });

  it("reads the outline, the lead and a section's text", () => {
    expect(outline(SAMPLE).map((h) => `${h.level}:${h.id}`)).toEqual(["1:the-title", "2:lists", "2:a-table", "2:code", "2:code-2"]);
    expect(lead(SAMPLE)).toBe("The first paragraph, with emphasis, strong, code and a link.");
    expect(sectionText(SAMPLE, "lists")).toBe("one two, with a continuation line nested three first second");
    expect(slug("Releasing the pool itself")).toBe("releasing-the-pool-itself");
  });

  it("resolves the links the chapters were written with", () => {
    expect(resolveLink("docs", "RUNBOOK.md#releasing-the-pool-itself")).toBe("/docs/runbook#releasing-the-pool-itself");
    expect(resolveLink("docs", "../factory/README.md")).toBe("/docs/factory");
    expect(resolveLink("factory", "../docs/TESTING.md")).toBe("/docs/testing");
    expect(resolveLink(".", "docs/GOVERNANCE.md")).toBe("/docs/governance");
    expect(resolveLink(".", "docs/upstream/README.md")).toBe("/docs/open-work#findings-to-report-upstream");
    expect(resolveLink("poc", "RESULTS.md")).toBe("/docs/proof-of-concept#results");
    expect(resolveLink("docs", "diagrams/promotion-gates.svg")).toBe("/docs/diagrams/promotion-gates.svg");
    expect(resolveLink("docs", "../worker/src/pages/governance.ts")).toBe("https://github.com/firemanxbr/omarchy-pool/blob/main/worker/src/pages/governance.ts");
    expect(resolveLink("poc", "crates/pkg-store")).toBe("https://github.com/firemanxbr/omarchy-pool/tree/main/poc/crates/pkg-store");
    expect(resolveLink("factory/host", "../../../../review")).toBe("/review");
    expect(resolveLink("docs", "https://omarchy.org/")).toBe("https://omarchy.org/");
    expect(resolveLink("docs", "#the-guard")).toBe("#the-guard");
  });

  it("renders every chapter without leaving markdown behind", () => {
    for (const c of MD_CHAPTERS) {
      const html = renderMarkdown(c.text, { skipTitle: true, link: (h) => resolveLink(c.from, h) });
      const text = html.replace(/<pre><code[\s\S]*?<\/code><\/pre>/g, "").replace(/<code>[^<]*<\/code>/g, "");
      expect(text, `${c.key}: a link left as written`).not.toMatch(/\]\(/);
      expect(text, `${c.key}: strong left as written`).not.toMatch(/\*\*[^*]+\*\*/);
      expect(text, `${c.key}: a heading left as written`).not.toMatch(/<p>#{1,4} /);
      expect(text, `${c.key}: a table row left as written`).not.toMatch(/<p>\|/);
      expect(text, `${c.key}: a list item left as written`).not.toMatch(/<p>[-*] /);
      // Every link to another chapter or a diagram lands on something the dashboard serves.
      for (const m of text.matchAll(/href="(\/docs\/[^"#]+)/g)) expect(m[1], `${c.key}: ${m[1]}`).toMatch(/^\/docs\/(diagrams\/[a-z0-9-]+\.svg|[a-z-]+)$/);
    }
  });
});
