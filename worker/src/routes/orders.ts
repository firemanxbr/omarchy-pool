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
import { edgeHit, edgeStore, json, readJson, type Env } from "../index";
import { isMaintainer, viaOf, type Contributor } from "./contributors";
import { aliveSince, workerView, type WorkerRow } from "./factory";
import { machineOrigin, version as running } from "../meta";
import {
  answerCode, breakerKey, breakerOf, breakerScope, capRefusal, cleanText, codeSentence, drainWords, isOrderKind, loginCapWords, issueOrder, openOrdersOf, orderFacts, orderVerdicts, providerOf, readSite, refreshOpen, rulesScale, siteWords, stopWay,
  ORDER_KINDS, ORDER_RIGHTS, OUTCOMES, RIGHT_OF, SITE_WORKERS_SQL, FOLLOW_MAX_IDS, FOLLOW_POLL_S, TTL_UPDATE_MIN,
  ANSWER_WITHIN_MIN, GIVE_UP_AFTER_MIN, MAX_ORDERS_PER_LOGIN_HOUR, MAX_POOL_ORDERS_PER_DAY, MAX_POOL_RECHECKS_PER_DAY, MAX_POOL_RESTARTS_PER_DAY, MAX_POOL_RESTARTS_PER_SPELL, MAX_RECHECKS_PER_HOUR,
  MAX_RESTARTS_PER_HOUR, MIN_UPTIME_S, RECHECK_AFTER_MIN, RESTART_AFTER_MIN, RESTART_SPACING_MIN, TTL_PERSON_MIN,
  type HeldTask, type OrderKind, type OrderWorker, type Outcome,
} from "../orders";
import { WORKER_ALIVE_MINUTES } from "../meta";
import { updateState } from "../update";
import { FIRST_PICK_MINUTES } from "../queue";
import { LEASE_MINUTES } from "../lease";

const NO_STORE = { "cache-control": "no-store" };
const MIN = 60000;

/** The worker's row as the doors read it, by the primary key — for a host's registration (#321), with its host's last report and the release its agent applied. */
export const WORKER_ROW_SQL = `SELECT w.*, h.reported_at AS host_reported_at, h.release_applied AS host_release FROM build_workers w LEFT JOIN hosts h ON h.id = w.host_id WHERE w.id = ?`;
async function workerRow(env: Env, id: string): Promise<(WorkerRow & OrderWorker & { id: string; current_task: number | null; site: string | null; agent_checked_at: string | null; arch: string }) | null> {
  return env.DB.prepare(WORKER_ROW_SQL).bind(id).first();
}

/** The task a worker holds, by its row's current_task (the primary key): what Stop its task decides on and says. */
export const HELD_TASK_SQL = "SELECT id, kind, name, arch, version, owner, trust, status, lease_owner, lease_expires_at, stop_order, attempts, max_attempts, params FROM build_tasks WHERE id = ?";
/** The tasks a host's registration holds (#334): its leases, by the lease index — a host has no current_task. */
export const HELD_TASKS_SQL = "SELECT id, kind, name, arch, version, owner, trust, status, lease_owner, lease_expires_at, stop_order, attempts, max_attempts, params FROM build_tasks WHERE status = 'leased' AND lease_owner = ? ORDER BY id";
export async function heldTasks(env: Env, w: { id: string; kind?: string | null; current_task: number | null }): Promise<HeldTask[]> {
  if (w.kind === "host") return (await env.DB.prepare(HELD_TASKS_SQL).bind(w.id).all<HeldTask>()).results;
  const t = w.current_task ? await env.DB.prepare(HELD_TASK_SQL).bind(w.current_task).first<HeldTask>() : null;
  return t ? [t] : [];
}
/**
 * The task Stop its task acts on: a legacy registration's one task; on a host, the task the stop names (the door then checks it is
 * leased to the host now, and not stopped), or its one lease when it names none.
 */
async function heldTask(env: Env, w: { id: string; kind?: string | null; current_task: number | null }, named?: unknown): Promise<HeldTask | null> {
  if (w.kind === "host") {
    const id = Number(named);
    // A task that does not exist is one it does not hold: the door says so by its number.
    if (named !== undefined && named !== null && Number.isSafeInteger(id) && id > 0) {
      return (await env.DB.prepare(HELD_TASK_SQL).bind(id).first<HeldTask>()) ?? { id, kind: "", name: "", arch: "", version: null, owner: null, trust: "", status: "gone", lease_owner: null, lease_expires_at: null, stop_order: null, attempts: 0, max_attempts: 0, params: null };
    }
    const all = await heldTasks(env, w);
    return all.length === 1 ? all[0] : null;
  }
  return (await heldTasks(env, w))[0] ?? null;
}

/** A task as a stop's words name it: a build by its package, version, architecture and whose it is; a pool job by what it does. */
export function taskWords(t: Pick<HeldTask, "id" | "kind" | "name" | "arch" | "version" | "owner" | "trust" | "params">): string {
  let p: Record<string, unknown> = {};
  try { p = t.params ? (JSON.parse(t.params) as Record<string, unknown>) : {}; } catch { p = {}; }
  const str = (k: string) => (typeof p[k] === "string" || typeof p[k] === "number" ? String(p[k]) : "");
  if (t.kind === "build") return `${t.name}${t.version ? ` ${t.version}` : ""}, ${t.arch}, ${t.trust === "community" ? `${t.owner ?? "?"}'s build` : "the project's build"}`;
  if (t.kind === "audit" || t.kind === "trial") return `the ${t.kind} of #${str("task") || "?"}, ${str("name") || t.name} for ${str("arch") || t.arch}`;
  if (t.kind === "promote") return `promote ${str("from") || "?"} → ${str("to") || "?"}`;
  if (t.kind === "rollback") return `rollback of ${str("ring") || "?"}`;
  if (t.kind === "sync") return `sync ${[str("source"), str("arch")].filter(Boolean).join("/") || t.arch}`;
  if (t.kind === "render" || t.kind === "health") return `${t.kind} ${[str("ring"), str("arch")].filter(Boolean).join("/")}`;
  return t.kind;
}

/** What a stop says it does, by how the task's work runs (orders.ts stopWay, §1.16): the dialog, the door's note and the page read it. */
export function stopFacts(w: { version: string | null; order_kinds: string | null }, t: HeldTask) {
  return {
    task: t.id, kind: t.kind, words: taskWords(t), attempt: t.attempts, max_attempts: t.max_attempts, last: t.attempts >= t.max_attempts,
    // The latest it goes back to the queue: nothing renews the lease once it is stopped, so it ends when this lease does.
    until: t.lease_expires_at ?? new Date(Date.now() + LEASE_MINUTES * MIN).toISOString(),
    stops: stopWay(t.kind, w.order_kinds), version: w.version,
  };
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

/**
 * When the order reaches the worker, in the words the page and the door say
 * it — and, while a Stop its task fences the task it holds (its open
 * stop-task, from the row alone), that the order goes once that task is
 * back in the queue: the stop is under way already.
 */
function deliveryNote(w: { last_seen: string; current_task: number | null; open_orders?: string | null }): string {
  const alive = Date.parse(w.last_seen) > aliveSince();
  if (!alive) return `delivered with its next claim — it is offline now; the order waits up to ${TTL_PERSON_MIN / 60} h for it`;
  if (!w.current_task) return "delivered with its next claim — within 30 s while it is idle";
  const stopping = openOrdersOf(w.open_orders ?? null).some((o) => o.kind === "stop-task");
  return stopping
    ? `delivered with its next claim — once task #${w.current_task}, which is being stopped, is back in the queue: the claim that gives it back carries the order`
    : `delivered with its next claim — after task #${w.current_task}, which it builds now (Stop its task to deliver it sooner)`;
}

/** A time of day the door says, on the pool's clock and saying so: the page words the same moment on its reader's. */
const clockOf = (iso: string) => `${iso.slice(11, 16)} UTC`;

/** What happens after a stop, per how its work runs (§1.16): the door's note, the page's dialog says the same. */
function stopNote(f: ReturnType<typeof stopFacts>): string {
  const back = `it goes back to the queue once this worker has stopped it (by ${clockOf(f.until)} at the latest)`;
  const end = f.last ? " — that was its last attempt: it fails then" : ` — attempt ${f.attempt} of ${f.max_attempts}`;
  if (f.stops === "lease-end") return `its image (${f.version ?? "unknown"}) does not stop on the pool's word: it runs task #${f.task} on, but can no longer report or upload it; the task goes back to the queue when its lease ends, by ${clockOf(f.until)}${end}`;
  if (f.stops === "child") return `task #${f.task} stops within 5 minutes; ${back}${end}`;
  if (f.stops === "child-or-call") return `task #${f.task} stops within 5 minutes while its ${f.kind === "trial" ? "check" : "build"} runs, or at its next call to the pool while it transfers; ${back}${end}`;
  return `task #${f.task} runs in the worker's own process: it stops at its next call to the pool once the worker hears of it, usually within 5 minutes; ${back}${end}`;
}

/**
 * POST /factory/workers/:id/orders — a person's order (#277): its owner or
 * any maintainer, under every cap, on the record. Drain, Resume and Stop its
 * task (part 2) act at issue, in the same batch: a drain holds from the
 * worker's next claim; a resume ends it; a stop fences the task the worker
 * holds (`task`, when given, must be it: the page may be stale).
 */
export async function handleIssueOrder(c: Contributor, id: string, request: Request, env: Env, url: URL): Promise<Response> {
  const gate = writeGate(request, url, true);
  if (gate) return gate;
  const b = await readJson<{ kind?: unknown; reason?: unknown; unless_agent_ok?: unknown; task?: unknown }>(request);
  if (b instanceof Response) return b;
  if (!isOrderKind(b.kind)) return json({ error: `kind is one of ${ORDER_KINDS.join(", ")}` }, 400);
  const kind = b.kind;
  const w = await workerRow(env, id);
  if (!w) return json({ error: "no such worker" }, 404);
  const now = Date.now();
  const host = w.kind === "host";
  const [facts, held] = await Promise.all([orderFacts(env, w.id, c.login, now, host), kind === "stop-task" ? heldTask(env, w, b.task) : null]);
  facts.task = held;
  const verdict = orderVerdicts(c, w, facts)[RIGHT_OF[kind]];
  // The login's cap is journaled once per hour whichever check met it first: this one, or the INSERT's.
  if (!verdict.ok && verdict.status === 409 && facts.loginHour >= MAX_ORDERS_PER_LOGIN_HOUR && verdict.why === loginCapWords(c.login, facts.loginFreeAt)) return json({ error: await capRefusal(env, { worker: w.id, kind, by: c.login, now, host }) }, 409);
  if (!verdict.ok) return json({ error: verdict.why }, verdict.status);
  // The task the page saw: only a restriction — the stop is of the task the worker holds now, or of none.
  if (kind === "stop-task" && b.task !== undefined && b.task !== null && Number(b.task) !== held!.id) return json({ error: `it holds #${held!.id} now, not #${String(b.task).slice(0, 20)}` }, 409);
  let reason = b.reason === undefined || b.reason === null ? "" : cleanText(b.reason, 300);
  if (reason === null) return json({ error: "the reason looks like it carries a secret, and it is public: say it without" }, 400);
  if (!reason) reason = `${KIND_LABEL[kind]} from the worker's page`;
  const unless = kind === "restart" && b.unless_agent_ok === true;
  const via = viaOf(request) === "web" ? "web" : "token";
  const stop = kind === "stop-task" ? stopFacts(w, held!) : null;
  const summary = stop
    ? `${w.id}: task #${stop.task} (${stop.words}) stopped by ${c.login} — ${reason}; back in the queue once this worker has stopped it${stop.last ? "; it fails then: that was its last attempt" : ` (attempt ${stop.attempt} of ${stop.max_attempts})`}`
    : kind === "resume"
      ? `${w.id}: resume ordered by ${c.login} — ${reason}${w.drained_by && w.drained_by !== c.login ? ` (drained ${drainWords(w)})` : ""}`
      : `${w.id}: ${kind} ordered by ${c.login} — ${reason}${unless ? " (only if its agent is down)" : ""}`;
  const issued = await issueOrder(env, {
    worker: w.id, owner: w.owner, kind, reason, by: c.login, via, rule: null, unless, site: w.site, baselineAtIssue: w.agent_checked_at, now,
    task: stop ? stop.task : null,
    host,
    resumed: kind === "resume" ? { detail: `resumed by ${c.login}: it is handed work again from its next claim`, drain: `resumed by ${c.login} before its next claim` } : undefined,
    line: { status: kind === "drain" || kind === "stop-task" ? "warn" : "ok", summary },
  });
  if (!issued.ok) {
    if (issued.why === "open" && kind === "stop-task" && host) return json({ error: `task #${stop!.task} is being stopped already: it goes back to the queue once this host's dispatcher has stopped it` }, 409);
    if (issued.why === "open") {
      const open = openOrdersOf((await env.DB.prepare("SELECT open_orders FROM build_workers WHERE id = ?").bind(w.id).first<{ open_orders: string | null }>())?.open_orders).find((o) => o.kind === kind);
      return json({ error: `${KIND_LABEL[kind].toLowerCase()} is waiting already${open ? ` (${open.id}, by ${open.by})` : ""}` }, 409);
    }
    if (issued.why === "site") return json({ error: "a restart of this host's agent service is waiting already, through another of its workers" }, 409);
    // The state a pool's kind acts on moved between the read and the INSERT: said as it is now.
    if (kind === "drain" || kind === "resume" || kind === "stop-task") {
      const again = await workerRow(env, w.id);
      if (kind === "drain" && again?.drained_at) return json({ error: `drained already (${drainWords(again)}) — Resume ends it` }, 409);
      if (kind === "resume" && again && !again.drained_at) return json({ error: "it is not drained: there is nothing to resume" }, 409);
      if (kind === "stop-task" && !host) {
        const now2 = again ? await heldTask(env, again) : null;
        if (!now2 || now2.status !== "leased" || now2.lease_owner !== w.id) return json({ error: "idle: there is no task to stop" }, 409);
        if (now2.id !== stop!.task) return json({ error: `it holds #${now2.id} now, not #${stop!.task}` }, 409);
        if (now2.stop_order) return json({ error: `task #${now2.id} is being stopped already: it goes back to the queue once this worker has stopped it` }, 409);
      }
    }
    return json({ error: await capRefusal(env, { worker: w.id, kind, by: c.login, now, host }) }, 409);
  }
  const note = stop ? `${w.id} hears it at its next heartbeat: ${stopNote(stop)}. Nothing is cancelled.`
    : kind === "drain" ? `the pool hands it nothing from its next claim${w.current_task ? `; task #${w.current_task} runs to its end` : ""}. Builds asked for it by name go to the shared queue after ${FIRST_PICK_MINUTES} min. Resume ends it.`
      : kind === "resume" ? "it is handed work again from its next claim"
        : kind === "update" ? updateNote(w)
          : deliveryNote(w);
  return json({
    // A stop's `until`, the latest its task goes back to the queue: the page words it on its reader's clock, as its dialog did.
    order: { id: issued.id, worker: w.id, kind, reason, issued_by: c.login, via, issued_at: issued.issued_at, expires_at: issued.expires_at, unless_agent_ok: unless, state: kind === "resume" ? "done" : "pending", ...(stop ? { task: stop.task, until: stop.until } : {}) },
    note,
  }, 201);
}

/** An order of a worker by its id (the primary key): the Cancel's read. */
export const ORDER_OF_WORKER_SQL = "SELECT id, kind, state, issued_by, via, rule, reason, task_id FROM worker_orders WHERE id = ? AND worker_id = ?";
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
  const o = await env.DB.prepare(ORDER_OF_WORKER_SQL).bind(oid, w.id).first<{ id: string; kind: OrderKind; state: string; issued_by: string; via: string | null; rule: string | null; reason: string; task_id: number | null }>();
  if (!o) return json({ error: "no such order on this worker" }, 404);
  if (o.state !== "pending") return json({ error: o.state === "delivered" ? "delivered already: its worker has it, and answers it" : `closed already: ${o.state}` }, 409);
  // The pool's own kinds acted at issue (#277): a stop told the worker to stop, which may have killed the task already — lifting the fence
  // could leave the task leased to a process that is gone; a drain holds until a Resume, which is the way to end it.
  if (o.kind === "stop-task") return json({ error: `${o.task_id ? `task #${o.task_id}` : "its task"} is being stopped already: it goes back to the queue once this worker has stopped it` }, 409);
  if (o.kind === "drain") return json({ error: "a drain holds from its issue: Resume ends it" }, 409);
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
  answer_within_min: ANSWER_WITHIN_MIN, ttl_person_min: TTL_PERSON_MIN, lease_minutes: LEASE_MINUTES, first_pick_minutes: FIRST_PICK_MINUTES,
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
  const [facts, held] = await Promise.all([orderFacts(env, w.id, c?.login ?? null, now, w.kind === "host"), heldTask(env, w)]);
  facts.task = held;
  const v = orderVerdicts(c, w, facts);
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
  // The task it holds, as Stop its task's dialog words it (§1.16): which, its attempt, the latest it goes back to the queue, and how it
  // stops (stopWay) — for anyone, like the listing's current_task; whether they may press it is `can.stop_task`.
  const stop = held && held.status === "leased" && held.lease_owner === w.id ? { ...stopFacts(w, held), stopping: !!held.stop_order, note: stopNote(stopFacts(w, held)) } : null;
  return json({ id: w.id, can, why, details, shared_agent_with: shared, update_with: sameSet, update_note: updateNote(w), note: deliveryNote(w), stop }, 200, NO_STORE);
}

/**
 * The workers a follow names, by the primary key (EXPLAIN QUERY PLAN pins it): their release and their open orders' list, which names an
 * open Update. Revoked ones are left out — after the read, since a host's registration (#322) is read with its host's status: the follow is
 * the call a host's agent makes in P1 (#315; the host state of #344 replaces it), and a suspended or retired host's is refused.
 */
export const FOLLOW_SQL = "SELECT id, version, open_orders, revoked_at, (SELECT status FROM hosts WHERE hosts.id = build_workers.host_id) AS host_status FROM build_workers WHERE id IN (SELECT value FROM json_each(?1))";
/** A worker id as registrations make them (routes/contributors.ts): the updater keeps only what matches it. */
const WORKER_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/** How long the edge keeps a follow answer: well under an updater's poll, so its own polls never meet their previous copy. */
const FOLLOW_EDGE_S = 30;

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
 * statement by the primary key, no write; kept at the edge thirty seconds
 * per set and per release of the pool.
 */
export async function handleFollow(url: URL, env: Env): Promise<Response> {
  const raw = url.searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!ids.length) return json({ error: "ids: the workers of this set, 1 to 16, comma-separated" }, 400);
  if (ids.length > FOLLOW_MAX_IDS) return json({ error: `ids: at most ${FOLLOW_MAX_IDS} workers` }, 400);
  const bad = ids.find((id) => !WORKER_ID.test(id));
  if (bad !== undefined) return json({ error: "ids: a worker id is letters, digits, '.', '_' and '-'" }, 400);
  const pool = running(env);
  // The edge keeps an answer FOLLOW_EDGE_S, under the URL and the pool's release together: a deploy or a rollback moves the key, so
  // no updater is ever served an answer from before it, whoever asked the same URL last — the release is seen at the first poll
  // after it, within FOLLOW_POLL_S. (An updater's own polls, FOLLOW_POLL_S apart, never meet its previous copy either.)
  const key = new Request(`${machineOrigin(url)}${url.pathname}${url.search}&release=${encodeURIComponent(`${pool.version}@${pool.deployed_at ?? ""}`)}`, { method: "GET" });
  const hit = await edgeHit(key);
  if (hit) return hit;
  const read = (await env.DB.prepare(FOLLOW_SQL).bind(JSON.stringify(ids)).all<{ id: string; version: string | null; open_orders: string | null; revoked_at: string | null; host_status: string | null }>()).results;
  // A suspended or retired host's agent is told 403, never kept at the edge (#322, design v2 §16.4): it changes nothing, keeps its bundle
  // running and polls hourly until a credential works again — a Resume — so it rolls out no release while its host is stopped.
  const stopped = read.find((r) => r.host_status === "suspended" || r.host_status === "retired");
  if (stopped) return json({ error: `${stopped.id}: its host is ${stopped.host_status}`, code: "host_status", status: stopped.host_status }, 403, { "cache-control": "no-store" });
  const rows = read.filter((r) => r.revoked_at === null);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const res = json({
    latest: pool.version,
    deployed_at: pool.deployed_at,
    poll_s: FOLLOW_POLL_S,
    workers: ids.filter((id) => byId.has(id)).map((id) => {
      const r = byId.get(id)!;
      return { id, version: r.version, outdated: updateState(r.version, pool).outdated, update: openOrdersOf(r.open_orders).find((o) => o.kind === "update")?.id ?? null };
    }),
  }, 200, { "cache-control": `public, max-age=${FOLLOW_EDGE_S}` });
  await edgeStore(key, res.clone(), FOLLOW_EDGE_S);
  res.headers.set("x-pool-cache", "miss");
  return res;
}
