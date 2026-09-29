/**
 * The v1 kit (#238, #239): the pieces the v1.0 pages are drawn with, taken
 * from the handoff's prototype (design/Hi-fi v1.0.dc.html) once, here, so
 * the page pull requests share one set instead of each inventing its own.
 * Nothing uses it yet: a page adopts it when its own issue lands, by
 * passing kit: true to page(), and declares what it draws in its own
 * manifest entry (components.ts). A page that has not adopted it pays
 * nothing for it — no request, no bytes — and looks the same.
 *
 * Three parts:
 * - KIT_CSS, the primitives (documented where they are declared): tokens
 *   only, square, 1px lines, no shadow, no gradient. A kit page links them
 *   after the frame's CSS.
 * - The icons: the Lucide icons the whole prototype draws (lucide-static
 *   0.400.0, ISC) and the agents' marks it shows (@lobehub/icons-static-svg
 *   1.95.1, MIT; the marks stay their owners' trademarks), as the SVG files
 *   in src/assets/icons/ with their licences beside them. lucide() and
 *   agentMark() write an empty element the CSS paints: a mask in
 *   currentColor for an icon and a one-colour mark, the mark itself for a
 *   coloured one. The shell's script has the same two functions (KIT_HELPERS),
 *   so a row a page draws in the browser is the row the server would write.
 * - KIT_HELPERS, spliced into a kit page's script: the two above, countUp()
 *   for a number that lands, and the copy button of a code well.
 *
 * The primitives and the shapes travel in one stylesheet,
 * /assets/kit.<hash>.css, every icon a data: URI in it, and not as a file
 * per icon or inline in every page: an icon per request would be a Worker
 * invocation per icon per first visit, and the sheet inline would add its
 * weight to every page view (pages are cached for a minute; the sheet for a
 * year). The name carries a hash of the content, so the sheet is immutable
 * — a browser asks for it once per change of the kit, and no request ever
 * reads D1.
 */
import { escapeHtml } from "../html";
import activitySvg from "../assets/icons/lucide/activity.svg";
import arrowDownToLineSvg from "../assets/icons/lucide/arrow-down-to-line.svg";
import arrowUpFromLineSvg from "../assets/icons/lucide/arrow-up-from-line.svg";
import arrowUpRightSvg from "../assets/icons/lucide/arrow-up-right.svg";
import badgeCheckSvg from "../assets/icons/lucide/badge-check.svg";
import banSvg from "../assets/icons/lucide/ban.svg";
import binarySvg from "../assets/icons/lucide/binary.svg";
import bookOpenSvg from "../assets/icons/lucide/book-open.svg";
import botSvg from "../assets/icons/lucide/bot.svg";
import bracesSvg from "../assets/icons/lucide/braces.svg";
import calendarSvg from "../assets/icons/lucide/calendar.svg";
import circleCheckSvg from "../assets/icons/lucide/circle-check.svg";
import circleSlashSvg from "../assets/icons/lucide/circle-slash.svg";
import clipboardCheckSvg from "../assets/icons/lucide/clipboard-check.svg";
import copySvg from "../assets/icons/lucide/copy.svg";
import cpuSvg from "../assets/icons/lucide/cpu.svg";
import databaseSvg from "../assets/icons/lucide/database.svg";
import downloadSvg from "../assets/icons/lucide/download.svg";
import eyeSvg from "../assets/icons/lucide/eye.svg";
import factorySvg from "../assets/icons/lucide/factory.svg";
import fileArchiveSvg from "../assets/icons/lucide/file-archive.svg";
import fileCodeSvg from "../assets/icons/lucide/file-code.svg";
import fileJsonSvg from "../assets/icons/lucide/file-json.svg";
import fileSearchSvg from "../assets/icons/lucide/file-search.svg";
import fileTextSvg from "../assets/icons/lucide/file-text.svg";
import flaskConicalSvg from "../assets/icons/lucide/flask-conical.svg";
import folderTreeSvg from "../assets/icons/lucide/folder-tree.svg";
import gitCommitHorizontalSvg from "../assets/icons/lucide/git-commit-horizontal.svg";
import gitCompareSvg from "../assets/icons/lucide/git-compare.svg";
import gitForkSvg from "../assets/icons/lucide/git-fork.svg";
import gitPullRequestSvg from "../assets/icons/lucide/git-pull-request.svg";
import githubSvg from "../assets/icons/lucide/github.svg";
import globeSvg from "../assets/icons/lucide/globe.svg";
import hammerSvg from "../assets/icons/lucide/hammer.svg";
import hardDriveSvg from "../assets/icons/lucide/hard-drive.svg";
import heartPulseSvg from "../assets/icons/lucide/heart-pulse.svg";
import inboxSvg from "../assets/icons/lucide/inbox.svg";
import infoSvg from "../assets/icons/lucide/info.svg";
import keyRoundSvg from "../assets/icons/lucide/key-round.svg";
import layersSvg from "../assets/icons/lucide/layers.svg";
import listChecksSvg from "../assets/icons/lucide/list-checks.svg";
import lockSvg from "../assets/icons/lucide/lock.svg";
import octagonXSvg from "../assets/icons/lucide/octagon-x.svg";
import packageSvg from "../assets/icons/lucide/package.svg";
import packageCheckSvg from "../assets/icons/lucide/package-check.svg";
import plugSvg from "../assets/icons/lucide/plug.svg";
import refreshCwSvg from "../assets/icons/lucide/refresh-cw.svg";
import scaleSvg from "../assets/icons/lucide/scale.svg";
import scrollTextSvg from "../assets/icons/lucide/scroll-text.svg";
import searchSvg from "../assets/icons/lucide/search.svg";
import sendSvg from "../assets/icons/lucide/send.svg";
import shieldSvg from "../assets/icons/lucide/shield.svg";
import shieldCheckSvg from "../assets/icons/lucide/shield-check.svg";
import sunMoonSvg from "../assets/icons/lucide/sun-moon.svg";
import tagSvg from "../assets/icons/lucide/tag.svg";
import terminalSvg from "../assets/icons/lucide/terminal.svg";
import textSvg from "../assets/icons/lucide/text.svg";
import userSvg from "../assets/icons/lucide/user.svg";
import userCheckSvg from "../assets/icons/lucide/user-check.svg";
import usersSvg from "../assets/icons/lucide/users.svg";
import wrenchSvg from "../assets/icons/lucide/wrench.svg";
import zapSvg from "../assets/icons/lucide/zap.svg";
import claudeColorSvg from "../assets/icons/agents/claude-color.svg";
import openaiSvg from "../assets/icons/agents/openai.svg";
import cursorSvg from "../assets/icons/agents/cursor.svg";
import geminiColorSvg from "../assets/icons/agents/gemini-color.svg";
import githubcopilotSvg from "../assets/icons/agents/githubcopilot.svg";
import grokSvg from "../assets/icons/agents/grok.svg";
import opencodeSvg from "../assets/icons/agents/opencode.svg";
import qwenColorSvg from "../assets/icons/agents/qwen-color.svg";
import kimiSvg from "../assets/icons/agents/kimi.svg";
import metaColorSvg from "../assets/icons/agents/meta-color.svg";

/**
 * Every Lucide icon the prototype draws, by its Lucide name: the ones in its
 * markup and the ones its script picks (the docs chapters, the palette's
 * actions, the package page's stages, fields, gates and facts). The
 * prototype's git-commit is not in lucide-static 0.400.0 (its edge icon
 * was blank there); git-commit-horizontal is that icon's name in this
 * release.
 */
export const LUCIDE = {
  activity: activitySvg,
  "arrow-down-to-line": arrowDownToLineSvg,
  "arrow-up-from-line": arrowUpFromLineSvg,
  "arrow-up-right": arrowUpRightSvg,
  "badge-check": badgeCheckSvg,
  ban: banSvg,
  binary: binarySvg,
  "book-open": bookOpenSvg,
  bot: botSvg,
  braces: bracesSvg,
  calendar: calendarSvg,
  "circle-check": circleCheckSvg,
  "circle-slash": circleSlashSvg,
  "clipboard-check": clipboardCheckSvg,
  copy: copySvg,
  cpu: cpuSvg,
  database: databaseSvg,
  download: downloadSvg,
  eye: eyeSvg,
  factory: factorySvg,
  "file-archive": fileArchiveSvg,
  "file-code": fileCodeSvg,
  "file-json": fileJsonSvg,
  "file-search": fileSearchSvg,
  "file-text": fileTextSvg,
  "flask-conical": flaskConicalSvg,
  "folder-tree": folderTreeSvg,
  "git-commit-horizontal": gitCommitHorizontalSvg,
  "git-compare": gitCompareSvg,
  "git-fork": gitForkSvg,
  "git-pull-request": gitPullRequestSvg,
  github: githubSvg,
  globe: globeSvg,
  hammer: hammerSvg,
  "hard-drive": hardDriveSvg,
  "heart-pulse": heartPulseSvg,
  inbox: inboxSvg,
  info: infoSvg,
  "key-round": keyRoundSvg,
  layers: layersSvg,
  "list-checks": listChecksSvg,
  lock: lockSvg,
  "octagon-x": octagonXSvg,
  package: packageSvg,
  "package-check": packageCheckSvg,
  plug: plugSvg,
  "refresh-cw": refreshCwSvg,
  scale: scaleSvg,
  "scroll-text": scrollTextSvg,
  search: searchSvg,
  send: sendSvg,
  shield: shieldSvg,
  "shield-check": shieldCheckSvg,
  "sun-moon": sunMoonSvg,
  tag: tagSvg,
  terminal: terminalSvg,
  text: textSvg,
  user: userSvg,
  "user-check": userCheckSvg,
  users: usersSvg,
  wrench: wrenchSvg,
  zap: zapSvg,
} as const;
export type LucideName = keyof typeof LUCIDE;

/**
 * The agents' marks the prototype shows (its AGENTS list), by their file
 * name in lobe-icons: a coloured mark is drawn as it is, a one-colour mark
 * in the text's colour — the prototype's img and mask. A coloured mark is
 * drawn on both themes' surfaces, so none may paint in white or black:
 * Kimi's coloured file draws its K in white, which vanished on a light page
 * (a blue dot was all that showed), so Kimi is its one-colour file. The
 * agent's name (Claude Code, Codex …) is the caller's: it is what the
 * reader sees on hover and what a screen reader says.
 */
export const AGENT_MARKS = {
  "claude-color": { svg: claudeColorSvg, color: true },
  openai: { svg: openaiSvg, color: false },
  cursor: { svg: cursorSvg, color: false },
  "gemini-color": { svg: geminiColorSvg, color: true },
  githubcopilot: { svg: githubcopilotSvg, color: false },
  grok: { svg: grokSvg, color: false },
  opencode: { svg: opencodeSvg, color: false },
  "qwen-color": { svg: qwenColorSvg, color: true },
  kimi: { svg: kimiSvg, color: false },
  "meta-color": { svg: metaColorSvg, color: true },
} as const;
export type AgentMark = keyof typeof AGENT_MARKS;

/** A size other than the default rides on the element as --op-i-s; the attribute is only ever a number of pixels. */
function sized(size: number, fallback: number): string {
  const px = Number(size);
  return Number.isFinite(px) && px > 0 && px !== fallback ? ` style="--op-i-s:${px}px"` : "";
}

/**
 * An icon, as the server writes one: 14 px unless told (the prototype draws
 * 13 to 16, 18 in the search box and 26 in a package's square), in the
 * colour of the text around it. Without a label it is decoration and hidden
 * from screen readers; with one it is an image that says the label. The
 * shell's lucide() writes the same element (test/kit.test.ts holds them to
 * each other).
 */
export function lucide(name: LucideName, size = 14, label?: string): string {
  return `<i class="op-i op-i-${escapeHtml(name)}"${sized(size, 14)}${label ? ` role="img" aria-label="${escapeHtml(label)}"` : ' aria-hidden="true"'}></i>`;
}

/** An agent's mark, 16 px unless told, named by the agent it stands for. The shell's agentMark() writes the same element. */
export function agentMark(mark: AgentMark, label: string, size = 16): string {
  return `<i class="op-b op-b-${escapeHtml(mark)}"${sized(size, 16)} role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"></i>`;
}

/**
 * An SVG file as a data: URI a stylesheet can hold: the licence comment,
 * the title and the root's size and styling go (the sheet's header carries
 * the licences; the element's CSS gives the size), whitespace is collapsed,
 * double quotes become single ones, and what a URI or a CSS string cannot
 * hold as it is — %, #, <, >, anything outside printable ASCII — is
 * percent-encoded.
 */
export function svgUri(svg: string): string {
  const clean = svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/<svg\b[^>]*>/, (root) => root.replace(/\s(?:class|style|width|height)="[^"]*"/g, ""))
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .replace(/\s+(\/?>)/g, "$1")
    .trim()
    .replace(/"/g, "'");
  return "data:image/svg+xml," + clean.replace(/[%#<>{}\\]|[^\x20-\x7e]/g, (c) => encodeURIComponent(c));
}

const LICENCES = `/* omarchy-pool's v1 kit, one sheet: its primitives, then its icons (src/pages/kit.ts; the icon files and their licences are in src/assets/icons/).
   Lucide (lucide-static 0.400.0), ISC License. Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.
   Agent marks from lobe-icons (@lobehub/icons-static-svg 1.95.1), MIT License, Copyright (c) 2023 LobeHub. The marks are trademarks of their owners and identify the agents they name. */`;

/** FNV-1a over the sheet: a name that changes when a byte of it does — for the cache, not for security. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** An SVG with nothing in it: the mask an icon or a mark wears when the sheet has no shape for its name, so it is blank, never a filled square in the text's colour. */
const EMPTY = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E")`;

/**
 * The primitives. Every class is op-…: none can meet a class of today's
 * pages, and today's go when the last page that draws them does. Colours
 * are tokens (layout.ts), so both themes hold; motion stops under
 * prefers-reduced-motion (the frame's rule, and countUp()).
 *
 *   .op-eyebrow        the green line over a page title: 11.5px, uppercase, .14em
 *   .op-label          a label: 11.5px, uppercase, .08em, in --dim (a section's head, a tile's name, a field's name)
 *   .op-hero           a page's title: Geist 600, 36px, -0.02em, balanced
 *   .op-stats          tiles that share their borders; each .op-stat has .k (its label), .n (the number: Geist
 *                      28px — countUp() lands it) and .s (the line under it); a.op-stat is a link and lights on hover
 *   .op-card           a panel: --panel on the page, 1px --line; .op-card-h its head row (the title a <b>, a note
 *                      in <small>), .op-card-b its body, .op-card-f a foot row (a "Full journal →")
 *   .op-pill           a state, uppercase: .ok green, .run blue, .warn amber, .fail red, .wait dim, .na dashed
 *   .op-chip           a tag, as written: 1px --line; a button or a link chip lights green; .na is dashed
 *   .edge .rc .stable .lab   on .op-ring (a chip), .op-ring-name (the ring's name in display type), .op-card
 *                      (a 2px top), .op-arch and .op-seg's buttons: the ring's own hue, and no other use of it —
 *                      the element's own class, never its parent's: a ring card does not tint the arch squares,
 *                      chips or segments inside it (each resets --op-hue and --op-tone, custom properties that
 *                      would otherwise inherit)
 *   .op-arch           an architecture's 10px square in the tone's colour: filled when .ok, .run, .fail or
 *                      .wait, hollow and dashed when .na (not supported)
 *   .op-mark           a status mark in its colour: ✓ .ok, ⟳ .run, ✗ .fail, ○ .wait, — .na; .op-box is an
 *                      icon's square bordered in its tone (dashed .na; .lg is a package's 54px square)
 *   .op-seg            a segmented choice: its buttons or links share their borders; the chosen one is lit —
 *                      green, or the ring's hue — on --bg-deep; .na is dashed
 *   .op-tabs           underline tabs: --dim, the chosen one in --text over a 1px green line
 *                      Chosen is .on or the ARIA state a screen reader hears — aria-pressed="true" on a
 *                      segment, aria-selected="true" on a tab, aria-current="page" or "true" on a link —, drawn
 *                      alike: a page that sets the attribute needs no class, and the two cannot disagree
 *   .op-code           a code well: a <code> (a .op-prompt glyph first) and a button.op-copy with data-op-copy —
 *                      the shell copies the code (or the attribute's own text) and says "copied" for 1.5 s
 *   .op-btn            a button: 1px --line; .primary green, .danger red
 *   .op-table          a table: a --bg-deep head of labels, 1px between rows; .num right-aligned
 *   .op-fresh          a row that just arrived: its --panel-2 highlight fades in 1.2 s
 *   .op-live-dot       the 8px green square that pulses (the frame's op-pulse, 1.6 s), for what is live
 *   .op-i  .op-b       an icon (lucide()) and an agent's mark (agentMark()), 14 and 16px unless --op-i-s says
 */
export const KIT_CSS = String.raw`
  /* ---- the v1 kit (pages/kit.ts) ---- */
  .op-eyebrow { margin: 0; font-size: var(--fs-label); letter-spacing: .14em; text-transform: uppercase; color: var(--green); }
  .op-label, .op-stat .k { font-size: var(--fs-label); font-weight: 400; letter-spacing: var(--tracking-label); text-transform: uppercase; color: var(--dim); }
  .op-hero { margin: 0; max-width: 640px; font: 600 36px/1.12 var(--font-display); letter-spacing: var(--tracking-display); text-wrap: balance; }
  .op-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
  .op-stat { background: var(--panel); padding: 16px 18px; display: grid; gap: 4px; align-content: start; min-width: 0; color: inherit; text-decoration: none; }
  a.op-stat:hover { background: var(--panel-2); } a.op-stat:focus-visible { outline: 1px solid var(--green); outline-offset: -1px; }
  .op-stat .n { font: 600 28px/1.1 var(--font-display); letter-spacing: -0.01em; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .op-stat .s { font-size: 12px; color: var(--dim); display: flex; align-items: center; gap: 6px; }
  .op-card { border: 1px solid var(--line); background: var(--panel); min-width: 0; }
  .op-card-h { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  .op-card-h > b { font: 600 15px var(--font-display); } .op-card-h small { font-size: 12px; color: var(--dim); }
  .op-card-b { padding: 16px; }
  .op-card-f { display: flex; justify-content: flex-end; align-items: center; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--line); font-size: 12.5px; }
  /* A tone and a ring's hue are the element's own: reset where they are read, before the classes set them, so neither inherits from a parent that has one ('initial' is no value, and each var() below takes its fallback). */
  .op-pill, .op-arch, .op-mark, .op-box { --op-tone: initial; } .op-ring, .op-ring-name, .op-card, .op-arch, .op-seg > * { --op-hue: initial; }
  :is(.op-pill, .op-arch, .op-mark, .op-box).ok { --op-tone: var(--status-ok); } :is(.op-pill, .op-arch, .op-mark, .op-box).run { --op-tone: var(--status-info); }
  :is(.op-pill, .op-arch, .op-mark, .op-box).warn { --op-tone: var(--status-warn); } :is(.op-pill, .op-arch, .op-mark, .op-box).fail { --op-tone: var(--status-error); }
  :is(.op-pill, .op-arch, .op-mark, .op-box):is(.wait, .na) { --op-tone: var(--dim); }
  :is(.op-ring, .op-ring-name, .op-card, .op-arch, .op-seg > *).edge { --op-hue: var(--edge); } :is(.op-ring, .op-ring-name, .op-card, .op-arch, .op-seg > *).rc { --op-hue: var(--rc); }
  :is(.op-ring, .op-ring-name, .op-card, .op-arch, .op-seg > *).stable { --op-hue: var(--stable); } :is(.op-ring, .op-ring-name, .op-card, .op-arch, .op-seg > *).lab { --op-hue: var(--lab); }
  .op-pill { display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px; border: 1px solid var(--op-tone, var(--line)); color: var(--op-tone, var(--muted)); font-size: var(--fs-label); line-height: 1.5; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
  .op-pill.na, .op-chip.na { border-style: dashed; color: var(--dim); }
  .op-chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border: 1px solid var(--line); background: transparent; color: var(--muted); font: inherit; font-size: 12.5px; white-space: nowrap; text-decoration: none; }
  button.op-chip, a.op-chip { cursor: pointer; } button.op-chip:hover, a.op-chip:hover { border-color: var(--green); color: var(--text); }
  .op-ring { display: inline-block; padding: 0 6px; border: 1px solid var(--op-hue, var(--line)); color: var(--op-hue, var(--muted)); font-size: var(--fs-label); line-height: 1.6; white-space: nowrap; }
  .op-ring-name { font: 600 var(--fs-h2)/1.2 var(--font-display); color: var(--op-hue, var(--text)); }
  .op-card:is(.edge, .rc, .stable, .lab) { border-top: 2px solid var(--op-hue); }
  .op-arch { display: inline-block; flex: none; width: 10px; height: 10px; vertical-align: middle; background: var(--op-tone, var(--op-hue, var(--status-ok))); border: 1px solid var(--op-tone, var(--op-hue, var(--status-ok))); }
  .op-arch.na { background: transparent; border-style: dashed; }
  .op-mark { display: inline-block; min-width: 14px; font-style: normal; font-weight: 700; text-align: center; color: var(--op-tone, var(--dim)); }
  .op-box { display: inline-grid; place-items: center; flex: none; width: 28px; height: 28px; border: 1px solid var(--op-tone, currentColor); color: var(--op-tone, inherit); }
  .op-box.lg { width: 54px; height: 54px; background: var(--panel); } .op-box.na { border-style: dashed; }
  .op-seg { display: flex; flex-wrap: wrap; padding-left: 1px; }
  .op-seg > :is(button, a) { position: relative; margin-left: -1px; padding: 4px 12px; border: 1px solid var(--line); background: transparent; color: var(--op-hue, var(--muted)); font: inherit; font-size: 13px; cursor: pointer; text-decoration: none; white-space: nowrap; }
  .op-seg > :is(button, a):hover { color: var(--op-hue, var(--text)); }
  .op-seg > :is(.on, [aria-pressed="true"], [aria-current="page"], [aria-current="true"]) { z-index: 1; border-color: var(--op-hue, var(--green)); background: var(--bg-deep); color: var(--op-hue, var(--text)); }
  .op-seg > .na { border-style: dashed; color: var(--dim); }
  .op-tabs { display: flex; gap: 16px; font-size: 13px; overflow-x: auto; scrollbar-width: none; }
  .op-tabs > :is(button, a) { padding: 0 0 1px; border: 0; border-bottom: 1px solid transparent; background: none; color: var(--dim); font: inherit; cursor: pointer; text-decoration: none; white-space: nowrap; }
  .op-tabs > :is(button, a):hover { color: var(--text); } .op-tabs > :is(.on, [aria-selected="true"], [aria-current="page"], [aria-current="true"]) { color: var(--text); border-bottom-color: var(--green); }
  .op-code { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 12px 14px; background: var(--bg-deep); border: 1px solid var(--line); }
  .op-code code { min-width: 0; color: var(--text); font: 13.5px/1.6 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
  .op-code .op-prompt { color: var(--dim); user-select: none; }
  .op-copy { flex: none; padding: 3px 12px; border: 1px solid var(--green); background: transparent; color: var(--green); font: 12.5px var(--font-mono); cursor: pointer; }
  .op-copy.copied { background: var(--green); color: var(--green-ink); }
  .op-btn { display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px; border: 1px solid var(--line); background: transparent; color: var(--text); font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer; text-decoration: none; white-space: nowrap; }
  .op-btn:hover { border-color: var(--green); }
  .op-btn.primary { background: var(--green); border-color: var(--green); color: var(--green-ink); } .op-btn.primary:hover { filter: brightness(1.08); }
  .op-btn.danger { border-color: var(--red); color: var(--red); }
  .op-table { width: 100%; border-collapse: collapse; font-size: var(--fs-small); }
  .op-table th { padding: 7px 12px; border-bottom: 0; background: var(--bg-deep); color: var(--dim); font-size: 11px; font-weight: 400; letter-spacing: .06em; text-align: left; text-transform: uppercase; white-space: nowrap; }
  .op-table td { padding: 8px 12px; border-bottom: 0; border-top: 1px solid var(--line); vertical-align: middle; }
  .op-table .num { text-align: right; font-variant-numeric: tabular-nums; }
  @keyframes op-fresh { from { background-color: var(--panel-2); } to { background-color: transparent; } }
  .op-fresh { animation: op-fresh 1.2s ease-out; }
  .op-live-dot { display: inline-block; flex: none; width: 8px; height: 8px; background: var(--green); animation: op-pulse 1.6s ease-in-out infinite; }
  .op-i, .op-b { display: inline-block; flex: none; vertical-align: -2px; }
  .op-i { width: var(--op-i-s, 14px); height: var(--op-i-s, 14px); background: currentColor; -webkit-mask: var(--op-i, ${EMPTY}) center / contain no-repeat; mask: var(--op-i, ${EMPTY}) center / contain no-repeat; }
  .op-b { width: var(--op-i-s, 16px); height: var(--op-i-s, 16px); background: var(--op-bc, currentColor) center / contain no-repeat; -webkit-mask: var(--op-bm, ${EMPTY}) center / contain no-repeat; mask: var(--op-bm, ${EMPTY}) center / contain no-repeat; }
`;

/**
 * The sheet a kit page links: the licences, the primitives, then per icon
 * a custom property that .op-i masks with, and per agent mark either the
 * image (a coloured mark: --op-bc, with no mask) or the mask (a one-colour
 * mark: --op-bm, painted currentColor).
 */
export const KIT_SHEET = [
  LICENCES,
  KIT_CSS.trim(),
  ...Object.entries(LUCIDE).map(([name, svg]) => `.op-i-${name}{--op-i:url("${svgUri(svg)}")}`),
  ...Object.entries(AGENT_MARKS).map(([name, m]) => (m.color ? `.op-b-${name}{--op-bc:url("${svgUri(m.svg)}");--op-bm:none}` : `.op-b-${name}{--op-bm:url("${svgUri(m.svg)}")}`)),
].join("\n") + "\n";
export const KIT_SHEET_HASH = fnv1a(KIT_SHEET);
/** The sheet's address, the one a kit page links. */
export const KIT_SHEET_PATH = `/assets/kit.${KIT_SHEET_HASH}.css`;

/**
 * The sheet by its name: immutable for a year under the current hash. A
 * page served before a deploy (pages are public for a minute) may still ask
 * for the old name; it gets today's sheet for five minutes, so no primitive
 * or icon goes missing and nothing old is pinned for long. Anything else under /assets/
 * is not ours: null, and the router's 404.
 */
export function kitAsset(path: string, method: string): Response | null {
  const m = /^\/assets\/kit\.([0-9a-f]{8})\.css$/.exec(path);
  if (!m || (method !== "GET" && method !== "HEAD")) return null;
  const current = m[1] === KIT_SHEET_HASH;
  return new Response(method === "HEAD" ? null : KIT_SHEET, {
    headers: { "content-type": "text/css; charset=utf-8", "cache-control": current ? "public, max-age=31536000, immutable" : "public, max-age=300" },
  });
}

/**
 * The kit's side of a page's script, spliced after the shell's HELPERS
 * (layout.ts) on a kit page: the browser's lucide() and agentMark() — the
 * server's above, character for character —, countUp(), and the copy button
 * of every code well.
 */
export const KIT_HELPERS = String.raw`
  // ---- the v1 kit (pages/kit.ts): an icon and an agent's mark as the server writes them, a number that lands, a code well's copy.
  function lucide(name, size, label) { return '<i class="op-i op-i-' + esc(name) + '"' + kitSize(size, 14) + (label ? ' role="img" aria-label="' + esc(label) + '"' : ' aria-hidden="true"') + '></i>'; }
  function agentMark(mark, label, size) { return '<i class="op-b op-b-' + esc(mark) + '"' + kitSize(size, 16) + ' role="img" aria-label="' + esc(label) + '" title="' + esc(label) + '"></i>'; }
  function kitSize(size, fallback) { var px = Number(size); return isFinite(px) && px > 0 && px !== fallback ? ' style="--op-i-s:' + px + 'px"' : ''; }
  // A number that counts up to where it lands, 1.1 s and easing out — or lands at once for a reader who asked for less motion, and where the browser cannot animate. fmt(n) writes it (num() unless told: function (n) { return "+" + num(n); }); a second call on the element takes over from the first. The page serves the final text, so a reader without script sees the number.
  function countUp(el, to, fmt, ms) {
    if (!el) return;
    fmt = fmt || num; to = Number(to) || 0;
    var run = el.opCount = (el.opCount || 0) + 1, period = ms || 1100, start = null;
    if (!to || typeof requestAnimationFrame !== "function" || (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches)) { el.textContent = fmt(to); return; }
    el.textContent = fmt(0);
    requestAnimationFrame(function step(t) {
      if (el.opCount !== run) return;
      if (start === null) start = t;
      var p = Math.min(1, (t - start) / period);
      el.textContent = fmt(p < 1 ? Math.round(to * (1 - Math.pow(1 - p, 3))) : to);
      if (p < 1) requestAnimationFrame(step);
    });
  }
  // A code well's copy button (button.op-copy with data-op-copy): the attribute's text when it has one, else the well's code without its prompt glyph; "copied" for 1.5 s, or "could not copy" when the browser refused — no permission, or no clipboard at all (plain http, an older browser: navigator.clipboard is undefined there, and calling it would throw before any answer).
  document.addEventListener("click", function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest("[data-op-copy]") : null; if (!b || b.disabled) return;
    var well = b.closest(".op-code"), code = well && well.querySelector("code"), text = b.getAttribute("data-op-copy");
    if (!text && code) { var c = code.cloneNode(true); c.querySelectorAll(".op-prompt").forEach(function (p) { p.remove(); }); text = c.textContent; }
    if (!text) return;
    var was = b.getAttribute("data-was") || b.textContent; b.setAttribute("data-was", was);
    var back = function () { setTimeout(function () { b.textContent = was; b.classList.remove("copied"); }, 1500); }, refused = function () { b.textContent = "could not copy"; back(); };
    var copying; try { copying = navigator.clipboard.writeText(text); } catch (e) { refused(); return; }
    copying.then(function () { b.textContent = "copied"; b.classList.add("copied"); back(); }, refused);
  });
`;
