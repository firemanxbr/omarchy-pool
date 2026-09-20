/**
 * The sitemap: the pages worth an index, with no database behind the
 * list. robots.txt names it (pages/robots.ts); it lives apart from the
 * robots module because the docs map (docs-tree.ts) reads cost.ts, and
 * cost.ts reads AI_CRAWLERS — an import of the map from robots.ts would
 * close a cycle that leaves cost.ts's words undefined in the runbook.
 */
import { DOCS_TREE } from "./docs-tree";

/** The pages a search engine may list: the landing, the docs and every chapter of the map, the doors that are a page and not a reader's own. Package pages are found by the links, not listed here. */
export const SITEMAP_PATHS: readonly string[] = ["/", "/docs", ...DOCS_TREE.map((c) => c.href), "/packages", "/security", "/status", "/factory", "/pipeline", "/people"];

/** The sitemap: SITEMAP_PATHS under one origin — the dashboard's on production, the request's own elsewhere (the tests', a local wrangler). */
export function sitemapXml(origin: string): string {
  const url = (p: string) => `  <url><loc>${origin}${p}</loc></url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${SITEMAP_PATHS.map(url).join("\n")}\n</urlset>\n`;
}
