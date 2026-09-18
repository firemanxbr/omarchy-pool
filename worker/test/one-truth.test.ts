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
 * approval that stands, on every page that draws them.
 * The third (2026-09-18) found the Review page holding a copy of the
 * server's waitsForMaintainer as `decidable`, subtracting a maintainer's
 * own rows with it and highlighting by it, with nothing holding the two
 * together: now every row of the list says `waits`, the page reads the
 * field, and the first block runs the served rule over the server's rows.
 * The fourth found Review's Decided line saying where a standing approval
 * is from the absence of a ring, guessing ["edge"] from the registry's
 * status, while the Factory read the row's blocked_at and publish_status:
 * now the shell's approvalWhere is the one rule, the fixture holds the two
 * states no ring serves (a failed publish, a block), and the second block
 * draws both pages over them.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { RINGS, RINGS_BY_STABILITY } from "../src/index";
import { LATE_AFTER_HOURS, RING_TEXT } from "../src/meta";
import { waitsForMaintainer, stands } from "../src/routes/review";
import { maintenanceOf } from "../src/routes/users";
import { landed } from "../src/routes/contributors";
import { allComponents } from "../src/pages/components";
import { HELPERS } from "../src/pages/layout";
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
    // The pill as the shell draws it from the rule's answer: class, title, word.
    const pill = (a: Row) => { const w = shell.approvalWhere(a); return `<span class="pill ${w.cls}" title="${w.title}">${w.word}</span>`; };
    for (const [what, html] of [["the Factory's Landed lately", landed], ["Review's Decided", decided]] as const) {
      expect(html, `${what} draws lost`).toContain(`>${F.failedPkg}</`);
      expect(html, `${what} draws pulled`).toContain(`>${F.pulledPkg}</`);
      expect(html, `${what} promises edge`).not.toContain("on its way into edge");
      expect(html, `${what} says publishing`).not.toContain(">publishing</span>");
      expect(html, `${what}: lost`).toContain(pill(failed));
      expect(html, `${what}: pulled`).toContain(pill(pulled));
    }
    // ours is served: the Factory's card wears the ring badges and no pill; Review's line says the ring and its way out is the package's one address.
    expect(landed).not.toContain(pill(served));
    const alices = (await drawn("/review", F.owner)).nodes["#mine-decided"].innerHTML as string;
    expect(alices).toContain(pill(served));
    expect(alices).toContain(`<a class="go" href="/package/${F.publishedPkg}?ring=edge&amp;arch=${F.arch}">`);
    // lost is in no ring: its way out is the build, never a package address as if a ring served it.
    expect(decided).toContain(`<a class="go" href="/build/${failed.task_id}">`);
    expect(decided).not.toContain(`<a class="go" href="/package/${F.failedPkg}?`);
    // pulled: the block row and the approval row of the same package say one word — the owner read "blocked" and, a row later, "on its way into edge".
    expect(decided.split(">blocked</span>").length - 1).toBe(2);
    expect(decided).not.toContain(`<a class="go" href="/package/${F.pulledPkg}?`);
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
});

describe("the maintainer set, the late mark and the budget lines are the server's", () => {
  it("GET /factory/maintainers is the one list a page takes a person's role from, cached at the edge", async () => {
    const r = await call("GET", "/factory/maintainers");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=60");
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
    for (const slot of ["cost-warn", "cost-guard", "cost-cap"]) expect(pipeline).toContain(`live("${slot}", num(usd.${slot.slice(5)}))`);
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
  it("community packages \"in the rings\" is the registry's own `landed`, read by the Pool, the Factory, the Pipeline and People", async () => {
    const pkgs = (await call("GET", "/factory/packages")).json.packages as { name: string; status: string; landed: boolean }[];
    // The server's rule on every row: ours published, hers registered — and mine, whose approval was withdrawn above, back to staged and not landed. lost is the registry's word too: approved, and a failed publish leaves it so (the approval's own row says where it is — the block below); pulled's block set it rejected.
    for (const p of pkgs) expect(p.landed, p.name).toBe(landed(p.status));
    expect(pkgs.filter((p) => p.landed).map((p) => p.name).sort()).toEqual([F.failedPkg, F.publishedPkg].sort());
    expect(pkgs.find((p) => p.name === F.pulledPkg)).toMatchObject({ status: "rejected", landed: false });
    expect(pkgs.find((p) => p.name === F.factoryPkg)).toMatchObject({ status: "staged", landed: false });
    const components = allComponents(F);
    for (const [path, id] of [["/", "pool.open-stats"], ["/factory", "factory.tiles"], ["/pipeline", "pipeline.throughput-flow"], ["/people", "people.tiles"]] as const) {
      const own = ownScript(await page(path));
      expect(own, `${path} reads landed`).toContain("p.landed");
      expect(own, `${path} still types the status words`).not.toMatch(/status === "approved" \|\| p\.status === "published"|status === "approved"; \}\)\.length/);
      const c = components.find((x) => x.id === id);
      expect(c?.script, id).toContain("p.landed");
      expect(c?.reads?.some((r) => r.path === "/api/v1/factory/packages" && r.fields?.includes("packages.0.landed")), `${id} reads landed`).toBe(true);
    }
  });

  it("the worker minutes of the week are one sum over jobs_daily — the tile and the chart's bars — on the Workers page, the Pipeline and Status", async () => {
    const stats = (await call("GET", "/stats")).json;
    for (const path of ["/workers", "/pipeline", "/status"]) {
      const html = await page(path), script = scriptOf(html), own = ownScript(html);
      expect(own, `${path} reads the snapshot's minutes`).not.toMatch(/\ba\.minutes\b|metrics\.jobs\.minutes/);
      expect(own, `${path} sums the series through the shell`).toMatch(/workerMinutes\((?:STATS|d)\.series, 7\)/);
      // The served sum, run over the server's series, is the series summed.
      const fn = /^  function workerMinutes\(series, days\) \{[\s\S]*?\n  \}$/m.exec(script)![0], lastDays = /^  function lastDays\(n\) [^\n]*$/m.exec(script)![0];
      const wm = new Function("series", [lastDays, fn, "return workerMinutes(series, 7);"].join("\n"))(stats.series) as { total: number; values: number[] };
      const days = new Set(wm.values.map((_: number, i: number) => new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10)));
      const expected = Math.round((stats.series.jobs_daily as { day: string; ms: number }[]).filter((r) => days.has(r.day)).reduce((n, r) => n + Number(r.ms || 0) / 60000, 0));
      expect(Math.abs(wm.total - expected)).toBeLessThanOrEqual(wm.values.length);
    }
  });

  it("open advisories in stable are counted at the Security page's default confidence on the Pool and the Pipeline, through the shell's one rule", async () => {
    const report = (await call("GET", `/security?ring=stable&arch=${F.arch}`)).json;
    const html = await page("/"), script = scriptOf(html);
    const fns = ["SEC_CONFS", "confOk", "advisoriesAt", "advisoryCounts"].map((n) => (n === "SEC_CONFS" ? /^  var SEC_CONFS = [^\n]*$/m : new RegExp(`^  function ${n}\\([\\s\\S]*?\\n  \\}$`, "m")).exec(script)![0]);
    const count = new Function("d", "conf", [...fns, "return advisoryCounts(advisoriesAt(d, conf));"].join("\n"));
    // At any confidence the shell's count is the report's own totals; at the default it is the Security page's first tile — the fixture's one match is exact, so both agree here, and the rule is one function either way.
    const all = count(report, "all"), dflt = count(report);
    expect(all.packages).toBe(report.totals.packages);
    expect(all.kev).toBe(report.totals.kev);
    expect(dflt.packages).toBe((report.vulnerable as { advisories: { match: string }[] }[]).filter((v) => v.advisories.some((a) => a.match === "exact" || a.match === "name-version")).length);
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
