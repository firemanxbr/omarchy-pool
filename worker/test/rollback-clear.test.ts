/**
 * A rollback past #277 (#295): a Worker from before #277 spreads a worker's
 * whole row in its listings (GET /factory, GET /users/:login — revoked
 * workers too), so factory/bin/release-rollback clears, around that
 * Worker's deploy, every column this Worker's workerView withholds — but
 * drained_at, drained_by and drain_reason, a person's standing drain, which
 * this Worker serves as `drained` and needs back after a roll-forward.
 *
 * - Drift: a column workerView withholds (a later migration's among them)
 *   that the clear neither clears nor names as kept fails here, until
 *   someone decides which it is; and the clear touches nothing the view
 *   serves.
 * - The clear itself, on a real D1 with every migration: what the older
 *   Worker's `SELECT *` then serves holds none of those columns
 *   (instance_churn at its default 0: NOT NULL), a task's stop fence is
 *   gone, a second run changes nothing.
 * - The security model's UPDATE is the script's.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { workerView, type WorkerRow } from "../src/routes/factory";
import type { RunningVersion } from "../src/meta";
// The repository's own files, as text (Vite's ?raw): the tests run inside workerd, which has no filesystem.
import rollbackScript from "../../factory/bin/release-rollback?raw";
import securityModel from "../src/docs/security-model.md?raw";

const KEEP = ["drained_at", "drained_by", "drain_reason"];
// What the Worker from before #277 withheld already (its workerView): never served by either, so never the clear's business.
const OLD_WITHHELD = ["token_hash", "log_tail", "log_at"];
const POOL: RunningVersion = { version: "v1.0.4", commit: null, deployed_at: null, release_url: null, commit_url: null, analytics: "" };
const AT = "2026-09-30T12:00:00.000Z";
const PID = "0123456789abcdef0123456789abcdef";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const clearSql = (() => {
  const m = rollbackScript.match(/^CLEAR_277_SQL="([^"]+)"$/m);
  if (!m) throw new Error("CLEAR_277_SQL not found in factory/bin/release-rollback");
  return m[1];
})();
const statements = clearSql.split(";").map((s) => s.trim()).filter(Boolean);
/** The build_workers columns the clear assigns: `SET a = …, b = … WHERE`. */
const assigned = (() => {
  const m = statements[0].match(/^UPDATE build_workers SET (.+?) WHERE /);
  if (!m) throw new Error(`the clear's first statement is not an UPDATE of build_workers: ${statements[0]}`);
  return new Map(m[1].split(",").map((a) => a.trim().split(/\s*=\s*/) as [string, string]));
})();

/** A worker's row with every column set — JSON where the view parses it — and the process id in instance_finished too, as workerFinished stamps it. */
async function fullRow(id: string, revoked: boolean): Promise<Record<string, unknown>> {
  const cols = (await env.DB.prepare("PRAGMA table_info(build_workers)").all<{ name: string; type: string }>()).results;
  const json: Record<string, string> = {
    labels: '{"where":"omarchy-studio"}', packages: '["felix"]', kinds: '["audit","build"]', usage: "{}", last_task: '{"id":1,"status":"done"}', open_orders: "[]",
    order_kinds: '["drain","recheck-agent","restart","restart-agent"]', watchdog_exits: `{"n":1,"since":"${AT}","last":"${AT}","stuck_in":null}`,
    rollout: '{"updater":{"image":"v1.0.4","follows":true},"host_script":"none"}', auto_orders: `{"spell":"${AT}","rechecks":0,"restarts":0}`,
  };
  const row: Record<string, unknown> = {};
  for (const c of cols) {
    if (c.name in json) row[c.name] = json[c.name];
    else if (c.type.toUpperCase() === "INTEGER") row[c.name] = 2;
    else if (/(_at|_since|_seen)$/.test(c.name)) row[c.name] = AT;
    else row[c.name] = `${c.name}-${id}`;
  }
  Object.assign(row, { id, arch: "aarch64", mode: "project", trust: "project", instance: PID, instance_finished: PID, agent_status: "error", agent_via: "direct", current_task: null });
  if (!revoked) row.revoked_at = null;
  const names = Object.keys(row);
  await env.DB.prepare(`INSERT INTO build_workers (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).bind(...names.map((n) => row[n])).run();
  return row;
}

describe("a rollback past #277 clears what this Worker withholds", () => {
  it("clears every column workerView withholds but a person's drain, and nothing it serves", async () => {
    const row = await fullRow("rb-drift", false);
    const view = workerView(row as unknown as WorkerRow, 0, POOL) as Record<string, unknown>;
    const withheld = Object.keys(row).filter((c) => row[c] !== null && view[c] === undefined && !OLD_WITHHELD.includes(c));
    expect(withheld.length).toBeGreaterThan(0);
    // Every withheld column is cleared or kept on purpose.
    expect(withheld.filter((c) => !assigned.has(c) && !KEEP.includes(c))).toEqual([]);
    // The clear touches only withheld columns, and never the drain.
    expect([...assigned.keys()].filter((c) => !withheld.includes(c))).toEqual([]);
    expect([...assigned.keys()].filter((c) => KEEP.includes(c))).toEqual([]);
    // NULL, but instance_churn: NOT NULL, back to its default.
    for (const [c, v] of assigned) expect([c, v]).toEqual([c, c === "instance_churn" ? "0" : "NULL"]);
    // The task's stop fence, which the older Worker never clears.
    expect(statements.slice(1)).toEqual(["UPDATE build_tasks SET stop_order = NULL WHERE stop_order IS NOT NULL"]);
  });

  it("leaves nothing of it in what the older Worker's listings serve, on a real D1", async () => {
    const live = await fullRow("rb-live", false);
    const revoked = await fullRow("rb-revoked", true);
    await env.DB.prepare(
      "INSERT INTO build_tasks (id, name, arch, pkgbuild_ref, reason, status, lease_owner, stop_order) VALUES (9501, 'felix', 'aarch64', 'ref', 'test', 'leased', 'rb-live', 'order-1')",
    ).run();
    for (const s of statements) await env.DB.prepare(s).run();
    // The Worker from before #277: SELECT * spread, less token_hash, log_tail and log_at; /users/:login lists the revoked too.
    const old = (await env.DB.prepare("SELECT * FROM build_workers WHERE id IN ('rb-live', 'rb-revoked') ORDER BY id").all<Record<string, unknown>>()).results;
    expect(old).toHaveLength(2);
    for (const got of old) {
      const seeded = got.id === "rb-live" ? live : revoked;
      for (const [c, v] of Object.entries(got)) {
        const want = assigned.has(c) ? (c === "instance_churn" ? 0 : null) : seeded[c];
        expect([c, v]).toEqual([c, want]);
      }
      for (const c of KEEP) expect(got[c]).not.toBeNull();
      expect(Object.values(got)).not.toContain(PID);
    }
    const task = await env.DB.prepare("SELECT stop_order, status, lease_owner FROM build_tasks WHERE id = 9501").first();
    expect(task).toEqual({ stop_order: null, status: "leased", lease_owner: "rb-live" });
    // Idempotent: a second run (the one after the deploy, the one once it serves) changes nothing.
    let changes = 0;
    for (const s of statements) changes += (await env.DB.prepare(s).run()).meta.changes ?? 0;
    expect(changes).toBe(0);
  });

  it("is the UPDATE the security model shows", () => {
    const section = securityModel.slice(securityModel.indexOf("**A Worker rolled back past #277"));
    const block = section.match(/```sql\n([\s\S]+?)```/);
    expect(block).not.toBeNull();
    expect(norm(block![1])).toBe(norm(clearSql));
  });
});
