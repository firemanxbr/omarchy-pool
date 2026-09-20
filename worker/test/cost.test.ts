import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BUDGET_CAP_USD, BUDGET_GUARD_USD, BUDGET_WARN_USD, costReportMarkdown, dailyCost, estimateCost, estimateSlot, PRICES, REPORT_HEADER, REPORT_REPO } from "../src/cost";
import type { Env } from "../src/index";

// Cloudflare's analytics for a month like September 2026 so far, stubbed.
// The month so far, and the last day (the rate the projection uses): 1 B
// rows read in it.
const analytics = {
  data: { viewer: {
    month: [{
      d1: [{ sum: { rowsRead: 17_000_000_000, rowsWritten: 20_000_000 }, dimensions: { databaseId: "x" } }],
      r2s: [{ max: { payloadSize: 275e9, metadataSize: 5e6 }, dimensions: { bucketName: "omarchy-packages" } }],
      r2o: [{ sum: { requests: 70_000 }, dimensions: { actionType: "PutObject" } }, { sum: { requests: 150_000 }, dimensions: { actionType: "HeadObject" } }],
      w: [{ sum: { requests: 132_000 }, quantiles: { cpuTimeP50: 1700 }, dimensions: { scriptName: "omarchy-repo" } }],
    }],
    recent: [{
      d1: [{ sum: { rowsRead: 1_000_000_000, rowsWritten: 800_000 }, dimensions: { databaseId: "x" } }],
      r2o: [{ sum: { requests: 2_000 }, dimensions: { actionType: "PutObject" } }, { sum: { requests: 8_000 }, dimensions: { actionType: "HeadObject" } }],
      w: [{ sum: { requests: 16_000 }, quantiles: { cpuTimeP50: 1700 }, dimensions: { scriptName: "omarchy-repo" } }],
    }],
  } },
};
const fetcher = (async (url: string | URL | Request) =>
  new Response(JSON.stringify(String(url).includes("/d1/database/") ? { result: { file_size: 5.1e8 } } : analytics), { status: 200 })) as unknown as typeof fetch;
const env = { CLOUDFLARE_ANALYTICS_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_D1_ID: "d" } as unknown as Env;

describe("the bill", () => {
  it("prices the month to date and projects it linearly", async () => {
    const est = await estimateCost(env, new Date("2026-09-13T16:00:00Z"), fetcher);
    expect(est.month).toBe("2026-09");
    expect(est.day_of_month).toBe(13);
    expect(est.days_in_month).toBe(30);
    const by = Object.fromEntries(est.lines.map((l) => [l.item, l]));
    expect(by["Workers Paid plan"].projected_usd).toBe(PRICES.plan);
    // 17 B rows read so far (25 B included: nothing yet); at 1 B/day for the
    // 17.33 days left ≈ 34.3 B → 9.3 B over → ≈ US$ 9.3. The expensive days
    // behind are not averaged forward.
    expect(by["D1 rows read"].month_to_date_usd).toBe(0);
    expect(by["D1 rows read"].projected_usd).toBeCloseTo(9.33, 1);
    // 20 M rows written + 0.8 M/day × 17.33 ≈ 34 M, 50 M included: nothing
    expect(by["D1 rows written"].projected_usd).toBe(0);
    // 275 GB of R2, 10 free: (265 × 0.015) ≈ 3.98 for the month
    expect(by["R2 storage"].projected_usd).toBeCloseTo(3.98, 1);
    expect(est.projected_usd).toBeCloseTo(5 + 9.33 + 3.98, 0);
    expect(est.guard).toBe(false);
  });

  it("raises the guard when the projection reaches the budget", async () => {
    const heavy = JSON.parse(JSON.stringify(analytics));
    heavy.data.viewer.month[0].d1[0].sum.rowsRead = 200_000_000_000;
    const f = (async () => new Response(JSON.stringify(heavy), { status: 200 })) as unknown as typeof fetch;
    const est = await estimateCost({ ...env, CLOUDFLARE_D1_ID: undefined } as unknown as Env, new Date("2026-09-13T16:00:00Z"), f);
    expect(est.guard).toBe(true);
    expect(est.month_to_date_usd).toBeGreaterThan(BUDGET_GUARD_USD);
  });

  it("does not read a burst as the month's pace: a day of it weighs a day", async () => {
    // The relayout's last hours, 2026-09-16: 400 M rows in the last day, on
    // top of 24.8 B for the month — 200 M over the included 25 B by the end
    // of the day, then 400 M × 14 days ≈ 5.6 B more: US$ 5.8, under the warning line.
    const burst = JSON.parse(JSON.stringify(analytics));
    burst.data.viewer.month[0].d1[0].sum.rowsRead = 24_800_000_000;
    burst.data.viewer.recent[0].d1[0].sum.rowsRead = 400_000_000;
    const f = (async () => new Response(JSON.stringify(burst), { status: 200 })) as unknown as typeof fetch;
    const est = await estimateCost({ ...env, CLOUDFLARE_D1_ID: undefined } as unknown as Env, new Date("2026-09-16T06:30:00Z"), f);
    const reads = est.lines.find((l) => l.item === "D1 rows read")!;
    expect(reads.projected_usd).toBeCloseTo(5.5, 0);
    expect(est.projected_usd).toBeLessThan(BUDGET_WARN_USD);
    expect(est.guard).toBe(false);
  });

  it("estimates once per three-hour slot, and the lines are in order", () => {
    expect(estimateSlot(new Date("2026-09-16T06:30:00Z"))).toBe("2026-09-16/2");
    expect(estimateSlot(new Date("2026-09-16T08:59:00Z"))).toBe("2026-09-16/2");
    expect(estimateSlot(new Date("2026-09-16T09:00:00Z"))).toBe("2026-09-16/3");
    expect(BUDGET_WARN_USD).toBeLessThan(BUDGET_GUARD_USD);
    expect(BUDGET_GUARD_USD).toBeLessThan(BUDGET_CAP_USD);
    expect(BUDGET_CAP_USD).toBe(50);
  });
});

// The daily report on GitHub: the analytics fetcher above, plus GitHub's
// three answers — the open issue, today's comments (what the `since` asks
// for), the POST — recorded so the test reads what the brain asked and sent.
type Call = { url: string; method: string; body?: string };
function github(opts: { todays?: string[]; post?: number } = {}) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined });
    if (u.includes("/d1/database/")) return new Response(JSON.stringify({ result: { file_size: 5.1e8 } }), { status: 200 });
    if (u.includes("/graphql")) return new Response(JSON.stringify(analytics), { status: 200 });
    if (u.includes("/issues?labels=cost-report")) return new Response(JSON.stringify([{ number: 68 }]), { status: 200 });
    if (u.includes("/issues/68/comments?since=")) return new Response(JSON.stringify((opts.todays ?? []).map((body) => ({ body, user: { login: "github-actions[bot]" } }))), { status: 200 });
    if (u.endsWith("/issues/68/comments")) return new Response(JSON.stringify({ id: 1 }), { status: opts.post ?? 201 });
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
  return { f, calls, github: () => calls.filter((c) => c.url.startsWith("https://api.github.com/")) };
}
const brain = (token?: string) => ({ ...testEnv, ...env, GITHUB_REPORT_TOKEN: token } as unknown as Env);
const costEvents = async () => (await testEnv.DB.prepare("SELECT status, summary FROM events WHERE kind = 'cost' ORDER BY id").all<{ status: string; summary: string }>()).results;

describe("the daily report on GitHub", () => {
  it("renders the comment the workflow's jq renders, ⚠️ at the warning line", async () => {
    const est = await estimateCost(env, new Date("2026-09-13T16:00:00Z"), fetcher);
    const md = costReportMarkdown({ estimated_at: "2026-09-13T16:00:00.000Z", ...est });
    expect(md).toMatch(REPORT_HEADER);
    expect(md.startsWith("**2026-09** — day 13 of 30 · estimated 2026-09-13T16:00:00.000Z\n\n| | |\n|---|---|\n| So far | **US$ ")).toBe(true);
    expect(md).toContain("| Workers Paid plan | 1 month | 0 | US$ 5 | US$ 5 |");
    expect(md).toContain("| D1 rows read | 17000 M rows | 25000 M | US$ 0 | US$ 9.33 |");
    expect(md).toContain("| D1 storage | 0.51 GB | 5 | US$ 0 | US$ 0 |");
    expect(md).not.toContain("Over the guard");
    expect(md.endsWith(`Budget (worker/src/cost.ts): this report warns from a projected US$ ${BUDGET_WARN_USD}; the pool pauses the jobs that write at a projected US$ ${BUDGET_GUARD_USD} and resumes within three hours of the estimate heading back; US$ ${BUDGET_CAP_USD} is the cap, never more.`)).toBe(true);
    // Over the line: the ⚠️ leads, and the guard's note names the guard and the cap from cost.ts.
    const hot = costReportMarkdown({ estimated_at: "x", ...est, projected_usd: BUDGET_GUARD_USD + 2.5, guard: true });
    expect(hot.startsWith("⚠️ **2026-09** — day 13 of 30")).toBe(true);
    expect(hot).toContain(`> ⚠️ **Over the guard (US$ ${BUDGET_GUARD_USD}): the jobs that write are paused** until the estimate is back under it — the cap is US$ ${BUDGET_CAP_USD}.`);
    // The workflow's "no estimate today" line is not an estimate.
    expect(REPORT_HEADER.test("**2026-09-18** — ⚠️ **no estimate today**: hosts did not answer")).toBe(false);
  });

  it("posts once, with the day's line, after checking the issue has no comment since midnight — and never twice", async () => {
    const gh = github();
    const first = await dailyCost(brain("t-report"), new Date("2026-09-21T06:00:30Z"), gh.f);
    expect(first).toMatch(/^cost: Cloudflare, 2026-09: US\$ .* projected; report: posted on #68$/);
    const asked = gh.github();
    expect(asked.map((c) => `${c.method} ${c.url.slice("https://api.github.com/repos/".length)}`)).toEqual([
      `GET ${REPORT_REPO}/issues?labels=cost-report&state=open&per_page=1`,
      `GET ${REPORT_REPO}/issues/68/comments?since=2026-09-21T00:00:00Z&per_page=100`,
      `POST ${REPORT_REPO}/issues/68/comments`,
    ]);
    const posted = JSON.parse(asked[2].body!) as { body: string };
    expect(posted.body).toMatch(REPORT_HEADER);
    expect(posted.body).toContain("estimated 2026-09-21T06:00:30.000Z");
    expect(posted.body).toContain("| Workers Paid plan | 1 month | 0 | US$ 5 | US$ 5 |");
    // The same slot again: nothing estimated, nothing asked of GitHub (the cadence rule).
    expect(await dailyCost(brain("t-report"), new Date("2026-09-21T06:10:00Z"), gh.f)).toBe("cost: estimated this slot");
    // The next slots of the day estimate again but the line and the comment are the morning's.
    expect(await dailyCost(brain("t-report"), new Date("2026-09-21T09:00:30Z"), gh.f)).not.toContain("report:");
    expect(await dailyCost(brain("t-report"), new Date("2026-09-21T21:00:30Z"), gh.f)).not.toContain("report:");
    expect(gh.github().filter((c) => c.method === "POST")).toHaveLength(1);
    // One journal line for the day, no warn.
    const ev = await costEvents();
    expect(ev.filter((e) => e.status === "warn")).toHaveLength(0);
    expect(ev).toHaveLength(1);
  });

  it("stays quiet when today's comment is already on the issue — whoever posted it", async () => {
    const gh = github({ todays: ["**2026-09** — day 22 of 30 · estimated 2026-09-22T05:59:00Z\n\n| | |"] });
    const line = await dailyCost(brain("t-report"), new Date("2026-09-22T06:00:30Z"), gh.f);
    expect(line).toContain("report: #68 already has today's comment");
    expect(gh.github().filter((c) => c.method === "POST")).toHaveLength(0);
    // The workflow's own "unavailable" line does not count as the number: the brain still posts.
    const gh2 = github({ todays: ["**2026-09-23** — ⚠️ **no estimate today**: the hosts did not answer"] });
    expect(await dailyCost(brain("t-report"), new Date("2026-09-23T06:00:30Z"), gh2.f)).toContain("report: posted on #68");
    expect(gh2.github().filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("does nothing on GitHub without GITHUB_REPORT_TOKEN, and journals a failed post once as a warning", async () => {
    const gh = github();
    const line = await dailyCost(brain(undefined), new Date("2026-09-24T06:00:30Z"), gh.f);
    expect(line).toContain("report: GITHUB_REPORT_TOKEN not set; cost-report.yml posts it on GitHub, late");
    expect(gh.github()).toHaveLength(0);
    expect((await costEvents()).filter((e) => e.status === "warn")).toHaveLength(0);
    // The token is there but GitHub refuses the POST: one warn line, the day's own line still written, no retry this day.
    const refused = github({ post: 403 });
    const failed = await dailyCost(brain("t-report"), new Date("2026-09-25T06:00:30Z"), refused.f);
    expect(failed).toContain("report: not posted — posting on #68: HTTP 403");
    const warns = (await costEvents()).filter((e) => e.status === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].summary).toBe("Cost report for 2026-09-25 not posted on GitHub — posting on #68: HTTP 403; cost-report.yml posts it, late");
    expect(await dailyCost(brain("t-report"), new Date("2026-09-25T09:00:30Z"), refused.f)).not.toContain("report:");
    expect(refused.github().filter((c) => c.method === "POST")).toHaveLength(1);
    expect((await costEvents()).filter((e) => e.status === "warn")).toHaveLength(1);
  });
});
