/**
 * The dashboard's pages, served by the Worker's own fetch handler: every
 * door and every detail page answers, carries the shared frame (the three
 * doors in the navigation, the footer with the docs and the licence), keeps the text the e2e script and
 * the old addresses rely on, and leaves no template placeholder behind.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const PAGES = ["/", "/factory", "/contribute", "/review", "/pipeline", "/docs", "/docs/get-started", "/docs/workers", "/docs/how-it-works", "/docs/what-we-test", "/docs/governance", "/docs/security", "/docs/glossary", "/docs/architecture", "/docs/runbook", "/docs/testing", "/docs/migration", "/docs/factory", "/docs/worker-host", "/docs/security-model", "/docs/contributing", "/docs/proof-of-concept", "/docs/open-work", "/docs/omarchy-cli-mcp", "/packages", "/package/zlib", "/security", "/status", "/journal", "/workers", "/request", "/user/someone", "/people", "/api", "/diff"];

describe("dashboard pages", () => {
  it("every page is served with the shared frame and no placeholder left behind", async () => {
    for (const path of PAGES) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain("omarchy-pool");
      // The four doors in the header; the documentation, the workers and the licence in the footer.
      expect(html, `${path} nav`).toMatch(/<header>[\s\S]*href="\/"[\s\S]*href="\/factory"[\s\S]*href="\/review"[\s\S]*href="\/pipeline"[\s\S]*<\/header>/);
      expect(html, `${path} header`).not.toMatch(/<header>[\s\S]*(href="\/docs"|id="status")[\s\S]*<\/header>/);
      expect(html, `${path} footer`).toMatch(/<footer>[\s\S]*href="\/workers"[\s\S]*href="\/docs"[\s\S]*href="\/api"[\s\S]*blob\/main\/LICENSE[\s\S]*<\/footer>/);
      expect(html, path).toContain("built for Omarchy");
      expect(html, path).not.toMatch(/__[A-Z_]+__/);
      expect(html, path).not.toContain("${");
    }
  });

  it("the Pool keeps its headline, the Factory serves the contributors, the Pipeline draws the living system", async () => {
    expect(await (await get("/")).text()).toContain("tested before they reach you");
    const factory = await (await get("/factory")).text();
    expect(factory).toContain("Sign in with GitHub");
    expect(factory).toContain('href="/request"');
    expect(await (await get("/contribute")).text()).toContain('href="/request"');
    // The request has a page of its own: the form, the checklist, nothing else — and no link to it in the header or the footer.
    const request = await (await get("/request")).text();
    expect(request).toContain('id="pkg-form"');
    expect(request).toContain('data-check="evidence"');
    expect(request).not.toMatch(/<(header|footer)[\s\S]*?href="\/request"[\s\S]*?<\/\1>/);
    const pipeline = await (await get("/pipeline")).text();
    expect(pipeline).toContain('data-live="verified-today"');
    expect(pipeline).toContain("sponsor@firemanxbr.org");
    expect(pipeline).toContain('id="staged"');
    // Review reads the same for everyone and acts for maintainers; the Workers page has the three kinds, and the Pipeline no longer lists them.
    const review = await (await get("/review")).text();
    expect(review).toContain('id="mine"');
    expect(review).toContain('data-approve');
    const workers = await (await get("/workers")).text();
    for (const kind of ["w-project", "w-review", "w-community"]) expect(workers).toContain(`id="${kind}"`);
    expect(workers).toContain('href="/docs/workers"');
    expect(pipeline).not.toContain('id="cworkers"');
    expect(pipeline).toContain('href="/workers"');
  });

  it("every docs page carries the same shell — the map with every chapter's sections, the search — and the stages are on How it works", async () => {
    const { DOCS_TREE } = await import("../src/pages/docs-tree");
    for (const path of ["/docs", "/docs/get-started", "/docs/workers", "/docs/how-it-works", "/docs/governance", "/docs/security", "/docs/glossary", "/api", "/docs/architecture", "/docs/runbook"]) {
      const html = await (await get(path)).text();
      expect(html, path).toContain('id="docs-q"');
      for (const c of DOCS_TREE) for (const sec of c.secs) expect(html, `${path}: ${c.key}#${sec.id}`).toContain(`href="${c.href}#${sec.id}"`);
    }
    // Every section the map names is an anchor on its page.
    for (const c of DOCS_TREE) {
      const html = await (await get(c.href)).text();
      for (const sec of c.secs) expect(html, `${c.href} has no #${sec.id}`).toMatch(new RegExp(`id="${sec.id}"`));
    }
    const how = await (await get("/docs/how-it-works")).text();
    for (const stage of ["sync", "pin", "promote", "render", "serve"]) expect(how).toContain(`data-stage="${stage}"`);
    // What we test is the skills the agents read (factory/skills), one text: the general one, then the groups, then the log.
    const { SKILLS } = await import("../src/pages/docs-tree");
    const test = await (await get("/docs/what-we-test")).text();
    expect(SKILLS.map((k) => k.file)).toEqual(["factory/skills/general/every-package.md", "factory/skills/groups/desktop-apps.md", "factory/skills/groups/prebuilt-binaries.md"]);
    for (const id of ["why-we-test-the-way-we-test", "every-package", "desktop-apps", "prebuilt-binaries", "how-this-page-grows", "what-we-learned"]) expect(test, id).toContain(`id="${id}"`);
    expect(test.indexOf('id="every-package"')).toBeLessThan(test.indexOf('id="desktop-apps"'));
    expect(test).toContain("ozone-platform-hint=auto");
    expect(test).not.toContain("<!-- skills -->");
    const res = await get("/how-it-works");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("http://pool.test/docs/how-it-works");
  });
});

// The diagrams size a box to its text; a line longer than planned widens the
// box into its neighbour, and the labels between them end up on a border.
describe("diagrams", () => {
  it("draws no two boxes over each other", async () => {
    const { ringsDiagram, sourcesDiagram, liveDiagram, archDiagram } = await import("../src/pages/diagrams");
    for (const [name, svg] of [["rings", ringsDiagram()], ["rings/promote", ringsDiagram("promote")], ["sources", sourcesDiagram()], ["live", liveDiagram()], ["arch", archDiagram()]] as const) {
      const boxes = [...svg.matchAll(/<rect class="d-box[^"]*" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((m) => m.slice(1, 5).map(Number));
      const [w] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!.slice(1).map(Number);
      expect(boxes.length, name).toBeGreaterThan(3);
      for (const b of boxes) expect(b[0] + b[2], `${name}: a box past the right edge`).toBeLessThanOrEqual(w);
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const [a, b] = [boxes[i], boxes[j]];
          const apart = a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1];
          expect(apart, `${name}: boxes at ${a.join(",")} and ${b.join(",")} overlap`).toBe(true);
        }
    }
  });
});
