/**
 * Review's decisions (#247), through the doors the page's workspace posts
 * to. The conflict of interest first: the requester may not claim their own
 * package, release a claim on it, ask for changes or reject it — refused
 * with the reason and a code an agent can read. Then the claim and its
 * release, as the MCP proposal's review_release words the rule: the
 * maintainer who claimed it or another, a queued or running rebuild
 * cancelled once, a staged one or a second release refused. Then the
 * factory's build is the lesson and never the product: the rebuild's inputs
 * carry no staged object of it, and its job's token cannot read one. Then
 * every decision — a claim, approve, request changes, reject, release,
 * adopt, block, lift — is a record signed by the pool and a journal line
 * with who, through which door (approve and block the browser's, with the
 * maintainer's passkey, #271: decide.ts) and the agent the review rests on (the one
 * each rebuild ran, not the one its worker runs by the time of the
 * decision); each is taken once — two sent at the same moment are one and
 * a 409 — and none is undone by another decision: a block is what takes an
 * approval back, and the cancel door is not a way around a release or an
 * approval. The queries the new doors add are asked for their plans, the
 * handlers' own statements.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import * as openpgp from "openpgp";
import worker, { MOVED } from "../src/index";
import { sha256Hex } from "../src/routes/contributors";
import { CLAIM_ROWS_SQL, CLAIM_SQL, RELEASE_SQL, REVIEW_SQL, ROWS_SQL } from "../src/routes/review";
import { ADOPT_SQL, MAINTAINER_SQL } from "../src/routes/adopt";
import { maintenanceOf } from "../src/routes/users";
import { putRecord } from "../src/record";
import { declared, ownScriptOf, runScript, scriptOf } from "./fixture";
import { decider } from "./decide";

const API = "http://pool.test/api/v1";
/** Approve and block, decided in the browser with the maintainer's passkey (#271): decide.ts. */
const { decide } = decider(env);

async function call(method: string, path: string, body?: unknown, token?: string, raw?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(API + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

const OWNER = (name: string) => `you brought ${name} — another maintainer decides; with one maintainer, that maintainer's own packages wait`;
const AGENT = "claude-code/claude-sonnet-5";

beforeAll(async () => {
  env.SIGNING_KEY = (await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "Pool Test", email: "test@omarchy.invalid" }], format: "armored" })).privateKey;
  const h = (t: string) => sha256Hex(t);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2')"),
    env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role) VALUES ('m1', ?, ?, 'maintainer'), ('m2', ?, ?, 'maintainer'), ('alice', ?, NULL, 'contributor'), ('bob', ?, NULL, 'contributor'), ('dave', ?, NULL, 'contributor')")
      .bind(await h("omc_m1"), await h("oms_m1"), await h("omc_m2"), await h("oms_m2"), await h("omc_alice"), await h("omc_bob"), await h("omc_dave")),
    // alice's worker builds her requests; the project's review worker, whose agent answers, takes the rebuilds a claim pins to it.
    env.DB.prepare(`INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, agent, agent_status, kinds) VALUES
      ('cx', 'x86_64', 'alice', ?, 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z', 'openai/gpt-5', 'ok', '["build"]'),
      ('px', 'x86_64', 'm2', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z', ?, 'ok', '["build"]'),
      ('ca', 'aarch64', 'alice', ?, 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z', 'openai/gpt-5', 'ok', '["build"]'),
      ('pa', 'aarch64', 'm2', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z', ?, 'ok', '["build"]')`).bind(await h("omw_cx"), await h("omw_px"), AGENT, await h("omw_ca"), await h("omw_pa"), AGENT),
  ]);
});

const checklist = { official: true, license: true, unshipped: true, evidence: true };
const request = (name: string, token = "omc_alice", arches = ["x86_64"]) =>
  call("POST", "/factory/packages", { name, url: `https://${name}.example`, source: `https://${name}.example/${name}-1.0.tar.gz`, version: "1.0", description: `${name}, a tool for Review's tests`, license: "MIT", arches, checklist }, token);
/** A worker's claim of the next task for it: the task and its job's token. The queue is the story's alone: what an earlier story left queued or running waits for no worker here. */
const claimAs = async (worker: string, name: string, arch = "x86_64", agent = worker === "omw_px" || worker === "omw_pa" ? AGENT : "openai/gpt-5") => {
  await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'not this story' WHERE status IN ('queued', 'leased') AND name != ?").bind(name).run();
  const c = await call("POST", "/factory/claim", { arch, agent, agent_status: "ok", kinds: ["build"] }, worker);
  expect(c.status, `${worker} claims ${name}: ${JSON.stringify(c.json)}`).toBe(200);
  expect(c.json.task).toMatchObject({ name, arch });
  return c.json as { task: { id: number; name: string; arch: string; params: Record<string, unknown>; pkgbuild_ref: string }; token: string; upload: string | null };
};
/** A build through the gate: its evidence, its package, staged. */
const stage = async (c: { task: { id: number; name: string; arch?: string }; token: string }, who: string) => {
  const file = `${c.task.name}-1.0-1-${c.task.arch ?? "x86_64"}.pkg.tar.zst`;
  for (const f of ["PKGBUILD", "build.log", "PKGINFO", file]) expect((await call("PUT", `/factory/tasks/${c.task.id}/artifacts/${f}`, undefined, c.token, `${who}'s ${f} of ${c.task.id}`)).status).toBe(201);
  await call("PUT", `/factory/tasks/${c.task.id}/artifacts/vet.json`, undefined, c.token, JSON.stringify({ schema: "omarchy-pool/vet/1", verdict: "pass", checks: [{ name: "smoke", status: "pass", detail: "" }] }));
  const done = await call("POST", `/factory/tasks/${c.task.id}/complete`, { sha256: (who === "the project" ? "d" : "c").repeat(64), filename: file, version: "1.0-1" }, c.token);
  expect(done.json, JSON.stringify(done.json)).toMatchObject({ status: "staged" });
};
/** alice's request, built and staged by her worker: the build a maintainer claims. */
const ready = async (name: string) => {
  expect((await request(name)).status).toBe(201);
  const c = await claimAs("omw_cx", name);
  await stage(c, "alice");
  return c.task.id;
};
/** A claim, pinned to the review worker whose agent the maintainer chose. */
const claim = (id: number, token = "omc_m1") => call("POST", `/factory/tasks/${id}/build`, { worker: "px", note: "pin the source to the tag" }, token);
/** The newest journal line of a kind about a package. */
const line = async (kind: string, name: string) => {
  const e = await env.DB.prepare("SELECT summary, payload FROM events WHERE kind = ? AND json_extract(payload, '$.name') = ? ORDER BY id DESC LIMIT 1").bind(kind, name).first<{ summary: string; payload: string }>();
  expect(e, `a ${kind} line about ${name}`).toBeTruthy();
  return { summary: e!.summary, payload: JSON.parse(e!.payload) };
};
/** A decision's record, read from the pool's bucket, with whether its detached signature verifies with the pool's key. */
const record = async (url: string) => {
  expect(url, "the decision names its record").toMatch(new RegExp(`^${env.POOL_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/factory/`));
  const key = url.slice(env.POOL_URL.length + 1);
  const bytes = new Uint8Array(await (await env.PACKAGES.get(key))!.arrayBuffer());
  const sig = new Uint8Array(await (await env.PACKAGES.get(`${key}.sig`))!.arrayBuffer());
  const pub = (await openpgp.readPrivateKey({ armoredKey: env.SIGNING_KEY! })).toPublic();
  const v = await openpgp.verify({ message: await openpgp.createMessage({ binary: bytes }), signature: await openpgp.readSignature({ binarySignature: sig }), verificationKeys: pub, format: "binary" });
  let verified = false;
  try { await v.signatures[0].verified; verified = true; } catch { verified = false; }
  return { doc: JSON.parse(new TextDecoder().decode(bytes)), verified };
};
/** A package a ring serves, the way the pool holds one: an object of it, a member of edge. */
const serve = async (name: string, source = "factory") => {
  const id = (await env.DB.prepare("INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, manifest_json, source) VALUES (?, ?, '1.0-1', 'x86_64', ?, 1, 1, '{}', ?) RETURNING id")
    .bind(await sha256Hex(`${source}/${name}`), name, `${name}-1.0-1-x86_64.pkg.tar.zst`, source)
    .first<{ id: number }>())!.id;
  await env.DB.prepare("INSERT INTO ring_packages (ring, package_id) VALUES ('edge', ?)").bind(id).run();
};

describe("no maintainer reviews what they asked for", () => {
  it("the requester is refused a claim, changes, a rejection and a release — with the reason and the code conflict_of_interest; a contributor is told a maintainer decides", async () => {
    const id = await ready("own");
    // alice, a maintainer for this test: her own package is still not hers to review, whatever the door.
    await env.DB.prepare("UPDATE contributors SET role = 'maintainer' WHERE login = 'alice'").run();
    try {
      for (const [d, body] of [["build", {}], ["changes", { note: "my own, sent back" }], ["reject", { note: "my own, rejected" }], ["approve", {}]] as const) {
        const r = await call("POST", `/factory/tasks/${id}/${d}`, body, "omc_alice");
        // Approve is refused earlier, for what it is asked on (a contributor's build is evidence): the owner rule comes after it.
        if (d === "approve") { expect(r.status).toBe(409); continue; }
        expect([r.status, r.json], d).toEqual([403, { error: OWNER("own"), code: "conflict_of_interest" }]);
      }
      // Another maintainer claims it; the requester may not let that claim go either — nor stop its rebuild through the cancel door, which is a maintainer's too.
      const claimed = await claim(id);
      expect(claimed.status).toBe(200);
      const rel = await call("POST", `/factory/tasks/${id}/release`, { reason: "I would rather it waited" }, "omc_alice");
      expect([rel.status, rel.json]).toEqual([403, { error: OWNER("own"), code: "conflict_of_interest" }]);
      const cancel = await call("POST", `/factory/tasks/${claimed.json.task}/cancel`, {}, "omc_alice");
      expect([cancel.status, cancel.json]).toEqual([403, { error: OWNER("own"), code: "conflict_of_interest" }]);
      // Another maintainer is sent to the claim's own door: a release, with a reason on the record.
      const other = await call("POST", `/factory/tasks/${claimed.json.task}/cancel`, {}, "omc_m2");
      expect(other.status).toBe(409);
      expect(other.json.error).toBe(`task ${claimed.json.task} is m1's claim on own: let it go with POST /api/v1/factory/tasks/${id}/release and a reason — it goes on the record`);
      expect(await env.DB.prepare("SELECT status FROM build_tasks WHERE id = ?").bind(claimed.json.task).first()).toEqual({ status: "queued" });
      const can = (await call("GET", `/factory/tasks/${id}/can`, undefined, "omc_alice")).json.can;
      expect(can).toMatchObject({ build: false, changes: false, reject: false, release: false });
      expect(can.why).toMatchObject({ build: OWNER("own"), changes: OWNER("own"), reject: OWNER("own"), release: OWNER("own") });
    } finally {
      await env.DB.prepare("UPDATE contributors SET role = 'contributor' WHERE login = 'alice'").run();
    }
    // A contributor — the requester while a contributor, or bob — is refused as one; nobody signed in is asked to sign in.
    for (const who of ["omc_alice", "omc_bob"]) expect((await call("POST", `/factory/tasks/${id}/release`, { reason: "not mine to let go" }, who)).json).toEqual({ error: "a maintainer decides", code: "maintainer_only" });
    const nobody = await call("POST", `/factory/tasks/${id}/release`, { reason: "nobody at all" });
    expect([nobody.status, nobody.json.error, nobody.json.code]).toEqual([401, "sign in with GitHub", "sign_in"]);
    // The claim stands: nobody's refusal moved it.
    expect((await call("GET", "/factory/review")).json.packages.find((p: any) => p.name === "own")).toMatchObject({ state: "in_review", claim: { by: "m1", status: "queued" } });
  });
});

describe("a claim", () => {
  it("is the project's rebuild on the review worker whose agent the maintainer chose, on the list as theirs and in the journal with the agent", async () => {
    const id = await ready("chosen");
    const r = await claim(id);
    expect(r.json).toMatchObject({ from: id, by: "m1", pinned_to: "px", agent: AGENT });
    const t = await env.DB.prepare("SELECT params, pinned_to FROM build_tasks WHERE id = ?").bind(r.json.task).first<{ params: string; pinned_to: string }>();
    expect(t!.pinned_to).toBe("px");
    expect(JSON.parse(t!.params)).toMatchObject({ review: id, by: "m1", agent: AGENT, hint: "pin the source to the tag" });
    const review = (await call("GET", "/factory/review")).json;
    expect(review.packages.find((p: any) => p.name === "chosen")).toMatchObject({ state: "in_review", claim: { task: r.json.task, by: "m1", agent: AGENT, status: "queued" } });
    expect(review.staged.find((x: any) => x.id === id).claim).toMatchObject({ task: r.json.task, by: "m1", agent: AGENT });
    const l = await line("review", "chosen");
    expect(l.summary).toContain(`claimed with ${AGENT}`);
    expect(l.payload).toMatchObject({ by: "m1", via: "token", agent: AGENT, pinned_to: "px", record: r.json.record });
    // Claiming is deciding on the package: signed on the record like every other decision.
    const rec = await record(r.json.record);
    expect(rec.verified).toBe(true);
    expect(rec.doc).toMatchObject({ schema: "omarchy-pool/decision/1", decision: "claim", name: "chosen", from: id, by: "m1", via: "token", agent: AGENT, pinned_to: "px", note: "pin the source to the tag" });
    expect(r.json.record).toMatch(new RegExp(`/decision-\\d+T\\d+-claim-${r.json.task}\\.json$`));
  });

  it("sent twice at once is one claim: one rebuild queued, the other maintainer told whose it is", async () => {
    const id = await ready("both");
    const [a, b] = await Promise.all([claim(id, "omc_m1"), claim(id, "omc_m2")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const won = a.status === 200 ? a : b, by = won === a ? "m1" : "m2";
    // Refused by the conditional insert when both read the package before either wrote, by the predicate when they did not.
    expect((won === a ? b : a).json.error).toMatch(new RegExp(`^(both was claimed a moment ago by ${by}: the project is already on it|the project is already on it: task \\d+ is queued)$`));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE name = 'both' AND kind = 'build' AND trust = 'project' AND status = 'queued'").first()).toEqual({ n: 1 });
    expect((await call("GET", "/factory/review")).json.packages.find((p: any) => p.name === "both")).toMatchObject({ state: "in_review", claim: { by } });
  });

  it("never downloads or reuses the factory's build: the rebuild's inputs carry no staged object of it, and its job's token cannot read one", async () => {
    const id = await ready("lesson");
    const staged = (await env.DB.prepare("SELECT staged_prefix, result_filename, result_sha256 FROM build_tasks WHERE id = ?").bind(id).first<{ staged_prefix: string; result_filename: string; result_sha256: string }>())!;
    expect(staged.result_filename).toMatch(/\.pkg\.tar\.zst$/);
    expect((await claim(id)).status).toBe(200);
    const rb = await claimAs("omw_px", "lesson");
    // What the review worker is handed: the request's facts and the maintainer's word, and its own staging to upload to — no key, file, checksum or address of the factory's package.
    expect(rb.task.pkgbuild_ref).toBe(`review:${id}`);
    const inputs = JSON.stringify(rb.task.params);
    for (const leak of [staged.staged_prefix, staged.result_filename, staged.result_sha256, ".pkg.tar", "staging/"]) expect(inputs, leak).not.toContain(leak);
    expect(Object.keys(rb.task.params).sort()).toEqual(["agent", "by", "description", "hint", "license", "note", "owner", "project", "request", "review", "source", "version"]);
    expect(rb.upload).toBe(`/api/v1/factory/tasks/${rb.task.id}/artifacts/<filename>`);
    // The lesson is the text evidence, public; the factory's package is not the rebuild's to read, with its token or without one.
    expect((await call("GET", `/factory/tasks/${id}/artifacts/PKGBUILD`)).status).toBe(200);
    const pkg = `/factory/tasks/${id}/artifacts/${staged.result_filename}`;
    expect((await call("GET", pkg, undefined, rb.token)).status).toBe(403);
    expect((await call("GET", pkg)).status).toBe(403);
    // Nor may its token write to the factory's staging: its scope is its own task's.
    expect((await call("PUT", `/factory/tasks/${id}/artifacts/PKGBUILD`, undefined, rb.token, "overwritten")).status).toBeGreaterThanOrEqual(401);
    // And the workspace names no package file and writes no evidence address of its own: it reads the addresses the list gives, the text only.
    const ctx = createExecutionContext();
    const html = await (await worker.fetch(new Request("http://pool.test/review?package=lesson"), env, ctx)).text();
    await waitOnExecutionContext(ctx);
    const own = ownScriptOf(html)!;
    expect(own).not.toMatch(/\.pkg\.tar|artifacts\//);
    expect(own).toContain("function evidenceOf(id)");
  });
});

describe("a release", () => {
  it("lets another maintainer — or the one who claimed it — take the package: a queued rebuild cancelled once, journaled with whose claim, who, the door, the agent and why, signed; the package waits for a claim again", async () => {
    const id = await ready("letgo");
    const c = await claim(id);
    // The input after the predicate: a reason is required, and goes on the record.
    expect((await call("POST", `/factory/tasks/${id}/release`, { reason: "no" }, "omc_m2")).status).toBe(400);
    const r = await call("POST", `/factory/tasks/${id}/release`, { reason: "away until Monday" }, "omc_m2");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ released: "letgo", tasks: [c.json.task], claimed_by: "m1", by: "m2", via: "token", agent: AGENT });
    expect(await env.DB.prepare("SELECT status, error FROM build_tasks WHERE id = ?").bind(c.json.task).first()).toEqual({ status: "cancelled", error: "claim released by m2: away until Monday" });
    const l = await line("review", "letgo");
    expect(l.summary).toBe(`letgo 1.0 (x86_64): m1's claim released by m2 (the rebuild with ${AGENT} stopped) — away until Monday`);
    expect(l.payload).toMatchObject({ claimed_by: "m1", by: "m2", via: "token", agent: AGENT, reason: "away until Monday", record: r.json.record });
    const rec = await record(r.json.record);
    expect(rec.verified).toBe(true);
    expect(rec.doc).toMatchObject({ schema: "omarchy-pool/decision/1", decision: "release", name: "letgo", claimed_by: "m1", by: "m2", via: "token", agent: AGENT, reason: "away until Monday", tasks: [c.json.task] });
    // Released once: a second release finds nothing to let go.
    const again = await call("POST", `/factory/tasks/${id}/release`, { reason: "once more" }, "omc_m1");
    expect(again.status).toBe(409);
    expect(again.json.error).toMatch(/^nothing to release: no rebuild of letgo is queued or running/);
    // Back in the queue, to be claimed again — by the one who claimed it first, who may let their own go too.
    expect((await call("GET", "/factory/review")).json.packages.find((p: any) => p.name === "letgo")).toMatchObject({ state: "ready", claim: null });
    const second = await claim(id);
    expect(second.status).toBe(200);
    expect((await call("POST", `/factory/tasks/${id}/release`, { reason: "my own, let go" }, "omc_m1")).json).toMatchObject({ claimed_by: "m1", by: "m1" });
    expect((await line("review", "letgo")).summary).toBe(`letgo 1.0 (x86_64): m1's claim released (the rebuild with ${AGENT} stopped) — my own, let go`);
  });

  it("voids a running rebuild's lease and takes what its worker staged; a staged rebuild is decided, not released", async () => {
    const id = await ready("running");
    expect((await claim(id)).status).toBe(200);
    const rb = await claimAs("omw_px", "running");
    expect((await call("PUT", `/factory/tasks/${rb.task.id}/artifacts/running-1.0-1-x86_64.pkg.tar.zst`, undefined, rb.token, "half a package")).status).toBe(201);
    expect((await call("POST", `/factory/tasks/${id}/release`, { reason: "the wrong agent for this one" }, "omc_m1")).status).toBe(200);
    expect(await env.DB.prepare("SELECT status FROM build_tasks WHERE id = ?").bind(rb.task.id).first()).toEqual({ status: "cancelled" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM staging_objects WHERE task_id = ? AND key LIKE '%.pkg.tar.zst'").bind(rb.task.id).first()).toEqual({ n: 0 });
    // The worker's lease is void: what it hands in now is refused.
    expect((await call("POST", `/factory/tasks/${rb.task.id}/complete`, { sha256: "e".repeat(64), filename: "running-1.0-1-x86_64.pkg.tar.zst", version: "1.0-1" }, rb.token)).status).toBe(409);
    // Claimed again and staged: that rebuild is a maintainer's to decide.
    expect((await claim(id)).status).toBe(200);
    await stage(await claimAs("omw_px", "running"), "the project");
    const staged = await call("POST", `/factory/tasks/${id}/release`, { reason: "too late for this" }, "omc_m2");
    expect(staged.status).toBe(409);
    expect(staged.json.error).toBe("nothing to release: no rebuild of running is queued or running — a staged rebuild is decided, not released");
  });

  it("sent twice at once cancels the rebuild once and writes one journal line and one record", async () => {
    const id = await ready("twice");
    const c = await claim(id);
    const [a, b] = await Promise.all([call("POST", `/factory/tasks/${id}/release`, { reason: "released by m1" }, "omc_m1"), call("POST", `/factory/tasks/${id}/release`, { reason: "released by m2" }, "omc_m2")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'review' AND json_extract(payload, '$.name') = 'twice' AND json_extract(payload, '$.claimed_by') IS NOT NULL").first()).toEqual({ n: 1 });
    expect((await env.DB.prepare("SELECT status FROM build_tasks WHERE id = ?").bind(c.json.task).first<{ status: string }>())!.status).toBe("cancelled");
  });
});

describe("a claim on two architectures, half of it staged", () => {
  it("is let go whole: the staged rebuild goes with the queued one, and the package is ready for a claim again", async () => {
    expect((await request("duo", "omc_alice", ["x86_64", "aarch64"])).status).toBe(201);
    const x86 = await claimAs("omw_cx", "duo");
    await stage(x86, "alice");
    const arm = await claimAs("omw_ca", "duo", "aarch64");
    await stage(arm, "alice");
    // m1 claims it on the x86_64 review worker; the project's aarch64 worker is offline, so that rebuild waits for any project worker.
    const c = await claim(x86.task.id);
    expect(c.json).toMatchObject({ arches: ["x86_64", "aarch64"], by: "m1" });
    const [rx, ra] = c.json.tasks as number[];
    expect(await env.DB.prepare("SELECT pinned_to, json_extract(params, '$.agent') AS agent FROM build_tasks WHERE id = ?").bind(ra).first()).toEqual({ pinned_to: null, agent: null });
    // x86_64 rebuilt and staged; aarch64 still queued: the claim is half staged.
    const rb = await claimAs("omw_px", "duo");
    expect(rb.task.id).toBe(rx);
    await stage(rb, "the project");
    expect(await env.DB.prepare("SELECT status FROM build_tasks WHERE id = ?").bind(ra).first()).toEqual({ status: "queued" });
    const before = (await call("GET", "/factory/review")).json.packages.find((p: any) => p.name === "duo");
    expect(before).toMatchObject({ state: "in_review" });
    // Released by another maintainer: both rebuilds cancelled — the staged one named as such — and its package taken out of staging.
    const r = await call("POST", `/factory/tasks/${x86.task.id}/release`, { reason: "the aarch64 worker is away for a week" }, "omc_m2");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ released: "duo", arches: ["x86_64", "aarch64"], staged: ["x86_64"], claimed_by: "m1", by: "m2" });
    expect([...r.json.tasks].sort()).toEqual([rx, ra].sort());
    expect((await env.DB.prepare("SELECT id, status FROM build_tasks WHERE id IN (?, ?) ORDER BY id").bind(rx, ra).all()).results).toEqual([{ id: rx, status: "cancelled" }, { id: ra, status: "cancelled" }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM staging_objects WHERE task_id = ? AND key LIKE '%.pkg.tar.zst'").bind(rx).first()).toEqual({ n: 0 });
    expect((await record(r.json.record)).doc).toMatchObject({ decision: "release", staged: ["x86_64"], claimed_by: "m1", by: "m2" });
    expect((await line("review", "duo")).summary).toContain("m1's claim released by m2");
    // Ready again, the lead claimable: nothing of it is in review, and Release has nothing left.
    const review = (await call("GET", "/factory/review", undefined, "omc_m1")).json;
    const pkg = review.packages.find((p: any) => p.name === "duo");
    expect(pkg).toMatchObject({ state: "ready", claim: null });
    const lead = review.staged.find((t: any) => t.id === pkg.lead);
    expect(lead.can, JSON.stringify(lead.can.why)).toMatchObject({ build: true, release: false });
    expect((await call("POST", `/factory/tasks/${x86.task.id}/release`, { reason: "once more" }, "omc_m1")).status).toBe(409);
    const again = await claim(x86.task.id);
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json.arches).toEqual(["x86_64", "aarch64"]);
  });

  it("a claim whose rebuilds all staged is decided, not released", async () => {
    const pending = await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'duo' AND kind = 'build' AND trust = 'project' AND status = 'queued' ORDER BY id").all<{ id: number }>();
    expect(pending.results).toHaveLength(2);
    await stage(await claimAs("omw_px", "duo"), "the project");
    // The aarch64 rebuild, to the project's aarch64 worker now that it is up.
    await stage(await claimAs("omw_pa", "duo", "aarch64"), "the project");
    const from = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'duo' AND trust = 'community' AND arch = 'x86_64' AND status = 'staged'").first<{ id: number }>())!.id;
    const r = await call("POST", `/factory/tasks/${from}/release`, { reason: "too late for this" }, "omc_m2");
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("nothing to release: no rebuild of duo is queued or running — a staged rebuild is decided, not released");
    expect((await call("GET", "/factory/review")).json.packages.find((p: any) => p.name === "duo")).toMatchObject({ state: "in_review" });
  });
});

describe("the three decisions of the workspace", () => {
  it("request changes: the round stops and goes back to the factory with the note, the name stays the requester's; signed and journaled with the agent that rebuilt it", async () => {
    const id = await ready("fixme");
    const c = await claim(id);
    await stage(await claimAs("omw_px", "fixme"), "the project");
    expect((await call("POST", `/factory/tasks/${id}/changes`, {}, "omc_m2")).json.error).toBe("a note saying what to change is required — the requester reads it");
    const r = await call("POST", `/factory/tasks/${id}/changes`, { note: "pin the source to the signed tag" }, "omc_m2");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ decision: "changes_requested", by: "m2", released: false, via: "token", agent: AGENT });
    expect(r.json.cancelled.sort()).toEqual([id, c.json.task].sort());
    // Back to the factory, the name held: registered, freed by nobody — another contributor's request for it is refused, and the requester builds again.
    expect(await env.DB.prepare("SELECT status, owner, freed_by_review FROM factory_packages WHERE name = 'fixme'").first()).toEqual({ status: "registered", owner: "alice", freed_by_review: null });
    expect((await request("fixme", "omc_bob")).status).toBe(409);
    expect(await env.DB.prepare("SELECT decision, released, changes FROM reviews WHERE id = ?").bind(r.json.review).first()).toEqual({ decision: "rejected", released: 0, changes: 1 });
    const listed = (await call("GET", `/factory/approvals?t=${Date.now()}`)).json.approvals.find((a: any) => a.name === "fixme");
    expect(listed).toMatchObject({ decision: "rejected", changes: true, released: false, standing: false });
    const l = await line("approve", "fixme");
    expect(l.summary).toBe("fixme 1.0 (x86_64) changes requested by m2: pin the source to the signed tag — back to the factory, the name stays the requester's");
    expect(l.payload).toMatchObject({ decision: "changes_requested", by: "m2", via: "token", agent: AGENT, record: r.json.record });
    const rec = await record(r.json.record);
    expect(rec.verified).toBe(true);
    expect(rec.doc).toMatchObject({ decision: "changes", name: "fixme", by: "m2", via: "token", agent: AGENT, note: "pin the source to the signed tag", released: false });
    // Every page that reads the decision says changes were asked for, not a rejection: the package's story, the build's own answer, the maintainer's record.
    const story = (await call("GET", `/factory/packages/fixme/story?t=${Date.now()}`)).json;
    expect(story.chains.find((ch: any) => ch.contributor?.id === id).approval).toMatchObject({ decision: "rejected", by: "m2", changes: true });
    expect((await call("GET", `/factory/tasks/${c.json.task}?t=${Date.now()}`)).json.approval).toMatchObject({ decision: "rejected", changes: true });
    expect((await call("GET", `/users/m2?t=${Date.now()}`)).json.approvals.find((a: any) => a.name === "fixme")).toMatchObject({ decision: "rejected", changes: true });
    const rebuild = await call("POST", "/factory/packages/fixme/build", {}, "omc_alice");
    expect(rebuild.status, JSON.stringify(rebuild.json)).toBe(201);
  });

  it("a note that is not text is none: refused before anything is written", async () => {
    const id = await ready("numnote");
    for (const d of ["changes", "reject"]) {
      const r = await call("POST", `/factory/tasks/${id}/${d}`, { note: 12345 }, "omc_m1");
      expect([r.status, d]).toEqual([400, d]);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews WHERE name = 'numnote'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE name = 'numnote'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT status FROM build_tasks WHERE id = ?").bind(id).first()).toEqual({ status: "staged" });
  });

  it("changes and a rejection sent at the same moment are one decision: one review, one record, the other told it was decided", async () => {
    const id = await ready("race");
    const [a, b] = await Promise.all([call("POST", `/factory/tasks/${id}/changes`, { note: "pin the source to the tag" }, "omc_m1"), call("POST", `/factory/tasks/${id}/reject`, { note: "not the upstream's source" }, "omc_m2")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const lost = a.status === 409 ? a : b;
    expect(lost.json.error).toMatch(/^(race was decided a moment ago: rejected by m[12]|task \d+ is cancelled, not staged)$/);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews WHERE name = 'race'").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE name = 'race'").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'approve' AND json_extract(payload, '$.name') = 'race'").first()).toEqual({ n: 1 });
  });

  it("reject frees a request's name, signed and journaled — no agent when nothing was rebuilt", async () => {
    const id = await ready("nope");
    const r = await call("POST", `/factory/tasks/${id}/reject`, { note: "not the upstream's source" }, "omc_m1");
    expect(r.json).toMatchObject({ decision: "rejected", released: true, by: "m1", via: "token", agent: null });
    const rec = await record(r.json.record);
    expect(rec.verified).toBe(true);
    expect(rec.doc).toMatchObject({ decision: "reject", name: "nope", by: "m1", agent: null, released: true, note: "not the upstream's source" });
    expect((await line("approve", "nope")).payload).toMatchObject({ decision: "rejected", by: "m1", via: "token", agent: null, released: true, record: r.json.record });
    // Freed: anyone may request the name, and it is theirs.
    expect((await request("nope", "omc_bob")).status).toBe(200);
    expect(await env.DB.prepare("SELECT owner FROM factory_packages WHERE name = 'nope'").first()).toEqual({ owner: "bob" });
  });

  it("approve: one review and a publish job, signed with who, the door and the agent that rebuilt what ships", async () => {
    const id = await ready("good");
    expect((await claim(id)).status).toBe(200);
    const rb = await claimAs("omw_px", "good");
    await stage(rb, "the project");
    const r = await decide("m2", `/factory/tasks/${rb.task.id}/approve`, { note: "reads well" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // The door is the browser's (#271: approve is the session's and the maintainer's passkey's, never a token's), and the passkey is named.
    expect(r.json).toMatchObject({ decision: "approved", by: "m2", via: "web", passkey: expect.stringMatching(/^pk_[0-9a-f]{32}$/), agent: AGENT, arches: ["x86_64"] });
    const rec = await record(r.json.record);
    expect(rec.verified).toBe(true);
    expect(rec.doc).toMatchObject({ schema: "omarchy-pool/decision/1", decision: "approve", name: "good", by: "m2", via: "web", passkey: r.json.passkey, agent: AGENT, note: "reads well", review: r.json.review, targets: [{ arch: "x86_64", task: rb.task.id, publish: r.json.publish }] });
    const l = await line("approve", "good");
    // m2's first decision here: decide.ts registered their first passkey a moment before it, and the line says so (#287).
    expect(l.summary).toContain(`approved by m2 with a passkey registered just now (rebuilt with ${AGENT})`);
    expect(l.payload).toMatchObject({ by: "m2", via: "web", passkey: r.json.passkey, registered_just_now: true, agent: AGENT, review: r.json.review, record: r.json.record });
    expect(r.json.record).toMatch(new RegExp(`-approve-r${r.json.review}\\.json$`));
    // The approval's publish job is not the cancel door's: what takes an approval back is a block.
    const stop = await call("POST", `/factory/tasks/${r.json.publish}/cancel`, {}, "omc_m1");
    expect(stop.status).toBe(409);
    expect(stop.json.error).toBe(`task ${r.json.publish} publishes good, approved by m2: what takes an approval back is a block (POST /api/v1/factory/packages/good/block), on the record`);
    expect(await env.DB.prepare("SELECT status FROM build_tasks WHERE id = ?").bind(r.json.publish).first()).toEqual({ status: "queued" });
  });

  it("the agent on the record is the one the rebuild ran, whatever its worker runs by the decision", async () => {
    const id = await ready("drift");
    expect((await claim(id)).status).toBe(200);
    const rb = await claimAs("omw_px", "drift");
    await stage(rb, "the project");
    expect(JSON.parse((await env.DB.prepare("SELECT params FROM build_tasks WHERE id = ?").bind(rb.task.id).first<{ params: string }>())!.params)).toMatchObject({ built_with: AGENT });
    // The review worker switches model and says so with its next claim, before anyone decides.
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'not this story' WHERE status = 'queued' AND name != 'drift'").run();
    expect((await call("POST", "/factory/claim", { arch: "x86_64", agent: "openai/gpt-5", agent_status: "ok", kinds: ["build"] }, "omw_px")).status).toBe(204);
    expect(await env.DB.prepare("SELECT agent FROM build_workers WHERE id = 'px'").first()).toEqual({ agent: "openai/gpt-5" });
    const r = await decide("m2", `/factory/tasks/${rb.task.id}/approve`, { note: "reads well" });
    expect(r.json).toMatchObject({ decision: "approved", agent: AGENT });
    expect((await record(r.json.record)).doc).toMatchObject({ agent: AGENT, targets: [{ arch: "x86_64", task: rb.task.id, agent: AGENT }] });
    expect((await line("approve", "drift")).summary).toContain(`(rebuilt with ${AGENT})`);
  });

  it("two approvals sent at the same moment are one: one review, one publish job, one record", async () => {
    const id = await ready("twin");
    expect((await claim(id)).status).toBe(200);
    const rb = await claimAs("omw_px", "twin");
    await stage(rb, "the project");
    const [a, b] = await Promise.all([decide("m1", `/factory/tasks/${rb.task.id}/approve`, { note: "m1 approves" }), decide("m2", `/factory/tasks/${rb.task.id}/approve`, { note: "m2 approves" })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const won = a.status === 200 ? a : b, lost = won === a ? b : a;
    expect(lost.json.error).toMatch(new RegExp(`^(twin was decided a moment ago: approved by ${won.json.by}|already approved)$`));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews WHERE name = 'twin'").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE name = 'twin'").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE name = 'twin' AND kind = 'publish'").first()).toEqual({ n: 1 });
    expect((await record(won.json.record)).doc).toMatchObject({ by: won.json.by, review: won.json.review });
  });

  it("a decision is taken back only by a block: approve, changes and reject again are refused, no route rewrites one, and the block withdraws the review — on the record too", async () => {
    const approved = (await env.DB.prepare("SELECT task_id, review_id FROM approvals WHERE name = 'good' AND decision = 'approved'").first<{ task_id: number; review_id: number }>())!;
    const contributors = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'good' AND trust = 'community'").first<{ id: number }>())!.id;
    expect((await call("POST", `/factory/tasks/${approved.task_id}/approve`, {}, "omc_m1")).json.error).toBe("already approved");
    for (const d of ["changes", "reject"]) for (const t of [approved.task_id, contributors]) expect((await call("POST", `/factory/tasks/${t}/${d}`, { note: "changed my mind" }, "omc_m1")).json.error, `${d} on ${t}`).toBe("already approved — withdraw the approval first");
    for (const m of ["PATCH", "DELETE", "PUT"]) expect((await call(m, `/factory/tasks/${approved.task_id}/approve`, {}, "omc_m1")).status, m).toBe(404);
    // A rejected request's builds are cancelled: nothing of it is decided again.
    const nope = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'nope' AND status = 'cancelled' ORDER BY id LIMIT 1").first<{ id: number }>())!.id;
    for (const d of ["approve", "changes", "reject"]) expect((await call("POST", `/factory/tasks/${nope}/${d}`, { note: "again" }, "omc_m2")).json.error, d).toBe(`task ${nope} is cancelled, not staged`);
    // The block: the review withdrawn with its reason, the package back to the factory, and the block itself on the record with who and the door.
    const b = await decide("m1", "/factory/packages/good/block", { reason: "ships a binary the source does not build" });
    expect(b.status, JSON.stringify(b.json)).toBe(200);
    expect(await env.DB.prepare("SELECT withdrawn_by FROM reviews WHERE id = ?").bind(approved.review_id).first()).toEqual({ withdrawn_by: "m1" });
    // A fresh key: the record is at the edge for thirty seconds.
    expect((await call("GET", `/factory/approvals?t=${Date.now()}`)).json.approvals.find((a: any) => a.name === "good")).toMatchObject({ standing: false });
    const rec = await record(b.json.record);
    expect(rec.verified).toBe(true);
    expect(rec.doc).toMatchObject({ decision: "block", name: "good", by: "m1", via: "web", passkey: b.json.passkey, agent: null });
    expect((await line("block", "good")).payload).toMatchObject({ by: "m1", via: "web", passkey: b.json.passkey, agent: null });
    // Lifted by another maintainer, on the record the same way.
    const lift = await call("POST", "/factory/packages/good/unblock", { reason: "the source builds it now" }, "omc_m2");
    expect((await record(lift.json.record)).doc).toMatchObject({ decision: "unblock", by: "m2", via: "token", agent: null });
  });
});

describe("who asked for a build", () => {
  it("never decides on it, whoever owns the registration since: the requester of a build in review is refused its claim and the approval of its rebuild; nobody adopts a package while a build of it is open", async () => {
    const id = await ready("moved");
    await env.DB.prepare("UPDATE contributors SET role = 'maintainer' WHERE login = 'alice'").run();
    try {
      // Unmaintained the way updates.ts leaves a package — its approved version still in edge — with alice's build still staged: an adoption waits for a maintainer's decision on it.
      await serve("moved");
      await env.DB.prepare("UPDATE factory_packages SET status = 'unmaintained' WHERE name = 'moved'").run();
      const adopt = await call("POST", "/factory/packages/moved/adopt", {}, "omc_m1");
      expect([adopt.status, adopt.json.error]).toEqual([409, `build #${id} of moved is staged, alice's: a maintainer decides it before anyone adopts moved`]);
      expect(await env.DB.prepare("SELECT owner, status FROM factory_packages WHERE name = 'moved'").first()).toEqual({ owner: "alice", status: "unmaintained" });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM package_maintainers WHERE name = 'moved'").first()).toEqual({ n: 0 });
      // The registration moved to dave another way (a registration taken over): alice asked for the build in review, and it is still not hers to decide.
      await env.DB.prepare("UPDATE factory_packages SET owner = 'dave', status = 'staged' WHERE name = 'moved'").run();
      expect((await claim(id, "omc_alice")).json).toEqual({ error: OWNER("moved"), code: "conflict_of_interest" });
      expect((await call("GET", `/factory/tasks/${id}/can`, undefined, "omc_alice")).json.can).toMatchObject({ build: false, reject: false, changes: false });
      // Another maintainer claims it; the rebuild is dave's by the registration, and still alice's request.
      expect((await claim(id, "omc_m1")).status).toBe(200);
      const rb = await claimAs("omw_px", "moved");
      await stage(rb, "the project");
      expect((await call("POST", `/factory/tasks/${rb.task.id}/approve`, { note: "mine to approve?" }, "omc_alice")).json).toEqual({ error: OWNER("moved"), code: "conflict_of_interest" });
      const review = (await call("GET", "/factory/review", undefined, "omc_alice")).json;
      expect(review.staged.find((t: any) => t.id === rb.task.id).can).toMatchObject({ approve: false, why: { approve: OWNER("moved") } });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE name = 'moved'").first()).toEqual({ n: 0 });
    } finally {
      await env.DB.prepare("UPDATE contributors SET role = 'contributor' WHERE login = 'alice'").run();
    }
  });
});

describe("Review's links", () => {
  it("lead to the Factory's request card and to Status, never to an address that only redirects there (index.ts MOVED: /request since #265, /journal since #264)", async () => {
    for (const path of ["/review", "/review?package=moved", "/review?tab=unmaintained"]) {
      const ctx = createExecutionContext();
      const html = await (await worker.fetch(new Request(`http://pool.test${path}`), env, ctx)).text();
      await waitOnExecutionContext(ctx);
      // Served or written by a script, the old addresses are gone: none of them opens a link, a string or a menu row.
      for (const old of Object.keys(MOVED)) expect(html, `${path} links ${old}`).not.toMatch(new RegExp(`(?:href=|["'])${old.replace(/\//g, "\\/")}(?=[?#"'])`));
      // The request's renewal (the workspace's request block) and the menu's Request open the Factory's request card, the name in its query.
      expect(html, path).toContain(`href="/factory?renew=' + encodeURIComponent(name) + '#request"`);
      expect(html, path).toContain(`href: "/factory?name=" + encodeURIComponent(term) + "#request"`);
    }
  });
});

describe("the record", () => {
  it("is written once: two writers of one key at the same moment are one record and an error, never the second's document under the first's name", async () => {
    const key = "factory/once/0/decision-20260929T000000000-approve-r1.json";
    const [a, b] = await Promise.allSettled([putRecord(env, key, { by: "m1" }), putRecord(env, key, { by: "m2" })]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const won = a.status === "fulfilled" ? "m1" : "m2";
    expect(JSON.parse(await (await env.PACKAGES.get(key))!.text())).toEqual({ by: won });
    await expect(putRecord(env, key, { by: "m3" })).rejects.toThrow(/written once/);
  });
});

describe("adopt", () => {
  it("is one door: on a package a ring serves the maintainer becomes its maintainer in the pool, and a registration its owner left unmaintained is theirs too — signed, journaled once, taken once; refused to anyone else, to its owner, to a package with a maintainer and to one in no ring", async () => {
    await env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status, detail) VALUES
      ('orphan', 'dave', 'https://orphan.example', '["x86_64"]', 'unmaintained', 'no worker built its bump in 30 days'),
      ('left', 'm2', 'https://left.example', '["x86_64"]', 'unmaintained', 'no worker built its bump in 30 days'),
      ('idle', 'dave', 'https://idle.example', '["x86_64"]', 'unmaintained', 'no worker built its bump in 30 days')`).run();
    // orphan and left are in edge, as a package left unmaintained is: its approved version stays served, the approval standing. idle never reached a ring. tzdata is synced.
    for (const name of ["orphan", "left"]) await serve(name);
    await env.DB.prepare("INSERT INTO approvals (task_id, name, arch, version, decision, by, note) VALUES (0, 'orphan', 'x86_64', '1.0-1', 'approved', 'm2', 'reads well'), (0, 'left', 'x86_64', '1.0-1', 'approved', 'm1', 'reads well')").run();
    await serve("tzdata", "core");
    // The No maintainer tab's own read, asked for when the list of all says it was truncated: the unmaintained registrations alone, paged the same way.
    const unmaintained = (await call("GET", "/factory/packages?status=unmaintained")).json;
    expect(unmaintained.truncated).toBe(false);
    expect(unmaintained.packages.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(["orphan", "left", "idle"]));
    expect(unmaintained.packages.every((p: { status: string }) => p.status === "unmaintained")).toBe(true);
    // Refused: nobody signed in, a contributor, the registration's own owner (a maintainer too: nobody looks after their own request), a package in no ring.
    expect((await call("POST", "/factory/packages/orphan/adopt", {})).status).toBe(401);
    expect(await call("POST", "/factory/packages/orphan/adopt", {}, "omc_bob")).toEqual({ status: 403, json: { error: "a maintainer adopts a package", code: "maintainer_only" } });
    expect(await call("POST", "/factory/packages/left/adopt", {}, "omc_m2")).toEqual({ status: 403, json: { error: "m2 requested left; another maintainer looks after it — build it to take it up again", code: "conflict_of_interest" } });
    for (const name of ["idle", "nothing-here"]) expect(await call("POST", `/factory/packages/${name}/adopt`, {}, "omc_m1"), name).toEqual({ status: 404, json: { error: `${name} is in no ring: a package is adopted once the pool serves it` } });
    expect(await env.DB.prepare("SELECT owner, status FROM factory_packages WHERE name IN ('left', 'idle') ORDER BY name").all().then((r) => r.results)).toEqual([{ owner: "dave", status: "unmaintained" }, { owner: "m2", status: "unmaintained" }]);

    // A synced package: its maintainer of record, and nothing else — no registration, no record, one line in the journal.
    const synced = await call("POST", "/factory/packages/tzdata/adopt", {}, "omc_m1");
    expect(synced).toMatchObject({ status: 200, json: { adopted: "tzdata", by: "m1", via: "token", registration: null } });
    expect((await line("adopt", "tzdata"))).toEqual({ summary: "tzdata adopted by m1: its maintainer in the pool", payload: { name: "tzdata", by: "m1", source: "core", via: "token", registration: null } });
    // Once: another maintainer is told whose it is.
    const again = await call("POST", "/factory/packages/tzdata/adopt", {}, "omc_m2");
    expect(again.status).toBe(409);
    expect(again.json.error).toMatch(/^tzdata is maintained by m1 \(since /);

    // An unmaintained registration: its approver is no maintainer of it any more (its owner left it), so two maintainers at once, the approver among them, and one takes it — its maintainer of record and its registration, where it stood before: published — and the other is told.
    const [a, b] = await Promise.all([call("POST", "/factory/packages/orphan/adopt", { reason: "I use it every day" }, "omc_m1"), call("POST", "/factory/packages/orphan/adopt", {}, "omc_m2")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const won = a.status === 200 ? a : b;
    const by = won === a ? "m1" : "m2";
    expect(won.json).toMatchObject({ adopted: "orphan", by, via: "token", registration: { from: "dave", status: "published" } });
    expect(await env.DB.prepare("SELECT owner, status FROM factory_packages WHERE name = 'orphan'").first()).toEqual({ owner: by, status: "published" });
    expect((await env.DB.prepare("SELECT login FROM package_maintainers WHERE name = 'orphan'").all()).results).toEqual([{ login: by }]);
    const rec = await record(won.json.record);
    expect(rec.verified).toBe(true);
    expect(rec.doc).toMatchObject({ decision: "adopt", name: "orphan", from: "dave", owner: by, maintainer: by, by, via: "token", agent: null });
    // One adopt line that says it took both, with who and from whom — and no line of any other kind about it.
    const took = await line("adopt", "orphan");
    expect(took.summary).toMatch(new RegExp(`^orphan adopted by ${by}: its maintainer in the pool, and its registration, taken from dave, who left it unmaintained`));
    expect(took.payload).toMatchObject({ name: "orphan", by, source: "factory", via: "token", registration: { from: "dave", status: "published" }, record: won.json.record });
    expect(await env.DB.prepare("SELECT kind, COUNT(*) AS n FROM events WHERE json_extract(payload, '$.name') = 'orphan' GROUP BY kind").all().then((r) => r.results)).toEqual([{ kind: "adopt", n: 1 }]);
    // The package's page names the adopter as its maintainer, for either path: the server's word it reads (maintenance on GET /package/:name).
    for (const [name, source, who] of [["orphan", "factory", by], ["tzdata", "core", "m1"]]) expect((await maintenanceOf(env, name, source, undefined)).maintainer, name).toMatchObject({ login: who, adopted: true });
    // left is still unmaintained: nobody looks after it, the approval it is served under notwithstanding.
    expect((await maintenanceOf(env, "left", "factory", undefined)).maintainer).toBeNull();
    // The adopter is its owner now, as its requester was: the one door refuses them as it refuses a requester.
    expect((await call("POST", "/factory/packages/orphan/adopt", {}, `omc_${by}`)).json).toMatchObject({ code: "conflict_of_interest" });
  });
});

describe("a decision's round", () => {
  it("is written by its first batch only: a second one on the same builds — facts read before either wrote — writes no review and no row", async () => {
    const rows = JSON.stringify([{ task: 9001, arch: "x86_64", version: "1.0-1", rebuild: 9001 }, { task: 9002, arch: "aarch64", version: "1.0-1", rebuild: 9002 }]);
    const decided = JSON.stringify([9001, 9002]);
    const take = (by: string) => env.DB.batch([
      env.DB.prepare(REVIEW_SQL).bind("roundtwice", "1.0-1", "approved", by, null, '["x86_64","aarch64"]', "{}", 0, 0, decided),
      env.DB.prepare(ROWS_SQL).bind("roundtwice", "approved", by, null, "roundtwice", rows, decided),
    ]);
    const [first, second] = await Promise.all([take("m1"), take("m2")]);
    const ids = [first[0].results.length, second[0].results.length].sort();
    expect(ids).toEqual([0, 1]);
    const review = await env.DB.prepare("SELECT id, by FROM reviews WHERE name = 'roundtwice'").all<{ id: number; by: string }>();
    expect(review.results).toHaveLength(1);
    // Both rows of the one review, each on its build, none of the other's.
    expect((await env.DB.prepare("SELECT task_id, by, review_id FROM approvals WHERE name = 'roundtwice' ORDER BY task_id").all()).results).toEqual([
      { task_id: 9001, by: review.results[0].by, review_id: review.results[0].id },
      { task_id: 9002, by: review.results[0].by, review_id: review.results[0].id },
    ]);
  });
});

describe("the queue's rows and the maintainers' lines, read whole", () => {
  // The v1.0.2 production check (2026-09-29, #282), at 1280: bitwarden's row in review read "0.0.1…" for 0.0.168, and the line under the
  // maintainer who claimed it — "reviewing bitwarden · 3 reviews · 1 package" — ended "1 p…". A version that does not fit beside its name
  // wraps under it, and the line wraps between its parts: each is whole, cut only when it alone is wider than its box.
  it("writes the version beside the name, whole, and the maintainer's line as parts that wrap", async () => {
    const id = await ready("longver");
    await env.DB.prepare("UPDATE build_tasks SET version = '0.0.168-1' WHERE id = ?").bind(id).run();
    expect((await claim(id)).status).toBe(200);
    const browser = async (path: string, init?: RequestInit) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`http://pool.test${path}`, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), cookie: "omc=oms_m1" } }), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const html = await (await browser("/review")).text();
    const drawn = runScript(scriptOf(html), { pathname: "/review", search: "?tab=review", functions: [], fetch: browser });
    for (let i = 0; i < 200 && !/reviewing longver/.test(drawn.nodes["#rv-maints"]?.innerHTML ?? ""); i++) await new Promise((r) => setTimeout(r, 5));
    const row = (drawn.nodes["#rv-rows"].innerHTML as string).split('<div class="rv-row').find((r) => r.includes("<b>longver</b>"));
    expect(row, drawn.nodes["#rv-rows"].innerHTML).toContain('title="longver"><b>longver</b></a><span class="v" title="0.0.168-1">0.0.168-1</span></span>');
    // The name's cell wraps the version under the name when both do not fit; the version never shrinks beside the name, the name is what is cut.
    expect(declared(html, ".rv-name")).toMatchObject({ display: "flex", "flex-wrap": "wrap", "min-width": "0" });
    // A version wider than the whole cell (an epoch or a git version, 1:2.44+r50+g1848099f063e-1) is cut there, whole in its title — never
    // drawn past its cell into the requester's column (the #282 review, at 1024).
    expect(declared(html, ".rv-name .v")).toMatchObject({ flex: "none", "max-width": "100%", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" });
    expect(declared(html, ".rv-name > :first-child")).toMatchObject({ "max-width": "100%", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" });
    // m1's line: what they review, their reviews, the packages they brought — each part whole, the line wrapping between them.
    const m1 = (drawn.nodes["#rv-maints"].innerHTML as string).split('<div class="rv-mrow">').find((r) => r.includes(">@m1<"));
    expect(m1).toMatch(/<span class="s" title="[^"]*"><span>reviewing longver ·<\/span> <span>\d+ reviews? ·<\/span> <span>\d+ packages?<\/span><\/span>/);
    const line = declared(html, ".rv-mwho .s");
    expect(line["white-space"], "the line wraps").toBeUndefined();
    expect(line["text-overflow"], "the line is never cut as one").toBeUndefined();
    expect(declared(html, ".rv-mwho .s > span")).toMatchObject({ display: "inline-block", "max-width": "100%", "white-space": "nowrap", "text-overflow": "ellipsis" });
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'not this story' WHERE name = 'longver' AND status IN ('queued', 'leased')").run();
  });
});

describe("the new doors' reads", () => {
  it("are led by a key — the handlers' own statements: the claim's rows and the release by their ids, the claim by the name, a decision's round by the approvals' task index, the adoption by the registration's key", async () => {
    const plan = async (sql: string) => {
      // A statement that numbers its parameters (?1, ?2) takes each once however often it reads it.
      const numbered = sql.match(/\?\d+/g), n = numbered ? new Set(numbered).size : (sql.match(/\?/g) ?? []).length;
      const args = Array.from({ length: n }, () => JSON.stringify([1, 2]));
      return (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    };
    const expected: [string, string, RegExp[]][] = [
      ["the claim's rows", CLAIM_ROWS_SQL, [/SEARCH build_tasks USING INTEGER PRIMARY KEY/]],
      ["the release", RELEASE_SQL, [/SEARCH build_tasks USING INTEGER PRIMARY KEY/, /SEARCH l USING INTEGER PRIMARY KEY/]],
      ["the claim", CLAIM_SQL, [/SEARCH r USING INDEX idx_build_tasks_name \(name=\?\)/]],
      ["a decision's review", REVIEW_SQL, [/SEARCH a USING (COVERING )?INDEX idx_approvals_task \(task_id=\?\)/]],
      ["a decision's rows", ROWS_SQL, [/SEARCH a USING (COVERING )?INDEX idx_approvals_task \(task_id=\?\)/, /SEARCH reviews USING COVERING INDEX idx_reviews_name \(name=\?\)/]],
      ["the adoption", ADOPT_SQL, [/SEARCH factory_packages USING INDEX sqlite_autoindex_factory_packages_1 \(name=\?\)/, /SEARCH t USING INDEX idx_build_tasks_name \(name=\?\)/, /SEARCH a USING INDEX idx_approvals_task \(task_id=\?\)/]],
      ["the adoption's maintainer of record", MAINTAINER_SQL, [/SEARCH factory_packages (EXISTS )?USING INDEX sqlite_autoindex_factory_packages_1 \(name=\?\)/]],
      ["a worker's agent", "SELECT agent FROM build_workers WHERE id = ?", [/SEARCH build_workers USING INDEX sqlite_autoindex_build_workers_1 \(id=\?\)/]],
      ["the record's request", "SELECT request_id FROM factory_packages WHERE name = ?", [/SEARCH factory_packages USING INDEX sqlite_autoindex_factory_packages_1 \(name=\?\)/]],
    ];
    for (const [what, sql, want] of expected) {
      const p = await plan(sql);
      for (const re of want) expect(p, `${what}: ${p}`).toMatch(re);
      expect(p, what).not.toMatch(/SCAN (build_tasks|build_workers|factory_packages|approvals|reviews|[atlr])\b/);
    }
    // The story's decisions read each row's review by its primary key, after the name's index.
    const story = await plan("SELECT a.id, COALESCE(v.changes, 0) AS changes FROM approvals a LEFT JOIN reviews v ON v.id = a.review_id WHERE a.name = ? ORDER BY a.id DESC LIMIT 40");
    expect(story).toMatch(/SEARCH a USING INDEX idx_approvals_name \(name=\?\)/);
    expect(story).toMatch(/SEARCH v USING INTEGER PRIMARY KEY/);
  });
});
