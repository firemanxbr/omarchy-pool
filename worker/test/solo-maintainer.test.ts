/**
 * The solo-maintainer exception (#394, a maintainer decision of 2026-10-06),
 * through the Worker inside workerd with a real D1 and R2: the governance
 * file's [solo] table names m1, and
 *
 * - the switch is the file: the sync applies [solo] beside the list (one
 *   `role` line when it is taken up, changed or ended), a table that does not
 *   parse is no exception (and the list still applies), and taking the table
 *   away brings the two-person rule back for everyone, unchanged;
 * - with the table, m1 claims, approves (with a passkey — never a token), asks
 *   for changes, rejects and releases the review of a package m1 brought, the
 *   cancel door sends m1 to the release as it sends anyone, m1 adopts a
 *   package of their own, and m1's agent drafts a rejection m1 confirms: each
 *   decision self-reviewed — `solo_exception` in its signed record and its
 *   answer, "self-reviewed (solo-maintainer exception)" on its journal line,
 *   the review row (`reviews.solo_since`), the adoption's maintainer of
 *   record (`package_maintainers.solo_since`, `maintenance.maintainer`), GET
 *   /factory/approvals, the task's and the story's approval, Review's claim,
 *   the list (GET /factory/self-reviewed) and Status's numbers (GET
 *   /factory/maintainers `solo`); no job's token adds to that list (the
 *   doors' kinds are refused at POST /events), and a decision someone else
 *   took first is never marked;
 * - another maintainer gains nothing (m2's own package is refused to m2 as
 *   today, and m1 decides on it as today, unmarked), and a contributor's
 *   package is unaffected;
 * - D35: m1's own host — the only one — builds the project's copy of m1's
 *   package at its next claim, no release, Review's placement says why, and
 *   the release to any host is refused as nothing to release; a claim may pin
 *   it to m1's worker; m2's copy is still kept off m2's host; without the
 *   table it is held again;
 * - the pages: Review's line above the queue, the hero's rule saying its one
 *   exception, the self-reviewed marks and the placement's words; Status's line; the build page's and the package
 *   page's marks, drawn by their own scripts; the package page's You for the
 *   maintainer the exception names; the governance chapter's list.
 *
 * Tokens: workers omw_<id>, people omc_<login>, sessions oms_<login>.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as openpgp from "openpgp";
import worker from "../src/index";
import { applyGovernance, SELF_REVIEWED_COUNT_SQL, SELF_REVIEWED_SQL, SOLO_AUDITS_SQL, SOLO_SQL, syncGovernance, type Solo } from "../src/governance";
import { sha256Hex } from "../src/routes/contributors";
import { REVIEW_SQL, ROWS_SQL, SOLO_REVIEW_SQL } from "../src/routes/review";
import { maintenanceOf } from "../src/routes/users";
import { issueJobToken, scopesFor } from "../src/jobtoken";
import { s256 } from "../src/agents";
import { PLACEMENTS_SQL } from "../src/routes/factory";
import { unitsOf } from "../src/hosts";
import { toB64url } from "../src/webauthn";
import { runScript, scriptOf, type Ran } from "./fixture";
import { decider } from "./decide";

const API = "http://pool.test/api/v1";
const { decide } = decider(env);
const SOLO: Solo = { maintainer: "m1", since: "2026-10-06", reason: "m2 has no time or machines for the pool: one active maintainer and one host" };
const MARK = { maintainer: "m1", since: "2026-10-06" };
const SELF = "self-reviewed (solo-maintainer exception)";
const OWNER = (name: string) => `you brought ${name} — another maintainer decides; with one maintainer, that maintainer's own packages wait`;
const AGENT = "claude-code/claude-sonnet-5";

async function call(method: string, path: string, body?: unknown, token?: string, raw?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token?.startsWith("oms_")) headers.cookie = `omc=${token}`;
  else if (token) headers.authorization = `Bearer ${token}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(API + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}
/** A GET past the edge's copy: a query of its own each time. */
let fresh = 0;
const read = async (path: string, token?: string) => (await call("GET", `${path}${path.includes("?") ? "&" : "?"}t=${++fresh}`, undefined, token)).json;

/** The pool's own pages, as the browser reaches them: localhost, where the grant and the confirm pages take a form (agents.ts). */
const WEB = "http://localhost:8787";
async function browser(method: "GET" | "POST", path: string, login: string, form?: Record<string, string>): Promise<{ status: number; text: string; location: string | null }> {
  const headers: Record<string, string> = { cookie: `omc=oms_${login}` };
  if (form) Object.assign(headers, { origin: WEB, "content-type": "application/x-www-form-urlencoded" });
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(WEB + path, { method, redirect: "manual", headers, body: form ? new URLSearchParams(form).toString() : undefined }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, text: await res.text(), location: res.headers.get("location") };
}
/** The hidden fields a served form carries. */
const hidden = (html: string): Record<string, string> => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([a-z_]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")]));
/** An agent's login, as omarchy-cli runs it: the grant page, Grant, the loopback's code, the swap. The agent's token. */
async function agentLogin(who: string, agent: string, scopes: string): Promise<string> {
  const verifier = `verifier-${who}-solo-`.padEnd(64, "x");
  const q = new URLSearchParams({ agent, scopes, port: "48123", state: "state-" + "s".repeat(16), challenge: await s256(verifier), method: "S256" });
  const granted = await browser("POST", "/auth/agent", who, { ...hidden((await browser("GET", `/auth/agent?${q}`, who)).text), action: "grant" });
  expect(granted.status, granted.text.slice(0, 400)).toBe(303);
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${WEB}/auth/agent/token`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "10.39.4.1" }, body: JSON.stringify({ code: new URL(granted.location!).searchParams.get("code"), code_verifier: verifier }) }), env, ctx);
  await waitOnExecutionContext(ctx);
  const body = (await res.json()) as { token?: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.token!;
}
/** A rejection's draft confirmed in the browser, as its page does it — it asks no passkey: its form, its nonce, the package's name typed. */
const confirmDraft = async (draft: string, who: string, name: string) => browser("POST", `/auth/confirm/${draft}`, who, { ...hidden((await browser("GET", `/auth/confirm/${draft}`, who)).text), name, action: "confirm" });

const checklist = { official: true, license: true, unshipped: true, evidence: true };
const request = (name: string, token: string) =>
  call("POST", "/factory/packages", { name, url: `https://${name}.example`, source: `https://${name}.example/${name}-1.0.tar.gz`, version: "1.0", description: `${name}, a tool the solo-maintainer exception's tests request`, license: "MIT", arches: ["x86_64"], checklist }, token);
/** A legacy registration's claim of the next task for it; what an earlier story left queued waits for no worker here. */
const claimAs = async (w: string, name: string) => {
  await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'not this story' WHERE status IN ('queued', 'leased') AND name != ? AND kind = 'build'").bind(name).run();
  const c = await call("POST", "/factory/claim", { arch: "x86_64", agent: w === "omw_px" ? AGENT : "openai/gpt-5", agent_status: "ok", kinds: ["build"] }, w);
  expect(c.status, `${w} claims ${name}: ${JSON.stringify(c.json)}`).toBe(200);
  expect(c.json.task).toMatchObject({ name });
  return c.json as { task: { id: number; name: string; arch: string; params: Record<string, unknown> }; token: string };
};
/** A build through the gate, staged. */
const stage = async (c: { task: { id: number; name: string }; token: string }, who: string) => {
  const file = `${c.task.name}-1.0-1-x86_64.pkg.tar.zst`;
  for (const f of ["PKGBUILD", "build.log", "PKGINFO", file]) expect((await call("PUT", `/factory/tasks/${c.task.id}/artifacts/${f}`, undefined, c.token, `${who}'s ${f} of ${c.task.id}`)).status).toBe(201);
  await call("PUT", `/factory/tasks/${c.task.id}/artifacts/vet.json`, undefined, c.token, JSON.stringify({ schema: "omarchy-pool/vet/1", verdict: "pass", checks: [{ name: "smoke", status: "pass", detail: "" }] }));
  const done = await call("POST", `/factory/tasks/${c.task.id}/complete`, { sha256: (who === "the project" ? "d" : "c").repeat(64), filename: file, version: "1.0-1" }, c.token);
  expect(done.json, JSON.stringify(done.json)).toMatchObject({ status: "staged" });
};
/**
 * `who`'s request, built and staged on a maintainer's legacy community registration: the build a maintainer claims. A maintainer's
 * own builds it; alice's, a contributor's, m2's — contributors run no worker, and a maintainer's takes anyone's (#343).
 */
const ready = async (name: string, who: "m1" | "m2" | "alice") => {
  expect((await request(name, `omc_${who}`)).status).toBe(201);
  const c = await claimAs(`omw_c${who === "alice" ? "m2" : who}`, name);
  await stage(c, who);
  return c.task.id;
};
/** A claim pinned to the project's review worker. */
const claim = (id: number, token: string) => call("POST", `/factory/tasks/${id}/build`, { worker: "px", note: "pin the source to the tag" }, token);
/** The newest journal line of a kind about a package. */
const line = async (kind: string, name: string) => {
  const e = await env.DB.prepare("SELECT summary, payload FROM events WHERE kind = ? AND json_extract(payload, '$.name') = ? ORDER BY id DESC LIMIT 1").bind(kind, name).first<{ summary: string; payload: string }>();
  expect(e, `a ${kind} line about ${name}`).toBeTruthy();
  return { summary: e!.summary, payload: JSON.parse(e!.payload) };
};
/** A decision's record from the pool's bucket, and whether its detached signature verifies with the pool's key. */
const record = async (url: string) => {
  const key = url.slice(env.POOL_URL.length + 1);
  const bytes = new Uint8Array(await (await env.PACKAGES.get(key))!.arrayBuffer());
  const sig = new Uint8Array(await (await env.PACKAGES.get(`${key}.sig`))!.arrayBuffer());
  const pub = (await openpgp.readPrivateKey({ armoredKey: env.SIGNING_KEY! })).toPublic();
  const v = await openpgp.verify({ message: await openpgp.createMessage({ binary: bytes }), signature: await openpgp.readSignature({ binarySignature: sig }), verificationKeys: pub, format: "binary" });
  let verified = false;
  try { await v.signatures[0].verified; verified = true; } catch { verified = false; }
  return { doc: JSON.parse(new TextDecoder().decode(bytes)), verified };
};
/** A package a ring serves: an object of it, a member of edge. */
const serve = async (name: string) => {
  const id = (await env.DB.prepare("INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, manifest_json, source) VALUES (?, ?, '1.0-1', 'x86_64', ?, 1, 1, '{}', 'factory') RETURNING id")
    .bind(await sha256Hex(`factory/${name}`), name, `${name}-1.0-1-x86_64.pkg.tar.zst`).first<{ id: number }>())!.id;
  await env.DB.prepare("INSERT INTO ring_packages (ring, package_id) VALUES ('edge', ?)").bind(id).run();
};
const GITHUB: Record<string, number> = { m1: 1001, m2: 1002, alice: 2001 };

beforeAll(async () => {
  env.SIGNING_KEY = (await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "Pool Test", email: "test@omarchy.invalid" }], format: "armored" })).privateKey;
  const h = (t: string) => sha256Hex(t);
  await env.DB.batch(await Promise.all(Object.entries(GITHUB).map(async ([l, g]) =>
    env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES (?, ?, ?, ?, ?)").bind(l, await h(`omc_${l}`), await h(`oms_${l}`), l === "alice" ? "contributor" : "maintainer", g))));
  // Each maintainer's legacy community registration builds the requests (alice's on m2's: a contributor runs none, #343); the project's
  // review worker — m2's, trusted on m1's word before #343 — takes the rebuilds a claim pins to it.
  await env.DB.prepare(`INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, agent, agent_status, kinds) VALUES
      ('cm1', 'x86_64', 'm1', ?, 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z', 'openai/gpt-5', 'ok', '["build"]'),
      ('cm2', 'x86_64', 'm2', ?, 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z', 'openai/gpt-5', 'ok', '["build"]'),
      ('px', 'x86_64', 'm2', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z', ?, 'ok', '["build"]')`)
    .bind(await h("omw_cm1"), await h("omw_cm2"), await h("omw_px"), AGENT).run();
});

describe("the switch is the file: applied by the sync beside the list, ended by taking the table away", () => {
  const FILE = (solo: string) => `maintainers = ["m1", "m2"]\n\n${solo}\n[cosignature]\nthreshold = 0\n`;
  const TABLE = `[solo]\nmaintainer = "m1"\nsince = "2026-10-06"\nreason = "${SOLO.reason}"\n`;
  const sync = (text: string) => syncGovernance(env, (async () => new Response(text)) as unknown as typeof fetch);
  const roleLines = async () => (await env.DB.prepare("SELECT status, summary, payload FROM events WHERE kind = 'role' AND json_extract(payload, '$.action') = 'solo_exception' ORDER BY id").all<{ status: string; summary: string; payload: string }>()).results;

  it("reads [solo] on main, applies it once, says so in the journal; a table that does not parse is none, the list applied all the same", async () => {
    expect(await sync(FILE(""))).toMatch(/^governance: 2 maintainer\(s\) applied/);
    expect(await env.DB.prepare(SOLO_SQL).first()).toBeNull();
    expect(await roleLines()).toEqual([]);
    // Taken up: one row beside the list, one role line that says who, since when and why.
    expect(await sync(FILE(TABLE))).toMatch(/m1 builds, reviews and approves their own packages under the solo-maintainer exception since 2026-10-06/);
    expect(await env.DB.prepare(SOLO_SQL).first()).toEqual(SOLO);
    expect(await sync(FILE(TABLE))).toBe("governance: unchanged");
    const [up] = await roleLines();
    expect(up.status).toBe("warn");
    expect(up.summary).toBe(`m1 builds, reviews and approves their own packages under the solo-maintainer exception since 2026-10-06 (factory/MAINTAINERS.toml): ${SOLO.reason} — every such decision is marked self-reviewed`);
    expect(JSON.parse(up.payload)).toMatchObject({ login: "m1", action: "solo_exception", solo_exception: SOLO, was: null });
    // A table that does not parse is no exception — the rules hold for everyone — and the list still applies (D39).
    const broken = await sync(FILE(TABLE.replace('"2026-10-06"', '"2026-02-30"')));
    expect(broken).toMatch(/— \[solo\] not applied: \[solo\] since must be a date, written "YYYY-MM-DD"$/);
    expect(await env.DB.prepare(SOLO_SQL).first()).toBeNull();
    expect(await env.DB.prepare("SELECT login FROM factory_maintainers ORDER BY login").all()).toMatchObject({ results: [{ login: "m1" }, { login: "m2" }] });
    expect((await roleLines()).at(-1)!.summary).toBe("the solo-maintainer exception for m1 (since 2026-10-06) ended (factory/MAINTAINERS.toml): nobody decides on their own package again");
    // A table naming somebody the list does not hold is refused the same way.
    expect(await sync(FILE(TABLE.replace('maintainer = "m1"', 'maintainer = "carol"')))).toMatch(/\[solo\] maintainer carol is not in `maintainers`/);
    expect(await env.DB.prepare(SOLO_SQL).first()).toBeNull();
    // An older brain stored the file's hash without reading [solo]: this one applies it all the same (GOVERNANCE_READS in the hash).
    await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'governance_sha256'").bind(await sha256Hex(FILE(TABLE))).run();
    expect(await sync(FILE(TABLE))).toMatch(/under the solo-maintainer exception since 2026-10-06/);
    expect(await env.DB.prepare(SOLO_SQL).first()).toEqual(SOLO);
    // Read and written by the one row's key.
    const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${SOLO_SQL}`).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    expect(plan).toMatch(/SEARCH governance_solo USING INTEGER PRIMARY KEY/);
    await expect(env.DB.prepare("INSERT INTO governance_solo (id, maintainer, since, reason) VALUES (2, 'm2', '2026-10-06', 'a second')").run()).rejects.toThrow(/CHECK/);
  });
});

describe("with [solo] naming m1: m1's own packages, decided by m1 and marked self-reviewed every time", () => {
  beforeAll(async () => {
    await applyGovernance(env, ["m1", "m2"], "sha-solo-on", SOLO);
  });

  it("a claim, then the approval — with m1's passkey, never a token — each self-reviewed on its answer, its signed record, its journal line, Review and the record", async () => {
    const id = await ready("selfpkg", "m1");
    // Review says the exception is in force, the same for everyone, and m1 may claim their own package.
    const list = await read("/factory/review", "oms_m1");
    expect(list.solo).toEqual(SOLO);
    expect(list.staged.find((r: any) => r.id === id).can).toMatchObject({ build: true });
    // Anyone else's answer is the same list's word: m2 may claim it too, as ever; alice is told a maintainer decides.
    expect((await read("/factory/review", "oms_m2")).staged.find((r: any) => r.id === id).can.build).toBe(true);
    const c = await claim(id, "omc_m1");
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(c.json.solo_exception).toEqual(MARK);
    const claimLine = await line("review", "selfpkg");
    expect(claimLine.summary).toMatch(new RegExp(`m1 asked the project to build it .*— ${SELF.replace(/[()]/g, "\\$&")}$`));
    expect(claimLine.payload).toMatchObject({ by: "m1", solo_exception: MARK, record: c.json.record });
    const claimed = await record(c.json.record);
    expect(claimed.verified).toBe(true);
    expect(claimed.doc).toMatchObject({ decision: "claim", by: "m1", solo_exception: SOLO });
    expect(JSON.parse((await env.DB.prepare("SELECT params FROM build_tasks WHERE id = ?").bind(c.json.task).first<{ params: string }>())!.params).solo_exception).toEqual(MARK);
    // Review's claim says so, for every reader.
    const row = (await read("/factory/review")).staged.find((r: any) => r.id === id);
    expect(row.claim).toMatchObject({ task: c.json.task, by: "m1", solo_exception: MARK });
    // The project's rebuild stages; m1 approves it — with a token never (#271), with their passkey in the browser.
    const rebuilt = await claimAs("omw_px", "selfpkg");
    await stage(rebuilt, "the project");
    expect(await call("POST", `/factory/tasks/${rebuilt.task.id}/approve`, { note: "mine, read twice" }, "omc_m1")).toMatchObject({ status: 403, json: { code: "session_only" } });
    const ok = await decide("m1", `/factory/tasks/${rebuilt.task.id}/approve`, { note: "mine, read twice" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ decision: "approved", by: "m1", passkey: expect.stringMatching(/^pk_/), solo_exception: MARK });
    const approved = await record(ok.json.record);
    expect(approved.verified).toBe(true);
    expect(approved.doc).toMatchObject({ decision: "approve", by: "m1", passkey: ok.json.passkey, solo_exception: SOLO });
    const approveLine = await line("approve", "selfpkg");
    expect(approveLine.summary).toContain(`approved by m1`);
    expect(approveLine.summary).toContain(` — ${SELF}`);
    expect(approveLine.payload).toMatchObject({ by: "m1", solo_exception: MARK, passkey: ok.json.passkey });
    // On the review row, on the record's list, on the task's page and the package's story.
    expect(await env.DB.prepare("SELECT by, solo_since FROM reviews WHERE id = ?").bind(ok.json.review).first()).toEqual({ by: "m1", solo_since: "2026-10-06" });
    expect((await read("/factory/approvals")).approvals.find((a: any) => a.name === "selfpkg")).toMatchObject({ by: "m1", standing: true, solo_exception: MARK });
    expect((await read(`/factory/tasks/${rebuilt.task.id}`)).approval).toMatchObject({ by: "m1", standing: true, solo_exception: MARK });
    const story = await read("/factory/packages/selfpkg/story");
    expect(story.chains.find((ch: any) => ch.approval)?.approval).toMatchObject({ by: "m1", solo_exception: MARK });
    // The story says the exception in force, the same for every reader: the package page's You reads it.
    expect(story.solo).toEqual(SOLO);
    expect((await read("/users/m1")).approvals.find((a: any) => a.name === "selfpkg")).toMatchObject({ solo_exception: MARK });
  });

  it("a release, the cancel door, changes asked for and a rejection: each m1's to take on their own package, each self-reviewed", async () => {
    const id = await ready("selftwo", "m1");
    const c = await claim(id, "omc_m1");
    expect(c.status).toBe(200);
    // The cancel door sends m1 to the release, as it sends any maintainer — no conflict_of_interest.
    const cancel = await call("POST", `/factory/tasks/${c.json.task}/cancel`, {}, "omc_m1");
    expect(cancel.status).toBe(409);
    expect(cancel.json.error).toMatch(/let it go with POST \/api\/v1\/factory\/tasks\/\d+\/release/);
    const rel = await call("POST", `/factory/tasks/${id}/release`, { reason: "another agent, from scratch" }, "omc_m1");
    expect(rel.status, JSON.stringify(rel.json)).toBe(200);
    expect(rel.json).toMatchObject({ released: "selftwo", by: "m1", solo_exception: MARK });
    expect((await line("review", "selftwo")).summary).toContain(` — ${SELF} — another agent, from scratch`);
    expect((await env.DB.prepare("SELECT error FROM build_tasks WHERE id = ?").bind(c.json.task).first<{ error: string }>())!.error).toBe(`claim released by m1, ${SELF}: another agent, from scratch`);
    expect((await record(rel.json.record)).doc).toMatchObject({ decision: "release", solo_exception: SOLO });
    // Changes asked for on their own package.
    const changes = await call("POST", `/factory/tasks/${id}/changes`, { note: "the licence file is missing" }, "omc_m1");
    expect(changes.status, JSON.stringify(changes.json)).toBe(200);
    expect(changes.json).toMatchObject({ decision: "changes_requested", by: "m1", solo_exception: MARK });
    expect((await line("approve", "selftwo")).summary).toContain(`changes requested by m1, ${SELF}`);
    expect(await env.DB.prepare("SELECT changes, solo_since FROM reviews WHERE id = ?").bind(changes.json.review).first()).toEqual({ changes: 1, solo_since: "2026-10-06" });
    expect((await read("/factory/approvals")).approvals.find((a: any) => a.name === "selftwo")).toMatchObject({ changes: true, solo_exception: MARK });
    // A rejection of another.
    const third = await ready("selfthree", "m1");
    const rej = await call("POST", `/factory/tasks/${third}/reject`, { note: "upstream is gone" }, "omc_m1");
    expect(rej.status, JSON.stringify(rej.json)).toBe(200);
    expect(rej.json).toMatchObject({ decision: "rejected", solo_exception: MARK });
    expect((await line("approve", "selfthree")).summary).toContain(`rejected by m1, ${SELF}`);
    expect((await record(rej.json.record)).doc).toMatchObject({ decision: "reject", solo_exception: SOLO });
  });

  it("the adoption of m1's own package: taken, signed and self-reviewed; m2's own is refused to m2 as today", async () => {
    await env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status, detail) VALUES
      ('mineleft', 'm1', 'https://mineleft.example', '["x86_64"]', 'unmaintained', 'no worker built its bump in 30 days'),
      ('theirsleft', 'm2', 'https://theirsleft.example', '["x86_64"]', 'unmaintained', 'no worker built its bump in 30 days')`).run();
    for (const name of ["mineleft", "theirsleft"]) await serve(name);
    expect(await call("POST", "/factory/packages/theirsleft/adopt", {}, "omc_m2")).toEqual({ status: 403, json: { error: "m2 requested theirsleft; another maintainer looks after it — build it to take it up again", code: "conflict_of_interest" } });
    const a = await call("POST", "/factory/packages/mineleft/adopt", { reason: "nobody else can" }, "omc_m1");
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json).toMatchObject({ adopted: "mineleft", by: "m1", registration: { from: "m1" }, solo_exception: MARK });
    const adopted = await line("adopt", "mineleft");
    expect(adopted.summary).toContain(` — ${SELF} — nobody else can`);
    expect(adopted.payload).toMatchObject({ solo_exception: MARK });
    expect((await record(a.json.record)).doc).toMatchObject({ decision: "adopt", solo_exception: SOLO });
    expect((await env.DB.prepare("SELECT detail FROM factory_packages WHERE name = 'mineleft'").first<{ detail: string }>())!.detail).toContain(SELF);
    // Marked for as long as it stands: the maintainer of record, the package's answer (GET /package/:name `maintenance`) and its page (below).
    expect(await env.DB.prepare("SELECT login, solo_since FROM package_maintainers WHERE name = 'mineleft'").first()).toEqual({ login: "m1", solo_since: "2026-10-06" });
    expect((await maintenanceOf(env, "mineleft", "factory", undefined)).maintainer).toMatchObject({ login: "m1", adopted: true, solo_exception: MARK });
    // m1's adoption of m2's package is an ordinary one: unmarked everywhere.
    const theirs = await call("POST", "/factory/packages/theirsleft/adopt", {}, "omc_m1");
    expect(theirs.status, JSON.stringify(theirs.json)).toBe(200);
    expect(theirs.json.solo_exception).toBeUndefined();
    expect((await line("adopt", "theirsleft")).summary).not.toContain("self-reviewed");
    expect((await line("adopt", "theirsleft")).payload.solo_exception).toBeUndefined();
    expect(await env.DB.prepare("SELECT login, solo_since FROM package_maintainers WHERE name = 'theirsleft'").first()).toEqual({ login: "m1", solo_since: null });
    expect((await maintenanceOf(env, "theirsleft", "factory", undefined)).maintainer).toMatchObject({ login: "m1", adopted: true, solo_exception: null });
  });

  it("an agent's draft by m1 on m1's own package: drafted and confirmed under the exception, `through` and `solo_exception` both on the record; refused as ever once the table is gone", async () => {
    const calls = env.AGENT_CALLS, swaps = env.AGENT_SWAPS;
    env.AGENT_CALLS = env.AGENT_SWAPS = { limit: async () => ({ success: true }) } as unknown as RateLimit;
    try {
      const token = await agentLogin("m1", "Claude Code", "contribute,review");
      const id = await ready("selfdraft", "m1");
      const drafted = await call("POST", "/factory/drafts", { name: "selfdraft", task: id, verdict: "reject", note: "upstream moved; drafted by m1's agent" }, token);
      expect(drafted.status, JSON.stringify(drafted.json)).toBe(201);
      // Confirmed in the browser as the page does it — its form and nonce, the name typed (a rejection asks no passkey): the door runs again, with `through`.
      const done = await confirmDraft(drafted.json.draft, "m1", "selfdraft");
      expect(done.status, done.text.slice(0, 300)).toBe(200);
      expect(done.text).toContain("<title>selfdraft rejected · omarchy-pool</title>");
      const rej = await line("approve", "selfdraft");
      expect(rej.summary).toContain(`rejected by m1, ${SELF}`);
      expect(rej.payload).toMatchObject({ by: "m1", decision: "rejected", solo_exception: MARK, through: expect.objectContaining({ draft: drafted.json.draft }) });
      expect((await record(rej.payload.record)).doc).toMatchObject({ decision: "reject", by: "m1", solo_exception: SOLO, through: expect.objectContaining({ draft: drafted.json.draft }) });
      expect(await env.DB.prepare("SELECT solo_since FROM reviews WHERE id = ?").bind(rej.payload.review).first()).toEqual({ solo_since: "2026-10-06" });
      // The table taken away: the same draft on m1's own package is refused as it is today.
      const again = await ready("selfdraft2", "m1");
      await applyGovernance(env, ["m1", "m2"], "sha-solo-draft-off");
      try {
        const refused = await call("POST", "/factory/drafts", { name: "selfdraft2", task: again, verdict: "reject", note: "the same, without the exception" }, token);
        expect([refused.status, refused.json]).toEqual([403, { error: OWNER("selfdraft2"), code: "conflict_of_interest" }]);
      } finally {
        await applyGovernance(env, ["m1", "m2"], "sha-solo-draft-on", SOLO);
      }
    } finally {
      env.AGENT_CALLS = calls;
      env.AGENT_SWAPS = swaps;
    }
  });

  it("another maintainer gains nothing, and a contributor's package is unaffected: m2's own is refused to m2, m1 decides on m2's and alice's unmarked", async () => {
    const theirs = await ready("theirspkg", "m2");
    for (const [d, body] of [["build", { worker: "px" }], ["changes", { note: "mine, sent back" }], ["reject", { note: "mine, rejected" }]] as const) {
      expect(await call("POST", `/factory/tasks/${theirs}/${d}`, body, "omc_m2"), d).toEqual({ status: 403, json: { error: OWNER("theirspkg"), code: "conflict_of_interest" } });
    }
    // Unpinned: the review worker is m2's, and the project's copy of m2's package is not built on m2's host (D35, the exception m1's alone).
    expect(await claim(theirs, "omc_m1")).toMatchObject({ status: 409, json: { code: "requester_host" } });
    const byM1 = await call("POST", `/factory/tasks/${theirs}/build`, { note: "the other maintainer's" }, "omc_m1");
    expect(byM1.status, JSON.stringify(byM1.json)).toBe(200);
    expect(byM1.json.solo_exception).toBeUndefined();
    expect((await line("review", "theirspkg")).summary).not.toContain("self-reviewed");
    expect((await line("review", "theirspkg")).payload.solo_exception).toBeUndefined();
    expect((await record(byM1.json.record)).doc.solo_exception).toBeUndefined();
    // m2 still may not let m1's claim on m2's package go.
    expect(await call("POST", `/factory/tasks/${theirs}/release`, { reason: "I would rather it waited" }, "omc_m2")).toEqual({ status: 403, json: { error: OWNER("theirspkg"), code: "conflict_of_interest" } });
    // alice's package: m1 claims it as any maintainer does — no mark.
    const alices = await ready("alicepkg", "alice");
    const c = await claim(alices, "omc_m1");
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(c.json.solo_exception).toBeUndefined();
    expect((await read("/factory/review")).staged.find((r: any) => r.id === alices).claim.solo_exception).toBeNull();
    const rej = await call("POST", `/factory/tasks/${theirs}/reject`, { note: "rejected by the other maintainer" }, "omc_m1");
    expect(rej.status).toBe(200);
    expect(rej.json.solo_exception).toBeUndefined();
    expect((await read("/factory/approvals")).approvals.find((a: any) => a.name === "theirspkg")).toMatchObject({ by: "m1", solo_exception: null });
  });

  it("the list and Status's numbers: every self-reviewed decision, newest first, counted; the audits beside them", async () => {
    const list = await read("/factory/self-reviewed");
    expect(list.solo).toEqual(SOLO);
    // selfpkg's claim and approval, selftwo's claim, release and changes, selfthree's rejection, mineleft's adoption, selfdraft's rejection
    // its agent drafted.
    expect(list.count).toBe(8);
    expect(list.decisions.map((d: any) => [d.decision, d.name])).toEqual([
      ["reject", "selfdraft"], ["adopt", "mineleft"], ["reject", "selfthree"], ["changes", "selftwo"], ["release", "selftwo"], ["claim", "selftwo"], ["approve", "selfpkg"], ["claim", "selfpkg"],
    ]);
    for (const d of list.decisions) {
      expect(d).toMatchObject({ by: "m1", solo_exception: MARK, record: expect.stringMatching(/^http/) });
      expect(d.summary).toContain("self-reviewed (solo-maintainer exception)");
    }
    expect((await read("/factory/self-reviewed?limit=2")).decisions).toHaveLength(2);
    // A limit that is not a whole number is cut to one, never a 500 (SQLite refuses a LIMIT of 1.5).
    expect((await read("/factory/self-reviewed?limit=1.5")).decisions).toHaveLength(1);
    // One publish-bound audit since the exception's date, leased on the same model: none.
    const rebuild = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'selfpkg' AND trust = 'project' AND kind = 'build' ORDER BY id DESC LIMIT 1").first<{ id: number }>())!.id;
    await env.DB.prepare("UPDATE build_tasks SET status = 'done', independent = 'none', created_at = '2026-10-07T00:00:00.000Z' WHERE kind = 'audit' AND json_extract(params, '$.task') = ?").bind(rebuild).run();
    const m = await read("/factory/maintainers");
    expect(m.solo).toEqual({ ...SOLO, self_reviewed: 8, audits: { publish_bound: 1, none: 1 }, list: "/api/v1/factory/self-reviewed", page: "/docs/governance#solo" });
    // Each read through an index: the journal's kind index, the audits' kind index, each audit's build by its key.
    const plan = async (sql: string, args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    for (const [sql, args] of [[SELF_REVIEWED_SQL, [10]], [SELF_REVIEWED_COUNT_SQL, []]] as const) expect(await plan(sql, [...args])).toMatch(/SEARCH events USING (COVERING )?INDEX idx_events_kind/);
    const audits = await plan(SOLO_AUDITS_SQL, ["2026-10-06T00:00:00.000Z"]);
    expect(audits).toMatch(/SEARCH a USING INDEX idx_build_tasks_kind \(kind=\? AND status=\?\)/);
    expect(audits).toMatch(/SEARCH b USING INTEGER PRIMARY KEY/);
    expect(await plan(SOLO_REVIEW_SQL, ["2026-10-06", "x"])).toMatch(/SEARCH reviews USING (COVERING )?INDEX idx_reviews_name \(name=\?\)/);
  });

  it("a job's token adds nothing to the list: POST /events refuses the doors' kinds, and a line that is no door's is neither counted nor linked", async () => {
    const before = (await read("/factory/self-reviewed")).count;
    // Any job token with the events scope — a trial's, a sync's — is refused every kind the pool's own doors write.
    const e = Math.floor(Date.now() / 1000) + 3600;
    const job = await issueJobToken(env, { t: 9, k: "trial", s: scopesFor("trial", 9, "project", {}), e, w: "w-solo" });
    for (const kind of ["approve", "review", "adopt", "role"]) {
      const forged = await call("POST", "/events", { kind, summary: `evil ${SELF}`, payload: { name: "evil", by: "m1", record: "javascript:alert(document.cookie)", solo_exception: MARK } }, job);
      expect([forged.status, forged.json?.code], kind).toEqual([403, "reserved_kind"]);
    }
    expect((await call("POST", "/events", { kind: "trial", summary: "a trial's own line" }, job)).status).toBe(201);
    expect((await read("/factory/self-reviewed")).count).toBe(before);
    // A line already in the journal (written before the door refused it, or by hand in D1): a record that is not the pool's is not passed
    // on, and a mark that is not who and since when is no decision at all.
    const stray = await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('approve', NULL, 'factory', 'ok', ?, ?) RETURNING id")
      .bind(`evil approved by m1 — ${SELF}`, JSON.stringify({ name: "evil", by: "m1", record: "javascript:alert(document.cookie)", solo_exception: MARK })).first<{ id: number }>();
    const odd = await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('approve', NULL, 'factory', 'ok', 'odd', ?) RETURNING id")
      .bind(JSON.stringify({ name: "odd", by: "m1", solo_exception: { maintainer: 1 } })).first<{ id: number }>();
    try {
      const list = await read("/factory/self-reviewed");
      expect(list.count).toBe(before + 1);
      expect(list.decisions[0]).toMatchObject({ id: stray!.id, name: "evil", record: null, solo_exception: MARK });
      expect(list.decisions.some((d: any) => d.id === odd!.id)).toBe(false);
    } finally {
      await env.DB.prepare("DELETE FROM events WHERE id IN (?, ?)").bind(stray!.id, odd!.id).run();
    }
  });

  it("a decision someone else took a moment before is never marked: m1's batch writes no review, and m2's stays unmarked (SOLO_REVIEW_SQL's changes())", async () => {
    // m1's own package; m2 rejects it first, as any other maintainer may.
    const id = await ready("racepkg", "m1");
    const m2s = await call("POST", `/factory/tasks/${id}/reject`, { note: "the other maintainer was first" }, "omc_m2");
    expect(m2s.status, JSON.stringify(m2s.json)).toBe(200);
    expect(m2s.json.solo_exception).toBeUndefined();
    // m1's decision, read on the same facts a moment before, arrives second: takeRound's batch, as it sends it under the exception.
    const decided = JSON.stringify([id]);
    const [review, rows, marked] = await env.DB.batch([
      env.DB.prepare(REVIEW_SQL).bind("racepkg", "1.0-1", "rejected", "m1", "mine, too late", JSON.stringify(["x86_64"]), "{}", 1, 0, decided),
      env.DB.prepare(ROWS_SQL).bind("racepkg", "rejected", "m1", "mine, too late", "racepkg", JSON.stringify([{ task: id, arch: "x86_64", version: "1.0-1", rebuild: null }]), decided),
      env.DB.prepare(SOLO_REVIEW_SQL).bind(SOLO.since, "racepkg"),
    ]);
    expect(review.results).toEqual([]);
    expect(rows.meta.changes).toBe(0);
    expect(marked.meta.changes).toBe(0);
    expect(await env.DB.prepare("SELECT by, solo_since FROM reviews WHERE id = ?").bind(m2s.json.review).first()).toEqual({ by: "m2", solo_since: null });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews WHERE name = 'racepkg'").first()).toEqual({ n: 1 });
  });
});

describe("D35 under the exception: m1's own host builds the project's copy of m1's packages, with no release", () => {
  type Lane = { arch: string; mode: "native" | "emulated" };
  const STUDIO = { cpus: 12, mem_gb: 32, lanes: [{ arch: "aarch64", mode: "native" }] as Lane[] };
  const capOf = () => ({ cpus: STUDIO.cpus, mem_gb: STUDIO.mem_gb, disk_free_gb: { work: 410, engine: 220 }, units: unitsOf({ cpus: STUDIO.cpus, mem_gb: STUDIO.mem_gb, units: null }), job_reserved: 1, agent_slots: 2, lanes: STUDIO.lanes });
  let hosts = 0, seq = 0;
  /** A maintainer's host, active, with its registration — its owner's — alive now. */
  const seedHost = async (id: string, owner: string) => {
    const hostId = `h_s${String(++hosts).padStart(9, "0")}`, now = new Date().toISOString(), cap = capOf();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO hosts (id, owner_login, owner_github_id, name, pubkey, status, arch, capacity, lanes, units, agent_slots, disk_free, worker_id, confirmed_at, last_seen)
                      VALUES (?, ?, ?, ?, ?, 'active', 'aarch64', ?, ?, ?, 2, ?, ?, ?, ?)`)
        .bind(hostId, owner, GITHUB[owner], id, toB64url(crypto.getRandomValues(new Uint8Array(32))), JSON.stringify({ ...cap, below_minimum: null }), JSON.stringify(cap.lanes), unitsOf(cap), JSON.stringify(cap.disk_free_gb), id, now, now),
      env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, kind, host_id, kinds, agent, agent_status) VALUES (?, 'aarch64', ?, ?, 'dedicated', 'project', ?, ?, 'host', ?, '[\"build\",\"trial\",\"audit\"]', ?, 'ok')")
        .bind(id, owner, await sha256Hex(`omw_${id}`), owner, now, hostId, AGENT),
    ]);
  };
  const hostClaim = (id: string) => call("POST", "/factory/claim", { arch: "aarch64", version: "v1.0.2", hostname: id, kinds: ["build", "trial", "audit"], claim_id: `c_solo${String(++seq).padStart(9, "0")}`, want: 1, leases: [], capacity: capOf(), agent: { provider: "claude-code", model: "claude-sonnet-5", probe: "ok", checked_at: "2026-10-01T00:00:00Z" } }, `omw_${id}`);
  /** A package `requester` asked for, its contributor's build staged, and the project's copy of it queued. */
  const seedCopy = async (requester: string) => {
    const name = `copy${++seq}`;
    await env.DB.prepare("INSERT INTO factory_packages (name, owner, url, arches, status, project, source, description, license) VALUES (?, ?, ?, '[\"aarch64\"]', 'staged', ?, ?, 'a copy placement places', 'MIT')")
      .bind(name, requester, `https://${name}.example`, `https://${name}.example`, `https://${name}.example/${name}-1.tar.gz`).run();
    const contributor = (await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, lease_owner, staged_prefix, finished_at)
       VALUES (?, 'aarch64', '1.0-1', ?, 'contributor', 100, 'staged', 0, 'community', ?, 'build', 'contrib-box', ?, ?) RETURNING id`).bind(name, `draft:https://${name}.example@1`, requester, `staging/${requester}/${name}/0/`, new Date().toISOString()).first<{ id: number }>())!.id;
    const copy = (await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params)
       VALUES (?, 'aarch64', '1.0-1', ?, 'project build asked by m1', 30, 'queued', 0, 'project', ?, 'build', ?) RETURNING id`).bind(name, `review:${contributor}`, requester, JSON.stringify({ review: contributor, by: requester, agent: null })).first<{ id: number }>())!.id;
    return { name, contributor, copy };
  };
  const placementOf = async (contributor: number, as?: string) => (await read("/factory/review", as)).staged.find((s: any) => s.id === contributor).project_build.placement;

  afterEach(async () => {
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE status IN ('queued', 'leased')").run();
  });

  it("the Studio, m1's and the only host: m1's copy is built there at its next claim, Review says why, and there is nothing to release", async () => {
    await applyGovernance(env, ["m1", "m2"], "sha-solo-d35", SOLO);
    await seedHost("m1-studio", "m1");
    const { contributor, copy } = await seedCopy("m1");
    const pl = await placementOf(contributor, "oms_m2");
    expect(pl).toEqual({ held: false, others: [], mine: ["m1-studio"], requesters: ["m1"], released: null, solo: { maintainer: "m1", hosts: ["m1-studio"], since: "2026-10-06" }, any_host: { ok: false, why: "the solo-maintainer exception (since 2026-10-06) lets m1's own hosts build the project's copy of their packages: m1-studio can build it — nothing to release" } });
    expect(await call("POST", `/factory/tasks/${copy}/any-host`, {}, "oms_m2")).toMatchObject({ status: 409 });
    const c = await hostClaim("m1-studio");
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(c.json.task).toMatchObject({ id: copy, lease_owner: "m1-studio" });
  });

  it("another maintainer gains nothing: m2's copy is still kept off m2's host, held for a release with only m2's host; m1's is m2's host's too", async () => {
    await seedHost("m2-box", "m2");
    await env.DB.prepare("UPDATE build_workers SET last_seen = '2000-01-01T00:00:00.000Z' WHERE id = 'm1-studio'").run();
    const theirs = await seedCopy("m2");
    expect(await placementOf(theirs.contributor, "oms_m1")).toMatchObject({ held: true, others: [], mine: ["m2-box"], any_host: { ok: true } });
    expect((await placementOf(theirs.contributor)).solo).toBeUndefined();
    expect((await hostClaim("m2-box")).status).toBe(204);
  });

  it("a claim may pin m1's own package to m1's worker; without the table, m1's copy is held again and the pin refused", async () => {
    await env.DB.batch([
      env.DB.prepare("UPDATE build_workers SET last_seen = ? WHERE id = 'm1-studio'").bind(new Date().toISOString()),
      env.DB.prepare("UPDATE build_workers SET last_seen = '2000-01-01T00:00:00.000Z' WHERE id = 'm2-box'"),
    ]);
    // m1's community build of a package of theirs, staged on aarch64; the claim pins the rebuild to m1's own worker.
    const own = await seedCopy("m1");
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE id = ?").bind(own.copy).run();
    const pinned = await call("POST", `/factory/tasks/${own.contributor}/build`, { worker: "m1-studio" }, "omc_m1");
    expect(pinned.status, JSON.stringify(pinned.json)).toBe(200);
    expect(pinned.json).toMatchObject({ pinned_to: "m1-studio", solo_exception: MARK });
    // The table taken away: the rules as they were — m1's copy held for another maintainer's release, the pin refused, the door closed.
    await applyGovernance(env, ["m1", "m2"], "sha-solo-off");
    expect((await read("/factory/maintainers")).solo).toBeNull();
    const again = await seedCopy("m1");
    expect(await placementOf(again.contributor, "oms_m2")).toEqual({ held: true, others: [], mine: ["m1-studio"], requesters: ["m1"], released: null, any_host: { ok: true, why: null } });
    expect((await hostClaim("m1-studio")).status).toBe(204);
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE id = ?").bind(again.copy).run();
    const refused = await call("POST", `/factory/tasks/${again.contributor}/build`, { worker: "m1-studio" }, "omc_m1");
    expect([refused.status, refused.json]).toEqual([403, { error: OWNER(again.name), code: "conflict_of_interest" }]);
    const pin = await call("POST", `/factory/tasks/${again.contributor}/build`, { worker: "m1-studio" }, "omc_m2");
    expect(pin).toMatchObject({ status: 409, json: { code: "requester_host" } });
    // The record stays: what was self-reviewed is still listed, the exception no longer in force.
    const list = await read("/factory/self-reviewed");
    expect(list.solo).toBeNull();
    expect(list.count).toBeGreaterThanOrEqual(8);
    // The placement reads through the copy's key and the exception's.
    const p = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${PLACEMENTS_SQL}`).bind("[1]").all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    expect(p).toMatch(/SEARCH gs USING INTEGER PRIMARY KEY/);
    expect(p).not.toMatch(/SCAN (build_tasks|c|rq|au|gs)(?! USING)/);
  });
});

describe("the pages: Review's line and marks, Status's line, the build page's and the package page's marks, the governance chapter's list", () => {
  const html = async (path: string) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`http://pool.test${path}`), env, ctx);
    await waitOnExecutionContext(ctx);
    return res.text();
  };
  const tick = () => new Promise((r) => setTimeout(r, 10));
  const PL = { held: false, others: [], mine: ["m1-studio"], requesters: ["m1"], released: null, solo: { maintainer: "m1", hosts: ["m1-studio"], since: "2026-10-06" }, any_host: { ok: false, why: "nothing to release" } };

  it("Review: the exception above the queue and in the hero's rule, a self-reviewed claim marked, m1's own row offering the claim as the server allows, and why m1's host builds the copy", async () => {
    const d = runScript(scriptOf(await html("/review")), { pathname: "/review", functions: ["renderSolo", "selfPill", "readyRow", "reviewRow", "renderRebuild", "confirmText"], variables: ["REVIEW", "WHO", "STORY", "OPEN"] }) as Ran & Record<string, any>;
    d.setREVIEW({ staged: [], packages: [], solo: SOLO });
    d.setWHO({ me: { login: "m1", role: "maintainer" }, login: "m1", role: "maintainer" });
    d.renderSolo();
    expect(d.nodes["#rv-solo"].hidden).toBe(false);
    // The hero's rule says it has one exception while it is in force, and links to it.
    expect(d.nodes["#rv-own-t"].textContent).toBe("Never your own requests — one exception, on the record");
    expect(d.nodes["#rv-own"].href).toBe("/docs/governance#solo");
    expect(d.nodes["#rv-solo"].innerHTML).toContain("<b>Solo-maintainer exception</b> since 2026-10-06: ");
    expect(d.nodes["#rv-solo"].innerHTML).toContain(">@m1</a> builds, reviews and approves their own packages, each decision marked self-reviewed — " + SOLO.reason);
    expect(d.selfPill(MARK)).toBe(' <span class="pill warn" title="taken by its requester, m1, under the solo-maintainer exception (since 2026-10-06)">self-reviewed</span>');
    expect(d.selfPill(null)).toBe("");
    // m1's own row: Claim, labelled a self-review, live because the server's can says so; without the exception the row is locked.
    const lead = { id: 7, arch: "x86_64", version: "1.0-1", finished_at: "2026-10-06T00:00:00Z", can: { build: true, why: {} } };
    expect(d.readyRow({ name: "mine", owner: "m1", version: "1.0-1", targets: {}, lead, rows: [lead] })).toContain(">Claim · self-review</button>");
    expect(d.reviewRow({ name: "mine", owner: "m1", claim: { by: "m1", at: "2026-10-06T00:00:00Z", solo_exception: MARK }, lead, rows: [lead] })).toContain(">self-reviewed</span>");
    expect(d.confirmText("approve", [], { owner: "m1", targets: {} })).toContain("Self-reviewed: you brought it, and the solo-maintainer exception lets you decide");
    // The rebuild's placement line: m1's own host builds it, the requester-host rule does not hold for m1's packages, no release needed.
    d.setREVIEW({ staged: [{ id: 40, kind: "contributor", project_build: { id: 41, status: "queued", placement: PL } }], packages: [], solo: SOLO });
    d.setOPEN("mine");
    d.renderRebuild([{ arch: "aarch64", asked: true, target: { status: "reviewing", task: 41 }, rebuild: { id: 41, kind: "build", trust: "project", status: "queued", arch: "aarch64", attempts: 0, max_attempts: 3, params: { review: 40 } } }], null);
    const place = d.nodes["#rv-place"].innerHTML as string;
    expect(place).toContain("aarch64: ");
    expect(place).toContain("'s own hosts may build it (m1-studio) — the requester-host rule does not hold for ");
    expect(place).toContain("while the solo-maintainer exception is in force (since 2026-10-06): no release needed.");
    expect(place).not.toContain("data-anyhost");
    // Without the exception, nothing is said and m1's own row is locked.
    d.setREVIEW({ staged: [], packages: [], solo: null });
    d.renderSolo();
    expect(d.nodes["#rv-solo"].hidden).toBe(true);
    expect(d.nodes["#rv-own-t"].textContent).toBe("Never your own requests");
    expect(d.nodes["#rv-own"].href).toBe("/docs/governance");
    expect(d.readyRow({ name: "mine", owner: "m1", version: "1.0-1", targets: {}, lead: { ...lead, can: { build: false, why: { build: OWNER("mine") } } }, rows: [lead] })).toContain(">yours · locked</button>");
  });

  it("Status: one line while the exception is in force — who, since when, why, how many self-reviewed, the list — and the audits beside it; none without it", async () => {
    const answers: Record<string, unknown> = { "/api/v1/factory/maintainers": { maintainers: [], solo: { ...SOLO, self_reviewed: 7, audits: { publish_bound: 3, none: 3 }, list: "/api/v1/factory/self-reviewed", page: "/docs/governance#solo" } } };
    const d = runScript(scriptOf(await html("/status")), {
      pathname: "/status", functions: ["loadSolo"],
      fetch: async (path) => (answers[path] ? new Response(JSON.stringify(answers[path]), { status: 200, headers: { "content-type": "application/json" } }) : new Promise<Response>(() => {})),
    }) as Ran & Record<string, any>;
    for (let i = 0; i < 100 && !d.nodes["#st-solo"]?.innerHTML; i++) await tick();
    const said = d.nodes["#st-solo"].innerHTML as string;
    expect(d.nodes["#st-solo"].hidden).toBe(false);
    expect(said).toContain("<b>Solo-maintainer exception</b> since 2026-10-06: ");
    expect(said).toContain(">@m1</a> builds, reviews and approves their own packages — " + SOLO.reason + ". ");
    expect(said).toContain('<a href="/docs/governance#solo">7 decisions self-reviewed</a>, each marked so on the record. ');
    expect(said).toContain("3 of 3 audits of the project's copies since then recorded <code>independent: none</code> — with one host and one model");
    answers["/api/v1/factory/maintainers"] = { maintainers: [], solo: null };
    d.loadSolo();
    for (let i = 0; i < 100 && !d.nodes["#st-solo"].hidden; i++) await tick();
    expect(d.nodes["#st-solo"].hidden).toBe(true);
    expect(d.nodes["#st-solo"].innerHTML).toBe("");
  });

  it("the build page: a self-reviewed claim or approval marked, with who and since when on hover", async () => {
    const d = runScript(scriptOf(await html("/build/1")), { pathname: "/build/1", functions: ["selfMark"] }) as Ran & Record<string, any>;
    expect(d.selfMark(MARK)).toBe('<span class="pill warn" title="taken by its requester, m1, under the solo-maintainer exception (since 2026-10-06)">self-reviewed</span>');
    expect(d.selfMark(null)).toBe("");
  });

  it("the build page, drawn from the task's answer: the head, the Decision tile, the decision beside the actions and the timeline's claim and approval marked; nothing without the marks", async () => {
    // selfpkg's project rebuild: m1 claimed it and approved it under the exception (above).
    const rebuild = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'selfpkg' AND trust = 'project' AND kind = 'build' ORDER BY id DESC LIMIT 1").first<{ id: number }>())!.id;
    const T = await read(`/factory/tasks/${rebuild}`);
    expect(T.approval).toMatchObject({ by: "m1", standing: true, solo_exception: MARK });
    expect(T.task.params.solo_exception).toEqual(MARK);
    const draw = (t: any) => {
      const d = runScript(scriptOf(await_html), { pathname: `/build/${rebuild}`, functions: ["render"], variables: ["T"] }) as Ran & Record<string, any>;
      d.setT(t);
      d.render();
      return { badges: d.nodes["#badges"].innerHTML as string, tiles: (d.nodes["#tiles"].children as any[]).map((c) => c.innerHTML).join(""), acts: d.nodes["#acts"].innerHTML as string, timeline: d.nodes["#timeline"].innerHTML as string };
    };
    const await_html = await html(`/build/${rebuild}`);
    const pill = '<span class="pill warn" title="taken by its requester, m1, under the solo-maintainer exception (since 2026-10-06)">self-reviewed</span>';
    const marked = draw(T);
    expect(marked.badges).toContain(pill);
    expect(marked.tiles).toMatch(/<div class="k">Decision<\/div><div class="v num ok">approved<\/div><div class="s">by m1 · [^<]* · self-reviewed<\/div>/);
    expect(marked.acts).toContain(`.</span> ${pill}`);
    expect(marked.timeline).toContain(`, their own package: ${pill} under the solo-maintainer exception`);
    expect(marked.timeline).toContain(`${pill} (solo-maintainer exception, since 2026-10-06)`);
    // The same build under the two-person rule: no mark anywhere.
    const plain = draw({ ...T, task: { ...T.task, params: { ...T.task.params, solo_exception: undefined } }, approval: { ...T.approval, solo_exception: null } });
    for (const part of Object.values(plain)) expect(part).not.toContain("self-reviewed");
  });

  it("the package page: the review stage, the record, the gates and the people marked on a self-reviewed approval; an adoption marked, its requester still named; nothing without the marks", async () => {
    await serve("selfpkg");
    const ST = await read("/factory/packages/selfpkg/story");
    const page = scriptOf(await html("/package/selfpkg"));
    const on = (name: string) => runScript(page, { pathname: `/package/${name}`, functions: ["stagesOf", "timeline", "gateCells", "renderPeople", "renderYou"], variables: ["ST", "D", "D404", "WHO"] }) as Ran & Record<string, any>;
    const marks = (st: any) => {
      const d = on("selfpkg");
      d.setST(st);
      d.renderPeople();
      return {
        review: d.stagesOf().find((x: any) => x.id === "review").sum as string,
        record: (d.timeline() as string[][]).map((e) => e.join(" ")).join("\n"),
        gate: d.gateCells("x86_64")[5][1] as string,
        people: d.nodes["#who"].innerHTML as string,
      };
    };
    const marked = marks(ST);
    expect(marked.review).toBe("@m1 · rebuilt · approved · self-reviewed");
    expect(marked.record).toContain("var(--green) approved by @m1 · self-reviewed (solo-maintainer exception) · 1.0 · x86_64");
    expect(marked.gate).toBe("brought by m1, rebuilt and approved by m1 — self-reviewed under the solo-maintainer exception (since 2026-10-06)");
    expect(marked.people).toContain("rebuilt from scratch · self-reviewed (solo-maintainer exception)");
    const unmarked = marks({ ...ST, chains: ST.chains.map((c: any) => ({ ...c, approval: c.approval && { ...c.approval, solo_exception: null } })) });
    for (const part of Object.values(unmarked)) expect(part).not.toContain("self-reviewed");
    // mineleft, adopted back by m1 under the exception: the maintainer row says so, and the requester row stays — m1 asked for it.
    const left = await read("/factory/packages/mineleft/story");
    const answer = { error: "mineleft is not in any ring for aarch64", arches: {}, maintenance: await maintenanceOf(env, "mineleft", "factory", undefined) };
    expect(answer.maintenance.maintainer).toMatchObject({ login: "m1", adopted: true, solo_exception: MARK });
    const people = (maintainer: any) => {
      const d = on("mineleft");
      d.setST(left);
      d.setD404({ ...answer, maintenance: { ...answer.maintenance, maintainer } });
      d.renderPeople();
      return d.nodes["#who"].innerHTML as string;
    };
    const adopted = people(answer.maintenance.maintainer);
    expect(adopted).toContain('<span class="r">requested by</span>');
    expect(adopted).toMatch(/<span class="r">maintainer<\/span><span class="l"><a [^>]*>@m1<\/a><span> · adopted [^<]* ago · self-reviewed \(solo-maintainer exception\)<\/span>/);
    // An ordinary adoption by its requester's registration (#247): the maintainer row alone, unmarked.
    const ordinary = people({ ...answer.maintenance.maintainer, solo_exception: null });
    expect(ordinary).not.toContain('<span class="r">requested by</span>');
    expect(ordinary).not.toContain("self-reviewed");
  });

  it("the package page's You: the maintainer the exception names is told they decide on their own package and offered its Adopt; the lock as ever without it, and for anyone else", async () => {
    const page = scriptOf(await html("/package/mineleft"));
    const you = (solo: Solo | null, login = "m1", role = "maintainer") => {
      const d = runScript(page, { pathname: "/package/mineleft", functions: ["renderYou"], variables: ["ST", "D", "D404", "WHO"] }) as Ran & Record<string, any>;
      d.setWHO({ me: { login, role }, login, role });
      // m1's own registration, left unmaintained, a ring still serving it: what Review's No maintainer tab lists.
      d.setST({ name: "mineleft", package: { name: "mineleft", owner: "m1", status: "unmaintained" }, request: {}, chains: [], rings: [{ ring: "edge", arch: "x86_64" }], targets: {}, solo });
      d.renderYou();
      return d.nodes["#you"].innerHTML as string;
    };
    const self = you(SOLO);
    expect(self).toContain('data-act="adopt"');
    expect(self).toContain(">Adopt · self-review</button>");
    expect(self).toContain("The solo-maintainer exception lets you adopt it back yourself");
    expect(self).toContain('Self-reviewed: the solo-maintainer exception names you, so you decide on your own package — every decision marked so, in public. <a href="/docs/governance#solo">The rule</a>');
    expect(self).not.toContain("You can't review your own request.");
    // Without the table: locked, and no Adopt — the server refuses it with conflict_of_interest.
    const off = you(null);
    expect(off).toContain("You can't review your own request.");
    expect(off).not.toContain('data-act="adopt"');
    // The exception names m1: a requester it does not name keeps the lock.
    const other = you({ ...SOLO, maintainer: "m2" });
    expect(other).toContain("You can't review your own request.");
    expect(other).not.toContain("self-review");
  });

  it("the governance chapter's list: every self-reviewed decision, its signed record linked only as an https address", async () => {
    const answer = {
      solo: SOLO, count: 2,
      decisions: [
        { id: 2, kind: "approve", at: "2026-10-06T10:00:00.000Z", summary: `selfpkg approved by m1 — ${SELF}`, name: "selfpkg", by: "m1", decision: "approve", record: "https://pool.omarchy-pool.org/records/selfpkg/decision.json", solo_exception: MARK },
        { id: 1, kind: "approve", at: "2026-10-06T09:00:00.000Z", summary: `evil approved by m1 — ${SELF}`, name: "evil", by: "m1", decision: "approve", record: "javascript:alert(document.cookie)", solo_exception: MARK },
      ],
    };
    const d = runScript(scriptOf(await html("/docs/governance")), {
      pathname: "/docs/governance", functions: [],
      fetch: async (path) => (path === "/api/v1/factory/self-reviewed?limit=200" ? new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } }) : new Promise<Response>(() => {})),
    }) as Ran & Record<string, any>;
    for (let i = 0; i < 100 && !(d.nodes["#solo-table tbody"]?.innerHTML ?? "").includes("self-reviewed"); i++) await tick();
    const rows = d.nodes["#solo-table tbody"].innerHTML as string;
    expect(rows).toContain('<a href="https://pool.omarchy-pool.org/records/selfpkg/decision.json">signed record</a>');
    expect(rows).not.toContain("javascript:");
    expect(d.nodes["#solo-now"].innerHTML).toContain("<b>In force since 2026-10-06</b>");
  });
});
