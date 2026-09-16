import { describe, expect, it } from "vitest";
import { RULES } from "../src/scheduler";

describe("metrics", () => {
  it("is no longer a workflow rule: the brain snapshots itself", () => {
    expect(RULES.some((r) => r.workflow === "metrics.yml")).toBe(false);
    expect(RULES.find((r) => r.workflow === "security")?.job?.kind).toBe("security");
  });
});

import { env } from "cloudflare:test";
import { anyTwice, snapshotMetrics } from "../src/metrics";

describe("any packages stored once per architecture", () => {
  it("counts the names, the objects and the second copies' bytes", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch) VALUES
        ('1', 'fonts', '1-1', 'any', 'fonts-1-1-any.pkg.tar.zst', 100, 1, 0, '{}', 'extra', 'extra/x86_64/fonts', 'x86_64'),
        ('2', 'fonts', '1-1', 'any', 'fonts-1-1-any.pkg.tar.zst', 120, 1, 0, '{}', 'alarm', 'alarm/aarch64/fonts', 'aarch64'),
        ('3', 'docs', '2-1', 'any', 'docs-2-1-any.pkg.tar.zst', 50, 1, 0, '{}', 'extra', 'extra/x86_64/docs', 'x86_64'),
        ('4', 'zlib', '1-1', 'x86_64', 'zlib-1-1-x86_64.pkg.tar.zst', 30, 1, 0, '{}', 'core', 'core/x86_64/zlib', 'x86_64')`),
      env.DB.prepare("INSERT INTO ring_packages (ring, package_id) SELECT 'stable', id FROM packages"),
    ]);
    expect(await anyTwice(env, "stable")).toEqual({ names: 2, objects: 3, bytes: 270, twice: 1, extra_bytes: 100 });
    expect(await anyTwice(env, "edge")).toEqual({ names: 0, objects: 0, bytes: 0, twice: 0, extra_bytes: 0 });
    // The snapshot carries it.
    await snapshotMetrics(env, new Date("2026-09-14T00:00:00Z"));
    const snap = await env.DB.prepare("SELECT payload FROM events WHERE kind = 'metrics' ORDER BY id DESC LIMIT 1").first<{ payload: string }>();
    expect(JSON.parse(snap!.payload).any.stable.twice).toBe(1);
  });
});

describe("what the snapshot reads", () => {
  it("rescans the pool only after something changed it", async () => {
    // A first snapshot scans; half an hour later nothing moved: the pool
    // block is the previous one, carried over. A sync, and the next one scans.
    await env.DB.prepare(`INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch) VALUES
      ('9', 'nano', '8-1', 'x86_64', 'nano-8-1-x86_64.pkg.tar.zst', 700, 1, 0, '{}', 'extra', 'extra/x86_64/nano', 'x86_64')`).run();
    // The rows' created_at is the database's clock, so the moments are real
    // ones — half an hour after the previous test's snapshot.
    const t0 = Date.now(), at = (min: number) => new Date(t0 + min * 60000);
    const synced = (when: string | null) => env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload, created_at) VALUES ('sync', 'edge', 'extra', 'ok', 'extra x86_64: 1 new package', '{}', COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))").bind(when).run();
    // The snapshots' own rows carry the database's clock (about t0), so the
    // events sit around it: one now, after the previous test's snapshot and
    // before the first one here; one a minute ahead, after the second.
    await synced(null);
    await snapshotMetrics(env, at(31));
    const first = JSON.parse((await env.DB.prepare("SELECT payload FROM events WHERE kind = 'metrics' ORDER BY id DESC LIMIT 1").first<{ payload: string }>())!.payload);
    expect(first.pool_scanned).toBe(true);
    expect(first.pool.objects).toBeGreaterThan(0);

    const later = await snapshotMetrics(env, at(62));
    expect(later).toContain("(unchanged)");
    const second = JSON.parse((await env.DB.prepare("SELECT payload FROM events WHERE kind = 'metrics' ORDER BY id DESC LIMIT 1").first<{ payload: string }>())!.payload);
    expect(second.pool_scanned).toBe(false);
    expect(second.pool).toEqual(first.pool);
    expect(second.rings).toEqual(first.rings);

    await synced(at(1).toISOString());
    await env.DB.prepare(`INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch) VALUES
      ('10', 'nano', '8-2', 'x86_64', 'nano-8-2-x86_64.pkg.tar.zst', 710, 1, 0, '{}', 'extra', 'extra/x86_64/nano2', 'x86_64')`).run();
    await snapshotMetrics(env, at(93));
    const third = JSON.parse((await env.DB.prepare("SELECT payload FROM events WHERE kind = 'metrics' ORDER BY id DESC LIMIT 1").first<{ payload: string }>())!.payload);
    expect(third.pool_scanned).toBe(true);
    expect(third.pool.objects).toBe(first.pool.objects + 1);
  });

  it("keeps the latest event of every kind, source and ring in one row each", async () => {
    // The trigger of migration 0027: what /api/v1/stats reads instead of a
    // GROUP BY over every event ever recorded.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('health', 'stable', 'x86_64', 'ok', 'first', '{}')"),
      env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('health', 'stable', 'x86_64', 'error', 'second', '{}')"),
      env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('health', 'stable', 'aarch64', 'ok', 'other arch', '{}')"),
      env.DB.prepare("INSERT INTO events (kind, status, summary, payload) VALUES ('deploy', 'ok', 'no ring, no source', '{}')"),
    ]);
    const latest = await env.DB.prepare("SELECT e.kind, e.ring, e.source, e.summary FROM latest_events l JOIN events e ON e.id = l.id WHERE e.kind IN ('health', 'deploy') ORDER BY e.kind, e.source").all<{ kind: string; ring: string | null; source: string | null; summary: string }>();
    expect(latest.results).toEqual([
      { kind: "deploy", ring: null, source: null, summary: "no ring, no source" },
      { kind: "health", ring: "stable", source: "aarch64", summary: "other arch" },
      { kind: "health", ring: "stable", source: "x86_64", summary: "second" },
    ]);
  });
});

describe("the dashboard's reads", () => {
  it("stats and security answer from the journal and the latest-events table", async () => {
    const { default: worker } = await import("../src/index");
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    await env.DB.prepare("INSERT INTO events (kind, status, summary, payload) VALUES ('security', 'ok', '3 advisories matched', ?)")
      .bind(JSON.stringify({ arch_advisories: 2, debian_advisories: 1, osv_advisories: 0, run_at: "2026-09-16T05:30:04Z" })).run();
    const stats = await worker.fetch(new Request("http://pool.test/api/v1/stats"), env, ctx);
    expect(stats.status).toBe(200);
    const d = (await stats.json()) as { security: { advisories: number; updated_at: string }; latest: { kind: string }[] };
    expect(d.security).toEqual({ advisories: 3, updated_at: "2026-09-16T05:30:04Z" });
    expect(d.latest.some((e) => e.kind === "security")).toBe(true);
    expect(stats.headers.get("cache-control")).toBe("public, max-age=60");
    const cost = await worker.fetch(new Request("http://pool.test/api/v1/cost"), env, ctx);
    expect(cost.status).toBe(404);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('cost_latest', ?)").bind(JSON.stringify({ estimated_at: "2026-09-16T12:00:00Z", status: "ok", month: "2026-09", month_to_date_usd: 8.86, projected_usd: 17.5 })).run();
    const cost2 = (await (await worker.fetch(new Request("http://pool.test/api/v1/cost"), env, ctx)).json()) as { projected_usd: number; guard: string | null; lines_usd: { warn: number; guard: number; cap: number } };
    expect(cost2.projected_usd).toBe(17.5);
    expect(cost2.guard).toBeNull();
    expect(cost2.lines_usd).toEqual({ warn: 25, guard: 40, cap: 50 });
  });
});
