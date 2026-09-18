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
import { HELPERS } from "../src/pages/layout";
import { CHARTS } from "../src/pages/charts";
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

  // One shell: a helper two pages need lives in HELPERS (a chart primitive in CHARTS), and a page declares only what it alone draws. The copies drifted when they lived on the pages — four colour maps for one build status, five pick() rows, three ways to say how long a build took — so a page that declares a name the shell declares (the copy coming back, at its top or inside the function that draws), assigns over one, or declares one of its own twice, fails here by the page's name; so does a page that polls /api/v1/stats every two minutes to render nothing, and a page that draws a chart primitive without CHARTS. The shell is checked first, by its own name: a page is never blamed for a name HELPERS declares twice.
  it("a page declares only what it alone draws — no helper the shell has, no name twice, no poll for nothing", async () => {
    const acorn = await import("acorn");
    type N = Record<string, any>;
    const FN = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
    // One walk for every check: visit(node, parent, key) returns false to go no deeper at that node.
    const walk = (n: unknown, visit: (node: N, parent: N | null, key: string | null) => boolean | void, parent: N | null = null, key: string | null = null): void => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { n.forEach((x) => walk(x, visit, parent, key)); return; }
      const node = n as N;
      if (!node.type) return;
      if (visit(node, parent, key) === false) return;
      for (const k of Object.keys(node)) if (k !== "type" && k !== "start" && k !== "end") walk(node[k], visit, node, k);
    };
    const names = (pat: N, out: string[] = []): string[] => {
      if (!pat) return out;
      if (pat.type === "Identifier") out.push(pat.name);
      else if (pat.type === "ObjectPattern") pat.properties.forEach((q: N) => names(q.value ?? q.argument, out));
      else if (pat.type === "ArrayPattern") pat.elements.forEach((e: N) => names(e, out));
      else if (pat.type === "AssignmentPattern") names(pat.left, out);
      else if (pat.type === "RestElement") names(pat.argument, out);
      return out;
    };
    // Every name the statements declare — function declarations, var/let/const declarators, parameters — with the function it sits in (null for the scope itself; an anonymous function goes by the named one around it) and whether it is a loop's own counter (the ES5 pages redeclare `var i` per loop).
    type Decl = { name: string; inside: string | null; loop: boolean };
    const declarations = (body: N[]): Decl[] => {
      const out: Decl[] = [];
      const scan = (n: unknown, inside: string | null, parent: N | null, key: string | null): void => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) { n.forEach((x) => scan(x, inside, parent, key)); return; }
        const node = n as N;
        if (!node.type) return;
        if (node.type === "FunctionDeclaration") names(node.id).forEach((name) => out.push({ name, inside, loop: false }));
        if (FN.has(node.type)) {
          const within = node.id ? node.id.name : inside || "an anonymous function";
          node.params.forEach((p: N) => names(p).forEach((name) => out.push({ name, inside: within, loop: false })));
          scan(node.body, within, node, "body");
          return;
        }
        if (node.type === "ClassDeclaration") { names(node.id).forEach((name) => out.push({ name, inside, loop: false })); return; }
        if (node.type === "VariableDeclaration") {
          const loop = !!parent && ((parent.type === "ForStatement" && key === "init") || ((parent.type === "ForInStatement" || parent.type === "ForOfStatement") && key === "left"));
          node.declarations.forEach((d: N) => { names(d.id).forEach((name) => out.push({ name, inside, loop })); scan(d.init, inside, d, "init"); });
          return;
        }
        for (const k of Object.keys(node)) if (k !== "type" && k !== "start" && k !== "end") scan(node[k], inside, node, k);
      };
      scan(body, null, null, null);
      return out;
    };
    const top = (ds: Decl[]): string[] => ds.filter((d) => d.inside === null && !d.loop).map((d) => d.name);
    const dupes = (a: string[]): string[] => [...new Set(a.filter((x, i) => a.indexOf(x) !== i))];
    const program = (code: string): N[] => (acorn.parse(code, { ecmaVersion: 2020, sourceType: "script" }) as unknown as N).body;
    // The shell first, by its own name: page() splices HELPERS whole, so a name it declared twice would fail every page.
    const helpers = program(HELPERS), charts = program(CHARTS);
    const shellNames = top(declarations(helpers)), chartNames = top(declarations(charts));
    expect(dupes(shellNames), "HELPERS declares a name twice").toEqual([]);
    expect(dupes(chartNames), "CHARTS declares a name twice").toEqual([]);
    expect(shellNames.filter((n) => chartNames.includes(n)), "HELPERS and CHARTS share a name").toEqual([]);
    const shell = new Set(shellNames);
    expect(shell.has("pillHtml") && shell.has("whoami") && shell.has("pick") && chartNames.includes("stacked")).toBe(true);
    // The primitives a page draws only through CHARTS — a page that does not splice CHARTS and declares one of these has copied it.
    const CHART_ONLY = ["bars", "area", "heat", "hbars", "stacked", "lines", "hrows", "heatGrid", "buildsByDay", "worst", "lastDays"];
    const problems: string[] = [];
    for (const path of PAGES) {
      const code = scriptOf(await (await get(path)).text());
      if (!code.trim()) continue;
      // page() wraps the footer's line, the shell, then the page's script in one function: the page's own statements are what follows the shell's, less CHARTS where the page splices it.
      const iife: N[] | undefined = program(code)[0]?.expression?.callee?.body?.body;
      expect(iife, `${path}: the page's script is not one IIFE`).toBeDefined();
      const cs = code.indexOf(CHARTS), withCharts = cs >= 0;
      const own = iife!.slice(1 + helpers.length).filter((st) => !(withCharts && st.start >= cs && st.end <= cs + CHARTS.length));
      const has = new Set([...shell, ...(withCharts ? chartNames : [])]);
      const decls = declarations(own);
      for (const d of decls) {
        if (d.inside !== null) { if (has.has(d.name)) problems.push(`${path} shadows the shell's ${d.name} inside ${d.inside}`); }
        else if (has.has(d.name)) problems.push(`${path} declares the shell's ${d.name} again`);
        else if (!withCharts && CHART_ONLY.includes(d.name)) problems.push(`${path} draws ${d.name} without CHARTS`);
      }
      for (const name of dupes(top(decls))) problems.push(`${path} declares ${name} ${top(decls).filter((n) => n === name).length} times`);
      // A page's top-level functions by name, for the poll check below.
      const fns = new Map<string, N>();
      for (const st of own) if (st.type === "FunctionDeclaration" && st.id) fns.set(st.id.name, st);
      // A function that renders nothing: no statement, or a bare return.
      const empty = (fn: N | undefined): boolean => !!fn && FN.has(fn.type) && fn.body.type === "BlockStatement" && fn.body.body.every((st: N) => st.type === "ReturnStatement" && !st.argument);
      walk(own, (node) => {
        // `pick = function () {…}` or `window.dur = …`: the copy back without a declaration.
        if (node.type === "AssignmentExpression") {
          const l = node.left;
          const name = l.type === "Identifier" ? l.name : l.type === "MemberExpression" && !l.computed && l.object.type === "Identifier" && (l.object.name === "window" || l.object.name === "globalThis") ? l.property.name : null;
          if (name && has.has(name)) problems.push(`${path} reassigns the shell's ${name}`);
        }
        // liveStats(function () {}, …), or liveStats(noop, …): the two-minute poll of /api/v1/stats that renders nothing.
        if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "liveStats") {
          const arg = node.arguments[0];
          if (arg && empty(arg.type === "Identifier" ? fns.get(arg.name) : arg)) problems.push(`${path} polls the stats to render nothing`);
        }
      });
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  // The dashboard's rule for roles: every role sees every section and every control, the same for all; what a role cannot do is a disabled control with the reason in its title — never hidden, never absent, never a sentence in its place. So the sections that exist for everyone are never served `hidden`; the attribute stays for what does not exist yet (a result line before a POST, a blocked notice for nobody blocked). The list is the sections the redesign names per page — Review's Yours block, a maintainer's queue line, the audit legend, the brake; the Pipeline's queue-position card, its Operations hint; the Journal's releases with the rollback column — and a build's page (#acts), a person's page (#pk-request, #w-toggle, #w-own) and the request (#ask) join it as they pass.
  it("serves the sections everyone gets without hidden — a role that cannot act sees the control grey, never nothing", async () => {
    const ALWAYS: Record<string, string[]> = {
      "/review": ["mine", "mine-queue", "legend", "brake", "staged"],
      "/pipeline": ["queue-pos", "ops-who", "staged", "heads"],
      "/journal": ["releases"],
      [`/build/${F.projectTask}`]: ["acts"],
      [`/user/${F.owner}`]: ["pk-request", "w-toggle", "w-own", "share-btn"],
    };
    const problems: string[] = [];
    for (const [path, ids] of Object.entries(ALWAYS)) {
      const html = await (await get(path)).text();
      for (const id of ids) {
        const tag = new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(html);
        if (!tag) problems.push(`${path}: #${id} is not served`);
        else if (/\shidden(?=[\s>=])/.test(tag[0])) problems.push(`${path}: #${id} is served hidden`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
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
