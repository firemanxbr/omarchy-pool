/**
 * A maintainer approves a package with its architectures in one decision,
 * or one architecture alone with the reason on the public record, and
 * nothing is ever approved by itself (#416). Through the Worker's doors,
 * with real passkeys (soft-authenticator.mjs) and records the pool signs:
 *
 * - the package whole: every architecture its request names, each built
 *   again by the project — one press, one passkey answer, one review, a row
 *   and a publish job per architecture — refused, with the reason the button
 *   carries (`can.why.approve`), while one of them is still building or did
 *   not build;
 * - one architecture alone (`only`, routes/review.ts handleApprove): the
 *   same door, the same review and the same withdrawal, a reason required,
 *   the passkey's answer for exactly that act (approve:<task>:<arch>, never
 *   the package's), the reason and what it set aside on the review, the
 *   signed record, the journal, GET /factory/approvals and the package's
 *   story; the other architecture's builds in review stopped with it, and
 *   `not_shipping` in its targets while the approval stands — `waiting`
 *   again once it is withdrawn;
 * - the solo-maintainer exception (#394): its maintainer approves one
 *   architecture of their own package, marked self-reviewed;
 * - nothing on a timer approves: a bump the cron queues (updates.ts) is
 *   built by the hosts and again by the project, and tick after tick nothing
 *   is decided nor published until a maintainer approves it with a passkey;
 *   and the Worker's source writes a decision in one place, reached only by
 *   the web's door with its passkey gate and an agent's draft confirmed in
 *   the browser.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as openpgp from "openpgp";
import worker from "../src/index";
import { sha256Hex } from "../src/routes/contributors";
import { runScheduler } from "../src/scheduler";
import { checkUpdates } from "../src/updates";
import { sweepStaging } from "../src/staging";
import { SET_ASIDE_SQL } from "../src/routes/review";
import { DECISIONS_OF_SQL, settleTargets } from "../src/targets";
import { assert as answer, createAuthenticator, register } from "./soft-authenticator.mjs";

// The Worker's code, as text (Vite's ?raw): the tests run inside workerd, which has no filesystem.
const SOURCES = import.meta.glob("../src/{*,routes/*}.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** The dashboard as the tests reach it: localhost, where a passkey works (relyingParty), as wrangler dev's. */
const ORIGIN = "http://localhost:8787";
const AGENT = "openai/gpt-5";
const checklist = { official: true, license: true, unshipped: true, evidence: true };
type Answer = { status: number; json: any };

async function raw(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<Answer> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}
/** A worker's or a contributor's call with its token. */
const call = (method: string, path: string, body: unknown, token?: string) => raw(method, `${ORIGIN}/api/v1${path}`, { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body);
/** A POST from the pool's page: the session's cookie, the page's Origin, JSON. */
const fromPage = (login: string, path: string, body: unknown) => raw("POST", ORIGIN + path, { "content-type": "application/json", cookie: `omc=oms_${login}`, origin: ORIGIN }, body);

/** Each maintainer's passkey, registered on their page — their first, with the session alone. */
const keys: Record<string, { a: Awaited<ReturnType<typeof createAuthenticator>>; id: string }> = {};
async function registerFor(login: string): Promise<void> {
  const a = await createAuthenticator();
  const o = await fromPage(login, "/auth/passkeys/challenge", {});
  const reg = await fromPage(login, "/auth/passkeys", { label: "laptop", ...(await register(a, { challenge: o.json.publicKey.challenge, origin: ORIGIN, rpId: "localhost" })) });
  expect(reg.status, JSON.stringify(reg.json)).toBe(201);
  keys[login] = { a, id: reg.json.passkey.id };
}
/** The login's passkey's answer for one act, as the page's script asks for it. */
async function assertion(login: string, subject: string): Promise<Record<string, string>> {
  const o = await fromPage(login, "/auth/passkeys/assert", { for: subject });
  expect(o.status, JSON.stringify(o.json)).toBe(200);
  return answer(keys[login].a, { challenge: o.json.publicKey.challenge, origin: ORIGIN, rpId: "localhost" });
}
/** Approve, as Review and the package page post it: the package (`approve:<task>`), or one architecture alone with `only` (`approve:<task>:<arch>`). */
async function approve(login: string, task: number, body: Record<string, unknown> = {}): Promise<Answer> {
  const subject = `approve:${task}${typeof body.only === "string" ? `:${body.only}` : ""}`;
  return fromPage(login, `/api/v1/factory/tasks/${task}/approve`, { ...body, assertion: await assertion(login, subject) });
}

/** A request for both architectures (or those given), alice's unless a token says whose. */
const request = (name: string, token = "omc_alice", arches = ["x86_64", "aarch64"]) =>
  call("POST", "/factory/packages", { name, url: `https://${name}.example`, source: `https://${name}.example/${name}-1.0.tar.gz`, version: "1.0", description: `${name}, a tool approved as a package`, license: "MIT", arches, checklist }, token);
/** A worker's claim of the next build of its architecture: the contributors' (cx, ca) or the project's (px, pa). */
async function claim(worker: string, arch: string, name: string) {
  const c = await call("POST", "/factory/claim", { arch, agent: AGENT, agent_status: "ok", ...(worker.startsWith("omw_p") ? { kinds: ["build"] } : {}) }, worker);
  expect(c.status, `${worker} claims ${name}: ${JSON.stringify(c.json)}`).toBe(200);
  expect(c.json.task).toMatchObject({ name, arch });
  return c.json as { task: { id: number; name: string; arch: string; version: string }; token: string };
}
/** Its evidence and its package through the gate: staged. */
async function stage(c: { task: { id: number; name: string; arch: string; version: string }; token: string }, version = "1.0-1") {
  const file = `${c.task.name}-${version}-${c.task.arch}.pkg.tar.zst`;
  for (const f of ["PKGBUILD", "build.log", "PKGINFO", file]) expect((await raw("PUT", `${ORIGIN}/api/v1/factory/tasks/${c.task.id}/artifacts/${f}`, { authorization: `Bearer ${c.token}` }, `${f} of ${c.task.id}`)).status).toBe(201);
  await raw("PUT", `${ORIGIN}/api/v1/factory/tasks/${c.task.id}/artifacts/vet.json`, { authorization: `Bearer ${c.token}` }, JSON.stringify({ schema: "omarchy-pool/vet/1", verdict: "pass", checks: [{ name: "smoke", status: "pass", detail: "" }] }));
  const done = await call("POST", `/factory/tasks/${c.task.id}/complete`, { sha256: "c".repeat(64), filename: file, version }, c.token);
  expect(done.json, JSON.stringify(done.json)).toMatchObject({ status: "staged" });
  return c.task.id;
}
/** A build that does not build, after its tries. */
async function fail(c: { task: { id: number }; token: string }) {
  expect((await call("POST", `/factory/tasks/${c.task.id}/fail`, { error: "exit 4: no linker for this architecture", final: true }, c.token)).json).toMatchObject({ status: "failed" });
  return c.task.id;
}
const targetsOf = async (name: string) => JSON.parse((await env.DB.prepare("SELECT targets FROM factory_packages WHERE name = ?").bind(name).first<{ targets: string }>())!.targets);
const canOf = async (task: number, token = "omc_m2") => (await call("GET", `/factory/tasks/${task}/can`, undefined, token)).json.can;
const recordOf = async (url: string) => JSON.parse(await (await env.PACKAGES.get(url.slice(env.POOL_URL.length + 1)))!.text());
const counted = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;
/** Nothing of a story left in the queue for the next one. */
const quiet = () => env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'not this story' WHERE status IN ('queued', 'leased')").run();

beforeAll(async () => {
  env.SIGNING_KEY = (await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "Pool Test", email: "test@omarchy.invalid" }], format: "armored" })).privateKey;
  const h = (t: string) => sha256Hex(t);
  const people: [string, string][] = [["m1", "maintainer"], ["m2", "maintainer"], ["alice", "contributor"]];
  await env.DB.batch([
    env.DB.prepare("INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2')"),
    ...(await Promise.all(people.map(async ([l, role]) => env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role) VALUES (?, ?, ?, ?)").bind(l, await h(`omc_${l}`), await h(`oms_${l}`), role)))),
    // m1's legacy pair on each architecture (#343: a maintainer's registration takes any contributor's build), m2's project workers: m1 may claim and approve m2's… alice's packages alike.
    env.DB.prepare(`INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES
      ('cx', 'x86_64', 'm1', ?, 'shared', 'community', NULL, '2000-01-01T00:00:00Z'),
      ('ca', 'aarch64', 'm1', ?, 'shared', 'community', NULL, '2000-01-01T00:00:00Z'),
      ('px', 'x86_64', 'm2', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z'),
      ('pa', 'aarch64', 'm2', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z')`).bind(await h("omw_cx"), await h("omw_ca"), await h("omw_px"), await h("omw_pa")),
  ]);
  await registerFor("m1");
  await registerFor("m2");
});

afterEach(() => vi.restoreAllMocks());

describe("a package approved in one decision", () => {
  it("covers every architecture its request names: one press, one passkey answer, one review, a row and a publish job each — refused while one is still being built", async () => {
    expect((await request("both")).status).toBe(201);
    const cx = await stage(await claim("omw_cx", "x86_64", "both"));
    await stage(await claim("omw_ca", "aarch64", "both"));
    const asked = await call("POST", `/factory/tasks/${cx}/build`, {}, "omc_m1");
    expect(asked.json).toMatchObject({ arches: ["x86_64", "aarch64"] });
    const [rx, ra] = asked.json.tasks as number[];
    expect(await stage(await claim("omw_px", "x86_64", "both"))).toBe(rx);
    // aarch64 is still being built again: the package waits for it, and the button says so — x86_64 alone could ship, with a reason.
    const waits = `the project is still building aarch64 (task ${ra} is queued): one review covers every architecture — approve once it is staged`;
    expect(await canOf(rx)).toMatchObject({ approve: false, approve_only: true, why: { approve: waits } });
    const early = await approve("m2", rx);
    expect([early.status, early.json.error]).toEqual([409, waits]);
    expect(await stage(await claim("omw_pa", "aarch64", "both"))).toBe(ra);
    expect(await canOf(ra)).toMatchObject({ approve: true, approve_only: true });
    // One decision for the package, on either architecture's build: one POST with one passkey answer, one line in the journal.
    const ok = await approve("m2", ra, { note: "both architectures read well" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ decision: "approved", arches: ["x86_64", "aarch64"], not_supported: {}, not_shipping: {}, only_reason: null, set_aside: [], passkey: keys.m2.id });
    expect((await env.DB.prepare("SELECT json_extract(payload, '$.passkey') AS passkey, json_extract(payload, '$.arches') AS arches FROM events WHERE kind = 'approve' AND json_extract(payload, '$.name') = 'both'").all()).results).toEqual([{ passkey: keys.m2.id, arches: '["x86_64","aarch64"]' }]);
    expect(await env.DB.prepare("SELECT arches, only_reason, not_shipping FROM reviews WHERE id = ?").bind(ok.json.review).first()).toEqual({ arches: '["x86_64","aarch64"]', only_reason: null, not_shipping: "{}" });
    expect((await env.DB.prepare("SELECT arch, task_id FROM approvals WHERE review_id = ? ORDER BY arch DESC").bind(ok.json.review).all()).results).toEqual([{ arch: "x86_64", task_id: rx }, { arch: "aarch64", task_id: ra }]);
    expect((await env.DB.prepare("SELECT arch, json_extract(params, '$.task') AS task FROM build_tasks WHERE name = 'both' AND kind = 'publish' ORDER BY arch DESC").all()).results).toEqual([{ arch: "x86_64", task: rx }, { arch: "aarch64", task: ra }]);
    // The signed record says it is the package, whole.
    expect(await recordOf(ok.json.record)).toMatchObject({ decision: "approve", scope: "package", arches: ["x86_64", "aarch64"], not_shipping: {}, only_reason: null, by: "m2", passkey: keys.m2.id });
    // Either build answers for the package: already approved on both, whole or one alone.
    expect(await canOf(rx)).toMatchObject({ approve: false, approve_only: false, why: { approve: "already approved", approve_only: "already approved" } });
    expect(await targetsOf("both")).toEqual({ x86_64: { status: "approved", task: rx }, aarch64: { status: "approved", task: ra } });
  });
});

describe("one architecture approved alone", () => {
  let x86: number, arm: number, px: number;
  it("is what is left when another architecture the request names did not build: the package is refused, with the reason", async () => {
    await quiet();
    expect((await request("half")).status).toBe(201);
    x86 = await stage(await claim("omw_cx", "x86_64", "half"));
    arm = await fail(await claim("omw_ca", "aarch64", "half"));
    expect((await call("POST", `/factory/tasks/${x86}/build`, {}, "omc_m1")).json).toMatchObject({ arches: ["x86_64"] });
    px = await stage(await claim("omw_px", "x86_64", "half"));
    const why = `aarch64 did not build (task ${arm}): the package is approved once every architecture it names is built again by the project — or approve x86_64 only, with the reason aarch64 does not ship`;
    expect(await canOf(px)).toMatchObject({ approve: false, approve_only: true, why: { approve: why } });
    // Review's list carries the same `can` on the row, for the page's two buttons.
    const row = (await call("GET", "/factory/review", undefined, "omc_m2")).json.staged.find((t: any) => t.id === px);
    expect(row.can).toMatchObject({ approve: false, approve_only: true, why: { approve: why } });
    const refused = await approve("m2", px);
    expect([refused.status, refused.json.error]).toEqual([409, why]);
    expect(await counted("SELECT COUNT(*) AS n FROM reviews WHERE name = 'half'")).toBe(0);
  });

  it("needs a reason, and the passkey's answer for exactly this act — the package's answer decides nothing here", async () => {
    for (const [body, error] of [
      [{ only: "x86_64" }, "a reason is required: why aarch64 does not ship — it goes on the record and on the package's page"],
      [{ only: "x86_64", reason: "  no " }, "a reason is required: why aarch64 does not ship — it goes on the record and on the package's page"],
    ] as const) {
      const r = await approve("m2", px, body);
      expect([r.status, r.json.error, r.json.code]).toEqual([400, error, "reason"]);
    }
    // The architecture `only` names is this build's, or nothing is decided.
    const wrong = await approve("m2", px, { only: "aarch64", reason: "said of the wrong build" });
    expect([wrong.status, wrong.json.code]).toEqual([400, "only"]);
    // No passkey's answer at all, or the answer the package's approval would take: refused, nothing written.
    const bare = await fromPage("m2", `/api/v1/factory/tasks/${px}/approve`, { only: "x86_64", reason: "aarch64 has no linker yet" });
    expect([bare.status, bare.json.code]).toEqual([403, "passkey_required"]);
    const other = await fromPage("m2", `/api/v1/factory/tasks/${px}/approve`, { only: "x86_64", reason: "aarch64 has no linker yet", assertion: await assertion("m2", `approve:${px}`) });
    expect([other.status, other.json.code]).toEqual([403, "challenge"]);
    // A token never approves, one architecture or the package.
    const token = await call("POST", `/factory/tasks/${px}/approve`, { only: "x86_64", reason: "aarch64 has no linker yet" }, "omc_m2");
    expect(token.status).toBe(403);
    // Nor the requester, who never decides on their own package.
    expect((await call("POST", `/factory/tasks/${px}/approve`, { only: "x86_64", reason: "mine" }, "omc_alice")).status).toBe(403);
    expect(await counted("SELECT COUNT(*) AS n FROM reviews WHERE name = 'half'")).toBe(0);
    expect(await counted("SELECT COUNT(*) AS n FROM build_tasks WHERE name = 'half' AND kind = 'publish'")).toBe(0);
  });

  it("goes on the record with its reason — the review, the signed record, the journal, the approvals, the story — and the other architecture does not ship", async () => {
    const why = "upstream ships no aarch64 build";
    const ok = await approve("m2", px, { only: "x86_64", reason: why, note: "x86_64 reads well" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ decision: "approved", arches: ["x86_64"], not_supported: {}, not_shipping: { aarch64: arm }, only_reason: why, publishes: { x86_64: ok.json.publish } });
    expect(await env.DB.prepare("SELECT arches, only_reason, not_shipping FROM reviews WHERE id = ?").bind(ok.json.review).first()).toEqual({ arches: '["x86_64"]', only_reason: why, not_shipping: JSON.stringify({ aarch64: arm }) });
    // The same approvals row and publish job as any approval: one, x86_64's.
    expect((await env.DB.prepare("SELECT arch, task_id, decision FROM approvals WHERE name = 'half'").all()).results).toEqual([{ arch: "x86_64", task_id: px, decision: "approved" }]);
    expect((await env.DB.prepare("SELECT arch FROM build_tasks WHERE name = 'half' AND kind = 'publish'").all()).results).toEqual([{ arch: "x86_64" }]);
    expect(await recordOf(ok.json.record)).toMatchObject({ decision: "approve", scope: "architecture", arches: ["x86_64"], not_shipping: { aarch64: arm }, only_reason: why, by: "m2", passkey: keys.m2.id });
    const line = (await env.DB.prepare("SELECT summary FROM events WHERE kind = 'approve' AND json_extract(payload, '$.review') = ?").bind(ok.json.review).first<{ summary: string }>())!;
    expect(line.summary).toMatch(/^half 1\.0 \(x86_64 only: upstream ships no aarch64 build\) approved by m2 /);
    expect(line.summary).toMatch(/; aarch64 does not ship$/);
    const listed = (await call("GET", "/factory/approvals?after=half", undefined)).json.approvals.find((a: any) => a.review === ok.json.review);
    expect(listed).toMatchObject({ arches: ["x86_64"], only_reason: why, not_shipping: { aarch64: arm }, standing: true });
    const story = (await call("GET", "/factory/packages/half/story?after=decided", undefined)).json;
    expect(story.chains.find((c: any) => c.approval)?.approval).toMatchObject({ arches: ["x86_64"], only_reason: why, not_shipping: { aarch64: arm }, standing: true });
    // aarch64 does not ship: said so in its target, not "not supported", not "waiting".
    expect(story.targets).toEqual({ x86_64: { status: "approved", task: px }, aarch64: { status: "not_shipping", task: arm } });
    expect((await call("GET", "/factory/review", undefined, "omc_m2")).json.packages.find((p: any) => p.name === "half")).toBeUndefined();
  });

  it("is taken back whole by a withdrawal, as any approval: the reason stays on the record and the other architecture is where its builds left it", async () => {
    const wd = await call("POST", `/factory/tasks/${px}/withdraw`, { note: "aarch64 builds after all" }, "omc_m1");
    expect(wd.status, JSON.stringify(wd.json)).toBe(200);
    expect(wd.json).toMatchObject({ arches: ["x86_64"], by: "m1" });
    expect(await counted("SELECT COUNT(*) AS n FROM approvals WHERE name = 'half' AND withdrawn_at IS NULL")).toBe(0);
    const listed = (await call("GET", "/factory/approvals?after=withdrawn", undefined)).json.approvals.find((a: any) => a.name === "half");
    expect(listed).toMatchObject({ standing: false, only_reason: "upstream ships no aarch64 build" });
    // No approval stands: aarch64 is its failed build again, x86_64 the project's build waiting for a decision.
    expect(await targetsOf("half")).toEqual({ x86_64: { status: "reviewed", task: px }, aarch64: { status: "not_supported", task: arm } });
  });

  it("sets aside what the other architecture still builds: its builds in review stop with the decision and leave staging", async () => {
    await quiet();
    expect((await request("aside")).status).toBe(201);
    const cx = await stage(await claim("omw_cx", "x86_64", "aside"));
    const ca = await stage(await claim("omw_ca", "aarch64", "aside"));
    const asked = await call("POST", `/factory/tasks/${cx}/build`, {}, "omc_m1");
    const [rx, ra] = asked.json.tasks as number[];
    expect(await stage(await claim("omw_px", "x86_64", "aside"))).toBe(rx);
    // aarch64's rebuild is still queued: the package waits; x86_64 alone does not.
    expect(await canOf(rx)).toMatchObject({ approve: false, approve_only: true });
    const ok = await approve("m2", rx, { only: "x86_64", reason: "aarch64 needs hardware this pool lacks" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ arches: ["x86_64"], not_shipping: { aarch64: ra } });
    expect([...ok.json.set_aside].sort()).toEqual([ca, ra].sort());
    expect((await env.DB.prepare("SELECT id, status, error FROM build_tasks WHERE id IN (?, ?) ORDER BY id").bind(ca, ra).all()).results).toEqual(
      [ca, ra].sort((x, y) => x - y).map((id) => ({ id, status: "cancelled", error: "not shipping: x86_64 approved alone by m2 — aarch64 needs hardware this pool lacks" })),
    );
    // Its package leaves staging; its text evidence stays.
    expect(await counted("SELECT COUNT(*) AS n FROM staging_objects WHERE task_id = ? AND key LIKE '%.pkg.tar.zst'", ca)).toBe(0);
    expect(await counted("SELECT COUNT(*) AS n FROM staging_objects WHERE task_id = ? AND key LIKE '%/PKGBUILD'", ca)).toBe(1);
    expect(await targetsOf("aside")).toEqual({ x86_64: { status: "approved", task: rx }, aarch64: { status: "not_shipping", task: ra } });
    // Nothing of it asks for a maintainer's time any more: aarch64's builds went with the decision.
    const list = (await call("GET", "/factory/review", undefined, "omc_m2")).json;
    expect(list.staged.filter((t: any) => t.name === "aside" && (t.waits || t.arch === "aarch64"))).toEqual([]);
  });

  it("is finished later at the same version: the other architecture, built again, is approved as the package, and nothing says it does not ship", async () => {
    await quiet();
    expect((await request("late")).status).toBe(201);
    const cx = await stage(await claim("omw_cx", "x86_64", "late"));
    const ca = await fail(await claim("omw_ca", "aarch64", "late"));
    expect((await call("POST", `/factory/tasks/${cx}/build`, {}, "omc_m1")).json).toMatchObject({ arches: ["x86_64"] });
    const px = await stage(await claim("omw_px", "x86_64", "late"));
    const first = await approve("m2", px, { only: "x86_64", reason: "aarch64 has no linker yet" });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json).toMatchObject({ not_shipping: { aarch64: ca }, kept: {} });
    // aarch64 builds after all, at the same version: its requester builds it again, a maintainer has the project build it too.
    expect((await call("POST", "/factory/packages/late/build", { arches: ["aarch64"] }, "omc_alice")).status).toBe(201);
    const ca2 = await stage(await claim("omw_ca", "aarch64", "late"));
    expect((await call("POST", `/factory/tasks/${ca2}/build`, {}, "omc_m1")).json).toMatchObject({ arches: ["aarch64"] });
    const pa = await stage(await claim("omw_pa", "aarch64", "late"));
    expect(await targetsOf("late")).toEqual({ x86_64: { status: "approved", task: px }, aarch64: { status: "reviewed", task: pa } });
    // x86_64 is approved at this version: the package is whole with aarch64, and aarch64 alone would leave nothing out.
    expect(await canOf(pa)).toMatchObject({ approve: true, approve_only: false, why: { approve_only: "x86_64 is approved at this version already: approve the package, it leaves nothing out" } });
    const alone = await approve("m2", pa, { only: "aarch64", reason: "said of a package that is whole" });
    expect([alone.status, alone.json.error]).toEqual([409, "x86_64 is approved at this version already: approve the package, it leaves nothing out"]);
    const ok = await approve("m2", pa, { note: "aarch64 links now" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    // The review covers what it adds — aarch64 — and sets nothing aside: x86_64 is never written as not shipping.
    expect(ok.json).toMatchObject({ arches: ["aarch64"], not_shipping: {}, kept: {}, only_reason: null, set_aside: [] });
    expect(await env.DB.prepare("SELECT arches, only_reason, not_shipping FROM reviews WHERE id = ?").bind(ok.json.review).first()).toEqual({ arches: '["aarch64"]', only_reason: null, not_shipping: "{}" });
    expect(await recordOf(ok.json.record)).toMatchObject({ scope: "package", arches: ["aarch64"], not_shipping: {}, kept: {} });
    const line = (await env.DB.prepare("SELECT summary FROM events WHERE kind = 'approve' AND json_extract(payload, '$.review') = ?").bind(ok.json.review).first<{ summary: string }>())!.summary;
    expect(line).toMatch(/^late 1\.0 \(aarch64\) approved by m2 /);
    expect(line).not.toMatch(/not ship/);
    expect(await targetsOf("late")).toEqual({ x86_64: { status: "approved", task: px }, aarch64: { status: "approved", task: pa } });
  });

  it("on a bump keeps an architecture whose new version did not build at the version in the pool: approved alone, the other stays, never written as not shipping", async () => {
    await quiet();
    // kept 1.0, approved on both architectures by m2 and served — its recipe on GitHub.
    await env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status, detail) VALUES ('kept', 'alice', 'https://github.com/alice/kept', '["x86_64","aarch64"]', 'published', 'in the pool')`).run();
    const review = (await env.DB.prepare(`INSERT INTO reviews (name, version, decision, by, arches) VALUES ('kept', '1.0-1', 'approved', 'm2', '["x86_64","aarch64"]') RETURNING id`).first<{ id: number }>())!.id;
    const v1: Record<string, number> = {};
    for (const arch of ["x86_64", "aarch64"]) {
      // Each architecture's two halves: the contributor's build, and the project's build of it that the approval stands on and the pool serves.
      const from = (await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind) VALUES ('kept', ?, '1.0-1', 'draft:x', 'contributor', 100, 'staged', 0, 'community', 'alice', 'build') RETURNING id").bind(arch).first<{ id: number }>())!.id;
      v1[arch] = (await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params) VALUES ('kept', ?, '1.0-1', 'draft:x', 'review', 100, 'done', 0, 'project', 'alice', 'build', ?) RETURNING id").bind(arch, JSON.stringify({ review: from })).first<{ id: number }>())!.id;
      await env.DB.prepare("INSERT INTO approvals (task_id, name, arch, version, decision, by, rebuild_task, review_id) VALUES (?, 'kept', ?, '1.0-1', 'approved', 'm2', ?, ?)").bind(v1[arch], arch, v1[arch], review).run();
    }
    expect(await settleTargets(env, "kept")).toEqual({ kept: { x86_64: { status: "published", task: v1.x86_64 }, aarch64: { status: "published", task: v1.aarch64 } } });
    // Upstream releases 2.0.0 (another day than the cron's test below): the bump is queued, x86_64 builds, aarch64 does not.
    const github = async (input: RequestInfo | URL) => (String(input instanceof Request ? input.url : input) === "https://api.github.com/repos/alice/kept/releases/latest" ? new Response(JSON.stringify({ tag_name: "v2.0.0" }), { status: 200 }) : new Response("not found", { status: 404 }));
    expect(await checkUpdates(env, new Date("2026-10-01T06:00:00Z"), github as typeof fetch)).toContain("kept: v2.0.0 queued");
    const bx = await stage(await claim("omw_cx", "x86_64", "kept"), "2.0.0-1");
    const ba = await fail(await claim("omw_ca", "aarch64", "kept"));
    expect((await call("POST", `/factory/tasks/${bx}/build`, {}, "omc_m1")).json).toMatchObject({ arches: ["x86_64"] });
    const px = await stage(await claim("omw_px", "x86_64", "kept"), "2.0.0-1");
    // aarch64 1.0 is what pacman installs: the package's 2.0.0 is refused, and x86_64 alone is offered with aarch64 kept where it is.
    expect(await targetsOf("kept")).toEqual({ x86_64: { status: "reviewed", task: px }, aarch64: { status: "published", task: v1.aarch64 } });
    const why = `aarch64 is in the pool at another version only (task ${v1.aarch64}): the package is approved once every architecture it names is built again by the project — or approve x86_64 only, with the reason aarch64 stays at 1.0-1`;
    expect(await canOf(px)).toMatchObject({ approve: false, approve_only: true, why: { approve: why } });
    const ok = await approve("m2", px, { only: "x86_64", reason: `aarch64 2.0.0 fails to link (task ${ba})` });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ arches: ["x86_64"], not_shipping: {}, kept: { aarch64: "1.0-1" }, only_reason: `aarch64 2.0.0 fails to link (task ${ba})`, set_aside: [] });
    // Nothing on the record says aarch64 does not ship: the review sets nothing aside, the record and the journal say it stays at 1.0-1.
    expect(await env.DB.prepare("SELECT only_reason, not_shipping FROM reviews WHERE id = ?").bind(ok.json.review).first()).toEqual({ only_reason: `aarch64 2.0.0 fails to link (task ${ba})`, not_shipping: "{}" });
    expect(await recordOf(ok.json.record)).toMatchObject({ scope: "architecture", not_shipping: {}, kept: { aarch64: "1.0-1" } });
    const line = (await env.DB.prepare("SELECT summary FROM events WHERE kind = 'approve' AND json_extract(payload, '$.review') = ?").bind(ok.json.review).first<{ summary: string }>())!.summary;
    expect(line).toMatch(/^kept 2\.0\.0-1 \(x86_64 only: aarch64 2\.0\.0 fails to link \(task \d+\)\) approved by m2 .*; aarch64 stays at 1\.0-1$/);
    expect(line).not.toMatch(/not ship/);
    expect((await env.DB.prepare("SELECT detail FROM factory_packages WHERE name = 'kept'").first<{ detail: string }>())!.detail).toBe(`2.0.0-1 for x86_64 only approved by m2 (aarch64 stays at 1.0-1: aarch64 2.0.0 fails to link (task ${ba})); publishing the project's build (job ${ok.json.publish})`);
    expect(await targetsOf("kept")).toEqual({ x86_64: { status: "approved", task: px }, aarch64: { status: "published", task: v1.aarch64 } });
  });

  it("is one decision when two maintainers approve each architecture alone at the same moment: the second cancels nothing and writes nothing", async () => {
    await quiet();
    expect((await request("race")).status).toBe(201);
    const cx = await stage(await claim("omw_cx", "x86_64", "race"));
    const ca = await stage(await claim("omw_ca", "aarch64", "race"));
    const [rx, ra] = (await call("POST", `/factory/tasks/${cx}/build`, {}, "omc_m1")).json.tasks as number[];
    expect(await stage(await claim("omw_px", "x86_64", "race"))).toBe(rx);
    expect(await stage(await claim("omw_pa", "aarch64", "race"))).toBe(ra);
    // Both read the same facts — each architecture undecided — before either writes: the decisions' batches wait for each other, then run in turn.
    const [x, a] = [await assertion("m1", `approve:${rx}:x86_64`), await assertion("m2", `approve:${ra}:aarch64`)];
    const batch = env.DB.batch.bind(env.DB);
    let waiting: (() => void) | null = null;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      if (waiting) { const go = waiting; waiting = null; go(); }
      else await Promise.race([new Promise<void>((r) => { waiting = r; }), new Promise((r) => setTimeout(r, 2000))]);
      return batch(statements);
    });
    const answers = await Promise.all([
      fromPage("m1", `/api/v1/factory/tasks/${rx}/approve`, { only: "x86_64", reason: "aarch64 is not wanted here", assertion: x }),
      fromPage("m2", `/api/v1/factory/tasks/${ra}/approve`, { only: "aarch64", reason: "x86_64 is not wanted here", assertion: a }),
    ]);
    vi.restoreAllMocks();
    const won = answers.find((r) => r.status === 200)!, lost = answers.find((r) => r.status !== 200)!;
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(lost.json.error).toBe(`race was decided a moment ago: approved by ${won.json.by}`);
    // One review, one approval — the winner's — and only the loser's architecture set aside: the winner's build stays staged, and publishes.
    expect(await counted("SELECT COUNT(*) AS n FROM reviews WHERE name = 'race'")).toBe(1);
    const mine = won.json.arches[0] === "x86_64" ? rx : ra, theirs = mine === rx ? [ca, ra] : [cx, rx];
    expect((await env.DB.prepare("SELECT task_id FROM approvals WHERE name = 'race'").all()).results).toEqual([{ task_id: mine }]);
    expect((await env.DB.prepare("SELECT status FROM build_tasks WHERE id = ?").bind(mine).first())).toEqual({ status: "staged" });
    expect([...won.json.set_aside].sort()).toEqual([...theirs].sort());
    expect((await env.DB.prepare("SELECT json_extract(params, '$.task') AS task FROM build_tasks WHERE name = 'race' AND kind = 'publish'").all()).results).toEqual([{ task: mine }]);
    // The statement itself never cancels a build a live decision stands on, whatever the round names.
    expect((await env.DB.prepare(SET_ASIDE_SQL).bind("not this one", JSON.stringify([mine]), JSON.stringify([])).all()).results).toEqual([]);
  });

  it("stays decided when staging cannot be emptied: the builds set aside are cancelled with the decision, their packages left to the weekly sweep", async () => {
    await quiet();
    expect((await request("stuck")).status).toBe(201);
    const cx = await stage(await claim("omw_cx", "x86_64", "stuck"));
    const ca = await stage(await claim("omw_ca", "aarch64", "stuck"));
    const [rx, ra] = (await call("POST", `/factory/tasks/${cx}/build`, {}, "omc_m1")).json.tasks as number[];
    expect(await stage(await claim("omw_px", "x86_64", "stuck"))).toBe(rx);
    // R2 refuses every delete for the moment.
    vi.spyOn(env.STAGING, "delete").mockRejectedValue(new Error("R2 is unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = await approve("m2", rx, { only: "x86_64", reason: "aarch64 needs hardware this pool lacks" });
    vi.restoreAllMocks();
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect([...ok.json.set_aside].sort()).toEqual([ca, ra].sort());
    // The decision is whole: the publish job, the signed record, the journal line; the builds set aside cancelled in the same batch as the review.
    expect((await env.DB.prepare("SELECT arch FROM build_tasks WHERE name = 'stuck' AND kind = 'publish'").all()).results).toEqual([{ arch: "x86_64" }]);
    expect(await recordOf(ok.json.record)).toMatchObject({ scope: "architecture", set_aside: ok.json.set_aside });
    expect(await counted("SELECT COUNT(*) AS n FROM events WHERE kind = 'approve' AND json_extract(payload, '$.review') = ?", ok.json.review)).toBe(1);
    expect((await env.DB.prepare("SELECT status FROM build_tasks WHERE id IN (?, ?)").bind(ca, ra).all()).results).toEqual([{ status: "cancelled" }, { status: "cancelled" }]);
    // The package aarch64's contributor staged is still there, a cancelled build's: the sweep takes it.
    expect(await counted("SELECT COUNT(*) AS n FROM staging_objects WHERE task_id = ? AND key LIKE '%.pkg.tar.zst'", ca)).toBe(1);
    await sweepStaging(env);
    expect(await counted("SELECT COUNT(*) AS n FROM staging_objects WHERE task_id = ? AND key LIKE '%.pkg.tar.zst'", ca)).toBe(0);
  });

  it("is the solo-maintainer exception's too: its maintainer approves one architecture of their own package, marked self-reviewed", async () => {
    await quiet();
    await env.DB.prepare("INSERT INTO governance_solo (id, maintainer, since, reason) VALUES (1, 'm1', '2026-10-06', 'one maintainer for now')").run();
    try {
      expect((await request("selfhalf", "omc_m1")).status).toBe(201);
      const x = await stage(await claim("omw_cx", "x86_64", "selfhalf"));
      const a = await fail(await claim("omw_ca", "aarch64", "selfhalf"));
      expect((await call("POST", `/factory/tasks/${x}/build`, {}, "omc_m1")).status).toBe(200);
      const p = await stage(await claim("omw_px", "x86_64", "selfhalf"));
      const ok = await approve("m1", p, { only: "x86_64", reason: "aarch64 has no linker yet" });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect(ok.json).toMatchObject({ arches: ["x86_64"], not_shipping: { aarch64: a }, only_reason: "aarch64 has no linker yet", solo_exception: { maintainer: "m1", since: "2026-10-06" } });
      expect(await env.DB.prepare("SELECT solo_since, only_reason FROM reviews WHERE id = ?").bind(ok.json.review).first()).toEqual({ solo_since: "2026-10-06", only_reason: "aarch64 has no linker yet" });
      expect((await env.DB.prepare("SELECT summary FROM events WHERE kind = 'approve' AND json_extract(payload, '$.review') = ?").bind(ok.json.review).first<{ summary: string }>())!.summary).toContain("self-reviewed (solo-maintainer exception)");
    } finally {
      await env.DB.prepare("DELETE FROM governance_solo").run();
    }
  });
});

describe("nothing is approved by itself", () => {
  it("leaves a bump as evidence, tick after tick, until a maintainer approves it with a passkey", async () => {
    await quiet();
    // bumped 1.0, approved on both architectures by m2 and served — its recipe on GitHub.
    const h = await env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status, detail) VALUES ('bumped', 'alice', 'https://github.com/alice/bumped', '["x86_64","aarch64"]', 'published', 'in the pool') RETURNING name`).first();
    expect(h).toEqual({ name: "bumped" });
    const review = (await env.DB.prepare(`INSERT INTO reviews (name, version, decision, by, arches) VALUES ('bumped', '1.0-1', 'approved', 'm2', '["x86_64","aarch64"]') RETURNING id`).first<{ id: number }>())!.id;
    for (const arch of ["x86_64", "aarch64"]) {
      const t = (await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind) VALUES ('bumped', ?, '1.0-1', 'draft:x', 'contributor', 100, 'done', 0, 'project', 'alice', 'build') RETURNING id").bind(arch).first<{ id: number }>())!.id;
      await env.DB.prepare("INSERT INTO approvals (task_id, name, arch, version, decision, by, rebuild_task, review_id) VALUES (?, 'bumped', ?, '1.0-1', 'approved', 'm2', ?, ?)").bind(t, arch, t, review).run();
    }
    const decisions = () => counted("SELECT COUNT(*) AS n FROM reviews WHERE name = 'bumped'");
    const rows = () => counted("SELECT COUNT(*) AS n FROM approvals WHERE name = 'bumped'");
    const publishes = () => counted("SELECT COUNT(*) AS n FROM build_tasks WHERE name = 'bumped' AND kind = 'publish'");
    const still = async (when: string) => {
      expect([await decisions(), await rows(), await publishes()], when).toEqual([1, 2, 0]);
    };
    // Upstream releases 2.0.0: the cron's tick (the scheduled handler's whole run, no job kinds of its own) queues the bump as a contributor's build.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://api.github.com/repos/alice/bumped/releases/latest") return new Response(JSON.stringify({ tag_name: "v2.0.0" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("not found", { status: 404 });
    });
    const tick = (iso: string) => runScheduler({ ...env, JOB_KINDS: "" }, new Date(iso));
    await tick("2026-10-12T06:00:00Z");
    const bumps = (await env.DB.prepare("SELECT id, arch, status, trust, publish FROM build_tasks WHERE name = 'bumped' AND reason = 'bump to v2.0.0' ORDER BY arch DESC").all<{ id: number; arch: string; status: string; trust: string; publish: number }>()).results;
    expect(bumps.map(({ arch, status, trust, publish }) => ({ arch, status, trust, publish }))).toEqual([{ arch: "x86_64", status: "queued", trust: "community", publish: 0 }, { arch: "aarch64", status: "queued", trust: "community", publish: 0 }]);
    await still("the bump queued");
    // The hosts build it: staged, evidence — and the next tick decides nothing.
    const bx = await stage(await claim("omw_cx", "x86_64", "bumped"), "2.0.0-1");
    await stage(await claim("omw_ca", "aarch64", "bumped"), "2.0.0-1");
    await tick("2026-10-12T09:00:00Z");
    await still("the bump built");
    const listed = (await call("GET", "/factory/review", undefined, "omc_m2")).json.packages.find((p: any) => p.name === "bumped");
    expect(listed).toMatchObject({ state: "ready", waits: true, claim: null });
    // A maintainer has the project build it again; staged, it is the project's build — and still nothing approves it.
    const asked = await call("POST", `/factory/tasks/${bx}/build`, {}, "omc_m1");
    expect(asked.json).toMatchObject({ arches: ["x86_64", "aarch64"] });
    const [rx, ra] = asked.json.tasks as number[];
    expect(await stage(await claim("omw_px", "x86_64", "bumped"), "2.0.0-1")).toBe(rx);
    expect(await stage(await claim("omw_pa", "aarch64", "bumped"), "2.0.0-1")).toBe(ra);
    await tick("2026-10-13T06:30:00Z");
    await still("the project's build of the bump staged");
    expect(await canOf(rx)).toMatchObject({ approve: true });
    // A token does not approve it; only a maintainer, in the browser, with a passkey.
    expect((await call("POST", `/factory/tasks/${rx}/approve`, {}, "omc_m2")).status).toBe(403);
    await still("a token's try");
    const ok = await approve("m2", rx, { note: "2.0.0 reads well" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ arches: ["x86_64", "aarch64"] });
    expect([await decisions(), await rows(), await publishes()]).toEqual([2, 4, 2]);
  });

  it("reads by a key: the builds set aside by their ids, a package's decisions by the name's index with each one's review by its primary key", async () => {
    const plan = async (sql: string, args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    const aside = await plan(SET_ASIDE_SQL, ["why", JSON.stringify([1, 2]), JSON.stringify([1, 2, 3])]);
    expect(aside).toMatch(/SEARCH build_tasks USING INTEGER PRIMARY KEY/);
    // The live decision on each build, and on any build of the round, by the approvals' task index.
    expect(aside).toMatch(/SEARCH [ad] USING (COVERING )?INDEX idx_approvals_task \(task_id=\?\)/);
    const decided = await plan(DECISIONS_OF_SQL, ["half"]);
    expect(decided).toMatch(/SEARCH a USING INDEX idx_approvals_name \(name=\?\)/);
    expect(decided).toMatch(/SEARCH v USING INTEGER PRIMARY KEY/);
    for (const p of [aside, decided]) expect(p).not.toMatch(/SCAN (build_tasks|approvals|reviews|[adv])\b/);
  });

  it("writes a decision in one place, reached only by a maintainer's act: the web's door with its passkey gate, or an agent's draft confirmed in the browser", () => {
    const where = (re: RegExp) => Object.entries(SOURCES).filter(([, text]) => re.test(text)).map(([f]) => f.replace("../src/", "")).sort();
    // The record of a decision — a review and its rows — is written by two statements of routes/review.ts, and nowhere else.
    expect(where(/INSERT INTO (approvals|reviews)\b/)).toEqual(["routes/review.ts"]);
    // A package is marked approved, and a publish job queued for it, by an approval alone.
    expect(where(/SET status = 'approved'/)).toEqual(["routes/review.ts"]);
    expect(where(/'project', NULL, 'publish'/)).toEqual(["routes/review.ts"]);
    // The batch that writes them runs for an approval and a rejection's round, nothing else.
    const review = SOURCES["../src/routes/review.ts"];
    expect(review.match(/await takeRound\(/g)).toHaveLength(2);
    expect(review).toMatch(/export async function handleApprove\([^)]*\)[^{]*\{[\s\S]*?const taken = await takeRound\(/);
    expect(review).toMatch(/async function closeRound\([^)]*\)[^{]*\{[\s\S]*?const taken = await takeRound\(/);
    // The builds an approval of one architecture sets aside are cancelled in the decision's own batch, first, under its condition.
    expect(review).toMatch(/async function takeRound\([\s\S]*?env\.DB\.batch\(\[\s*\.\.\.\(aside \? \[env\.DB\.prepare\(SET_ASIDE_SQL\)/);
    expect(review.match(/prepare\(SET_ASIDE_SQL\)/g)).toHaveLength(1);
    // handleApprove is reached from two places: the web's door, with the passkey's gate for the act the body names, and an agent's draft a maintainer confirmed in the browser.
    expect(where(/\bhandleApprove\b/)).toEqual(["index.ts", "routes/agents.ts", "routes/review.ts"]);
    expect(SOURCES["../src/index.ts"]).toMatch(/handleApprove\(c, Number\(m\[1\]\), request, env, undefined, \(subject\) => webGate\(request, url, env, c\.login, subject\)\)/);
    // It fails closed: without a draft's passkey or the door's, nothing is decided.
    expect(review).toMatch(/const confirmed = await decidedWith\(through, gateFor\?\.\(/);
    // Nothing on a timer names either: the cron, the bumps, the jobs.
    for (const f of ["../src/scheduler.ts", "../src/updates.ts", "../src/jobs.ts"]) expect(SOURCES[f], f).not.toMatch(/handleApprove|takeRound|INSERT INTO approvals|INSERT INTO reviews|SET status = 'approved'/);
  });
});
