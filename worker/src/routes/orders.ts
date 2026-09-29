/**
 * The doors of #277's orders (orders.ts has the rules, the caps and the
 * record):
 *
 *   POST   /factory/workers/self/orders/:id    the worker's answer, with its own token and the process that took it
 *   POST   /factory/workers/:id/orders         a person's order: its owner or any maintainer
 *   DELETE /factory/workers/:id/orders/:oid    a waiting order cancelled, by the same people
 *   GET    /factory/workers/:id                the worker's view and its last orders, public — never the worker's own words
 *   GET    /factory/workers/:id/orders         the same list with the worker's words, for its owner and the maintainers
 *   GET    /factory/workers/:id/can            what this caller may press, with the reason where not
 *   GET    /factory/follow?ids=a,b             the pool's release and the open Updates of those workers: what a set's updater polls (#277, part 3)
 *
 * One predicate (orderVerdicts) answers the door and /can: a grey button is
 * one the door refuses in the same words. A write with the session comes
 * from the page itself — JSON, and the pool's own Origin — so another site
 * cannot make a signed-in browser press anything; a token's write needs
 * the JSON header only when it carries a body. An agent's token (oma_) is
 * refused before any of this runs (agents.ts agentTokenRefusal): no route
 * here is an agent's.
 */
import { json, readJson, type Env } from "../index";
import { isMaintainer, viaOf, type Contributor } from "./contributors";
import { aliveSince, workerView, type WorkerRow } from "./factory";
import { version as running } from "../meta";
import {
  answerCode, breakerKey, breakerOf, breakerScope, capRefusal, cleanText, codeSentence, isOrderKind, loginCapWords, issueOrder, openOrdersOf, orderFacts, orderVerdicts, providerOf, readSite, refreshOpen, rulesScale, siteWords,
  ORDER_KINDS, ORDER_RIGHTS, OUTCOMES, RIGHT_OF, SITE_WORKERS_SQL, FOLLOW_MAX_IDS, FOLLOW_POLL_S, TTL_UPDATE_MIN,
  ANSWER_WITHIN_MIN, GIVE_UP_AFTER_MIN, MAX_ORDERS_PER_LOGIN_HOUR, MAX_POOL_ORDERS_PER_DAY, MAX_POOL_RECHECKS_PER_DAY, MAX_POOL_RESTARTS_PER_DAY, MAX_POOL_RESTARTS_PER_SPELL, MAX_RECHECKS_PER_HOUR,
  MAX_RESTARTS_PER_HOUR, MIN_UPTIME_S, RECHECK_AFTER_MIN, RESTART_AFTER_MIN, RESTART_SPACING_MIN, TTL_PERSON_MIN,
  type OrderKind, type OrderWorker, type Outcome,
} from "../orders";
import { WORKER_ALIVE_MINUTES } from "../meta";
import { updateState } from "../update";

const NO_STORE = { "cache-control": "no-store" };
const MIN = 60000;

/** The worker's row as the doors read it, by the primary key. */
async function workerRow(env: Env, id: string): Promise<(WorkerRow & OrderWorker & { id: string; current_task: number | null; site: string | null; agent_checked_at: string | null; arch: string }) | null> {
  return env.DB.prepare("SELECT * FROM build_workers WHERE id = ?").bind(id).first();
}

/**
 * A write from the page is JSON and comes from the page's own origin: the
 * session cookie is SameSite=Lax already, and this closes the rest — a
 * form another site posts cannot set the header, and its Origin is not the
 * pool's. A token's write (a person's curl) needs the header only with a
 * body; a browser never attaches a token.
 */
export function writeGate(request: Request, url: URL, withBody: boolean): Response | null {
  const json_ = (request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
  if (viaOf(request) === "web") {
    if (!json_) return json({ error: "a write from the page is JSON (content-type: application/json)" }, 415);
    if (request.headers.get("origin") !== url.origin) return json({ error: "not from this page: a write with the session comes from the pool's own pages", code: "origin" }, 403);
  } else if (withBody && !json_) return json({ error: "the body is JSON (content-type: application/json)" }, 415);
  return null;
}

const KIND_LABEL: Record<OrderKind, string> = { "recheck-agent": "Re-check agent", restart: "Restart", "restart-agent": "Restart agent service", drain: "Drain", resume: "Resume", "stop-task": "Stop its task", update: "Update" };

/** When an Update is carried out, in the words the page and the door say it: by the set's updater, never the worker (§1.11.5). */
function updateNote(w: { trust: string; current_task: number | null }): string {
  const soon = `within ${FOLLOW_POLL_S / 60} min`;
  const drain = w.current_task ? ` — task #${w.current_task} finishes first (up to 3 h)` : "";
  return w.trust === "project"
    ? `its set's updater replaces it ${soon}, with every service there that runs an older image${drain}`
    : `its set's updater replaces it ${soon} (an updater from before #277 replaces it at its own 15-min round)${drain}; if nothing does, the order expires in ${TTL_UPDATE_MIN / 60} h`;
}

/** When the order reaches the worker, in the words the page and the door say it. */
function deliveryNote(w: { last_seen: string; current_task: number | null }): string {
  const alive = Date.parse(w.last_seen) > aliveSince();
  if (!alive) return `delivered with its next claim — it is offline now; the order waits up to ${TTL_PERSON_MIN / 60} h for it`;
  return w.current_task ? `delivered with its next claim — after task #${w.current_task}, which it builds now` : "delivered with its next claim — within 30 s while it is idle";
}

/** POST /factory/workers/:id/orders — a person's order (#277): its owner or any maintainer, under every cap, on the record. */
export async function handleIssueOrder(c: Contributor, id: string, request: Request, env: Env, url: URL): Promise<Response> {
  const gate = writeGate(request, url, true);
  if (gate) return gate;
  const b = await readJson<{ kind?: unknown; reason?: unknown; unless_agent_ok?: unknown }>(request);
  if (b instanceof Response) return b;
  if (!isOrderKind(b.kind)) return json({ error: `kind is one of ${ORDER_KINDS.join(", ")}` }, 400);
  const kind = b.kind;
  const w = await workerRow(env, id);
  if (!w) return json({ error: "no such worker" }, 404);
  const now = Date.now();
  const facts = await orderFacts(env, w.id, c.login, now);
  const verdict = orderVerdicts(c, w, facts)[RIGHT_OF[kind]];
  // The login's cap is journaled once per hour whichever check met it first: this one, or the INSERT's.
  if (!verdict.ok && verdict.status === 409 && facts.loginHour >= MAX_ORDERS_PER_LOGIN_HOUR && verdict.why === loginCapWords(c.login, facts.loginFreeAt)) return json({ error: await capRefusal(env, { worker: w.id, kind, by: c.login, now }) }, 409);
  if (!verdict.ok) return json({ error: verdict.why }, verdict.status);
  let reason = b.reason === undefined || b.reason === null ? "" : cleanText(b.reason, 300);
  if (reason === null) return json({ error: "the reason looks like it carries a secret, and it is public: say it without" }, 400);
  if (!reason) reason = `${KIND_LABEL[kind]} from the worker's page`;
  const unless = kind === "restart" && b.unless_agent_ok === true;
  const via = viaOf(request) === "web" ? "web" : "token";
  const issued = await issueOrder(env, {
    worker: w.id, owner: w.owner, kind, reason, by: c.login, via, rule: null, unless, site: w.site, baselineAtIssue: w.agent_checked_at, now,
    line: { status: "ok", summary: `${w.id}: ${kind} ordered by ${c.login} — ${reason}${unless ? " (only if its agent is down)" : ""}` },
  });
  if (!issued.ok) {
    if (issued.why === "open") {
      const open = openOrdersOf((await env.DB.prepare("SELECT open_orders FROM build_workers WHERE id = ?").bind(w.id).first<{ open_orders: string | null }>())?.open_orders).find((o) => o.kind === kind);
      return json({ error: `${KIND_LABEL[kind].toLowerCase()} is waiting already${open ? ` (${open.id}, by ${open.by})` : ""}` }, 409);
    }
    if (issued.why === "site") return json({ error: "a restart of this host's agent service is waiting already, through another of its workers" }, 409);
    return json({ error: await capRefusal(env, { worker: w.id, kind, by: c.login, now }) }, 409);
  }
  return json({
    order: { id: issued.id, worker: w.id, kind, reason, issued_by: c.login, via, issued_at: issued.issued_at, expires_at: issued.expires_at, unless_agent_ok: unless, state: "pending" },
    note: kind === "update" ? updateNote(w) : deliveryNote(w),
  }, 201);
}

/** An order of a worker by its id (the primary key): the Cancel's read. */
export const ORDER_OF_WORKER_SQL = "SELECT id, kind, state, issued_by, via, rule, reason FROM worker_orders WHERE id = ? AND worker_id = ?";
/** An order by its id (the primary key): the worker's answer's read. */
export const ORDER_BY_ID_SQL = "SELECT id, worker_id, kind, state, delivered_to, accepted_at, issued_by, via, rule, reason FROM worker_orders WHERE id = ?";

/** DELETE /factory/workers/:id/orders/:oid — a waiting order taken back, by its worker's owner or a maintainer; one final line. */
export async function handleCancelOrder(c: Contributor, id: string, oid: string, request: Request, env: Env, url: URL): Promise<Response> {
  const gate = writeGate(request, url, false);
  if (gate) return gate;
  const w = await workerRow(env, id);
  if (!w) return json({ error: "no such worker" }, 404);
  const v = orderVerdicts(c, w, { now: Date.now(), restartsHour: 0, rechecksHour: 0, loginHour: 0, restartsFreeAt: null, rechecksFreeAt: null, loginFreeAt: null }).cancel;
  if (!v.ok) return json({ error: v.why }, v.status);
  const o = await env.DB.prepare(ORDER_OF_WORKER_SQL).bind(oid, w.id).first<{ id: string; kind: OrderKind; state: string; issued_by: string; via: string | null; rule: string | null; reason: string }>();
  if (!o) return json({ error: "no such order on this worker" }, 404);
  if (o.state !== "pending") return json({ error: o.state === "delivered" ? "delivered already: its worker has it, and answers it" : `closed already: ${o.state}` }, 409);
  const at = new Date().toISOString();
  const detail = `cancelled by ${c.login}`;
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE worker_orders SET state = 'cancelled', answered_at = ?, answered_by = 'pool', detail = ? WHERE id = ? AND state = 'pending'").bind(at, detail, o.id),
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'order', NULL, 'factory', 'ok', ?, ? WHERE EXISTS (SELECT 1 FROM worker_orders WHERE id = ? AND state = 'cancelled' AND answered_at = ?)")
      .bind(`${w.id}: ${o.kind} cancelled — ${detail} (order ${o.id})`, JSON.stringify({ order: o.id, worker: w.id, owner: w.owner, kind: o.kind, by: o.issued_by, via: o.via, rule: o.rule, reason: o.reason, state: "cancelled", code: null, cancelled_by: c.login }), o.id, at),
    refreshOpen(env, w.id),
  ]);
  if (!res[0].meta.changes) return json({ error: "delivered or closed meanwhile" }, 409);
  return json({ order: o.id, state: "cancelled", by: c.login });
}

/**
 * POST /factory/workers/self/orders/:id — the worker's answer, with its own
 * token and the process the order went to: only that process's answer
 * counts, an acceptance once, a final answer once. The code is one of the
 * kind's closed set; the public sentence is the pool's for it, and the
 * worker's own words are kept for its owner and the maintainers. The
 * answer writes nothing of the worker's row: what its agent says is the
 * claim's to write.
 */
export async function handleAnswerOrder(w: { id: string; owner: string | null; version?: string | null }, oid: string, request: Request, env: Env): Promise<Response> {
  const b = await readJson<{ instance?: unknown; outcome?: unknown; code?: unknown; detail?: unknown; agent?: unknown; service?: unknown; seconds?: unknown }>(request);
  if (b instanceof Response) return b;
  if (!/^wo_[0-9a-f]{32}$/.test(oid)) return json({ error: "no such order" }, 404);
  const o = await env.DB.prepare(ORDER_BY_ID_SQL).bind(oid).first<{ id: string; worker_id: string; kind: OrderKind; state: string; delivered_to: string | null; accepted_at: string | null; issued_by: string; via: string | null; rule: string | null; reason: string }>();
  if (!o || o.worker_id !== w.id) return json({ error: "no such order" }, 404);
  if (!OUTCOMES.includes(b.outcome as Outcome)) return json({ error: `outcome is one of ${OUTCOMES.join(", ")}` }, 400);
  const outcome = b.outcome as Outcome;
  if (o.kind === "drain" || o.kind === "resume" || o.kind === "update" || o.kind === "stop-task") return json({ error: `a ${o.kind} is not answered by the worker` }, 409);
  if (o.state !== "delivered") return json({ error: `the order is ${o.state}, not waiting for an answer` }, 409);
  if (typeof b.instance !== "string" || b.instance !== o.delivered_to) return json({ error: "delivered to another process of this token" }, 409);
  if (outcome === "accepted" && o.accepted_at) return json({ error: "accepted already" }, 409);
  const code = answerCode(o.kind, outcome, b.code);
  // The worker's own words, and what its agent said: private, cleaned, leak-checked — the rule of its log.
  const said = [typeof b.detail === "string" ? b.detail : "", b.agent && typeof b.agent === "object" ? JSON.stringify(b.agent) : ""].filter(Boolean).join(" · ");
  const words = cleanText(said, 500, { lines: true });
  const workerDetail = words === null ? "[withheld: the answer carried what looks like a secret]" : words || null;
  const at = new Date().toISOString();
  const seconds = typeof b.seconds === "number" ? b.seconds : null;
  const service = typeof b.service === "string" ? b.service : null;
  const detail = codeSentence(o.kind, code, outcome, { version: w.version ?? null, service, seconds });
  if (outcome === "accepted") {
    const res = await env.DB.prepare("UPDATE worker_orders SET accepted_at = ?, code = ?, worker_detail = ?, detail = ? WHERE id = ? AND worker_id = ? AND delivered_to = ? AND state = 'delivered' AND accepted_at IS NULL")
      .bind(at, code, workerDetail, detail, o.id, w.id, b.instance).run();
    return res.meta.changes ? json({ order: o.id, state: "delivered", accepted: true }) : json({ error: "accepted already, or closed meanwhile" }, 409);
  }
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE worker_orders SET state = ?, answered_at = ?, answered_by = 'worker', code = ?, detail = ?, worker_detail = ? WHERE id = ? AND worker_id = ? AND delivered_to = ? AND state = 'delivered'")
      .bind(outcome, at, code, detail, workerDetail, o.id, w.id, b.instance),
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'order', NULL, 'factory', ?, ?, ? WHERE EXISTS (SELECT 1 FROM worker_orders WHERE id = ? AND state = ? AND answered_at = ? AND answered_by = 'worker')")
      .bind(outcome === "failed" ? "error" : "ok", `${w.id}: ${o.kind} ${outcome} — ${detail} (order ${o.id})`, JSON.stringify({ order: o.id, worker: w.id, owner: w.owner, kind: o.kind, by: o.issued_by, via: o.via, rule: o.rule, reason: o.reason, state: outcome, code }), o.id, outcome, at),
    refreshOpen(env, w.id),
  ]);
  return res[0].meta.changes ? json({ order: o.id, state: outcome, code }) : json({ error: "closed meanwhile" }, 409);
}

/** The rules as a worker's page quotes them. */
const RULES = {
  recheck_after_min: RECHECK_AFTER_MIN, restart_after_min: RESTART_AFTER_MIN, restart_spacing_min: RESTART_SPACING_MIN, give_up_after_min: GIVE_UP_AFTER_MIN, min_uptime_s: MIN_UPTIME_S,
  max_pool_restarts_per_spell: MAX_POOL_RESTARTS_PER_SPELL, max_pool_restarts_per_day: MAX_POOL_RESTARTS_PER_DAY, max_pool_rechecks_per_day: MAX_POOL_RECHECKS_PER_DAY,
  max_restarts_per_hour: MAX_RESTARTS_PER_HOUR, max_rechecks_per_hour: MAX_RECHECKS_PER_HOUR, max_orders_per_login_hour: MAX_ORDERS_PER_LOGIN_HOUR, max_pool_orders_per_day: MAX_POOL_ORDERS_PER_DAY,
  answer_within_min: ANSWER_WITHIN_MIN, ttl_person_min: TTL_PERSON_MIN,
};

/** A worker's last orders, newest first, through idx_worker_orders_worker (worker_id, issued_at). */
export const WORKER_ORDERS_SQL = "SELECT id, kind, reason, issued_by, via, rule, unless_agent_ok, issued_at, expires_at, state, delivered_at, accepted_at, answered_at, answered_by, code, detail, worker_detail FROM worker_orders WHERE worker_id = ? ORDER BY issued_at DESC LIMIT ?";

type OrderRowOut = { id: string; kind: string; reason: string; issued_by: string; via: string | null; rule: string | null; unless_agent_ok: number; issued_at: string; expires_at: string; state: string; delivered_at: string | null; accepted_at: string | null; answered_at: string | null; answered_by: string | null; code: string | null; detail: string | null; worker_detail?: string | null };

async function lastOrders(env: Env, id: string, url: URL, withWorkerWords: boolean) {
  const n = Math.min(50, Math.max(1, Number(url.searchParams.get("orders") ?? 10) || 10));
  const rows = (await env.DB.prepare(WORKER_ORDERS_SQL).bind(id, n).all<OrderRowOut>()).results;
  return rows.map((r) => ({ ...r, unless_agent_ok: !!r.unless_agent_ok, worker_detail: withWorkerWords ? r.worker_detail ?? null : undefined }));
}

/**
 * GET /factory/workers/:id — the worker's page's one read: the listing's
 * view of it (workerView), its last orders without the worker's own words,
 * the rules the page quotes, and, while its agent does not answer, the
 * provider's breaker of its scope when it stands (its key, by the primary
 * key) and, for a worker that shares its host's agent service, what the
 * host says — who restarts the service, or why the pool waits — in the
 * rules' own words from the site's two reads (the site itself is never
 * served). Public, like the journal it mirrors; cached ten seconds.
 */
export async function handleWorkerPublic(id: string, url: URL, env: Env): Promise<Response> {
  const w = await workerRow(env, id);
  if (!w) return json({ error: "no such worker" }, 404);
  const view = workerView(w, aliveSince(), running(env));
  const now = Date.now();
  const failing = w.agent_status === "error" && !w.revoked_at;
  const scope = breakerScope(w.trust);
  const [orders, breaker, site] = await Promise.all([
    lastOrders(env, id, url, false),
    failing && w.agent ? env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(breakerKey(providerOf(w.agent), scope)).first<{ value: string }>() : null,
    failing && w.site && w.agent_via === "sibling" ? readSite(env, w.site, now) : null,
  ]);
  const b = breakerOf(breaker?.value);
  return json({
    worker: view, orders, rules: { on: (env.WORKER_RULES ?? "").toLowerCase() !== "off", ...RULES },
    breaker: b ? { provider: providerOf(w.agent), scope, since: b.since, peak: b.peak } : null,
    site_word: site ? siteWords(w, site, now, rulesScale(env).scale) : null,
  }, 200, { "cache-control": "public, max-age=10" });
}

/** GET /factory/workers/:id/orders — the same list with the worker's own words: its owner's and the maintainers', like its log. */
export async function handleWorkerOrders(c: Contributor | null, id: string, url: URL, env: Env): Promise<Response> {
  if (!c) return json({ error: "sign in with GitHub" }, 401, NO_STORE);
  const w = await env.DB.prepare("SELECT id, owner FROM build_workers WHERE id = ?").bind(id).first<{ id: string; owner: string | null }>();
  if (!w) return json({ error: "no such worker" }, 404, NO_STORE);
  if (!(isMaintainer(c) || (w.owner !== null && w.owner === c.login))) return json({ error: "the worker's answers are its owner's and the maintainers' to read" }, 403, NO_STORE);
  return json({ id: w.id, orders: await lastOrders(env, id, url, true) }, 200, NO_STORE);
}

/**
 * GET /factory/workers/:id/can — what this caller may press on the
 * worker's page, and why not: the door's own verdicts (orderVerdicts),
 * with the counts behind the caps. For a caller who may restart its agent
 * service, the other live workers of its host that call the same service
 * (from the site's read: the dialog names them, and types no number); the
 * site itself is never served.
 */
export async function handleWorkerCan(c: Contributor | null, id: string, env: Env): Promise<Response> {
  const w = await workerRow(env, id);
  if (!w) return json({ error: "no such worker" }, 404, NO_STORE);
  const now = Date.now();
  const v = orderVerdicts(c, w, await orderFacts(env, w.id, c?.login ?? null, now));
  const can: Record<string, boolean> = {};
  const why: Record<string, string> = {};
  for (const r of ORDER_RIGHTS) {
    can[r] = v[r].ok;
    const x = v[r];
    if (!x.ok) why[r] = x.why;
  }
  // The site's live workers, read once and only for a caller who may press a button whose dialog names them: Restart agent service (the
  // workers that call the same service) and Update (the project workers its set's updater replaces too, as the pool sees them on this
  // host). The site itself is never served.
  let shared: string[] = [], sameSet: string[] = [];
  if ((v.restart_agent.ok || v.update.ok) && w.site) {
    const rows = (await env.DB.prepare(SITE_WORKERS_SQL).bind(w.site, new Date(now - WORKER_ALIVE_MINUTES * MIN).toISOString()).all<{ id: string; agent_via: string | null }>()).results;
    if (v.restart_agent.ok) shared = rows.filter((r) => r.id !== w.id && r.agent_via === "sibling").map((r) => r.id).sort();
    if (v.update.ok) sameSet = rows.filter((r) => r.id !== w.id).map((r) => r.id).sort();
  }
  const details = !!c && (isMaintainer(c) || (w.owner !== null && w.owner === c.login));
  return json({ id: w.id, can, why, details, shared_agent_with: shared, update_with: sameSet, update_note: updateNote(w), note: deliveryNote(w) }, 200, NO_STORE);
}

/** The workers a follow names, by the primary key (EXPLAIN QUERY PLAN pins it): their release and their open orders' list, which names an open Update. Revoked ones are left out. */
export const FOLLOW_SQL = "SELECT id, version, open_orders FROM build_workers WHERE revoked_at IS NULL AND id IN (SELECT value FROM json_each(?1))";
/** A worker id as registrations make them (routes/contributors.ts): the updater keeps only what matches it. */
const WORKER_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * GET /factory/follow?ids=a,b — what a set's updater polls every two
 * minutes (#277, part 3): the pool's release, and for each worker it names,
 * its release, whether it is behind, and the id of an open Update. The
 * updater runs its round when the release changes — a release, or a
 * rollback — or when an Update it has not acted on appears; it holds no
 * token and answers nothing: the order closes when the worker claims on
 * the pool's release. Public, like /workers, which shows all of it: ids,
 * versions and open orders. Nothing here says which workers share a host
 * (there is no site parameter: the updater names its workers by id). One
 * statement by the primary key, no write; cached thirty seconds per set.
 */
export async function handleFollow(url: URL, env: Env): Promise<Response> {
  const raw = url.searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!ids.length) return json({ error: "ids: the workers of this set, 1 to 16, comma-separated" }, 400);
  if (ids.length > FOLLOW_MAX_IDS) return json({ error: `ids: at most ${FOLLOW_MAX_IDS} workers` }, 400);
  const bad = ids.find((id) => !WORKER_ID.test(id));
  if (bad !== undefined) return json({ error: "ids: a worker id is letters, digits, '.', '_' and '-'" }, 400);
  const rows = (await env.DB.prepare(FOLLOW_SQL).bind(JSON.stringify(ids)).all<{ id: string; version: string | null; open_orders: string | null }>()).results;
  const pool = running(env);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return json({
    latest: pool.version,
    deployed_at: pool.deployed_at,
    poll_s: FOLLOW_POLL_S,
    workers: ids.filter((id) => byId.has(id)).map((id) => {
      const r = byId.get(id)!;
      return { id, version: r.version, outdated: updateState(r.version, pool).outdated, update: openOrdersOf(r.open_orders).find((o) => o.kind === "update")?.id ?? null };
    }),
  }, 200, { "cache-control": "public, max-age=30" });
}
