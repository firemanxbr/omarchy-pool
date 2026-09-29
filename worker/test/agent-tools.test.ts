/**
 * The MCP write tools' server side (#252; routes/agents.ts, agents.ts), as
 * the chapter's *Tests* section lists it. The grant: made in the signed-in
 * browser only (the session, its Origin and the page's nonce), its code sent
 * to 127.0.0.1 whatever the link asked, swapped once, not after a minute and
 * not without the verifier; review and block a maintainer's, for seven days;
 * three live grants per login. The token: taken by the tools' routes and
 * refused on every other — every decision route — and by contributorOf. The
 * writes: a request is not confirmed through the link and says it came
 * through an agent; a claim leaves the project agent's hint null; a release
 * says who let it go through which agent. The drafts: the requester's agent
 * refused with conflict_of_interest, no journal line, the person's own page
 * only; confirmed by the same login in the browser, with the session, the
 * Origin and the nonce, once — two at once are one decision — the name typed
 * for reject and block, the predicate run again, expired after thirty
 * minutes. Revocation: logout, the person's page and a contributor's block.
 * The limits: the bursts (the rate limiting bindings, real in workerd), the
 * day's counts by login, the cost guard. Text evidence is edge-cached and
 * read by its tail; a package in staging never is. Every new query is asked
 * for its plan.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as openpgp from "openpgp";
import worker from "../src/index";
import { contributorOf, ME_DRAFTS_SQL, ME_GRANTS_SQL, ME_LIVE_GRANTS_SQL, ME_WAITING_DRAFTS_SQL, ME_WORKERS_SQL, sha256Hex } from "../src/routes/contributors";
import {
  DECIDED_BY_DRAFT_SQL, DISCARD_BY_TOKEN_SQL, DISCARD_SQL, DRAFT_GRANT_SQL, GRANT_INSERT_SQL, LIVE_GRANTS_SQL, LOGOUT_SQL, REPLACE_SQL, REVOKE_GRANT_SQL, SPEND_SQL, SWAP_SQL, UNSWAPPED_SQL,
} from "../src/routes/agents";
import { BLOCK_GRANTS_SQL } from "../src/routes/blocks";
import { PENDING_CODES_SQL } from "../src/routes/gc";
import { agentName, daySql, DRAFT_MINUTES, GRANT_SQL, s256 } from "../src/agents";
import { forgetGuardWord } from "../src/cost";
import { assert as answer, createAuthenticator, register, UP, UV } from "./soft-authenticator.mjs";

/** The dashboard as the tests reach it: localhost, where a passkey works (routes/passkeys.ts relyingParty), as wrangler dev's. */
const ORIGIN = "http://localhost:8787";
const API = `${ORIGIN}/api/v1`;
const AGENT = "claude-code/claude-sonnet-5";
const checklist = { official: true, license: true, unshipped: true, evidence: true };

/** The real bindings, kept aside: most tests run with the bursts off (a file's calls as one login would pass twenty a minute), the limits' own tests put them back. */
const REAL = { calls: env.AGENT_CALLS, swaps: env.AGENT_SWAPS };
const unlimited = { limit: async () => ({ success: true }) } as unknown as RateLimit;
afterEach(() => {
  env.AGENT_CALLS = unlimited;
  env.AGENT_SWAPS = unlimited;
});

async function raw(method: string, url: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, { method, headers: init.headers, body: init.body, redirect: "manual" }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function call(method: string, path: string, body?: unknown, token?: string, extra: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Headers }> {
  const headers: Record<string, string> = { ...extra };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await raw(method, API + path, { headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}

const session = (login: string) => `omc=oms_${login}`;

/** A page of the flow in the browser: the session's cookie, and for a POST the form, its Origin. */
async function browser(method: "GET" | "POST", path: string, login: string | null, form?: Record<string, string>, opts: { origin?: string | null; bearer?: string } = {}): Promise<{ status: number; text: string; location: string | null; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (login) headers.cookie = session(login);
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (form) headers["content-type"] = "application/x-www-form-urlencoded";
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (method === "POST" && origin) headers.origin = origin;
  const res = await raw(method, ORIGIN + path, { headers, body: form ? new URLSearchParams(form).toString() : undefined });
  return { status: res.status, text: await res.text(), location: res.headers.get("location"), headers: res.headers };
}

/** The hidden fields a served form carries. */
const fields = (html: string): Record<string, string> => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([a-z_]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")]));

let swapIp = 0;
const verifierOf = (seed: string) => `verifier-${seed.replace(/[^A-Za-z0-9._~-]/g, "-")}-`.padEnd(64, "x");

/** The whole login, as omarchy-cli runs it: the grant page, Grant, the loopback's code, the swap. */
async function login(who: string, agent: string, scopes = "contribute", extra: Record<string, string> = {}): Promise<{ token: string; grant: string; expires_at: string; scopes: string[] }> {
  const verifier = verifierOf(`${who}-${agent}-${Math.random().toString(36).slice(2)}`);
  const q = new URLSearchParams({ agent, scopes, port: "48123", state: "state-" + "s".repeat(16), challenge: await s256(verifier), method: "S256", ...extra });
  const pageRes = await browser("GET", `/auth/agent?${q}`, who);
  expect(pageRes.status, pageRes.text.slice(0, 400)).toBe(200);
  const f = fields(pageRes.text);
  const granted = await browser("POST", "/auth/agent", who, { ...f, action: "grant" });
  expect(granted.status, granted.text.slice(0, 600)).toBe(303);
  const back = new URL(granted.location!);
  expect(`${back.protocol}//${back.host}`).toBe("http://127.0.0.1:48123");
  const res = await raw("POST", `${ORIGIN}/auth/agent/token`, { headers: { "content-type": "application/json", "cf-connecting-ip": `10.0.0.${++swapIp % 250}` }, body: JSON.stringify({ code: back.searchParams.get("code"), code_verifier: verifier }) });
  const body = (await res.json()) as any;
  expect(res.status, JSON.stringify(body)).toBe(200);
  return { token: body.token, grant: body.grant, expires_at: body.expires_at, scopes: body.scopes };
}

const request = (name: string, token: string, arches = ["x86_64"]) =>
  call("POST", "/factory/packages", { name, url: `https://${name}.example`, source: `https://${name}.example/${name}-1.0.tar.gz`, version: "1.0", description: `${name}, a tool for the agents' tests`, license: "MIT", arches, checklist }, token, { "x-omarchy-client": "claude-code/2.1.0" });
const claimAs = async (workerToken: string, name: string, arch = "x86_64") => {
  await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'not this story' WHERE status IN ('queued', 'leased') AND name != ?").bind(name).run();
  const c = await call("POST", "/factory/claim", { arch, agent: workerToken.startsWith("omw_px") ? AGENT : "openai/gpt-5", agent_status: "ok", kinds: ["build"] }, workerToken);
  expect(c.status, `${workerToken} claims ${name}: ${JSON.stringify(c.json)}`).toBe(200);
  expect(c.json.task).toMatchObject({ name, arch });
  return c.json as { task: { id: number; name: string; arch: string; params: Record<string, unknown> }; token: string };
};
const stage = async (c: { task: { id: number; name: string; arch?: string }; token: string }, who: string) => {
  const file = `${c.task.name}-1.0-1-${c.task.arch ?? "x86_64"}.pkg.tar.zst`;
  for (const f of ["PKGBUILD", "build.log", "PKGINFO", file]) expect((await call("PUT", `/factory/tasks/${c.task.id}/artifacts/${f}`, `${who}'s ${f} of ${c.task.id}`, c.token)).status).toBe(201);
  await call("PUT", `/factory/tasks/${c.task.id}/artifacts/vet.json`, JSON.stringify({ schema: "omarchy-pool/vet/1", verdict: "pass", checks: [{ name: "smoke", status: "pass", detail: "" }] }), c.token);
  const done = await call("POST", `/factory/tasks/${c.task.id}/complete`, { sha256: (who === "the project" ? "d" : "c").repeat(64), filename: file, version: "1.0-1" }, c.token);
  expect(done.json, JSON.stringify(done.json)).toMatchObject({ status: "staged" });
};
/** alice's request, built and staged by her worker: ready for a claim. */
const ready = async (name: string) => {
  expect((await call("POST", "/factory/packages", { name, url: `https://${name}.example`, source: `https://${name}.example/${name}-1.0.tar.gz`, version: "1.0", description: `${name}, a tool for the agents' tests`, license: "MIT", arches: ["x86_64"], checklist }, "omc_alice")).status).toBe(201);
  const c = await claimAs("omw_cx", name);
  await stage(c, "alice");
  return c.task.id;
};
/** Claimed on the web by m2, rebuilt and staged by the project: ready for a verdict. */
const reviewed = async (name: string) => {
  const id = await ready(name);
  expect((await call("POST", `/factory/tasks/${id}/build`, { worker: "px", note: "pin the tag" }, "omc_m2")).status).toBe(200);
  const rb = await claimAs("omw_px", name);
  await stage(rb, "the project");
  return { contributor: id, project: rb.task.id };
};
const line = async (kind: string, name: string) => env.DB.prepare("SELECT summary, payload FROM events WHERE kind = ? AND json_extract(payload, '$.name') = ? ORDER BY id DESC LIMIT 1").bind(kind, name).first<{ summary: string; payload: string }>();
const record = async (url: string) => {
  const key = url.slice(env.POOL_URL.length + 1);
  return JSON.parse(await (await env.PACKAGES.get(key))!.text());
};
/** The confirm page's form, and the POST of it. */
const confirmPage = (id: string, who: string) => browser("GET", `/auth/confirm/${id}`, who);

type Authenticator = Awaited<ReturnType<typeof createAuthenticator>>;
/** The passkeys each login registered in this file (#257): the software authenticator and the pool's id for it, the first answering unless a test names another. */
const passkeys: Record<string, { a: Authenticator; id: string }[]> = {};

/** A passkey registered on the person's own page, as its script does it: the options, the authenticator's answer, the POST — the session, the page's Origin. */
async function registerPasskey(login: string, o: { keepsCounter?: boolean } = {}): Promise<{ a: Authenticator; id: string }> {
  const a = await createAuthenticator({ keepsCounter: o.keepsCounter ?? true });
  const post = async (path: string, body: unknown) => {
    const res = await raw("POST", ORIGIN + path, { headers: { cookie: session(login), origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const opts = await post("/auth/passkeys/challenge", {});
  expect(opts.status, JSON.stringify(opts.json)).toBe(200);
  const reg = await post("/auth/passkeys", { label: `${login}'s key`, ...(await register(a, { challenge: opts.json.publicKey.challenge, origin: ORIGIN, rpId: "localhost" })) });
  expect(reg.status, JSON.stringify(reg.json)).toBe(201);
  const k = { a, id: reg.json.passkey.id as string };
  (passkeys[login] ??= []).push(k);
  return k;
}

/** POST /auth/confirm/:id/challenge, as the page's script asks it: the session, the page's Origin, the form's nonce. */
async function challengeFor(id: string, who: string, nonce: string, opts: { origin?: string | null; bearer?: string } = {}): Promise<{ status: number; json: any; headers: Headers }> {
  const headers: Record<string, string> = { cookie: session(who), "content-type": "application/x-www-form-urlencoded" };
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin) headers.origin = origin;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await raw("POST", `${ORIGIN}/auth/confirm/${id}/challenge`, { headers, body: new URLSearchParams({ nonce }).toString() });
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}

/** The assertion the confirm page's script posts with the form: a challenge for this draft, answered by the login's passkey (or `with`), made wrong where a test says how. */
async function signed(id: string, who: string, o: { with?: Authenticator; answer?: Record<string, unknown> } = {}): Promise<Record<string, string>> {
  const nonce = fields((await confirmPage(id, who)).text).nonce;
  const ch = await challengeFor(id, who, nonce);
  expect(ch.status, JSON.stringify(ch.json)).toBe(200);
  return answer(o.with ?? passkeys[who][0].a, { challenge: ch.json.publicKey.challenge, origin: ORIGIN, rpId: "localhost", ...(o.answer ?? {}) });
}

/** Confirm as the page does: its form, and for approve and block (the page offers the passkey's Confirm) the login's passkey's answer. */
const confirm = async (id: string, who: string, extra: Record<string, string> = {}, opts: { origin?: string | null; bearer?: string } = {}) => {
  const p = await confirmPage(id, who);
  const pk = p.text.includes('id="pk-confirm"') ? await signed(id, who) : {};
  return browser("POST", `/auth/confirm/${id}`, who, { ...fields(p.text), ...pk, action: "confirm", ...extra }, opts);
};

beforeAll(async () => {
  env.SIGNING_KEY = (await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "Pool Test", email: "test@omarchy.invalid" }], format: "armored" })).privateKey;
  env.AGENT_CALLS = unlimited;
  env.AGENT_SWAPS = unlimited;
  const h = (t: string) => sha256Hex(t);
  const people = ["m1", "m2", "m3", "m4", "alice", "bob", "carol", "dave", "erin", "frank", "gina", "hana"];
  const role = (l: string) => (/^m\d$/.test(l) ? "maintainer" : "contributor");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2'), ('m3'), ('m4')"),
    ...(await Promise.all(people.map(async (l) => env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role) VALUES (?, ?, ?, ?)").bind(l, await h(`omc_${l}`), await h(`oms_${l}`), role(l))))),
    env.DB.prepare(`INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, agent, agent_status, kinds) VALUES
      ('cx', 'x86_64', 'alice', ?, 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z', 'openai/gpt-5', 'ok', '["build"]'),
      ('px', 'x86_64', 'm2', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z', ?, 'ok', '["build"]'),
      ('cxa', 'aarch64', 'alice', ?, 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z', 'openai/gpt-5', 'ok', '["build"]'),
      ('pxa', 'aarch64', 'm2', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z', ?, 'ok', '["build"]')`).bind(await h("omw_cx"), await h("omw_px"), AGENT, await h("omw_cxa"), await h("omw_pxa"), AGENT),
  ]);
});

/** Tokens a later test reads again. */
const kept: Record<string, string> = {};

/** The bursts' windows are the wall clock's minute: a test that counts to the limit starts well inside one. */
async function freshWindow(): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 10_000) await new Promise((r) => setTimeout(r, left + 100));
}

describe("the grant", () => {
  it("is made in the signed-in browser only: nobody is sent to sign in and back, a token of any kind is refused, and the page escapes what the link says", async () => {
    const q = new URLSearchParams({ agent: "Claude <b>Code</b>", scopes: "contribute", port: "48123", state: "s".repeat(20), challenge: await s256(verifierOf("page")), method: "S256" });
    const nobody = await browser("GET", `/auth/agent?${q}`, null);
    expect(nobody.status).toBe(302);
    expect(nobody.location).toBe(`/auth/github?next=${encodeURIComponent(`/auth/agent?${q}`)}`);
    for (const bearer of ["omc_alice", "oma_whatever"]) expect((await browser("GET", `/auth/agent?${q}`, "alice", undefined, { bearer })).status, bearer).toBe(403);
    const p = await browser("GET", `/auth/agent?${q}`, "alice");
    expect(p.status).toBe(200);
    expect(p.headers.get("cache-control")).toBe("no-store");
    expect(p.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    // Never framed; the address goes to no other site, and the page's own form still carries its Origin (no-referrer would make it "null").
    expect([p.headers.get("x-frame-options"), p.headers.get("content-security-policy"), p.headers.get("referrer-policy")]).toEqual(["DENY", "frame-ancestors 'none'", "same-origin"]);
    expect(p.text).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(p.text).toContain("Claude &lt;b&gt;Code&lt;/b&gt;");
    expect(p.text).not.toContain("<b>Code</b>");
    expect(p.text).toContain("<code>http://127.0.0.1:48123/</code>");
    // A link that asks for what the pool does not grant is said so, and nothing is offered.
    for (const [k, v] of [["scopes", "admin"], ["port", "80"], ["method", "plain"], ["challenge", "short"]] as const) {
      const bad = new URLSearchParams(q); bad.set(k, v);
      expect((await browser("GET", `/auth/agent?${bad}`, "alice")).status, k).toBe(400);
    }
  });

  it("is posted with the session, its Origin and the page's nonce, and sends the code to 127.0.0.1 on the port — never anywhere the link names", async () => {
    const verifier = verifierOf("post");
    const q = new URLSearchParams({ agent: "Codex", scopes: "contribute", port: "51000", state: "t".repeat(20), challenge: await s256(verifier), redirect_uri: "https://evil.example/cb" });
    const f = fields((await browser("GET", `/auth/agent?${q}`, "bob")).text);
    // A bearer, another Origin, no Origin, another session's nonce, a changed field: refused, and no grant written.
    expect((await browser("POST", "/auth/agent", "bob", { ...f, action: "grant" }, { bearer: "omc_bob" })).status).toBe(403);
    expect((await browser("POST", "/auth/agent", "bob", { ...f, action: "grant" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await browser("POST", "/auth/agent", "bob", { ...f, action: "grant" }, { origin: null })).status).toBe(403);
    expect((await browser("POST", "/auth/agent", "carol", { ...f, action: "grant" })).status).toBe(403);
    expect((await browser("POST", "/auth/agent", "bob", { ...f, port: "51001", action: "grant" })).status).toBe(403);
    expect((await browser("POST", "/auth/agent", "bob", { ...f, action: "grant" })).status).toBe(303);
    const rows = (await env.DB.prepare("SELECT login, agent, token_hash, challenge FROM agent_grants WHERE login = 'bob'").all()).results;
    expect(rows).toEqual([{ login: "bob", agent: "Codex", token_hash: null, challenge: await s256(verifier) }]);
    // Deny sends the command an error, and writes nothing.
    const denied = await browser("POST", "/auth/agent", "bob", { ...f, action: "deny" });
    expect(denied.status).toBe(303);
    expect(denied.location).toBe(`http://127.0.0.1:51000/?state=${"t".repeat(20)}&error=access_denied`);
  });

  it("is swapped once, not after its minute and not without the verifier that matches its challenge; a wrong code writes nothing", async () => {
    const verifier = verifierOf("swap");
    const q = new URLSearchParams({ agent: "Gemini CLI", scopes: "contribute", port: "52000", state: "u".repeat(20), challenge: await s256(verifier) });
    const f = fields((await browser("GET", `/auth/agent?${q}`, "dave")).text);
    const g = await browser("POST", "/auth/agent", "dave", { ...f, action: "grant" });
    const code = new URL(g.location!).searchParams.get("code")!;
    expect(new URL(g.location!).searchParams.get("state")).toBe("u".repeat(20));
    const swap = (body: unknown) => raw("POST", `${ORIGIN}/auth/agent/token`, { headers: { "content-type": "application/json", "cf-connecting-ip": "10.1.1.1" }, body: JSON.stringify(body) });
    const before = await env.DB.prepare("SELECT * FROM agent_grants WHERE login = 'dave'").first();
    expect((await swap({ code: "f".repeat(64), code_verifier: verifier })).status).toBe(400);
    expect((await swap({ code, code_verifier: verifierOf("another") })).status).toBe(400);
    expect((await swap({ code })).status).toBe(400);
    expect(await env.DB.prepare("SELECT * FROM agent_grants WHERE login = 'dave'").first()).toEqual(before);
    const ok = await swap({ code, code_verifier: verifier });
    const body = (await ok.json()) as any;
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(body.token).toMatch(/^oma_[0-9a-f]{48}$/);
    expect(body).toMatchObject({ login: "dave", agent: "Gemini CLI", scopes: ["contribute"] });
    // Kept as its hash; the code and the challenge gone with the swap.
    expect(await env.DB.prepare("SELECT token_hash, code_hash, challenge FROM agent_grants WHERE id = ?").bind(body.grant).first()).toEqual({ token_hash: await sha256Hex(body.token), code_hash: null, challenge: null });
    expect((await swap({ code, code_verifier: verifier })).status).toBe(400);
    // A code past its minute is worth nothing.
    const late = verifierOf("late");
    const q2 = new URLSearchParams({ agent: "Late", scopes: "contribute", port: "52001", state: "v".repeat(20), challenge: await s256(late) });
    const g2 = await browser("POST", "/auth/agent", "dave", { ...fields((await browser("GET", `/auth/agent?${q2}`, "dave")).text), action: "grant" });
    await env.DB.prepare("UPDATE agent_grants SET code_expires_at = '2000-01-01T00:00:00.000Z' WHERE login = 'dave' AND token_hash IS NULL").run();
    expect((await swap({ code: new URL(g2.location!).searchParams.get("code"), code_verifier: late })).status).toBe(400);
    // The weekly gc deletes it through the partial index.
    const gc = await env.DB.prepare(PENDING_CODES_SQL).run();
    expect(gc.meta.changes).toBeGreaterThanOrEqual(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_grants WHERE login = 'dave' AND token_hash IS NULL").first()).toEqual({ n: 0 });
  });

  it("expires in thirty days by default and never later than ninety; review and block in seven, whatever the link asked", async () => {
    const day = 86400_000;
    const near = (iso: string, days: number) => expect(Math.abs(Date.parse(iso) - (Date.now() + days * day))).toBeLessThan(60_000);
    near((await login("erin", "One")).expires_at, 30);
    const two = await login("erin", "Two", "contribute", { days: "400" });
    kept.erinTwo = two.token;
    near(two.expires_at, 90);
    near((await login("erin", "Three", "contribute", { days: "5" })).expires_at, 5);
    const m = await login("m1", "Claude Code", "contribute,review,block", { days: "90" });
    expect(m.scopes).toEqual(["contribute", "review", "block"]);
    near(m.expires_at, 7);
    near((await login("m3", "Only block", "block")).expires_at, 7);
  });

  it("gives review and block to a maintainer only; a fourth live grant is refused until one is revoked, and a new grant of the same agent name replaces it", async () => {
    const q = new URLSearchParams({ agent: "Maintain me", scopes: "contribute,review", port: "53000", state: "w".repeat(20), challenge: await s256(verifierOf("role")) });
    const p = await browser("GET", `/auth/agent?${q}`, "frank");
    expect(p.text).toContain("review and block are granted to a maintainer only, and frank is not one");
    expect(p.text).not.toContain('value="grant"');
    expect((await browser("POST", "/auth/agent", "frank", { ...fields(p.text), action: "grant" })).status).toBe(403);
    // erin holds three live grants (the expiry test): a fourth is refused, at the page and at Grant.
    const q4 = new URLSearchParams({ agent: "Four", scopes: "contribute", port: "53001", state: "x".repeat(20), challenge: await s256(verifierOf("four")) });
    const p4 = await browser("GET", `/auth/agent?${q4}`, "erin");
    expect(p4.text).toContain("erin holds 3 live grants already");
    expect((await browser("POST", "/auth/agent", "erin", { ...fields(p4.text), action: "grant" })).status).toBe(409);
    // The same agent name again replaces that grant: still three, the old token refused.
    expect((await call("GET", "/factory/me", undefined, kept.erinTwo)).status).toBe(200);
    const again = await login("erin", "Two");
    expect((await call("GET", "/factory/me", undefined, kept.erinTwo)).json.code).toBe("grant_invalid");
    const live = (await env.DB.prepare(LIVE_GRANTS_SQL).bind("erin").all<{ agent: string }>()).results.map((g) => g.agent).sort();
    expect(live).toEqual(["One", "Three", "Two"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_grants WHERE login = 'erin' AND agent = 'Two' AND revoked_by = 'replaced'").first()).toEqual({ n: 1 });
    expect((await call("GET", "/factory/me", undefined, again.token)).status).toBe(200);
  });

  it("replaces a grant of the same agent name at the swap, once the new token exists: a Grant whose code is never swapped leaves the old grant working", async () => {
    const old = await login("dave", "Replace me");
    const q = new URLSearchParams({ agent: "Replace me", scopes: "contribute", port: "52100", state: "r".repeat(20), challenge: await s256(verifierOf("never swapped")) });
    const g = await browser("POST", "/auth/agent", "dave", { ...fields((await browser("GET", `/auth/agent?${q}`, "dave")).text), action: "grant" });
    expect(g.status, g.text.slice(0, 400)).toBe(303);
    // The command never swapped its code (closed, timed out, or its browser could not reach the loopback): the grant it was to replace still works.
    expect((await call("GET", "/factory/me", undefined, old.token)).status).toBe(200);
    expect(await env.DB.prepare("SELECT revoked_at FROM agent_grants WHERE id = ?").bind(old.grant).first()).toEqual({ revoked_at: null });
    const again = await login("dave", "Replace me");
    expect((await call("GET", "/factory/me", undefined, old.token)).json.code).toBe("grant_invalid");
    expect(await env.DB.prepare("SELECT revoked_by FROM agent_grants WHERE id = ?").bind(old.grant).first()).toEqual({ revoked_by: "replaced" });
    expect((await call("GET", "/factory/me", undefined, again.token)).status).toBe(200);
  });

  it("counts a login's Grants at the edge — the agents' binding, a key of its own — and writes no row past it", async () => {
    const keys: string[] = [];
    const q = new URLSearchParams({ agent: "Looping", scopes: "contribute", port: "52200", state: "l".repeat(20), challenge: await s256(verifierOf("looping")) });
    const f = fields((await browser("GET", `/auth/agent?${q}`, "hana")).text);
    env.AGENT_CALLS = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: !key.startsWith("grant:") }) } as unknown as RateLimit;
    const r = await browser("POST", "/auth/agent", "hana", { ...f, action: "grant" });
    expect(r.status).toBe(429);
    expect(keys).toEqual(["grant:hana"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_grants WHERE login = 'hana'").first()).toEqual({ n: 0 });
    // Deny writes nothing and is never counted.
    expect((await browser("POST", "/auth/agent", "hana", { ...f, action: "deny" })).status).toBe(303);
    expect(keys).toEqual(["grant:hana"]);
  });

  it("refuses an agent name that holds a control, format, private-use or lone surrogate character: a right-to-left override, a zero-width space, a C1 control", async () => {
    for (const bad of ["\u202eedoC edualC", "Claude\u200bCode", "Claude\u0085Code", "Claude\u2066Code", "Claude\ue000", "Claude\ud800"]) expect(agentName(bad), JSON.stringify(bad)).toBeNull();
    expect(agentName("  Claude\tCode\u00a0 ")).toBe("Claude Code");
    expect(agentName("Clåude Cöde 日本")).toBe("Clåude Cöde 日本");
    for (const bad of ["\u202eedoC edualC", "Claude\u200bCode", "Claude\u0085Code"]) {
      const q = new URLSearchParams({ agent: bad, scopes: "contribute", port: "48123", state: "s".repeat(20), challenge: await s256(verifierOf("names")), method: "S256" });
      const p = await browser("GET", `/auth/agent?${q}`, "hana");
      expect(p.status, JSON.stringify(bad)).toBe(400);
      expect(p.text).not.toContain('value="grant"');
    }
  });
});

describe("the token is worth the seven tools and nothing else", () => {
  let token = "";
  beforeAll(async () => {
    token = (await login("m2", "Claude Code", "contribute,review,block")).token;
  });

  it("is refused on every route outside its list — every decision route — with 403 and agent_token, and contributorOf never takes it", async () => {
    const routes: [string, string, unknown?][] = [
      ["POST", "/factory/tasks/1/approve", {}], ["POST", "/factory/tasks/1/reject", { note: "no" }], ["POST", "/factory/tasks/1/changes", { note: "no" }], ["POST", "/factory/tasks/1/withdraw", { note: "no" }],
      ["POST", "/factory/tasks/1/cancel", {}], ["POST", "/factory/packages/x/block", { reason: "abcd" }], ["POST", "/factory/packages/x/unblock", { reason: "abcd" }],
      ["POST", "/factory/contributors/bob/block", { reason: "abcd" }], ["POST", "/factory/contributors/bob/unblock", { reason: "abcd" }], ["POST", "/factory/workers/w/trust", {}],
      ["POST", "/factory/token", {}], ["POST", "/factory/record/withdraw", { key: "factory/x/1/request.json", reason: "abcdefgh" }], ["POST", "/factory/packages/x/adopt", {}],
      ["POST", "/factory/packages/x/category", { category: "tools" }], ["POST", "/factory/jobs", { kind: "gc" }], ["POST", "/factory/workers", { name: "w", arch: "x86_64" }],
      ["DELETE", "/factory/packages/x"], ["POST", "/factory/packages/x/build", {}], ["POST", "/factory/grants/g_00000000000000000000000000000000/revoke", {}], ["POST", "/events", {}],
      ["POST", "/factory/enqueue", {}], ["GET", "/factory/review"], ["GET", "/factory/tasks/1/artifacts/x-1.0-1-x86_64.pkg.tar.zst"], ["GET", "/users/m2/can"],
    ];
    for (const [method, path, body] of routes) {
      const r = await call(method, path, body, token);
      expect([r.status, r.json?.code], `${method} ${path}: ${JSON.stringify(r.json)}`).toEqual([403, "agent_token"]);
    }
    expect((await call("POST", "/factory/tasks/1/approve", {}, token)).json.error).toMatch(/^an agent token may not approve:/);
    // contributorOf: a request with the agent's token is nobody, the browser's session beside it or not.
    const withCookie = new Request(`${API}/factory/me`, { headers: { authorization: `Bearer ${token}`, cookie: session("m2") } });
    expect(await contributorOf(withCookie, env)).toBeNull();
    // Nor does the sign-in's own read of who is signed in take it.
    expect((await raw("GET", `${ORIGIN}/auth/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("is refused on a read the edge holds too: the answer never depends on whether someone read the URL first", async () => {
    const url = `${API}/version?agent-tools=warm`;
    expect((await raw("GET", url)).status).toBe(200);
    const hit = await raw("GET", url);
    expect([hit.status, hit.headers.get("x-pool-cache")]).toEqual([200, "hit"]);
    const r = await raw("GET", url, { headers: { authorization: `Bearer ${token}` } });
    expect([r.status, ((await r.json()) as { code: string }).code]).toEqual([403, "agent_token"]);
  });

  it("names the scope the route needs, and reads the role again on every call: a login taken out of MAINTAINERS.toml loses review and block at its next call", async () => {
    const contributor = (await login("gina", "Codex")).token;
    const d = await call("POST", "/factory/drafts", { name: "x", verdict: "block", note: "a reason" }, contributor);
    expect([d.status, d.json.code]).toEqual([403, "scope"]);
    const m3 = (await login("m3", "Claude Code", "contribute,review,block")).token;
    await env.DB.prepare("UPDATE contributors SET role = 'contributor' WHERE login = 'm3'").run();
    try {
      const r = await call("POST", "/factory/drafts", { name: "x", verdict: "block", note: "a reason" }, m3);
      expect([r.status, r.json.code]).toEqual([403, "maintainer_only"]);
      expect((await call("POST", "/factory/tasks/1/build", {}, m3)).json.code).toBe("maintainer_only");
      // What contribute allows still works: the grant is not void, the decision scopes are.
      expect((await call("GET", "/factory/me", undefined, m3)).status).toBe(200);
    } finally {
      await env.DB.prepare("UPDATE contributors SET role = 'maintainer' WHERE login = 'm3'").run();
    }
  });
});

describe("the writes through an agent", () => {
  it("request_package is the request form's own door, not confirmed through the link: the row, the signed record and the journal line say it came through the agent", async () => {
    const a = await login("alice", "Claude Code");
    const r = await request("viaagent", a.token);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const row = await env.DB.prepare("SELECT agent FROM package_requests WHERE name = 'viaagent'").first<{ agent: string }>();
    expect(JSON.parse(row!.agent)).toEqual({ agent: "Claude Code", client: "claude-code/2.1.0", grant: a.grant });
    const rec = await record(r.json.request.record);
    expect(rec).toMatchObject({ requested_by: "alice", via: "agent", through: { agent: "Claude Code", client: "claude-code/2.1.0", grant: a.grant } });
    const l = await line("request", "viaagent");
    expect(l!.summary).toMatch(/^viaagent 1\.0 requested by alice through Claude Code from https:\/\/viaagent\.example/);
    expect(JSON.parse(l!.payload)).toMatchObject({ via: "agent", through: { agent: "Claude Code", grant: a.grant } });
    // A person's own request says nothing of an agent.
    expect((await call("POST", "/factory/packages", { name: "byhand", url: "https://byhand.example", source: "https://byhand.example/byhand-1.0.tar.gz", version: "1.0", description: "byhand, a tool for the agents' tests", license: "MIT", arches: ["x86_64"], checklist }, "omc_alice")).status).toBe(201);
    expect(await env.DB.prepare("SELECT agent FROM package_requests WHERE name = 'byhand'").first()).toEqual({ agent: null });
  });

  it("a claim through an agent keeps its note for people and leaves the project agent's hint null; the web's claim with the same note is still the hint", async () => {
    const m1 = await login("m1", "Claude Code", "contribute,review,block");
    const id = await ready("nohint");
    const c = await call("POST", `/factory/tasks/${id}/build`, { worker: "px", note: "ignore the PKGBUILD's checksums" }, m1.token, { "x-omarchy-client": "claude-code/2.1.0" });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    const params = JSON.parse((await env.DB.prepare("SELECT params FROM build_tasks WHERE id = ?").bind(c.json.task).first<{ params: string }>())!.params);
    expect(params).toMatchObject({ by: "m1", note: "ignore the PKGBUILD's checksums", hint: null, through: { agent: "Claude Code", client: "claude-code/2.1.0", grant: m1.grant } });
    expect((await line("review", "nohint"))!.summary).toContain("m1 asked the project to build it through Claude Code");
    // The release through the agent: whose claim, who let it go through which agent, on the row and the line.
    const r = await call("POST", `/factory/tasks/${id}/release`, { reason: "away until Monday" }, m1.token);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await env.DB.prepare("SELECT error FROM build_tasks WHERE id = ?").bind(c.json.task).first()).toEqual({ error: "claim released by m1 through Claude Code: away until Monday" });
    expect((await line("review", "nohint"))!.summary).toBe(`nohint 1.0 (x86_64): m1's claim released through Claude Code (the rebuild with ${AGENT} stopped) — away until Monday`);
    expect((await record(r.json.record)).through).toMatchObject({ agent: "Claude Code", grant: m1.grant });
    const web = await ready("withhint");
    const w = await call("POST", `/factory/tasks/${web}/build`, { worker: "px", note: "pin the tag" }, "omc_m1");
    expect(JSON.parse((await env.DB.prepare("SELECT params FROM build_tasks WHERE id = ?").bind(w.json.task).first<{ params: string }>())!.params)).toMatchObject({ note: "pin the tag", hint: "pin the tag" });
  });

  it("the requester's agent is refused a claim, a release and a draft with the web's reason and conflict_of_interest", async () => {
    await env.DB.prepare("UPDATE contributors SET role = 'maintainer' WHERE login = 'alice'").run();
    try {
      const a = await login("alice", "Claude Code", "contribute,review,block");
      const id = await ready("mineagain");
      const refusal = { error: "you brought mineagain — another maintainer decides; with one maintainer, that maintainer's own packages wait", code: "conflict_of_interest" };
      expect(await call("POST", `/factory/tasks/${id}/build`, {}, a.token).then((r) => [r.status, r.json])).toEqual([403, refusal]);
      for (const verdict of ["request_changes", "reject"]) expect(await call("POST", "/factory/drafts", { name: "mineagain", task: id, verdict, note: "my own" }, a.token).then((r) => [r.status, r.json]), verdict).toEqual([403, refusal]);
      expect((await call("POST", `/factory/tasks/${id}/build`, { worker: "px" }, "omc_m1")).status).toBe(200);
      expect(await call("POST", `/factory/tasks/${id}/release`, { reason: "let mine go" }, a.token).then((r) => [r.status, r.json])).toEqual([403, refusal]);
    } finally {
      await env.DB.prepare("UPDATE contributors SET role = 'contributor' WHERE login = 'alice'").run();
    }
  });
});

describe("a draft", () => {
  let m1 = { token: "", grant: "" };
  beforeAll(async () => {
    m1 = await login("m1", "Claude Code", "contribute,review,block");
    // m1 confirms approve and block with a passkey (#257): a security key that counts, and a synced passkey that keeps no counter.
    await registerPasskey("m1");
    await registerPasskey("m1", { keepsCounter: false });
  });

  it("decides nothing, writes no journal line, and is shown to its own person only", async () => {
    const { project } = await reviewed("drafted");
    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    const d = await call("POST", "/factory/drafts", { name: "drafted", task: project, verdict: "approve", note: "reads well" }, m1.token, { "x-omarchy-client": "claude-code/2.1.0" });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    expect(d.json).toMatchObject({ state: "waiting", verdict: "approve", name: "drafted", task: project, confirm_url: `${ORIGIN}/auth/confirm/${d.json.draft}` });
    expect(d.json.draft).toMatch(/^d_[0-9a-f]{32}$/);
    expect(Math.abs(Date.parse(d.json.expires_at) - (Date.now() + 30 * 60_000))).toBeLessThan(60_000);
    expect(d.json.next).toBe("Open the link in a browser signed in as m1 and confirm. Nothing is decided until then.");
    // Nothing decided, nothing journaled.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first()).toEqual(events);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE task_id = ?").bind(project).first()).toEqual({ n: 0 });
    // The public journal and the person's public page never show it; their own /factory/me does, and their agent reads it by its id.
    expect(JSON.stringify((await call("GET", "/events?limit=200")).json)).not.toContain(d.json.draft);
    expect(JSON.stringify((await call("GET", "/users/m1")).json)).not.toContain(d.json.draft);
    const me = await call("GET", "/factory/me", undefined, "omc_m1");
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(me.json.drafts.find((x: any) => x.id === d.json.draft)).toMatchObject({ state: "waiting", verdict: "approve", agent: "Claude Code", client: "claude-code/2.1.0" });
    expect(me.json.grants.find((g: any) => g.id === m1.grant)).toMatchObject({ agent: "Claude Code", state: "live", scopes: ["contribute", "review", "block"] });
    expect((await call("GET", `/factory/drafts/${d.json.draft}`, undefined, m1.token)).json).toMatchObject({ state: "waiting" });
    const m2 = await login("m2", "Other", "contribute,review");
    expect((await call("GET", `/factory/drafts/${d.json.draft}`, undefined, m2.token)).status).toBe(404);
    expect((await call("GET", "/factory/me", undefined, "omc_m2")).json.drafts.map((x: any) => x.id)).not.toContain(d.json.draft);
  });

  it("is confirmed only by the same login in the browser — the session, its Origin, the nonce — once; the decision's row, record and line carry the agent", async () => {
    const { project } = await reviewed("confirmed");
    const d = (await call("POST", "/factory/drafts", { name: "confirmed", task: project, verdict: "approve", note: "reads well" }, m1.token, { "x-omarchy-client": "claude-code/2.1.0" })).json;
    // Nobody signed in is sent to sign in; another login, a token, another Origin, a stale nonce are refused.
    const nobody = await browser("GET", `/auth/confirm/${d.draft}`, null);
    expect([nobody.status, nobody.location]).toEqual([302, `/auth/github?next=${encodeURIComponent(`/auth/confirm/${d.draft}`)}`]);
    expect((await confirmPage(d.draft, "m2")).status).toBe(403);
    expect((await confirmPage(d.draft, "m2")).text).not.toContain("reads well");
    expect((await browser("GET", `/auth/confirm/${d.draft}`, "m1", undefined, { bearer: m1.token })).status).toBe(403);
    const page = await confirmPage(d.draft, "m1");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.text).toContain("Approve confirmed?");
    expect(page.text).toContain("reads well");
    expect(page.text).toContain(`href="/build/${project}"`);
    expect(page.text).toContain("its client says: claude-code/2.1.0");
    const f = fields(page.text);
    expect((await browser("POST", `/auth/confirm/${d.draft}`, "m1", { ...f, action: "confirm" }, { bearer: m1.token })).status).toBe(403);
    expect((await browser("POST", `/auth/confirm/${d.draft}`, "m1", { ...f, action: "confirm" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await browser("POST", `/auth/confirm/${d.draft}`, "m1", { nonce: "x".repeat(43), action: "confirm" })).status).toBe(403);
    expect((await browser("POST", `/auth/confirm/${d.draft}`, "m2", { ...f, action: "confirm" })).status).toBe(403);
    expect(await env.DB.prepare("SELECT state, used_at FROM drafts WHERE id = ?").bind(d.draft).first()).toEqual({ state: "waiting", used_at: null });
    // The person, in the browser, with their passkey.
    const ok = await browser("POST", `/auth/confirm/${d.draft}`, "m1", { ...f, ...(await signed(d.draft, "m1")), action: "confirm" });
    expect(ok.status, ok.text.slice(0, 800)).toBe(200);
    expect(ok.text).toContain("confirmed approved by m1 — drafted by Claude Code, confirmed in the browser with a passkey.");
    const row = await env.DB.prepare("SELECT agent, by FROM approvals WHERE task_id = ?").bind(project).first<{ agent: string; by: string }>();
    expect(row!.by).toBe("m1");
    expect(JSON.parse(row!.agent)).toMatchObject({ agent: "Claude Code", client: "claude-code/2.1.0", grant: m1.grant, draft: d.draft });
    const l = await line("approve", "confirmed");
    expect(l!.summary).toMatch(/^confirmed 1\.0 \(x86_64\) approved by m1 — drafted by Claude Code, confirmed in the browser/);
    const payload = JSON.parse(l!.payload);
    expect(payload).toMatchObject({ by: "m1", via: "web", through: { agent: "Claude Code", draft: d.draft, drafted_at: expect.any(String), confirmed_at: expect.any(String), passkey: passkeys.m1[0].id } });
    expect(await record(payload.record)).toMatchObject({ decision: "approve", by: "m1", via: "web", through: { draft: d.draft, grant: m1.grant, passkey: passkeys.m1[0].id } });
    expect(await env.DB.prepare("SELECT state FROM drafts WHERE id = ?").bind(d.draft).first()).toEqual({ state: "confirmed" });
    // Once: again is 409, and nothing more is decided.
    const again = await browser("POST", `/auth/confirm/${d.draft}`, "m1", { ...f, action: "confirm" });
    expect(again.status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE task_id = ?").bind(project).first()).toEqual({ n: 1 });
  });

  it("sent twice at once makes one approval, one publish job and one journal line; the second is answered 409", async () => {
    const { project } = await reviewed("atonce");
    const d = (await call("POST", "/factory/drafts", { name: "atonce", task: project, verdict: "approve", note: "reads well" }, m1.token)).json;
    const f = fields((await confirmPage(d.draft, "m1")).text);
    // Two answers of the passkey that keeps no counter, each for a challenge of its own: both are good, and the draft decides once.
    const [x, y] = [await signed(d.draft, "m1", { with: passkeys.m1[1].a }), await signed(d.draft, "m1", { with: passkeys.m1[1].a })];
    const [a, b] = await Promise.all([browser("POST", `/auth/confirm/${d.draft}`, "m1", { ...f, ...x, action: "confirm" }), browser("POST", `/auth/confirm/${d.draft}`, "m1", { ...f, ...y, action: "confirm" })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE name = 'atonce'").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE name = 'atonce' AND kind = 'publish'").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'approve' AND json_extract(payload, '$.name') = 'atonce'").first()).toEqual({ n: 1 });
  });

  it("a rejection and a block are confirmed with the package's name typed; without it nothing is decided", async () => {
    const { contributor } = await reviewed("typed");
    const rej = (await call("POST", "/factory/drafts", { name: "typed", task: contributor, verdict: "reject", note: "not a project of its own" }, m1.token)).json;
    const page = await confirmPage(rej.draft, "m1");
    expect(page.text).toContain('name="name"');
    expect((await confirm(rej.draft, "m1")).status).toBe(400);
    expect((await confirm(rej.draft, "m1", { name: "typo" })).status).toBe(400);
    expect(await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'typed'").first()).toEqual({ status: "staged" });
    const ok = await confirm(rej.draft, "m1", { name: "typed" });
    expect(ok.status, ok.text.slice(0, 600)).toBe(200);
    expect((await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'typed'").first<{ status: string }>())!.status).toBe("rejected");
    expect((await line("approve", "typed"))!.summary).toContain("rejected by m1 — drafted by Claude Code, confirmed in the browser");
    // A block, the same way; its record and line carry the agent.
    const blk = (await call("POST", "/factory/drafts", { name: "viaagent", verdict: "block", note: "ships a token stealer" }, m1.token)).json;
    expect(blk.task).toBeNull();
    expect((await confirm(blk.draft, "m1")).status).toBe(400);
    expect(await env.DB.prepare("SELECT blocked_at FROM factory_packages WHERE name = 'viaagent'").first()).toEqual({ blocked_at: null });
    const b = await confirm(blk.draft, "m1", { name: "viaagent" });
    expect(b.status, b.text.slice(0, 600)).toBe(200);
    expect((await env.DB.prepare("SELECT blocked_by FROM factory_packages WHERE name = 'viaagent'").first())).toEqual({ blocked_by: "m1" });
    const l = await line("block", "viaagent");
    expect(l!.summary).toMatch(/^viaagent blocked by m1 — drafted by Claude Code, confirmed in the browser with a passkey: ships a token stealer/);
    expect(await record(JSON.parse(l!.payload).record)).toMatchObject({ decision: "block", through: { draft: blk.draft, passkey: passkeys.m1[0].id } });
  });

  it("runs the predicate again on the facts of now, and is refused once decided in the meantime; discarded or expired, nothing is decided", async () => {
    const { project, contributor } = await reviewed("meantime");
    const d = (await call("POST", "/factory/drafts", { name: "meantime", task: project, verdict: "approve", note: "reads well" }, m1.token)).json;
    // Another maintainer decides on the web first.
    expect((await call("POST", `/factory/tasks/${contributor}/changes`, { note: "pin the tag" }, "omc_m3")).status).toBe(200);
    const page = await confirmPage(d.draft, "m1");
    expect(page.text).toContain("It cannot be confirmed now.");
    // A page opened before, posted now: the passkey answers, and the predicate refuses.
    const r = await browser("POST", `/auth/confirm/${d.draft}`, "m1", { ...fields(page.text), ...(await signed(d.draft, "m1")), action: "confirm" });
    expect(r.status).toBe(409);
    expect(await env.DB.prepare("SELECT state FROM drafts WHERE id = ?").bind(d.draft).first()).toEqual({ state: "refused" });
    expect((await call("GET", "/factory/me", undefined, "omc_m1")).json.drafts.find((x: any) => x.id === d.draft)).toMatchObject({ state: "refused", outcome: { error: expect.stringMatching(/not staged/) } });
    // Discarded: nothing decided, and it cannot be confirmed after.
    const { project: p2 } = await reviewed("discarded");
    const d2 = (await call("POST", "/factory/drafts", { name: "discarded", task: p2, verdict: "approve", note: "reads well" }, m1.token)).json;
    const f2 = fields((await confirmPage(d2.draft, "m1")).text);
    expect((await browser("POST", `/auth/confirm/${d2.draft}`, "m1", { ...f2, action: "discard" })).status).toBe(200);
    expect((await browser("POST", `/auth/confirm/${d2.draft}`, "m1", { ...f2, action: "confirm" })).status).toBe(409);
    // Expired: thirty minutes, then nothing.
    const d3 = (await call("POST", "/factory/drafts", { name: "discarded", task: p2, verdict: "approve", note: "reads well" }, m1.token)).json;
    const f3 = fields((await confirmPage(d3.draft, "m1")).text);
    await env.DB.prepare("UPDATE drafts SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(d3.draft).run();
    expect((await browser("POST", `/auth/confirm/${d3.draft}`, "m1", { ...f3, action: "confirm" })).status).toBe(410);
    expect((await call("GET", `/factory/drafts/${d3.draft}`, undefined, m1.token)).json.state).toBe("expired");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE name = 'discarded'").first()).toEqual({ n: 0 });
  });

  it("bad arguments are refused before the day counts or the predicate: a verdict outside the four, a short note, no task", async () => {
    const count = () => env.DB.prepare("SELECT agent_day, agent_drafts FROM contributors WHERE login = 'm1'").first();
    const before = await count();
    for (const body of [{ name: "x", verdict: "merge", note: "abcd" }, { name: "x", verdict: "approve", note: "ab", task: 1 }, { name: "x", verdict: "approve", note: "abcd" }, { name: "x", verdict: "reject", note: "abcd", task: "12" }]) {
      expect((await call("POST", "/factory/drafts", body, m1.token)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await count()).toEqual(before);
  });

  it("covers every architecture of the package: the confirm page draws each one the decision decides, and each of the decision's rows carries the agent — served as through, never as agent", async () => {
    expect((await call("POST", "/factory/packages", { name: "twoarch", url: "https://twoarch.example", source: "https://twoarch.example/twoarch-1.0.tar.gz", version: "1.0", description: "twoarch, a tool for the agents' tests", license: "MIT", arches: ["x86_64", "aarch64"], checklist }, "omc_alice")).status).toBe(201);
    const cx = await claimAs("omw_cx", "twoarch", "x86_64");
    await stage(cx, "alice");
    const ca = await claimAs("omw_cxa", "twoarch", "aarch64");
    await stage(ca, "alice");
    expect((await call("POST", `/factory/tasks/${cx.task.id}/build`, { worker: "px" }, "omc_m2")).status).toBe(200);
    const px = await claimAs("omw_px", "twoarch", "x86_64");
    await stage(px, "the project");
    const pa = await claimAs("omw_pxa", "twoarch", "aarch64");
    await stage(pa, "the project");
    const d = (await call("POST", "/factory/drafts", { name: "twoarch", task: px.task.id, verdict: "approve", note: "reads well" }, m1.token)).json;
    expect(d.state, JSON.stringify(d)).toBe("waiting");
    const page = await confirmPage(d.draft, "m1");
    expect(page.text).toContain("One review decides every architecture: confirming decides all 2 below.");
    for (const id of [cx.task.id, ca.task.id, px.task.id, pa.task.id]) expect(page.text, String(id)).toContain(`href="/build/${id}"`);
    expect(page.text.indexOf("<th colspan=\"2\">x86_64</th>")).toBeLessThan(page.text.indexOf("<th colspan=\"2\">aarch64</th>"));
    const ok = await browser("POST", `/auth/confirm/${d.draft}`, "m1", { ...fields(page.text), ...(await signed(d.draft, "m1")), action: "confirm" });
    expect(ok.status, ok.text.slice(0, 800)).toBe(200);
    const rows = (await env.DB.prepare("SELECT arch, agent FROM approvals WHERE name = 'twoarch' ORDER BY arch").all<{ arch: string; agent: string }>()).results;
    expect(rows.map((r) => [r.arch, JSON.parse(r.agent).draft, JSON.parse(r.agent).agent])).toEqual([["aarch64", d.draft, "Claude Code"], ["x86_64", d.draft, "Claude Code"]]);
    // The public record serves the column parsed, as `through`; `agent` keeps #247's meaning (the rebuild's), and is not the column.
    const pub = (await call("GET", `/factory/approvals?t=${Date.now()}`)).json.approvals.find((a: any) => a.name === "twoarch");
    expect(pub.through).toMatchObject({ agent: "Claude Code", client: null, grant: m1.grant, draft: d.draft });
    expect(pub).not.toHaveProperty("agent");
    const web = (await call("GET", `/factory/approvals?t=${Date.now()}`)).json.approvals.find((a: any) => a.name === "atonce");
    expect(web.through).toMatchObject({ draft: expect.any(String) });
    expect((await call("GET", `/users/m1?t=${Date.now()}`)).json.approvals.find((a: any) => a.name === "twoarch").through).toMatchObject({ draft: d.draft });
  });

  it("is refused when the package moved since the draft — here the project's rebuild staged while a request for changes waited — and nothing is decided", async () => {
    const id = await ready("moved");
    expect((await call("POST", `/factory/tasks/${id}/build`, { worker: "px", note: "pin the tag" }, "omc_m2")).status).toBe(200);
    const rb = await claimAs("omw_px", "moved");
    const d = (await call("POST", "/factory/drafts", { name: "moved", task: id, verdict: "request_changes", note: "pin the tag" }, m1.token)).json;
    expect(d.state, JSON.stringify(d)).toBe("waiting");
    await stage(rb, "the project");
    const page = await confirmPage(d.draft, "m1");
    expect(page.text).toContain("It cannot be confirmed now.");
    expect(page.text).toContain("moved changed since Claude Code drafted this");
    const r = await browser("POST", `/auth/confirm/${d.draft}`, "m1", { ...fields(page.text), action: "confirm" });
    expect(r.status).toBe(409);
    expect(await env.DB.prepare("SELECT state FROM drafts WHERE id = ?").bind(d.draft).first()).toEqual({ state: "refused" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE name = 'moved'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT status FROM build_tasks WHERE id = ?").bind(rb.task.id).first()).toEqual({ status: "staged" });
  });

  it("says what became of it when the decision's handler fails: refused with nothing decided before the decision, confirmed with the decision standing after it — never confirmed with nothing decided", async () => {
    const real = env.DB;
    const failing = (at: string) =>
      new Proxy(real, {
        get(t, p) {
          if (p === "prepare") return (sql: string) => { if (sql.startsWith(at)) throw new Error("D1_ERROR: the database went away"); return t.prepare(sql); };
          const v = Reflect.get(t, p, t);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }) as D1Database;
    const attempt = async (name: string, at: string) => {
      const { project } = await reviewed(name);
      const d = (await call("POST", "/factory/drafts", { name, task: project, verdict: "approve", note: "reads well" }, m1.token)).json;
      const f = { ...fields((await confirmPage(d.draft, "m1")).text), ...(await signed(d.draft, "m1")) };
      env.DB = failing(at);
      try {
        return { d, r: await browser("POST", `/auth/confirm/${d.draft}`, "m1", { ...f, action: "confirm" }) };
      } finally {
        env.DB = real;
      }
    };
    // The handler's first read fails: nothing was decided, and the draft says refused.
    const before = await attempt("failsbefore", "SELECT * FROM build_tasks WHERE id = ?");
    expect(before.r.status).toBe(500);
    expect(before.r.text).toContain("nothing was decided");
    expect(await env.DB.prepare("SELECT state, json_extract(outcome, '$.status') AS status FROM drafts WHERE id = ?").bind(before.d.draft).first()).toEqual({ state: "refused", status: 500 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE name = 'failsbefore'").first()).toEqual({ n: 0 });
    // The publish job's insert fails after the decision was taken: it stands, and the draft says confirmed, with what failed.
    const after = await attempt("failsafter", "INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish");
    expect(after.r.status).toBe(500);
    expect(after.r.text).toContain("was decided, then the pool failed");
    expect(await env.DB.prepare("SELECT state, json_extract(outcome, '$.status') AS status FROM drafts WHERE id = ?").bind(after.d.draft).first()).toEqual({ state: "confirmed", status: 500 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE name = 'failsafter' AND json_extract(agent, '$.draft') = ?").bind(after.d.draft).first()).toEqual({ n: 1 });
  });
});

describe("a passkey for approve and block (#257)", () => {
  let m1 = { token: "", grant: "" }, m3 = { token: "", grant: "" };
  beforeAll(async () => {
    m1 = await login("m1", "Claude Code", "contribute,review,block");
    m3 = await login("m3", "Codex", "contribute,review,block");
  });
  // m3's grant goes when the passkey's tests are done: a login holds three live grants, and the limits' tests log m3 in again.
  afterAll(async () => {
    expect((await call("POST", `/factory/grants/${m3.grant}/revoke`, {}, "omc_m3")).status).toBe(200);
  });
  const approveDraft = async (as: { token: string }, name: string) => {
    const { project } = await reviewed(name);
    const d = (await call("POST", "/factory/drafts", { name, task: project, verdict: "approve", note: "reads well" }, as.token)).json;
    expect(d.state, JSON.stringify(d)).toBe("waiting");
    return d.draft as string;
  };
  const blockDraft = async (as: { token: string }, name: string) => {
    await ready(name);
    const d = (await call("POST", "/factory/drafts", { name, verdict: "block", note: "ships a token stealer" }, as.token)).json;
    expect(d.state, JSON.stringify(d)).toBe("waiting");
    return d.draft as string;
  };
  const post = async (id: string, who: string, extra: Record<string, string>) => browser("POST", `/auth/confirm/${id}`, who, { ...fields((await confirmPage(id, who)).text), action: "confirm", ...extra });
  const nothing = async (id: string, name: string) => {
    expect(await env.DB.prepare("SELECT state, used_at FROM drafts WHERE id = ?").bind(id).first(), `${name}'s draft`).toEqual({ state: "waiting", used_at: null });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE name = ?").bind(name).first(), `${name}'s approvals`).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT blocked_at FROM factory_packages WHERE name = ?").bind(name).first(), `${name}'s block`).toEqual({ blocked_at: null });
  };

  it("confirms approve and block with a valid assertion — the stored key, a challenge for this draft, this origin and RP id, the user verified — and the decision's row, record and line say so; the passkey's counter and last use move", async () => {
    const key = passkeys.m1[0];
    const was = await env.DB.prepare("SELECT counter FROM passkeys WHERE id = ?").bind(key.id).first<{ counter: number }>();
    const d = await approveDraft(m1, "pkapprove");
    const page = await confirmPage(d, "m1");
    // The page asks for the passkey, with its script, and offers no Confirm without it.
    expect(page.text).toContain('id="pk-confirm"');
    expect(page.text).toContain("Confirm with your passkey: approve pkapprove");
    expect(page.text).toContain("navigator.credentials.get");
    expect(page.text).not.toContain('value="confirm"');
    const ok = await post(d, "m1", await signed(d, "m1"));
    expect(ok.status, ok.text.slice(0, 600)).toBe(200);
    expect(ok.text).toContain("pkapprove approved by m1 — drafted by Claude Code, confirmed in the browser with a passkey.");
    const row = await env.DB.prepare("SELECT agent FROM approvals WHERE name = 'pkapprove'").first<{ agent: string }>();
    expect(JSON.parse(row!.agent)).toMatchObject({ draft: d, passkey: key.id });
    expect((await line("approve", "pkapprove"))!.summary).toContain("approved by m1 — drafted by Claude Code, confirmed in the browser with a passkey");
    const now = await env.DB.prepare("SELECT counter, last_used FROM passkeys WHERE id = ?").bind(key.id).first<{ counter: number; last_used: string | null }>();
    expect(now!.counter).toBe(key.a.counter);
    expect(now!.counter).toBeGreaterThan(was!.counter);
    expect(now!.last_used).not.toBeNull();
    // The person's own /factory/me lists the passkey and its last use; the same answer to their agent carries none.
    expect((await call("GET", "/factory/me", undefined, "omc_m1")).json.passkeys.find((p: any) => p.id === key.id)).toMatchObject({ alg: "ES256", last_used: now!.last_used });
    expect((await call("GET", "/factory/me", undefined, m1.token)).json).not.toHaveProperty("passkeys");
    // A block, the same way, with the name typed.
    const b = await blockDraft(m1, "pkblock");
    const blocked = await post(b, "m1", { ...(await signed(b, "m1")), name: "pkblock" });
    expect(blocked.status, blocked.text.slice(0, 600)).toBe(200);
    expect(await env.DB.prepare("SELECT blocked_by FROM factory_packages WHERE name = 'pkblock'").first()).toEqual({ blocked_by: "m1" });
    const l = await line("block", "pkblock");
    expect(l!.summary).toMatch(/^pkblock blocked by m1 — drafted by Claude Code, confirmed in the browser with a passkey: ships a token stealer/);
    expect(JSON.parse(l!.payload).through).toMatchObject({ draft: b, passkey: key.id });
  });

  it("refuses a replayed answer: its challenge is taken by the first request that brings it, whatever that request decides", async () => {
    const d = await blockDraft(m1, "pkreplay");
    const x = await signed(d, "m1");
    // The first request brings a good answer but no typed name: refused for the name, and the challenge is spent.
    expect((await post(d, "m1", x)).status).toBe(400);
    const again = await post(d, "m1", { ...x, name: "pkreplay" });
    expect(again.status).toBe(403);
    expect(again.text).toContain("was used already");
    await nothing(d, "pkreplay");
    // A challenge of another draft is not this one's.
    const other = await approveDraft(m1, "pkother");
    const theirs = await signed(other, "m1");
    const crossed = await post(d, "m1", { ...theirs, name: "pkreplay" });
    expect(crossed.status).toBe(403);
    await nothing(d, "pkreplay");
    // Nor is a challenge past its five minutes.
    const nonce = fields((await confirmPage(d, "m1")).text).nonce;
    const late = (await challengeFor(d, "m1", nonce)).json.publicKey.challenge;
    await env.DB.prepare("UPDATE passkey_challenges SET expires_at = '2000-01-01T00:00:00.000Z' WHERE challenge = ?").bind(late).run();
    const expired = await post(d, "m1", { ...(await answer(passkeys.m1[0].a, { challenge: late, origin: ORIGIN, rpId: "localhost" })), name: "pkreplay" });
    expect(expired.status).toBe(403);
    await nothing(d, "pkreplay");
    // A fresh answer confirms it.
    expect((await post(d, "m1", { ...(await signed(d, "m1")), name: "pkreplay" })).status).toBe(200);
  });

  it("refuses an answer made on another origin, for another RP id, without the user verified or present, or of a registration — the draft still waits, nothing is decided", async () => {
    const d = await approveDraft(m1, "pkwrong");
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["another origin", { origin: "https://evil.example" }, /made on &quot;https:\/\/evil\.example&quot;/],
      ["the right name over http on another port", { origin: "http://localhost:9999" }, /not http:\/\/localhost:8787/],
      ["another RP id", { signRpId: "evil.example" }, /another relying party/],
      ["no user verification", { flags: UP }, /did not verify the user/],
      ["nobody present", { flags: UV }, /nobody was present/],
      ["a registration's type", { type: "webauthn.create" }, /not webauthn\.get/],
      ["a frame of another site", { crossOrigin: true }, /frame of another site/],
    ];
    for (const [what, wrong, said] of cases) {
      const r = await post(d, "m1", await signed(d, "m1", { answer: wrong }));
      expect(r.status, what).toBe(403);
      expect(r.text, what).toMatch(said);
      await nothing(d, "pkwrong");
    }
    // Without any answer: asked for, not skipped.
    const none = await post(d, "m1", {});
    expect([none.status, none.text.includes("Confirm with your passkey")]).toEqual([403, true]);
    await nothing(d, "pkwrong");
    expect((await post(d, "m1", await signed(d, "m1"))).status).toBe(200);
  });

  it("refuses a key of another login, a removed key, and a key whose counter went backwards", async () => {
    const m2key = await registerPasskey("m2");
    const d = await approveDraft(m1, "pkanother");
    const theirs = await post(d, "m1", await signed(d, "m1", { with: m2key.a }));
    expect([theirs.status, theirs.text.includes("not one of m1&#39;s") || theirs.text.includes("not one of m1's")]).toEqual([403, true]);
    await nothing(d, "pkanother");
    // A signature of m2's key under m1's credential id: the stored key does not verify it.
    const forged = await post(d, "m1", await signed(d, "m1", { answer: { signer: m2key.a, credentialId: passkeys.m1[0].a.credentialId } }));
    expect([forged.status, forged.text.includes("not the passkey")]).toEqual([403, true]);
    await nothing(d, "pkanother");
    // The counter: behind the stored one is a copy of the key.
    const key = passkeys.m1[0];
    const stored = (await env.DB.prepare("SELECT counter FROM passkeys WHERE id = ?").bind(key.id).first<{ counter: number }>())!.counter;
    const back = await post(d, "m1", await signed(d, "m1", { answer: { counter: stored - 1 } }));
    expect([back.status, back.text.includes("counter went from")]).toEqual([403, true]);
    const same = await post(d, "m1", await signed(d, "m1", { answer: { counter: stored } }));
    expect(same.status).toBe(403);
    await nothing(d, "pkanother");
    key.a.counter = stored;
    // A passkey removed on the person's page answers nothing after.
    const spare = await registerPasskey("m1");
    const removed = await raw("POST", `${ORIGIN}/auth/passkeys/${spare.id}/remove`, { headers: { cookie: session("m1"), origin: ORIGIN } });
    expect(removed.status).toBe(200);
    const gone = await post(d, "m1", await signed(d, "m1", { with: spare.a }));
    expect(gone.status).toBe(403);
    await nothing(d, "pkanother");
    expect((await post(d, "m1", await signed(d, "m1"))).status).toBe(200);
  });

  it("is asked for, never skipped: a maintainer without a passkey is told to register one — on the page, at the POST and at the challenge — with the link, and nothing is decided", async () => {
    const d = await approveDraft(m3, "nopasskey");
    const page = await confirmPage(d, "m3");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Register a passkey first.");
    expect(page.text).toContain('href="/user/m3#passkeys"');
    expect(page.text).not.toContain('id="pk-confirm"');
    expect(page.text).not.toContain('value="confirm"');
    expect(page.text).toContain('value="discard"');
    const r = await post(d, "m3", {});
    expect(r.status).toBe(403);
    expect(r.text).toContain("Register a passkey first");
    expect(r.text).toContain("You have none yet.");
    expect(r.text).toContain('href="/user/m3#passkeys"');
    await nothing(d, "nopasskey");
    const ch = await challengeFor(d, "m3", fields(page.text).nonce);
    expect([ch.status, ch.json.code, ch.json.register]).toEqual([403, "no_passkey", "/user/m3#passkeys"]);
    // Somebody else's answer does not stand in for one: the passkey must be m3's.
    const forged = await post(d, "m3", await answer(passkeys.m1[0].a, { challenge: "x".repeat(43), origin: ORIGIN, rpId: "localhost" }));
    expect(forged.status).toBe(403);
    await nothing(d, "nopasskey");
    // A block the same.
    const b = await blockDraft(m3, "nopasskeyblock");
    expect((await confirmPage(b, "m3")).text).toContain("Register a passkey first.");
    const rb = await post(b, "m3", { name: "nopasskeyblock" });
    expect([rb.status, rb.text.includes("Register a passkey first")]).toEqual([403, true]);
    await nothing(b, "nopasskeyblock");
  });

  it("is offered on the relying party's address only: elsewhere the page says where, and a POST there decides nothing", async () => {
    const d = await approveDraft(m1, "elsewhere");
    const at = async (method: string, form?: Record<string, string>) => {
      const res = await raw(method, `http://pool.test/auth/confirm/${d}`, { headers: { cookie: session("m1"), ...(form ? { origin: "http://pool.test", "content-type": "application/x-www-form-urlencoded" } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined });
      return { status: res.status, text: await res.text() };
    };
    const page = await at("GET");
    expect(page.text).toContain("Not on this address.");
    expect(page.text).not.toContain('id="pk-confirm"');
    const r = await at("POST", { ...fields(page.text), action: "confirm", ...(await signed(d, "m1")) });
    expect([r.status, r.text.includes("Not on this address")]).toEqual([403, true]);
    await nothing(d, "elsewhere");
  });

  it("request changes and reject are confirmed as before — the session and, for a rejection, the name typed — by a maintainer without a passkey", async () => {
    const { contributor } = await reviewed("pkchanges");
    const c = (await call("POST", "/factory/drafts", { name: "pkchanges", task: contributor, verdict: "request_changes", note: "pin the tag" }, m3.token)).json;
    const page = await confirmPage(c.draft, "m3");
    expect(page.text).toContain("Confirm: request changes on pkchanges");
    expect(page.text).not.toContain("passkey");
    expect((await challengeFor(c.draft, "m3", fields(page.text).nonce)).json.code).toBe("no_passkey_needed");
    const ok = await confirm(c.draft, "m3");
    expect(ok.status, ok.text.slice(0, 600)).toBe(200);
    expect(ok.text).toContain("confirmed in the browser.");
    expect(ok.text).not.toContain("with a passkey");
    const { contributor: r } = await reviewed("pkreject");
    const rej = (await call("POST", "/factory/drafts", { name: "pkreject", task: r, verdict: "reject", note: "not a project of its own" }, m3.token)).json;
    expect((await confirm(rej.draft, "m3")).status).toBe(400);
    expect((await confirm(rej.draft, "m3", { name: "pkreject" })).status).toBe(200);
    expect((await line("approve", "pkreject"))!.summary).toMatch(/rejected by m3 — drafted by Codex, confirmed in the browser(?! with a passkey)/);
  });

  it("its challenge is asked from the draft's own page: the session only, its Origin and nonce, the same login; five live at most", async () => {
    const d = await approveDraft(m1, "pkchallenge");
    const nonce = fields((await confirmPage(d, "m1")).text).nonce;
    expect((await challengeFor(d, "m1", nonce, { bearer: m1.token })).json.code).toBe("session_only");
    expect((await challengeFor(d, "m1", nonce, { origin: "https://evil.example" })).json.code).toBe("origin");
    expect((await challengeFor(d, "m1", nonce, { origin: null })).json.code).toBe("origin");
    expect((await challengeFor(d, "m1", "x".repeat(43))).json.code).toBe("nonce");
    expect((await challengeFor(d, "m2", nonce)).status).toBe(404);
    const anon = await raw("POST", `${ORIGIN}/auth/confirm/${d}/challenge`, { headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: `nonce=${nonce}` });
    expect(anon.status).toBe(401);
    const first = await challengeFor(d, "m1", nonce);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.json.publicKey).toMatchObject({ rpId: "localhost", userVerification: "required", timeout: 120000 });
    expect(first.json.publicKey.allowCredentials.map((c: any) => c.id).sort()).toEqual((await env.DB.prepare("SELECT credential_id FROM passkeys WHERE login = 'm1'").all<{ credential_id: string }>()).results.map((r) => r.credential_id).sort());
    expect(await env.DB.prepare("SELECT login, purpose, draft_id FROM passkey_challenges WHERE challenge = ?").bind(first.json.publicKey.challenge).first()).toEqual({ login: "m1", purpose: "confirm", draft_id: d });
    await env.DB.prepare("DELETE FROM passkey_challenges WHERE login = 'm1'").run();
    for (let i = 0; i < 5; i++) expect((await challengeFor(d, "m1", nonce)).status).toBe(200);
    const sixth = await challengeFor(d, "m1", nonce);
    expect([sixth.status, sixth.json.code]).toEqual([429, "rate_limited"]);
    await env.DB.prepare("DELETE FROM passkey_challenges WHERE login = 'm1'").run();
    // A draft decided or expired asks for none.
    await env.DB.prepare("UPDATE drafts SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(d).run();
    expect((await challengeFor(d, "m1", nonce)).status).toBe(410);
  });
});

describe("revocation", () => {
  it("logout, Revoke on the person's page and a contributor's block each end a grant at once", async () => {
    const a = await login("carol", "One");
    expect((await call("GET", "/factory/me", undefined, a.token)).status).toBe(200);
    const out = await raw("POST", `${ORIGIN}/auth/agent/revoke`, { headers: { authorization: `Bearer ${a.token}` } });
    expect(out.status).toBe(200);
    expect((await call("GET", "/factory/me", undefined, a.token)).json.code).toBe("grant_invalid");
    const b = await login("carol", "Two");
    expect((await call("POST", `/factory/grants/${b.grant}/revoke`, {}, "omc_bob")).status).toBe(404);
    expect((await call("POST", `/factory/grants/${b.grant}/revoke`, {}, "omc_carol")).json).toMatchObject({ revoked: b.grant, by: "carol" });
    expect((await call("GET", "/factory/me", undefined, b.token)).status).toBe(401);
    const c = await login("carol", "Three");
    expect((await call("POST", "/factory/contributors/carol/block", { reason: "a token stealer" }, "omc_m1")).status).toBe(200);
    expect((await call("GET", "/factory/me", undefined, c.token)).status).toBe(401);
    expect(await env.DB.prepare("SELECT revoked_by FROM agent_grants WHERE id = ?").bind(c.grant).first()).toEqual({ revoked_by: "blocked" });
  });

  it("Revoke on the page, logout and a new login under the same name discard the grant's waiting drafts in the same batch; a draft whose grant was revoked otherwise is refused at the confirm", async () => {
    const drafted = async (name: string, token: string) => {
      const { project } = await reviewed(name);
      const d = (await call("POST", "/factory/drafts", { name, task: project, verdict: "approve", note: "reads well" }, token)).json;
      expect(d.state, JSON.stringify(d)).toBe("waiting");
      return { d, f: fields((await confirmPage(d.draft, "m4")).text) };
    };
    const ended = async (draft: string, name: string) => {
      expect(await env.DB.prepare("SELECT state, used_at IS NOT NULL AS spent, json_extract(outcome, '$.error') AS error FROM drafts WHERE id = ?").bind(draft).first()).toEqual({ state: "discarded", spent: 1, error: expect.stringMatching(/grant was revoked/) });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE name = ?").bind(name).first()).toEqual({ n: 0 });
    };
    // Revoke on the person's page: the page opened before it confirms nothing, and says why.
    const a = await login("m4", "Revoked on the page", "contribute,review,block");
    const one = await drafted("revokedpage", a.token);
    expect((await call("POST", `/factory/grants/${a.grant}/revoke`, {}, "omc_m4")).status).toBe(200);
    await ended(one.d.draft, "revokedpage");
    const r1 = await browser("POST", `/auth/confirm/${one.d.draft}`, "m4", { ...one.f, action: "confirm" });
    expect([r1.status, r1.text.includes("grant was revoked")]).toEqual([409, true]);
    expect((await confirmPage(one.d.draft, "m4")).text).toContain("grant was revoked");
    expect((await call("GET", "/factory/me", undefined, "omc_m4")).json.drafts.find((x: any) => x.id === one.d.draft)).toMatchObject({ state: "discarded", outcome: { error: expect.stringMatching(/grant was revoked/) } });
    await ended(one.d.draft, "revokedpage");
    // omarchy-cli logout.
    const b = await login("m4", "Logged out", "contribute,review,block");
    const two = await drafted("loggedout", b.token);
    expect((await raw("POST", `${ORIGIN}/auth/agent/revoke`, { headers: { authorization: `Bearer ${b.token}` } })).status).toBe(200);
    await ended(two.d.draft, "loggedout");
    // A new login under the same name, with contribute alone: the review draft of the grant it replaced goes with it.
    const c = await login("m4", "Renamed", "contribute,review,block");
    const three = await drafted("replacedname", c.token);
    await login("m4", "Renamed");
    await ended(three.d.draft, "replacedname");
    // A revocation the batch did not see (it raced the draft): the confirm reads the draft's grant again, refuses, and decides nothing.
    const e = await login("m4", "Raced", "contribute,review,block");
    const four = await drafted("raced", e.token);
    await env.DB.prepare("UPDATE agent_grants SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoked_by = 'm4' WHERE id = ?").bind(e.grant).run();
    const page = await confirmPage(four.d.draft, "m4");
    expect(page.text).toContain("It cannot be confirmed now.");
    expect(page.text).toContain("the grant to Raced that drafted this was revoked since (revoked on m4's page)");
    await registerPasskey("m4");
    const r4 = await browser("POST", `/auth/confirm/${four.d.draft}`, "m4", { ...four.f, ...(await signed(four.d.draft, "m4")), action: "confirm" });
    expect(r4.status).toBe(409);
    expect(await env.DB.prepare("SELECT state FROM drafts WHERE id = ?").bind(four.d.draft).first()).toEqual({ state: "refused" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE name = 'raced'").first()).toEqual({ n: 0 });
  });
});

describe("the person's own page", () => {
  it("lists every live grant, with its Revoke, and every waiting draft, however many newer rows are behind them", async () => {
    const live = await login("hana", "Old but live", "contribute", { days: "90" });
    // Eleven newer grants, each revoked: a login that re-grants every week piles up history the page shows ten of.
    const at = (s: number) => new Date(Date.now() + s * 1000).toISOString();
    for (let i = 1; i <= 11; i++) {
      await env.DB.prepare("INSERT INTO agent_grants (id, login, agent, scopes, token_hash, created_at, expires_at, revoked_at, revoked_by) VALUES (?, 'hana', 'Weekly', '[\"contribute\"]', ?, ?, ?, ?, 'replaced')")
        .bind(`g_${String(i).padStart(32, "0")}`, `hana-history-${i}`, at(i), at(7 * 86400), at(i + 1)).run();
    }
    // A draft still waiting, and twenty newer ones spent.
    const draftRow = (id: string, created: string, used: string | null, state: string) =>
      env.DB.prepare("INSERT INTO drafts (id, grant_id, login, agent, verdict, note, name, task_id, facts, created_at, expires_at, used_at, state) VALUES (?, ?, 'hana', 'Old but live', 'approve', 'reads well', 'x', 1, 'f', ?, ?, ?, ?)")
        .bind(id, live.grant, created, new Date(Date.parse(created) + DRAFT_MINUTES * 60_000).toISOString(), used, state);
    const waiting = `d_${"a".repeat(32)}`;
    await draftRow(waiting, at(-60), null, "waiting").run();
    for (let i = 1; i <= 20; i++) await draftRow(`d_${String(i).padStart(32, "0")}`, at(i), at(i), "discarded").run();
    const me = (await call("GET", "/factory/me", undefined, "omc_hana")).json;
    expect(me.grants[0]).toMatchObject({ id: live.grant, state: "live", agent: "Old but live" });
    expect(me.grants).toHaveLength(11);
    expect(me.grants.filter((g: any) => g.id === live.grant)).toHaveLength(1);
    expect(me.drafts[0]).toMatchObject({ id: waiting, state: "waiting" });
    expect(me.drafts).toHaveLength(21);
    // The literal half hour of the waiting drafts' read and of the discard is the drafts' own life.
    for (const sql of [ME_WAITING_DRAFTS_SQL, DISCARD_SQL, DISCARD_BY_TOKEN_SQL]) expect(sql).toContain(`'-${DRAFT_MINUTES} minutes'`);
  });
});

describe("the limits", () => {
  it("twenty calls a minute per login, however many grants; five token swaps a minute per address, before anything is read", async () => {
    const one = await login("gina", "Burst one"), two = await login("gina", "Burst two");
    await freshWindow();
    env.AGENT_CALLS = REAL.calls;
    const answers: number[] = [];
    for (let i = 0; i < 21; i++) answers.push((await call("GET", "/factory/me", undefined, i % 2 ? one.token : two.token)).status);
    expect(answers.slice(0, 20).every((s) => s === 200), answers.join(",")).toBe(true);
    const over = await call("GET", "/factory/me", undefined, one.token);
    expect([over.status, over.json.code, over.headers.get("retry-after")]).toEqual([429, "rate_limited", "60"]);
    env.AGENT_SWAPS = REAL.swaps;
    const swaps: number[] = [];
    for (let i = 0; i < 6; i++) swaps.push((await raw("POST", `${ORIGIN}/auth/agent/token`, { headers: { "content-type": "application/json", "cf-connecting-ip": "10.9.9.9" }, body: "not even json" })).status);
    expect(swaps).toEqual([400, 400, 400, 400, 400, 429]);
  });

  it("five requests a day per login, across its grants and agent names: a refused request counts too", async () => {
    const a = await login("frank", "Day one");
    for (let i = 0; i < 5; i++) expect((await call("POST", "/factory/packages", { url: "" }, a.token)).status).toBe(400);
    const over = await call("POST", "/factory/packages", { url: "" }, a.token);
    expect([over.status, over.json.code]).toEqual([429, "day_limit"]);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    const b = await login("frank", "Day two");
    expect((await request("frankly", b.token)).status).toBe(429);
    // The person's own request on the web is not an agent's: not counted, not refused.
    expect((await call("POST", "/factory/packages", { url: "" }, "omc_frank")).status).toBe(400);
  });

  it("ten claims a day, a release counting as one", async () => {
    await env.DB.prepare("UPDATE contributors SET agent_day = ?, agent_claims = 9 WHERE login = 'm3'").bind(new Date().toISOString().slice(0, 10)).run();
    const m3 = await login("m3", "Claims", "contribute,review");
    const r = await call("POST", "/factory/tasks/999999/release", { reason: "abcd" }, m3.token);
    expect(r.status).toBe(404);
    expect((await call("POST", "/factory/tasks/999999/build", {}, m3.token)).json.code).toBe("day_limit");
  });

  it("with the cost guard up, an agent's write is answered 503 and a person's write on the web is not", async () => {
    const a = await login("bob", "Guarded");
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('cost_guard', 'over the line') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
    forgetGuardWord();
    try {
      const r = await request("guarded", a.token);
      expect([r.status, r.json.code, r.headers.get("retry-after")]).toEqual([503, "cost_guard", "3600"]);
      // A read through the agent is not a write: it is answered.
      expect((await call("GET", "/factory/me", undefined, a.token)).status).toBe(200);
      const web = await raw("POST", `${API}/factory/packages`, { headers: { cookie: session("bob"), "content-type": "application/json" }, body: JSON.stringify({ url: "" }) });
      expect(web.status).toBe(400);
    } finally {
      await env.DB.prepare("DELETE FROM settings WHERE key = 'cost_guard'").run();
      forgetGuardWord();
    }
  });
});

describe("the evidence review_context reads", () => {
  it("text evidence answers public, max-age=30 and ?tail= its last bytes; a package in staging stays no-store and a maintainer's", async () => {
    const id = await ready("evidence");
    const log = await raw("GET", `${API}/factory/tasks/${id}/artifacts/build.log?tail=6`);
    expect([log.status, log.headers.get("cache-control"), await log.text()]).toEqual([200, "public, max-age=30", `alice's build.log of ${id}`.slice(-6)]);
    expect((await raw("GET", `${API}/factory/tasks/${id}/artifacts/build.log?tail=${64 * 1024 + 1}`)).status).toBe(400);
    const pkg = `${API}/factory/tasks/${id}/artifacts/evidence-1.0-1-x86_64.pkg.tar.zst`;
    expect((await raw("GET", pkg)).status).toBe(403);
    const m = await raw("GET", pkg, { headers: { authorization: "Bearer omc_m1" } });
    expect([m.status, m.headers.get("cache-control")]).toEqual([200, "no-store"]);
    await m.arrayBuffer();
    expect((await raw("GET", `${pkg}?tail=10`, { headers: { authorization: "Bearer omc_m1" } })).status).toBe(400);
  });
});

describe("every new query", () => {
  it("is a search through an index, never a scan", async () => {
    const plan = async (sql: string) => {
      const numbered = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
      const n = numbered.length ? Math.max(...numbered) : (sql.match(/\?/g) ?? []).length;
      const args = Array.from({ length: n }, () => "x");
      return (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    };
    const expected: [string, string, RegExp[]][] = [
      ["a grant by its token", GRANT_SQL, [/SEARCH g USING INDEX idx_agent_grants_token \(token_hash=\?\)/, /SEARCH c USING INDEX sqlite_autoindex_contributors_1 \(login=\?\)/]],
      ["the swap", SWAP_SQL, [/SEARCH agent_grants USING INDEX idx_agent_grants_code \(code_hash=\?\)/]],
      ["a login's live grants", LIVE_GRANTS_SQL, [/SEARCH agent_grants USING INDEX idx_agent_grants_live \(login=\? AND expires_at>\?\)/]],
      ["the grant's insert", GRANT_INSERT_SQL, [/SEARCH agent_grants USING INDEX idx_agent_grants_live \(login=\? AND expires_at>\?\)/]],
      ["a login's code nobody swapped, at Grant", UNSWAPPED_SQL, [/SEARCH agent_grants USING INDEX idx_agent_grants_unswapped \(login=\?\)/]],
      ["the same name's grant replaced at the swap", REPLACE_SQL, [/SEARCH agent_grants USING INDEX idx_agent_grants_live \(login=\? AND expires_at>\?\)/, /SEARCH agent_grants USING INDEX idx_agent_grants_token \(token_hash=\?\)/]],
      ["a revoked grant's waiting drafts, by the login", DISCARD_SQL, [/SEARCH drafts USING INDEX idx_drafts_login \(login=\? AND created_at>\?\)/, /SEARCH g USING INDEX sqlite_autoindex_agent_grants_1 \(id=\?\)/]],
      ["a revoked grant's waiting drafts, by the token", DISCARD_BY_TOKEN_SQL, [/SEARCH drafts USING INDEX idx_drafts_login \(login=\? AND created_at>\?\)/, /SEARCH agent_grants USING INDEX idx_agent_grants_token \(token_hash=\?\)/]],
      ["Revoke on the page", REVOKE_GRANT_SQL, [/SEARCH agent_grants USING INDEX sqlite_autoindex_agent_grants_1 \(id=\?\)/]],
      ["a contributor's block", BLOCK_GRANTS_SQL, [/SEARCH agent_grants USING INDEX idx_agent_grants_login \(login=\?\)/]],
      ["a draft's grant, at the confirm", DRAFT_GRANT_SQL, [/SEARCH agent_grants USING INDEX sqlite_autoindex_agent_grants_1 \(id=\?\)/]],
      ["a draft's decision after its handler failed", DECIDED_BY_DRAFT_SQL, [/SEARCH approvals USING INDEX idx_approvals_name \(name=\? AND created_at>\?\)/]],
      ["a person's live grants", ME_LIVE_GRANTS_SQL, [/SEARCH agent_grants USING INDEX idx_agent_grants_live \(login=\? AND expires_at>\?\)/]],
      ["a person's waiting drafts", ME_WAITING_DRAFTS_SQL, [/SEARCH drafts USING INDEX idx_drafts_login \(login=\? AND created_at>\?\)/]],
      ["the day's count", daySql("drafts"), [/SEARCH contributors USING INDEX sqlite_autoindex_contributors_1 \(login=\?\)/]],
      ["a person's workers", ME_WORKERS_SQL, [/SEARCH build_workers USING INDEX idx_build_workers_owner \(owner=\?\)/]],
      ["a person's grants", ME_GRANTS_SQL, [/SEARCH agent_grants USING INDEX idx_agent_grants_login \(login=\?\)/]],
      ["a person's drafts", ME_DRAFTS_SQL, [/SEARCH drafts USING INDEX idx_drafts_login \(login=\?\)/]],
      ["the draft spent", SPEND_SQL, [/SEARCH drafts USING INDEX sqlite_autoindex_drafts_1 \(id=\?\)/]],
      ["a draft by its id", "SELECT * FROM drafts WHERE id = ?", [/SEARCH drafts USING INDEX sqlite_autoindex_drafts_1 \(id=\?\)/]],
      ["the codes nobody took", PENDING_CODES_SQL, [/SEARCH agent_grants USING INDEX idx_agent_grants_pending \(code_expires_at<\?\)/]],
      ["logout", LOGOUT_SQL, [/SEARCH agent_grants USING INDEX idx_agent_grants_token \(token_hash=\?\)/]],
    ];
    for (const [what, sql, want] of expected) {
      const p = await plan(sql);
      for (const re of want) expect(p, `${what}: ${p}`).toMatch(re);
      expect(p, `${what}: ${p}`).not.toMatch(/\bSCAN (agent_grants|drafts|contributors|build_workers|approvals)\b/);
    }
  });
});
