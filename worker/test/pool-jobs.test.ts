/**
 * The Pipeline's Build tasks table words a pool job from its params and its
 * result — jobResult() and paramsLabel() in src/pages/pipeline.ts — and
 * the shapes it reads are written elsewhere: the params by the brain when
 * it queues the job (src/scheduler.ts, src/jobs.ts), the result by the
 * Rust worker when it completes it (crates/pkg-repo/src/work.rs, every
 * `result: serde_json::json!`). Nothing in the tests held those shapes
 * until 2026-09-18, so a rename on either side passed CI and the table read
 * zeros: the scheduler had batched the sync per architecture a week
 * earlier (one task, its sources as a list, the result per source with the
 * releases it pinned) and the page still read the one-source shape — every
 * sync row on production said "upstream 0 · uploaded 0 · removed 0 ·
 * unchanged" with an empty label, task 501 among them, which had uploaded
 * six packages and created release 346. This file runs the served page's
 * two functions over the fixture's one done job of every kind
 * (test/fixture.ts, F.jobs: params and result copied from the writers —
 * the audit, the trial and the publish run for real through the API) and
 * expects the words; the manifest (pipeline.tasks-table) pins the same
 * fields on the same rows, so a rename fails by the field's name and this
 * file by the sentence. A release is named one way in the column: its id
 * first, the ring's head "(edge #346)" after it where the result carries
 * the sequence — the sync rows said "release edge #346" beside a promotion's
 * "release 512", two numbers a reader could not tell apart.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { runScript, scriptOf, seedDashboard, type Fixture } from "./fixture";

let F: Fixture;
let jobResult: (t: unknown) => string;
let paramsLabel: (t: unknown) => string;
let tasks: Record<string, any>;

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeAll(async () => {
  F = await seedDashboard(env);
  const ran = runScript(scriptOf(await (await get("/pipeline")).text()), { pathname: "/pipeline", functions: ["jobResult", "paramsLabel"] });
  jobResult = ran.jobResult;
  paramsLabel = ran.paramsLabel;
  // The listing the table draws from: the fixture's done job of each kind, by its id.
  const listing = (await (await get("/api/v1/factory?limit=100")).json()) as { tasks: any[] };
  tasks = Object.fromEntries(Object.entries(F.jobs).map(([kind, id]) => [kind, listing.tasks.find((t) => t.id === id)]));
});

describe("the Pipeline's table words every pool job from the shapes the jobs post", () => {
  it("the listing hands every job's params and result as JSON, as the task's own page does", () => {
    for (const [kind, t] of Object.entries(tasks)) {
      expect(t, `the fixture's ${kind} job is in the listing`).toBeDefined();
      expect(typeof t.params, `${kind}: params`).toBe("object");
      expect(typeof t.result, `${kind}: result`).toBe("object");
    }
  });

  it("a sync of one architecture: the totals summed over its sources, the source that failed, the releases it pinned", () => {
    const t = tasks.sync;
    const sources: any[] = t.result.sources;
    const sum = (k: string) => sources.reduce((n, s) => n + (s[k] || 0), 0);
    expect(sum("uploaded"), "core's two packages, the fixture's journal line").toBe(2);
    expect(paramsLabel(t)).toBe(`${F.arch} · ${sources.length} sources`);
    expect(jobResult(t)).toBe(`upstream ${sum("upstream_total")} · uploaded 2 · removed 0 · failed 1 · ${sources[sources.length - 1].source} down · release ${t.result.releases[0].id} (edge #${t.result.releases[0].seq})`);
    // Production today, before this: every sync row read the one-source shape over the batched result.
    expect(jobResult(t)).not.toContain("upstream 0");
  });

  it("a promotion, a rollback, a render, a health check, the retention", () => {
    expect(paramsLabel(tasks.promote)).toBe("rc → stable");
    expect(jobResult(tasks.promote)).toBe(`promoted → stable, release ${F.release}`);
    expect(paramsLabel(tasks.rollback)).toBe(`stable → release ${F.previousRelease}`);
    expect(jobResult(tasks.rollback)).toBe(`stable rolled back to release ${F.previousRelease} as release ${F.release}`);
    expect(paramsLabel(tasks.render)).toBe(`stable/${F.arch}`);
    expect(jobResult(tasks.render)).toBe("rendered omarchy-core-stable");
    expect(paramsLabel(tasks.health)).toBe(`stable/${F.arch}`);
    expect(jobResult(tasks.health)).toBe("healthy");
    expect(paramsLabel(tasks.gc)).toBe("");
    expect(jobResult(tasks.gc)).toBe("kept the last 3 releases per ring");
  });

  it("the three jobs on a build: the audit's report, the trial's verdict, the file the publish put in the pool — every done row in words, none its JSON", () => {
    // w1 ran these for ours in the fixture; the Pipeline lists them among the pool's jobs and read their JSON, cut at 90 characters, until 2026-09-18.
    // The three are on one build, the project's build of ours: its id is in each job's params, as the brain queued them.
    const built = tasks.audit.params.task as number;
    expect(built).toBeGreaterThan(0);
    expect(tasks.trial.params.task).toBe(built);
    expect(tasks.publish.params.task).toBe(built);
    expect(paramsLabel(tasks.audit)).toBe(`${F.publishedPkg} · build #${built}`);
    expect(jobResult(tasks.audit)).toBe("ok · 0 findings — nothing to change");
    expect(paramsLabel(tasks.trial)).toBe(`${F.publishedPkg} · 2.0-1 · build #${built}`);
    expect(jobResult(tasks.trial)).toBe("installs · 1 package");
    expect(paramsLabel(tasks.publish)).toBe(`${F.publishedPkg} · ${tasks.publish.params.version} · build #${built}`);
    expect(jobResult(tasks.publish)).toBe(`published ${F.publishedPkg}-2.0-1-${F.arch}.pkg.tar.zst`);
    // The shapes work.rs posts for the other outcomes: an audit with findings, a trial that failed, a publish the fast lane carried on, one with the repos it rendered.
    expect(jobResult({ kind: "audit", result: { verdict: "warn", summary: "one thing to look at", findings: [{ severity: "medium" }] } })).toBe("warn · 1 finding — one thing to look at");
    expect(jobResult({ kind: "trial", result: { verdict: "install failed", packages: ["a", "b"], task: 3 } })).toBe("trial install failed · 2 packages");
    expect(jobResult({ kind: "publish", result: { sha256: "0", filename: "a-1-1-x86_64.pkg.tar.zst", version: "1-1", rendered: ["omarchy-factory-edge"], task: 3, fast_track: ["rc", "stable"] } })).toBe("published a-1-1-x86_64.pkg.tar.zst · fast-tracked to rc, stable · rendered omarchy-factory-edge");
    for (const [kind, t] of Object.entries(tasks)) expect(jobResult(t), `${kind} reads as JSON`).not.toMatch(/^\{/);
  });

  it("the security run, the weekly verify, the relayout, the enqueue", () => {
    expect(jobResult(tasks.security)).toBe("1 vulnerable / 0 fixed matches · 1 in KEV · fast-tracked into stable (1 fix)");
    expect(jobResult(tasks.verify)).toBe("6 objects · all verify");
    expect(jobResult(tasks.relayout)).toBe("6 moved · 0 ghosts · 0 missing · 6 old keys purged");
    expect(jobResult(tasks.enqueue)).toBe("main@0123456: 1 queued, 0 skipped, 3 up to date");
    for (const kind of ["security", "verify", "relayout", "enqueue"]) expect(paramsLabel(tasks[kind]), `${kind} takes no parameters`).toBe("");
  });

  it("the other verdicts and the one-source sync, as work.rs writes them", () => {
    // work.rs: a sync queued by hand for one source (src/jobs.ts) answers with the source's own report; `release` is [id, seq] or null.
    const one = { kind: "sync", params: { source: "core", arch: "x86_64", ring: "edge" }, result: { upstream_total: 5, uploaded: 2, already_indexed: 3, removed: 0, deferred: 0, failed: 0, release: [7, 3], rendered: ["omarchy-core-edge"] } };
    expect(paramsLabel(one)).toBe("core/x86_64 → edge");
    expect(jobResult(one)).toBe("upstream 5 · uploaded 2 · removed 0 · release 7 (edge #3)");
    expect(jobResult({ ...one, params: { source: "core", arch: "x86_64" } })).toBe("upstream 5 · uploaded 2 · removed 0 · release 7 (#3)");
    expect(jobResult({ ...one, result: { ...one.result, release: null } })).toBe("upstream 5 · uploaded 2 · removed 0 · unchanged");
    expect(jobResult({ ...tasks.sync, result: { ...tasks.sync.result, releases: [] } })).toContain(" · unchanged");
    // work.rs: the gate's three other verdicts.
    const promote = (result: unknown, params = { from: "edge", to: "rc", note: "by evidence" }) => jobResult({ kind: "promote", params, result });
    expect(promote({ verdict: "blocked", reasons: ["rc health is 2 h old", "abi: 1 break"] })).toBe("blocked — rc health is 2 h old; abi: 1 break");
    expect(promote({ verdict: "skip", why: "edge is at rc's release" })).toBe("nothing to promote — edge is at rc's release");
    expect(promote({ verdict: "rolled-back", release_id: 9, to: 8, unhealthy: ["aarch64"] })).toBe("rolled back to release 8 — health failed on aarch64");
    expect(paramsLabel({ kind: "promote", params: { from: "edge", to: "rc", arch: "x86_64", force: "yes" } })).toBe("edge → rc · x86_64 · forced");
    expect(paramsLabel({ kind: "verify", params: { ring: "stable", arch: "x86_64", repair: "no" } })).toBe("stable/x86_64 · report only");
    expect(paramsLabel({ kind: "gc", params: { keep: "5" } })).toBe("keep 5");
  });
});
