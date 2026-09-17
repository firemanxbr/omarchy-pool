/**
 * A package's story in the factory, as chains: a contributor's build with
 * its audit, the project's build of it with its gate and trial, the
 * decision — and the score each chain earns (score.ts). Read by a build's
 * page (the chain its task is in), by the package page (every chain, the
 * class the package has today) and by Review (the class column). One
 * indexed read of the package's tasks, one of its approvals, one of its
 * registration; the rest is assembled here.
 */
import { json, type Env } from "../index";
import { scoreChain, type Score } from "../score";

export interface TaskBrief {
  id: number;
  kind: string;
  status: string;
  trust: string;
  owner: string | null;
  arch: string;
  version: string | null;
  attempts: number;
  lease_owner: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
}

export interface Approval { id: number; task_id: number; decision: string; by: string; note: string | null; rebuild_task: number | null; created_at: string; version: string | null; arch: string; withdrawn_at: string | null; withdrawn_by: string | null; withdrawn_reason: string | null }

export interface Chain {
  contributor: TaskBrief | null;
  project: TaskBrief | null;
  audit: TaskBrief | null;
  trial: TaskBrief | null;
  publish: TaskBrief | null;
  /** The standing decision; a withdrawn approval is none. */
  approval: Approval | null;
  /** An approval taken back: on the record, void. */
  withdrawn: Approval | null;
  score: Score;
}

const TASK_COLS = "id, kind, status, trust, owner, arch, version, attempts, lease_owner, created_at, started_at, finished_at, duration_ms, error, params, result";

function brief(r: Record<string, unknown>): TaskBrief {
  const parse = (s: unknown) => { try { return s ? (JSON.parse(s as string) as Record<string, unknown>) : null; } catch { return null; } };
  return { ...(r as unknown as TaskBrief), params: parse(r.params) ?? {}, result: parse(r.result) };
}

/** The package's tasks (newest first), its approvals and its registration — everything a story is made of. */
export async function storyRows(env: Env, name: string) {
  const [tasks, approvals, pkg] = await Promise.all([
    env.DB.prepare(`SELECT ${TASK_COLS} FROM build_tasks WHERE name = ? AND kind IN ('build', 'audit', 'trial', 'publish') ORDER BY id DESC LIMIT 120`).bind(name).all<Record<string, unknown>>(),
    env.DB.prepare("SELECT id, task_id, decision, by, note, rebuild_task, created_at, version, arch, withdrawn_at, withdrawn_by, withdrawn_reason FROM approvals WHERE name = ? ORDER BY id DESC LIMIT 40").bind(name).all<Approval>(),
    env.DB.prepare("SELECT name, owner, url, status, detail, category, request_id, description, license, source, project, created_at, updated_at, blocked_at, blocked_by, blocked_reason FROM factory_packages WHERE name = ?").bind(name).first<Record<string, unknown>>(),
  ]);
  return { tasks: tasks.results.map(brief), approvals: approvals.results, pkg };
}

/** The chains, newest first: one per contributor's build (a project build with no contributor behind it — the old direct approvals — is a chain of its own). */
export function chains(tasks: TaskBrief[], approvals: Approval[], pkg: Record<string, unknown> | null): Chain[] {
  const builds = tasks.filter((t) => t.kind === "build");
  const contributors = builds.filter((t) => t.trust === "community");
  const projects = builds.filter((t) => t.trust === "project");
  const of = (kind: string, key: string, id: number) => tasks.find((t) => t.kind === kind && t.params[key] === id) ?? null;
  const vetOf = (t: TaskBrief | null) => (t?.result?.vet as { verdict: string; fails: number; warnings: number } | undefined) ?? null;
  const request = pkg ? { license: (pkg.license as string | null) ?? null, source: (pkg.source as string | null) ?? null } : null;
  const category = (pkg?.category as string | null) ?? null;
  const make = (contributor: TaskBrief | null, project: TaskBrief | null): Chain => {
    const audit = contributor ? of("audit", "task", contributor.id) : null;
    const trial = project ? of("trial", "task", project.id) : null;
    const publish = project ? of("publish", "task", project.id) : contributor ? of("publish", "task", contributor.id) : null;
    const ids = [contributor?.id, project?.id].filter((x): x is number => typeof x === "number");
    const mine = approvals.filter((a) => ids.includes(a.task_id) || (a.rebuild_task !== null && ids.includes(a.rebuild_task)));
    const approval = mine.find((a) => !a.withdrawn_at) ?? null;
    const withdrawn = mine.find((a) => a.withdrawn_at) ?? null;
    const auditReport = audit?.result as { verdict?: string; findings?: { severity: string }[] } | null | undefined;
    const score = scoreChain({
      contributor: contributor ? { attempts: contributor.attempts, status: contributor.status } : null,
      vet: vetOf(contributor),
      audit: audit ? { status: audit.status, verdict: auditReport?.verdict ?? null, high: (auditReport?.findings ?? []).filter((f) => f.severity === "high").length, findings: (auditReport?.findings ?? []).length } : null,
      request,
      project: project ? { status: project.status, attempts: project.attempts } : null,
      projectVet: vetOf(project),
      trial: trial ? { status: trial.status, verdict: (trial.result as { verdict?: string } | null)?.verdict ?? null } : null,
      approval: approval ? { decision: approval.decision, note: approval.note } : null,
      category,
    });
    return { contributor, project, audit, trial, publish, approval, withdrawn, score };
  };
  const out: Chain[] = [];
  const used = new Set<number>();
  for (const c of contributors) {
    const p = projects.find((x) => x.params.review === c.id) ?? null;
    if (p) used.add(p.id);
    out.push(make(c, p));
  }
  for (const p of projects) if (!used.has(p.id)) out.push(make(null, p));
  return out;
}

/** The chain a task is in, or null: a build's page asks for its own. */
export function chainOf(all: Chain[], taskId: number): Chain | null {
  return all.find((c) => [c.contributor?.id, c.project?.id, c.audit?.id, c.trial?.id, c.publish?.id].includes(taskId)) ?? null;
}

/**
 * GET /api/v1/factory/packages/:name/story — the factory's view of a
 * package: its registration, every chain with its score, the class the
 * package has today (its latest decided chain, else its latest), the
 * rings it is in. The package page draws its factory section from this;
 * a package that came from a source has no story, and says so.
 */
export async function handlePackageStory(name: string, env: Env): Promise<Response> {
  const { tasks, approvals, pkg } = await storyRows(env, name);
  if (!pkg && !tasks.length) return json({ error: `${name} is not a factory package` }, 404);
  const all = chains(tasks, approvals, pkg);
  const rings = (await env.DB.prepare("SELECT DISTINCT rp.ring, p.repo_arch AS arch FROM packages p JOIN ring_packages rp ON rp.package_id = p.id AND rp.ring IN ('lab', 'edge', 'rc', 'stable') WHERE p.source = 'factory' AND p.name = ?").bind(name).all<{ ring: string; arch: string }>()).results;
  const decided = all.find((c) => c.approval?.decision === "approved") ?? null;
  const current = decided ?? all[0] ?? null;
  return json(
    {
      name,
      package: pkg,
      class: current ? current.score.class : null,
      score: current ? current.score : null,
      rings,
      chains: all,
    },
    200,
    { "cache-control": "public, max-age=30" },
  );
}
