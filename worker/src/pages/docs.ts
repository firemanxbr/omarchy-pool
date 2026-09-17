/**
 * Documentation, the index: what each chapter answers, section by section,
 * inside the same shell every chapter uses (layout.ts docsShell) — the map
 * and the search beside the text, so opening a chapter changes the text,
 * never the page around it.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import { DOCS_TREE, GLOSSARY, MD_CHAPTERS, chapterOf, type DocKey, type MdChapter } from "./docs-tree";
import { termId } from "./layout";
import type { RunningVersion } from "../meta";
import { REPO_URL } from "../meta";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

const card = (c: (typeof DOCS_TREE)[number]) => {
  const secs = c.key === "glossary"
    ? GLOSSARY.map(([term]) => `<a href="${c.href}#${termId(term)}">${esc(term)}</a>`)
    : c.secs.map((s) => `<a href="${c.href}#${s.id}" title="${esc(s.blurb)}">${esc(s.title)}</a>`);
  return `<div class="doc-card"><h3><a href="${c.href}">${esc(c.label)} →</a></h3><p>${esc(c.blurb)}</p><div class="doc-secs">${secs.join("")}</div></div>`;
};
const POOL = DOCS_TREE.filter((c) => c.group === "pool").map(card).join("");
const CODE = DOCS_TREE.filter((c) => c.group === "code").map(card).join("");

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Documentation</p>
    <h1>The pool, chapter by chapter</h1>
    <p class="lede">Pick a chapter, or type what you are looking for — the map on the left is on every page of the documentation, and every section is one link. Everything is documented here, where it runs: how to use the pool and who decides what, and below, the code itself — its architecture, runbook, tests and the rest — for people working on the pool. The repository on <a href="${REPO_URL}">GitHub</a> is where the code lives and is released.</p>
  </div>
  <div class="doc-cards">${POOL}</div>
  <h2 style="margin:28px 0 12px">For people working on the pool</h2>
  <div class="doc-cards">${CODE}</div>
`;

export function docsHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Documentation · omarchy-pool",
    description: "How to use the pool, how to build for it, how it works and who decides what — one map, one search.",
    active: "docs",
    doc: "index",
    body: BODY,
    poolUrl,
    version,
  });
}

/**
 * What a chapter must carry beyond its title, its sections and its body: the
 * anchors other pages link to (a reworded heading breaks them without a
 * sound), the links written for the repository resolved to a chapter, a
 * dashboard page or the code on GitHub (doc.ts resolveLink), and the table
 * or the code block that is the chapter's substance.
 */
const CHAPTER_ANCHORS: Partial<Record<DocKey, string[]>> = {
  "omarchy-cli-mcp": ["<th>Tool</th><th>Arguments</th><th>Answers</th>", '<pre><code class="lang-json">', `href="${REPO_URL}/blob/main/docs/omarchy-cli.config.toml"`],
  // The score and who does what: /build and /packages link here.
  "what-we-test": ['id="the-score"', 'id="who-does-what"', "<th>The contributor's half</th><th>points</th><th>The maintainer's half</th><th>points</th>"],
  architecture: ['href="/docs/proof-of-concept#results"', 'href="/docs/omarchy-cli-mcp"', `href="${REPO_URL}/blob/main/docs/omarchy-cli.config.toml"`, "<th>Route</th><th>Purpose</th>", '<figure class="diagram">'],
  // Releasing the pool itself: Contributing and Testing link here.
  runbook: ['id="releasing-the-pool-itself"', 'href="/docs/architecture"', 'href="/docs/worker-host"', "<th>Service</th><th>Registration</th><th>Takes</th>", '<pre><code class="lang-bash">'],
  testing: ['href="/docs/runbook#releasing-the-pool-itself"', 'href="/docs/proof-of-concept#results"', "<th>File</th><th>What is covered</th>", '<pre><code class="lang-bash">'],
  migration: ['href="/docs/factory"', "<th>Placeholder</th><th>Meaning</th><th>Today</th>", '<pre><code class="lang-bash">'],
  // The Review link is written as a path climbed out of factory/: the dashboard's own page.
  factory: ['href="/review"', 'href="/docs/migration"', "<th>Check</th><th>What it asks</th><th>fail when</th>", '<pre><code class="lang-bash">', '<figure class="diagram">'],
  "worker-host": ['href="/docs/factory"', 'href="/docs/runbook"', "<th>File</th><th>What</th>", '<pre><code class="lang-bash">'],
  "security-model": ["<th>Credential</th><th>Held by</th><th>Can do</th><th>Cannot do</th><th>Status</th>", "<th>Who</th><th>Gets</th><th>How</th>"],
  contributing: ['href="/docs/runbook#releasing-the-pool-itself"', 'href="/docs/governance"', 'href="/docs/testing"', "<th>Change</th><th>Label on the pull request</th><th>Example</th>", '<pre><code class="lang-bash">'],
  // Results: poc/RESULTS.md became this section (doc.ts FILES); the crates are the code on GitHub.
  "proof-of-concept": ['id="results"', 'href="/docs/proof-of-concept#results"', `href="${REPO_URL}/tree/main/poc/crates/pkg-store"`, 'href="/docs/testing"', "<th>Command</th><th>Result</th>", '<figure class="diagram">'],
  // Findings to report upstream: docs/upstream/README.md became this section.
  "open-work": ['id="findings-to-report-upstream"', 'href="/docs/open-work#findings-to-report-upstream"', 'href="/docs/contributing"', 'href="/docs/proof-of-concept#results"'],
};

/** The figures the chapters draw (doc-diagrams.ts): each by the words its svg is labelled with, and its key in DOC_DIAGRAMS. */
const FIGURES: [key: string, chapter: DocKey, label: string][] = [
  ["publishing-layer", "architecture", "Six sources — Arch Linux"],
  ["release-promotion", "architecture", "A package published to the pool"],
  ["promotion-gates", "architecture", "The promote job"],
  ["release-pipeline", "architecture", "A pull request that ci.yml and e2e.yml passed"],
  ["thin-client-install", "architecture", "A request — omarchy-cli install, or check"],
  ["transaction-lifecycle", "proof-of-concept", "pkg-store's transaction in six stages"],
  ["benchmark-promotion", "proof-of-concept", "A bar chart on a log scale"],
  ["factory-loop", "factory", "What starts a build"],
];

/**
 * What /docs and the markdown chapters are made of. Nothing here reads the API:
 * the index and every chapter are rendered on the server, the same bytes
 * for every role, so the entries are anchors — the index's cards and the
 * shell around them, and per chapter its title, its sections, what other
 * pages link to, the links it resolves and the figures it draws.
 */
export const DOCS_COMPONENTS = (_F: Fixture): Component[] => {
  const cardTitle = (c: (typeof DOCS_TREE)[number]) => `<h3><a href="${c.href}">${c.label} →</a></h3>`;
  const chapter = (c: MdChapter): Component => ({
    id: `doc.${c.key}`,
    page: `/docs/${c.key}`,
    anchor: [
      `<title>${c.label} · Documentation · omarchy-pool</title>`,
      `<details open><summary><a href="/docs/${c.key}" class="on">${c.label}</a>`,
      `<h1>${c.label}</h1>`,
      '<div class="md">',
      // Every section the map names, as the rendering draws it: a heading with its own anchor.
      ...chapterOf(c.key)!.secs.map((s) => `<h2 id="${s.id}"><a class="anchor" href="#${s.id}">`),
      ...(CHAPTER_ANCHORS[c.key] ?? []),
    ],
    visible: EVERYONE,
  });
  return [
    {
      id: "docs.hero",
      page: "/docs",
      anchor: ['<p class="eyebrow">Documentation</p>', "<h1>The pool, chapter by chapter</h1>", `href="${REPO_URL}">GitHub</a>`],
      visible: EVERYONE,
    },
    {
      id: "docs.pool-cards",
      page: "/docs",
      // One card per chapter of the pool's group, its title a link; a section chip carries the blurb as its tooltip, a glossary chip is a term.
      anchor: ['<div class="doc-cards">', ...DOCS_TREE.filter((c) => c.group === "pool").map(cardTitle), 'href="/docs/get-started#which-ring" title="', 'href="/api#read" title="', 'href="/docs/glossary#term-ring">ring</a>'],
      visible: EVERYONE,
    },
    {
      id: "docs.code-heading",
      page: "/docs",
      anchor: [">For people working on the pool</h2>"],
      visible: EVERYONE,
    },
    {
      id: "docs.code-cards",
      page: "/docs",
      anchor: [...DOCS_TREE.filter((c) => c.group === "code").map(cardTitle), 'href="/docs/proof-of-concept#results" title="'],
      visible: EVERYONE,
    },
    {
      id: "docs.shell",
      page: "/docs",
      // The map beside the text (layout.ts docsShell) and the search over it: every chapter a summary, the index the one that is on.
      anchor: [
        '<aside class="docs-side">',
        '<a class="docs-home on" href="/docs">Documentation</a>',
        'id="docs-q"',
        'aria-label="search the docs"',
        'id="docs-hits"',
        'id="docs-nav"',
        'aria-label="Chapters"',
        '<div class="docs-group">For people working on the pool</div>',
        ...DOCS_TREE.map((c) => `<summary><a href="${c.href}">${c.label}</a>`),
        '<li><a href="/docs/get-started#which-ring">Which ring is for me?</a></li>',
        '<li><a href="/docs/glossary#term-ring">ring</a></li>',
        'class="docs-hint"',
      ],
      script: ['var q = $("#docs-q"), hits = $("#docs-hits"), nav = $("#docs-nav")', 'var TREE = [{"label":"', '"/docs/glossary#" + g[2]', "nothing in the docs says", 'e.key === "Escape"'],
      visible: EVERYONE,
    },
    {
      id: "docs.routes",
      page: "/docs",
      // The addresses: the index with or without its slash, and the three old ones that redirect into the docs.
      anchor: ['href="/docs/get-started"', 'href="/docs/how-it-works"', 'href="/docs/governance"'],
      reads: [
        { path: "/docs/", json: false },
        { path: "/get-started", status: 301, json: false },
        { path: "/how-it-works", status: 301, json: false },
        { path: "/governance", status: 301, json: false },
      ],
      visible: EVERYONE,
    },
    ...MD_CHAPTERS.map(chapter),
    ...FIGURES.map(([key, page, label]): Component => ({
      id: `fig.${key}`,
      page: `/docs/${page}`,
      anchor: [`role="img" aria-label="${label}`],
      drawn: `docs/${key}`,
      visible: EVERYONE,
    })),
  ];
};
