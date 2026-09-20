/**
 * The pool's names (src/meta.ts): a person's link moves and a machine's
 * name never does. The dashboard's old names and www redirect a page to
 * omarchy-pool.org with its path and query — 301 for a read, 308 for the
 * rest — and answer the API in place; pkgs.omarchy-pool.org and the old
 * pkgs.firemanxbr.org serve everything without a redirect, as the tests'
 * own pool.test does. A sign-in pressed on the API host starts over on the
 * dashboard. What a machine keeps — the setup script, the worker CLI, the
 * include's own comment — names the API host whichever production name it
 * was fetched from, and the edge cache keys one answer for all of them
 * (one copy per zone, the cache being the zone's).
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { AI_CRAWLERS, API_HOST, DASHBOARD_HOST, LEGACY_API_HOST, LEGACY_DASHBOARD_HOSTS, LEGACY_POOL_HOSTS, PRODUCTION_HOSTS, isProductionHost, machineOrigin } from "../src/meta";
import { ROBOTS_DISALLOW, SITEMAP_PATHS } from "../src/pages/robots";
import { DOCS_TREE } from "../src/pages/docs-tree";

async function fetchAt(origin: string, path: string, method = "GET"): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${origin}${path}`, { method }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const DASHBOARD = `https://${DASHBOARD_HOST}`;
const SERVING = [`https://${DASHBOARD_HOST}`, `https://${API_HOST}`, `https://${LEGACY_API_HOST}`, "http://pool.test"];

describe("the names", () => {
  it("say which are production and where a machine's text points", () => {
    expect(PRODUCTION_HOSTS).toEqual([DASHBOARD_HOST, API_HOST, LEGACY_API_HOST, ...LEGACY_DASHBOARD_HOSTS]);
    expect(LEGACY_DASHBOARD_HOSTS).toContain("www.omarchy-pool.org");
    expect(LEGACY_POOL_HOSTS).toEqual(["pool.firemanxbr.org"]);
    for (const h of PRODUCTION_HOSTS) expect(isProductionHost(h), h).toBe(true);
    for (const h of ["pool.test", "localhost", "pool.omarchy-pool.org", ...LEGACY_POOL_HOSTS]) expect(isProductionHost(h), h).toBe(false);
    // The origin a machine keeps: the API host on any production name, the request's own elsewhere.
    for (const h of PRODUCTION_HOSTS) expect(machineOrigin(new URL(`https://${h}/setup?x=1`)), h).toBe(`https://${API_HOST}`);
    expect(machineOrigin(new URL("http://pool.test/setup"))).toBe("http://pool.test");
    expect(machineOrigin(new URL("http://localhost:8787/api/v1/version"))).toBe("http://localhost:8787");
  });
});

describe("the dashboard's old names", () => {
  it("move a page to the dashboard with its path and query, and answer the API in place", async () => {
    for (const host of LEGACY_DASHBOARD_HOSTS) {
      const from = `https://${host}`;
      for (const [path, to] of [["/", "/"], ["/path?q=1", "/path?q=1"], ["/docs/get-started?ring=rc&arch=aarch64", "/docs/get-started?ring=rc&arch=aarch64"]]) {
        for (const method of ["GET", "HEAD"]) {
          const res = await fetchAt(from, path, method);
          expect(res.status, `${method} ${from}${path}`).toBe(301);
          expect(res.headers.get("location"), `${method} ${from}${path}`).toBe(`${DASHBOARD}${to}`);
        }
      }
      // Not a read: the method is kept by a client that follows.
      const post = await fetchAt(from, "/x", "POST");
      expect(post.status, `POST ${from}/x`).toBe(308);
      expect(post.headers.get("location"), `POST ${from}/x`).toBe(`${DASHBOARD}/x`);
      // A machine's call on the old dashboard name is answered, not moved.
      const api = await fetchAt(from, "/api/v1/version");
      expect(api.status, `${from}/api/v1/version`).toBe(200);
      expect(((await api.json()) as { version: string }).version).toBe("test");
    }
  });
});

describe("the serving names", () => {
  it("answer pages and the API with no redirect", async () => {
    for (const origin of SERVING) {
      const page = await fetchAt(origin, "/");
      expect(page.status, `${origin}/`).toBe(200);
      expect(page.headers.get("content-type"), `${origin}/`).toContain("text/html");
      const api = await fetchAt(origin, "/api/v1/version");
      expect(api.status, `${origin}/api/v1/version`).toBe(200);
      expect(api.headers.get("location"), `${origin}/api/v1/version`).toBeNull();
    }
  });

  it("send a sign-in pressed on the API host to the dashboard, before any cookie", async () => {
    for (const origin of [`https://${API_HOST}`, `https://${LEGACY_API_HOST}`]) {
      const res = await fetchAt(origin, "/auth/github?next=%2Fworkers");
      expect(res.status, origin).toBe(302);
      expect(res.headers.get("location"), origin).toBe(`${DASHBOARD}/auth/github?next=%2Fworkers`);
      expect(res.headers.get("set-cookie"), origin).toBeNull();
    }
    // On the dashboard itself, and off production, the sign-in starts: GitHub, with the state cookie.
    for (const origin of [DASHBOARD, "http://pool.test"]) {
      const res = await fetchAt(origin, "/auth/github?next=%2Fworkers");
      expect(res.status, origin).toBe(302);
      expect(res.headers.get("location"), origin).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
      expect(res.headers.get("location"), origin).toContain(encodeURIComponent(`${origin}/auth/github/callback`));
      expect(res.headers.get("set-cookie"), origin).toContain("omc_state=");
    }
  });
});

describe("what a machine keeps", () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO releases (id, ring, seq) VALUES (902, 'stable', 9)"),
      env.DB.prepare("INSERT INTO ring_heads (ring, release_id) VALUES ('stable', 902)"),
      env.DB.prepare("INSERT INTO release_artifacts (release_id, repo, arch, kind, r2_key, size) VALUES (902, 'omarchy-core-stable', 'x86_64', 'db', 'core/x86_64/omarchy-core-stable.db', 1)"),
    ]);
  });

  it("names the API host on every production name, and the request's own origin elsewhere", async () => {
    for (const origin of [DASHBOARD, `https://${API_HOST}`, `https://${LEGACY_API_HOST}`]) {
      const setup = await (await fetchAt(origin, "/setup")).text();
      expect(setup, `${origin}/setup`).toContain(`API="https://${API_HOST}/api/v1"`);
      expect(setup, `${origin}/setup`).toContain(`curl -fsSL https://${API_HOST}/setup | sudo bash -s -- --ring stable`);
      expect(setup, `${origin}/setup`).not.toContain(`${DASHBOARD}/`);
      const cli = await (await fetchAt(origin, "/omarchy-worker")).text();
      expect(cli, `${origin}/omarchy-worker`).toContain(`API="https://${API_HOST}"`);
      expect(cli, `${origin}/omarchy-worker`).not.toContain("__API__");
    }
    const local = await (await fetchAt("http://pool.test", "/setup")).text();
    expect(local).toContain('API="http://pool.test/api/v1"');
    expect(local).not.toContain(API_HOST);
    expect(await (await fetchAt("http://pool.test", "/omarchy-worker")).text()).toContain('API="http://pool.test"');
  });

  it("writes the API host into the include's own comment, and keys one edge answer for every name", async () => {
    const first = await fetchAt(DASHBOARD, "/api/v1/pacman.conf?ring=stable&arch=x86_64&with=hosts");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-pool-cache")).toBe("miss");
    expect(await first.text()).toContain(`# https://${API_HOST}/setup rewrites this file`);
    // The same answer, fetched on the other names, is the one stored under the API host: a hit, with the same text.
    for (const origin of [`https://${API_HOST}`, `https://${LEGACY_API_HOST}`, `https://${LEGACY_DASHBOARD_HOSTS[0]}`]) {
      const again = await fetchAt(origin, "/api/v1/pacman.conf?ring=stable&arch=x86_64&with=hosts");
      expect(again.status, origin).toBe(200);
      expect(again.headers.get("x-pool-cache"), origin).toBe("hit");
      expect(await again.text(), origin).toContain(`# https://${API_HOST}/setup rewrites this file`);
    }
    // Off production the include names the origin it was asked on, under its own key.
    const local = await fetchAt("http://pool.test", "/api/v1/pacman.conf?ring=stable&arch=x86_64&with=hosts");
    expect(local.headers.get("x-pool-cache")).toBe("miss");
    expect(await local.text()).toContain("# http://pool.test/setup rewrites this file");
  });
});

// What a crawler may read (src/pages/robots.ts): the dashboard's robots.txt keeps the pages open to search engines and closes the API, the sign-in and the reader's own pages to all, and the whole site to the AI crawlers by name; the API names deny everything; the sitemap lists the fixed pages under the dashboard's name; the API's answers and the sign-in say noindex themselves.
describe("what a crawler may read", () => {
  it("is said by robots.txt on every name: the dashboard's rules, the API name's one line", async () => {
    for (const origin of [DASHBOARD, "http://pool.test"]) {
      const res = await fetchAt(origin, "/robots.txt");
      expect(res.status, origin).toBe(200);
      expect(res.headers.get("content-type"), origin).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("cache-control"), origin).toContain("max-age=86400");
      const txt = await res.text();
      // Everyone: the API, the sign-in and the reader's own pages closed, the rest open — the package pages stay indexable.
      const everyone = txt.slice(txt.indexOf("User-agent: *"), txt.indexOf("Allow: /"));
      for (const p of ROBOTS_DISALLOW) expect(everyone, `${origin} ${p}`).toContain(`Disallow: ${p}\n`);
      for (const p of ["/api/", "/auth/", "/diff", "/build/", "/user/"]) expect(ROBOTS_DISALLOW).toContain(p);
      expect(everyone).not.toContain("Disallow: /package");
      expect(everyone).not.toContain("Disallow: /docs");
      expect(everyone).not.toContain("Disallow: /\n");
      expect(txt).toContain("Allow: /\n");
      // The AI crawlers, by name, one group closed whole.
      for (const ua of ["GoogleOther", "GPTBot", "ClaudeBot", "CCBot", "Bytespider", "Amazonbot", "meta-externalagent", "PerplexityBot", "Applebot-Extended"]) expect(AI_CRAWLERS, ua).toContain(ua);
      const ai = txt.slice(txt.indexOf(`User-agent: ${AI_CRAWLERS[0]}`));
      for (const ua of AI_CRAWLERS) expect(ai, ua).toContain(`User-agent: ${ua}\n`);
      expect(ai).toContain("Disallow: /\n");
      expect(ai).not.toContain("Allow: /");
      // The sitemap line names the sitemap this Worker serves.
      expect(txt).toContain(`Sitemap: https://${DASHBOARD_HOST}/sitemap.xml\n`);
    }
    for (const origin of [`https://${API_HOST}`, `https://${LEGACY_API_HOST}`]) {
      const res = await fetchAt(origin, "/robots.txt");
      expect(res.status, origin).toBe(200);
      const txt = await res.text();
      expect(txt, origin).toMatch(/^# [^\n]*\nUser-agent: \*\nDisallow: \/\n$/);
      expect(txt, origin).not.toContain("Allow: /");
      expect(txt, origin).not.toContain("Sitemap:");
    }
    // The dashboard's old names move it to the dashboard's copy, like any page.
    const moved = await fetchAt(`https://${LEGACY_DASHBOARD_HOSTS[0]}`, "/robots.txt");
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe(`${DASHBOARD}/robots.txt`);
  });

  it("lists the fixed pages in a sitemap under the dashboard's name, the docs chapters among them, no package page", async () => {
    for (const origin of [DASHBOARD, `https://${API_HOST}`, "http://pool.test"]) {
      const res = await fetchAt(origin, "/sitemap.xml");
      expect(res.status, origin).toBe(200);
      expect(res.headers.get("content-type"), origin).toBe("application/xml; charset=utf-8");
      const xml = await res.text();
      const base = origin === "http://pool.test" ? origin : DASHBOARD;
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'), origin).toBe(true);
      expect(xml.trimEnd().endsWith("</urlset>"), origin).toBe(true);
      const locs = [...xml.matchAll(/<url><loc>([^<]*)<\/loc><\/url>/g)].map((m) => m[1]);
      expect(locs, origin).toEqual(SITEMAP_PATHS.map((p) => `${base}${p}`));
      for (const c of DOCS_TREE) expect(locs, `${origin} ${c.key}`).toContain(`${base}${c.href}`);
      for (const p of ["/", "/docs", "/packages", "/security", "/status", "/factory", "/pipeline", "/people"]) expect(locs, `${origin} ${p}`).toContain(`${base}${p}`);
      expect(locs.some((l) => l.includes("/package/") || l.includes("/user/") || l.includes("/build/") || l.includes("/api/")), origin).toBe(false);
      // Well-formed: every tag closed, nothing unescaped.
      expect((xml.match(/<url>/g) ?? []).length).toBe((xml.match(/<\/url>/g) ?? []).length);
      expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    }
    // Every page the sitemap names is served.
    for (const p of SITEMAP_PATHS) expect((await fetchAt("http://pool.test", p)).status, p).toBe(200);
  });

  it("is said on the API's answers and on the sign-in: noindex, nofollow, and the header's link says nofollow", async () => {
    for (const path of ["/api/v1/stats", "/api/v1/version", "/api/v1/package/nothing-here?ring=stable&arch=x86_64"]) {
      const res = await fetchAt(DASHBOARD, path);
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
    }
    // A hit from the edge cache carries it as a miss does.
    const again = await fetchAt(DASHBOARD, "/api/v1/version");
    expect(again.headers.get("x-pool-cache")).toBe("hit");
    expect(again.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    for (const origin of [DASHBOARD, `https://${API_HOST}`, "http://pool.test"]) {
      const start = await fetchAt(origin, "/auth/github?next=%2F");
      expect(start.status, origin).toBe(302);
      expect(start.headers.get("x-robots-tag"), origin).toBe("noindex, nofollow");
    }
    const out = await fetchAt(DASHBOARD, "/auth/logout");
    expect(out.status).toBe(302);
    expect(out.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const page = await (await fetchAt(DASHBOARD, "/")).text();
    expect(page).toMatch(/<a id="account" href="\/auth\/github\?next=\/"[^>]*rel="nofollow">Sign in<\/a>/);
    expect(page).not.toContain('name="robots"');
  });
});
