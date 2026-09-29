/**
 * Documentation, the index (#250): how the pool works on one page, seven
 * short sections — Set up, Rings, How a package gets in, Factory, Review,
 * Status and journal, API — each a card with a line or two, and the
 * chapters that say more linked from it, so a rule is explained once and
 * the long text is one click further. A sticky map beside the cards lights
 * the section the reader is in. The search over every chapter, section
 * and glossary term (layout.ts DOCS_SEARCH) is the page's too: its answer
 * takes the place of the sections while there is a word in the box. The
 * chapters keep the shell (layout.ts docsShell), the map of every chapter
 * beside their text; this page is the one without it.
 *
 * What the sections say comes from where the app keeps it: the rings'
 * words from RING_TEXT, the upstreams from UPSTREAMS, the chapters' names
 * from the map (DOCS_TREE) and the API's table from the reference's own
 * rows (api-docs.ts API_BRIEF).
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import { DOCS_TREE, MD_CHAPTERS, chapterOf, type DocKey, type MdChapter } from "./docs-tree";
import { lucide, type LucideName } from "./kit";
import { API_BRIEF } from "./api-docs";
import { escapeHtml } from "../html";
import type { RunningVersion } from "../meta";
import { DASHBOARD_HOST, PROMOTED_RINGS, REPO_URL, RING_TEXT, UPSTREAMS } from "../meta";

/** A link to a chapter of the map, or to one of its sections, named as the map names it unless told. */
interface More {
  href: string;
  label: string;
}
function chapter(key: DocKey, section?: string, label?: string): More {
  const c = chapterOf(key)!;
  const s = section ? c.secs.find((x) => x.id === section) : undefined;
  if (section && !s) throw new Error(`docs: ${key} has no section ${section}`);
  return { href: s ? `${c.href}#${s.id}` : c.href, label: label ?? s?.title ?? c.label };
}

/** A cell of a section's grid: an icon in its colour (a ring's own hue, else green), a name, a line. */
interface Item {
  icon: LucideName;
  name: string;
  line: string;
  ring?: string;
}

/** One of the seven sections: its anchor on this page, its icon, its title, what it says, what it shows under that, and the chapters that say more. */
export interface IndexSection {
  id: string;
  icon: LucideName;
  title: string;
  text: string;
  code?: string;
  items?: Item[];
  api?: true;
  more: More[];
}

/** The ring icons, as the prototype draws them: a commit for edge, a flask for rc, a shield for stable. */
const RING_ICON: Record<string, LucideName> = { edge: "git-commit-horizontal", rc: "flask-conical", stable: "shield-check" };

/** How many projects the pool syncs from: every upstream but the factory (meta.ts UPSTREAMS). */
const SYNCED = Object.keys(UPSTREAMS).filter((u) => u !== "the factory").length;

/**
 * The one command, as Home and Get started write it, for the dashboard's
 * name: the page's script puts the address it is served from in its place
 * (#guide-origin), so a local or a staging copy names itself, as those pages do.
 */
const SETUP = `<span class="op-prompt">$ </span>curl -fsSL <span id="guide-origin">https://${DASHBOARD_HOST}</span>/setup | sudo bash -s -- --ring stable
<span class="op-prompt">$ </span>sudo pacman -S ghostty`;

export const DOC_SECTIONS: IndexSection[] = [
  {
    id: "setup",
    icon: "terminal",
    title: "Set up",
    text: "One command points pacman at a ring. After that, install and update with pacman as usual.",
    code: SETUP,
    more: [chapter("get-started")],
  },
  {
    id: "rings",
    icon: "layers",
    title: "Rings",
    text: "Three rings, one hue each. A release moves up only on green health checks, and a ring rolls back by itself on a red one.",
    items: PROMOTED_RINGS.map((r) => ({ icon: RING_ICON[r], name: r, line: RING_TEXT[r].lag, ring: r })),
    more: [chapter("get-started", "which-ring"), chapter("glossary")],
  },
  {
    id: "gates",
    icon: "badge-check",
    title: "How a package gets in",
    text: "Every package, synced or built here, passes the same gates before it enters a ring.",
    items: [
      { icon: "refresh-cw", name: "Synced or requested", line: `${SYNCED} upstreams or the factory` },
      { icon: "key-round", name: "Signed", line: "against each project's own key" },
      { icon: "package-check", name: "Installs", line: "real pacman, every architecture" },
      { icon: "binary", name: "ABI", line: "symbol versions satisfied" },
      { icon: "heart-pulse", name: "Healthy", line: "green checks before each ring" },
      { icon: "users", name: "Reviewed", line: "factory packages: two people" },
    ],
    more: [chapter("how-it-works"), chapter("what-we-test")],
  },
  {
    id: "factory",
    icon: "factory",
    title: "Factory",
    text: "Send the project's address, a name, its licence and the architectures. The name is reserved. The pool checks the request, then a worker's agent writes the PKGBUILD and fixes it from the log until it builds on each architecture. One that keeps failing stops there, with the reason.",
    more: [chapter("factory"), chapter("workers")],
  },
  {
    id: "review",
    icon: "user-check",
    title: "Review",
    text: "A maintainer who did not request the package reads what the factory did and has it built again from scratch on a review worker. That build is the one that ships, once a maintainer approves it. Any maintainer can block a package later.",
    more: [chapter("governance")],
  },
  {
    id: "journal",
    icon: "activity",
    title: "Status and journal",
    text: "Syncs, releases, health checks, rollbacks and every decision are public, with who made each one.",
    more: [{ href: "/status", label: "Status" }, chapter("security")],
  },
  {
    id: "api",
    icon: "braces",
    title: "API",
    text: "Read-only JSON, the same data the site shows. No key needed.",
    api: true,
    more: [chapter("api", undefined, "Every endpoint, with examples"), chapter("omarchy-cli-mcp")],
  },
];

/** The map beside the cards: one link per section, its icon first. The script lights the one the reader is in. */
const NAV = `<nav class="guide-nav" aria-label="Sections">${DOC_SECTIONS.map((s) => `<a href="#${s.id}">${lucide(s.icon)}${escapeHtml(s.title)}</a>`).join("")}</nav>`;

/** The API section's table: the reference's short list, a path under /api/v1 per row. */
const API_TABLE = `<div class="guide-api"><table class="op-table"><thead><tr><th>Method</th><th>Path</th><th>Returns</th></tr></thead><tbody>${API_BRIEF.map(([route, returns]) => {
  const [method, path] = route.split(" ");
  return `<tr><td>${method}</td><td><code>/api/v1${escapeHtml(path)}</code></td><td>${escapeHtml(returns)}</td></tr>`;
}).join("")}</tbody></table></div>`;

const item = (i: Item) => `<div${i.ring ? ` class="${i.ring}"` : ""}><b>${lucide(i.icon)}${escapeHtml(i.name)}</b><span>${escapeHtml(i.line)}</span></div>`;

const card = (s: IndexSection) => `<section class="op-card guide-sec" id="${s.id}" aria-labelledby="${s.id}-h">
      <h2 id="${s.id}-h"><span class="op-box ok">${lucide(s.icon, 15)}</span>${escapeHtml(s.title)}</h2>
      <p>${escapeHtml(s.text)}</p>${s.code ? `
      <div class="op-code guide-well"><code>${s.code}</code><button type="button" class="op-copy" data-op-copy>copy</button></div>` : ""}${s.items ? `
      <div class="guide-items">${s.items.map(item).join("")}</div>` : ""}${s.api ? `
      ${API_TABLE}` : ""}
      <p class="guide-more">${s.more.map((m) => `<a href="${m.href}">${escapeHtml(m.label)} →</a>`).join("")}</p>
    </section>`;

/** The chapters for people working on the pool's code, one line under the sections: the map's second half, in its order. */
const CODE = DOCS_TREE.filter((c) => c.group === "code");

const BODY = `<div class="guide">
  <div class="guide-head">
    <div><p class="op-eyebrow">Docs</p><h1 class="op-hero">How the pool works</h1></div>
    <label class="guide-search">${lucide("search", 16)}<input type="search" id="docs-q" placeholder="search the docs…" aria-label="search the docs" autocomplete="off"></label>
  </div>
  <div class="docs-hits" id="docs-hits" hidden></div>
  <div class="guide-body" id="docs-nav">
    ${NAV}
    <div class="guide-secs">
    ${DOC_SECTIONS.map(card).join("\n    ")}
    <p class="guide-code"><span class="op-label">For people working on the pool</span>${CODE.map((c) => `<a href="${c.href}">${escapeHtml(c.label)}</a>`).join("")}</p>
    </div>
  </div>
</div>`;

/**
 * The page's own script: the setup command names the address the page is
 * served from, and the map lights the section the reader is in — the last
 * one whose top has passed a third of the window, or the last of all once
 * the page is scrolled to its end, where the short last cards can never
 * reach that line. A section chosen in the map (or named by the address's
 * fragment, /docs#api) stays lit while the page moves to it, until the
 * reader scrolls on their own: at the page's end the last card would
 * otherwise take the light from the one that was asked for. With no
 * addEventListener on window (an old browser, the tests' own document)
 * nothing is lit, and the map is plain links.
 */
const SCRIPT = String.raw`
  var origin = $("#guide-origin"); if (origin) origin.textContent = location.origin;
  (function () {
    var nav = $(".guide-nav"); if (!nav || !window.addEventListener || !nav.querySelectorAll) return;
    var links = [].slice.call(nav.querySelectorAll('a[href^="#"]')), secs = links.map(function (a) { return document.getElementById(a.getAttribute("href").slice(1)); });
    var asked = null, queued = false;
    function light(id) { links.forEach(function (a) { if (a.getAttribute("href") === "#" + id) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current"); }); }
    function spy() {
      queued = false;
      if (asked) { light(asked); return; }
      var cur = secs[0], line = innerHeight / 3, root = document.documentElement;
      secs.forEach(function (s) { if (s && s.getBoundingClientRect().top <= line) cur = s; });
      if (innerHeight + scrollY >= root.scrollHeight - 2) cur = secs[secs.length - 1];
      if (cur) light(cur.id);
    }
    function later() { if (!queued) { queued = true; requestAnimationFrame(spy); } }
    function own() { if (asked) { asked = null; later(); } }
    function choose(id) { if (secs.some(function (s) { return s && s.id === id; })) { asked = id; light(id); } }
    nav.addEventListener("click", function (e) { var a = e.target.closest ? e.target.closest("a") : null; if (a) choose(a.getAttribute("href").slice(1)); });
    window.addEventListener("hashchange", function () { choose(location.hash.slice(1)); });
    ["wheel", "touchmove", "keydown"].forEach(function (t) { window.addEventListener(t, own, { passive: true }); });
    window.addEventListener("scroll", later, { passive: true });
    window.addEventListener("resize", later);
    if (location.hash) choose(location.hash.slice(1));
    spy();
  })();
`;

export function docsHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/docs",
    title: "Documentation · omarchy-pool",
    description: "How the pool works: set up, the rings, how a package gets in, the factory, review, status and the API.",
    active: "docs",
    doc: "index",
    kit: true,
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}

/**
 * What a chapter must carry beyond its title, its sections and its body: the
 * anchors other pages link to (a reworded heading breaks them without a
 * sound), the links written for the repository resolved to a chapter, a
 * dashboard page or the code on GitHub (doc.ts resolveLink), and the table
 * or the code block that is the chapter's substance.
 */
const CHAPTER_ANCHORS: Partial<Record<DocKey, string[]>> = {
  "omarchy-cli-mcp": ["<th>Tool</th><th>Arguments</th><th>Answers</th>", '<pre><code class="lang-json">', `href="${REPO_URL}/blob/main/docs/omarchy-cli.config.toml"`],
  // The score and who does what: /build and /packages link here.
  "what-we-test": ['id="the-score"', 'id="who-does-what"', "<th>The contributor's half</th><th>points</th><th>The maintainer's half</th><th>points</th>"],
  architecture: ['href="/docs/proof-of-concept#results"', 'href="/docs/omarchy-cli-mcp"', `href="${REPO_URL}/blob/main/docs/omarchy-cli.config.toml"`, "<th>Route</th><th>Purpose</th>", '<figure class="diagram">'],
  // Releasing the pool itself: Contributing and Testing link here.
  runbook: ['id="releasing-the-pool-itself"', 'href="/docs/architecture"', 'href="/docs/worker-host"', "<th>Service</th><th>Registration</th><th>Takes</th>", '<pre><code class="lang-bash">'],
  testing: ['href="/docs/runbook#releasing-the-pool-itself"', 'href="/docs/proof-of-concept#results"', "<th>File</th><th>What is covered</th>", '<pre><code class="lang-bash">'],
  migration: ['href="/docs/factory"', "<th>Placeholder</th><th>Meaning</th><th>Today</th>", '<pre><code class="lang-bash">'],
  // The Review link is written as a path climbed out of factory/: the dashboard's own page.
  factory: ['href="/review"', 'href="/docs/migration"', "<th>Check</th><th>What it asks</th><th>fail when</th>", '<pre><code class="lang-bash">', '<figure class="diagram">'],
  "worker-host": ['href="/docs/factory"', 'href="/docs/runbook"', "<th>File</th><th>What</th>", '<pre><code class="lang-bash">'],
  "security-model": ["<th>Credential</th><th>Held by</th><th>Can do</th><th>Cannot do</th><th>Status</th>", "<th>Who</th><th>Gets</th><th>How</th>"],
  contributing: ['href="/docs/runbook#releasing-the-pool-itself"', 'href="/docs/governance"', 'href="/docs/testing"', "<th>Change</th><th>Label on the pull request</th><th>Example</th>", '<pre><code class="lang-bash">'],
  // Results: poc/RESULTS.md became this section (doc.ts FILES); the crates are the code on GitHub.
  "proof-of-concept": ['id="results"', 'href="/docs/proof-of-concept#results"', `href="${REPO_URL}/tree/main/poc/crates/pkg-store"`, 'href="/docs/testing"', "<th>Command</th><th>Result</th>", '<figure class="diagram">'],
  // Findings to report upstream: docs/upstream/README.md became this section.
  "open-work": ['id="findings-to-report-upstream"', 'href="/docs/open-work#findings-to-report-upstream"', 'href="/docs/contributing"', 'href="/docs/proof-of-concept#results"'],
};

/** The figures the chapters draw (doc-diagrams.ts): each by the words its svg is labelled with, and its key in DOC_DIAGRAMS. */
const FIGURES: [key: string, chapter: DocKey, label: string][] = [
  ["publishing-layer", "architecture", "Six sources — Arch Linux"],
  ["release-promotion", "architecture", "A package published to the pool"],
  ["promotion-gates", "architecture", "The promote job"],
  ["release-pipeline", "architecture", "A pull request that ci.yml and e2e.yml passed"],
  ["thin-client-install", "architecture", "A request — omarchy-cli install, or check"],
  ["transaction-lifecycle", "proof-of-concept", "pkg-store's transaction in six stages"],
  ["benchmark-promotion", "proof-of-concept", "A bar chart on a log scale"],
  ["factory-loop", "factory", "What starts a build"],
];

/**
 * What /docs and the markdown chapters are made of. The index and every
 * chapter are rendered on the server, the same bytes for every role, so
 * most entries are anchors — the index's title, its search, its map and
 * its seven cards, and per chapter its title, its sections, what other
 * pages link to, the links it resolves and the figures it draws. The one
 * table of claims, the API section's, reads every route it lists on the
 * fixture for the fields its line promises, as the reference's own tables
 * do (api-docs.ts).
 */
export const DOCS_COMPONENTS = (F: Fixture): Component[] => {
  const chapterEntry = (c: MdChapter): Component => ({
    id: `doc.${c.key}`,
    page: `/docs/${c.key}`,
    anchor: [
      `<title>${c.label} · Documentation · omarchy-pool</title>`,
      `<details open><summary><a href="/docs/${c.key}" class="on">${c.label}</a>`,
      `<h1>${c.label}</h1>`,
      '<div class="md">',
      // Every section the map names, as the rendering draws it: a heading with its own anchor.
      ...chapterOf(c.key)!.secs.map((s) => `<h2 id="${s.id}"><a class="anchor" href="#${s.id}">`),
      ...(CHAPTER_ANCHORS[c.key] ?? []),
    ],
    visible: EVERYONE,
  });
  const stable = `ring=stable&arch=${F.arch}`;
  const section = (s: IndexSection): Component => ({
    id: `docs.${s.id}`,
    page: "/docs",
    // The card with its anchor and its title, and every chapter it says more in.
    anchor: [`<section class="op-card guide-sec" id="${s.id}" aria-labelledby="${s.id}-h">`, `<h2 id="${s.id}-h">`, ...s.more.map((m) => `<a href="${m.href}">${escapeHtml(m.label)} →</a>`)],
    visible: EVERYONE,
  });
  return [
    {
      id: "docs.hero",
      page: "/docs",
      anchor: ['<p class="op-eyebrow">Docs</p>', '<h1 class="op-hero">How the pool works</h1>'],
      visible: EVERYONE,
    },
    {
      id: "docs.search",
      page: "/docs",
      // The search over every chapter, section and glossary term (layout.ts DOCS_SEARCH): its answer takes the place of the map and the cards (#docs-nav) while there is a word in the box.
      anchor: ['<input type="search" id="docs-q"', 'aria-label="search the docs"', '<div class="docs-hits" id="docs-hits" hidden></div>', '<div class="guide-body" id="docs-nav">'],
      script: ['var q = $("#docs-q"), hits = $("#docs-hits"), nav = $("#docs-nav")', 'var TREE = [{"label":"', '"/docs/glossary#" + g[2]', "nothing in the docs says", 'e.key === "Escape"'],
      visible: EVERYONE,
    },
    {
      id: "docs.map",
      page: "/docs",
      // The sticky map: a link per section, in the cards' order; the script lights the one the reader is in.
      anchor: ['<nav class="guide-nav" aria-label="Sections">', ...DOC_SECTIONS.map((s) => `<a href="#${s.id}">`)],
      script: ['$(".guide-nav")', 'a.setAttribute("aria-current", "true")', "innerHeight / 3", 'window.addEventListener("scroll", later, { passive: true })', 'window.addEventListener("hashchange"'],
      visible: EVERYONE,
    },
    ...DOC_SECTIONS.map(section),
    {
      id: "docs.setup-command",
      page: "/docs",
      // The one command in the kit's code well, its copy button the kit's, the address the page is served from put in by its script.
      anchor: ['<div class="op-code guide-well"><code><span class="op-prompt">$ </span>curl -fsSL <span id="guide-origin">', "/setup | sudo bash -s -- --ring stable", '<button type="button" class="op-copy" data-op-copy>copy</button>'],
      script: ['$("#guide-origin")', "origin.textContent = location.origin"],
      reads: [{ path: "/setup", json: false }],
      visible: EVERYONE,
    },
    {
      id: "docs.api-table",
      page: "/docs",
      // Every row of the reference's short list as the table draws it, and each route answering, on the fixture, what its row says it returns.
      anchor: ['<div class="guide-api"><table class="op-table"><thead><tr><th>Method</th><th>Path</th><th>Returns</th></tr></thead>', ...API_BRIEF.map(([route]) => `<td>GET</td><td><code>/api/v1${escapeHtml(route.split(" ")[1])}</code></td>`)],
      reads: [
        { path: `/api/v1/package/${F.pkg}?${stable}`, fields: ["rings", "package.version", "depends", "security.advisories"] },
        { path: `/api/v1/search?q=${F.pkg}&${stable}&limit=10`, fields: ["packages.0.name", "packages.0.description"] },
        { path: `/api/v1/releases/stable?fields=summary&arch=${F.arch}`, fields: ["release.id", "packages.0.name", "packages.0.version"] },
        { path: `/api/v1/packages/${F.sha}/provenance`, fields: ["origin", "seal", "upstream.keyring", "signature"] },
        { path: `/api/v1/security?${stable}`, fields: ["vulnerable.0.name", "vulnerable.0.advisories.0.cves"] },
        { path: "/api/v1/events?limit=5", fields: ["events.0.kind", "events.0.created_at"] },
        { path: "/api/v1/factory/packages", fields: ["packages.0.name", "packages.0.status"] },
        { path: "/api/v1/factory/review", fields: ["staged", "waiting"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "docs.code-chapters",
      page: "/docs",
      // The map's second half, one line under the cards: every chapter for people working on the pool's code.
      anchor: ['<p class="guide-code"><span class="op-label">For people working on the pool</span>', ...CODE.map((c) => `<a href="${c.href}">${escapeHtml(c.label)}</a>`)],
      visible: EVERYONE,
    },
    {
      id: "docs.routes",
      page: "/docs",
      // The addresses: the index with or without its slash, /docs/api, which is the API section (index.ts MOVED), and the three old ones that redirect into the docs.
      anchor: ['id="api"', 'href="/docs/get-started"', 'href="/docs/how-it-works"', 'href="/docs/governance"'],
      reads: [
        { path: "/docs/", json: false },
        { path: "/docs/api", status: 301, json: false },
        { path: "/get-started", status: 301, json: false },
        { path: "/how-it-works", status: 301, json: false },
        { path: "/governance", status: 301, json: false },
      ],
      visible: EVERYONE,
    },
    ...MD_CHAPTERS.map(chapterEntry),
    ...FIGURES.map(([key, page, label]): Component => ({
      id: `fig.${key}`,
      page: `/docs/${page}`,
      anchor: [`role="img" aria-label="${label}`],
      drawn: `docs/${key}`,
      visible: EVERYONE,
    })),
  ];
};
