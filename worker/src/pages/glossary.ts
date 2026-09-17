/** The glossary: the words on these pages, one line each; every term an anchor the search links to. */
import { page, termId } from "./layout";
import type { Component, Fixture } from "./components";
import { GLOSSARY } from "./docs-tree";
import type { RunningVersion } from "../meta";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

const BODY = String.raw`
  <h1>Glossary</h1>
  <p class="lede">The words on these pages, one line each.</p>
  <dl class="gloss-list">${GLOSSARY.map(([term, text]) => `<dt id="${termId(term)}"><a href="#${termId(term)}">${esc(term)}</a></dt><dd>${esc(text)}</dd>`).join("")}</dl>
`;

export function glossaryHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Glossary · Documentation · omarchy-pool",
    description: "The words on the omarchy-pool pages, one line each.",
    active: "docs",
    doc: "glossary",
    body: BODY,
    poolUrl,
    version,
  });
}

/** What /docs/glossary is made of, for test/components.test.ts — see components.ts. */
export const GLOSSARY_COMPONENTS = (_F: Fixture): Component[] => [];
