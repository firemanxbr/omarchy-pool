/**
 * One truth per fact. The consistency audit (2026-09-18) found the same
 * fact computed two ways on neighbouring pages: a withdrawn approval
 * "landed" on the Factory and "withdrawn" on Review; "waiting for review"
 * counted three ways on three tiles; the package page rewriting ?ring=lab
 * to stable while Review linked to the lab; a source late at six hours in
 * one table and nine in the headline. This file pins the server's one
 * answer to each, over the fixture (test/fixture.ts), so the pages have one
 * number to read and a page that computes its own fails by name. The last
 * block reads the pages: the three tiles that say "waiting for review" read
 * the one field, every package address is written by the shell's pkgHref
 * and the lab chip is drawn from it, no page types the budget's lines or an
 * hour of its own, and the Status page's pill and table are late by the one
 * constant — the served script's functions run here over the server's rows.
 * The second audit (the review of this branch) found three more said two
 * ways — community packages "in the rings", the worker minutes of the week,
 * open advisories in stable — and the last block pins each to one source:
 * the registry's `landed`, one sum over jobs_daily, one count at the
 * Security page's confidence; and one ring for one build, one word for an
 * approval that stands, on every page that draws them. The third audit
 * found the Status page saying the week's jobs two ways on one screen —
 * the tiles from the half-hourly snapshot, the table and the charts from
 * the series beneath, a cancelled job a success on one and a failure on the
 * other — and pins the jobs of the week to one reduce over jobs_daily
 * (jobsSummary), read by the tiles, the table and the charts, and by the
 * Pipeline's chart. The same audit found an advisory's severity coloured by
 * three maps — the shell's pill, the Pool's bars, the Security page's stack
 * — critical + high red on one page and amber on the next, low / unknown in
 * two greys, over the same advisoryCounts; the last block pins the colour
 * to the shell's SEV_COLOR (the pill's class, as the CSS paints it) and the
 * buckets to SEV_BUCKETS, and runs the served charts to see the colour land.
 * The same audit found the 14-day health grid drawn twice — the shell's
 * heatGrid on the Pipeline, an inline copy on Status with the rings the
 * other way round — and a check's result spelled three ways over the same
 * journal rows (ok on the Pool's cards and the Status table, healthy on the
 * Pipeline's pill, healthy / unhealthy on a job, ok / warn / error on one
 * grid and healthy / warning / failed on the other); the last block pins
 * the grid to heatGrid over the shell's PROMISED_RINGS (meta.ts's promoted
 * rings, stable first) and the word to HEALTH_WORD, run as served over the
 * server's rows on both pages, and reads every page that says a result.
 * The review of that branch found the Pipeline's budget panel reading a
 * chart function for the cap (a rename that CI let through: the name
 * existed), the Status tile losing a job queued longer than the week, the
 * Workers page keeping a bucket rule of its own, and four proofs that
 * passed with their rule inverted; the cases below now run the served
 * renderCost over /cost, carry an old queued job through the series, read
 * the shell's jobBucket on every page that buckets a job, and hold each
 * rule with data that tells it from its mutation.
 * The same audit found the Review page holding a copy of the
 * server's waitsForMaintainer as `decidable`, subtracting a maintainer's
 * own rows with it and highlighting by it, with nothing holding the two
 * together: now every row of the list says `waits`, the page reads the
 * field, and the first block runs the served rule over the server's rows.
 * It also found Review's Decided line saying where a standing approval
 * is from the absence of a ring, guessing ["edge"] from the registry's
 * status, while the Factory read the row's blocked_at and publish_status:
 * now the shell's approvalWhere is the one rule, the fixture holds the two
 * states no ring serves (a failed publish, a block), and the second block
 * draws both pages over them.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { RINGS, RINGS_BY_STABILITY } from "../src/index";
import { PROMOTED_RINGS } from "../src/meta";
import { LATE_AFTER_HOURS, RING_TEXT, WORKER_ALIVE_MINUTES } from "../src/meta";
import { waitsForMaintainer, stands } from "../src/routes/review";
import { maintenanceOf } from "../src/routes/users";
import { landed } from "../src/routes/contributors";
import { snapshotMetrics } from "../src/metrics";
import { allComponents } from "../src/pages/components";
import { HELPERS } from "../src/pages/layout";
import { CHARTS } from "../src/pages/charts";
import { ownScriptOf, runScript, scriptOf, seedDashboard, type Fixture } from "./fixture";

let F: Fixture;

beforeAll(async () => {
  F = await seedDashboard(env);
});

async function call(method: string, path: string, as = "", body?: unknown): Promise<{ status: number; headers: Headers; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (as) headers.cookie = `omc=oms_${as}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}

describe("the review list counts what waits, once", () => {
  it("answers `waiting` and `oldest_ms` at the top, by the rule the rows are highlighted with", async () => {
    const r = await call("GET", "/factory/review");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    // Three of alice's builds of mine sit staged and undecided; the approved chain is not listed at all.
    expect(r.json.staged.map((t: { id: number }) => t.id).sort()).toEqual([F.stagedTask, F.disposableTask, F.spareTask].sort());
    expect(r.json.waiting).toBe(3);
    expect(r.json.waiting).toBe(r.json.staged.filter(waitsForMaintainer).length);
    // Every row says it for itself: `waits` is the same rule, and `waiting` is the count of rows that say true — the page reads the field, not the rule.
    for (const t of r.json.staged) expect(t.waits, `#${t.id} waits`).toBe(waitsForMaintainer(t));
    expect(r.json.waiting).toBe(r.json.staged.filter((t: { waits: boolean }) => t.waits === true).length);
    const ages = r.json.staged.map((t: { finished_at: string }) => Date.now() - Date.parse(t.finished_at));
    expect(r.json.oldest_ms).toBeGreaterThan(0);
    expect(Math.abs(r.json.oldest_ms - Math.max(...ages))).toBeLessThan(5000);
  });

  it("a withdrawn approval puts the project's build back in the count; a project build in flight takes a contributor's out", async () => {
    // m1 takes m2's approval of mine back: the project's build waits for a decision again, alice's evidence behind it is listed but not decidable — the project's row is.
    expect((await call("POST", `/factory/tasks/${F.projectTask}/withdraw`, "m1", { note: "taken back by the test" })).status).toBe(200);
    let r = (await call("GET", "/factory/review")).json;
    expect(r.staged.map((t: { id: number }) => t.id).sort()).toEqual([F.contributorTask, F.projectTask, F.stagedTask, F.disposableTask, F.spareTask].sort());
    expect(r.waiting).toBe(4);
    expect(r.staged.find((t: { id: number }) => t.id === F.contributorTask)).toMatchObject({ kind: "contributor", project_build: { id: F.projectTask, status: "staged" } });
    expect(waitsForMaintainer(r.staged.find((t: { id: number }) => t.id === F.contributorTask))).toBe(false);
    expect(waitsForMaintainer(r.staged.find((t: { id: number }) => t.id === F.projectTask))).toBe(true);
    // The oldest waiting row is now the project's build, staged before the three later ones.
    const project = r.staged.find((t: { id: number }) => t.id === F.projectTask);
    expect(Math.abs(r.oldest_ms - (Date.now() - Date.parse(project.finished_at)))).toBeLessThan(5000);
    // m1 has the project build alice's 1.0-2 again: that row is the project's to build now, not a maintainer's to decide.
    expect((await call("POST", `/factory/tasks/${F.stagedTask}/build`, "m1", { note: "built again by the test" })).status).toBe(200);
    r = (await call("GET", "/factory/review")).json;
    expect(r.staged.find((t: { id: number }) => t.id === F.stagedTask).project_build).toMatchObject({ status: "queued" });
    expect(r.waiting).toBe(3);
    expect(r.waiting).toBe(r.staged.filter(waitsForMaintainer).length);
    // The rows moved and each row's word moved with them: the contributor's row behind a project build in flight says false, the project's row says true, the count is theirs.
    for (const t of r.staged) expect(t.waits, `#${t.id} waits`).toBe(waitsForMaintainer(t));
    expect(r.staged.find((t: { id: number }) => t.id === F.stagedTask).waits).toBe(false);
    expect(r.staged.find((t: { id: number }) => t.id === F.projectTask).waits).toBe(true);
    expect(r.waiting).toBe(r.staged.filter((t: { waits: boolean }) => t.waits).length);
  });

  it("the Review page highlights a row and takes a maintainer's own rows out of the number by the row's `waits`, keeping no rule of its own", async () => {
    const r = (await call("GET", "/factory/review")).json as { waiting: number; staged: { id: number; owner: string; waits: boolean }[] };
    const html = await page("/review"), script = scriptOf(html);
    // The served rule, run over the server's rows, is the field: row by row what waitsForMaintainer says — and, the field withheld, nothing is highlighted, because the page has no copy of the rule to fall back on.
    const decidable = served(script, "decidable");
    expect(decidable).not.toMatch(/project_build|already|kind|failed/);
    const rule = new Function("rows", [decidable, "return rows.map(decidable);"].join("\n"));
    expect(rule(r.staged)).toEqual(r.staged.map(waitsForMaintainer));
    expect(r.staged.some((t) => t.waits)).toBe(true);
    expect(rule(r.staged.map(({ waits: _, ...t }) => t))).toEqual(r.staged.map(() => false));
    // The maintainer's number is the list's `waiting` less their own rows that wait, by the same field: the served forMe over the served shown(), as a maintainer who owns rows and as one who owns none — never below zero, never above the list's.
    const forMe = new Function("REVIEW", "me", [decidable, served(script, "folded"), served(script, "shown"), served(script, "forMe"), "var STAGED = REVIEW.staged; function isMaintainer() { return true; } function isOwner(o) { return o === me; }", "return forMe();"].join("\n"));
    const own = r.staged.filter((t) => t.owner === F.owner && t.waits).length;
    expect(own).toBeGreaterThan(0);
    expect(forMe(r, F.owner)).toBe(r.waiting - own);
    expect(forMe(r, F.m1)).toBe(r.waiting);
    // The manifests pin the field on every component that reads it: the queue line, the note and the table.
    for (const id of ["review.yours-queue-line", "review.queue-head", "review.staged-table"]) {
      const c = allComponents(F).find((x) => x.id === id);
      expect(c?.reads?.some((x) => x.path === "/api/v1/factory/review" && x.fields?.includes("staged.0.waits")), `${id} reads waits`).toBe(true);
    }
  });
});

describe("an approval stands or it does not, said once", () => {
  it("GET /factory/approvals carries `standing` on every row: approved and not withdrawn", async () => {
    const before = (await call("GET", "/factory/approvals")).json.approvals as { name: string; decision: string; withdrawn_at: string | null; standing: boolean }[];
    // mine's approval was withdrawn above (the same database); ours stands.
    expect(before.find((a) => a.name === F.publishedPkg)).toMatchObject({ decision: "approved", withdrawn_at: null, standing: true });
    expect(before.find((a) => a.name === F.factoryPkg)).toMatchObject({ decision: "approved", withdrawn_at: expect.any(String), standing: false });
    for (const a of before) expect(a.standing).toBe(stands(a));
    // The row says whether the project's build is on its way: the newest publish job of the approved build, and the package's block — ours' publish job is done (w1 released it into edge), nothing is blocked; a page's "publishing" pill reads these, not the absence of a ring.
    const rows = before as (typeof before[number] & { publish_status: string | null; blocked_at: string | null })[];
    expect(rows.find((a) => a.name === F.publishedPkg)).toMatchObject({ publish_status: "done", blocked_at: null });
    for (const a of rows) { expect(a).toHaveProperty("publish_status"); expect(a).toHaveProperty("blocked_at"); }
  });

  it("where a standing approval is today is one word, the shell's approvalWhere over the row's rings, blocked_at and publish_status — said by the Factory's Landed lately and Review's Decided line alike; no page guesses a ring from the registry's status", async () => {
    type Row = { name: string; task_id: number; standing: boolean; rings: string[]; publish_status: string | null; blocked_at: string | null };
    const rows = (await call("GET", "/factory/approvals")).json.approvals as Row[];
    const served = rows.find((a) => a.name === F.publishedPkg)!, failed = rows.find((a) => a.name === F.failedPkg)!, pulled = rows.find((a) => a.name === F.pulledPkg)!;
    // The three states of an approval that stands: edge serves ours; lost's publish job failed; pulled's block cancelled its job and pulled the package.
    expect(served).toMatchObject({ standing: true, rings: ["edge"], publish_status: "done", blocked_at: null });
    expect(failed).toMatchObject({ standing: true, rings: [], publish_status: "failed", blocked_at: null });
    expect(pulled).toMatchObject({ standing: true, rings: [], publish_status: "cancelled", blocked_at: expect.any(String) });
    // The registry's word for lost is still "approved" — the status the Review line read to promise edge — and no page reads it for this.
    const pkgs = (await call("GET", "/factory/packages")).json.packages as { name: string; status: string }[];
    expect(pkgs.find((p) => p.name === F.failedPkg)).toMatchObject({ status: "approved" });
    for (const path of ["/review", "/factory"]) {
      const own = ownScript(await page(path));
      expect(own, `${path} guesses a ring from the registry`).not.toMatch(/\["edge"\]|status === "published"/);
      expect(own, `${path} words the state on its own`).not.toMatch(/"publishing"|on its way into edge|publish_status ===/);
      expect(own, `${path} reads the shell's word`).toContain("approvalWhere(a)");
    }
    // The shell's rule, out of the served page, over the server's rows and the two states the fixture cannot hold at once.
    const shell = runScript(scriptOf(await page("/review")), { pathname: "/review", functions: ["approvalWhere"] });
    expect(shell.approvalWhere(served)).toMatchObject({ word: "in edge", cls: "ok" });
    expect(shell.approvalWhere(failed)).toMatchObject({ word: "publish failed", cls: "error" });
    expect(shell.approvalWhere(pulled)).toMatchObject({ word: "blocked", cls: "error" });
    expect(shell.approvalWhere({ ...failed, publish_status: "cancelled" })).toMatchObject({ word: "publish cancelled", cls: "error" });
    for (const publish_status of ["queued", "leased", null]) expect(shell.approvalWhere({ ...failed, publish_status }), String(publish_status)).toMatchObject({ word: "publishing", cls: "blue" });
    expect(shell.approvalWhere({ ...served, rings: ["edge", "stable"] })).toMatchObject({ word: "in edge · stable", cls: "ok" });
    // The two pages drawn over the Worker's answers, as the fixture's people see them: the Factory for anyone, Review as dave, whose two packages these are, and as alice, whose ours edge serves.
    const viewer = (login: string) => async (path: string, init?: RequestInit) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`http://pool.test${path}`, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...(login ? { cookie: `omc=oms_${login}` } : {}) } }), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const drawn = async (path: string, login: string) => { const d = runScript(scriptOf(await page(path)), { pathname: path, functions: [], fetch: viewer(login) }); await new Promise((r) => setTimeout(r, 80)); return d; };
    const landed = (await drawn("/factory", "")).nodes["#landed"].innerHTML as string;
    const decided = (await drawn("/review", F.outsider)).nodes["#mine-decided"].innerHTML as string;
    // The pill as the shell draws it from the rule's answer — class and word; the title is left out, since "blocked 0s ago" is a clock read twice (once by the page, once here) and a second boundary between the two reads is not this test's to control.
    const pill = (a: Row) => { const w = shell.approvalWhere(a); return new RegExp(`<span class="pill ${w.cls}" title="[^"]*">${w.word}</span>`); };
    // The row of one package, in the drawn list: the Factory's card (a div.land), Review's line (a div.rrow). The assertions on lost and pulled read their own rows, not the whole list — mine, alice's, may stand approved with its publish queued, and then wears the shell's "publishing" pill by right; whether it does depends on what the tests above did to the database, and this test holds either way (it failed alone, passing only after the withdrawal at the top of the file).
    const rowOf = (html: string, name: string, cls: string, mark = "") => { const m = html.split(`<div class="${cls}`).find((r) => r.includes(`>${name}</`) && r.includes(mark)); expect(m, `a ${cls} row of ${name}`).toBeDefined(); return m!; };
    // Review's Decided holds two rows of pulled — the brake's, then the approval's (marked "approved"); the approval's is the one the rule words.
    // The way out of a row: the Factory card's one link is the name's; Review's line has the package's story on the name and the way out on its `go` link.
    for (const [what, html, cls, mark, out] of [["the Factory's Landed lately", landed, "land", "", ""], ["Review's Decided", decided, "rrow", ">approved</span>", '<a class="go" ']] as const) {
      for (const [name, a] of [[F.failedPkg, failed], [F.pulledPkg, pulled]] as const) {
        const row = rowOf(html, name, cls, mark);
        expect(row, `${what}: ${name}`).toMatch(pill(a));
        // Neither row promises edge: the word for a publish that failed, or a package pulled, is never "publishing".
        expect(row, `${what}: ${name} promises edge`).not.toContain("on its way into edge");
        expect(row, `${what}: ${name} says publishing`).not.toContain(">publishing</span>");
        // In no ring, the way out of both rows is the build — never a package address as if a ring served it (the Factory's card linked /package/lost?ring=stable, a ring no fact supports, while Review's line led to the build).
        expect(row, `${what}: ${name} leads to the build`).toContain(`${out}href="/build/${a.task_id}"`);
        expect(row, `${what}: ${name} leads to a ring`).not.toContain(`${out}href="/package/${name}?`);
      }
    }
    // A standing approval whose publish is queued wears the shell's "publishing" pill on both pages — the shape the two negatives above forbid on lost and pulled, drawn here from the row alone.
    const queued = { ...failed, publish_status: "queued" };
    expect(shell.approvalWhere(queued)).toMatchObject({ word: "publishing", cls: "blue", title: expect.stringContaining("on its way into edge") });
    // ours is served: the Factory's card wears the ring badges and no pill; Review's line says the ring and its way out is the package's one address.
    expect(landed).not.toMatch(pill(served));
    expect(rowOf(landed, F.publishedPkg, "land")).toContain(`href="/package/${F.publishedPkg}?ring=edge&arch=${F.arch}"`);
    const alices = (await drawn("/review", F.owner)).nodes["#mine-decided"].innerHTML as string;
    expect(alices).toMatch(pill(served));
    expect(alices).toContain(`<a class="go" href="/package/${F.publishedPkg}?ring=edge&amp;arch=${F.arch}">`);
    // pulled: the block row and the approval row of the same package say one word — the owner read "blocked" and, a row later, "on its way into edge".
    expect(decided.split(">blocked</span>").length - 1).toBe(2);
  });

  it("a person's page lists the approvals they signed with `standing`, and counts only standing ones as what they maintain", async () => {
    const u = (await call("GET", `/users/${F.m2}`)).json;
    const mine = u.approvals.find((a: { name: string }) => a.name === F.factoryPkg);
    const ours = u.approvals.find((a: { name: string }) => a.name === F.publishedPkg);
    expect(mine).toMatchObject({ decision: "approved", standing: false });
    expect(mine.rings).toBeUndefined();
    expect(ours).toMatchObject({ decision: "approved", standing: true, rings: ["edge"] });
    expect(u.approved_packages).toEqual([F.publishedPkg]);
  });

  it("who stands behind a package names the approval that stands, never a withdrawn one", async () => {
    expect((await maintenanceOf(env, F.publishedPkg, "factory", undefined)).factory).toMatchObject({ owner: F.owner, approved_by: F.m2, maintainers: [F.m1, F.m2] });
    expect((await maintenanceOf(env, F.factoryPkg, "factory", undefined)).factory).toMatchObject({ owner: F.owner, approved_by: null, approved_at: null, approved_version: null, task: null });
  });
});

describe("the rings are RINGS, the lab included", () => {
  it("the reader's order is derived from RINGS and the ring texts keep it", () => {
    expect(RINGS_BY_STABILITY).toEqual(["stable", "rc", "edge", "lab"]);
    expect([...RINGS_BY_STABILITY].sort()).toEqual([...RINGS].sort());
    // Every page script gets RINGS_TEXT from the shell: its keys are the ring list a page needs, in the order a reader picks.
    expect(Object.keys(RING_TEXT)).toEqual(RINGS_BY_STABILITY);
  });

  it("GET /package/:name takes ?ring=lab and shows the most stable ring that has the package, with its edges in that ring", async () => {
    // zlib is in stable and edge; the lab and rc do not serve it.
    const lab = await call("GET", `/package/${F.pkg}?ring=lab&arch=${F.arch}`);
    expect(lab.status).toBe(200);
    expect(lab.json).toMatchObject({ name: F.pkg, ring: "lab", shown_ring: "stable" });
    expect(lab.json.rings.map((r: { ring: string }) => r.ring).sort()).toEqual(["edge", "stable"]);
    // xz declares zlib in stable: the reverse edge is resolved in the shown ring, not in the empty lab.
    expect(lab.json.required_by.map((r: { name: string }) => r.name)).toEqual([F.pkg2]);
    expect((await call("GET", `/package/${F.pkg}?ring=rc&arch=${F.arch}`)).json).toMatchObject({ ring: "rc", shown_ring: "stable" });
    expect((await call("GET", `/package/${F.pkg}?ring=edge&arch=${F.arch}`)).json).toMatchObject({ ring: "edge", shown_ring: "edge" });
    expect((await call("GET", `/package/${F.pkg}?ring=stable&arch=${F.arch}`)).json).toMatchObject({ ring: "stable", shown_ring: "stable", package: { version: "1:1.3.2-3" } });
    expect((await call("GET", `/package/${F.pkg}?ring=nightly&arch=${F.arch}`)).status).toBe(400);
  });

  it("the package page's download link is the object's one address — the row's key, `<pool>/<source>/<arch>/<filename>`, the seal's `object` — never a key built from the arch alone", async () => {
    // The bucket has been laid out per source since the relayout (r2.ts); the page linked `<pool>/<arch>/<filename>`
    // until 2026-09-20 and every download and .sig on every package page was a 404 for four days.
    const page = await call("GET", `/package/${F.pkg}?ring=stable&arch=${F.arch}`);
    expect(page.status).toBe(200);
    expect(page.json.pool_url).toBe(`${env.POOL_URL}/core/${F.arch}/${F.pkg}-1:1.3.2-3-${F.arch}.pkg.tar.zst`);
    expect(page.json.pool_url).toBe(page.json.seal.object);
    // A row indexed before the key column existed links the same address: the key is computed, not the old layout.
    await env.DB.prepare("UPDATE packages SET r2_key = NULL WHERE sha256 = ?").bind(page.json.package.sha256).run();
    const older = await call("GET", `/package/${F.pkg}?ring=stable&arch=${F.arch}`);
    expect(older.json.pool_url).toBe(page.json.pool_url);
    expect(older.json.seal.object).toBe(page.json.pool_url);
    await env.DB.prepare("UPDATE packages SET r2_key = ? WHERE sha256 = ?").bind(`core/${F.arch}/${F.pkg}-1:1.3.2-3-${F.arch}.pkg.tar.zst`, page.json.package.sha256).run();
  });
});

describe("the maintainer set, the late mark and the budget lines are the server's", () => {
  it("GET /factory/maintainers is the one list a page takes a person's role from, cached at the edge", async () => {
    const r = await call("GET", "/factory/maintainers");
    expect(r.status).toBe(200);
    // A miss says the minute; a hit says what is left of it (edgeHit rewrites
    // cache-control from x-pool-expires), which is 59 once the clock has
    // ticked since the copy was stored — the edge cache is shared across the
    // test files of one run, so either answer can be the first one here.
    expect(r.headers.get("x-pool-cache")).toMatch(/^(hit|miss)$/);
    const left = Number(/^public, max-age=(\d+)$/.exec(r.headers.get("cache-control") ?? "")?.[1]);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(60);
    expect(r.json.maintainers.map((m: { login: string }) => m.login)).toEqual([F.m1, F.m2]);
  });

  it("a source is late by one constant, marked on its coverage row — the number lives in meta.ts and nowhere in the answer", async () => {
    let s = (await call("GET", "/stats")).json;
    expect(s.late_after_hours).toBeUndefined();
    const core = () => s.coverage.find((c: { source: string; arch: string }) => c.source === "core" && c.arch === F.arch);
    expect(core()).toMatchObject({ last_sync: expect.any(String), late: false });
    await env.DB.prepare("UPDATE events SET created_at = ? WHERE kind = 'sync' AND source = 'core'").bind(new Date(Date.now() - (LATE_AFTER_HOURS + 1) * 3600e3).toISOString()).run();
    // The edge keeps a cached answer for a minute: a query it has not seen asks the index again.
    s = (await call("GET", "/stats?after=late")).json;
    expect(core().late).toBe(true);
    expect(s.coverage.filter((c: { last_sync: string | null }) => !c.last_sync).every((c: { late: boolean }) => c.late === false)).toBe(true);
  });

  it("GET /cost carries the three lines with and without an estimate", async () => {
    const lines = { warn: 25, guard: 40, cap: 50 };
    expect((await call("GET", "/cost")).json).toMatchObject({ month: "2026-09", lines_usd: lines });
    await env.DB.prepare("DELETE FROM settings WHERE key = 'cost_latest'").run();
    const none = await call("GET", "/cost?after=forgotten");
    expect(none.status).toBe(404);
    expect(none.json).toEqual({ error: "no estimate yet", lines_usd: lines });
  });
});

async function page(path: string): Promise<string> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status, path).toBe(200);
  return res.text();
}

// A page's own statements (the fixture's ownScriptOf): what follows the shell's last lines, the shell proved spliced whole.
function ownScript(html: string): string {
  const own = ownScriptOf(html);
  expect(own, "the shell is spliced whole").not.toBeNull();
  return own!;
}

// A function of the served script, by name, as text: the proofs below run the shell's rule over the server's rows instead of reading the code and trusting it. The shell's functions are one line each.
function served(script: string, name: string): string {
  const m = new RegExp(`^  (?:function ${name}\\(|var ${name} = )[^\\n]*$`, "m").exec(script);
  expect(m, `${name} is served`).not.toBeNull();
  return m![0];
}

describe("the pages read the one answer instead of counting their own", () => {
  // The doors that say how much waits for a maintainer: Review, the Pipeline and the Factory.
  const TILES = { "/review": "review.tiles", "/pipeline": "pipeline.operations-tiles", "/factory": "factory.tiles" } as const;

  it("the Review, Pipeline and Factory tiles say \"waiting for review\" from the review list's own `waiting` and `oldest_ms`, never a count of their own", async () => {
    const components = allComponents(F);
    for (const [path, id] of Object.entries(TILES)) {
      const script = ownScript(await page(path));
      // The tile's number is the field on the object the list answered, and its age the field beside it.
      const tile = /"Waiting for review", num\((\w+(?:\.\w+)?)\.waiting\), \1\.oldest_ms/.exec(script);
      expect(tile, `${path} reads waiting and oldest_ms from one answer`).not.toBeNull();
      // Nothing on the page counts staged rows for that number.
      expect(script, `${path} counts staged rows for the tile`).not.toMatch(/"Waiting for review", num\((?!\w+(?:\.\w+)?\.waiting\))/);
      // The manifest says so: the tile's literal and the field, read from the list.
      const c = components.find((x) => x.id === id);
      expect(c?.script, id).toEqual(expect.arrayContaining(['"Waiting for review"', `${tile![1]}.waiting`, `${tile![1]}.oldest_ms`]));
      expect(c?.reads?.some((r) => r.path === "/api/v1/factory/review" && r.fields?.includes("waiting") && r.fields?.includes("oldest_ms")), `${id} reads waiting from the list`).toBe(true);
    }
  });

  it("every package address a page writes goes through pkgHref, and the page asked for the lab draws the lab chip beside the ring shown", async () => {
    const written: string[] = [];
    for (const path of ["/", "/factory", "/review", "/pipeline", "/packages", `/package/${F.pkg}`, `/build/${F.projectTask}`, `/user/${F.owner}`, "/people", "/workers", "/security", "/status", "/journal", "/request", "/diff"]) {
      const script = ownScript(await page(path));
      // Any string a page's own script starts with the family's prefix is an address written by hand — the shell's footer match on it is the shell's.
      if (/["']\/package\//.test(script)) written.push(path);
    }
    expect(written, `a package address written by hand: ${written.join(", ")}`).toEqual([]);
    // The page asked for the lab: its script keeps the ring (the lab is one of RINGS_TEXT, the server's order) and asks the API for it; the API shows stable, the most stable ring that has zlib; the chips are drawn from the served script — the lab's own address among them, the shown ring lit.
    const html = await page(`/package/${F.pkg}?ring=lab`), script = scriptOf(html), own = ownScript(html);
    expect(own).toContain("RINGS = Object.keys(RINGS_TEXT)");
    expect(own).not.toMatch(/\["stable", "rc", "edge"\]/);
    const d = (await call("GET", `/package/${F.pkg}?ring=lab`)).json;
    expect(d).toMatchObject({ ring: "lab", shown_ring: "stable" });
    const ringLine = /^  var ring = [^\n]*$/m.exec(own)![0], chipLine = /^    \$\("#pg-ring"\)\.innerHTML = [^\n]*$/m.exec(own)![0];
    const draw = new Function("q", "d", "$", [served(script, "RINGS_TEXT"), served(script, "pkgHref"), "var RINGS = Object.keys(RINGS_TEXT);", ringLine, "var arch = 'x86_64';", chipLine, "return ring;"].join("\n"));
    const el = { innerHTML: "" };
    expect(draw(new URLSearchParams("?ring=lab"), d, () => el)).toBe("lab");
    const chips = [...el.innerHTML.matchAll(/<a class="([^"]*)" href="([^"]*)"/g)].map((m) => [m[1], m[2]]);
    expect(chips).toEqual(Object.keys(RING_TEXT).map((r) => [r === "stable" ? "on" : "", `/package/${F.pkg}?ring=${r}&arch=x86_64`]));
  });

  it("no page types the budget's lines or an hour of its own: the lines ride /cost, the hour is the shell's LATE_MS", async () => {
    const typed: string[] = [];
    for (const path of ["/", "/factory", "/review", "/pipeline", "/status", "/workers", "/people", "/security", "/journal"]) {
      const script = ownScript(await page(path));
      if (/US\$\s*(?:25|40|50)\b|\b83\.3\b|\b(?:warn|guard|cap)\b[^;\n]{0,24}\b(?:25|40|50)\b/.test(script)) typed.push(`${path} types a budget line`);
      if (/\b6 \* 3600|\b21600\b|3600e3 \* 6\b|\b9 \* 3600/.test(script)) typed.push(`${path} types an hour`);
    }
    expect(typed, typed.join("\n")).toEqual([]);
    // The Pipeline's budget panel fills its three slots from the answer, with and without an estimate.
    const pipeline = ownScript(await page("/pipeline"));
    for (const slot of ["cost-warn", "cost-guard", "cost-cap"]) expect(pipeline).toContain(`live("${slot}", num(budget.${slot.slice(5)}))`);
    // The shell types no hour either: the constant is spliced in from meta.ts, and the served value is the server's.
    expect(HELPERS).toContain("var LATE_MS = __LATE_AFTER_HOURS__ * 3600e3;");
    expect(HELPERS).not.toMatch(/var LATE_MS = \d/);
    expect(scriptOf(await page("/status"))).toContain(`var LATE_MS = ${LATE_AFTER_HOURS} * 3600e3;`);
  });

  it("the Status page's pill and its sources table are late by the one constant: the served rule, run over the server's rows", async () => {
    const html = await page("/status"), script = scriptOf(html), own = ownScript(html);
    // The table's row and the sentence over it read the shell's; the page has no threshold and no isLate of its own.
    expect(own).toContain("lateSync(c)");
    expect(own).toContain('$("#late-after").textContent = Math.round(LATE_MS / 3600e3)');
    expect(own).not.toMatch(/function isLate|var isLate|last_sync\) >/);
    expect(html).toContain('older than <span id="late-after">…</span> hours');
    // The core sync aged past the constant: the server marks the row, the shell's lateSync agrees with the mark and, the mark withheld, with the same rule over last_sync; problemsOf (the pipeline pill) names the count and the constant.
    await env.DB.prepare("UPDATE events SET created_at = ? WHERE kind = 'sync' AND source = 'core'").bind(new Date(Date.now() - (LATE_AFTER_HOURS + 1) * 3600e3).toISOString()).run();
    const stats = (await call("GET", "/stats?after=status-page")).json;
    const rule = new Function("rows", [served(script, "LATE_MS"), served(script, "lateSync"), "return rows.map(lateSync);"].join("\n"));
    const marked = stats.coverage.map((c: { late: boolean }) => c.late);
    expect(marked.filter(Boolean).length).toBeGreaterThan(0);
    expect(rule(stats.coverage)).toEqual(marked);
    expect(rule(stats.coverage.map(({ late: _, ...c }: { late: boolean }) => c))).toEqual(marked);
    const newest = /^  function newest\(list, kind\) \{[\s\S]*?\n  \}$/m.exec(script)![0], problemsOf = /^  function problemsOf\(d\) \{[\s\S]*?\n  \}$/m.exec(script)![0];
    const pill = new Function("d", [served(script, "LATE_MS"), served(script, "lateSync"), "function ago() { return 'a while ago'; }", newest, problemsOf, "return problemsOf(d);"].join("\n"));
    expect(pill(stats)).toContain(`${marked.filter(Boolean).length} source(s) not synced for ${LATE_AFTER_HOURS} h`);
    expect(Math.round(new Function(served(script, "LATE_MS") + " return LATE_MS / 3600e3;")())).toBe(LATE_AFTER_HOURS);
  });
});

describe("three more facts, one source each", () => {
  it("community packages, approved by a maintainer, is the registry's own `landed`, read by the Pool, the Factory, the Pipeline and People — captioned as what it counts, never \"in the rings\"", async () => {
    const pkgs = (await call("GET", "/factory/packages")).json.packages as { name: string; status: string; landed: boolean }[];
    // The server's rule on every row: ours published, hers registered — and mine, whose approval was withdrawn above, back to staged and not landed. lost is the registry's word too: approved, and a failed publish leaves it so (the approval's own row says where it is — the block below); pulled's block set it rejected. So the number is "approved", not "in the rings": the Factory's tile said "3 · in the rings" over a Landed lately reading "publish failed" on one of the three (2026-09-18).
    for (const p of pkgs) expect(p.landed, p.name).toBe(landed(p.status));
    expect(pkgs.filter((p) => p.landed).map((p) => p.name).sort()).toEqual([F.failedPkg, F.publishedPkg].sort());
    expect(pkgs.find((p) => p.name === F.pulledPkg)).toMatchObject({ status: "rejected", landed: false });
    expect(pkgs.find((p) => p.name === F.factoryPkg)).toMatchObject({ status: "staged", landed: false });
    const components = allComponents(F);
    for (const [path, id, caption] of [["/", "pool.open-stats", '"approved, built by the project"'], ["/factory", "factory.tiles", '"approved by a maintainer, from "'], ["/pipeline", "pipeline.throughput-flow", '<span class="k">approved</span>'], ["/people", "people.tiles", '"approved by a maintainer, built by the project"']] as const) {
      const own = ownScript(await page(path));
      expect(own, `${path} reads landed`).toContain("p.landed");
      expect(own, `${path} still types the status words`).not.toMatch(/status === "approved" \|\| p\.status === "published"|status === "approved"; \}\)\.length/);
      expect(own, `${path} captions the flag as what it counts`).toContain(caption);
      const c = components.find((x) => x.id === id);
      expect(c?.script, id).toContain("p.landed");
      expect(c?.reads?.some((r) => r.path === "/api/v1/factory/packages" && r.fields?.includes("packages.0.landed")), `${id} reads landed`).toBe(true);
    }
  });

  // The shell's reduce over the jobs series, as served: jobsSummary and the minutes view on it, with the day helper and the bucket rule they need — the proofs below run them over the server's rows.
  function jobsFns(script: string): string[] {
    return [/^  function lastDays\(n\) [^\n]*$/m.exec(script)![0], /^  function jobBucket\(status\) [^\n]*$/m.exec(script)![0], /^  function jobsSummary\(series, days\) \{[\s\S]*?\n  \}$/m.exec(script)![0], /^  function workerMinutes\(series, days\) \{[\s\S]*?\n  \}$/m.exec(script)![0]];
  }

  it("the worker minutes of the week are one sum over jobs_daily — the tile and the chart's bars — on the Workers page, the Pipeline and Status", async () => {
    const stats = (await call("GET", "/stats")).json;
    for (const path of ["/workers", "/pipeline", "/status"]) {
      const html = await page(path), script = scriptOf(html), own = ownScript(html);
      expect(own, `${path} reads the snapshot's minutes`).not.toMatch(/\ba\.minutes\b|metrics\.jobs\.minutes/);
      expect(own, `${path} sums the series through the shell`).toMatch(/workerMinutes\((?:STATS|d)\.series, 7\)/);
      // The served sum, run over the server's series, is the series summed.
      const wm = new Function("series", [...jobsFns(script), "return workerMinutes(series, 7);"].join("\n"))(stats.series) as { total: number; values: number[] };
      const days = new Set(wm.values.map((_: number, i: number) => new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10)));
      const expected = Math.round((stats.series.jobs_daily as { day: string; ms: number }[]).filter((r) => days.has(r.day)).reduce((n, r) => n + Number(r.ms || 0) / 60000, 0));
      expect(Math.abs(wm.total - expected)).toBeLessThanOrEqual(wm.values.length);
    }
  });

  it("the jobs of the week are one reduce over jobs_daily — the Status tiles, its table and its charts, the Pipeline's chart, the Workers page's cards — a cancelled job is a failed one everywhere, whatever the snapshot says, and a job queued longer than the week still waits", async () => {
    // A job cancelled this week, beside the fixture's done and queued ones, and a snapshot taken over it: the snapshot's "succeeded" (runs − failures − running) counts it as a success; the series counts it as failed. The two disagree from here on, on the same page if a page read both.
    await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, finished_at, duration_ms) VALUES ('gc', ?, '', '', 'schedule', 0, 0, 'project', 'pool', 'gc', 'cancelled', ?, 60000)").bind(F.arch, new Date().toISOString()).run();
    // A security job queued ten days ago and never pulled — the pool's case when no worker of its architecture is alive: the snapshot took every queued or leased row whatever its age, and the tile that read it said so; the series carries it on today, so the reduce that replaced the snapshot counts it too.
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, created_at) VALUES ('security', ?, '', '', 'schedule', 0, 0, 'project', 'pool', 'security', 'queued', ?)").bind(F.arch, tenDaysAgo).run();
    // A health check done yesterday: a row of the week that is not today's, for the day window below.
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, created_at, finished_at, duration_ms) VALUES ('health', ?, '', '', 'schedule', 0, 0, 'project', 'pool', 'health', 'done', ?, ?, 30000)").bind(F.arch, yesterday, yesterday).run();
    // The fixture's snapshot is minutes old and a snapshot on time declines: this one is asked for half an hour later.
    expect(await snapshotMetrics(env, new Date(Date.now() + 30 * 60000))).not.toBe("metrics: on time");
    const stats = (await call("GET", "/stats?after=cancelled")).json;
    const rows = stats.series.jobs_daily as { day: string; kind: string; status: string; n: number; ms: number }[];
    expect(rows.some((r) => r.status === "cancelled")).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect(rows.find((r) => r.kind === "security" && r.status === "queued"), "a job queued ten days ago is in the series, on today").toMatchObject({ day: today, n: 1 });
    expect(rows.find((r) => r.kind === "health" && r.status === "done" && r.day === yesterday.slice(0, 10)), "yesterday's health check is on yesterday").toMatchObject({ n: 1 });
    // The server's rows, reduced here by the rule the shell states: every row of the week counted once, done or failed (cancelled with it) or waiting.
    const week = new Set(Array.from({ length: 7 }, (_, i) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)));
    const kept = rows.filter((r) => week.has(r.day)), n = (f: (r: typeof rows[number]) => boolean) => kept.filter(f).reduce((a, r) => a + Number(r.n), 0);
    const expected = { runs: n(() => true), done: n((r) => r.status === "done"), failed: n((r) => r.status === "failed" || r.status === "cancelled"), waiting: n((r) => r.status !== "done" && r.status !== "failed" && r.status !== "cancelled") };
    expect(expected.runs).toBeGreaterThan(0);
    expect(expected.failed).toBeGreaterThan(0);
    expect(expected.waiting).toBeGreaterThan(1);
    expect(expected.runs).toBe(expected.done + expected.failed + expected.waiting);
    // Today's rows alone, for the reduce's day window: fewer than the week's, yesterday's check among the missing.
    const todays = rows.filter((r) => r.day === today), t = (f: (r: typeof rows[number]) => boolean) => todays.filter(f).reduce((a, r) => a + Number(r.n), 0);
    const expectedToday = { runs: t(() => true), done: t((r) => r.status === "done"), failed: t((r) => r.status === "failed" || r.status === "cancelled"), waiting: t((r) => r.status !== "done" && r.status !== "failed" && r.status !== "cancelled") };
    expect(expectedToday.runs).toBeLessThan(expected.runs);
    expect(expectedToday.waiting).toBe(expected.waiting);
    // The snapshot's word for the same week is another number: the proof that a page reading it beside the series would say two — every cancelled job (the gc above, the fixture's cancelled publish) is a success to it.
    const cancelled = n((r) => r.status === "cancelled");
    expect(cancelled).toBeGreaterThan(0);
    expect(stats.metrics.jobs.runs).toBe(expected.runs);
    expect(stats.metrics.jobs.runs - stats.metrics.jobs.failures - stats.metrics.jobs.running).toBe(expected.done + cancelled);
    const components = allComponents(F);
    let js7!: { byKind: Record<string, { runs: number; done: number; failed: number; waiting: number }> };
    for (const [path, ids] of [["/status", ["status.system-tiles", "status.chart-jobs", "status.chart-minutes", "status.workflows-table"]], ["/pipeline", ["pipeline.jobs-chart"]]] as const) {
      // The page's own statements, less CHARTS where it splices them: the reduce lives there, the page only reads it.
      const html = await page(path), script = scriptOf(html), own = ownScript(html).replace(CHARTS, "");
      // The served reduce, run over the server's series, is the rule above — in all, and its buckets sum to it.
      const reduce = new Function("series", "days", [...jobsFns(script), "return jobsSummary(series, days);"].join("\n")) as (series: unknown, days: number) => { runs: number; done: number; failed: number; waiting: number; byKind: Record<string, { runs: number; failed: number; waiting: number }>; byDay: Record<string, { runs: number; failed: number }> };
      const js = reduce(stats.series, 7); js7 = js as typeof js7;
      expect({ runs: js.runs, done: js.done, failed: js.failed, waiting: js.waiting }, path).toEqual(expected);
      expect(Object.values(js.byKind).reduce((a, k) => a + k.runs, 0), `${path} byKind`).toBe(expected.runs);
      expect(Object.values(js.byDay).reduce((a, d) => a + d.failed, 0), `${path} byDay`).toBe(expected.failed);
      expect(js.byKind.gc, `${path} counts the cancelled job as failed`).toMatchObject({ failed: 1, waiting: 0 });
      expect(js.byKind.security, `${path} counts the job queued ten days ago as waiting`).toMatchObject({ waiting: 1 });
      expect(js.byDay[today].runs, `${path} byDay has today's rows`).toBe(expectedToday.runs);
      // The reduce's window is the days asked for: over one day it is today's rows and nothing older, which is what keeps the tiles equal to the chart's bars beneath them.
      const one = reduce(stats.series, 1);
      expect({ runs: one.runs, done: one.done, failed: one.failed, waiting: one.waiting }, `${path} over one day`).toEqual(expectedToday);
      expect(Object.keys(one.byDay), `${path} one day, one label`).toEqual([today]);
      // The page reads the shell's reduce and nothing else: no snapshot's jobs, no reduce of the rows on the page.
      expect(own, `${path} reads the shell's reduce`).toContain("jobsSummary(d.series, 7)");
      expect(own, `${path} reads the snapshot's jobs`).not.toMatch(/m\.jobs|m\.actions|metrics\.jobs|\ba\.(?:runs|running|failures)\b/);
      expect(own, `${path} reduces jobs_daily itself`).not.toMatch(/\.jobs_daily\b|r\.status === "(?:done|failed|cancelled)"/);
      for (const id of ids) {
        const c = components.find((x) => x.id === id);
        expect(c?.script?.some((l) => /^jobsSummary\(d\.series, 7\)$|^js\./.test(l) || l.includes("js.byKind") || l.includes("js.byDay")), `${id} names the shell's reduce`).toBe(true);
        expect(c?.reads?.some((r) => r.path === "/api/v1/stats" && r.fields?.some((f) => f.startsWith("series.jobs_daily"))), `${id} reads the series`).toBe(true);
        expect(c?.reads?.some((r) => r.fields?.some((f) => /^metrics\.jobs\./.test(f))), `${id} still pins the snapshot's jobs`).toBe(false);
      }
    }
    // The Status tiles say the reduce's numbers by name, in the order the sentence reads: what waits, what ran, what failed and what got done — and the bucket is one word on the page, the reduce's: the tile, the table's column, the chart's legend.
    const statusHtml = await page("/status"), status = ownScript(statusHtml).replace(CHARTS, "");
    expect(status).toContain('"Jobs waiting now", num(js.waiting)');
    expect(status).toContain('"Jobs, 7 days", num(js.runs), num(js.failed) + " failed · " + num(js.done) + " done"');
    expect(statusHtml).toContain('<th class="num">Waiting</th>');
    expect(status).toContain("waiting: v.waiting");
    expect(status).toContain("</i>waiting</span>");
    expect(status, "the page calls the bucket by another word").not.toMatch(/running: v\.waiting|queued \/ running|"Jobs running now"|<th class="num">Running<\/th>/);
    // The Workers page splits the same rows by kind — the pool's kinds on the project's card — and a job's bucket there is the shell's jobBucket, the rule jobsSummary applies: the card's failed of the week is the reduce's failed over the pool's kinds, the cancelled job in it (the page's own rule, done or failed by name, counted it nowhere).
    const workersHtml = await page("/workers"), workersScript = scriptOf(workersHtml), workersOwn = ownScript(workersHtml).replace(CHARTS, "");
    expect(workersOwn).toContain("jobBucket(r.status)");
    expect(workersOwn, "/workers buckets a job by a rule of its own").not.toMatch(/status === "(?:failed|cancelled)"|status === "done" \|\|/);
    const perDay = /^  function perDay\(\) \{[\s\S]*?\n  \}$/m.exec(workersScript)![0], poolKinds = /^  var POOL_KINDS = [^\n]*$/m.exec(workersScript)![0];
    const cards = new Function("STATS", [served(workersScript, "lastDays"), served(workersScript, "jobBucket"), poolKinds, perDay, "var pd = perDay(); return { days: pd.days, P: pd.P, POOL_KINDS: POOL_KINDS };"].join("\n"))(stats) as { days: string[]; P: Record<string, Record<string, { done: number; failed: number }>>; POOL_KINDS: string[] };
    const sum = (side: string, k: "done" | "failed") => cards.days.reduce((a, d) => a + cards.P[side][d][k], 0);
    const pool = (k: "done" | "failed" | "waiting") => Object.keys(js7.byKind).filter((kind) => cards.POOL_KINDS.includes(kind)).reduce((a, kind) => a + js7.byKind[kind][k], 0);
    expect(sum("project", "failed"), "the project card's failed is the reduce's over the pool's kinds").toBe(pool("failed"));
    expect(sum("project", "done"), "the project card's done is the reduce's over the pool's kinds").toBe(pool("done"));
    expect(pool("failed")).toBeGreaterThanOrEqual(1);
    expect(allComponents(F).find((x) => x.id === "workers.kind-cards")?.script, "workers.kind-cards names the shell's bucket").toContain("jobBucket(r.status)");
  });

  it("open advisories in stable are counted at the Security page's default confidence on the Pool and the Pipeline, through the shell's one rule", async () => {
    const report = (await call("GET", `/security?ring=stable&arch=${F.arch}`)).json;
    const html = await page("/"), script = scriptOf(html);
    const fns = ["SEC_CONFS", "SEVERITIES", "confOk", "advisoriesAt", "advisoryCounts"].map((n) => (n === "SEC_CONFS" || n === "SEVERITIES" ? new RegExp(`^  var ${n} = [^\\n]*$`, "m") : new RegExp(`^  function ${n}\\([\\s\\S]*?\\n  \\}$`, "m")).exec(script)![0]);
    const count = new Function("d", "conf", [...fns, "return advisoryCounts(advisoriesAt(d, conf));"].join("\n"));
    // At any confidence the shell's count is the report's own totals; at the default it is the Security page's first tile — the fixture's one match is exact, so both agree here, and the rule is one function either way.
    const all = count(report, "all"), dflt = count(report);
    expect(all.packages).toBe(report.totals.packages);
    expect(all.kev).toBe(report.totals.kev);
    expect(dflt.packages).toBe((report.vulnerable as { advisories: { match: string }[] }[]).filter((v) => v.advisories.some((a) => a.match === "exact" || a.match === "name-version")).length);
    // The worst of a package's advisories, by the server's SEVERITIES order, over a report built here: a package with a low and a critical advisory is critical; one with a severity the list does not know, and one with none at all, is unknown; a KEV advisory makes the package exploited, whatever its severity — and advisoryCounts puts each once where its worst says, the exploited out of `rest`.
    const at = new Function("d", "conf", [...fns, "return advisoriesAt(d, conf);"].join("\n"));
    const made = { vulnerable: [
      { name: "a", advisories: [{ match: "exact", severity: "low" }, { match: "exact", severity: "critical" }, { match: "name", severity: "medium" }] },
      { name: "b", advisories: [{ match: "exact", severity: "urgent" }] },
      { name: "c", advisories: [{ match: "exact" }] },
      { name: "d", advisories: [{ match: "name-version", severity: "medium", kev: true, epss: 0.3 }, { match: "exact", severity: "high", epss: 0.7 }] },
      { name: "e", advisories: [{ match: "name", severity: "critical" }] },
    ] };
    const worst = Object.fromEntries((at(made) as { v: { name: string }; worst: string; kev: boolean; epss: number }[]).map((r) => [r.v.name, r.worst]));
    expect(worst).toEqual({ a: "critical", b: "unknown", c: "unknown", d: "high" });
    expect((at(made) as { v: { name: string }; kev: boolean; epss: number }[]).find((r) => r.v.name === "d")).toMatchObject({ kev: true, epss: 0.7 });
    expect((at(made, "all") as { v: { name: string }; worst: string }[]).map((r) => [r.v.name, r.worst])).toEqual([["a", "critical"], ["b", "unknown"], ["c", "unknown"], ["d", "high"], ["e", "critical"]]);
    expect((at(made, "exact") as { v: { name: string }; worst: string; kev: boolean }[]).find((r) => r.v.name === "d")).toMatchObject({ worst: "high", kev: false });
    expect(count(made)).toEqual({ packages: 4, kev: 1, critical: 1, high: 1, medium: 0, low: 0, unknown: 2, rest: { critical: 1, high: 0, medium: 0, low: 0, unknown: 2 } });
    for (const path of ["/", "/pipeline"]) {
      const own = ownScript(await page(path));
      expect(own, `${path} reads the report's totals for the number`).not.toMatch(/totals\.packages|t\.packages \|\| 0/);
      expect(own, `${path} counts through the shell`).toContain("advisoryCounts(advisoriesAt(s))");
      expect(own, `${path} names the confidence`).toContain("confWord()");
    }
    // The Pool's tile lands the reader on the Security page at that default.
    expect(ownScript(html)).toContain('"/security?ring=stable&arch=x86_64"');
    expect(ownScript(await page("/security"))).toContain("SEC_CONF");
  });

  it("an advisory's severity wears one colour: the shell's SEV_COLOR paints the pill, the Pool's bars and the Security page's stack, and no page types a colour of its own", async () => {
    const html = await page("/security"), script = scriptOf(html);
    // The shell's map as served, run here: six keys — the five severities the server says and the exploited bucket — each a :root colour the CSS declares, by the class the pill wears.
    const shell = ["esc", "pillHtml", "SEV_PILL", "SEV_COLOR", "SEV_BUCKETS", "sevSeries", "sevPill"].map((n) => served(script, n));
    const sev = new Function([...shell, "return { SEV_PILL: SEV_PILL, PILL_COLOR: PILL_COLOR, SEV_COLOR: SEV_COLOR, buckets: SEV_BUCKETS.map(function (b) { return [b[0], b[1]]; }), sevSeries: sevSeries, sevPill: sevPill };"].join("\n"))();
    expect(Object.keys(sev.SEV_COLOR).sort()).toEqual(["critical", "exploited", "high", "low", "medium", "unknown"]);
    expect(sev.SEV_COLOR).toEqual({ exploited: "var(--red)", critical: "var(--red)", high: "var(--red)", medium: "var(--amber)", low: "var(--blue)", unknown: "var(--dim)" });
    for (const [cls, color] of Object.entries(sev.PILL_COLOR) as [string, string][]) {
      // The pill's colour in JS is the pill's colour in the CSS, and the variable is one :root declares.
      expect(html, `.pill.${cls} is painted ${color}`).toContain(cls === "none" ? `.pill.none { color: ${color}; }` : `.pill.${cls} { color: ${color}; border-color: ${color}; }`);
      expect(html).toMatch(new RegExp(`${color.slice(4, -1)}: #[0-9a-f]{6};`));
    }
    for (const s of ["critical", "high", "medium", "low", "unknown", "exploited"]) {
      expect(sev.SEV_COLOR[s]).toBe(sev.PILL_COLOR[sev.SEV_PILL[s]]);
      expect(sev.sevPill(s)).toBe(`<span class="pill ${sev.SEV_PILL[s]}">${s}</span>`);
    }
    // The buckets a chart stacks, in the order the stack draws them, each in the colour of its worst severity; over a count with every severity the series is the numbers regrouped, a package once: the exploited packages — one of every severity here, so every total differs from its `rest` — sit in the first bucket and in no other, and the four sum to the packages.
    expect(sev.buckets).toEqual([["exploited", "exploited in the wild (KEV)"], ["critical", "critical + high"], ["medium", "medium"], ["low", "low / unknown"]]);
    const count = { packages: 21, kev: 5, critical: 2, high: 3, medium: 4, low: 5, unknown: 7, rest: { critical: 1, high: 2, medium: 3, low: 4, unknown: 6 } };
    expect(count.critical + count.high + count.medium + count.low + count.unknown).toBe(count.packages);
    expect(Object.values(count.rest).reduce((a, n) => a + n, 0)).toBe(count.packages - count.kev);
    const series = sev.sevSeries(count) as { name: string; color: string; value: number }[];
    expect(series).toEqual([{ name: "exploited in the wild (KEV)", color: "var(--red)", value: 5 }, { name: "critical + high", color: "var(--red)", value: 3 }, { name: "medium", color: "var(--amber)", value: 3 }, { name: "low / unknown", color: "var(--blue)", value: 10 }]);
    expect(series.reduce((a, r) => a + r.value, 0)).toBe(count.packages);
    // The two charts, drawn by the served CHARTS over that series: every bar the Pool draws and every rect the Security page stacks carries the shell's colour, and the legend says the shell's words.
    const chartFn = (name: string) => new RegExp(`^  function ${name}\\([\\s\\S]*?\\n  \\}$`, "m").exec(script)![0];
    const draw = new Function("series", [...shell, "function num(v) { return String(v); } function nice(v) { return v; } function shortDay(d) { return d; }", chartFn("hrows"), chartFn("stacked"),
      "var max = Math.max.apply(null, series.map(function (r) { return r.value; })) || 1;",
      "return { pool: hrows(series.map(function (r) { return [r.name, '', Math.round(100 * r.value / max), r.color, num(r.value)]; }), 190), security: stacked(['edge', 'rc', 'stable'], series.map(function (b) { return { name: b.name, color: b.color, values: [b.value, b.value, b.value] }; }), { full: true }) };"].join("\n"))(series) as { pool: string; security: string };
    expect([...draw.pool.matchAll(/;background:(var\(--\w+\))"/g)].map((m) => m[1])).toEqual(series.map((r) => r.color));
    expect([...draw.security.matchAll(/fill="(var\(--\w+\))"/g)].map((m) => m[1])).toEqual([0, 1, 2].flatMap(() => series.map((r) => r.color)));
    expect([...draw.security.matchAll(/<i style="background:(var\(--\w+\))"><\/i>([^<]+)</g)].map((m) => [m[1], m[2]])).toEqual(series.map((r) => [r.color, r.name]));
    // The pages read the shell's series and hand its colour to the chart; neither names a bucket or a colour of its own, and the manifests say so.
    const components = allComponents(F);
    for (const [path, id, reads] of [["/", "pool.chart-security", ["sevSeries(t)", "r.color"]], ["/security", "security.per-ring-chart", ["sevSeries(tot[RINGS.indexOf(r)])", "b.color"]]] as const) {
      const own = ownScript(await page(path)).replace(CHARTS, "");
      for (const r of reads) expect(own, `${path} reads ${r}`).toContain(r);
      expect(own, `${path} names a bucket of its own`).not.toMatch(/"critical \+ high"|"low \/ unknown"|"exploited in the wild \(KEV\)"|name: "medium"/);
      expect(own, `${path} colours a severity of its own`).not.toMatch(/C\.(?:red|amber|blue|dim)|(?:critical|high|medium|low|unknown|kev)[^\n]{0,40}var\(--(?:red|amber|blue|dim)\)/);
      const c = components.find((x) => x.id === id);
      expect(c?.script, id).toEqual(expect.arrayContaining([...reads]));
    }
    // The Security table's exploited pill and the package page's "exploited in the wild" wear the bucket's class and colour, not a word of their own.
    expect(ownScript(html)).toContain('pillHtml(SEV_PILL.exploited, "exploited", "in CISA KEV")');
    expect(ownScript(await page(`/package/${F.pkg}`))).toContain("SEV_COLOR.exploited");
    expect(ownScript(await page(`/package/${F.pkg}`))).not.toContain('style="color:var(--red)">exploited');
  });

  it("the 14-day health grid is drawn once — the shell's heatGrid on the Pipeline and on Status, the rings in the reader's order — and a check's result is one word everywhere: HEALTH_WORD on the grid, the Pool's ring cards, the Pipeline's pills, heads and job results, the Status table", async () => {
    // Health checks beside the fixture's one: two on edge aarch64 yesterday, ok then failed — the day's cell is the worse; a warn on rc today, posted by hand (the check posts ok or error only: a ring with nothing rendered fails, since #47); and one on the lab, which no scheduler queues (the lab is promised nothing) and no grid draws a row for.
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600e3).toISOString();
    const yesterday = new Date(Date.now() - 86400e3).toISOString().slice(0, 10), today = new Date().toISOString().slice(0, 10);
    const ins = (ring: string, arch: string, status: string, when: string) => env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload, created_at) VALUES ('health', ?, ?, ?, ?, '{}', ?)").bind(ring, arch, status, `${ring} ${arch}: ${status}`, when);
    await env.DB.batch([ins("edge", "aarch64", "ok", at(26)), ins("edge", "aarch64", "error", at(25)), ins("rc", "x86_64", "warn", at(1)), ins("lab", "x86_64", "ok", at(1))]);
    const stats = (await call("GET", "/stats?after=health")).json;
    const rows = stats.series.health as { ring: string; arch: string; created_at: string; status: string }[];
    expect(rows.map((r) => r.status).sort()).toEqual(["error", "ok", "ok", "ok", "warn"]);
    // The rule, stated here over the server's rows: the worst status per ring, architecture and day — ok under warn under error.
    const rank: Record<string, number> = { error: 3, warn: 2, ok: 1 }, expected: Record<string, string> = {};
    for (const h of rows) { const k = `${h.ring}/${h.arch}/${h.created_at.slice(0, 10)}`; if ((rank[h.status] || 0) > (rank[expected[k]] || 0)) expected[k] = h.status; }
    expect(expected[`edge/aarch64/${yesterday}`]).toBe("error");
    expect(expected[`rc/x86_64/${today}`]).toBe("warn");
    const days = Array.from({ length: 14 }, (_, i) => new Date(Date.now() - (13 - i) * 86400000).toISOString().slice(0, 10));
    // The rows a grid draws: the rings a check covers, stable first — meta.ts's PROMOTED_RINGS in RINGS_BY_STABILITY's order — over both architectures; never the lab.
    const promised = RINGS_BY_STABILITY.filter((r) => (PROMOTED_RINGS as readonly string[]).includes(r));
    expect(promised).toEqual(["stable", "rc", "edge"]);
    const labels = promised.flatMap((r) => ["x86_64", "aarch64"].map((a) => `${r} ${a}`));
    const WORD = { ok: "healthy", warn: "warning", error: "failed" };
    const components = allComponents(F), grids: string[] = [];
    for (const [path, id] of [["/pipeline", "pipeline.health-heatgrid"], ["/status", "status.chart-health"]] as const) {
      const html = await page(path), script = scriptOf(html), own = ownScript(html).replace(CHARTS, "");
      // The shell's word and rings, as served: the one map, the promised rings in the reader's order.
      const shell = ["esc", "HEALTH_WORD", "PROMISED_RINGS", "ARCHES", "SEV_PILL"].map((n) => served(script, n));
      const words = new Function([...shell, "return { HEALTH_WORD: HEALTH_WORD, PROMISED_RINGS: PROMISED_RINGS };"].join("\n"))() as { HEALTH_WORD: Record<string, string>; PROMISED_RINGS: string[] };
      expect(words.HEALTH_WORD, `${path} HEALTH_WORD`).toEqual(WORD);
      expect(words.PROMISED_RINGS, `${path} PROMISED_RINGS`).toEqual(promised);
      // The served grid, run over the server's rows: one cell per ring, architecture and day, its class the worst status of the day, its tooltip the shell's word; the legend the same words in the pill's colours.
      const chartFn = (name: string) => new RegExp(`^  function ${name}\\([\\s\\S]*?\\n  \\}$`, "m").exec(script)![0];
      const grid = new Function("health", [...shell, served(script, "lastDays"), served(script, "day"), served(script, "worst"), chartFn("heatGrid"), "return heatGrid(health);"].join("\n"))(rows) as string;
      grids.push(grid);
      const drawn = [...grid.matchAll(/<div class="r"><span class="l">([^<]+)<\/span>((?:<span class="c[^>]*><\/span>)+)<\/div>/g)].map((m) => [m[1], [...m[2].matchAll(/<span class="c ?(\w*)" data-tip="([^"]*)"><\/span>/g)].map((c) => [c[1], c[2]])] as [string, [string, string][]]);
      expect(drawn.map((r) => r[0]), `${path} rows`).toEqual(labels);
      for (const [label, cells] of drawn) {
        const key = label.replace(" ", "/");
        expect(cells.length, `${path} ${label}`).toBe(14);
        cells.forEach(([cls, tip], i) => {
          const st = expected[`${key}/${days[i]}`] || "";
          expect(cls, `${path} ${label} ${days[i]}`).toBe(st);
          expect(tip, `${path} ${label} ${days[i]}`).toBe(`${days[i]} · ${label} · ${st ? WORD[st as keyof typeof WORD] : "no check"}`);
        });
      }
      expect(grid).toContain(`data-tip="${yesterday} · edge aarch64 · failed"`);
      expect(grid).toContain(`data-tip="${today} · rc x86_64 · warning"`);
      expect(grid).toContain(`data-tip="${today} · stable ${F.arch} · healthy"`);
      expect(grid).not.toContain("lab ");
      expect(grid).toMatch(/<div class="legend"><span><i style="background:var\(--green\)"><\/i>healthy<\/span><span><i style="background:var\(--amber\)"><\/i>warning<\/span><span><i style="background:var\(--red\)"><\/i>failed<\/span><span><i style="background:var\(--line\)"><\/i>no check<\/span><\/div>$/);
      // The legend says the statuses the cells wear and no other: without the hand-posted warn — the production case, the check never posting one — the amber entry is not advertised.
      const noWarn = new Function("health", [...shell, served(script, "lastDays"), served(script, "day"), served(script, "worst"), chartFn("heatGrid"), "return heatGrid(health);"].join("\n"))(rows.filter((h) => h.status !== "warn")) as string;
      expect(noWarn).toMatch(/<div class="legend"><span><i style="background:var\(--green\)"><\/i>healthy<\/span><span><i style="background:var\(--red\)"><\/i>failed<\/span><span><i style="background:var\(--line\)"><\/i>no check<\/span><\/div>$/);
      expect(noWarn).not.toContain("warning");
      // The page draws the shell's grid and nothing of its own: no cell map, no ring list, no word for a result, no legend.
      expect(own, `${path} reads the shell's grid`).toContain('$("#c-health").innerHTML = heatGrid(S.health);');
      expect(own, `${path} builds the cells itself`).not.toMatch(/worst\(cells|h\.ring \+ "\/"|\bheat\(|nothing rendered|"healthy"|"unhealthy"|"warning"/);
      const c = components.find((x) => x.id === id);
      expect(c?.script, id).toEqual(expect.arrayContaining(["heatGrid(S.health)"]));
      expect(c?.script?.some((l) => l.includes("worst(cells")), `${id} pins a cell map of its own`).toBe(false);
    }
    expect(grids[0], "the Status page's cells are the Pipeline's").toBe(grids[1]);
    // Every other place a check's result is said reads HEALTH_WORD — the Pool's ring cards, the Pipeline's ring pills, its ring heads and a health job's result, the Status rings table — and no page draws the journal's status as text; the manifests name the read.
    for (const [path, ids, reads] of [
      ["/", ["pool.ring-cards"], ["HEALTH_WORD[h.status]"]],
      ["/pipeline", ["pipeline.state-row", "pipeline.ring-heads", "pipeline.tasks-table"], ["HEALTH_WORD.ok", "HEALTH_WORD[h.status]", "HEALTH_WORD[e.status]", "r.ok ? HEALTH_WORD.ok : HEALTH_WORD.error", "PROMISED_RINGS.map(function (n)"]],
      ["/status", ["status.rings-table"], ["pillHtml(h.status, HEALTH_WORD[h.status])", "PROMISED_RINGS.forEach(function (ring)"]],
    ] as const) {
      const html = await page(path), own = ownScript(html).replace(CHARTS, "");
      for (const r of reads) expect(own, `${path} reads ${r}`).toContain(r);
      expect(own, `${path} says a health result in a word of its own`).not.toMatch(/' · ' \+ h\.status|" " \+ h\.status|pillHtml\(h\.status, h\.status\)|e\.status : "—"|"healthy"|"unhealthy"/);
      for (const id of ids) {
        const c = components.find((x) => x.id === id);
        expect(c?.script?.some((l) => l.includes("HEALTH_WORD")), `${id} names the shell's word`).toBe(true);
      }
    }
    // The Pipeline's word for a health job, run as served over the two results a job has: the shell's, not one of its own.
    const pipeline = scriptOf(await page("/pipeline"));
    const jobResult = new Function("t", [served(pipeline, "HEALTH_WORD"), "function num(v) { return String(v); }", /^  function jobResult\(t\) \{[\s\S]*?\n  \}$/m.exec(pipeline)![0], "return jobResult(t);"].join("\n"));
    expect(jobResult({ kind: "health", result: { ok: true } })).toBe("healthy");
    expect(jobResult({ kind: "health", result: JSON.stringify({ ok: false }) })).toBe("failed");
  });

  it("a person's workers are the listing's rows: /users/:login serves each through the same view as /factory — alive by the one threshold, ready, side, update — so the page's tile counts what its tables draw", async () => {
    // The fixture's workers were last seen in 2000, dead under any window: one of m1's heartbeats five minutes ago and another fifteen — one side of the threshold each — so a route with a window of its own would say a different word on one of them.
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE build_workers SET last_seen = ? WHERE id = 'w1'").bind(minutesAgo(WORKER_ALIVE_MINUTES / 2)),
      env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES ('w1-idle', ?, 'm1', 'idle', 'shared', 'project', 'm1', ?)").bind(F.arch, minutesAgo(WORKER_ALIVE_MINUTES + WORKER_ALIVE_MINUTES / 2)),
    ]);
    const listing = (await call("GET", "/factory?limit=10")).json.workers as Record<string, unknown>[];
    expect(listing.find((w) => w.id === "w1")).toMatchObject({ alive: true });
    expect(listing.find((w) => w.id === "w1-idle")).toMatchObject({ alive: false });
    for (const login of [F.owner, F.m1]) {
      const mine = (await call("GET", `/users/${login}?after=heartbeat`)).json.workers as Record<string, unknown>[];
      expect(mine.length, login).toBeGreaterThan(0);
      if (login === F.m1) expect(mine.map((w) => [w.id, w.alive]).sort(), "one side of the threshold each").toEqual([["w1", true], ["w1-idle", false]]);
      for (const w of mine) {
        // The same words on the row: alive, ready and side are the listing's, computed by workerView; nothing the listing withholds rides here.
        for (const k of ["alive", "ready", "side", "update", "labels", "kinds"]) expect(w, `${login}'s ${w.id} carries ${k}`).toHaveProperty(k);
        expect(w).not.toHaveProperty("token_hash"); expect(w).not.toHaveProperty("log_tail"); expect(w).not.toHaveProperty("log_at");
        const same = listing.find((x) => x.id === w.id);
        if (!w.revoked_at) { expect(same, `${w.id} is listed`).toBeDefined(); for (const k of ["alive", "ready", "side", "current_task", "trust", "owner"]) expect(w[k], `${w.id} ${k}`).toEqual(same![k]); }
      }
    }
    // The user page reads the answer with the shell's counter, as every tile does, and the manifest reads the fields the counter needs.
    const own = ownScript(await page(`/user/${F.owner}`));
    expect(own).toContain("wc = workerCounts(d.workers)");
    const c = allComponents(F).find((x) => x.id === "user.tiles");
    expect(c?.reads?.some((r) => r.path === `/api/v1/users/${F.owner}` && ["workers.0.alive", "workers.0.ready", "workers.0.side"].every((f) => r.fields?.includes(f))), "user.tiles reads the listing's words").toBe(true);
  });

  it("the bill wears one colour and one figure: the shell's costColor (the pill's colours by the status /cost says) and usd() on the Status tile and the Pipeline's panel, neither page mapping a status or formatting a sum of its own", async () => {
    const script = scriptOf(await page("/status"));
    const shell = new Function([served(script, "SEV_PILL") /* PILL_COLOR is declared beside it */, served(script, "usd"), served(script, "costColor"), "return { usd: usd, costColor: costColor, PILL_COLOR: PILL_COLOR };"].join("\n"))() as { usd: (n: unknown) => string; costColor: (c: unknown) => string; PILL_COLOR: Record<string, string> };
    expect(shell.usd(12.345)).toBe("US$ 12.35"); expect(shell.usd(0)).toBe("US$ 0.00"); expect(shell.usd(null)).toBe("US$ 0.00"); expect(shell.usd("7")).toBe("US$ 7.00");
    // ok is green — the pill's ok — on both pages: it was plain ink on Status and green on the Pipeline.
    expect(shell.costColor({ status: "ok" })).toBe(shell.PILL_COLOR.ok);
    expect(shell.costColor({ status: "warn" })).toBe(shell.PILL_COLOR.warn);
    expect(shell.costColor({ status: "error" })).toBe(shell.PILL_COLOR.error);
    expect(shell.costColor(null)).toBe(shell.PILL_COLOR.ok);
    // The server's status is the one the shell maps: the three words cost.ts says.
    const cost = (await call("GET", "/cost")).json;
    expect(["ok", "warn", "error"]).toContain(cost.status);
    const components = allComponents(F);
    for (const [path, id] of [["/status", "status.bill-tile"], ["/pipeline", "pipeline.budget"]] as const) {
      const own = ownScript(await page(path));
      for (const r of ["costColor(c)", "usd(c.projected_usd)", "usd(c.month_to_date_usd)"]) expect(own, `${path} reads ${r}`).toContain(r);
      expect(own, `${path} maps the status itself`).not.toMatch(/c\.status === "(?:error|warn|ok)"/);
      expect(own, `${path} formats the bill itself`).not.toMatch(/toFixed\(2\)|"US\$ " \+ Number/);
      const c = components.find((x) => x.id === id);
      expect(c?.script, id).toEqual(expect.arrayContaining(["costColor(c)", "usd(c.projected_usd)", "usd(c.month_to_date_usd)"]));
    }
    // The Pipeline's panel, run as served over the server's answer (api() stubbed with it): the cap and the guard on the panel are the lines the sentence's slots say, and the bar is a width. A name that resolves to something else spliced into the same script — `lines`, the chart — prints US$ 0 and NaN without throwing, so the text is read here, not trusted.
    const pipeline = scriptOf(await page("/pipeline"));
    const slots: Record<string, string> = {}, el = { innerHTML: "" };
    const renderCost = /^  function renderCost\(\) \{[\s\S]*?\n  \}$/m.exec(pipeline)![0];
    await new Promise<void>((done) => new Function("c", "$", "live", "api", "done", [served(pipeline, "esc"), served(pipeline, "num"), served(pipeline, "usd"), served(pipeline, "SEV_PILL"), served(pipeline, "costColor"), "function lines() {} /* CHARTS' chart, in the same scope as on the page */", renderCost, "renderCost(); setTimeout(done, 0);"].join("\n"))(cost, () => el, (k: string, v: string) => { slots[k] = v; }, () => Promise.resolve(cost), done));
    expect(slots).toEqual({ "cost-warn": String(cost.lines_usd.warn), "cost-guard": String(cost.lines_usd.guard), "cost-cap": String(cost.lines_usd.cap) });
    expect(el.innerHTML).toContain(`of a US$ ${cost.lines_usd.cap} hard cap`);
    expect(el.innerHTML).toContain(cost.guard ? "over the guard" : `guard at US$ ${cost.lines_usd.guard}`);
    expect(el.innerHTML).toContain(`<b style="color:${shell.costColor(cost)}">${shell.usd(cost.month_to_date_usd)}</b>`);
    expect(el.innerHTML).toMatch(new RegExp(`<i style="width:${Math.min(100, (100 * cost.projected_usd) / cost.lines_usd.cap)}%;`));
    expect(el.innerHTML).toContain(`<em style="left:${(100 * cost.lines_usd.guard) / cost.lines_usd.cap}%">`);
    expect(el.innerHTML).not.toMatch(/NaN|US\$ 0 hard cap|guard at US\$ 0\b/);
    expect(ownScript(await page("/pipeline"))).not.toMatch(/\blines\.(?:warn|guard|cap)\b/);
  });

  it("a build nobody decided yet links its package on the lab from Review, from its own page and from a person's builds table — one ringOfBuild", async () => {
    const script = scriptOf(await page("/"));
    const rule = new Function("status", "rings", [/^  var RINGS_TEXT = [^\n]*$/m.exec(script)![0], /^  function ringName\([^\n]*$/m.exec(script)![0], /^  function servedRing\([^\n]*$/m.exec(script)![0], /^  function ringOfBuild\([^\n]*$/m.exec(script)![0], "return ringOfBuild(status, rings);"].join("\n"));
    expect(rule("staged", [])).toBe("lab");
    expect(rule("staged", null)).toBe("lab");
    expect(rule("done", ["lab", "edge", "stable"])).toBe("stable");
    expect(rule("staged", ["lab"])).toBe("lab");
    expect(rule("failed", [])).toBeNull();
    // servedRing takes the server's rows too, in any order, and hands the row back.
    expect(rule("done", [{ ring: "edge", arch: "x86_64" }, { ring: "rc", arch: "x86_64" }])).toBe("rc");
    for (const [path, literal] of [[`/build/${F.projectTask}`, "pkgHref(t.name, ringOfBuild(t.status, T.rings), t.arch)"], [`/user/${F.owner}`, "pkgHref(t.name, ringOfBuild(t.status, null), t.arch)"], ["/review", 'pkg(t.name, t.version, "lab", t.arch)']] as const) {
      expect(ownScript(await page(path)), path).toContain(literal);
    }
  });

  it("a task's approval carries `standing`, and no page derives it from decision and withdrawn_at", async () => {
    const whole = (await call("GET", `/factory/tasks/${F.projectTask}`)).json;
    expect(whole.approval).toMatchObject({ decision: "approved", standing: stands(whole.approval) });
    const story = (await call("GET", `/factory/packages/${F.factoryPkg}/story`)).json;
    for (const c of story.chains) if (c.approval) expect(c.approval.standing).toBe(stands(c.approval));
    for (const path of [`/build/${F.projectTask}`, `/user/${F.owner}`, "/review", "/pipeline", "/factory"]) {
      expect(scriptOf(await page(path)), path).not.toMatch(/decision === "approved" && !\w+\.withdrawn_at/);
    }
  });

  it("a person's role on their page is the maintainer set's word", async () => {
    expect((await call("GET", `/users/${F.m1}`)).json).toMatchObject({ role: "maintainer", maintainer_since: expect.any(String) });
    expect((await call("GET", `/users/${F.owner}`)).json).toMatchObject({ role: "contributor", maintainer_since: null });
  });
});

describe("a build's evidence has one address", () => {
  // A build that died before it uploaded anything — the worker gone, the lease lost: production's tasks 451, 467 and 391 on 2026-09-18 — has a row and no build.log, so a raw link to one is a JSON 404.
  let dead: number;
  beforeAll(async () => {
    dead = (await env.DB.prepare(
      `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, lease_owner, error, log_tail, finished_at)
       VALUES (?, ?, '1.0-9', 'draft:https://mine.example@latest', 'contributor', 100, 0, 'community', ?, 'build', 'failed', ?, 'the worker died: lease lost', 'makepkg: killed', ?) RETURNING id`,
    ).bind(F.factoryPkg, F.arch, F.owner, F.communityWorker, new Date().toISOString()).first<{ id: number }>())!.id;
  });

  it("the raw log of a build that left nothing is a 404, its page is not, and the page says so", async () => {
    const raw = await call("GET", `/factory/tasks/${dead}/artifacts/build.log`);
    expect(raw.status).toBe(404);
    expect((await call("GET", `/factory/tasks/${dead}`)).json).toMatchObject({ evidence: [], task: { status: "failed", log_tail: "makepkg: killed" } });
    const html = await page(`/build/${dead}`);
    expect(html).toContain('id="evidence"');
    expect(scriptOf(html)).toContain("Nothing staged for this build");
  });

  it("the shell writes the address, and the rows link it: a person's builds, the Pipeline's tasks, the checklist's build items — no page writes /artifacts/build.log by hand", async () => {
    const script = scriptOf(await page("/"));
    const href = new Function("id", [served(script, "evidenceHref"), "return evidenceHref(id);"].join("\n"));
    expect(href(dead)).toBe(`/build/${dead}#evidence`);
    // The person's builds column, the served function over the server's row of the dead build.
    // Past the edge cache (keyed by URL), as the owner's own page reads it: the dead build was written after the profile was read above.
    const person = (await call("GET", `/users/${F.owner}?t=${Date.now()}`)).json;
    const row = person.builds.find((b: { id: number }) => b.id === dead);
    expect(row).toMatchObject({ id: dead, status: "failed" });
    const user = scriptOf(await page(`/user/${F.owner}`));
    const cell = new Function("t", [served(user, "esc"), served(user, "evidenceHref"), served(user, "evidenceLink"), served(user, "evidence"), "return evidence(t);"].join("\n"));
    expect(cell(row)).toContain(`href="/build/${dead}#evidence"`);
    expect(cell(row)).not.toContain("/artifacts/");
    expect(cell({ ...row, status: "staged" })).toContain(`href="/build/${dead}#evidence"`);
    expect(cell({ ...row, status: "queued" })).toBe("");
    // The Pipeline's staged row and the checklist's build items go through the same link; the raw file links a page draws by hand are gone from every page's own script.
    for (const path of ["/pipeline", `/user/${F.owner}`, `/build/${F.projectTask}`, "/review", "/factory", "/", "/packages", `/package/${F.pkg}`]) {
      expect(ownScript(await page(path)), `${path} links a raw artifact by hand`).not.toMatch(/artifacts\//);
    }
    expect(ownScript(await page("/pipeline"))).toContain("evidenceLink(t)");
    expect(script).toContain("evidenceLink(cc)");
    expect(script).toContain("evidenceLink(pb)");
  });
});

describe("nothing waiting", () => {
  it("answers `waiting` 0 and `oldest_ms` null once every staged row is decided — the last thing this file does to the fixture", async () => {
    // Rejecting the project's build hands alice's evidence behind it back to a maintainer (project_build gone), so the queue empties in two rounds.
    let after = (await call("GET", "/factory/review?round=0")).json;
    for (let round = 1; after.waiting && round <= 3; round++) {
      for (const t of after.staged.filter(waitsForMaintainer)) expect((await call("POST", `/factory/tasks/${t.id}/reject`, "m1", { note: "cleared by the test, one by one" })).status, `reject #${t.id}`).toBe(200);
      after = (await call("GET", `/factory/review?round=${round}`)).json;
    }
    expect(after.staged.filter(waitsForMaintainer)).toEqual([]);
    expect(after).toMatchObject({ waiting: 0, oldest_ms: null });
  });
});
