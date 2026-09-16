/**
 * A chapter written in markdown (src/docs/*.md), rendered inside the docs
 * shell. Links written for the repository still land: another chapter's
 * file becomes that chapter, a diagram becomes the one the dashboard
 * serves, a source file becomes its page on GitHub, a dashboard path stays.
 */
import { page } from "./layout";
import { MD_CHAPTERS, type MdChapter } from "./docs-tree";
import { renderMarkdown } from "../markdown";
import { REPO_URL } from "../meta";
import type { RunningVersion } from "../meta";

/** Which chapter a repository file became. */
const FILES: Record<string, string> = {
  "docs/ARCHITECTURE.md": "/docs/architecture",
  "docs/RUNBOOK.md": "/docs/runbook",
  "docs/TESTING.md": "/docs/testing",
  "docs/MIGRATION.md": "/docs/migration",
  "docs/GOVERNANCE.md": "/docs/governance",
  "docs/omarchy-cli-mcp.md": "/docs/omarchy-cli-mcp",
  "docs/upstream/README.md": "/docs/open-work#findings-to-report-upstream",
  "factory/README.md": "/docs/factory",
  "factory/host/README.md": "/docs/worker-host",
  "SECURITY.md": "/docs/security-model",
  "CONTRIBUTING.md": "/docs/contributing",
  "TODO.md": "/docs/open-work",
  "poc/README.md": "/docs/proof-of-concept",
  "poc/RESULTS.md": "/docs/proof-of-concept#results",
  "README.md": `${REPO_URL}#readme`,
};

/** `a/b/../c` → `a/c`, from a directory; segments that climb past the root are dropped. */
function normalize(from: string, href: string): string {
  const parts = (from === "." ? [] : from.split("/")).concat(href.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

export function resolveLink(from: string, href: string): string {
  if (/^(https?:|mailto:|#|\/)/.test(href)) return href;
  const [target, frag] = href.split("#");
  const path = normalize(from, target);
  const tail = frag ? `#${frag}` : "";
  const chapter = FILES[path];
  if (chapter) return chapter.includes("#") && frag ? chapter.replace(/#.*$/, tail) : chapter + (chapter.includes("#") ? "" : tail);
  if (/\.svg$/.test(path)) return `/docs/diagrams/${path.split("/").pop()}`;
  // A path written from a page of the dashboard (../../review from factory/host): the dashboard's own page.
  if (!path.includes("/") && !/\./.test(path) && from !== ".") return `/${path}`;
  return `${REPO_URL}/${/\.[a-z0-9]+$/i.test(path) ? "blob" : "tree"}/main/${path}${tail}`;
}

export function docHtml(chapter: MdChapter, poolUrl: string, version: RunningVersion): string {
  const body = `<h1>${chapter.label}</h1>\n<div class="md">${renderMarkdown(chapter.text, { skipTitle: true, link: (h) => resolveLink(chapter.from, h) })}</div>`;
  return page({
    title: `${chapter.label} · Documentation · omarchy-pool`,
    description: chapter.text.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.slice(0, 160) ?? chapter.label,
    active: "docs",
    doc: chapter.key,
    body,
    poolUrl,
    version,
  });
}

/** The chapter at a docs path, if it is one written in markdown. */
export function mdChapterAt(path: string): MdChapter | undefined {
  const key = path.replace(/^\/docs\//, "");
  return MD_CHAPTERS.find((c) => c.key === key);
}
