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
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { RINGS, RINGS_BY_STABILITY } from "../src/index";
import { RING_TEXT } from "../src/meta";
import { waitsForMaintainer, stands } from "../src/routes/review";
import { maintenanceOf } from "../src/routes/users";
import { LATE_AFTER_HOURS } from "../src/routes/stats";
import { allComponents } from "../src/pages/components";
import { HELPERS } from "../src/pages/layout";
import { scriptOf, seedDashboard, type Fixture } from "./fixture";

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
  });
});

describe("an approval stands or it does not, said once", () => {
  it("GET /factory/approvals carries `standing` on every row: approved and not withdrawn", async () => {
    const before = (await call("GET", "/factory/approvals")).json.approvals as { name: string; decision: string; withdrawn_at: string | null; standing: boolean }[];
    // mine's approval was withdrawn above (the same database); ours stands.
    expect(before.find((a) => a.name === F.publishedPkg)).toMatchObject({ decision: "approved", withdrawn_at: null, standing: true });
    expect(before.find((a) => a.name === F.factoryPkg)).toMatchObject({ decision: "approved", withdrawn_at: expect.any(String), standing: false });
    for (const a of before) expect(a.standing).toBe(stands(a));
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

  it("a source is late by one constant, marked on its coverage row and named at the top of /stats", async () => {
    let s = (await call("GET", "/stats")).json;
    expect(s.late_after_hours).toBe(LATE_AFTER_HOURS);
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

// A page's own statements: page() splices HELPERS whole, so what follows its last lines is the page's (as test/pages.test.ts reads it).
const shellEnd = HELPERS.slice(-120);
function ownScript(html: string): string {
  const script = scriptOf(html), at = script.indexOf(shellEnd);
  expect(at, "the shell is spliced whole").toBeGreaterThan(0);
  return script.slice(at + shellEnd.length);
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
    expect(HELPERS).toContain(`var LATE_MS = ${LATE_AFTER_HOURS} * 3600e3;`);
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
