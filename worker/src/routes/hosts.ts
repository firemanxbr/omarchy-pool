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
 *                                with a passkey; one open per kind, each with a not_after; P4's (#325): set-units, set-emulate,
 *                                rotate-token, retry-release, diagnostics — its owner or any maintainer, an agent from 0.4.0
 *   GET  /hosts/:id/diagnostics/:order   the dispatcher's log lines a diagnostics order brought: its owner's and the maintainers'
 *   GET  /hosts/self/state       signed by the host key: what the pool says of the host — its release target, its
 *                                registration's open Updates, its open host orders (#344) and its settings (#325)
 *   POST /hosts/self/token       signed: mint the host worker token (first fetch and every rotation alike); the one it
 *                                replaces stays valid ten minutes, so only the dispatcher is recreated
 *   POST /hosts/self/report      signed: the host report (design v2 §17.2), at most 16 KiB
 *   POST /hosts/self/diagnostics signed: the lines a diagnostics order asked for (#325), at most 64 KiB
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
import { machineOrigin, version, API_HOST, WORKER_ALIVE_MINUTES, type RunningVersion } from "../meta";
import { putRecord } from "../record";
import { writeGate, WORKER_ROW_SQL } from "./orders";
import { selectionRules } from "./factory";
import { sha256Hex, viaOf, workspace, SIGN_IN, type Contributor } from "./contributors";
import { dashboardOrigin } from "./agents";
import { docChallenge, issueChallenge, PASSKEYS_SQL, justNowWords, relyingParty, webGate, CEREMONY_MS, SELF_CAUSE, TOO_MANY_CHALLENGES, CHALLENGE_MINUTES } from "./passkeys";
import { toB64url } from "../webauthn";
import { cancelOrdersOf, openOrdersOf, orderFacts, orderVerdicts, FOLLOW_POLL_S, type HeldTask, type OrderFacts, type OrderWorker } from "../orders";
import {
  aliveOf, capacityLines, capacityOf, fleetHostOf, hostLines, jobReservedOf, limitsOf, needsPersonOf, reportOf, roundOf, secondOpinionOf, silentOf,
  CLAMPED_WINDOW_H, LOST_WINDOW_MIN, QUEUED_KINDS, WEEK_DAYS,
  type AuditRow, type BusyRow, type FleetHostRow, type FleetLease, type MixRow, type QueueRow,
} from "../fleet";
import {
  belowMinimum, enrollMessage, fingerprint, hostLine, installCommand, newHostId, parseCapacity, parseHostHeader, publicKeyBytes, sha256HexOf, shortId, signedMessage,
  unitsOf, verifySignature, ENROLL_TTL_MIN, MIN_HOST, HOST_NAME, HOST_REPORT_FRESH_MIN, ISOLATIONS, NONCE_KEEP_MIN, OLD_TOKEN_GRACE_MIN, REPORT_MAX_BYTES, SIGNED_SKEW_S, TOKEN_ROTATE_DAYS,
  hostReason, revertedOf, HOST_REASON, OWNER_LISTED_SQL, OWNER_NOT_MAINTAINER,
  agentTakesOrders, isHostOrderKind, legacyOf, orderAnswers, HOST_ORDER_KINDS, HOST_ORDER_TTL_MIN, HOST_ORDERS_AGENT, asleepNow,
  agentTakesSettings, hostSettingsOf, orderArg, reportedBrakeOf, reportedSettingsOf, DIAGNOSTIC_LINE_MAX, DIAGNOSTIC_LINES, DIAGNOSTICS_MAX_BYTES, HOST_ORDER_ID, HOST_SETTINGS_AGENT, SETTINGS_ORDER_KINDS,
  poolBehindOf, reportedSoakOf, sandboxAppliedOf, soakOf, HOST_ROW_TOUCH_MIN, PINNED_TOOLS,
  agentTakesOwner, ownerDoc, readOwnerDoc, reportedOwnerOf, sealKeyOf, sealedKeys, widening, HOST_OWNER_AGENT, OWNER_DOC_TTL_MIN, OWNER_ORDER_KINDS, PIN_DOC_TTL_MIN,
  type Capacity, type HostOrderKind, type Isolation, type OrderArg, type OwnerAct, type OwnerDocInput,
} from "../hosts";
import { gateWords, lastGoodMessage, parseTag, revertAfter, updateState } from "../update";

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
  /** #342: when the pool first heard its agent revert rolled_back_from. */
  rolled_back_at: string | null;
  report: string | null; reported_at: string | null; last_seen: string | null; enrolled_at: string; confirmed_at: string | null; worker_id: string | null; token_issued_at: string | null;
  /** #322: who suspended, resumed or retired it last, when and why; when the sync found its owner gone from the list. */
  status_by: string | null; status_at: string | null; status_reason: string | null; owner_removed_at: string | null;
  /** #337: the large task it reserves for, since when (selection.ts). */
  reserving_task: number | null; reserving_since: string | null;
  /** #329: when its agent's report first said it sleeps; NULL while it is awake. */
  asleep_at: string | null;
  /** #342: the release its registration last claimed on (build_workers.version), where HOST_VIEW_COLS joins it. */
  claims_on?: string | null;
  /** #324: its registration's last claim, its drain and the model its claims say it runs, where HOST_VIEW_COLS joins them. */
  reg_last_seen?: string | null; drained_at?: string | null; drained_by?: string | null; drain_reason?: string | null; agent?: string | null;
  /** #325: the settings its agent took (its last set-units and set-emulate answered done). */
  settings: string | null;
  /** #326: its soak and freeze detection as its last report says them (migration 0048): what the claims and listings read. */
  soaking_until: string | null; soak_quarantine: string | null; pool_behind_github: string | null;
  /** #328: the X25519 seal key its agent reports, and the one its owner confirmed ({key, by, at, passkey}, migration 0049). */
  seal_key: string | null; seal_confirmed: string | null;
  /** #330: the sandbox its dispatcher's last claim said it applies (migration 0049, hosts.ts sandboxApplied); NULL while its claims do not say. */
  sandbox_applied: string | null;
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

/**
 * A host as its page, the listings and the fleet read it: the row, with what its registration says beside it — the release it last
 * claimed on (#342, `claims_on`), its last claim, its drain and the model it runs (#324) — by the registration's primary key.
 */
const HOST_VIEW_COLS = "hosts.*, w.version AS claims_on, w.last_seen AS reg_last_seen, w.drained_at, w.drained_by, w.drain_reason, w.agent";
const HOST_VIEW_FROM = "hosts LEFT JOIN build_workers w ON w.id = hosts.worker_id";

/** A HostRow as the fleet's rules read it (fleet.ts FleetHostRow): the columns HOST_VIEW_COLS joins, none missing. */
const fleetRowOf = (h: HostRow): FleetHostRow => ({ ...h, reg_last_seen: h.reg_last_seen ?? null, drained_at: h.drained_at ?? null, agent: h.agent ?? null });

/** Every lease a host's registration holds, by the lease index: the fleet rows' units, disk budgets and tasks (#324). */
export const FLEET_LEASES_SQL = "SELECT id, lease_owner, kind, arch, lane, units, size, disk_gb FROM build_tasks WHERE status = 'leased' AND lease_owner IN (SELECT worker_id FROM hosts WHERE worker_id IS NOT NULL AND status != 'retired')";

/**
 * What anyone sees of a host, and what its owner and the maintainers see besides (design v2 §18.1): anyone, its name, its
 * architectures, its release and whether its agent reports — with whose it is and whether it sleeps or was stopped, which the
 * journal says as publicly; its owner and the maintainers, the rest — the runtime and its versions, the capacity and the units busy
 * and free, the lanes and the held ones, the release with its floor and the rollout, the "needs a person" box, the legacy set, the
 * settings and the soak.
 */
async function hostView(h: HostRow, detailed: boolean, now: number, pool: RunningVersion, leases: FleetLease[] = []) {
  // Whether its agent reports by the fleet's one rule (fleet.ts aliveOf): a report within HOST_REPORT_FRESH_MIN and not silent — the
  // page, the listings and the Workers page's row alike. Silent as Status says it, public as that line is: the page's words for why not.
  const alive = aliveOf(h, now), silent = silentOf(h, now);
  const capacity = h.capacity ? (JSON.parse(h.capacity) as Capacity & { below_minimum?: string | null }) : null;
  const lanes = h.lanes ? (JSON.parse(h.lanes) as Capacity["lanes"]) : [];
  const out: Record<string, unknown> = {
    id: h.id, name: h.name, owner: h.owner_login, status: h.status, arches: lanes.map((l) => l.arch), release_applied: h.release_applied, alive, silent,
    // Whether it sleeps (#329), public as `alive` is: `asleep` is what the claims hold to (zero free units while its report is
    // fresh), `asleep_since` what its last report said, fresh or not.
    asleep: asleepNow(h, now), asleep_since: h.asleep_at,
    worker: h.worker_id, enrolled_at: h.enrolled_at, confirmed_at: h.confirmed_at,
    // Freeze detection (#326): its agent says GitHub has shown a newer release than the pool names for over a day — about the pool, public as Status says it.
    pool_behind_github: poolBehindOf(h.pool_behind_github),
    // Who stopped it and why (#322) — the journal's words, public as the journal is — and whether the list stopped its claims.
    status_by: h.status_by, status_at: h.status_at, status_reason: h.status_reason, claims_stopped_at: h.owner_removed_at,
  };
  if (!detailed) return out;
  const raw = publicKeyBytes(h.pubkey)!;
  const report = reportOf(h.report);
  const fleet = fleetHostOf(fleetRowOf(h), leases, now, selectionRules());
  const settings = reportedSettingsOf(h.report);
  const rel = report?.release && typeof report.release === "object" ? (report.release as Record<string, unknown>) : {};
  const tagOf = (v: unknown) => (typeof v === "string" && /^v\d+\.\d+\.\d+$/.test(v) ? v : null);
  const rollout = report?.rollout && typeof report.rollout === "object" ? (report.rollout as Record<string, unknown>) : null;
  const runtime = h.runtime ? (JSON.parse(h.runtime) as Record<string, unknown>) : null;
  const platform = `${h.arch ?? "?"}-${h.os === "macos" ? "darwin" : "linux"}`;
  const pinned = PINNED_TOOLS[platform] ?? null;
  const said = (v: unknown) => (typeof v === "string" && /^v?\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(v) ? v.replace(/^v/, "") : null);
  // The tools a host on the pool's own release runs are the ones that release pins; the runtime's own word when its report says it.
  const onPool = !!h.release_applied && h.release_applied === pool.version;
  return {
    ...out,
    where: h.where, hostname: h.hostname, os: h.os, arch: h.arch, page_kb: h.page_kb, isolation: h.isolation, dedicated: h.dedicated === null ? null : !!h.dedicated,
    fingerprint: await fingerprint(raw),
    capacity, lanes, units: h.units, agent_slots: h.agent_slots, disk_free: h.disk_free ? JSON.parse(h.disk_free) : null, pool_cap_units: h.pool_cap_units,
    // The sandbox its dispatcher applies, as its last claim said (#330) — beside what its agent found (capacity.sandbox): null while
    // its claims do not say (a dispatcher before #330), whatever its agent found.
    sandbox_applied: sandboxAppliedOf(h.sandbox_applied),
    // The units the pool counts on it now (#324, design v2 §18.1): what it hands it at most, what its leases hold, what is free for a
    // task, the one kept for pool jobs, and its tasks; the lanes its agent holds off, and why; the limits its runtime enforces.
    units_busy: fleet.units_busy, units_free: fleet.units_free, units_effective: fleet.units, job_reserved: jobReservedOf(report), tasks: fleet.tasks, state: fleet.state,
    held_lanes: capacity?.held_lanes ?? [], limits: limitsOf(report),
    // The owner's caps (design v2 §7.2, §12): what its envelope gives of what was detected, as its agent reports them.
    owner_caps: settings ? { max_units: settings.envelope.max_units, detected_units: settings.envelope.detected_units, emulate: settings.envelope.emulate } : null,
    reserving_task: h.reserving_task, reserving_since: h.reserving_since,
    below_minimum: capacity?.below_minimum ?? null,
    runtime, provider: h.provider, model: h.model,
    // The versions (design v2 §18.1): its agent's; the compose plugin and the docker CLI — its report's word, else the ones the release
    // it applied pins when that is the pool's (an agent says neither yet: its state keeps the pins' digests only, so a host behind the
    // pool shows them unknown) —; the engine's, when its report says it.
    agent_version: h.agent_version,
    tools: {
      compose: said(runtime?.compose) ?? (onPool ? pinned?.compose ?? null : null), docker: said(runtime?.docker) ?? (onPool ? pinned?.docker ?? null : null), engine: said(runtime?.engine),
      pinned: !said(runtime?.compose) && !said(runtime?.docker) && onPool && !!(pinned?.compose || pinned?.docker),
    },
    release_target: h.release_target, rolled_back_from: h.rolled_back_from, rolled_back_at: h.rolled_back_at,
    release_floor: tagOf(rel.floor), min_release: tagOf(rel.min_release),
    rollout: rollout ? { state: typeof rollout.state === "string" ? rollout.state.slice(0, 40) : null, since: typeof rollout.since === "string" ? rollout.since.slice(0, 40) : null, target: tagOf(rollout.target) } : null,
    // Its registration claims on its last-good after its agent reverted the pool's release, until then (#342): the gate's own word,
    // on the release its registration last claimed on (its dispatcher's) — on another than its agent's last-good the gate refuses
    // it, and this says nothing; the release its agent applied only before its registration ever claimed.
    last_good: lastGoodMessage(updateState(h.claims_on ?? h.release_applied, pool, now, soakOf({ soaking_until: h.soaking_until, quarantine: h.soak_quarantine }), revertedOf(h))),
    round: roundOf(report),
    // What only a person fixes (#324, design v2 §18.1): from its status and its last report.
    needs_person: needsPersonOf({ ...h, status_by: h.status_by, status_reason: h.status_reason }, report),
    // Its registration's drain (#322): Drain and Resume are on its page too.
    drained: h.drained_at ? { at: h.drained_at, by: h.drained_by ?? null, reason: h.drain_reason ?? null } : null,
    // The legacy set its agent reports (#344): the project, its state and directory, what a retire-legacy would be refused for.
    legacy: legacyOf(h.report),
    // Its settings (#325): what its agent reports — the narrowing, the envelope it narrows inside, what applies —, what the pool keeps
    // for it, the brake's last window, and the releases it holds in quarantine (what retry-release lifts).
    settings, pool_settings: hostSettingsOf(h.settings), brake: reportedBrakeOf(h.report), quarantine: quarantineOf(h.report),
    // Its owner's soak (#326): the minutes its envelope sets, when the soak of the release it is to take ends, and GitHub's latest tag as its agent read it.
    soak: reportedSoakOf(h.report),
    // The owner's control without a visit (#328): the passkey pinned at the host, the envelope a widening starts from, the agent keys' names —
    // and its seal key, whether its owner confirmed it, and whether it changed since. A key of its own: `owner` stays the owner's login.
    owner_control: reportedOwnerOf(h.report), seal: await sealView(h),
    reported_at: h.reported_at, last_seen: h.last_seen, token_issued_at: h.token_issued_at,
    summary: capacity ? hostLine(capacity, h.isolation, h.dedicated === null ? null : !!h.dedicated) : null,
  };
}

const mayDetail = (c: Contributor | null, h: Pick<HostRow, "owner_login">) => !!c && (c.role === "maintainer" || c.login === h.owner_login);

/** The seal key its agent reports (#328) with its fingerprint — the one `omarchy-agent status` prints at the host — and its owner's confirmation: whose and when, and whether it is still the key reported. */
async function sealView(h: Pick<HostRow, "seal_key" | "seal_confirmed">) {
  const key = sealKeyOf(h.seal_key);
  let confirmed: { key?: unknown; by?: unknown; at?: unknown } | null = null;
  try {
    confirmed = h.seal_confirmed ? JSON.parse(h.seal_confirmed) : null;
  } catch {
    confirmed = null;
  }
  if (!key && !confirmed) return null;
  return {
    key, fingerprint: key ? await fingerprint(fromB64urlKey(key)) : null,
    confirmed: confirmed && typeof confirmed.by === "string" && typeof confirmed.at === "string" ? { by: confirmed.by, at: confirmed.at, current: confirmed.key === key } : null,
  };
}
const fromB64urlKey = (k: string) => publicKeyBytes(k)!;

/** The releases its last report holds in quarantine (#325: what retry-release lifts), each a tag. */
function quarantineOf(report: string | null): string[] {
  if (!report) return [];
  try {
    const q = (JSON.parse(report) as { quarantine?: unknown }).quarantine;
    return Array.isArray(q) ? q.map((x) => (x as { release?: unknown })?.release).filter((r): r is string => typeof r === "string" && /^v\d+\.\d+\.\d+$/.test(r)).slice(0, 8) : [];
  } catch {
    return [];
  }
}

/**
 * GET /hosts[?owner=<login>] — the hosts that are not retired, newest first;
 * the details for their owner and the maintainers. A maintainer also gets the
 * notices of the last week: the hosts other maintainers confirmed (D40).
 */
export async function handleHostsList(c: Contributor | null, url: URL, env: Env): Promise<Response> {
  const owner = url.searchParams.get("owner");
  if (owner !== null && !/^[A-Za-z0-9-]{1,39}$/.test(owner)) return json({ error: "owner is a GitHub login" }, 400);
  const [listed, held] = await env.DB.batch([
    owner
      ? env.DB.prepare(`SELECT ${HOST_VIEW_COLS} FROM ${HOST_VIEW_FROM} WHERE hosts.owner_login = ? AND hosts.status != 'retired' ORDER BY hosts.enrolled_at DESC LIMIT 50`).bind(owner)
      : env.DB.prepare(`SELECT ${HOST_VIEW_COLS} FROM ${HOST_VIEW_FROM} WHERE hosts.status != 'retired' ORDER BY hosts.enrolled_at DESC LIMIT 100`),
    env.DB.prepare(FLEET_LEASES_SQL),
  ]);
  const rows = listed.results as HostRow[], leases = held.results as FleetLease[];
  const now = Date.now();
  const pool = version(env);
  const rules = selectionRules();
  // Each with its fleet row (#324, design v2 §18.2): its lanes, its units busy and free, its tasks and its state, public as the Workers
  // page is — a person's page lists their hosts with them.
  const hosts = await Promise.all(rows.map(async (h) => ({ ...(await hostView(h, mayDetail(c, h), now, pool, leases)), fleet: fleetHostOf(fleetRowOf(h), leases, now, rules) })));
  let notices: { host: string; owner: string; line: string; at: string }[] = [];
  if (c && c.role === "maintainer") {
    const recent = (await env.DB.prepare("SELECT * FROM hosts WHERE confirmed_at > ? AND owner_login != ? ORDER BY confirmed_at DESC LIMIT 10").bind(iso(now - 7 * 24 * 60 * MIN), c.login).all<HostRow>()).results;
    notices = recent.map((h) => ({ host: h.id, owner: h.owner_login, at: h.confirmed_at!, line: newHostLine(h) }));
  }
  return json({ hosts, notices, minimum: MIN_HOST, fresh_minutes: HOST_REPORT_FRESH_MIN }, 200, NO_STORE);
}

// ---------- the fleet: the Workers page's hosts and Status's lines (#324, design v2 §18.2, §18.3) ----------

/** The hosts that are not retired, with their registration's liveness and drain: a handful of maintainers' machines, no index needed. */
const FLEET_HOSTS_SQL = `SELECT ${HOST_VIEW_COLS} FROM ${HOST_VIEW_FROM} WHERE hosts.status != 'retired' ORDER BY hosts.name, hosts.id LIMIT 100`;
/** Each architecture's queue of the tasks a lane runs (builds, trials), by the queue index: how many, the oldest, those waiting for a native host. */
export const QUEUE_BY_ARCH_SQL = `SELECT arch, COUNT(*) AS n, MIN(created_at) AS oldest, SUM(json_extract(params, '$.needs_native') IS 1) AS needs_native
  FROM build_tasks WHERE status = 'queued' AND kind IN (${QUEUED_KINDS.map((k) => `'${k}'`).join(", ")}) GROUP BY arch`;
/**
 * The unit-hours each architecture's lanes spent on hosts' leases over the week (?1 now, ?2 a week ago): every lease of a host
 * (`lease_gen`) of a lane's kinds, from its start (or the week's) to its end (or now), by its units — what Status's busy ratio
 * divides by the units the hosts that run the lane have. The tasks a week touched: what the stats' weekly series read as well.
 */
export const BUSY_7D_SQL = `SELECT arch, lane, SUM(COALESCE(units, 1) * (julianday(CASE WHEN status = 'leased' THEN ?1 ELSE finished_at END) - julianday(CASE WHEN started_at < ?2 THEN ?2 ELSE started_at END))) * 24 AS unit_hours
  FROM build_tasks WHERE lease_gen IS NOT NULL AND lane IN ('native', 'emulated') AND kind IN (${QUEUED_KINDS.map((k) => `'${k}'`).join(", ")}) AND started_at IS NOT NULL
    AND (status = 'leased' OR (finished_at IS NOT NULL AND finished_at > ?2)) GROUP BY arch, lane`;
/**
 * The journal's lines Status reads of the last day (by the kind index): a host lease lost (its fail's `lost`) and a task clamped to
 * the largest host alive (the claim's own line). Matched on the payload's text as the pool writes it (JSON.stringify, no spaces):
 * SQLite's JSON parser is never asked to read a line.
 */
export const FLEET_EVENTS_SQL = `SELECT summary, payload, created_at FROM events WHERE kind = 'build' AND created_at > ?
  AND (payload LIKE '%"lost":true%' OR payload LIKE '%"clamped":true%') ORDER BY created_at DESC LIMIT 100`;
/** The models the registrations alive say they run (their claims' `agent`), with how many and how many of them are hosts'. */
export const MODEL_MIX_SQL = `SELECT agent, COUNT(*) AS n, SUM(kind = 'host') AS hosts FROM build_workers WHERE revoked_at IS NULL AND last_seen > ? AND agent IS NOT NULL
  GROUP BY agent ORDER BY n DESC, agent LIMIT 20`;
/** Last week's audits of the project's copies of packages (publish-bound, #339), by how independent their lease recorded them, by the kind index. */
export const AUDITS_7D_SQL = `SELECT a.independent AS independent, COUNT(*) AS n FROM build_tasks a WHERE a.kind = 'audit' AND a.status = 'done' AND a.finished_at > ?
  AND EXISTS (SELECT 1 FROM build_tasks b WHERE b.id = json_extract(a.params, '$.task') AND b.kind = 'build' AND b.trust = 'project' AND json_extract(b.params, '$.review') IS NOT NULL)
  GROUP BY a.independent`;

/**
 * GET /hosts/fleet — the fleet, public (design v2 §18.2, §18.3): each host's fleet row — owner, lanes, units busy and free, tasks,
 * release, isolation level, whether its agent reports —; the Status lines — each host's warnings, errors and info, the capacity per
 * architecture (the scaling signal) and the second opinion —; and the numbers behind them. One read for the Workers page and
 * Status, kept a minute at the edge as the stats are: the week's sums read the tasks it touched.
 */
export async function handleFleet(env: Env): Promise<Response> {
  const now = Date.now();
  const at = iso(now), weekAgo = iso(now - WEEK_DAYS * 24 * 60 * MIN);
  const [hostRows, leaseRows, queue, busy, events, mix, audits] = await env.DB.batch([
    env.DB.prepare(FLEET_HOSTS_SQL),
    env.DB.prepare(FLEET_LEASES_SQL),
    env.DB.prepare(QUEUE_BY_ARCH_SQL),
    env.DB.prepare(BUSY_7D_SQL).bind(at, weekAgo),
    env.DB.prepare(FLEET_EVENTS_SQL).bind(iso(now - CLAMPED_WINDOW_H * 60 * MIN)),
    env.DB.prepare(MODEL_MIX_SQL).bind(iso(now - WORKER_ALIVE_MINUTES * MIN)),
    env.DB.prepare(AUDITS_7D_SQL).bind(weekAgo),
  ]);
  const rows = (hostRows.results as HostRow[]).map(fleetRowOf);
  const leases = leaseRows.results as FleetLease[];
  const rules = selectionRules();
  const hosts = rows.map((h) => fleetHostOf(h, leases, now, rules));
  const lost: { worker: string; task: number; at: string }[] = [], clamped: { task: number; summary: string; at: string }[] = [];
  for (const e of events.results as { summary: string; payload: string | null; created_at: string }[]) {
    let p: { task?: unknown; worker?: unknown; lost?: unknown; clamped?: unknown } = {};
    try { p = e.payload ? JSON.parse(e.payload) : {}; } catch { continue; }
    if (typeof p.task !== "number") continue;
    if (p.lost === true && typeof p.worker === "string" && Date.parse(e.created_at) > now - LOST_WINDOW_MIN * MIN) lost.push({ worker: p.worker, task: p.task, at: e.created_at });
    if (p.clamped === true && !clamped.some((x) => x.task === p.task)) clamped.push({ task: p.task, summary: e.summary, at: e.created_at });
  }
  const pool = version(env);
  const capacity = capacityOf(queue.results as QueueRow[], hosts, rows, busy.results as BusyRow[], now);
  const second = secondOpinionOf(mix.results as MixRow[], audits.results as AuditRow[]);
  const rank = { error: 0, warn: 1, info: 2 } as const;
  const lines = [...hostLines(rows, { lost, clamped }, pool, now), ...capacityLines(capacity), second.line]
    .map((l, i) => [l, i] as const).sort((a, b) => rank[a[0].level] - rank[b[0].level] || a[1] - b[1]).map(([l]) => l);
  return json(
    { generated_at: at, pool: { version: pool.version, deployed_at: pool.deployed_at }, hosts, lines, capacity, second_opinion: { mix: second.mix, audits: second.audits, none: second.none, share_none: second.share_none } },
    200,
    { "cache-control": "public, max-age=60" },
  );
}

/** The new-host line, the journal's and the notice's (D40). */
function newHostLine(h: HostRow): string {
  const c = h.capacity ? (JSON.parse(h.capacity) as Capacity) : null;
  return `new host of ${h.owner_login}: ${c ? hostLine(c, h.isolation, h.dedicated === null ? null : !!h.dedicated) : h.name}`;
}

/** A host's last host orders, newest first, through (host_id, issued_at): what its page lists with each answer (#344), a settings order's value and whether a diagnostics order brought lines (#325). */
export const HOST_ORDERS_SQL = "SELECT o.id, o.kind, o.arg, o.issued_by, o.issued_at, o.not_after, o.state, o.answered_at, o.detail, d.order_id IS NOT NULL AS lines FROM host_orders o LEFT JOIN host_diagnostics d ON d.order_id = o.id WHERE o.host_id = ? ORDER BY o.issued_at DESC LIMIT 10";

/** The leases a host's registration holds, by the lease index: what its page lists, and what a Stop on each reads (orders.ts HeldTask). */
export const HOST_LEASES_SQL = "SELECT id, kind, name, arch, version, owner, trust, status, lease_owner, lease_expires_at, stop_order, attempts, max_attempts, params, lane, units, size, started_at FROM build_tasks WHERE lease_owner = ? AND status = 'leased' ORDER BY id";
type HostLease = HeldTask & { lane: string | null; units: number | null; size: number | null; started_at: string | null };

/**
 * GET /hosts/:id — one host (the host page, design v2 §18.1). Anyone gets its public fields; its owner and the maintainers its
 * details, the leases its registration holds — each with whether this reader may Stop it, the door's own words where not (#324) —,
 * its last host orders (#344), where its registration stands at the 426 gate (#326), and its registration's Drain, Resume and
 * Update as the worker orders' door answers them (orders.ts orderVerdicts): Drain and Resume with the owner rule (#322), and
 * Update, which is Reconcile now for an agent that takes no host order yet.
 */
export async function handleHostGet(c: Contributor | null, id: string, env: Env): Promise<Response> {
  const h = await env.DB.prepare(`SELECT ${HOST_VIEW_COLS} FROM ${HOST_VIEW_FROM} WHERE hosts.id = ?`).bind(id).first<HostRow>();
  if (!h) return json({ error: "no such host" }, 404, NO_STORE);
  const detailed = mayDetail(c, h);
  // Its leases are its owner's and the maintainers' (§18.1): read for them only.
  const held = detailed && h.worker_id ? ((await env.DB.prepare(HOST_LEASES_SQL).bind(h.worker_id).all<HostLease>()).results) : [];
  const viewer = c ? await viewerOf(env, c) : null;
  const orders = detailed
    ? (await env.DB.prepare(HOST_ORDERS_SQL).bind(h.id).all<Record<string, unknown>>()).results.map((o) => ({ ...o, arg: o.arg ? argView(o.kind as string, JSON.parse(o.arg as string)) : null, lines: !!o.lines }))
    : undefined;
  const pool = version(env);
  const now = Date.now();
  const leases = held.map((l) => ({ id: l.id, lease_owner: l.lease_owner ?? "", kind: l.kind, arch: l.arch, lane: l.lane, units: l.units, size: l.size }));
  const reg = detailed && h.worker_id ? await registrationOf(env, c!, h.worker_id, held, now) : null;
  const verdicts = hostVerdicts(viewer, h);
  // Reconcile now (design v2 §17.1): a host order for an agent that takes them; an Update of its registration for one that does not yet.
  const reconcileVia = verdicts.reconcile.ok ? "order" : reg?.can.update && !agentTakesOrders(h.agent_version) ? "update" : null;
  const can = canOf(verdicts);
  return json(
    {
      // Where its registration stands at the 426 gate (#326) tells its soak and the releases it holds in quarantine: its owner's and the
      // maintainers', as host.soak and host.quarantine are.
      host: await hostView(h, detailed, now, pool, leases),
      // Its leases are its details (§18.1): a visitor gets their count on the Workers page, not what runs.
      leases: detailed ? held.map((l) => ({
        id: l.id, kind: l.kind, name: l.name, arch: l.arch, lane: l.lane, units: l.units, size: l.size, started_at: l.started_at, lease_expires_at: l.lease_expires_at, fenced: !!l.stop_order,
        stop: reg?.stops.get(l.id) ?? { ok: false, why: "its owner's and the maintainers'" },
      })) : undefined,
      orders, pool: { version: pool.version, deployed_at: pool.deployed_at }, update: detailed ? await gateOf(env, h, pool) : undefined,
      registration: reg ? { id: reg.id, drained: reg.drained, can: reg.can, why: reg.why } : null,
      can: { ...can, reconcile_via: reconcileVia }, passkey: { retire: !!viewer && !isOwner(viewer, h), retire_legacy: true },
    },
    200,
    NO_STORE,
  );
}

/**
 * A host's registration as the host page's own controls read it (#324): its drain, and what the worker orders' door
 * (orders.ts orderVerdicts) answers this reader for Drain, Resume and Update, and for a Stop of each lease — the counts behind
 * the caps read once (orderFacts), the task each Stop names set in turn — so a grey button is one the door refuses in the
 * same words.
 */
async function registrationOf(env: Env, c: Contributor, worker: string, held: HeldTask[], now: number) {
  const w = await env.DB.prepare(WORKER_ROW_SQL).bind(worker).first<OrderWorker & { id: string; drained_at: string | null; drained_by: string | null; drain_reason: string | null }>();
  if (!w) return null;
  const facts: OrderFacts = await orderFacts(env, w.id, c.login, now, true);
  const v = orderVerdicts(c, w, facts);
  const pick = (k: "drain" | "resume" | "update") => v[k];
  const can = { drain: pick("drain").ok, resume: pick("resume").ok, update: pick("update").ok };
  const why: Record<string, string> = {};
  for (const k of ["drain", "resume", "update"] as const) { const x = pick(k); if (!x.ok) why[k] = x.why; }
  const stops = new Map<number, { ok: boolean; why?: string }>();
  for (const t of held) {
    const x = orderVerdicts(c, w, { ...facts, task: t }).stop_task;
    stops.set(t.id, x.ok ? { ok: true } : { ok: false, why: x.why });
  }
  return { id: w.id, drained: w.drained_at ? { at: w.drained_at, by: w.drained_by, reason: w.drain_reason } : null, can, why, stops };
}

/**
 * Where its registration stands at the 426 gate (#326, update.ts): the release its last claim reported against the pool's, with its
 * soak and the release its agent reverted (#342), as the claim itself decides it, and why in the page's words. Null with no registration, or one that never claimed.
 */
async function gateOf(env: Env, h: HostRow, pool: ReturnType<typeof version>) {
  if (!h.worker_id) return null;
  const w = await env.DB.prepare("SELECT version FROM build_workers WHERE id = ?").bind(h.worker_id).first<{ version: string | null }>();
  if (!parseTag(w?.version)) return null;
  // The columns the claim reads (SOAK_COLUMNS), from the same row.
  const soak = soakOf({ soaking_until: h.soaking_until, quarantine: h.soak_quarantine });
  const at = Date.now();
  // And the release its agent reverted (#342, REVERTED_COLUMNS): its claim on its last-good, as the claim weighs it.
  const reverted = revertedOf(h);
  const u = updateState(w!.version, pool, at, soak, reverted);
  return { ...u, words: gateWords(u, soak, pool.deployed_at, at, reverted) };
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
    // No mode: the column is history since the community tier ended (#343).
    env.DB.prepare(
      `INSERT INTO build_workers (id, arch, hostname, labels, owner, token_hash, packages, last_seen, trust, trusted_by, trusted_at, host_id, kind)
       SELECT ?, arch, hostname, json_object('where', name), owner_login, NULL, '[]', ?, 'project', owner_login, ?, id, 'host' FROM hosts WHERE id = ? AND worker_id = ? AND confirmed_at = ?`,
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

export type HostRight = "suspend" | "resume" | "retire" | "cap" | "reconcile" | "retire_legacy" | "settings" | "rotate_token" | "retry_release" | "diagnostics" | "owner";
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
 * - P4's (#325) — the settings (set-units, set-emulate), Rotate token, Retry
 *   release, Diagnostics: its owner or any maintainer, on an active host whose
 *   agent takes them (HOST_SETTINGS_AGENT on). They only narrow or ask what
 *   the owner's envelope allows: whether a value fits it is the agent's to
 *   say, and it refuses above it — the page greys what the last report says
 *   the envelope excludes, never the door.
 * - P5's (#328) — a pin, the seal key's confirmation, a widening of the
 *   envelope, agent keys: its owner only, while a maintainer, with their
 *   passkey, on an active host whose agent takes them (HOST_OWNER_AGENT on).
 *   Whatever the door says, the host takes a widening or a key only when the
 *   passkey pinned there signed it.
 */
export function hostVerdicts(
  v: HostViewer | null,
  h: Pick<HostRow, "name" | "status" | "owner_login" | "owner_github_id"> & Partial<Pick<HostRow, "agent_version" | "report">>,
): Record<HostRight, HostVerdict> {
  const no = (status: 401 | 403 | 404 | 409, why: string): HostVerdict => ({ ok: false, status, why });
  if (!v) return { suspend: no(401, SIGN_IN), resume: no(401, SIGN_IN), retire: no(401, SIGN_IN), cap: no(401, SIGN_IN), reconcile: no(401, SIGN_IN), retire_legacy: no(401, SIGN_IN), settings: no(401, SIGN_IN), rotate_token: no(401, SIGN_IN), retry_release: no(401, SIGN_IN), diagnostics: no(401, SIGN_IN), owner: no(401, SIGN_IN) };
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
  // P4's orders (#325): its owner or any maintainer, an agent that takes them.
  const p4 = (!owner && !v.maintainer ? no(403, `only ${h.owner_login} or a maintainer gives ${h.name} its settings and orders`) : null)
    ?? takes
    ?? (!agentTakesSettings(h.agent_version) ? no(409, `its agent (${h.agent_version ?? "unknown"}) takes no settings or P4 orders: agent ${HOST_SETTINGS_AGENT} or later does, and a release brings it by itself`) : null)
    ?? { ok: true } as HostVerdict;
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
    settings: p4, rotate_token: p4, retry_release: p4, diagnostics: p4,
    // P5's (#328): its owner's alone, with the passkey they pin at the host.
    owner: (!owner ? no(403, `only ${h.owner_login} widens ${h.name}'s envelope and sets its agent keys, with the passkey pinned at the host`) : null)
      ?? (!v.maintainer ? no(403, `${OWNER_NOT_MAINTAINER}: ${h.name}'s envelope and keys stay as they are`) : null)
      ?? takes
      ?? (!agentTakesOwner(h.agent_version) ? no(409, `its agent (${h.agent_version ?? "unknown"}) takes no signed widening or sealed key: agent ${HOST_OWNER_AGENT} or later does, and a release brings it by itself`) : null)
      ?? { ok: true },
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
 * every claim reads), and its envelope stays as its owner wrote it — the
 * host is sent nothing; null lifts the cap. A cap above the units the pool
 * counts on the host is refused (#324): it would cap nothing. Lowered below what it holds,
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
  // A cap above the units the pool counts on it caps nothing (#324, design v2 §18.1): refused, so the page never shows a cap that does not hold.
  if (units !== null && h.units !== null && units > h.units) return json({ error: `units: at most ${h.units}, the units the pool counts on ${h.name} — a cap above them caps nothing; lift the cap (null) to let its count decide`, code: "units" }, 400, NO_STORE);
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
    env.DB.prepare("UPDATE build_tasks SET pinned_to = NULL WHERE pinned_to = ? AND status = 'queued' AND EXISTS (SELECT 1 FROM hosts WHERE id = ? AND status_at = ?)").bind(worker, id, at),
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
/** A host's open orders, oldest first, with a settings order's value: what its state hands its agent, by the open-kind index. */
export const HOST_OPEN_ORDERS_SQL = "SELECT id, kind, not_after, arg FROM host_orders WHERE host_id = ? AND state = 'open' AND not_after > ? ORDER BY issued_at LIMIT 16";

/** The right a kind of order needs (hostVerdicts). */
const RIGHT_OF: Record<HostOrderKind, HostRight> = {
  "reconcile-now": "reconcile", "retire-legacy": "retire_legacy", "set-units": "settings", "set-emulate": "settings",
  "rotate-token": "rotate_token", "retry-release": "retry_release", diagnostics: "diagnostics",
  "widen-envelope": "owner", "set-agent-keys": "owner",
};

/** An order's line on the journal: who asked what of which host (a settings order with its value). */
/** What an owner order's line and its row on the page say of it (#328): its version, the envelope's keys or the keys' names — never the document or a ciphertext. */
type OwnerArgView = { version: number; envelope: Record<string, unknown> } | { version: number; keys: string[] };
function orderLine(h: HostRow, kind: HostOrderKind, by: string, arg: OrderArg | OwnerArgView | null, passkey: string): string {
  const lanes = (e: string[]) => (e.length ? e.join(", ") : "none");
  switch (kind) {
    case "retire-legacy":
      return `${hostLine_(h)}: ${by}${passkey} ordered its legacy set ${legacyOf(h.report)?.project ?? "?"} retired — its agent stops and removes it and leaves its marker`;
    case "set-units": {
      const u = arg && "units" in arg ? arg.units : null;
      return u === null ? `${hostLine_(h)}: ${by} gave it its envelope's units back` : `${hostLine_(h)}: ${by} narrowed it to ${u} unit${u === 1 ? "" : "s"}`;
    }
    case "set-emulate": {
      const e = arg && "emulate" in arg ? arg.emulate : null;
      return e === null ? `${hostLine_(h)}: ${by} gave it its envelope's emulated lanes back` : `${hostLine_(h)}: ${by} set its emulated lanes to ${lanes(e)}`;
    }
    case "rotate-token":
      return `${hostLine_(h)}: ${by} ordered its worker token rotated`;
    case "retry-release":
      return `${hostLine_(h)}: ${by} ordered its quarantined release tried again`;
    case "diagnostics":
      return `${hostLine_(h)}: ${by} asked for its dispatcher's last log lines`;
    case "widen-envelope": {
      const env = arg && "envelope" in arg ? arg.envelope : {};
      return `${hostLine_(h)}: ${by}${passkey} signed a widening of its envelope (version ${arg && "version" in arg ? arg.version : "?"}: ${Object.keys(env).join(", ")}) — its agent takes it only when the passkey pinned there signed it`;
    }
    case "set-agent-keys": {
      const names = arg && "keys" in arg ? arg.keys : [];
      return `${hostLine_(h)}: ${by}${passkey} sealed its agent keys to it (version ${arg && "version" in arg ? arg.version : "?"}: ${names.join(", ")}) — the pool holds only ciphertext`;
    }
    default:
      return `${hostLine_(h)}: ${by} ordered a round now`;
  }
}

/**
 * POST /hosts/:id/orders — {kind, assertion?, units?, emulate?}: a host order,
 * from the browser's session on the pool's own page (design v2 §17.1):
 * - `reconcile-now`, its owner or any maintainer: a round now, which never
 *   skips the owner's soak — what the host page's Reconcile now gives;
 * - `retire-legacy`, its owner only, with their passkey
 *   (`host:retire-legacy:<id>`): the agent stops and then removes the
 *   legacy compose project its legacy.json records, and nothing else, and
 *   writes the .omarchy-agent marker into its directory, so rollout.sh,
 *   setup.sh, omarchy-worker and the updater refuse there;
 * - P4's (#325), its owner or any maintainer, an agent from 0.4.0:
 *   `set-units` {units: n | null} and `set-emulate` {emulate: [arch] | null}
 *   narrow the host's units and emulated lanes inside its envelope (null: the
 *   envelope's own back) — the agent refuses anything above it, and the
 *   answer says so —; `rotate-token` rotates its worker token; `retry-release`
 *   lifts a quarantine; `diagnostics` brings the dispatcher's last 500 log
 *   lines, scrubbed, when its envelope allows it.
 * Every one needs an active host whose agent takes it; one open per kind,
 * each with a not_after HOST_ORDER_TTL_MIN on, after which it expires. The
 * agent answers in its report, which closes the order (a done settings order
 * becomes the host's settings); issue and answer are on the journal.
 */
export async function handleHostOrder(c: Contributor, id: string, request: Request, env: Env, url: URL): Promise<Response> {
  const p = await personAct(c, request, env, url, "given orders");
  if (p instanceof Response) return p;
  const h = await env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(id).first<HostRow>();
  if (!h) return json({ error: "no such host" }, 404, NO_STORE);
  if (!isHostOrderKind(p.b.kind)) return json({ error: `kind is one of ${HOST_ORDER_KINDS.join(", ")}`, code: "kind" }, 400, NO_STORE);
  const kind: HostOrderKind = p.b.kind;
  const no = refusedBy(hostVerdicts(p.v, h)[RIGHT_OF[kind]]);
  if (no) return no;
  const arg = orderArg(kind, p.b);
  if (typeof arg === "string") return json({ error: arg, code: "arg" }, 400, NO_STORE);
  // P5's (#328): the document the owner's passkey signed, as this host's page asked for it, relayed whole — the host checks it again.
  const owner = OWNER_ORDER_KINDS.includes(kind) ? ownerOrder(kind, h, c.login, p.b) : null;
  if (owner instanceof Response) return owner;
  // Two documents signed from challenges in flight (two tabs, a slow passkey) carry the same version: the host would take the first and
  // refuse the other as a replay. Said here instead, before it is relayed — and the insert below holds to it too.
  if (owner && owner.view.version < (await nextOwnerVersion(env, h))) {
    return json({ error: `another signed document took version ${owner.view.version} of ${h.name} first: press again, and your passkey signs the next version`, code: "version" }, 409, NO_STORE);
  }
  const ok = kind === "retire-legacy" ? await webGate(request, url, env, c.login, `host:retire-legacy:${id}`)(p.b.assertion)
    : owner ? await webGate(request, url, env, c.login, `host:${kind}:${id}`, owner.doc)(p.b.assertion)
    : null;
  if (ok instanceof Response) return ok;
  const now = Date.now();
  const at = iso(now);
  const notAfter = iso(now + HOST_ORDER_TTL_MIN * MIN);
  const oid = newOrderId();
  const line = orderLine(h, kind, c.login, owner ? owner.view : arg, ok ? justNowWords(ok) : "");
  const stored = owner ? { version: owner.view.version, doc: owner.doc, assertion: assertionFields(p.b.assertion) } : arg;
  const shown = owner ? owner.view : arg;
  try {
    await env.DB.batch([
      env.DB.prepare(EXPIRE_HOST_ORDERS_SQL).bind(at, id),
      env.DB.prepare(`INSERT INTO host_orders (id, host_id, kind, issued_by, via, confirmed_with, issued_at, not_after, arg) SELECT ?, id, ?, ?, 'web', ?, ?, ?, ? FROM hosts WHERE id = ? AND status = 'active' AND NOT EXISTS (${OWNER_VERSION_TAKEN_SQL})`)
        .bind(oid, kind, c.login, ok ? ok.passkey : null, at, notAfter, stored ? JSON.stringify(stored) : null, id, id, owner ? owner.view.version : null),
      env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'host', NULL, 'factory', ?, ?, ? WHERE EXISTS (SELECT 1 FROM host_orders WHERE id = ?)")
        .bind(kind === "retire-legacy" || owner ? "warn" : "ok", line, JSON.stringify({ host: id, owner: h.owner_login, by: c.login, via: "web", action: "order", order: oid, kind, not_after: notAfter, ...(shown ?? {}), ...(ok ? { confirmed_with: ok.passkey } : {}) }), oid),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return json({ error: `${kind} is waiting for ${h.name}'s agent already: one at a time, until it answers or the order expires`, code: "order_open" }, 409, NO_STORE);
    throw e;
  }
  if (!(await env.DB.prepare("SELECT 1 FROM host_orders WHERE id = ?").bind(oid).first())) return json({ error: `${h.name} was not ordered: it changed a moment ago`, code: "host_right" }, 409, NO_STORE);
  return json(
    {
      order: { id: oid, kind, state: "open", not_after: notAfter, ...(shown ? { arg: shown } : {}), ...(ok ? { confirmed_with: ok.passkey } : {}) },
      host: id, by: c.login, line,
      note: `its agent takes it at its next poll (within ${FOLLOW_POLL_S / 60} min) and answers in its next report; not taken by ${notAfter}, it expires`,
    },
    201,
    NO_STORE,
  );
}

// ---------- the owner's control without a visit (#328, design v2 §12, §14, D6 b) ----------

/** An assertion's five fields as a page posts them, strings only, as the host reads them (crates/omarchy-agent/src/owner/webauthn.rs `Assertion`). */
function assertionFields(v: unknown): Record<string, string> {
  const a = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const s = (x: unknown, max: number) => (typeof x === "string" && x.length <= max ? x : "");
  return { credential: s(a.credential, 1400), client_data: s(a.client_data, 4096), authenticator_data: s(a.authenticator_data, 2048), signature: s(a.signature, 1024), user_handle: s(a.user_handle, 128) };
}

/** What a stored owner order says on the page and the journal: its version and the envelope's keys, or the keys' names — never the document or a ciphertext. */
function argView(kind: string, arg: Record<string, unknown> | null): unknown {
  if (!arg || !(OWNER_ORDER_KINDS as readonly string[]).includes(kind)) return arg;
  const d = readOwnerDoc(arg.doc);
  if (!d) return { version: arg.version ?? null };
  return kind === "widen-envelope" ? { version: d.version, envelope: d.envelope ?? {} } : { version: d.version, keys: (d.keys ?? []).map((k) => (k.remove ? `${k.name} (taken out)` : k.name)) };
}

/** The highest version the host's owner orders and its last report name: the next document is one above both, so the host never takes one twice. Through (host_id, issued_at). */
export const OWNER_VERSION_SQL = "SELECT MAX(json_extract(arg, '$.version')) AS v FROM host_orders WHERE host_id = ? AND kind IN ('widen-envelope', 'set-agent-keys')";
/** An owner order of the host at this version or above (host id, version): the insert of another holds to it. NULL, any other kind: none. */
const OWNER_VERSION_TAKEN_SQL = "SELECT 1 FROM host_orders WHERE host_id = ? AND kind IN ('widen-envelope', 'set-agent-keys') AND json_extract(arg, '$.version') >= ?";
async function nextOwnerVersion(env: Env, h: HostRow): Promise<number> {
  const r = await env.DB.prepare(OWNER_VERSION_SQL).bind(h.id).first<{ v: number | null }>();
  return Math.max(r?.v ?? 0, reportedOwnerOf(h.report)?.version ?? 0) + 1;
}

/** The seal key a host's agent reports and its owner confirmed — the one the browser seals to — or why there is none. */
function confirmedSeal(h: HostRow): string | Response {
  const key = sealKeyOf(h.seal_key);
  if (!key) return json({ error: `${h.name}'s agent reports no seal key yet: agent ${HOST_OWNER_AGENT} makes one at its start`, code: "seal_key" }, 409, NO_STORE);
  let c: { key?: unknown } | null = null;
  try {
    c = h.seal_confirmed ? JSON.parse(h.seal_confirmed) : null;
  } catch {
    c = null;
  }
  if (!c || c.key !== key) return json({ error: c ? `${h.name}'s seal key changed since you confirmed it: compare its fingerprint with \`omarchy-agent status\` at the host and confirm it again` : `confirm ${h.name}'s seal key first: compare its fingerprint with \`omarchy-agent status\` at the host`, code: "seal_key" }, 409, NO_STORE);
  return key;
}

/**
 * A widening or agent keys as a page posts them (#328): the document this host's page asked the pool for (POST …/owner/challenge),
 * byte for byte, for this host, this act and this login, not expired; its envelope or its sealed keys as the pool writes them; the
 * keys sealed to the seal key its owner confirmed. The order's arg is then the document and the assertion, relayed whole.
 */
function ownerOrder(kind: HostOrderKind, h: HostRow, login: string, b: Record<string, unknown>): { doc: string; view: OwnerArgView } | Response {
  const d = readOwnerDoc(b.doc);
  if (!d || d.act !== kind || d.host !== h.id || d.by !== login || !Number.isSafeInteger(d.version) || (d.version as number) < 1) {
    return json({ error: "doc: the document this page asked the pool for (POST /api/v1/hosts/<id>/owner/challenge), as it came: for this host, this act and you", code: "doc" }, 400, NO_STORE);
  }
  if (!(Date.parse(d.not_after) > Date.now())) return json({ error: `the document expired at ${d.not_after}: press again`, code: "doc" }, 409, NO_STORE);
  if (kind === "widen-envelope") {
    const w = widening(d.envelope);
    if (typeof w === "string") return json({ error: w, code: "arg" }, 400, NO_STORE);
    return { doc: b.doc as string, view: { version: d.version as number, envelope: w } };
  }
  const k = sealedKeys(d.keys);
  if (typeof k === "string") return json({ error: k, code: "arg" }, 400, NO_STORE);
  const seal = confirmedSeal(h);
  if (seal instanceof Response) return seal;
  if (d.seal_key !== seal) return json({ error: `the keys were sealed to another seal key than ${h.name}'s: seal them again`, code: "seal_key" }, 409, NO_STORE);
  return { doc: b.doc as string, view: { version: d.version as number, keys: k.map((x) => (x.remove ? `${x.name} (taken out)` : x.name)) } };
}

/** The acts a document is signed for. */
const OWNER_ACTS: readonly OwnerAct[] = ["pin-passkey", "widen-envelope", "set-agent-keys"];

/**
 * POST /hosts/:id/owner/challenge — {act, envelope? | keys?}: the document
 * the owner's passkey signs for this host (#328, design v2 D6 b) and the
 * options navigator.credentials.get() takes for it: its challenge is the
 * document's SHA-256 (issued to this login for `host:<act>:<id>`, five
 * minutes, once), user verification required. A pin's names this host and
 * the page's relying party, for any of the login's passkeys; a widening's
 * and agent keys' carry a version above every one this host was given or
 * took, and are for the passkey pinned there alone — none pinned, or one
 * that is no longer the login's, is said before the device is asked. The
 * agent keys arrive sealed in the browser, to the seal key its owner
 * confirmed: the pool never sees a value.
 */
export async function handleOwnerChallenge(c: Contributor, id: string, request: Request, env: Env, url: URL): Promise<Response> {
  const p = await personAct(c, request, env, url, "widened and given its agent keys");
  if (p instanceof Response) return p;
  const h = await env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(id).first<HostRow>();
  if (!h) return json({ error: "no such host" }, 404, NO_STORE);
  const no = refusedBy(hostVerdicts(p.v, h).owner);
  if (no) return no;
  const rp = relyingParty(url);
  if (!rp) return json({ error: `a passkey works on the pool's own page, not on ${url.hostname}`, code: "rp_unavailable" }, 403, NO_STORE);
  const act = OWNER_ACTS.find((a) => a === p.b.act);
  if (!act) return json({ error: `act: one of ${OWNER_ACTS.join(", ")}`, code: "act" }, 400, NO_STORE);
  const now = Date.now();
  const base = { act, host: id, issued_at: iso(now), by: c.login };
  let d: OwnerDocInput;
  let allow: string[] | null = null;
  if (act === "pin-passkey") {
    d = { ...base, not_after: iso(now + PIN_DOC_TTL_MIN * MIN), rp_id: rp.id, origin: rp.origin };
  } else {
    const pinned = reportedOwnerOf(h.report)?.passkey;
    if (!pinned) return json({ error: `no passkey is pinned at ${h.name} yet: make a pin here and paste it at the host (omarchy-agent envelope pin-passkey) — its next report says so`, code: "not_pinned" }, 409, NO_STORE);
    if (pinned.rp_id !== rp.id || pinned.origin !== rp.origin) return json({ error: `the passkey pinned at ${h.name} answers on ${pinned.origin}, not on this page (${rp.origin}): sign there, or pin one made here`, code: "not_pinned" }, 409, NO_STORE);
    if (!(await env.DB.prepare("SELECT 1 FROM passkeys WHERE credential_id = ? AND login = ?").bind(pinned.credential, c.login).first())) {
      return json({ error: `the passkey pinned at ${h.name} is not one of ${c.login}'s on the site any more: pin another at the host`, code: "not_pinned" }, 409, NO_STORE);
    }
    allow = [pinned.credential];
    const version = await nextOwnerVersion(env, h);
    const notAfter = iso(now + OWNER_DOC_TTL_MIN * MIN);
    if (act === "widen-envelope") {
      const w = widening(p.b.envelope);
      if (typeof w === "string") return json({ error: w, code: "arg" }, 400, NO_STORE);
      d = { ...base, version, not_after: notAfter, envelope: w };
    } else {
      const k = sealedKeys(p.b.keys);
      if (typeof k === "string") return json({ error: k, code: "arg" }, 400, NO_STORE);
      const seal = confirmedSeal(h);
      if (seal instanceof Response) return seal;
      d = { ...base, version, not_after: notAfter, seal_key: seal, keys: k };
    }
  }
  const keys = (await env.DB.prepare(PASSKEYS_SQL).bind(c.login).all<{ credential_id: string }>()).results;
  if (!keys.length) return json({ error: `this is confirmed with your passkey, and ${c.login} has none yet: add one on your page`, code: "no_passkey", register: `/user/${encodeURIComponent(c.login)}#passkeys` }, 403, NO_STORE);
  const doc = ownerDoc(d);
  const challenge = await docChallenge(doc);
  if (!(await issueChallenge(env, c.login, "confirm", `host:${act}:${id}`, challenge))) {
    return json({ error: `${TOO_MANY_CHALLENGES} — nothing changed`, code: "rate_limited" }, 429, { ...NO_STORE, "retry-after": String(CHALLENGE_MINUTES * 60) });
  }
  const credentials = allow ?? keys.map((k) => k.credential_id);
  return json({
    doc, act, ...(d.version ? { version: d.version } : {}), not_after: d.not_after,
    publicKey: { challenge, rpId: rp.id, timeout: CEREMONY_MS, userVerification: "required", allowCredentials: credentials.map((id) => ({ type: "public-key", id })) },
  }, 200, NO_STORE);
}

/**
 * POST /hosts/:id/owner/pin — {doc, assertion}: the pin the owner pastes at
 * the host (`omarchy-agent envelope pin-passkey <pin>`, #328): the
 * document this page asked for (this host, the page's relying party, ten
 * minutes), the assertion of one of the owner's passkeys over it — checked
 * here as every act's is, and again at the host with the key the pin
 * carries — and that passkey's COSE public key and algorithm, as it was
 * registered. Base64url of their JSON; journaled. Nothing changes on the
 * host until the owner pastes it there.
 */
export async function handleOwnerPin(c: Contributor, id: string, request: Request, env: Env, url: URL): Promise<Response> {
  const p = await personAct(c, request, env, url, "widened and given its agent keys");
  if (p instanceof Response) return p;
  const h = await env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(id).first<HostRow>();
  if (!h) return json({ error: "no such host" }, 404, NO_STORE);
  const no = refusedBy(hostVerdicts(p.v, h).owner);
  if (no) return no;
  const d = readOwnerDoc(p.b.doc);
  if (!d || d.act !== "pin-passkey" || d.host !== id || d.by !== c.login) return json({ error: "doc: the pin's document this page asked the pool for, as it came", code: "doc" }, 400, NO_STORE);
  if (!(Date.parse(d.not_after) > Date.now())) return json({ error: `the pin's document expired at ${d.not_after}: press Make a pin again`, code: "doc" }, 409, NO_STORE);
  const ok = await webGate(request, url, env, c.login, `host:pin-passkey:${id}`, p.b.doc as string)(p.b.assertion);
  if (ok instanceof Response) return ok;
  const key = await env.DB.prepare("SELECT credential_id, public_key, alg FROM passkeys WHERE id = ?").bind(ok.passkey).first<{ credential_id: string; public_key: string; alg: number }>();
  if (!key) return json({ error: "the passkey went a moment ago: nothing was pinned", code: "not_yours" }, 409, NO_STORE);
  const pin = toB64url(new TextEncoder().encode(JSON.stringify({ doc: p.b.doc, assertion: assertionFields(p.b.assertion), public_key: key.public_key, alg: key.alg })));
  const line = `${hostLine_(h)}: ${c.login} made a pin of their passkey (${ok.passkey})${justNowWords(ok)} — pasted at the host, it is the one passkey its agent takes a widening or agent keys with`;
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('host', NULL, 'factory', 'ok', ?, ?)")
    .bind(line, JSON.stringify({ host: id, owner: h.owner_login, by: c.login, via: "web", action: "pin", passkey: ok.passkey, not_after: d.not_after }))
    .run();
  return json({
    host: id, pin, command: `omarchy-agent envelope pin-passkey ${pin}`, passkey: ok.passkey, not_after: d.not_after, line,
    note: `paste it at the host before ${d.not_after}, as the agent's user: the agent checks it there, keeps the passkey's public key, and from then on takes a widening of its envelope and its agent keys only when this passkey signed them`,
  }, 200, NO_STORE);
}

/**
 * POST /hosts/:id/seal-key — {key, assertion}: its owner confirms, once, the
 * X25519 seal key its agent reports (#328), with their passkey
 * (`host:seal-key:<id>`), having compared its fingerprint with what
 * `omarchy-agent status` prints at the host. The browser seals agent keys to
 * the confirmed key alone; a seal key that changes (one made again) is
 * confirmed again before anything is sealed to it.
 */
export async function handleSealKeyConfirm(c: Contributor, id: string, request: Request, env: Env, url: URL): Promise<Response> {
  const p = await personAct(c, request, env, url, "widened and given its agent keys");
  if (p instanceof Response) return p;
  const h = await env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(id).first<HostRow>();
  if (!h) return json({ error: "no such host" }, 404, NO_STORE);
  const no = refusedBy(hostVerdicts(p.v, h).owner);
  if (no) return no;
  const key = sealKeyOf(p.b.key);
  const reported = sealKeyOf(h.seal_key);
  if (!reported) return json({ error: `${h.name}'s agent reports no seal key yet: agent ${HOST_OWNER_AGENT} makes one at its start`, code: "seal_key" }, 409, NO_STORE);
  if (key !== reported) return json({ error: `the seal key ${h.name}'s agent reports is ${await fingerprint(publicKeyBytes(reported)!)}: reload the page and compare that one`, code: "seal_key" }, 409, NO_STORE);
  const ok = await webGate(request, url, env, c.login, `host:seal-key:${id}`)(p.b.assertion);
  if (ok instanceof Response) return ok;
  const at = iso(Date.now());
  const fp = await fingerprint(publicKeyBytes(key)!);
  const line = `${hostLine_(h)}: ${c.login} confirmed its seal key ${fp}${justNowWords(ok)} — its agent keys are sealed to it in the browser, and the pool holds only ciphertext`;
  const [res] = await env.DB.batch([
    env.DB.prepare("UPDATE hosts SET seal_confirmed = ? WHERE id = ? AND seal_key = ?").bind(JSON.stringify({ key, by: c.login, at, passkey: ok.passkey }), id, key),
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'host', NULL, 'factory', 'ok', ?, ? WHERE changes() > 0")
      .bind(line, JSON.stringify({ host: id, owner: h.owner_login, by: c.login, via: "web", action: "seal-key", fingerprint: fp, confirmed_with: ok.passkey })),
  ]);
  if (!res.meta.changes) return json({ error: `${h.name}'s seal key changed a moment ago: reload the page`, code: "seal_key" }, 409, NO_STORE);
  return json({ host: id, seal: { key, fingerprint: fp, confirmed: { by: c.login, at, current: true } }, confirmed_with: ok.passkey, line }, 200, NO_STORE);
}

/** GET /hosts/:id/diagnostics/:order — the dispatcher's log lines a diagnostics order brought (#325): its owner's and the maintainers'. */
export async function handleHostDiagnosticsGet(c: Contributor | null, id: string, order: string, env: Env): Promise<Response> {
  const h = await env.DB.prepare("SELECT owner_login FROM hosts WHERE id = ?").bind(id).first<Pick<HostRow, "owner_login">>();
  if (!h) return json({ error: "no such host" }, 404, NO_STORE);
  if (!mayDetail(c, h)) return json({ error: c ? `only ${h.owner_login} and the maintainers read its diagnostics` : SIGN_IN, code: "host_right" }, c ? 403 : 401, NO_STORE);
  const d = await env.DB.prepare(HOST_DIAGNOSTICS_SQL).bind(order, id).first<{ order_id: string; at: string; lines: string; dropped: number }>();
  if (!d) return json({ error: "no diagnostics for that order: its agent sent none (refused, or not answered yet)" }, 404, NO_STORE);
  return json({ host: id, order: d.order_id, at: d.at, lines: JSON.parse(d.lines) as string[], dropped: d.dropped }, 200, NO_STORE);
}
/** One order's diagnostics, by its id (the primary key), of that host only. */
export const HOST_DIAGNOSTICS_SQL = "SELECT order_id, at, lines, dropped FROM host_diagnostics WHERE order_id = ? AND host_id = ?";

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
 * and the body as sent, at most `max` bytes (the diagnostics' 64 KiB, #325;
 * every other call's 16 KiB). A suspended or retired host is refused (403).
 */
export async function signedHost(request: Request, env: Env, url: URL, max = REPORT_MAX_BYTES): Promise<SignedHost | Response> {
  const hdr = parseHostHeader(request.headers.get("omarchy-host"));
  if (!hdr) return json({ error: "a host's signed request is required: Omarchy-Host: <host>; ts=<unix>; nonce=<32 hex>; sig=<base64url>", code: "host_signature" }, 401, NO_STORE);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > max) return json({ error: `at most ${max} bytes` }, 413, NO_STORE);
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
 * order past it is never sent) and a settings order with its value; P4's
 * (#325) settings: what its agent took, which an agent that lost its own
 * narrows to again. Every answer is the host's alone: no-store. Its row's
 * `last_seen` is written only once it is HOST_ROW_TOUCH_MIN old (#324).
 */
export async function handleHostState(s: SignedHost, env: Env): Promise<Response> {
  const h = s.host;
  const now = Date.now();
  const at = iso(now);
  const [, orders, worker] = await env.DB.batch([
    // Written only when it is HOST_ROW_TOUCH_MIN old (#324): the poll every two minutes writes nothing in between.
    env.DB.prepare("UPDATE hosts SET last_seen = ? WHERE id = ? AND (last_seen IS NULL OR last_seen < ?)").bind(at, h.id, iso(now - HOST_ROW_TOUCH_MIN * MIN)),
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
    orders: (orders.results as { id: string; kind: string; not_after: string; arg: string | null }[]).map((o) => ({ id: o.id, kind: o.kind, not_after: o.not_after, ...(o.arg ? (JSON.parse(o.arg) as OrderArg) : {}) })),
    settings: hostSettingsOf(h.settings),
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
 * D1 is written only on a change (#324): a report the same as the last one,
 * within HOST_ROW_TOUCH_MIN of it, writes nothing (`written: false`).
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
  // The same report as the last one the pool kept, within HOST_ROW_TOUCH_MIN of it (#324, design v2 §18): nothing to write — its
  // answers closed their orders when it first came, and the row is fresh enough for every reader (a host is silent after ten minutes).
  if (h.report === text && h.reported_at && Date.parse(h.reported_at) > Date.now() - HOST_ROW_TOUCH_MIN * MIN) {
    return json({ ok: true, at: h.reported_at, units: h.units, below_minimum: null, asleep: h.asleep_at !== null, orders_closed: 0, written: false }, 200, NO_STORE);
  }
  const str = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : null);
  const tag = /^v\d+\.\d+\.\d+$/;
  // An agent that has no whole capacity file to send leaves it out; null says the same.
  const cap = r.capacity === undefined || r.capacity === null ? null : parseCapacity(r.capacity);
  if (typeof cap === "string") return json({ error: cap }, 400, NO_STORE);
  // As at enrollment: the native lane is the host's own architecture.
  if (cap && !cap.lanes.some((l) => l.mode === "native" && l.arch === h.arch)) return json({ error: `capacity.lanes: the native lane is not ${h.arch}` }, 400, NO_STORE);
  const runtime = r.runtime && typeof r.runtime === "object" ? r.runtime : null;
  // As the enrollment: whole or refused — a cut one would not parse on the hosts' pages.
  if (runtime && JSON.stringify(runtime).length > 2048) return json({ error: "runtime: an object of at most 2 KiB" }, 400, NO_STORE);
  const isolation = runtime && ISOLATIONS.includes(runtime.isolation) ? (runtime.isolation as string) : h.isolation;
  const dedicated = runtime && typeof runtime.dedicated === "boolean" ? (runtime.dedicated ? 1 : 0) : h.dedicated;
  // A Mac about to sleep, or asleep (#329): from the first report that says so until one that does not (an agent that does not
  // say is awake).
  const asleep = r.asleep === true;
  const at = iso(Date.now());
  // The release its guard reverted, kept while its reports hold it back, and since when the pool knows it (#342): the 426 gate lets
  // its registration claim on its last-good for six hours from then.
  const reverted = revertAfter({ from: h.rolled_back_from, at: h.rolled_back_at }, r, at);
  // The soak and freeze detection (#326), read here and kept in plain columns — the claims, the fleet and the listings read those,
  // never the report parsed by SQL: SQLite's JSON parser refuses nesting V8's accepts, and one report would fail them pool-wide.
  const soak = soakOf({ soaking_until: r.release?.soaking_until, quarantine: r.quarantine });
  // The journal says when a host starts and stops reporting the pool behind GitHub, once each.
  const [behindWas, behindNow] = [poolBehindOf(h.pool_behind_github), poolBehindOf(r.release?.pool_behind_github)];
  await env.DB.prepare(
    `UPDATE hosts SET report = ?, reported_at = ?, last_seen = ?, agent_version = COALESCE(?, agent_version), release_applied = ?, release_target = ?, rolled_back_from = ?, rolled_back_at = ?,
       isolation = ?, dedicated = ?, runtime = COALESCE(?, runtime), provider = ?, model = ?,
       capacity = COALESCE(?, capacity), lanes = COALESCE(?, lanes), units = COALESCE(?, units), agent_slots = COALESCE(?, agent_slots), disk_free = COALESCE(?, disk_free),
       soaking_until = ?, soak_quarantine = ?, pool_behind_github = ?, seal_key = COALESCE(?, seal_key),
       asleep_at = CASE WHEN ? THEN COALESCE(asleep_at, ?) ELSE NULL END
     WHERE id = ?`,
  )
    .bind(
      text, at, at, str(r.agent?.version, /^\d{1,4}\.\d{1,4}\.\d{1,6}$/), str(r.release?.applied, tag), str(r.release?.target, tag), reverted.from, reverted.at,
      isolation, dedicated, runtime ? JSON.stringify(runtime) : null, str(r.agent?.provider, /^[a-z0-9-]{1,40}$/), str(r.agent?.model, /^[A-Za-z0-9._:-]{1,80}$/),
      cap ? JSON.stringify({ ...cap, below_minimum: belowMinimum(cap) }) : null, cap ? JSON.stringify(cap.lanes) : null, cap ? unitsOf(cap) : null, cap ? cap.agent_slots : null, cap ? JSON.stringify(cap.disk_free_gb) : null,
      soak ? soak.until : null, soak ? JSON.stringify(soak.quarantined) : null, behindNow ? JSON.stringify(behindNow) : null,
      // Its seal key (#328), as the report signed with its host key says it: the page shows it for its owner to confirm.
      sealKeyOf(r.owner?.seal?.key),
      asleep ? 1 : 0, at,
      h.id,
    )
    .run();
  if (!!behindWas !== !!behindNow) {
    const line = behindNow
      ? `${hostLine_(h)}: its agent reports the pool behind GitHub — GitHub's latest release has been ${behindNow.github} for more than a day (since ${behindNow.since}) while the pool names ${behindNow.pool}; nothing changes on the host: check the pool's deploys (freeze detection)`
      : `${hostLine_(h)}: its agent no longer reports the pool behind GitHub`;
    await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('host', NULL, 'factory', ?, ?, ?)")
      .bind(behindNow ? "warn" : "ok", line, JSON.stringify({ host: h.id, owner: h.owner_login, action: "pool-behind-github", ...(behindNow ?? { github: null, pool: null, since: null }) }))
      .run();
  }
  // The host orders it answers (#344): each closes an open order of this host only, once; its line is the pool's words, the
  // agent's own stay on the host's page. A settings order answered done becomes the host's settings (#325).
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
      env.DB.prepare(SETTINGS_FROM_ANSWER_SQL).bind(a.id, h.id, at),
    ]));
    closed = results.filter((x, i) => i % 3 === 0 && x.meta.changes).length;
  }
  return json({ ok: true, at, units: cap ? unitsOf(cap) : h.units, below_minimum: cap ? belowMinimum(cap) : null, asleep, orders_closed: closed, written: true }, 200, NO_STORE);
}

/**
 * A settings order its agent answered done, at this report (`answered_at`): its value becomes the host's settings, the field it
 * names replaced and the other kept — what the host state sends back (#325).
 */
export const SETTINGS_FROM_ANSWER_SQL = `UPDATE hosts SET settings = json_set(COALESCE(settings, '{}'),
    CASE (SELECT kind FROM host_orders WHERE id = ?1) WHEN 'set-units' THEN '$.units' ELSE '$.emulate' END,
    json((SELECT COALESCE(json_extract(arg, '$.units'), json_extract(arg, '$.emulate')) FROM host_orders WHERE id = ?1)))
  WHERE id = ?2 AND EXISTS (SELECT 1 FROM host_orders WHERE id = ?1 AND host_id = ?2 AND kind IN ('set-units', 'set-emulate') AND state = 'done' AND answered_at = ?3)`;

/**
 * POST /hosts/self/diagnostics — {order, lines, at}, signed, at most 64 KiB
 * (#325, design v2 M10): the dispatcher's last log lines a diagnostics order
 * asked for, which the agent read only because its envelope allows it and
 * scrubbed of every secret it knows. Kept for that order of this host only,
 * while it waits for its answer; a line that still looks like a secret
 * (leak.ts) is dropped and counted. Its owner and the maintainers read them
 * on the host page (GET /hosts/:id/diagnostics/:order).
 */
export async function handleHostDiagnostics(s: SignedHost, env: Env): Promise<Response> {
  const h = s.host;
  let b: { order?: unknown; lines?: unknown };
  try {
    b = JSON.parse(new TextDecoder().decode(s.body));
  } catch {
    return json({ error: "a JSON body is required" }, 400, NO_STORE);
  }
  if (typeof b?.order !== "string" || !HOST_ORDER_ID.test(b.order)) return json({ error: "order: the diagnostics order's id" }, 400, NO_STORE);
  if (!Array.isArray(b.lines) || b.lines.length > DIAGNOSTIC_LINES || !b.lines.every((l) => typeof l === "string")) return json({ error: `lines: at most ${DIAGNOSTIC_LINES} lines of the dispatcher's log` }, 400, NO_STORE);
  const o = await env.DB.prepare("SELECT kind, state FROM host_orders WHERE id = ? AND host_id = ?").bind(b.order, h.id).first<{ kind: string; state: string }>();
  if (!o || o.kind !== "diagnostics") return json({ error: `${b.order} is no diagnostics order of ${h.name}`, code: "order" }, 404, NO_STORE);
  if (o.state !== "open" && o.state !== "expired") return json({ error: `${b.order} was answered already: its lines came before its answer, or never`, code: "order" }, 409, NO_STORE);
  let dropped = 0;
  const lines: string[] = [];
  for (const raw of b.lines as string[]) {
    const line = raw.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").slice(0, DIAGNOSTIC_LINE_MAX);
    if (findLeak(line)) dropped++;
    else lines.push(line);
  }
  const at = iso(Date.now());
  await env.DB.prepare("INSERT INTO host_diagnostics (order_id, host_id, at, lines, dropped) VALUES (?, ?, ?, ?, ?) ON CONFLICT (order_id) DO UPDATE SET at = excluded.at, lines = excluded.lines, dropped = excluded.dropped")
    .bind(b.order, h.id, at, JSON.stringify(lines), dropped)
    .run();
  return json({ ok: true, order: b.order, lines: lines.length, dropped }, 200, NO_STORE);
}

/** The diagnostics the cron keeps: a week. */
export const DIAGNOSTICS_KEEP_DAYS = 7;

/** The cron's share (scheduler.ts): nonces past the window, enrollment tokens nobody used a day after they expired, host orders past their not_after (#344), and diagnostics older than a week (#325). */
export async function pruneHosts(env: Env, now = Date.now()): Promise<number> {
  const [a, b, c, d] = await env.DB.batch([
    env.DB.prepare("DELETE FROM host_nonces WHERE at < ?").bind(iso(now - NONCE_KEEP_MIN * MIN)),
    env.DB.prepare("DELETE FROM host_enrollments WHERE used_at IS NULL AND expires_at < ?").bind(iso(now - 24 * 60 * MIN)),
    env.DB.prepare(EXPIRE_ALL_HOST_ORDERS_SQL).bind(iso(now)),
    env.DB.prepare("DELETE FROM host_diagnostics WHERE at < ?").bind(iso(now - DIAGNOSTICS_KEEP_DAYS * 24 * 60 * MIN)),
  ]);
  return (a.meta.changes ?? 0) + (b.meta.changes ?? 0) + (c.meta.changes ?? 0) + (d.meta.changes ?? 0);
}
