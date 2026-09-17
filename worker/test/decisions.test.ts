/**
 * The four decisions on a build, decided in one place (routes/review.ts,
 * `decisions`): what GET /factory/review says a caller may do on each row
 * and GET /factory/tasks/:id/can says for one task is exactly what the POST
 * answers — `can.X` is true when POST /factory/tasks/:id/X answers 200, and
 * where it is false the refusal carries the same reason. Every role of the
 * fixture (test/fixture.ts) on every staged row: nobody signed in, bob who
 * owns nothing, alice who brought the package, m1 and m2 the maintainers.
 * The two answers are no-store: a per-caller field never rides a cached one.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { seedDashboard, type Fixture } from "./fixture";

let F: Fixture;

const DECISIONS = ["approve", "build", "reject", "withdraw"] as const;
type Decision = (typeof DECISIONS)[number];
/** Who asks: the fixture's logins, each signed in with the cookie `omc=oms_<login>`; "" is nobody. */
const ROLES = ["", "bob", "alice", "m1", "m2"] as const;
type Who = (typeof ROLES)[number];

interface Can { approve: boolean; reject: boolean; build: boolean; withdraw: boolean; why: Partial<Record<Decision, string>> }

beforeAll(async () => {
  F = await seedDashboard(env);
});

async function call(method: string, path: string, as: Who, body?: unknown): Promise<{ status: number; headers: Headers; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (as) headers.cookie = `omc=oms_${as}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}

const review = async (as: Who) => call("GET", "/factory/review", as);
const canOf = async (id: number, as: Who): Promise<Can> => {
  const r = await call("GET", `/factory/tasks/${id}/can`, as);
  expect(r.status, `GET /factory/tasks/${id}/can as ${as || "nobody"}`).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.json.task).toBe(id);
  return r.json.can as Can;
};
const nothing = (c: Can, why: string) => {
  expect([c.approve, c.reject, c.build, c.withdraw]).toEqual([false, false, false, false]);
  expect(c.why).toEqual({ approve: why, reject: why, build: why, withdraw: why });
};
const OWNER = (name: string) => `you brought ${name} — another maintainer decides; with one maintainer, that maintainer's own packages wait`;

describe("what a caller may do on a staged build", () => {
  it("GET /factory/review is no-store and every row carries `can` for the caller: all false for nobody, the sign-in as the reason", async () => {
    const r = await review("");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    // The three undecided community builds of alice's `mine` (the decided chain is out of the list).
    expect(r.json.staged.map((t: any) => t.id).sort()).toEqual([F.stagedTask, F.disposableTask, F.spareTask].sort());
    for (const t of r.json.staged) nothing(t.can, "sign in with GitHub");
  });

  it("a contributor — the owner too, while a contributor — may do nothing: a maintainer decides", async () => {
    for (const who of ["bob", "alice"] as const) {
      const r = await review(who);
      for (const t of r.json.staged) nothing(t.can, "a maintainer decides");
      nothing(await canOf(F.projectTask, who), "a maintainer decides");
      nothing(await canOf(F.contributorTask, who), "a maintainer decides");
    }
  });

  it("a maintainer on a contributor's undecided build: the project builds it first, then approves; reject and build are theirs; nothing to withdraw", async () => {
    for (const who of ["m1", "m2"] as const) {
      const r = await review(who);
      for (const t of r.json.staged) {
        expect(t.can, `${who} on ${t.id}`).toMatchObject({ approve: false, reject: true, build: true, withdraw: false });
        expect(t.can.why.approve).toMatch(/have the project build it first/);
        expect(t.can.why.withdraw).toBe("nothing standing to withdraw");
        expect(Object.keys(t.can.why).sort()).toEqual(["approve", "withdraw"]);
        expect(await canOf(t.id, who)).toEqual(t.can);
      }
    }
  });

  it("the project's build approved by m2: already approved for any maintainer, nothing to reject beside a standing approval, its approval there to withdraw; its contributor's half says the project is on it", async () => {
    for (const who of ["m1", "m2"] as const) {
      const p = await canOf(F.projectTask, who);
      expect(p).toMatchObject({ approve: false, reject: false, build: false, withdraw: true });
      expect(p.why).toEqual({ approve: "already approved", reject: "already approved — withdraw the approval first", build: "the project's own build; the project builds from a contributor's staged build" });
      // The contributor's half stays staged after the publish; it is decided all the same.
      const c = await canOf(F.contributorTask, who);
      expect(c).toMatchObject({ approve: false, reject: false, build: false, withdraw: true });
      expect(c.why.build).toBe(`the project is already on it: task ${F.projectTask} is staged`);
      expect(c.why.reject).toBe("already approved — withdraw the approval first");
      expect(c.why.approve).toMatch(/have the project build it first/);
      const rj = await call("POST", `/factory/tasks/${F.contributorTask}/reject`, who, { note: "a rejection beside a standing approval" });
      expect(rj.status).toBe(409);
      expect(rj.json.error).toBe(c.why.reject);
    }
  });

  it("the owner never decides on their own package, a maintainer or not — reject included; the POST refuses with the same words", async () => {
    // alice, maintainer for a moment: her own rows stay hers to read, not to decide.
    await env.DB.prepare("UPDATE contributors SET role = 'maintainer' WHERE login = 'alice'").run();
    try {
      for (const t of (await review("alice")).json.staged) {
        expect(t.can, `alice on ${t.id}`).toMatchObject({ approve: false, reject: false, build: false, withdraw: false });
        expect(t.can.why).toMatchObject({ reject: OWNER(F.factoryPkg), build: OWNER(F.factoryPkg) });
        expect(t.can.why.approve).toMatch(/have the project build it first/); // a contributor's build: that comes before the owner
        const reject = await call("POST", `/factory/tasks/${t.id}/reject`, "alice", { note: "my own, rejected" });
        expect(reject.status).toBe(403);
        expect(reject.json.error).toBe(t.can.why.reject);
        const build = await call("POST", `/factory/tasks/${t.id}/build`, "alice", {});
        expect(build.status).toBe(403);
        expect(build.json.error).toBe(t.can.why.build);
      }
      // The project's build of her package: the approval is not hers to give, and would not be were it undecided.
      const p = await canOf(F.projectTask, "alice");
      expect(p.why.approve).toBe(OWNER(F.factoryPkg));
      expect(p.why.reject).toBe(OWNER(F.factoryPkg));
      expect(p.withdraw).toBe(true); // undoing is not deciding
    } finally {
      await env.DB.prepare("UPDATE contributors SET role = 'contributor' WHERE login = 'alice'").run();
    }
  });

  it("can.X is true exactly when POST /factory/tasks/:id/X answers 200, and a refusal says why in the same words — every row, every role, each row consumed once", async () => {
    const rows: number[] = (await review("")).json.staged.map((t: any) => t.id);
    const note = { note: "decided by the test, on the record" };
    let allowed = 0;
    for (const id of rows) {
      for (const who of ROLES) {
        for (const d of DECISIONS) {
          // Fresh before each POST: the one before may have changed the row.
          const c = await canOf(id, who);
          const res = await call("POST", `/factory/tasks/${id}/${d}`, who, d === "approve" || d === "build" ? {} : note);
          expect(res.status === 200, `${who || "nobody"} ${d} on ${id}: can ${c[d]} (${c.why[d] ?? "-"}), POST ${res.status} ${JSON.stringify(res.json)}`).toBe(c[d]);
          if (res.status === 200) allowed++;
          else expect(res.json.error, `${who || "nobody"} ${d} on ${id}`).toBe(c.why[d]); // nobody too: the door answers the predicate's sentence
        }
      }
    }
    // Per row: m1 had the project build it (200), then rejected it (200); nothing else went through — m2 found it cancelled.
    expect(allowed).toBe(rows.length * 2);
    for (const id of rows) {
      const c = await canOf(id, "m2");
      expect([c.approve, c.reject, c.build, c.withdraw]).toEqual([false, false, false, false]);
      expect(c.why).toEqual({ approve: `task ${id} is cancelled, not staged`, reject: `task ${id} is cancelled, not staged`, build: `task ${id} is cancelled, not staged`, withdraw: "nothing standing to withdraw" });
    }
  });

  it("a task that is not staged: everything false with the reason; an unknown task is 404", async () => {
    const c = await canOf(F.disposableTask, "m1");
    expect([c.approve, c.reject, c.build, c.withdraw]).toEqual([false, false, false, false]);
    expect(c.why).toEqual({ approve: `task ${F.disposableTask} is cancelled, not staged`, reject: `task ${F.disposableTask} is cancelled, not staged`, build: `task ${F.disposableTask} is cancelled, not staged`, withdraw: "nothing standing to withdraw" });
    expect((await call("GET", "/factory/tasks/999999/can", "m1")).status).toBe(404);
  });

  it("the approval withdrawn by a maintainer: approve and reject are theirs again, then already approved once more", async () => {
    const before = await canOf(F.projectTask, "m1");
    expect(before).toMatchObject({ approve: false, reject: false, withdraw: true });
    const wd = await call("POST", `/factory/tasks/${F.projectTask}/withdraw`, "m1", { note: "taken back by the test" });
    expect(wd.status, JSON.stringify(wd.json)).toBe(200);
    const after = await canOf(F.projectTask, "m1");
    expect(after).toMatchObject({ approve: true, reject: true, build: false, withdraw: false });
    expect(after.why.withdraw).toBe("nothing standing to withdraw");
    const listed = (await review("m1")).json.staged.find((t: any) => t.id === F.projectTask);
    expect(listed?.can).toEqual(after);
    expect(listed?.standing).toBe(false);
    // The one who approved may not be the owner; m1 is not, and approves.
    const ap = await call("POST", `/factory/tasks/${F.projectTask}/approve`, "m1", { note: "approved by the test" });
    expect(ap.status, JSON.stringify(ap.json)).toBe(200);
    const again = await canOf(F.projectTask, "m2");
    expect(again).toMatchObject({ approve: false, reject: false, withdraw: true });
    expect(again.why).toMatchObject({ approve: "already approved", reject: "already approved — withdraw the approval first" });
    expect((await call("POST", `/factory/tasks/${F.projectTask}/approve`, "m2", {})).json.error).toBe("already approved");
  });

  it("a project's build the sweep emptied: approve is refused before the click, with the reason the POST answers", async () => {
    // The approval withdrawn, the build is a maintainer's to approve — until its package is gone from staging (staging.ts sweeps objects past STAGING_DAYS, the row stays staged).
    expect((await call("POST", `/factory/tasks/${F.projectTask}/withdraw`, "m2", { note: "taken back once more by the test" })).status).toBe(200);
    expect((await canOf(F.projectTask, "m1")).approve).toBe(true);
    await env.DB.prepare("UPDATE staging_objects SET key = key || '.swept' WHERE task_id = ? AND key LIKE '%.pkg.tar.zst'").bind(F.projectTask).run();
    try {
      const c = await canOf(F.projectTask, "m1");
      expect(c).toMatchObject({ approve: false, reject: true, build: false, withdraw: false });
      expect(c.why.approve).toBe("the project's build left no package in staging");
      expect((await review("m1")).json.staged.find((t: any) => t.id === F.projectTask)?.can).toEqual(c);
      const ap = await call("POST", `/factory/tasks/${F.projectTask}/approve`, "m1", { note: "approving what is not there" });
      expect(ap.status).toBe(409);
      expect(ap.json.error).toBe(c.why.approve);
    } finally {
      await env.DB.prepare("UPDATE staging_objects SET key = substr(key, 1, length(key) - 6) WHERE task_id = ? AND key LIKE '%.pkg.tar.zst.swept'").bind(F.projectTask).run();
    }
    expect((await canOf(F.projectTask, "m1")).approve).toBe(true);
  });
});
