import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isDue, RULES, runScheduler } from "../src/scheduler";
import { PROBE_URL } from "../src/tokenprobe";

// The Worker's code (not its pages or docs), as text (Vite's ?raw): the tests run inside workerd, which has no filesystem.
const SOURCES = import.meta.glob("../src/{*,routes/*}.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const at = (iso: string) => new Date(iso);
const run = (created_at: string, status = "completed") => ({ created_at, status });

afterEach(() => vi.restoreAllMocks());

describe("scheduler rules", () => {
  const sync = RULES.find((r) => r.workflow === "sync")!;
  const stable = RULES.find((r) => r.workflow === "promote" && r.job?.params.to === "stable")!;

  it("dispatches an interval workflow only once it is overdue and idle", () => {
    const now = at("2026-09-12T16:00:00Z");
    expect(isDue(sync, [run("2026-09-12T13:20:00Z")], now).due).toBe(false); // 160 min ago, every 180
    expect(isDue(sync, [run("2026-09-12T12:50:00Z")], now).due).toBe(true); // 190 min ago
    expect(isDue(sync, [run("2026-09-12T12:50:00Z", "in_progress")], now).due).toBe(false);
    expect(isDue(sync, [], now).due).toBe(true); // never ran
  });

  it("dispatches a daily slot after a grace period, once", () => {
    const health = RULES.find((r) => r.workflow === "health")!; // 08:30 UTC
    expect(isDue(health, [], at("2026-09-12T08:35:00Z")).due).toBe(false); // GitHub's cron gets first go
    expect(isDue(health, [], at("2026-09-12T08:45:00Z")).due).toBe(true);
    expect(isDue(health, [run("2026-09-12T08:32:00Z", "completed")], at("2026-09-12T08:45:00Z")).due).toBe(false);
    expect(isDue(health, [run("2026-09-11T08:32:00Z")], at("2026-09-12T18:00:00Z")).due).toBe(true); // yesterday's run does not count
  });

  it("promotes by evidence, not by the clock: rc → stable is attempted every three hours, edge → rc has a twelve-hour safety net", () => {
    expect(stable.every).toBe(180);
    expect(stable.at).toBeUndefined();
    const rc = RULES.find((r) => r.workflow === "promote" && r.job?.params.to === "rc")!;
    expect(rc.every).toBe(720);
    expect(isDue(stable, [run("2026-09-12T06:00:00Z")], at("2026-09-12T08:00:00Z")).due).toBe(false); // on time
    expect(isDue(stable, [run("2026-09-12T06:00:00Z")], at("2026-09-12T09:10:00Z")).due).toBe(true);
  });

  it("only runs the weekly slot on its weekday", () => {
    const gc = RULES.find((r) => r.workflow === "gc")!;
    expect(isDue(gc, [], at("2026-09-12T05:00:00Z")).due).toBe(false); // Saturday
    expect(isDue(gc, [], at("2026-09-13T05:00:00Z")).due).toBe(true); // Sunday
  });

  it("has no dispatch path: no Worker source starts or reads a workflow but the token probe, and the cron starts nothing on GitHub (#308)", async () => {
    // The source itself: only tokenprobe.ts names GitHub's workflow API (its probe, a dispatch to a ref that cannot exist).
    for (const [file, text] of Object.entries(SOURCES)) {
      if (file.endsWith("/tokenprobe.ts")) continue;
      expect(text, file).not.toMatch(/actions\/workflows|\/dispatches\b|\/actions\/runs/);
    }
    expect(SOURCES["../src/scheduler.ts"]).toBeTruthy();
    expect(SOURCES["../src/scheduler.ts"]).not.toMatch(/api\.github\.com|method: "POST"/);
    const sent: { url: string; method: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      sent.push({ url, method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() });
      return new Response("not found", { status: 404 });
    });
    // A token set and no job kind listed: nothing runs the rules, and the log says so.
    const log = await runScheduler({ ...env, GITHUB_TOKEN: "github_pat_test", JOB_KINDS: "" }, at("2026-09-12T01:00:00Z"));
    expect(log).toContain("sync: not in JOB_KINDS; nothing runs it");
    expect(log.join("\n")).not.toMatch(/dispatched/);
    const actions = sent.filter((r) => r.url.includes("/actions/"));
    // The one request to GitHub's Actions API is the daily token probe's POST (tokenprobe.ts): rollback.yml to a ref that cannot exist, never a run.
    expect(actions.map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${PROBE_URL}`]);
  });
});
