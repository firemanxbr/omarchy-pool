/**
 * The read guard (src/cost.ts readGuard): while the cost guard is up, an
 * anonymous machine reading a package page or its data gets a 503 that
 * says when to come back and that nothing keeps; a person, a signed-in
 * reader, a search engine, the pool's own clients and every other read
 * pass — and with the guard down, nothing changes at all. The write pause
 * (scheduler.test.ts) is the same setting's other half.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { OWN_CLIENTS, forgetGuardWord, machineReader } from "../src/cost";
import { AI_CRAWLERS } from "../src/meta";
import { seedDashboard, type Fixture } from "./fixture";

const CURL = "curl/8.7.1";
const BROWSER = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

async function get(path: string, headers: Record<string, string> = {}, cf?: Record<string, unknown>): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`, { headers, ...(cf ? { cf } : {}) } as RequestInit), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function raise(): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('cost_guard', 'over the US$ 40 guard: jobs that write are paused') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
  forgetGuardWord();
}

async function lower(): Promise<void> {
  await env.DB.prepare("DELETE FROM settings WHERE key = 'cost_guard'").run();
  forgetGuardWord();
}

let F: Fixture;
beforeAll(async () => {
  F = await seedDashboard(env);
});
afterAll(lower);

describe("the read guard", () => {
  it("knows a machine from a person, and the pool's own clients from a machine", () => {
    const ua = (s: string | null, cf?: Record<string, unknown>) => machineReader(new Request("http://pool.test/", { headers: s === null ? {} : { "user-agent": s }, ...(cf ? { cf } : {}) } as RequestInit));
    expect(ua(BROWSER)).toBe(false);
    expect(ua(CURL)).toBe(true);
    expect(ua(null)).toBe(true);
    expect(ua("")).toBe(true);
    expect(ua("python-requests/2.32")).toBe(true);
    for (const c of AI_CRAWLERS) expect(ua(`Mozilla/5.0 (compatible; ${c}/1.0; +https://example.invalid/bot)`)).toBe(true);
    for (const p of OWN_CLIENTS) expect(ua(`${p}0.1.0`)).toBe(false);
    // Cloudflare's word, when it has one: a search engine's crawler reads on; any other verified bot is a machine, whatever it wears.
    expect(ua(BROWSER, { verifiedBotCategory: "AI Crawler" })).toBe(true);
    expect(ua("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", { verifiedBotCategory: "Search Engine Crawler" })).toBe(false);
    expect(ua(CURL, { verifiedBotCategory: "Search Engine Crawler" })).toBe(false);
  });

  it("sheds an anonymous machine's read of a package's data while the guard is up, with an hour's retry-after and nothing kept", async () => {
    await raise();
    const res = await get(`/api/v1/package/${F.pkg}`, { "user-agent": CURL });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("3600");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("x-pool-cache")).toBeNull();
    const body = await res.json<{ error: string; guard: string }>();
    expect(body.error).toContain("over its monthly budget");
    expect(body.guard).toContain("over the US$ 40 guard");
    // The shed answer was never stored: the next request, a browser's, is a real answer.
    const person = await get(`/api/v1/package/${F.pkg}`, { "user-agent": BROWSER });
    expect(person.status).toBe(200);
    expect(person.headers.get("x-pool-cache")).toBe("miss");
    expect((await person.json<{ name: string }>()).name).toBe(F.pkg);
  });

  it("sheds the package page the same way, in one line of html a person on a bare client can read", async () => {
    await raise();
    const res = await get(`/package/${F.pkg}`, { "user-agent": CURL });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("3600");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("over its monthly budget");
    expect((await get(`/package/${F.pkg}`, { "user-agent": BROWSER })).status).toBe(200);
  });

  it("lets a person, a signed-in reader, a token, the pool's own clients and a search engine through while the guard is up", async () => {
    await raise();
    const path = `/api/v1/package/${F.pkg}`;
    expect((await get(path, { "user-agent": BROWSER })).status).toBe(200);
    expect((await get(path, { "user-agent": CURL, cookie: `omc=${F.sessions.contributor}` })).status).toBe(200);
    expect((await get(path, { "user-agent": CURL, authorization: "Bearer omc_nobody" })).status).toBe(200);
    expect((await get(path, { "user-agent": "omarchy-cli/0.3.0" })).status).toBe(200);
    expect((await get(path, { "user-agent": "pkg-repo/0.1.0" })).status).toBe(200);
    expect((await get(path, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" }, { verifiedBotCategory: "Search Engine Crawler" })).status).toBe(200);
    expect((await get(`/package/${F.pkg}`, { "user-agent": CURL, cookie: `omc=${F.sessions.contributor}` })).status).toBe(200);
  });

  it("closes only the package page and its data: the file list, the graph, the search and every other read stay open to a machine", async () => {
    await raise();
    for (const path of [`/api/v1/package/${F.pkg}/files`, `/api/v1/graph?targets=${F.pkg}&ring=stable`, `/api/v1/search?q=${F.pkg}`, "/api/v1/version", "/api/v1/pacman.conf", "/", "/packages", "/docs", "/status", "/setup"]) {
      const res = await get(path, { "user-agent": CURL });
      expect(res.status, path).toBe(200);
    }
  });

  it("touches nothing while the guard is down", async () => {
    await lower();
    for (const path of [`/api/v1/package/${F.pkg}`, `/package/${F.pkg}`]) {
      const res = await get(path, { "user-agent": CURL });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("retry-after")).toBeNull();
    }
    expect((await get(`/api/v1/package/${F.pkg}`, { "user-agent": "" })).status).toBe(200);
  });

  it("reads the guard word once a minute, not once a request", async () => {
    await raise();
    expect((await get(`/api/v1/package/${F.pkg}`, { "user-agent": CURL })).status).toBe(503);
    // The row goes, the memo does not: within the minute the guard is still the word it read.
    await env.DB.prepare("DELETE FROM settings WHERE key = 'cost_guard'").run();
    expect((await get(`/api/v1/package/${F.pkg}`, { "user-agent": CURL })).status).toBe(503);
    forgetGuardWord();
    expect((await get(`/api/v1/package/${F.pkg}`, { "user-agent": CURL })).status).toBe(200);
  });
});
