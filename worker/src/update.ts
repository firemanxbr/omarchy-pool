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
 * is deployed once the images exist (release.yml), the updater polls every
 * fifteen minutes, and what changed is replaced together — each service
 * drains under its own grace, none idles on the old image meanwhile.
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
}

/** Where a worker's image stands against the pool, at `at` (now). */
export function updateState(workerVersion: string | null | undefined, pool: RunningVersion, at = Date.now()): UpdateState {
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
  const required = outdated && Number.isFinite(deployed) && (behind === null || behind >= 2 || at - deployed > UPDATE_GRACE_MINUTES * 60000);
  return { latest: pool.version, yours, outdated, behind, required };
}

/** The refusal a claim gets, and the line the journal keeps. */
export function updateMessage(u: UpdateState): string {
  return `this worker runs ${u.yours}; the pool is at ${u.latest}${u.behind ? ` (${u.behind} release${u.behind === 1 ? "" : "s"} behind)` : ""} — every worker follows the latest image: update it (/docs/workers#update) and it works again`;
}
