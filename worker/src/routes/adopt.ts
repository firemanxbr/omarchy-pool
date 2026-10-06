import { json, type Env } from "../index";
import { PROMOTED_RINGS, ringsSql } from "../meta";
import { isMaintainer, viaOf, type Contributor } from "./contributors";
import { decisionRecord } from "./review";
import { standsSql } from "./story";
import { SELF_REVIEWED, soloMark, soloOf, type Solo } from "../governance";

/**
 * Adopt: the one act that gives a package its maintainer in the pool — the
 * maintainer who looks after it, the one to ask about it, the one who
 * notices when it must be blocked (#244) — and, for a registration its owner
 * left unmaintained, the registration too (#247). One route, one handler:
 * the package page's Adopt and Review's No maintainer tab both post here.
 *
 *   POST /factory/packages/:name/adopt {reason?}   a maintainer, on a package a ring serves. Always: a
 *                                                  package_maintainers row names them its maintainer of record, and
 *                                                  the package page says so after (maintenanceOf, routes/users.ts).
 *                                                  When the package is a factory registration whose status is
 *                                                  `unmaintained` — thirty days without a build of its bump
 *                                                  (updates.ts) — the same press also takes the registration: its
 *                                                  bumps come to the adopter's workers, another maintainer reviews
 *                                                  them, and the conflict-of-interest rule treats the adopter as its
 *                                                  owner from then on.
 *
 * Refused: 403 to anyone who is not a maintainer (`maintainer_only`) and to
 * the registration's owner — nobody looks after their own request, the
 * two-person rule of the review (`conflict_of_interest`) — but the maintainer
 * the governance file's solo-maintainer exception names, on their own
 * package (#394): taken, and marked self-reviewed on its record and its
 * journal line; 404 when no ring
 * serves the package (a package in review is its reviewer's); 409 when it
 * has a maintainer already — one who adopted it, or, for a registration
 * that is not unmaintained, the maintainer whose approval it is served
 * under — and, for an unmaintained registration, while it is blocked or a
 * build of it is still open (that build is its requester's, and a
 * maintainer decides it first).
 *
 * Taken once: the row is the package's name, and the registration moves by
 * one conditional update in the same batch as the row, so two maintainers
 * pressing at once are one adoption and a 409. One `adopt` line in the
 * journal says which of the two it did and who; the registration's move is
 * also a record the pool signs beside the request (decisionRecord), with
 * whom it was taken from.
 */
export async function handleAdoptPackage(c: Contributor, name: string, request: Request, env: Env): Promise<Response> {
  if (!isMaintainer(c)) return json({ error: "a maintainer adopts a package", code: "maintainer_only" }, 403);
  const b = (await request.json().catch(() => ({}))) as { reason?: unknown };
  const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim().slice(0, 300) : null;
  // Served: through the name's index, then each row's membership by the rings' key — a handful of rows, never a ring. The registration and
  // its maintainer of record by their keys.
  const [served, pkg, held, solo] = await Promise.all([
    env.DB.prepare(`SELECT p.source FROM packages p WHERE p.name = ? AND EXISTS (SELECT 1 FROM ring_packages rp WHERE rp.ring IN (${ringsSql(PROMOTED_RINGS)}) AND rp.package_id = p.id) LIMIT 1`)
      .bind(name)
      .first<{ source: string }>(),
    env.DB.prepare("SELECT owner, status, blocked_at FROM factory_packages WHERE name = ?").bind(name).first<{ owner: string | null; status: string; blocked_at: string | null }>(),
    env.DB.prepare("SELECT login, since FROM package_maintainers WHERE name = ?").bind(name).first<{ login: string; since: string }>(),
    soloOf(env),
  ]);
  const unmaintained = pkg?.status === "unmaintained";
  if (!served) return json({ error: `${name} is in no ring: a package is adopted once the pool serves it` }, 404);
  // Their own package, adopted under the solo-maintainer exception (#394): the maintainer [solo] names, and only them.
  const self: Solo | null = pkg?.owner === c.login && solo?.maintainer === c.login ? solo : null;
  if (pkg?.owner === c.login && !self) return json({ error: `${c.login} requested ${name}; another maintainer looks after it${unmaintained ? " — build it to take it up again" : ""}`, code: "conflict_of_interest" }, 403);
  if (held) return json({ error: `${name} is maintained by ${held.login} (since ${held.since})` }, 409);
  const via = viaOf(request);
  if (!unmaintained) return adoptServed(c, name, served.source, via, reason, env, self);
  if (pkg.blocked_at) return json({ error: `${name} is blocked: another maintainer lifts the block first` }, 409);
  const open = await env.DB.prepare(`SELECT t.id, t.status, t.owner FROM build_tasks t WHERE ${ROUND_OPEN} ORDER BY t.id DESC LIMIT 1`).bind(name).first<{ id: number; status: string; owner: string | null }>();
  if (open) return json({ error: `build #${open.id} of ${name} is ${open.status}${open.owner ? `, ${open.owner}'s` : ""}: a maintainer decides it before anyone adopts ${name}` }, 409);
  // Where it was before it went unmaintained: published while a review stands — a ring serves it, as Adopt asks — registered otherwise.
  const standing = await env.DB.prepare(`SELECT id FROM approvals WHERE name = ? AND ${standsSql()} LIMIT 1`).bind(name).first<{ id: number }>();
  const status = standing ? "published" : "registered";
  const from = pkg.owner;
  const [moved] = await env.DB.batch([
    env.DB.prepare(ADOPT_SQL).bind(c.login, status, `adopted by ${c.login} from ${from}, who left it unmaintained${self ? `, ${SELF_REVIEWED}` : ""}${reason ? `: ${reason}` : ""}`, name, name),
    // The row only where the registration just became theirs: a second maintainer's batch finds it taken and writes nothing.
    env.DB.prepare(MAINTAINER_SQL).bind(name, c.login),
  ]);
  if (!moved.meta.changes) return json({ error: `${name} was taken a moment ago, or a build of it went into review: look again` }, 409);
  const now = await env.DB.prepare("SELECT since FROM package_maintainers WHERE name = ? AND login = ?").bind(name, c.login).first<{ since: string }>();
  const at = new Date().toISOString();
  const record = await decisionRecord(env, name, "adopt", c.login, { owner: c.login, maintainer: c.login, from, status, by: c.login, via, agent: null, at, reason, ...(self ? { solo_exception: self } : {}) });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('adopt', NULL, 'factory', 'ok', ?, ?)")
    .bind(
      `${name} adopted by ${c.login}: its maintainer in the pool, and its registration, taken from ${from}, who left it unmaintained${self ? ` — ${SELF_REVIEWED}` : ""}${reason ? ` — ${reason.slice(0, 120)}` : ""}`,
      JSON.stringify({ name, by: c.login, source: "factory", via, registration: { from, status }, reason, record: record.url, ...(record.error ? { record_error: record.error } : {}), ...(self ? { solo_exception: soloMark(self) } : {}) }),
    )
    .run();
  return json({ adopted: name, by: c.login, since: now?.since ?? at, via, registration: { from, status }, record: record.url, ...(self ? { solo_exception: soloMark(self) } : {}) });
}

/**
 * A package a ring serves that is no registration left unmaintained: the maintainer of record only — the package stays what it was,
 * synced or built here. Taken by its own requester under the solo-maintainer exception (#394, `self`), it is a decision on the record
 * like the registration's: signed, and marked self-reviewed on its line.
 */
async function adoptServed(c: Contributor, name: string, source: string, via: ReturnType<typeof viaOf>, reason: string | null, env: Env, self: Solo | null = null): Promise<Response> {
  // A package the factory built has its maintainer already: the one whose approval it is served under.
  const approval = await env.DB.prepare(`SELECT by FROM approvals WHERE name = ? AND ${standsSql()} ORDER BY id DESC LIMIT 1`).bind(name).first<{ by: string }>();
  if (approval) return json({ error: `${name} is maintained by ${approval.by}, whose approval it is served under` }, 409);
  const took = await env.DB.prepare("INSERT INTO package_maintainers (name, login) VALUES (?, ?) ON CONFLICT (name) DO NOTHING").bind(name, c.login).run();
  const now = await env.DB.prepare("SELECT login, since FROM package_maintainers WHERE name = ?").bind(name).first<{ login: string; since: string }>();
  if (!took.meta.changes) return json({ error: `${name} is maintained by ${now?.login ?? "another maintainer"} (since ${now?.since ?? "a moment ago"})` }, 409);
  const record = self ? await decisionRecord(env, name, "adopt", c.login, { maintainer: c.login, source, by: c.login, via, agent: null, at: now?.since ?? new Date().toISOString(), reason, solo_exception: self }) : null;
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('adopt', NULL, ?, 'ok', ?, ?)")
    .bind(source, `${name} adopted by ${c.login}: its maintainer in the pool${self ? ` — ${SELF_REVIEWED}` : ""}`, JSON.stringify({ name, by: c.login, source, via, registration: null, ...(reason ? { reason } : {}), ...(record ? { record: record.url, ...(record.error ? { record_error: record.error } : {}) } : {}), ...(self ? { solo_exception: soloMark(self) } : {}) }))
    .run();
  return json({ adopted: name, by: c.login, since: now?.since ?? null, via, registration: null, ...(record ? { record: record.url } : {}), ...(self ? { solo_exception: soloMark(self) } : {}) });
}

/**
 * A build of the package still open — queued, running, or staged with no approval standing on it — by the name's
 * (name, arch, id) index: what an adoption of a registration waits for. A contributor's build whose project build was
 * approved has served, as Review's list reads it (handleReviewList): the approval stands on the project's build, and the
 * evidence it answered stays staged — without the second test no package that was ever approved could be adopted.
 */
const ROUND_OPEN = `t.name = ? AND +t.kind = 'build' AND +t.status IN ('queued', 'leased', 'staged')
  AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.task_id = t.id AND a.decision = 'approved' AND a.withdrawn_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM build_tasks r JOIN approvals a ON a.task_id = r.id WHERE r.name = t.name AND json_extract(r.params, '$.review') = t.id AND a.decision = 'approved' AND a.withdrawn_at IS NULL)`;
/** The registration taken, by its primary key: only while it is unmaintained, not blocked, and nothing of it is open (ROUND_OPEN). */
export const ADOPT_SQL = `UPDATE factory_packages SET owner = ?, status = ?, detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE name = ? AND status = 'unmaintained' AND blocked_at IS NULL AND NOT EXISTS (SELECT 1 FROM build_tasks t WHERE ${ROUND_OPEN})`;
/** The maintainer of record beside it, in the same batch: only where the registration is now the adopter's and no longer unmaintained — so it is written by the batch whose ADOPT_SQL took the registration, and by no other. */
export const MAINTAINER_SQL = `INSERT INTO package_maintainers (name, login)
  SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM factory_packages WHERE name = ?1 AND owner = ?2 AND status != 'unmaintained')
  ON CONFLICT (name) DO NOTHING`;
