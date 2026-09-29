/**
 * The dashboard's pages, served by the Worker's own fetch handler: every
 * door and every detail page answers, carries the shared frame (the three
 * doors in the navigation, the footer with the docs and the licence), uses
 * no name its script does not declare, and leaves no template placeholder
 * behind; the docs pages carry the same shell, and the diagrams draw no two
 * boxes over each other. What each page is made of is its manifest
 * (src/pages/components.ts), checked by components.test.ts.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { MOVED } from "../src/index";
import { allComponents } from "../src/pages/components";
import { GO_MENU, HELPERS, MORE, NAV, termId } from "../src/pages/layout";
import { DOCS_TREE, GLOSSARY } from "../src/pages/docs-tree";
import { CHARTS } from "../src/pages/charts";
import { KIT_HELPERS } from "../src/pages/kit";
import { JOURNAL_KINDS } from "../src/meta";
import { fetchPage, ownScriptOf, runScript, scriptOf, seedDashboard, type Fixture } from "./fixture";
// The router's own source, as text (Vite's ?raw): the routed pages are read from it, so a page added to index.ts without a way in fails here by name.
import routerSource from "../src/index.ts?raw";

// The Worker's handler, as the page tests ask it (the fixture's fetchPage); raw() asks it by method.
async function get(path: string, cookie?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await fetchPage(new Request(`http://pool.test${path}`, cookie ? { headers: { cookie: `omc=${cookie}` } } : undefined), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
async function raw(path: string, method = "GET"): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`, { method }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// The page's own script (the fixture's ownScriptOf), the shell proved spliced whole.
function ownScript(html: string): string {
  const own = ownScriptOf(html);
  expect(own, "the shell is spliced whole").not.toBeNull();
  return own!;
}

// The pages are served over the fixture's data (test/fixture.ts): the package, the build and the person exist. PAGES are what the router serves, and every rule over a page's HTML and script reads them all.
let F: Fixture;
let PAGES: string[];
beforeAll(async () => {
  F = await seedDashboard(env);
  PAGES = ["/", "/factory", "/review", "/docs", "/docs/get-started", "/docs/workers", "/docs/how-it-works", "/docs/what-we-test", "/docs/governance", "/docs/security", "/docs/glossary", "/docs/architecture", "/docs/runbook", "/docs/testing", "/docs/migration", "/docs/factory", "/docs/worker-host", "/docs/security-model", "/docs/contributing", "/docs/proof-of-concept", "/docs/open-work", "/docs/omarchy-cli-mcp", "/packages", `/package/${F.pkg}`, `/build/${F.projectTask}`, "/status", "/workers", "/request", `/user/${F.owner}`, "/people", "/api", "/diff"];
});

describe("dashboard pages", () => {
  it("every page is served with the shared frame and no placeholder left behind", async () => {
    for (const path of PAGES) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain("omarchy-pool");
      // The three doors in the header (#240), then Go… — a link to the packages, with no key to name until the ⌘K menu makes it its button — and the account; the Pipeline is no door since it became a section of Status.
      const header = /<header>[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
      expect([...header.matchAll(/<nav aria-label="Main">[\s\S]*?<\/nav>/g)].map((m) => [...m[0].matchAll(/href="([^"]*)"/g)].map((h) => h[1])), `${path} doors`).toEqual([["/", "/factory", "/review"]]);
      expect(header, `${path} go`).toContain('<a class="go" id="go" href="/packages" title="find a package">Go…</a>');
      expect(header, `${path} go`).not.toContain("<kbd>");
      // A door's role follows its name after a real space, so a screen reader names the link "Pool use", not "Pooluse"; the lit door is the page for a screen reader too, and no other door is.
      for (const n of NAV) expect(header, `${path} ${n.label}`).toContain(`>${n.label}<small> ${n.sub}</small></a>`);
      expect((header.match(/class="active"/g) ?? []).length, `${path} one door lit, and it is the current page`).toBe((header.match(/ class="active" aria-current="page">/g) ?? []).length);
      expect((header.match(/aria-current="page"/g) ?? []).length, `${path} doors`).toBeLessThanOrEqual(1);
      expect(header, `${path} header`).not.toMatch(/href="\/(docs|pipeline)"|id="status"/);
      // The footer's five and the licence; every other page — the workers, the request, the API reference — is one hop from these or from a door (the walk below), and the addresses that redirect are linked from no frame.
      const footer = /<footer>[\s\S]*?<\/footer>/.exec(html)?.[0] ?? "";
      expect(footer, `${path} footer`).toMatch(/href="\/packages"[\s\S]*href="\/status"[\s\S]*href="\/agents" class="accent"[\s\S]*href="\/docs"[\s\S]*href="\/people"[\s\S]*github\.com\/firemanxbr\/omarchy-pool"[\s\S]*blob\/main\/LICENSE/);
      for (const m of MORE) expect(footer, `${path} footer lacks ${m.label}`).toContain(`href="${m.href}"`);
      expect(footer, `${path} footer`).not.toMatch(/href="\/(security|journal|pipeline|workers|request|api)"/);
      // The header's Sign in comes back to the page it was pressed on.
      expect(html, `${path} sign-in return`).toContain(`id="account" href="/auth/github?next=${path}"`);
      expect(html, path).toContain("built for Omarchy");
      expect(html, path).not.toMatch(/__[A-Z_]+__/);
      expect(html, path).not.toContain("${");
      // No id served twice: a script draws into $("#id"), and the first element of that name is the one it finds — a section and its row sharing one id had the picker replace the section, heading and text gone, and the next $() null (the Security chapter, v0.0.183).
      // A figure's SVG is read out: two diagrams on one page carry the same marker defs, identical, and a url(#arw) resolves to the first.
      const served = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "");
      const ids = [...served.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
      expect([...new Set(twice)], `${path} serves an id twice`).toEqual([]);
    }
    // The door a page lights (#240): a package and the packages list are the Pool's, the request and the workers the Factory's, a build Review's; a page the footer names (Status, People) and the docs light none.
    const LIT: [string, string | null][] = [["/", "/"], ["/packages", "/"], [`/package/${F.pkg}`, "/"], ["/factory", "/factory"], ["/request", "/factory"], ["/workers", "/factory"], ["/review", "/review"], [`/build/${F.projectTask}`, "/review"], ["/status", null], ["/people", null], ["/docs", null], ["/diff", null]];
    for (const [path, door] of LIT) {
      const header = /<header>[\s\S]*?<\/header>/.exec(await (await get(path)).text())?.[0] ?? "";
      expect([...header.matchAll(/<a href="([^"]*)" class="active" aria-current="page">/g)].map((m) => m[1]), path).toEqual(door ? [door] : []);
    }
  });

  // The pages nothing linked: /me is the reader's own page — a session decides where, the sign-in comes back to it without one; the two old addresses of a door are one redirect each, so a bookmark lands and no page has two addresses. The sign-in return is a same-origin path or the Factory: a second slash or a backslash after the first would name another host in the Location header.
  it("routes /me to the reader's own page or the sign-in, and the old addresses to their page", async () => {
    let res = await get("/me");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/github?next=/me");
    expect(res.headers.get("cache-control")).toBe("no-store");
    res = await get("/me", F.sessions.owner);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/user/${F.owner}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    res = await get("/me", F.sessions.maintainer);
    expect(res.headers.get("location")).toBe(`/user/${F.m2}`);
    // A HEAD — a link checker's — is answered as a GET is, not by whatever follows.
    const ctx = createExecutionContext();
    res = await worker.fetch(new Request("http://pool.test/me", { method: "HEAD" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(302);
    for (const [from, to] of [["/contribute", "/factory"], ["/index.html", "/"]]) {
      res = await get(from);
      expect(res.status, from).toBe(301);
      expect(res.headers.get("location"), from).toBe(`http://pool.test${to}`);
    }
    expect((await get("/factory")).status).toBe(200);
    // The sign-in start keeps `next` for the callback in its state cookie: a page's path stays, its query too (a renewal's name); another host does not, nor a control character — a newline in the Location would make the callback throw after the session was replaced.
    for (const [next, kept] of [["/workers", "/workers"], [`/build/${F.projectTask}`, `/build/${F.projectTask}`], ["/request?renew=zlib", "/request?renew=zlib"], ["//evil.example", "/factory"], ["/\\evil.example", "/factory"], ["https://evil.example/", "/factory"], ["/\nevil", "/factory"], ["/x\u0000y", "/factory"]]) {
      res = await get(`/auth/github?next=${encodeURIComponent(next)}`);
      expect(res.status, next).toBe(302);
      expect(res.headers.get("set-cookie"), next).toContain(`:${encodeURIComponent(kept)};`);
    }
  });

  // The addresses #240 took out of the header and the footer are one redirect each, to the section they became (index.ts MOVED): a 301 with the section as the fragment and the query kept — a bookmark lands, a filtered journal stays filtered, a ring's advisories stay that ring's. A HEAD — a link checker's — is answered as a GET is.
  it("redirects the Pipeline, the Journal, Security and /docs/api to the section each became, and the footer's Agents to the agents chapter until its page lands", async () => {
    let res: Response;
    expect(MOVED).toEqual({ "/pipeline": "/status", "/journal": "/status#journal", "/security": "/status#advisories", "/docs/api": "/docs#api" });
    for (const [from, to] of [
      ...Object.entries(MOVED),
      ["/journal?kind=role", "/status?kind=role#journal"],
      ["/security?ring=rc&arch=aarch64", "/status?ring=rc&arch=aarch64#advisories"],
      ["/pipeline?since=1", "/status?since=1"],
      ["/docs/api?x=1", "/docs?x=1#api"],
    ]) {
      for (const method of ["GET", "HEAD"]) {
        res = await raw(from, method);
        expect(res.status, `${method} ${from}`).toBe(301);
        expect(res.headers.get("location"), `${method} ${from}`).toBe(`http://pool.test${to}`);
      }
    }
    // Only those addresses: the API's own /security and /events, the API reference at /api and the page a redirect lands on answer as they did.
    for (const path of ["/api/v1/security?ring=stable&arch=x86_64", "/api/v1/events?limit=1", "/api", "/api/", "/status", "/docs"]) expect((await raw(path)).status, path).toBe(200);
    expect((await raw("/journal/x")).status, "a path under a moved address is no address").toBe(404);
    // The footer's Agents is #249's page: until it lands the address is the chapter on connecting an agent today, a 302 no browser keeps — MORE's `until`, the one place the router reads it from, so every footer entry still standing in for its page is answered the same way.
    expect(MORE.filter((m) => m.until).map((m) => [m.href, m.until])).toEqual([["/agents", "/docs/omarchy-cli-mcp"]]);
    for (const m of MORE.filter((e) => e.until)) {
      res = await raw(`${m.href}?from=footer`);
      expect(res.status, m.href).toBe(302);
      expect(res.headers.get("location"), m.href).toBe(`http://pool.test${m.until}?from=footer`);
      expect((await raw(m.until!)).status, m.until).toBe(200);
    }
  });

  // The header's Sign in names the page it is on, a build's page and a package's included — so a maintainer who signs in from a build lands on the build, not on Review. The served href is the path; the shell's script rewrites it to the whole address once the query is known, so /request?renew=zlib signs in and comes back to the renewal. The docs sidebar's hint is written from MORE, so it names every page the footer links and no other.
  it("sends the sign-in back to the page it was pressed on, and the docs hint names the footer's pages", async () => {
    for (const path of ["/workers", `/build/${F.projectTask}`, `/package/${F.pkg}`, `/user/${F.owner}`, "/docs/runbook", "/request", "/review"]) {
      const html = await (await get(path)).text();
      expect(html, path).toContain(`<a id="account" href="/auth/github?next=${path}" title=`);
      expect(html, path).not.toContain("next=/me");
      expect(scriptOf(html), path).toContain('if (location.search) document.querySelectorAll(\'a[href^="/auth/github?next="]\')');
    }
    // The one place `next=/me` stays: the Factory gate's way to the reader's own page, whoever they turn out to be. The two workspace links — the Request's, Review's — are /me itself, one href for everyone.
    const factory = await (await get("/factory")).text();
    expect(factory).toContain('id="gate-btn" href="/auth/github?next=/me"');
    expect(factory).toContain('id="account" href="/auth/github?next=/factory"');
    expect(await (await get("/request")).text()).toContain('<a id="ws" href="/me">Your workspace</a>');
    expect(await (await get("/review")).text()).toContain('id="mine-ws" href="/me"');
    const docs = await (await get("/docs")).text();
    const hint = /<div class="docs-hint">([^<]*)<\/div>/.exec(docs)?.[1] ?? "";
    // A footer entry whose address still stands in for its page (MORE's `until`: Agents, a docs chapter until #249) is not called a page of its own.
    for (const m of MORE) if (m.href !== "/docs") (m.until ? expect(hint, m.label).not : expect(hint, m.label)).toContain(m.label);
    expect(hint).toBe("Packages, Status and People have their own pages, linked from the footer. The three doors are the header.");
    for (const n of NAV) expect(hint, n.label).not.toContain(n.label);
    // The footer marks the entry the reader is on or under: the page's script says so for a chapter, for a package, for the API reference (a chapter of the docs, at an address of its own) and for a diff (Status's, where the journal went).
    expect(docs).toContain('here.indexOf(href + "/") === 0');
    expect(docs).toContain('href === "/packages" && here.indexOf("/package/") === 0');
    expect(docs).toContain('href === "/docs" && here === "/api"');
    expect(docs).toContain('href === "/status" && here === "/diff"');
  });

  // The frame's own statement, run as a browser runs it (it is the one statement page() puts before the shell): Go… stays the served link until the ⌘K menu is on the page (window.opPalette, #241) — looked for once the page's whole script has run, so a menu declared after the frame counts — and then becomes the button that opens it, naming the platform's key for the eye and as aria-keyshortcuts, the key itself hidden from the button's name; and the footer marks the entry the reader is on or under, for a screen reader too.
  it("makes Go… the ⌘K menu's button, key and all, only once there is a menu, and marks the footer's entry for the page", async () => {
    const acorn = await import("acorn");
    const code = scriptOf(await (await get("/")).text());
    const outer = (acorn.parse(code, { ecmaVersion: 2020, sourceType: "script" }) as any).body[0].expression.callee.body.body[0];
    const frame = code.slice(outer.start, outer.end);
    expect(frame).toContain('document.querySelector("header a.go")');
    const run = (opts: { path: string; platform?: string; palette?: "before" | "after" }) => {
      const footer = MORE.map((m) => { const cls: string[] = [], attrs: Record<string, string> = {}; return { href: m.href, cls, attrs, getAttribute: () => m.href, setAttribute: (k: string, v: string) => { attrs[k] = v; }, classList: { add: (c: string) => { cls.push(c); } } }; });
      let replaced: any = null;
      const menu = { opened: 0 };
      const location = { pathname: opts.path, href: `http://pool.test${opts.path}` };
      const link = { tagName: "A", className: "go", id: "go", title: "find a package", textContent: "Go…", href: "http://pool.test/packages", parentNode: { replaceChild(n: unknown) { replaced = n; } } };
      const element = (tag: string) => ({ tag, attrs: {} as Record<string, string>, children: [] as any[], listeners: {} as Record<string, () => void>, setAttribute(k: string, v: string) { this.attrs[k] = v; }, appendChild(c: unknown) { this.children.push(c); }, addEventListener(t: string, f: () => void) { this.listeners[t] = f; } });
      const document = {
        querySelectorAll: (sel: string) => (sel === "footer .more a" ? footer : []),
        querySelector: (sel: string) => (sel === "header a.go" ? link : null),
        createElement: element,
      };
      const window: any = {};
      const palette = { open() { menu.opened++; } };
      if (opts.palette === "before") window.opPalette = palette;
      // The microtask queue (a resolved promise's then), drained when the page's script is done — after a menu declared later in it.
      const later: (() => void)[] = [];
      const Promise = { resolve: () => ({ then: (f: () => void) => { later.push(f); } }) };
      new Function("document", "location", "navigator", "window", "Promise", frame)(document, location, { platform: opts.platform ?? "MacIntel" }, window, Promise);
      expect(replaced, "nothing is replaced before the page's script has run").toBeNull();
      if (opts.palette === "after") window.opPalette = palette;
      later.forEach((f) => f());
      return { replaced, menu, location, marked: footer.filter((a) => a.cls.includes("active")).map((a) => a.href), current: footer.filter((a) => a.attrs["aria-current"] === "page").map((a) => a.href) };
    };
    const none = run({ path: "/" });
    expect(none.replaced, "no menu: Go… stays the link to the packages, and names no key").toBeNull();
    const mac = run({ path: "/", palette: "after" });
    expect(mac.replaced).toMatchObject({ tag: "button", type: "button", className: "go", id: "go", title: "go to a package or a page", textContent: "Go…", attrs: { "aria-keyshortcuts": "Meta+K" } });
    expect(mac.replaced.children).toMatchObject([{ tag: "kbd", textContent: "⌘K", attrs: { "aria-hidden": "true" } }]);
    mac.replaced.listeners.click();
    expect(mac.menu.opened, "the menu opens").toBe(1);
    expect(mac.location.href, "and nothing navigates").toBe("http://pool.test/");
    const linux = run({ path: "/", platform: "Linux x86_64", palette: "before" });
    expect(linux.replaced.attrs["aria-keyshortcuts"]).toBe("Control+K");
    expect(linux.replaced.children).toMatchObject([{ tag: "kbd", textContent: "Ctrl K" }]);
    // The footer's mark: the page itself, a page under it, a package under Packages, the API reference under Docs, a diff under Status; a door's page marks nothing. What is marked for the eye is the current page for a screen reader.
    for (const [path, marked] of [["/status", ["/status"]], ["/docs/runbook", ["/docs"]], ["/api", ["/docs"]], [`/package/${F.pkg}`, ["/packages"]], ["/diff", ["/status"]], ["/people", ["/people"]], ["/factory", []], ["/", []]] as const) {
      const r = run({ path });
      expect(r.marked, path).toEqual(marked);
      expect(r.current, path).toEqual(marked);
    }
  });

  // The app is the truth and the text follows. Three rules over every served page, the markdown chapters included, and the pages' own scripts: (a) a link into the documentation lands — its path is a chapter of DOCS_TREE (or the index) and its fragment one of that chapter's sections, or a glossary term; the four `/docs#chapter/section` links written against the old one-page docs landed at the top of /docs for a day; (b) no page says what the app no longer does — the phrases below each name a page or a flow that moved, with why; (c) a `/journal?kind=<k>` link filters, because k is one of the journal's kinds — `kind=role` fell back to all for a day.
  it("links the documentation where it is, says nothing the app no longer does, and links journal kinds the filter has", async () => {
    const chapters = new Map(DOCS_TREE.map((c) => [c.href, new Set(c.secs.map((sec) => sec.id))]));
    chapters.set("/docs/glossary", new Set(GLOSSARY.map(([term]) => termId(term))));
    const FORBIDDEN: [RegExp, string][] = [
      [/Factory page/, "/factory is the assembly line (#169): workers and agents are on /workers, staged builds on /review, a person's record on /user/<login>, the queue on /pipeline"],
      [/Contributors page|Contributors,? Review/, "there is no Contributors page: the people are on /people, a person's record on /user/<login>, the workers on /workers"],
      [/Trust table/, "there is no trust table: a maintainer trusts a worker through the API, and who did is in the worker id's tooltip on /workers"],
      [/recipe pending|waiting for the recipe/, "the recipe-on-main flow is retired (#182): an approval carries the project's build (rebuild_task), always"],
      [/press (?:<b>)?Build(?:<\/b>)? on your page|picks it up within a minute/, "a request builds by itself in the shared queue, the best idle worker first (#182); the owner's Build is for a worker of their own or a re-run"],
      [/rebuilds what a maintainer approves|[Aa]pprove queues a rebuild/, "approve queues a publish of the project's build; Build by the project is the separate action, and the one that queues a rebuild"],
      [/approve, trust and roll back|approving, trusting and rolling back/, "no page has a trust control: trust is through the API"],
      [/href="\/docs#/, "the docs index has no ids: a chapter's page carries the anchors (DOCS_TREE)"],
      [/under a group in <code>factory\/MAINTAINERS\.toml/, "one list, no groups"],
      [/Journal's\s+(?:<em>)?Ring\s+history|overview's\s+roll\s+back/, "the Journal is a section of Status since #248, and a maintainer rolls a ring back on Status's Releases — a ring's card, its history — or with the rollback job (pkg-repo job rollback, POST /api/v1/factory/jobs)"],
      [/the\s+Pipeline\s+(?:follows|lists)|Pipeline\s+page\s+shows|Pipeline's\s+(?:build\s+tasks|counters)|Security\s+page\s+shows/, "the Pipeline and Security are not served since #240 (their addresses redirect to Status, index.ts MOVED): name Status, a build's page or the API"],
    ];
    const problems: string[] = [];
    for (const path of PAGES) {
      const html = await (await get(path)).text();
      // (a) the served HTML's links, scripts set aside: what a reader can press.
      const body = html.replace(/<script[\s\S]*?<\/script>/g, "");
      for (const m of body.matchAll(/href="(\/docs(?:\/[a-z-]+)?)(?:#([^"]*))?"/g)) {
        const [, chapter, frag] = m;
        if (chapter === "/docs") { if (frag) problems.push(`${path}: href="/docs#${frag}" — the index has no anchors`); continue; }
        const secs = chapters.get(chapter);
        if (!secs) { problems.push(`${path}: href="${chapter}" is no chapter of DOCS_TREE`); continue; }
        if (frag && !secs.has(frag)) problems.push(`${path}: href="${chapter}#${frag}" — no such section (${[...secs].join(", ")})`);
      }
      // (b) the whole page, script included: a pill's word is as much a claim as a paragraph.
      for (const [re, why] of FORBIDDEN) { const hit = re.exec(html); if (hit) problems.push(`${path} says "${hit[0]}" — ${why}`); }
      // (c) every journal link, in HTML or script.
      for (const m of html.matchAll(/\/journal\?kind=([a-z-]+)/g)) if (!JOURNAL_KINDS.includes(m[1])) problems.push(`${path} links /journal?kind=${m[1]}, a kind the journal's filter lacks (${JOURNAL_KINDS.join(", ")})`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
    // The journal is Status's since #248 (/journal?kind=k lands on /status?kind=k#journal): `?kind=` picks one of the journal's kinds — a chip of its own beside All, Syncs, Promotions, Decisions and Blocks — rather than falling back to all; sync is the Syncs chip; a word the journal does not know is All.
    const status = scriptOf(await (await get("/status")).text());
    expect(ownScript(await (await get("/status")).text())).toContain(`var KINDS = ${JSON.stringify(JOURNAL_KINDS)}`);
    const chips = (search: string) => runScript(status, { pathname: "/status", search, functions: ["chipIds"] }).chipIds() as string[];
    const groups = ["all", "syncs", "promotions", "decisions", "blocks"];
    expect(chips("")).toEqual(groups);
    expect(chips("?kind=role")).toEqual([...groups, "role"]);
    expect(chips("?kind=fast-track")).toEqual([...groups, "fast-track"]);
    expect(chips("?kind=sync")).toEqual(groups);
    expect(chips("?kind=promotions")).toEqual(groups);
    expect(chips("?kind=nothing-we-know")).toEqual(groups);
    for (const k of ["role", "withdraw", "review", "request", "audience", "fast-track", "trial", "build", "promote", "rollback", "sync"]) expect(JOURNAL_KINDS, k).toContain(k);
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
    // The shell first, by its own name: page() splices HELPERS whole, so a name it declared twice would fail every page. The ⌘K menu's script (GO_MENU) follows it on every page, one statement that declares nothing outside itself — nor, inside, a name the shell has.
    const helpers = program(HELPERS), charts = program(CHARTS), menu = program(GO_MENU), kit = program(KIT_HELPERS);
    const shellNames = top(declarations(helpers)), chartNames = top(declarations(charts));
    expect(dupes(shellNames), "HELPERS declares a name twice").toEqual([]);
    expect(dupes(chartNames), "CHARTS declares a name twice").toEqual([]);
    expect(shellNames.filter((n) => chartNames.includes(n)), "HELPERS and CHARTS share a name").toEqual([]);
    const shell = new Set(shellNames);
    expect(shell.has("pillHtml") && shell.has("whoami") && shell.has("pick") && chartNames.includes("stacked")).toBe(true);
    expect(menu.length, "GO_MENU is one statement").toBe(1);
    expect(top(declarations(menu)), "GO_MENU declares nothing outside itself").toEqual([]);
    const menuShadows = declarations(menu).filter((d) => shell.has(d.name)).map((d) => d.name);
    expect(menuShadows, `GO_MENU shadows the shell's ${menuShadows.join(", ")}`).toEqual([]);
    // A kit page (page({ kit: true })) has the kit's helpers after the menu (KIT_HELPERS): the frame's too, their names a page may not declare again, and none of them the shell's.
    const kitNames = top(declarations(kit)), kitShadows = declarations(kit).filter((d) => shell.has(d.name)).map((d) => d.name);
    expect(kitShadows, `KIT_HELPERS shadows the shell's ${kitShadows.join(", ")}`).toEqual([]);
    // The primitives a page draws only through CHARTS — a page that does not splice CHARTS and declares one of these has copied it.
    const CHART_ONLY = ["bars", "area", "hbars", "stacked", "lines", "hrows", "heatGrid", "buildsByDay", "jobsSummary", "workerMinutes", "worst", "lastDays"];
    const problems: string[] = [];
    for (const path of PAGES) {
      const code = scriptOf(await (await get(path)).text());
      if (!code.trim()) continue;
      // page() wraps the footer's line, the shell, the ⌘K menu, then the page's script in one function: the page's own statements are what follows the menu's, less CHARTS where the page splices it.
      const iife: N[] | undefined = program(code)[0]?.expression?.callee?.body?.body;
      expect(iife, `${path}: the page's script is not one IIFE`).toBeDefined();
      const cs = code.indexOf(CHARTS), withCharts = cs >= 0;
      const kitted = code.includes(KIT_HELPERS);
      const own = iife!.slice(1 + helpers.length + menu.length + (kitted ? kit.length : 0)).filter((st) => !(withCharts && st.start >= cs && st.end <= cs + CHARTS.length));
      const has = new Set([...shell, ...(withCharts ? chartNames : []), ...(kitted ? kitNames : [])]);
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

  // The dashboard's rule for roles: every role sees every section and every control, the same for all; what a role cannot do is a disabled control with the reason in its title — never hidden, never absent, never a sentence in its place. So the sections that exist for everyone are never served `hidden`; the attribute stays for what does not exist yet (a result line before a POST, a blocked notice for nobody blocked). The list is the sections the redesign names per page — Review's Yours block, a maintainer's queue line, the audit legend, the brake; Status's sections — the releases and their history, the sources, the workers, the checks, the advisories and their list, the journal, the numbers (its roll back is a maintainer's alone, and drawn for a maintainer only: the v1 rule, #238, is that the information is the same for everyone and only the actions change); a build's page (#acts); a person's page (#pk-request, #w-toggle, #w-own); the request's gate and form (#gate, #ask, #pkg-form); the Factory gate with its hint (#gate-hint, once hidden for a session); the People page's three worker tables and their legend.
  it("serves the sections everyone gets without hidden — a role that cannot act sees the control grey, never nothing", async () => {
    const ALWAYS: Record<string, string[]> = {
      "/review": ["mine", "mine-queue", "legend", "brake", "staged"],
      "/status": ["releases", "history", "sources", "workers", "checks", "advisories", "advisory-list", "journal", "numbers"],
      [`/build/${F.projectTask}`]: ["acts"],
      [`/user/${F.owner}`]: ["pk-request", "w-toggle", "w-own", "share-btn"],
      "/request": ["gate", "gate-who", "gate-cta", "gate-btn", "ask", "pkg-form", "pkg-checklist", "pkg-btn", "ws"],
      "/factory": ["gate", "gate-btn", "gate-hint"],
      "/people": ["w-project", "w-review", "w-community", "wt-legend"],
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

  // No hidden pages: every page index.ts serves as HTML is the header's, the footer's, or one hop from a page that is — a link in the served HTML, not in a script. Since #240 the footer names five pages and the rest are that hop: the request from the Factory, the workers from People, the API reference from the docs map, a diff from Status. The routed pages are read from the router's source (a fixed route is `path === "/x"` answered with html(); a page with a parameter — a build, a person, a package — is the fixture's example of it), so a page added without a way in fails here by its address. A page with a parameter is named by a row drawn from data, so its way in is the script of the listing that writes its address — `href="/build/` by hand, or the shell's one renderer of that address called from the page's own script: pkgHref() for a package, personLink() and the avatars for a person; that page must itself be in the frame. The redirect aliases are not pages: asserted apart as 301/302 to a routed page.
  it("reaches every routed page from the header or the footer in at most one hop, and names the shortest way", async () => {
    const fixed = [...routerSource.matchAll(/path === "(\/[^"]*)"[^\n]*return html\(/g)].map((m) => m[1]);
    // The chapters written in markdown are one route (mdChapterAt); the fixture's examples of the parametric pages stand for their kind.
    const families: Record<string, string> = { "/build/": `/build/${F.projectTask}`, "/user/": `/user/${F.owner}`, "/package/": `/package/${F.pkg}` };
    // What writes a family's address in a page's own script: a hand-written href for a build, or the shell's one writer of it — a package's page has one address (pkgHref), a person one (userHref, and the renderers that write it: personLink, personChip, avatar, avatarIcon, and the worker row's owner through wtPerson).
    const writes: Record<string, RegExp> = {
      "/build/": /href=\\?["']\/build\//,
      "/user/": /\b(?:userHref|personLink|personChip|avatar|avatarIcon|wtPerson|workerRow)\(/,
      "/package/": /\bpkgHref\(/,
    };
    const routed = new Set<string>([...fixed, ...PAGES, ...Object.values(families)]);
    for (const p of fixed) expect(PAGES, `${p} is routed but not in PAGES — the served-frame rules would not read it`).toContain(p);
    const route = (href: string): string | null => {
      const path = href.replace(/[?#].*$/, "").replace(/\/$/, "") || "/";
      if (routed.has(path)) return path;
      for (const [prefix, example] of Object.entries(families)) if (path.startsWith(prefix)) return example;
      return null;
    };
    // The frame is the same on every page, so the header's and the footer's links are read once, from the Pool's.
    const home = await (await get("/")).text();
    const frameHtml = (home.match(/<header>[\s\S]*?<\/header>/)?.[0] ?? "") + (home.match(/<footer>[\s\S]*?<\/footer>/)?.[0] ?? "");
    const frame = [...new Set([...frameHtml.matchAll(/href="(\/[^"]*)"/g)].map((m) => route(m[1])).filter((p): p is string => !!p))];
    for (const n of NAV) expect(frame, n.label).toContain(n.href);
    // Every footer entry is a page in the frame, but Agents: its page is #249's, and until it lands /agents redirects to a chapter (an alias, below) — linked from the frame all the same.
    for (const m of MORE) {
      if (m.href === "/agents") expect(frameHtml, m.label).toContain(`href="${m.href}"`);
      else expect(frame, m.label).toContain(m.href);
    }
    // Breadth first from the frame: a page's own links are its body's, header, footer and scripts set aside; the rows a page's own script draws are the way to a page with a parameter — its own script, not the shell's, whose workerRow and avatar write a build's and a person's address on every page.
    const via = new Map<string, string>();
    for (const p of frame) via.set(p, "the frame");
    for (const p of frame) {
      const html = await (await get(p)).text();
      const body = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<header>[\s\S]*?<\/header>/, "").replace(/<footer>[\s\S]*?<\/footer>/, "");
      for (const m of body.matchAll(/(?:data-)?href="(\/[^"\/][^"]*)"/g)) { const to = route(m[1]); if (to && !via.has(to)) via.set(to, p); }
      for (const [prefix, example] of Object.entries(families)) if (!via.has(example) && writes[prefix].test(ownScript(html))) via.set(example, `${p} (a row it draws)`);
    }
    const unreached = [...routed].filter((p) => !via.has(p)).sort();
    expect(unreached, `reached only by address: ${unreached.join(", ")}`).toEqual([]);
    const ways = [...routed].sort().map((p) => `${p} ← ${via.get(p)}${via.get(p) === "the frame" ? "" : " ← the frame"}`);
    console.log(`the way to every page:\n  ${ways.join("\n  ")}`);
    // The pages nothing links, on purpose: an alias is a redirect to a page that is reached, never a page of its own — the old addresses, the pages that became sections (MOVED, #240) and, until #249, the footer's Agents.
    for (const alias of ["/me", "/contribute", "/index.html", "/get-started", "/how-it-works", "/governance", "/agents", ...Object.keys(MOVED)]) {
      const res = await raw(alias);
      expect([301, 302], alias).toContain(res.status);
      const to = new URL(res.headers.get("location") ?? "", "http://pool.test").pathname;
      // /me as nobody is the sign-in, which comes back to it; every other alias lands on a page that is reached.
      if (alias === "/me") expect(to).toBe("/auth/github");
      else expect(route(to), `${alias} → ${to} is not a routed page`).not.toBeNull();
    }
  });

  // The request as nobody: the gate banner with the sign-in live, and the whole form served — every field, every confirmation and the button grey with the sign-in as the reason — so a person who is not in sees what a request asks, and a person who is sees the same page with its fields live.
  it("serves the request to nobody as the gate banner and the form with every control grey", async () => {
    const html = await (await get("/request")).text();
    expect(html).toContain('<div id="gate" class="gate">');
    expect(html).toContain('<a class="btn" id="gate-btn" href="/auth/github?next=/request">');
    expect(html).toContain('<section id="ask">');
    const form = /<form id="pkg-form" class="form" onsubmit="return false">([\s\S]*?)<\/form>/.exec(html)?.[1] ?? "";
    const controls = [...form.matchAll(/<(?:input|button|select|textarea)\b[^>]*>/g)].map((m) => m[0]);
    // Eight fields (two of them for a project not on GitHub), four confirmations, the button.
    expect(controls.length).toBe(13);
    // The reason is the shell's word for nobody — orSignIn's, the server's 401's — not a fourth spelling.
    for (const c of controls) expect(c).toMatch(/ disabled aria-disabled="true" title="sign in with GitHub">$/);
    expect(form).toContain('id="pkg-url"');
    expect(form).toContain('data-check="evidence"');
    expect(form).toContain('<button type="submit" id="pkg-btn" disabled aria-disabled="true" title="sign in with GitHub">Request</button>');
    // Signed in, the page is the same page: the script draws the fields again through the shell's gate(), live for a person; the workspace line is /me for everyone, rewritten for nobody.
    const script = ownScript(html);
    expect(script).toContain('$("#pkg-form").innerHTML = gate(');
    expect(script).toContain('$("#gate-cta").innerHTML = gate(');
    expect(script).not.toContain('$("#ask").hidden');
    expect(script).not.toContain('$("#ws").href');
    expect(html).not.toContain("next=/me");
    expect(html).not.toContain("/factory#gate");
  });

  // A worker's row is the shell's wherever it is drawn. The manifests say which pages draw the worker tables (`shared: "worker-table"`, the legend `"worker-legend"`) — the Workers page, the People page, a person's — and each is proved the same way: the panels served by workerPanels(), the head and the skeleton by wtTables(), every row by workerRow() over wtKind(), the filter by wtText, and no hand-written head, cell or filter left; a page that serves a worker table without claiming the shared name fails here by its address.
  it("draws every worker table the manifests claim with the shell's panels, head and row, and no other page draws one", async () => {
    const claims = allComponents(F).filter((c) => c.shared === "worker-table");
    expect(claims.map((c) => c.page).sort()).toEqual(["/people", `/user/${F.owner}`, "/workers"].sort());
    for (const c of claims) {
      const html = await (await get(c.page)).text(), script = ownScript(html);
      // The served frame: one panel per kind with the shell's table, the legend after them.
      for (const kind of ["project", "review", "community"]) expect(html, `${c.page}: ${kind}`).toContain(`<table id="w-${kind}" class="wtable"><thead><tr></tr></thead><tbody></tbody></table>`);
      expect(html, c.page).toContain('<div id="wt-legend"></div>');
      expect(allComponents(F).some((l) => l.page === c.page && l.shared === "worker-legend"), `${c.page} claims the table and not the legend`).toBe(true);
      // The page's own script: the head through wtTables(), a row through workerRow() by wtKind(), the filter the shell's.
      expect(script, `${c.page} head`).toMatch(/wtTables\((true)?\)/);
      expect(script, `${c.page} row`).toMatch(/workerRow\(w(,|\))/);
      expect(script, `${c.page} kind`).toContain("wtKind(w)");
      expect(script, `${c.page} filter`).toContain("text: wtText");
      for (const hand of ["WT_HEAD", "WT_LEGEND", 'skeletonRows("#w-', 'colspan="9"', "#workers-table", "var text = function", "<th>Worker</th>"]) expect(script, `${c.page} writes ${hand} by hand`).not.toContain(hand);
    }
    // Every page that serves a worker table claims it: a fourth page drawing rows of its own would be caught here.
    for (const path of PAGES) {
      const html = await (await get(path)).text();
      if (/class="wtable"/.test(html)) expect(claims.map((c) => c.page), `${path} serves a worker table and claims no shared component`).toContain(path);
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
    const { ringsDiagram, sourcesDiagram, factoryDiagram } = await import("../src/pages/diagrams");
    const { DOC_DIAGRAMS } = await import("../src/pages/doc-diagrams");
    const draw: Record<string, () => string> = { rings: ringsDiagram, "rings/promote": () => ringsDiagram("promote"), sources: sourcesDiagram, factory: factoryDiagram };
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
