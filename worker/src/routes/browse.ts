import { json, type Env } from "../index";
import { PROMOTED_RINGS, REPO_ARCHES, RINGS, RINGS_BY_STABILITY, isRepoArch, ringsSql, sourceRank, type Ring } from "../meta";

/**
 * The packages list (#245): every package the rings serve, one row per
 * name — "one name, one package" (#242): marcelo, on x86_64 and aarch64,
 * is one row with a square per architecture — filtered, sorted and paged
 * by the server, so the page is drawn whole with script off and a crawler
 * walking every page reads what it is shown.
 *
 *   GET /packages?q=&ring=&arch=&origin=&sort=&after=&before=&page=&limit=
 *
 *   q        a name or a word of the description, two characters or more
 *   ring     all (default: stable, rc and edge — the lab promises nothing and is not listed) | stable | rc | edge
 *   arch     all (default) | x86_64 | aarch64
 *   origin   all (default) | synced (from a source) | factory (built here)
 *   sort     name (default: a–z; with q the names that hold it first) | recent (the newest version first)
 *   after, before   the cursor of the next or previous page, as `next` and `prev` give it
 *   page     the page's number, as `next` and `prev` give it — with its cursor; with q, the page itself
 *   limit    rows per page, 25 by default, at most 100
 *
 * What it costs, per page view (D1 bills every row read; test/browse.test.ts
 * measures each shape against a pool of its own, and bounds it). The
 * figures are rows_read on a pool shaped like production's — 19,000 names,
 * 35,467 objects, 95,635 memberships, the newest 633 objects in edge only
 * (measured 2026-09-29):
 *
 * - The page is found by walking an index from the cursor, never by an
 *   OFFSET: a–z walks the (name, repo_arch, source) index from the last
 *   name shown, recent walks the table's own order (an object's id grows
 *   with its arrival) down from the last object shown — each object asked
 *   whether a ring serves it with a probe of ring_packages' primary key,
 *   and stopped at the page's last row. An a–z page reads the same wherever
 *   it is (365 rows; page 700 by OFFSET would have read the 17,000 names
 *   before it), recent over every ring about as much (658). Recent in one
 *   ring walks past every newer object that ring does not serve before its
 *   first row: 4,057 for stable, whose newest object is older than edge's
 *   last syncs (1,753 for rc on aarch64). The factory's few objects are
 *   walked through the source index instead of the whole list (660–821).
 * - A search reads the packages table once (a description is text in the
 *   manifest, which no index holds) and ranks every match: the scan (a row
 *   per object), a ring probe per match, then the matches grouped by name,
 *   counted and sorted — so it costs by how much matches. A word nothing
 *   holds reads the table alone (35,477); "lib" 53,109; "p0" 99,730; a
 *   word every description holds ("tool") 157,347, about four rows per
 *   object. The search Home's box reads 63–82 k per term on the same pool
 *   (routes/search.ts: one ring, one architecture, a hundred rows), so a
 *   narrow search here costs less and a broad one about twice. A page past
 *   the last match (an address the pager does not give) pays the pass
 *   twice, to count. A search that matched nothing, with no filter, adds
 *   two point reads to say where the pool has the name (heldElsewhere).
 * - The counts — the total in the page's title and "page 1 of N" — are
 *   not counted per view: browseCounts() counts every filter at once
 *   (one walk of the name index, 131,108 rows), keeps the answer in
 *   settings under the heads it was counted at, and counts again at the
 *   first view after a head has moved. Every sync and every promotion
 *   moves one: about 30 a day on production (2026-09-28: edge 14, rc 8,
 *   stable 8), so at most about 4 M rows a day, 120 M a month — some
 *   US$0.12 a month at the overage rate (/api/v1/cost). They are not kept
 *   per ring: over every ring a name counts once, which counts per ring
 *   cannot add up to, so an edge sync would count those again anyway.
 * - The answer is kept at the edge for five minutes (index.ts cachedApi),
 *   under its URL: the page (index.ts, pages/browse.ts) asks this very
 *   address for its first drawing and its script asks it for every other,
 *   so the two share the copy.
 */

/** The rings the list reads, in the reader's order (stable first): the promised ones. */
export const BROWSE_RINGS = RINGS_BY_STABILITY.filter((r) => (PROMOTED_RINGS as readonly string[]).includes(r));
export type BrowseRing = "all" | (typeof PROMOTED_RINGS)[number];
export type BrowseArch = "all" | (typeof REPO_ARCHES)[number];
/** Where a package comes from: a source the pool syncs, or the factory, which builds it here. */
export const BROWSE_ORIGINS = ["synced", "factory"] as const;
export type BrowseOrigin = "all" | (typeof BROWSE_ORIGINS)[number];
export const BROWSE_SORTS = ["name", "recent"] as const;
export type BrowseSort = (typeof BROWSE_SORTS)[number];

/** Rows per page by default, and the most a caller may ask for. */
export const BROWSE_LIMIT = 25;
export const BROWSE_MAX = 100;
/** A search is two characters or more, as the search Home's box asks (routes/search.ts): one letter holds nearly every name. */
export const BROWSE_MIN_Q = 2;
/** The longest search read, in characters (code points, so none is cut in half): a name is at most a hundred (the factory's rule); a longer search is read to its hundredth. */
export const BROWSE_MAX_Q = 100;
/** A name a request can carry — the ⌘K menu's rule for offering Request "<name>" (layout.ts GO_MENU's NAME, routes/contributors.ts's characters). */
export const BROWSE_NAME = /^[a-z0-9][a-z0-9@._+-]{1,99}$/;
/** The highest page number read: a search's matches are counted and sorted in one pass whatever the page, so this only bounds its OFFSET; a cursor's page number is only said. */
export const BROWSE_MAX_PAGE = 100000;

export interface BrowseQuery {
  q: string;
  ring: BrowseRing;
  arch: BrowseArch;
  origin: BrowseOrigin;
  sort: BrowseSort;
  /** The cursor: the last row of the page before (after) or the first row of the page after (before) — a name when sorted by name, an object's id when by recency. */
  after: string | null;
  before: string | null;
  page: number;
  limit: number;
}

export const BROWSE_DEFAULT: BrowseQuery = { q: "", ring: "all", arch: "all", origin: "all", sort: "name", after: null, before: null, page: 1, limit: BROWSE_LIMIT };

/**
 * A query string read into a BrowseQuery, and what was wrong with it. The
 * API refuses a query with a problem (400); the page draws what it could
 * read and leaves the rest at its default, so an old or hand-made address
 * still lands on a list. `typed` is the search as the reader typed it —
 * one letter too, which the list does not search on but the box keeps.
 */
export function browseQuery(params: URLSearchParams): { query: BrowseQuery; typed: string; problems: string[] } {
  const problems: string[] = [];
  const query: BrowseQuery = { ...BROWSE_DEFAULT };
  // Cut by characters, not UTF-16 units: half an emoji is a lone surrogate, which encodeURIComponent (browseSearch) throws on.
  const typed = Array.from((params.get("q") ?? "").trim()).slice(0, BROWSE_MAX_Q).join("");
  if (typed.length >= BROWSE_MIN_Q) query.q = typed;
  else if (typed) problems.push(`q must have at least ${BROWSE_MIN_Q} characters`);
  const ring = params.get("ring");
  if (ring !== null && ring !== "all") {
    if ((BROWSE_RINGS as readonly string[]).includes(ring)) query.ring = ring as BrowseRing;
    else problems.push("ring is all, " + BROWSE_RINGS.join(", "));
  }
  // "both" is the segment's word for every architecture; an address may say either.
  const arch = params.get("arch");
  if (arch !== null && arch !== "all" && arch !== "both") {
    if (isRepoArch(arch)) query.arch = arch;
    else problems.push("arch is all, " + REPO_ARCHES.join(", "));
  }
  const origin = params.get("origin");
  if (origin !== null && origin !== "all") {
    if ((BROWSE_ORIGINS as readonly string[]).includes(origin)) query.origin = origin as BrowseOrigin;
    else problems.push("origin is all, " + BROWSE_ORIGINS.join(", "));
  }
  const sort = params.get("sort");
  if (sort !== null) {
    if ((BROWSE_SORTS as readonly string[]).includes(sort)) query.sort = sort as BrowseSort;
    else problems.push("sort is " + BROWSE_SORTS.join(" or "));
  }
  const page = params.get("page");
  if (page !== null) {
    if (/^\d{1,6}$/.test(page) && Number(page) >= 1 && Number(page) <= BROWSE_MAX_PAGE) query.page = Number(page);
    else problems.push(`page is a number from 1 to ${BROWSE_MAX_PAGE}`);
  }
  const limit = params.get("limit");
  if (limit !== null) {
    if (/^\d{1,3}$/.test(limit) && Number(limit) >= 1 && Number(limit) <= BROWSE_MAX) query.limit = Number(limit);
    else problems.push(`limit is a number from 1 to ${BROWSE_MAX}`);
  }
  // A cursor is a name (the index's own order) or an object's id (recency's). A search pages by number: its matches are sorted in one pass, so there is nothing for a cursor to save.
  for (const key of ["after", "before"] as const) {
    const v = params.get(key);
    if (v === null) continue;
    if (query.q) { problems.push(`${key} is not used with q: a search pages by page`); continue; }
    if (query.sort === "recent" ? /^\d{1,15}$/.test(v) : v.length >= 1 && v.length <= 256) query[key] = v;
    else problems.push(`${key} is ${query.sort === "recent" ? "an object's id" : "a package name"}, as next and prev give it`);
  }
  if (query.after !== null && query.before !== null) {
    problems.push("after and before are one page each: one of them");
    query.after = query.before = null;
  }
  // Outside a search the rows are the cursor's and the number only says where they are, so the two go together, as next and prev give them: a number with no cursor would label the first page's rows "page 3", a cursor with no number past the first would call a later page "page 1". Either is the first page, whose number is sure.
  if (!query.q) {
    const cursor = query.after !== null || query.before !== null;
    if (!cursor && query.page > 1) {
      problems.push("page goes with after or before, as next and prev give them (a search pages by page alone)");
      query.page = 1;
    } else if (cursor && query.page <= 1) {
      problems.push("after and before go with the page they lead to, 2 or more, as next and prev give them");
      query.after = query.before = null;
    }
  }
  return { query, typed, problems };
}

/**
 * The query string of a list, the defaults left out, in one order — the
 * page's links, its form, the address its script asks and the edge's key
 * are this string, so one list has one address. `over` replaces fields
 * (a filter picked, the next page); a filter or a search picked starts
 * again from the first page, which the caller says by passing the paging
 * fields as they should be.
 */
export function browseSearch(query: BrowseQuery, over: Partial<BrowseQuery> = {}): string {
  const s = { ...query, ...over };
  const parts: string[] = [];
  const add = (k: string, v: string) => parts.push(`${k}=${encodeURIComponent(v)}`);
  if (s.q) add("q", s.q);
  if (s.ring !== "all") add("ring", s.ring);
  if (s.arch !== "all") add("arch", s.arch);
  if (s.origin !== "all") add("origin", s.origin);
  if (s.sort !== "name") add("sort", s.sort);
  if (s.after !== null) add("after", s.after);
  if (s.before !== null) add("before", s.before);
  if (s.page > 1) add("page", String(s.page));
  if (s.limit !== BROWSE_LIMIT) add("limit", String(s.limit));
  return parts.length ? "?" + parts.join("&") : "";
}

/** One row of the list: a name, and what the rings picked serve of it. */
export interface BrowseRow {
  name: string;
  description: string;
  /** The version shown: the ring's, on the architecture picked (else the first that has it); with every ring, the newest the rings serve. */
  version: string;
  /** The most stable ring picked that serves that version, and its architecture: where the row's link opens the package's page. */
  ring: Ring;
  arch: string;
  /** Where that version comes from: its source (core, extra, …, or factory). */
  source: string;
  /** The architectures the rings picked serve the name on, from the origin picked — the row's squares. */
  arches: string[];
  /** When the newest version the row stands for entered the pool: what "recent" sorts by. */
  updated_at: string;
}

/** What the next or the previous page is: the fields to set on the query ({} is the first page). */
export type BrowseStep = Partial<Pick<BrowseQuery, "after" | "before" | "page">>;

/** A name the rings do not serve but the pool has: the factory's registration (`where` is its status) or a build in the lab (`where` is "lab"), and the architecture its page opens on. */
export interface BrowseHeld {
  name: string;
  where: string;
  arch: string;
}

export interface BrowseAnswer {
  q: string;
  ring: BrowseRing;
  arch: BrowseArch;
  origin: BrowseOrigin;
  sort: BrowseSort;
  page: number;
  limit: number;
  /** Every package the rings serve — every ring, both architectures, any origin: the page's title. */
  total: number;
  /** What the filters and the search match, and the pages that makes. */
  count: number;
  pages: number;
  packages: BrowseRow[];
  next: BrowseStep | null;
  prev: BrowseStep | null;
  /** For a search with no filter that matched nothing, where the pool has that name when it is one (a pacman name): what the page shows instead of Request "<name>". Null otherwise. */
  held: BrowseHeld | null;
}

/** The counts, one per filter the page offers — `<ring>/<arch>/<origin>` — kept with the heads they were counted at. */
export interface BrowseCounts {
  heads: Record<string, number | null>;
  counts: Record<string, number>;
}

/** What a caller of browse() may hold to add up the rows D1 read for one answer (the tests measure a view with it). */
export interface Meter {
  rows: number;
}

const SETTINGS_KEY = "browse_counts";

/** An architecture as SQL: only ever one of REPO_ARCHES, checked here, so the fragment can only be the arch's own name. */
function archSql(arch: string): string {
  if (!isRepoArch(arch)) throw new Error(`not an architecture: ${arch}`);
  return `'${arch}'`;
}

/** The rings a query reads: the one picked, or every promised one. */
function ringsOf(ring: BrowseRing): Ring[] {
  return ring === "all" ? [...PROMOTED_RINGS] : [ring];
}

/**
 * `alias` is served by one of `rings` now: a probe of ring_packages'
 * primary key (ring, package_id) per ring, in RINGS order — edge first,
 * which serves nearly everything, so the OR stops at its first probe for
 * most objects (db.ts outsideRetention reads the rings the same way).
 */
function servedIn(alias: string, rings: readonly Ring[]): string {
  return "(" + RINGS.filter((r) => rings.includes(r)).map((r) => `EXISTS (SELECT 1 FROM ring_packages m WHERE m.ring = ${ringsSql([r])} AND m.package_id = ${alias}.id)`).join(" OR ") + ")";
}

/** The filters on one object, the membership last: the index's own columns first, so the probes run only for what passed them. */
function candidate(alias: string, q: BrowseQuery): string {
  const terms: string[] = [];
  if (q.arch !== "all") terms.push(`${alias}.repo_arch = ${archSql(q.arch)}`);
  if (q.origin === "factory") terms.push(`${alias}.source = 'factory'`);
  if (q.origin === "synced") terms.push(`${alias}.source != 'factory'`);
  terms.push(servedIn(alias, ringsOf(q.ring)));
  return terms.join(" AND ");
}

function measured<T>(meter: Meter | undefined, r: D1Result<T>): D1Result<T> {
  if (meter) meter.rows += r.meta?.rows_read ?? 0;
  return r;
}

/**
 * The counts behind every filter the page offers: the names each
 * combination of ring, architecture and origin serves (36 of them), in
 * one pass — the name index walked once, covering, each object probed in
 * the rings that serve it: a row per object and one per membership, about
 * 135 k on production's 38 k objects and 97 k memberships (2026-09-29) —,
 * the names grouped in the index's order and summed per combination. Counted again only when a head has moved since
 * the counts in settings were taken: between two releases the rings
 * serve the same objects, so the numbers cannot change, and a view reads
 * the heads (four rows) and the kept counts (one). The first view after a
 * release pays the pass; two views at once may both pay it, and the last
 * to finish is kept — the same numbers.
 */
export async function browseCounts(env: Env, meter?: Meter): Promise<BrowseCounts> {
  const headRows = measured(meter, await env.DB.prepare(`SELECT ring, release_id FROM ring_heads WHERE ring IN (${ringsSql(PROMOTED_RINGS)})`).all<{ ring: string; release_id: number }>());
  const heads: Record<string, number | null> = Object.fromEntries(PROMOTED_RINGS.map((r) => [r, headRows.results.find((h) => h.ring === r)?.release_id ?? null]));
  const kept = measured(meter, await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(SETTINGS_KEY).all<{ value: string }>()).results[0];
  if (kept) {
    try {
      const was = JSON.parse(kept.value) as BrowseCounts;
      if (PROMOTED_RINGS.every((r) => was.heads?.[r] === heads[r]) && was.counts) return was;
    } catch {
      // A value that is not ours any more is counted again and replaced.
    }
  }
  // A flag per ring, architecture and origin for every name, then a sum per combination: a name counts once however many objects it has.
  const flags: { col: string; ring: Ring; arch: string; origin: (typeof BROWSE_ORIGINS)[number] }[] = [];
  for (const ring of PROMOTED_RINGS) for (const arch of REPO_ARCHES) for (const origin of BROWSE_ORIGINS) flags.push({ col: `f_${ring}_${arch}_${origin}`, ring, arch, origin });
  const combos: { key: string; cols: string[] }[] = [];
  for (const ring of ["all", ...BROWSE_RINGS] as BrowseRing[])
    for (const arch of ["all", ...REPO_ARCHES] as BrowseArch[])
      for (const origin of ["all", ...BROWSE_ORIGINS] as BrowseOrigin[])
        combos.push({
          key: `${ring}/${arch}/${origin}`,
          cols: flags.filter((f) => (ring === "all" || f.ring === ring) && (arch === "all" || f.arch === arch) && (origin === "all" || f.origin === origin)).map((f) => f.col),
        });
  // The name index walked whole, covering, the names in its order (so none is sorted); a flag is one ring, one architecture, one origin, and its probe of ring_packages' primary key runs only for an object of that architecture and origin — the AND stops before it otherwise — so an object costs its index row and a row per ring that serves it. Joined to the memberships instead, either way round, the same count read about twice the rows (45 to 55 k against 25 k over 10 k objects and 15 k memberships, 2026-09-29); test/browse.test.ts bounds this one.
  const perName = flags.map((f) => `MAX(p.repo_arch = ${archSql(f.arch)} AND p.source ${f.origin === "factory" ? "=" : "!="} 'factory' AND EXISTS (SELECT 1 FROM ring_packages m WHERE m.ring = ${ringsSql([f.ring])} AND m.package_id = p.id)) AS ${f.col}`);
  const row = measured(
    meter,
    await env.DB.prepare(
      `SELECT ${combos.map((c, i) => `SUM(${c.cols.join(" OR ")}) AS c${i}`).join(", ")}
         FROM (SELECT p.name, ${perName.join(", ")} FROM packages p INDEXED BY idx_packages_name_repo_arch_source GROUP BY p.name)`,
    ).all<Record<string, number | null>>(),
  ).results[0] ?? {};
  const out: BrowseCounts = { heads, counts: Object.fromEntries(combos.map((c, i) => [c.key, Number(row[`c${i}`] ?? 0)])) };
  measured(meter, await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").bind(SETTINGS_KEY, JSON.stringify(out)).run());
  return out;
}

/** One object of a name on the page, with the rings picked that serve it. */
interface ObjectRow {
  id: number;
  name: string;
  version: string;
  repo_arch: string;
  source: string;
  created_at: string;
  description: string | null;
  rings: Ring[];
}

/**
 * The names of one page, in the page's order, and whether there is more
 * past its last row in the direction it was walked. One extra row is
 * asked for to know that.
 */
async function pageNames(env: Env, q: BrowseQuery, meter?: Meter): Promise<{ names: string[]; cursor: (string | number)[]; more: boolean; matched?: number }> {
  const take = q.limit + 1;
  const backward = q.before !== null;
  // The factory's objects are a handful among tens of thousands: read through the source index rather than walked past.
  const factory = q.origin === "factory";
  if (q.q) {
    // A search: one pass over the table (the description is in the manifest), every match grouped by name and counted, then the page. The names that hold the words come first when sorting by name — the name itself, a name that starts with it, one that holds it — as the search Home's box orders them.
    // The words are found with instr() over lower() — the case of ASCII letters aside, as LIKE's is — not with LIKE: D1 refuses a LIKE pattern over 50 bytes, so a pasted sentence or a long factory name (a hundred characters) was a 500 with the database's words on the page; instr() takes the words as they are, % and _ included, at any length. What a row reads is the same: the table was scanned either way.
    const order = q.sort === "recent" ? "newest DESC" : "tier, p.name";
    const from = factory ? "packages p INDEXED BY idx_packages_source" : "packages p NOT INDEXED";
    const where = `(instr(lower(p.name), lower(?1)) > 0 OR instr(lower(json_extract(p.manifest_json, '$.description')), lower(?1)) > 0) AND ${candidate("p", q)}`;
    const rows = measured(
      meter,
      await env.DB.prepare(
        `SELECT p.name, MAX(p.id) AS newest,
                MIN(CASE WHEN lower(p.name) = lower(?1) THEN 0 WHEN instr(lower(p.name), lower(?1)) = 1 THEN 1 WHEN instr(lower(p.name), lower(?1)) > 0 THEN 2 ELSE 3 END) AS tier,
                COUNT(*) OVER () AS matched
           FROM ${from}
          WHERE ${where}
          GROUP BY p.name ORDER BY ${order} LIMIT ?2 OFFSET ?3`,
      ).bind(q.q, q.limit, (q.page - 1) * q.limit).all<{ name: string; newest: number; matched: number }>(),
    ).results;
    let matched = rows[0]?.matched;
    // A page past the last match has no row to carry the count: asked for once more, the same pass (only an address the pager did not give lands there).
    if (matched === undefined) matched = q.page > 1 ? Number(measured(meter, await env.DB.prepare(`SELECT COUNT(DISTINCT p.name) AS n FROM ${from} WHERE ${where}`).bind(q.q).all<{ n: number }>()).results[0]?.n ?? 0) : 0;
    return { names: rows.map((r) => r.name), cursor: [], more: q.page * q.limit < matched, matched };
  }
  if (q.sort === "name") {
    // A–z: the name index walked from the cursor, a name once however many objects it has, stopped at the page's last.
    const from = factory ? "packages p INDEXED BY idx_packages_source" : "packages p INDEXED BY idx_packages_name_repo_arch_source";
    const cursor = backward ? "p.name < ?1 AND " : q.after !== null ? "p.name > ?1 AND " : "?1 IS NULL AND ";
    const rows = measured(
      meter,
      await env.DB.prepare(`SELECT DISTINCT p.name FROM ${from} WHERE ${cursor}${candidate("p", q)} ORDER BY p.name ${backward ? "DESC" : "ASC"} LIMIT ?2`)
        .bind(backward ? q.before : q.after, take)
        .all<{ name: string }>(),
    ).results.map((r) => r.name);
    const names = rows.slice(0, q.limit);
    return { names: backward ? names.reverse() : names, cursor: backward ? rows.slice(0, q.limit).reverse() : names, more: rows.length > q.limit };
  }
  // Recent: the table walked by id from the cursor down (an object's id grows with its arrival, so this is the order objects entered the pool), each name at its newest candidate — an older object of a name whose newer one the rings also serve is stepped over — stopped at the page's last.
  const from = factory ? "packages p INDEXED BY idx_packages_source" : "packages p NOT INDEXED";
  const cursor = backward ? "p.id > ?1 AND " : q.after !== null ? "p.id < ?1 AND " : "?1 IS NULL AND ";
  const rows = measured(
    meter,
    await env.DB.prepare(
      `SELECT p.id, p.name FROM ${from}
        WHERE ${cursor}${candidate("p", q)}
          AND NOT EXISTS (SELECT 1 FROM packages n INDEXED BY idx_packages_name_repo_arch_source WHERE n.name = p.name AND n.id > p.id AND ${candidate("n", q)})
        ORDER BY p.id ${backward ? "ASC" : "DESC"} LIMIT ?2`,
    )
      .bind(backward ? Number(q.before) : q.after !== null ? Number(q.after) : null, take)
      .all<{ id: number; name: string }>(),
  ).results;
  const page = rows.slice(0, q.limit);
  const ordered = backward ? page.reverse() : page;
  return { names: ordered.map((r) => r.name), cursor: ordered.map((r) => r.id), more: rows.length > q.limit };
}

/**
 * Every object of the page's names that a ring picked serves: from the
 * names through the name index (a CROSS JOIN, so the planner cannot start
 * from a ring instead), with a probe per ring picked — which ring serves
 * which object decides the version shown and where the row's link opens.
 */
async function objectsOf(env: Env, names: string[], q: BrowseQuery, meter?: Meter): Promise<ObjectRow[]> {
  if (!names.length) return [];
  const rings = ringsOf(q.ring);
  const rows = measured(
    meter,
    await env.DB.prepare(
      `SELECT p.id, p.name, p.version, p.repo_arch, p.source, p.created_at, json_extract(p.manifest_json, '$.description') AS description,
              ${rings.map((r) => `EXISTS (SELECT 1 FROM ring_packages m WHERE m.ring = ${ringsSql([r])} AND m.package_id = p.id) AS in_${r}`).join(", ")}
         FROM json_each(?1) j
         CROSS JOIN packages p INDEXED BY idx_packages_name_repo_arch_source ON p.name = j.value
        WHERE ${servedIn("p", rings)}`,
    )
      .bind(JSON.stringify(names))
      .all<Record<string, unknown>>(),
  ).results;
  return rows.map((r) => ({
    id: Number(r.id), name: String(r.name), version: String(r.version), repo_arch: String(r.repo_arch), source: String(r.source), created_at: String(r.created_at),
    description: r.description == null ? null : String(r.description),
    rings: rings.filter((ring) => Number(r[`in_${ring}`]) === 1),
  }));
}

/**
 * A name's row from its objects. The candidates are the objects the
 * filters keep (ring, origin, architecture); the squares are every
 * architecture the name has among the objects the ring and the origin
 * keep, so a list of x86_64 still shows where else the name is served.
 * The version shown is on the architecture picked, else the first of
 * REPO_ARCHES that has one: in one ring, the build pacman takes (the
 * include's order, sourceRank); in every ring, the newest.
 */
function rowOf(name: string, objects: ObjectRow[], q: BrowseQuery): BrowseRow | null {
  const kept = objects.filter((o) => o.name === name && o.rings.length && (q.origin === "all" || (q.origin === "factory") === (o.source === "factory")));
  const cands = kept.filter((o) => q.arch === "all" || o.repo_arch === q.arch);
  if (!cands.length) return null;
  const arch = q.arch !== "all" ? q.arch : REPO_ARCHES.find((a) => cands.some((o) => o.repo_arch === a))!;
  const onArch = cands.filter((o) => o.repo_arch === arch);
  const newest = (list: ObjectRow[]) => list.reduce((a, b) => (b.id > a.id ? b : a));
  const shown = q.ring === "all" ? newest(onArch) : onArch.reduce((a, b) => (sourceRank(b.source) < sourceRank(a.source) || (sourceRank(b.source) === sourceRank(a.source) && b.id > a.id) ? b : a));
  const ring = RINGS_BY_STABILITY.find((r) => shown.rings.includes(r))!;
  return {
    name,
    description: shown.description ?? "",
    version: shown.version,
    ring,
    arch: shown.repo_arch,
    source: shown.source,
    arches: REPO_ARCHES.filter((a) => kept.some((o) => o.repo_arch === a)),
    updated_at: newest(cands).created_at,
  };
}

/**
 * Where the pool has a name the rings do not serve: the factory's
 * registration of it (any status — a name registered is reserved, and its
 * page tells its story), else a build of it in the lab — the places the ⌘K
 * menu asks before it offers Request "<name>" (layout.ts GO_MENU: the
 * factory's names, then the package's own address, which answers from the
 * lab too). Two point reads — factory_packages' primary key, then the name
 * index with a probe of the lab's key — only for a search that matched
 * nothing, and kept at the edge with the answer.
 */
async function heldElsewhere(env: Env, name: string, meter?: Meter): Promise<BrowseHeld | null> {
  const reg = measured(meter, await env.DB.prepare("SELECT status FROM factory_packages WHERE name = ?").bind(name).all<{ status: string }>()).results[0];
  if (reg) return { name, where: reg.status, arch: REPO_ARCHES[0] };
  const lab = measured(
    meter,
    await env.DB.prepare(`SELECT p.repo_arch FROM packages p INDEXED BY idx_packages_name_repo_arch_source WHERE p.name = ? AND EXISTS (SELECT 1 FROM ring_packages m WHERE m.ring = ${ringsSql(["lab"])} AND m.package_id = p.id) LIMIT 1`).bind(name).all<{ repo_arch: string }>(),
  ).results[0];
  return lab ? { name, where: "lab", arch: lab.repo_arch } : null;
}

/** The list for a query: the counts, the page's names, their objects, the rows, and the two steps. */
export async function browse(env: Env, query: BrowseQuery, meter?: Meter): Promise<BrowseAnswer> {
  const counts = await browseCounts(env, meter);
  let q = query;
  let found = await pageNames(env, q, meter);
  // Walked back to the start, the page is the first one: drawn as the first page is, from the start and full, with no step before it.
  if (q.before !== null && !found.more) {
    q = { ...q, before: null, page: 1 };
    found = await pageNames(env, q, meter);
  }
  const objects = await objectsOf(env, found.names, q, meter);
  const packages = found.names.map((n) => rowOf(n, objects, q)).filter((r): r is BrowseRow => r !== null);
  const count = found.matched ?? counts.counts[`${q.ring}/${q.arch}/${q.origin}`] ?? 0;
  const pages = Math.max(1, Math.ceil(count / q.limit));
  const first = found.cursor[0], last = found.cursor[found.cursor.length - 1];
  // The page before: by its number for a search, else before this page's first row — or the first page, when this one is the first or has no row to step back from (a cursor past the end).
  const back = (page: number): BrowseStep => (page <= 1 ? {} : q.q ? { page } : first === undefined ? {} : { before: String(first), page });
  let next: BrowseStep | null = null, prev: BrowseStep | null = null;
  if (q.q) {
    next = found.more ? { page: q.page + 1 } : null;
    // Past the last match (an address the pager did not give), the step back is the last page, not the empty one before this.
    prev = q.page > 1 ? back(Math.min(q.page - 1, pages)) : null;
  } else if (q.before !== null) {
    // Walked backward: there is more before (else it would be the first page, above), and the page it came from after.
    prev = back(q.page - 1);
    next = packages.length ? { after: String(last), page: q.page + 1 } : null;
  } else {
    next = found.more ? { after: String(last), page: q.page + 1 } : null;
    prev = q.after !== null ? back(q.page - 1) : null;
  }
  // Nothing matched a search with no filter: a name the pool has elsewhere is shown there rather than offered as a request (the ⌘K menu's rule). A list with a filter offers to clear it instead (pages/browse.ts), so it asks nothing.
  const name = q.q.toLowerCase();
  const held = !count && q.q && q.ring === "all" && q.arch === "all" && q.origin === "all" && BROWSE_NAME.test(name) ? await heldElsewhere(env, name, meter) : null;
  return {
    q: q.q, ring: q.ring, arch: q.arch, origin: q.origin, sort: q.sort, page: q.page, limit: q.limit,
    total: counts.counts["all/all/all"] ?? 0,
    count,
    pages,
    packages,
    next,
    prev,
    held,
  };
}

export async function handleBrowse(url: URL, env: Env): Promise<Response> {
  const { query, problems } = browseQuery(url.searchParams);
  if (problems.length) return json({ error: problems.join("; ") }, 400);
  // Five minutes at the edge: what the list shows moves when a ring's head does, about 30 times a day (the header above).
  return json(await browse(env, query), 200, { "cache-control": "public, max-age=300" });
}
