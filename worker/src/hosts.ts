/**
 * Maintainer hosts (#321, epic #307, design v2 §6.1, §7.2, §7.3): the rules
 * the routes (routes/hosts.ts) and the pages share, with no database — the
 * capacity a host must have to join, the units the pool computes from what
 * it reports, the host key's fingerprint, and the signed request.
 *
 * The minimum and the unit constants are the signed release's: this module
 * reads factory/bundle/manifest.toml, the file release.yml signs into every
 * host bundle (factory/bin/host-bundle), so the pool deployed from a release
 * checks a host against that release's numbers, and a change to them is one
 * reviewed edit of that file.
 *
 * A signed request (decision D7) carries
 *
 *   Omarchy-Host: <host_id>; ts=<unix seconds>; nonce=<32 hex>; sig=<base64url>
 *
 * where `sig` is the host key's Ed25519 signature over the lines of
 * `signedMessage`: a fixed tag, the host, the method, the path, the SHA-256
 * of the body, the time and the nonce. The pool checks the key of that host,
 * that the time is within 120 seconds of its own, and that the nonce is new
 * (host_nonces), so a request can be neither changed nor replayed.
 */
import { parse } from "smol-toml";
import manifestToml from "../../factory/bundle/manifest.toml";
import { fromB64url } from "./webauthn";

interface Resources { cpus: number; mem_gb: number }
export interface MinHost extends Resources { work_disk_gb: number; engine_disk_gb: number }
interface TaskUnits { build_per_size: number; trial: number; audit: number; job: number; job_reserved: number }
interface SignedCapacity { max_size: number; community_max_size: number; min: MinHost; reserve: Resources; unit: Resources; units: TaskUnits; disk: { build_gb_per_size: number } }

const SIGNED = (parse(manifestToml) as unknown as { capacity: SignedCapacity }).capacity;
/** The minimum a host must have to join (D30), as the release signs it. */
export const MIN_HOST: Readonly<MinHost> = Object.freeze({ ...SIGNED.min });
/** What a host keeps for itself, and one capacity unit (design v2 §7.3). */
export const RESERVE: Readonly<Resources> = Object.freeze({ ...SIGNED.reserve });
export const UNIT: Readonly<Resources> = Object.freeze({ ...SIGNED.unit });
/** The units a task takes, by kind, and the one kept for pool jobs (D30); a build's size is clamped to these (#334). */
export const TASK_UNITS: Readonly<TaskUnits> = Object.freeze({ ...SIGNED.units });
export const MAX_SIZE = SIGNED.max_size;
export const COMMUNITY_MAX_SIZE = SIGNED.community_max_size;
export const BUILD_GB_PER_SIZE = SIGNED.disk.build_gb_per_size;

/** An enrollment token lives this long, and is spent once. */
export const ENROLL_TTL_MIN = 15;
/** A signed request's time may differ from the pool's by this much. */
export const SIGNED_SKEW_S = 120;
/** Nonces are kept this long: past both sides of the window, so a replay always finds its nonce. */
export const NONCE_KEEP_MIN = 5;
/** The host worker token is rotated this often by the agent; the one a rotation replaced keeps working this long. */
export const TOKEN_ROTATE_DAYS = 30;
export const OLD_TOKEN_GRACE_MIN = 10;
/** A host report, and an enrollment, are at most this big. */
export const REPORT_MAX_BYTES = 16 * 1024;
/** A host whose agent reported within this long is one whose agent reports: an Update for its registration is taken (§8.6). */
export const HOST_REPORT_FRESH_MIN = 15;

export const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const HOST_ID = /^h_[0-9a-z]{10}$/;
const ARCHES = ["x86_64", "aarch64"] as const;
export type Arch = (typeof ARCHES)[number];
export const ISOLATIONS = ["root", "user", "subuid"] as const;
export type Isolation = (typeof ISOLATIONS)[number];

export interface Lane { arch: Arch; mode: "native" | "emulated"; via?: string; page16k?: boolean }
/** A capacity report (design v2 §7.3, `run/capacity.json`), as the pool keeps it: the totals it can check, nothing it takes on trust. */
export interface Capacity {
  cpus: number;
  mem_gb: number;
  disk_free_gb: { work: number; engine: number };
  lanes: Lane[];
  agent_slots: number | null;
  /** What the host said it runs; the pool's own count is unitsOf(). */
  units: number | null;
}

const num = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const int = (v: unknown, min: number, max: number): v is number => num(v, min, max) && Number.isInteger(v);

/** A capacity report checked field by field, or why not. Unknown fields are ignored: the agent's report may grow before the pool reads more of it. */
export function parseCapacity(v: unknown): Capacity | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "capacity must be an object";
  const c = v as Record<string, unknown>;
  if (!int(c.cpus, 1, 4096)) return "capacity.cpus must be a whole number of CPUs";
  if (!num(c.mem_gb, 0, 1 << 20)) return "capacity.mem_gb must be a number of GB";
  const d = c.disk_free_gb as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object" || !num(d.work, 0, 1 << 30) || !num(d.engine, 0, 1 << 30)) return "capacity.disk_free_gb must be {work, engine} in GB";
  if (!Array.isArray(c.lanes) || c.lanes.length === 0 || c.lanes.length > 4) return "capacity.lanes must list one to four lanes";
  const lanes: Lane[] = [];
  for (const l of c.lanes as unknown[]) {
    const x = l as Record<string, unknown>;
    if (!x || typeof x !== "object" || !ARCHES.includes(x.arch as Arch) || (x.mode !== "native" && x.mode !== "emulated")) return "a lane is {arch: x86_64 | aarch64, mode: native | emulated}";
    const lane: Lane = { arch: x.arch as Arch, mode: x.mode };
    if (typeof x.via === "string" && /^[a-z0-9-]{1,20}$/.test(x.via)) lane.via = x.via;
    if (typeof x.page16k === "boolean") lane.page16k = x.page16k;
    lanes.push(lane);
  }
  if (lanes.filter((l) => l.mode === "native").length !== 1) return "capacity.lanes must have exactly one native lane";
  return {
    cpus: c.cpus,
    mem_gb: c.mem_gb,
    disk_free_gb: { work: d.work as number, engine: d.engine as number },
    lanes,
    agent_slots: int(c.agent_slots, 0, 64) ? c.agent_slots : null,
    units: int(c.units, 0, 4096) ? c.units : null,
  };
}

/** Why a host is below the signed minimum, with its numbers, or null when it meets it (D30). */
export function belowMinimum(c: Pick<Capacity, "cpus" | "mem_gb" | "disk_free_gb">, min: MinHost = MIN_HOST): string | null {
  const short: string[] = [];
  if (c.cpus < min.cpus) short.push(`${c.cpus} CPUs (${min.cpus} needed)`);
  if (c.mem_gb < min.mem_gb) short.push(`${c.mem_gb} GB of memory (${min.mem_gb} needed)`);
  if (c.disk_free_gb.work < min.work_disk_gb) short.push(`${c.disk_free_gb.work} GB free on the work root (${min.work_disk_gb} needed)`);
  if (c.disk_free_gb.engine < min.engine_disk_gb) short.push(`${c.disk_free_gb.engine} GB free on the engine's data root (${min.engine_disk_gb} needed)`);
  return short.length ? `below the minimum to join: ${short.join(", ")}` : null;
}

/**
 * The units the pool hands a host (design v2 §7.3): computed from the
 * reported totals with the signed constants, and never more than the host
 * itself declared — so neither a confused host nor the pool raises it.
 */
export function unitsOf(c: Pick<Capacity, "cpus" | "mem_gb" | "units">): number {
  const byCpu = Math.floor((c.cpus - RESERVE.cpus) / UNIT.cpus);
  const byMem = Math.floor((c.mem_gb - RESERVE.mem_gb) / UNIT.mem_gb);
  const units = Math.max(0, Math.min(byCpu, byMem));
  return c.units === null ? units : Math.min(units, c.units);
}

/** The host in one line, as the journal and the other maintainers' notice say it (D40): "12 cores, 32 GB, aarch64 native, x86_64 emulated, isolation root (dedicated)". */
export function hostLine(c: Pick<Capacity, "cpus" | "mem_gb" | "lanes">, isolation: string | null, dedicated: boolean | null): string {
  const lanes = c.lanes.map((l) => `${l.arch} ${l.mode}`).join(", ");
  return `${c.cpus} cores, ${c.mem_gb} GB, ${lanes}, isolation ${isolation ?? "unknown"}${dedicated ? " (dedicated)" : ""}`;
}

// ---------- the host key ----------

/** A raw Ed25519 public key from its base64url, or null. */
export function publicKeyBytes(b64u: unknown): Uint8Array | null {
  if (typeof b64u !== "string" || b64u.length !== 43) return null;
  try {
    const raw = fromB64url(b64u, "the public key");
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

/** The key's fingerprint as OpenSSH writes it — `SHA256:` and the unpadded base64 of its SHA-256 — which the agent prints at the host and the owner compares on the page. */
export async function fingerprint(raw: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  let s = "";
  for (const b of d) s += String.fromCharCode(b);
  return `SHA256:${btoa(s).replace(/=+$/, "")}`;
}

/** Whether `sig` (base64url) is the key's Ed25519 signature of `message`. Anything malformed is false, never a throw. */
export async function verifySignature(raw: Uint8Array, sig: string, message: string): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = fromB64url(sig, "the signature");
  } catch {
    return false;
  }
  if (bytes.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, bytes, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

/** What the host signs at enrollment to prove it holds the key it sends: bound to the token, so the proof is good for that enrollment only. */
export function enrollMessage(token: string, pubkey: string): string {
  return `omarchy-host-enroll-v1\n${token}\n${pubkey}`;
}

/** What a signed request's signature covers, one field a line. */
export function signedMessage(host: string, method: string, path: string, bodySha256: string, ts: number, nonce: string): string {
  return `omarchy-host-v1\n${host}\n${method}\n${path}\n${bodySha256}\n${ts}\n${nonce}`;
}

export interface HostHeader { host: string; ts: number; nonce: string; sig: string }

/** The Omarchy-Host header, read strictly: the host, then ts, nonce and sig, once each. */
export function parseHostHeader(h: string | null): HostHeader | null {
  if (!h || h.length > 300) return null;
  const parts = h.split(";").map((p) => p.trim());
  if (parts.length !== 4 || !HOST_ID.test(parts[0])) return null;
  const kv: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf("=");
    if (i < 1) return null;
    const k = p.slice(0, i), v = p.slice(i + 1);
    if (k in kv) return null;
    kv[k] = v;
  }
  if (!/^\d{1,12}$/.test(kv.ts ?? "") || !/^[0-9a-f]{32}$/.test(kv.nonce ?? "") || !/^[A-Za-z0-9_-]{86}$/.test(kv.sig ?? "")) return null;
  return { host: parts[0], ts: Number(kv.ts), nonce: kv.nonce, sig: kv.sig };
}

export async function sha256HexOf(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new host id: `h_` and ten base36 characters. */
export function newHostId(): string {
  const b = new Uint8Array(10);
  crypto.getRandomValues(b);
  return `h_${[...b].map((x) => (x % 36).toString(36)).join("")}`;
}

/** Four base36 characters, for the registration's id (`<login>-<host name>-<4 base36>`, as a worker's always was). */
export function shortId(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => (x % 36).toString(36)).join("");
}

/** Where install.sh is: the release this pool runs, or the latest one when it runs none (a development Worker). */
export function installUrl(poolVersion: string): string {
  return /^v\d+\.\d+\.\d+$/.test(poolVersion)
    ? `https://github.com/firemanxbr/omarchy-pool/releases/download/${poolVersion}/install.sh`
    : "https://github.com/firemanxbr/omarchy-pool/releases/latest/download/install.sh";
}

/** The one command the page prints: the token in the environment of `sh`, never in an argument; the pool named only when it is not the agent's default. */
export function installCommand(poolVersion: string, token: string, pool: string | null): string {
  return `curl --proto '=https' --tlsv1.2 -fsSL ${installUrl(poolVersion)} | OMARCHY_ENROLL=${token} sh${pool ? ` -s -- --pool ${pool}` : ""}`;
}

// ---------- who stops a host, and what a claim checks (#322, design v2 §6.2, §6.4) ----------

/**
 * Whether a host's owner counts as a maintainer now (D39): some login
 * factory/MAINTAINERS.toml lists resolves to the owner's GitHub user id
 * through the contributors' sign-in records. The file lists logins and hosts
 * are owned by ids, so a login renamed in the file is not a removal. `col`
 * is the SQL that names the owner's id (`hosts.owner_github_id`, a binding).
 * The list is walked (a few rows), each login by the contributors' primary
 * key: CROSS JOIN is SQLite's word for that order — contributors.github_id
 * has no index of its own.
 */
export const OWNER_LISTED_SQL = (col: string) => `EXISTS (SELECT 1 FROM factory_maintainers m CROSS JOIN contributors c ON c.login = m.login WHERE c.github_id = ${col})`;

/** A host as every claim of its registration reads it: one row by the primary key, the owner joined with the maintainer list. */
export const HOST_CLAIM_SQL = `SELECT name, status, status_by, status_at, status_reason, owner_login, owner_removed_at, ${OWNER_LISTED_SQL("hosts.owner_github_id")} AS listed FROM hosts WHERE id = ?`;
export interface HostClaimRow { name: string; status: string; status_by: string | null; status_at: string | null; status_reason: string | null; owner_login: string; owner_removed_at: string | null; listed: number }

/**
 * The lease's own check of a host registration (#322): the claim's UPDATE takes a task only while its host is active and its owner
 * listed and not stopped by the list, in the same statement — D1 serialises writes, so a claim that passed the early read
 * (HOST_CLAIM_SQL, which only gives a refusal its words) and commits after a suspension, a retirement or a removal leases nothing.
 * One binding: the host's id.
 */
export const HOST_MAY_LEASE_SQL = `EXISTS (SELECT 1 FROM hosts WHERE id = ? AND status = 'active' AND owner_removed_at IS NULL AND ${OWNER_LISTED_SQL("hosts.owner_github_id")})`;

/** The words of a claim refused because of the list (D39), the same at the claim, on the host's page and in the journal. */
export const OWNER_NOT_MAINTAINER = "the host's owner is no longer a maintainer";

/**
 * Why a host's registration may not claim now, or null (design v2 §6.2,
 * §6.4): suspended or retired; its owner no longer resolved from the list —
 * at the claim itself, between two syncs too —; or stopped by a sync that
 * found them gone, until their one Resume. Running leases are not this
 * function's: a removal fences nothing, a suspension fenced them already.
 */
export function hostClaimRefusal(h: HostClaimRow): { code: string; error: string } | null {
  const why = h.status_reason ? `: ${h.status_reason}` : "";
  if (h.status === "suspended") return { code: "host_suspended", error: `${h.name} is suspended (by ${h.status_by ?? "?"}${why}): it claims nothing until ${h.owner_login} resumes it` };
  if (h.status === "retired") return { code: "host_retired", error: `${h.name} is retired (by ${h.status_by ?? "?"}${why}): a new install enrolls a new host` };
  if (h.status !== "active") return { code: "host_status", error: `${h.name} is ${h.status}: it claims nothing` };
  if (!h.listed) return { code: "owner_not_maintainer", error: `${OWNER_NOT_MAINTAINER} (factory/MAINTAINERS.toml): ${h.name} claims nothing; its running tasks finish and upload` };
  if (h.owner_removed_at) return { code: "owner_not_maintainer", error: `${OWNER_NOT_MAINTAINER} since ${h.owner_removed_at.slice(0, 16).replace("T", " ")} UTC (factory/MAINTAINERS.toml): ${h.name} claims again once ${h.owner_login} resumes their hosts on their page` };
  return null;
}

/** A reason a person gives for stopping a host: one printable line, 4 to 300 characters, as the journal keeps it. */
export const HOST_REASON = { min: 4, max: 300 };
export function hostReason(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (s.length < HOST_REASON.min || s.length > HOST_REASON.max || /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u.test(s)) return null;
  return s;
}

// ---------- host orders (#344, design v2 §11.1 M4, M5, §17.1, §21.1 step 6) ----------

/**
 * The host orders P3 gives, sent in the signed host state: a closed set,
 * each with an id and a not_after; the agent refuses any other kind, an order
 * past its not_after and an id it took already. retire-legacy stops and
 * removes the legacy compose project the host recorded (install --legacy)
 * and writes the .omarchy-agent marker into its directory; reconcile-now is a
 * round now, which never skips the owner's soak (P4). P4 (#325) adds the
 * settings and the other kinds.
 */
export const HOST_ORDER_KINDS = ["retire-legacy", "reconcile-now"] as const;
export type HostOrderKind = (typeof HOST_ORDER_KINDS)[number];
export const isHostOrderKind = (k: unknown): k is HostOrderKind => typeof k === "string" && (HOST_ORDER_KINDS as readonly string[]).includes(k);
/** How long an order waits for its agent's poll (60-120 s, hourly while the pool answers 401): past it, it expires. */
export const HOST_ORDER_TTL_MIN = 60;
/** The first agent that reads the host state's target and orders (and never follow.latest): an older one would let an order expire unheard. */
export const HOST_ORDERS_AGENT = "0.3.0";
/** An order's id: `ho_` and 32 hex digits. */
export const HOST_ORDER_ID = /^ho_[0-9a-f]{32}$/;
/** An agent's answer's words are kept to this many characters. */
export const ORDER_DETAIL_MAX = 500;

const semver = (v: string | null | undefined): number[] | null => {
  const m = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/.exec(v ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** Whether an agent of version `v` takes host orders (at or above HOST_ORDERS_AGENT). */
export function agentTakesOrders(v: string | null | undefined): boolean {
  const have = semver(v), want = semver(HOST_ORDERS_AGENT)!;
  if (!have) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i];
  return true;
}

/** The legacy set as the host's last report says it (design v2 §17.2 `legacy`), each field checked; null when it reports none. */
export interface LegacySet {
  project: string;
  /** running | stopped | gone | retiring | retired | unknown */
  state: string;
  since: string | null;
  containers: number | null;
  running: number | null;
  dir: string | null;
  /** Why a retire-legacy would be refused now (the agent's words), or null. */
  blocked: string | null;
  /** The order that is retiring it, or retired it. */
  order: string | null;
}
const LEGACY_STATES = ["running", "stopped", "gone", "retiring", "retired", "unknown"];
export function legacyOf(report: string | null): LegacySet | null {
  if (!report) return null;
  let r: { legacy?: unknown };
  try {
    r = JSON.parse(report);
  } catch {
    return null;
  }
  const l = r?.legacy as Record<string, unknown> | null | undefined;
  if (!l || typeof l !== "object" || typeof l.project !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(l.project)) return null;
  const text = (v: unknown, max: number) => (typeof v === "string" && v.length <= max && !/[\x00-\x1f\x7f]/.test(v) ? v : null);
  const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 10000 ? (v as number) : null);
  return {
    project: l.project,
    state: typeof l.state === "string" && LEGACY_STATES.includes(l.state) ? l.state : "unknown",
    since: text(l.since, 40),
    containers: count(l.containers),
    running: count(l.running),
    dir: text(l.dir, 4096),
    blocked: text(l.blocked, ORDER_DETAIL_MAX),
    order: typeof l.order === "string" && HOST_ORDER_ID.test(l.order) ? l.order : null,
  };
}

/** An agent's answer to a host order, as its report carries them (`orders`). */
export interface OrderAnswer { id: string; outcome: "done" | "refused" | "failed"; detail: string }
/** The answers in a report, each checked; at most 16, the rest and anything malformed left out. */
export function orderAnswers(v: unknown): OrderAnswer[] {
  if (!Array.isArray(v)) return [];
  const out: OrderAnswer[] = [];
  for (const a of v.slice(0, 16)) {
    const x = a as Record<string, unknown>;
    if (!x || typeof x !== "object" || typeof x.id !== "string" || !HOST_ORDER_ID.test(x.id)) continue;
    if (x.outcome !== "done" && x.outcome !== "refused" && x.outcome !== "failed") continue;
    const detail = typeof x.detail === "string" ? x.detail.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, ORDER_DETAIL_MAX) : "";
    out.push({ id: x.id, outcome: x.outcome, detail });
  }
  return out;
}
