/**
 * What a crawler may read, said by the Worker itself: robots.txt on every
 * name it serves, and a sitemap of the pages worth an index. On 2026-09-19
 * an AI crawler (GoogleOther) fetched every package page of the zone, and
 * every one of them is a database read; Googlebot's few hundred a day are
 * wanted, since a package's page is what a person searches for. So the
 * dashboard's robots.txt keeps the landing, the docs and the package pages
 * open to search engines, closes the API, the sign-in and the pages that
 * are only a reader's own to everyone, and closes the whole site to the
 * AI and research crawlers by name. The API host has no page for an index:
 * everything on it is denied. The bucket (pool.omarchy-pool.org) runs no
 * code; its robots.txt is an object at its root (Runbook, Costs).
 * robots.txt is a request, not a wall — the WAF rule on the zone is the
 * wall (Runbook, Costs) — and takes effect when the crawler next reads it.
 */
import { AI_CRAWLERS, API_HOST, DASHBOARD_HOST, LEGACY_API_HOST } from "../meta";
import { DOCS_TREE } from "./docs-tree";

/** The paths no crawler indexes: the API, the sign-in, and what is a reader's own or a machine's — not a page for a search. */
export const ROBOTS_DISALLOW: readonly string[] = ["/api/", "/auth/", "/me", "/diff", "/review", "/request", "/build/", "/user/", "/pool/", "/setup", "/omarchy-worker"];

/** The pages a search engine may list, with no database behind the list: the landing, the docs and every chapter of the map, the doors that are a page and not a reader's own. Package pages are found by the links, not listed here. */
export const SITEMAP_PATHS: readonly string[] = ["/", "/docs", ...DOCS_TREE.map((c) => c.href), "/packages", "/security", "/status", "/factory", "/pipeline", "/people"];

/** robots.txt for the name it was asked on: the dashboard's rules, or the API name's one line. */
export function robotsTxt(host: string): string {
  if (host === API_HOST || host === LEGACY_API_HOST) return `# The API name: nothing here is for an index; the pages live on https://${DASHBOARD_HOST}\nUser-agent: *\nDisallow: /\n`;
  return [
    "# omarchy-pool: the landing, the docs and the package pages may be indexed;",
    "# the API, sign-in, diffs, per-release listings and people's pages are not for crawlers.",
    "User-agent: *",
    ...ROBOTS_DISALLOW.map((p) => `Disallow: ${p}`),
    "Allow: /",
    "",
    "# AI and research crawlers: every package page costs a database read; not here.",
    ...AI_CRAWLERS.map((ua) => `User-agent: ${ua}`),
    "Disallow: /",
    "",
    `Sitemap: https://${DASHBOARD_HOST}/sitemap.xml`,
  ].join("\n") + "\n";
}

/** The sitemap: SITEMAP_PATHS under one origin — the dashboard's on production, the request's own elsewhere (the tests', a local wrangler). */
export function sitemapXml(origin: string): string {
  const url = (p: string) => `  <url><loc>${origin}${p}</loc></url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${SITEMAP_PATHS.map(url).join("\n")}\n</urlset>\n`;
}
