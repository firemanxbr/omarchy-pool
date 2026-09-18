/**
 * The audience: one day of the pool's request analytics becomes one number
 * per ring and per architecture, recorded once as an event; one account
 * query names both names of the pool; a token without the account permission
 * is reported once for the day, not every ten minutes.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dailyAudience, measureAudience } from "../src/audience";
import type { Env } from "../src/index";
import { RINGS } from "../src/meta";

// Cloudflare's answer for one day: distinct addresses per alias, and the day's totals.
const ip = (n: number) => Array.from({ length: n }, (_, i) => ({ count: 3, dimensions: { clientIP: `10.0.0.${i}` } }));
const analytics = {
  data: { viewer: { accounts: [{
    totals: [{ count: 1234, sum: { edgeResponseBytes: 5_000_000_000 }, avg: { sampleInterval: 1 } }],
    all: ip(300), stable: ip(210), rc: ip(60), edge: ip(45), lab: ip(2), x86_64: ip(250), aarch64: ip(55),
  }] } },
};
const answer = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
const forbidden = { data: null, errors: [{ message: "Actor 'x' does not have permission 'com.cloudflare.api.account.analytics.read' for account a" }] };
const withAccount = { ...env, CLOUDFLARE_ANALYTICS_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", POOL_URL: "https://pool.test" } as unknown as Env;

describe("the audience", () => {
  it("counts distinct addresses per ring and per architecture for one day", async () => {
    const a = await measureAudience(withAccount, "2026-09-13", answer(analytics));
    expect(a).toEqual({ day: "2026-09-13", machines: 300, by_ring: { stable: 210, rc: 60, edge: 45, lab: 2 }, by_arch: { x86_64: 250, aarch64: 55 }, requests: 1234, bytes: 5_000_000_000, sampled: false });
  });

  it("asks the account once, for both names of the pool", async () => {
    // The pool has two names in two zones; the account scope spans them, so a machine that used both in a day is one address.
    let query = "";
    const capture = (async (_url: unknown, init?: RequestInit) => {
      query = (JSON.parse(String(init?.body)) as { query: string }).query;
      return new Response(JSON.stringify(analytics), { status: 200 });
    }) as unknown as typeof fetch;
    await measureAudience(withAccount, "2026-09-13", capture);
    expect(query).toContain('accounts(filter: {accountTag: "a"})');
    expect(query).toContain('clientRequestHTTPHost_in: ["pool.test","pool.firemanxbr.org"]');
    expect(query).not.toContain("zones(");
    expect(query.match(/clientRequestHTTPHost_in/g)).toHaveLength(RINGS.length + 4);
  });

  it("says what a token without the account permission is missing", async () => {
    await expect(measureAudience(withAccount, "2026-09-13", answer(forbidden))).rejects.toThrow(/Account · Analytics · Read/);
    await expect(measureAudience({ ...withAccount, CLOUDFLARE_ACCOUNT_ID: undefined } as unknown as Env, "2026-09-13")).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it("records yesterday once as an event, and a failure once for the day", async () => {
    const now = new Date("2026-09-14T00:40:00Z");
    expect(await dailyAudience(withAccount, now, answer(analytics))).toMatch(/^audience: 2026-09-13: about 300 machines/);
    expect(await dailyAudience(withAccount, now, answer(analytics))).toBe("audience: measured today");
    const ev = await env.DB.prepare("SELECT kind, status, summary, payload FROM events WHERE kind = 'audience'").all<{ kind: string; status: string; summary: string; payload: string }>();
    expect(ev.results).toHaveLength(1);
    expect(ev.results[0].status).toBe("ok");
    expect(JSON.parse(ev.results[0].payload).by_ring.stable).toBe(210);
    // The next day, without the permission: no event, reported once, then quiet.
    const later = new Date("2026-09-15T00:40:00Z");
    expect(await dailyAudience(withAccount, later, answer(forbidden))).toMatch(/not measured for 2026-09-14 — the analytics token needs Account/);
    expect(await dailyAudience(withAccount, later, answer(forbidden))).toBe("audience: measured today");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'audience'").first<{ n: number }>())?.n).toBe(1);
  });
});
