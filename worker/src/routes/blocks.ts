import { json, type Env } from "../index";
import { isMaintainer, viaOf, type Contributor } from "./contributors";
import { handleCreateRelease } from "./releases";
import { createJob } from "../scheduler";
import { putRecord, recordKey, recordUrl } from "../record";
import { REPO_ARCHES } from "../r2";
import { standsSql } from "./story";
import { settleTargets } from "../targets";
import { throughWords, type Through } from "../agents";
import { DISCARD_SQL } from "./agents";
import { decidedWith, type PasskeyGate } from "./passkeys";
import { cancelOrdersOf } from "../orders";

/**
 * Blocking — the maintainers' brake (docs/GOVERNANCE.md, *Blocking*).
 *
 *   POST /factory/contributors/:login/block   {reason, assertion}  a maintainer, not the login itself, with their passkey:
 *                                                       no more requests or builds; their workers revoked, their queued and
 *                                                       staged builds cancelled, their packages rejected. The record:
 *                                                       contributors/<login>/block-<t>.json
 *   POST /factory/contributors/:login/unblock {reason}  another maintainer than the one who blocked
 *   POST /factory/packages/:name/block        {reason, assertion}  any maintainer, with their passkey: the package — every
 *                                                       architecture of it — leaves every ring (a release per ring, edge
 *                                                       re-rendered), its builds cancelled, the review it stood on withdrawn,
 *                                                       its bumps stopped, its project refused to new requests. The record:
 *                                                       factory/<name>/<request>/decision-<t>.json
 *   POST /factory/packages/:name/unblock      {reason}  another maintainer than the one who blocked: back to the factory,
 *                                                       registered (a new build and a new review follow)
 *   GET  /factory/blocks                                what is blocked, and by whom (public)
 *
 * Each is signed on the record and a journal line naming who and through
 * which door (`via`, contributors.ts); `agent` is null — a block rests on no
 * agent's rebuild, as Review's decisions do (routes/review.ts). A package's
 * block an agent drafted and the person confirmed in the browser (#252,
 * routes/agents.ts) carries `through` — the agent, its client, the grant and
 * the draft — on its record and its line. A contributor's block ends their
 * agents' grants with their workers.
 *
 * A block — of a contributor or of a package — is decided with the
 * maintainer's passkey (#271): the web's own Block posts an assertion for
 * this act (`assertion`, routes/passkeys.ts webGate), a draft brings the one
 * its confirmation was made with (`through.passkey`); the record and the
 * line name it. A lift is not: it takes nothing out of a ring.
 */

/** A blocked contributor's grants, every one not revoked yet — the live ones and a code not swapped — by the login's index: a maintainer's act, once per person. */
export const BLOCK_GRANTS_SQL = "UPDATE agent_grants SET revoked_at = ?, revoked_by = 'blocked' WHERE login = ? AND revoked_at IS NULL";

function need(c: Contributor): Response | null {
  return isMaintainer(c) ? null : json({ error: "a maintainer is required" }, 403);
}

const stamp = (): string => new Date().toISOString().replace(/[-:.Z]/g, "");

export async function handleBlockContributor(c: Contributor, login: string, request: Request, env: Env, gate?: PasskeyGate): Promise<Response> {
  const denied = need(c);
  if (denied) return denied;
  const b = (await request.json().catch(() => ({}))) as { reason?: string; assertion?: unknown };
  if (!b.reason || b.reason.trim().length < 4) return json({ error: "a reason is required; it is on the record" }, 400);
  if (login === c.login) return json({ error: "nobody blocks themselves" }, 400);
  const who = await env.DB.prepare("SELECT login, role, blocked_at FROM contributors WHERE login = ?").bind(login).first<{ login: string; role: string; blocked_at: string | null }>();
  if (!who) return json({ error: `${login} has never signed in` }, 404);
  if (who.role === "maintainer") return json({ error: `${login} is a maintainer: that is a governance pull request (factory/MAINTAINERS.toml), not a block` }, 409);
  if (who.blocked_at) return json({ error: `${login} is already blocked (since ${who.blocked_at})` }, 409);
  // The brake is decided with the maintainer's passkey (#271): checked once the block is allowed, before anything is written.
  const passkey = await decidedWith(undefined, gate, b.assertion);
  if (passkey instanceof Response) return passkey;
  const at = new Date().toISOString();
  const packages = (await env.DB.prepare("SELECT name FROM factory_packages WHERE owner = ?").bind(login).all<{ name: string }>()).results.map((r) => r.name);
  const workers = (await env.DB.prepare("SELECT id FROM build_workers WHERE owner = ? AND revoked_at IS NULL").bind(login).all<{ id: string }>()).results.map((r) => r.id);
  await env.DB.batch([
    env.DB.prepare("UPDATE contributors SET blocked_at = ?, blocked_by = ?, blocked_reason = ? WHERE login = ?").bind(at, c.login, b.reason, login),
    env.DB.prepare("UPDATE build_workers SET revoked_at = ? WHERE owner = ? AND revoked_at IS NULL").bind(at, login),
    // Their workers' open orders are cancelled with them, each with its line (#277).
    ...cancelOrdersOf(env, { sql: "SELECT id FROM build_workers WHERE owner = ? AND revoked_at = ?", binds: [login, at] }, c.login, at),
    // Their agents' grants end with their workers (#252): the tokens stop at once, a code not yet swapped too — and what their agents drafted and nobody confirmed yet is discarded with them.
    env.DB.prepare(BLOCK_GRANTS_SQL).bind(at, login),
    env.DB.prepare(DISCARD_SQL).bind(login, JSON.stringify({ error: `${login} was blocked by a maintainer: the agent's grant ended, and nothing was decided` })),
    // Other people's builds asked of the blocked person's shared workers go back to the queue.
    env.DB.prepare("UPDATE build_tasks SET pinned_to = NULL, shared_after = NULL WHERE status = 'queued' AND pinned_to IN (SELECT id FROM build_workers WHERE owner = ?)").bind(login),
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = ? WHERE owner = ? AND trust = 'community' AND status IN ('queued', 'leased', 'staged')").bind(`${login} was blocked by ${c.login}: ${b.reason.slice(0, 200)}`, login),
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'the build it audited was cancelled: its owner was blocked' WHERE kind = 'audit' AND status = 'queued' AND json_extract(params, '$.owner') = ?").bind(login),
    // Rejected, and held: a block frees none of their names (contributors.ts, nameIsFree) — a name a review had already freed, and nobody built since, stays free.
    env.DB.prepare("UPDATE factory_packages SET status = 'rejected', freed_by_review = CASE WHEN status = 'rejected' THEN freed_by_review END, detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE owner = ?").bind(`owner blocked by ${c.login}: ${b.reason.slice(0, 200)}`, login),
  ]);
  // Their builds stopped: each package's architectures say so.
  await settleTargets(env, packages);
  const key = `contributors/${login}/block-${stamp()}.json`;
  const via = viaOf(request);
  const record = await putRecord(env, key, { schema: "omarchy-pool/block/1", kind: "contributor", login, by: c.login, via, passkey, agent: null, at, reason: b.reason, packages, workers_revoked: workers });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('block', NULL, 'factory', 'warn', ?, ?)")
    .bind(`${login} blocked by ${c.login}: ${b.reason.slice(0, 140)} — ${packages.length} package(s) rejected, ${workers.length} worker(s) revoked`, JSON.stringify({ login, by: c.login, via, passkey, agent: null, reason: b.reason, packages, workers, record: recordUrl(env, record.key) }))
    .run();
  return json({ blocked: login, by: c.login, at, passkey, packages, workers_revoked: workers, record: recordUrl(env, record.key) });
}

export async function handleUnblockContributor(c: Contributor, login: string, request: Request, env: Env): Promise<Response> {
  const denied = need(c);
  if (denied) return denied;
  const b = (await request.json().catch(() => ({}))) as { reason?: string };
  if (!b.reason || b.reason.trim().length < 4) return json({ error: "a reason is required; it is on the record" }, 400);
  const who = await env.DB.prepare("SELECT blocked_at, blocked_by FROM contributors WHERE login = ?").bind(login).first<{ blocked_at: string | null; blocked_by: string | null }>();
  if (!who?.blocked_at) return json({ error: `${login} is not blocked` }, 409);
  if (who.blocked_by === c.login) return json({ error: `${c.login} blocked ${login}; another maintainer lifts it` }, 403);
  const at = new Date().toISOString();
  await env.DB.prepare("UPDATE contributors SET blocked_at = NULL, blocked_by = NULL, blocked_reason = NULL WHERE login = ?").bind(login).run();
  const via = viaOf(request);
  const record = await putRecord(env, `contributors/${login}/unblock-${stamp()}.json`, { schema: "omarchy-pool/block/1", kind: "contributor", login, by: c.login, via, agent: null, at, reason: b.reason, lifted: { blocked_at: who.blocked_at, blocked_by: who.blocked_by } });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('block', NULL, 'factory', 'ok', ?, ?)")
    .bind(`${login} unblocked by ${c.login}: ${b.reason.slice(0, 140)} (blocked by ${who.blocked_by} since ${who.blocked_at}); workers and packages need registering again`, JSON.stringify({ login, by: c.login, via, agent: null, reason: b.reason, record: recordUrl(env, record.key) }))
    .run();
  return json({ unblocked: login, by: c.login, at, record: recordUrl(env, record.key) });
}

/**
 * The package leaves every ring: one release per ring that serves it,
 * removing the name from source factory, then a render job per
 * architecture so pacman sees it gone. Nothing of the object is deleted —
 * the record and GC's retention keep the history — it is simply no longer
 * served.
 */
export async function pullFromRings(env: Env, name: string, note: string): Promise<{ ring: string; release: number | null }[]> {
  const rings = (await env.DB.prepare("SELECT DISTINCT rp.ring FROM ring_packages rp JOIN packages p ON p.id = rp.package_id WHERE p.name = ? AND p.source = 'factory'").bind(name).all<{ ring: string }>()).results.map((r) => r.ring);
  const out: { ring: string; release: number | null }[] = [];
  for (const ring of rings) {
    const res = await handleCreateRelease(new Request("http://brain/release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ring, remove_from: [{ source: "factory", name }], note }) }), env);
    const body = (await res.json().catch(() => ({}))) as { release?: { id: number } };
    out.push({ ring, release: res.ok ? (body.release?.id ?? null) : null });
    if (res.ok) for (const arch of REPO_ARCHES) await createJob(env, { kind: "render", params: { ring, arch }, arch }, `block: ${name} left ${ring}`);
  }
  return out;
}

/**
 * A block covers the package, every architecture and every ring (#242): it
 * leaves the rings, its builds in flight or staged stop, and the review it
 * stood on is withdrawn with the block's reason — the package goes back to
 * the factory, and once another maintainer lifts the block it is built and
 * reviewed again from the start (the bumps of an approval no longer
 * standing never queue). Everything of the package's until now is a
 * closed round: its targets start from what is built after.
 */
/**
 * Who may block a package, and whether it can be: a maintainer, with a
 * reason of four characters or more, a package that was requested and is
 * not blocked already — the registration, or the refusal the door sends. The
 * block's door reads it, and so do an agent's draft of a block and its
 * confirmation in the browser (routes/agents.ts), so the rule is here once.
 */
export async function blockRefusal(c: Contributor, name: string, reason: unknown, env: Env): Promise<Response | { name: string; owner: string; request_id: number | null; blocked_at: string | null }> {
  const denied = need(c);
  if (denied) return denied;
  if (typeof reason !== "string" || reason.trim().length < 4) return json({ error: "a reason is required; it is on the record" }, 400);
  const pkg = await env.DB.prepare("SELECT name, owner, request_id, blocked_at FROM factory_packages WHERE name = ?").bind(name).first<{ name: string; owner: string; request_id: number | null; blocked_at: string | null }>();
  if (!pkg) return json({ error: `${name} was never requested` }, 404);
  if (pkg.blocked_at) return json({ error: `${name} is already blocked (since ${pkg.blocked_at})` }, 409);
  return pkg;
}

export async function handleBlockPackage(c: Contributor, name: string, request: Request, env: Env, through?: Through, gate?: PasskeyGate): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { reason?: string; assertion?: unknown };
  const pkg = await blockRefusal(c, name, b.reason, env);
  if (pkg instanceof Response) return pkg;
  // Every ring loses it: decided with a passkey (#271) — the draft's, or the web's own answer for this block — once the block is allowed, before anything is written.
  const passkey = await decidedWith(through, gate, b.assertion);
  if (passkey instanceof Response) return passkey;
  b.reason = b.reason!.trim();
  const at = new Date().toISOString();
  const note = `blocked by ${c.login}: ${b.reason.slice(0, 200)}`;
  const rings = await pullFromRings(env, name, note);
  const withdrawn = (await env.DB.prepare(`SELECT id, review_id, arch FROM approvals WHERE name = ? AND ${standsSql()} ORDER BY id`).bind(name).all<{ id: number; review_id: number | null; arch: string }>()).results;
  await env.DB.batch([
    env.DB.prepare("UPDATE factory_packages SET status = 'rejected', blocked_at = ?, blocked_by = ?, blocked_reason = ?, detail = ?, closed_through = MAX(closed_through, COALESCE((SELECT MAX(t.id) FROM build_tasks t WHERE t.name = factory_packages.name AND +t.kind = 'build'), 0)), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(at, c.login, b.reason, note, name),
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = ? WHERE name = ? AND kind IN ('build', 'publish') AND status IN ('queued', 'leased', 'staged')").bind(note, name),
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'the build it audited was blocked' WHERE kind = 'audit' AND status = 'queued' AND json_extract(params, '$.name') = ?").bind(name),
    // The review it stood on, every architecture of it: withdrawn by the block, with its reason.
    env.DB.prepare(`UPDATE approvals SET withdrawn_at = ?, withdrawn_by = ?, withdrawn_reason = ? WHERE name = ? AND ${standsSql()}`).bind(at, c.login, note, name),
    env.DB.prepare("UPDATE reviews SET withdrawn_at = ?, withdrawn_by = ?, withdrawn_reason = ? WHERE name = ? AND decision = 'approved' AND withdrawn_at IS NULL").bind(at, c.login, note, name),
  ]);
  await settleTargets(env, name);
  const key = pkg.request_id ? recordKey(name, pkg.request_id, `decision-${stamp()}.json`) : `factory/${name}/0/decision-${stamp()}.json`;
  const reviews = [...new Set(withdrawn.map((a) => a.review_id ?? a.id))];
  const via = viaOf(request);
  const record = await putRecord(env, key, { schema: "omarchy-pool/decision/1", decision: "block", name, owner: pkg.owner, by: c.login, via, ...(through ? { through } : { passkey }), agent: null, at, reason: b.reason, rings, withdrawn: { reviews, approvals: withdrawn.map((a) => a.id), arches: [...new Set(withdrawn.map((a) => a.arch))] } });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('block', NULL, 'factory', 'warn', ?, ?)")
    .bind(`${name} blocked by ${c.login}${throughWords(through)}: ${b.reason.slice(0, 140)}${rings.length ? " — pulled from " + rings.map((r) => r.ring).join(", ") : ""}${reviews.length ? ` — the approval withdrawn, back to the factory` : ""}`, JSON.stringify({ name, owner: pkg.owner, by: c.login, via, ...(through ? { through } : { passkey }), agent: null, reason: b.reason, rings, withdrawn: reviews, record: recordUrl(env, record.key) }))
    .run();
  return json({ blocked: name, by: c.login, at, rings, withdrawn: reviews, ...(through ? { through } : { passkey }), record: recordUrl(env, record.key) });
}

export async function handleUnblockPackage(c: Contributor, name: string, request: Request, env: Env): Promise<Response> {
  const denied = need(c);
  if (denied) return denied;
  const b = (await request.json().catch(() => ({}))) as { reason?: string };
  if (!b.reason || b.reason.trim().length < 4) return json({ error: "a reason is required; it is on the record" }, 400);
  const pkg = await env.DB.prepare("SELECT owner, request_id, blocked_at, blocked_by FROM factory_packages WHERE name = ?").bind(name).first<{ owner: string; request_id: number | null; blocked_at: string | null; blocked_by: string | null }>();
  if (!pkg?.blocked_at) return json({ error: `${name} is not blocked` }, 409);
  if (pkg.blocked_by === c.login) return json({ error: `${c.login} blocked ${name}; another maintainer lifts it` }, 403);
  const at = new Date().toISOString();
  // Back to the factory: registered, its owner's; a new build and a new review start it over.
  await env.DB.prepare("UPDATE factory_packages SET status = 'registered', blocked_at = NULL, blocked_by = NULL, blocked_reason = NULL, detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(`block lifted by ${c.login}: ${b.reason.slice(0, 200)}; a new build starts it over`, name).run();
  const key = pkg.request_id ? recordKey(name, pkg.request_id, `decision-${stamp()}.json`) : `factory/${name}/0/decision-${stamp()}.json`;
  const via = viaOf(request);
  const record = await putRecord(env, key, { schema: "omarchy-pool/decision/1", decision: "unblock", name, owner: pkg.owner, by: c.login, via, agent: null, at, reason: b.reason, lifted: { blocked_at: pkg.blocked_at, blocked_by: pkg.blocked_by } });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('block', NULL, 'factory', 'ok', ?, ?)")
    .bind(`${name} unblocked by ${c.login}: ${b.reason.slice(0, 140)} (blocked by ${pkg.blocked_by} since ${pkg.blocked_at})`, JSON.stringify({ name, by: c.login, via, agent: null, reason: b.reason, record: recordUrl(env, record.key) }))
    .run();
  return json({ unblocked: name, by: c.login, at, record: recordUrl(env, record.key) });
}

export async function handleBlocks(env: Env): Promise<Response> {
  const [contributors, packages] = await Promise.all([
    env.DB.prepare("SELECT login, blocked_at, blocked_by, blocked_reason FROM contributors WHERE blocked_at IS NOT NULL ORDER BY blocked_at DESC").all(),
    env.DB.prepare("SELECT name, owner, blocked_at, blocked_by, blocked_reason FROM factory_packages WHERE blocked_at IS NOT NULL ORDER BY blocked_at DESC").all(),
  ]);
  return json({ contributors: contributors.results, packages: packages.results }, 200, { "cache-control": "no-store" });
}
