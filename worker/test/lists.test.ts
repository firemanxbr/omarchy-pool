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
 * from index.ts's own source, as the reachability test reads the html routes.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { CHECKLIST } from "../src/request";
import { CATEGORIES } from "../src/categories";
import { EXPECTED_SOURCES, JOURNAL_KINDS, LATE_AFTER_HOURS, UPSTREAMS } from "../src/meta";
import { sourceBoxes } from "../src/pages/diagrams";
import { JOB_KINDS } from "../src/jobs";
import { BUDGET_CAP_USD, BUDGET_GUARD_USD, BUDGET_WARN_USD, ESTIMATE_CADENCE } from "../src/cost";
import { DOCUMENTED_ROUTES } from "../src/pages/api-docs";
import { escapeHtml } from "../src/html";
import { scriptOf, seedDashboard, type Fixture } from "./fixture";
import routerSource from "../src/index.ts?raw";
import jobsSource from "../src/jobs.ts?raw";
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
