import type { Env } from "./index";

/**
 * No stored or automated token with `actions`, `contents: write` or
 * `workflows` on this repository exists outside GitHub Actions (#308):
 * hosts trust what release.yml and rollback.yml sign on main, and a token
 * that can dispatch rollback.yml could send every host back. The pool holds
 * two GitHub tokens, both meant to be unable to start a workflow:
 * GITHUB_TOKEN (reads) and GITHUB_REPORT_TOKEN (the cost comment, Issues
 * only).
 *
 * Once a day the cron probes each one it has: a dispatch of rollback.yml to
 * a ref that cannot exist (`..` is never a valid ref name). GitHub answers
 * 403 to a token without `actions: write`, and 422 (no such ref) to one
 * with it; no run starts either way. A 422, or a 2xx, is an `error` line of
 * kind `token` in the journal, and the Status hero (the latest line per
 * token) says so until a later probe of that token answers 403, or the
 * token is removed (an ok line says so). Any other answer (401, a 5xx) is a
 * `warn` line, or an `error` one while the last line was an error: an
 * answer that cannot tell clears nothing. No answer at all writes nothing,
 * and the next tick tries again. The probe detects `actions: write` only;
 * `contents` and `workflows` are the maintainers' manual token review.
 */

export const PROBE_URL = "https://api.github.com/repos/firemanxbr/omarchy-pool/actions/workflows/rollback.yml/dispatches";
export const PROBE_REF = "refs/heads/omarchy-token-probe..no-such-ref";
export const PROBED_TOKENS = ["GITHUB_TOKEN", "GITHUB_REPORT_TOKEN"] as const;

export type Verdict = { status: "ok" | "warn" | "error"; summary: string };

/** What GitHub's answer to the probe says of `name`, pure. */
export function verdictOf(name: string, http: number): Verdict {
  if (http === 403) return { status: "ok", summary: `${name} cannot start a workflow: GitHub answered 403 to the daily probe` };
  if (http === 422 || (http >= 200 && http < 300))
    return {
      status: "error",
      summary: `${name} can start workflows on this repository: GitHub answered ${http} to the daily probe, a dispatch of rollback.yml to a ref that does not exist. No token outside GitHub Actions may hold actions: write; replace it with a read-only one (runbook, The GitHub settings the signature relies on)`,
    };
  if (http === 401) return { status: "warn", summary: `GitHub refused ${name} (401) at the daily probe: expired or revoked` };
  return { status: "warn", summary: `the daily probe of ${name} could not tell: GitHub answered ${http}` };
}

/** The daily probe of every token the pool holds; one journal line per token and UTC day. */
export async function probeTokens(env: Env, now = new Date(), fetcher: typeof fetch = fetch): Promise<string[]> {
  const log: string[] = [];
  const since = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  for (const name of PROBED_TOKENS) {
    const token = env[name];
    const done = await env.DB.prepare("SELECT 1 AS x FROM events WHERE kind = 'token' AND source = ? AND created_at >= ? LIMIT 1").bind(name, since).first();
    if (done) continue;
    // The line Status shows for this token now (stats' latest_events).
    const last = await env.DB.prepare("SELECT e.status, e.payload FROM latest_events l JOIN events e ON e.id = l.id WHERE l.kind = 'token' AND l.src = ? AND l.rg = ''")
      .bind(name)
      .first<{ status: string; payload: string | null }>();
    let v: Verdict;
    let payload: Record<string, unknown>;
    if (!token) {
      // Removed: nothing left to probe; an error it left behind is cleared, once.
      if (last?.status !== "error") continue;
      v = { status: "ok", summary: `${name} is no longer set: nothing to probe, and nothing it could start` };
      payload = { http: null, probe: "none: the token is not set" };
    } else {
      const res = await fetcher(PROBE_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "omarchy-pool-token-probe" },
        body: JSON.stringify({ ref: PROBE_REF, inputs: { to: "v0.0.0" } }),
      });
      v = verdictOf(name, res.status);
      payload = { http: res.status, probe: `rollback.yml dispatch to ${PROBE_REF}` };
      // An answer that cannot tell clears nothing: an earlier error stands until a 403, with the answer that raised it (Status shows it).
      if (v.status === "warn" && last?.status === "error") {
        const before = JSON.parse(last.payload || "{}") as { http?: number; error_http?: number };
        v = { status: "error", summary: `${v.summary}; the last answer said ${name} can start workflows, and that stands until GitHub answers 403` };
        payload.error_http = before.error_http ?? before.http ?? null;
      }
    }
    await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload, created_at) VALUES ('token', NULL, ?, ?, ?, ?, ?)")
      .bind(name, v.status, v.summary, JSON.stringify(payload), now.toISOString())
      .run();
    log.push(`token ${name}: ${v.summary}`);
  }
  return log;
}
