/**
 * Every worker follows the pool's latest image — not as an option. A
 * worker reports the release its image was built from with each claim;
 * the pool compares it with the release it runs itself. Behind by a
 * release still within the rollout's grace, the worker works on; behind
 * for longer, it is handed nothing until it updates, its row on the
 * Workers page says so, and the journal says it once per release. A
 * worker ten releases behind drafted the wrong version and linked the
 * wrong objects for a day (2026-09-17) while looking alive.
 */
import type { RunningVersion } from "./meta";

/**
 * How long after a deploy the previous image may still claim: the Worker
 * is deployed once the images exist (release.yml), every set's updater
 * sees the new release within two minutes (#277; one from before it, or a
 * host's timer, within fifteen), and what changed is replaced together —
 * each service drains under its own grace, none idles on the old image
 * meanwhile.
 */
export const UPDATE_GRACE_MINUTES = 45;

export type Tag = [number, number, number];

/** `v0.0.177` → [0, 0, 177]; anything else (dev, container, unknown) → null. */
export function parseTag(v: string | null | undefined): Tag | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((v || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareTags(a: Tag, b: Tag): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

export interface UpdateState {
  /** The pool's release. */
  latest: string;
  /** What the worker reported, as it said it. */
  yours: string | null;
  /** Older than the pool. */
  outdated: boolean;
  /** Releases behind, when only the patch number differs (every release is one); null when not comparable. */
  behind: number | null;
  /** Outdated past the grace: the pool hands it nothing. */
  required: boolean;
  /** Past the grace, but its host soaks the pool's release (#326): it claims until then. */
  soaking_until?: string;
}

/**
 * An owner's soak (#326, design v2 D16): a host whose owner set
 * `soak_minutes` takes a new release that long after its agent first saw the
 * pool name it, so a bad one can be caught elsewhere first. Its claims would
 * meet the gate meanwhile — two releases behind, or one past the grace, with
 * several releases a day — and idle the host the soak meant to protect. So
 * the pool extends the grace of that host's registration until the soak its
 * agent reports ends (`release.soaking_until`), and the round's
 * SOAK_ROUND_MINUTES after it (the pull, the replace, the guard), whatever
 * the releases behind — but never past SOAK_GRACE_MAX_MINUTES after the
 * pool's deploy, and none for a host that holds the pool's release (or a
 * later one) in quarantine: it reverted it, it is not waiting for it, and
 * its claim on last-good is a rule of its own.
 */
export const SOAK_GRACE_MAX_MINUTES = 120;
export const SOAK_ROUND_MINUTES = 15;

/** What a host's last report says of its soak: when it ends, and the releases it holds in quarantine. */
export interface HostSoak {
  until: string | null;
  quarantined: string[];
}

/** Until when a soaking host's registration may claim behind the pool's release `latest`, deployed at `deployed` (ms), at `at`; null when it may not. */
export function soakGraceUntil(soak: HostSoak | null | undefined, latest: Tag, deployed: number, at: number): string | null {
  if (!soak?.until || !Number.isFinite(deployed)) return null;
  const until = Date.parse(soak.until);
  if (!Number.isFinite(until)) return null;
  if (soak.quarantined.some((q) => { const t = parseTag(q); return t !== null && compareTags(t, latest) >= 0; })) return null;
  const end = Math.min(until + SOAK_ROUND_MINUTES * 60000, deployed + SOAK_GRACE_MAX_MINUTES * 60000);
  return at < end ? new Date(end).toISOString() : null;
}

/** Where a worker's image stands against the pool, at `at` (now); `soak`, its host's soak as its last report says it (#326). */
export function updateState(workerVersion: string | null | undefined, pool: Pick<RunningVersion, "version" | "deployed_at">, at = Date.now(), soak: HostSoak | null = null): UpdateState {
  const yours = workerVersion && workerVersion !== "container" ? workerVersion : null;
  const w = parseTag(yours);
  const p = parseTag(pool.version);
  if (!w || !p) return { latest: pool.version, yours, outdated: false, behind: null, required: false };
  const outdated = compareTags(w, p) < 0;
  const behind = outdated ? (w[0] === p[0] && w[1] === p[1] ? p[2] - w[2] : null) : 0;
  // The grace is the latest release's rollout: a worker one release behind
  // may still be draining through it. Two behind, or behind across a minor,
  // it missed a rollout already — releases come several times a day, and a
  // grace that restarted at each would never end for it.
  const deployed = pool.deployed_at ? Date.parse(pool.deployed_at) : NaN;
  const past = outdated && Number.isFinite(deployed) && (behind === null || behind >= 2 || at - deployed > UPDATE_GRACE_MINUTES * 60000);
  // A soaking host's grace (#326): until its soak ends, at most two hours after the deploy.
  const soaking = past ? soakGraceUntil(soak, p, deployed, at) : null;
  return { latest: pool.version, yours, outdated, behind, required: past && soaking === null, ...(soaking ? { soaking_until: soaking } : {}) };
}

/** The refusal a claim gets, and the line the journal keeps. */
export function updateMessage(u: UpdateState): string {
  return `this worker runs ${u.yours}; the pool is at ${u.latest}${u.behind ? ` (${u.behind} release${u.behind === 1 ? "" : "s"} behind)` : ""} — every worker follows the latest image: update it (/docs/workers#update) and it works again; on a host the agent manages, nothing needs to be run`;
}

/**
 * Why a host's registration claims or is refused with 426, in the host page's
 * words (#326): the gate, the soak's grace and what ended it — a soak past
 * its end and the round's margin, the two hours after the deploy, or a
 * quarantine of the pool's release. Null when it runs the pool's release.
 */
export function gateWords(u: UpdateState, soak: HostSoak | null, deployedAt: string | null): string | null {
  if (!u.outdated) return null;
  const behind = u.behind ? ` (${u.behind} release${u.behind === 1 ? "" : "s"} behind)` : "";
  const runs = `its registration runs ${u.yours}, the pool ${u.latest}${behind}`;
  if (u.soaking_until) return `${runs}: it claims through its owner's soak, until ${u.soaking_until} — the pool's grace follows the soak its agent reports, ${SOAK_ROUND_MINUTES} minutes past its end for the round, at most ${SOAK_GRACE_MAX_MINUTES / 60} hours after the deploy`;
  if (!u.required) return `${runs}: within the rollout's grace (${UPDATE_GRACE_MINUTES} minutes after the deploy, one release behind at most); its agent rolls the release out`;
  const latest = parseTag(u.latest);
  const held = soak && latest ? soak.quarantined.find((q) => { const t = parseTag(q); return t !== null && compareTags(t, latest) >= 0; }) : undefined;
  const deployed = deployedAt ? Date.parse(deployedAt) : NaN;
  const why = held
    ? `it holds ${held} in quarantine — its guard reverted it — so its soak gives no grace: Retry release, or the release after it`
    : soak?.until && Number.isFinite(deployed) && Date.parse(soak.until) + SOAK_ROUND_MINUTES * 60000 > deployed + SOAK_GRACE_MAX_MINUTES * 60000
      ? `its soak runs until ${soak.until}, past the pool's grace for a soak, which ends ${SOAK_GRACE_MAX_MINUTES / 60} hours after the deploy (${new Date(deployed + SOAK_GRACE_MAX_MINUTES * 60000).toISOString()})`
      : soak?.until
        ? `its soak ended at ${soak.until} and its round has not brought the release yet: the pool's grace ran ${SOAK_ROUND_MINUTES} minutes past it`
        : `past the rollout's grace (${UPDATE_GRACE_MINUTES} minutes after the deploy, one release behind at most), and its agent reports no soak`;
  return `refused with 426 — ${runs}: ${why}`;
}
