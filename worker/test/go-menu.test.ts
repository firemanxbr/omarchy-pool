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
 * Home's box asks, at its very address, one search per pause in the
 * typing, each term asked once, a term inside a whole answer narrowed
 * without asking, a package whose name holds the line above an action a
 * hidden word found; a name the search did not find looked up — the
 * factory's names, then the name on each architecture — and drawn first
 * where it is, Request "<name>" only for a name found nowhere, landing on
 * the request form with the name filled in, ↵ before that answer waiting
 * for it; a package's origin in words; a search or a lookup that did not
 * answer said, to a screen reader too, not drawn as "no package"; one
 * letter asking for another; on a Mac, Ctrl+K left to a text field; the
 * theme through opTheme; the kit's sheet linked the first time the menu
 * opens, once; everything the menu writes escaped; and a browser without
 * <dialog> left as served, its closed dialog hidden by the CSS.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { EXPECTED_SOURCES, REPO_ARCHES } from "../src/meta";
import { GO_ACTIONS, GO_MENU, GO_MENU_HTML, HELPERS } from "../src/pages/layout";
import { KIT_SHEET_PATH, LUCIDE, lucide, type LucideName } from "../src/pages/kit";
import { fetchPage, ownScriptOf, runScript, scriptOf, seedDashboard, type Fixture } from "./fixture";

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await fetchPage(new Request(`http://pool.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
// The Worker's own handler, for an address that redirects: its 301 or 302 is read as it is, never followed.
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
  PAGES = ["/", "/factory", "/review", "/docs", "/docs/get-started", "/docs/workers", "/docs/how-it-works", "/docs/glossary", "/docs/runbook", "/docs/omarchy-cli-mcp", "/packages", `/package/${F.pkg}`, `/build/${F.projectTask}`, "/status", "/workers", "/request", `/user/${F.owner}`, "/people", "/api", "/diff"];
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
  });

  it("lands Request \"<name>\" on the Factory's form with the name filled in, for whoever is looking, and takes only a pacman name from the address", async () => {
    const res = await raw("/request?name=zzfoo");
    expect(res.status).toBe(200);
    const script = scriptOf(await res.text());
    const cases: [string, unknown, string][] = [
      ["?name=zzfoo", { login: "alice", role: "contributor" }, "zzfoo"],
      // Nobody signed in: the name is in the grey form, and the sign-in comes back to this address.
      ["?name=zzfoo", null, "zzfoo"],
      ["?name=%3Cb%3Ex", { login: "alice", role: "contributor" }, ""],
      ["?name=ZZFOO", { login: "alice", role: "contributor" }, ""],
      // A renewal fills the whole form from the record instead.
      ["?renew=mine&name=zzfoo", { login: "alice", role: "contributor" }, ""],
    ];
    for (const [search, me, want] of cases) {
      const ran = runScript(script, {
        pathname: "/request", search, functions: [],
        fetch: async (path: string) => (path === "/auth/me" ? (me ? Response.json(me) : Response.json({ error: "sign in" }, { status: 401 })) : new Promise<Response>(() => {})),
      });
      for (let i = 0; i < 20 && !ran.nodes["#pkg-form"]?.innerHTML; i++) await new Promise((r) => globalThis.setTimeout(r, 5));
      expect(ran.nodes["#pkg-form"]?.innerHTML, `${search}: the form drawn`).toContain('id="pkg-name"');
      expect(ran.nodes["#pkg-name"]?.value ?? "", search).toBe(want);
    }
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
function mount(o: { search?: boolean; searchHidden?: boolean; kitLinked?: boolean; noDialog?: boolean; mac?: boolean } = {}) {
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
  const asked: string[] = [], replies: ((r: unknown) => void)[] = [], answered = new Set<number>();
  const fetch = (url: string) => { asked.push(url); return new Promise((res) => replies.push(res)); };
  let timers: { id: number; fn: () => void }[] = [], ids = 0;
  const setTimeout = (fn: () => void) => { const id = ++ids; timers.push({ id, fn }); return id; };
  const clearTimeout = (id: number) => { timers = timers.filter((t) => t.id !== id); };
  const window: any = { opTheme: { toggles: 0, toggle() { this.toggles++; return "light"; } } };
  const location = { assigned: [] as string[], assign(h: string) { this.assigned.push(h); } };
  const navigator = { platform: o.mac ? "MacIntel" : "Linux x86_64" };
  new Function("document", "window", "location", "navigator", "fetch", "setTimeout", "clearTimeout", "esc", "pkgHref", "errorText", "ARCHES", GO_MENU)(doc, window, location, navigator, fetch, setTimeout, clearTimeout, SHELL.esc, SHELL.pkgHref, SHELL.errorText, [...REPO_ARCHES]);
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
    answer,
    /** The last request to this address still waiting, answered; a test that answers what was never asked fails here. */
    reply: async (url: string, body: unknown, status = 200) => {
      await settle();
      let i = asked.length - 1;
      while (i >= 0 && (asked[i] !== url || answered.has(i))) i--;
      if (i < 0) throw new Error(`nothing waits for ${url}; asked: ${asked.join(" ")}`);
      await answer(i, body, status);
    },
    /** Whether a request to this address is still waiting. */
    waits: (url: string) => asked.some((u, j) => u === url && !answered.has(j)),
    /** The searches asked, in order: the requests the menu makes of the one search Home's box asks. */
    searches: () => asked.filter((u) => u.startsWith("/api/v1/search?")),
  };
  async function answer(i: number, body: unknown, status = 200) { answered.add(i); replies[i]({ ok: status < 400, status, json: async () => body }); await settle(); }
}
/** Every promise the menu chained on what was answered, run: the next request it makes is asked by then. */
async function settle() { for (let k = 0; k < 4; k++) await new Promise((r) => globalThis.setTimeout(r, 0)); }
const REGISTRY = "/api/v1/factory/packages";
/** The package page's own address for a name, which the menu asks where the name is. */
const lookup = (name: string, arch: string) => `/api/v1/package/${name}?ring=stable&arch=${arch}`;
/** A name found nowhere: the factory's names (the first time the page asks them) hold it not, and no architecture serves it. */
async function nowhere(m: ReturnType<typeof mount>, name: string, registered: string[] = []) {
  await settle();
  if (m.waits(REGISTRY)) await m.reply(REGISTRY, { packages: registered.map((n) => ({ name: n })) });
  for (const arch of REPO_ARCHES) await m.reply(lookup(name, arch), { error: `${name} is not in any ring for ${arch}` }, 404);
}
const origin = (source: string, arch: string) => EXPECTED_SOURCES.find((e) => e.source === source && e.arch === arch)!.origin;
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
    expect(m.none.hidden).toBe(true);
    expect(m.said.textContent).toBe("4 results");
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
    await m.reply(homeSearch("do"), { packages: [] });
    await nowhere(m, "do");
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

  it("asks for another letter when one matches no action, and never says nothing matches before the search has answered", () => {
    const m = mount();
    m.window.opPalette.open();
    // "z": no action says it, and the search is not asked below two letters — zlib may well be there.
    m.type("z");
    m.tick();
    expect(m.asked).toEqual([]);
    expect(m.rows()).toEqual([]);
    expect(m.none.hidden).toBe(false);
    expect(m.none.textContent).toBe("type one more letter to search the packages");
    expect(m.said.textContent, "a screen reader hears the same words").toBe("type one more letter to search the packages");
    // Two letters, the search out: nothing said yet.
    m.type("zl");
    expect(m.none.hidden).toBe(true);
    expect(m.said.textContent).toBe("");
  });

  it("switches the theme through opTheme, in place", () => {
    const m = mount();
    m.window.opPalette.open();
    m.type("theme");
    expect(m.rows()[0]).toMatchObject({ label: "Theme: dark / light", href: null });
    // An action lit opens at once: the search still out cannot put a package's name above it unless the name is the line.
    m.keyOnLine("Enter");
    expect(m.window.opTheme.toggles).toBe(1);
    expect(m.location.assigned).toEqual([]);
    expect(m.menu.open).toBe(false);
  });

  it("puts a package whose name holds the line above an action a hidden word found, and an action the line begins above them all", async () => {
    const m = mount();
    m.window.opPalette.open();
    // "pacm" is in Set up the pool's words, and pacman is a package: pacman first, ↵ opens it.
    m.type("pacm");
    m.tick();
    await m.reply(homeSearch("pacm"), { packages: [pkg("pacman", "core"), pkg("pacman-contrib"), pkg("yay", "chaotic", "a pacman wrapper")] });
    await nowhere(m, "pacm");
    expect(m.rows().map((r) => r.label)).toEqual(["pacman", "pacman-contrib", "Set up the pool", "yay", 'Request "pacm"']);
    expect(m.rows().map((r) => r.hint)).toEqual([origin("core", REPO_ARCHES[0]), origin("extra", REPO_ARCHES[0]), "›", origin("chaotic", REPO_ARCHES[0]), "factory"]);
    m.keyOnLine("Enter");
    expect(m.location.assigned).toEqual([SHELL.pkgHref("pacman", "stable", REPO_ARCHES[0])]);
    // "pac": the actions whose label holds it later, or whose words do, after the names and before what only a description matched.
    m.window.opPalette.open();
    m.type("pac");
    m.tick();
    await m.reply(homeSearch("pac"), { packages: [pkg("pacman", "core"), pkg("libalpm-pac"), pkg("yay", "chaotic", "a pacman wrapper")] });
    await nowhere(m, "pac");
    expect(m.rows().map((r) => r.label)).toEqual(["pacman", "libalpm-pac", "Browse packages", "Set up the pool", "Request a package", "yay", 'Request "pac"']);
    // "ai" is Connect your agent's word, and cairo's name holds it.
    m.type("ai");
    m.tick();
    await m.reply(homeSearch("ai"), { packages: [pkg("cairo")] });
    await nowhere(m, "ai");
    expect(m.rows().map((r) => r.label)).toEqual(["cairo", "Connect your agent", 'Request "ai"']);
    // "theme": the Theme action begins with it, and goes before the packages whose names hold it.
    m.type("theme");
    m.tick();
    await m.reply(homeSearch("theme"), { packages: [pkg("adwaita-icon-theme"), pkg("sddm", "extra", "a login manager with themes")] });
    await nowhere(m, "theme");
    expect(m.rows().map((r) => r.label)).toEqual(["Theme: dark / light", "adwaita-icon-theme", "sddm", 'Request "theme"']);
    // The typed name that is a package goes first of all, before an action it begins.
    m.type("docs");
    m.tick();
    await m.reply(homeSearch("docs"), { packages: [pkg("python-docs"), pkg("docs")] });
    expect(m.rows().map((r) => r.label)).toEqual(["docs", "Docs", "python-docs"]);
    expect(m.waits(lookup("docs", REPO_ARCHES[0])), "a name the search found is not looked up").toBe(false);
  });

  it("says where a package comes from in words, and the source's id only when the sources do not know it", async () => {
    const m = mount();
    m.window.opPalette.open();
    m.type("hypr");
    m.tick();
    await m.reply(homeSearch("hypr"), { packages: [pkg("hyprland-qtutils", "packages"), pkg("hyprland", "extra"), pkg("hyprmon", "factory"), pkg("hyprx", "somewhere-new")] });
    expect(m.rows().map((r) => [r.label, r.hint])).toEqual([
      ["hyprland-qtutils", "Omarchy"],
      ["hyprland", "Arch extra"],
      ["hyprmon", "factory"],
      ["hyprx", "somewhere-new"],
    ]);
  });

  it("asks Home's search at its address, once per pause and once per term, and narrows a whole answer without asking", async () => {
    const m = mount();
    m.window.opPalette.open();
    for (const t of ["h", "hy", "hyp", "hypr"]) m.type(t);
    expect(m.asked, "nothing before the pause").toEqual([]);
    m.tick();
    expect(m.asked).toEqual([homeSearch("hypr")]);
    // Nine rows — the limit, so not the whole answer: the first six packages, then — "hypr" itself found nowhere — Request.
    const nine = ["hyprland", "hyprlock", "hypridle", "hyprpaper", "hyprpicker", "hyprsunset", "hyprcursor", "hyprutils", "xdg-desktop-portal-hyprland"].map((n) => pkg(n));
    await m.answer(0, { packages: nine });
    let rows = m.rows();
    expect(rows.map((r) => r.label), "no Request while the name is looked up").toEqual(nine.slice(0, 6).map((p) => p.name));
    expect(m.said.textContent, "nothing said until the rows are settled").toBe("");
    await nowhere(m, "hypr");
    rows = m.rows();
    expect(rows.map((r) => r.label)).toEqual([...nine.slice(0, 6).map((p) => p.name), 'Request "hypr"']);
    expect(rows[0]).toMatchObject({ hint: origin("extra", REPO_ARCHES[0]), href: SHELL.pkgHref("hyprland", "stable", REPO_ARCHES[0]), icon: lucide("package", 16) });
    expect(rows[6]).toMatchObject({ hint: "factory", href: "/request?name=hypr", icon: lucide("git-pull-request", 16) });
    expect(m.said.textContent).toBe("7 results");
    // A longer term the answer does not hold whole: asked, and until then the rows of the last answer that still match — never a Request.
    m.type("hyprland");
    expect(m.rows().map((r) => r.label)).toEqual(["hyprland", "xdg-desktop-portal-hyprland"]);
    m.tick();
    expect(m.searches()).toEqual([homeSearch("hypr"), homeSearch("hyprland")]);
    await m.reply(homeSearch("hyprland"), { packages: [pkg("hyprland-qtutils"), pkg("hyprland")] });
    // The name itself first, whatever order the rows came in; no Request for a name that is a package, and nothing looked up.
    rows = m.rows();
    expect(rows.map((r) => r.label)).toEqual(["hyprland", "hyprland-qtutils"]);
    expect(m.waits(lookup("hyprland", REPO_ARCHES[0]))).toBe(false);
    m.keyOnLine("Enter");
    expect(m.location.assigned).toEqual([SHELL.pkgHref("hyprland", "stable", REPO_ARCHES[0])]);
    // Asked once per page: the same term again is answered from memory, the lookups too.
    const before = m.asked.length;
    m.window.opPalette.open();
    m.type("hypr");
    m.tick();
    expect(m.asked.length).toBe(before);
    expect(m.rows().length).toBe(7);
    // A whole answer (fewer rows than the limit) holds every answer to a term inside it: "zzfoo" is never searched, only looked up.
    m.type("zz");
    m.tick();
    expect(m.searches()[2]).toBe(homeSearch("zz"));
    await m.reply(homeSearch("zz"), { packages: [] });
    await nowhere(m, "zz");
    expect(m.rows().map((r) => r.label)).toEqual(['Request "zz"']);
    m.type("zzfoo");
    m.tick();
    expect(m.searches().length, "narrowed, not searched").toBe(3);
    await nowhere(m, "zzfoo");
    expect(m.rows().map((r) => [r.label, r.hint, r.selected])).toEqual([['Request "zzfoo"', "factory", true]]);
    m.keyOnLine("Enter");
    expect(m.location.assigned[m.location.assigned.length - 1]).toBe("/request?name=zzfoo");
    // The factory's names were asked once for the page, whatever was looked up.
    expect(m.asked.filter((u) => u === REGISTRY).length).toBe(1);
  });

  it("uses a whole answer that lands in the pause for the line typed since, instead of asking for it", async () => {
    const m = mount();
    m.window.opPalette.open();
    m.type("zz");
    m.tick();
    expect(m.searches()).toEqual([homeSearch("zz")]);
    // "zz" is out when the reader types on; its whole answer lands before the pause is over.
    m.type("zzfoo");
    await m.reply(homeSearch("zz"), { packages: [] });
    m.tick();
    expect(m.searches(), "zzfoo is inside the whole answer to zz").toEqual([homeSearch("zz")]);
    await nowhere(m, "zzfoo");
    expect(m.rows().map((r) => r.label)).toEqual(['Request "zzfoo"']);
  });

  it("looks up a name the search did not find, and draws it first where it is: another architecture, a ring before stable, the factory's", async () => {
    const m = mount();
    m.window.opPalette.open();
    // An aarch64 package: stable on the first architecture has no row, the factory does not know the name, the first architecture serves it nowhere, the second does.
    m.type("linux-asahi");
    m.keyOnLine("Enter");
    m.tick();
    await m.reply(homeSearch("linux-asahi"), { packages: [] });
    expect(m.rows(), "nothing drawn while the name is looked up").toEqual([]);
    expect(m.none.hidden, "and no 'nothing matches'").toBe(true);
    expect(m.location.assigned, "↵ waits").toEqual([]);
    await m.reply(REGISTRY, { packages: [{ name: "ours" }, { name: "caligula" }] });
    await m.reply(lookup("linux-asahi", REPO_ARCHES[0]), { error: "linux-asahi is not in any ring" }, 404);
    await m.reply(lookup("linux-asahi", REPO_ARCHES[1]), { name: "linux-asahi", shown_ring: "stable", package: { source: "asahi-alarm" } });
    expect(m.location.assigned, "↵ opens the package, not a request").toEqual([SHELL.pkgHref("linux-asahi", "stable", REPO_ARCHES[1])]);
    m.window.opPalette.open();
    m.type("linux-asahi");
    m.tick();
    expect(m.rows().map((r) => [r.label, r.hint, r.href])).toEqual([["linux-asahi", origin("asahi-alarm", REPO_ARCHES[1]), SHELL.pkgHref("linux-asahi", "stable", REPO_ARCHES[1])]]);
    // A package only in edge on the first architecture: its own lookup answers, the second architecture is not asked.
    m.type("newtool");
    m.tick();
    await m.reply(homeSearch("newtool"), { packages: [] });
    await m.reply(lookup("newtool", REPO_ARCHES[0]), { name: "newtool", shown_ring: "edge", package: { source: "extra" } });
    expect(m.rows().map((r) => [r.label, r.hint, r.href])).toEqual([["newtool", origin("extra", REPO_ARCHES[0]), SHELL.pkgHref("newtool", "stable", REPO_ARCHES[0])]]);
    expect(m.asked).not.toContain(lookup("newtool", REPO_ARCHES[1]));
    // A factory name — in the lab, or reserved by a request and in no ring yet — is its package's page, before a row only its description found, and nothing else is asked. ↵ with that row lit waits for where the name is.
    const f = mount();
    f.window.opPalette.open();
    f.type("ours");
    f.tick();
    await f.reply(homeSearch("ours"), { packages: [pkg("hourly", "extra", "counts the hours")] });
    expect(f.rows().map((r) => r.label)).toEqual(["hourly"]);
    f.keyOnLine("Enter");
    expect(f.location.assigned, "↵ waits: the name may come first").toEqual([]);
    await f.reply(REGISTRY, { packages: [{ name: "ours" }, { name: "caligula" }] });
    expect(f.asked).not.toContain(lookup("ours", REPO_ARCHES[0]));
    expect(f.location.assigned).toEqual([SHELL.pkgHref("ours", "stable", REPO_ARCHES[0])]);
    f.window.opPalette.open();
    f.type("ours");
    expect(f.rows().map((r) => [r.label, r.hint])).toEqual([["ours", "factory"], ["hourly", origin("extra", REPO_ARCHES[0])]]);
    f.type("caligula");
    f.tick();
    await f.reply(homeSearch("caligula"), { packages: [] });
    expect(f.rows().map((r) => [r.label, r.hint, r.href])).toEqual([["caligula", "factory", SHELL.pkgHref("caligula", "stable", REPO_ARCHES[0])]]);
    expect(f.rows().some((r) => r.label.startsWith("Request")), "a reserved name is not offered again").toBe(false);
    // A row the reader moved to is theirs: ↵ opens it at once, whatever is still being looked up.
    const g = mount();
    g.window.opPalette.open();
    g.type("ours");
    g.tick();
    await g.reply(homeSearch("ours"), { packages: [pkg("hourly", "extra", "counts the hours")] });
    g.keyOnLine("ArrowDown");
    g.keyOnLine("Enter");
    expect(g.location.assigned).toEqual([SHELL.pkgHref("hourly", "stable", REPO_ARCHES[0])]);
    // A ↵ still waiting is taken back by a move: the answer that lands opens nothing by itself.
    const h = mount();
    h.window.opPalette.open();
    h.type("ours");
    h.keyOnLine("Enter");
    h.keyOnLine("ArrowDown");
    h.tick();
    await h.reply(homeSearch("ours"), { packages: [pkg("hourly", "extra", "counts the hours")] });
    await h.reply(REGISTRY, { packages: [{ name: "ours" }] });
    expect(h.location.assigned).toEqual([]);
    expect(h.rows().map((r) => [r.label, r.selected])).toEqual([["ours", true], ["hourly", false]]);
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
    await m.reply(homeSearch("qqq"), { packages: [] });
    expect(m.location.assigned, "the name is looked up first").toEqual([]);
    await nowhere(m, "qqq");
    expect(m.location.assigned).toEqual(["/request?name=qqq"]);
    // An answer that lands after the line changed does not draw over it.
    m.window.opPalette.open();
    m.type("abc");
    m.tick();
    m.type("peo");
    await m.reply(homeSearch("abc"), { packages: [pkg("abc")] });
    expect(m.rows().map((r) => r.label)).toEqual(["People"]);
  });

  it("says a search or a lookup that did not answer, to a screen reader too, and offers no Request over it", async () => {
    const m = mount();
    m.window.opPalette.open();
    m.type("ghostty");
    m.tick();
    await m.answer(0, { error: "internal error" }, 500);
    expect(m.rows()).toEqual([]);
    expect(m.none.hidden).toBe(false);
    expect(m.none.textContent).toBe("the package search did not answer: HTTP 500");
    expect(m.said.textContent, "not 'no results'").toBe("the package search did not answer: HTTP 500");
    // It is not asked again by itself; typing again asks again.
    m.tick();
    expect(m.asked.length).toBe(1);
    m.type("ghostt");
    m.tick();
    expect(m.asked.length).toBe(2);
    expect(m.none.hidden).toBe(true);
    // With an action on the line, the failure is said beside the count.
    m.type("status");
    m.tick();
    await m.reply(homeSearch("status"), { error: "internal error" }, 500);
    expect(m.rows().map((r) => r.label)).toEqual(["Status"]);
    expect(m.said.textContent).toBe("the package search did not answer: HTTP 500; 1 result");
    // A lookup that did not answer: no Request over a name the menu could not place.
    m.type("zzfoo");
    m.tick();
    await m.reply(homeSearch("zzfoo"), { packages: [] });
    await m.reply(REGISTRY, { packages: [] });
    await m.reply(lookup("zzfoo", REPO_ARCHES[0]), { error: "internal error" }, 503);
    expect(m.rows()).toEqual([]);
    expect(m.none.textContent).toBe("the package search did not answer: HTTP 503");
    expect(m.said.textContent).toBe("the package search did not answer: HTTP 503");
    // Typing it again looks it up again.
    m.type("zzfo");
    m.type("zzfoo");
    m.tick();
    await m.reply(lookup("zzfoo", REPO_ARCHES[0]), { error: "not in any ring" }, 404);
    await m.reply(lookup("zzfoo", REPO_ARCHES[1]), { error: "not in any ring" }, 404);
    expect(m.rows().map((r) => r.label)).toEqual(['Request "zzfoo"']);
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
    // Not a pacman name: no Request, nothing looked up, and nothing to go to.
    expect(m.rows().map((r) => r.label)).toEqual(['<img src=x onerror=alert(1)>']);
    m.type('"><i>');
    m.tick();
    await m.answer(1, { packages: [] });
    expect(m.asked.length).toBe(2);
    expect(m.rows()).toEqual([]);
    expect(m.none.textContent).toBe('nothing matches “"><i>”');
    expect(m.said.textContent).toBe("no results");
  });

  it("leaves Ctrl+K to a Mac's text field, where it deletes to the end of the line, and takes ⌘K there", () => {
    const m = mount({ mac: true });
    const field = { tagName: "INPUT", name: "field", focus() { m.doc.activeElement = this; } };
    m.doc.activeElement = field;
    expect(m.press("k", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(m.menu.open).toBe(false);
    expect(m.press("k", { metaKey: true }).defaultPrevented).toBe(true);
    expect(m.menu.open).toBe(true);
    // In the menu's own line too; ⌘K closes it.
    expect(m.keyOnLine("k", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(m.menu.open).toBe(true);
    m.keyOnLine("k", { metaKey: true });
    expect(m.menu.open).toBe(false);
    // Nowhere to type, Ctrl+K is the menu's on a Mac as well; and anywhere at all elsewhere.
    m.doc.activeElement = m.doc.body;
    expect(m.press("k", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(m.menu.open).toBe(true);
    const pc = mount();
    pc.doc.activeElement = field;
    expect(pc.press("k", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(pc.menu.open).toBe(true);
  });

  it("leaves a browser without <dialog> as served: no menu, no key taken, the closed dialog hidden by the CSS", async () => {
    const m = mount({ noDialog: true });
    expect(m.window.opPalette).toBeUndefined();
    expect(m.doc.on.keydown ?? []).toEqual([]);
    // Such a browser has no rule of its own for a closed <dialog>: the frame's CSS hides it, so neither the line nor the keys are drawn after the footer.
    const css = /<style>([\s\S]*?)<\/style>/.exec(await (await get("/status")).text())![1];
    expect(css).toContain("dialog.go-menu:not([open]) { display: none; }");
    // On a touch screen the line is 16px, so a phone's browser does not zoom the page into it each time the menu opens.
    expect(css).toMatch(/@media \(hover: none\) and \(pointer: coarse\) \{[^}]*\}[^}]*\.go-box input \{ font-size: 16px; \}/);
  });
});
