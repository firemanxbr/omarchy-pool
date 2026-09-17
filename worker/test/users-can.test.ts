/**
 * What a person may do on a person's page, decided in one place
 * (routes/contributors.ts, `workspace`): GET /users/:login/can says for
 * the caller what the doors behind the page's controls would answer —
 * `can.X` is true where the call answers 2xx, and where it is false the
 * refusal carries the same reason with a 4xx. Every role of the fixture
 * (test/fixture.ts) on alice's page: nobody signed in, bob who owns
 * nothing, alice herself, m1 a maintainer — and carol, blocked, on her
 * own. The answer is no-store: a per-caller field never rides the cached
 * page.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { RIGHTS, SIGN_IN, type Rights } from "../src/routes/contributors";
import { seedDashboard, type Fixture } from "./fixture";

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
const OWNERS_WORD = "sharing is the owner's word alone: a maintainer can set a worker to its owner's packages, not share it";

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
    expect(Object.keys(c.packages).sort()).toEqual([F.factoryPkg, F.publishedPkg].sort());
    for (const name of Object.keys(c.packages)) expect(c.packages[name]).toEqual({ remove: false, why: SIGN_IN });
    expect(Object.keys(c.workers)).toEqual([F.communityWorker]);
    expect(c.workers[F.communityWorker]).toEqual({ revoke: false, own_only: false, share_worker: false, why: { revoke: SIGN_IN, own_only: SIGN_IN, share_worker: SIGN_IN } });
    expect((await call("GET", "/users/nobody/can", "")).status).toBe(404);
    // The doors say the same, in the same words: 401 for nobody, the sign-in.
    refusedLike(await call("POST", `/factory/packages/${F.factoryPkg}/build`, "", {}), 401, SIGN_IN, "nobody builds");
    refusedLike(await call("DELETE", `/factory/packages/${F.factoryPkg}`, ""), 401, SIGN_IN, "nobody removes");
    refusedLike(await call("DELETE", `/factory/workers/${F.communityWorker}`, ""), 401, SIGN_IN, "nobody revokes");
    refusedLike(await call("POST", `/factory/workers/${F.communityWorker}/mode`, "", { mode: "shared" }), 401, SIGN_IN, "nobody shares w3");
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
      own_only: "only alice or a maintainer sets where it builds",
      share_worker: OWNERS_WORD,
    });
    for (const name of Object.keys(c.packages)) expect(c.packages[name]).toEqual({ remove: false, why: "only alice removes it, or a maintainer" });
    expect(c.workers[F.communityWorker]).toEqual({ revoke: false, own_only: false, share_worker: false, why: { revoke: c.why.revoke, own_only: c.why.own_only, share_worker: OWNERS_WORD } });
    refusedLike(await call("POST", `/factory/packages/${F.factoryPkg}/build`, "bob", { arches: [F.arch] }), 404, c.why.build, "bob builds mine");
    refusedLike(await call("DELETE", `/factory/packages/${F.factoryPkg}`, "bob"), 403, c.packages[F.factoryPkg].why, "bob removes mine");
    refusedLike(await call("DELETE", `/factory/packages/${F.factoryPkg}/builds/${F.stagedTask}`, "bob"), 403, c.why.dequeue, "bob takes alice's build out");
    refusedLike(await call("DELETE", `/factory/workers/${F.communityWorker}`, "bob"), 404, c.why.revoke, "bob revokes w3");
    refusedLike(await call("POST", `/factory/workers/${F.communityWorker}/mode`, "bob", { mode: "dedicated" }), 403, c.why.own_only, "bob sets w3 to its owner's");
    refusedLike(await call("POST", `/factory/workers/${F.communityWorker}/mode`, "bob", { mode: "shared" }), 403, c.why.share_worker, "bob shares w3");
    refusedLike(await call("POST", `/factory/tasks/${F.projectTask}/withdraw`, "bob", { note: "bob's word" }), 403, c.why.withdraw, "bob withdraws");
    // The token, the request and a worker are the caller's own: the door mints bob's token, on bob's page — which is why alice's page offers them to nobody else.
    expect((await call("POST", "/factory/token", "bob")).json.login).toBe("bob");
    expect((await canOn("bob", "bob")).token).toBe(true);
  });

  it("alice on her own page: the workspace is hers — build, the queue, a worker, the token; Remove per registration and Revoke per worker as they stand; never Withdraw", async () => {
    const c = await canOn("alice", "alice");
    expect(flags(c)).toEqual({ ...allFalse, request: true, register: true, token: true, build: true, dequeue: true, remove: true, revoke: true, own_only: true, share_worker: true });
    expect(c.why).toEqual({ withdraw: "a maintainer decides" });
    expect(c.workers[F.communityWorker]).toEqual({ revoke: true, own_only: true, share_worker: true, why: {} });
    // Her two registrations are the maintainers' now: mine approved (its publish waits), ours published into edge.
    expect(c.packages[F.factoryPkg]).toEqual({ remove: false, why: `${F.factoryPkg} is approved: a maintainer removes it` });
    expect(c.packages[F.publishedPkg]).toEqual({ remove: false, why: `${F.publishedPkg} is published: a maintainer removes it` });
    refusedLike(await call("DELETE", `/factory/packages/${F.factoryPkg}`, "alice"), 403, c.packages[F.factoryPkg].why, "alice removes mine");
    refusedLike(await call("POST", `/factory/tasks/${F.projectTask}/withdraw`, "alice", { note: "her own" }), 403, c.why.withdraw, "alice withdraws");
    // Each true, at the door: a build queued, then taken out of the queue; a token; a worker registered, shared, then revoked.
    const built = await call("POST", `/factory/packages/${F.factoryPkg}/build`, "alice", { arches: [F.arch] });
    expect(built.status, JSON.stringify(built.json)).toBe(201);
    const queued = built.json.tasks[0] as number;
    refusedLike(await call("DELETE", `/factory/packages/${F.factoryPkg}/builds/${queued}`, "bob"), 403, "only alice takes their build out of the queue — yours is on /user/bob", "bob takes the new build out");
    expect((await call("DELETE", `/factory/packages/${F.factoryPkg}/builds/${queued}`, "alice")).json).toMatchObject({ task: queued, status: "cancelled" });
    expect((await call("POST", "/factory/token", "alice")).status).toBe(201);
    const w = await call("POST", "/factory/workers", "alice", { name: "box", arch: F.arch });
    expect(w.status, JSON.stringify(w.json)).toBe(201);
    expect((await call("POST", `/factory/workers/${w.json.worker}/mode`, "alice", { mode: "shared" })).status).toBe(200);
    expect((await call("POST", `/factory/workers/${w.json.worker}/mode`, "alice", { mode: "dedicated" })).status).toBe(200);
    expect((await call("DELETE", `/factory/workers/${w.json.worker}`, "alice")).json).toMatchObject({ revoked: w.json.worker });
    refusedLike(await call("DELETE", `/factory/workers/${w.json.worker}`, "alice"), 404, `${w.json.worker} is revoked already`, "revoked twice");
    // Revoked, the worker's row still answers — grey with the state's word for its owner and for a maintainer, before whose it is — and its mode door says the same.
    const gone = `${w.json.worker} is revoked already`;
    for (const as of ["alice", "m1", "bob"] as Who[]) expect((await canOn("alice", as)).workers[w.json.worker], as).toEqual({ revoke: false, own_only: false, share_worker: false, why: { revoke: gone, own_only: gone, share_worker: gone } });
    refusedLike(await call("POST", `/factory/workers/${w.json.worker}/mode`, "alice", { mode: "shared" }), 404, gone, "a revoked worker shared");
    refusedLike(await call("POST", `/factory/workers/${w.json.worker}/mode`, "m1", { mode: "dedicated" }), 404, gone, "a revoked worker set to its owner's");
    expect((await call("DELETE", "/factory/workers/no-such-worker", "alice")).status).toBe(404);
  });

  it("m1, a maintainer, on alice's page: not her workspace — but Revoke, own-only, Withdraw and Remove (an approved one too) are theirs; sharing her worker is not", async () => {
    const c = await canOn("alice", "m1");
    expect(flags(c)).toEqual({ ...allFalse, remove: true, revoke: true, withdraw: true, own_only: true });
    expect(c.why).toEqual({
      request: "only alice requests here — yours is on /user/m1",
      register: "only alice registers a worker here — yours is on /user/m1",
      token: "only alice mints their token — yours is on /user/m1",
      build: "only alice builds here — yours is on /user/m1",
      dequeue: "only alice takes their build out of the queue — yours is on /user/m1",
      share_worker: OWNERS_WORD,
    });
    for (const name of Object.keys(c.packages)) expect(c.packages[name]).toEqual({ remove: true });
    expect(c.workers[F.communityWorker]).toEqual({ revoke: true, own_only: true, share_worker: false, why: { share_worker: OWNERS_WORD } });
    // The project's worker, on m1's own page: its mode is nobody's to set — the door's 409 — and the row's verdict says so for m1 as for anyone.
    const noMode = "a project worker takes the project's work; it has no shared or own mode";
    expect((await canOn("m1", "m1")).workers[F.worker]).toEqual({ revoke: true, own_only: false, share_worker: false, why: { own_only: noMode, share_worker: noMode } });
    refusedLike(await call("POST", `/factory/workers/${F.worker}/mode`, "m1", { mode: "dedicated" }), 409, noMode, "m1 sets the project's worker's mode");
    refusedLike(await call("POST", `/factory/packages/${F.factoryPkg}/build`, "m1", { arches: [F.arch] }), 404, c.why.build, "m1 builds mine");
    refusedLike(await call("DELETE", `/factory/packages/${F.factoryPkg}/builds/${F.stagedTask}`, "m1"), 403, c.why.dequeue, "m1 takes alice's build out");
    refusedLike(await call("POST", `/factory/workers/${F.communityWorker}/mode`, "m1", { mode: "shared" }), 403, c.why.share_worker, "m1 shares w3");
    expect((await call("POST", `/factory/workers/${F.communityWorker}/mode`, "m1", { mode: "dedicated" })).status).toBe(200);
    expect((await call("POST", `/factory/tasks/${F.projectTask}/withdraw`, "m1", { note: "taken back by the test" })).status).toBe(200);
    expect((await call("DELETE", `/factory/workers/${F.communityWorker}`, "m1")).json).toMatchObject({ revoked: F.communityWorker });
    // The maintainer's removal takes the approved one and the published one alike; then alice's page has nothing to remove.
    for (const name of [F.factoryPkg, F.publishedPkg]) {
      const r = await call("DELETE", `/factory/packages/${name}`, "m1");
      expect(r.status, `m1 removes ${name}: ${JSON.stringify(r.json)}`).toBe(200);
    }
    expect((await canOn("alice", "m1")).packages).toEqual({});
  });

  it("carol, blocked, on her own page: the page is hers, but a request, a build and a worker are refused with the block — and her registration is hers to remove", async () => {
    const c = await canOn("carol", "carol");
    const blocked = "carol is blocked by a maintainer: requests under a name that is not hers; nothing can be requested or built until another maintainer lifts it";
    expect(flags(c)).toEqual({ ...allFalse, token: true, dequeue: true, remove: true, revoke: true, own_only: true, share_worker: true });
    expect(c.why).toEqual({ request: blocked, register: blocked, build: blocked, withdraw: "a maintainer decides" });
    expect(c.packages[F.blockedPkg]).toEqual({ remove: true });
    refusedLike(await call("POST", "/factory/workers", "carol", { arch: F.arch }), 403, blocked, "carol registers a worker");
    // Her package is blocked too: the package's word comes first at the door, as the page greys the button — with no trailing colon when the block has no reason.
    refusedLike(await call("POST", `/factory/packages/${F.blockedPkg}/build`, "carol", { arches: [F.arch] }), 403, `${F.blockedPkg} is blocked by a maintainer: ${(await call("GET", `/factory/packages/${F.blockedPkg}/story`, "")).json.package.blocked_reason}`, "carol builds hers");
    refusedLike(await call("POST", "/factory/packages", "carol", { url: "https://other.example" }), 403, blocked, "carol requests");
    expect((await call("DELETE", `/factory/packages/${F.blockedPkg}`, "carol")).status).toBe(200);
  });
});
