/**
 * Lists rendered from their source, never copied: the request's four
 * confirmations (CHECKLIST) on the form and in the factory chapter, the
 * categories on Governance (CATEGORIES), the sources table on How it works
 * (EXPECTED_SOURCES), the pacman.conf sample on Get started (the API's own
 * include, served and fetched), the cost cadence and the budget's lines
 * (cost.ts) on the API page and the Pipeline, the journal's kinds
 * (JOURNAL_KINDS), the jobs a maintainer may queue (JOB_KINDS, held to the
 * switch's own cases in jobs.ts) and the late threshold (LATE_AFTER_HOURS)
 * on the API page, the categories the auditing agent is told to choose
 * from (factory/prompts/audit.md, held to CATEGORIES), and the API page's
 * endpoint rows against the routes the router serves under /api/v1 — read
 * from index.ts's own source, as the reachability test reads the html routes;
 * the rings, the architectures, the severities and the alive threshold
 * (meta.ts) spliced into the shell and read by every page script, none
 * typing a list of its own; the Workers page's pool kinds (JOB_KINDS).
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { CHECKLIST } from "../src/request";
import { CATEGORIES } from "../src/categories";
import { EXPECTED_SOURCES, JOURNAL_KINDS, LATE_AFTER_HOURS, PROMOTED_RINGS, REPO_ARCHES, RINGS_BY_STABILITY, RINGS_UPWARD, SEVERITIES, UPSTREAMS, WORKER_ALIVE_MINUTES } from "../src/meta";
import { sourceBoxes } from "../src/pages/diagrams";
import { JOB_KINDS } from "../src/jobs";
import { BUDGET_CAP_USD, BUDGET_GUARD_USD, BUDGET_WARN_USD, ESTIMATE_CADENCE } from "../src/cost";
import { DOCUMENTED_ROUTES } from "../src/pages/api-docs";
import { escapeHtml } from "../src/html";
import { allComponents } from "../src/pages/components";
import { HELPERS } from "../src/pages/layout";
import { CHARTS } from "../src/pages/charts";
import { ownScriptOf, scriptOf, seedDashboard, type Fixture } from "./fixture";
import routerSource from "../src/index.ts?raw";
import jobsSource from "../src/jobs.ts?raw";
import factorySource from "../src/routes/factory.ts?raw";
import usersSource from "../src/routes/users.ts?raw";
import metricsSource from "../src/metrics.ts?raw";
import schedulerSource from "../src/scheduler.ts?raw";
import auditPrompt from "../../factory/prompts/audit.md";

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const text = async (path: string): Promise<string> => {
  const res = await get(path);
  expect(res.status, path).toBe(200);
  return res.text();
};

let F: Fixture;
beforeAll(async () => {
  F = await seedDashboard(env);
});

describe("lists come from the code that owns them", () => {
  it("the request form's boxes and the factory chapter's four things are CHECKLIST's sentences", async () => {
    const form = await text("/request");
    const keys = Object.keys(CHECKLIST);
    expect(keys.length).toBe(4);
    for (const [key, sentence] of Object.entries(CHECKLIST)) {
      expect(form, key).toContain(`data-check="${key}"`);
      expect(form, key).toContain(`> ${escapeHtml(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`)}</label>`);
    }
    expect(form.match(/data-check="/g)?.length, "one box per confirmation").toBe(keys.length);
    const chapter = await text("/docs/factory");
    for (const sentence of Object.values(CHECKLIST)) expect(chapter).toContain(escapeHtml(sentence));
    expect(chapter).not.toContain("<!-- checklist -->");
  });

  it("the categories on Governance are CATEGORIES, in its order", async () => {
    const page = await text("/docs/governance");
    expect(page).toContain(`one of a fixed list: ${CATEGORIES.map((c) => `<code>${c}</code>`).join(", ")}.`);
  });

  // The auditing agent is told the categories in its prompt, as a JSON union of quoted names: the one hand copy of CATEGORIES outside the Worker, held here so a name added on either side fails by name.
  it("the audit prompt's category line is CATEGORIES, in its order", () => {
    const line = auditPrompt.split("\n").find((l) => l.trim().startsWith('"category":'));
    expect(line, 'a "category": line in factory/prompts/audit.md').toBeDefined();
    expect([...line!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).slice(1)).toEqual([...CATEGORIES]);
  });

  it("the API page's rows read the journal's kinds, the job kinds and the late threshold from the code", async () => {
    const api = await text("/api");
    expect(api).toContain(`The journal, one line per ${JOURNAL_KINDS.filter((k) => k !== "all").join(", ")};`);
    expect(api).toContain(`Queue a pool job by hand (${JOB_KINDS.join(", ")})`);
    expect(api).toContain(`older than the pool's one threshold, ${LATE_AFTER_HOURS} hours)`);
    // JOB_KINDS is the switch in handleQueueJob, case for case: a kind added to one and not the other fails here, not on a maintainer's terminal.
    const cases = [...jobsSource.slice(jobsSource.indexOf("switch (b.kind)")).matchAll(/case "([a-z]+)":/g)].map((m) => m[1]).sort();
    expect(cases).toEqual([...JOB_KINDS].sort());
  });

  it("the sources table on How it works has one row per source and architecture of EXPECTED_SOURCES", async () => {
    const page = await text("/docs/how-it-works");
    const table = page.slice(page.indexOf('<section id="sources">'), page.indexOf('<section id="stages">'));
    const rows = [...table.matchAll(/<tr><td><code>([^<]+)<\/code>(?: <span class="muted">optional<\/span>)?<\/td><td>[^]*?<\/td><td>([^<]+)<\/td>/g)].map((m) => `${m[1]}/${m[2]}`);
    expect(rows).toEqual(EXPECTED_SOURCES.map((e) => `${e.source}/${e.arch}`));
    const signed = [...table.matchAll(/<tr><td><code>[^<]+<\/code>(?: <span class="muted">optional<\/span>)?<\/td><td>[^]*?<\/td><td>[^<]+<\/td><td>([^]*?)<\/td>/g)].map((m) => m[1]);
    expect(signed.length).toBe(EXPECTED_SOURCES.length);
    EXPECTED_SOURCES.forEach((e, i) => {
      expect(table, e.source).toContain(escapeHtml(e.title));
      if (e.optional) expect(table, e.source).toContain(`<code>--with ${e.source}</code>`);
      // The keyring is the upstream's, UPSTREAMS' word: never an empty cell.
      expect(signed[i].replace(/<\/?code>/g, ""), `${e.source}/${e.arch} signed with`).toBe(escapeHtml(UPSTREAMS[e.upstream].keyring));
    });
    // The sources figure above the table is the same list: every source but the factory's in exactly one box of its upstream, the box saying the upstream's keyring, and the page's live groups are the boxes' rows.
    const boxes = sourceBoxes();
    for (const e of EXPECTED_SOURCES.filter((x) => x.upstream !== "the factory")) expect(boxes.filter((b) => b.entries.includes(e)).length, `${e.source}/${e.arch} in one box`).toBe(1);
    const figure = page.slice(page.indexOf('<div class="chart"'), page.indexOf('<section id="sources">'));
    for (const b of boxes) {
      expect(figure, b.id).toContain(`data-live="${b.id}"`);
      expect(figure, b.id).toContain(`>${escapeHtml(b.keyring)}</text>`);
      expect(figure, b.id).toContain(`>${escapeHtml(b.sources)}</text>`);
    }
    expect(scriptOf(page)).toContain(`var GROUPS = ${JSON.stringify(Object.fromEntries(boxes.map((b) => [b.id, b.entries.map((e) => [e.source, e.arch])])))};`);
  });

  it("Get started is served with the include the API answers for the pick, and its script asks the same route", async () => {
    const api = await text(`/api/v1/pacman.conf?ring=stable&arch=${F.arch}`);
    expect(api).toContain("[omarchy-core-stable]");
    const page = await text(`/docs/get-started?ring=stable&arch=${F.arch}`);
    const served = /<span id="conf-text">([^]*?)<\/span><\/pre>/.exec(page)?.[1];
    expect(served, "the sample").toBe(escapeHtml(api).replace(/^\[(.+)\]$/gm, "[<b>$1</b>]"));
    // The default pick is the same page.
    expect((await text("/docs/get-started")).includes(served!)).toBe(true);
    // The page took the include through the API's edge cache, under the address its script fetches: the API answers that address from the cache now, and the page's script starts knowing it has the served pick's answer.
    expect((await get(`/api/v1/pacman.conf?ring=stable&arch=${F.arch}&with=`)).headers.get("x-pool-cache")).toBe("hit");
    expect(scriptOf(page)).toContain(`var confKey = "stable|${F.arch}|", confSeq = 0;`);
    // A ring with no release yet (rc: the fixture releases stable and edge) is served with the words the script would write, not an include invented on the page.
    const rc = await get("/api/v1/pacman.conf?ring=rc&arch=x86_64");
    expect(rc.status).toBe(404);
    const rcPage = await text("/docs/get-started?ring=rc");
    expect(rcPage).toContain('<span id="conf-text"><span class="c"># loading what the ring serves…</span></span>');
    expect(scriptOf(rcPage)).toContain('var confKey = "", confSeq = 0;');
    // The script derives nothing: no section, no SigLevel line of its own — the route, with the pick and the optional sources, is what it writes from.
    const script = scriptOf(page);
    expect(script).toContain('fetch("/api/v1/pacman.conf?ring=" + ring + "&arch=" + arch + "&with=" + withOptional.join(","))');
    expect(script).not.toContain("SigLevel");
    expect(script).not.toContain("data.rings");
  });

  it("the cost cadence and the budget's three lines are cost.ts's on the API page and the Pipeline", async () => {
    expect(ESTIMATE_CADENCE).toBe("every three hours");
    const api = await text("/api");
    expect(api).toContain(`Estimated ${ESTIMATE_CADENCE}; the lines: warn at US$ ${BUDGET_WARN_USD}, pause at US$ ${BUDGET_GUARD_USD}, cap US$ ${BUDGET_CAP_USD}.`);
    const pipeline = await text("/pipeline");
    expect(pipeline).toContain(`Cloudflare, estimated ${ESTIMATE_CADENCE} from its analytics`);
    expect(pipeline).toContain(`Estimated ${ESTIMATE_CADENCE}; the report warns from US$`);
    expect(scriptOf(pipeline)).toContain(`no estimate yet (${ESTIMATE_CADENCE})`);
    const runbook = await text("/docs/runbook");
    expect(runbook).toContain(`the cost estimate (${ESTIMATE_CADENCE}) it does itself`);
    expect(runbook).toContain(`The brain estimates the month's bill ${ESTIMATE_CADENCE} from`);
    expect(runbook).not.toContain("estimate-cadence");
  });

  /**
   * The lists every page script needs — the rings, the architectures, the
   * severities, the alive threshold — are meta.ts's, spliced into the shell
   * once by page(); a page reads them and types none. Thirteen sites in
   * eight page modules typed the rings by hand before this test (the Pool's
   * cards, Get started's picker, Security's chart, Status's tables, the
   * Pipeline's heads, How it works, the Factory's badges, the health grid),
   * and one manifest pinned the copy, so CI enforced the duplicate: a ring
   * added to meta.ts reached /packages and the API and nothing else.
   */
  const RING = "(?:stable|rc|edge|lab)", ARCH = "(?:x86_64|aarch64)";
  const RING_LIST = new RegExp(`\\[\\s*"${RING}"(?:\\s*,\\s*"${RING}")+\\s*\\]`), ARCH_PAIR = new RegExp(`\\[\\s*"${ARCH}"\\s*,\\s*"${ARCH}"\\s*\\]`), SEV_LIST = /\[\s*"critical"\s*,\s*"high"[^\]]*\]/;

  it("no page script types the rings, the architectures or the severities: the shell splices meta.ts's lists and every page reads them", async () => {
    // The shell holds no list either — placeholders, filled by page() — and serves each one as meta.ts has it.
    expect(HELPERS).toContain("var PROMISED_RINGS = __PROMISED_RINGS__;");
    expect(HELPERS).toContain("var ARCHES = __ARCHES__;");
    expect(HELPERS).toContain("var SEVERITIES = __SEVERITIES__;");
    expect(HELPERS).toContain("var RINGS_UPWARD = Object.keys(RINGS_TEXT).reverse();");
    expect(HELPERS).toContain("var PROMISED_UPWARD = PROMISED_RINGS.slice().reverse();");
    for (const src of [HELPERS, CHARTS]) { expect(src).not.toMatch(RING_LIST); expect(src).not.toMatch(ARCH_PAIR); expect(src).not.toMatch(SEV_LIST); }
    const promised = RINGS_BY_STABILITY.filter((r) => (PROMOTED_RINGS as readonly string[]).includes(r));
    const pages = [...new Set(allComponents(F).map((c) => c.page))];
    expect(pages.length).toBeGreaterThan(20);
    const typed: string[] = [];
    for (const path of pages) {
      const html = await text(path), script = scriptOf(html), own = ownScriptOf(html);
      expect(own, `${path} carries the shell`).not.toBeNull();
      expect(script, `${path} PROMISED_RINGS`).toContain(`var PROMISED_RINGS = ${JSON.stringify(promised)};`);
      expect(script, `${path} ARCHES`).toContain(`var ARCHES = ${JSON.stringify(REPO_ARCHES)};`);
      expect(script, `${path} SEVERITIES`).toContain(`var SEVERITIES = ${JSON.stringify(SEVERITIES)};`);
      if (RING_LIST.test(own!)) typed.push(`${path} types a ring list: ${RING_LIST.exec(own!)![0]}`);
      if (ARCH_PAIR.test(own!)) typed.push(`${path} types the architectures`);
      if (SEV_LIST.test(own!)) typed.push(`${path} types the severities`);
    }
    expect(typed, typed.join("\n")).toEqual([]);
    // The served lists, run: the reader's order stable first, the climb the other way, every ring the way a package climbs, the lab last to first.
    const lists = new Function([/^  var RINGS_TEXT = [^\n]*$/m.exec(scriptOf(await text("/")))![0], "var PROMISED_RINGS = " + JSON.stringify(promised) + ";", /^  var RINGS_UPWARD = [^\n]*$/m.exec(HELPERS)![0], /^  var PROMISED_UPWARD = [^\n]*$/m.exec(HELPERS)![0], "return { up: RINGS_UPWARD, pup: PROMISED_UPWARD };"].join("\n"))() as { up: string[]; pup: string[] };
    expect(lists.up).toEqual([...RINGS_UPWARD]);
    expect(lists.pup).toEqual([...PROMOTED_RINGS]);
    // Each page reads the list it means — every ring where a reader picks one, the promised ones where a check or a scan covers them — and its manifest pins the read, not a literal.
    const components = allComponents(F);
    for (const [path, id, literal] of [
      ["/", "pool.get-started-step", "RINGS = Object.keys(RINGS_TEXT)"],
      ["/docs/get-started", "docs-get-started.ring-picker", "RINGS = Object.keys(RINGS_TEXT)"],
      ["/packages", "packages.ring-arch-pickers", "RINGS = Object.keys(RINGS_TEXT)"],
      ["/security", "security.pickers", "RINGS = PROMISED_RINGS"],
      ["/security", "security.per-ring-chart", "stacked(PROMISED_UPWARD"],
      ["/pipeline", "pipeline.ring-heads", "PROMISED_RINGS.map(function (n)"],
      ["/pipeline", "pipeline.arch-diagram", 'live("heads", PROMISED_UPWARD.map(function (n)'],
      ["/status", "status.rings-table", "PROMISED_RINGS.forEach(function (ring)"],
      ["/docs/how-it-works", "how-it-works.sources-diagram", "PROMISED_RINGS.forEach(function (n)"],
      ["/factory", "factory.landed", "RINGS_UPWARD.map(function (r)"],
    ] as const) {
      expect(ownScriptOf(await text(path)), `${path} reads ${literal}`).toContain(literal);
      const c = components.find((x) => x.id === id);
      expect(c, id).toBeDefined();
      expect(c!.script, `${id} pins the read`).toContain(literal);
      expect(c!.script?.some((l) => RING_LIST.test(l) || ARCH_PAIR.test(l)), `${id} pins a literal`).toBe(false);
    }
    // The architectures' first is every default: a picker's, pkgHref's, the build dialogs' choice of workers, the Pool's search. No page and not the shell types "x86_64" as a fallback — `|| "x86_64"`, `: "x86_64"`, `?? "x86_64"` — in any spelling. The one typed word is the shell's NULL_SOURCE_ARCH, the architecture of a health row the journal wrote without one: a data rule, read by name where a source is missing.
    const typedDefault = /(?:\|\||\?\?|[?:]) "x86_64"/;
    expect(HELPERS).not.toMatch(typedDefault);
    expect(HELPERS).toContain('var NULL_SOURCE_ARCH = "x86_64";');
    expect(HELPERS).toContain("arch && arch !== \"all\" ? arch : ARCHES[0]");
    expect(HELPERS).toContain("opts.arch || ARCHES[0]");
    expect(HELPERS).toMatch(/source === NULL_SOURCE_ARCH|e\.source \|\| NULL_SOURCE_ARCH/);
    for (const path of ["/", "/factory", "/review", "/pipeline", "/packages", "/security", "/status", "/workers", "/journal", "/request", "/people", "/docs/get-started", `/package/${F.pkg}`, `/build/${F.projectTask}`, `/user/${F.owner}`]) {
      const own = ownScriptOf(await text(path))!;
      expect(own, `${path} types x86_64 as a default`).not.toMatch(typedDefault);
      expect(own, `${path} types the null source's architecture`).not.toMatch(/source \|\| "x86_64"/);
    }
    expect(ownScriptOf(await text(`/user/${F.owner}`))).toContain("arch || ARCHES[0]");
    expect(ownScriptOf(await text("/"))).toContain('pkgHref(p.name, "stable", ARCHES[0])');
    expect(ownScriptOf(await text("/pipeline"))).toContain("h.source || NULL_SOURCE_ARCH");
  });

  it("the Workers page's pool kinds are JOB_KINDS, spliced in — a kind added to jobs.ts lands on the project's card", async () => {
    const script = ownScriptOf(await text("/workers"))!;
    expect(script).toContain(`var POOL_KINDS = ${JSON.stringify(JOB_KINDS)};`);
    expect(script).toContain('POOL_KINDS.indexOf(r.kind) >= 0 ? "project" : "review"');
    expect(script).not.toMatch(/POOL_KINDS = \{/);
    const c = allComponents(F).find((x) => x.id === "workers.kind-cards");
    expect(c?.script, "the manifest pins the splice").toEqual(expect.arrayContaining([`POOL_KINDS = ${JSON.stringify(JOB_KINDS)}`, "POOL_KINDS.indexOf(r.kind)"]));
  });

  it("a worker is alive by one number, WORKER_ALIVE_MINUTES: the listing, a person's page, the snapshot and the scheduler read meta.ts's, the shell's titles say it", async () => {
    expect(WORKER_ALIVE_MINUTES).toBe(10);
    // No server file types the threshold beside the constant: the line each one decides "alive" on reads WORKER_ALIVE_MINUTES (or the listing's aliveSince, which does), and no line subtracts ten minutes from now on its own — the scheduler's slot grace adds ten and is another number.
    for (const [name, src, reads] of [
      ["routes/factory.ts", factorySource, ["return at - WORKER_ALIVE_MINUTES * 60000;", ".bind(new Date(alive).toISOString())", "alive: Date.parse(w.last_seen) > since,"]],
      ["routes/users.ts", usersSource, ["const alive = aliveSince()", "workers.results.map((w) => workerView(w, alive, pool))"]],
      ["metrics.ts", metricsSource, ["const alive = new Date(now.getTime() - WORKER_ALIVE_MINUTES * 60000).toISOString();"]],
      ["scheduler.ts", schedulerSource, [".bind(new Date(now.getTime() - WORKER_ALIVE_MINUTES * 60000).toISOString())"]],
    ] as const) {
      for (const r of reads) expect(src, `${name} reads ${r}`).toContain(r);
      expect(src, `${name} types the threshold`).not.toMatch(/-\s*10 \* 60000|-\s*600000\b|-\s*600e3\b/);
    }
    // The shell: the number spliced, the titles read it, no "ten minutes" typed.
    expect(HELPERS).toContain("var WORKER_ALIVE_MINUTES = __WORKER_ALIVE_MINUTES__;");
    expect(HELPERS).not.toMatch(/ten minutes|10 minutes/);
    const script = scriptOf(await text("/workers"));
    expect(script).toContain(`var WORKER_ALIVE_MINUTES = ${WORKER_ALIVE_MINUTES};`);
    const wtStatus = /^  function wtStatus\(w\) \{[\s\S]*?\n  \}$/m.exec(script)![0], legend = /^  var WT_LEGEND = [^\n]*$/m.exec(script)![0];
    const run = new Function("w", ["function esc(s) { return String(s); } function ago() { return '3h ago'; } var WICON = { native: '', emu: '', shared: '', own: '', log: '' };", `var WORKER_ALIVE_MINUTES = ${WORKER_ALIVE_MINUTES};`, wtStatus, legend, "return { pill: wtStatus(w), legend: WT_LEGEND };"].join("\n"))({ alive: false, last_seen: "2026-01-01T00:00:00Z" }) as { pill: string; legend: string };
    expect(run.pill).toContain(`title="not seen in the last ${WORKER_ALIVE_MINUTES} minutes"`);
    expect(run.legend).toContain(`offline</span> not seen in ${WORKER_ALIVE_MINUTES} minutes`);
  });

  /**
   * The routes the router serves under /api/v1, read from its source: the
   * two functions after the fetch handler (factoryRoutes and api), where a
   * route is `method === "M" && path === "/p"`, the same the other way
   * round, or `path.match(/^\/…$/)) && method === "M"`. A capture that is
   * a choice of words — (approve|reject|build), (block|unblock) — is every
   * one of them as its own route; any other capture is one segment, X.
   */
  function servedRoutes(): string[] {
    const src = routerSource.slice(routerSource.indexOf("async function factoryRoutes("));
    expect(src.length, "the router's api functions").toBeGreaterThan(0);
    const routes = new Set<string>();
    const shapes = (re: string): string[] => {
      let paths = [""];
      for (const seg of re.replace(/^\^/, "").replace(/\$$/, "").split("\\/").slice(1)) {
        const words = /^\(([a-z.\\|]+)\)$/.exec(seg);
        const alts = words && words[1].includes("|") ? words[1].split("|").map((w) => w.replace(/\\\./g, ".")) : seg.startsWith("(") || seg.includes("[") ? ["X"] : [seg.replace(/\\\./g, ".")];
        paths = paths.flatMap((p) => alts.map((a) => `${p}/${a}`));
      }
      return paths;
    };
    for (const m of src.matchAll(/method === "([A-Z]+)" && path === "([^"]+)"/g)) routes.add(`${m[1]} ${m[2]}`);
    for (const m of src.matchAll(/path === "([^"]+)" && method === "([A-Z]+)"/g)) routes.add(`${m[2]} ${m[1]}`);
    for (const m of src.matchAll(/path\.match\(\/(.+?)\/\)\) && method === "([A-Z]+)"/g)) for (const p of shapes(m[1])) routes.add(`${m[2]} ${p}`);
    return [...routes].sort();
  }

  /** A documented route as a shape: `:id`, `<file>` and the like are one segment, X, as a served capture is. */
  const documented = (r: string) => r.replace(/\/(?::[a-z0-9_]+|<[a-z]+>)(?=\/|$)/g, "/X");
  /** A served route matches a documented one segment by segment, X standing for any word — so `:kind` covers the four artifact kinds the router spells out. */
  const covers = (doc: string, served: string) => {
    const [dm, dp] = doc.split(" "), [sm, sp] = served.split(" ");
    if (dm !== sm) return false;
    const a = dp.split("/"), b = sp.split("/");
    return a.length === b.length && a.every((seg, i) => seg === "X" || seg === b[i]);
  };

  it("the API page documents every route the router serves under /api/v1, and nothing it does not", () => {
    const served = servedRoutes();
    expect(served.length).toBeGreaterThan(60);
    const rows = DOCUMENTED_ROUTES.map(documented);
    const undocumented = served.filter((s) => !rows.some((d) => covers(d, s)));
    expect(undocumented, "served under /api/v1 with no row on /api").toEqual([]);
    const gone = DOCUMENTED_ROUTES.filter((r, i) => !served.some((s) => covers(rows[i], s)));
    expect(gone, "a row on /api about a route the router does not serve").toEqual([]);
  });
});
