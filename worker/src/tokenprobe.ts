import type { Env } from "./index";

/**
 * No token with `actions`, `contents: write` or `workflows` on this
 * repository exists outside GitHub Actions (#308): hosts trust what
 * release.yml and rollback.yml sign on main, and a token that can dispatch
 * rollback.yml could send every host back. The pool holds two GitHub
 * tokens, both meant to be unable to start a workflow: GITHUB_TOKEN (reads)
 * and GITHUB_REPORT_TOKEN (the cost comment, Issues only).
 *
 * Once a day the cron probes each one it has: a dispatch of rollback.yml to
 * a ref that cannot exist (`..` is never a valid ref name). GitHub answers
 * 403 to a token without `actions: write`, and 422 (no such ref) to one
 * with it; no run starts either way. A 422, or a 2xx, is an `error` line of
 * kind `token` in the journal, and the Status hero says so until a later
 * probe of that token answers 403. Any other answer (401, a 5xx) is a
 * `warn` line; no answer at all writes nothing, and the next tick tries
 * again.
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
    if (!token) continue;
    const done = await env.DB.prepare("SELECT 1 AS x FROM events WHERE kind = 'token' AND source = ? AND created_at >= ? LIMIT 1").bind(name, since).first();
    if (done) continue;
    const res = await fetcher(PROBE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "omarchy-pool-token-probe" },
      body: JSON.stringify({ ref: PROBE_REF, inputs: { to: "v0.0.0" } }),
    });
    const v = verdictOf(name, res.status);
    await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload, created_at) VALUES ('token', NULL, ?, ?, ?, ?, ?)")
      .bind(name, v.status, v.summary, JSON.stringify({ http: res.status, probe: `rollback.yml dispatch to ${PROBE_REF}` }), now.toISOString())
      .run();
    log.push(`token ${name}: ${v.summary}`);
  }
  return log;
}
