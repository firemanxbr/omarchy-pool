/**
 * The documentation's markdown, rendered by the dashboard. A small, exact
 * subset — what the chapters use: headings (with anchors), paragraphs,
 * emphasis, code spans and fenced blocks, links and images, ordered and
 * unordered lists (nested by indent), tables, quotes, rules. An image whose
 * target is `diagram:<name>` is a figure the dashboard draws on the server
 * (pages/doc-diagrams.ts), its text the caption. Nothing else is
 * interpreted; text is escaped. `outline` reads the same headings for the
 * map beside the text (docs-tree.ts).
 */

export interface Heading {
  level: number;
  id: string;
  title: string;
}

export interface RenderOptions {
  /** Turns a link's target as written into the one served: chapters for chapter files, GitHub for code, the dashboard for its pages. */
  link?: (href: string) => string;
  /** Rendered headings drop the document's own title (level 1); the page draws it. */
  skipTitle?: boolean;
  /** The figure drawn for `![caption](diagram:<name>)`, as inline SVG; a name nothing draws leaves the image as written, which the tests catch. */
  figure?: (name: string) => string | undefined;
}

/** The sentinel that keeps a code span out of the inline passes: a character no document contains. */
const HOLD = String.fromCharCode(1);
const HOLD_RE = new RegExp(`${HOLD}(\\d+)${HOLD}`, "g");

export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/`/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "section"
  );
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/** A heading's text without its markup: what the anchor and the map use. */
function plain(s: string): string {
  return s.replace(/`/g, "").replace(/\*\*?/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

/** Inline markdown: code spans are protected first, then images, links, strong, emphasis. */
function inline(text: string, link: (h: string) => string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `${HOLD}${codes.length - 1}${HOLD}`;
  });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt: string, src: string) => `<img src="${esc(link(src))}" alt="${alt}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => `<a href="${esc(link(href))}">${label}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, "$1<em>$2</em>");
  return s.replace(HOLD_RE, (_, i: string) => codes[Number(i)]);
}

/** Every heading of a document, in order, with the anchors the rendering gives them (a repeated title gets a number). */
export function outline(md: string): Heading[] {
  const out: Heading[] = [];
  const seen = new Map<string, number>();
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const title = plain(m[2]);
    let id = slug(title);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n) id = `${id}-${n + 1}`;
    out.push({ level: m[1].length, id, title });
  }
  return out;
}

/** The document's first paragraph, as plain text — what the map shows for a chapter. */
export function lead(md: string): string {
  let fence = false;
  const para: string[] = [];
  for (const line of md.split("\n")) {
    if (/^```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || /^#/.test(line) || /^!\[/.test(line) || /^\s*[|>]/.test(line)) continue;
    if (!line.trim()) {
      if (para.length) break;
      continue;
    }
    para.push(line.trim());
  }
  return plain(para.join(" "));
}

/** The text under a heading (to the next heading of its level or higher), as plain text, cut to `max` characters — what the search matches for a section. */
export function sectionText(md: string, id: string, max = 220): string {
  const heads = outline(md);
  const at = heads.findIndex((h) => h.id === id);
  if (at < 0) return "";
  const lines = md.split("\n");
  let seen = -1;
  let fence = false;
  const body: string[] = [];
  for (const line of lines) {
    if (/^```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = /^(#{1,4})\s/.exec(line);
    if (m) {
      seen++;
      if (seen > at && m[1].length <= heads[at].level) break;
      continue;
    }
    if (seen === at && line.trim() && !/^\s*[|>]/.test(line) && !/^!\[/.test(line)) body.push(line.trim().replace(/^([-*]|\d+\.)\s+/, ""));
  }
  const t = plain(body.join(" ")).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : t;
}

export function renderMarkdown(md: string, opts: RenderOptions = {}): string {
  const link = opts.link ?? ((h: string) => h);
  const lines = md.split("\n");
  const out: string[] = [];
  const ids = new Map<string, number>();
  const para: string[] = [];
  let i = 0;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "), link)}</p>`);
    para.length = 0;
  };
  const isItem = (l: string) => /^(\s*)([-*]|\d+\.)\s+/.exec(l);

  /** A list from `lines[i]` on: items at one indent, a nested list at a deeper one, continuation lines joined to their item. */
  function list(): string {
    const first = isItem(lines[i])!;
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const items: string[] = [];
    while (i < lines.length) {
      const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
      if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
      let text = m[3];
      let nested = "";
      i++;
      while (i < lines.length) {
        const l = lines[i];
        const sub = isItem(l);
        if (sub && sub[1].length > indent) {
          nested += list();
          continue;
        }
        if (sub) break;
        if (!l.trim()) {
          // A blank line ends the item — unless the list goes on after it (a loose list) or the item does (an indented line).
          const next = lines[i + 1] ?? "";
          const nextItem = isItem(next);
          if ((nextItem && nextItem[1].length >= indent) || (/^\s{2,}\S/.test(next) && !nextItem)) {
            i++;
            continue;
          }
          break;
        }
        if (/^#|^```|^\s*\||^\s*>/.test(l)) break;
        text += " " + l.trim();
        i++;
      }
      items.push(`<li>${inline(text, link)}${nested}</li>`);
    }
    return `<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`;
  }

  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ""}>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      let id = slug(plain(h[2]));
      const n = ids.get(id) ?? 0;
      ids.set(id, n + 1);
      if (n) id = `${id}-${n + 1}`;
      i++;
      if (level === 1 && opts.skipTitle) continue;
      out.push(`<h${level} id="${id}"><a class="anchor" href="#${id}">${inline(h[2], link)}</a></h${level}>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(c.trim(), link));
      const head = cells(line);
      i += 2;
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(`<tr>${cells(lines[i++]).map((c) => `<td>${c}</td>`).join("")}</tr>`);
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(q.join("\n"), opts)}</blockquote>`);
      continue;
    }
    if (isItem(line)) {
      flush();
      out.push(list());
      continue;
    }
    const img = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line);
    if (img) {
      flush();
      const drawn = img[2].startsWith("diagram:") ? opts.figure?.(img[2].slice("diagram:".length)) : undefined;
      out.push(drawn ? `<figure class="diagram">${drawn}<figcaption>${inline(img[1], link)}</figcaption></figure>` : `<figure class="doc-figure"><img src="${esc(link(img[2]))}" alt="${esc(img[1])}"></figure>`);
      i++;
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join("\n");
}
