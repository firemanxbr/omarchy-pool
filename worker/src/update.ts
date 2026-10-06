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
import { RELEASE_POLICY } from "./hosts";
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

/**
 * The releases the signed manifest retires (design v2 §5.2; #342): its
 * `min_release` and `revoked`, the pool's own release's (hosts.ts
 * RELEASE_POLICY), unless a caller weighs another.
 */
export interface ReleasePolicy { min_release: string; revoked: readonly string[] }

/** Whether `v` is a release the policy revokes: no claim on it is handed anything, and nothing its leases send is taken. */
export function isRevoked(v: string | null | undefined, policy: ReleasePolicy = RELEASE_POLICY): boolean {
  const t = parseTag(v);
  return t !== null && policy.revoked.some((r) => {
    const x = parseTag(r);
    return x !== null && compareTags(x, t) === 0;
  });
}

/**
 * A host that reverted the pool's release (#342, design v2 §8.6, §16.2;
 * D55). One bundle runs on every host, so a release that fails its guard on
 * one architecture only (a 16K-page problem, say) sends that architecture's
 * hosts back to `last-good`, and the gate would then hand them nothing —
 * all of its native work stopped by one bad release. So a host whose
 * reports say its guard reverted the pool's release, and whose registration
 * claims on the release its agent applied (its last-good), claims for
 * LAST_GOOD_HOURS after the pool first heard of the revert: never on a
 * release below the signed `min_release`, never on a revoked one, and with
 * a warning on Status while it does. Then it is refused with 426 like any
 * other: the maintainers have had six hours to fix the release or roll it
 * back.
 */
export const LAST_GOOD_HOURS = 6;

/** What a host's reports say of a revert (hosts.ts revertedOf): the release it reverted, since when the pool knows it, the release it applied. */
export interface Reverted { from: string; at: string | null; applied: string | null }

/** Until when a registration that claims on `yours` may claim on its host's last-good, at `at`, behind the pool's release `latest`; null when it may not. */
export function lastGoodUntil(r: Reverted | null | undefined, yours: string | null, latest: string, at: number, policy: ReleasePolicy = RELEASE_POLICY): string | null {
  const from = parseTag(r?.from), p = parseTag(latest), w = parseTag(yours), applied = parseTag(r?.applied), min = parseTag(policy.min_release);
  if (!r || !from || !p || !w || !applied || compareTags(from, p) !== 0) return null;
  // On its last-good: the release its agent applied, which is behind the pool's.
  if (compareTags(w, applied) !== 0 || compareTags(w, p) >= 0) return null;
  if ((min && compareTags(w, min) < 0) || isRevoked(yours, policy)) return null;
  const since = r.at ? Date.parse(r.at) : NaN;
  if (!Number.isFinite(since)) return null;
  const end = since + LAST_GOOD_HOURS * 3600e3;
  return at < end ? new Date(end).toISOString() : null;
}

/**
 * The release a host reverted, after one of its reports (#342), and since
 * when the pool knows it. Its agent says `round.outcome: rolled-back` with
 * `round.from` once, in the report after the revert; its next round says
 * `held` while the release waits in quarantine, which every report lists
 * (`quarantine`) until a commit of that release or an Update order clears
 * it. So: the release the round says it rolled back from; else the one
 * named before, while the report still holds it in quarantine or rolls out
 * toward it again (an Update lifted the quarantine) and has not applied it
 * or a later one; else none. The time stays the first report's while the
 * release stays the same: a retry that reverts again, or an Update that
 * lifts the quarantine, does not start the six hours again.
 */
export function revertAfter(prev: { from: string | null; at: string | null }, report: Record<string, unknown>, at: string): { from: string | null; at: string | null } {
  const field = (o: unknown, k: string): unknown => (o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>)[k] : undefined);
  const tag = (v: unknown) => (typeof v === "string" && /^v\d+\.\d+\.\d+$/.test(v) ? v : null);
  let from = field(report.round, "outcome") === "rolled-back" ? tag(field(report.round, "from")) : null;
  const was = parseTag(prev.from);
  if (!from && prev.from && was) {
    const held = Array.isArray(report.quarantine) && report.quarantine.slice(0, 16).some((q) => field(q, "release") === prev.from);
    const again = field(report.rollout, "target") === prev.from;
    const applied = parseTag(tag(field(report.release, "applied")));
    if ((held || again) && !(applied && compareTags(applied, was) >= 0)) from = prev.from;
  }
  return { from, at: from === null ? null : from === prev.from && prev.at ? prev.at : at };
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
  /** Outdated past the grace, or on a revoked release: the pool hands it nothing. */
  required: boolean;
  /** It runs a release the pool's release revokes (#342): handed nothing, whatever the grace. */
  revoked?: true;
  /** Past the grace, but its host reverted the pool's release (#342): it claims on its last-good until then. */
  last_good_until?: string;
}

/**
 * Where a worker's image stands against the pool, at `at` (now); `reverted`,
 * what its host's reports say of a release it reverted (#342), for a host's
 * registration; `policy`, the releases the signed manifest retires.
 */
export function updateState(workerVersion: string | null | undefined, pool: Pick<RunningVersion, "version" | "deployed_at">, at = Date.now(), reverted: Reverted | null = null, policy: ReleasePolicy = RELEASE_POLICY): UpdateState {
  const yours = workerVersion && workerVersion !== "container" ? workerVersion : null;
  const w = parseTag(yours);
  const p = parseTag(pool.version);
  // A revoked release (#342) is handed nothing, whatever the pool runs and whatever the grace: what it would build is refused.
  const revoked = isRevoked(yours, policy);
  const marks = revoked ? { revoked: true as const } : {};
  if (!w || !p) return { latest: pool.version, yours, outdated: false, behind: null, required: revoked, ...marks };
  const outdated = compareTags(w, p) < 0;
  const behind = outdated ? (w[0] === p[0] && w[1] === p[1] ? p[2] - w[2] : null) : 0;
  // The grace is the latest release's rollout: a worker one release behind
  // may still be draining through it. Two behind, or behind across a minor,
  // it missed a rollout already — releases come several times a day, and a
  // grace that restarted at each would never end for it.
  const deployed = pool.deployed_at ? Date.parse(pool.deployed_at) : NaN;
  const past = outdated && Number.isFinite(deployed) && (behind === null || behind >= 2 || at - deployed > UPDATE_GRACE_MINUTES * 60000);
  // A host that reverted the pool's release claims on its last-good, six hours at most (#342).
  const lastGood = past ? lastGoodUntil(reverted, yours, pool.version, at, policy) : null;
  return { latest: pool.version, yours, outdated, behind, required: revoked || (past && lastGood === null), ...marks, ...(lastGood ? { last_good_until: lastGood } : {}) };
}

/** The refusal a claim gets, and the line the journal keeps. */
export function updateMessage(u: UpdateState): string {
  if (u.revoked) return `this worker runs ${u.yours}, a release the pool's release (${u.latest}) revokes — it is handed nothing, and nothing its tasks send on that release is taken: update it (/docs/workers#update) and it works again; on a host the agent manages, nothing needs to be run`;
  return `this worker runs ${u.yours}; the pool is at ${u.latest}${u.behind ? ` (${u.behind} release${u.behind === 1 ? "" : "s"} behind)` : ""} — every worker follows the latest image: update it (/docs/workers#update) and it works again; on a host the agent manages, nothing needs to be run`;
}

/** The warning a host claiming on its last-good carries (#342, design v2 §18.3): the journal's line, Status's and the host page's words. */
export function lastGoodMessage(u: UpdateState): string | null {
  return u.last_good_until ? `its agent reverted ${u.latest}: claiming on last-good ${u.yours} until ${u.last_good_until}, then refused like any registration behind the pool's release` : null;
}
