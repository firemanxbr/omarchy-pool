/**
 * What this pool costs, estimated every day from Cloudflare's own analytics
 * (GraphQL, an API token with Analytics: Read as the Worker secret
 * CLOUDFLARE_ANALYTICS_TOKEN) priced at the Workers Paid rates below, and a
 * guard: when the month's projected charges reach the budget, the scheduler
 * stops creating the jobs that write (sync, promote, render, security,
 * enqueue) until the estimate is back under it — and, since 2026-09-20,
 * sheds the anonymous machine reads of the package pages (readGuard below:
 * the crawl that put September over the line was reads, which the write
 * pause did not touch). People, signed-in readers, search engines, the
 * pool's own clients and pacman keep reading; the pool keeps serving.
 * The budget is three lines (below): the report warns at US$ 25, the
 * guard pauses the writers at US$ 40, US$ 50 is the cap. The day's first
 * estimate is also the daily report: posted from here as a comment on the
 * Cost report issue (postCostReport), the GitHub workflow cost-report.yml
 * being the late fallback.
 */
import type { Env } from "./index";
import { cookieOf } from "./routes/auth";
import { AI_CRAWLERS } from "./meta";

/** Workers Paid, US$, 2026. Included quotas are per month. */
export const PRICES = {
  plan: 5,
  requests: { included: 10_000_000, per_million: 0.3 },
  cpu_ms: { included: 30_000_000, per_million: 0.02 },
  d1_rows_read: { included: 25_000_000_000, per_million: 0.001 },
  d1_rows_written: { included: 50_000_000, per_million: 1.0 },
  d1_storage_gb: { included: 5, per_gb: 0.75 },
  r2_storage_gb: { included: 10, per_gb: 0.015 },
  r2_class_a: { included: 1_000_000, per_million: 4.5 },
  r2_class_b: { included: 10_000_000, per_million: 0.36 },
};

/**
 * The budget, three lines. The cap is the month's ceiling, agreed with the
 * project's sponsor (2026-09-16: US$ 50, not a dollar more); the guard is
 * where the brain stops creating the jobs that write, leaving room under
 * the cap for what the projection gets wrong; the warning is where the
 * report starts saying so.
 */
export const BUDGET_CAP_USD = 50;
export const BUDGET_GUARD_USD = 40;
export const BUDGET_WARN_USD = 25;
/** How often the month is estimated and the guard reconsidered. */
export const ESTIMATE_EVERY_HOURS = 3;
/** The cadence as a page says it — "every three hours" — so the API page and the Pipeline read the number here. */
export const ESTIMATE_CADENCE = `every ${["", "one", "two", "three", "four", "five", "six"][ESTIMATE_EVERY_HOURS] ?? ESTIMATE_EVERY_HOURS} hours`;

const CLASS_A = new Set(["PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "UploadPart", "ListObjects", "PutBucket", "DeleteObject", "PutBucketLifecycleConfiguration", "ListBuckets"]);

export interface CostLine {
  item: string;
  used: number;
  unit: string;
  included: number;
  month_to_date_usd: number;
  projected_usd: number;
}

export interface CostEstimate {
  month: string;
  day_of_month: number;
  days_in_month: number;
  month_to_date_usd: number;
  projected_usd: number;
  lines: CostLine[];
  guard: boolean;
}

function overage(used: number, included: number, perUnit: number, unitSize: number): number {
  return Math.max(0, used - included) / unitSize * perUnit;
}

interface Usage {
  rowsRead: number;
  rowsWritten: number;
  classA: number;
  classB: number;
  requests: number;
  cpuMs: number;
}

interface Analytics {
  d1?: { sum: { rowsRead: number; rowsWritten: number }; dimensions: { databaseId: string } }[];
  r2s?: { max: { payloadSize: number; metadataSize: number }; dimensions: { bucketName: string } }[];
  r2o?: { sum: { requests: number }; dimensions: { actionType: string } }[];
  w?: { sum: { requests: number }; quantiles: { cpuTimeP50: number }; dimensions: { scriptName: string } }[];
}

// The rate the projection extends over the days left: the last day. Six
// hours was too twitchy — the relayout's last hours (2026-09-16, 03:30–05:30
// UTC) were read as the month's pace, US$ 26 was projected, and the guard
// paused the pipeline for a day over a bill that was heading for US$ 15.
const RATE_WINDOW_HOURS = 24;

function usageOf(a: Analytics): Usage {
  return {
    rowsRead: (a.d1 ?? []).reduce((n, r) => n + r.sum.rowsRead, 0),
    rowsWritten: (a.d1 ?? []).reduce((n, r) => n + r.sum.rowsWritten, 0),
    classA: (a.r2o ?? []).filter((r) => CLASS_A.has(r.dimensions.actionType)).reduce((n, r) => n + r.sum.requests, 0),
    classB: (a.r2o ?? []).filter((r) => !CLASS_A.has(r.dimensions.actionType)).reduce((n, r) => n + r.sum.requests, 0),
    requests: (a.w ?? []).reduce((n, r) => n + r.sum.requests, 0),
    cpuMs: (a.w ?? []).reduce((n, r) => n + (r.sum.requests * (r.quantiles.cpuTimeP50 ?? 0)) / 1000, 0),
  };
}

/**
 * The estimate for the current month: what the analytics say was used so
 * far, priced; and a projection that adds the *current* rate — the last
 * day, scaled — for the days left, so a fix shows in the next estimate
 * instead of being averaged with the expensive days before it.
 */
export async function estimateCost(env: Env, now = new Date(), fetcher: typeof fetch = fetch): Promise<CostEstimate> {
  if (!env.CLOUDFLARE_ANALYTICS_TOKEN) throw new Error("CLOUDFLARE_ANALYTICS_TOKEN is not set");
  const account = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const dayOfMonth = now.getUTCDate();
  const elapsedDays = (now.getTime() - Date.parse(start)) / 86400000;
  const remainingDays = Math.max(0, daysInMonth - elapsedDays);
  const windowStart = new Date(now.getTime() - RATE_WINDOW_HOURS * 3600000).toISOString();
  const acc = `accounts(filter: {accountTag: "${account}"})`;
  const block = (since: string) => `
    d1: d1AnalyticsAdaptiveGroups(limit: 20, filter: {datetime_geq: "${since}"}) { sum { rowsRead rowsWritten } dimensions { databaseId } }
    r2o: r2OperationsAdaptiveGroups(limit: 100, filter: {datetime_geq: "${since}"}) { sum { requests } dimensions { actionType } }
    w: workersInvocationsAdaptive(limit: 100, filter: {datetime_geq: "${since}"}) { sum { requests } quantiles { cpuTimeP50 } dimensions { scriptName } }`;
  const q = `{ viewer {
    month: ${acc} { ${block(start)}
      r2s: r2StorageAdaptiveGroups(limit: 20, filter: {datetime_geq: "${new Date(now.getTime() - 86400000).toISOString()}"}) { max { payloadSize metadataSize } dimensions { bucketName } } }
    recent: ${acc} { ${block(windowStart)} }
  } }`;
  const res = await fetcher("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  const body = (await res.json()) as { data?: { viewer?: { month?: Analytics[]; recent?: Analytics[] } }; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  const a: Analytics = body.data?.viewer?.month?.[0] ?? {};
  const month = usageOf(a);
  const rate = usageOf(body.data?.viewer?.recent?.[0] ?? {});
  const perDay = 24 / RATE_WINDOW_HOURS;
  const project = (k: keyof Usage) => month[k] + rate[k] * perDay * remainingDays;
  const { rowsRead, rowsWritten, classA, classB, requests, cpuMs } = month;
  const r2Bytes = (a.r2s ?? []).reduce((n, r) => n + r.max.payloadSize + r.max.metadataSize, 0);
  // The database file size comes from the D1 API (the token that reads
  // analytics reads that too); unknown counts as nothing, well under 5 GB.
  let d1Gb = 0;
  if (env.CLOUDFLARE_D1_ID) {
    const d1 = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${env.CLOUDFLARE_D1_ID}`, { headers: { authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}` } })
      .then((r) => (r.ok ? (r.json() as Promise<{ result?: { file_size?: number } }>) : null))
      .catch(() => null);
    d1Gb = (d1?.result?.file_size ?? 0) / 1e9;
  }
  const r2Gb = r2Bytes / 1e9;

  const line = (item: string, used: number, unit: string, included: number, mtd: number, projected: number): CostLine => ({ item, used, unit, included, month_to_date_usd: round(mtd), projected_usd: round(projected) });
  const lines: CostLine[] = [
    line("Workers Paid plan", 1, "month", 0, PRICES.plan, PRICES.plan),
    line("Workers requests", requests, "requests", PRICES.requests.included, overage(requests, PRICES.requests.included, PRICES.requests.per_million, 1e6), overage(project("requests"), PRICES.requests.included, PRICES.requests.per_million, 1e6)),
    line("Workers CPU", cpuMs, "CPU-ms", PRICES.cpu_ms.included, overage(cpuMs, PRICES.cpu_ms.included, PRICES.cpu_ms.per_million, 1e6), overage(project("cpuMs"), PRICES.cpu_ms.included, PRICES.cpu_ms.per_million, 1e6)),
    line("D1 rows read", rowsRead, "rows", PRICES.d1_rows_read.included, overage(rowsRead, PRICES.d1_rows_read.included, PRICES.d1_rows_read.per_million, 1e6), overage(project("rowsRead"), PRICES.d1_rows_read.included, PRICES.d1_rows_read.per_million, 1e6)),
    line("D1 rows written", rowsWritten, "rows", PRICES.d1_rows_written.included, overage(rowsWritten, PRICES.d1_rows_written.included, PRICES.d1_rows_written.per_million, 1e6), overage(project("rowsWritten"), PRICES.d1_rows_written.included, PRICES.d1_rows_written.per_million, 1e6)),
    line("D1 storage", d1Gb, "GB", PRICES.d1_storage_gb.included, overage(d1Gb, PRICES.d1_storage_gb.included, PRICES.d1_storage_gb.per_gb, 1), overage(d1Gb, PRICES.d1_storage_gb.included, PRICES.d1_storage_gb.per_gb, 1)),
    line("R2 storage", r2Gb, "GB", PRICES.r2_storage_gb.included, overage(r2Gb, PRICES.r2_storage_gb.included, PRICES.r2_storage_gb.per_gb, 1) * (dayOfMonth / daysInMonth), overage(r2Gb, PRICES.r2_storage_gb.included, PRICES.r2_storage_gb.per_gb, 1)),
    line("R2 class A operations", classA, "requests", PRICES.r2_class_a.included, overage(classA, PRICES.r2_class_a.included, PRICES.r2_class_a.per_million, 1e6), overage(project("classA"), PRICES.r2_class_a.included, PRICES.r2_class_a.per_million, 1e6)),
    line("R2 class B operations", classB, "requests", PRICES.r2_class_b.included, overage(classB, PRICES.r2_class_b.included, PRICES.r2_class_b.per_million, 1e6), overage(project("classB"), PRICES.r2_class_b.included, PRICES.r2_class_b.per_million, 1e6)),
  ];
  const mtd = round(lines.reduce((n, l) => n + l.month_to_date_usd, 0));
  const projected = round(lines.reduce((n, l) => n + l.projected_usd, 0));
  return { month: start.slice(0, 7), day_of_month: dayOfMonth, days_in_month: daysInMonth, month_to_date_usd: mtd, projected_usd: projected, lines, guard: projected >= BUDGET_GUARD_USD || mtd >= BUDGET_GUARD_USD };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Is the guard up? (The scheduler asks before creating a job that writes.) */
export async function costGuard(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'cost_guard'").first<{ value: string }>();
  return row?.value ?? null;
}

/** The pool's own clients, by the user-agent prefix each sends: never shed, whatever the guard says — the CLI reads a package's page and files, the broker and pacman read on a machine's behalf. */
export const OWN_CLIENTS = ["omarchy-cli/", "pkg-repo/", "omarchy-broker/", "pacman/"];

/** What the read guard closes: the package page and its data — the two addresses the crawl paid for. Not the file list, the graph or the search: the CLI reads those, and the crawler did not. */
const SHED_PATHS = [/^\/package\/[^/]+$/, /^\/api\/v1\/package\/[^/]+$/];

/** How long a fetch trusts the guard word it last read: one settings row a minute per isolate, not one per request. */
const GUARD_MEMO_MS = 60_000;
let guardMemo: { at: number; value: string | null } | null = null;

/** The guard word as fetch() reads it: through the memo, refreshed at most once a minute. */
async function guardWord(env: Env, now: number): Promise<string | null> {
  if (!guardMemo || now - guardMemo.at >= GUARD_MEMO_MS) guardMemo = { at: now, value: await costGuard(env) };
  return guardMemo.value;
}

/** Forgets the memo, so the next read asks the settings row: the tests raise and lower the guard inside one minute. */
export function forgetGuardWord(): void {
  guardMemo = null;
}

/**
 * Is this a machine reading, and not one of ours? Cloudflare's word first
 * when it has one (request.cf.verifiedBotCategory: a verified bot of any
 * category but a search engine's crawler is a machine — the AI crawlers
 * are verified too, and GoogleOther's category is "AI Crawler"); then the
 * user-agent: empty, one of the AI crawlers by name, or not a browser's —
 * every browser since 1994 says "Mozilla/". A heuristic: a crawler that
 * wears a browser's user-agent passes, and the zone's rules are what catch
 * it; the pool's own clients are exempt by their prefix before any of it.
 */
export function machineReader(request: Request): boolean {
  const ua = request.headers.get("user-agent") ?? "";
  if (OWN_CLIENTS.some((p) => ua.startsWith(p))) return false;
  const category = (request.cf as { verifiedBotCategory?: string } | undefined)?.verifiedBotCategory;
  if (category) return category !== "Search Engine Crawler";
  if (!ua) return true;
  const lower = ua.toLowerCase();
  if (AI_CRAWLERS.some((c) => lower.includes(c.toLowerCase()))) return true;
  return !ua.includes("Mozilla/");
}

/**
 * The read guard: while the cost guard is up, an anonymous machine asking
 * for a package page or its data is answered 503 with an hour's
 * retry-after — no database read, and nothing the edge keeps: the answer
 * is no-store and is made before cachedApi looks the URL up, so a person's
 * next request is a real answer. Anonymous is no `omc` session and no
 * bearer token; machine is machineReader above. Every other read — the
 * docs, the landing, the status, the file list and the graph the CLI asks
 * for, the include pacman reads — passes untouched, as does every read
 * while the guard is down. The write pause (scheduler.ts) stays beside it:
 * one setting, `settings.cost_guard`, lifted the same way.
 */
export async function readGuard(request: Request, url: URL, env: Env, now = Date.now()): Promise<Response | null> {
  if (request.method !== "GET" || !SHED_PATHS.some((re) => re.test(url.pathname))) return null;
  if (cookieOf(request, "omc") || /^bearer\s/i.test(request.headers.get("authorization") ?? "")) return null;
  if (!machineReader(request)) return null;
  const word = await guardWord(env, now);
  if (!word) return null;
  const headers = { "retry-after": "3600", "cache-control": "no-store", "x-robots-tag": "noindex" };
  const why = "the pool is over its monthly budget; try again later";
  if (url.pathname.startsWith("/api/")) return new Response(JSON.stringify({ error: why, guard: word }), { status: 503, headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
  return new Response(`<!doctype html><title>omarchy-pool: over budget</title><p>The pool is over its monthly budget; the package pages are closed to crawlers until an estimate is back under the line. Try again in an hour.</p>\n`, { status: 503, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
}

/** The slot a moment falls in: the day and the three-hour block, so one estimate is taken per block. */
export function estimateSlot(now: Date): string {
  return `${now.toISOString().slice(0, 10)}/${Math.floor(now.getUTCHours() / ESTIMATE_EVERY_HOURS)}`;
}

/**
 * The cost job, every three hours: estimate, keep the latest estimate where
 * the dashboard reads it (settings.cost_latest), raise or lower the guard
 * the moment the projection crosses the line — not the next morning. One
 * `cost` journal line a day (the first estimate at or after 06:00 UTC, what
 * the daily report carries), plus one whenever the guard goes up or comes
 * down. The daily line is also the day's report on GitHub: posted right
 * after it, once (postCostReport).
 */
export async function dailyCost(env: Env, now = new Date(), fetcher: typeof fetch = fetch): Promise<string> {
  const slot = estimateSlot(now);
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = 'cost_checked'").first<{ value: string }>();
  if (last?.value === slot) return "cost: estimated this slot";
  const est = await estimateCost(env, now, fetcher);
  const guardBefore = await costGuard(env);
  const status = est.guard ? "error" : est.projected_usd >= BUDGET_WARN_USD ? "warn" : "ok";
  const summary = `Cloudflare, ${est.month}: US$ ${est.month_to_date_usd.toFixed(2)} so far, US$ ${est.projected_usd.toFixed(2)} projected${est.guard ? ` — over the US$ ${BUDGET_GUARD_USD} guard: jobs that write are paused` : guardBefore ? " — back under the guard: the jobs that write resume" : ""}`;
  const upsert = (key: string, value: string) =>
    env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").bind(key, value);
  // The day's journal line: the first estimate at or after 06:00 UTC (block 2).
  const day = slot.slice(0, 10), block = Number(slot.slice(11)), lastBlock = last?.value.startsWith(day) ? Number(last.value.slice(11)) : -1;
  const dailyLine = lastBlock < 2 && block >= 2;
  const flips = est.guard !== !!guardBefore;
  const stmts = [upsert("cost_checked", slot), upsert("cost_latest", JSON.stringify({ estimated_at: now.toISOString(), status, ...est }))];
  if (dailyLine || flips) stmts.push(env.DB.prepare("INSERT INTO events (kind, status, summary, payload) VALUES ('cost', ?, ?, ?)").bind(status, summary, JSON.stringify(est)));
  if (est.guard && !guardBefore) stmts.push(upsert("cost_guard", summary));
  else if (!est.guard && guardBefore) stmts.push(env.DB.prepare("DELETE FROM settings WHERE key = 'cost_guard'"));
  await env.DB.batch(stmts);
  const report = dailyLine ? await postCostReport(env, { estimated_at: now.toISOString(), ...est }, now, fetcher) : "";
  return `cost: ${summary}${report ? `; ${report}` : ""}`;
}

/** The repository whose Cost report issue gets the daily comment. */
export const REPORT_REPO = "firemanxbr/omarchy-pool";
const GITHUB = `https://api.github.com/repos/${REPORT_REPO}`;

/** The estimate as the API serves it: when it was taken, and the three lines that ride every answer. */
export type ReportedEstimate = CostEstimate & { estimated_at: string };

/**
 * A comment that carries an estimate starts with the month and the day —
 * `**2026-09** — day 20 of 30 · estimated …`, a ⚠️ before it at the warning
 * line. The rule both posters skip by: the Worker and cost-report.yml each
 * count today's comments on the issue that look like this (and not like the
 * workflow's "no estimate today" line), whoever wrote them, so the day gets
 * one number and a second poster stays quiet. Change the header here and in
 * the workflow's jq together.
 */
export const REPORT_HEADER = /\*\*\d{4}-\d{2}\*\* — day \d+ of \d+ · estimated /;

/** `US$ 12.34` — the same spelling as the workflow's jq `usd`. */
const usd = (n: number) => `US$ ${n}`;
/** A quantity as the jq template prints it: millions floored with " M" over a million, else two decimals. */
const qty = (n: number) => (n > 1e6 ? `${Math.floor(n / 1e6)} M` : String(Math.round(n * 100) / 100));
const included = (n: number) => (n > 1e6 ? `${Math.floor(n / 1e6)} M` : String(n));

/**
 * The daily comment's markdown — the twin of the jq template in
 * .github/workflows/cost-report.yml, line for line, so the day reads the
 * same whichever of the two posted it. The lines come from the budget
 * constants above, as the API's `lines_usd` gives them to the workflow.
 */
export function costReportMarkdown(est: ReportedEstimate): string {
  const guardNote = est.guard
    ? `\n> ⚠️ **Over the guard (${usd(BUDGET_GUARD_USD)}): the jobs that write are paused** until the estimate is back under it — the cap is ${usd(BUDGET_CAP_USD)}.\n`
    : "";
  const rows = est.lines.map((l) => `| ${l.item} | ${qty(l.used)} ${l.unit} | ${included(l.included)} | ${usd(l.month_to_date_usd)} | ${usd(l.projected_usd)} |`).join("\n");
  return (
    (est.projected_usd >= BUDGET_WARN_USD ? "⚠️ " : "") +
    `**${est.month}** — day ${est.day_of_month} of ${est.days_in_month} · estimated ${est.estimated_at}\n\n` +
    `| | |\n|---|---|\n| So far | **${usd(est.month_to_date_usd)}** |\n| Projected for the month | **${usd(est.projected_usd)}** |\n` +
    guardNote +
    `\n| Item | Used | Included | So far | Projected |\n|---|---:|---:|---:|---:|\n` +
    rows +
    `\n\nBudget (worker/src/cost.ts): this report warns from a projected ${usd(BUDGET_WARN_USD)}; the pool pauses the jobs that write at a projected ${usd(BUDGET_GUARD_USD)} and resumes within three hours of the estimate heading back; ${usd(BUDGET_CAP_USD)} is the cap, never more.`
  );
}

/**
 * The daily report, posted by the brain itself the moment the day's line is
 * written — GitHub's cron started cost-report.yml 4.8–6.6 hours late every
 * day of 2026-09-13..20, and on the 18th an edge rule kept the runner from
 * reading the estimate at all, so the issue went a day without its number
 * while the journal had it at 06:00. The secret is GITHUB_REPORT_TOKEN, a
 * fine-grained token with Issues: Read and write on the repository and
 * nothing else — never GITHUB_TOKEN, which stays read-only (the release
 * workflow is dispatch-only and deploys production, so no token with
 * Actions: write lives in the Worker). Without the secret this says so in
 * the tick's log and the workflow posts, late. One attempt a day: a failure
 * is one `cost` journal line with status warn, and the workflow still posts.
 * Costs no D1 row on success.
 */
export async function postCostReport(env: Env, est: ReportedEstimate, now = new Date(), fetcher: typeof fetch = fetch): Promise<string> {
  if (!env.GITHUB_REPORT_TOKEN) {
    const line = "report: GITHUB_REPORT_TOKEN not set; cost-report.yml posts it on GitHub, late";
    console.log(`cost ${line}`);
    return line;
  }
  const headers = { authorization: `Bearer ${env.GITHUB_REPORT_TOKEN}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "omarchy-pool-cost-report" };
  const day = now.toISOString().slice(0, 10);
  try {
    const issues = await fetcher(`${GITHUB}/issues?labels=cost-report&state=open&per_page=1`, { headers });
    if (!issues.ok) throw new Error(`listing the issue: HTTP ${issues.status}`);
    const issue = ((await issues.json()) as { number: number }[])[0];
    if (!issue) return "report: no open issue labelled cost-report (the workflow creates it)";
    // One number a day: a comment carrying an estimate since midnight — the
    // workflow's, a maintainer's dispatch, an earlier attempt — means done.
    const comments = await fetcher(`${GITHUB}/issues/${issue.number}/comments?since=${day}T00:00:00Z&per_page=100`, { headers });
    if (!comments.ok) throw new Error(`reading #${issue.number}'s comments: HTTP ${comments.status}`);
    const today = ((await comments.json()) as { body?: string }[]).filter((c) => REPORT_HEADER.test(c.body ?? ""));
    if (today.length) return `report: #${issue.number} already has today's comment`;
    const post = await fetcher(`${GITHUB}/issues/${issue.number}/comments`, { method: "POST", headers, body: JSON.stringify({ body: costReportMarkdown(est) }) });
    if (!post.ok) throw new Error(`posting on #${issue.number}: HTTP ${post.status}`);
    return `report: posted on #${issue.number}`;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("INSERT INTO events (kind, status, summary, payload) VALUES ('cost', 'warn', ?, ?)")
      .bind(`Cost report for ${day} not posted on GitHub — ${reason}; cost-report.yml posts it, late`, JSON.stringify({ day, error: reason, repo: REPORT_REPO }))
      .run();
    return `report: not posted — ${reason}`;
  }
}
