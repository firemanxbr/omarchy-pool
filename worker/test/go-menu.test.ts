/**
 * The ⌘K menu (#241, layout.ts GO_MENU): on every page, served as a closed
 * dialog after the footer — so with script off nothing of it is drawn and
 * Go… stays the link to the packages — and its script spliced once, after
 * the shell and before the page's own, parsing as the browser parses it;
 * the handoff's ten actions, each landing on a page (a fragment on the page
 * it names); and the menu itself, run over a document of its own: ⌘K and
 * Ctrl+K open and close it, / focuses the page's own search where one is
 * marked and opens the menu everywhere else, Esc, a press beside it and the
 * cancel event close it, and the focus goes back where it was; the line
 * filters the actions and the packages, ↑ and ↓ move with the row named
 * for a screen reader, ↵ opens; the packages come from the one search
 * Home's box asks, at its very address, one request per pause in the
 * typing, each term asked once, a term inside a whole answer narrowed
 * without asking; Request "<name>" once the search has said the name is
 * not a package, ↵ before that answer waiting for it; a search that did
 * not answer said, not drawn as "no package"; the theme through opTheme;
 * the kit's sheet linked the first time the menu opens, once; everything
 * the menu writes escaped; and a browser without <dialog> left as served.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { REPO_ARCHES } from "../src/meta";
import { GO_ACTIONS, GO_MENU, GO_MENU_HTML, HELPERS } from "../src/pages/layout";
import { KIT_SHEET_PATH, LUCIDE, lucide, type LucideName } from "../src/pages/kit";
import { fetchPage, ownScriptOf, RETIRED_PAGES, runScript, scriptOf, seedDashboard, type Fixture } from "./fixture";

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await fetchPage(new Request(`http://pool.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
// The Worker's own handler, for an address that redirects: the fixture's get() draws a retired page instead.
async function raw(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let F: Fixture;
let PAGES: string[];
// The shell's own esc, pkgHref and errorText, as a served page carries them (spliced, run): what the menu calls.
let SHELL: { esc: (s: unknown) => string; pkgHref: (name: string, ring?: string, arch?: string) => string; errorText: (e: unknown) => string };
beforeAll(async () => {
  F = await seedDashboard(env);
  PAGES = ["/", "/factory", "/review", "/docs", "/docs/get-started", "/docs/workers", "/docs/how-it-works", "/docs/glossary", "/docs/runbook", "/docs/omarchy-cli-mcp", "/packages", `/package/${F.pkg}`, `/build/${F.projectTask}`, "/status", "/workers", "/request", `/user/${F.owner}`, "/people", "/api", "/diff", ...Object.keys(RETIRED_PAGES)];
  const shell = runScript(scriptOf(await (await get("/docs")).text()), { pathname: "/docs", functions: ["esc", "pkgHref", "errorText"] });
  SHELL = { esc: shell.esc, pkgHref: shell.pkgHref, errorText: shell.errorText };
});

describe("the ⌘K menu on the page", () => {
  it("is on every page as a closed dialog after the footer, its script once after the shell's, and the whole script parses", async () => {
    const acorn = await import("acorn");
    expect(() => acorn.parse(GO_MENU, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
    // Closed as served: no open attribute, so a browser draws none of it until the script opens it — and with script off, never.
    expect(GO_MENU_HTML).toMatch(/^<dialog class="go-menu" id="go-menu" aria-label="[^"]+" aria-modal="true">/);
    expect(GO_MENU_HTML).not.toMatch(/<dialog[^>]*\sopen[\s>=]/);
    for (const path of PAGES) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html.split(GO_MENU_HTML).length - 1, `${path}: the menu's markup once`).toBe(1);
      expect(html.indexOf(GO_MENU_HTML), `${path}: after the footer`).toBeGreaterThan(html.indexOf("</footer>"));
      // The header as served: Go… a link to the packages, naming no key, until the script has the menu.
      expect(/<header>[\s\S]*?<\/header>/.exec(html)![0], path).toContain('<a class="go" id="go" href="/packages" title="find a package">Go…</a>');
      const script = scriptOf(html);
      expect(() => acorn.parse(script, { ecmaVersion: 2020, sourceType: "script" }), `${path}: the script parses`).not.toThrow();
      expect(script.split(GO_MENU).length - 1, `${path}: the menu's script once`).toBe(1);
      expect(script.indexOf(GO_MENU), `${path}: after the shell`).toBeGreaterThan(script.indexOf(HELPERS.slice(-120)));
      // It is the frame's: never read as the page's own script.
      expect(ownScriptOf(html), path).not.toContain("go-menu");
    }
  });

  it("offers the handoff's ten actions, and every one lands on a page — a fragment on the page it names", async () => {
    expect(GO_ACTIONS.map((a) => [a.label, a.hint, a.icon])).toEqual([
      ["Browse packages", "/", "search"],
      ["Set up the pool", "›", "terminal"],
      ["Request a package", "factory", "git-pull-request"],
      ["Your requests", "SIGNED IN", "list-checks"],
      ["Review queue", "MAINTAINERS", "clipboard-check"],
      ["Connect your agent", "›", "bot"],
      ["Docs", "", "book-open"],
      ["People", "", "users"],
      ["Status", "LIVE", "activity"],
      ["Theme: dark / light", "", "sun-moon"],
    ]);
    for (const a of GO_ACTIONS) {
      expect(Object.keys(LUCIDE), a.label).toContain(a.icon);
      expect(!!a.href !== !!a.act, `${a.label}: an address or an act, one of them`).toBe(true);
    }
    expect(GO_ACTIONS.filter((a) => a.act).map((a) => a.act)).toEqual(["theme"]);
    for (const a of GO_ACTIONS.filter((x) => x.href)) {
      const [path, fragment] = a.href!.split("#");
      const res = await raw(path);
      if (res.status === 200) {
        if (fragment) expect(await res.text(), `${a.label}: #${fragment} is on ${path}`).toContain(` id="${fragment}"`);
        continue;
      }
      // A redirect lands too: /me on the reader's page, or the sign-in that comes back to it; a footer page still standing in for its own on what stands in.
      expect(res.status, a.label).toBe(302);
      const to = res.headers.get("location")!;
      if (path === "/me") expect(to, a.label).toBe("/auth/github?next=/me");
      else expect((await raw(new URL(to, "http://pool.test").pathname)).status, `${a.label} → ${to}`).toBe(200);
    }
    // Request "<name>" lands on the Factory, whose form (#246) reads the name from ?name=.
    expect((await raw("/factory?name=zzfoo")).status).toBe(200);
  });
});

/** A thing events are dispatched to, the way the menu listens: its listeners by type, and fire() to call them. */
function target<T extends object>(o: T) {
  const on: Record<string, ((ev: any) => void)[]> = {};
  return Object.assign(o, {
    on,
    addEventListener(t: string, f: (ev: any) => void) { (on[t] ||= []).push(f); },
    fire(t: string, ev: any = {}) { for (const f of on[t] ?? []) f(ev); return ev; },
  });
}
/** A key as the browser hands it to a listener: preventDefault marks it. */
function key(k: string, extra: Record<string, unknown> = {}): any {
  const ev: any = { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, ...extra };
  return ev;
}
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * GO_MENU over a document of its own: the dialog and its four parts, Go…,
 * the head the kit's sheet goes into, a page's own search when the test
 * gives one, another open dialog when it says so; a fetch the test answers
 * by hand, timers it runs by hand, the address the menu goes to, and
 * window.opTheme's toggles. rows() reads back what the list was drawn with.
 */
function mount(o: { search?: boolean; searchHidden?: boolean; kitLinked?: boolean; noDialog?: boolean } = {}) {
  const doc: any = target({ activeElement: null as any, body: { tagName: "BODY" }, head: { added: [] as any[], appendChild(c: any) { this.added.push(c); } }, otherDialog: false });
  doc.activeElement = doc.body;
  const focusable = (name: string, extra: object = {}) => ({ name, isConnected: true, focused: [] as any[], focus(opts?: unknown) { this.focused.push(opts ?? null); doc.activeElement = this; }, ...extra });
  const line: any = target(focusable("line", { tagName: "INPUT", value: "", attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; }, removeAttribute(k: string) { delete this.attrs[k]; } }));
  const list: any = target({ innerHTML: "", querySelector: () => null });
  const none: any = { hidden: true, textContent: "" }, said: any = { textContent: "" };
  const menu: any = target({
    open: false, shown: 0,
    showModal() { this.open = true; this.shown++; },
    close() { if (!this.open) return; this.open = false; this.fire("close"); },
    querySelector: (sel: string) => ({ "#go-q": line, "#go-list": list, ".go-none": none, ".go-said": said } as Record<string, unknown>)[sel] ?? null,
  });
  if (o.noDialog) delete menu.showModal;
  const go = focusable("go");
  const search = o.search ? focusable("search", { tagName: "INPUT", disabled: false, getClientRects: () => (o.searchHidden ? [] : [{}]) }) : null;
  doc.createElement = (tag: string) => ({ tag });
  doc.querySelector = (sel: string) => {
    if (sel === "#go-menu") return menu;
    if (sel === "#go") return go;
    if (sel === `link[href="${KIT_SHEET_PATH}"]`) return o.kitLinked || doc.head.added.some((l: any) => l.href === KIT_SHEET_PATH) ? {} : null;
    if (sel === '[aria-keyshortcuts="/"]') return search;
    if (sel === "dialog[open]") return doc.otherDialog ? {} : null;
    return null;
  };
  const asked: string[] = [], replies: ((r: unknown) => void)[] = [];
  const fetch = (url: string) => { asked.push(url); return new Promise((res) => replies.push(res)); };
  let timers: { id: number; fn: () => void }[] = [], ids = 0;
  const setTimeout = (fn: () => void) => { const id = ++ids; timers.push({ id, fn }); return id; };
  const clearTimeout = (id: number) => { timers = timers.filter((t) => t.id !== id); };
  const window: any = { opTheme: { toggles: 0, toggle() { this.toggles++; return "light"; } } };
  const location = { assigned: [] as string[], assign(h: string) { this.assigned.push(h); } };
  new Function("document", "window", "location", "fetch", "setTimeout", "clearTimeout", "esc", "pkgHref", "errorText", "ARCHES", GO_MENU)(doc, window, location, fetch, setTimeout, clearTimeout, SHELL.esc, SHELL.pkgHref, SHELL.errorText, [...REPO_ARCHES]);
  const rows = () => [...list.innerHTML.matchAll(/<(a|div) class="go-opt" id="go-o-(\d+)" role="option" aria-selected="(true|false)" data-i="\d+"(?: href="([^"]*)" tabindex="-1")?><span class="go-ic">(<i [^>]*><\/i>)<\/span><span class="go-l">([^<]*)<\/span><span class="go-h">([^<]*)<\/span><\/\1>/g)]
    .map((m) => ({ id: `go-o-${m[2]}`, selected: m[3] === "true", href: m[4] === undefined ? null : unescape(m[4]), icon: m[5], label: unescape(m[6]), hint: unescape(m[7]) }));
  return {
    doc, menu, line, list, none, said, go, search, window, location, asked, rows,
    /** The page's key, from wherever the focus is. */
    press: (k: string, extra: Record<string, unknown> = {}) => doc.fire("keydown", key(k, { target: doc.activeElement, ...extra })),
    /** A key on the menu's line, as the browser sends it there first and then up to the document. */
    keyOnLine: (k: string, extra: Record<string, unknown> = {}) => { const ev = line.fire("keydown", key(k, { target: line, ...extra })); doc.fire("keydown", ev); return ev; },
    type: (text: string) => { line.value = text; line.fire("input"); },
    tick: () => { const due = timers; timers = []; due.forEach((t) => t.fn()); },
    answer: async (i: number, body: unknown, status = 200) => { replies[i]({ ok: status < 400, status, json: async () => body }); await new Promise((r) => globalThis.setTimeout(r, 0)); },
  };
}
const pkg = (name: string, source = "extra", description = `${name} for the menu's test`) => ({ name, version: "1.0-1", repo_arch: "x86_64", source, size_download: 1, sha256: "0".repeat(64), description });
const homeSearch = (term: string) => `/api/v1/search?q=${encodeURIComponent(term)}&ring=stable&arch=${REPO_ARCHES[0]}&limit=9`;

describe("the ⌘K menu, run", () => {
  it("opens and closes with ⌘K or Ctrl+K, links the kit's sheet once, and gives the focus back", () => {
    const m = mount();
    expect(typeof m.window.opPalette.open).toBe("function");
    const before = { name: "somewhere", isConnected: true, focused: [] as unknown[], focus(opts: unknown) { this.focused.push(opts); m.doc.activeElement = this; } };
    m.doc.activeElement = before;
    const ev = m.press("k", { metaKey: true });
    expect(ev.defaultPrevented, "the browser's own ⌘K is not also run").toBe(true);
    expect(m.menu.open).toBe(true);
    expect(m.doc.activeElement, "the line has the focus").toBe(m.line);
    expect(m.doc.head.added).toEqual([{ tag: "link", rel: "stylesheet", href: KIT_SHEET_PATH }]);
    // Nothing typed: the ten actions, the first one lit and named for a screen reader, each icon the kit's as lucide() writes it.
    const rows = m.rows();
    expect(rows.map((r) => r.label)).toEqual(GO_ACTIONS.map((a) => a.label));
    expect(rows.map((r) => r.hint)).toEqual(GO_ACTIONS.map((a) => a.hint));
    expect(rows.map((r) => r.href)).toEqual(GO_ACTIONS.map((a) => a.href ?? null));
    expect(rows.map((r) => r.icon)).toEqual(GO_ACTIONS.map((a) => lucide(a.icon as LucideName, 16)));
    expect(rows.map((r) => r.selected)).toEqual(GO_ACTIONS.map((_, i) => i === 0));
    expect(m.line.attrs["aria-activedescendant"]).toBe("go-o-0");
    expect(m.line.attrs["aria-expanded"]).toBe("true");
    expect(m.said.textContent).toBe("10 results");
    // ⌘K again closes it, and the focus is where it was, the page not scrolled to it.
    m.keyOnLine("k", { metaKey: true });
    expect(m.menu.open).toBe(false);
    expect(m.doc.activeElement).toBe(before);
    expect(before.focused).toEqual([{ preventScroll: true }]);
    // Ctrl+K too; the sheet is not linked twice.
    m.press("k", { ctrlKey: true });
    expect(m.menu.open).toBe(true);
    expect(m.doc.head.added.length).toBe(1);
    m.keyOnLine("K", { ctrlKey: true });
    expect(m.menu.open).toBe(false);
    // Shift+⌘K is another shortcut (a browser's console); another dialog open answers first.
    expect(m.press("k", { metaKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    m.doc.otherDialog = true;
    expect(m.press("k", { metaKey: true }).defaultPrevented).toBe(false);
    expect(m.menu.open).toBe(false);
    // A page that links the kit already (page({ kit: true })) is not given it again.
    const k = mount({ kitLinked: true });
    k.window.opPalette.open();
    expect(k.menu.open).toBe(true);
    expect(k.doc.head.added).toEqual([]);
  });

  it("closes on Esc, on the cancel event and on a press beside it; keeps the focus on the line; gives it back to Go… when nothing had it", () => {
    const m = mount();
    m.window.opPalette.open();
    expect(m.keyOnLine("Tab").defaultPrevented, "Tab stays on the line").toBe(true);
    expect(m.keyOnLine("Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(m.menu.open).toBe(true);
    // A press inside the menu does not take the focus from the line; on the line itself it does what a press does.
    const inside = key("", { target: m.list });
    m.menu.fire("mousedown", inside);
    expect(inside.defaultPrevented).toBe(true);
    const onLine = key("", { target: m.line });
    m.menu.fire("mousedown", onLine);
    expect(onLine.defaultPrevented).toBe(false);
    const esc = m.keyOnLine("Escape");
    expect(esc.defaultPrevented).toBe(true);
    expect(m.menu.open).toBe(false);
    // Nothing had the focus (a press on a button Safari does not focus): Go…, the menu's own button, gets it.
    expect(m.doc.activeElement).toBe(m.go);
    expect(m.go.focused).toEqual([{ preventScroll: true }]);
    m.window.opPalette.open();
    const cancel = m.menu.fire("cancel", key(""));
    expect(cancel.defaultPrevented).toBe(true);
    expect(m.menu.open).toBe(false);
    m.window.opPalette.open();
    m.menu.fire("click", { target: m.list });
    expect(m.menu.open, "a press inside is not beside it").toBe(true);
    m.menu.fire("click", { target: m.menu });
    expect(m.menu.open).toBe(false);
    m.window.opPalette.toggle();
    expect(m.menu.open).toBe(true);
    m.window.opPalette.toggle();
    expect(m.menu.open).toBe(false);
  });

  it("gives / to the page's own search where one is marked, and opens the menu everywhere else", () => {
    const m = mount({ search: true });
    let ev = m.press("/");
    expect(ev.defaultPrevented).toBe(true);
    expect(m.doc.activeElement).toBe(m.search);
    expect(m.menu.open).toBe(false);
    // Typed into a field, / is a slash; with a modifier it is someone else's key.
    expect(m.press("/").defaultPrevented, "the search has the focus now").toBe(false);
    m.doc.activeElement = m.doc.body;
    expect(m.press("/", { metaKey: true }).defaultPrevented).toBe(false);
    expect(m.press("/", { target: { tagName: "TEXTAREA" } }).defaultPrevented).toBe(false);
    expect(m.press("/", { target: { tagName: "DIV", isContentEditable: true } }).defaultPrevented).toBe(false);
    // No search on the page, or one that is not drawn: the menu.
    for (const other of [mount(), mount({ search: true, searchHidden: true })]) {
      ev = other.press("/");
      expect(ev.defaultPrevented).toBe(true);
      expect(other.menu.open).toBe(true);
      // Open, / is typed into the line.
      expect(other.keyOnLine("/").defaultPrevented).toBe(false);
      expect(other.menu.open).toBe(true);
    }
  });

  it("filters the actions as the reader types, moves with ↑ and ↓ round the list, and opens the row with ↵", async () => {
    const m = mount();
    m.window.opPalette.open();
    // One letter: the actions that name it, and no search (the endpoint's floor is two).
    m.type("p");
    expect(m.rows().map((r) => r.label)).toEqual(["Browse packages", "Set up the pool", "Request a package", "People"]);
    m.tick();
    expect(m.asked).toEqual([]);
    m.keyOnLine("ArrowUp");
    expect(m.rows().map((r) => r.selected)).toEqual([false, false, false, true]);
    expect(m.line.attrs["aria-activedescendant"]).toBe("go-o-3");
    m.keyOnLine("ArrowDown");
    expect(m.rows()[0].selected).toBe(true);
    m.keyOnLine("ArrowDown");
    m.keyOnLine("ArrowDown");
    const enter = m.keyOnLine("Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(m.location.assigned).toEqual(["/factory"]);
    expect(m.menu.open).toBe(false);
    // A word the action does not say: the Journal is a section of Status.
    m.window.opPalette.open();
    expect(m.line.value, "the line is empty again").toBe("");
    m.type("journal");
    expect(m.rows().map((r) => r.label)).toEqual(["Status"]);
    // The pointer moves the lit row too; a press opens it, and one with a modifier is the browser's.
    m.type("do");
    m.tick();
    await m.answer(0, { packages: [] });
    expect(m.rows().map((r) => r.label)).toEqual(["Docs", 'Request "do"']);
    m.list.fire("mousemove", { target: { closest: () => ({ getAttribute: () => "1" }) } });
    expect(m.rows().map((r) => r.selected)).toEqual([false, true]);
    const newTab = m.list.fire("click", { metaKey: true, target: { closest: () => ({ getAttribute: () => "0" }) }, preventDefault() { throw new Error("a modified press is the browser's"); } });
    expect(newTab.metaKey).toBe(true);
    expect(m.menu.open).toBe(true);
    m.list.fire("click", { target: { closest: () => ({ getAttribute: () => "0" }) }, preventDefault() {} });
    expect(m.location.assigned).toEqual(["/factory", "/docs"]);
    expect(m.menu.open).toBe(false);
  });

  it("switches the theme through opTheme, in place", () => {
    const m = mount();
    m.window.opPalette.open();
    m.type("theme");
    expect(m.rows()[0]).toMatchObject({ label: "Theme: dark / light", href: null });
    m.keyOnLine("Enter");
    expect(m.window.opTheme.toggles).toBe(1);
    expect(m.location.assigned).toEqual([]);
    expect(m.menu.open).toBe(false);
  });

  it("asks Home's search at its address, once per pause and once per term, and narrows a whole answer without asking", async () => {
    const m = mount();
    m.window.opPalette.open();
    for (const t of ["h", "hy", "hyp", "hypr"]) m.type(t);
    expect(m.asked, "nothing before the pause").toEqual([]);
    m.tick();
    expect(m.asked).toEqual([homeSearch("hypr")]);
    // Nine rows — the limit, so not the whole answer: the first six packages, then Request, since no row is "hypr" itself.
    const nine = ["hyprland", "hyprlock", "hypridle", "hyprpaper", "hyprpicker", "hyprsunset", "hyprcursor", "hyprutils", "xdg-desktop-portal-hyprland"].map((n) => pkg(n));
    await m.answer(0, { packages: nine });
    let rows = m.rows();
    expect(rows.map((r) => r.label)).toEqual([...nine.slice(0, 6).map((p) => p.name), 'Request "hypr"']);
    expect(rows[0]).toMatchObject({ hint: "extra", href: SHELL.pkgHref("hyprland", "stable", REPO_ARCHES[0]), icon: lucide("package", 16) });
    expect(rows[6]).toMatchObject({ hint: "factory", href: "/factory?name=hypr", icon: lucide("git-pull-request", 16) });
    // A longer term the answer does not hold whole: asked, and until then the rows of the last answer that still match — never a Request.
    m.type("hyprland");
    expect(m.rows().map((r) => r.label)).toEqual(["hyprland", "xdg-desktop-portal-hyprland"]);
    m.tick();
    expect(m.asked).toEqual([homeSearch("hypr"), homeSearch("hyprland")]);
    await m.answer(1, { packages: [pkg("hyprland-qtutils"), pkg("hyprland")] });
    // The name itself first, whatever order the rows came in; no Request for a name that is a package.
    rows = m.rows();
    expect(rows.map((r) => r.label)).toEqual(["hyprland", "hyprland-qtutils"]);
    m.keyOnLine("Enter");
    expect(m.location.assigned).toEqual([SHELL.pkgHref("hyprland", "stable", REPO_ARCHES[0])]);
    // Asked once per page: the same term again is answered from memory.
    m.window.opPalette.open();
    m.type("hypr");
    m.tick();
    expect(m.asked.length).toBe(2);
    expect(m.rows().length).toBe(7);
    // A whole answer (fewer rows than the limit) holds every answer to a term inside it: "zzfoo" is never asked.
    m.type("zz");
    m.tick();
    expect(m.asked[2]).toBe(homeSearch("zz"));
    await m.answer(2, { packages: [] });
    expect(m.rows().map((r) => r.label)).toEqual(['Request "zz"']);
    m.type("zzfoo");
    m.tick();
    expect(m.asked.length, "narrowed, not asked").toBe(3);
    expect(m.rows().map((r) => [r.label, r.hint, r.selected])).toEqual([['Request "zzfoo"', "factory", true]]);
    m.keyOnLine("Enter");
    expect(m.location.assigned[m.location.assigned.length - 1]).toBe("/factory?name=zzfoo");
  });

  it("waits for the answer when ↵ comes before it with nothing shown, and draws no answer for a line that moved on", async () => {
    const m = mount();
    m.window.opPalette.open();
    m.type("qqq");
    expect(m.rows()).toEqual([]);
    expect(m.line.attrs["aria-expanded"], "no rows: the list is collapsed").toBe("false");
    expect(m.line.attrs["aria-activedescendant"]).toBeUndefined();
    expect(m.none.hidden, "no 'nothing matches' while the search is out").toBe(true);
    m.keyOnLine("Enter");
    expect(m.location.assigned).toEqual([]);
    m.tick();
    await m.answer(0, { packages: [] });
    expect(m.location.assigned).toEqual(["/factory?name=qqq"]);
    // An answer that lands after the line changed does not draw over it.
    m.window.opPalette.open();
    m.type("abc");
    m.tick();
    m.type("peo");
    await m.answer(1, { packages: [pkg("abc")] });
    expect(m.rows().map((r) => r.label)).toEqual(["People"]);
  });

  it("says a search that did not answer, and offers no Request over it", async () => {
    const m = mount();
    m.window.opPalette.open();
    m.type("ghostty");
    m.tick();
    await m.answer(0, { error: "internal error" }, 500);
    expect(m.rows()).toEqual([]);
    expect(m.none.hidden).toBe(false);
    expect(m.none.textContent).toBe("the package search did not answer: HTTP 500");
    // Typing again asks again.
    m.type("ghostt");
    m.tick();
    expect(m.asked.length).toBe(2);
    expect(m.none.hidden).toBe(true);
  });

  it("escapes what it writes: a package's name and source, the typed line", async () => {
    const m = mount();
    m.window.opPalette.open();
    m.type('<b>x</b>');
    m.tick();
    await m.answer(0, { packages: [pkg('<img src=x onerror=alert(1)>', '"><script>')] });
    expect(m.list.innerHTML).not.toMatch(/<img|<script|<b>/);
    expect(m.list.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(m.list.innerHTML).toContain("&quot;&gt;&lt;script&gt;");
    // Not a pacman name: no Request, and nothing to go to.
    expect(m.rows().map((r) => r.label)).toEqual(['<img src=x onerror=alert(1)>']);
    m.type('"><i>');
    m.tick();
    await m.answer(1, { packages: [] });
    expect(m.rows()).toEqual([]);
    expect(m.none.textContent).toBe('nothing matches “"><i>”');
  });

  it("leaves a browser without <dialog> as served: no menu, no key taken", () => {
    const m = mount({ noDialog: true });
    expect(m.window.opPalette).toBeUndefined();
    expect(m.doc.on.keydown ?? []).toEqual([]);
  });
});
