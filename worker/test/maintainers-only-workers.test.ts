/**
 * Only maintainers provide workers (#331, epic #307, design v2 §6.5 and
 * §21.4): POST /factory/workers registers a worker for a maintainer — the
 * synced factory/MAINTAINERS.toml, as governance.ts applies it — and refuses
 * everyone else with 403 and the page's sentence, "your packages build on
 * the pool's hosts". A login the last sync removed from the list is refused
 * from then on. Nothing else changes in P0: registrations made before keep
 * claiming, and their owner or a maintainer still revokes them.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyGovernance } from "../src/governance";
import { POOL_HOSTS } from "../src/routes/contributors";
import { legacyWorker, seedDashboard, type Fixture } from "./fixture";

let F: Fixture;

beforeAll(async () => {
  F = await seedDashboard(env);
});

async function call(method: string, path: string, auth: { session?: string; token?: string }, body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth.session) headers.cookie = `omc=oms_${auth.session}`;
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}
const register = (as: string, name = "box") => call("POST", "/factory/workers", { session: as }, { name, arch: F.arch });
const registered = async (id: string) => env.DB.prepare("SELECT owner, trust, mode, revoked_at FROM build_workers WHERE id = ?").bind(id).first<{ owner: string; trust: string; mode: string; revoked_at: string | null }>();

describe("POST /factory/workers is for maintainers only (#331)", () => {
  it("a maintainer registers a worker, as before: 201, the token once, the row under their name", async () => {
    const r = await register(F.m1, "studio");
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.worker).toMatch(new RegExp(`^${F.m1}-studio-`));
    expect(r.json.token).toMatch(/^omw_/);
    expect(await registered(r.json.worker)).toMatchObject({ owner: F.m1, trust: "community", mode: "dedicated", revoked_at: null });
    // Its token claims at once: nothing queued for it, and the claim is the one it always was.
    expect((await call("POST", "/factory/claim", { token: r.json.token }, { arch: F.arch })).status).toBe(204);
  });

  it("a contributor is refused with 403 and the sentence, from the page and with a CLI token alike, and nothing is written", async () => {
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM build_workers").first<{ n: number }>())!.n;
    for (const as of [F.owner, F.contributor]) {
      const r = await register(as);
      expect(r.status, `${as}: ${JSON.stringify(r.json)}`).toBe(403);
      expect(r.json.error, as).toBe(POOL_HOSTS);
    }
    const cli = await call("POST", "/factory/workers", { token: `omc_${F.owner}` }, { name: "laptop", arch: F.arch });
    expect([cli.status, cli.json.error]).toEqual([403, POOL_HOSTS]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM build_workers").first<{ n: number }>())!.n).toBe(before);
    expect(POOL_HOSTS).toBe("your packages build on the pool's hosts");
  });

  it("nobody signed in is asked to sign in first (401), as every door does", async () => {
    expect((await call("POST", "/factory/workers", {}, { arch: F.arch })).status).toBe(401);
  });

  it("a registration made before keeps working: its owner's contributor worker claims, and its owner revokes it", async () => {
    const id = await legacyWorker(env, F.owner, "old", F.arch);
    expect((await call("POST", "/factory/claim", { token: `omw_${id}` }, { arch: F.arch })).status).toBe(204);
    expect((await call("DELETE", `/factory/workers/${id}`, { session: F.owner })).json).toMatchObject({ revoked: id });
  });

  it("a login removed from MAINTAINERS.toml at the last sync is refused from then on; the maintainers still listed are not — and the worker it registered before still claims", async () => {
    const before = await register(F.m2, "rack");
    expect(before.status, JSON.stringify(before.json)).toBe(201);
    await applyGovernance(env, [F.m1], "sha-without-m2");
    const after = await register(F.m2, "rack2");
    expect([after.status, after.json.error]).toEqual([403, POOL_HOSTS]);
    expect((await register(F.m1, "again")).status).toBe(201);
    // Claims are unchanged in P0 (§21.4): a removed maintainer's host stops with the host agent's enrollment (P1), not here.
    expect((await call("POST", "/factory/claim", { token: before.json.token }, { arch: F.arch })).status).toBe(204);
  });
});

describe("the site and the docs no longer invite a contributor to run a worker (#331)", () => {
  // The sentences the review found left over, each on a page it was on: none may come back.
  const GONE = [
    "runs workers on their own machines",
    "Build it at home first",
    "run the same image at home",
    "on their own worker",
    "one of the contributor's own workers",
    "a contributor can verify the worker they run",
    "a contributor's and a maintainer's",
    "The agent's key is the contributor's, on their machine",
  ];
  it("Governance, How it works, Workers, a person's page and the served docs carry none of them", async () => {
    for (const path of ["/docs/governance", "/docs/how-it-works", "/workers", `/user/${F.owner}`, "/docs/what-we-test", "/docs/security-model", "/docs/factory", "/docs/workers", "/docs/worker-host"]) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`http://pool.test${path}`), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status, path).toBe(200);
      const text = await res.text();
      for (const s of GONE) expect(text, `${path}: ${s}`).not.toContain(s);
    }
  });
});
