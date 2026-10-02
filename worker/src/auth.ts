import { json, type Env } from "./index";
import { jobOf, type JobClaims } from "./jobtoken";
import { contributorOf, isMaintainer, type Contributor } from "./routes/contributors";

/**
 * Who may write. Two credentials, nothing else: a per-job token (issued at
 * claim time with exactly the scopes that task needs) and a maintainer —
 * the operator, signed in with GitHub or holding their contributor token.
 * There is no shared secret: the publish token is gone.
 */

/** A job token carrying the scope: null when allowed, else the 401/403 to send. */
export async function authorize(request: Request, env: Env, scope: string): Promise<Response | null> {
  const job = await jobOf(request, env);
  if (!job) return json({ error: "unauthorized: a job token is required" }, 401);
  if (!job.s.includes(scope) && !job.s.some((s) => s.endsWith(":*") && scope.startsWith(s.slice(0, -1)))) {
    return json({ error: `job ${job.t} (${job.k}) may not ${scope}`, scopes: job.s }, 403);
  }
  return leaseGone(env, job);
}

/**
 * A host lease's token (`g`, #334, D46) writes only while its lease is
 * still that lease: leased to its host, of that generation, not fenced by a
 * Stop. The pool-wide scopes a project build or a trial carries (pool:write,
 * release:<ring>, artifacts:*:<ring>) are refused to the old container of a
 * lease stopped and claimed again, as its task routes are (owned()). A
 * legacy token (no `g`) is unchanged.
 */
async function leaseGone(env: Env, job: JobClaims): Promise<Response | null> {
  if (!job.g) return null;
  const held = await env.DB.prepare("SELECT 1 AS ok FROM build_tasks WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_gen = ? AND stop_order IS NULL")
    .bind(job.t, job.w, job.g)
    .first<{ ok: number }>();
  return held ? null : json({ error: `task ${job.t}'s lease this token was issued for is over: it writes nothing`, stop: true }, 409);
}

/** The signed-in maintainer, or the 401/403 to send. */
export async function maintainerOf(request: Request, env: Env): Promise<Contributor | Response> {
  const c = await contributorOf(request, env);
  if (!c) return json({ error: "unauthorized: sign in, or use a contributor token" }, 401);
  if (!isMaintainer(c)) return json({ error: `${c.login} is not a maintainer (factory/MAINTAINERS.toml)` }, 403);
  return c;
}

/** A job with the scope, or a maintainer: what an operator may also do by hand. */
export async function authorizeJobOrMaintainer(request: Request, env: Env, scope: string): Promise<Response | null> {
  const job = await jobOf(request, env);
  if (job) return authorize(request, env, scope);
  const m = await maintainerOf(request, env);
  return m instanceof Response ? m : null;
}

/** POST /releases: the scope depends on the ring in the body. */
export async function authorizeRelease(request: Request, env: Env): Promise<Response | null> {
  let ring = "";
  try {
    ring = String(((await request.clone().json()) as { ring?: string }).ring ?? "");
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  return authorize(request, env, `release:${ring}`);
}

/** PUT /releases/:id/artifacts: the scope names the ring the release belongs to. */
export async function authorizeArtifacts(request: Request, env: Env, releaseId: number): Promise<Response | null> {
  const row = await env.DB.prepare("SELECT ring FROM releases WHERE id = ?").bind(releaseId).first<{ ring: string }>();
  if (!row) return json({ error: "no such release" }, 404);
  const job = await jobOf(request, env);
  if (job && job.s.includes(`artifacts:${releaseId}`)) return leaseGone(env, job);
  return authorize(request, env, `artifacts:*:${row.ring}`);
}
