/** The glossary: the words on these pages, one line each; every term an anchor the search links to. */
import { page, termId } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import { GLOSSARY } from "./docs-tree";
import type { RunningVersion } from "../meta";
import { escapeHtml } from "../html";


const BODY = String.raw`
  <h1>Glossary</h1>
  <p class="lede">The words on these pages, one line each.</p>
  <dl class="gloss-list">${GLOSSARY.map(([term, text]) => `<dt id="${termId(term)}"><a href="#${termId(term)}">${escapeHtml(term)}</a></dt><dd>${escapeHtml(text)}</dd>`).join("")}</dl>
`;

export function glossaryHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/docs/glossary",
    title: "Glossary · Documentation · omarchy-pool",
    description: "The words on the omarchy-pool pages, one line each.",
    active: "docs",
    doc: "glossary",
    body: BODY,
    poolUrl,
    version,
  });
}

/** What /docs/glossary is made of: the shell, the lede and every term an anchor; nothing is read. */
export const GLOSSARY_COMPONENTS = (_F: Fixture): Component[] => {
  const page = "/docs/glossary";
  return [
    {
      // The sidebar lists the terms as this chapter's sections, and the search carries each term's anchor.
      id: "glossary.docs-shell",
      page,
      anchor: ['class="docs-side"', 'id="docs-q"', 'id="docs-hits"', 'id="docs-nav"', '<details open><summary><a href="/docs/glossary" class="on">Glossary</a>', ...GLOSSARY.map(([term]) => `href="/docs/glossary#${termId(term)}"`)],
      script: ['"#docs-q"', '"#docs-hits"', '"#docs-nav"', '"/docs/glossary#" + g[2]', ...GLOSSARY.map(([term]) => `"${termId(term)}"`)],
      visible: EVERYONE,
    },
    {
      id: "glossary.hero",
      page,
      anchor: ["<h1>Glossary</h1>", '<p class="lede">The words on these pages, one line each.</p>'],
      visible: EVERYONE,
    },
    {
      // Every term is an anchor the sidebar, the docs index and the search link to; a renamed term moves it.
      id: "glossary.list",
      page,
      anchor: ['<dl class="gloss-list">', ...GLOSSARY.map(([term]) => `<dt id="${termId(term)}"><a href="#${termId(term)}">${escapeHtml(term)}</a></dt>`)],
      visible: EVERYONE,
    },
  ];
};
