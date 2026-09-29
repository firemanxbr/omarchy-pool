/**
 * The packages list (#245): GET /api/v1/packages (routes/browse.ts) and
 * the page that draws it (pages/browse.ts). The first blocks read the
 * fixture (test/fixture.ts): stable serves zlib 1:1.3.2-3, xz and zstd,
 * edge the fixed zlib 1:1.3.2-4 and the factory's `ours`, rc nothing — so
 * a filter, an order, a search and a step of the pager each have an
 * answer to name. The page is served with the list drawn, links and a
 * form that work with script off, and its script's renderers write the
 * characters the server's do, run side by side over the same answers.
 * The last block seeds a pool of its own and measures what a view reads —
 * D1's rows_read and the plan of every statement — so a planner or a
 * query that walks the whole index for one page fails here.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { browse, browseCounts, browseQuery, browseSearch, type BrowseAnswer } from "../src/routes/browse";
import { countText, listHtml, packagesHtml, titleHtml } from "../src/pages/browse";
import { GO_ACTIONS, MORE } from "../src/pages/layout";
import { version } from "../src/meta";
import { runScript, scriptOf, seedDashboard, type Fixture } from "./fixture";

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
async function list(query: string): Promise<{ status: number; d: BrowseAnswer & { error?: string } }> {
  const res = await get(`/api/v1/packages${query}`);
  return { status: res.status, d: (await res.json()) as BrowseAnswer & { error?: string } };
}
const names = (d: BrowseAnswer) => d.packages.map((p) => p.name);
/** The rows a page was served with: its links to a package's page outside the scripts (the script's pkRow() writes the same markup). */
const rows = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "").match(/<a class="pk-row"/g)?.length ?? 0;

let F: Fixture;
beforeAll(async () => {
  F = await seedDashboard(env);
});

describe("GET /api/v1/packages over the fixture", () => {
  it("lists a name once over every ring, a–z, with the newest version the rings serve and where its link opens", async () => {
    const res = await get("/api/v1/packages");
    // Five minutes at the edge, under the URL: the page and its script share the copy.
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const d = (await res.json()) as BrowseAnswer;
    expect(d).toMatchObject({ q: "", ring: "all", arch: "all", origin: "all", sort: "name", page: 1, limit: 25, total: 4, count: 4, pages: 1, next: null, prev: null });
    expect(names(d)).toEqual(["ours", "xz", "zlib", "zstd"]);
    // zlib is two objects, stable's and edge's: one row, edge's newer version, opened in edge.
    expect(d.packages.find((p) => p.name === F.pkg)).toMatchObject({ version: "1:1.3.2-4", ring: "edge", arch: F.arch, source: "core", arches: [F.arch], description: `${F.pkg} for the dashboard's tests` });
    expect(d.packages.find((p) => p.name === F.publishedPkg)).toMatchObject({ version: "2.0-1", ring: "edge", source: "factory" });
    for (const p of d.packages) expect(Date.parse(p.updated_at)).toBeGreaterThan(0);
  });

  it("filters by ring, architecture and origin — the version the ring picked serves — and the total stays the pool's", async () => {
    const stable = (await list("?ring=stable")).d;
    expect(names(stable)).toEqual(["xz", "zlib", "zstd"]);
    expect(stable).toMatchObject({ total: 4, count: 3 });
    expect(stable.packages.find((p) => p.name === F.pkg)).toMatchObject({ version: "1:1.3.2-3", ring: "stable" });
    expect(names((await list("?ring=edge")).d)).toEqual(["ours", "zlib"]);
    expect((await list("?ring=rc")).d).toMatchObject({ count: 0, packages: [], next: null, prev: null });
    expect(names((await list("?origin=factory")).d)).toEqual(["ours"]);
    expect(names((await list("?origin=synced")).d)).toEqual(["xz", "zlib", "zstd"]);
    expect(names((await list(`?arch=${F.arch}`)).d)).toEqual(["ours", "xz", "zlib", "zstd"]);
    expect((await list("?arch=aarch64")).d).toMatchObject({ count: 0, packages: [] });
    // The segment's word for every architecture is "both": an address may say it.
    expect((await list("?arch=both")).d).toMatchObject({ arch: "all", count: 4 });
  });

  it("sorts by recency: the newest object a name has in the rings first", async () => {
    expect(names((await list("?sort=recent")).d)).toEqual(["ours", "zlib", "zstd", "xz"]);
    expect(names((await list("?sort=recent&ring=stable")).d)).toEqual(["zstd", "xz", "zlib"]);
  });

  it("searches names and descriptions, the names that hold the words first, and counts what matched", async () => {
    expect((await list("?q=zl")).d).toMatchObject({ q: "zl", count: 1 });
    expect(names((await list("?q=zl")).d)).toEqual(["zlib"]);
    // Every description says "tests"; zstd's name holds "st", so it comes first, then the rest a–z.
    expect(names((await list("?q=st")).d)).toEqual(["zstd", "ours", "xz", "zlib"]);
    expect(names((await list("?q=st&sort=recent")).d)).toEqual(["ours", "zlib", "zstd", "xz"]);
    expect(names((await list("?q=TESTS&ring=stable")).d)).toEqual(["xz", "zlib", "zstd"]);
    // % and _ are the reader's characters, not LIKE's.
    expect((await list("?q=%25%25")).d).toMatchObject({ count: 0, packages: [] });
    expect((await list("?q=zzfoo")).d).toMatchObject({ count: 0, pages: 1, packages: [], next: null, prev: null });
  });

  it("pages a–z and by recency with cursors, both ways, and a search by number", async () => {
    let d = (await list("?limit=1")).d;
    expect([names(d), d.next, d.prev, d.pages]).toEqual([["ours"], { after: "ours", page: 2 }, null, 4]);
    d = (await list("?after=ours&page=2&limit=1")).d;
    expect([names(d), d.next, d.prev]).toEqual([["xz"], { after: "xz", page: 3 }, {}]);
    d = (await list("?after=xz&page=3&limit=1")).d;
    expect([names(d), d.next, d.prev]).toEqual([["zlib"], { after: "zlib", page: 4 }, { before: "zlib", page: 2 }]);
    d = (await list("?before=zlib&page=2&limit=1")).d;
    expect([names(d), d.page, d.next, d.prev]).toEqual([["xz"], 2, { after: "xz", page: 3 }, {}]);
    d = (await list("?after=zlib&page=4&limit=1")).d;
    expect([names(d), d.next]).toEqual([["zstd"], null]);
    // Past the end: nothing on the page, and the step back is the first page.
    d = (await list("?after=zzzz&page=9&limit=1")).d;
    expect([names(d), d.count, d.next, d.prev]).toEqual([[], 4, null, {}]);
    d = (await list("?sort=recent&after=1&page=9")).d;
    expect([names(d), d.next, d.prev]).toEqual([[], null, {}]);
    // Walked back to the start, a page is the first page, drawn full from the start.
    d = (await list("?before=xz&page=7&limit=2")).d;
    expect([names(d), d.page, d.prev, d.next]).toEqual([["ours", "xz"], 1, null, { after: "xz", page: 2 }]);
    // Recency: the cursor is the object's id.
    d = (await list("?sort=recent&limit=2")).d;
    expect(names(d)).toEqual(["ours", "zlib"]);
    const after = d.next!.after!;
    d = (await list(`?sort=recent&limit=2&after=${after}&page=2`)).d;
    expect([names(d), d.next, d.prev]).toEqual([["zstd", "xz"], null, {}]);
    // A search pages by number: its matches are counted in the same pass.
    d = (await list("?q=st&limit=3")).d;
    expect([names(d), d.count, d.pages, d.next, d.prev]).toEqual([["zstd", "ours", "xz"], 4, 2, { page: 2 }, null]);
    d = (await list("?q=st&limit=3&page=2")).d;
    expect([names(d), d.next, d.prev]).toEqual([["zlib"], null, {}]);
    // Past the last match: nothing on the page, still the count, and the step back is the last page — page 4 was as empty as this one.
    d = (await list("?q=st&limit=3&page=5")).d;
    expect([names(d), d.count, d.pages, d.prev]).toEqual([[], 4, 2, { page: 2 }]);
    d = (await list("?q=zl&page=9")).d;
    expect([names(d), d.count, d.prev]).toEqual([[], 1, {}]);
  });

  it("refuses what it does not read, with the reason: one letter, a ring or a value it does not know, two cursors, a cursor with a search", async () => {
    // Outside a search a page's number and its cursor go together, as next and prev give them: a number alone labelled the first page's rows "page 3", a cursor alone called a later page "page 1".
    for (const q of ["?q=z", "?ring=lab", "?ring=nope", "?arch=riscv64", "?origin=aur", "?sort=size", "?page=0", "?page=x", "?limit=101", "?limit=0", "?after=a&before=b", "?q=zl&after=zlib", "?sort=recent&after=zlib", "?page=3", "?sort=recent&page=2", "?after=ours", "?before=zlib&page=1", "?sort=recent&after=5"]) {
      const { status, d } = await list(q);
      expect(status, q).toBe(400);
      expect(d.error, q).toMatch(/\w/);
    }
  });

  it("searches words of any length — D1 refuses a LIKE pattern over 50 bytes, and the search uses none — and never cuts a character in half", async () => {
    // A phrase longer than any pattern D1 takes, from a description, in capitals: found, not a 500.
    const long = "a description long enough that no LIKE pattern D1 takes could hold it";
    const obj = (await env.DB.prepare("INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch) VALUES ('browse-long', 'longword', '1-1', 'x86_64', 'longword-1-1-x86_64.pkg.tar.zst', 1, 1, 1, ?, 'extra', 'extra/x86_64/longword', 'x86_64') RETURNING id").bind(JSON.stringify({ description: long })).first<{ id: number }>())!.id;
    await env.DB.prepare("INSERT INTO ring_packages (ring, package_id) VALUES ('edge', ?)").bind(obj).run();
    try {
      const d = await browse(env, browseQuery(new URLSearchParams({ q: long.toUpperCase() })).query);
      expect([names(d), d.count]).toEqual([["longword"], 1]);
      // % and _ stay the reader's characters: "no_like" is not the description's "no LIKE", which LIKE's _ would have matched.
      expect((await browse(env, browseQuery(new URLSearchParams({ q: "no_like" })).query)).count).toBe(0);
    } finally {
      // Where the fixture was: the object out of the ring and out of the table.
      await env.DB.batch([env.DB.prepare("DELETE FROM ring_packages WHERE package_id = ?").bind(obj), env.DB.prepare("DELETE FROM packages WHERE id = ?").bind(obj)]);
    }
    // Through the router: 60 letters are a search like any other (they were a 500, "LIKE or GLOB pattern too complex").
    const sixty = await list(`?q=${"a".repeat(60)}`);
    expect([sixty.status, sixty.d.count, sixty.d.packages]).toEqual([200, 0, []]);
    // A search is read to its hundredth character, never to half of one: an emoji there was a lone surrogate, and encodeURIComponent threw (a 500 for the page).
    const emoji = "a".repeat(99) + "\u{1F600}";
    const cut = await list(`?q=${encodeURIComponent(emoji + "b")}`);
    expect([cut.status, cut.d.q]).toEqual([200, emoji]);
    const res = await get(`/packages?q=${encodeURIComponent(emoji + "b")}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`value="${emoji}"`);
  });

  it("says where the pool has a name the rings do not serve — the factory's, the lab's — for a search with no filter that found nothing, and asks nothing otherwise", async () => {
    const status = (await env.DB.prepare("SELECT status FROM factory_packages WHERE name = ?").bind(F.factoryPkg).first<{ status: string }>())!.status;
    // mine is the factory's, approved, and no ring serves it: the list finds nothing, and says where the name is.
    expect((await list(`?q=${F.factoryPkg}`)).d).toMatchObject({ count: 0, packages: [], held: { name: F.factoryPkg, where: status, arch: F.arch } });
    expect((await list(`?q=${F.factoryPkg.toUpperCase()}`)).d.held).toMatchObject({ name: F.factoryPkg });
    // A name found nowhere, a filter, a search that is not a name, rows: nothing asked.
    for (const q of ["?q=zzfoo", `?q=${F.factoryPkg}&ring=stable`, `?q=${F.factoryPkg}&origin=factory`, "?q=two%20words", `?q=${F.pkg}`]) expect((await list(q)).d.held, q).toBeNull();
    // A build only in the lab: the lab's, on its architecture.
    const obj = (await env.DB.prepare("INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch) VALUES ('browse-lab', 'labonly', '1-1', 'aarch64', 'labonly-1-1-aarch64.pkg.tar.zst', 1, 1, 1, '{\"description\":\"in the lab\"}', 'alarm', 'alarm/aarch64/labonly', 'aarch64') RETURNING id").first<{ id: number }>())!.id;
    await env.DB.prepare("INSERT INTO ring_packages (ring, package_id) VALUES ('lab', ?)").bind(obj).run();
    try {
      expect((await browse(env, browseQuery(new URLSearchParams("q=labonly")).query)).held).toEqual({ name: "labonly", where: "lab", arch: "aarch64" });
    } finally {
      await env.DB.batch([env.DB.prepare("DELETE FROM ring_packages WHERE package_id = ?").bind(obj), env.DB.prepare("DELETE FROM packages WHERE id = ?").bind(obj)]);
    }
  });

  it("keeps its counts under the heads they were counted at, and counts again once a head moves", async () => {
    await browse(env, browseQuery(new URLSearchParams()).query);
    const kept = await env.DB.prepare("SELECT value FROM settings WHERE key = 'browse_counts'").first<{ value: string }>();
    const was = JSON.parse(kept!.value) as { heads: Record<string, number | null>; counts: Record<string, number> };
    expect(was.counts).toMatchObject({ "all/all/all": 4, "stable/all/all": 3, "edge/all/factory": 1, "rc/all/all": 0, "all/aarch64/all": 0, "all/x86_64/synced": 3 });
    expect(Object.keys(was.counts)).toHaveLength(36);
    // Nothing moved: a view reads the heads and the kept counts, a handful of rows.
    const meter = { rows: 0 };
    expect(await browseCounts(env, meter)).toEqual(was);
    expect(meter.rows).toBeLessThan(10);
    // A release moves edge's head: an object of a new name in the ring, counted at the next view.
    const obj = (await env.DB.prepare(`INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch) VALUES ('browse-new', 'newcomer', '1-1', 'aarch64', 'newcomer-1-1-aarch64.pkg.tar.zst', 1, 1, 1, '{"description":"a newcomer"}', 'alarm', 'alarm/aarch64/newcomer', 'aarch64') RETURNING id`).first<{ id: number }>())!.id;
    const rel = (await env.DB.prepare("INSERT INTO releases (ring, seq, parent_id) SELECT 'edge', MAX(seq) + 1, (SELECT release_id FROM ring_heads WHERE ring = 'edge') FROM releases WHERE ring = 'edge' RETURNING id").first<{ id: number }>())!.id;
    await env.DB.batch([env.DB.prepare("INSERT INTO ring_packages (ring, package_id) VALUES ('edge', ?)").bind(obj), env.DB.prepare("UPDATE ring_heads SET release_id = ? WHERE ring = 'edge'").bind(rel)]);
    try {
      const now = await browseCounts(env);
      expect(now.heads.edge).toBe(rel);
      expect(now.counts).toMatchObject({ "all/all/all": 5, "edge/aarch64/synced": 1, "stable/all/all": 3 });
      // An address no test asked before: the edge keeps every answer for five minutes under its URL.
      const d = (await list("?arch=aarch64&ring=edge")).d;
      expect(d).toMatchObject({ total: 5, count: 1 });
      expect(d.packages).toEqual([expect.objectContaining({ name: "newcomer", ring: "edge", arch: "aarch64", source: "alarm", arches: ["aarch64"] })]);
    } finally {
      // Where the fixture was: back out, so the rest of the file reads it as it was.
      await env.DB.batch([env.DB.prepare("DELETE FROM ring_packages WHERE package_id = ?").bind(obj), env.DB.prepare("UPDATE ring_heads SET release_id = ? WHERE ring = 'edge'").bind(was.heads.edge)]);
    }
    expect((await browseCounts(env)).counts["all/all/all"]).toBe(4);
  });
});

describe("the /packages page", () => {
  const page = async (path: string) => {
    const res = await get(path);
    expect(res.status, path).toBe(200);
    return res.text();
  };

  it("is drawn with the list in it: the total, the rows as links to each package's page, the filters as links, the pager", async () => {
    const html = await page("/packages");
    expect(html).toContain('<h1 class="op-hero"><span id="pk-total" data-n="4">4</span> packages, every one tested</h1>');
    expect(html).toContain(`<a class="pk-row" href="/package/${F.pkg}?ring=edge&amp;arch=${F.arch}"><b class="pk-n">${F.pkg}</b>`);
    expect(html).toContain(`<a class="pk-row" href="/package/${F.pkg2}?ring=stable&amp;arch=${F.arch}">`);
    expect(rows(html)).toBe(4);
    // The factory's package says so, in green, and a synced one names its source in the handoff's words.
    expect(html).toContain('<span class="pk-o f" title="factory"><i class="op-i op-i-factory" style="--op-i-s:13px" aria-hidden="true"></i><span class="pk-sr">from </span><span>factory</span></span>');
    expect(html).toContain('<span class="pk-o" title="Arch core"><i class="op-i op-i-refresh-cw" style="--op-i-s:13px" aria-hidden="true"></i><span class="pk-sr">from </span><span>Arch core</span></span>');
    // A row is one link and the head is not read out: its cells say what they are to a screen reader, out of sight.
    expect(html).toMatch(/<span class="pk-v"><span class="pk-sr">version <\/span>1:1\.3\.2-4<\/span>/);
    expect(html).toMatch(/<span class="pk-u" title="updated [^"]+ UTC"><span class="pk-sr">updated <\/span>\d+[smhd]<span class="pk-sr"> ago<\/span><\/span>/);
    // A filter segment is a labelled group, not one of four navigation landmarks.
    expect(html).toContain('<div class="op-seg" role="group" aria-labelledby="pk-l-ring">');
    expect(html).not.toContain('<nav class="op-seg"');
    expect(html).toContain(`<span class="pk-a" role="img" aria-label="on ${F.arch}, not on aarch64" title="on ${F.arch}, not on aarch64"><i class="op-arch ok"></i><i class="op-arch na"></i></span>`);
    expect(html).toContain('<span class="pk-count pk-all" id="pk-count" aria-live="polite">every ring · both architectures</span>');
    expect(html).toContain('<div class="pk-foot"><span id="pk-at">page 1 of 1</span><span class="pk-pager"><span class="pk-p off" aria-disabled="true">← prev</span><span class="pk-p off" aria-disabled="true">next →</span></span></div>');
    // The filters: a link each, the list's own current; the Ring filter the promised rings, the lab not listed.
    expect(html).toContain('<a href="/packages?ring=stable" rel="nofollow" data-k="ring" data-v="stable">stable</a>');
    expect(html).toContain('<a href="/packages" rel="nofollow" data-k="ring" data-v="all" aria-current="true">all</a>');
    expect(html).toContain('<a href="/packages?sort=recent" rel="nofollow" data-k="sort" data-v="recent">recent</a>');
    expect(html).not.toContain('data-v="lab"');
    // The page is the kit's: its sheet is linked, its title the version column's and a row's pieces are the kit's.
    expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/kit\.[0-9a-f]{8}\.css">/);
  });

  it("works with script off: a filter keeps the search and the other filters, the form keeps the filters, a step keeps them all", async () => {
    const html = await page("/packages?q=zl&ring=stable&limit=1");
    expect(html).toContain('<input type="search" name="q" id="pk-q" value="zl"');
    expect(html).toContain('<input type="hidden" name="ring" value="stable">');
    expect(html).not.toContain('<input type="hidden" name="arch"');
    expect(html).toContain('<a href="/packages?q=zl&amp;ring=stable&amp;arch=x86_64&amp;limit=1" rel="nofollow" data-k="arch" data-v="x86_64">x86_64</a>');
    expect(html).toContain('<a href="/packages?q=zl&amp;limit=1" rel="nofollow" data-k="ring" data-v="all">all</a>');
    expect(html).toContain('<span class="pk-count" id="pk-count" aria-live="polite">1 match</span>');
    expect(html).toContain("<span>in stable</span>");
    const paged = await page("/packages?limit=1");
    // The default list's pages are a crawler's way to every package; a filtered list's are not followed.
    expect(paged).toContain('<a class="pk-p" href="/packages?after=ours&amp;page=2&amp;limit=1" rel="next">next →</a>');
    expect(await page("/packages?limit=1&ring=stable")).toContain('<a class="pk-p" href="/packages?ring=stable&amp;after=xz&amp;page=2&amp;limit=1" rel="next nofollow">next →</a>');
    // The sign-in comes back to the list as it was.
    expect(html).toContain('id="account" href="/auth/github?next=/packages%3Fq%3Dzl%26ring%3Dstable%26limit%3D1"');
  });

  it("offers the request when nothing matches — with the search when it is a name — and says a letter is not a search yet", async () => {
    expect(await page("/packages?q=zzfoo")).toContain('<div class="pk-none"><span>Nothing matches.</span><a href="/request?name=zzfoo">Request "zzfoo" →</a></div>');
    expect(await page("/packages?q=ZZFoo")).toContain('<a href="/request?name=zzfoo">Request "zzfoo" →</a>');
    expect(await page("/packages?q=two%20words")).toContain('<div class="pk-none"><span>Nothing matches.</span><a href="/request">Request a package →</a></div>');
    // A filter that leaves nothing is cleared, not requested around: the name may be on another ring, architecture or origin (zlib is, and wlctl on the other architecture). The search and the order stay.
    expect(await page("/packages?ring=rc")).toContain('<div class="pk-none"><span>Nothing matches these filters.</span><a href="/packages">Clear the filters →</a></div>');
    expect(await page(`/packages?q=${F.pkg}&origin=factory&sort=recent`)).toContain(`<div class="pk-none"><span>Nothing matches these filters.</span><a href="/packages?q=${F.pkg}&amp;sort=recent">Clear the filters →</a></div>`);
    // A name the factory has is its page, not a request (the ⌘K menu's rule): mine is approved and in no ring.
    const status = (await env.DB.prepare("SELECT status FROM factory_packages WHERE name = ?").bind(F.factoryPkg).first<{ status: string }>())!.status;
    const mine = await page(`/packages?q=${F.factoryPkg}`);
    expect(mine).toContain(`<div class="pk-none"><span>${F.factoryPkg} is not in a ring. The factory has it: ${status}.</span><a href="/package/${F.factoryPkg}?ring=stable&amp;arch=${F.arch}">Its page →</a></div>`);
    expect(mine).not.toContain(`/request?name=${F.factoryPkg}`);
    // One letter: the whole list, the letter kept in the box.
    const one = await page("/packages?q=z");
    expect(one).toContain('value="z"');
    expect(one).toContain('<span class="pk-count" id="pk-count" aria-live="polite">type one more letter</span>');
    expect(rows(one)).toBe(4);
    // An address the list does not read is the default list, not an error page.
    const odd = await page("/packages?ring=lab&sort=size&page=zero");
    expect(rows(odd)).toBe(4);
    expect(odd).toContain('data-k="ring" data-v="all" aria-current="true"');
  });

  it("labels a page by the number that goes with its cursor: a number or a cursor alone is the first page", async () => {
    for (const path of ["/packages?page=3&limit=1", "/packages?after=ours&limit=1", "/packages?before=zlib&page=1&limit=1"]) {
      const html = await page(path);
      expect(html, path).toContain('<span id="pk-at">page 1 of 4</span><span class="pk-pager"><span class="pk-p off" aria-disabled="true">← prev</span>');
      expect(html, path).toContain(`<a class="pk-row" href="/package/${F.publishedPkg}?`);
      expect(rows(html), path).toBe(1);
    }
  });

  it("gives a crawler one address per page: the default list's steps forward are followed, a step back (before=) is not", async () => {
    const html = await page("/packages?after=xz&page=3&limit=1");
    expect(html).toContain('<a class="pk-p" href="/packages?before=zlib&amp;page=2&amp;limit=1" rel="prev nofollow">← prev</a><a class="pk-p" href="/packages?after=zlib&amp;page=4&amp;limit=1" rel="next">next →</a>');
    // Back to the first page is its own address, followed.
    expect(await page("/packages?after=ours&page=2&limit=1")).toContain('<a class="pk-p" href="/packages?limit=1" rel="prev">← prev</a>');
  });

  it("says the list did not answer without the database's words, when reading it threw", async () => {
    const broken = { ...env, DB: { prepare: () => { throw new Error("D1_ERROR: a detail no reader should see"); } } } as unknown as typeof env;
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://pool.test/packages?q=unreadable"), broken, ctx);
    await waitOnExecutionContext(ctx);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('<div class="pk-none"><span>The packages list did not answer: internal error.</span><a href="/packages?q=unreadable">Try again →</a></div>');
    expect(html).not.toContain("D1_ERROR");
  });

  it("is one step from Home (All packages →), the footer and the ⌘K menu", async () => {
    expect(await page("/")).toContain('<a class="more-link" href="/packages">All packages →</a>');
    expect(MORE[0]).toEqual({ href: "/packages", label: "Packages" });
    expect(/<footer>[\s\S]*?<\/footer>/.exec(await page("/status"))![0]).toContain('<a href="/packages">Packages</a>');
    expect(GO_ACTIONS.find((a) => a.label === "Browse packages")?.href).toBe("/packages");
    // The Community packages tiles open the factory's packages, not a search for the word "factory" (Request "factory" on this list).
    for (const path of ["/", "/factory"]) expect(scriptOf(await page(path)), path).toContain('"/packages?origin=factory"');
  });

  it("says so when the list did not answer, and offers the same list again", () => {
    const html = packagesHtml("http://pool.test/pool", version(env), { query: browseQuery(new URLSearchParams("ring=stable")).query, typed: "", answer: null, error: "internal error" });
    expect(html).toContain('<div class="pk-none"><span>The packages list did not answer: internal error.</span><a href="/packages?ring=stable">Try again →</a></div>');
    expect(html).toContain("<h1 class=\"op-hero\">Every package in the pool, tested</h1>");
  });

  it("draws from the edge's copy of the address its script asks: the page's own read is the API's cached answer", async () => {
    await page("/packages?origin=factory&sort=recent");
    const res = await get("/api/v1/packages?origin=factory&sort=recent");
    expect(res.headers.get("x-pool-cache")).toBe("hit");
  });

  it("writes in the browser the characters the server writes: the rows, the pager, the empty list, the count, the address", async () => {
    const served = scriptOf(await page("/packages"));
    const js = runScript(served, { pathname: "/packages", functions: ["pkList", "pkCount", "pkTitle", "pkState", "pkQuery"] });
    const now = Date.now();
    for (const q of ["", "?ring=stable", "?origin=factory&sort=recent", "?limit=1", "?after=ours&page=2&limit=1", "?after=xz&page=3&limit=1", "?before=zlib&page=2&limit=1", "?q=zzfoo", "?q=two%20words", "?q=st&limit=3&page=5", "?ring=rc", "?arch=x86_64&limit=2", `?q=${F.factoryPkg}`, `?q=${F.pkg}&origin=factory&sort=recent`]) {
      const d = (await list(q)).d;
      expect(js.pkList(d, now), q).toBe(listHtml(d, now));
      expect(js.pkTitle(d), q).toBe(titleHtml(d));
      for (const typed of ["", "z", d.q]) expect(js.pkCount(d, typed), `${q} ${typed}`).toBe(countText(d, typed));
    }
    // An address read the same way on both sides, written back the same way — the defaults dropped, the order the server's.
    for (const q of ["", "q=zl", "q=z", "ring=stable&arch=aarch64&origin=factory&sort=recent", "sort=recent&ring=edge&after=12&page=3", "before=zlib&page=2", "ring=lab&arch=both&origin=all&sort=size", "limit=10&page=2&q=a%20b", "q=zl&after=zlib", "after=a&before=b", "sort=recent&after=zlib", "limit=500&page=0", "page=3", "after=zlib", "before=xz&page=1", "q=zl&page=3", `q=${encodeURIComponent("a".repeat(99) + "\u{1F600}b")}`]) {
      const s = js.pkState("?" + q);
      expect(js.pkQuery(s, {}), q).toBe(browseSearch(browseQuery(new URLSearchParams(q)).query));
    }
  });
});

describe("what a view reads", () => {
  /**
   * A pool of its own: N names, most on both architectures, each with an
   * older object stable still serves and a newer one rc and edge serve
   * (every fifth name one object in all three), one in 97 built by the
   * factory — so the walk steps over objects no ring picked serves, and a
   * filter has objects to leave out.
   */
  const N = 3000;
  let objects = 0, members = 0;
  beforeAll(async () => {
    const pk: string[] = [], rp: string[] = [];
    let id = 500000;
    for (let i = 1; i <= N; i++) {
      const name = `bulk${String(i).padStart(5, "0")}`;
      for (const arch of ["x86_64", "aarch64"]) {
        if (arch === "aarch64" && i % 3 === 0) continue;
        const src = i % 97 === 0 ? "factory" : arch === "x86_64" ? "extra" : "alarm";
        const old = ++id, cur = ++id;
        for (const [oid, v, d] of [[old, "1-1", "old"], [cur, "2-1", "the"]] as const) pk.push(`(${oid}, 'bulk${oid}', '${name}', '${v}', '${arch}', '${name}-${v}-${arch}.pkg.tar.zst', 1, 1, 1, '{"description":"${d} ${name} tool"}', '${src}', 'bulk/${oid}', '${arch}')`);
        rp.push(`('stable', ${i % 5 === 0 ? cur : old})`, `('rc', ${cur})`, `('edge', ${cur})`);
      }
    }
    const chunk = async (rows: string[], head: string) => { for (let i = 0; i < rows.length; i += 300) await env.DB.prepare(`${head} ${rows.slice(i, i + 300).join(",")}`).run(); };
    await chunk(pk, "INSERT INTO packages (id, sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch) VALUES");
    await chunk(rp, "INSERT INTO ring_packages (ring, package_id) VALUES");
    // New heads, so the counts are counted again over this pool.
    for (const ring of ["edge", "rc", "stable"]) {
      const rel = (await env.DB.prepare("INSERT INTO releases (ring, seq) SELECT ?1, COALESCE(MAX(seq), 0) + 1 FROM releases WHERE ring = ?1 RETURNING id").bind(ring).first<{ id: number }>())!.id;
      await env.DB.prepare("INSERT INTO ring_heads (ring, release_id) VALUES (?, ?) ON CONFLICT (ring) DO UPDATE SET release_id = excluded.release_id").bind(ring, rel).run();
    }
    objects = (await env.DB.prepare("SELECT COUNT(*) AS n FROM packages").first<{ n: number }>())!.n;
    members = (await env.DB.prepare("SELECT COUNT(*) AS n FROM ring_packages WHERE ring != 'lab'").first<{ n: number }>())!.n;
  });

  /** Every statement browse() prepares, with its bindings, through a DB that records them: what EXPLAIN QUERY PLAN is asked about. */
  function recorded(): { e: typeof env; log: { sql: string; binds: unknown[] }[] } {
    const real = env.DB, log: { sql: string; binds: unknown[] }[] = [];
    const wrap = (sql: string, st: D1PreparedStatement, binds: unknown[]): unknown => ({
      bind: (...b: unknown[]) => wrap(sql, st.bind(...b), b),
      all: () => { log.push({ sql, binds }); return st.all(); },
      first: () => { log.push({ sql, binds }); return st.first(); },
      run: () => st.run(),
    });
    return { e: { ...env, DB: { prepare: (sql: string) => wrap(sql, real.prepare(sql), []) } } as unknown as typeof env, log };
  }
  const plan = async (sql: string, binds: unknown[]) => (await env.DB.prepare("EXPLAIN QUERY PLAN " + sql).bind(...binds).all<{ detail: string }>()).results.map((r) => r.detail);

  it("counts every filter in one walk of the name index — a row per object and one per ring that serves it — and only when a head has moved", async () => {
    const meter = { rows: 0 };
    const counts = await browseCounts(env, meter);
    expect(counts.counts["all/all/all"]).toBe(N + 4);
    expect(counts.counts["all/aarch64/all"]).toBe(N - Math.floor(N / 3));
    expect(counts.counts["all/all/factory"]).toBe(Math.floor(N / 97) + 1);
    // Joined to the memberships instead, either way round, the same count read about twice this (routes/browse.ts).
    expect(meter.rows).toBeLessThan(1.1 * (objects + members));
    const again = { rows: 0 };
    await browseCounts(env, again);
    expect(again.rows).toBeLessThan(10);
  });

  it("reads rows by the page, not by the pool, wherever the page is, and every statement goes through an index or the table's own order", async () => {
    await browseCounts(env);
    const views: [string, number][] = [
      ["", 30], ["after=bulk02900&page=117", 30], ["before=bulk01500&page=60", 30], ["ring=stable", 30], ["ring=edge&arch=aarch64", 30],
      ["origin=factory", 60], ["origin=synced", 30], ["sort=recent", 40], ["sort=recent&after=500600&page=90", 40], ["sort=recent&origin=factory&ring=rc", 60],
    ];
    for (const [q, perRow] of views) {
      const { e, log } = recorded();
      const meter = { rows: 0 };
      const d = await browse(e, browseQuery(new URLSearchParams(q)).query, meter);
      expect(d.packages.length, q).toBeGreaterThan(0);
      // Bounded by the page (25 rows), never by the pool's 3,000 names and their objects.
      expect(meter.rows, q).toBeLessThan(perRow * 25);
      // The heads, the kept counts, the page's names and their objects: every statement recorded, so none escapes the checks below.
      expect(log.map((l) => l.sql.trim().split(/\s+/).slice(0, 4).join(" ")), q).toEqual(["SELECT ring, release_id FROM", "SELECT value FROM settings", expect.stringMatching(/^SELECT (DISTINCT p\.name|p\.id, p\.name)/), expect.stringMatching(/^SELECT p\.id, p\.name, p\.version,/)]);
      for (const { sql, binds } of log) {
        if (/FROM (ring_heads|settings)\b/.test(sql)) continue;
        const p = await plan(sql, binds);
        // A ring is only ever probed by its primary key, and the list is found by walking an index or the table in id order, never sorted whole.
        expect(p.filter((l) => /\bm\b/.test(l) && /ring_packages/.test(l)).every((l) => /SEARCH m .*\(ring=\? AND package_id=\?\)/.test(l)), `${q}: ${p.join(" | ")}`).toBe(true);
        expect(p.some((l) => /SCAN m\b/.test(l)), `${q}: ${p.join(" | ")}`).toBe(false);
        if (/SELECT DISTINCT p\.name/.test(sql) && !/idx_packages_source/.test(sql)) expect(p.join(" | "), q).toMatch(/(SCAN|SEARCH) p USING COVERING INDEX idx_packages_name_repo_arch_source/);
        if (/SELECT DISTINCT p\.name|SELECT p\.id, p\.name FROM/.test(sql) && !/idx_packages_source/.test(sql)) expect(p.some((l) => /TEMP B-TREE/.test(l)), `${q}: ${p.join(" | ")}`).toBe(false);
        if (/idx_packages_source/.test(sql)) expect(p.join(" | "), q).toMatch(/SEARCH p USING INDEX idx_packages_source \(source=\?\)/);
      }
    }
  });

  it("reads the table once for a search and ranks what matched — so it costs by how much matches, never the pool twice", async () => {
    // What the bound allows: the scan (a row per object), a probe of each ring picked per object that matched (at most: the OR stops at the first ring that serves it), the matched names grouped, counted and ordered (a few rows each), and the page's objects. A word every description holds, over every ring, reads about 3.7 rows per object here (37 k over 10 k objects) — routes/browse.ts's header gives production's shape.
    for (const [q, rings] of [["q=bulk0123", 3], ["q=tool&ring=stable", 1], ["q=tool", 3], ["q=bulk01&sort=recent&page=3", 3]] as const) {
      const meter = { rows: 0 };
      const d = await browse(env, browseQuery(new URLSearchParams(q)).query, meter);
      expect(d.count, q).toBeGreaterThan(0);
      expect(meter.rows, q).toBeLessThan(objects * (1 + rings) + 4 * d.count + 1000);
    }
    expect((await browse(env, browseQuery(new URLSearchParams("q=bulk0123")).query)).count).toBe(10);
    // A word nothing holds reads the table and nothing else; with no filter, where the pool has the name is two point reads by key.
    const { e, log } = recorded();
    const meter = { rows: 0 };
    const none = await browse(e, browseQuery(new URLSearchParams("q=zzfoo")).query, meter);
    expect([none.count, none.held]).toEqual([0, null]);
    expect(meter.rows).toBeLessThan(objects + 50);
    const held = log.filter((l) => /factory_packages|ring_packages m WHERE m\.ring = 'lab'/.test(l.sql));
    expect(held).toHaveLength(2);
    expect((await plan(held[0].sql, held[0].binds)).join(" | ")).toMatch(/SEARCH factory_packages USING INDEX sqlite_autoindex_factory_packages_1 \(name=\?\)/);
    const lab = (await plan(held[1].sql, held[1].binds)).join(" | ");
    expect(lab).toMatch(/SEARCH p USING COVERING INDEX idx_packages_name_repo_arch_source \(name=\?\)/);
    expect(lab).toMatch(/SEARCH m (EXISTS )?USING COVERING INDEX \w+ \(ring=\? AND package_id=\?\)/);
  });
});
