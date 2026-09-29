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
 * every decision — approve, request changes, reject, release, adopt, block,
 * lift — is a record signed by the pool and a journal line with who,
 * through which door and the agent the review rests on, and none is undone
 * by another decision: a block is what takes an approval back. The queries
 * the new doors add are asked for their plans.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import * as openpgp from "openpgp";
import worker from "../src/index";
import { sha256Hex } from "../src/routes/contributors";
import { ownScriptOf } from "./fixture";

const API = "http://pool.test/api/v1";

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
    env.DB.prepare("INSERT INTO contributors (login, token_hash, role) VALUES ('m1', ?, 'maintainer'), ('m2', ?, 'maintainer'), ('alice', ?, 'contributor'), ('bob', ?, 'contributor'), ('dave', ?, 'contributor')")
      .bind(await h("omc_m1"), await h("omc_m2"), await h("omc_alice"), await h("omc_bob"), await h("omc_dave")),
    // alice's worker builds her requests; the project's review worker, whose agent answers, takes the rebuilds a claim pins to it.
    env.DB.prepare(`INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, agent, agent_status, kinds) VALUES
      ('cx', 'x86_64', 'alice', ?, 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z', 'openai/gpt-5', 'ok', '["build"]'),
      ('px', 'x86_64', 'm2', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z', ?, 'ok', '["build"]')`).bind(await h("omw_cx"), await h("omw_px"), AGENT),
  ]);
});

const checklist = { official: true, license: true, unshipped: true, evidence: true };
const request = (name: string, token = "omc_alice") =>
  call("POST", "/factory/packages", { name, url: `https://${name}.example`, source: `https://${name}.example/${name}-1.0.tar.gz`, version: "1.0", description: `${name}, a tool for Review's tests`, license: "MIT", arches: ["x86_64"], checklist }, token);
/** A worker's claim of the next task for it: the task and its job's token. The queue is the story's alone: what an earlier story left queued or running waits for no worker here. */
const claimAs = async (worker: string, name: string) => {
  await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'not this story' WHERE status IN ('queued', 'leased') AND name != ?").bind(name).run();
  const c = await call("POST", "/factory/claim", { arch: "x86_64", agent: worker === "omw_px" ? AGENT : "openai/gpt-5", agent_status: "ok", kinds: ["build"] }, worker);
  expect(c.status, `${worker} claims ${name}: ${JSON.stringify(c.json)}`).toBe(200);
  expect(c.json.task).toMatchObject({ name });
  return c.json as { task: { id: number; name: string; params: Record<string, unknown>; pkgbuild_ref: string }; token: string; upload: string | null };
};
/** A build through the gate: its evidence, its package, staged. */
const stage = async (c: { task: { id: number; name: string }; token: string }, who: string) => {
  const file = `${c.task.name}-1.0-1-x86_64.pkg.tar.zst`;
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
      // Another maintainer claims it; the requester may not let that claim go either.
      expect((await claim(id)).status).toBe(200);
      const rel = await call("POST", `/factory/tasks/${id}/release`, { reason: "I would rather it waited" }, "omc_alice");
      expect([rel.status, rel.json]).toEqual([403, { error: OWNER("own"), code: "conflict_of_interest" }]);
      const can = (await call("GET", `/factory/tasks/${id}/can`, undefined, "omc_alice")).json.can;
      expect(can).toMatchObject({ build: false, changes: false, reject: false, release: false });
      expect(can.why).toMatchObject({ build: OWNER("own"), changes: OWNER("own"), reject: OWNER("own"), release: OWNER("own") });
    } finally {
      await env.DB.prepare("UPDATE contributors SET role = 'contributor' WHERE login = 'alice'").run();
    }
    // A contributor — the requester while a contributor, or bob — is refused as one; nobody signed in is asked to sign in.
    for (const who of ["omc_alice", "omc_bob"]) expect((await call("POST", `/factory/tasks/${id}/release`, { reason: "not mine to let go" }, who)).json).toEqual({ error: "a maintainer decides", code: "maintainer_only" });
    expect((await call("POST", `/factory/tasks/${id}/release`, { reason: "nobody at all" })).status).toBe(401);
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
    expect(l.payload).toMatchObject({ by: "m1", via: "token", agent: AGENT, pinned_to: "px" });
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
    const rebuild = await call("POST", "/factory/packages/fixme/build", {}, "omc_alice");
    expect(rebuild.status, JSON.stringify(rebuild.json)).toBe(201);
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
    const r = await call("POST", `/factory/tasks/${rb.task.id}/approve`, { note: "reads well" }, "omc_m2");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ decision: "approved", by: "m2", via: "token", agent: AGENT, arches: ["x86_64"] });
    const rec = await record(r.json.record);
    expect(rec.verified).toBe(true);
    expect(rec.doc).toMatchObject({ schema: "omarchy-pool/decision/1", decision: "approve", name: "good", by: "m2", via: "token", agent: AGENT, note: "reads well", review: r.json.review, targets: [{ arch: "x86_64", task: rb.task.id, publish: r.json.publish }] });
    const l = await line("approve", "good");
    expect(l.summary).toContain(`approved by m2 (rebuilt with ${AGENT})`);
    expect(l.payload).toMatchObject({ by: "m2", via: "token", agent: AGENT, review: r.json.review, record: r.json.record });
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
    const b = await call("POST", "/factory/packages/good/block", { reason: "ships a binary the source does not build" }, "omc_m1");
    expect(b.status, JSON.stringify(b.json)).toBe(200);
    expect(await env.DB.prepare("SELECT withdrawn_by FROM reviews WHERE id = ?").bind(approved.review_id).first()).toEqual({ withdrawn_by: "m1" });
    // A fresh key: the record is at the edge for thirty seconds.
    expect((await call("GET", `/factory/approvals?t=${Date.now()}`)).json.approvals.find((a: any) => a.name === "good")).toMatchObject({ standing: false });
    const rec = await record(b.json.record);
    expect(rec.verified).toBe(true);
    expect(rec.doc).toMatchObject({ decision: "block", name: "good", by: "m1", via: "token", agent: null });
    expect((await line("block", "good")).payload).toMatchObject({ by: "m1", via: "token", agent: null });
    // Lifted by another maintainer, on the record the same way.
    const lift = await call("POST", "/factory/packages/good/unblock", { reason: "the source builds it now" }, "omc_m2");
    expect((await record(lift.json.record)).doc).toMatchObject({ decision: "unblock", by: "m2", via: "token", agent: null });
  });
});

describe("adopt", () => {
  it("a maintainer takes a package its owner left unmaintained: theirs, where it stood before, signed and journaled; refused to anyone else, to a package that has a maintainer, and twice", async () => {
    await env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status, detail) VALUES
      ('orphan', 'dave', 'https://orphan.example', '["x86_64"]', 'unmaintained', 'no worker built its bump in 30 days'),
      ('kept', 'dave', 'https://kept.example', '["x86_64"]', 'published', '1.0-1 in edge')`).run();
    expect((await call("POST", "/factory/packages/orphan/adopt", {})).status).toBe(401);
    expect((await call("POST", "/factory/packages/orphan/adopt", {}, "omc_bob")).json).toEqual({ error: "a maintainer decides", code: "maintainer_only" });
    expect((await call("POST", "/factory/packages/kept/adopt", {}, "omc_m1")).json.error).toBe("kept has a maintainer: it is published, dave's");
    expect((await call("POST", "/factory/packages/nothing-here/adopt", {}, "omc_m1")).status).toBe(404);
    const [a, b] = await Promise.all([call("POST", "/factory/packages/orphan/adopt", { reason: "I use it every day" }, "omc_m1"), call("POST", "/factory/packages/orphan/adopt", {}, "omc_m2")]);
    const won = a.status === 200 ? a : b;
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const by = won === a ? "m1" : "m2";
    expect(won.json).toMatchObject({ adopted: "orphan", from: "dave", by, status: "registered", via: "token" });
    expect(await env.DB.prepare("SELECT owner, status FROM factory_packages WHERE name = 'orphan'").first()).toEqual({ owner: by, status: "registered" });
    const rec = await record(won.json.record);
    expect(rec.verified).toBe(true);
    expect(rec.doc).toMatchObject({ decision: "adopt", name: "orphan", from: "dave", owner: by, by, via: "token", agent: null });
    expect((await line("review", "orphan")).summary).toMatch(new RegExp(`^orphan: adopted by ${by} from dave, who left it unmaintained`));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'review' AND json_extract(payload, '$.name') = 'orphan'").first()).toEqual({ n: 1 });
  });
});

describe("the new doors' reads", () => {
  it("are led by a key: the claim's rows and the cancel by their ids, a worker's agent, the registration and the adoption by the primary key", async () => {
    const plan = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    const ids = JSON.stringify([1, 2]);
    for (const [sql, args] of [
      ["SELECT id, arch, status, lease_owner, pinned_to, json_extract(params, '$.by') AS by, json_extract(params, '$.agent') AS agent FROM build_tasks WHERE id IN (SELECT value FROM json_each(?))", [ids]],
      ["UPDATE build_tasks SET status = 'cancelled', error = ?, lease_expires_at = NULL, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id IN (SELECT value FROM json_each(?)) AND +status IN ('queued', 'leased')", ["x", ids]],
      ["SELECT agent FROM build_workers WHERE id = ?", ["px"]],
      ["SELECT request_id FROM factory_packages WHERE name = ?", ["good"]],
      ["UPDATE factory_packages SET owner = ?, status = ?, detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ? AND status = 'unmaintained' AND blocked_at IS NULL", ["m1", "registered", "x", "orphan"]],
    ] as const) {
      const p = await plan(sql, ...args);
      expect(p, sql).toMatch(/SEARCH (build_tasks|build_workers|factory_packages) USING (INTEGER PRIMARY KEY|INDEX sqlite_autoindex_\w+)/);
      expect(p, sql).not.toMatch(/SCAN (build_tasks|build_workers|factory_packages)\b/);
    }
  });
});
