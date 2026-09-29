import { json, type Env } from "../index";
import { PROMOTED_RINGS, ringsSql } from "../meta";
import { isMaintainer, type Contributor } from "./contributors";
import { standsSql } from "./story";

/**
 * A package's maintainer in the pool (#244): the maintainer who looks after
 * a package the pool serves — the one to ask about it, the one who notices
 * when it must be blocked. A package the factory built has one from its
 * approval: the maintainer whose approval stands. A synced package has none
 * until a maintainer adopts it; the package page offers Adopt to a
 * maintainer then, and says whose it is after.
 *
 *   POST /factory/packages/:name/adopt   a maintainer: the package becomes theirs to look after. 404 when no ring
 *                                        serves it (a package in review is its reviewer's), 403 to the contributor
 *                                        who requested it — nobody looks after their own request, the two-person rule
 *                                        of the review — and 409 when it has a maintainer already. An `adopt` line in
 *                                        the journal says who.
 *
 * Who is its maintainer is read by maintenanceOf (routes/users.ts), on the
 * package's page data; the row is the package's name, so two maintainers
 * pressing at once is one statement that one of them wins.
 */
export async function handleAdoptPackage(c: Contributor, name: string, env: Env): Promise<Response> {
  if (!isMaintainer(c)) return json({ error: "a maintainer adopts a package" }, 403);
  // Served: through the name's index, then each row's membership by the rings' key — a handful of rows, never a ring.
  const served = await env.DB.prepare(`SELECT p.source FROM packages p WHERE p.name = ? AND EXISTS (SELECT 1 FROM ring_packages rp WHERE rp.ring IN (${ringsSql(PROMOTED_RINGS)}) AND rp.package_id = p.id) LIMIT 1`)
    .bind(name)
    .first<{ source: string }>();
  if (!served) return json({ error: `${name} is in no ring: a package is adopted once the pool serves it` }, 404);
  const request = await env.DB.prepare("SELECT owner FROM factory_packages WHERE name = ?").bind(name).first<{ owner: string | null }>();
  if (request?.owner === c.login) return json({ error: `${c.login} requested ${name}; another maintainer looks after it` }, 403);
  const approval = await env.DB.prepare(`SELECT by FROM approvals WHERE name = ? AND ${standsSql()} ORDER BY id DESC LIMIT 1`).bind(name).first<{ by: string }>();
  if (approval) return json({ error: `${name} is maintained by ${approval.by}, whose approval it is served under` }, 409);
  const took = await env.DB.prepare("INSERT INTO package_maintainers (name, login) VALUES (?, ?) ON CONFLICT (name) DO NOTHING").bind(name, c.login).run();
  const now = await env.DB.prepare("SELECT login, since FROM package_maintainers WHERE name = ?").bind(name).first<{ login: string; since: string }>();
  if (!took.meta.changes) return json({ error: `${name} is maintained by ${now?.login ?? "another maintainer"} (since ${now?.since ?? "a moment ago"})` }, 409);
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('adopt', NULL, ?, 'ok', ?, ?)")
    .bind(served.source, `${name} adopted by ${c.login}: its maintainer in the pool`, JSON.stringify({ name, by: c.login, source: served.source }))
    .run();
  return json({ adopted: name, by: c.login, since: now?.since ?? null });
}
