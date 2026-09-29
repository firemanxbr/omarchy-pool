/**
 * A build an emulated worker sent back (#281): the fail report's
 * `needs_native` marks it (params.needs_native) and the claim hands it to no
 * emulated worker again (factory.test.ts). Here, the pages say what it
 * waits for, run over the Worker's own answers on the fixture: the Status
 * page's row, the build's own page (its pill and its lede), the Factory's
 * card — a contributor's build and the project's rebuild, whichever of its
 * architectures waits, past the live read by the package's detail — the
 * Review workbench, the person's page, the package page's review cell, and
 * the Workers page, how many wait per architecture, each linked; none
 * waiting, nothing said. The Workers page reads the live listing, the tasks in flight through
 * the queue's index, and no longer the whole listing.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { settleTargets } from "../src/targets";
import { runScript, scriptOf, seedDashboard, type Fixture, type Ran } from "./fixture";

let F: Fixture;
let waiting: number;

async function real(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
/** Past the edge's copy of an answer: every read a fresh one, so a test that wrote a row reads it. */
let fresh = 0;
const uncached = (path: string) => (path === "/auth/me" ? path : `${path}${path.includes("?") ? "&" : "?"}fresh=${++fresh}`);

/** A page's script run over the Worker's answers, until `ready` says it drew what the test reads. */
async function drawn(path: string, ready: (d: Ran) => boolean, opts: { functions?: string[]; variables?: string[] } = {}): Promise<Ran & Record<string, any>> {
  const html = await (await real(path)).text();
  const d = runScript(scriptOf(html), { pathname: path, functions: opts.functions ?? [], variables: opts.variables, fetch: (p, init) => real(uncached(p), init) });
  for (let i = 0; i < 100 && !ready(d); i++) await new Promise((r) => setTimeout(r, 30));
  return d as Ran & Record<string, any>;
}

/** alice's `slowrust`: its build, queued again after an emulated worker could not start rustc — the row handleFail leaves behind. */
async function sendBack(): Promise<number> {
  await env.DB.prepare("INSERT INTO factory_packages (name, owner, url, arches, status, project, source, description, license) VALUES ('slowrust', 'alice', 'https://slowrust.example', ?, 'waiting', 'https://slowrust.example', 'https://slowrust.example/slowrust-1.tar.gz', 'A Rust tool the test sends back', 'MIT')")
    .bind(JSON.stringify([F.arch])).run();
  const row = await env.DB.prepare(
    "INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, attempts, params, error) VALUES ('slowrust', ?, '1', 'draft:https://slowrust.example@1', 'contributor', 110, 0, 'community', 'alice', 'build', 'queued', 0, '{\"needs_native\":1}', ?) RETURNING id",
  )
    .bind(F.arch, `exit 96: rustc cannot start on this worker: emulated ${F.arch} under qemu on a host whose page size is not the guest's — a native worker is needed for this package`)
    .first<{ id: number }>();
  await settleTargets(env, "slowrust");
  return row!.id;
}

beforeAll(async () => {
  F = await seedDashboard(env);
});

describe("a build waiting for a native worker", () => {
  it("the Workers page says nothing while none waits", async () => {
    const d = await drawn("/workers", (x) => x.nodes["#native-wait"] !== undefined);
    expect(d.nodes["#native-wait"].hidden).toBe(true);
    expect(d.nodes["#native-wait"].innerHTML).toBe("");
    waiting = await sendBack();
  });

  it("the Workers page says how many wait, per architecture, each linked", async () => {
    const d = await drawn("/workers", (x) => !!x.nodes["#native-wait"]?.innerHTML);
    expect(d.nodes["#native-wait"].hidden).toBe(false);
    expect(d.nodes["#native-wait"].innerHTML).toBe(`<b>1 build waits for a native ${F.arch} worker.</b> It could not run emulated: <a href="/build/${waiting}">#${waiting}</a>. <a href="/docs/workers">Run one →</a>`);
    // Two of them, and a full live read: "at least".
    const w = await drawn("/workers", (x) => !!x.nodes["#native-wait"]?.innerHTML, { functions: ["drawNativeWait"], variables: ["LISTED"] });
    const t = (id: number, arch: string) => ({ id, arch, status: "queued", params: { needs_native: 1 } });
    w.drawNativeWait({ tasks: [t(7, "x86_64"), t(9, "x86_64"), { id: 8, arch: "x86_64", status: "leased", params: { needs_native: 1 } }, { id: 10, arch: "aarch64", status: "queued", params: {} }] });
    expect(w.nodes["#native-wait"].innerHTML).toBe('<b>2 builds wait for a native x86_64 worker.</b> They could not run emulated: <a href="/build/7">#7</a>, <a href="/build/9">#9</a>. <a href="/docs/workers">Run one →</a>');
    w.setLISTED(4);
    w.drawNativeWait({ tasks: [t(7, "x86_64"), t(9, "aarch64"), t(11, "x86_64"), t(12, "x86_64")] });
    expect(w.nodes["#native-wait"].innerHTML).toBe('<b>At least 1 build waits for a native aarch64 worker.</b> It could not run emulated: <a href="/build/9">#9</a>.<br><b>At least 3 builds wait for a native x86_64 worker.</b> They could not run emulated: <a href="/build/7">#7</a>, <a href="/build/11">#11</a>, <a href="/build/12">#12</a>. <a href="/docs/workers">Run one →</a>');
    w.drawNativeWait({ tasks: [] });
    expect(w.nodes["#native-wait"].hidden).toBe(true);
  });

  it("the Status page's row says what it waits for", async () => {
    const d = await drawn("/status", (x) => (x.nodes["#tasks tbody"]?.innerHTML ?? "").includes(`/build/${waiting}"`));
    const row = (d.nodes["#tasks tbody"].innerHTML as string).split("<tr>").find((r) => r.includes(`/build/${waiting}"`))!;
    expect(row).toContain(`<span class="pill none">queued</span> <span class="pill warn" title="it could not run emulated: a toolchain or a library did not start under qemu. No emulated worker takes it again.">waiting for a native ${F.arch} worker</span>`);
    // Any other row says nothing of it.
    expect((d.nodes["#tasks tbody"].innerHTML as string).match(/waiting for a native/g)).toHaveLength(1);
  });

  it("the build's page wears it and its lede says it", async () => {
    const d = await drawn(`/build/${waiting}`, (x) => !!x.nodes["#lede"]?.innerHTML);
    expect(d.nodes["#badges"].innerHTML).toContain(`<span class="pill warn" title="it could not run emulated: a toolchain or a library did not start under qemu. No emulated worker takes it again.">waiting for a native ${F.arch} worker</span>`);
    expect(d.nodes["#lede"].innerHTML).toContain(` · queued, waiting for a native ${F.arch} worker: it could not run emulated.`);
    // A build that is not sent back says neither.
    const other = await drawn(`/build/${F.projectTask}`, (x) => !!x.nodes["#lede"]?.innerHTML);
    expect(other.nodes["#badges"].innerHTML).not.toContain("waiting for a native");
    expect(other.nodes["#lede"].innerHTML).not.toContain("waiting for a native");
  });

  it("the Factory's card says it — the contributor's build, and the project's rebuild in review", async () => {
    const d = await drawn("/factory", (x) => (x.nodes["#board"]?.innerHTML ?? "").includes("slowrust") || (x.nodes["#col-1"]?.innerHTML ?? "").includes("slowrust"), { functions: ["noteOf"], variables: ["LISTING"] });
    const board = Object.values(d.nodes).map((n: any) => n.innerHTML ?? "").join("");
    const card = /<a class="fx-card[^"]*" href="[^"]*slowrust[^"]*">[\s\S]*?<\/a>/.exec(board)?.[0] ?? "";
    expect(card).toContain(`<span class="fx-note warn" title="waiting for a native ${F.arch} worker">waiting for a native ${F.arch} worker</span>`);
    // The project's rebuild an emulated worker sent back, in review; one still building says so as before.
    d.setLISTING({ tasks: [{ id: 99, kind: "build", trust: "project", status: "queued", arch: "x86_64", params: { review: 5, needs_native: 1 } }, { id: 98, kind: "build", trust: "project", status: "queued", arch: "aarch64", params: { review: 4 } }] });
    expect(d.noteOf({ targets: { x86_64: { status: "reviewing", task: 99 } } }, 3)).toEqual(["waiting for a native x86_64 worker", "warn"]);
    expect(d.noteOf({ targets: { aarch64: { status: "reviewing", task: 98 } } }, 3)).toEqual(["project rebuilding", ""]);
    expect(d.noteOf({ targets: { aarch64: { status: "building", task: 98 } } }, 1)).toEqual(["queued for a worker", ""]);
    // Whichever architecture waits, not the first one only: aarch64 building on the native Studio, x86_64 sent back.
    d.setLISTING({ tasks: [{ id: 97, kind: "build", trust: "project", status: "leased", arch: "aarch64", attempts: 1, max_attempts: 3, params: { review: 4 } }, { id: 99, kind: "build", trust: "project", status: "queued", arch: "x86_64", params: { review: 5, needs_native: 1 } }] });
    expect(d.noteOf({ targets: { aarch64: { status: "reviewing", task: 97 }, x86_64: { status: "reviewing", task: 99 } } }, 3)).toEqual(["waiting for a native x86_64 worker", "warn"]);
    expect(d.noteOf({ targets: { aarch64: { status: "building", task: 97 }, x86_64: { status: "building", task: 99 } } }, 1)).toEqual(["waiting for a native x86_64 worker", "warn"]);
    expect(d.noteOf({ targets: { aarch64: { status: "building", task: 97 } } }, 1)).toEqual(["rebuilding from scratch on aarch64", ""]);
    // Past the live read's twenty rows: the package's detail, which the fail report wrote naming that very task.
    d.setLISTING({ tasks: [] });
    expect(d.noteOf({ detail: "the project's build (task 99) waits for a native x86_64 worker", targets: { x86_64: { status: "reviewing", task: 99 } } }, 3)).toEqual(["waiting for a native x86_64 worker", "warn"]);
    expect(d.noteOf({ detail: "waiting for a native x86_64 worker (task 99)", targets: { aarch64: { status: "building", task: 97 }, x86_64: { status: "building", task: 99 } } }, 1)).toEqual(["waiting for a native x86_64 worker", "warn"]);
    // A detail that names another task, or a target past it, says nothing.
    expect(d.noteOf({ detail: "the project's build (task 9) waits for a native x86_64 worker", targets: { x86_64: { status: "reviewing", task: 99 } } }, 3)).toEqual(["project rebuilding", ""]);
    expect(d.noteOf({ detail: "waiting for a native x86_64 worker (task 99)", targets: { x86_64: { status: "reviewing", task: 100 } } }, 3)).toEqual(["project rebuilding", ""]);
  });

  // The project's rebuild an emulated worker sent back, where a maintainer and the contributor follow it (#281's own case: omarchy-cli's x86_64 review build).
  const sentBack = { id: 99, kind: "build", trust: "project", status: "queued", arch: "x86_64", attempts: 0, max_attempts: 3, params: { review: 5, needs_native: 1 } };
  const words = "waiting for a native x86_64 worker";

  it("the Review workbench's step and log say what the rebuild waits for", async () => {
    const d = await drawn("/review", (x) => x.nodes["#rv-steps"] !== undefined, { functions: ["renderSteps", "renderRebuild"] });
    const R = [{ arch: "x86_64", asked: true, target: { status: "reviewing", task: 99 }, rebuild: sentBack }];
    d.renderSteps(R);
    expect(d.nodes["#rv-steps"].innerHTML).toContain(`<span class="t">Build x86_64</span><span class="w">native worker</span>`);
    expect(d.nodes["#rv-steps"].innerHTML).toContain(`title="${words}: it could not run emulated"`);
    d.renderRebuild(R, null);
    expect(d.nodes["#rv-y-log"].innerHTML).toContain(`${words}: it could not run emulated`);
    expect(d.nodes["#rv-y-log"].innerHTML).not.toContain("queued for a review worker");
    // A rebuild queued as any other says so as before.
    const plain = [{ ...R[0], rebuild: { ...sentBack, params: { review: 5 } } }];
    d.renderSteps(plain);
    expect(d.nodes["#rv-steps"].innerHTML).toContain(`<span class="t">Build x86_64</span><span class="w">queued</span>`);
    d.renderRebuild(plain, null);
    expect(d.nodes["#rv-y-log"].innerHTML).toContain("queued for a review worker");
  });

  it("the person's page says it, not that the project is building it", async () => {
    const d = await drawn(`/user/${F.owner}`, (x) => x.nodes["#title"] !== undefined, { functions: ["nextStep"] });
    const cc = { id: 98, kind: "build", trust: "community", status: "staged", arch: "x86_64", params: {} };
    const line = d.nextStep({ package: {}, rings: [] }, { contributor: cc, project: sentBack, score: { class: "B", projected: "A" } });
    expect(line).toContain(`The project builds it again (<a href="/build/99">#99</a>), ${words}: a toolchain or a library could not start <b>emulated</b>. Then the trial, then a maintainer decides.`);
    expect(d.nextStep({ package: {}, rings: [] }, { contributor: cc, project: { ...sentBack, params: { review: 5 } }, score: {} })).toContain("The project is building it again");
    // The person's Builds table: alice's slowrust, sent back, wears the pill; her other rows do not.
    const u = await drawn("/user/alice", (x) => (x.nodes["#builds tbody"]?.innerHTML ?? "").includes(`/build/${waiting}"`));
    const rows = (u.nodes["#builds tbody"].innerHTML as string).split("<tr>");
    expect(rows.find((r) => r.includes(`/build/${waiting}"`))).toContain(`<span class="pill none">queued</span> <span class="pill warn" title="it could not run emulated: a toolchain or a library did not start under qemu. No emulated worker takes it again.">waiting for a native ${F.arch} worker</span>`);
    expect(rows.filter((r) => r.includes("waiting for a native"))).toHaveLength(1);
  });

  it("the package page's review cell says it", async () => {
    const d = await drawn(`/package/${F.pkg}`, (x) => x.nodes["#title"] !== undefined, { functions: ["buildMark"] });
    expect(d.buildMark(sentBack)).toEqual(["wait", "native worker", `${words}: it could not run emulated`]);
    expect(d.buildMark({ ...sentBack, params: { review: 5 } })).toEqual(["wait", "queued", "waiting for a worker"]);
  });
});
