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
 *
 * This module imports meta.ts only: cost.ts reads AI_CRAWLERS for the
 * read guard, and the docs map (docs-tree.ts) reads cost.ts, so an import
 * of a page module here would close a cycle. The sitemap the robots.txt
 * names is pages/sitemap.ts for that reason.
 */
import { API_HOST, DASHBOARD_HOST, LEGACY_API_HOST } from "../meta";

/** The AI and research crawlers by their robots.txt token (Cloudflare Radar categories AI Crawler and AI Search, September 2026); the read guard names the same list. */
export const AI_CRAWLERS: readonly string[] = [
  "GoogleOther", "GoogleOther-Image", "GoogleOther-Video", "Google-Extended",
  "GPTBot", "ChatGPT-User", "OAI-SearchBot",
  "ClaudeBot", "Claude-User", "Claude-SearchBot", "anthropic-ai",
  "CCBot", "Bytespider", "Amazonbot", "meta-externalagent", "meta-externalfetcher",
  "PerplexityBot", "Perplexity-User", "Applebot-Extended", "cohere-ai", "Diffbot",
  "ImagesiftBot", "omgili", "omgilibot", "YouBot", "PetalBot", "Timpibot", "DuckAssistBot", "MistralAI-User",
];

/** The paths no crawler indexes: the API, the sign-in, and what is a reader's own or a machine's — not a page for a search. */
export const ROBOTS_DISALLOW: readonly string[] = ["/api/", "/auth/", "/me", "/diff", "/review", "/request", "/build/", "/user/", "/pool/", "/setup", "/omarchy-worker"];

/** robots.txt for the name it was asked on: the dashboard's rules, or the API name's one line. The Sitemap line names what pages/sitemap.ts serves. */
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
