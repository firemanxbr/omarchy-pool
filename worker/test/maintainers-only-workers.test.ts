/**
 * Only maintainers provide workers (#331, epic #307, design v2 §6.5 and
 * §21.4): POST /factory/workers refuses a contributor with 403 and the
 * page's sentence, "your packages build on the pool's hosts" — and since the
 * legacy registrations retired (#346) it answers a maintainer 410, with the
 * pointer to the maintainer-host docs: a machine joins as a host, and nothing
 * is written either way. A login the last sync removed from the list reads
 * the contributor's sentence. Registrations made before keep their rows as
 * history, and their owner or a maintainer still revokes them. Since #343 a
 * community registration claims only while its owner is a maintainer: one a
 * contributor made before, or one whose owner left the list, is refused at
 * the claim (403, with why and the pointer to the maintainer-host docs).
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyGovernance } from "../src/governance";
import { GONE, HOST_DOCS, POOL_HOSTS } from "../src/routes/contributors";
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

describe("POST /factory/workers: no legacy registration is made any more (#331, #346)", () => {
  it("a maintainer is answered 410, with why and the pointer to the maintainer-host docs, and nothing is written", async () => {
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM build_workers").first<{ n: number }>())!.n;
    for (const [as, auth] of [[F.m1, { session: F.m1 }], [F.m2, { token: `omc_${F.m2}` }]] as const) {
      const r = await call("POST", "/factory/workers", auth, { name: "studio", arch: F.arch });
      expect([r.status, r.json.code, r.json.docs], `${as}: ${JSON.stringify(r.json)}`).toEqual([410, "gone", HOST_DOCS]);
      expect(r.json.error, as).toBe(GONE.register);
      expect(r.json, as).not.toHaveProperty("token");
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM build_workers").first<{ n: number }>())!.n).toBe(before);
    expect(GONE.register).toContain("a maintainer's machine joins the pool as a host");
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

  it("a registration a contributor made before claims nothing since #343 — 403, with why and the pointer — and its owner still revokes it", async () => {
    const id = await legacyWorker(env, F.owner, "old", F.arch);
    const c = await call("POST", "/factory/claim", { token: `omw_${id}` }, { arch: F.arch });
    expect([c.status, c.json.code, c.json.docs]).toEqual([403, "owner_not_maintainer", HOST_DOCS]);
    expect(c.json.error).toBe(`${id}: its owner (${F.owner}) is no maintainer (factory/MAINTAINERS.toml) — contributors do not run workers (#343), ${POOL_HOSTS}: it claims nothing; revoke it on its page`);
    expect((await call("DELETE", `/factory/workers/${id}`, { session: F.owner })).json).toMatchObject({ revoked: id });
  });

  it("a login removed from MAINTAINERS.toml at the last sync reads the contributor's sentence from then on — and the worker it registered before claims nothing until the list names it again", async () => {
    const before = await legacyWorker(env, F.m2, "rack", F.arch);
    await applyGovernance(env, [F.m1], "sha-without-m2");
    const after = await register(F.m2, "rack2");
    expect([after.status, after.json.error]).toEqual([403, POOL_HOSTS]);
    expect((await register(F.m1, "again")).status).toBe(410);
    // Since #343 a community registration claims only while its owner is a maintainer, as a host's registration does (#322).
    expect((await call("POST", "/factory/claim", { token: `omw_${before}` }, { arch: F.arch })).json).toMatchObject({ code: "owner_not_maintainer" });
    await applyGovernance(env, [F.m1, F.m2], "sha-with-m2-again");
    expect((await call("POST", "/factory/claim", { token: `omw_${before}` }, { arch: F.arch })).status).toBe(204);
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
