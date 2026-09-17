/**
 * One truth per fact. The consistency audit (2026-09-18) found the same
 * fact computed two ways on neighbouring pages: a withdrawn approval
 * "landed" on the Factory and "withdrawn" on Review; "waiting for review"
 * counted three ways on three tiles; the package page rewriting ?ring=lab
 * to stable while Review linked to the lab; a source late at six hours in
 * one table and nine in the headline. This file pins the server's one
 * answer to each, over the fixture (test/fixture.ts), so the pages have one
 * number to read and a page that computes its own fails by name.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { RINGS, RINGS_BY_STABILITY } from "../src/index";
import { RING_TEXT } from "../src/meta";
import { waitsForMaintainer, stands } from "../src/routes/review";
import { maintenanceOf } from "../src/routes/users";
import { LATE_AFTER_HOURS } from "../src/routes/stats";
import { seedDashboard, type Fixture } from "./fixture";

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
