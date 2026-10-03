/**
 * One name, one package (#242). `marcelo` is a package; x86_64 and aarch64
 * are two targets of it, built each on a worker of its architecture, and a
 * request, a review and a block are about the name.
 *
 * First the migration (0036): the per-architecture rows production holds —
 * a decision per build, withdrawn and rejected ones among them, packages
 * blocked, in review, built for one architecture and not the other — are
 * seeded on the schema as it was before, the migration's own statements
 * run over them, and every fact is read back: the rows unchanged, each in
 * exactly one review, each review its rows' decision, the targets what the
 * runtime rule (targetsOf) says of the same rows. Then the flow, through the
 * doors: a package requested for both architectures, built on x86_64 and
 * not on aarch64, reviewed once, published on x86_64 alone — the same
 * story tests/e2e-worker.sh tells with the real publisher.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../src/index";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { reserveName, sha256Hex } from "../src/routes/contributors";
import { asReviews, wholeReviews } from "../src/routes/review";
import { settleTargets, targetsOf, type TargetBuild, type TargetDecision } from "../src/targets";
import { packageKey } from "../src/r2";
import { runScript, scriptOf } from "./fixture";
import { decider } from "./decide";

const API = "http://pool.test/api/v1";
/** Approve and block, decided in the browser with the maintainer's passkey (#271): decide.ts. */
const web = decider(env);

async function call(method: string, path: string, body?: unknown, token?: string, raw?: string, on: Env = env): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(API + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), on, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** The Worker's env with every statement it prepares noted, with its bindings: what a door read, to ask the planner how it reads it. */
function traced(): { env: Env; seen: { sql: string; args: unknown[] }[] } {
  const seen: { sql: string; args: unknown[] }[] = [];
  const DB = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => {
          const entry = { sql, args: [] as unknown[] };
          seen.push(entry);
          const stmt = target.prepare(sql);
          // Bound, the statement is D1's own again: a batch takes it as it is.
          return new Proxy(stmt, { get: (s, k) => (k === "bind" ? (...args: unknown[]) => { entry.args = args; return s.bind(...args); } : typeof Reflect.get(s, k) === "function" ? Reflect.get(s, k).bind(s) : Reflect.get(s, k)) });
        };
      }
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { env: { ...env, DB }, seen };
}

/** How the planner reads a statement the Worker ran, with the bindings it ran with. */
async function planOf(x: { sql: string; args: unknown[] }): Promise<string> {
  return (await env.DB.prepare(`EXPLAIN QUERY PLAN ${x.sql}`).bind(...x.args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
}

/** What 0036 added, taken off again, and what the migrations after it added (the package's maintainer in the pool, #244; the reviews table takes its changes column, #247, with it): the schema as production has it before the migration. */
const REWIND = [
  // What 0046 added (host orders, #344) comes off first: its table, with its indexes.
  "DROP TABLE host_orders",
  "ALTER TABLE factory_packages DROP COLUMN disk_gb",
  "ALTER TABLE factory_packages DROP COLUMN size",
  "ALTER TABLE build_tasks DROP COLUMN lease_missed",
  "ALTER TABLE build_tasks DROP COLUMN host_losses",
  "ALTER TABLE build_tasks DROP COLUMN claim_id",
  "ALTER TABLE build_tasks DROP COLUMN release",
  "ALTER TABLE build_tasks DROP COLUMN disk_gb",
  "ALTER TABLE build_tasks DROP COLUMN size",
  "ALTER TABLE build_tasks DROP COLUMN units",
  "ALTER TABLE build_tasks DROP COLUMN lane",
  "ALTER TABLE build_tasks DROP COLUMN lease_gen",
  // What 0045 added (host leases, #334) comes off first — its open-order indexes go with 0042's table —, then 0043's (maintainer hosts, #321 — with the columns 0044 added to them, #322), then 0042's (orders to workers, #277), then 0041's (a package's ELF class, #275), then 0040's (passkeys for approve and block, #257), then 0039's (the MCP write tools, #252), so the migrations after 0036 run again in their order below.
  "DROP INDEX idx_build_workers_host",
  "ALTER TABLE build_workers DROP COLUMN kind",
  "ALTER TABLE build_workers DROP COLUMN host_id",
  "DROP TABLE host_nonces",
  "DROP TABLE hosts",
  "DROP TABLE host_enrollments",
  "ALTER TABLE contributors DROP COLUMN github_id",
  "ALTER TABLE build_tasks DROP COLUMN stop_order",
  "DROP INDEX idx_build_workers_site",
  "DROP INDEX idx_build_workers_not_ready",
  "ALTER TABLE build_workers DROP COLUMN auto_orders",
  "ALTER TABLE build_workers DROP COLUMN drain_reason",
  "ALTER TABLE build_workers DROP COLUMN drained_by",
  "ALTER TABLE build_workers DROP COLUMN drained_at",
  "ALTER TABLE build_workers DROP COLUMN agent_error_class",
  "ALTER TABLE build_workers DROP COLUMN agent_probed_at",
  "ALTER TABLE build_workers DROP COLUMN agent_error_since",
  "ALTER TABLE build_workers DROP COLUMN rollout",
  "ALTER TABLE build_workers DROP COLUMN restarts_left",
  "ALTER TABLE build_workers DROP COLUMN site",
  "ALTER TABLE build_workers DROP COLUMN agent_via",
  "ALTER TABLE build_workers DROP COLUMN started_at",
  "ALTER TABLE build_workers DROP COLUMN watchdog_exits",
  "ALTER TABLE build_workers DROP COLUMN crash_loop_since",
  "ALTER TABLE build_workers DROP COLUMN instance_finished",
  "ALTER TABLE build_workers DROP COLUMN instance_churn",
  "ALTER TABLE build_workers DROP COLUMN instance_other_at",
  "ALTER TABLE build_workers DROP COLUMN instance_conflict_at",
  "ALTER TABLE build_workers DROP COLUMN instance_since",
  "ALTER TABLE build_workers DROP COLUMN instance_prev",
  "ALTER TABLE build_workers DROP COLUMN instance",
  "ALTER TABLE build_workers DROP COLUMN order_kinds",
  "ALTER TABLE build_workers DROP COLUMN open_orders",
  "DROP TABLE worker_orders",
  "ALTER TABLE packages DROP COLUMN elf_class",
  "DROP TABLE passkeys",
  "DROP TABLE passkey_challenges",
  "DROP TABLE agent_grants",
  "DROP TABLE drafts",
  "DROP INDEX idx_build_workers_owner",
  "ALTER TABLE package_requests DROP COLUMN agent",
  "ALTER TABLE approvals DROP COLUMN agent",
  "ALTER TABLE contributors DROP COLUMN agent_day",
  "ALTER TABLE contributors DROP COLUMN agent_requests",
  "ALTER TABLE contributors DROP COLUMN agent_claims",
  "ALTER TABLE contributors DROP COLUMN agent_drafts",
  "DROP INDEX idx_approvals_review",
  "ALTER TABLE approvals DROP COLUMN review_id",
  "DROP TABLE reviews",
  "ALTER TABLE factory_packages DROP COLUMN targets",
  "ALTER TABLE factory_packages DROP COLUMN closed_through",
  "ALTER TABLE factory_packages DROP COLUMN freed_by_review",
  "DROP TABLE package_maintainers",
];

const schema = async () => (await env.DB.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY type, name").all<{ type: string; name: string; sql: string | null }>()).results;

beforeAll(async () => {
  const h = (t: string) => sha256Hex(t);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2')`),
    env.DB.prepare(`INSERT INTO contributors (login, token_hash, session_hash, role) VALUES ('m1', ?, ?, 'maintainer'), ('m2', ?, ?, 'maintainer'), ('alice', ?, NULL, 'contributor'), ('bob', ?, NULL, 'contributor'), ('carol', ?, NULL, 'contributor'), ('dave', ?, NULL, 'contributor')`)
      .bind(await h("omc_m1"), await h("oms_m1"), await h("omc_m2"), await h("oms_m2"), await h("omc_alice"), await h("omc_bob"), await h("omc_carol"), await h("omc_dave")),
  ]);
});

describe("migration 0036: one package per name, with a target per architecture", () => {
  const day = (d: number) => new Date(Date.UTC(2026, 8, 1 + d, 12)).toISOString();
  const ids: Record<string, number> = {};
  let before: { approvals: Record<string, unknown>[]; tasks: Record<string, unknown>[]; packages: Record<string, unknown>[]; schema: Awaited<ReturnType<typeof schema>> };

  // A build, as the factory writes one: a contributor's (community), the project's again (review), or the project's from a recipe (publish, no review).
  const task = async (key: string, t: { name: string; arch: string; status: string; trust?: "community" | "project"; kind?: string; version?: string; review?: string; publish?: number; params?: Record<string, unknown>; error?: string }) => {
    const params = t.params ?? (t.review ? { review: ids[t.review] } : null);
    ids[key] = (await env.DB.prepare(
      `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, params, error)
       VALUES (?, ?, ?, ?, 'contributor', 100, ?, ?, 'alice', ?, ?, ?, ?) RETURNING id`,
    ).bind(t.name, t.arch, t.version ?? "1.0-1", t.review ? `review:${ids[t.review]}` : t.trust === "project" ? "0123abc" : `draft:https://${t.name}.example@latest`, t.publish ?? 0, t.trust ?? "community", t.kind ?? "build", t.status, params ? JSON.stringify(params) : null, t.error ?? null)
      .first<{ id: number }>())!.id;
  };
  // A decision on one architecture's build, as review.ts wrote them before #242.
  const decide = async (key: string, a: { name: string; arch: string; task: string; rebuild?: string | null; version: string; decision?: "approved" | "rejected"; by: string; note: string; at: number; withdrawn?: { at: number; by: string; reason: string } }) => {
    ids[key] = (await env.DB.prepare(
      `INSERT INTO approvals (task_id, name, arch, version, decision, by, note, rebuild_task, created_at, withdrawn_at, withdrawn_by, withdrawn_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(ids[a.task], a.name, a.arch, a.version, a.decision ?? "approved", a.by, a.note, a.rebuild === null ? null : ids[a.rebuild ?? a.task], day(a.at), a.withdrawn ? day(a.withdrawn.at) : null, a.withdrawn?.by ?? null, a.withdrawn?.reason ?? null)
      .first<{ id: number }>())!.id;
  };

  it("runs over production's rows on the schema before it, and changes nothing it does not add", async () => {
    const after0036 = await schema();
    await env.DB.batch(REWIND.map((q) => env.DB.prepare(q)));
    expect((await schema()).map((x) => x.name)).not.toContain("reviews");

    const both = '["x86_64","aarch64"]', x86 = '["x86_64"]';
    await env.DB.prepare(
      `INSERT INTO factory_packages (name, owner, url, arches, status, detail, blocked_at, blocked_by, blocked_reason) VALUES
         ('felix', 'alice', 'https://felix.example', ?1, 'published', 'in edge', NULL, NULL, NULL),
         ('obsidian', 'alice', 'https://obsidian.example', ?1, 'published', 'in edge', NULL, NULL, NULL),
         ('bitwarden', 'bob', 'https://bitwarden.example', ?1, 'published', 'in edge', NULL, NULL, NULL),
         ('zed', 'carol', 'https://zed.example', ?2, 'waiting', 'in the queue', NULL, NULL, NULL),
         ('rusty', 'dave', 'https://rusty.example', ?1, 'rejected', 'blocked', '2026-09-10T12:00:00.000Z', 'm1', 'ships a token stealer'),
         ('mise', 'alice', 'https://mise.example', ?1, 'staged', 'the project is building it', NULL, NULL, NULL),
         ('helix', 'bob', 'https://helix.example', ?1, 'approved', 'publishing', NULL, NULL, NULL),
         ('yazi', 'carol', 'https://yazi.example', ?2, 'published', 'in edge', NULL, NULL, NULL),
         ('fresh', 'alice', 'https://fresh.example', ?1, 'registered', 'requested', NULL, NULL, NULL),
         ('odd', 'bob', 'https://odd.example', ?2, 'published', 'renewed for x86_64 alone', NULL, NULL, NULL)`,
    ).bind(both, x86).run();
    // The pool's own jobs share the table and carry no package's name.
    await env.DB.prepare("INSERT INTO build_tasks (name, arch, pkgbuild_ref, reason, priority, publish, trust, kind, status) VALUES ('sync', 'x86_64', '-', 'scheduled', 50, 1, 'project', 'sync', 'done'), ('render', 'aarch64', '-', 'scheduled', 50, 1, 'project', 'render', 'done')").run();

    // felix: built on both, the project built each again, approved one architecture at a time by m2 — one decision.
    await task("c1", { name: "felix", arch: "x86_64", status: "staged" });
    await task("c2", { name: "felix", arch: "aarch64", status: "staged" });
    await task("audit1", { name: "felix", arch: "x86_64", status: "done", kind: "audit", trust: "project", params: { task: 0 } });
    await task("p1", { name: "felix", arch: "x86_64", status: "done", trust: "project", review: "c1" });
    await task("p2", { name: "felix", arch: "aarch64", status: "done", trust: "project", review: "c2" });
    await task("pub1", { name: "felix", arch: "x86_64", status: "done", kind: "publish", trust: "project", publish: 1, params: { task: 0 } });
    await decide("a1", { name: "felix", arch: "x86_64", task: "p1", version: "1.0-1", by: "m2", note: "looks right", at: 1 });
    await decide("a2", { name: "felix", arch: "aarch64", task: "p2", version: "1.0-1", by: "m2", note: "the same on arm", at: 2 });
    // Then its bump to 1.1 failed on x86_64: the next version's failure — x86_64 is still in the pool, published.
    await task("fb", { name: "felix", arch: "x86_64", status: "failed", version: "1.1-1", error: "exit 4: the bump does not build" });
    // obsidian: x86_64 approved and published; aarch64 never built — its contributor's build failed.
    await task("c3", { name: "obsidian", arch: "x86_64", status: "staged" });
    await task("p3", { name: "obsidian", arch: "x86_64", status: "done", trust: "project", review: "c3" });
    await task("c4", { name: "obsidian", arch: "aarch64", status: "failed", error: "exit 96: rustc does not start under emulation" });
    await decide("a3", { name: "obsidian", arch: "x86_64", task: "p3", version: "1.0-1", by: "m1", note: "reads well", at: 3 });
    // bitwarden: both approved by m1, x86_64's taken back by m2 — two decisions, one standing.
    await task("c5", { name: "bitwarden", arch: "x86_64", status: "staged", version: "2026.9-1" });
    await task("p5", { name: "bitwarden", arch: "x86_64", status: "done", trust: "project", review: "c5", version: "2026.9-1" });
    await task("c6", { name: "bitwarden", arch: "aarch64", status: "staged", version: "2026.9-1" });
    await task("p6", { name: "bitwarden", arch: "aarch64", status: "done", trust: "project", review: "c6", version: "2026.9-1" });
    await decide("a4", { name: "bitwarden", arch: "x86_64", task: "p5", version: "2026.9-1", by: "m1", note: "ok", at: 4, withdrawn: { at: 5, by: "m2", reason: "approved by mistake" } });
    await decide("a5", { name: "bitwarden", arch: "aarch64", task: "p6", version: "2026.9-1", by: "m1", note: "ok", at: 4 });
    // zed: rejected twice, a failed build between, a new one in the queue.
    await task("c7", { name: "zed", arch: "x86_64", status: "cancelled", error: "rejected by m1: no checksums" });
    await decide("a6", { name: "zed", arch: "x86_64", task: "c7", rebuild: null, version: "1.0-1", decision: "rejected", by: "m1", note: "no checksums", at: 6 });
    await task("c7f", { name: "zed", arch: "x86_64", status: "failed", version: "1.0-2", error: "exit 4" });
    await task("c8", { name: "zed", arch: "x86_64", status: "cancelled", version: "1.0-2", error: "rejected by m1: still no checksums" });
    await decide("a7", { name: "zed", arch: "x86_64", task: "c8", rebuild: null, version: "1.0-2", decision: "rejected", by: "m1", note: "still no checksums", at: 7 });
    await task("c10", { name: "zed", arch: "x86_64", status: "queued", version: "1.0-3" });
    // rusty: approved on x86_64, then blocked — a block from before #242 left the approval standing; aarch64 had failed.
    await task("c11", { name: "rusty", arch: "x86_64", status: "cancelled", version: "0.1-1", error: "blocked by m1" });
    await task("p11", { name: "rusty", arch: "x86_64", status: "cancelled", trust: "project", review: "c11", version: "0.1-1", error: "blocked by m1" });
    await decide("a8", { name: "rusty", arch: "x86_64", task: "p11", version: "0.1-1", by: "m2", note: "fine", at: 8 });
    await task("c12", { name: "rusty", arch: "aarch64", status: "failed", version: "0.1-1" });
    // mise: in review now — the project builds x86_64 again, aarch64 is built and waits.
    await task("c13", { name: "mise", arch: "x86_64", status: "staged" });
    await task("p13", { name: "mise", arch: "x86_64", status: "queued", trust: "project", review: "c13" });
    await task("c14", { name: "mise", arch: "aarch64", status: "staged" });
    // helix: x86_64 approved, taken back, approved again by the same maintainer; aarch64 approved beside the second — two decisions.
    await task("c15", { name: "helix", arch: "x86_64", status: "staged", version: "25.1-1" });
    await task("p15", { name: "helix", arch: "x86_64", status: "staged", trust: "project", review: "c15", version: "25.1-1" });
    await task("c16", { name: "helix", arch: "aarch64", status: "staged", version: "25.1-1" });
    await task("p16", { name: "helix", arch: "aarch64", status: "staged", trust: "project", review: "c16", version: "25.1-1" });
    await decide("a9", { name: "helix", arch: "x86_64", task: "p15", version: "25.1-1", by: "m2", note: "first look", at: 10, withdrawn: { at: 11, by: "m1", reason: "the wrong tag" } });
    await decide("a10", { name: "helix", arch: "x86_64", task: "p15", version: "25.1-1", by: "m2", note: "the right tag", at: 12 });
    await decide("a11", { name: "helix", arch: "aarch64", task: "p16", version: "25.1-1", by: "m2", note: "and arm", at: 12 });
    // yazi: the direct approval before #182 — the contributor's build approved, the project built the recipe on main.
    await task("c17", { name: "yazi", arch: "x86_64", status: "staged", version: "0.9-1" });
    await decide("a12", { name: "yazi", arch: "x86_64", task: "c17", rebuild: null, version: "0.9-1", by: "m1", note: "ok", at: 13 });
    await task("e1", { name: "yazi", arch: "x86_64", status: "done", trust: "project", publish: 1, version: "0.9-1" });
    // fresh: requested, nothing built — a dry run of the project's sized it, and says nothing of where it stands.
    await task("d1", { name: "fresh", arch: "x86_64", status: "done", trust: "project", publish: 0 });
    // odd: renewed for x86_64 alone; the approval of aarch64 still stands.
    await task("c18", { name: "odd", arch: "aarch64", status: "staged" });
    await task("p18", { name: "odd", arch: "aarch64", status: "done", trust: "project", review: "c18" });
    await decide("a13", { name: "odd", arch: "aarch64", task: "p18", version: "1.0-1", by: "m1", note: "ok", at: 14 });

    const read = async () => ({
      approvals: (await env.DB.prepare("SELECT * FROM approvals ORDER BY id").all()).results,
      tasks: (await env.DB.prepare("SELECT * FROM build_tasks ORDER BY id").all()).results,
      packages: (await env.DB.prepare("SELECT * FROM factory_packages ORDER BY name").all()).results,
    });
    before = { ...(await read()), schema: await schema() };

    // The migration's own statements, as D1 applies them.
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0036_"))!;
    expect(m, "migration 0036 is in the list").toBeTruthy();
    await env.DB.batch(m.queries.map((q) => env.DB.prepare(q)));
    // The migrations after it run again too, in their order — what the rewind took off (the maintainers' table, #244; with the reviews table, its changes column, #247; 0039's tables and columns, #252; 0040's passkeys, #257; 0041's ELF class, #275; 0042's orders to workers, #277; 0043's maintainer hosts, #321, and 0044's columns on them, #322; 0045's host leases, #334; 0046's host orders, #344) comes back as D1 applies it.
    for (const later of env.TEST_MIGRATIONS.filter((x) => x.name > m.name)) await env.DB.batch(later.queries.map((q) => env.DB.prepare(q)));

    // The schema is what every other test file runs on, and nothing of the rows it had changed.
    expect(await schema()).toEqual(after0036);
    const now = await read();
    // 0042 adds a task's stop fence (#277), NULL on every row it finds; 0045 a host lease's columns (#334), NULL or 0 on every row.
    expect(now.tasks.map(({ stop_order: so, lease_gen: g, lane: l, units: u, size: z, disk_gb: d, release: r, claim_id: c, host_losses: hl, lease_missed: lm, ...t }) => (expect([so, g, l, u, z, d, r, c]).toEqual([null, null, null, null, null, null, null, null]), expect([hl, lm]).toEqual([0, 0]), t))).toEqual(before.tasks);
    expect(now.approvals.map(({ review_id: _, agent: _a, ...a }) => a)).toEqual(before.approvals);
    expect(now.packages.map(({ targets: _t, closed_through: _c, freed_by_review: _f, size: _s, disk_gb: _d, ...p }) => p)).toEqual(before.packages);
    // A rejection before #242 freed no name: every name is held as it was.
    expect(now.packages.every((p) => p.freed_by_review === null)).toBe(true);
    // The helper table is gone with the statement that made it.
    expect((await schema()).map((x) => x.name)).not.toContain("target_merge");
  });

  it("puts every per-architecture row in exactly one review — the decision it was — and a review's id is its first row's", async () => {
    const rows = (await env.DB.prepare("SELECT id, name, arch, version, decision, by, note, created_at, withdrawn_at, withdrawn_by, withdrawn_reason, review_id FROM approvals ORDER BY id").all<{ id: number; name: string; arch: string; version: string; decision: string; by: string; note: string; created_at: string; withdrawn_at: string | null; withdrawn_by: string | null; withdrawn_reason: string | null; review_id: number | null }>()).results;
    expect(rows.every((r) => r.review_id !== null)).toBe(true);
    const reviewOf = (key: string) => rows.find((r) => r.id === ids[key])!.review_id;
    // felix's two, helix's second x86_64 with its aarch64: one review each; everything else a review of its own.
    expect(reviewOf("a2")).toBe(ids.a1);
    expect(reviewOf("a11")).toBe(ids.a10);
    for (const k of ["a1", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a12", "a13"]) expect(reviewOf(k), k).toBe(ids[k]);
    const reviews = (await env.DB.prepare("SELECT * FROM reviews ORDER BY id").all<Record<string, unknown>>()).results;
    expect(reviews.map((r) => r.id)).toEqual(["a1", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a12", "a13"].map((k) => ids[k]));
    // Each review is its first row's decision — who, what, when, the note, standing or withdrawn — and names every architecture of its rows, in their order.
    for (const v of reviews) {
      const mine = rows.filter((r) => r.review_id === v.id);
      const first = mine[0];
      expect(v).toMatchObject({ name: first.name, version: first.version, decision: first.decision, by: first.by, note: first.note, created_at: first.created_at, withdrawn_at: first.withdrawn_at, withdrawn_by: first.withdrawn_by, withdrawn_reason: first.withdrawn_reason, migrated: 1, released: 0, not_supported: "{}" });
      expect(JSON.parse(v.arches as string)).toEqual(mine.map((r) => r.arch));
      // A review stands or not as one: its rows agree.
      expect(new Set(mine.map((r) => r.withdrawn_at === null)).size).toBe(1);
    }
    expect(JSON.parse(reviews.find((v) => v.id === ids.a1)!.arches as string)).toEqual(["x86_64", "aarch64"]);
    // No row is in two reviews and no review is empty: the targets add up to the rows.
    expect(reviews.reduce((n, v) => n + (JSON.parse(v.arches as string) as string[]).length, 0)).toBe(rows.length);
  });

  it("gives every package a target per architecture, by the rule the brain keeps them with", async () => {
    const packages = (await env.DB.prepare("SELECT name, arches, targets, closed_through FROM factory_packages ORDER BY name").all<{ name: string; arches: string; targets: string; closed_through: number }>()).results;
    const targets = Object.fromEntries(packages.map((p) => [p.name, JSON.parse(p.targets)]));
    const t = (status: string, key: string | null) => ({ status, task: key ? ids[key] : null });
    expect(targets).toEqual({
      // The failed bump is 1.1's: 1.0 is what the rings serve on x86_64.
      felix: { x86_64: t("published", "p1"), aarch64: t("published", "p2") },
      obsidian: { x86_64: t("published", "p3"), aarch64: t("not_supported", "c4") },
      // x86_64's approval was taken back after it was published: that build is spent, the contributor's waits again.
      bitwarden: { x86_64: t("built", "c5"), aarch64: t("published", "p6") },
      // The two rejections closed their rounds, the failed build between them with them; the new build is where zed stands.
      zed: { x86_64: t("building", "c10") },
      // Blocked: its builds cancelled, the failure before the block a closed round.
      rusty: { x86_64: t("waiting", null), aarch64: t("waiting", null) },
      mise: { x86_64: t("reviewing", "p13"), aarch64: t("built", "c14") },
      helix: { x86_64: t("approved", "p15"), aarch64: t("approved", "p16") },
      yazi: { x86_64: t("published", "e1") },
      fresh: { x86_64: t("waiting", null), aarch64: t("waiting", null) },
      odd: { x86_64: t("waiting", null), aarch64: t("published", "p18") },
    });
    expect(Object.fromEntries(packages.map((p) => [p.name, p.closed_through]))).toEqual({ felix: 0, obsidian: 0, bitwarden: 0, zed: ids.c8, rusty: ids.c12, mise: 0, helix: 0, yazi: 0, fresh: 0, odd: 0 });
    // The runtime rule over the same rows says the same, package by package — read whole here, and read bounded as settleTargets reads them.
    for (const p of packages) {
      const builds = (await env.DB.prepare("SELECT id, arch, status, trust, publish, json_extract(params, '$.review') AS review FROM build_tasks WHERE name = ? AND kind = 'build'").bind(p.name).all<TargetBuild>()).results;
      const decisions = (await env.DB.prepare("SELECT arch, task_id, rebuild_task, decision, withdrawn_at FROM approvals WHERE name = ?").bind(p.name).all<TargetDecision>()).results;
      expect(targetsOf(JSON.parse(p.arches), builds, decisions, p.closed_through), p.name).toEqual(targets[p.name]);
      expect((await settleTargets(env, p.name))[p.name], p.name).toEqual(targets[p.name]);
    }
  });

  it("serves one package with a status per architecture, and the record one row per review", async () => {
    const story = await call("GET", "/factory/packages/obsidian/story");
    expect(story.status).toBe(200);
    expect(story.json.targets).toEqual({ x86_64: { status: "published", task: ids.p3 }, aarch64: { status: "not_supported", task: ids.c4 } });
    expect(story.json.package.targets).toEqual(story.json.targets);
    const registry = (await call("GET", "/factory/packages")).json.packages;
    expect(registry.find((p: any) => p.name === "felix").targets).toEqual({ x86_64: { status: "published", task: ids.p1 }, aarch64: { status: "published", task: ids.p2 } });
    const record = (await call("GET", "/factory/approvals")).json.approvals;
    const felix = record.filter((a: any) => a.name === "felix");
    expect(felix).toHaveLength(1);
    expect(felix[0]).toMatchObject({ id: ids.a1, review: ids.a1, decision: "approved", by: "m2", standing: true, arches: ["x86_64", "aarch64"], task_id: ids.p1, arch: "x86_64" });
    expect(felix[0].targets.map((x: any) => [x.arch, x.task_id, x.rebuild_task])).toEqual([["x86_64", ids.p1, ids.p1], ["aarch64", ids.p2, ids.p2]]);
    // bitwarden's two decisions stay two: one withdrawn, one standing.
    expect(record.filter((a: any) => a.name === "bitwarden").map((a: any) => [a.arches, a.standing])).toEqual([[["aarch64"], true], [["x86_64"], false]]);
    // Every row of the table is in the record, once.
    expect(record.reduce((n: number, a: any) => n + a.targets.length, 0)).toBe((await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals").first<{ n: number }>())!.n);
  });

  it("a merged review is taken back whole: every architecture of it, from either build", async () => {
    const wd = await call("POST", `/factory/tasks/${ids.p2}/withdraw`, { note: "withdrawn as one decision" }, "omc_m1");
    expect(wd.status, JSON.stringify(wd.json)).toBe(200);
    expect(wd.json).toMatchObject({ review: ids.a1, arches: ["x86_64", "aarch64"], by: "m1" });
    expect((await env.DB.prepare("SELECT id, withdrawn_by FROM approvals WHERE name = 'felix' ORDER BY id").all()).results).toEqual([{ id: ids.a1, withdrawn_by: "m1" }, { id: ids.a2, withdrawn_by: "m1" }]);
    expect(await env.DB.prepare("SELECT withdrawn_by, withdrawn_reason FROM reviews WHERE id = ?").bind(ids.a1).first()).toEqual({ withdrawn_by: "m1", withdrawn_reason: "withdrawn as one decision" });
    // Nothing of felix stands: no second withdrawal from the other build.
    expect((await call("POST", `/factory/tasks/${ids.p1}/withdraw`, { note: "and again" }, "omc_m1")).status).toBe(404);
  });

  it("a block takes the review a package stood on back with it, every architecture, and another maintainer's lift sends it back to the factory", async () => {
    const t = traced();
    const blocked = await web.decide("m1", "/factory/packages/helix/block", { reason: "ships a binary the source does not build" }, t.env);
    expect(blocked.status, JSON.stringify(blocked.json)).toBe(200);
    // Where the round closes, the package's last build, is found through the name's index, not the index of every build's kind.
    const closing = t.seen.filter((x) => x.sql.includes("closed_through = MAX(closed_through"));
    expect(closing).toHaveLength(1);
    expect(await planOf(closing[0])).toMatch(/SEARCH t USING (COVERING )?INDEX idx_build_tasks_name/);
    expect(blocked.json.withdrawn).toEqual([ids.a10]);
    expect((await env.DB.prepare("SELECT id FROM approvals WHERE name = 'helix' AND decision = 'approved' AND withdrawn_at IS NULL").all()).results).toEqual([]);
    expect(await env.DB.prepare("SELECT withdrawn_by, withdrawn_reason FROM approvals WHERE id = ?").bind(ids.a11).first()).toEqual({ withdrawn_by: "m1", withdrawn_reason: "blocked by m1: ships a binary the source does not build" });
    expect(await env.DB.prepare("SELECT withdrawn_by FROM reviews WHERE id = ?").bind(ids.a10).first()).toEqual({ withdrawn_by: "m1" });
    // Its builds stopped and closed: nothing of it is where it stands.
    expect(JSON.parse((await env.DB.prepare("SELECT targets FROM factory_packages WHERE name = 'helix'").first<{ targets: string }>())!.targets)).toEqual({ x86_64: { status: "waiting", task: null }, aarch64: { status: "waiting", task: null } });
    expect((await call("POST", "/factory/packages/helix/unblock", { reason: "the binary is the source's" }, "omc_m1")).status).toBe(403);
    expect((await call("POST", "/factory/packages/helix/unblock", { reason: "the binary is the source's" }, "omc_m2")).status).toBe(200);
    expect(await env.DB.prepare("SELECT status, blocked_at FROM factory_packages WHERE name = 'helix'").first()).toEqual({ status: "registered", blocked_at: null });
  });
});

describe("a package built for two architectures", () => {
  const agent = { agent: "openai/gpt-5", agent_status: "ok" };
  beforeAll(async () => {
    const h = (t: string) => sha256Hex(t);
    await env.DB.batch([
      // The queue is this story's alone: what the migration's rows left queued (zed's build, mise's rebuild) waits for no worker here.
      env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'not this story' WHERE status = 'queued'"),
      env.DB.prepare(`INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES
        ('cx', 'x86_64', 'alice', ?, 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z'),
        ('ca', 'aarch64', 'alice', ?, 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z'),
        ('px', 'x86_64', 'm1', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z'),
        ('pa', 'aarch64', 'm1', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z')`).bind(await h("omw_cx"), await h("omw_ca"), await h("omw_px"), await h("omw_pa")),
    ]);
  });
  const checklist = { official: true, license: true, unshipped: true, evidence: true };
  const request = (name: string, token = "omc_alice", arches = ["x86_64", "aarch64"], version = "1.0") =>
    call("POST", "/factory/packages", { name, url: `https://${name}.example`, source: `https://${name}.example/${name}-${version}.tar.gz`, version, description: `${name}, a tool built for two architectures`, license: "MIT", arches, checklist }, token);
  const targetsOf = async (name: string) => JSON.parse((await env.DB.prepare("SELECT targets FROM factory_packages WHERE name = ?").bind(name).first<{ targets: string }>())!.targets);
  // A worker's build of the package, through the gate: its evidence, its package, staged.
  const build = async (worker: string, arch: string, name: string, kinds?: string[]) => {
    const c = await call("POST", "/factory/claim", { arch, ...agent, ...(kinds ? { kinds } : {}) }, worker);
    expect(c.status, `${worker} claims ${name}: ${JSON.stringify(c.json)}`).toBe(200);
    expect(c.json.task).toMatchObject({ name, arch });
    return c.json as { task: { id: number; name: string; arch: string; params: Record<string, unknown> }; token: string };
  };
  const stage = async (c: { task: { id: number; name: string; arch: string }; token: string }) => {
    const file = `${c.task.name}-1.0-1-${c.task.arch}.pkg.tar.zst`;
    for (const f of ["PKGBUILD", "build.log", "PKGINFO", file]) expect((await call("PUT", `/factory/tasks/${c.task.id}/artifacts/${f}`, undefined, c.token, `${f} of ${c.task.id}`)).status).toBe(201);
    await call("PUT", `/factory/tasks/${c.task.id}/artifacts/vet.json`, undefined, c.token, JSON.stringify({ schema: "omarchy-pool/vet/1", verdict: "pass", checks: [{ name: "smoke", status: "pass", detail: "" }] }));
    const done = await call("POST", `/factory/tasks/${c.task.id}/complete`, { sha256: "c".repeat(64), filename: file, version: "1.0-1" }, c.token);
    expect(done.json, JSON.stringify(done.json)).toMatchObject({ status: "staged" });
  };

  it("reserves the name in one statement: taken by one request, refused to another — a new name or a freed one — and a block frees nothing", async () => {
    const reserve = (login: string) => reserveName(env, "race", login, "https://race.example", ["x86_64"]);
    const row = () => env.DB.prepare("SELECT owner, status, freed_by_review FROM factory_packages WHERE name = 'race'").first();
    expect(await reserve("alice")).toBe(true);
    expect(await reserve("bob")).toBe(false);
    expect(await reserve("alice")).toBe(true); // her own: a renewal
    expect(await row()).toEqual({ owner: "alice", status: "registered", freed_by_review: null });
    // Rejected by a block of its owner's, not by a review: the name is still hers.
    await env.DB.prepare("UPDATE factory_packages SET status = 'rejected' WHERE name = 'race'").run();
    expect(await reserve("bob")).toBe(false);
    // Freed by a review's rejection: anyone's — and the first to take it has it. The reservation moves it out of the free set in the same
    // statement, so the next request finds it held: without that, carol took it back from bob and both requests were written (#242 review).
    await env.DB.prepare("UPDATE factory_packages SET status = 'rejected', freed_by_review = 1 WHERE name = 'race'").run();
    expect(await reserve("bob")).toBe(true);
    expect(await reserve("carol")).toBe(false);
    expect(await row()).toEqual({ owner: "bob", status: "registered", freed_by_review: null });
    // Left unmaintained: the same, once.
    await env.DB.prepare("UPDATE factory_packages SET status = 'unmaintained' WHERE name = 'race'").run();
    expect(await reserve("carol")).toBe(true);
    expect(await reserve("dave")).toBe(false);
    expect(await row()).toEqual({ owner: "carol", status: "registered", freed_by_review: null });
    // Blocked: nobody's, freed or not.
    await env.DB.prepare("UPDATE factory_packages SET status = 'rejected', freed_by_review = 1, blocked_at = '2026-09-20T00:00:00Z' WHERE name = 'race'").run();
    expect(await reserve("alice")).toBe(false);
    expect(await reserve("carol")).toBe(false);
    // Two requests for one name at once: one of them has it, the other is told whose it is — and wrote nothing.
    const [a, b] = await Promise.all([request("twin"), request("twin", "omc_bob")]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const lost = a.status === 409 ? a : b;
    expect(lost.json.error).toMatch(/^twin is registered, requested by (alice|bob)$/);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM package_requests WHERE name = 'twin'").first<{ n: number }>())!.n).toBe(1);
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'not this story' WHERE name = 'twin' AND status = 'queued'").run();
    // The same for a name a review freed and one left unmaintained: two requests at once, one takes it over, the other is told whose it is and wrote nothing.
    for (const [name, status] of [["loose", "rejected"], ["idle", "unmaintained"]]) {
      await env.DB.prepare("INSERT INTO factory_packages (name, owner, url, arches, status, detail, freed_by_review) VALUES (?, 'carol', ?, '[\"x86_64\",\"aarch64\"]', ?, 'freed', ?)")
        .bind(name, `https://old-${name}.example`, status, status === "rejected" ? 1 : null).run();
      const both = await Promise.all([request(name, "omc_bob"), request(name, "omc_dave")]);
      expect(both.map((x) => x.status).sort(), JSON.stringify(both.map((x) => x.json))).toEqual([200, 409]);
      const won = both.find((x) => x.status === 200)!, lost = both.find((x) => x.status === 409)!;
      expect(lost.json.error).toMatch(new RegExp(`^${name} is (registered|waiting), requested by ${won.json.package.owner}$`));
      expect((await env.DB.prepare("SELECT owner FROM package_requests WHERE name = ?").bind(name).all()).results).toEqual([{ owner: won.json.package.owner }]);
      expect(await env.DB.prepare("SELECT owner, freed_by_review FROM factory_packages WHERE name = ?").bind(name).first()).toEqual({ owner: won.json.package.owner, freed_by_review: null });
      await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'not this story' WHERE name = ? AND status = 'queued'").bind(name).run();
    }
  });

  let x86: number, arm: number, px: number;
  it("is requested once, and each architecture builds on a worker of its own: x86_64 built, aarch64 failing after its tries is not supported", async () => {
    const r = await request("duo");
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.targets).toEqual({ x86_64: { status: "building", task: expect.any(Number) }, aarch64: { status: "building", task: expect.any(Number) } });
    const cx = await build("omw_cx", "x86_64", "duo");
    x86 = cx.task.id;
    await stage(cx);
    expect(await targetsOf("duo")).toMatchObject({ x86_64: { status: "built", task: x86 }, aarch64: { status: "building" } });
    // One review covers every architecture: not before aarch64 is built or not supported.
    let row = (await call("GET", "/factory/review", undefined, "omc_m2")).json.staged.find((t: any) => t.id === x86);
    expect(row).toMatchObject({ waits: false, lead: false, targets: { x86_64: { status: "built" }, aarch64: { status: "building" } } });
    expect(row.can.why.build).toMatch(/^aarch64 is still building \(task \d+\): one review covers every architecture/);
    const ca = await build("omw_ca", "aarch64", "duo");
    arm = ca.task.id;
    expect((await call("POST", `/factory/tasks/${arm}/fail`, { error: "exit 4: the linker for aarch64 is missing", final: true }, ca.token)).json).toMatchObject({ status: "failed" });
    expect(await targetsOf("duo")).toEqual({ x86_64: { status: "built", task: x86 }, aarch64: { status: "not_supported", task: arm } });
    // The package goes on to review with what built: one row speaks for it, and it waits.
    expect(await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'duo'").first()).toEqual({ status: "staged" });
    const review = (await call("GET", "/factory/review", undefined, "omc_m2")).json;
    row = review.staged.find((t: any) => t.id === x86);
    expect(row).toMatchObject({ waits: true, lead: true, can: { build: true, approve: false } });
    // Nobody claimed it yet: it is Review's to claim (#247), by the list's own word.
    expect(review.packages.find((p: any) => p.name === "duo")).toEqual({ name: "duo", owner: "alice", version: "1.0", category: null, targets: { x86_64: { status: "built", task: x86 }, aarch64: { status: "not_supported", task: arm } }, lead: x86, waits: true, rows: [x86], claim: null, state: "ready" });
  });

  it("is built again by the project for every architecture its contributor built — aarch64 is not rebuilt — and approved once", async () => {
    expect((await call("POST", `/factory/tasks/${x86}/build`, { note: "reads well" }, "omc_alice")).status).toBe(403);
    const asked = await call("POST", `/factory/tasks/${x86}/build`, { note: "reads well" }, "omc_m2");
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    expect(asked.json).toMatchObject({ from: x86, arches: ["x86_64"], tasks: [asked.json.task] });
    px = asked.json.task;
    expect(await targetsOf("duo")).toMatchObject({ x86_64: { status: "reviewing", task: px }, aarch64: { status: "not_supported" } });
    const c = await build("omw_px", "x86_64", "duo", ["build"]);
    expect(c.task.id).toBe(px);
    await stage(c);
    expect(await targetsOf("duo")).toMatchObject({ x86_64: { status: "reviewed", task: px } });
    const ok = await web.decide("m2", `/factory/tasks/${px}/approve`, { note: "x86_64 only; aarch64 needs a linker" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ decision: "approved", arches: ["x86_64"], not_supported: { aarch64: arm }, publishes: { x86_64: ok.json.publish } });
    // One review on the record, one row for its one target, one publish job — x86_64's.
    expect(await env.DB.prepare("SELECT name, decision, by, arches, not_supported FROM reviews WHERE id = ?").bind(ok.json.review).first()).toEqual({ name: "duo", decision: "approved", by: "m2", arches: '["x86_64"]', not_supported: JSON.stringify({ aarch64: arm }) });
    expect((await env.DB.prepare("SELECT arch, task_id, review_id FROM approvals WHERE name = 'duo'").all()).results).toEqual([{ arch: "x86_64", task_id: px, review_id: ok.json.review }]);
    expect((await env.DB.prepare("SELECT arch, json_extract(params, '$.task') AS task FROM build_tasks WHERE name = 'duo' AND kind = 'publish'").all()).results).toEqual([{ arch: "x86_64", task: px }]);
    expect(await targetsOf("duo")).toEqual({ x86_64: { status: "approved", task: px }, aarch64: { status: "not_supported", task: arm } });
  });

  it("is published on x86_64 alone, and says aarch64 is not supported", async () => {
    const c = await call("POST", "/factory/claim", { arch: "x86_64", kinds: ["publish"] }, "omw_px");
    expect(c.json.task).toMatchObject({ kind: "publish", name: "duo", arch: "x86_64" });
    // The job names its review as review_id: `review` in a task's params is the contributor's build a project's build answers, and the
    // Worker reads it so — a publish job that carried the review there got a staging upload URL and another build as its provenance.
    const review = (await env.DB.prepare("SELECT review_id FROM approvals WHERE name = 'duo'").first<{ review_id: number }>())!.review_id;
    expect(c.json.task.params).toMatchObject({ task: px, review_id: review });
    expect(c.json.task.params).not.toHaveProperty("review");
    expect(c.json.upload).toBeNull();
    const job = (await call("GET", `/factory/tasks/${c.json.task.id}`)).json;
    expect(job.from).toMatchObject({ id: px, kind: "build" });
    const file = "duo-1.0-1-x86_64.pkg.tar.zst", bytes = new TextEncoder().encode("the project's build of duo"), sha = "d".repeat(64);
    await env.PACKAGES.put(packageKey("factory", "x86_64", file), bytes);
    expect((await call("POST", "/packages?source=factory&arch=x86_64", { schema_version: 1, name: "duo", version: "1.0-1", arch: "x86_64", sha256: sha, filename: file, size_download: bytes.length, size_installed: 1, provides: ["duo"], requires: [] }, c.json.token)).status).toBe(201);
    expect((await call("POST", `/factory/tasks/${c.json.task.id}/complete`, { summary: "published", result: { sha256: sha, filename: file, version: "1.0-1", task: px } }, c.json.token)).json).toMatchObject({ status: "done" });
    expect(await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'duo'").first()).toEqual({ status: "published" });
    const story = (await call("GET", "/factory/packages/duo/story")).json;
    expect(story.targets).toEqual({ x86_64: { status: "published", task: px }, aarch64: { status: "not_supported", task: arm } });
    const decided = (await call("GET", "/factory/approvals?after=duo")).json.approvals.find((a: any) => a.name === "duo"); // past the edge cache
    expect(decided).toMatchObject({ arches: ["x86_64"], not_supported: { aarch64: arm }, standing: true, targets: [{ arch: "x86_64", task_id: px, publish_status: "done" }] });
    // `id` stays the approval row's — the id the journal, a withdrawal and a refusal name — and the review is `review`.
    const approval = (await env.DB.prepare("SELECT id, review_id FROM approvals WHERE name = 'duo'").first<{ id: number; review_id: number }>())!;
    expect(decided).toMatchObject({ id: approval.id, review: approval.review_id });
    // The maintainer's page lists the same review, with what it said of the architecture never built.
    const m2 = (await call("GET", "/users/m2?after=duo")).json;
    expect(m2.approvals.find((a: any) => a.name === "duo")).toMatchObject({ id: approval.id, review: approval.review_id, arches: ["x86_64"], not_supported: { aarch64: arm }, standing: true });
    // No aarch64 build was ever queued by the review, nor a publish of it.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE name = 'duo' AND arch = 'aarch64' AND trust = 'project'").first<{ n: number }>())!.n).toBe(0);
  });

  it("builds both architectures again with one press, approves them with one decision, and takes them back with one", async () => {
    expect((await request("pair")).status).toBe(201);
    const a = await build("omw_cx", "x86_64", "pair"); await stage(a);
    const b = await build("omw_ca", "aarch64", "pair"); await stage(b);
    const asked = await call("POST", `/factory/tasks/${a.task.id}/build`, {}, "omc_m1");
    expect(asked.json).toMatchObject({ arches: ["x86_64", "aarch64"], tasks: [expect.any(Number), expect.any(Number)] });
    const [rx, ra] = asked.json.tasks as number[];
    expect((await call("POST", `/factory/tasks/${b.task.id}/build`, {}, "omc_m1")).json.error).toBe(`the project is already on it: task ${ra} is queued`);
    const cx = await build("omw_px", "x86_64", "pair", ["build"]); await stage(cx);
    // The review waits for the other architecture: approve is refused, with the reason.
    const early = await call("POST", `/factory/tasks/${rx}/approve`, {}, "omc_m2");
    expect(early.status).toBe(409);
    expect(early.json.error).toBe(`the project is still building aarch64 (task ${ra} is queued): one review covers every architecture — approve once it is staged`);
    expect((await call("GET", `/factory/tasks/${rx}/can`, undefined, "omc_m2")).json.can.why.approve).toBe(early.json.error);
    const ca = await build("omw_pa", "aarch64", "pair", ["build"]); await stage(ca);
    const ok = await web.decide("m2", `/factory/tasks/${ra}/approve`, { note: "both" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ arches: ["x86_64", "aarch64"], not_supported: {}, publishes: { x86_64: expect.any(Number), aarch64: expect.any(Number) } });
    expect((await env.DB.prepare("SELECT arch, task_id FROM approvals WHERE name = 'pair' AND review_id = ? ORDER BY arch DESC").bind(ok.json.review).all()).results).toEqual([{ arch: "x86_64", task_id: rx }, { arch: "aarch64", task_id: ra }]);
    // Either build answers for the package: already approved on both.
    expect((await call("POST", `/factory/tasks/${rx}/approve`, {}, "omc_m2")).json.error).toBe("already approved");
    const wd = await call("POST", `/factory/tasks/${a.task.id}/withdraw`, { note: "taken back as one" }, "omc_m1");
    expect(wd.json).toMatchObject({ review: ok.json.review, arches: ["x86_64", "aarch64"] });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE name = 'pair' AND withdrawn_at IS NULL").first<{ n: number }>())!.n).toBe(0);
  });

  it("goes back to its requester when no architecture builds", async () => {
    expect((await request("none")).status).toBe(201);
    for (const [w, arch] of [["omw_cx", "x86_64"], ["omw_ca", "aarch64"]]) {
      const c = await build(w, arch, "none");
      expect((await call("POST", `/factory/tasks/${c.task.id}/fail`, { error: `exit 4: nothing builds on ${arch}`, final: true }, c.token)).json).toMatchObject({ status: "failed" });
    }
    expect(await env.DB.prepare("SELECT status, detail FROM factory_packages WHERE name = 'none'").first()).toEqual({ status: "registered", detail: "build failed on ca: exit 4: nothing builds on aarch64" });
    expect(Object.values(await targetsOf("none")).map((x: any) => x.status)).toEqual(["not_supported", "not_supported"]);
    expect((await call("GET", "/factory/review")).json.staged.filter((t: any) => t.name === "none")).toEqual([]);
  });

  it("frees its name when the request is rejected — and keeps it when what is rejected is a new version of a package in the pool", async () => {
    expect((await request("solo", "omc_alice", ["x86_64"])).status).toBe(201);
    const c = await build("omw_cx", "x86_64", "solo"); await stage(c);
    const t = traced();
    const no = await call("POST", `/factory/tasks/${c.task.id}/reject`, { note: "not the project's own source" }, "omc_m2", undefined, t.env);
    expect(no.status, JSON.stringify(no.json)).toBe(200);
    expect(no.json).toMatchObject({ decision: "rejected", released: true, cancelled: [c.task.id] });
    // The round's last build, through the name's index.
    const through = t.seen.filter((x) => x.sql.startsWith("SELECT MAX(id) AS id FROM build_tasks"));
    expect(through).toHaveLength(1);
    expect(await planOf(through[0])).toMatch(/USING (COVERING )?INDEX idx_build_tasks_name/);
    // This review freed the name: it says so on the registration.
    expect(await env.DB.prepare("SELECT freed_by_review FROM factory_packages WHERE name = 'solo'").first()).toEqual({ freed_by_review: no.json.review });
    expect(await env.DB.prepare("SELECT status, detail FROM factory_packages WHERE name = 'solo'").first()).toEqual({ status: "rejected", detail: "rejected by m2: not the project's own source — the name is free again" });
    expect(await targetsOf("solo")).toEqual({ x86_64: { status: "waiting", task: null } });
    // Anyone may request the name now: bob does, and it is his.
    const taken = await request("solo", "omc_bob", ["x86_64"]);
    expect(taken.status, JSON.stringify(taken.json)).toBe(200);
    expect(taken.json.package).toMatchObject({ owner: "bob", status: "registered" });
    expect((await env.DB.prepare("SELECT summary FROM events WHERE kind = 'request' ORDER BY id DESC LIMIT 1").first<{ summary: string }>())!.summary).toMatch(/taken over from alice, whose request was rejected$/);
    // duo is in the pool on x86_64: a new build of it rejected leaves the name and the approved version where they are.
    await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, staged_prefix) VALUES ('duo', 'x86_64', '1.1-1', 'draft:https://duo.example@1.1', 'bump to 1.1', 100, 0, 'community', 'alice', 'build', 'staged', 'staging/alice/duo/1/')").run();
    const bump = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'duo' AND version = '1.1-1'").first<{ id: number }>())!.id;
    const kept = await call("POST", `/factory/tasks/${bump}/reject`, { note: "1.1 breaks the config" }, "omc_m2");
    expect(kept.json).toMatchObject({ released: false, cancelled: [bump] });
    expect(await env.DB.prepare("SELECT owner, status, freed_by_review FROM factory_packages WHERE name = 'duo'").first()).toEqual({ owner: "alice", status: "registered", freed_by_review: null });
    expect(await targetsOf("duo")).toEqual({ x86_64: { status: "published", task: px }, aarch64: { status: "not_supported", task: arm } });
    expect((await request("duo", "omc_bob")).status).toBe(409);
  });

  it("reviews one version, as each architecture stands: renewed, and aarch64's new build failing, aarch64's older build stays out of the review", async () => {
    // 1.0 built on both architectures and staged; renewed to 1.1: x86_64 builds, aarch64 fails for good. aarch64's 1.0 build is still staged
    // (a failure supersedes nothing), but aarch64 stands on its 1.1 failure — not supported — and nothing of 1.0 joins the review of 1.1.
    expect((await request("mix")).status).toBe(201);
    const x10 = await build("omw_cx", "x86_64", "mix"); await stage(x10);
    const a10 = await build("omw_ca", "aarch64", "mix"); await stage(a10);
    const renewed = await request("mix", "omc_alice", ["x86_64", "aarch64"], "1.1");
    expect(renewed.status, JSON.stringify(renewed.json)).toBe(200);
    const x11 = await build("omw_cx", "x86_64", "mix"); await stage(x11);
    const a11 = await build("omw_ca", "aarch64", "mix");
    expect((await call("POST", `/factory/tasks/${a11.task.id}/fail`, { error: "exit 4: 1.1 needs a newer toolchain on aarch64", final: true }, a11.token)).json).toMatchObject({ status: "failed" });
    expect(await env.DB.prepare("SELECT version, status FROM build_tasks WHERE id = ?").bind(a10.task.id).first()).toEqual({ version: "1.0", status: "staged" });
    expect(await targetsOf("mix")).toEqual({ x86_64: { status: "built", task: x11.task.id }, aarch64: { status: "not_supported", task: a11.task.id } });
    // Review: x86_64's 1.1 speaks for mix; aarch64's 1.0 is listed, never the row that speaks for it, and the project does not build it — the door's words on the button.
    const list = (await call("GET", "/factory/review", undefined, "omc_m2")).json;
    expect(list.packages.find((p: any) => p.name === "mix")).toMatchObject({ lead: x11.task.id, waits: true });
    const old = list.staged.find((t: any) => t.id === a10.task.id);
    expect(old).toMatchObject({ lead: false, waits: false, can: { build: false } });
    const why = `task ${a10.task.id} is not where aarch64 stands: its newer build, task ${a11.task.id}, is not supported — one review covers where each architecture stands`;
    expect(old.can.why.build).toBe(why);
    const refused = await call("POST", `/factory/tasks/${a10.task.id}/build`, {}, "omc_m2");
    expect([refused.status, refused.json]).toEqual([409, { error: why }]);
    // Build by the project, on x86_64's 1.1: that architecture alone — before, it built aarch64's 1.0 again beside it and the approval published both.
    const asked = await call("POST", `/factory/tasks/${x11.task.id}/build`, {}, "omc_m2");
    expect(asked.json).toMatchObject({ arches: ["x86_64"], tasks: [asked.json.task] });
    const p = await build("omw_px", "x86_64", "mix", ["build"]); await stage(p);
    const ok = await web.decide("m2", `/factory/tasks/${p.task.id}/approve`);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ arches: ["x86_64"], not_supported: { aarch64: a11.task.id } });
    // One review of one version: 1.1 on x86_64, aarch64 not supported; nothing of 1.0 approved, nothing of it published.
    expect(await env.DB.prepare("SELECT version, arches, not_supported FROM reviews WHERE id = ?").bind(ok.json.review).first()).toEqual({ version: "1.1", arches: '["x86_64"]', not_supported: JSON.stringify({ aarch64: a11.task.id }) });
    expect((await env.DB.prepare("SELECT arch, version FROM approvals WHERE name = 'mix'").all()).results).toEqual([{ arch: "x86_64", version: "1.1" }]);
    expect((await env.DB.prepare("SELECT arch, version FROM build_tasks WHERE name = 'mix' AND kind = 'publish'").all()).results).toEqual([{ arch: "x86_64", version: "1.1" }]);
    expect(await targetsOf("mix")).toEqual({ x86_64: { status: "approved", task: p.task.id }, aarch64: { status: "not_supported", task: a11.task.id } });
  });

  it("reads a package's builds led by its name: a decision's facts and a transition's targets never walk the index of every build's kind", async () => {
    const t = traced();
    const x11 = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'mix' AND arch = 'x86_64' AND trust = 'community' ORDER BY id DESC LIMIT 1").first<{ id: number }>())!.id;
    // GET /factory/tasks/:id/can is public and uncached, asked on every build page: what it reads is what every decision reads.
    expect((await call("GET", `/factory/tasks/${x11}/can`, undefined, "omc_m2", undefined, t.env)).status).toBe(200);
    await settleTargets(t.env, "mix");
    const reads = t.seen.filter((x) => /FROM build_tasks/.test(x.sql) && /\bname = \?|json_each/.test(x.sql));
    // The story's tasks, each architecture's newest builds (twice: the facts, then the settle), and the builds an approval names.
    expect(reads.length).toBeGreaterThanOrEqual(5);
    for (const x of reads) {
      const plan = await planOf(x);
      expect(plan, x.sql).toMatch(/idx_build_tasks_name|INTEGER PRIMARY KEY/);
      expect(plan, x.sql).not.toMatch(/idx_build_tasks_kind|SCAN build_tasks/);
    }
    // A person's page asks where each standing approval is served in one read, each (name, arch) a seek, never a walk of the rings.
    const u = traced();
    expect((await call("GET", "/users/m2?after=plans", undefined, undefined, undefined, u.env)).status).toBe(200);
    const rings = u.seen.filter((x) => x.sql.includes("FROM json_each(?) k CROSS JOIN packages p CROSS JOIN ring_packages rp"));
    expect(rings).toHaveLength(1);
    const plan = await planOf(rings[0]);
    expect(plan).toMatch(/SEARCH p USING (COVERING )?INDEX idx_packages_name_repo_arch_source \(name=\? AND repo_arch=\? AND source=\?\)/);
    expect(plan).toMatch(/SEARCH rp USING (COVERING )?INDEX sqlite_autoindex_ring_packages_1 \(ring=\? AND package_id=\?\)/);
  });

  it("holds a blocked contributor's names: a block rejects their registrations and frees none of them", async () => {
    expect((await request("held", "omc_dave", ["x86_64"])).status).toBe(201);
    // One of dave's names a review had freed before the block, requested by nobody since: that one is free, and stays free.
    await env.DB.prepare("INSERT INTO factory_packages (name, owner, url, arches, status, detail, freed_by_review) VALUES ('let-go', 'dave', 'https://let-go.example', '[\"x86_64\"]', 'rejected', 'rejected by m2 — the name is free again', 1)").run();
    expect((await web.decide("m1", "/factory/contributors/dave/block", { reason: "requests packages that are not theirs" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT owner, status, freed_by_review FROM factory_packages WHERE name = 'held'").first()).toEqual({ owner: "dave", status: "rejected", freed_by_review: null });
    // bob asks for the names from another project: the blocked contributor's own is refused, as before #242; the one a review freed is his.
    const fork = (name: string) =>
      call("POST", "/factory/packages", { name, url: `https://${name}-fork.example`, source: `https://${name}-fork.example/${name}-2.0.tar.gz`, version: "2.0", description: `${name}, from another project`, license: "MIT", arches: ["x86_64"], checklist }, "omc_bob");
    const refused = await fork("held");
    expect([refused.status, refused.json.error]).toEqual([409, "held is rejected, requested by dave"]);
    const taken = await fork("let-go");
    expect(taken.status, JSON.stringify(taken.json)).toBe(200);
    expect(taken.json.package).toMatchObject({ owner: "bob" });
    // Lifted by another maintainer: the name is still dave's, to request again.
    expect((await call("POST", "/factory/contributors/dave/unblock", { reason: "it was a misunderstanding" }, "omc_m2")).status).toBe(200);
    expect((await fork("held")).status).toBe(409);
    expect((await request("held", "omc_dave", ["x86_64"])).status).toBe(200);
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'not this story' WHERE name IN ('held', 'let-go') AND status = 'queued'").run();
  });

  it("is one row of Review's queue: the package's name once, a square per architecture, one claim for the package", async () => {
    expect((await request("rows")).status).toBe(201);
    const a = await build("omw_cx", "x86_64", "rows"); await stage(a);
    const b = await build("omw_ca", "aarch64", "rows"); await stage(b);
    const listed = (await call("GET", "/factory/review", undefined, "omc_m2")).json.packages.find((p: any) => p.name === "rows");
    expect(listed).toMatchObject({ state: "ready", claim: null, rows: expect.arrayContaining([a.task.id, b.task.id]) });
    // The page as m2's browser draws it (#247): the served script, run over the Worker's answers with m2's session.
    await env.DB.prepare("UPDATE contributors SET session_hash = ? WHERE login = 'm2'").bind(await sha256Hex("oms_m2")).run();
    const browser = async (path: string, init?: RequestInit) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`http://pool.test${path}`, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), cookie: "omc=oms_m2" } }), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const drawn = runScript(scriptOf(await (await browser("/review")).text()), { pathname: "/review", functions: [], fetch: browser });
    await new Promise((r) => setTimeout(r, 80));
    const rows = (drawn.nodes["#rv-rows"].innerHTML as string).split('<div class="rv-row').slice(1);
    const mine = rows.filter((r) => r.includes("<b>rows</b></a>"));
    expect(mine, "the package is one row, whatever builds it has").toHaveLength(1);
    // Each architecture a square in its package's row, and one Claim — for the build that speaks for the package, m2 not its owner.
    expect(mine[0].match(/<i class="op-arch ok" title="(x86_64|aarch64): built"><\/i>/g)).toHaveLength(2);
    expect(mine[0]).toContain(`data-claim="${listed.lead}"`);
    expect(mine[0].match(/data-claim=/g)).toHaveLength(1);
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'not this story' WHERE name = 'rows' AND status = 'queued'").run();
  });

  it("has the project build a build whose name nobody registered once at a time: the decision reads its builds all the same", async () => {
    // A build written before registrations, or by hand as tests/e2e-worker.sh writes one: no registration, so no targets — and the
    // project's build of it in flight is still what refuses a second press (it was not, while the decision read the builds only through a registration).
    const id = (await env.DB.prepare(
      "INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, staged_prefix) VALUES ('stray', 'aarch64', '1.0-1', 'draft:https://stray.example@latest', 'contributor', 100, 0, 'community', 'alice', 'build', 'staged', 'staging/alice/stray/1/') RETURNING id",
    ).first<{ id: number }>())!.id;
    expect(await env.DB.prepare("SELECT 1 FROM factory_packages WHERE name = 'stray'").first()).toBeNull();
    const first = await call("POST", `/factory/tasks/${id}/build`, {}, "omc_m1");
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json).toMatchObject({ from: id, arches: ["aarch64"], tasks: [first.json.task] });
    const again = await call("POST", `/factory/tasks/${id}/build`, {}, "omc_m1");
    expect([again.status, again.json.error]).toEqual([409, `the project is already on it: task ${first.json.task} is queued`]);
    expect((await call("GET", `/factory/tasks/${id}/can`, undefined, "omc_m1")).json.can.why.build).toBe(again.json.error);
    // Nothing was registered by the decision: the targets are kept for a registration only.
    expect(await env.DB.prepare("SELECT 1 FROM factory_packages WHERE name = 'stray'").first()).toBeNull();
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'not this story' WHERE name = 'stray' AND status = 'queued'").run();
  });
});

describe("the rules, on rows", () => {
  const b = (id: number, status: string, trust = "community", review: number | null = null): TargetBuild => ({ id, arch: "x86_64", status, trust, publish: 0, review });
  const standing: TargetDecision[] = [{ arch: "x86_64", task_id: 2, rebuild_task: 2, decision: "approved", withdrawn_at: null }];

  it("keeps an architecture in the pool where it is served when a build of its next version fails; one in flight or staged moves it on", () => {
    const served = [b(1, "staged"), b(2, "done", "project", 1)];
    expect(targetsOf(["x86_64"], served, standing)).toEqual({ x86_64: { status: "published", task: 2 } });
    // The bump fails, or the project's build of it does: still published — pacman installs it — never "not supported".
    expect(targetsOf(["x86_64"], [...served, b(3, "failed")], standing)).toEqual({ x86_64: { status: "published", task: 2 } });
    expect(targetsOf(["x86_64"], [...served, b(3, "staged"), b(4, "failed", "project", 3)], standing)).toEqual({ x86_64: { status: "built", task: 3 } });
    // The next version on its way to a review: building, then built.
    expect(targetsOf(["x86_64"], [...served, b(3, "queued")], standing)).toEqual({ x86_64: { status: "building", task: 3 } });
    expect(targetsOf(["x86_64"], [...served, b(3, "staged")], standing)).toEqual({ x86_64: { status: "built", task: 3 } });
    // With the approval taken back, the failure is where it stands.
    expect(targetsOf(["x86_64"], [...served, b(3, "failed")], [{ ...standing[0], withdrawn_at: "2026-09-29T00:00:00Z" }])).toEqual({ x86_64: { status: "not_supported", task: 3 } });
  });

  it("lists a review whole when its rows straddle a page of the record, and names every architecture it decided", async () => {
    const row = (id: number, arch: string) => ({ id, task_id: id, name: "wide", arch, version: "1.0", decision: "approved", by: "m1", note: null, rebuild_task: id, created_at: "2026-09-29T00:00:00Z", withdrawn_at: null, withdrawn_by: null, withdrawn_reason: null, review_id: 9, review_arches: '["x86_64","aarch64"]' });
    // The page ends at row 10, aarch64's: x86_64's row 9 is older.
    const page = [row(10, "aarch64")];
    expect(asReviews(page)[0].arches).toEqual(["x86_64", "aarch64"]);
    let asked: unknown = null;
    const whole = await wholeReviews(page, async (reviews, below) => { asked = [reviews, below]; return [row(9, "x86_64")]; });
    expect(asked).toEqual([[9], 10]);
    const [v] = asReviews(whole);
    expect(v).toMatchObject({ id: 9, review: 9, arch: "x86_64", arches: ["x86_64", "aarch64"] });
    expect(v.targets.map((x) => x.arch)).toEqual(["x86_64", "aarch64"]);
    // A page with every review whole reads nothing more.
    expect(await wholeReviews(whole, async () => { throw new Error("read"); })).toBe(whole);
  });
});
