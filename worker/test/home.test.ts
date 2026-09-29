/**
 * The Pool (#243), drawn: the served page's own script run over the
 * fixture (runScript in test/fixture.ts) with the Worker's real answers, as
 * a browser on the dashboard gets them. The four numbers are the stats':
 * the pool's names, today's arrivals into edge, the stable release, the
 * sources in sync; the chain lists every source by its project with what
 * edge serves from it; New in the pool this week is the rings' newest
 * releases against their parents — only releases retention keeps whole, so
 * a diff never rebuilds one — one card per name; Requested is the
 * factory's newest names, none blocked; Live is the journal's newest lines
 * less the ones that repeat another or changed nothing, a line that arrived
 * since the last poll lit; the search box asks what the ⌘K menu asks and
 * offers Request only for a name found nowhere; the setup card writes the
 * command or the words for an agent for the picked ring. And the page's own
 * CSS keeps the kit's rules: square, no shadow, no gradient, and the
 * chain's squares standing still, evenly spaced, for a reader who asked for
 * less motion.
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

/** The served Home, run with the Worker's answers; `asked` is every path its script fetched, in order. */
async function home(functions: string[] = [], variables: string[] = []): Promise<Ran & { asked: string[] }> {
  const asked: string[] = [];
  const res = await real("/");
  expect(res.status).toBe(200);
  const ran = runScript(scriptOf(await res.text()), {
    pathname: "/", functions, variables,
    fetch: (path, init) => { asked.push(path); return path === "/auth/me" ? Promise.resolve(Response.json({ error: "no session" }, { status: 401 })) : real(path, init); },
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

  it("New in the pool this week: each ring's head against its parent, at the Packages page's address, one card per name, the most stable ring's first", async () => {
    const d = await home();
    const stats = await json("/api/v1/stats");
    const heads = PROMOTED_RINGS.map((r) => stats.rings.find((x: { ring: string }) => x.ring === r).release).filter((h: { parent_id: number | null } | null) => h && h.parent_id);
    // Only the heads: the fixture shows fewer than KEEP_RELEASES releases of each ring, so the one before a head is not known to be kept and is never asked about.
    expect(d.asked.filter((p) => p.includes("/diff?")).sort()).toEqual(heads.map((h: { ring: string; id: number; parent_id: number }) => `/api/v1/releases/${h.ring}/diff?from=${h.parent_id}&to=${h.id}`).sort());
    expect(d.asked).toContain(`/api/v1/releases/stable/diff?from=${F.previousRelease}&to=${F.release}`);
    const cards = [...d.nodes["#pool-new"].innerHTML.matchAll(/<a class="op-card (\w+) home-pkg" href="([^"]+)"[^>]*><span class="h"><b>([^<]+)<\/b>[\s\S]*?<span class="src">([^<]+)<\/span><span class="a">([^<]+)<\/span>/g)].map((m) => ({ ring: m[1], href: m[2], name: m[3], source: m[4], arch: m[5] }));
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

  it("Requested: the factory's names, newest first, none blocked, five at most", async () => {
    const d = await home();
    const rows = (await json("/api/v1/factory/packages")).packages as { name: string; created_at: string; blocked_at: string | null }[];
    const want = rows.filter((p) => !p.blocked_at).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5).map((p) => p.name);
    expect(want.length).toBeGreaterThan(0);
    expect(rows.some((p) => p.blocked_at), "the fixture blocks a package").toBe(true);
    const chips = [...d.nodes["#pool-asked"].innerHTML.matchAll(/data-name="([^"]+)"/g)].map((m) => m[1]);
    expect(chips).toEqual(want);
    expect(d.nodes["#pool-asked"].innerHTML.startsWith("<span>Requested</span>")).toBe(true);
    expect(d.nodes["#pool-asked"].hidden).toBe(false);
  });

  it("Live: the newest lines less a job's own, a dispatch and a sync that changed nothing; each said in its word and hue; a line that arrived since the last poll lit", async () => {
    const d = await home(["feed"]);
    const now = Date.now(), at = (s: number) => new Date(now - s * 1000).toISOString();
    const ev = (id: number, kind: string, extra: Record<string, unknown> = {}) => ({ id, kind, status: "ok", ring: null, source: null, summary: `${kind} ${id}: what happened`, payload: {}, created_at: at(id), ...extra });
    const events = [
      ev(1, "job"), ev(2, "dispatch"), ev(3, "sync", { ring: "edge", payload: { uploaded: 0, removed: 0 } }),
      ev(4, "sync", { ring: "edge", payload: { uploaded: 3 } }), ev(5, "promote", { ring: "stable" }), ev(6, "health", { ring: "rc", status: "error" }),
      ev(7, "fast-track", { ring: "stable" }), ev(8, "role", { summary: "m2 is maintainer" }), ev(9, "sync", { status: "warn", payload: { uploaded: 0 } }),
    ];
    // Drawn twice, as two polls with the same answer: nothing new the second time.
    d.feed({ events });
    d.feed({ events });
    const rows = () => [...d.nodes["#live-feed"].innerHTML.matchAll(/<button type="button" class="home-ev ([^"]*)" data-id="(\d+)"[^>]*>[\s\S]*?<span class="t">([\s\S]*?)<\/span><span class="e">([^<]*)<\/span><\/button>/g)].map((m) => ({ cls: m[1], id: Number(m[2]), text: m[3], word: m[4] }));
    let drawn = rows();
    expect(drawn.map((r) => r.id)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(drawn.map((r) => [r.cls, r.word])).toEqual([["edge", "synced → edge"], ["stable", "promoted → stable"], ["fail", "rc failed"], ["warn", "security fix → stable"], ["", "role"], ["warn", "synced"]]);
    expect(drawn[0].text).toBe("<b>sync 4</b><span>what happened</span>");
    expect(drawn[4].text).toBe("<b>m2 is maintainer</b>");
    // All nine are today's: there were more than the stats carry.
    expect(d.nodes["#live-count"].textContent).toBe("9+ events today");
    // The next poll brings one more: it alone is lit.
    d.feed({ events: [ev(10, "promote", { ring: "rc", created_at: at(0) }), ...events] });
    drawn = rows();
    expect(drawn.filter((r) => r.cls.includes("op-fresh")).map((r) => r.id)).toEqual([10]);
    // What a line says is escaped.
    d.feed({ events: [ev(11, "sync", { summary: "<img src=x>: <b>", payload: { uploaded: 1 } })] });
    expect(d.nodes["#live-feed"].innerHTML).toContain("<b>&lt;img src=x&gt;</b><span>&lt;b&gt;</span>");
  });

  it("the search box asks the menu's search, finds a name where the menu finds it, and offers Request only for a name found nowhere", async () => {
    const d = await home(["lookFor"]);
    const results = () => d.nodes["#pool-results"].innerHTML as string;
    d.lookFor(F.pkg);
    for (let i = 0; i < 3; i++) await settled();
    expect(d.asked).toContain(`/api/v1/search?q=${F.pkg}&ring=stable&arch=${REPO_ARCHES[0]}&limit=9`);
    expect(results()).toContain(`<a class="r" href="/package/${F.pkg}?ring=stable&amp;arch=${REPO_ARCHES[0]}"><b>${F.pkg}</b>`);
    expect(results()).toContain("synced · Arch core");
    expect(results()).not.toContain("Request it");
    // A factory name the search does not find (mine waits for its publish): the menu's registry says it is one, drawn as only in the pool — no Request, and no package page asked.
    const before = d.asked.length;
    d.lookFor(F.factoryPkg);
    for (let i = 0; i < 3; i++) await settled();
    expect(results()).toContain(`<b>${F.factoryPkg}</b>`);
    expect(results()).toContain("factory · only in the pool");
    expect(results()).not.toContain("Request it");
    expect(d.asked.slice(before).some((p) => p.startsWith("/api/v1/package/"))).toBe(false);
    // Nowhere: the name on each architecture at the package page's own address, then Request, to the request form with the name.
    const from = d.asked.length;
    d.lookFor("zzfoo");
    for (let i = 0; i < 4; i++) await settled();
    expect(d.asked.slice(from)).toEqual([`/api/v1/search?q=zzfoo&ring=stable&arch=${REPO_ARCHES[0]}&limit=9`, ...REPO_ARCHES.map((a) => `/api/v1/package/zzfoo?ring=stable&arch=${a}`)]);
    expect(results()).toBe('<div class="none"><span>No “zzfoo” yet.</span><a href="/request?name=zzfoo">Request it →</a></div>');
    // Words that are no pacman name: nothing to request, the whole search a link away.
    d.lookFor("no such words");
    for (let i = 0; i < 3; i++) await settled();
    expect(results()).toContain("Nothing in stable matches “no such words”.");
    expect(results()).toContain('href="/packages?q=no%20such%20words"');
    expect(results()).not.toContain("Request it");
  });

  it("the setup card writes the command or the words for an agent, for the ring picked, with its copy button", async () => {
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
  });

  it("keeps the kit's rules in its own CSS: square, no shadow, no gradient, focus in green, and the chain still for less motion", async () => {
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
    // The squares move by animation only; their places without it are the rule's own, evenly along the line — and the frame stops every animation for a reader who asked for less motion.
    expect(css).toMatch(/\.home-track b \{[^}]*left: 16%;[^}]*animation: home-flow var\(--dur\) linear infinite;/);
    expect(css).toContain(".home-track b + b { left: 47%;");
    expect(css).toContain(".home-track b + b + b { left: 78%;");
    expect(styles[0]).toContain("@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }");
  });
});
