/**
 * The docs index (#250, pages/docs.ts): one page, seven short sections —
 * Set up, Rings, How a package gets in, Factory, Review, Status and
 * journal, API — in a card each, with a map of them beside the cards and
 * no chapter shell around them; /docs/api is the API section, a 301 to
 * /docs#api that lands on its anchor; every chapter of the map one link
 * away, from the section it deepens or, for the code's chapters, the line
 * under the cards; the API's table the reference's own short list
 * (api-docs.ts API_BRIEF, held to the router in lists.test.ts); the
 * search over every chapter, section and glossary term still on the page,
 * run, and what came of it said to a screen reader; the kit's primitives
 * and helpers, and nothing of the kit written into the frame's CSS; what
 * the CSS must hold at every width (grids with no empty cell, the command
 * in the design's type); and the map lighting the section the reader is
 * in, run over a document of its own: a third of the way down the window,
 * the first card at the page's top and the last at its end, a section
 * chosen in the map or named by the address kept lit while the page moves
 * to it and given back once the page is the reader's again.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { DASHBOARD_HOST, PROMOTED_RINGS, RING_TEXT } from "../src/meta";
import { DOCS_TREE, GLOSSARY } from "../src/pages/docs-tree";
import { DOCS_COMPONENTS, DOC_SECTIONS } from "../src/pages/docs";
import { API_BRIEF } from "../src/pages/api-docs";
import { KIT_CSS, KIT_HELPERS, KIT_SHEET_PATH } from "../src/pages/kit";
import { termId } from "../src/pages/layout";
import { escapeHtml } from "../src/html";
import { ownScriptOf, scriptOf, type Fixture } from "./fixture";

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const docs = async () => (await get("/docs")).text();
/** What a reader can press: the page's body, its scripts, header and footer set aside. */
const bodyOf = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<header>[\s\S]*?<\/header>/, "").replace(/<footer>[\s\S]*?<\/footer>/, "");
/** A card's HTML, by its section's id. */
const cardOf = (html: string, id: string) => new RegExp(`<section class="op-card guide-sec" id="${id}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? "";

describe("the docs index", () => {
  it("is one page of seven sections, in the order the map lists them, with no chapter shell around them", async () => {
    const res = await get("/docs");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<p class="op-eyebrow">Docs</p><h1 class="op-hero">How the pool works</h1>');
    expect(DOC_SECTIONS.map((s) => [s.id, s.title])).toEqual([
      ["setup", "Set up"], ["rings", "Rings"], ["gates", "How a package gets in"], ["factory", "Factory"], ["review", "Review"], ["journal", "Status and journal"], ["api", "API"],
    ]);
    // The cards, in order, one each; the map beside them names each by its anchor, in the same order.
    expect([...html.matchAll(/<section class="op-card guide-sec" id="([a-z]+)"/g)].map((m) => m[1])).toEqual(DOC_SECTIONS.map((s) => s.id));
    const map = /<nav class="guide-nav" aria-label="Sections">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
    expect([...map.matchAll(/<a href="#([a-z]+)">/g)].map((m) => m[1])).toEqual(DOC_SECTIONS.map((s) => s.id));
    for (const s of DOC_SECTIONS) {
      expect(map, s.id).toContain(`${s.title}</a>`);
      expect(cardOf(html, s.id), s.id).toContain(`<h2 id="${s.id}-h">`);
      // A line or two, never a chapter: the long text is the chapters'.
      expect(s.text.split(/(?<=\.) /).length, `${s.id}: ${s.text}`).toBeLessThanOrEqual(4);
    }
    // No id on the page twice.
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    // The chapters' shell is theirs: no map of every chapter here, no hint under it.
    expect(html).not.toContain('<aside class="docs-side">');
    expect(html).not.toContain('class="docs-hint"');
    expect(await (await get("/docs/")).text()).toBe(html);
  });

  it("is where /docs/api goes: a 301 to /docs#api, query kept, landing on the API section", async () => {
    for (const [from, to] of [["/docs/api", "/docs#api"], ["/docs/api?from=old", "/docs?from=old#api"]]) {
      const res = await get(from);
      expect(res.status, from).toBe(301);
      expect(res.headers.get("location"), from).toBe(`http://pool.test${to}`);
    }
    const html = await docs();
    expect(html.match(/\sid="api"/g)?.length).toBe(1);
    expect(cardOf(html, "api")).toContain('<div class="guide-api"><table class="op-table" role="table">');
  });

  it("links every chapter of the map: the reader's from the section each deepens, the code's from the line under the cards", async () => {
    const html = await docs(), body = bodyOf(html);
    const cards = DOC_SECTIONS.map((s) => cardOf(html, s.id)).join("");
    const code = /<p class="guide-code">[\s\S]*?<\/p>/.exec(html)?.[0] ?? "";
    for (const c of DOCS_TREE) {
      const link = new RegExp(`href="${c.href}(?:#[a-z0-9-]+)?"`);
      expect(body, `${c.key} is not linked from /docs`).toMatch(link);
      if (c.group === "pool") expect(cards, `${c.key}: not linked from a section`).toMatch(link);
      else expect(code, `${c.key}: not on the code's line`).toContain(`href="${c.href}"`);
    }
    // A section's links are the map's names for what they open, and land: a chapter, one of its sections, or a page of the dashboard.
    for (const s of DOC_SECTIONS) {
      expect(s.more.length, s.id).toBeGreaterThan(0);
      for (const m of s.more) {
        const [path, frag] = m.href.split("#");
        const c = DOCS_TREE.find((x) => x.href === path);
        if (!c) { expect((await get(path)).status, m.href).toBe(200); continue; }
        if (frag) expect(c.secs.map((x) => x.id), m.href).toContain(frag);
      }
    }
    // The glossary is the Rings section's, and the search's (below).
    expect(cardOf(html, "rings")).toContain('href="/docs/glossary"');
  });

  it("says what the app keeps: the rings' own words, the reference's short list for the API", async () => {
    const html = await docs();
    const rings = cardOf(html, "rings");
    for (const r of PROMOTED_RINGS) expect(rings, r).toContain(`${r}</b><span>${escapeHtml(RING_TEXT[r].lag)}</span>`);
    expect(rings.indexOf(">edge</b>")).toBeLessThan(rings.indexOf(">rc</b>"));
    expect(rings.indexOf(">rc</b>")).toBeLessThan(rings.indexOf(">stable</b>"));
    // Every row of the short list, in its order, a GET under /api/v1 and what it returns.
    const cells = [...cardOf(html, "api").matchAll(/<tr role="row"><td role="cell">([A-Z]+)<\/td><td role="cell"><code>([\s\S]*?)<\/code><\/td><td role="cell">([^<]+)<\/td><\/tr>/g)];
    const rows = cells.map((m) => [m[1], m[2].replace(/<[^>]+>/g, ""), m[3]]);
    expect(rows).toEqual(API_BRIEF.map(([route, returns]) => ["GET", `/api/v1${escapeHtml(route.split(" ")[1])}`, escapeHtml(returns)]));
    // A phone's row breaks a path only between its pieces — each step up to its slash, then the query whole — never inside a word (/api/v1/packages/:sha256/provenan|ce is no route), and a query moves to the next line from its "?".
    for (const [, , path] of cells) {
      const pieces = [...path.matchAll(/<span>([^<]*)<\/span>/g)].map((m) => m[1]);
      expect(pieces.join(""), path).toBe(path.replace(/<[^>]+>/g, ""));
      expect(pieces.length, path).toBeGreaterThan(2);
      pieces.forEach((p, i) => {
        if (p.startsWith("?")) expect(i, `${path}: the query is the last piece`).toBe(pieces.length - 1);
        else expect(p.endsWith("/") || i === pieces.length - 1 || pieces[i + 1].startsWith("?"), `${path}: ${p}`).toBe(true);
        expect(p.slice(1, -1), `${path}: ${p} holds a slash inside`).not.toContain("/");
      });
    }
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
    expect(style).toContain(".guide-api code { color: var(--text); white-space: nowrap; }");
    expect(style).toContain(".guide-api code > span { display: inline-block; }");
    expect(cardOf(html, "api"), "no <wbr>: Chrome breaks at one inside nowrap, and the desktop's paths would wrap").not.toContain("<wbr>");
    // The table's head and cells keep their names for a screen reader when a phone draws each row as a grid.
    expect(cardOf(html, "api")).toContain('<table class="op-table" role="table"><thead role="rowgroup"><tr role="row"><th role="columnheader">Method</th><th role="columnheader">Path</th><th role="columnheader">Returns</th></tr></thead><tbody role="rowgroup">');
    // The manifest reads every route of the list on the fixture (components.test.ts), a list grown by a row included.
    const table = DOCS_COMPONENTS({ arch: "x86_64", pkg: "zlib", sha: "0".repeat(64) } as Fixture).find((c) => c.id === "docs.api-table")!;
    for (const [route] of API_BRIEF) {
      const shape = new RegExp(`^/api/v1${route.split(" ")[1].replace(/\?.*$/, "").replace(/:[a-z0-9_]+/g, "[^/?]+")}(?:\\?|$)`);
      expect(table.reads!.some((r) => shape.test(r.path)), `${route}: the manifest reads it nowhere`).toBe(true);
    }
    // The one command, for the dashboard's name as served; the page's script names the address it is served from.
    expect(cardOf(html, "setup")).toContain(`curl -fsSL <span id="guide-origin">https://${DASHBOARD_HOST}</span>/setup | sudo bash -s -- --ring stable`);
    // Its copy button copies the command alone — one line, no newline, not the install under it — as Home's and Get started's do.
    const copied = /<button type="button" class="op-copy" data-op-copy="([^"]*)">copy<\/button>/.exec(cardOf(html, "setup"))?.[1];
    expect(copied).toBe(`curl -fsSL https://${DASHBOARD_HOST}/setup | sudo bash -s -- --ring stable`);
    // Copy: no emoji (the handoff's glyphs → ✓ · › are text).
    const main = /<main>([\s\S]*?)<\/main>/.exec(html)![1];
    expect(main).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("keeps the search: the box, the answer that takes the sections' place, what came of it said to a screen reader, and the search itself, run", async () => {
    const html = await docs();
    expect(html).toContain('<input type="search" id="docs-q" placeholder="search the docs…" aria-label="search the docs" autocomplete="off">');
    expect(html.indexOf('id="docs-hits"')).toBeLessThan(html.indexOf('<div class="guide-body" id="docs-nav">'));
    // The status line is there before a word is typed (a live region added later is not heard), empty, and for the ear only.
    expect(html).toContain('<p class="docs-said" id="docs-said" role="status"></p>');
    expect(/<style>([\s\S]*?)<\/style>/.exec(html)![1]).toMatch(/\.docs-said \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset\(50%\);/);
    // The search as served (layout.ts DOCS_SEARCH), run over the three elements it reads.
    const script = scriptOf(html), at = script.indexOf('var q = $("#docs-q")');
    expect(at).toBeGreaterThan(0);
    const start = script.lastIndexOf("(function () {", at), end = script.indexOf("})();", at) + "})();".length;
    const el = () => ({ hidden: false, innerHTML: "", textContent: "", value: "", oninput: null as null | (() => void), onkeydown: null as null | ((e: { key: string }) => void) });
    const q = el(), hits = el(), nav = el(), said = el();
    hits.hidden = true;
    const nodes: Record<string, ReturnType<typeof el>> = { "#docs-q": q, "#docs-hits": hits, "#docs-nav": nav, "#docs-said": said };
    const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    new Function("$", "esc", script.slice(start, end))((sel: string) => nodes[sel] ?? null, esc);
    // A glossary term is found and linked to its line; the sections give way to the answer.
    q.value = "soak";
    q.oninput!();
    expect(hits.hidden).toBe(false);
    expect(nav.hidden).toBe(true);
    expect(hits.innerHTML).toContain(`href="/docs/glossary#${termId("soak")}"`);
    expect(GLOSSARY.some(([t]) => t === "soak")).toBe(true);
    const shown = (hits.innerHTML.match(/<a class="hit"/g) ?? []).length;
    expect(said.textContent).toBe(`${shown} ${shown === 1 ? "result" : "results"}`);
    // A chapter's section by its words.
    q.value = "which ring";
    q.oninput!();
    expect(hits.innerHTML).toContain('href="/docs/get-started#which-ring"');
    // Nothing found is said, escaped.
    q.value = "<zz>";
    q.oninput!();
    expect(hits.innerHTML).toContain("nothing in the docs says “&lt;zz&gt;”");
    expect(said.textContent, "text, not markup: no escaping to undo").toBe("nothing in the docs says “<zz>”");
    // Esc empties the box and gives the sections back, and the status line says nothing more.
    q.onkeydown!({ key: "Escape" });
    expect(q.value).toBe("");
    expect(hits.hidden).toBe(true);
    expect(nav.hidden).toBe(false);
    expect(said.textContent).toBe("");
    // A chapter's shell has the same line: the search is the same there, in place of the map of every chapter.
    expect(await (await get("/docs/get-started")).text()).toContain('<p class="docs-said" id="docs-said" role="status"></p>');
  });

  it("is drawn with the kit: its sheet once in the head, its helpers, its primitives — and the frame's CSS names none of them", async () => {
    const html = await docs(), head = /<head>([\s\S]*?)<\/head>/.exec(html)![1];
    expect(head.match(/\/assets\/kit\./g)?.length).toBe(1);
    expect(head.indexOf(`<link rel="stylesheet" href="${KIT_SHEET_PATH}">`)).toBeGreaterThan(head.indexOf("</style>"));
    expect(scriptOf(html)).toContain(KIT_HELPERS);
    for (const primitive of ['class="op-eyebrow"', 'class="op-hero"', 'class="op-card guide-sec"', 'class="op-box ok"', 'class="op-code guide-well"', 'class="op-prompt"', 'class="op-copy" data-op-copy', 'class="op-table"', 'class="op-label"', 'class="op-i op-i-terminal"', 'class="op-i op-i-git-commit-horizontal"'])
      expect(html, primitive).toContain(primitive);
    expect(/<style>([\s\S]*?)<\/style>/.exec(html)![1]).not.toContain(".op-");
  });

  it("draws what the design draws at every width: grids with no empty cell, the command in the well's own type, the search box with no clear button of the browser's", async () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(await docs())![1];
    // A grid of facts draws its lines as the --line behind a 1px gap, so a track its cells do not fill is a block of that colour: every column count the CSS gives it, at any width, divides every grid's cells.
    const columns = [...style.matchAll(/\.guide-items \{[^}]*?grid-template-columns: ([^;]+);/g)].map((m) => {
      const repeat = /^repeat\((\d+),/.exec(m[1]);
      expect(m[1], "a fixed count: auto-fit and auto-fill leave a track empty wherever the width does not divide the cells").not.toMatch(/auto-fi(?:t|ll)/);
      return repeat ? Number(repeat[1]) : m[1].trim().split(/\s+(?![^(]*\))/).length;
    });
    expect(columns).toEqual([3, 1]);
    for (const sec of DOC_SECTIONS.filter((x) => x.items)) for (const n of columns) expect(sec.items!.length % n, `${sec.id}: ${sec.items!.length} cells in ${n} columns`).toBe(0);
    // The command at the design's 12.5px/1.7: the kit's sheet comes after the frame's CSS, so the page's rule outweighs the kit's (a class more) rather than tie with it and lose.
    const classes = (sel: string) => (sel.match(/\.[\w-]+/g) ?? []).length;
    expect(style).toContain(".guide-sec .guide-well code { font-size: 12.5px; line-height: 1.7; }");
    expect(KIT_CSS).toContain(".op-code code {");
    expect(classes(".guide-sec .guide-well code")).toBeGreaterThan(classes(".op-code code"));
    // On a phone the command scrolls in its well, as the design's does, rather than break inside the address.
    expect(style).toContain(".guide-sec .guide-well code { white-space: pre; overflow-wrap: normal; overflow-x: auto; }");
    // The search box is drawn in the palette's names only: the browser's own clear button (blue in the light theme) is not drawn; Esc empties the box.
    expect(style).toContain(".guide-search input::-webkit-search-decoration, .guide-search input::-webkit-search-cancel-button { -webkit-appearance: none; }");
    // The API table's head is hidden from the eye on a phone, not from a screen reader.
    expect(style).not.toMatch(/\.guide-api thead \{ display: none/);
    expect(style).toContain(".guide-api thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%);");
  });

  it("lights the section the reader is in, keeps the one they asked for lit while the page moves to it, and gives the light back once the page is theirs", async () => {
    const own = ownScriptOf(await docs())!;
    const code = own.slice(0, own.indexOf("(function () {\n    var q = $(\"#docs-q\")"));
    expect(code).toContain('$(".guide-nav")');
    // A document of its own: the seven cards at their places down a 2300px page (each ending 14px above the next), a 900px window.
    const TOP: Record<string, number> = { setup: 220, rings: 450, gates: 690, factory: 990, review: 1180, journal: 1370, api: 1520 };
    const BOTTOM: Record<string, number> = { setup: 436, rings: 676, gates: 976, factory: 1166, review: 1356, journal: 1506, api: 1760 };
    const links = DOC_SECTIONS.map((s) => {
      const attrs: Record<string, string> = {};
      return { attrs, getAttribute: (n: string) => (n === "href" ? `#${s.id}` : attrs[n] ?? null), setAttribute: (n: string, v: string) => { attrs[n] = v; }, removeAttribute: (n: string) => { delete attrs[n]; } };
    });
    const on: Record<string, (e?: unknown) => void> = {}, navOn: Record<string, (e: unknown) => void> = {};
    const nav = { querySelectorAll: () => links, addEventListener: (t: string, f: (e: unknown) => void) => { navOn[t] = f; } };
    const origin = { textContent: `https://${DASHBOARD_HOST}` };
    const copyAttrs: Record<string, string> = { "data-op-copy": `curl -fsSL https://${DASHBOARD_HOST}/setup | sudo bash -s -- --ring stable` };
    const copy = { getAttribute: (n: string) => copyAttrs[n] ?? null, setAttribute: (n: string, v: string) => { copyAttrs[n] = v; } };
    // The browser's one timer, run by hand: rest() is the page coming to rest, 150 ms without a scroll.
    let timer: (() => void) | null = null;
    const rest = () => { const f = timer; timer = null; f?.(); };
    const scope = {
      innerHeight: 900, scrollY: 0,
      location: { origin: "http://127.0.0.1:8870", hash: "" },
      $: (sel: string) => (sel === ".guide-nav" ? nav : sel === "#guide-origin" ? origin : sel === ".guide-well [data-op-copy]" ? copy : null),
      document: { getElementById: (id: string) => ({ id, getBoundingClientRect: () => ({ top: TOP[id] - scope.scrollY, bottom: BOTTOM[id] - scope.scrollY }) }), documentElement: { scrollHeight: 2300 } },
      window: { addEventListener: (t: string, f: (e?: unknown) => void) => { on[t] = f; } },
      requestAnimationFrame: (f: () => void) => f(),
      setTimeout: (f: () => void) => { timer = f; return 1; },
      clearTimeout: () => { timer = null; },
    };
    const lit = () => links.filter((l) => l.attrs["aria-current"] === "true").map((l) => l.getAttribute("href"));
    const run = () => new Function("scope", `with (scope) {\n${code}\n}`)(scope);
    const scrollTo = (y: number) => { scope.scrollY = y; on.scroll(); };
    // The browser's jump to a card: its top 16px under the window's (scroll-margin-top), or as far as the page goes.
    const jump = (id: string) => scrollTo(Math.min(TOP[id] - 16, 2300 - scope.innerHeight));
    const pick = (id: string) => navOn.click({ target: { closest: () => links[DOC_SECTIONS.findIndex((s) => s.id === id)] } });
    run();
    expect(origin.textContent, "the command names the address the page is served from").toBe("http://127.0.0.1:8870");
    expect(copyAttrs["data-op-copy"], "and so does what its button copies").toBe("curl -fsSL http://127.0.0.1:8870/setup | sudo bash -s -- --ring stable");
    expect(lit()).toEqual(["#setup"]);
    // A card is the reader's once its top passes a third of the window.
    scrollTo(500);
    expect(lit()).toEqual(["#gates"]);
    scrollTo(1000);
    expect(lit()).toEqual(["#review"]);
    // At the page's end the last card, whose top can never reach that line.
    scrollTo(1400);
    expect(lit()).toEqual(["#api"]);
    // Chosen in the map: lit while the page moves to it and once it rests there, though the API card's top has passed the line too.
    pick("journal");
    expect(lit()).toEqual(["#journal"]);
    jump("journal");
    expect(lit()).toEqual(["#journal"]);
    rest();
    scrollTo(scope.scrollY);
    expect(lit(), "a scroll that does not move the card keeps it").toEqual(["#journal"]);
    // The reader's wheel gives the light back to where they are.
    on.wheel();
    expect(lit()).toEqual(["#api"]);
    // So does a scroll no wheel, touch or key made — the scrollbar dragged, a middle-click — once the jump has come to rest.
    pick("journal");
    jump("journal");
    rest();
    scrollTo(900);
    expect(lit()).toEqual(["#review"]);
    // Back to /docs: the address names no section any more, and the light is where the page is.
    scope.location.hash = "#factory";
    on.hashchange();
    expect(lit()).toEqual(["#factory"]);
    jump("factory");
    rest();
    scope.location.hash = "";
    scope.scrollY = 0;
    on.hashchange();
    expect(lit()).toEqual(["#setup"]);
    // Named by the address on load, the page already there: kept once it rests.
    scope.location.hash = "#gates";
    scope.scrollY = TOP.gates - 16;
    run();
    expect(lit()).toEqual(["#gates"]);
    rest();
    expect(lit()).toEqual(["#gates"]);
    // An address that names no section gives the light back too.
    scope.location.hash = "#rings";
    on.hashchange();
    expect(lit()).toEqual(["#rings"]);
    scope.location.hash = "#nothing";
    on.hashchange();
    expect(lit()).toEqual(["#gates"]);
    // Named by the address, but the browser put the page back where the reader had it (Back from another page): the card is not in the window when the page rests, and the light is where the page is.
    scope.location.hash = "#api";
    scope.scrollY = 0;
    run();
    expect(lit()).toEqual(["#api"]);
    rest();
    expect(lit()).toEqual(["#setup"]);
    // A window tall enough for the whole page: at its top, not its end.
    scope.location.hash = "";
    scope.innerHeight = 2400;
    run();
    expect(lit()).toEqual(["#setup"]);
    scope.innerHeight = 900;
    // With no addEventListener on window — an old browser, the other tests' document — nothing is lit and nothing throws.
    for (const l of links) delete l.attrs["aria-current"];
    scope.window = {} as typeof scope.window;
    run();
    expect(lit()).toEqual([]);
  });
});
