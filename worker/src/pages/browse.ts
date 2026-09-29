/**
 * The packages list (#245, the handoff's "packages" screen): the pool's
 * total in the title, a search, four filters — ring, architecture, origin,
 * and the order — and the list itself, a name per row, each row the
 * package's page. The list is the API's (routes/browse.ts): the server
 * filters and pages it, and draws the first page into the HTML, so every
 * filter is a link, the search a form and the pager two links that work
 * with script off; with script on, a filter, a page or a pause in the
 * typing asks the same address the page was drawn from and draws the
 * answer in place, the address following along. The rows are drawn by
 * listHtml() here and by the script's pkList() in the browser, the same
 * characters — test/browse.test.ts holds the two to each other.
 */
import { page } from "./layout";
import { escapeHtml } from "../html";
import { lucide } from "./kit";
import { EVERYONE, type Component, type Fixture } from "./components";
import { EXPECTED_SOURCES, REPO_ARCHES, type RunningVersion } from "../meta";
import { BROWSE_DEFAULT, BROWSE_LIMIT, BROWSE_MAX, BROWSE_MAX_PAGE, BROWSE_MAX_Q, BROWSE_MIN_Q, BROWSE_NAME, BROWSE_ORIGINS, BROWSE_RINGS, BROWSE_SORTS, browseSearch, type BrowseAnswer, type BrowseQuery, type BrowseStep } from "../routes/browse";

/** Where a package comes from, in the handoff's words, by its source and architecture: EXPECTED_SOURCES' `origin`, as the ⌘K menu says it (layout.ts ORIGINS). A source the list does not know is said by its id. */
const ORIGIN_WORDS: Record<string, string> = Object.fromEntries(EXPECTED_SOURCES.map((e) => [`${e.source}/${e.arch}`, e.origin]));

/**
 * A name a request can carry: the ⌘K menu's characters (routes/browse.ts
 * BROWSE_NAME). Like the menu, the list offers Request "<name>" only for a
 * name the pool has nowhere: a search with a filter offers to clear the
 * filters, and a name the factory or the lab has is shown there — the API
 * looks it up (routes/browse.ts heldElsewhere) where the menu asks the
 * factory's names and the package's own address.
 */
const REQUEST_NAME = BROWSE_NAME;

/** What the page is drawn from: the list asked for, the search as typed (one letter too), and the API's answer — or why there is none. */
export interface BrowseView {
  query: BrowseQuery;
  typed: string;
  answer: BrowseAnswer | null;
  error: string | null;
}

/** The segments, in the handoff's order and words: the value in the address, the word on the button. */
const SEGMENTS: { key: "ring" | "arch" | "origin" | "sort"; label: string; options: [string, string][] }[] = [
  { key: "ring", label: "Ring", options: [["all", "all"], ...BROWSE_RINGS.map((r): [string, string] => [r, r])] },
  { key: "arch", label: "Arch", options: [["all", "both"], ...REPO_ARCHES.map((a): [string, string] => [a, a])] },
  { key: "origin", label: "Origin", options: [["all", "all"], ...BROWSE_ORIGINS.map((o): [string, string] => [o, o])] },
  { key: "sort", label: "Sort", options: BROWSE_SORTS.map((s): [string, string] => [s, s === "name" ? "a–z" : s]) },
];

/**
 * The page's own CSS: the handoff's packages screen on the kit's pieces
 * (op-eyebrow, op-hero, op-seg, op-card, op-arch, op-mark, op-i). The page
 * is the handoff's 1120px, 32px from the sides — the frame's main is wider
 * — and 48px under the header. A row is the handoff's grid of seven; on a
 * phone it folds into three lines — the name and its version, what it
 * does, then where it comes from, its squares, its age and the seal —
 * rather than scroll sideways. Nothing in the top row may widen the page:
 * the column has a floor of zero, the box's input no width of its own (a
 * search input's is about twenty characters — with "type one more letter"
 * beside it, 422px on a 390px phone), and the count gives way last, cut
 * short rather than pushed off the edge; a name of a hundred letters in
 * Request "<name>" breaks where it must. Every colour is a token.
 */
const BROWSE_CSS = `
  .pk { max-width: calc(var(--content-max) - 2 * var(--gutter)); margin: 12px auto 0; padding-bottom: 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 36px; }
  .pk-top { display: grid; gap: 18px; min-width: 0; }
  .pk-title { display: grid; gap: 14px; }
  .pk-search { display: flex; align-items: center; gap: 12px; min-width: 0; height: 50px; padding: 0 16px; background: var(--bg-deep); border: 1px solid var(--line); }
  .pk-search:focus-within { border-color: var(--green); }
  .pk-search .op-i { flex: none; color: var(--green); }
  .pk-search input { flex: 1 1 0; width: 0; min-width: 4.5em; height: 100%; padding: 0; border: 0; border-radius: 0; outline: none; -webkit-appearance: none; appearance: none; background: transparent; color: var(--text); font: 15px var(--font-mono); }
  .pk-search input::placeholder { color: var(--dim); } .pk-search input::-webkit-search-decoration, .pk-search input::-webkit-search-cancel-button { -webkit-appearance: none; }
  .pk-count { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 12px; color: var(--dim); white-space: nowrap; }
  .pk-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .pk-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 22px; }
  .pk-f { display: flex; align-items: center; gap: 10px; }
  .pk-f.pk-sort { margin-left: auto; }
  .pk-f .op-seg > a { padding: 5px 11px; font-size: 12.5px; color: var(--dim); }
  .pk-f .op-seg > a[aria-current="true"] { color: var(--text); }
  .pk-list { min-width: 0; }
  .pk-rows { margin: 0; padding: 0; list-style: none; }
  .pk-head, .pk-row { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(0, 2fr) 130px 150px 40px 60px 24px; gap: 14px; align-items: center; padding: 10px 16px; }
  .pk-head { padding: 8px 16px; background: var(--bg-deep); color: var(--dim); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
  .pk-head span:nth-child(6) { text-align: right; }
  .pk-row { position: relative; border-top: 1px solid var(--line); color: var(--text); font-size: 13px; text-decoration: none; }
  .pk-row:hover { background: var(--panel-2); } .pk-row:focus-visible { outline: 1px solid var(--green); outline-offset: -1px; }
  .pk-n, .pk-d, .pk-v { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pk-n { font-weight: 600; } .pk-d { color: var(--muted); } .pk-v { font-size: 12.5px; }
  .pk-o { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: var(--muted); white-space: nowrap; } .pk-o.f { color: var(--green); }
  .pk-o span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .pk-a { display: flex; gap: 3px; } .pk-a .op-arch { width: 9px; height: 9px; }
  .pk-u { font-size: 12px; color: var(--dim); text-align: right; white-space: nowrap; }
  .pk-s { text-align: right; }
  .pk-none, .pk-foot { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding: 14px 16px; border-top: 1px solid var(--line); }
  .pk-none { font-size: 13.5px; color: var(--muted); } .pk-none a { color: var(--green); text-decoration: none; } .pk-none a:hover { text-decoration: underline; }
  .pk-none > * { min-width: 0; overflow-wrap: anywhere; }
  .pk-foot { padding: 10px 16px; font-size: 12.5px; color: var(--dim); }
  .pk-pager { display: flex; gap: 8px; }
  .pk-p { padding: 3px 10px; border: 1px solid var(--line); color: var(--text); text-decoration: none; white-space: nowrap; }
  a.pk-p:hover { border-color: var(--green); } .pk-p.off { color: var(--dim); }
  .pk-f .op-seg > a:focus-visible, a.pk-p:focus-visible, .pk-none a:focus-visible, .pk-list:focus-visible { outline: 1px solid var(--green); outline-offset: -1px; }
  .pk-list[aria-busy="true"] .pk-rows { opacity: .6; }
  @media (prefers-reduced-motion: no-preference) { .pk-list .pk-rows { transition: opacity .15s; } }
  @media (max-width: 760px) {
    .pk-head { display: none; } .pk-rows li:first-child .pk-row, .pk-rows:empty + .pk-none { border-top: 0; }
    .pk-row { grid-template-columns: minmax(0, 1fr) auto auto auto; grid-template-areas: "n v v v" "d d d d" "o a u s"; gap: 4px 12px; }
    .pk-n { grid-area: n; } .pk-d { grid-area: d; } .pk-v { grid-area: v; text-align: right; } .pk-o { grid-area: o; } .pk-a { grid-area: a; } .pk-u { grid-area: u; } .pk-s { grid-area: s; }
  }
  @media (max-width: 560px) { .pk-count.pk-all { display: none; } }
`;

/** A package's page, as the shell's pkgHref() writes it (layout.ts): the ring and the architecture ride the query. The list's rings and architectures are always one of the server's, so none falls back. */
function pkgHref(name: string, ring: string, arch: string): string {
  return `/package/${encodeURIComponent(name)}?ring=${encodeURIComponent(ring)}&arch=${encodeURIComponent(arch)}`;
}

/** How long ago, as the shell's ago() says it, without "ago": 42s, 5m, 3h, 12d. */
function age(iso: string, now: number): string {
  const s = (now - Date.parse(iso)) / 1000;
  if (!(s >= 0)) return "0s";
  if (s < 60) return Math.floor(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

function num(n: number): string {
  return Number(n || 0).toLocaleString("en-US");
}

/** The list an answer is, as a query: what its links and the next asks are built on. */
function asQuery(d: BrowseAnswer): BrowseQuery {
  return { ...BROWSE_DEFAULT, q: d.q, ring: d.ring, arch: d.arch, origin: d.origin, sort: d.sort, page: d.page, limit: d.limit };
}

/** A step (the next page, the previous) as the list's address: the cursor it names, and nothing of the page it leaves. */
function stepHref(d: BrowseAnswer, step: BrowseStep): string {
  return "/packages" + browseSearch(asQuery(d), { after: step.after ?? null, before: step.before ?? null, page: step.page ?? 1 });
}

/** Any filter or search: the list is not every package in its default order. A crawler follows the pages of the default list only — every package is on them — and none of the filtered ones (rel="nofollow"). */
function filtered(d: BrowseAnswer): boolean {
  return !!d.q || d.ring !== "all" || d.arch !== "all" || d.origin !== "all" || d.sort !== "name";
}

/**
 * One row: a package's page, the version the ring serves, where it comes
 * from, the architectures it is served on, its age and the seal. The row is
 * one link and the column head is not read out, so the cells carry their
 * own words for a screen reader ("version", "from", "updated … ago"),
 * hidden from sight. The browser's pkRow() writes the same characters.
 */
function rowHtml(p: BrowseAnswer["packages"][number], now: number): string {
  const factory = p.source === "factory";
  const origin = ORIGIN_WORDS[`${p.source}/${p.arch}`] ?? p.source;
  const on = REPO_ARCHES.filter((a) => p.arches.includes(a)), off = REPO_ARCHES.filter((a) => !p.arches.includes(a));
  const where = "on " + on.join(" and ") + (off.length ? ", not on " + off.join(" or ") : "");
  return `<li><a class="pk-row" href="${escapeHtml(pkgHref(p.name, p.ring, p.arch))}"><b class="pk-n">${escapeHtml(p.name)}</b><span class="pk-d">${escapeHtml(p.description)}</span><span class="pk-v"><span class="pk-sr">version </span>${escapeHtml(p.version)}</span><span class="pk-o${factory ? " f" : ""}" title="${escapeHtml(origin)}">${lucide(factory ? "factory" : "refresh-cw", 13)}<span class="pk-sr">from </span><span>${escapeHtml(origin)}</span></span><span class="pk-a" role="img" aria-label="${escapeHtml(where)}" title="${escapeHtml(where)}">${REPO_ARCHES.map((a) => `<i class="op-arch ${p.arches.includes(a) ? "ok" : "na"}"></i>`).join("")}</span><span class="pk-u" title="updated ${escapeHtml(p.updated_at.slice(0, 16).replace("T", " "))} UTC"><span class="pk-sr">updated </span>${age(p.updated_at, now)}<span class="pk-sr"> ago</span></span><span class="pk-s op-mark ok" role="img" aria-label="sealed" title="sealed">✓</span></a></li>`;
}

/** A filter narrows the list: a ring, an architecture or an origin picked (the order is not one). */
function narrowed(d: BrowseAnswer): boolean {
  return d.ring !== "all" || d.arch !== "all" || d.origin !== "all";
}

/**
 * What the reader can do when the list is empty: go to the first page (an
 * address past the end); clear the filters (a filter left nothing — the
 * name may be on another ring or architecture); open the page of a name
 * the pool has outside the rings (the factory's, or the lab's); else
 * Request "<name>" when the search is a name, or a request.
 */
function noneHtml(d: BrowseAnswer): string {
  if (d.packages.length) return "";
  if (d.count) return `<div class="pk-none"><span>Nothing on this page.</span><a href="${escapeHtml(stepHref(d, {}))}">First page →</a></div>`;
  if (narrowed(d)) return `<div class="pk-none"><span>Nothing matches these filters.</span><a href="${escapeHtml("/packages" + browseSearch({ ...asQuery(d), ring: "all", arch: "all", origin: "all", page: 1 }))}">Clear the filters →</a></div>`;
  const h = d.held;
  if (h) return `<div class="pk-none"><span>${escapeHtml(h.name)} is not in a ring. ${h.where === "lab" ? "It is in the lab." : "The factory has it: " + escapeHtml(h.where) + "."}</span><a href="${escapeHtml(pkgHref(h.name, "stable", h.arch))}">Its page →</a></div>`;
  const name = d.q.toLowerCase();
  const offer = REQUEST_NAME.test(name) ? `<a href="/request?name=${encodeURIComponent(name)}">Request "${escapeHtml(name)}" →</a>` : `<a href="/request">Request a package →</a>`;
  return `<div class="pk-none"><span>Nothing matches.</span>${offer}</div>`;
}

/**
 * The list an answer draws: the head, a row per package — or what the
 * reader can do when there is none (noneHtml) — and the page it is on with
 * the two steps. A crawler follows the default list forward only: a step
 * back is a page it reached forward already, under another address
 * (before= where it was after=), so it is rel="nofollow" as well — one
 * page, one address in an index. The browser's pkList() writes the same
 * characters.
 */
export function listHtml(d: BrowseAnswer, now: number): string {
  const head = `<div class="pk-head" aria-hidden="true"><span>name</span><span>what it does</span><span>${d.ring === "all" ? "version" : "in " + escapeHtml(d.ring)}</span><span>origin</span><span>arch</span><span>updated</span><span></span></div>`;
  const step = (s: BrowseStep | null, word: string, dir: "prev" | "next") => (s ? `<a class="pk-p" href="${escapeHtml(stepHref(d, s))}" rel="${dir}${filtered(d) || s.before != null ? " nofollow" : ""}">${word}</a>` : `<span class="pk-p off" aria-disabled="true">${word}</span>`);
  const foot = d.count ? `<div class="pk-foot"><span id="pk-at">page ${num(d.page)} of ${num(d.pages)}</span><span class="pk-pager">${step(d.prev, "← prev", "prev")}${step(d.next, "next →", "next")}</span></div>` : "";
  return `${head}<ol class="pk-rows">${d.packages.map((p) => rowHtml(p, now)).join("")}</ol>${noneHtml(d)}${foot}`;
}

/** The page's title: the pool's total, counted up on load — or, when the list did not answer, the words without the number. The browser's pkTitle() writes the same characters. */
export function titleHtml(d: BrowseAnswer | null): string {
  return d ? `<span id="pk-total" data-n="${d.total}">${num(d.total)}</span> packages, every one tested` : "Every package in the pool, tested";
}

/** What the search box says on its right: every package, or how many the filters and the search match — or that one letter is not a search yet. */
export function countText(d: BrowseAnswer, typed: string): string {
  if (typed.length > 0 && typed.length < BROWSE_MIN_Q) return "type one more letter";
  return d.q || d.ring !== "all" || d.arch !== "all" || d.origin !== "all" ? num(d.count) + " match" : "every ring · both architectures";
}

/** The filters: each a segment of links, the one the list is on marked current. A link keeps the search and the other filters and starts again from the first page. A segment is a labelled group, not a landmark: four navigation landmarks for one row of filters crowded a screen reader's list of them. */
function filtersHtml(q: BrowseQuery): string {
  return SEGMENTS.map((s) => `<div class="pk-f${s.key === "sort" ? " pk-sort" : ""}"><span class="op-label" id="pk-l-${s.key}">${s.label}</span><div class="op-seg" role="group" aria-labelledby="pk-l-${s.key}">${s.options.map(([v, word]) => `<a href="/packages${escapeHtml(browseSearch(q, { [s.key]: v, after: null, before: null, page: 1 }))}" rel="nofollow" data-k="${s.key}" data-v="${v}"${q[s.key] === v ? ' aria-current="true"' : ""}>${escapeHtml(word)}</a>`).join("")}</div></div>`).join("");
}

function body(v: BrowseView, now: number): string {
  const d = v.answer, q = v.query;
  // With script off, the form keeps the filters the list is on: a search starts again from the first page, in the same rings.
  const keep = (["ring", "arch", "origin", "sort"] as const).filter((k) => q[k] !== BROWSE_DEFAULT[k]).map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(q[k])}">`).join("");
  const count = d ? countText(d, v.typed) : "";
  const list = d ? listHtml(d, now) : `<div class="pk-none"><span>The packages list did not answer: ${escapeHtml(v.error ?? "no answer")}.</span><a href="/packages${escapeHtml(browseSearch(q))}">Try again →</a></div>`;
  // #pk-said says where a step of the pager landed (the rows and the pager are drawn again, and the count beside the box does not change); the list takes the focus a step's link had when there is no step left to give it to.
  return `<style>${BROWSE_CSS}</style>
<div class="pk">
  <div class="pk-top">
    <div class="pk-title"><p class="op-eyebrow">Packages</p><h1 class="op-hero">${titleHtml(d)}</h1></div>
    <form class="pk-search" id="pk-search" action="/packages" method="get" role="search">${lucide("search", 18)}<input type="search" name="q" id="pk-q" value="${escapeHtml(v.typed)}" placeholder="name or what it does" aria-label="Find a package by its name or what it does" aria-keyshortcuts="/" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">${keep}<span class="pk-count${d && !filtered({ ...d, sort: "name" }) && !v.typed ? " pk-all" : ""}" id="pk-count" aria-live="polite">${escapeHtml(count)}</span></form>
    <div class="pk-filters" id="pk-filters">${filtersHtml(q)}</div>
  </div>
  <div class="op-card pk-list" id="pk-list" tabindex="-1">${list}</div>
  <p class="pk-sr" id="pk-said" aria-live="polite"></p>
</div>`;
}

/**
 * The page's script: what the browser adds to the page the server drew.
 * The same list the server read — its address is the page's own query,
 * asked at /api/v1/packages, so the edge keeps one copy for both — drawn
 * by pkList(), pkRow(), pkCount() and pkTitle(), the characters listHtml(),
 * rowHtml(), countText() and titleHtml() write. A filter or a step of the
 * pager is drawn in place and pushed on the history (back and forward draw
 * the list again); a step keeps the keyboard on the pager and says the page
 * it landed on. The search asks after a pause in the typing (250 ms, the
 * old list's) and replaces the address instead, so typing leaves one
 * entry; one letter draws the whole list and says a search is two. A press
 * with a modifier key, or on the page's other links, is the browser's. A
 * list that did not answer is said where the page number was, and the
 * rows stay.
 */
const BROWSE_SCRIPT = String.raw`
  // ---- the packages list (#245): pages/browse.ts says how it works and why.
  var PK = __PK__, PK_NAME = new RegExp(PK.name), pkSeq = 0, pkTimer = null;
  // A search as the server reads it: trimmed, and cut by characters, never in the middle of one (half an emoji throws in encodeURIComponent).
  function pkCut(v) { return Array.from(String(v || "").trim()).slice(0, PK.maxQ).join(""); }
  // The list an address asks for, as the server reads it (routes/browse.ts browseQuery): a value it does not know is the default, one letter is typed but not searched.
  function pkState(search) {
    var p = new URLSearchParams(search), s = { q: "", typed: pkCut(p.get("q")), ring: "all", arch: "all", origin: "all", sort: "name", after: null, before: null, page: 1, limit: PK.limit };
    if (s.typed.length >= PK.minQ) s.q = s.typed;
    if (PROMISED_RINGS.indexOf(p.get("ring")) >= 0) s.ring = p.get("ring");
    if (ARCHES.indexOf(p.get("arch")) >= 0) s.arch = p.get("arch");
    if (PK.origins.indexOf(p.get("origin")) >= 0) s.origin = p.get("origin");
    if (PK.sorts.indexOf(p.get("sort")) >= 0) s.sort = p.get("sort");
    if (/^\d{1,6}$/.test(p.get("page") || "") && Number(p.get("page")) >= 1 && Number(p.get("page")) <= PK.maxPage) s.page = Number(p.get("page"));
    if (/^\d{1,3}$/.test(p.get("limit") || "") && Number(p.get("limit")) >= 1 && Number(p.get("limit")) <= PK.maxLimit) s.limit = Number(p.get("limit"));
    // A cursor is an id when sorted by recency, a name otherwise; none with a search, and neither when an address names both.
    function cursor(v) { return v === null || s.q ? null : s.sort === "recent" ? (/^\d{1,15}$/.test(v) ? v : null) : v.length >= 1 && v.length <= 256 ? v : null; }
    s.after = cursor(p.get("after")); s.before = cursor(p.get("before"));
    if (s.after !== null && s.before !== null) s.after = s.before = null;
    // Outside a search a page's number goes with its cursor: either alone is the first page.
    if (!s.q && s.after === null && s.before === null) s.page = 1;
    if (!s.q && s.page <= 1) s.after = s.before = null;
    return s;
  }
  // A list's address, the defaults left out, in the server's order (routes/browse.ts browseSearch): one list, one address.
  function pkQuery(s, over) {
    var t = {}, k, parts = [];
    for (k in s) t[k] = s[k];
    for (k in over || {}) t[k] = over[k];
    function add(key, v) { parts.push(key + "=" + encodeURIComponent(v)); }
    if (t.q) add("q", t.q);
    if (t.ring !== "all") add("ring", t.ring);
    if (t.arch !== "all") add("arch", t.arch);
    if (t.origin !== "all") add("origin", t.origin);
    if (t.sort !== "name") add("sort", t.sort);
    if (t.after !== null && t.after !== undefined) add("after", t.after);
    if (t.before !== null && t.before !== undefined) add("before", t.before);
    if (t.page > 1) add("page", String(t.page));
    if (t.limit !== PK.limit) add("limit", String(t.limit));
    return parts.length ? "?" + parts.join("&") : "";
  }
  function pkAge(iso, now) { var s = (now - Date.parse(iso)) / 1000; if (!(s >= 0)) return "0s"; if (s < 60) return Math.floor(s) + "s"; if (s < 3600) return Math.floor(s / 60) + "m"; if (s < 86400) return Math.floor(s / 3600) + "h"; return Math.floor(s / 86400) + "d"; }
  function pkFiltered(d) { return !!d.q || d.ring !== "all" || d.arch !== "all" || d.origin !== "all" || d.sort !== "name"; }
  function pkStep(d, step) { return "/packages" + pkQuery({ q: d.q, ring: d.ring, arch: d.arch, origin: d.origin, sort: d.sort, limit: d.limit }, { after: step.after === undefined ? null : step.after, before: step.before === undefined ? null : step.before, page: step.page === undefined ? 1 : step.page }); }
  function pkRow(p, now) {
    var factory = p.source === "factory", origin = PK.origin[p.source + "/" + p.arch] || p.source;
    var on = ARCHES.filter(function (a) { return p.arches.indexOf(a) >= 0; }), off = ARCHES.filter(function (a) { return p.arches.indexOf(a) < 0; });
    var where = "on " + on.join(" and ") + (off.length ? ", not on " + off.join(" or ") : "");
    return '<li><a class="pk-row" href="' + esc(pkgHref(p.name, p.ring, p.arch)) + '"><b class="pk-n">' + esc(p.name) + '</b><span class="pk-d">' + esc(p.description) + '</span><span class="pk-v"><span class="pk-sr">version </span>' + esc(p.version) + '</span><span class="pk-o' + (factory ? " f" : "") + '" title="' + esc(origin) + '">' + lucide(factory ? "factory" : "refresh-cw", 13) + '<span class="pk-sr">from </span><span>' + esc(origin) + '</span></span><span class="pk-a" role="img" aria-label="' + esc(where) + '" title="' + esc(where) + '">' + ARCHES.map(function (a) { return '<i class="op-arch ' + (p.arches.indexOf(a) >= 0 ? "ok" : "na") + '"></i>'; }).join("") + '</span><span class="pk-u" title="updated ' + esc(p.updated_at.slice(0, 16).replace("T", " ")) + ' UTC"><span class="pk-sr">updated </span>' + pkAge(p.updated_at, now) + '<span class="pk-sr"> ago</span></span><span class="pk-s op-mark ok" role="img" aria-label="sealed" title="sealed">✓</span></a></li>';
  }
  // An empty list: the first page, clear the filters, the page of a name the pool has outside the rings, or the request (pages/browse.ts noneHtml).
  function pkNone(d) {
    if (d.packages.length) return "";
    if (d.count) return '<div class="pk-none"><span>Nothing on this page.</span><a href="' + esc(pkStep(d, {})) + '">First page →</a></div>';
    if (d.ring !== "all" || d.arch !== "all" || d.origin !== "all") return '<div class="pk-none"><span>Nothing matches these filters.</span><a href="' + esc("/packages" + pkQuery({ q: d.q, ring: "all", arch: "all", origin: "all", sort: d.sort, after: null, before: null, page: 1, limit: d.limit }, {})) + '">Clear the filters →</a></div>';
    var h = d.held;
    if (h) return '<div class="pk-none"><span>' + esc(h.name) + ' is not in a ring. ' + (h.where === "lab" ? "It is in the lab." : "The factory has it: " + esc(h.where) + ".") + '</span><a href="' + esc(pkgHref(h.name, "stable", h.arch)) + '">Its page →</a></div>';
    var name = d.q.toLowerCase();
    var offer = PK_NAME.test(name) ? '<a href="/request?name=' + encodeURIComponent(name) + '">Request "' + esc(name) + '" →</a>' : '<a href="/request">Request a package →</a>';
    return '<div class="pk-none"><span>Nothing matches.</span>' + offer + '</div>';
  }
  function pkList(d, now) {
    var head = '<div class="pk-head" aria-hidden="true"><span>name</span><span>what it does</span><span>' + (d.ring === "all" ? "version" : "in " + esc(d.ring)) + '</span><span>origin</span><span>arch</span><span>updated</span><span></span></div>';
    // A step back is nofollow too: its page was reached forward already, under another address.
    function step(s, word, dir) { return s ? '<a class="pk-p" href="' + esc(pkStep(d, s)) + '" rel="' + dir + (pkFiltered(d) || s.before != null ? " nofollow" : "") + '">' + word + '</a>' : '<span class="pk-p off" aria-disabled="true">' + word + '</span>'; }
    var foot = d.count ? '<div class="pk-foot"><span id="pk-at">page ' + num(d.page) + ' of ' + num(d.pages) + '</span><span class="pk-pager">' + step(d.prev, "← prev", "prev") + step(d.next, "next →", "next") + '</span></div>' : "";
    return head + '<ol class="pk-rows">' + d.packages.map(function (p) { return pkRow(p, now); }).join("") + '</ol>' + pkNone(d) + foot;
  }
  function pkTitle(d) { return '<span id="pk-total" data-n="' + d.total + '">' + num(d.total) + '</span> packages, every one tested'; }
  function pkCount(d, typed) {
    if (typed.length > 0 && typed.length < PK.minQ) return "type one more letter";
    return d.q || d.ring !== "all" || d.arch !== "all" || d.origin !== "all" ? num(d.count) + " match" : "every ring · both architectures";
  }
  // The filters' links follow the list: each keeps the search and the other filters, starts from the first page, and the one the list is on is current.
  function pkLinks(s) {
    document.querySelectorAll("#pk-filters a[data-k]").forEach(function (a) {
      var k = a.getAttribute("data-k"), v = a.getAttribute("data-v"), over = { after: null, before: null, page: 1 };
      over[k] = v;
      a.setAttribute("href", "/packages" + pkQuery(s, over));
      if (s[k] === v) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
    });
  }
  function pkShow(d, s) {
    var total = $("#pk-total"), count = $("#pk-count"), hero = $(".pk-title .op-hero");
    $("#pk-list").innerHTML = pkList(d, Date.now());
    // The title has no number when the page was drawn without an answer: the first answer puts it there.
    if (total) { total.setAttribute("data-n", d.total); total.textContent = num(d.total); } else if (hero) hero.innerHTML = pkTitle(d);
    if (count) { count.textContent = pkCount(d, s.typed); count.removeAttribute("title"); count.classList.toggle("pk-all", !pkFiltered({ q: d.q, ring: d.ring, arch: d.arch, origin: d.origin, sort: "name" }) && !s.typed); }
    pkLinks(s);
  }
  // A step of the pager or a link in the empty list is gone with the list it was drawn in, and the focus with it: it goes to the same step of the new pager (↵ walks on), else the other step, else the list; and where the step landed is said — the count beside the box has not changed.
  function pkRefocus(d, dir) {
    var said = $("#pk-said"), to = (dir && $("#pk-list .pk-pager a[rel^='" + dir + "']")) || $("#pk-list .pk-pager a") || $("#pk-list");
    if (said) said.textContent = d.count ? "page " + num(d.page) + " of " + num(d.pages) : pkCount(d, "");
    if (to && to.focus) to.focus({ preventScroll: true });
  }
  // Ask for the list, draw it, and put its address in the history: "push" for a filter or a page, "replace" while typing, nothing for back and forward (the history is already there). "from" is where the focus was when a link in the list asked: "prev" or "next" for a step, "list" for the empty list's link.
  function pkLoad(s, how, from) {
    var my = ++pkSeq, list = $("#pk-list");
    if (list) list.setAttribute("aria-busy", "true");
    busy(fetch("/api/v1/packages" + pkQuery(s))).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || "HTTP " + r.status); return d; });
    }).then(function (d) {
      if (my !== pkSeq) return;
      pkShow(d, s);
      if (from) pkRefocus(d, from === "list" ? null : from);
      var to = "/packages" + pkQuery({ q: s.typed, ring: s.ring, arch: s.arch, origin: s.origin, sort: s.sort, after: s.after, before: s.before, page: s.page, limit: s.limit }, {});
      if (how === "push") history.pushState(null, "", to); else if (how === "replace") history.replaceState(null, "", to);
    }, function (e) {
      if (my !== pkSeq) return;
      // Said where the page number was, or beside the box — whole on hover and to a screen reader when the box's width cuts it short.
      var at = $("#pk-at"), line = "the packages list did not answer: " + errorText(e);
      if (at) at.textContent = line; else { var c = $("#pk-count"); if (c) { c.textContent = line; c.setAttribute("title", line); } }
    }).then(function () { if (my === pkSeq && list) list.removeAttribute("aria-busy"); });
  }
  // A step of the pager, a filter, a link in the empty list: a plain press is drawn in place; with a modifier it is the browser's (a new tab, a new window).
  document.addEventListener("click", function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest("#pk-filters a[href], #pk-list .pk-pager a[href], #pk-list .pk-none a[href^='/packages']") : null;
    if (!a || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    ev.preventDefault();
    var href = a.getAttribute("href"), s = pkState(href.slice(href.indexOf("?") < 0 ? href.length : href.indexOf("?")));
    pkLoad(s, "push", a.closest(".pk-pager") ? (a.getAttribute("rel") || "next").split(" ")[0] : a.closest("#pk-list") ? "list" : null);
    var top = $(".pk-list"); if (a.closest(".pk-pager") && top && top.scrollIntoView && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" });
  });
  var pkBox = $("#pk-q"), pkForm = $("#pk-search");
  // The search: the list for the words after a pause, the filters kept, from the first page; ↵ asks at once.
  function pkSearch(how) {
    var s = pkState(location.search);
    s.typed = pkCut(pkBox.value); s.q = s.typed.length >= PK.minQ ? s.typed : ""; s.after = null; s.before = null; s.page = 1;
    pkLoad(s, how);
  }
  if (pkBox && pkForm) {
    pkBox.addEventListener("input", function () { clearTimeout(pkTimer); pkTimer = setTimeout(function () { pkSearch("replace"); }, 250); });
    pkForm.addEventListener("submit", function (ev) { ev.preventDefault(); clearTimeout(pkTimer); pkSearch("replace"); });
  }
  if (window.addEventListener) window.addEventListener("popstate", function () { var s = pkState(location.search); if (pkBox) pkBox.value = s.typed; pkLoad(s, null); });
  // The total lands the way the handoff's numbers do (countUp: 1.1 s, or at once for less motion); the page serves the number itself.
  var pkTotal = $("#pk-total");
  if (pkTotal && pkTotal.getAttribute("data-n")) countUp(pkTotal, Number(pkTotal.getAttribute("data-n")));
`;

/** The browser's side of what the server knows: the options, the page's size, the origins' words and the request rule. */
const PK_CONFIG = { limit: BROWSE_LIMIT, maxLimit: BROWSE_MAX, maxPage: BROWSE_MAX_PAGE, minQ: BROWSE_MIN_Q, maxQ: BROWSE_MAX_Q, origins: [...BROWSE_ORIGINS], sorts: [...BROWSE_SORTS], origin: ORIGIN_WORDS, name: REQUEST_NAME.source };

export function packagesHtml(poolUrl: string, version: RunningVersion, view: BrowseView, now = Date.now()): string {
  const search = browseSearch({ ...view.query, q: view.typed || view.query.q });
  return page({
    // Sign in comes back to the list as it was: its filters and its page.
    path: "/packages" + search,
    title: "Packages · omarchy-pool",
    description: "Every package the pool serves, tested: search it, filter it by ring, architecture and origin, open its page.",
    // The packages list and a package's page are the Pool's: what a user comes to the pool for (#240).
    active: "pool",
    kit: true,
    body: body(view, now),
    script: BROWSE_SCRIPT.replace("__PK__", JSON.stringify(PK_CONFIG)),
    poolUrl,
    version,
  });
}

/**
 * What /packages is made of. Every read is a public GET and nothing on it
 * changes with the role — the header's account chip is the shell's. The
 * list is drawn by the server from the very address its script asks, so
 * each piece is anchored in the HTML and named in the script both.
 */
export const PACKAGES_COMPONENTS = (F: Fixture): Component[] => [
  {
    // The title is the pool's total — every ring, both architectures, a name once — counted up on load; a page drawn without an answer gets it from the first one.
    id: "packages.hero",
    page: "/packages",
    anchor: ['<p class="op-eyebrow">Packages</p>', '<h1 class="op-hero"><span id="pk-total" data-n="', " packages, every one tested</h1>"],
    script: ['$("#pk-total")', "countUp(pkTotal", "d.total", "hero.innerHTML = pkTitle(d)"],
    reads: [{ path: "/api/v1/packages", fields: ["total"] }],
    visible: EVERYONE,
  },
  {
    // A form with script off, the list in place with it on; / focuses it (the ⌘K menu's hook, layout.ts GO_MENU).
    id: "packages.search-box",
    page: "/packages",
    anchor: ['<form class="pk-search" id="pk-search" action="/packages" method="get" role="search">', 'name="q" id="pk-q"', 'aria-keyshortcuts="/"', 'id="pk-count"'],
    script: ['"/api/v1/packages" + pkQuery(', '$("#pk-q")', '"input"', '"submit"', "pkCount(d, s.typed)", '"type one more letter"', '"every ring · both architectures"', '" match"'],
    reads: [{ path: `/api/v1/packages?q=${F.pkg}`, fields: ["q", "count", "packages", "packages.0.name"] }],
    visible: EVERYONE,
  },
  {
    // Ring, Arch, Origin and Sort: links in the address's words, the one the list is on current; the rings the server's promised ones (PROMISED_RINGS), the architectures ARCHES.
    id: "packages.filters",
    page: "/packages",
    anchor: ['id="pk-filters"', 'data-k="ring" data-v="all" aria-current="true">all</a>', 'data-k="ring" data-v="stable">stable</a>', 'data-k="arch" data-v="all" aria-current="true">both</a>', 'data-k="origin" data-v="factory">factory</a>', 'data-k="sort" data-v="recent">recent</a>', 'data-k="sort" data-v="name" aria-current="true">a–z</a>'],
    script: ["PROMISED_RINGS.indexOf(", "ARCHES.indexOf(", "PK.origins", "PK.sorts", "pkLinks(s)", '"aria-current"', "history.pushState"],
    reads: [
      { path: "/api/v1/packages?ring=stable&arch=x86_64&origin=synced&sort=recent", fields: ["ring", "arch", "origin", "sort", "packages"] },
      { path: "/api/v1/packages?origin=factory", fields: ["origin", "packages.0.source"] },
    ],
    visible: EVERYONE,
  },
  {
    // A row per name: its page in the ring and on the architecture the version shown comes from (pkgHref), the squares every architecture the rings serve it on.
    id: "packages.list",
    page: "/packages",
    anchor: ['class="op-card pk-list" id="pk-list"', '<div class="pk-head" aria-hidden="true">', '<ol class="pk-rows">', '<a class="pk-row" href="/package/', '<span class="pk-s op-mark ok" role="img" aria-label="sealed" title="sealed">✓</span>'],
    script: ["pkList(d, Date.now())", "pkRow(p, now)", "pkgHref(p.name, p.ring, p.arch)", "p.description", "p.version", "p.arches", "p.updated_at", "PK.origin[p.source", 'lucide(factory ? "factory" : "refresh-cw", 13)'],
    reads: [{ path: "/api/v1/packages", fields: ["packages.0.name", "packages.0.description", "packages.0.version", "packages.0.ring", "packages.0.arch", "packages.0.source", "packages.0.arches", "packages.0.updated_at", "count", "pages"] }],
    visible: EVERYONE,
  },
  {
    // Nothing matches: the request, with the name the search is when it is one — the ⌘K menu's Request "<name>", on the same form.
    id: "packages.request",
    page: "/packages?q=zzfoo",
    anchor: ['<div class="pk-none"><span>Nothing matches.</span><a href="/request?name=zzfoo">Request "zzfoo" →</a></div>'],
    script: ["'<a href=\"/request?name=' + encodeURIComponent(name)", "'<a href=\"/request\">Request a package →</a>'", "PK_NAME.test(name)"],
    reads: [{ path: "/api/v1/packages?q=zzfoo", fields: ["count", "packages", "held"] }, { path: "/request?name=zzfoo", json: false }],
    visible: EVERYONE,
  },
  {
    // A name the pool has outside the rings — the factory's (mine: approved, in no ring) or the lab's — is its page, not a request; a filter that leaves nothing offers to clear it.
    id: "packages.elsewhere",
    page: `/packages?q=${F.factoryPkg}`,
    anchor: [`<div class="pk-none"><span>${F.factoryPkg} is not in a ring. The factory has it: `, `<a href="/package/${F.factoryPkg}?ring=stable&amp;arch=${F.arch}">Its page →</a></div>`],
    script: ["var h = d.held", 'pkgHref(h.name, "stable", h.arch)', ">Its page →</a>", '"It is in the lab."', "Nothing matches these filters.", "Clear the filters →"],
    reads: [
      { path: `/api/v1/packages?q=${F.factoryPkg}`, fields: ["count", "held", "held.name", "held.where", "held.arch"] },
      { path: `/package/${F.factoryPkg}?ring=stable&arch=${F.arch}`, json: false },
    ],
    visible: EVERYONE,
  },
  {
    // The page it is on and the two steps: links with script off, drawn in place with it on.
    id: "packages.pager",
    page: "/packages?limit=1",
    anchor: ['<div class="pk-foot"><span id="pk-at">page 1 of ', '<span class="pk-p off" aria-disabled="true">← prev</span>', '<a class="pk-p" href="/packages?after='],
    script: ["pkStep(d, s)", '"← prev"', '"next →"', "d.next", "d.prev", "d.pages", "s.before != null", "pkRefocus(d,", '$("#pk-said")', "preventScroll: true"],
    reads: [{ path: "/api/v1/packages?limit=1", fields: ["page", "pages", "next", "next.after", "prev"] }],
    visible: EVERYONE,
  },
];
