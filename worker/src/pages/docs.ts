/**
 * Documentation, the index: what each chapter answers, section by section,
 * inside the same shell every chapter uses (layout.ts docsShell) — the map
 * and the search beside the text, so opening a chapter changes the text,
 * never the page around it.
 */
import { page } from "./layout";
import { DOCS_TREE, GLOSSARY } from "./docs-tree";
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
