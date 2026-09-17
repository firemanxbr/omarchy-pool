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
export const GLOSSARY_COMPONENTS = (_F: Fixture): Component[] => {
  const page = "/docs/glossary";
  const everyone: Component["visible"] = ["anonymous", "contributor", "owner", "maintainer"];
  return [
    {
      // The sidebar lists the terms as this chapter's sections, and the search carries each term's anchor.
      id: "glossary.docs-shell",
      page,
      anchor: ['class="docs-side"', 'id="docs-q"', 'id="docs-hits"', 'id="docs-nav"', '<details open><summary><a href="/docs/glossary" class="on">Glossary</a>', ...GLOSSARY.map(([term]) => `href="/docs/glossary#${termId(term)}"`)],
      script: ['"#docs-q"', '"#docs-hits"', '"#docs-nav"', '"/docs/glossary#" + g[2]', ...GLOSSARY.map(([term]) => `"${termId(term)}"`)],
      visible: everyone,
    },
    {
      id: "glossary.hero",
      page,
      anchor: ["<h1>Glossary</h1>", '<p class="lede">The words on these pages, one line each.</p>'],
      visible: everyone,
    },
    {
      // Every term is an anchor the sidebar, the docs index and the search link to; a renamed term moves it.
      id: "glossary.list",
      page,
      anchor: ['<dl class="gloss-list">', ...GLOSSARY.map(([term]) => `<dt id="${termId(term)}"><a href="#${termId(term)}">${esc(term)}</a></dt>`)],
      visible: everyone,
    },
  ];
};
