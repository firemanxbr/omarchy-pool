/**
 * The dashboard's pages, served by the Worker's own fetch handler: every
 * door and every detail page answers, carries the shared frame (the four
 * doors in the navigation, the footer with the docs and the licence), uses
 * no name its script does not declare, and leaves no template placeholder
 * behind; the docs pages carry the same shell, and the diagrams draw no two
 * boxes over each other. What each page is made of is its manifest
 * (src/pages/components.ts), checked by components.test.ts.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { allComponents } from "../src/pages/components";
import { scriptOf, seedDashboard, type Fixture } from "./fixture";

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// The pages are served over the fixture's data (test/fixture.ts): the package, the build and the person exist.
let F: Fixture;
let PAGES: string[];
beforeAll(async () => {
  F = await seedDashboard(env);
  PAGES = ["/", "/factory", "/contribute", "/review", "/pipeline", "/docs", "/docs/get-started", "/docs/workers", "/docs/how-it-works", "/docs/what-we-test", "/docs/governance", "/docs/security", "/docs/glossary", "/docs/architecture", "/docs/runbook", "/docs/testing", "/docs/migration", "/docs/factory", "/docs/worker-host", "/docs/security-model", "/docs/contributing", "/docs/proof-of-concept", "/docs/open-work", "/docs/omarchy-cli-mcp", "/packages", `/package/${F.pkg}`, `/build/${F.projectTask}`, "/security", "/status", "/journal", "/workers", "/request", `/user/${F.owner}`, "/people", "/api", "/diff"];
});

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
      // The request has a page of its own, reached from the Factory and a person's page — never from the frame.
      expect(html, `${path} links the request from its frame`).not.toMatch(/<(header|footer)[\s\S]*?href="\/request"[\s\S]*?<\/\1>/);
      expect(html, path).toContain("built for Omarchy");
      expect(html, path).not.toMatch(/__[A-Z_]+__/);
      expect(html, path).not.toContain("${");
    }
  });

  // Every name a page's script uses is declared somewhere in that script (the shell's helpers, the charts, the page's own) or is the browser's — parsed, not grepped: a helper moved out of one page and dropped from another is a ReferenceError the tests would not otherwise see (the Workers page lost perDay() and COLOR that way, 2026-09-17).
  it("no page script uses a name it does not declare", async () => {
    const GLOBALS = new Set(["window", "document", "location", "history", "navigator", "console", "fetch", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "parseInt", "parseFloat", "isNaN", "isFinite", "Number", "String", "Boolean", "Array", "Object", "Date", "Promise", "RegExp", "Error", "TypeError", "Map", "Set", "WeakMap", "JSON", "Math", "Response", "Request", "Headers", "URLSearchParams", "URL", "Function", "Symbol", "Infinity", "NaN", "undefined", "escape", "unescape", "alert", "confirm", "prompt", "Blob", "TextEncoder", "TextDecoder", "Intl", "structuredClone", "queueMicrotask", "matchMedia", "getComputedStyle", "scrollTo", "scrollBy", "scrollX", "scrollY", "innerWidth", "innerHeight", "open", "close", "atob", "btoa", "AbortController", "IntersectionObserver", "ResizeObserver", "MutationObserver", "CustomEvent", "Event", "FormData", "localStorage", "sessionStorage", "crypto", "performance", "CSS", "arguments", "this", "Element", "HTMLElement", "Node", "NodeList", "DOMParser", "XMLSerializer", "Image", "Audio", "devicePixelRatio", "self", "globalThis", "gtag", "dataLayer"]);
    const acorn = await import("acorn");
    for (const path of PAGES) {
      const html = await (await get(path)).text();
      const code = scriptOf(html);
      if (!code.trim()) continue;
      const ast = acorn.parse(code, { ecmaVersion: 2020, sourceType: "script" }) as unknown as Record<string, unknown>;
      const declared = new Set<string>(), used = new Set<string>();
      const pattern = (n: Record<string, unknown> | null | undefined): void => {
        if (!n) return;
        const t = n.type as string;
        if (t === "Identifier") declared.add(n.name as string);
        else if (t === "ObjectPattern") (n.properties as Record<string, unknown>[]).forEach((p) => pattern((p.value ?? p.argument) as Record<string, unknown>));
        else if (t === "ArrayPattern") (n.elements as Record<string, unknown>[]).forEach(pattern);
        else if (t === "AssignmentPattern") pattern(n.left as Record<string, unknown>);
        else if (t === "RestElement") pattern(n.argument as Record<string, unknown>);
      };
      const walk = (n: unknown, parent: Record<string, unknown> | null, key: string | null): void => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) { n.forEach((x) => walk(x, parent, key)); return; }
        const node = n as Record<string, unknown>, t = node.type as string;
        if (!t) return;
        if (t === "FunctionDeclaration" || t === "FunctionExpression" || t === "ArrowFunctionExpression") { if (node.id) pattern(node.id as Record<string, unknown>); (node.params as Record<string, unknown>[]).forEach(pattern); }
        if (t === "VariableDeclarator") pattern(node.id as Record<string, unknown>);
        if (t === "CatchClause" && node.param) pattern(node.param as Record<string, unknown>);
        if (t === "ClassDeclaration" && node.id) pattern(node.id as Record<string, unknown>);
        if (t === "Identifier") {
          // A reference, not a property name or a key: `a.b` counts a, `{ b: 1 }` counts nothing, `a[b]` counts both.
          const isProp = parent && ((parent.type === "MemberExpression" && key === "property" && !parent.computed) || (parent.type === "Property" && key === "key" && !parent.computed) || (parent.type === "MethodDefinition" && key === "key") || (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement"));
          if (!isProp) used.add(node.name as string);
        }
        for (const k of Object.keys(node)) { if (k === "type" || k === "start" || k === "end") continue; walk(node[k], node, k); }
      };
      walk(ast, null, null);
      const missing = [...used].filter((name) => !declared.has(name) && !GLOBALS.has(name)).sort();
      expect(missing, `${path} uses undeclared: ${missing.join(", ")}`).toEqual([]);
    }
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
    // The mark, as the files a browser asks for by name — and the head names them; no page-view script unless the deployment names one.
    for (const [path, type] of [["/favicon.ico", "image/x-icon"], ["/favicon.svg", "image/svg+xml"], ["/apple-touch-icon.png", "image/png"], ["/icon-192.png", "image/png"], ["/icon-512.png", "image/png"], ["/site.webmanifest", "application/manifest+json"]]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe(type);
      expect((await res.arrayBuffer()).byteLength, path).toBeGreaterThan(50);
    }
    const png = new Uint8Array(await (await get("/apple-touch-icon.png")).arrayBuffer());
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(how).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
    expect(how).not.toContain("googletagmanager");
    expect(how).not.toContain("cloudflareinsights");
    // What we test is the skills the agents read (factory/skills), one text: the general one, then the groups, then the log.
    const { SKILLS } = await import("../src/pages/docs-tree");
    const test = await (await get("/docs/what-we-test")).text();
    expect(SKILLS.map((k) => k.file)).toEqual(["factory/skills/general/every-package.md", "factory/skills/groups/desktop-apps.md", "factory/skills/groups/prebuilt-binaries.md"]);
    for (const id of ["why-we-test-the-way-we-test", "every-package", "desktop-apps", "prebuilt-binaries", "who-does-what", "the-score", "how-this-page-grows", "what-we-learned"]) expect(test, id).toContain(`id="${id}"`);
    expect(test.indexOf('id="every-package"')).toBeLessThan(test.indexOf('id="desktop-apps"'));
    expect(test).toContain("ozone-platform-hint=auto");
    expect(test).not.toContain("<!-- skills -->");
    const res = await get("/how-it-works");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("http://pool.test/docs/how-it-works");
  });
});

// The diagrams size a box to its text; a line longer than planned widens the
// box into its neighbour, and the labels between them end up on a border. A
// box drawn inside a group (`d-group`: the Factory's "Build — your choice"
// holds the two kinds of worker) is not two boxes over each other. Which
// diagrams exist is what the manifests claim with `drawn`: a figure claimed
// by no page, or a page claiming one nobody draws, fails here.
// The documentation's figures are drawn the same way and checked the same way.
describe("diagrams", () => {
  it("draws no two boxes over each other", async () => {
    const { ringsDiagram, sourcesDiagram, liveDiagram, archDiagram, factoryDiagram } = await import("../src/pages/diagrams");
    const { DOC_DIAGRAMS } = await import("../src/pages/doc-diagrams");
    const draw: Record<string, () => string> = { rings: ringsDiagram, "rings/promote": () => ringsDiagram("promote"), sources: sourcesDiagram, live: liveDiagram, arch: archDiagram, factory: factoryDiagram };
    for (const [name, fn] of Object.entries(DOC_DIAGRAMS)) draw[`docs/${name}`] = fn;
    const claimed = new Set(allComponents(F).map((c) => c.drawn).filter((k): k is string => k !== undefined));
    expect([...claimed].sort()).toEqual(Object.keys(draw).sort());
    for (const name of claimed) {
      const svg = draw[name]();
      const rects = [...svg.matchAll(/<rect class="(d-box[^"]*)" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)];
      const boxes = rects.map((m) => m.slice(2, 6).map(Number));
      const group = (i: number) => /\bd-group\b/.test(rects[i][1]);
      const [w] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!.slice(1).map(Number);
      if (name === "docs/benchmark-promotion") {
        // The one chart: bars, not boxes — inside the viewBox, in the palette's two fills.
        const bars = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="var\(--(?:dim|green)\)"/g)].map((m) => m.slice(1, 5).map(Number)).filter((b) => b[3] > 8); // not the legend's swatches
        expect(bars.length, name).toBe(5);
        for (const b of bars) expect(b[0] + b[2], `${name}: a bar past the right edge`).toBeLessThanOrEqual(w);
        continue;
      }
      expect(boxes.length, name).toBeGreaterThan(3);
      for (const b of boxes) expect(b[0] + b[2], `${name}: a box past the right edge`).toBeLessThanOrEqual(w);
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const [a, b] = [boxes[i], boxes[j]];
          const apart = a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1];
          const inside = (x: number[], y: number[]) => x[0] >= y[0] && x[1] >= y[1] && x[0] + x[2] <= y[0] + y[2] && x[1] + x[3] <= y[1] + y[3];
          expect(apart || (group(j) && inside(a, b)) || (group(i) && inside(b, a)), `${name}: boxes at ${a.join(",")} and ${b.join(",")} overlap`).toBe(true);
        }
    }
  });
});
