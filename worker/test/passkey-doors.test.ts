/**
 * The last doors without a passkey (#284). #271 put the maintainer's passkey
 * on every decision; three doors still shipped bytes, or left a login's
 * other keys behind, without it:
 *
 * - A build queued by hand (`POST /factory/enqueue`, a maintainer's session
 *   or `omc_` token) published into edge with no approval. By hand it is a
 *   dry run now: `publish` true or left out is refused (`dry_run_only`),
 *   `publish: false` is queued. The factory's enqueue job (its token carries
 *   `factory:write`) still publishes a recipe on main, and an approval —
 *   with the maintainer's passkey — still queues its publish job.
 * - A promotion forced past its evidence (`POST /factory/jobs`, promote with
 *   `force: "yes"`) takes the maintainer's passkey, in the browser, for
 *   exactly that promotion (`promote:force:<from>:<to>[:<arch>]`): a token of
 *   any kind is refused, each wrong answer refused with its code and nothing
 *   queued, and the answer and the journal's line name the passkey. A
 *   promotion by evidence and every other job keep their doors.
 * - A passkey reset also revokes the login's `omc_` token and its agents'
 *   live grants, a journal line each, in the reset's own batch — their
 *   waiting drafts discarded, a code nobody swapped deleted — and the person
 *   makes a new token after signing in again.
 *
 * Every new statement is asked for its plan. The reset's passkeys, record
 * and refusals are passkeys.test.ts's; approve and block, passkey-decisions'.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import * as openpgp from "openpgp";
import worker from "../src/index";
import { contributorOf, sha256Hex } from "../src/routes/contributors";
import { handleQueueJob } from "../src/jobs";
import { issueJobToken, scopesFor } from "../src/jobtoken";
import { DISCARD_SQL, UNSWAPPED_SQL } from "../src/routes/agents";
import { RESET_GRANT_EVENTS_SQL, RESET_GRANTS_SQL, RESET_TOKEN_SQL, SUBJECT, forcedSubject } from "../src/routes/passkeys";
import { assert as answer, createAuthenticator, register, UP } from "./soft-authenticator.mjs";

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
/** A call with a token — a contributor's, a worker's, a job's — as a script makes it. */
const call = (method: string, path: string, body: unknown, token: string, base = ORIGIN) => raw(method, `${base}/api/v1${path}`, { "content-type": "application/json", authorization: `Bearer ${token}` }, body);
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
/** The login's passkey's answer for one act — or another passkey's, or one made wrong, where a test says how. */
async function assertion(login: string, subject: string, o: { with?: Authenticator; answer?: Record<string, unknown> } = {}): Promise<Record<string, string>> {
  const c = await fromPage(login, "/auth/passkeys/assert", { for: subject });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return answer(o.with ?? keys[login].a, { challenge: c.json.publicKey.challenge, origin: ORIGIN, rpId: "localhost", ...(o.answer ?? {}) });
}

const count = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;
const lines = (kind: string, action?: string) =>
  env.DB.prepare(`SELECT status, summary, payload FROM events WHERE kind = ?${action ? " AND json_extract(payload, '$.action') = ?" : ""} ORDER BY id`).bind(...(action ? [kind, action] : [kind])).all<{ status: string; summary: string; payload: string }>().then((r) => r.results.map((l) => ({ ...l, payload: JSON.parse(l.payload) })));

beforeAll(async () => {
  // The reset's record is signed by the pool: a key of its own, made here.
  env.SIGNING_KEY = (await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "Pool Test", email: "test@omarchy.invalid" }], format: "armored" })).privateKey;
  const h = (t: string) => sha256Hex(t);
  const people: [string, string][] = [["m1", "maintainer"], ["m2", "maintainer"], ["m3", "maintainer"], ["m5", "maintainer"], ["m7", "maintainer"], ["m8", "maintainer"], ["alice", "contributor"]];
  await env.DB.batch([
    env.DB.prepare("INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2'), ('m3'), ('m5'), ('m7'), ('m8')"),
    ...(await Promise.all(people.map(async ([l, role]) => env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role) VALUES (?, ?, ?, ?)").bind(l, await h(`omc_${l}`), await h(`oms_${l}`), role)))),
    env.DB.prepare(`INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, agent, agent_status, kinds) VALUES
      ('cx', 'x86_64', 'alice', ?, 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z', 'openai/gpt-5', 'ok', '["build"]'),
      ('px', 'x86_64', 'm2', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z', ?, 'ok', '["build"]')`).bind(await h("omw_cx"), await h("omw_px"), AGENT),
  ]);
  for (const m of ["m1", "m2", "m5", "m7", "m8"]) await registerFor(m);
});

describe("a build queued by hand (#284)", () => {
  const body = (name: string, extra: Record<string, unknown> = {}) => ({ name, pkgbuild_ref: "abc123", reason: "sizing", arches: ["aarch64"], version: "1.0-1", ...extra });
  const queued = (name: string) => count("SELECT COUNT(*) AS n FROM build_tasks WHERE name = ? AND kind = 'build'", name);

  it("is a dry run: publish true or left out is refused with dry_run_only, from a session and from a token, and nothing is queued", async () => {
    const cases: [string, () => Promise<Answer>][] = [
      ["a token, publish left out", () => call("POST", "/factory/enqueue", body("byhand"), "omc_m1")],
      ["a token, publish true", () => call("POST", "/factory/enqueue", body("byhand", { publish: true }), "omc_m1")],
      ["a token, publish as a word", () => call("POST", "/factory/enqueue", body("byhand", { publish: "false" }), "omc_m1")],
      ["the session, publish left out", () => fromPage("m1", "/api/v1/factory/enqueue", body("byhand"))],
      ["the session, publish true", () => fromPage("m2", "/api/v1/factory/enqueue", body("byhand", { publish: true }))],
    ];
    for (const [what, send] of cases) {
      const r = await send();
      expect([r.status, r.json?.code], `${what}: ${JSON.stringify(r.json)}`).toEqual([403, "dry_run_only"]);
      expect(r.json.error, what).toMatch(/publishes nothing\. What publishes comes from the enqueue job .* or from an approval, confirmed with a passkey; nothing was queued$/);
    }
    expect(await queued("byhand")).toBe(0);
    expect((await lines("enqueue")).filter((l) => l.payload.name === "byhand")).toEqual([]);
    // The door's own refusals come first: nobody, a contributor, a body without what it needs.
    expect((await raw("POST", `${ORIGIN}/api/v1/factory/enqueue`, { "content-type": "application/json" }, body("byhand"))).status).toBe(401);
    expect((await call("POST", "/factory/enqueue", body("byhand", { publish: false }), "omc_alice")).status).toBe(403);
    expect((await call("POST", "/factory/enqueue", {}, "omc_m1")).status).toBe(400);
  });

  it("queues publish:false, from a token and from the session: built and reported, never published, and the line says who", async () => {
    const t = await call("POST", "/factory/enqueue", body("sized", { publish: false }), "omc_m1");
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    const s = await fromPage("m2", "/api/v1/factory/enqueue", body("sized2", { publish: false }));
    expect(s.status, JSON.stringify(s.json)).toBe(201);
    for (const [name, r] of [["sized", t], ["sized2", s]] as const) {
      expect(await env.DB.prepare("SELECT publish, trust FROM build_tasks WHERE id = ?").bind(r.json.tasks[0]).first()).toEqual({ publish: 0, trust: "project" });
      expect(await queued(name)).toBe(1);
    }
    const [lt, ls] = [(await lines("enqueue")).find((l) => l.payload.name === "sized")!, (await lines("enqueue")).find((l) => l.payload.name === "sized2")!];
    expect(lt.summary).toBe("sized 1.0-1: 1 build task(s) queued for aarch64 by m1 (sizing); dry run, nothing will be published");
    expect(lt.payload).toMatchObject({ by: "m1", via: "token", tasks: t.json.tasks });
    expect(ls.payload).toMatchObject({ by: "m2", via: "web" });
  });

  it("the enqueue job still publishes: its token queues a recipe on main as a build that publishes; a job without factory:write is refused", async () => {
    const e = Math.floor(Date.now() / 1000) + 3600;
    const job = await issueJobToken(env, { t: 900, k: "enqueue", s: scopesFor("enqueue", 900, "project", {}), e, w: "w-pool" });
    const r = await call("POST", "/factory/enqueue", { ...body("frommain"), reason: "pkgbuild-changed" }, job);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(await env.DB.prepare("SELECT publish, trust FROM build_tasks WHERE id = ?").bind(r.json.tasks[0]).first()).toEqual({ publish: 1, trust: "project" });
    const said = (await lines("enqueue")).find((l) => l.payload.name === "frommain")!;
    expect(said.summary).toBe("frommain 1.0-1: 1 build task(s) queued for aarch64 (pkgbuild-changed)");
    expect(said.payload.by).toBeUndefined();
    // publish true says the same; publish false is the job's dry run.
    expect((await env.DB.prepare("SELECT publish FROM build_tasks WHERE id = ?").bind((await call("POST", "/factory/enqueue", { ...body("frommain2"), publish: true }, job)).json.tasks[0]).first())).toEqual({ publish: 1 });
    expect((await env.DB.prepare("SELECT publish FROM build_tasks WHERE id = ?").bind((await call("POST", "/factory/enqueue", { ...body("frommain3"), publish: false }, job)).json.tasks[0]).first())).toEqual({ publish: 0 });
    const sync = await issueJobToken(env, { t: 901, k: "sync", s: scopesFor("sync", 901, "project", { ring: "edge" }), e, w: "w-pool" });
    expect((await call("POST", "/factory/enqueue", body("notmine"), sync)).status).toBe(403);
    expect(await queued("notmine")).toBe(0);
  });

  it("an approval still publishes: the project's build approved with the maintainer's passkey queues its publish job", async () => {
    // alice's request, built by her worker; claimed by m1 and rebuilt by the project; approved by m2 in the browser.
    const claimAs = async (token: string) => {
      const c = await call("POST", "/factory/claim", { arch: "x86_64", agent: token === "omw_px" ? AGENT : "openai/gpt-5", agent_status: "ok", kinds: ["build"] }, token);
      expect(c.status, JSON.stringify(c.json)).toBe(200);
      return c.json as { task: { id: number; name: string }; token: string };
    };
    const stage = async (c: { task: { id: number; name: string }; token: string }, who: string) => {
      const file = `${c.task.name}-1.0-1-x86_64.pkg.tar.zst`;
      for (const f of ["PKGBUILD", "build.log", "PKGINFO", file]) expect((await raw("PUT", `${ORIGIN}/api/v1/factory/tasks/${c.task.id}/artifacts/${f}`, { authorization: `Bearer ${c.token}` }, `${who}'s ${f}`)).status).toBe(201);
      expect((await call("POST", `/factory/tasks/${c.task.id}/complete`, { sha256: (who === "the project" ? "d" : "c").repeat(64), filename: file, version: "1.0-1" }, c.token)).json).toMatchObject({ status: "staged" });
    };
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'not this story' WHERE status IN ('queued', 'leased')").run();
    expect((await call("POST", "/factory/packages", { name: "shipme", url: "https://shipme.example", source: "https://shipme.example/shipme-1.0.tar.gz", version: "1.0", description: "shipme, a tool for the doors' tests", license: "MIT", arches: ["x86_64"], checklist }, "omc_alice")).status).toBe(201);
    const contributor = await claimAs("omw_cx");
    await stage(contributor, "alice");
    expect((await call("POST", `/factory/tasks/${contributor.task.id}/build`, { worker: "px", note: "pin the tag" }, "omc_m1")).status).toBe(200);
    const project = await claimAs("omw_px");
    await stage(project, "the project");
    const r = await fromPage("m2", `/api/v1/factory/tasks/${project.task.id}/approve`, { note: "reads well", assertion: await assertion("m2", `approve:${project.task.id}`) });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ decision: "approved", passkey: keys.m2.id });
    const pub = await env.DB.prepare("SELECT kind, status, trust, params FROM build_tasks WHERE kind = 'publish' AND json_extract(params, '$.task') = ?").bind(project.task.id).first<{ kind: string; status: string; trust: string; params: string }>();
    expect(pub).toMatchObject({ kind: "publish", status: "queued", trust: "project" });
    // Its job token writes edge: what an approval ships.
    expect(scopesFor("publish", 1, "project", JSON.parse(pub!.params))).toEqual(expect.arrayContaining(["pool:write", "release:edge"]));
  });
});

describe("a forced promotion (#284)", () => {
  const promote = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ kind: "promote", params: { from: "rc", to: "stable", force: "yes", note: "stable lags a security fix", ...params }, ...extra });
  const forced = () => count("SELECT COUNT(*) AS n FROM build_tasks WHERE kind = 'promote' AND json_extract(params, '$.force') = 'yes'");
  const post = (login: string, body: unknown, o: Parameters<typeof fromPage>[3] = {}) => fromPage(login, "/api/v1/factory/jobs", body, o);

  it("binds its challenge to the promotion: its rings and its architecture, from meta's lists — a maintainer's act", async () => {
    for (const ok of ["promote:force:rc:stable", "promote:force:edge:rc", "promote:force:rc:stable:aarch64", forcedSubject("edge", "rc", "x86_64")]) expect(SUBJECT.test(ok), ok).toBe(true);
    for (const no of ["promote:force:rc:lab", "promote:force:rc:stable:riscv64", "promote:rc:stable", "promote:force:rc", "promote:force:rc:stable:"]) expect(SUBJECT.test(no), no).toBe(false);
    const o = await fromPage("m1", "/auth/passkeys/assert", { for: "promote:force:rc:stable" });
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    expect(await env.DB.prepare("SELECT login, purpose, draft_id FROM passkey_challenges WHERE challenge = ?").bind(o.json.publicKey.challenge).first()).toEqual({ login: "m1", purpose: "confirm", draft_id: "promote:force:rc:stable" });
    expect((await fromPage("alice", "/auth/passkeys/assert", { for: "promote:force:rc:stable" })).json.code).toBe("maintainer_only");
    expect((await fromPage("m1", "/auth/passkeys/assert", { for: "promote:force:rc:lab" })).json.code).toBe("for");
  });

  it("is queued with a maintainer's passkey for exactly this promotion: the answer and the journal's line name it, the task carries force", async () => {
    const was = await forced();
    const r = await post("m1", promote({}, { assertion: await assertion("m1", "promote:force:rc:stable") }));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json).toMatchObject({ passkey: keys.m1.id, job: { kind: "promote", params: { from: "rc", to: "stable", force: "yes", note: "stable lags a security fix" } } });
    expect(await forced()).toBe(was + 1);
    const line = (await lines("dispatch")).find((l) => l.payload.task === r.json.task)!;
    expect(line.status).toBe("warn");
    expect(line.summary).toBe(`promote rc → stable forced past its evidence, queued by m1 as task ${r.json.task} with their passkey (${keys.m1.id})`);
    expect(line.payload).toMatchObject({ by: "m1", via: "web", passkey: keys.m1.id });
    // One architecture: its own act, and an answer for both is not one for it.
    const one = promote({ arch: "aarch64" });
    expect((await post("m1", { ...one, assertion: await assertion("m1", "promote:force:rc:stable") })).json.code).toBe("challenge");
    const r2 = await post("m1", { ...one, assertion: await assertion("m1", "promote:force:rc:stable:aarch64") });
    expect(r2.status, JSON.stringify(r2.json)).toBe(201);
    expect(r2.json.job.params).toMatchObject({ arch: "aarch64", force: "yes" });
    expect((await lines("dispatch")).find((l) => l.payload.task === r2.json.task)!.summary).toBe(`promote rc → stable (aarch64) forced past its evidence, queued by m1 as task ${r2.json.task} with their passkey (${keys.m1.id})`);
  });

  it("queues nothing without a valid answer: a token, a token beside the session, none, another page, no Origin, another address, an answer for another promotion or act or login, another login's key, the user not verified — each with its code", async () => {
    const was = await forced(), dispatched = (await lines("dispatch")).length;
    const subject = "promote:force:rc:stable";
    const cases: [string, () => Promise<Answer>, string][] = [
      ["a maintainer's token", async () => call("POST", "/factory/jobs", promote({}, { assertion: await assertion("m1", subject) }), "omc_m1"), "session_only"],
      ["a token beside the session", async () => post("m1", promote({}, { assertion: await assertion("m1", subject) }), { bearer: "omc_m1" }), "session_only"],
      ["no answer", () => post("m1", promote({})), "passkey_required"],
      ["an answer that is not one", () => post("m1", promote({}, { assertion: "yes" })), "passkey_required"],
      ["another page", async () => post("m1", promote({}, { assertion: await assertion("m1", subject) }), { origin: "https://evil.example" }), "origin"],
      ["no Origin", async () => post("m1", promote({}, { assertion: await assertion("m1", subject) }), { origin: null }), "origin"],
      ["an address the list does not hold", async () => post("m1", promote({}, { assertion: await assertion("m1", subject) }), { base: "http://pool.test" }), "rp_unavailable"],
      ["an answer for another promotion", async () => post("m1", promote({}, { assertion: await assertion("m1", "promote:force:edge:rc") })), "challenge"],
      ["an answer for approve", async () => post("m1", promote({}, { assertion: await assertion("m1", "approve:1") })), "challenge"],
      ["an answer made for m2", async () => post("m1", promote({}, { assertion: await assertion("m2", subject) })), "challenge"],
      ["another login's key", async () => post("m1", promote({}, { assertion: await assertion("m1", subject, { with: keys.m2.a }) })), "not_yours"],
      ["the user not verified", async () => post("m1", promote({}, { assertion: await assertion("m1", subject, { answer: { flags: UP } }) })), "user_verified"],
    ];
    for (const [what, send, code] of cases) {
      const r = await send();
      expect([r.status, r.json?.code], `${what}: ${JSON.stringify(r.json)}`).toEqual([403, code]);
      expect(r.json.error, what).toMatch(/nothing was queued$/);
    }
    // A maintainer with no passkey is told where to register one.
    const m3 = await post("m3", promote({}));
    expect([m3.status, m3.json.code, m3.json.register]).toEqual([403, "no_passkey", "/user/m3#passkeys"]);
    expect(m3.json.error).toMatch(/^forcing rc into stable is confirmed with your passkey, and m3 has none yet/);
    // The door's own refusals first: nobody, a contributor, a promotion that is not one.
    expect((await raw("POST", `${ORIGIN}/api/v1/factory/jobs`, { "content-type": "application/json", origin: ORIGIN }, promote({}))).status).toBe(401);
    expect((await post("alice", promote({}))).status).toBe(403);
    expect((await post("m1", promote({ to: "rc" }))).status).toBe(400);
    expect((await post("m1", promote({ to: "lab" }))).status).toBe(400);
    expect(await forced()).toBe(was);
    expect((await lines("dispatch")).length).toBe(dispatched);
  });

  it("leaves a promotion by evidence and every other job as they were: the session, or the maintainer's token, and no passkey", async () => {
    const byToken = await call("POST", "/factory/jobs", { kind: "promote", params: { from: "rc", to: "stable" } }, "omc_m1");
    expect(byToken.status, JSON.stringify(byToken.json)).toBe(201);
    expect(byToken.json.job.params.force).toBeUndefined();
    expect(byToken.json.passkey).toBeUndefined();
    // force other than "yes" is no force, as before.
    expect((await call("POST", "/factory/jobs", { kind: "promote", params: { from: "edge", to: "rc", force: "no" } }, "omc_m1")).json.job.params.force).toBeUndefined();
    expect((await post("m2", { kind: "rollback", params: { ring: "stable", to: "1" } })).status).toBe(201);
    expect((await call("POST", "/factory/jobs", { kind: "health", params: { ring: "stable", arch: "x86_64" } }, "omc_m2")).status).toBe(201);
    const line = (await lines("dispatch")).find((l) => l.payload.task === byToken.json.task)!;
    expect([line.status, line.summary]).toEqual(["ok", `promote queued by m1 as task ${byToken.json.task}`]);
  });

  it("a door that forgets the passkey queues nothing", async () => {
    const was = await forced();
    const m1 = (await contributorOf(new Request(ORIGIN, { headers: { cookie: "omc=oms_m1" } }), env))!;
    const r = await handleQueueJob(m1, new Request(`${ORIGIN}/api/v1/factory/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(promote({})) }), env);
    expect([r.status, ((await r.json()) as { code: string }).code]).toEqual([403, "passkey_required"]);
    expect(await forced()).toBe(was);
  });
});

describe("a passkey reset (#284)", () => {
  const REASON = "lost the phone and the key on a train";
  /** A grant of the login's, as the swap leaves it: `oma_<name>` its token. */
  const grant = async (login: string, id: string, o: { token?: string | null; expires?: string; revoked?: string; code?: string } = {}) =>
    env.DB.prepare("INSERT INTO agent_grants (id, login, agent, scopes, token_hash, code_hash, challenge, code_expires_at, expires_at, revoked_at, revoked_by) VALUES (?, ?, ?, '[\"contribute\",\"review\",\"block\"]', ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, login, `Agent ${id}`, o.token === null ? null : await sha256Hex(o.token ?? `oma_${id}`), o.code ? await sha256Hex(o.code) : null, o.code ? "c".repeat(43) : null, o.code ? "2999-01-01T00:00:00.000Z" : null, o.expires ?? "2999-01-01T00:00:00.000Z", o.revoked ?? null, o.revoked ? "m7" : null)
      .run();
  const me = (token: string) => raw("GET", `${ORIGIN}/api/v1/factory/me`, { authorization: `Bearer ${token}` });
  const reset = async (by: string, login: string) => fromPage(by, "/auth/passkeys/reset", { login, reason: REASON, assertion: await assertion(by, `passkey:reset:${login}`) });

  it("revokes the login's omc_ token and every live agent grant, a journal line each, in the reset's batch — waiting drafts discarded, a code nobody swapped gone — and the record says so", async () => {
    await grant("m7", "g_live1");
    await grant("m7", "g_live2");
    await grant("m7", "g_expired", { expires: "2000-01-01T00:00:00.000Z" });
    await grant("m7", "g_gone", { revoked: "2026-01-01T00:00:00.000Z" });
    await grant("m7", "g_code", { token: null, code: "a".repeat(64) });
    await grant("m8", "g_other");
    await env.DB.prepare("INSERT INTO drafts (id, grant_id, login, agent, verdict, note, name, facts, expires_at) VALUES (?, 'g_live1', 'm7', 'Agent g_live1', 'block', 'a bad one', 'hers', 'x', ?)").bind(`d_${"7".repeat(32)}`, new Date(Date.now() + 30 * 60_000).toISOString()).run();
    // Before: the token and the grants work.
    expect((await me("omc_m7")).status).toBe(200);
    expect((await me("oma_g_live1")).status).toBe(200);
    const r = await reset("m5", "m7");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ reset: "m7", by: "m5", signed_out: true, token_revoked: true });
    expect([...r.json.grants_revoked].sort((a: any, b: any) => a.id.localeCompare(b.id))).toEqual([{ id: "g_live1", agent: "Agent g_live1" }, { id: "g_live2", agent: "Agent g_live2" }]);
    // Gone: the command line's token, the live grants' tokens, the code nobody swapped; the waiting draft discarded with why.
    expect((await me("omc_m7")).status).toBe(401);
    for (const t of ["oma_g_live1", "oma_g_live2"]) expect([(await me(t)).status, (await me(t)).json.code], t).toEqual([401, "grant_invalid"]);
    const rows = (await env.DB.prepare("SELECT id, revoked_at IS NOT NULL AS revoked, revoked_by FROM agent_grants WHERE login IN ('m7', 'm8') ORDER BY id").all()).results;
    expect(rows).toEqual([
      { id: "g_expired", revoked: 0, revoked_by: null },
      { id: "g_gone", revoked: 1, revoked_by: "m7" },
      { id: "g_live1", revoked: 1, revoked_by: "reset" },
      { id: "g_live2", revoked: 1, revoked_by: "reset" },
      { id: "g_other", revoked: 0, revoked_by: null },
    ]);
    expect(await env.DB.prepare("SELECT state, outcome FROM drafts WHERE id = ?").bind(`d_${"7".repeat(32)}`).first()).toEqual({ state: "discarded", outcome: JSON.stringify({ error: "m7's passkeys were reset by m5: the agent's grant ended, and nothing was decided" }) });
    // Another login's grant and token stand.
    expect((await me("oma_g_other")).status).toBe(200);
    expect((await me("omc_m8")).status).toBe(200);
    // A line each, after the reset's own, naming the record; never a token.
    const said = (await lines("passkey")).filter((l) => l.payload.login === "m7" && l.payload.by === "m5");
    expect(said.map((l) => l.payload.action)).toEqual(["reset", "revoke_token", "revoke_grant", "revoke_grant"]);
    expect(said.slice(1).map((l) => l.status)).toEqual(["warn", "warn", "warn"]);
    expect(said[1].summary).toBe("m5 reset m7's passkeys: m7's command-line token revoked");
    expect(said[1].payload).toEqual({ login: "m7", by: "m5", via: "web", action: "revoke_token", record: r.json.record });
    expect(said.slice(2).map((l) => l.summary).sort()).toEqual(["m5 reset m7's passkeys: the grant to Agent g_live1 (g_live1) revoked", "m5 reset m7's passkeys: the grant to Agent g_live2 (g_live2) revoked"]);
    expect(said.slice(2).map((l) => l.payload).sort((a, b) => a.grant.localeCompare(b.grant))).toEqual([
      { login: "m7", by: "m5", via: "web", action: "revoke_grant", grant: "g_live1", agent: "Agent g_live1", record: r.json.record },
      { login: "m7", by: "m5", via: "web", action: "revoke_grant", grant: "g_live2", agent: "Agent g_live2", record: r.json.record },
    ]);
    const doc = JSON.parse(await (await env.PACKAGES.get(r.json.record.slice(env.POOL_URL.length + 1)))!.text());
    expect(doc).toMatchObject({ schema: "omarchy-pool/passkey-reset/1", login: "m7", by: "m5", token_revoked: true });
    expect(doc.grants_revoked.map((g: any) => g.id).sort()).toEqual(["g_live1", "g_live2"]);
  });

  it("the person makes a new token after signing in again, and it works; the revoked one stays revoked", async () => {
    expect((await raw("POST", `${ORIGIN}/api/v1/factory/token`, { cookie: "omc=oms_m7" })).status).toBe(401);
    // m7 signs in with GitHub again (the tests write the new session's hash, as the callback does).
    await env.DB.prepare("UPDATE contributors SET session_hash = ? WHERE login = 'm7'").bind(await sha256Hex("oms_m7")).run();
    const t = await raw("POST", `${ORIGIN}/api/v1/factory/token`, { cookie: "omc=oms_m7" });
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    expect(t.json.token).toMatch(/^omc_/);
    const back = await me(t.json.token);
    expect([back.status, back.json.contributor.login]).toEqual([200, "m7"]);
    expect((await me("omc_m7")).status).toBe(401);
  });

  it("sent twice at once revokes once: one token line, one line a grant", async () => {
    await grant("m8", "g_twice");
    const [a, b] = await Promise.all([reset("m5", "m8"), reset("m2", "m8")]);
    expect([a.status, b.status].sort(), JSON.stringify([a.json, b.json])).toEqual([200, 409]);
    const said = (await lines("passkey")).filter((l) => l.payload.login === "m8");
    expect(said.filter((l) => l.payload.action === "revoke_token")).toHaveLength(1);
    expect(said.filter((l) => l.payload.action === "revoke_grant").map((l) => l.payload.grant).sort()).toEqual(["g_other", "g_twice"]);
    expect((await me("omc_m8")).status).toBe(401);
  });

  it("every new statement is a search through an index, never a scan", async () => {
    const plan = async (sql: string) => {
      const numbered = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
      const n = numbered.length ? Math.max(...numbered) : (sql.match(/\?/g) ?? []).length;
      return (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...Array.from({ length: n }, () => "x")).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    };
    const expected: [string, string, RegExp[]][] = [
      ["the token revoked", RESET_TOKEN_SQL, [/SEARCH contributors USING INDEX sqlite_autoindex_contributors_1 \(login=\?\)/, /SEARCH passkeys (EXISTS )?USING COVERING INDEX idx_passkeys_login \(login=\?\)/]],
      ["a line a live grant", RESET_GRANT_EVENTS_SQL, [/SEARCH agent_grants USING INDEX idx_agent_grants_live \(login=\? AND expires_at>\?\)/, /SEARCH passkeys (EXISTS )?USING COVERING INDEX idx_passkeys_login \(login=\?\)/]],
      ["the live grants revoked", RESET_GRANTS_SQL, [/SEARCH agent_grants USING INDEX idx_agent_grants_live \(login=\? AND expires_at>\?\)/, /SEARCH passkeys (EXISTS )?USING COVERING INDEX idx_passkeys_login \(login=\?\)/]],
      ["a code nobody swapped", UNSWAPPED_SQL, [/SEARCH agent_grants USING (COVERING )?INDEX idx_agent_grants_unswapped \(login=\?\)/]],
      ["the waiting drafts discarded", DISCARD_SQL, [/SEARCH drafts USING INDEX idx_drafts_login \(login=\? AND created_at>\?\)/]],
    ];
    for (const [what, sql, want] of expected) {
      const p = await plan(sql);
      for (const re of want) expect(p, `${what}: ${p}`).toMatch(re);
      expect(p, `${what}: ${p}`).not.toMatch(/\bSCAN (contributors|agent_grants|passkeys|drafts)\b/);
    }
  });
});
