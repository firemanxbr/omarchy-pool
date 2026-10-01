/**
 * The web's own Approve and Block (#271, routes/passkeys.ts webGate): what
 * Review, a build's page and a package's page post is decided with the
 * maintainer's passkey — an assertion with the user verified, for a
 * challenge issued to this login for exactly this act (POST
 * /auth/passkeys/assert), checked by the Worker — in the browser, with its
 * session: a token of any kind is refused, a maintainer's `omc_` included,
 * so no door approves or blocks without one. Each way an answer can be
 * wrong is refused with its code and decides nothing; the act's own refusal
 * comes first, in the words the pages read from `can`; request changes and
 * reject are as they were. A handler called without the passkey's half
 * decides nothing (decidedWith fails closed). The pages' half — the shell's
 * passkeyed, run as a page runs it — asks for this act's challenge, hands it
 * to the browser and posts the answer with the act, and posts nothing when
 * no passkey answers. The registration, the step-up and the reset are
 * passkeys.test.ts's; an agent's draft, agent-tools.test.ts's.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import * as openpgp from "openpgp";
import worker from "../src/index";
import { contributorOf, sha256Hex } from "../src/routes/contributors";
import { handleApprove } from "../src/routes/review";
import { handleBlockContributor, handleBlockPackage } from "../src/routes/blocks";
import { HELPERS } from "../src/pages/layout";
import { legacyWorker, runScript } from "./fixture";
import { assert as answer, b64url, createAuthenticator, register, unb64url, UP } from "./soft-authenticator.mjs";

/** The dashboard as the tests reach it: localhost, where a passkey works (relyingParty), as wrangler dev's. */
const ORIGIN = "http://localhost:8787";
const AGENT = "claude-code/claude-sonnet-5";
const checklist = { official: true, license: true, unshipped: true, evidence: true };

type Authenticator = Awaited<ReturnType<typeof createAuthenticator>>;
type Answer = { status: number; json: any };

async function raw(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<Answer> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}
/** A worker's or a contributor's call with its token, as the other tests make them. */
const call = (method: string, path: string, body: unknown, token: string) => raw(method, `${ORIGIN}/api/v1${path}`, { "content-type": "application/json", authorization: `Bearer ${token}` }, body);
/** A POST from the pool's page: the session's cookie, the page's Origin, JSON — each can be taken away or changed. */
const fromPage = (login: string | null, path: string, body: unknown, o: { origin?: string | null; bearer?: string; base?: string } = {}) => {
  const base = o.base ?? ORIGIN;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (login) headers.cookie = `omc=oms_${login}`;
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  const origin = o.origin === undefined ? base : o.origin;
  if (origin) headers.origin = origin;
  return raw("POST", base + path, headers, body);
};

/** Each maintainer's passkey, registered on their page — their first, with the session alone. */
const keys: Record<string, { a: Authenticator; id: string }> = {};
async function registerFor(login: string): Promise<void> {
  const a = await createAuthenticator();
  const o = await fromPage(login, "/auth/passkeys/challenge", {});
  const reg = await fromPage(login, "/auth/passkeys", { label: "laptop", ...(await register(a, { challenge: o.json.publicKey.challenge, origin: ORIGIN, rpId: "localhost" })) });
  expect(reg.status, JSON.stringify(reg.json)).toBe(201);
  keys[login] = { a, id: reg.json.passkey.id };
}
/** The challenge the page's script asks for one act. */
async function challengeFor(login: string, subject: string): Promise<string> {
  const o = await fromPage(login, "/auth/passkeys/assert", { for: subject });
  expect(o.status, JSON.stringify(o.json)).toBe(200);
  return o.json.publicKey.challenge;
}
/** The login's passkey's answer for one act — or another passkey's, or one made wrong, where a test says how. */
async function assertion(login: string, subject: string, o: { with?: Authenticator; answer?: Record<string, unknown> } = {}): Promise<Record<string, string>> {
  return answer(o.with ?? keys[login].a, { challenge: await challengeFor(login, subject), origin: ORIGIN, rpId: "localhost", ...(o.answer ?? {}) });
}

/** A staged build claimed by the project and rebuilt: the project's build, ready for Approve. */
const claimAs = async (token: string, name: string) => {
  await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'not this story' WHERE status IN ('queued', 'leased') AND name != ?").bind(name).run();
  const c = await call("POST", "/factory/claim", { arch: "x86_64", agent: token === "omw_px" ? AGENT : "openai/gpt-5", agent_status: "ok", kinds: ["build"] }, token);
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return c.json as { task: { id: number; name: string }; token: string };
};
const stage = async (c: { task: { id: number; name: string }; token: string }, who: string) => {
  const file = `${c.task.name}-1.0-1-x86_64.pkg.tar.zst`;
  for (const f of ["PKGBUILD", "build.log", "PKGINFO", file]) expect((await raw("PUT", `${ORIGIN}/api/v1/factory/tasks/${c.task.id}/artifacts/${f}`, { authorization: `Bearer ${c.token}` }, `${who}'s ${f}`)).status).toBe(201);
  const done = await call("POST", `/factory/tasks/${c.task.id}/complete`, { sha256: (who === "the project" ? "d" : "c").repeat(64), filename: file, version: "1.0-1" }, c.token);
  expect(done.json).toMatchObject({ status: "staged" });
};
/** alice's request, built by her worker: the contributor's build, staged. */
const ready = async (name: string) => {
  expect((await call("POST", "/factory/packages", { name, url: `https://${name}.example`, source: `https://${name}.example/${name}-1.0.tar.gz`, version: "1.0", description: `${name}, a tool for the passkey's tests`, license: "MIT", arches: ["x86_64"], checklist }, "omc_alice")).status).toBe(201);
  const c = await claimAs("omw_cx", name);
  await stage(c, "alice");
  return c.task.id;
};
/** …claimed by m1, rebuilt by the project: the build a maintainer approves. */
const reviewed = async (name: string) => {
  const contributor = await ready(name);
  expect((await call("POST", `/factory/tasks/${contributor}/build`, { worker: "px", note: "pin the tag" }, "omc_m1")).status).toBe(200);
  const rb = await claimAs("omw_px", name);
  await stage(rb, "the project");
  return { contributor, project: rb.task.id };
};
const approvals = async (name: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE name = ?").bind(name).first<{ n: number }>())!.n;
const line = async (kind: string, key: string, value: string) => {
  const e = await env.DB.prepare(`SELECT summary, payload FROM events WHERE kind = ? AND json_extract(payload, '$.${key}') = ? ORDER BY id DESC LIMIT 1`).bind(kind, value).first<{ summary: string; payload: string }>();
  return e ? { summary: e.summary, payload: JSON.parse(e.payload) } : null;
};
const recordOf = async (url: string) => JSON.parse(await (await env.PACKAGES.get(url.slice(env.POOL_URL.length + 1)))!.text());

beforeAll(async () => {
  env.SIGNING_KEY = (await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "Pool Test", email: "test@omarchy.invalid" }], format: "armored" })).privateKey;
  const h = (t: string) => sha256Hex(t);
  const people: [string, string][] = [["m1", "maintainer"], ["m2", "maintainer"], ["m3", "maintainer"], ["alice", "contributor"], ["bob", "contributor"], ["carl", "contributor"]];
  await env.DB.batch([
    env.DB.prepare("INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2'), ('m3')"),
    ...(await Promise.all(people.map(async ([l, role]) => env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role) VALUES (?, ?, ?, ?)").bind(l, await h(`omc_${l}`), await h(`oms_${l}`), role)))),
    env.DB.prepare(`INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, agent, agent_status, kinds) VALUES
      ('cx', 'x86_64', 'alice', ?, 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z', 'openai/gpt-5', 'ok', '["build"]'),
      ('px', 'x86_64', 'm2', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z', ?, 'ok', '["build"]')`).bind(await h("omw_cx"), await h("omw_px"), AGENT),
  ]);
  await registerFor("m1");
  await registerFor("m2");
});

describe("approve on the web (#271)", () => {
  it("is decided with the maintainer's passkey: the answer, the record and the line name it, and its counter and last use move", async () => {
    const { project } = await reviewed("withkey");
    const was = (await env.DB.prepare("SELECT counter FROM passkeys WHERE id = ?").bind(keys.m2.id).first<{ counter: number }>())!.counter;
    const r = await fromPage("m2", `/api/v1/factory/tasks/${project}/approve`, { note: "reads well", assertion: await assertion("m2", `approve:${project}`) });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ decision: "approved", by: "m2", via: "web", passkey: keys.m2.id, agent: AGENT });
    expect(r.json.through).toBeUndefined();
    expect(await recordOf(r.json.record)).toMatchObject({ decision: "approve", by: "m2", via: "web", passkey: keys.m2.id });
    expect((await line("approve", "name", "withkey"))!.payload).toMatchObject({ by: "m2", via: "web", passkey: keys.m2.id, record: r.json.record });
    const now = await env.DB.prepare("SELECT counter, last_used FROM passkeys WHERE id = ?").bind(keys.m2.id).first<{ counter: number; last_used: string | null }>();
    expect(now!.counter).toBeGreaterThan(was);
    expect(now!.last_used).not.toBeNull();
  });

  it("decides nothing without a valid answer: none, a token, another page, another address, an answer for another build or a block, another login's key, the user not verified, an expired or a spent challenge, a counter gone backwards — each with its code", async () => {
    const { project } = await reviewed("nokey");
    const approve = (body: Record<string, unknown>, o: Parameters<typeof fromPage>[3] = {}) => fromPage("m2", `/api/v1/factory/tasks/${project}/approve`, { note: "reads well", ...body }, o);
    const subject = `approve:${project}`;
    const stored = () => env.DB.prepare("SELECT counter FROM passkeys WHERE id = ?").bind(keys.m2.id).first<{ counter: number }>().then((x) => x!.counter);
    const cases: [string, () => Promise<Answer>, string][] = [
      ["no answer", () => approve({}), "passkey_required"],
      ["an answer that is not one", () => approve({ assertion: "yes" }), "passkey_required"],
      ["a maintainer's token", async () => call("POST", `/factory/tasks/${project}/approve`, { note: "reads well", assertion: await assertion("m2", subject) }, "omc_m2"), "session_only"],
      ["a token beside the session", async () => approve({ assertion: await assertion("m2", subject) }, { bearer: "omc_m2" }), "session_only"],
      ["another page", async () => approve({ assertion: await assertion("m2", subject) }, { origin: "https://evil.example" }), "origin"],
      ["no Origin", async () => approve({ assertion: await assertion("m2", subject) }, { origin: null }), "origin"],
      ["an address the list does not hold", async () => approve({ assertion: await assertion("m2", subject) }, { base: "http://pool.test" }), "rp_unavailable"],
      ["an answer for another build", async () => approve({ assertion: await assertion("m2", `approve:${project + 1000}`) }), "challenge"],
      ["an answer for a block", async () => approve({ assertion: await assertion("m2", "block:package:nokey") }), "challenge"],
      ["an answer made for m1", async () => approve({ assertion: await assertion("m1", subject) }), "challenge"],
      ["another login's key", async () => approve({ assertion: await assertion("m2", subject, { with: keys.m1.a }) }), "not_yours"],
      ["the user not verified", async () => approve({ assertion: await assertion("m2", subject, { answer: { flags: UP } }) }), "user_verified"],
      ["another origin in the answer", async () => approve({ assertion: await assertion("m2", subject, { answer: { origin: "https://evil.example" } }) }), "origin"],
      ["another relying party", async () => approve({ assertion: await assertion("m2", subject, { answer: { signRpId: "evil.example" } }) }), "rp_id"],
      ["a signature of another key", async () => approve({ assertion: await assertion("m2", subject, { answer: { signer: keys.m1.a } }) }), "signature"],
      ["an expired challenge", async () => {
        const c = await challengeFor("m2", subject);
        await env.DB.prepare("UPDATE passkey_challenges SET expires_at = '2000-01-01T00:00:00.000Z' WHERE challenge = ?").bind(c).run();
        return approve({ assertion: await answer(keys.m2.a, { challenge: c, origin: ORIGIN, rpId: "localhost" }) });
      }, "challenge"],
      ["a spent challenge: its answer taken by a request refused for its signature", async () => {
        const good = await assertion("m2", subject);
        const cut = await approve({ assertion: { ...good, signature: good.signature.slice(0, 20) } });
        expect(cut.json.code).toBe("signature");
        return approve({ assertion: good });
      }, "challenge"],
      ["a counter gone backwards", async () => {
        const back = (await stored()) - 1;
        const r = await approve({ assertion: await assertion("m2", subject, { answer: { counter: back } }) });
        keys.m2.a.counter = back + 1;
        return r;
      }, "counter"],
    ];
    for (const [what, send, code] of cases) {
      const r = await send();
      expect([r.status, r.json?.code], `${what}: ${JSON.stringify(r.json)}`).toEqual([403, code]);
      expect(r.json.error, what).toMatch(/nothing was decided$/);
      expect(await approvals("nokey"), what).toBe(0);
    }
    // A maintainer with no passkey is told where to register one.
    const m3 = await fromPage("m3", `/api/v1/factory/tasks/${project}/approve`, { note: "reads well" });
    expect([m3.status, m3.json.code, m3.json.register]).toEqual([403, "no_passkey", "/user/m3#passkeys"]);
    // The build still waits, and the passkey decides it.
    const ok = await approve({ assertion: await assertion("m2", subject) });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(await approvals("nokey")).toBe(1);
  });

  it("says the act's own refusal first, as can says it, whatever the answer: nobody, a contributor, the requester, a contributor's build, a build decided already", async () => {
    const { contributor, project } = await reviewed("first");
    const can = async (login: string) => (await raw("GET", `${ORIGIN}/api/v1/factory/tasks/${project}/can`, { cookie: `omc=oms_${login}` })).json.can;
    expect((await fromPage(null, `/api/v1/factory/tasks/${project}/approve`, {})).status).toBe(401);
    const alice = await fromPage("alice", `/api/v1/factory/tasks/${project}/approve`, {});
    expect([alice.status, alice.json.code, alice.json.error]).toEqual([403, "maintainer_only", (await can("alice")).why.approve]);
    const evidence = await fromPage("m2", `/api/v1/factory/tasks/${contributor}/approve`, { assertion: await assertion("m2", `approve:${contributor}`) });
    expect([evidence.status, evidence.json.error]).toEqual([409, "a contributor's build is evidence, never what users get — have the project build it first, then approve the project's build"]);
    // The requester is a maintainer here: their own package waits for another.
    await env.DB.prepare("UPDATE factory_packages SET owner = 'm1' WHERE name = 'first'").run();
    const own = await fromPage("m1", `/api/v1/factory/tasks/${project}/approve`, {});
    expect([own.status, own.json.code]).toEqual([403, "conflict_of_interest"]);
    await env.DB.prepare("UPDATE factory_packages SET owner = 'alice' WHERE name = 'first'").run();
    expect((await fromPage("m2", `/api/v1/factory/tasks/${project}/approve`, { assertion: await assertion("m2", `approve:${project}`) })).status).toBe(200);
    const again = await fromPage("m2", `/api/v1/factory/tasks/${project}/approve`, {});
    expect([again.status, again.json.error]).toEqual([409, "already approved"]);
  });

  it("leaves request changes and reject as they were: the session, or the maintainer's token, and no passkey", async () => {
    const a = await reviewed("changesok");
    const changes = await fromPage("m3", `/api/v1/factory/tasks/${a.project}/changes`, { note: "pin the source to the signed tag" });
    expect(changes.status, JSON.stringify(changes.json)).toBe(200);
    expect(changes.json).toMatchObject({ decision: "changes_requested", by: "m3", via: "web" });
    const b = await reviewed("rejectok");
    const reject = await call("POST", `/factory/tasks/${b.project}/reject`, { note: "not the project's own source" }, "omc_m3");
    expect(reject.status, JSON.stringify(reject.json)).toBe(200);
    expect(reject.json).toMatchObject({ decision: "rejected", by: "m3", via: "token" });
  });
});

describe("block on the web (#271)", () => {
  it("of a package: refused without the passkey — a token, no answer, an answer for another package — nothing pulled; with it, blocked and named on the record", async () => {
    await ready("blockme");
    const block = (body: Record<string, unknown>, o: Parameters<typeof fromPage>[3] = {}) => fromPage("m1", "/api/v1/factory/packages/blockme/block", { reason: "ships a token stealer", ...body }, o);
    const blocked = async () => (await env.DB.prepare("SELECT blocked_at FROM factory_packages WHERE name = 'blockme'").first<{ blocked_at: string | null }>())!.blocked_at;
    const cases: [string, () => Promise<Answer>, string][] = [
      ["a maintainer's token", () => call("POST", "/factory/packages/blockme/block", { reason: "ships a token stealer" }, "omc_m1"), "session_only"],
      ["no answer", () => block({}), "passkey_required"],
      ["an answer for another package", async () => block({ assertion: await assertion("m1", "block:package:other") }), "challenge"],
      ["an answer for blocking a contributor of that name", async () => block({ assertion: await assertion("m1", "block:contributor:blockme") }), "challenge"],
    ];
    for (const [what, send, code] of cases) {
      const r = await send();
      expect([r.status, r.json?.code], `${what}: ${JSON.stringify(r.json)}`).toEqual([403, code]);
      expect(await blocked(), what).toBeNull();
    }
    // The act's own refusal first: no reason.
    expect((await block({ reason: "no" })).status).toBe(400);
    const r = await block({ assertion: await assertion("m1", "block:package:blockme") });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ blocked: "blockme", by: "m1", passkey: keys.m1.id });
    expect(await blocked()).not.toBeNull();
    expect(await recordOf(r.json.record)).toMatchObject({ decision: "block", by: "m1", via: "web", passkey: keys.m1.id });
    expect((await line("block", "name", "blockme"))!.payload).toMatchObject({ by: "m1", via: "web", passkey: keys.m1.id });
  });

  it("of a contributor: refused without the passkey — nothing revoked, nothing cancelled; with it, blocked and named on the record", async () => {
    // A worker carl registered before #331 closed the door to contributors: the block revokes it.
    const w = { json: { worker: await legacyWorker(env, "carl", "box", "x86_64") } };
    const block = (body: Record<string, unknown>) => fromPage("m2", "/api/v1/factory/contributors/carl/block", { reason: "requests under a name that is not his", ...body });
    const intact = async (what: string) => {
      expect(await env.DB.prepare("SELECT blocked_at FROM contributors WHERE login = 'carl'").first(), what).toEqual({ blocked_at: null });
      expect(await env.DB.prepare("SELECT revoked_at FROM build_workers WHERE id = ?").bind(w.json.worker).first(), what).toEqual({ revoked_at: null });
    };
    const cases: [string, () => Promise<Answer>, string][] = [
      ["a maintainer's token", () => call("POST", "/factory/contributors/carl/block", { reason: "requests under a name that is not his" }, "omc_m2"), "session_only"],
      ["no answer", () => block({}), "passkey_required"],
      ["an answer for blocking a package of that name", async () => block({ assertion: await assertion("m2", "block:package:carl") }), "challenge"],
      ["another login's key", async () => block({ assertion: await assertion("m2", "block:contributor:carl", { with: keys.m1.a }) }), "not_yours"],
    ];
    for (const [what, send, code] of cases) {
      const r = await send();
      expect([r.status, r.json?.code], `${what}: ${JSON.stringify(r.json)}`).toEqual([403, code]);
      await intact(what);
    }
    // The act's own refusal first: a maintainer is a governance pull request, not a block.
    expect((await fromPage("m2", "/api/v1/factory/contributors/m1/block", { reason: "no reason at all" })).status).toBe(409);
    const r = await block({ assertion: await assertion("m2", "block:contributor:carl") });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ blocked: "carl", by: "m2", passkey: keys.m2.id, workers_revoked: [w.json.worker] });
    expect(await recordOf(r.json.record)).toMatchObject({ kind: "contributor", by: "m2", via: "web", passkey: keys.m2.id });
    expect((await line("block", "login", "carl"))!.payload).toMatchObject({ by: "m2", via: "web", passkey: keys.m2.id });
  });
});

describe("a door that forgets the passkey", () => {
  it("decides nothing: approve and both blocks called without their gate are refused, and write nothing", async () => {
    const { project } = await reviewed("nogate");
    await ready("nogatepkg");
    const m2 = (await contributorOf(new Request(ORIGIN, { headers: { cookie: "omc=oms_m2" } }), env))!;
    const req = (body: unknown) => new Request(`${ORIGIN}/api/v1/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const refusals = [
      await handleApprove(m2, project, req({ note: "reads well" }), env),
      await handleBlockPackage(m2, "nogatepkg", req({ reason: "ships a token stealer" }), env),
      await handleBlockContributor(m2, "bob", req({ reason: "spam requests" }), env),
    ];
    for (const r of refusals) expect([r.status, ((await r.json()) as { code: string }).code]).toEqual([403, "passkey_required"]);
    expect(await approvals("nogate")).toBe(0);
    expect(await env.DB.prepare("SELECT blocked_at FROM factory_packages WHERE name = 'nogatepkg'").first()).toEqual({ blocked_at: null });
    expect(await env.DB.prepare("SELECT blocked_at FROM contributors WHERE login = 'bob'").first()).toEqual({ blocked_at: null });
  });
});

describe("the pages' half (#271)", () => {
  /**
   * The shell's passkeyed, as a page runs it (HELPERS, through runScript): a
   * browser whose navigator.credentials.get is the software authenticator,
   * and a fetch that is the Worker at the pool's address with the person's
   * session and the page's Origin — what Approve in the Decision cell and
   * Review, and each page's Block, go through.
   */
  function shellAs(login: string, o: { webauthn?: boolean; get?: (options: any) => Promise<unknown> } = {}) {
    const src = HELPERS.split("__POOL_URL__").join("http://pool.test").split("__RINGS_TEXT__").join("{}").split("__WICON__").join("{}").split("__LATE_AFTER_HOURS__").join("9").split("__PROMISED_RINGS__").join("[]").split("__ARCHES__").join("[]").split("__SEVERITIES__").join("[]").split("__WORKER_ALIVE_MINUTES__").join("10");
    const asked: any[] = [], posted: string[] = [];
    (globalThis as any).__pkNavigator = {
      credentials: {
        get: async (opts: any) => {
          asked.push(opts.publicKey);
          if (o.get) return o.get(opts);
          const k = opts.publicKey;
          const x = await answer(keys[login].a, { challenge: b64url(k.challenge), origin: ORIGIN, rpId: k.rpId });
          const buf = (v: string) => unb64url(v).buffer;
          return { rawId: buf(x.credential), response: { clientDataJSON: buf(x.client_data), authenticatorData: buf(x.authenticator_data), signature: buf(x.signature), userHandle: null } };
        },
      },
    };
    const browser = (o.webauthn ?? true) ? "window.PublicKeyCredential = function () {}; window.isSecureContext = true;" : "";
    const fetchAs = async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") posted.push(path);
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(ORIGIN + path, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie: `omc=oms_${login}`, origin: ORIGIN } }), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const ran = runScript(`${browser} var navigator = globalThis.__pkNavigator;\n${src}`, { pathname: "/review", functions: ["passkeyed", "api", "refusalHtml"], fetch: fetchAs }) as any;
    return { passkeyed: ran.passkeyed as (what: string, post: (a: unknown) => Promise<any>) => Promise<any>, api: ran.api as (m: string, p: string, b: unknown) => Promise<any>, refusalHtml: ran.refusalHtml as (d: unknown) => string, asked, posted };
  }

  it("asks the pool for this act's challenge, hands it to the browser with user verification required, and posts the act with the answer", async () => {
    const { project } = await reviewed("fromshell");
    const s = shellAs("m2");
    const d = await s.passkeyed(`approve:${project}`, (assertion) => s.api("POST", `/api/v1/factory/tasks/${project}/approve`, { note: "reads well", assertion }));
    expect(d.__status, JSON.stringify(d)).toBe(200);
    expect(d).toMatchObject({ decision: "approved", by: "m2", via: "web", passkey: keys.m2.id });
    expect(s.posted).toEqual(["/auth/passkeys/assert", `/api/v1/factory/tasks/${project}/approve`]);
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]).toMatchObject({ rpId: "localhost", userVerification: "required", timeout: 120000 });
    expect(s.asked[0].allowCredentials.map((c: any) => b64url(c.id))).toEqual([b64url(keys.m2.a.credentialId)]);
  });

  it("posts nothing when the browser cannot ask, the prompt is cancelled, or the pool will not give a challenge — and says why, as an answer the page draws", async () => {
    const { project } = await reviewed("notfromshell");
    const approve = (s: ReturnType<typeof shellAs>) => s.passkeyed(`approve:${project}`, (assertion) => s.api("POST", `/api/v1/factory/tasks/${project}/approve`, { note: "reads well", assertion }));
    const old = shellAs("m2", { webauthn: false });
    expect(await approve(old)).toEqual({ error: "This browser cannot use a passkey on this page: it needs a secure address (https, or localhost) and passkey support. Nothing changed.", code: "no_answer" });
    expect(old.posted).toEqual([]);
    const cancelled = shellAs("m2", { get: async () => { throw Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" }); } });
    expect(await approve(cancelled)).toEqual({ error: "No passkey answered: the request was cancelled or timed out. Nothing changed.", code: "no_answer" });
    expect(cancelled.posted).toEqual(["/auth/passkeys/assert"]);
    const none = shellAs("m3");
    const said = await approve(none);
    expect(said).toMatchObject({ code: "no_passkey", register: "/user/m3#passkeys", __status: 403 });
    expect(none.posted).toEqual(["/auth/passkeys/assert"]);
    expect(await approvals("notfromshell")).toBe(0);
  });

  it("draws a refusal with the way to add a passkey as a link, where the pages say it — never an address to copy, never a link the pool did not name", async () => {
    const { project } = await reviewed("linkfromshell");
    const s = shellAs("m3");
    // A maintainer with no passkey presses Approve: the words, with the address they carried turned into the link.
    const said = await s.passkeyed(`approve:${project}`, (assertion) => s.api("POST", `/api/v1/factory/tasks/${project}/approve`, { note: "reads well", assertion }));
    expect(s.refusalHtml(said)).toBe(`approving build #${project} is confirmed with your passkey, and m3 has none yet: add one on your page, then press again — nothing was decided. <a href="/user/m3#passkeys">Register a passkey</a>`);
    // The act's own door says the same when no challenge was asked for (a page that posts without one): the same link.
    const posted = await s.api("POST", `/api/v1/factory/tasks/${project}/approve`, { note: "reads well" });
    expect(posted).toMatchObject({ code: "no_passkey", register: "/user/m3#passkeys" });
    expect(s.refusalHtml(posted)).toContain('<a href="/user/m3#passkeys">Register a passkey</a>');
    // Any other refusal is its words, escaped, and nothing more; a register that is not a person's own section is no link.
    expect(s.refusalHtml({ error: "a <b>bold</b> refusal", code: "challenge" })).toBe("a &lt;b&gt;bold&lt;/b&gt; refusal");
    for (const register of ["javascript:alert(1)", "https://evil.example/user/m3#passkeys", "/user/m3#agents", '/user/m3"onmouseover="x#passkeys']) {
      expect(s.refusalHtml({ error: "no passkey", code: "no_passkey", register }), register).toBe("no passkey");
    }
    expect(await approvals("linkfromshell")).toBe(0);
  });
});
