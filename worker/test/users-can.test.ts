/**
 * What a person may do on a person's page, decided in one place
 * (routes/contributors.ts, `workspace`): GET /users/:login/can says for
 * the caller what the doors behind the page's controls would answer —
 * `can.X` is true where the call answers 2xx, and where it is false the
 * refusal carries the same reason with a 4xx. Every role of the fixture
 * (test/fixture.ts) on alice's page: nobody signed in, bob who owns
 * nothing, alice herself, m1 a maintainer — and carol, blocked, on her
 * own. The answer is no-store: a per-caller field never rides the cached
 * page. A worker's row answers Drain and Resume beside Revoke (#412), in
 * the worker orders' own words (orders.ts orderVerdicts): the door of
 * POST /factory/workers/:id/orders refuses with the same sentence.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { POOL_HOSTS, RIGHTS, SIGN_IN, type Rights } from "../src/routes/contributors";
import { legacyWorker, seedDashboard, type Fixture } from "./fixture";

let F: Fixture;

type Who = "" | "bob" | "alice" | "m1" | "carol";

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

const canOn = async (login: string, as: Who): Promise<Rights> => {
  const r = await call("GET", `/users/${login}/can`, as);
  expect(r.status, `GET /users/${login}/can as ${as || "nobody"}`).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.json.login).toBe(login);
  return r.json.can as Rights;
};
const flags = (c: Rights) => Object.fromEntries(RIGHTS.map((r) => [r, c[r]]));
const allFalse = Object.fromEntries(RIGHTS.map((r) => [r, false]));
/** A worker's mode is gone (#343): its door answers 410 to everyone, with the pointer, before whose it is. */
const modeGone = async (id: string, as: Who) => {
  const r = await call("POST", `/factory/workers/${id}/mode`, as, { mode: "shared" });
  expect([r.status, r.json.code, r.json.docs], `${as || "nobody"} sets ${id}'s mode`).toEqual([410, "gone", "/docs/worker-host#maintainer-hosts"]);
};

/** The worker orders' words a person's page greys Drain and Resume with (orders.ts orderVerdicts): whose the orders are, and a worker not drained. */
const ORDERS_BY = "only alice or a maintainer gives it orders";
const NOT_DRAINED = "it is not drained: there is nothing to resume";
/** A person's order of a worker, with their CLI token: a session's write would need the page's Origin (orders.ts writeGate). */
async function order(id: string, as: Who, kind: string, reason: string): Promise<{ status: number; json: any }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test/api/v1/factory/workers/${id}/orders`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer omc_${as}` }, body: JSON.stringify({ kind, reason }) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** The refusal a door answers is the predicate's sentence with its status. */
const refusedLike = (res: { status: number; json: any }, status: number, why: string | undefined, what: string) => {
  expect(res.status, `${what}: ${JSON.stringify(res.json)}`).toBe(status);
  expect(res.json.error, what).toBe(why);
};

describe("what a caller may do on a person's page", () => {
  it("nobody signed in: everything false, the sign-in as the reason — the registrations and the workers too; an unknown login is 404", async () => {
    const c = await canOn("alice", "");
    expect(flags(c)).toEqual(allFalse);
    expect(c.why).toEqual(Object.fromEntries(RIGHTS.map((r) => [r, SIGN_IN])));
    expect(Object.keys(c.packages).sort()).toEqual([F.factoryPkg, F.publishedPkg, F.disposablePkg, F.sparePkg].sort());
    for (const name of Object.keys(c.packages)) expect(c.packages[name]).toEqual({ remove: false, why: SIGN_IN });
    expect(Object.keys(c.workers)).toEqual([F.ownerWorker]);
    expect(c.workers[F.ownerWorker]).toEqual({ revoke: false, drain: false, resume: false, why: { revoke: SIGN_IN, drain: SIGN_IN, resume: SIGN_IN } });
    expect((await call("GET", "/users/nobody/can", "")).status).toBe(404);
    // The doors say the same, in the same words: 401 for nobody, the sign-in.
    refusedLike(await call("POST", `/factory/packages/${F.factoryPkg}/build`, "", {}), 401, SIGN_IN, "nobody builds");
    refusedLike(await call("DELETE", `/factory/packages/${F.factoryPkg}`, ""), 401, SIGN_IN, "nobody removes");
    refusedLike(await call("DELETE", `/factory/workers/${F.ownerWorker}`, ""), 401, SIGN_IN, "nobody revokes");
    await modeGone(F.ownerWorker, "");
    refusedLike(await call("POST", `/factory/tasks/${F.projectTask}/withdraw`, "", { note: "nobody's" }), 401, SIGN_IN, "nobody withdraws");
    refusedLike(await call("POST", "/factory/token", ""), 401, SIGN_IN, "nobody mints");
    refusedLike(await call("POST", "/factory/workers", "", { arch: F.arch }), 401, SIGN_IN, "nobody registers");
    refusedLike(await call("POST", "/factory/packages", "", { url: "https://x.example" }), 401, SIGN_IN, "nobody requests");
  });

  it("bob, who owns nothing, on alice's page: everything false, each with whose it is (and where his own is) — and every door refuses him in the same words", async () => {
    const c = await canOn("alice", "bob");
    expect(flags(c)).toEqual(allFalse);
    expect(c.why).toEqual({
      request: "only alice requests here — yours is on /user/bob",
      register: "only alice registers a worker here — yours is on /user/bob",
      token: "only alice mints their token — yours is on /user/bob",
      build: "only alice builds here — yours is on /user/bob",
      dequeue: "only alice takes their build out of the queue — yours is on /user/bob",
      remove: "only alice or a maintainer removes a registration here",
      revoke: "only alice or a maintainer revokes a worker here",
      withdraw: "a maintainer decides",
    });
    for (const name of Object.keys(c.packages)) expect(c.packages[name]).toEqual({ remove: false, why: "only alice removes it, or a maintainer" });
    expect(c.workers[F.ownerWorker]).toEqual({ revoke: false, drain: false, resume: false, why: { revoke: c.why.revoke, drain: ORDERS_BY, resume: ORDERS_BY } });
    refusedLike(await order(F.ownerWorker, "bob", "drain", "bob's word"), 403, ORDERS_BY, "bob drains alice's worker");
    refusedLike(await call("POST", `/factory/packages/${F.factoryPkg}/build`, "bob", { arches: [F.arch] }), 404, c.why.build, "bob builds mine");
    refusedLike(await call("DELETE", `/factory/packages/${F.factoryPkg}`, "bob"), 403, c.packages[F.factoryPkg].why, "bob removes mine");
    refusedLike(await call("DELETE", `/factory/packages/${F.factoryPkg}/builds/${F.stagedTask}`, "bob"), 403, c.why.dequeue, "bob takes alice's build out");
    refusedLike(await call("DELETE", `/factory/workers/${F.ownerWorker}`, "bob"), 404, c.why.revoke, "bob revokes alice's worker");
    await modeGone(F.ownerWorker, "bob");
    refusedLike(await call("POST", `/factory/tasks/${F.projectTask}/withdraw`, "bob", { note: "bob's word" }), 403, c.why.withdraw, "bob withdraws");
    // The token, the request and a worker are the caller's own: the door mints bob's token, on bob's page — which is why alice's page offers them to nobody else.
    expect((await call("POST", "/factory/token", "bob")).json.login).toBe("bob");
    expect((await canOn("bob", "bob")).token).toBe(true);
  });

  it("alice on her own page: the workspace is hers — build, the queue, her legacy worker, the token; Remove per registration and Revoke per worker as they stand; never Withdraw, and no new worker (#331)", async () => {
    const c = await canOn("alice", "alice");
    expect(flags(c)).toEqual({ ...allFalse, request: true, token: true, build: true, dequeue: true, remove: true, revoke: true });
    expect(c.why).toEqual({ register: POOL_HOSTS, withdraw: "a maintainer decides" });
    expect(c.workers[F.ownerWorker]).toEqual({ revoke: true, drain: true, resume: false, why: { resume: NOT_DRAINED } });
    // Her two registrations are the maintainers' now: mine approved (its publish waits), ours published into edge.
    expect(c.packages[F.factoryPkg]).toEqual({ remove: false, why: `${F.factoryPkg} is approved: a maintainer removes it` });
    expect(c.packages[F.publishedPkg]).toEqual({ remove: false, why: `${F.publishedPkg} is published: a maintainer removes it` });
    refusedLike(await call("DELETE", `/factory/packages/${F.factoryPkg}`, "alice"), 403, c.packages[F.factoryPkg].why, "alice removes mine");
    refusedLike(await call("POST", `/factory/tasks/${F.projectTask}/withdraw`, "alice", { note: "her own" }), 403, c.why.withdraw, "alice withdraws");
    // Each true, at the door: a build queued, then taken out of the queue; a token; a worker registered before #331 revoked (its mode is gone, #343). A new one is refused with the page's sentence.
    const built = await call("POST", `/factory/packages/${F.factoryPkg}/build`, "alice", { arches: [F.arch] });
    expect(built.status, JSON.stringify(built.json)).toBe(201);
    const queued = built.json.tasks[0] as number;
    refusedLike(await call("DELETE", `/factory/packages/${F.factoryPkg}/builds/${queued}`, "bob"), 403, "only alice takes their build out of the queue — yours is on /user/bob", "bob takes the new build out");
    expect((await call("DELETE", `/factory/packages/${F.factoryPkg}/builds/${queued}`, "alice")).json).toMatchObject({ task: queued, status: "cancelled" });
    expect((await call("POST", "/factory/token", "alice")).status).toBe(201);
    refusedLike(await call("POST", "/factory/workers", "alice", { name: "box", arch: F.arch }), 403, c.why.register, "alice registers a worker");
    const w = { json: { worker: await legacyWorker(env, "alice", "box", F.arch) } };
    await modeGone(w.json.worker, "alice");
    expect((await call("DELETE", `/factory/workers/${w.json.worker}`, "alice")).json).toMatchObject({ revoked: w.json.worker });
    refusedLike(await call("DELETE", `/factory/workers/${w.json.worker}`, "alice"), 404, `${w.json.worker} is revoked already`, "revoked twice");
    // Revoked, the worker's row still answers — grey with the state's word for its owner and for a maintainer, before whose it is.
    const gone = `${w.json.worker} is revoked already`;
    for (const as of ["alice", "m1", "bob"] as Who[]) expect((await canOn("alice", as)).workers[w.json.worker], as).toEqual({ revoke: false, drain: false, resume: false, why: { revoke: gone, drain: gone, resume: gone } });
    expect((await call("DELETE", "/factory/workers/no-such-worker", "alice")).status).toBe(404);
  });

  it("Drain and Resume on alice's worker (#412): the row says what the orders' door answers — m1 drains it, the row turns to Resume with the drain's words, and a second drain is refused in them", async () => {
    expect((await canOn("alice", "m1")).workers[F.ownerWorker]).toMatchObject({ drain: true, resume: false });
    const drained = await order(F.ownerWorker, "m1", "drain", "a disk to replace");
    expect(drained.status, JSON.stringify(drained.json)).toBe(201);
    const after = await canOn("alice", "m1"), row = after.workers[F.ownerWorker] as Rights["workers"][string] & { drain: boolean; resume: boolean; why: Record<string, string> };
    expect(row).toMatchObject({ revoke: true, drain: false, resume: true });
    expect(row.why.drain).toMatch(/^drained already \(by m1, .*: a disk to replace\) — Resume ends it$/);
    refusedLike(await order(F.ownerWorker, "m1", "drain", "again"), 409, row.why.drain, "m1 drains it twice");
    // Its owner may resume it too (a maintainer drained it); bob may do neither, in the orders' words; nobody is asked to sign in.
    expect((await canOn("alice", "alice")).workers[F.ownerWorker]).toMatchObject({ drain: false, resume: true });
    expect((await canOn("alice", "bob")).workers[F.ownerWorker]).toMatchObject({ drain: false, resume: false, why: { drain: ORDERS_BY, resume: ORDERS_BY } });
    expect((await canOn("alice", "")).workers[F.ownerWorker]).toMatchObject({ drain: false, resume: false, why: { drain: SIGN_IN, resume: SIGN_IN } });
    expect((await order(F.ownerWorker, "m1", "resume", "the disk is in")).status).toBe(201);
    expect((await canOn("alice", "m1")).workers[F.ownerWorker]).toEqual({ revoke: true, drain: true, resume: false, why: { resume: NOT_DRAINED } });
  });

  it("m1, a maintainer, on alice's page: not her workspace — but Revoke, Withdraw and Remove (an approved one too) are theirs", async () => {
    const c = await canOn("alice", "m1");
    expect(flags(c)).toEqual({ ...allFalse, remove: true, revoke: true, withdraw: true });
    expect(c.why).toEqual({
      request: "only alice requests here — yours is on /user/m1",
      register: "only alice registers a worker here — yours is on /user/m1",
      token: "only alice mints their token — yours is on /user/m1",
      build: "only alice builds here — yours is on /user/m1",
      dequeue: "only alice takes their build out of the queue — yours is on /user/m1",
    });
    for (const name of Object.keys(c.packages)) expect(c.packages[name]).toEqual({ remove: true });
    expect(c.workers[F.ownerWorker]).toEqual({ revoke: true, drain: true, resume: false, why: { resume: NOT_DRAINED } });
    // The project's worker, on m1's own page: Revoke and Drain are the maintainer's; its mode, as every worker's, is gone (#343).
    expect((await canOn("m1", "m1")).workers[F.worker]).toEqual({ revoke: true, drain: true, resume: false, why: { resume: NOT_DRAINED } });
    await modeGone(F.worker, "m1");
    refusedLike(await call("POST", `/factory/packages/${F.factoryPkg}/build`, "m1", { arches: [F.arch] }), 404, c.why.build, "m1 builds mine");
    refusedLike(await call("DELETE", `/factory/packages/${F.factoryPkg}/builds/${F.stagedTask}`, "m1"), 403, c.why.dequeue, "m1 takes alice's build out");
    await modeGone(F.ownerWorker, "m1");
    expect((await call("POST", `/factory/tasks/${F.projectTask}/withdraw`, "m1", { note: "taken back by the test" })).status).toBe(200);
    expect((await call("DELETE", `/factory/workers/${F.ownerWorker}`, "m1")).json).toMatchObject({ revoked: F.ownerWorker });
    // The maintainer's removal takes the approved one and the published one alike, and the two under review; then alice's page has nothing to remove.
    for (const name of [F.factoryPkg, F.publishedPkg, F.disposablePkg, F.sparePkg]) {
      const r = await call("DELETE", `/factory/packages/${name}`, "m1");
      expect(r.status, `m1 removes ${name}: ${JSON.stringify(r.json)}`).toBe(200);
    }
    expect((await canOn("alice", "m1")).packages).toEqual({});
  });

  it("carol, blocked, on her own page: the page is hers, but a request and a build are refused with the block, a worker with the pool's hosts — and her registration is hers to remove", async () => {
    const c = await canOn("carol", "carol");
    const blocked = "carol is blocked by a maintainer: requests under a name that is not hers; nothing can be requested or built until another maintainer lifts it";
    expect(flags(c)).toEqual({ ...allFalse, token: true, dequeue: true, remove: true, revoke: true });
    expect(c.why).toEqual({ request: blocked, register: POOL_HOSTS, build: blocked, withdraw: "a maintainer decides" });
    expect(c.packages[F.blockedPkg]).toEqual({ remove: true });
    // A worker is a maintainer's before anything else (#331): every contributor reads the same sentence, blocked or not.
    refusedLike(await call("POST", "/factory/workers", "carol", { arch: F.arch }), 403, POOL_HOSTS, "carol registers a worker");
    // Her package is blocked too: the package's word comes first at the door, as the page greys the button — with no trailing colon when the block has no reason.
    refusedLike(await call("POST", `/factory/packages/${F.blockedPkg}/build`, "carol", { arches: [F.arch] }), 403, `${F.blockedPkg} is blocked by a maintainer: ${(await call("GET", `/factory/packages/${F.blockedPkg}/story`, "")).json.package.blocked_reason}`, "carol builds hers");
    refusedLike(await call("POST", "/factory/packages", "carol", { url: "https://other.example" }), 403, blocked, "carol requests");
    expect((await call("DELETE", `/factory/packages/${F.blockedPkg}`, "carol")).status).toBe(200);
  });
});
