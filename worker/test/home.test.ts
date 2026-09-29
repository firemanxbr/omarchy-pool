/**
 * The Pool (#243), drawn: the served page's own script run over the
 * fixture (runScript in test/fixture.ts) with the Worker's real answers, as
 * a browser on the dashboard gets them. The four numbers are the stats':
 * the pool's names, today's arrivals into edge, the stable release, the
 * sources in sync; the chain lists every source by its project with what
 * edge serves from it; New in the pool is the rings' newest releases
 * against their parents — only releases retention keeps whole, so a diff
 * never rebuilds one — one card per name; Requested is the factory's
 * newest names a maintainer let through, none blocked; Live is the
 * packages moving through the pool — syncs that brought something,
 * promotions, fixes, rollbacks, the factory's publish — from the journal's
 * newest lines and its latest of each kind, a line that arrived since the
 * last poll lit, the day's syncs counted exactly; the search box asks what
 * the ⌘K menu asks, on the other architecture too when the first finds
 * nothing, draws a name the rows do not hold where it is, and offers
 * Request only for a name found nowhere; the setup card writes the command
 * or the words for an agent for the picked ring, and a poll leaves the well
 * alone. And the page's own CSS keeps the kit's rules: square, no shadow,
 * no gradient, focus in green, and the chain's squares moving by transform
 * and standing still, evenly spaced, for a reader who asked for less
 * motion.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { EXPECTED_SOURCES, PROMOTED_RINGS, REPO_ARCHES, RING_TEXT, type Upstream } from "../src/meta";
import { KEEP_RELEASES } from "../src/db";
import { SOURCE_NAME } from "../src/pages/overview";
import { fetchPage, ownScriptOf, runScript, scriptOf, seedDashboard, type Fixture, type Ran } from "./fixture";

let F: Fixture;
beforeAll(async () => {
  F = await seedDashboard(env);
});

async function real(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await fetchPage(new Request(`http://pool.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const json = async (path: string) => (await real(path)).json() as Promise<any>;
const settled = () => new Promise((r) => setTimeout(r, 60));
const num = (n: number) => Number(n || 0).toLocaleString("en-US");

/** The served Home, run with the Worker's answers — or, for a path `canned` holds, that answer instead; `asked` is every path its script fetched, in order. */
async function home(functions: string[] = [], variables: string[] = [], canned: Record<string, unknown> = {}): Promise<Ran & { asked: string[] }> {
  const asked: string[] = [];
  const res = await real("/");
  expect(res.status).toBe(200);
  const ran = runScript(scriptOf(await res.text()), {
    pathname: "/", functions, variables,
    fetch: (path, init) => {
      asked.push(path);
      if (path === "/auth/me") return Promise.resolve(Response.json({ error: "no session" }, { status: 401 }));
      return path in canned ? Promise.resolve(Response.json(canned[path])) : real(path, init);
    },
  });
  for (let i = 0; i < 4; i++) await settled();
  return Object.assign(ran, { asked });
}

describe("the Pool, drawn over the fixture", () => {
  it("counts what the stats say: the pool's names, today's arrivals, the stable release and the sources in sync; the chain lists every project with what edge serves from it", async () => {
    const d = await home();
    const stats = await json("/api/v1/stats");
    expect(d.nodes["#n-pkgs"].textContent).toBe(num(stats.pool.names));
    const today = new Date().toISOString().slice(0, 10), imp = stats.series.imports_daily.find((r: { day: string }) => r.day === today);
    expect(d.nodes["#n-edge"].textContent).toBe("+" + num(imp ? imp.packages : 0));
    const stable = stats.rings.find((r: { ring: string }) => r.ring === "stable").release;
    expect(d.nodes["#n-rel"].textContent).toBe("#" + stable.seq);
    expect(d.nodes["#s-rel"].innerHTML).toContain('<i class="op-live-dot"></i>');
    expect(d.nodes["#s-rel"].innerHTML).toContain("healthy");
    // Every project the pool reads, named once, in the handoff's order; what edge serves from each, the larger architecture of the two for a project on both.
    const upstreams = Object.keys(SOURCE_NAME) as Upstream[];
    expect([...new Set(EXPECTED_SOURCES.map((e) => e.upstream))].sort()).toEqual([...upstreams].sort());
    const expected = upstreams.map((u) => {
      const per: Record<string, number> = {};
      for (const c of stats.coverage) if (EXPECTED_SOURCES.some((e) => e.upstream === u && e.source === c.source && e.arch === c.arch)) per[c.arch] = (per[c.arch] ?? 0) + c.indexed;
      return `<li><span>${SOURCE_NAME[u]}</span><b>${num(Math.max(0, ...Object.values(per)))}</b></li>`;
    });
    expect(d.nodes["#pool-sources"].innerHTML).toBe(expected.join(""));
    // In sync: every repository of a project synced and none late; the factory builds and is never behind. The fixture synced core on x86_64 alone.
    const inSync = upstreams.filter((u) => u === "the factory" || stats.coverage.filter((c: { source: string; arch: string }) => EXPECTED_SOURCES.some((e) => e.upstream === u && e.source === c.source && e.arch === c.arch)).every((c: { last_sync: string | null; late: boolean }) => c.last_sync && !c.late));
    expect(d.nodes["#n-src"].textContent).toBe(`${inSync.length} / ${upstreams.length}`);
    expect(d.nodes["#s-src"].textContent).toBe("not synced yet: Arch Linux, Arch Linux ARM, Chaotic, Omarchy, Asahi, Asahi ALARM");
    expect(d.nodes["#fl-pool"].textContent).toBe(`${num(stats.pool.names)} verified`);
    expect(d.nodes["#fl-stable"].textContent).toBe("#" + stable.seq);
    expect(d.nodes["#fl-rc"].textContent).toBe("no release");
  });

  it("New in the pool: each ring's head against its parent, at the Packages page's address, one card per name, the most stable ring's first", async () => {
    const d = await home();
    const stats = await json("/api/v1/stats");
    const heads = PROMOTED_RINGS.map((r) => stats.rings.find((x: { ring: string }) => x.ring === r).release).filter((h: { parent_id: number | null } | null) => h && h.parent_id);
    // Only the heads: the fixture shows fewer than KEEP_RELEASES releases of each ring, so the one before a head is not known to be kept and is never asked about.
    expect(d.asked.filter((p) => p.includes("/diff?")).sort()).toEqual(heads.map((h: { ring: string; id: number; parent_id: number }) => `/api/v1/releases/${h.ring}/diff?from=${h.parent_id}&to=${h.id}`).sort());
    expect(d.asked).toContain(`/api/v1/releases/stable/diff?from=${F.previousRelease}&to=${F.release}`);
    const cards = [...d.nodes["#pool-new"].innerHTML.matchAll(/<a class="op-card (\w+) home-pkg" href="([^"]+)"[^>]*><span class="h"><b>([^<]+)<\/b>[\s\S]*?<span class="from">([^<]+)<\/span><span class="a">([^<]+)<\/span>/g)].map((m) => ({ ring: m[1], href: m[2], name: m[3], source: m[4], arch: m[5] }));
    // Stable's head added zstd and upgraded xz; edge's added ours, the factory's.
    expect(cards.map((c) => c.name).sort()).toEqual(["ours", "xz", "zstd"]);
    expect(cards.find((c) => c.name === "zstd")).toEqual({ ring: "stable", href: `/package/zstd?ring=stable&amp;arch=${F.arch}`, name: "zstd", source: "Arch Linux", arch: F.arch });
    expect(cards.find((c) => c.name === "ours")).toMatchObject({ ring: "edge", source: "Factory", href: `/package/ours?ring=edge&amp;arch=${F.arch}` });
  });

  it("asks about a release only while retention keeps it and its parent whole, and only this week", async () => {
    const d = await home(["releasesOf"]);
    const now = Date.now(), at = (h: number) => new Date(now - h * 3600e3).toISOString();
    const rel = (id: number, seq: number, parent: number | null, hoursAgo = 1) => ({ id, ring: "edge", seq, parent_id: parent, created_at: at(hoursAgo) });
    const stats = (head: ReturnType<typeof rel>, releases: ReturnType<typeof rel>[]) => ({ rings: [{ ring: "edge", release: head }], releases });
    const ids = (list: { id: number }[]) => list.map((x) => x.id);
    // The cases below are written for retention's three.
    expect(KEEP_RELEASES).toBe(3);
    // Three kept, in a line: the head, and the one before it (its parent is kept too).
    let h = rel(12, 12, 11);
    expect(ids(d.releasesOf(stats(h, [h, rel(11, 11, 10), rel(10, 10, 9)]), "edge"))).toEqual([12, 11]);
    // Two made from one head at once (12 and 13 both from 11): 13 is the head, 11 is kept, 10 is not — the head only.
    h = rel(13, 13, 11);
    expect(ids(d.releasesOf(stats(h, [h, rel(12, 12, 11), rel(11, 11, 10), rel(10, 10, 9)]), "edge"))).toEqual([13]);
    // The head's parent outside the three kept: nothing is asked.
    h = rel(15, 15, 11);
    expect(ids(d.releasesOf(stats(h, [h, rel(14, 14, 12), rel(13, 13, 12), rel(11, 11, 10)]), "edge"))).toEqual([]);
    // Fewer than three of the ring in sight: the head alone, as the Packages page asks.
    h = rel(12, 12, 11);
    expect(ids(d.releasesOf(stats(h, [h, rel(11, 11, 10)]), "edge"))).toEqual([12]);
    // The ring's first release, and a head older than a week: nothing.
    h = rel(1, 1, null);
    expect(ids(d.releasesOf(stats(h, [h]), "edge"))).toEqual([]);
    h = rel(12, 12, 11, 8 * 24);
    expect(ids(d.releasesOf(stats(h, [h, rel(11, 11, 10, 9 * 24), rel(10, 10, 9, 10 * 24)]), "edge"))).toEqual([]);
  });

  it("Requested: the factory's names a maintainer let through, newest first, none blocked, five at most — and none of them typed into the box's placeholder", async () => {
    const d = await home();
    const rows = (await json("/api/v1/factory/packages")).packages as { name: string; created_at: string; landed: boolean; blocked_at: string | null }[];
    const want = rows.filter((p) => p.landed && !p.blocked_at).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5).map((p) => p.name);
    expect(want.length).toBeGreaterThan(0);
    expect(rows.some((p) => p.blocked_at), "the fixture blocks a package").toBe(true);
    // Anyone signed in may ask for any name: one only asked for (disposable and spare are staged, waiting for a maintainer) is not put on the front page.
    const asked = rows.filter((p) => !p.landed && !p.blocked_at).map((p) => p.name);
    expect(asked).toEqual(expect.arrayContaining(["disposable", "spare"]));
    const chips = [...d.nodes["#pool-asked"].innerHTML.matchAll(/data-name="([^"]+)"/g)].map((m) => m[1]);
    expect(chips).toEqual(want);
    for (const name of asked) expect(chips).not.toContain(name);
    // The placeholder offers a name New in the pool drew, a package a ring serves, never a request.
    const cards = [...d.nodes["#pool-new"].innerHTML.matchAll(/<span class="h"><b>([^<]+)<\/b>/g)].map((m) => m[1]);
    expect(cards.length).toBeGreaterThan(0);
    const offered = /· try ([^▌]*)▌?$/.exec(d.nodes["#pool-q"].placeholder);
    expect(offered, `placeholder "${d.nodes["#pool-q"].placeholder}"`).not.toBeNull();
    expect(cards.some((c) => c.startsWith(offered![1])), `placeholder "${d.nodes["#pool-q"].placeholder}"`).toBe(true);
    expect(d.nodes["#pool-asked"].innerHTML.startsWith("<span>Requested</span>")).toBe(true);
    expect(d.nodes["#pool-asked"].hidden).toBe(false);
  });

  it("Live: the packages moving through the pool — a sync that brought or dropped something, a promotion, a security fix, a rollback, the factory's publish — from the journal's newest lines and its latest of each kind, newest first, each in its word and hue; a promotion said twice said once; the day's syncs counted by the daily series; a line that arrived since the last poll lit", async () => {
    const d = await home(["feed"]);
    const now = Date.now(), today = new Date(now).toISOString().slice(0, 10);
    // A line's id grows with time, as the journal's do.
    const ev = (id: number, kind: string, extra: Record<string, unknown> = {}) => ({ id, kind, status: "ok", ring: null, source: null, summary: `${kind} ${id}: what happened`, payload: {}, created_at: new Date(now - (100 - id) * 1000).toISOString(), ...extra });
    const events = [
      ev(20, "role", { summary: "m2 is maintainer" }), ev(19, "health", { ring: "rc", status: "error" }), ev(18, "job"), ev(17, "dispatch"),
      ev(16, "sync", { ring: "edge", payload: { uploaded: 0, removed: 0 } }), ev(15, "sync", { status: "warn", payload: { uploaded: 0 } }),
      // One promotion, two lines: the ring's and the copy's, both naming the release.
      ev(14, "promote", { ring: "stable", summary: "stable serves release 9 (from rc)", payload: { release_id: 9 } }),
      ev(13, "promote", { ring: "stable", summary: "rc → stable#4: 3 packages", payload: { release_id: 9 } }),
      ev(12, "fast-track", { ring: "stable" }), ev(11, "sync", { ring: "edge", payload: { uploaded: 3 } }), ev(10, "rollback", { ring: "rc" }),
      ev(9, "audience"), ev(8, "render", { ring: "stable" }), ev(7, "approve", { ring: "edge" }),
    ];
    // The journal's latest line of each kind: the factory's publish, older than the newest lines, a line those carry already, and a check.
    const latest = [ev(3, "publish", { ring: "edge", summary: "1 archive(s) published → edge#27" }), ev(11, "sync", { ring: "edge", payload: { uploaded: 3 } }), ev(2, "health", { ring: "stable" })];
    const series = { imports_daily: [{ day: today, runs: 12, packages: 3 }] };
    // Drawn twice, as two polls with the same answer (the page's own poll drew the fixture's lines before, so these all arrived since): the second draws nothing — the lines stay as they are, only their ages move.
    d.feed({ events, latest, series });
    const once = d.nodes["#live-feed"].innerHTML;
    d.feed({ events, latest, series });
    expect(d.nodes["#live-feed"].innerHTML).toBe(once);
    const rows = () => [...d.nodes["#live-feed"].innerHTML.matchAll(/<button type="button" class="home-ev ([^"]*)" data-id="(\d+)"[^>]*>[\s\S]*?<span class="t">([\s\S]*?)<\/span><span class="e">([^<]*)<\/span><\/button>/g)].map((m) => ({ cls: m[1].replace(" op-fresh", ""), fresh: m[1].includes("op-fresh"), id: Number(m[2]), text: m[3], word: m[4] }));
    let drawn = rows();
    expect(drawn.map((r) => r.id)).toEqual([14, 12, 11, 10, 3]);
    expect(drawn.map((r) => [r.cls, r.word])).toEqual([["stable", "promoted → stable"], ["warn", "security fix → stable"], ["edge", "synced → edge"], ["fail", "rolled back · rc"], ["", "built in the factory"]]);
    expect(drawn[0].text).toBe("<b>stable serves release 9 (from rc)</b>");
    expect(drawn[2].text).toBe("<b>sync 11</b><span>what happened</span>");
    // The day's syncs, exact, from the daily series — not the lines the stats carry, which a busy day outnumbers.
    expect(d.nodes["#live-count"].textContent).toBe("12 syncs today");
    d.feed({ events, latest, series: { imports_daily: [{ day: "2000-01-01", runs: 4, packages: 1 }] } });
    expect(d.nodes["#live-count"].textContent).toBe("no sync yet today");
    // The next poll brings one more: it alone is lit.
    d.feed({ events: [ev(21, "promote", { ring: "rc", payload: { release_id: 10 } }), ...events], latest, series });
    drawn = rows();
    expect(drawn.map((r) => r.id)).toEqual([21, 14, 12, 11, 10, 3]);
    expect(drawn.filter((r) => r.fresh).map((r) => r.id)).toEqual([21]);
    // What a line says is escaped.
    d.feed({ events: [ev(22, "sync", { summary: "<img src=x>: <b>", payload: { uploaded: 1 } })] });
    expect(d.nodes["#live-feed"].innerHTML).toContain("<b>&lt;img src=x&gt;</b><span>&lt;b&gt;</span>");
    // Nothing moved: said, never a blank panel.
    d.feed({ events: [ev(23, "health")] });
    expect(d.nodes["#live-feed"].innerHTML).toBe('<div><p class="home-quiet">No package moved lately.</p></div>');
  });

  it("the search box asks the menu's search — the other architecture's too when the first finds nothing —, draws a name the rows do not hold where it is, and offers Request only for a name found nowhere, beside the whole search", async () => {
    const [first, other] = REPO_ARCHES;
    const search = (term: string, arch = first) => `/api/v1/search?q=${encodeURIComponent(term)}&ring=stable&arch=${arch}&limit=9`;
    const pkg = (name: string, arch: string) => `/api/v1/package/${name}?ring=stable&arch=${arch}`;
    // Two answers the fixture cannot give: packages on aarch64 alone (Asahi's), and a row on the first architecture that only mentions a factory name.
    const d = await home(["lookFor"], [], {
      [search("asahi", other)]: { packages: [{ name: "linux-asahi", source: "asahi", repo_arch: other, description: "the Asahi kernel" }, { name: "mesa-asahi", source: "asahi", repo_arch: other, description: "" }] },
      [search(F.publishedPkg)]: { packages: [{ name: `${F.publishedPkg}-helper`, source: "extra", repo_arch: first, description: `works with ${F.publishedPkg}` }] },
    });
    const results = () => d.nodes["#pool-results"].innerHTML as string, said = () => d.nodes["#pool-said"].textContent as string;
    const look = async (term: string) => { const from = d.asked.length; d.lookFor(term); for (let i = 0; i < 5; i++) await settled(); return d.asked.slice(from); };

    // A name stable serves: its row, one search, nothing looked up.
    expect(await look(F.pkg)).toEqual([search(F.pkg)]);
    expect(results()).toContain(`<a class="r" href="/package/${F.pkg}?ring=stable&amp;arch=${first}"><b>${F.pkg}</b>`);
    expect(results()).toContain("synced · Arch core");
    expect(results()).not.toContain("Request it");
    expect(said()).toMatch(/^\d+ packages?$/);

    // Packages on aarch64 alone: stable on the first architecture finds nothing, on the other it finds them — drawn with their architecture, and no Request.
    expect(await look("asahi")).toEqual([search("asahi"), search("asahi", other), pkg("asahi", first), pkg("asahi", other)]);
    expect(results()).toContain(`<a class="r" href="/package/linux-asahi?ring=stable&amp;arch=${other}"><b>linux-asahi</b><span class="d">the Asahi kernel</span><span class="o">synced · Asahi</span></a>`);
    expect(results()).not.toContain("Request it");
    expect(said()).toBe("2 packages");

    // A name the rows only mention: looked up at the package page's address, and drawn first where it is — ours, the factory's, in the ring that serves it.
    const ours = await json(pkg(F.publishedPkg, first));
    expect(await look(F.publishedPkg)).toEqual([search(F.publishedPkg), pkg(F.publishedPkg, first)]);
    expect(results().startsWith(`<a class="r" href="/package/${F.publishedPkg}?ring=${ours.shown_ring}&amp;arch=${first}"><b>${F.publishedPkg}</b>`)).toBe(true);
    expect(results()).toContain("factory · only in the pool");
    expect(results()).toContain(`<b>${F.publishedPkg}-helper</b>`);

    // A request no ring serves (mine waits for its publish): the package page's address on each architecture, then the factory's names (read once, for the page) — "not in a ring yet", never "in the pool", and no Request.
    expect(await look(F.factoryPkg)).toEqual([search(F.factoryPkg), search(F.factoryPkg, other), ...REPO_ARCHES.map((a) => pkg(F.factoryPkg, a))]);
    expect(results()).toContain(`<b>${F.factoryPkg}</b>`);
    expect(results()).toContain("factory · not in a ring yet");
    expect(results()).not.toContain("only in the pool");
    expect(results()).not.toContain("Request it");
    // A blocked one says so.
    await look(F.pulledPkg);
    expect(results()).toContain("factory · blocked");

    // Nowhere: stable on both architectures, the name on each at the package page's address, then Request — the request form with the name — beside the whole search.
    expect(await look("zzfoo")).toEqual([search("zzfoo"), search("zzfoo", other), ...REPO_ARCHES.map((a) => pkg("zzfoo", a))]);
    expect(results()).toBe('<div class="none"><span>No “zzfoo” yet.</span><span class="go"><a href="/packages?q=zzfoo">Search all packages →</a><a href="/request?name=zzfoo">Request it →</a></span></div>');
    expect(said()).toBe("No “zzfoo” yet: you can request it");
    // Words that are no pacman name: nothing to request, the whole search a link away.
    expect(await look("no such words")).toEqual([search("no such words"), search("no such words", other)]);
    expect(results()).toContain("Nothing in stable matches “no such words”.");
    expect(results()).toContain('href="/packages?q=no%20such%20words"');
    expect(results()).not.toContain("Request it");
  });

  it("the setup card writes the command or the words for an agent, for the ring picked, with its copy button — and only when the ring or the mode changes", async () => {
    const d = await home(["drawSetup"], ["mode", "ring"]);
    d.setring("rc");
    d.drawSetup();
    expect(d.nodes["#setup-well"].innerHTML).toBe('<code><span class="op-prompt">$ </span>curl -fsSL http://pool.test/setup | sudo bash -s -- --ring rc</code><button type="button" class="op-copy" data-op-copy="">copy</button>');
    expect(d.nodes["#ring-line"].textContent).toBe(`${RING_TEXT.rc.title} · ${RING_TEXT.rc.lag}`);
    expect(d.nodes["#setup-agents"].hidden).toBe(true);
    d.setmode("agent");
    d.drawSetup();
    expect(d.nodes["#setup-well"].innerHTML).toBe('<code><span class="op-prompt">› </span>Set up omarchy-pool on this machine on the rc ring, with the script at http://pool.test/setup. After that I\'ll install packages with pacman as usual.</code><button type="button" class="op-copy" data-op-copy="">copy prompt</button>');
    expect(d.nodes["#setup-agents"].hidden).toBe(false);
    // Nothing changed, nothing written: the well keeps the copy button's focus and its "copied", and a selection a reader is making in it.
    d.nodes["#setup-well"].innerHTML = "as the reader left it";
    d.drawSetup();
    expect(d.nodes["#setup-well"].innerHTML).toBe("as the reader left it");
    // And the stats poll touches only the rings' numbers in the picker, never the well.
    const render = /liveStats\(function \(d\) \{([^}]*)\}/.exec(ownScriptOf(await (await real("/")).text())!)![1];
    expect(render).toContain("ringNumbers(d)");
    expect(render).not.toContain("drawSetup");
  });
});

describe("the Pool as served", () => {
  it("offers the three promised rings, most stable first, the stable command before its script runs, and every agent mark named", async () => {
    const html = await (await real("/")).text();
    const rings = [...html.matchAll(/<button type="button" class="(\w+)" data-ring="\1" aria-pressed="(true|false)">/g)].map((m) => [m[1], m[2]]);
    expect(rings).toEqual([["stable", "true"], ["rc", "false"], ["edge", "false"]]);
    expect(html).toContain('<span class="op-prompt">$ </span>curl -fsSL https://omarchy-pool.org/setup | sudo bash -s -- --ring stable</code>');
    expect([...html.matchAll(/class="op-b op-b-[a-z-]+"[^>]* aria-label="([^"]+)"/g)].map((m) => m[1])).toEqual(["Claude Code", "Codex", "Cursor", "Gemini CLI", "GitHub Copilot", "Grok", "OpenCode", "Qwen Code", "Kimi", "Meta"]);
    // The ⌘K menu's "Set up the pool" lands on the card, and / focuses the box.
    expect(html).toContain('<div class="op-card home-setup" id="get-started">');
    expect(html).toContain('id="pool-q" placeholder="Search the pool\'s packages" aria-label="Find a package" aria-keyshortcuts="/"');
    // The page's own script types no ring, reads the shell's.
    expect(ownScriptOf(html)).not.toMatch(/"stable", "rc", "edge"|\["edge", "rc"/);
    // Every keystroke makes an answer still on its way for an earlier term stale (seq), not only the next search: an answer that lands during the pause is dropped, never drawn under newer text. (The fake document runs no events; the handler is read as served.)
    expect(ownScriptOf(html)).toMatch(/box\.addEventListener\("input", function \(\) \{\s*clearTimeout\(timer\);\s*seq\+\+;/);
    // A searchbox is not a combobox: no aria-expanded on it; what the rows say goes to a status line instead.
    expect(html).not.toMatch(/id="pool-q"[^>]*aria-expanded/);
    expect(ownScriptOf(html)).not.toContain("aria-expanded\", \"true");
  });

  it("keeps the kit's rules in its own CSS: square, no shadow, no gradient, focus in green, a gate's word inside its segment, and the chain moving by transform and still for less motion", async () => {
    const html = await (await real("/")).text();
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    expect(styles).toHaveLength(2);
    const css = styles[1];
    expect(css).toContain("/* ---- the Pool (#243, pages/overview.ts) */");
    for (const m of css.matchAll(/border-radius:\s*([^;}]+)/g)) expect(m[1].trim()).toBe("0");
    expect(css).not.toMatch(/box-shadow|text-shadow|drop-shadow|(?:linear|radial|conic)-gradient\(/);
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-fA-F]{3,6}\b|\b(?:rgba?|hsla?)\(/);
    // The box takes the input's outline away and draws its own line in green around it.
    expect(css).toContain(".home-box:focus-within { border-color: var(--green); }");
    for (const sel of [".home-results a:focus-visible", ".home-own summary:focus-visible", ".home-ev:focus-visible", "a.home-pkg:focus-visible"]) expect(css).toContain(`${sel} { outline: 1px solid var(--green);`);
    // The kit's controls on this page too — the chips, the copy button, the buttons — and its links, never the browser's blue ring; the tabs' line inside the tab, since their row scrolls and clips a line drawn outside it.
    expect(css).toContain(".home-more:focus-visible, .home-ringline a:focus-visible, .home-asked .op-chip:focus-visible, .home-setup .op-copy:focus-visible, .home-own .op-btn:focus-visible { outline: 1px solid var(--green); outline-offset: 2px; }");
    expect(css).toContain(".home-setup .op-tabs > button:focus-visible { outline: 1px solid var(--green); outline-offset: -1px; }");
    // A gate's word ("install") fits its segment at any width: the segment is never narrower than its label, and the chain scrolls instead.
    expect(css).toMatch(/\.home-track \{[^}]*min-width: max-content;/);
    // The squares move by transform, which the compositor runs without laying the page out (animating left laid it out sixty times a second): each rides a box as wide as its line, so 100% is the line. Their places without the animation are the rule's own, evenly along the line — and the frame stops every animation for a reader who asked for less motion.
    expect(css).toMatch(/\.home-track b \{[^}]*width: 100%;[^}]*transform: translateX\(16%\);[^}]*animation: home-flow var\(--dur\) linear infinite;/);
    expect(css).toContain(".home-track b + b { transform: translateX(47%);");
    expect(css).toContain(".home-track b + b + b { transform: translateX(78%);");
    expect(css).toContain("@keyframes home-flow { from { transform: translateX(-8px); } to { transform: translateX(100%); } }");
    expect(styles[0]).toContain("@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }");
  });
});
