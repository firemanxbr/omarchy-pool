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
 *   not_supported  its build failed after the tries it had — the others go on without it (an architecture an
 *                  approval stands on stays where it is served: a failed build of its next version is that version's)
 *   reviewing      the project builds it again on a review worker
 *   reviewed       the project's build is staged: the review decides
 *   approved       the review approved it; its publish job carries it into edge
 *   published      in the pool
 *   not_shipping   set aside by an approval of another architecture only, with its reason on the record (#416):
 *                  its builds in review stopped with that decision; a newer build of it is where it stands again
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

export const TARGET_STATES = ["waiting", "building", "built", "not_supported", "reviewing", "reviewed", "approved", "published", "not_shipping"] as const;
export type TargetState = (typeof TARGET_STATES)[number];
/** Where one architecture of a package stands, and the build that says so. */
export interface Target { status: TargetState; task: number | null }
export type Targets = Record<string, Target>;

/** A build of the package as the rule reads it: its row, and the contributor's build a project's build answers (params.review); the version rides along for the review, which decides one version (routes/review.ts). */
export interface TargetBuild { id: number; arch: string; status: string; trust: string; publish: number; review: number | null; version?: string | null }
/** A decision's row on one target (approvals), as the rule reads it — and the version it decided, which the rule does not read and a decision on the package does (#416: an architecture an approval already serves at a build's version is shipped already). */
export interface TargetDecision { arch: string; task_id: number; rebuild_task: number | null; decision: string; withdrawn_at: string | null; version?: string | null }
/** The architectures the newest standing approval set aside (reviews.not_shipping, #416): each with the build its target stood on when it was decided, null for none. */
export type NotShipping = Record<string, number | null>;

/**
 * Per architecture — the ones requested, and any an approval still stands
 * on — the newest build that says where it stands: not cancelled, not a
 * dry run of the project's (no review, nothing published), not one a
 * closed round left behind (a rejection or a block: `closedThrough`, unless
 * it is still in flight or an approval stands on it), not a build done and
 * spent (published, then its approval taken back), and not a failed build
 * of an architecture an approval stands on: a bump that fails is its next
 * version's failure, and the approved version is still what the rings serve
 * — the architecture stays approved or published, never not supported
 * while pacman installs it. A bump in flight or staged does move it: that
 * is the next version on its way to a review. None: waiting.
 *
 * An architecture the newest standing approval set aside (`notShipping`,
 * #416: another architecture approved alone, the reason on the record) and
 * no approval stands on is not_shipping while no build of it newer than the
 * one its target stood on then says otherwise: what that decision stopped
 * is not where it stands, and "waiting" would read as forgotten.
 */
export function targetsOf(arches: string[], builds: TargetBuild[], decisions: TargetDecision[], closedThrough = 0, notShipping: NotShipping = {}): Targets {
  const approved = (b: TargetBuild, standing: boolean) =>
    decisions.some((a) => a.arch === b.arch && a.decision === "approved" && (a.withdrawn_at === null) === standing && (a.task_id === b.id || a.rebuild_task === b.id));
  const standsOn = (arch: string) => decisions.some((a) => a.arch === arch && a.decision === "approved" && a.withdrawn_at === null);
  const wanted = new Set([...arches, ...decisions.filter((a) => a.decision === "approved" && a.withdrawn_at === null).map((a) => a.arch)].filter(isRepoArch));
  const out: Targets = {};
  for (const arch of REPO_ARCHES.filter((a) => wanted.has(a))) {
    const served = standsOn(arch);
    const newest = builds
      .filter((b) => b.arch === arch && b.status !== "cancelled" && !(b.trust === "project" && b.review === null && b.publish === 0))
      .filter((b) => ["queued", "leased", "staged"].includes(b.status) || approved(b, true) || b.id > closedThrough)
      .filter((b) => !(b.status === "done" && !approved(b, true) && (approved(b, false) || b.trust === "community")))
      .filter((b) => !(served && b.status === "failed"))
      .sort((x, y) => y.id - x.id)[0];
    const aside = Object.prototype.hasOwnProperty.call(notShipping, arch) ? (notShipping[arch] ?? 0) : null;
    if (aside !== null && !served && (!newest || newest.id <= aside)) out[arch] = { status: "not_shipping", task: notShipping[arch] ?? null };
    else out[arch] = newest ? { status: stateOf(newest, approved(newest, true)), task: newest.id } : { status: "waiting", task: null };
  }
  return out;
}

/** reviews.not_shipping as the rule reads it: {arch: task} for the architectures a repository builds, anything else none. */
export function parseNotShipping(v: unknown): NotShipping {
  let o: unknown;
  try { o = typeof v === "string" ? JSON.parse(v) : v; } catch { return {}; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return {};
  const out: NotShipping = {};
  for (const [arch, task] of Object.entries(o as Record<string, unknown>)) if (isRepoArch(arch)) out[arch] = typeof task === "number" ? task : null;
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

/** What the rule reads of a package — the registration's requested architectures and closed round, its builds and its decisions, and what the newest standing approval set aside — the same rows a decision on one of its builds reads (routes/review.ts). */
export interface PackageRows { arches: string[]; closedThrough: number; builds: TargetBuild[]; decisions: TargetDecision[]; notShipping: NotShipping }

/**
 * What the rule reads of a package, bounded: the newest builds of each
 * architecture and every build an approval of it names; null for a name
 * with no registration, unless the caller asks for its builds anyway
 * (`unregistered`): the targets are kept for a registration only, but a
 * decision on a build of a name nobody registered — a build queued before
 * registrations, or written by hand — still has to see the project's build
 * of it in flight, or a second press queues another. Such a name requested
 * no architecture, so its rows say `arches: []`. Every read leads with the
 * name — a package's rows are dozens, the table is every build ever — and
 * says so to the planner: with no statistics to go by (nothing runs
 * ANALYZE), it chose the (kind, status, id) index, every build of every
 * package, over the name's own until `+kind` took that term out of the
 * index's reach.
 */
export async function packageRows(env: Env, name: string, opts: { unregistered?: boolean } = {}): Promise<PackageRows | null> {
  const pkg = await env.DB.prepare("SELECT arches, closed_through FROM factory_packages WHERE name = ?").bind(name).first<{ arches: string; closed_through: number | null }>();
  if (!pkg && !opts.unregistered) return null;
  // Each architecture's newest forty builds walk the (name, arch, id) index backwards; the decisions are the name's newest forty, by the (name, created_at) index.
  const cols = "id, arch, status, trust, publish, version, json_extract(params, '$.review') AS review";
  // Each decision row carries what its review set aside (reviews.not_shipping, #416), by the review's primary key: no read of its own.
  const [perArch, decisions] = await Promise.all([
    Promise.all(REPO_ARCHES.map((arch) => env.DB.prepare(`SELECT ${cols} FROM build_tasks WHERE name = ? AND arch = ? AND +kind = 'build' ORDER BY id DESC LIMIT 40`).bind(name, arch).all<TargetBuild>())),
    env.DB.prepare(DECISIONS_OF_SQL).bind(name).all<TargetDecision & { not_shipping: string | null }>(),
  ]);
  const builds = perArch.flatMap((r) => r.results);
  // An approval that stands on a build older than the newest forty still says where its architecture stands: those builds by their ids.
  const have = new Set(builds.map((b) => b.id));
  const named = [...new Set(decisions.results.flatMap((a) => [a.task_id, a.rebuild_task]).filter((id): id is number => typeof id === "number" && !have.has(id)))];
  if (named.length) {
    builds.push(...(await env.DB.prepare(`SELECT ${cols} FROM build_tasks WHERE id IN (SELECT value FROM json_each(?)) AND +kind = 'build'`).bind(JSON.stringify(named)).all<TargetBuild>()).results);
  }
  let arches: string[] = [];
  try { arches = pkg ? (JSON.parse(pkg.arches) as string[]) : []; } catch { arches = []; }
  // What the newest standing approval set aside: the rows come newest first, and every row of a review carries the review's own word.
  const newest = decisions.results.find((a) => a.decision === "approved" && a.withdrawn_at === null);
  return { arches, closedThrough: pkg?.closed_through ?? 0, builds, decisions: decisions.results.map(({ not_shipping: _, ...a }) => a), notShipping: parseNotShipping(newest?.not_shipping) };
}

/** The name's newest forty decisions by the (name, created_at) index, each with the version it decided and its review's not_shipping by the review's primary key. */
export const DECISIONS_OF_SQL = "SELECT a.arch, a.task_id, a.rebuild_task, a.decision, a.withdrawn_at, a.version, v.not_shipping FROM approvals a LEFT JOIN reviews v ON v.id = a.review_id WHERE a.name = ? ORDER BY a.created_at DESC LIMIT 40";

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
      const rows = await packageRows(env, name);
      if (!rows) continue;
      const targets = targetsOf(rows.arches, rows.builds, rows.decisions, rows.closedThrough, rows.notShipping);
      await env.DB.prepare("UPDATE factory_packages SET targets = ? WHERE name = ?").bind(JSON.stringify(targets), name).run();
      out[name] = targets;
    } catch (e) {
      console.error(`targets of ${name} not settled: ${String(e)}`);
    }
  }
  return out;
}
