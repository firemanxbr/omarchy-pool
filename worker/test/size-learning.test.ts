/**
 * Automatic task-size learning (#330, design v2 §7.4; D31, P6): the size a
 * package's builds ask is raised after the engine killed one at its memory
 * limit, never above 2 for a contributor's build nor 4 for any, and decays
 * after five builds in a row that peaked lower; a maintainer's size, on the
 * package's page or in factory/sizing, wins over it.
 *
 * - the rules alone (src/sizing.ts `afterOom`, `afterBuild`), replayed over
 *   recorded out-of-memory histories, report by report as the pool receives
 *   them: a one-off out-of-memory kill that decays back to size 1, a
 *   contributor's recipe running itself out of memory on purpose and stopping
 *   at 2, the project's copy climbing one step per kill to 4 and no further,
 *   a peak that needed the size starting the count over, a kill while
 *   counting, a contributor's kill below what the project's copy learned, a
 *   kill at a clamped size, the edge of "lower";
 * - through the Worker (routes/factory.ts handleFail, handleComplete,
 *   selectAndLease; migration 0050), inside workerd with a real D1: a
 *   contributor's build that ran out of memory at size 1 queued again and
 *   leased at 2, its journal line, its story, and no further than 2; the
 *   project's copy whose size a maintainer set on the page keeps asking that
 *   size while the pool learns under it, then climbs to 4 once the page's
 *   size is cleared; five builds in a row that peaked lower bring the size
 *   back to 1 — a build that needed the size starting the count over, one
 *   that says no peak counting nothing; two builds ending at once both
 *   counted; a maintainer's dry run teaching nothing;
 * - the package page: the size fact says the learned size, under a
 *   maintainer's or as the one its builds ask, and a build queued again after
 *   running out of memory says the size it now waits at.
 *
 * Tokens: workers omw_<id>, people's CLI omc_<login>.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/routes/contributors";
import { unitsOf } from "../src/hosts";
import { afterBuild, afterOom, learnCap, peakBelowMb, DECAY_AFTER, type Learned } from "../src/sizing";
import { runScript, scriptOf } from "./fixture";
import { toB64url } from "../src/webauthn";

// ---------- the rules, over recorded histories ----------

const NOTHING: Learned = { size: null, lower: 0, task: null, why: null, at: null };

/**
 * One report per line, as the pool receives them: `oom <ran> <trust>` — the engine killed a build running at that size; `peak <mb>` —
 * a build completed with that memory high-water mark; `peak ?` — one completed without saying. After each, the size its package
 * remembers (1: nothing learned) and the builds in a row counted lower.
 */
type Line = [report: string, size: number, lower: number];
const HISTORIES: { what: string; from?: Learned; lines: Line[] }[] = [
  {
    what: "a one-off: a test suite ran out of memory once, then five small builds bring it back to size 1",
    lines: [["oom 1 community", 2, 0], ["peak 1200", 2, 1], ["peak 1310", 2, 2], ["peak ?", 2, 2], ["peak 1100", 2, 3], ["peak 1250", 2, 4], ["peak 1180", 1, 0], ["peak 900", 1, 0]],
  },
  {
    what: "a contributor's recipe that runs itself out of memory on purpose stops at 2, however often",
    lines: [["oom 1 community", 2, 0], ["oom 2 community", 2, 0], ["oom 2 community", 2, 0], ["oom 2 community", 2, 0]],
  },
  {
    what: "the project's copy of a large C++ build climbs one step per kill, to the signed maximum and no further",
    lines: [["oom 1 project", 2, 0], ["oom 2 project", 3, 0], ["oom 3 project", 4, 0], ["oom 4 project", 4, 0], ["peak 11500", 4, 1]],
  },
  {
    what: "a build that needed the size starts the count over; size 3 decays to 2, then 2 to 1, each after five lower peaks in a row",
    lines: [
      ["oom 1 project", 2, 0], ["oom 2 project", 3, 0], ["peak 2000", 3, 1], ["peak 3000", 3, 2], ["peak 8000", 3, 0],
      ["peak 5000", 3, 1], ["peak 5100", 3, 2], ["peak 4900", 3, 3], ["peak 5050", 3, 4], ["peak 5000", 2, 0],
      ["peak 5000", 2, 0], ["peak 3000", 2, 1], ["peak 3100", 2, 2], ["peak 2900", 2, 3], ["peak 3050", 2, 4], ["peak 3000", 1, 0],
    ],
  },
  {
    what: "an out-of-memory kill while counting starts the count over, and raises",
    lines: [["oom 1 project", 2, 0], ["peak 1000", 2, 1], ["peak 1000", 2, 2], ["peak 1000", 2, 3], ["oom 2 project", 3, 0]],
  },
  {
    what: "a contributor's kill never lowers what the project's copy learned; it only starts the count over",
    lines: [["oom 1 project", 2, 0], ["oom 2 project", 3, 0], ["peak 2500", 3, 1], ["oom 2 community", 3, 0]],
  },
  {
    what: "a kill at a size the claim clamped below the remembered one changes nothing but the count",
    from: { size: 3, lower: 2, task: 7, why: "oom", at: "2026-10-01T00:00:00.000Z" },
    lines: [["oom 2 project", 3, 0], ["oom 1 community", 3, 0]],
  },
  {
    what: "a peak at what the size under it gives is no lower peak; one megabyte under it is",
    lines: [["oom 1 community", 2, 0], [`peak ${peakBelowMb(2)}`, 2, 0], [`peak ${peakBelowMb(2) - 1}`, 2, 1], [`peak ${peakBelowMb(2)}`, 2, 0]],
  },
];

describe("the rules, replayed over recorded out-of-memory histories (#330, D31)", () => {
  it("the size under a remembered one gives its units' memory less both sidecars; a contributor's build learns up to 2, any other up to 4", () => {
    expect([peakBelowMb(2), peakBelowMb(3), peakBelowMb(4)]).toEqual([4096 - 64 - 256, 8192 - 64 - 256, 12288 - 64 - 256]);
    expect([learnCap("community"), learnCap("project")]).toEqual([2, 4]);
    expect(DECAY_AFTER).toBe(5);
  });

  for (const h of HISTORIES) {
    it(h.what, () => {
      let cur = h.from ?? NOTHING;
      h.lines.forEach(([report, size, lower], i) => {
        const [what, a, b] = report.split(" ");
        const task = 100 + i, at = `2026-10-06T00:00:${String(i).padStart(2, "0")}.000Z`;
        const next = what === "oom" ? afterOom(cur, { ran: Number(a), trust: b, task, at }) : a === "?" ? null : afterBuild(cur, { peak_mb: Number(a), task, at });
        // null is "nothing changes": nothing is written.
        if (next === null) expect({ size: cur.size ?? 1, lower: cur.lower }, `${report} (line ${i + 1}) changed nothing`).toEqual({ size, lower });
        else {
          expect({ size: next.size ?? 1, lower: next.lower }, `${report} (line ${i + 1})`).toEqual({ size, lower });
          // The report that changed the size is the one the page names; a lower peak counted names none.
          if (next.size !== cur.size) expect({ task: next.task, why: next.why, at: next.at }).toEqual({ task, why: what === "oom" ? "oom" : "decay", at });
          else expect({ task: next.task, why: next.why, at: next.at }).toEqual({ task: cur.task, why: cur.why, at: cur.at });
          cur = next;
        }
      });
    });
  }
});

// ---------- through the Worker ----------

const ORIGIN = "http://localhost:8787";

interface Res { status: number; json: any }
async function call(method: string, path: string, o: { token?: string; body?: unknown; raw?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, { method, headers, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** The Studio, native aarch64 only: 11 units, size 4 fits beside the job unit. */
const STUDIO = { cpus: 12, mem_gb: 32, lanes: [{ arch: "aarch64", mode: "native" }] };
const CAP = { cpus: STUDIO.cpus, mem_gb: STUDIO.mem_gb, disk_free_gb: { work: 410, engine: 220 }, units: unitsOf({ cpus: STUDIO.cpus, mem_gb: STUDIO.mem_gb, units: null }), job_reserved: 1, agent_slots: 2, lanes: STUDIO.lanes };
const HOST = "studio-l";
let seq = 0;

/** The claim of the Studio's dispatcher, for builds only (the audits a staged build queues are not this test's). */
const claim = (leases: { task: number; gen: string }[] = []) => call("POST", "/factory/claim", { token: `omw_${HOST}`, body: {
  arch: "aarch64", version: "v1.0.2", hostname: HOST, kinds: ["build"], claim_id: `c_learn${String(++seq).padStart(7, "0")}`, want: 1, leases, capacity: CAP,
  agent: { provider: "anthropic", model: "claude-test", probe: "ok", checked_at: "2026-10-01T00:00:00Z" },
} });
/** A lease the Studio's claim hands out, for task `id`. */
async function lease(id: number, leases: { task: number; gen: string }[] = []): Promise<{ size: number; units: number; token: string; gen: string }> {
  const c = await claim(leases);
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  expect(c.json.task.id).toBe(id);
  return { size: c.json.task.size, units: c.json.task.units, token: c.json.token, gen: c.json.task.lease_gen };
}
/** The engine killed it at its memory limit, as the dispatcher reports it. */
const oom = (id: number, token: string) => call("POST", `/factory/tasks/${id}/fail`, { token, body: { error: "the engine killed it at its memory limit (4 GB, exit 137)", oom: true, final: false } });
/** A build that staged its package and completed, with the memory peak its dispatcher read from resources.json (or none). */
async function staged(id: number, name: string, token: string, peak?: number): Promise<void> {
  for (const f of ["PKGBUILD", "build.log", `${name}-1.0-1-aarch64.pkg.tar.zst`]) expect((await call("PUT", `/factory/tasks/${id}/artifacts/${f}`, { token, raw: `${name} ${f}` })).status).toBe(201);
  const done = await call("POST", `/factory/tasks/${id}/complete`, { token, body: { sha256: "c".repeat(64), filename: `${name}-1.0-1-aarch64.pkg.tar.zst`, version: "1.0-1", duration_ms: 60000, ...(peak === undefined ? {} : { ram_peak_mb: peak }) } });
  expect(done.status, JSON.stringify(done.json)).toBe(200);
}

/** A queued build. */
async function seedTask(t: { name: string; trust: "project" | "community"; owner?: string | null; params?: unknown; publish?: 0 | 1; status?: string }): Promise<number> {
  return (await env.DB.prepare(
    "INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params, max_attempts) VALUES (?, 'aarch64', '1.0-1', ?, 'test', 100, ?, ?, ?, ?, 'build', ?, 10) RETURNING id",
  ).bind(t.name, `https://github.com/x/${t.name}@v1:PKGBUILD`, t.status ?? "queued", t.publish ?? 0, t.trust, t.owner ?? (t.trust === "community" ? "bob" : null), t.params === undefined ? null : JSON.stringify(t.params)).first<{ id: number }>())!.id;
}
const register = (name: string) => env.DB.prepare("INSERT INTO factory_packages (name, owner, url, arches, status) VALUES (?, 'bob', ?, '[\"aarch64\"]', 'waiting')").bind(name, `https://${name}.example`).run();
const learned = (name: string) => env.DB.prepare("SELECT learned_size AS size, learned_lower AS lower, learned_task AS task, learned_why AS why FROM factory_packages WHERE name = ?").bind(name).first<any>();
const lines = async (name: string) => (await env.DB.prepare("SELECT status, summary FROM events WHERE kind = 'build' AND json_extract(payload, '$.learned') IS NOT NULL AND json_extract(payload, '$.name') = ? ORDER BY id").bind(name).all<any>()).results;
const story = async (name: string) => (await call("GET", `/factory/packages/${name}/story?t=${++seq}`)).json;

beforeAll(async () => {
  const h = sha256Hex;
  const hostId = "h_learn00001";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2')"),
    env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES ('m1', ?, ?, 'maintainer', 1001), ('m2', ?, ?, 'maintainer', 1002), ('bob', ?, ?, 'contributor', 2001)")
      .bind(await h("omc_m1"), await h("oms_m1"), await h("omc_m2"), await h("oms_m2"), await h("omc_bob"), await h("oms_bob")),
    env.DB.prepare(`INSERT INTO hosts (id, owner_login, owner_github_id, name, pubkey, status, arch, capacity, lanes, units, agent_slots, disk_free, worker_id, confirmed_at, last_seen)
                    VALUES (?, 'm1', 1001, ?, ?, 'active', 'aarch64', ?, ?, ?, 2, ?, ?, ?, ?)`)
      .bind(hostId, HOST, toB64url(crypto.getRandomValues(new Uint8Array(32))), JSON.stringify({ ...CAP, below_minimum: null }), JSON.stringify(STUDIO.lanes), CAP.units, JSON.stringify(CAP.disk_free_gb), HOST, new Date().toISOString(), new Date().toISOString()),
    env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, kind, host_id, kinds, agent_status) VALUES (?, 'aarch64', 'm1', ?, 'shared', 'project', 'm1', ?, 'host', ?, '[\"build\",\"trial\",\"audit\"]', 'ok')")
      .bind(HOST, await h(`omw_${HOST}`), new Date().toISOString(), hostId),
  ]);
});

afterEach(async () => {
  // Each test's queue is its own.
  await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE status IN ('queued', 'leased')").run();
});

describe("the migration (0050)", () => {
  it("adds the remembered size, the lower peaks counted and the report that last changed it to a package", async () => {
    const cols = (await env.DB.prepare("SELECT name FROM pragma_table_info('factory_packages')").all<{ name: string }>()).results.map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(["learned_size", "learned_lower", "learned_task", "learned_why", "learned_at"]));
    await register("checked");
    await expect(env.DB.prepare("UPDATE factory_packages SET learned_why = 'guess' WHERE name = 'checked'").run()).rejects.toThrow(/CHECK/);
  });
});

describe("raised after the engine's out-of-memory kill (#330, D31)", () => {
  it("a contributor's build that ran out of memory at size 1 is queued again and leased at 2, said on the journal and its story; never above 2", async () => {
    await register("hungry");
    const t = await seedTask({ name: "hungry", trust: "community" });
    const first = await lease(t);
    expect(first).toMatchObject({ size: 1, units: 2 });
    expect((await oom(t, first.token)).json).toMatchObject({ status: "queued" });
    expect(await learned("hungry")).toEqual({ size: 2, lower: 0, task: t, why: "oom" });
    expect(await lines("hungry")).toEqual([{ status: "warn", summary: `hungry: learned size 2 (was 1) — task ${t} for aarch64 ran out of memory at size 1 on ${HOST}; its builds ask size 2 from now on` }]);
    const s = await story("hungry");
    expect(s.package.sizing).toEqual({ size: 2, disk_gb: 40, from: "learned", disk_from: null, learned: { size: 2, lower: 0, of: 5, task: t, why: "oom", at: expect.any(String) } });
    // The same task, its next attempt: at the learned size.
    const second = await lease(t);
    expect(second).toMatchObject({ size: 2, units: 4 });
    // Out of memory at 2 too: a contributor's build learns no further — no line, and its next attempt still runs at 2.
    expect((await oom(t, second.token)).json).toMatchObject({ status: "queued" });
    expect(await learned("hungry")).toEqual({ size: 2, lower: 0, task: t, why: "oom" });
    expect(await lines("hungry")).toHaveLength(1);
    expect((await lease(t)).size).toBe(2);
  });

  it("the project's copy whose size a maintainer set keeps asking it while the pool learns under it; cleared, it climbs one step per kill to 4", async () => {
    await register("big");
    const from = await seedTask({ name: "big", trust: "community", status: "staged" });
    expect((await call("POST", "/factory/packages/big/size", { token: "omc_m1", body: { size: 1 } })).status).toBe(200);
    const t = await seedTask({ name: "big", trust: "project", params: { review: from } });
    let l = await lease(t);
    expect(l.size).toBe(1);
    await oom(t, l.token);
    expect((await learned("big")).size).toBe(2);
    expect((await lines("big")).map((x: any) => x.summary)).toEqual([`big: learned size 2 (was 1) — task ${t} for aarch64 ran out of memory at size 1 on ${HOST}; its builds still ask size 1, set on its page`]);
    expect((await story("big")).package.sizing).toMatchObject({ size: 1, from: "page", learned: { size: 2, lower: 0, why: "oom" } });
    // The maintainer's word wins: the next attempt runs at 1 again.
    l = await lease(t);
    expect(l.size).toBe(1);
    await call("POST", `/factory/tasks/${t}/fail`, { token: l.token, body: { error: "a mirror timed out", final: false } });
    // Cleared, the learned size stands; each kill raises it one step, to the signed maximum (4) and no further.
    const cleared = await call("POST", "/factory/packages/big/size", { token: "omc_m1", body: { size: null } });
    expect(cleared.json.sizing).toMatchObject({ size: 2, disk_gb: 40, from: "learned", learned: { size: 2 } });
    for (const [ran, after] of [[2, 3], [3, 4], [4, 4]]) {
      l = await lease(t);
      expect(l).toMatchObject({ size: ran, units: 2 * ran });
      await oom(t, l.token);
      expect((await learned("big")).size).toBe(after);
    }
    expect((await lines("big")).map((x: any) => x.summary).slice(1)).toEqual([
      `big: learned size 3 (was 2) — task ${t} for aarch64 ran out of memory at size 2 on ${HOST}; its builds ask size 3 from now on`,
      `big: learned size 4 (was 3) — task ${t} for aarch64 ran out of memory at size 3 on ${HOST}; its builds ask size 4 from now on`,
    ]);
    expect((await lease(t)).size).toBe(4);
  });

  it("a maintainer's dry run teaches nothing: its recipe may be any one they measure", async () => {
    await register("measured");
    const t = await seedTask({ name: "measured", trust: "project" });
    const l = await lease(t);
    await oom(t, l.token);
    expect(await learned("measured")).toEqual({ size: null, lower: 0, task: null, why: null });
    expect(await lines("measured")).toEqual([]);
  });
});

describe("decays after five builds in a row that peaked lower (#330, D31)", () => {
  it("back to size 1 after five lower peaks in a row; a build that needed the size starts the count over, one that says no peak counts nothing", async () => {
    await register("lean");
    const t = await seedTask({ name: "lean", trust: "community" });
    const l = await lease(t);
    await oom(t, l.token);
    expect((await learned("lean")).size).toBe(2);
    // Then its builds, each at size 2, report their peaks: 3776 MB is what size 1 gives a build's container.
    const peaks: [number | undefined, number][] = [[1500, 1], [1400, 2], [5000, 0], [undefined, 0], [1500, 1], [1600, 2], [1450, 3], [1500, 4]];
    for (const [peak, lower] of peaks) {
      const id = await seedTask({ name: "lean", trust: "community" });
      const b = await lease(id);
      expect(b.size).toBe(2);
      await staged(id, "lean", b.token, peak);
      expect(await learned("lean"), `after a peak of ${peak ?? "nothing said"}`).toMatchObject({ size: 2, lower });
    }
    expect(await lines("lean")).toHaveLength(1);
    const last = await seedTask({ name: "lean", trust: "community" });
    const b = await lease(last);
    await staged(last, "lean", b.token, 1500);
    expect(await learned("lean")).toEqual({ size: null, lower: 0, task: last, why: "decay" });
    expect((await lines("lean"))[1]).toEqual({ status: "ok", summary: `lean: learned size 1 (was 2) — 5 builds in a row peaked below the 3776 MB size 1 gives, the last task ${last} for aarch64 at 1500 MB on ${HOST}; its builds ask size 1 from now on` });
    expect((await story("lean")).package.sizing).toEqual({ size: 1, disk_gb: 20, from: null, disk_from: null });
    const next = await seedTask({ name: "lean", trust: "community" });
    expect((await lease(next)).size).toBe(1);
  });

  it("two builds ending at once are both counted: the remembered size is written compare-and-set", async () => {
    await register("pair");
    const t = await seedTask({ name: "pair", trust: "community" });
    const l = await lease(t);
    await oom(t, l.token);
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE id = ?").bind(t).run();
    const [a, b] = [await seedTask({ name: "pair", trust: "community" }), await seedTask({ name: "pair", trust: "community", owner: "m2" })];
    const la = await lease(a);
    const lb = await lease(b, [{ task: a, gen: la.gen }]);
    await Promise.all([staged(a, "pair", la.token, 1200), staged(b, "pair", lb.token, 1300)]);
    expect(await learned("pair")).toMatchObject({ size: 2, lower: 2 });
  });
});

describe("the package page (#330)", () => {
  it("its size fact says the learned size — the one its builds ask, or under a maintainer's — and a build queued again after running out of memory says the size it waits at", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${ORIGIN}/package/hungry`), env, ctx);
    await waitOnExecutionContext(ctx);
    const d = runScript(scriptOf(await res.text()), { pathname: "/package/hungry", functions: ["sizeWords", "buildPanel", "buildMark", "identity", "sizesAlive"], variables: ["ST", "WHO"] });
    const learnedAt = { size: 2, lower: 1, of: 5, task: 41, why: "oom", at: "2026-10-06T00:00:00.000Z" };
    expect(d.sizeWords({ size: 2, disk_gb: 40, from: "learned", disk_from: null, learned: learnedAt }))
      .toBe('size 2 · 40 GB of disk · learned: raised after <a href="/build/41">#41</a> ran out of memory · 1 of 5 builds since peaked lower');
    expect(d.sizeWords({ size: 1, disk_gb: 20, from: "page", disk_from: null, learned: learnedAt }))
      .toBe('size 1 · 20 GB of disk · set on this page · learned size 2, under it: raised after <a href="/build/41">#41</a> ran out of memory · 1 of 5 builds since peaked lower');
    expect(d.sizeWords({ size: 3, disk_gb: 60, from: "learned", disk_from: null, learned: { ...learnedAt, size: 3, lower: 0, task: 52, why: "decay" } }))
      .toBe('size 3 · 60 GB of disk · learned: lowered after 5 builds in a row peaked lower, the last <a href="/build/52">#52</a> · 0 of 5 builds since peaked lower');
    // Nothing learned: as before (#337).
    expect(d.sizeWords({ size: 1, disk_gb: 20, from: null, disk_from: null })).toBe("size 1 · 20 GB of disk · the default");
    // A contributor's build queued again after running out of memory at size 1, its package now asking 2: it says it waits at 2, and a
    // maintainer has nothing larger to offer it (a contributor's build stops at 2).
    const error = "out of memory at 4 GB (size 1) — the engine killed it: the engine killed it at its memory limit (4 GB, exit 137)";
    const b = { id: 41, kind: "build", trust: "community", owner: "bob", status: "queued", arch: "aarch64", attempts: 1, error, params: {} };
    const st = { package: { name: "hungry", owner: "bob", status: "waiting", sizing: { size: 2, disk_gb: 40, from: "learned", disk_from: null, learned: learnedAt } }, targets: { aarch64: { status: "building", task: 41 } }, request: { checks: [], complete: true }, chains: [{ contributor: b }] };
    d.setWHO(d.identity({ login: "m1", role: "maintainer" }));
    d.sizesAlive(st);
    d.setST(st);
    expect(d.buildMark(b)).toEqual(["wait", "queued again", "out of memory at 4 GB (size 1); queued again at size 2"]);
    expect(d.buildPanel()).toContain(`aarch64 is queued again at size 2 after running out of memory: “${error}”.`);
    expect(d.buildPanel()).not.toContain("data-retry-size");
    // The project's copy goes on to 4: Retry at size offers 3.
    const copy = { ...b, trust: "project" };
    d.setST({ ...st, chains: [{ contributor: copy }] });
    expect(d.buildPanel()).toContain('data-oom="1" data-retry-size="41" data-size="2" data-max="4">Retry at size 3</button>');
    // No host alive runs size 2 now: it waits at 1, as the claim clamps it, and Retry at size has nothing larger to offer.
    d.sizesAlive({ ...st, largest_size: 1 });
    d.setST({ ...st, largest_size: 1, chains: [{ contributor: copy }] });
    expect(d.buildMark(copy)).toEqual(["wait", "queued again", "out of memory at 4 GB (size 1); queued again at the same size"]);
    expect(d.buildPanel()).not.toContain("data-retry-size");
    // A maintainer's size of 1 on the page wins: queued again at the same size, Retry at size offers 2.
    d.sizesAlive({ ...st, package: { ...st.package, sizing: { size: 1, disk_gb: 20, from: "page", disk_from: "page", learned: learnedAt } } });
    expect(d.buildMark(b)).toEqual(["wait", "queued again", "out of memory at 4 GB (size 1); queued again at the same size"]);
  });
});
