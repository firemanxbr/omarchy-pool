/**
 * Maintainer hosts (#321, epic #307, design v2 §6.1, §6.3, §17.2, §18.1):
 * only a maintainer enrolls a host, and the host is trusted by the same act
 * that made them a maintainer — a pull request to factory/MAINTAINERS.toml
 * another maintainer approved — so there is no per-host trust grant.
 *
 *   POST /hosts/enrollments      a maintainer, from their page: {name, where?} → a one-time ome_ token, 15 minutes,
 *                                bound to their login and GitHub user id, and the one command to paste on the machine
 *   POST /hosts/enroll           the machine's agent, with the token, its new Ed25519 key, what it is and its capacity,
 *                                and a proof it holds the key: the host waits in pending-owner
 *   GET  /hosts[?owner=]         the hosts — for the owner and the maintainers with the details (the fingerprint the
 *                                owner compares, the capacity), and for a maintainer the other maintainers' new ones
 *   GET  /hosts/:id              one host, and its leases (the host page)
 *   POST /hosts/:id/confirm      its owner, once: the host's one worker registration (kind host, project trust)
 *   POST /hosts/:id/orders       a host order (#344): reconcile-now — its owner or any maintainer —, retire-legacy — its owner,
 *                                with a passkey; one open per kind, each with a not_after
 *   GET  /hosts/self/state       signed by the host key: what the pool says of the host — its release target, its
 *                                registration's open Updates and its open host orders (#344)
 *   POST /hosts/self/token       signed: mint the host worker token (first fetch and every rotation alike); the one it
 *                                replaces stays valid ten minutes, so only the dispatcher is recreated
 *   POST /hosts/self/report      signed: the host report (design v2 §17.2), at most 16 KiB
 *
 * A signed request (hosts.ts) can read the host's state, fetch or rotate its
 * worker token and report — nothing else: it cannot claim (a claim needs the
 * worker token, which only the dispatcher holds), change the maintainer list,
 * or widen anything. Its report answers the host orders it took, and that
 * closes them; it can close none of another host's.
 */
import { json, readJson, type Env } from "../index";
import { roleFor } from "../governance";
import { findLeak } from "../leak";
import { machineOrigin, version, API_HOST } from "../meta";
import { putRecord } from "../record";
import { writeGate } from "./orders";
import { sha256Hex, viaOf, workspace, SIGN_IN, type Contributor } from "./contributors";
import { dashboardOrigin } from "./agents";
import { justNowWords, webGate, SELF_CAUSE } from "./passkeys";
import { cancelOrdersOf, openOrdersOf, FOLLOW_POLL_S } from "../orders";
import {
  belowMinimum, enrollMessage, fingerprint, hostLine, installCommand, newHostId, parseCapacity, parseHostHeader, publicKeyBytes, sha256HexOf, shortId, signedMessage,
  unitsOf, verifySignature, ENROLL_TTL_MIN, MIN_HOST, HOST_NAME, HOST_REPORT_FRESH_MIN, ISOLATIONS, NONCE_KEEP_MIN, OLD_TOKEN_GRACE_MIN, REPORT_MAX_BYTES, SIGNED_SKEW_S, TOKEN_ROTATE_DAYS,
  hostReason, HOST_REASON, OWNER_LISTED_SQL, OWNER_NOT_MAINTAINER,
  agentTakesOrders, isHostOrderKind, legacyOf, orderAnswers, HOST_ORDER_KINDS, HOST_ORDER_TTL_MIN, HOST_ORDERS_AGENT, asleepNow,
  type Capacity, type HostOrderKind, type Isolation,
} from "../hosts";
import { parseTag } from "../update";

const NO_STORE = { "cache-control": "no-store" };
const MIN = 60000;
const iso = (ms: number) => new Date(ms).toISOString();

/** The words for a person who is no maintainer, as the page says why the button is not theirs. */
export const HOSTS_ARE_MAINTAINERS = "only a maintainer enrolls a host: a maintainer is named by a pull request to factory/MAINTAINERS.toml that another maintainer approves";

export interface HostRow {
  id: string; owner_login: string; owner_github_id: number; name: string; where: string | null; pubkey: string; status: string;
  hostname: string | null; os: string | null; arch: string | null; page_kb: number | null; runtime: string | null; isolation: string | null; dedicated: number | null;
  capacity: string | null; lanes: string | null; units: number | null; agent_slots: number | null; disk_free: string | null; pool_cap_units: number | null;
  provider: string | null; model: string | null; agent_version: string | null; release_applied: string | null; release_target: string | null; rolled_back_from: string | null;
  report: string | null; reported_at: string | null; last_seen: string | null; enrolled_at: string; confirmed_at: string | null; worker_id: string | null; token_issued_at: string | null;
  /** #322: who suspended, resumed or retired it last, when and why; when the sync found its owner gone from the list. */
  status_by: string | null; status_at: string | null; status_reason: string | null; owner_removed_at: string | null;
  /** #337: the large task it reserves for, since when (selection.ts). */
  reserving_task: number | null; reserving_since: string | null;
  /** #329: when its agent's report first said it sleeps; NULL while it is awake. */
  asleep_at: string | null;
}

function newToken(prefix: string): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return `${prefix}_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** One line of a person's words: what the page shows and the journal keeps — no control character, no secret. */
function oneLine(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s || s.length > max || /[\x00-\x1f\x7f]/.test(s) || findLeak(s)) return undefined;
  return s;
}

async function githubIdOf(env: Env, login: string): Promise<number | null> {
  const r = await env.DB.prepare("SELECT github_id FROM contributors WHERE login = ?").bind(login).first<{ github_id: number | null }>();
  return r?.github_id ?? null;
}

// ---------- the person's side ----------

/**
 * POST /hosts/enrollments — a maintainer mints a one-time enrollment token
 * (design v2 §6.1). The browser session only, as Confirm: a bearer token (an
 * omc_ CLI token) could otherwise leave hosts waiting on the owner's page,
 * with a name and a "where" of its choosing, for a careless Confirm.
 */
export async function handleMintEnrollment(c: Contributor, request: Request, env: Env, url: URL): Promise<Response> {
  if (viaOf(request) !== "web") return json({ error: "a host is added on its owner's page, signed in in the browser: a token does not add one", code: "web_only" }, 403, NO_STORE);
  const gate = writeGate(request, url, true);
  if (gate) return gate;
  // The page's own reason first (a contributor, a blocked maintainer), then the synced list itself, read again: the role on the row is the last sign-in's.
  const v = workspace(c, c.login).register;
  if (!v.ok) return json({ error: c.role === "maintainer" ? v.why : HOSTS_ARE_MAINTAINERS, code: "maintainers_only" }, v.status, NO_STORE);
  if ((await roleFor(env, c.login)) !== "maintainer") return json({ error: HOSTS_ARE_MAINTAINERS, code: "maintainers_only" }, 403, NO_STORE);
  const b = await readJson<{ name?: unknown; where?: unknown }>(request);
  if (b instanceof Response) return b;
  if (typeof b.name !== "string" || !HOST_NAME.test(b.name)) return json({ error: "name: lowercase letters, digits and dashes, 1 to 32 (\"studio\", \"vps-1\")" }, 400);
  const where = oneLine(b.where, 80);
  if (where === undefined) return json({ error: "where: one line of at most 80 characters, no secret" }, 400);
  if (await env.DB.prepare("SELECT 1 FROM hosts WHERE owner_login = ? AND name = ? AND status != 'retired'").bind(c.login, b.name).first()) {
    return json({ error: `you have a host named ${b.name} already: give this one another name`, code: "name_taken" }, 409, NO_STORE);
  }
  const github = await githubIdOf(env, c.login);
  if (github === null) return json({ error: "the pool has no GitHub user id for you yet: sign in with GitHub again, then add the host", code: "github_id" }, 409, NO_STORE);
  const token = newToken("ome");
  const id = `he_${newToken("x").slice(2, 18)}`;
  const now = Date.now();
  const expires = iso(now + ENROLL_TTL_MIN * MIN);
  await env.DB.prepare("INSERT INTO host_enrollments (token_hash, id, login, github_id, name, \"where\", created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), id, c.login, github, b.name, where, iso(now), expires)
    .run();
  const pool = machineOrigin(url);
  return json(
    {
      enrollment: id,
      token,
      name: b.name,
      expires_at: expires,
      command: installCommand(version(env).version, token, pool === `https://${API_HOST}` ? null : pool),
      note: `The token works once, for ${ENROLL_TTL_MIN} minutes.`,
    },
    201,
    NO_STORE,
  );
}

/** What anyone sees of a host, and what its owner and the maintainers see besides (design v2 §18.1). */
async function hostView(h: HostRow, detailed: boolean, now: number) {
  const alive = !!h.reported_at && now - Date.parse(h.reported_at) < HOST_REPORT_FRESH_MIN * MIN;
  const capacity = h.capacity ? (JSON.parse(h.capacity) as Capacity & { below_minimum?: string | null }) : null;
  const lanes = h.lanes ? (JSON.parse(h.lanes) as Capacity["lanes"]) : [];
  const out: Record<string, unknown> = {
    id: h.id, name: h.name, owner: h.owner_login, status: h.status, arches: lanes.map((l) => l.arch), release_applied: h.release_applied, alive,
    // Whether it sleeps (#329), public as `alive` is: `asleep` is what the claims hold to (zero free units while its report is
    // fresh), `asleep_since` what its last report said, fresh or not.
    asleep: asleepNow(h, now), asleep_since: h.asleep_at,
    worker: h.worker_id, enrolled_at: h.enrolled_at, confirmed_at: h.confirmed_at,
    // Who stopped it and why (#322) — the journal's words, public as the journal is — and whether the list stopped its claims.
    status_by: h.status_by, status_at: h.status_at, status_reason: h.status_reason, claims_stopped_at: h.owner_removed_at,
  };
  if (!detailed) return out;
  const raw = publicKeyBytes(h.pubkey)!;
  return {
    ...out,
    where: h.where, hostname: h.hostname, os: h.os, arch: h.arch, page_kb: h.page_kb, isolation: h.isolation, dedicated: h.dedicated === null ? null : !!h.dedicated,
    fingerprint: await fingerprint(raw),
    capacity, lanes, units: h.units, agent_slots: h.agent_slots, disk_free: h.disk_free ? JSON.parse(h.disk_free) : null, pool_cap_units: h.pool_cap_units,
    reserving_task: h.reserving_task, reserving_since: h.reserving_since,
    below_minimum: capacity?.below_minimum ?? null,
    runtime: h.runtime ? JSON.parse(h.runtime) : null, provider: h.provider, model: h.model,
    agent_version: h.agent_version, release_target: h.release_target, rolled_back_from: h.rolled_back_from,
    round: h.report ? ((JSON.parse(h.report) as { round?: unknown }).round ?? null) : null,
    // The legacy set its agent reports (#344): the project, its state and directory, what a retire-legacy would be refused for.
    legacy: legacyOf(h.report),
    reported_at: h.reported_at, last_seen: h.last_seen, token_issued_at: h.token_issued_at,
    summary: capacity ? hostLine(capacity, h.isolation, h.dedicated === null ? null : !!h.dedicated) : null,
  };
}

const mayDetail = (c: Contributor | null, h: Pick<HostRow, "owner_login">) => !!c && (c.role === "maintainer" || c.login === h.owner_login);

/**
 * GET /hosts[?owner=<login>] — the hosts that are not retired, newest first;
 * the details for their owner and the maintainers. A maintainer also gets the
 * notices of the last week: the hosts other maintainers confirmed (D40).
 */
export async function handleHostsList(c: Contributor | null, url: URL, env: Env): Promise<Response> {
  const owner = url.searchParams.get("owner");
  if (owner !== null && !/^[A-Za-z0-9-]{1,39}$/.test(owner)) return json({ error: "owner is a GitHub login" }, 400);
  const rows = (await (owner
    ? env.DB.prepare("SELECT * FROM hosts WHERE owner_login = ? AND status != 'retired' ORDER BY enrolled_at DESC LIMIT 50").bind(owner)
    : env.DB.prepare("SELECT * FROM hosts WHERE status != 'retired' ORDER BY enrolled_at DESC LIMIT 100")
  ).all<HostRow>()).results;
  const now = Date.now();
  const hosts = await Promise.all(rows.map((h) => hostView(h, mayDetail(c, h), now)));
  let notices: { host: string; owner: string; line: string; at: string }[] = [];
  if (c && c.role === "maintainer") {
    const recent = (await env.DB.prepare("SELECT * FROM hosts WHERE confirmed_at > ? AND owner_login != ? ORDER BY confirmed_at DESC LIMIT 10").bind(iso(now - 7 * 24 * 60 * MIN), c.login).all<HostRow>()).results;
    notices = recent.map((h) => ({ host: h.id, owner: h.owner_login, at: h.confirmed_at!, line: newHostLine(h) }));
  }
  return json({ hosts, notices, minimum: MIN_HOST, fresh_minutes: HOST_REPORT_FRESH_MIN }, 200, NO_STORE);
}

/** The new-host line, the journal's and the notice's (D40). */
function newHostLine(h: HostRow): string {
  const c = h.capacity ? (JSON.parse(h.capacity) as Capacity) : null;
  return `new host of ${h.owner_login}: ${c ? hostLine(c, h.isolation, h.dedicated === null ? null : !!h.dedicated) : h.name}`;
}

/** A host's last host orders, newest first, through (host_id, issued_at): what its page lists with each answer (#344). */
export const HOST_ORDERS_SQL = "SELECT id, kind, issued_by, issued_at, not_after, state, answered_at, detail FROM host_orders WHERE host_id = ? ORDER BY issued_at DESC LIMIT 10";

/** GET /hosts/:id — one host and the leases its registration holds (the minimal host page, design v2 §18.1); for its owner and the maintainers its last host orders too (#344). */
export async function handleHostGet(c: Contributor | null, id: string, env: Env): Promise<Response> {
  const h = await env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(id).first<HostRow>();
  if (!h) return json({ error: "no such host" }, 404, NO_STORE);
  const leases = h.worker_id
    ? (await env.DB.prepare("SELECT id, kind, name, arch, lane, units, size, started_at, lease_expires_at, stop_order IS NOT NULL AS fenced FROM build_tasks WHERE lease_owner = ? AND status = 'leased' ORDER BY id").bind(h.worker_id).all()).results
    : [];
  const viewer = c ? await viewerOf(env, c) : null;
  const detailed = mayDetail(c, h);
  const orders = detailed ? (await env.DB.prepare(HOST_ORDERS_SQL).bind(h.id).all()).results : undefined;
  return json(
    { host: await hostView(h, detailed, Date.now()), leases, orders, pool: { version: version(env).version }, can: canOf(hostVerdicts(viewer, h)), passkey: { retire: !!viewer && !isOwner(viewer, h), retire_legacy: true } },
    200,
    NO_STORE,
  );
}

/**
 * POST /hosts/:id/confirm — the host's owner, from the page that shows its
 * fingerprint: the host becomes active and gets its one worker registration
 * (`<login>-<host name>-<4 base36>`, kind host, project trust from
 * MAINTAINERS.toml, decision S2). Its token is minted when the agent asks for
 * it with a signed request (POST /hosts/self/token), never shown here.
 *
 * The browser session only, from the pool's own page (writeGate's Origin):
 * Confirm gives project trust, so a bearer token — an omc_ CLI token, or a
 * GitHub token turned into one — is refused (403 web_only). A passkey
 * assertion, as approve's (#271), is the stronger seam, for a later issue.
 * The signed trust record the per-worker door writes is written here too
 * (workers/<id>/trust-<time>.json), so who vouched for a machine that
 * publishes stays readable.
 */
export async function handleConfirmHost(c: Contributor, id: string, request: Request, env: Env, url: URL): Promise<Response> {
  if (viaOf(request) !== "web") return json({ error: "a host is confirmed on its owner's page, signed in in the browser: a token does not confirm one", code: "web_only" }, 403, NO_STORE);
  const gate = writeGate(request, url, false);
  if (gate) return gate;
  const h = await env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(id).first<HostRow>();
  if (!h) return json({ error: "no such host" }, 404, NO_STORE);
  if (c.login !== h.owner_login) return json({ error: `only ${h.owner_login} confirms their host`, code: "not_owner" }, 403, NO_STORE);
  if ((await githubIdOf(env, c.login)) !== h.owner_github_id) return json({ error: `this host was enrolled by GitHub user id ${h.owner_github_id}, not by the account signed in as ${c.login}: sign in with that account`, code: "owner_changed" }, 403, NO_STORE);
  if ((await roleFor(env, c.login)) !== "maintainer") return json({ error: HOSTS_ARE_MAINTAINERS, code: "maintainers_only" }, 403, NO_STORE);
  if (h.status !== "pending-owner") return json({ error: `${h.name} is ${h.status} already`, code: "not_pending" }, 409, NO_STORE);
  const worker = `${h.owner_login}-${h.name}-${shortId()}`;
  const at = iso(Date.now());
  const line = newHostLine(h);
  const [res] = await env.DB.batch([
    env.DB.prepare("UPDATE hosts SET status = 'active', confirmed_at = ?, worker_id = ? WHERE id = ? AND status = 'pending-owner' AND owner_login IN (SELECT login FROM factory_maintainers)").bind(at, worker, id),
    // The registration, only if this batch confirmed the host: its owner's, project trust on the owner's word as a maintainer (S2), no token until the agent's signed fetch.
    env.DB.prepare(
      `INSERT INTO build_workers (id, arch, hostname, labels, owner, token_hash, mode, packages, last_seen, trust, trusted_by, trusted_at, host_id, kind)
       SELECT ?, arch, hostname, json_object('where', name), owner_login, NULL, 'dedicated', '[]', ?, 'project', owner_login, ?, id, 'host' FROM hosts WHERE id = ? AND worker_id = ? AND confirmed_at = ?`,
    ).bind(worker, at, at, id, worker, at),
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'host', NULL, 'factory', 'ok', ?, ? WHERE (SELECT worker_id FROM hosts WHERE id = ?) = ?")
      .bind(line, JSON.stringify({ host: id, worker, owner: h.owner_login, by: c.login }), id, worker),
  ]);
  if (!res.meta.changes) return json({ error: `${h.name} was not confirmed: it is no longer waiting, or ${h.owner_login} is no longer a maintainer`, code: "not_pending" }, 409, NO_STORE);
  await putRecord(env, `workers/${worker}/trust-${at}.json`, {
    schema: "omarchy-pool/worker-trust/1", worker, owner: h.owner_login, trust: "project", host: id, fingerprint: await fingerprint(publicKeyBytes(h.pubkey)!), confirmed_by: c.login, basis: "factory/MAINTAINERS.toml", at,
  }).catch(() => null);
  return json({ host: id, status: "active", worker, line, note: "The agent fetches the host's worker token with its next signed request, writes it for the dispatcher, and the host claims from then on." }, 200, NO_STORE);
}

// ---------- suspend, resume, retire; removed for cause; the owner's resume (#322, design v2 §6.2, §6.4, D20, D39) ----------

/** A person as the host doors read them: their login, the maintainer list read now (not the last sign-in's role), and their GitHub user id — what owns a host. */
export interface HostViewer { login: string; maintainer: boolean; github_id: number | null }
async function viewerOf(env: Env, c: Contributor): Promise<HostViewer> {
  return { login: c.login, maintainer: (await roleFor(env, c.login)) === "maintainer", github_id: await githubIdOf(env, c.login) };
}
/** The owner is a GitHub user id, not a login: a renamed owner is still the owner, and a login someone else took is not. */
const isOwner = (v: HostViewer, h: Pick<HostRow, "owner_github_id">) => v.github_id !== null && v.github_id === h.owner_github_id;

export type HostRight = "suspend" | "resume" | "retire" | "cap" | "reconcile" | "retire_legacy";
type HostVerdict = { ok: true } | { ok: false; status: 401 | 403 | 404 | 409; why: string };

/**
 * Who may suspend, resume and retire a host, and give it a host order,
 * decided in one place — the doors refuse with it and GET /hosts/:id carries
 * it for the page's buttons:
 * - Suspend: its owner or any maintainer, on an active host;
 * - Resume: its owner only, with their passkey — so they are a maintainer;
 * - Retire: its owner, or any maintainer with their passkey; a host retired
 *   once stays retired (a new install enrolls a new host).
 * - Cap: its owner or any maintainer sets or lifts the pool's cap on its
 *   units (#337, design v2 §7.2), on a host not retired.
 * Every one takes a reason, journaled with who.
 * - Reconcile now (#344): its owner or any maintainer, on an active host
 *   whose agent takes host orders (HOST_ORDERS_AGENT on);
 * - Retire legacy set (#344): its owner only, while a maintainer, with their
 *   passkey, on an active host whose agent takes host orders and reports a
 *   legacy set that is not retired or being retired, and that it would not
 *   refuse (its report's `blocked`: no directory it may write its marker
 *   into) — the button is greyed with the agent's words, at most one report
 *   (five minutes) after the owner fixed it.
 */
export function hostVerdicts(
  v: HostViewer | null,
  h: Pick<HostRow, "name" | "status" | "owner_login" | "owner_github_id"> & Partial<Pick<HostRow, "agent_version" | "report">>,
): Record<HostRight, HostVerdict> {
  const no = (status: 401 | 403 | 404 | 409, why: string): HostVerdict => ({ ok: false, status, why });
  if (!v) return { suspend: no(401, SIGN_IN), resume: no(401, SIGN_IN), retire: no(401, SIGN_IN), cap: no(401, SIGN_IN), reconcile: no(401, SIGN_IN), retire_legacy: no(401, SIGN_IN) };
  const owner = isOwner(v, h);
  const theirs = !owner && !v.maintainer ? no(403, `only ${h.owner_login} or a maintainer stops ${h.name}`) : null;
  const gone = h.status === "retired" ? no(409, `${h.name} is retired: a new install enrolls a new host`) : null;
  // A host order needs an active host and an agent that reads them: an older one would let it expire unheard.
  const takes = h.status !== "active" ? no(409, h.status === "pending-owner" ? `${h.name} waits for its owner's Confirm: it runs nothing yet` : `${h.name} is ${h.status}: its agent takes no order`)
    : !agentTakesOrders(h.agent_version) ? no(409, `its agent (${h.agent_version ?? "unknown"}) takes no host order: agent ${HOST_ORDERS_AGENT} or later does, and a release brings it by itself; Update on its registration's page reconciles it meanwhile`)
    : null;
  const legacy = legacyOf(h.report ?? null);
  const legacyWhy = !legacy ? no(409, `${h.name} reports no legacy set: an install with --legacy records one`)
    : legacy.state === "retired" ? no(409, `${h.name}'s legacy set ${legacy.project} was retired already${legacy.since ? ` (${legacy.since})` : ""}`)
    : legacy.state === "retiring" ? no(409, `${h.name}'s legacy set ${legacy.project} is being retired (${legacy.order ?? "an order"})`)
    : legacy.blocked ? no(409, `${h.name}'s agent would refuse it: ${legacy.blocked}`)
    : null;
  return {
    suspend: theirs ?? gone ?? (h.status === "suspended" ? no(409, `${h.name} is suspended already — its owner's Resume ends it`) : h.status !== "active" ? no(409, `${h.name} waits for its owner's Confirm: it claims nothing yet`) : { ok: true }),
    resume: gone ?? (h.status !== "suspended" ? no(409, `${h.name} is not suspended: there is nothing to resume`)
      : !owner ? no(403, `only ${h.owner_login} resumes ${h.name}, with their passkey`)
      : !v.maintainer ? no(403, `${OWNER_NOT_MAINTAINER}: ${h.name} stays suspended`) : { ok: true }),
    retire: theirs ?? gone ?? { ok: true },
    cap: (!owner && !v.maintainer ? no(403, `only ${h.owner_login} or a maintainer caps ${h.name}`) : null) ?? gone ?? { ok: true },
    reconcile: (!owner && !v.maintainer ? no(403, `only ${h.owner_login} or a maintainer orders ${h.name} a round`) : null) ?? takes ?? { ok: true },
    retire_legacy: (!owner ? no(403, `only ${h.owner_login} retires the legacy set of ${h.name}, with their passkey`) : null)
      ?? (!v.maintainer ? no(403, `${OWNER_NOT_MAINTAINER}: ${h.name}'s legacy set stays`) : null)
      ?? takes ?? legacyWhy ?? { ok: true },
  };
}
const canOf = (v: Record<HostRight, HostVerdict>) => {
  const out: Record<string, unknown> = {}, why: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) { out[k] = x.ok; if (!x.ok) why[k] = x.why; }
  return { ...out, why };
};
const refusedBy = (x: HostVerdict) => (x.ok ? null : json({ error: x.why, code: "host_right" }, x.status, NO_STORE));

/**
 * The bulk fence (design v2 §8.6): every lease the suspended hosts'
 * registrations hold, fenced in one statement — `UPDATE build_tasks SET
 * stop_order = … WHERE lease_owner … AND status = 'leased'` — with one order
 * row per task. The rows are written closed: the order's work is done the
 * moment the fence is (the host claims nothing to hear it), and a closed row
 * holds no place in the one-open-per-kind index, so a host holding several
 * leases is fenced whole. Every heartbeat, report and upload of a fenced
 * lease is refused from then on; it goes back to the queue when its lease
 * ends (lease.ts), with the person and the reason on its line. `scope`
 * names the hosts (`id = ?5`, or `owner_github_id = ?5`), only those this
 * act suspended at `at` (`status_at = ?3`).
 */
export const FENCE_ORDERS_SQL = (scope: string) => `INSERT INTO worker_orders (id, worker_id, kind, reason, issued_by, via, task_id, issued_at, expires_at, state, answered_at, answered_by, detail)
  SELECT 'wo_' || lower(hex(randomblob(16))), t.lease_owner, 'stop-task', ?1, ?2, 'web', t.id, ?3, ?3, 'done', ?3, 'pool', ?4
    FROM build_tasks t WHERE t.status = 'leased' AND t.lease_owner IN (SELECT worker_id FROM hosts WHERE ${scope} AND status = 'suspended' AND status_at = ?3 AND worker_id IS NOT NULL)`;
export const BULK_FENCE_SQL = (scope: string) => `UPDATE build_tasks SET stop_order = (SELECT o.id FROM worker_orders o WHERE o.worker_id = build_tasks.lease_owner AND o.issued_at = ?3 AND o.kind = 'stop-task' AND o.task_id = build_tasks.id)
  WHERE status = 'leased' AND lease_owner IN (SELECT worker_id FROM hosts WHERE ${scope} AND status = 'suspended' AND status_at = ?3 AND worker_id IS NOT NULL)`;
/** The tasks a fence of this act holds, for its line and its answer. */
export const FENCED_SQL = "SELECT json_group_array(id) AS fenced FROM build_tasks WHERE status = 'leased' AND stop_order IN (SELECT id FROM worker_orders WHERE issued_at = ?1 AND kind = 'stop-task' AND issued_by = ?2)";

async function fencedBy(env: Env, at: string, by: string): Promise<number[]> {
  const r = await env.DB.prepare(FENCED_SQL).bind(at, by).first<{ fenced: string | null }>();
  return JSON.parse(r?.fenced ?? "[]") as number[];
}

/** Suspension's statements after the host rows moved: open orders cancelled with a line each, the leases fenced. */
function suspendStatements(env: Env, scope: "id" | "owner_github_id" | "owner_login", key: string | number, by: string, reason: string, at: string): D1PreparedStatement[] {
  const which = `SELECT worker_id FROM hosts WHERE ${scope} = ? AND status = 'suspended' AND status_at = ? AND worker_id IS NOT NULL`;
  const where = `${scope} = ?5`;
  const detail = `fenced: its host was suspended by ${by} — the task goes back to the queue when its lease ends`;
  return [
    ...cancelOrdersOf(env, { sql: which, binds: [key, at] }, by, at, `its host was suspended by ${by}`),
    env.DB.prepare(FENCE_ORDERS_SQL(where)).bind(reason, by, at, detail, key),
    env.DB.prepare(BULK_FENCE_SQL(where)).bind(null, null, at, null, key),
    // Its open host orders (#344): its agent's key is refused from now on, so none would be taken.
    env.DB.prepare(`UPDATE host_orders SET state = 'cancelled', answered_at = ?, detail = ? WHERE state = 'open' AND host_id IN (SELECT id FROM hosts WHERE ${scope} = ? AND status = 'suspended' AND status_at = ?)`)
      .bind(at, `its host was suspended by ${by}`, key, at),
  ];
}

/** A person's reason, as the doors take it: one printable line, no secret. */
function reasonOf(v: unknown): string | Response {
  const r = hostReason(v);
  if (r === null || findLeak(r)) return json({ error: `reason: why, in ${HOST_REASON.min} to ${HOST_REASON.max} printable characters and no secret — it goes on the public journal`, code: "reason" }, 400, NO_STORE);
  return r;
}

/** The doors' common head: the browser's session, from the pool's own page, a JSON body. */
async function personAct(c: Contributor, request: Request, env: Env, url: URL, what = "suspended, resumed and retired"): Promise<{ v: HostViewer; b: Record<string, unknown> } | Response> {
  if (viaOf(request) !== "web") return json({ error: `a host is ${what} on the site, signed in in the browser: a token does not`, code: "web_only" }, 403, NO_STORE);
  const gate = writeGate(request, url, true);
  if (gate) return gate;
  const b = await readJson<Record<string, unknown>>(request);
  if (b instanceof Response) return b;
  return { v: await viewerOf(env, c), b };
}

const hostLine_ = (h: Pick<HostRow, "name" | "owner_login">) => `${h.name} of ${h.owner_login}`;
const HOST_EVENT_SQL = "INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'host', NULL, 'factory', ?, ?, json_set(?, '$.fenced', json((" + FENCED_SQL.replace("?1", "?4").replace("?2", "?5") + "))) WHERE EXISTS (SELECT 1 FROM hosts WHERE status_at = ?4 AND status_by = ?5)";

/**
 * POST /hosts/:id/suspend — {reason}: its owner or any maintainer. In one
 * batch: the host suspended (its key refused, its registration's claims
 * refused), its registration's open orders cancelled, its running leases
 * fenced (the bulk fence), one journal line with who, why and the fenced
 * tasks. Reversible: Resume, by the owner.
 */
export async function handleSuspendHost(c: Contributor, id: string, request: Request, env: Env, url: URL): Promise<Response> {
  const p = await personAct(c, request, env, url);
  if (p instanceof Response) return p;
  const h = await env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(id).first<HostRow>();
  if (!h) return json({ error: "no such host" }, 404, NO_STORE);
  const no = refusedBy(hostVerdicts(p.v, h).suspend);
  if (no) return no;
  const reason = reasonOf(p.b.reason);
  if (reason instanceof Response) return reason;
  const at = iso(Date.now());
  const line = `${hostLine_(h)} suspended by ${c.login}: ${reason}`;
  const [res] = await env.DB.batch([
    env.DB.prepare("UPDATE hosts SET status = 'suspended', status_by = ?, status_at = ?, status_reason = ? WHERE id = ? AND status = 'active'").bind(c.login, at, reason, id),
    ...suspendStatements(env, "id", id, c.login, reason, at),
    env.DB.prepare(HOST_EVENT_SQL).bind("warn", line, JSON.stringify({ host: id, worker: h.worker_id, owner: h.owner_login, by: c.login, via: "web", action: "suspend", reason }), at, c.login),
  ]);
  if (!res.meta.changes) return json({ error: `${h.name} was not suspended: it changed a moment ago`, code: "host_right" }, 409, NO_STORE);
  const fenced = await fencedBy(env, at, c.login);
  return json({ host: id, status: "suspended", by: c.login, at, reason, fenced, line }, 200, NO_STORE);
}

/** The pool's cap a person may set on a host's units (#337): none, or 0 (it claims nothing) to this many. */
export const POOL_CAP_MAX = 4096;

/**
 * POST /hosts/:id/cap — {units: N | null, reason}: its owner or any
 * maintainer (design v2 §7.2). The pool hands the host at most N units,
 * whatever its envelope and its reports say (hosts.pool_cap_units, which
 * every claim reads); null lifts the cap. Lowered below what it holds,
 * nothing running ends: it claims nothing until its leases fit (§7.6). The
 * Studio canary runs at one build under it (§21.1). One journal line with
 * who and why.
 */
export async function handleCapHost(c: Contributor, id: string, request: Request, env: Env, url: URL): Promise<Response> {
  const p = await personAct(c, request, env, url);
  if (p instanceof Response) return p;
  const h = await env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(id).first<HostRow>();
  if (!h) return json({ error: "no such host" }, 404, NO_STORE);
  const no = refusedBy(hostVerdicts(p.v, h).cap);
  if (no) return no;
  const units = p.b.units;
  if (units !== null && (typeof units !== "number" || !Number.isInteger(units) || units < 0 || units > POOL_CAP_MAX)) return json({ error: `units: a whole number from 0 to ${POOL_CAP_MAX}, or null to lift the cap`, code: "units" }, 400, NO_STORE);
  const reason = reasonOf(p.b.reason);
  if (reason instanceof Response) return reason;
  const at = iso(Date.now());
  const line = units === null ? `${hostLine_(h)}: the pool's cap lifted by ${c.login} (was ${h.pool_cap_units ?? "none"}): ${reason}` : `${hostLine_(h)} capped at ${units} unit${units === 1 ? "" : "s"} by ${c.login} (was ${h.pool_cap_units ?? "none"}; its count is ${h.units ?? "?"}): ${reason}`;
  const [res] = await env.DB.batch([
    env.DB.prepare("UPDATE hosts SET pool_cap_units = ? WHERE id = ? AND status != 'retired' AND pool_cap_units IS ?").bind(units, id, h.pool_cap_units),
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'host', NULL, 'factory', 'ok', ?, ? WHERE changes() > 0")
      .bind(line, JSON.stringify({ host: id, worker: h.worker_id, owner: h.owner_login, by: c.login, via: "web", action: "cap", units, was: h.pool_cap_units, reason })),
  ]);
  if (!res.meta.changes) return json({ error: `${h.name}'s cap was not set: it ${h.pool_cap_units === units ? "is that already" : "changed a moment ago"}`, code: "host_right" }, 409, NO_STORE);
  return json({ host: id, pool_cap_units: units, was: h.pool_cap_units, by: c.login, at, reason, line }, 200, NO_STORE);
}

/**
 * POST /hosts/:id/resume — {assertion}: its owner only, with their passkey
 * (`host:resume:<id>`). The host is active again: its key works, its
 * registration claims, its agent recovers at its next poll. Leases fenced by
 * the suspension stay fenced until their end.
 */
export async function handleResumeHost(c: Contributor, id: string, request: Request, env: Env, url: URL): Promise<Response> {
  const p = await personAct(c, request, env, url);
  if (p instanceof Response) return p;
  const h = await env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(id).first<HostRow>();
  if (!h) return json({ error: "no such host" }, 404, NO_STORE);
  const no = refusedBy(hostVerdicts(p.v, h).resume);
  if (no) return no;
  const ok = await webGate(request, url, env, c.login, `host:resume:${id}`)(p.b.assertion);
  if (ok instanceof Response) return ok;
  const at = iso(Date.now());
  const line = `${hostLine_(h)} resumed by ${c.login}${justNowWords(ok)} (suspended by ${h.status_by ?? "?"}${h.status_reason ? `: ${h.status_reason}` : ""})`;
  const [res] = await env.DB.batch([
    env.DB.prepare("UPDATE hosts SET status = 'active', status_by = ?, status_at = ?, status_reason = NULL WHERE id = ? AND status = 'suspended'").bind(c.login, at, id),
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'host', NULL, 'factory', 'ok', ?, ? WHERE EXISTS (SELECT 1 FROM hosts WHERE id = ? AND status_at = ?)")
      .bind(line, JSON.stringify({ host: id, worker: h.worker_id, owner: h.owner_login, by: c.login, via: "web", action: "resume", confirmed_with: ok.passkey }), id, at),
  ]);
  if (!res.meta.changes) return json({ error: `${h.name} was not resumed: it changed a moment ago`, code: "host_right" }, 409, NO_STORE);
  return json({ host: id, status: "active", by: c.login, at, confirmed_with: ok.passkey, line, note: "its registration claims from its next claim; its agent recovers at its next poll" }, 200, NO_STORE);
}

/**
 * POST /hosts/:id/retire — {reason, assertion?}: its owner, or any
 * maintainer with their passkey (`host:retire:<id>`). In one batch the host
 * is retired — its key refused for good, and since the pool keeps it, never
 * enrolled again — its registration revoked with its worker token, its open
 * orders cancelled, builds asked for it unpinned, one journal line. Running
 * leases are not fenced: they end with their lease, as a revoked worker's.
 * A new install on the machine enrolls a new host, with a new key.
 */
export async function handleRetireHost(c: Contributor, id: string, request: Request, env: Env, url: URL): Promise<Response> {
  const p = await personAct(c, request, env, url);
  if (p instanceof Response) return p;
  const h = await env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(id).first<HostRow>();
  if (!h) return json({ error: "no such host" }, 404, NO_STORE);
  const no = refusedBy(hostVerdicts(p.v, h).retire);
  if (no) return no;
  const reason = reasonOf(p.b.reason);
  if (reason instanceof Response) return reason;
  const ok = isOwner(p.v, h) ? null : await webGate(request, url, env, c.login, `host:retire:${id}`)(p.b.assertion);
  if (ok instanceof Response) return ok;
  const at = iso(Date.now());
  const line = `${hostLine_(h)} retired by ${c.login}${ok ? justNowWords(ok) : ""}: ${reason}`;
  const worker = h.worker_id ?? "";
  const [res] = await env.DB.batch([
    env.DB.prepare("UPDATE hosts SET status = 'retired', status_by = ?, status_at = ?, status_reason = ?, prev_token_hash = NULL, prev_token_until = NULL WHERE id = ? AND status != 'retired'").bind(c.login, at, reason, id),
    env.DB.prepare("UPDATE build_workers SET revoked_at = ? WHERE id = ? AND host_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM hosts WHERE id = ? AND status_at = ?)").bind(at, worker, id, id, at),
    ...cancelOrdersOf(env, { sql: "SELECT id FROM build_workers WHERE id = ? AND revoked_at = ?", binds: [worker, at] }, c.login, at, `its host was retired by ${c.login}`),
    env.DB.prepare("UPDATE build_tasks SET pinned_to = NULL, shared_after = NULL WHERE pinned_to = ? AND status = 'queued' AND EXISTS (SELECT 1 FROM hosts WHERE id = ? AND status_at = ?)").bind(worker, id, at),
    env.DB.prepare("UPDATE host_orders SET state = 'cancelled', answered_at = ?, detail = ? WHERE host_id = ? AND state = 'open' AND EXISTS (SELECT 1 FROM hosts WHERE id = ? AND status_at = ?)")
      .bind(at, `its host was retired by ${c.login}`, id, id, at),
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'host', NULL, 'factory', 'warn', ?, ? WHERE EXISTS (SELECT 1 FROM hosts WHERE id = ? AND status_at = ?)")
      .bind(line, JSON.stringify({ host: id, worker: h.worker_id, owner: h.owner_login, by: c.login, via: "web", action: "retire", reason, ...(ok ? { confirmed_with: ok.passkey } : {}) }), id, at),
  ]);
  if (!res.meta.changes) return json({ error: `${h.name} was not retired: it changed a moment ago`, code: "host_right" }, 409, NO_STORE);
  return json({ host: id, status: "retired", by: c.login, at, reason, line, note: "its key and its worker token are burnt; a new install on the machine enrolls a new host" }, 200, NO_STORE);
}

/** The hosts of a login: by its GitHub user id when the pool knows it (a renamed owner's hosts are theirs), else by the login. */
async function ownerKey(env: Env, login: string): Promise<{ col: "owner_github_id" | "owner_login"; key: string | number }> {
  const g = await githubIdOf(env, login);
  return g === null ? { col: "owner_login", key: login } : { col: "owner_github_id", key: g };
}

/**
 * POST /hosts/owners/:login/cause — {reason, assertion}: "removed for
 * cause", another maintainer's explicit act with their passkey
 * (`host:cause:<login>`), never the owner's own. In one batch every host of
 * that owner that runs or is suspended is suspended for cause, their open
 * orders cancelled and their running leases fenced in one statement, one
 * journal line. Removing the person from factory/MAINTAINERS.toml stays a
 * pull request; this is what stops their machines at once meanwhile.
 */
export async function handleRemoveForCause(c: Contributor, login: string, request: Request, env: Env, url: URL): Promise<Response> {
  const p = await personAct(c, request, env, url);
  if (p instanceof Response) return p;
  if (!p.v.maintainer) return json({ error: `removing a maintainer for cause is another maintainer's act; ${c.login} is not one (factory/MAINTAINERS.toml)`, code: "maintainers_only" }, 403, NO_STORE);
  const target = await ownerKey(env, login);
  if (login === c.login || (target.col === "owner_github_id" && target.key === p.v.github_id)) return json({ error: SELF_CAUSE, code: "second_maintainer" }, 403, NO_STORE);
  const hosts = (await env.DB.prepare(`SELECT id, name, status, worker_id FROM hosts WHERE ${target.col} = ? AND status IN ('active', 'suspended')`).bind(target.key).all<{ id: string; name: string; status: string; worker_id: string | null }>()).results;
  if (!hosts.length) return json({ error: `${login} has no host that runs or is suspended: there is nothing to stop`, code: "no_host" }, 409, NO_STORE);
  const reason = reasonOf(p.b.reason);
  if (reason instanceof Response) return reason;
  const ok = await webGate(request, url, env, c.login, `host:cause:${login}`)(p.b.assertion);
  if (ok instanceof Response) return ok;
  const at = iso(Date.now());
  const why = `removed for cause: ${reason}`;
  const line = `${login} removed for cause by ${c.login}${justNowWords(ok)}: ${hosts.length} host${hosts.length === 1 ? "" : "s"} suspended, their running tasks fenced — ${reason}`;
  const [res] = await env.DB.batch([
    env.DB.prepare(`UPDATE hosts SET status = 'suspended', status_by = ?, status_at = ?, status_reason = ? WHERE ${target.col} = ? AND status IN ('active', 'suspended')`).bind(c.login, at, why, target.key),
    ...suspendStatements(env, target.col, target.key, c.login, why, at),
    env.DB.prepare(HOST_EVENT_SQL).bind("error", line, JSON.stringify({ owner: login, hosts: hosts.map((h) => h.id), by: c.login, via: "web", action: "cause", reason, confirmed_with: ok.passkey }), at, c.login),
  ]);
  if (!res.meta.changes) return json({ error: `${login}'s hosts were not suspended: they changed a moment ago`, code: "host_right" }, 409, NO_STORE);
  const fenced = await fencedBy(env, at, c.login);
  return json({ owner: login, hosts: hosts.map((h) => h.id), status: "suspended", by: c.login, at, reason, fenced, confirmed_with: ok.passkey, line }, 200, NO_STORE);
}

/**
 * POST /hosts/owners/:login/resume — {assertion}: an owner listed again
 * (D39) resumes claiming on all their hosts the sync stopped, with one
 * action and their passkey (`host:resume-all:<login>`). Only the stop the
 * list made is lifted: a suspended host stays suspended.
 */
export async function handleResumeOwner(c: Contributor, login: string, request: Request, env: Env, url: URL): Promise<Response> {
  const p = await personAct(c, request, env, url);
  if (p instanceof Response) return p;
  if (login !== c.login || p.v.github_id === null) return json({ error: `only ${login} resumes their own hosts, with their passkey`, code: "host_right" }, 403, NO_STORE);
  const listed = await env.DB.prepare(`SELECT ${OWNER_LISTED_SQL("?")} AS yes`).bind(p.v.github_id).first<{ yes: number }>();
  if (!listed?.yes) return json({ error: `${OWNER_NOT_MAINTAINER} (factory/MAINTAINERS.toml): your hosts claim again once a pull request lists you again and the pool has synced it`, code: "owner_not_maintainer" }, 403, NO_STORE);
  const stopped = (await env.DB.prepare("SELECT id, name FROM hosts WHERE owner_github_id = ? AND owner_removed_at IS NOT NULL AND status != 'retired'").bind(p.v.github_id).all<{ id: string; name: string }>()).results;
  if (!stopped.length) return json({ error: "no host of yours was stopped by the maintainer list: there is nothing to resume", code: "no_host" }, 409, NO_STORE);
  const ok = await webGate(request, url, env, c.login, `host:resume-all:${login}`)(p.b.assertion);
  if (ok instanceof Response) return ok;
  const at = iso(Date.now());
  const line = `${login} resumed claiming on ${stopped.length} host${stopped.length === 1 ? "" : "s"} the maintainer list had stopped${justNowWords(ok)}: ${stopped.map((h) => h.name).join(", ")}`;
  const [res] = await env.DB.batch([
    env.DB.prepare(`UPDATE hosts SET owner_removed_at = NULL WHERE owner_github_id = ?1 AND owner_removed_at IS NOT NULL AND status != 'retired' AND ${OWNER_LISTED_SQL("?1")}`).bind(p.v.github_id),
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'host', NULL, 'factory', 'ok', ?, ? WHERE NOT EXISTS (SELECT 1 FROM hosts WHERE owner_github_id = ? AND owner_removed_at IS NOT NULL AND status != 'retired')")
      .bind(line, JSON.stringify({ owner: login, hosts: stopped.map((h) => h.id), by: c.login, via: "web", action: "resume_owner", confirmed_with: ok.passkey }), p.v.github_id),
  ]);
  if (!res.meta.changes) return json({ error: "your hosts were not resumed: they changed a moment ago", code: "host_right" }, 409, NO_STORE);
  return json({ owner: login, hosts: stopped.map((h) => h.id), at, confirmed_with: ok.passkey, line }, 200, NO_STORE);
}

// ---------- host orders (#344, design v2 §11.1 M4, M5, §17.1, §21.1 step 6) ----------

/** A new host order's id: `ho_` and 32 hex digits. */
function newOrderId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return `ho_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** What an order not taken before its not_after says: the agent refuses one past it too. */
export const ORDER_EXPIRED = "not taken by its agent before its not_after";
/** A host's open orders past their not_after, expired: the door's first statement, by the open-kind index. */
export const EXPIRE_HOST_ORDERS_SQL = `UPDATE host_orders SET state = 'expired', answered_at = ?1, detail = '${ORDER_EXPIRED}' WHERE host_id = ?2 AND state = 'open' AND not_after <= ?1`;
/** Every host's (the cron's), by the open orders' not_after. */
export const EXPIRE_ALL_HOST_ORDERS_SQL = `UPDATE host_orders SET state = 'expired', answered_at = ?1, detail = '${ORDER_EXPIRED}' WHERE state = 'open' AND not_after <= ?1`;
/**
 * An agent's answer closing its host's order: an open one, or one the pool expired meanwhile — the agent takes an order
 * before its not_after but answers a retire-legacy only at its end (up to 30 minutes on), so its answer, not "not taken",
 * is what happened. Once answered, a later report carrying the same answer closes nothing more.
 */
export const ANSWER_HOST_ORDER_SQL = "UPDATE host_orders SET state = ?, answered_at = ?, detail = ? WHERE id = ? AND host_id = ? AND state IN ('open', 'expired')";
/** A host's open orders, oldest first: what its state hands its agent, by the open-kind index. */
export const HOST_OPEN_ORDERS_SQL = "SELECT id, kind, not_after FROM host_orders WHERE host_id = ? AND state = 'open' AND not_after > ? ORDER BY issued_at LIMIT 16";

/**
 * POST /hosts/:id/orders — {kind, assertion?}: a host order, from the
 * browser's session on the pool's own page (design v2 §17.1):
 * - `reconcile-now`, its owner or any maintainer: a round now, which never
 *   skips the owner's soak (P4) — what the host page's Reconcile now gives;
 * - `retire-legacy`, its owner only, with their passkey
 *   (`host:retire-legacy:<id>`): the agent stops and then removes the
 *   legacy compose project its legacy.json records, and nothing else, and
 *   writes the .omarchy-agent marker into its directory, so rollout.sh,
 *   setup.sh, omarchy-worker and the updater refuse there.
 * Both need an active host whose agent takes host orders; one open per kind,
 * each with a not_after HOST_ORDER_TTL_MIN on, after which it expires. The
 * agent answers in its report, which closes the order; issue and answer are
 * on the journal.
 */
export async function handleHostOrder(c: Contributor, id: string, request: Request, env: Env, url: URL): Promise<Response> {
  const p = await personAct(c, request, env, url, "given orders");
  if (p instanceof Response) return p;
  const h = await env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(id).first<HostRow>();
  if (!h) return json({ error: "no such host" }, 404, NO_STORE);
  if (!isHostOrderKind(p.b.kind)) return json({ error: `kind is one of ${HOST_ORDER_KINDS.join(", ")}`, code: "kind" }, 400, NO_STORE);
  const kind: HostOrderKind = p.b.kind;
  const no = refusedBy(hostVerdicts(p.v, h)[kind === "retire-legacy" ? "retire_legacy" : "reconcile"]);
  if (no) return no;
  const ok = kind === "retire-legacy" ? await webGate(request, url, env, c.login, `host:retire-legacy:${id}`)(p.b.assertion) : null;
  if (ok instanceof Response) return ok;
  const now = Date.now();
  const at = iso(now);
  const notAfter = iso(now + HOST_ORDER_TTL_MIN * MIN);
  const oid = newOrderId();
  const legacy = legacyOf(h.report);
  const line = kind === "retire-legacy"
    ? `${hostLine_(h)}: ${c.login}${ok ? justNowWords(ok) : ""} ordered its legacy set ${legacy?.project ?? "?"} retired — its agent stops and removes it and leaves its marker`
    : `${hostLine_(h)}: ${c.login} ordered a round now`;
  try {
    await env.DB.batch([
      env.DB.prepare(EXPIRE_HOST_ORDERS_SQL).bind(at, id),
      env.DB.prepare("INSERT INTO host_orders (id, host_id, kind, issued_by, via, confirmed_with, issued_at, not_after) SELECT ?, id, ?, ?, 'web', ?, ?, ? FROM hosts WHERE id = ? AND status = 'active'")
        .bind(oid, kind, c.login, ok ? ok.passkey : null, at, notAfter, id),
      env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'host', NULL, 'factory', ?, ?, ? WHERE EXISTS (SELECT 1 FROM host_orders WHERE id = ?)")
        .bind(kind === "retire-legacy" ? "warn" : "ok", line, JSON.stringify({ host: id, owner: h.owner_login, by: c.login, via: "web", action: "order", order: oid, kind, not_after: notAfter, ...(ok ? { confirmed_with: ok.passkey } : {}) }), oid),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return json({ error: `${kind} is waiting for ${h.name}'s agent already: one at a time, until it answers or the order expires`, code: "order_open" }, 409, NO_STORE);
    throw e;
  }
  if (!(await env.DB.prepare("SELECT 1 FROM host_orders WHERE id = ?").bind(oid).first())) return json({ error: `${h.name} was not ordered: it changed a moment ago`, code: "host_right" }, 409, NO_STORE);
  return json(
    {
      order: { id: oid, kind, state: "open", not_after: notAfter, ...(ok ? { confirmed_with: ok.passkey } : {}) },
      host: id, by: c.login, line,
      note: `its agent takes it at its next poll (within ${FOLLOW_POLL_S / 60} min) and answers in its next report; not taken by ${notAfter}, it expires`,
    },
    201,
    NO_STORE,
  );
}

// ---------- the host's side ----------

const ENROLL_FIELDS = "the token, pubkey, sig, hostname, os, arch, page_kb, isolation, agent_version and capacity";

/**
 * POST /hosts/enroll — the machine's agent (design v2 §6.1 steps 2-3): the
 * token, its public key and a signature of enrollMessage() with it, what the
 * machine is, and its capacity report. In one batch the pool checks the token
 * is live and unused, its login is still a maintainer and still the same
 * GitHub user, burns it, and creates the host in pending-owner. A host below
 * the signed minimum is refused before anything is written.
 */
export async function handleEnroll(request: Request, env: Env, url: URL): Promise<Response> {
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > REPORT_MAX_BYTES) return json({ error: `an enrollment is at most ${REPORT_MAX_BYTES} bytes` }, 413);
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json({ error: "a JSON body is required" }, 400);
  }
  if (!b || typeof b !== "object") return json({ error: `${ENROLL_FIELDS} are required` }, 400);
  const token = typeof b.token === "string" && /^ome_[0-9a-f]{48}$/.test(b.token) ? b.token : null;
  if (!token) return json({ error: "token: the ome_ token the site printed", code: "token_unknown" }, 401);
  const raw = publicKeyBytes(b.pubkey);
  if (!raw) return json({ error: "pubkey: the host's Ed25519 public key, 32 bytes, base64url" }, 400);
  const pubkey = b.pubkey as string;
  if (typeof b.sig !== "string" || !(await verifySignature(raw, b.sig, enrollMessage(token, pubkey)))) return json({ error: "sig: no proof the host holds that key (the key's signature of the enrollment)", code: "proof" }, 401);
  const cap = parseCapacity(b.capacity);
  if (typeof cap === "string") return json({ error: cap }, 400);
  const hostname = typeof b.hostname === "string" && /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(b.hostname) ? b.hostname : null;
  const os = b.os === "linux" || b.os === "macos" ? b.os : null;
  const arch = b.arch === "x86_64" || b.arch === "aarch64" ? b.arch : null;
  const isolation = ISOLATIONS.includes(b.isolation as Isolation) ? (b.isolation as Isolation) : null;
  const agent = typeof b.agent_version === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(b.agent_version) ? b.agent_version : null;
  const pageKb = Number.isInteger(b.page_kb) && (b.page_kb as number) >= 4 && (b.page_kb as number) <= 64 ? (b.page_kb as number) : null;
  if (!hostname || !os || !arch || !isolation || !agent || !pageKb) return json({ error: `${ENROLL_FIELDS} are required (hostname a DNS label, os linux | macos, arch x86_64 | aarch64, isolation root | user | subuid | vm | vm-shared)` }, 400);
  if (!cap.lanes.some((l) => l.mode === "native" && l.arch === arch)) return json({ error: `capacity.lanes: the native lane is not ${arch}` }, 400);
  const runtime = b.runtime === undefined || b.runtime === null ? null : JSON.stringify(b.runtime);
  if (runtime !== null && (typeof b.runtime !== "object" || runtime.length > 2048)) return json({ error: "runtime: an object of at most 2 KiB" }, 400);
  const leak = findLeak(new TextDecoder().decode(bytes).replace(token, ""));
  if (leak) return json({ error: `the enrollment carries what looks like ${leak.kind}; nothing was written` }, 422);

  const hash = await sha256Hex(token);
  const e = await env.DB.prepare("SELECT login, github_id, name, \"where\", expires_at, used_at FROM host_enrollments WHERE token_hash = ?").bind(hash)
    .first<{ login: string; github_id: number; name: string; where: string | null; expires_at: string; used_at: string | null }>();
  if (!e) return json({ error: "this token was never issued", code: "token_unknown" }, 401);
  if (e.used_at) return json({ error: "this token was used already: a token enrolls one host, once; add the host again on your page for a new one", code: "token_used" }, 401);
  const now = Date.now();
  if (Date.parse(e.expires_at) <= now) return json({ error: `this token expired at ${e.expires_at} (${ENROLL_TTL_MIN} minutes): add the host again on your page for a new one`, code: "token_expired" }, 401);
  if ((await roleFor(env, e.login)) !== "maintainer") return json({ error: `${e.login} is no longer a maintainer (factory/MAINTAINERS.toml): ${HOSTS_ARE_MAINTAINERS}`, code: "not_maintainer" }, 403);
  if ((await githubIdOf(env, e.login)) !== e.github_id) return json({ error: `${e.login} is no longer the GitHub account that asked for this token`, code: "owner_changed" }, 403);
  const below = belowMinimum(cap);
  if (below) return json({ error: `${below}; nothing was registered, and the token is still good until it expires`, code: "below_minimum" }, 422);
  if (await env.DB.prepare("SELECT 1 FROM hosts WHERE pubkey = ?").bind(pubkey).first()) return json({ error: "this key is a host's already: an enrollment needs a key no host holds (the agent makes one whenever the machine has no host.json)", code: "key_taken" }, 409);

  const id = newHostId();
  const at = iso(now);
  const units = unitsOf(cap);
  const capacity = JSON.stringify({ ...cap, below_minimum: null });
  const [burn] = await env.DB.batch([
    // The checks again, in the statement that burns: live, unused, its login listed and still the same GitHub user.
    env.DB.prepare(
      `UPDATE host_enrollments SET used_at = ?, host_id = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
         AND login IN (SELECT login FROM factory_maintainers) AND github_id = (SELECT github_id FROM contributors WHERE login = host_enrollments.login)`,
    ).bind(at, id, hash, at),
    env.DB.prepare(
      `INSERT INTO hosts (id, owner_login, owner_github_id, name, "where", pubkey, status, hostname, os, arch, page_kb, runtime, isolation, dedicated, capacity, lanes, units, agent_slots, disk_free, agent_version, enrolled_at, last_seen)
       SELECT ?, login, github_id, name, "where", ?, 'pending-owner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM host_enrollments WHERE token_hash = ? AND host_id = ?`,
    ).bind(id, pubkey, hostname, os, arch, pageKb, runtime, isolation, b.dedicated === true ? 1 : b.dedicated === false ? 0 : null, capacity, JSON.stringify(cap.lanes), units, cap.agent_slots, JSON.stringify(cap.disk_free_gb), agent, at, at, hash, id),
  ]);
  if (!burn.meta.changes) return json({ error: "this token was used already, or expired, a moment ago", code: "token_used" }, 401);
  const fp = await fingerprint(raw);
  return json(
    { host: id, status: "pending-owner", owner: e.login, name: e.name, fingerprint: fp, units, confirm: `${dashboardOrigin(url)}/user/${e.login}#hosts`, note: `waiting for ${e.login} to confirm ${fp} on the site; nothing claims before that` },
    201,
    NO_STORE,
  );
}

export interface SignedHost { host: HostRow; body: Uint8Array }

/**
 * The host behind a signed request, or the refusal: its key, a time within
 * 120 seconds of the pool's, a nonce never seen, over the method, the path
 * and the body as sent. A suspended or retired host is refused (403).
 */
export async function signedHost(request: Request, env: Env, url: URL): Promise<SignedHost | Response> {
  const hdr = parseHostHeader(request.headers.get("omarchy-host"));
  if (!hdr) return json({ error: "a host's signed request is required: Omarchy-Host: <host>; ts=<unix>; nonce=<32 hex>; sig=<base64url>", code: "host_signature" }, 401, NO_STORE);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > REPORT_MAX_BYTES) return json({ error: `at most ${REPORT_MAX_BYTES} bytes` }, 413, NO_STORE);
  const now = Date.now();
  if (Math.abs(hdr.ts - Math.floor(now / 1000)) > SIGNED_SKEW_S) return json({ error: `the request's time is more than ${SIGNED_SKEW_S} s from the pool's (${iso(now)}): set the host's clock`, code: "clock", now: iso(now) }, 401, NO_STORE);
  const h = await env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(hdr.host).first<HostRow>();
  const raw = h ? publicKeyBytes(h.pubkey) : null;
  if (!h || !raw) return json({ error: "no such host", code: "host_signature" }, 401, NO_STORE);
  const message = signedMessage(h.id, request.method, url.pathname, await sha256HexOf(body), hdr.ts, hdr.nonce);
  if (!(await verifySignature(raw, hdr.sig, message))) return json({ error: "the signature is not this host's over this request", code: "host_signature" }, 401, NO_STORE);
  // Its status rides the refusal (#322): an agent re-installed on a retired host's machine enrolls a new host, and one on a suspended host waits.
  if (h.status === "suspended" || h.status === "retired") return json({ error: `${h.name} is ${h.status}${h.status_by ? ` (by ${h.status_by}${h.status_reason ? `: ${h.status_reason}` : ""})` : ""}`, code: "host_status", status: h.status }, 403, NO_STORE);
  const fresh = await env.DB.prepare("INSERT INTO host_nonces (host_id, nonce, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(h.id, hdr.nonce, iso(now)).run();
  if (!fresh.meta.changes) return json({ error: "this request was seen already (its nonce)", code: "replay" }, 401, NO_STORE);
  return { host: h, body };
}

/**
 * GET /hosts/self/state — what the pool says of the host: its status, its
 * registration and its token's dates, and — P3's minimal host state (#344,
 * design v2 §17.1) — the release target (the pool's own release, which from
 * agent 0.3.0 on replaces follow.latest), its registration's open Update
 * orders, and its open host orders, each with its id and not_after (an
 * order past it is never sent). P4 (#325) adds the settings and the other
 * kinds. Every answer is the host's alone: no-store.
 */
export async function handleHostState(s: SignedHost, env: Env): Promise<Response> {
  const h = s.host;
  const now = Date.now();
  const at = iso(now);
  const [, orders, worker] = await env.DB.batch([
    env.DB.prepare("UPDATE hosts SET last_seen = ? WHERE id = ?").bind(at, h.id),
    env.DB.prepare(HOST_OPEN_ORDERS_SQL).bind(h.id, at),
    env.DB.prepare("SELECT open_orders FROM build_workers WHERE id = ? AND host_id = ? AND revoked_at IS NULL").bind(h.worker_id ?? "", h.id),
  ]);
  const raw = publicKeyBytes(h.pubkey)!;
  const pool = version(env);
  const open = (worker.results[0] as { open_orders: string | null } | undefined)?.open_orders ?? null;
  return json({
    host: h.id, status: h.status, name: h.name, owner: h.owner_login, worker: h.worker_id, fingerprint: await fingerprint(raw),
    token: h.token_issued_at ? { issued_at: h.token_issued_at, rotate_after: iso(Date.parse(h.token_issued_at) + TOKEN_ROTATE_DAYS * 24 * 60 * MIN) } : null,
    report_every_s: 300,
    poll_s: FOLLOW_POLL_S,
    // A Worker that runs no release (a development one) names none: the agent then changes nothing.
    release: { target: parseTag(pool.version) ? pool.version : null, deployed_at: pool.deployed_at },
    updates: openOrdersOf(open).filter((o) => o.kind === "update").map((o) => o.id),
    orders: (orders.results as { id: string; kind: string; not_after: string }[]).map((o) => ({ id: o.id, kind: o.kind, not_after: o.not_after })),
  }, 200, NO_STORE);
}

/**
 * POST /hosts/self/token — the host worker token, for the dispatcher only: a
 * new one at every call, the first fetch after Confirm and every rotation
 * alike. The token it replaces keeps working for ten minutes, so the agent
 * recreates only the dispatcher and the dispatcher's running tasks — whose
 * job tokens do not depend on it — never notice.
 */
export async function handleHostToken(s: SignedHost, env: Env): Promise<Response> {
  const h = s.host;
  if (h.status !== "active" || !h.worker_id) return json({ error: `${h.name} waits for ${h.owner_login} to confirm it on the site`, code: "pending_owner" }, 409, NO_STORE);
  const token = newToken("omw");
  const now = Date.now();
  const grace = iso(now + OLD_TOKEN_GRACE_MIN * MIN);
  const [, res] = await env.DB.batch([
    // The token it replaces, first: valid ten more minutes (none before the first fetch).
    env.DB.prepare("UPDATE hosts SET prev_token_hash = w.token_hash, prev_token_until = CASE WHEN w.token_hash IS NULL THEN NULL ELSE ? END, token_issued_at = ?, last_seen = ? FROM (SELECT token_hash FROM build_workers WHERE id = ? AND revoked_at IS NULL) AS w WHERE hosts.id = ?")
      .bind(grace, iso(now), iso(now), h.worker_id, h.id),
    env.DB.prepare("UPDATE build_workers SET token_hash = ? WHERE id = ? AND host_id = ? AND revoked_at IS NULL").bind(await sha256Hex(token), h.worker_id, h.id),
  ]);
  if (!res.meta.changes) return json({ error: `${h.worker_id} is revoked`, code: "revoked" }, 409, NO_STORE);
  return json({ worker: h.worker_id, token, issued_at: iso(now), rotate_after: iso(now + TOKEN_ROTATE_DAYS * 24 * 60 * MIN), previous_valid_until: h.token_issued_at ? grace : null }, 200, NO_STORE);
}

/**
 * POST /hosts/self/report — the host report (design v2 §17.2), on every
 * change and at least every five minutes, at most 16 KiB. A report that
 * carries what looks like a secret is refused whole (leak.ts). The pool keeps
 * the last one and the columns its pages read; the units are its own count
 * from the reported totals. `asleep: true` (#329) — a Mac about to sleep —
 * gives the host zero free units until a report says otherwise (asleepNow).
 */
export async function handleHostReport(s: SignedHost, env: Env): Promise<Response> {
  const h = s.host;
  const text = new TextDecoder().decode(s.body);
  let r: Record<string, any>;
  try {
    r = JSON.parse(text);
  } catch {
    return json({ error: "a JSON body is required" }, 400, NO_STORE);
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) return json({ error: "the report is an object" }, 400, NO_STORE);
  const leak = findLeak(text);
  if (leak) return json({ error: `the report carries what looks like ${leak.kind} (line ${leak.line}); nothing was written`, code: "leak" }, 422, NO_STORE);
  const str = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : null);
  const tag = /^v\d+\.\d+\.\d+$/;
  const cap = r.capacity === undefined ? null : parseCapacity(r.capacity);
  if (typeof cap === "string") return json({ error: cap }, 400, NO_STORE);
  // As at enrollment: the native lane is the host's own architecture.
  if (cap && !cap.lanes.some((l) => l.mode === "native" && l.arch === h.arch)) return json({ error: `capacity.lanes: the native lane is not ${h.arch}` }, 400, NO_STORE);
  const runtime = r.runtime && typeof r.runtime === "object" ? r.runtime : null;
  // As the enrollment: whole or refused — a cut one would not parse on the hosts' pages.
  if (runtime && JSON.stringify(runtime).length > 2048) return json({ error: "runtime: an object of at most 2 KiB" }, 400, NO_STORE);
  const isolation = runtime && ISOLATIONS.includes(runtime.isolation) ? (runtime.isolation as string) : h.isolation;
  const dedicated = runtime && typeof runtime.dedicated === "boolean" ? (runtime.dedicated ? 1 : 0) : h.dedicated;
  const round = r.round && typeof r.round === "object" ? r.round : null;
  // A Mac about to sleep, or asleep (#329): from the first report that says so until one that does not (an agent that does not
  // say is awake).
  const asleep = r.asleep === true;
  const at = iso(Date.now());
  await env.DB.prepare(
    `UPDATE hosts SET report = ?, reported_at = ?, last_seen = ?, agent_version = COALESCE(?, agent_version), release_applied = ?, release_target = ?, rolled_back_from = ?,
       isolation = ?, dedicated = ?, runtime = COALESCE(?, runtime), provider = ?, model = ?,
       capacity = COALESCE(?, capacity), lanes = COALESCE(?, lanes), units = COALESCE(?, units), agent_slots = COALESCE(?, agent_slots), disk_free = COALESCE(?, disk_free),
       asleep_at = CASE WHEN ? THEN COALESCE(asleep_at, ?) ELSE NULL END
     WHERE id = ?`,
  )
    .bind(
      text, at, at, str(r.agent?.version, /^\d{1,4}\.\d{1,4}\.\d{1,6}$/), str(r.release?.applied, tag), str(r.release?.target, tag), round?.outcome === "rolled-back" ? str(round.from, tag) : null,
      isolation, dedicated, runtime ? JSON.stringify(runtime) : null, str(r.agent?.provider, /^[a-z0-9-]{1,40}$/), str(r.agent?.model, /^[A-Za-z0-9._:-]{1,80}$/),
      cap ? JSON.stringify({ ...cap, below_minimum: belowMinimum(cap) }) : null, cap ? JSON.stringify(cap.lanes) : null, cap ? unitsOf(cap) : null, cap ? cap.agent_slots : null, cap ? JSON.stringify(cap.disk_free_gb) : null,
      asleep ? 1 : 0, at,
      h.id,
    )
    .run();
  // The host orders it answers (#344): each closes an open order of this host only, once; its line is the pool's words, the
  // agent's own stay on the host's page.
  const answers = orderAnswers(r.orders);
  let closed = 0;
  if (answers.length) {
    const results = await env.DB.batch(answers.flatMap((a) => [
      env.DB.prepare(ANSWER_HOST_ORDER_SQL).bind(a.outcome, at, a.detail, a.id, h.id),
      env.DB.prepare(
        `INSERT INTO events (kind, ring, source, status, summary, payload)
         SELECT 'host', NULL, 'factory', ?, ? || kind || ' ' || state || ' (' || id || ')', json_object('host', host_id, 'owner', ?, 'action', 'order-answer', 'order', id, 'kind', kind, 'outcome', state, 'by', issued_by)
           FROM host_orders WHERE id = ? AND host_id = ? AND state = ? AND answered_at = ?`,
      ).bind(a.outcome === "done" ? "ok" : "warn", `${hostLine_(h)}: its agent answered the host order `, h.owner_login, a.id, h.id, a.outcome, at),
    ]));
    closed = results.filter((x, i) => i % 2 === 0 && x.meta.changes).length;
  }
  return json({ ok: true, at, units: cap ? unitsOf(cap) : h.units, below_minimum: cap ? belowMinimum(cap) : null, asleep, orders_closed: closed }, 200, NO_STORE);
}

/** The cron's share (scheduler.ts): nonces past the window, enrollment tokens nobody used a day after they expired, and host orders past their not_after (#344). */
export async function pruneHosts(env: Env, now = Date.now()): Promise<number> {
  const [a, b, c] = await env.DB.batch([
    env.DB.prepare("DELETE FROM host_nonces WHERE at < ?").bind(iso(now - NONCE_KEEP_MIN * MIN)),
    env.DB.prepare("DELETE FROM host_enrollments WHERE used_at IS NULL AND expires_at < ?").bind(iso(now - 24 * 60 * MIN)),
    env.DB.prepare(EXPIRE_ALL_HOST_ORDERS_SQL).bind(iso(now)),
  ]);
  return (a.meta.changes ?? 0) + (b.meta.changes ?? 0) + (c.meta.changes ?? 0);
}
