/**
 * A package's targets: one per architecture it was requested for (#242).
 * The package is its name — `marcelo` is one package, and x86_64 and
 * aarch64 are two artifacts of it — so a page says "marcelo, on x86_64",
 * never "the x86_64 package", and asks the package where each of its
 * architectures stands. The builds run per architecture and say it:
 *
 *   waiting        requested, nothing of it in flight (a round closed, a build taken out of the queue)
 *   building       a contributor's build is queued or running
 *   built          built and staged, through the gate: ready for the review
 *   not_supported  its build failed after the tries it had — the others go on without it
 *   reviewing      the project builds it again on a review worker
 *   reviewed       the project's build is staged: the review decides
 *   approved       the review approved it; its publish job carries it into edge
 *   published      in the pool
 *
 * One rule (targetsOf) from the builds and the approvals the pool keeps
 * anyway; stored on the registration (factory_packages.targets) at every
 * transition that moves a build or a decision (settleTargets), so the lists
 * read one column instead of every package's builds. Migration 0036 derived
 * the first values by the same rule in SQL; test/package-identity.test.ts
 * holds the two together.
 */
import type { Env } from "./index";
import { REPO_ARCHES, isRepoArch } from "./meta";

export const TARGET_STATES = ["waiting", "building", "built", "not_supported", "reviewing", "reviewed", "approved", "published"] as const;
export type TargetState = (typeof TARGET_STATES)[number];
/** Where one architecture of a package stands, and the build that says so. */
export interface Target { status: TargetState; task: number | null }
export type Targets = Record<string, Target>;

/** A build of the package as the rule reads it: its row, and the contributor's build a project's build answers (params.review). */
export interface TargetBuild { id: number; arch: string; status: string; trust: string; publish: number; review: number | null }
/** A decision's row on one target (approvals), as the rule reads it. */
export interface TargetDecision { arch: string; task_id: number; rebuild_task: number | null; decision: string; withdrawn_at: string | null }

/**
 * Per architecture — the ones requested, and any an approval still stands
 * on — the newest build that says where it stands: not cancelled, not a
 * dry run of the project's (no review, nothing published), not one a
 * closed round left behind (a rejection or a block: `closedThrough`, unless
 * it is still in flight or an approval stands on it), not a build done and
 * spent (published, then its approval taken back). None: waiting.
 */
export function targetsOf(arches: string[], builds: TargetBuild[], decisions: TargetDecision[], closedThrough = 0): Targets {
  const approved = (b: TargetBuild, standing: boolean) =>
    decisions.some((a) => a.arch === b.arch && a.decision === "approved" && (a.withdrawn_at === null) === standing && (a.task_id === b.id || a.rebuild_task === b.id));
  const wanted = new Set([...arches, ...decisions.filter((a) => a.decision === "approved" && a.withdrawn_at === null).map((a) => a.arch)].filter(isRepoArch));
  const out: Targets = {};
  for (const arch of REPO_ARCHES.filter((a) => wanted.has(a))) {
    const newest = builds
      .filter((b) => b.arch === arch && b.status !== "cancelled" && !(b.trust === "project" && b.review === null && b.publish === 0))
      .filter((b) => ["queued", "leased", "staged"].includes(b.status) || approved(b, true) || b.id > closedThrough)
      .filter((b) => !(b.status === "done" && !approved(b, true) && (approved(b, false) || b.trust === "community")))
      .sort((x, y) => y.id - x.id)[0];
    out[arch] = newest ? { status: stateOf(newest, approved(newest, true)), task: newest.id } : { status: "waiting", task: null };
  }
  return out;
}

function stateOf(b: TargetBuild, standing: boolean): TargetState {
  if (b.status === "queued" || b.status === "leased") return b.trust === "project" ? "reviewing" : "building";
  if (b.status === "staged") return standing ? "approved" : b.trust === "project" ? "reviewed" : "built";
  if (b.status === "done") return "published";
  return "not_supported";
}

/** The stored column as a page reads it: the targets, or none for a registration older than them that no transition has settled yet. */
export function parseTargets(v: unknown): Targets {
  if (!v) return {};
  try { return (typeof v === "string" ? JSON.parse(v) : v) as Targets; } catch { return {}; }
}

/** What the rule reads of a package, bounded: the newest builds of each architecture and every build an approval of it names. */
async function ruleRows(env: Env, name: string): Promise<{ arches: string[]; closedThrough: number; builds: TargetBuild[]; decisions: TargetDecision[] } | null> {
  const pkg = await env.DB.prepare("SELECT arches, closed_through FROM factory_packages WHERE name = ?").bind(name).first<{ arches: string; closed_through: number | null }>();
  if (!pkg) return null;
  // Each architecture's newest forty builds walk the (name, arch, id) index backwards; the decisions are the name's newest forty.
  const cols = "id, arch, status, trust, publish, json_extract(params, '$.review') AS review";
  const [perArch, decisions] = await Promise.all([
    Promise.all(REPO_ARCHES.map((arch) => env.DB.prepare(`SELECT ${cols} FROM build_tasks WHERE name = ? AND arch = ? AND kind = 'build' ORDER BY id DESC LIMIT 40`).bind(name, arch).all<TargetBuild>())),
    env.DB.prepare("SELECT arch, task_id, rebuild_task, decision, withdrawn_at FROM approvals WHERE name = ? ORDER BY id DESC LIMIT 40").bind(name).all<TargetDecision>(),
  ]);
  const builds = perArch.flatMap((r) => r.results);
  // An approval that stands on a build older than the newest forty still says where its architecture stands.
  const have = new Set(builds.map((b) => b.id));
  const named = [...new Set(decisions.results.flatMap((a) => [a.task_id, a.rebuild_task]).filter((id): id is number => typeof id === "number" && !have.has(id)))];
  if (named.length) {
    builds.push(...(await env.DB.prepare(`SELECT ${cols} FROM build_tasks WHERE id IN (SELECT value FROM json_each(?)) AND kind = 'build'`).bind(JSON.stringify(named)).all<TargetBuild>()).results);
  }
  let arches: string[] = [];
  try { arches = JSON.parse(pkg.arches) as string[]; } catch { arches = []; }
  return { arches, closedThrough: pkg.closed_through ?? 0, builds, decisions: decisions.results };
}

/**
 * The targets of each package named, from what its builds and decisions
 * say now, written onto its registration. Called by every transition that
 * moves a build or a decision (a claim, a completion, a failure, an expired
 * lease, a request, a build asked, a review, a block); a package with no
 * registration has none. The column is a view of the builds, never what a
 * decision is taken on: a transition does not fail for it — a claim that
 * leased a build still hands it out — and the package's next transition
 * settles it again. Returns the targets per name it settled.
 */
export async function settleTargets(env: Env, names: string | string[]): Promise<Record<string, Targets>> {
  const out: Record<string, Targets> = {};
  for (const name of [...new Set(Array.isArray(names) ? names : [names])]) {
    try {
      const rows = await ruleRows(env, name);
      if (!rows) continue;
      const targets = targetsOf(rows.arches, rows.builds, rows.decisions, rows.closedThrough);
      await env.DB.prepare("UPDATE factory_packages SET targets = ? WHERE name = ?").bind(JSON.stringify(targets), name).run();
      out[name] = targets;
    } catch (e) {
      console.error(`targets of ${name} not settled: ${String(e)}`);
    }
  }
  return out;
}
