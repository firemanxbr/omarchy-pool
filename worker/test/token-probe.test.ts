/**
 * No write-scoped token outside GitHub Actions (#308): the pool's daily
 * probe of its own GitHub tokens. A dispatch of rollback.yml to a ref that
 * cannot exist: GitHub's 403 says the token cannot start a workflow, its
 * 422 says it can — an error on Status. The cron runs it once a day per
 * token, against stubbed GitHub answers here; nothing reaches the network.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { runScheduler } from "../src/scheduler";
import { PROBE_REF, PROBE_URL, probeTokens, verdictOf } from "../src/tokenprobe";

type Sent = { url: string; method: string; auth: string | null; body: string };

/** A stubbed GitHub: the probe's URL answers `probe`, everything else 404; every request recorded. */
function github(probe: number): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    sent.push({ url: req.url, method: req.method, auth: req.headers.get("authorization"), body: req.method === "POST" ? await req.text() : "" });
    if (req.url === PROBE_URL) return new Response(JSON.stringify({ message: probe === 422 ? "No ref found for: omarchy-token-probe..no-such-ref" : "Resource not accessible by personal access token" }), { status: probe });
    return new Response("not found", { status: 404 });
  });
  return sent;
}

const withTokens = (tokens: Partial<Pick<Env, "GITHUB_TOKEN" | "GITHUB_REPORT_TOKEN">>): Env => ({ ...env, JOB_KINDS: "", GITHUB_TOKEN: undefined, GITHUB_REPORT_TOKEN: undefined, ...tokens }) as Env;
const lines = async (day: string) =>
  (await env.DB.prepare("SELECT source, status, summary, payload FROM events WHERE kind = 'token' AND created_at LIKE ? ORDER BY id").bind(`${day}%`).all<{ source: string; status: string; summary: string; payload: string }>()).results;

afterEach(() => vi.restoreAllMocks());

describe("the daily token probe (#308)", () => {
  it("reads GitHub's answer: 403 cannot start a workflow, 422 (or a run accepted) can, anything else cannot tell", () => {
    expect(verdictOf("GITHUB_TOKEN", 403).status).toBe("ok");
    expect(verdictOf("GITHUB_TOKEN", 422)).toMatchObject({ status: "error", summary: expect.stringContaining("GITHUB_TOKEN can start workflows on this repository: GitHub answered 422") });
    expect(verdictOf("GITHUB_TOKEN", 204).status).toBe("error");
    expect(verdictOf("GITHUB_TOKEN", 401).status).toBe("warn");
    expect(verdictOf("GITHUB_TOKEN", 404).status).toBe("warn");
    expect(verdictOf("GITHUB_TOKEN", 502).status).toBe("warn");
  });

  it("runs on the cron: a stubbed 422 raises a Status error, once a day", async () => {
    const sent = github(422);
    const log = await runScheduler(withTokens({ GITHUB_TOKEN: "github_pat_writes" }), new Date("2026-10-01T00:10:00Z"));
    expect(log.join("\n")).toContain("token GITHUB_TOKEN: GITHUB_TOKEN can start workflows on this repository");
    const probes = sent.filter((r) => r.url === PROBE_URL);
    expect(probes).toHaveLength(1);
    // The probe itself: a POST of rollback.yml's dispatch, with the token, to a ref no branch can have — no run can start.
    expect(probes[0].method).toBe("POST");
    expect(probes[0].auth).toBe("Bearer github_pat_writes");
    expect(JSON.parse(probes[0].body).ref).toBe(PROBE_REF);
    expect(PROBE_REF).toContain("..");
    const today = await lines("2026-10-01");
    expect(today).toHaveLength(1);
    expect(today[0]).toMatchObject({ source: "GITHUB_TOKEN", status: "error" });
    expect(JSON.parse(today[0].payload).http).toBe(422);
    // It is the latest token line the Status page reads (the stats' latest), so the hero says so (status-page.test.ts draws it).
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://pool.test/api/v1/stats?fresh=probe"), env, ctx);
    await waitOnExecutionContext(ctx);
    const stats = (await res.json()) as { latest: { kind: string; source: string; status: string }[] };
    expect(stats.latest.filter((e) => e.kind === "token")).toEqual([expect.objectContaining({ source: "GITHUB_TOKEN", status: "error" })]);
    // The next tick the same day probes nothing again.
    await runScheduler(withTokens({ GITHUB_TOKEN: "github_pat_writes" }), new Date("2026-10-01T00:20:00Z"));
    expect(sent.filter((r) => r.url === PROBE_URL)).toHaveLength(1);
    expect(await lines("2026-10-01")).toHaveLength(1);
  });

  it("a stubbed 403 raises no error: the token cannot start a workflow, and a later 403 clears an earlier error", async () => {
    const sent = github(403);
    const log = await runScheduler(withTokens({ GITHUB_TOKEN: "github_pat_reads" }), new Date("2026-10-02T00:10:00Z"));
    expect(log.join("\n")).toContain("token GITHUB_TOKEN: GITHUB_TOKEN cannot start a workflow: GitHub answered 403");
    expect(sent.filter((r) => r.url === PROBE_URL)).toHaveLength(1);
    const today = await lines("2026-10-02");
    expect(today).toEqual([expect.objectContaining({ source: "GITHUB_TOKEN", status: "ok" })]);
    // The latest token line is the one Status reads: the day before's error no longer is.
    const latest = await env.DB.prepare("SELECT e.status FROM latest_events l JOIN events e ON e.id = l.id WHERE l.kind = 'token' AND l.src = 'GITHUB_TOKEN'").first<{ status: string }>();
    expect(latest?.status).toBe("ok");
  });

  it("probes every GitHub token the pool holds, each on its own line, and nothing without one", async () => {
    let sent = github(403);
    expect(await probeTokens(withTokens({}), new Date("2026-10-03T01:00:00Z"))).toEqual([]);
    expect(sent).toHaveLength(0);
    sent = github(422);
    const log = await probeTokens(withTokens({ GITHUB_TOKEN: "github_pat_a", GITHUB_REPORT_TOKEN: "github_pat_b" }), new Date("2026-10-03T01:00:00Z"));
    expect(log).toHaveLength(2);
    expect(sent.map((r) => r.auth)).toEqual(["Bearer github_pat_a", "Bearer github_pat_b"]);
    expect((await lines("2026-10-03")).map((l) => `${l.source} ${l.status}`)).toEqual(["GITHUB_TOKEN error", "GITHUB_REPORT_TOKEN error"]);
  });

  it("writes nothing when GitHub does not answer, so the next tick tries again", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("network down");
    });
    const log = await runScheduler(withTokens({ GITHUB_TOKEN: "github_pat_x" }), new Date("2026-10-04T00:10:00Z"));
    expect(log.join("\n")).toContain("token probe: TypeError: network down");
    expect(await lines("2026-10-04")).toHaveLength(0);
  });
});
