/**
 * One package's page — where it is in every ring, what it declares, what
 * its binaries actually load, who depends on it, drawn as a graph — with
 * the file list on demand. The packages list is pages/browse.ts.
 */
import { page, RETRY_AT_SIZE } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import { EXPECTED_SOURCES, type RunningVersion } from "../meta";
import { lucide } from "./kit";
import { escapeHtml } from "../html";

/**
 * A package's page (#244): one layout for every package, synced or built by
 * the factory, and the same information for everyone — only the actions in
 * the You card change with the viewer. The header (name, version, state,
 * where it comes from, each architecture), five tiles that jump to their
 * section, how it got here in four stages (the request or the upstream, the
 * build, the review, the rings), each with its panel, the security of the
 * object and of what it loads, the dependency graph and the files; beside
 * them the install, the seal, the people and agents, the facts and You.
 * Below 1120px the install and the seal come first, then the main column,
 * then the rest of the side.
 *
 * Its rules are its own (page() serves them after the kit's sheet), under
 * .pkg: what the kit has no piece for — the header, the stages and their
 * panel, the matrices, the graph, the side's cards — in the kit's tokens.
 */
const PACKAGE_CSS = String.raw`
  .pkg { max-width: calc(var(--content-wide) - 2 * var(--gutter)); margin: 0 auto; display: grid; gap: 20px; }
  .pkg .crumbs { margin: 0; }
  .pkg section { margin: 0; }
  .pkg a { text-decoration: none; }
  .pkg h2, .pkg h3 { margin: 0; letter-spacing: normal; text-wrap: initial; }
  /* The keyboard's ring is the frame's: 1px of green, square — never the browser's blue. */
  .pkg :is(a, button, summary, input):focus-visible { outline: 1px solid var(--green); outline-offset: 2px; }
  .pkg :is(.op-seg > *, .op-stat, .pkg-files-h, .pkg-node, .pkg-adv > summary, .pkg-more > summary):focus-visible { outline-offset: -1px; }
  .pkg .pkg-stage:focus-visible { outline-offset: -4px; }
  /* Words for a screen reader alone: what a mark means, where only its title says it to the eye. */
  .pkg-vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .pkg-head { display: flex; flex-wrap: wrap; gap: 16px 32px; justify-content: space-between; align-items: flex-start; }
  .pkg-id { flex: 1 1 420px; min-width: 0; display: flex; gap: 16px; align-items: flex-start; }
  .pkg-id > .op-box { color: var(--muted); } .pkg-id > .op-box.ok { color: var(--green); }
  .pkg-idt { display: grid; gap: 6px; min-width: 0; }
  .pkg-title { display: flex; align-items: baseline; gap: 6px 12px; flex-wrap: wrap; min-width: 0; }
  .pkg-title h1 { margin: 0; font: 600 30px/1.15 var(--font-display); letter-spacing: var(--tracking-display); overflow-wrap: anywhere; }
  .pkg-ver { font: 500 16px var(--font-display); color: var(--dim); overflow-wrap: anywhere; }
  .pkg-desc { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
  .pkg-desc a { color: var(--green); }
  .pkg-chips { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; font-size: 12.5px; }
  .pkg-chips .op-chip { padding: 1px 8px; } .pkg-chips .op-chip.factory { color: var(--green); }
  .pkg-chips .pill.tgt { font-size: 12.5px; padding: 1px 8px; }
  .pkg-pick { display: grid; gap: 8px; justify-items: end; }
  .pkg-blocked { border: 1px solid var(--red); background: var(--panel-2); padding: 12px 16px; display: flex; gap: 12px; align-items: flex-start; font-size: 13.5px; }
  .pkg-blocked > i { color: var(--red); margin-top: 3px; } .pkg-blocked > div { display: grid; gap: 2px; min-width: 0; overflow-wrap: anywhere; } .pkg-blocked b { color: var(--red); font-weight: 600; } .pkg-blocked b a { color: inherit; } .pkg-blocked b a:hover { text-decoration: underline; } .pkg-blocked .dim { color: var(--dim); }
  .pkg-tiles .op-stat { padding: 14px 16px; }
  /* Five tiles in rows that close: five across, three and two on a tablet, two, two and one (the last as wide as the row) on a phone — never a cell of bare --line where a tile would be. */
  .pkg-tiles { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  @media (max-width: 899px) { .pkg-tiles { grid-template-columns: repeat(6, minmax(0, 1fr)); } .pkg-tiles .op-stat { grid-column: span 2; } .pkg-tiles .op-stat:nth-child(n + 4) { grid-column: span 3; } }
  @media (max-width: 519px) { .pkg-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } .pkg-tiles .op-stat, .pkg-tiles .op-stat:nth-child(n + 4) { grid-column: auto; } .pkg-tiles .op-stat:last-child { grid-column: span 2; } }
  .pkg-tiles .op-stat .k { display: flex; align-items: center; gap: 8px; }
  .pkg-tiles .op-stat .n { font-size: 22px; line-height: 1.15; }
  .pkg .ok-t { color: var(--green); } .pkg .run-t { color: var(--blue); } .pkg .warn-t { color: var(--amber); } .pkg .fail-t { color: var(--red); } .pkg .dim-t { color: var(--dim); }
  .pkg-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 35%); grid-template-rows: auto 1fr; grid-template-areas: "main a" "main b"; gap: 20px; align-items: start; }
  .pkg-main { grid-area: main; display: grid; gap: 20px; min-width: 0; }
  .pkg-side-a { grid-area: a; } .pkg-side-b { grid-area: b; }
  .pkg-side-a, .pkg-side-b { display: grid; gap: 12px; align-content: start; min-width: 0; }
  /* Narrower than the frame: one column — the install and the seal first, what it takes to have the package, then the main column, then the rest of the side. */
  @media (max-width: 1119px) { .pkg-cols { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; grid-template-areas: "a" "main" "b"; } }
  @media (max-width: 719px) { .pkg-pick { justify-items: start; } .pkg-title h1 { font-size: 26px; } }
  .pkg-h { display: flex; align-items: center; gap: 10px; min-width: 0; color: var(--dim); }
  .pkg-h :is(b, h2) { font: 600 15px var(--font-display); color: var(--text); }
  .pkg h2.op-label { font: 400 var(--fs-label) var(--font-mono); letter-spacing: var(--tracking-label); }
  .pkg .op-card-h small a { color: var(--green); }
  /* How it got here: four stages as tabs, the chosen one open into its panel below. */
  .pkg-chain-h { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
  .pkg-chain-h small { font-size: 12px; color: var(--dim); }
  .pkg-stages { display: flex; flex-wrap: wrap; padding-left: 1px; }
  .pkg-stage { --st: var(--dim); flex: 1 1 150px; min-width: 0; margin: 0 0 0 -1px; border: 1px solid var(--line); border-top: 2px solid var(--st); background: var(--panel-2); padding: 12px 14px; display: grid; gap: 8px; align-content: start; position: relative; font: inherit; color: var(--text); text-align: left; cursor: pointer; }
  .pkg-stage:hover { background: var(--panel); }
  .pkg-stage[aria-selected="true"] { background: var(--panel); border-bottom-color: var(--panel); z-index: 2; }
  .pkg-stage.ok { --st: var(--green); } .pkg-stage.run { --st: var(--blue); } .pkg-stage.warn { --st: var(--amber); } .pkg-stage.fail { --st: var(--red); }
  .pkg-stage-t { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-width: 0; }
  .pkg-stage-t > span { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .pkg-stage-t b { font: 600 15px var(--font-display); letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pkg-stage-t .op-box { width: 26px; height: 26px; }
  .pkg-stage-t .op-box { color: var(--st); border-color: var(--st); }
  /* A stage's line wraps onto a second line before it is cut: "in review · rebuild staged" read "ready for a maintai…" at 1280 (#282). */
  .pkg-stage-s { font-size: 12.5px; color: var(--muted); overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: anywhere; }
  .pkg-stage-a { display: flex; gap: 4px; align-items: center; min-height: 16px; font-size: 11.5px; color: var(--dim); }
  .pkg-stage-a > span { margin-left: 4px; }
  .pkg-panel { border: 1px solid var(--line); border-top: 0; background: var(--panel); padding: 18px; display: grid; gap: 16px; min-width: 0; }
  .pkg-ph { display: flex; justify-content: space-between; align-items: center; gap: 10px 16px; flex-wrap: wrap; }
  /* A panel's title and its tag: the tag goes under the title when one row cannot hold both (waiting for a native x86_64 worker, on a phone),
     and a tag wider than the panel wraps inside its own box: Review's word and the native wait, "in review · waiting for a native x86_64
     worker", is wider than a phone's panel on one line. */
  .pkg-ph > span { display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap; min-width: 0; } .pkg-ph h3 { font: 600 17px var(--font-display); }
  .pkg-ph > span > .op-pill { max-width: 100%; white-space: normal; }
  .pkg-who { display: flex; gap: 6px; flex-wrap: wrap; }
  .pkg-whoc { display: inline-flex; align-items: center; gap: 7px; min-width: 0; border: 1px solid var(--line); background: var(--bg-deep); padding: 2px 9px 2px 3px; font-size: 12.5px; color: var(--text); }
  .pkg-whoc .r { color: var(--dim); } .pkg-whoc > a:not(.avatar) { color: var(--text); } .pkg-whoc > a:not(.avatar):hover { color: var(--green); } .pkg-whoc .avatar { width: 20px; height: 20px; font-size: 8.5px; }
  .pkg-glyph { display: inline-grid; place-items: center; flex: none; width: 20px; height: 20px; background: var(--panel-2); color: var(--muted); font-size: 8.5px; font-weight: 700; }
  .pkg-glyph.pool { background: var(--green); color: var(--green-ink); } .pkg-glyph.agent { background: var(--bg-deep); color: var(--text); }
  .pkg-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), 1fr)); gap: 12px 20px; }
  .pkg-field { display: flex; gap: 10px; align-items: flex-start; min-width: 0; }
  .pkg-field > i { color: var(--dim); margin-top: 3px; } .pkg-field > div { display: grid; min-width: 0; }
  .pkg-field .op-label { font-size: 11px; } .pkg-field .v { font-size: 13.5px; overflow-wrap: anywhere; } .pkg-field .v a { color: var(--green); }
  .pkg-sub { display: grid; gap: 6px; min-width: 0; }
  .pkg-rows { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 6px 20px; }
  .pkg-row { display: flex; gap: 10px; align-items: baseline; font-size: 13.5px; min-width: 0; overflow-wrap: anywhere; }
  .pkg-row .op-mark { flex: none; } .pkg-row .dim { color: var(--dim); } .pkg-row a { color: var(--green); }
  .pkg-mx { border: 1px solid var(--line); min-width: 0; }
  /* Every column flexes: a column capped at a fixed width took its whole cap before the check's column got any room, and on a phone the check's name went one letter per line. */
  .pkg-mx > div { display: grid; grid-template-columns: minmax(0, 2fr) repeat(2, minmax(72px, 1fr)); border-top: 1px solid var(--line); font-size: 13px; }
  .pkg-mx > div:first-child { border-top: 0; background: var(--bg-deep); font-size: 12px; color: var(--dim); }
  .pkg-mx > div > span { padding: 6px 12px; min-width: 0; overflow-wrap: anywhere; }
  .pkg-mx > div > span + span { border-left: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 2px 8px; align-items: baseline; }
  .pkg-mx small { font-size: 11.5px; color: var(--dim); }
  .pkg-mx > .foot { background: var(--panel-2); font-size: 12px; color: var(--dim); } .pkg-mx > .foot > span + span { color: var(--muted); }
  .pkg-diff { background: var(--bg-deep); border: 1px solid var(--line); padding: 10px 12px; font: 12.5px/1.75 var(--font-mono); overflow-x: auto; }
  .pkg-diff div { white-space: pre; } .pkg-diff .add { color: var(--green); } .pkg-diff .del { color: var(--red); } .pkg-diff .ctx, .pkg-diff .gap { color: var(--dim); }
  .pkg-rings { display: flex; flex-wrap: wrap; gap: 16px 24px; }
  .pkg-rt { flex: 3 1 360px; min-width: 0; border: 1px solid var(--line); overflow-x: auto; }
  .pkg-rt td { white-space: nowrap; } .pkg-rt tr.on td { background: var(--panel-2); } .pkg-rt .dim { color: var(--dim); }
  .pkg-tl { flex: 2 1 220px; min-width: 0; display: grid; gap: 2px; align-content: start; }
  .pkg-tl > div { display: grid; grid-template-columns: 40px 10px minmax(0, 1fr); gap: 10px; align-items: center; font-size: 13px; padding: 3px 0; }
  .pkg-tl .w { font-size: 12px; color: var(--dim); } .pkg-tl .sq { width: 10px; height: 10px; background: currentColor; }
  .pkg-tl .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pkg-tl .t b { font-weight: 600; } .pkg-tl .t span { color: var(--dim); margin-left: 8px; }
  .pkg-note { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 12px; overflow-wrap: anywhere; }
  .pkg-note > i { color: var(--dim); margin-top: 3px; } .pkg-note a { color: var(--green); }
  .pkg-links { display: flex; gap: 8px 18px; flex-wrap: wrap; font-size: 12.5px; }
  .pkg-links a { display: inline-flex; align-items: center; gap: 6px; color: var(--green); } .pkg-links a:hover { text-decoration: underline; }
  /* Security: the version on the left, what it loads on the right — one square per advisory, grouped by the dependency it comes through. */
  .pkg-sec { display: flex; flex-wrap: wrap; }
  .pkg-sec-own { flex: 1 1 200px; padding: 16px; display: grid; gap: 4px; align-content: start; border-right: 1px solid var(--line); }
  .pkg-sec-own .big { font: 600 24px/1.2 var(--font-display); } .pkg-sec-own > span:not(.op-label) { font-size: 12.5px; color: var(--dim); }
  .pkg-sec-dep { flex: 3 1 380px; min-width: 0; padding: 12px 16px 14px; display: grid; gap: 8px; align-content: start; }
  .pkg-sech { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; } .pkg-adv + .pkg-sech { margin-top: 6px; }
  .pkg-sec-dep > p { margin: 0; font-size: 13px; color: var(--muted); }
  .pkg-sevs { display: flex; gap: 8px; flex-wrap: wrap; } .pkg-sevs span { display: flex; align-items: center; gap: 5px; font-size: 11.5px; }
  .pkg-sq { display: inline-block; flex: none; width: 9px; height: 9px; background: currentColor; }
  .pkg-adv { border-top: 1px solid var(--line); min-width: 0; }
  .pkg-adv > summary { list-style: none; display: grid; grid-template-columns: 12px minmax(64px, 130px) minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 7px 0; cursor: pointer; font-size: 13px; }
  .pkg-adv > summary::-webkit-details-marker { display: none; }
  .pkg-adv > summary::before { content: "›"; color: var(--green); transition: transform 120ms; } .pkg-adv[open] > summary::before { transform: rotate(90deg); }
  .pkg-adv > summary b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pkg-adv .via { font-size: 12px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pkg-adv .dots { display: flex; gap: 3px; flex-wrap: wrap; justify-content: flex-end; max-width: 120px; } .pkg-adv .dots i { width: 10px; height: 10px; background: currentColor; }
  .pkg-adv ul { list-style: none; margin: 0; padding: 0 0 8px 22px; display: grid; gap: 3px; }
  .pkg-adv li { display: flex; gap: 4px 12px; font-size: 12.5px; flex-wrap: wrap; align-items: baseline; }
  .pkg-adv .sev { width: 62px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; } .pkg-adv li a { color: var(--green); } .pkg-adv li .dim { color: var(--dim); }
  @media (max-width: 719px) { .pkg-sec-own { border-right: 0; border-bottom: 1px solid var(--line); } .pkg-adv > summary { grid-template-columns: 12px minmax(0, 1fr) auto; } .pkg-adv .via { display: none; } }
  /* Dependencies: required-by on the left, depends-on on the right, the package between, drawn by the SVG connectors; one column on a phone. */
  .pkg-legend { display: flex; gap: 6px 14px; flex-wrap: wrap; font-size: 12px; color: var(--dim); }
  .pkg-legend span { display: flex; align-items: center; gap: 6px; } .pkg-legend .ln { width: 14px; height: 2px; }
  /* The side columns get the width first: the package between is as wide as its name up to 160px, then its name wraps (#282). The columns,
     the connectors and the package between all sit in the middle of their row, each column padded to the connectors' height above and below:
     the connectors meet at the middle of the package between however many lines its name takes. */
  .pkg-graph { display: grid; grid-template-columns: minmax(0, 1fr) 64px fit-content(160px) 64px minmax(0, 1.2fr); align-items: start; }
  .pkg-graph > .op-label { margin-bottom: 6px; } .pkg-graph > .gl { grid-area: 1 / 1; } .pkg-graph > .gr { grid-area: 1 / 5; }
  .pkg-graph > .pkg-gcol.l { grid-area: 2 / 1; } .pkg-graph > svg.l { grid-area: 2 / 2; } .pkg-graph > .pkg-center { grid-area: 2 / 3; } .pkg-graph > svg.r { grid-area: 2 / 4; } .pkg-graph > .pkg-gcol.r { grid-area: 2 / 5; }
  .pkg-graph > .pkg-gcol, .pkg-graph > svg, .pkg-graph > .pkg-center { align-self: center; }
  .pkg-gcol { display: grid; gap: 2px; min-width: 0; }
  .pkg-node { height: 24px; border: 1px solid var(--line); background: var(--bg-deep); display: flex; align-items: center; gap: 6px; padding: 0 8px; font: 12px var(--font-mono); color: var(--text); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  a.pkg-node:hover { border-color: var(--green); }
  /* The name keeps its width; the version and the tag give way first (#274, #282). Name, version and tag sit on one line the box clips: what
     does not fit wraps onto the hidden line whole — the tag, and the version once less than three characters of it would show, never a stray
     digit without its ellipsis — and the version is cut with an ellipsis. A name longer than the node is cut last, in the middle: its head
     gives way and its tail stays (.nt, the part after the prefix it shares with another name in the graph), so aarch64-linux-gnu-gcc and
     aarch64-linux-gnu-linux-api-headers never read the same "aarch64-linux-g…". The node's title says it all. The head is cut to a whole number
     of characters — the box's width less the tail's (--t, its characters), rounded down to a character — so the ellipsis meets the tail
     without the blank of a part-character, which read like a space in a name: "aarch64-linux… binutils" (the #282 review). */
  .pkg-node > .l { container-type: inline-size; flex: 1 1 auto; display: flex; flex-wrap: wrap; align-content: flex-start; column-gap: 8px; row-gap: 8px; height: 16px; min-width: 0; overflow: hidden; line-height: 16px; }
  .pkg-node .nm { flex: 0 0 auto; max-width: 100%; display: flex; min-width: 0; white-space: nowrap; }
  .pkg-node .nh { flex: 0 1 auto; min-width: 1ch; max-width: calc(round(down, 100cqw - var(--t, 0) * 1ch, 1ch) + .5px); overflow: hidden; text-overflow: ellipsis; } .pkg-node .nt { flex: none; max-width: calc(100% - 1ch); overflow: hidden; text-overflow: ellipsis; }
  .pkg-node .v { flex: 1 1 3ch; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 11px; color: var(--dim); white-space: nowrap; }
  .pkg-node .t { font-size: 11px; white-space: nowrap; flex: none; max-width: 100%; margin-left: auto; overflow: hidden; } .pkg-node .t.decl { color: var(--blue); } .pkg-node .t.so { color: var(--green); } .pkg-node .t.none { color: var(--dim); }
  .pkg-node.adv { border-color: color-mix(in oklab, var(--red) 55%, var(--line)); } .pkg-node .dot { width: 7px; height: 7px; flex: none; background: var(--red); }
  .pkg-node.gone { color: var(--dim); } button.pkg-node { width: 100%; color: var(--green); cursor: pointer; text-align: left; } button.pkg-node:hover { border-color: var(--green); }
  .pkg-center { min-height: 36px; display: grid; place-items: center; padding: 6px 14px; background: var(--green); color: var(--green-ink); font: 600 14px/1.25 var(--font-display); text-align: center; overflow-wrap: anywhere; } .pkg-center.fail { background: var(--red); }
  .pkg-graph svg { display: block; overflow: visible; }
  .pkg-gfoot { display: flex; gap: 8px 24px; flex-wrap: wrap; font-size: 12.5px; color: var(--dim); margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; }
  .pkg-gfoot b { font-weight: 400; color: var(--text); overflow-wrap: anywhere; }
  .pkg-more { margin-top: 12px; } .pkg-more > summary { list-style: none; cursor: pointer; font-size: 12.5px; color: var(--green); display: flex; gap: 8px; align-items: center; }
  .pkg-more > summary::-webkit-details-marker { display: none; }
  .pkg-more > summary::before { content: "›"; transition: transform 120ms; } .pkg-more[open] > summary::before { transform: rotate(90deg); }
  .pkg-more ul { list-style: none; margin: 8px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr)); gap: 3px 20px; font-size: 12.5px; }
  .pkg-more li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pkg-more li a { color: var(--text); } .pkg-more li a:hover { color: var(--green); } .pkg-more li span { color: var(--dim); }
  .pkg-more table { margin-top: 8px; }
  @media (max-width: 719px) { .pkg-graph { grid-template-columns: minmax(0, 1fr); } .pkg-graph > * { grid-area: auto !important; } .pkg-graph > svg { display: none; } .pkg-graph > .pkg-gcol { padding-block: 0 !important; } .pkg-graph > .pkg-center { justify-self: start; margin: 12px 0 !important; } .pkg-graph > .gr { margin-top: 4px; } }
  .pkg-files-t { font: inherit; }
  .pkg-files-h { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; text-align: left; }
  .pkg-files-h:hover { background: var(--panel-2); } .pkg-files-h .pkg-h small { font-size: 12.5px; } .pkg-files-h > span:last-child { font-size: 12.5px; color: var(--green); }
  .pkg-files-h[disabled] { cursor: default; } .pkg-files-h[disabled]:hover { background: none; } .pkg-files-h[disabled] > span:last-child { color: var(--dim); }
  .pkg-files { border-top: 1px solid var(--line); padding: 12px 16px; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr)); gap: 3px 20px; font-size: 12.5px; color: var(--muted); }
  .pkg-files span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pkg-files > button { grid-column: 1 / -1; justify-self: start; margin-top: 6px; border: 0; background: none; padding: 0; color: var(--green); font: inherit; cursor: pointer; }
  .pkg-files > pre { grid-column: 1 / -1; margin: 0; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
  /* The side: the install, the seal, the people and agents, the facts, You. */
  .pkg-side-a .op-card-h, .pkg-side-b .op-card-h { padding: 10px 14px; }
  .pkg-inst { padding: 12px 14px; display: grid; gap: 10px; }
  .pkg-inst .op-code { padding: 10px 12px; } .pkg-inst .op-code code { font-size: 13px; }
  .pkg-noinst { display: flex; gap: 10px; align-items: center; font-size: 13px; color: var(--muted); border: 1px dashed var(--line); padding: 10px 12px; } .pkg-noinst > i { color: var(--dim); } .pkg-noinst a { color: var(--green); }
  .pkg-agents { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 12px; color: var(--dim); } .pkg-agents > span { margin-right: 4px; }
  .pkg-am { display: inline-grid; place-items: center; padding: 4px; border: 1px solid var(--line); background: var(--bg-deep); }
  .pkg-small { font-size: 12px; color: var(--dim); } .pkg-small a { color: var(--green); }
  .pkg-seal { padding: 6px 14px 10px; display: grid; }
  .pkg-seal > div { display: grid; grid-template-columns: minmax(0, 1fr) 44px 44px; align-items: center; font-size: 13px; padding: 5px 0; border-top: 1px solid var(--line); }
  .pkg-seal > div:first-child { border-top: 0; padding: 4px 0; font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); } .pkg-seal > div:first-child span { text-align: center; }
  .pkg-seal .g { display: flex; align-items: center; gap: 9px; min-width: 0; color: var(--dim); } .pkg-seal .g span { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pkg-seal > div > [role="cell"] { justify-self: center; }
  .pkg-sealf { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 10px; padding: 9px 14px; border-top: 1px solid var(--line); font-size: 12px; color: var(--dim); }
  .pkg-sealf > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; } .pkg-sealf a { color: var(--green); white-space: nowrap; }
  .pkg-people { padding: 6px 14px 10px; display: grid; }
  .pkg-person { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 10px; align-items: center; padding: 6px 0; border-top: 1px solid var(--line); }
  .pkg-person:first-child { border-top: 0; }
  .pkg-person .avatar, .pkg-person .pkg-glyph { width: 26px; height: 26px; font-size: 11px; }
  .pkg-person > div { display: grid; min-width: 0; line-height: 1.35; }
  .pkg-person .r { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  .pkg-person .l { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pkg-person .l a { color: var(--text); } .pkg-person .l a:hover { color: var(--green); } .pkg-person .l span { color: var(--dim); }
  .pkg-facts { padding: 6px 14px 10px; display: grid; }
  .pkg-facts > div { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
  .pkg-facts > div:last-child { border-bottom: 0; } .pkg-facts > div > i { color: var(--dim); }
  .pkg-facts span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pkg-facts a { color: var(--green); } .pkg-facts a:hover { text-decoration: underline; }
  .pkg-you { padding: 12px 14px; display: grid; gap: 10px; }
  .pkg-you > p { margin: 0; font-size: 13px; color: var(--muted); }
  .pkg-btns { display: flex; gap: 8px; flex-wrap: wrap; }
  .pkg-lock { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--dim); }
  .pkg-ask { display: grid; gap: 8px; border-top: 1px solid var(--line); padding-top: 10px; }
  .pkg-ask input { min-width: 0; background: var(--bg-deep); border: 1px solid var(--line); border-radius: 0; color: var(--text); font: 13px var(--font-mono); padding: 7px 10px; }
  .pkg-ask .op-btn.danger { background: var(--red); color: var(--green-ink); }
  .pkg-ask input:focus-visible { outline: 1px solid var(--green); outline-offset: -1px; }
  .pkg-ask .err { margin: 0; font-size: 12px; color: var(--red); }
  .pkg-ask .pk { margin: 0; padding: 7px 10px; border: 1px solid var(--amber); font-size: 12.5px; color: var(--text); } .pkg-ask .pk.ok { border-color: var(--green); }
  .pkg-recipes { justify-self: start; }
`;

/** Where a synced package comes from, in words (meta.ts's EXPECTED_SOURCES, as the ⌘K menu says it): "core/x86_64" → "Arch core". */
const SOURCE_WORDS: Record<string, string> = Object.fromEntries(EXPECTED_SOURCES.map((e) => [`${e.source}/${e.arch}`, e.origin]));

/** The page as served: the frame of every section, its headings and icons, filled by the script from the package's answers; the name is the address's, escaped. */
function packageBody(name: string): string {
  const n = escapeHtml(name);
  return String.raw`
<div class="pkg" id="pkg">
  <p class="crumbs"><a href="/packages">Packages</a> / <span id="crumb">${n}</span></p>
  <section class="pkg-head">
    <div class="pkg-id">
      <span class="op-box lg" id="pkg-mark">${lucide("package", 26)}</span>
      <div class="pkg-idt">
        <div class="pkg-title"><h1 id="title">${n}</h1><span class="pkg-ver" id="pkg-ver"></span><span id="pkg-state"></span></div>
        <p class="pkg-desc" id="desc"></p>
        <div class="pkg-chips" id="pkg-chips"></div>
      </div>
    </div>
    <div class="pkg-pick">
      <nav class="op-seg" id="pg-ring" aria-label="Ring"></nav>
      <nav class="op-seg" id="pg-arch" aria-label="Architecture"></nav>
    </div>
  </section>
  <div class="pkg-blocked" id="pkg-blocked" hidden></div>
  <section class="op-stats pkg-tiles" id="pg-tiles" aria-label="The package in five numbers"></section>
  <div class="pkg-cols">
    <div class="pkg-main">
      <section id="op-chain" aria-labelledby="h-chain">
        <div class="pkg-chain-h"><h2 class="op-label" id="h-chain">How it got here</h2><small id="chain-note"></small></div>
        <div class="pkg-stages" role="tablist" aria-label="How it got here" id="stages"></div>
        <div class="pkg-panel" role="tabpanel" id="stage-panel"><p class="pkg-small">Loading</p></div>
      </section>
      <section class="op-card" id="sec-section" aria-labelledby="h-sec">
        <div class="op-card-h"><span class="pkg-h" id="sec-icon">${lucide("shield", 16)}<h2 id="h-sec">Security</h2></span><small>matched every 3 hours · <a href="/docs/security#confidence">what the confidence means</a></small></div>
        <div class="pkg-sec">
          <div class="pkg-sec-own" id="sec-own"><span class="op-label">On this version</span></div>
          <div class="pkg-sec-dep" id="sec-exposed"></div>
        </div>
      </section>
      <section class="op-card" id="deps-section" aria-labelledby="h-deps">
        <div class="op-card-h"><span class="pkg-h">${lucide("git-fork", 16)}<h2 id="h-deps">Dependencies</h2></span><span class="pkg-legend"><span><i class="ln" style="background:var(--blue)"></i>declared</span><span><i class="ln" style="background:var(--green)"></i>loads a library</span><span><i class="pkg-sq" style="color:var(--red)"></i>advisory</span></span></div>
        <div class="op-card-b" id="deps"></div>
      </section>
      <section class="op-card" id="files-section" aria-labelledby="h-files">
        <h2 class="pkg-files-t" id="h-files"><button type="button" class="pkg-files-h" id="load-files" aria-expanded="false" aria-controls="files"><span class="pkg-h">${lucide("folder-tree", 16)}<b>Files</b><small id="files-count"></small></span><span id="files-label">show</span></button></h2>
        <div class="pkg-files" id="files" hidden></div>
      </section>
    </div>
    <aside class="pkg-side-a" aria-label="Install and seal">
      <section class="op-card" id="install" aria-labelledby="h-install">
        <div class="op-card-h"><span class="pkg-h ok-t">${lucide("download", 15)}<h2 id="h-install">Install</h2></span><div class="op-tabs" role="tablist" aria-label="Install with" id="install-tabs"><button type="button" role="tab" id="install-cmd" aria-controls="install-b" aria-selected="true" tabindex="0" data-mode="cmd">Command</button><button type="button" role="tab" id="install-agent" aria-controls="install-b" aria-selected="false" tabindex="-1" data-mode="agent">Agent</button></div></div>
        <div class="pkg-inst" id="install-b" role="tabpanel" aria-labelledby="install-cmd"></div>
      </section>
      <section class="op-card" id="seal-section" aria-labelledby="h-seal">
        <div class="op-card-h"><span class="pkg-h" id="seal-icon">${lucide("badge-check", 15)}<h2 id="h-seal">Seal</h2></span><small id="seal-ctx"></small></div>
        <div class="pkg-seal" id="seal" role="table" aria-labelledby="h-seal"></div>
        <div class="pkg-sealf" id="seal-foot"></div>
      </section>
    </aside>
    <aside class="pkg-side-b" aria-label="Who and what">
      <section class="op-card" id="who-section" aria-labelledby="h-who">
        <div class="op-card-h"><span class="pkg-h">${lucide("users", 15)}<h2 id="h-who">People &amp; agents</h2></span></div>
        <div class="pkg-people" id="who"></div>
      </section>
      <section class="op-card" id="facts-section" aria-label="Facts"><div class="pkg-facts" id="facts"></div></section>
      <section class="op-card" id="you-section" aria-labelledby="h-you">
        <div class="op-card-h"><span class="pkg-h"><span id="you-icon">${lucide("eye", 15)}</span><h2 id="h-you" tabindex="-1">You</h2></span><small id="you-who"></small></div>
        <div class="pkg-you" id="you"></div>
      </section>
    </aside>
  </div>
</div>
`;
}

const PACKAGE_SCRIPT = String.raw`
  var name = decodeURIComponent(location.pathname.split("/").pop());
  var q = new URLSearchParams(location.search);
  // The rings are the server's list in its order (RINGS_TEXT: stable, rc, edge, lab), the first the default: the page asks the API for any of them, the lab included, and draws the ring the API says it shows (shown_ring) — the most stable one that serves the package when the asked one does not.
  var RINGS = Object.keys(RINGS_TEXT);
  var ring = RINGS.indexOf(q.get("ring")) >= 0 ? q.get("ring") : RINGS[0];
  var arch = ARCHES.indexOf(q.get("arch")) >= 0 ? q.get("arch") : ARCHES[0];
  // Whether the address named the architecture: one that did not opens on the one that serves the package, when the default does not.
  var archAsked = arch === q.get("arch");
  // Where a synced package comes from, in words: meta.ts's list, spliced.
  var SOURCE_WORDS = __SOURCE_WORDS__;
  // The two answers the page is drawn from: the package in its ring and architecture (D; D404 when this architecture has none, which still says where the others are served) and the factory's story of it (ST; none for a synced package). The chosen stage, the install's mode, the recipes a review compares, the file list once asked, the open form of You.
  var D = null, D404 = null, ST = null, STAGE = null, MODE = "cmd", RECIPES = {}, FILES = null, ASK = null;
  var GLYPH = { ok: "✓", run: "⟳", warn: "✓", fail: "✗", wait: "○", na: "—" };
  // A status mark, an architecture's square, a date, a span without "ago". A mark with a reason says it to a screen reader too, where the eye reads it on hover.
  function mark(tone, title) { return '<b class="op-mark ' + tone + '"' + (title ? ' title="' + esc(title) + '" aria-hidden="true"' : '') + '>' + GLYPH[tone] + '</b>' + (title ? '<span class="pkg-vh">' + esc(title) + '</span>' : ''); }
  function square(tone, title) { return '<i class="op-arch ' + tone + '" title="' + esc(title) + '"></i>'; }
  function onDay(iso) { if (!iso) return "—"; var t = new Date(iso); return isNaN(t) ? "—" : t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
  function since(iso) { return iso ? ago(iso).replace(" ago", "") : ""; }
  function hue(r) { return "var(--" + (RINGS_TEXT[r] ? r : "dim") + ")"; }
  // Every package named on this page links its page in the ring shown (the package's answer sets ring to it) and the architecture read — the shell's one address.
  function pkgLink(n) { return '<a href="' + pkgHref(n, ring, arch) + '">' + esc(n) + '</a>'; }
  // A login as the page writes it everywhere: @login, a link to the person's page, the role on hover (the shell's whoAttr).
  function atLink(l) { return '<a href="' + userHref(l) + '"' + whoAttr(l) + '>@' + esc(l) + '</a>'; }
  // A factory package: the story is its, or the object it serves came from the factory — decided by the data, never by what the page drew before.
  function isFactory() { var o = originOf(); return !!(ST && ST.package && ST.package.name) || !!(o && o.source === "factory"); }
  function blockedBy() { var p = ST && ST.package; return p && p.blocked_at ? p : null; }
  function unmaintained() { var p = ST && ST.package; return !!(p && p.status === "unmaintained"); }
  function targetsOf() { var t = ST && (ST.targets || (ST.package || {}).targets); return t && Object.keys(t).length ? t : null; }
  // Where an architecture is served: the rings, most stable first, from the package's answer (every architecture rides it; one cached before it carried them has the asked architecture's rings alone), else the story's rings for a factory package no ring serves on this architecture. The story (30 s at the edge) is fresher than the package's answer (10 min): an architecture the story puts in no ring — blocked, or lifted and back in the factory — is served nowhere, whatever the older answer still says.
  function servedOn(a) {
    var x = (D && D.arches) || (D404 && D404.arches), rs;
    if (x && x[a]) rs = x[a].rings || [];
    else if (D && !D.arches) rs = a === arch ? ringsOfAnswer() : [];
    else rs = ((ST && ST.rings) || []).filter(function (r) { return r.arch === a; });
    if (ST && ST.package && ST.rings && !ST.rings.some(function (r) { return r.arch === a; })) return [];
    return rs;
  }
  // The asked architecture's rings as an answer without arches has them (rings: a row per ring and source), in the reader's order, the first row of each ring.
  function ringsOfAnswer() {
    var order = Object.keys(RINGS_TEXT), seen = {};
    return (D.rings || []).filter(function (r) { if (seen[r.ring]) return false; seen[r.ring] = 1; return true; }).map(function (r) { return { ring: r.ring, release_seq: r.release_seq, version: r.version, sha256: r.sha256, source: r.source, size_download: r.size_download, has_signature: r.sha256 === D.package.sha256 ? D.package.has_signature : undefined }; }).sort(function (x, y) { return order.indexOf(x.ring) - order.indexOf(y.ring); });
  }
  function servedAnywhere() { return ARCHES.some(function (a) { return promised(servedOn(a)).length > 0; }); }
  // Where the package comes from: the object shown, else the most stable one another architecture serves — its source and that architecture; none for a name no ring serves.
  function originOf() {
    if (D) return { source: D.package.source, arch: arch, version: D.package.version };
    var a = ARCHES.filter(function (x) { return servedOn(x).length; })[0], r = a ? servedOn(a)[0] : null;
    return r ? { source: r.source, arch: a, version: r.version } : null;
  }
  // The rings that serve it elsewhere, as links to its page there: what a reader of an architecture that does not serve it needs.
  function elsewhere() { return ARCHES.filter(function (a) { return a !== arch && servedOn(a).length; }).map(function (a) { return '<a href="' + pkgHref(name, servedOn(a)[0].ring, a) + '">Open it on ' + esc(a) + ' →</a>'; }).join(" "); }
  // The rings that promise something (the shell's PROMISED_RINGS, most stable first): the lab promises nothing. Above edge (PROMISED_UPWARD's first) a package went through a promotion's checks; the most stable ring took two green health checks in a row.
  function promised(rs) { return rs.filter(function (r) { return PROMISED_RINGS.indexOf(r.ring) >= 0; }); }
  function promoted(r) { return PROMISED_UPWARD.indexOf(r) > 0; }
  function inRing(a, r) { return servedOn(a).filter(function (x) { return x.ring === r; })[0] || null; }
  // Where the upstream is: the seal's project, or the source in words.
  function upstreamName() { var u = D && D.seal && D.seal.upstream; return (u && u.project) || "its upstream"; }
  function sourceWords(src, a) { return SOURCE_WORDS[src + "/" + a] || src || ""; }
  // The chains of an architecture, newest first. The one its target names is the work in the factory now — a bump or a renewal is newer than what the rings serve; the one whose approval stands is what the rings serve (or will, once its publish lands). The build and review stages follow the first, the seal, the people and the record the second.
  function chainsOn(a) { return ((ST && ST.chains) || []).filter(function (c) { return ((c.contributor || c.project || {}).arch) === a; }); }
  function chainFor(a) {
    var t = (targetsOf() || {})[a], id = t && t.task, mine = chainsOn(a);
    return (id && mine.filter(function (c) { return (c.contributor && c.contributor.id === id) || (c.project && c.project.id === id); })[0]) || mine[0] || null;
  }
  function approvedChain(a) { return chainsOn(a).filter(function (c) { return c.approval && c.approval.decision === "approved" && c.approval.standing !== false && !c.approval.withdrawn_at; })[0] || null; }
  function sealChain(a) { return approvedChain(a) || chainFor(a); }
  // A standing approval whose publish is still on its way: approved, not in edge yet.
  function publishing() { return ARCHES.map(approvedChain).some(function (c) { return c && c.publish && (c.publish.status === "queued" || c.publish.status === "leased"); }); }
  function archList() { var t = targetsOf(); return ARCHES.filter(function (a) { return !isFactory() || !t || t[a] || servedOn(a).length; }); }
  // A maintainer's claim on an architecture of it: the project's rebuild a maintainer asked for, queued, running or staged, and not decided yet
  // (a failed one hands it back). It stands while a newer version of it builds: the review panel shows it until the decision (#282).
  function claimOf(a) { return chainsOn(a).filter(function (c) { return c.project && ["queued", "leased", "staged"].indexOf(c.project.status) >= 0 && !c.approval && !c.withdrawn; })[0] || null; }
  // Where it stands in Review's queue: the list's own state, weighed by the list's rule over the story's rows (the story's review, queueOf in
  // routes/review.ts) — in review from the claim until the decision, ready for review while it waits for a claim, else neither (null: an
  // architecture still building, a build of a version already approved). Never a rule of the page's own: its targets alone once called a
  // build of an approved version ready (#282). One the list would not name, its targets' place, as the Factory's line files it (lineOf).
  function reviewOf() {
    var q = ST && ST.review;
    if (q) return q.state === "in_review" ? "in-review" : q.state === "ready" ? "ready" : null;
    var ts = targetsOf() || {}, st = Object.keys(ts).map(function (a) { return ts[a].status; });
    return st.indexOf("building") >= 0 ? null : st.indexOf("reviewing") >= 0 || st.indexOf("reviewed") >= 0 ? "in-review" : st.indexOf("built") >= 0 ? "ready" : null;
  }
  // The package's state, one word for the chip and the Review stage: blocked, in rings (a promised ring serves it), else in review from a
  // maintainer's claim until the decision, else where its targets stand — ready for review while it waits for a claim: the words the Factory
  // and Review say (#274), the list's in_review and ready.
  var STATE = { "in-rings": ["ok", "in rings"], building: ["run", "building"], ready: ["warn", "ready for review"], "in-review": ["warn", "in review"], approved: ["ok", "approved"], blocked: ["fail", "blocked"], rejected: ["fail", "rejected"], requested: ["wait", "requested"], none: ["wait", "not in the pool"] };
  function stateOf() {
    if (blockedBy()) return "blocked";
    if (ARCHES.some(function (a) { return promised(servedOn(a)).length; })) return "in-rings";
    if (!ST) return D ? "in-rings" : "none";
    var ts = targetsOf() || {}, has = function (list) { return Object.keys(ts).some(function (a) { return list.indexOf(ts[a].status) >= 0; }); };
    var r = reviewOf();
    if (r === "in-review") return r;
    if (has(["building"])) return "building";
    if (r) return r;
    if (has(["approved", "published"])) return "approved";
    return (ST.package || {}).status === "rejected" ? "rejected" : "requested";
  }
  function versionOf() {
    var o = originOf(); if (o) return o.version;
    var c = ((ST && ST.chains) || [])[0], b = c && (c.project || c.contributor);
    return (b && b.version) || (ST && ST.request && ST.request.version) || "";
  }

  // ---- the header: the mark, the version and the state, where it comes from, each architecture; the two pickers.
  function renderHead() {
    var fac = isFactory(), st = STATE[stateOf()], m = D ? D.manifest || {} : {}, pk = (ST && ST.package) || {}, o = originOf();
    $("#pkg-mark").className = "op-box lg" + (fac ? " ok" : "");
    $("#pkg-mark").innerHTML = lucide(fac ? "hammer" : "package", 26);
    $("#pkg-ver").textContent = versionOf();
    $("#pkg-state").innerHTML = '<span class="op-pill ' + st[0] + '">' + esc(st[1]) + '</span>';
    var desc = m.description || pk.description || "";
    if (!D && !ST) desc = stateOf() === "none" ? "Not in the pool." : (D404 && D404.error) || "";
    $("#desc").innerHTML = esc(desc) + (!D && D404 ? otherArch() : "");
    var origin = fac ? '<span class="op-chip factory" title="built here from a contributor\'s request, built again by the project, decided by a maintainer">' + lucide("factory", 13) + 'factory · only in the pool</span>'
      : o ? '<span class="op-chip" title="synced from ' + esc(upstreamName()) + ', served as built and signed there">' + lucide("refresh-cw", 13) + 'synced · ' + esc(sourceWords(o.source, o.arch)) + '</span>' : "";
    $("#pkg-chips").innerHTML = origin + (targetsOf() ? targetChips(targetsOf()) : servedChips());
    // The two pickers: the rings (ringChips) and the architectures, each chip the package's one address; the ring shown and the architecture read lit.
    var shown = D ? D.shown_ring : null;
    $("#pg-ring").innerHTML = ringChips({ name: name, shown_ring: shown }, function (r) { return !!inRing(arch, r); });
    $("#pg-arch").innerHTML = ARCHES.map(function (a) { var on = a === arch, has = servedOn(a).length > 0 || !!(targetsOf() || {})[a]; return '<a class="' + (on ? "on" : "") + (has || on ? "" : " na") + '"' + (on ? ' aria-current="true"' : '') + ' href="' + pkgHref(name, shown || ring, a) + '">' + a + '</a>'; }).join("");
    var b = blockedBy(), box = $("#pkg-blocked");
    box.hidden = !b;
    if (b) box.innerHTML = lucide("octagon-x", 18) + '<div><b>Blocked by ' + (b.blocked_by ? atLink(b.blocked_by) : "a maintainer") + ' · ' + esc(ago(b.blocked_at)) + '</b><span>“' + esc(b.blocked_reason || "") + '”</span><span class="dim">Out of every ring and back in the factory. Another maintainer can lift the block.</span></div>';
  }
  // The ring chips: every ring, the lab included, the one the API shows lit, one that does not serve it on this architecture dashed; each is the package's one address in that ring.
  function ringChips(d, has) { return RINGS.map(function (r) { var on = r === d.shown_ring; return '<a class="' + r + (on ? " on" : "") + (has(r) || on ? "" : " na") + '" href="' + pkgHref(d.name, r, arch) + '"' + (on ? ' aria-current="true"' : '') + ' title="' + esc(has(r) ? r + " serves it on " + arch : "not in " + r + " on " + arch) + '">' + r + '</a>'; }).join(""); }
  // A synced package's architectures, as the targets' chips draw them: served, or not served on it.
  function servedChips() {
    if (!D && !D404) return "";
    return '<span class="tgts">' + ARCHES.map(function (a) { var rs = servedOn(a); return rs.length ? '<span class="pill tgt ok" title="' + esc(a + ": in " + rs.map(function (r) { return r.ring; }).join(", ")) + '">' + esc(a) + ' ✓</span>' : '<span class="pill tgt none dashed" title="' + esc(a + ": no ring serves it") + '">' + esc(a) + ' · not served</span>'; }).join("") + '</span>';
  }
  // Asked on an architecture that does not serve it: where it is, as links; a name nothing serves, the factory's request.
  function otherArch() {
    var there = elsewhere();
    if (there) return (ST ? ' — not served on ' + esc(arch) + '. ' : ' ') + there;
    return ST ? "" : ' <a href="/factory?name=' + encodeURIComponent(name) + '#request">Request ' + esc(name) + ' →</a>';
  }

  // ---- the five tiles, each a link to its section.
  function renderTiles() {
    var b = blockedBy(), row = D ? inRing(arch, D.shown_ring) : null, p = D ? D.package : null;
    var own = D ? ((D.security && D.security.advisories) || []).filter(function (a) { return a.status === "vulnerable"; }) : [], exp = D ? ((D.security && D.security.exposed) || []) : [];
    var rb = D ? (D.required_by || []).length : 0, away = !D && !b && servedAnywhere() ? "not served on " + arch : !D && stateOf() === "rejected" ? "rejected · in no ring" : "";
    var tiles = [
      ["tag", "Version", D ? p.version : "—", D ? D.shown_ring + (row ? " #" + row.release_seq : "") + " · " + arch : b ? "out of every ring" : away || "not in a ring yet", "", "#op-chain", "rings"],
      ["hard-drive", "Size", D ? bytes(p.size_download) : "—", D ? bytes(p.size_installed) + " installed" : away || "no object in a ring yet", "", "#files-section"],
      ["arrow-down-to-line", "Depends on", D ? num(dependsOn().length) : "—", D ? "loads " + num((D.links || []).length) + ((D.links || []).length === 1 ? " library" : " libraries") : "read from the object", "", "#deps-section"],
      ["arrow-up-from-line", "Required by", D ? num(rb) + (rb >= 400 ? "+" : "") : "—", D ? "in " + D.shown_ring : "in the ring that serves it", "", "#deps-section"],
      ["shield", "Security", b ? "blocked" : !D ? "—" : own.length ? num(own.length) + " open" : "clean", b ? "revoked from every ring" : !D ? "checked once a ring serves it" : exp.length + " via dependencies", b || own.length ? "fail-t" : D ? "ok-t" : "", "#sec-section"]
    ];
    $("#pg-tiles").innerHTML = tiles.map(function (t) { return '<a class="op-stat" href="' + t[5] + '"' + (t[6] ? ' data-stage="' + t[6] + '"' : '') + '><span class="k">' + lucide(t[0], 14) + esc(t[1]) + '</span><span class="n ' + t[4] + '" title="' + esc(t[2]) + '">' + esc(t[2]) + '</span><span class="s">' + esc(t[3]) + '</span></a>'; }).join("");
    // The two counts land (the kit's countUp: at once for a reader who asked for less motion).
    if (D) { var n = document.querySelectorAll("#pg-tiles .n"); countUp(n[2], dependsOn().length); countUp(n[3], rb, function (v) { return num(v) + (rb >= 400 ? "+" : ""); }); }
  }
  // The Version tile opens the Rings stage before it scrolls there.
  $("#pg-tiles").addEventListener("click", function (ev) { var a = ev.target.closest ? ev.target.closest("[data-stage]") : null; if (a) { STAGE = a.getAttribute("data-stage"); renderChain(); } });

  // ---- how it got here: four stages, each with its status per architecture, and the chosen one's panel.
  function stagesOf() {
    var fac = isFactory(), b = blockedBy(), ts = targetsOf() || {}, arches = archList(), state = stateOf();
    var sq = function (fn) { return ARCHES.map(function (a) { var r = fn(a); return square(r[0], a + ": " + r[1]); }).join(""); };
    var rs = ARCHES.map(function (a) { return promised(servedOn(a))[0]; }).filter(Boolean), top = rs[0];
    // The rings: blocked, the most stable one serving it, on its way into edge while a standing approval's publish runs (whichever build it approved), none after a rejection, else after the approval.
    var ringsStage = b ? ["fail", "blocked · out of every ring", since(b.blocked_at)] : top ? ["ok", top.ring + " #" + top.release_seq, ""] : state === "approved" || publishing() ? ["run", "publishing into edge", ""] : state === "rejected" ? ["na", "none · rejected", ""] : ["wait", "after approval", ""];
    // A name no ring serves and nobody requested: nothing happened to it, and no stage says otherwise.
    if (state === "none") return [
      { id: "source", icon: "file-text", label: "Request", tone: "wait", sum: "nobody requested it" },
      { id: "build", icon: "hammer", label: "Build", tone: "na", sum: "nothing built" },
      { id: "review", icon: "user-check", label: "Review", tone: "na", sum: "nothing to review", dashed: true },
      { id: "rings", icon: "layers", label: "Rings", tone: "na", sum: "in no ring" }
    ];
    if (!fac) {
      var u = upstreamName(), o = originOf(), src = o ? sourceWords(o.source, o.arch) : "", built = D && D.manifest && D.manifest.pkginfo && D.manifest.pkginfo.builddate;
      return [
        { id: "source", icon: "download", label: "Upstream", tone: "ok", sum: src || u, when: built ? onDay(new Date(built * 1000).toISOString()).replace(/ \d{4}$/, "") : "" },
        { id: "build", icon: "hammer", label: "Build", tone: "ok", sum: "by " + u + " · verified here", archs: sq(function (a) { return servedOn(a).length ? ["ok", "served"] : ["na", "not served"]; }) },
        { id: "review", icon: "user-check", label: "Review", tone: "na", sum: "not needed · mirrored", dashed: true },
        { id: "rings", icon: "layers", label: "Rings", tone: ringsStage[0], sum: ringsStage[1], when: ringsStage[2] }
      ];
    }
    var req = (ST && ST.request) || {}, checks = req.checks || [], okN = checks.filter(function (c) { return c.ok; }).length, owner = (ST && ST.package && ST.package.owner) || "";
    var status = function (a) { return (ts[a] || {}).status || ""; };
    var anyT = function (list) { return arches.some(function (a) { return list.indexOf(status(a)) >= 0; }); };
    var rejected = state === "rejected";
    var buildTone = rejected ? "na" : anyT(["building"]) ? "run" : anyT(["built", "reviewing", "reviewed", "approved", "published"]) ? "ok" : arches.length && arches.every(function (a) { return status(a) === "not_supported"; }) ? "fail" : "wait";
    var building = arches.filter(function (a) { return status(a) === "building"; })[0], ns = arches.filter(function (a) { return status(a) === "not_supported"; }), okA = arches.filter(function (a) { return ["built", "reviewing", "reviewed", "approved", "published"].indexOf(status(a)) >= 0; });
    var bc = building ? chainFor(building) : null;
    var buildSum = rejected ? "rejected · back with its requester" : b && buildTone === "wait" ? "stopped by the block" : building ? building + " · try " + Math.max(1, ((bc && bc.contributor) || {}).attempts || 1) : okA.length && okA.length === ARCHES.length ? "both architectures" : okA.length ? okA.join(" · ") + " only" : ns.length ? "not supported" : "waiting for a worker";
    // The review: the decision on the build the targets name; while that build is still on its way, the approval the rings stand on. One review covers every target.
    var decided = arches.map(chainFor).filter(function (c) { return c && c.approval; })[0], approval = decided ? decided.approval : null;
    var standing = ARCHES.map(approvedChain).filter(Boolean)[0], stood = standing ? standing.approval : null;
    var withdrawn = ((ST && ST.chains) || []).some(function (c) { return c.withdrawn; });
    // Undecided, it says Review's word — the chip's, unless a ring serves it — first, then where the claim stands, in the Factory card's words
    // and by its order (#282): a rebuild an emulated worker sent back waiting for a native worker (#281), else the project rebuilding while
    // any architecture's rebuild is queued or running, else a new version building beside the claim, else the rebuild staged. The native
    // wait in the shell's short word, as Review's step and the review cell say it ("native worker"), so the line stays whole in its two
    // lines; its whole words in the line's title, the mark's and the architecture's square.
    var reviewTone, reviewSum, reviewWhy = "", reviewFull = "", inReview = reviewOf();
    var sentBack = function (a) { var k = status(a) === "reviewing" ? claimOf(a) : null; return k ? waitsForNative(k.project) : ""; }, waits = arches.map(sentBack).filter(Boolean)[0] || "";
    var claimAt = waits ? ["warn", "native worker"] : anyT(["reviewing"]) ? ["run", "project rebuilding"] : anyT(["building"]) ? ["run", "new version building"] : ["warn", "rebuild staged"];
    if (b && !approval) { reviewTone = "na"; reviewSum = withdrawn ? "withdrawn by the block" : "never reviewed · blocked"; }
    else if (approval) { reviewTone = approval.decision === "approved" ? "ok" : "fail"; reviewSum = "@" + approval.by + (approval.decision === "approved" ? " · rebuilt · approved" : " · " + approval.decision); }
    else if (inReview === "in-review") { reviewTone = claimAt[0]; reviewSum = STATE[inReview][1] + " · " + claimAt[1]; reviewWhy = waits; reviewFull = waits ? STATE[inReview][1] + " · " + waits : ""; }
    else if (inReview === "ready") { reviewTone = "wait"; reviewSum = STATE[inReview][1] + " · waiting for a claim"; }
    else if (stood) { reviewTone = "ok"; reviewSum = "@" + stood.by + " · approved " + (stood.version || ""); }
    else { reviewTone = "wait"; reviewSum = "waiting for builds"; }
    // A newer build waiting beside the approval the rings serve: the summary says both. One Review does not ask a maintainer about — a build
    // of the version already approved (felix 2.16.1) — is that version built again, nothing to decide.
    if (stood && !approval && anyT(["built", "reviewing", "reviewed"])) reviewSum += inReview || anyT(["building"]) ? " · " + (stood.version || "the last") + " stays approved" : " · built again";
    return [
      { id: "source", icon: "file-text", label: "Request", tone: req.complete ? "ok" : checks.length ? "fail" : "wait", sum: (owner ? "@" + owner + " · " : "") + okN + "/" + checks.length + " checks", when: onDay(req.created_at || ((ST && ST.package) || {}).created_at).replace(/ \d{4}$/, "") },
      { id: "build", icon: "hammer", label: "Factory build", tone: buildTone, sum: buildSum, archs: sq(function (a) { var s = status(a); return s === "building" ? ["run", "building"] : s === "not_supported" ? ["na", "not supported"] : ["built", "reviewing", "reviewed", "approved", "published"].indexOf(s) >= 0 ? ["ok", "built"] : rejected ? ["na", "rejected"] : s ? ["wait", s] : ["na", "not requested"]; }), when: since(((bc || chainFor(arches[0]) || {}).contributor || {}).finished_at) },
      { id: "review", icon: "user-check", label: "Review", tone: reviewTone, sum: reviewSum, why: reviewWhy, full: reviewFull, archs: sq(function (a) { var s = status(a), c = chainFor(a); return s === "not_supported" ? ["na", "not supported"] : s === "reviewing" ? (sentBack(a) ? ["warn", "in review · " + sentBack(a)] : ["run", "in review · project rebuilding"]) : s === "reviewed" ? ["warn", "in review · rebuild staged"] : ["approved", "published"].indexOf(s) >= 0 ? ["ok", "approved"] : c && c.approval && c.approval.decision === "rejected" ? ["fail", "rejected"] : s === "built" ? (inReview === "ready" ? ["wait", "ready for review · waiting for a claim"] : inReview === "in-review" ? ["warn", "in review"] : anyT(["building"]) ? ["wait", "built · waiting for the others"] : ["wait", "built · nothing to decide"]) : approvedChain(a) ? ["ok", "approved"] : s ? ["wait", "not yet"] : ["na", "not requested"]; }), when: approval ? since(approval.created_at) : stood ? since(stood.created_at) : "" },
      { id: "rings", icon: "layers", label: "Rings", tone: ringsStage[0], sum: ringsStage[1], when: ringsStage[2] }
    ];
  }
  function defaultStage() { var s = stateOf(); return s === "building" ? "build" : s === "ready" || s === "in-review" || s === "approved" ? "review" : s === "blocked" ? "rings" : "source"; }
  function renderChain() {
    var list = stagesOf(), fac = isFactory();
    if (!STAGE || !list.some(function (s) { return s.id === STAGE; })) STAGE = defaultStage();
    $("#chain-note").textContent = stateOf() === "none" ? "not in the pool · nobody requested it" : fac ? peopleCount() : "mirrored from " + upstreamName() + " · verified here";
    $("#stages").innerHTML = list.map(function (s) {
      var on = s.id === STAGE;
      return '<button type="button" role="tab" class="pkg-stage ' + s.tone + '" id="stage-' + s.id + '" aria-controls="stage-panel" aria-selected="' + on + '" tabindex="' + (on ? 0 : -1) + '" data-stage="' + s.id + '"><span class="pkg-stage-t"><span><span class="op-box ' + (s.dashed ? "na" : "") + '">' + lucide(s.icon, 15) + '</span><b>' + esc(s.label) + '</b></span>' + (s.tone === "warn" ? '<b class="op-mark warn" title="' + esc(s.why || "waiting for a decision") + '">⟳</b>' : mark(s.tone)) + '</span><span class="pkg-stage-s" title="' + esc(s.full || s.sum) + '">' + esc(s.sum) + '</span><span class="pkg-stage-a">' + (s.archs || "") + (s.when ? '<span>' + esc(s.when) + '</span>' : '') + '</span></button>';
    }).join("");
    $("#stage-panel").setAttribute("aria-labelledby", "stage-" + STAGE);
    $("#stage-panel").innerHTML = panelOf(STAGE);
  }
  $("#stages").addEventListener("click", function (ev) { var b = ev.target.closest ? ev.target.closest("[data-stage]") : null; if (b) { STAGE = b.getAttribute("data-stage"); renderChain(); $("#stage-" + STAGE).focus(); } });
  // The two recipes of a review are read when a reader asks for them, never because the stage opened by itself: each is a staging read and an R2 read no cache keeps.
  $("#stage-panel").addEventListener("click", function (ev) { var b = ev.target.closest ? ev.target.closest("[data-recipes]") : null; if (b) { b.disabled = true; loadRecipes(); } });
  // The arrow keys move along the stages, as a tab list does.
  $("#stages").addEventListener("keydown", function (ev) {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
    var ids = stagesOf().map(function (s) { return s.id; }), i = ids.indexOf(STAGE);
    STAGE = ids[(i + (ev.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length]; renderChain(); $("#stage-" + STAGE).focus(); ev.preventDefault();
  });
  function peopleCount() {
    var logins = {}, agents = {};
    var pk = (ST && ST.package) || {}; if (pk.owner) logins[pk.owner] = 1;
    ((ST && ST.chains) || []).forEach(function (c) { if (c.approval) logins[c.approval.by] = 1; var au = c.audit && c.audit.result && c.audit.result.model; if (au) agents[au] = 1; });
    var sb = D && D.seal && D.seal.chain && D.seal.chain.source_build; if (sb && sb.agent) agents[sb.agent] = 1;
    var np = Object.keys(logins).length, na = Object.keys(agents).length;
    return np + (np === 1 ? " person" : " people") + (na ? " · " + na + (na === 1 ? " agent" : " agents") : "") + " · every step on the record";
  }

  // ---- a stage's panel: a title and its tag, who, fields, a checklist, a matrix per architecture, the recipe diff, the rings and what happened, a note, links.
  function panel(o) {
    var h = '<div class="pkg-ph"><span><h3>' + esc(o.title) + '</h3><span class="op-pill ' + o.tone + '">' + esc(o.tag) + '</span></span>' + (o.who && o.who.length ? '<span class="pkg-who">' + o.who.join("") + '</span>' : '') + '</div>';
    if (o.fields && o.fields.length) h += '<div class="pkg-fields">' + o.fields.map(function (f) { return '<div class="pkg-field">' + lucide(f[0], 15) + '<div><span class="op-label">' + esc(f[1]) + '</span><span class="v">' + f[2] + '</span></div></div>'; }).join("") + '</div>';
    if (o.rows && o.rows.length) h += '<div class="pkg-sub"><span class="op-label">' + esc(o.rowsTitle) + '</span><div class="pkg-rows">' + o.rows.map(function (r) { return '<div class="pkg-row">' + mark(r[0], r[2]) + '<span>' + r[1] + '</span></div>'; }).join("") + '</div></div>';
    // The matrix is a table to assistive tech: a check per row, an architecture per column, each cell's reason in words.
    if (o.mx) h += '<div class="pkg-sub"><span class="op-label" id="pkg-mx-t">' + esc(o.mx.title) + '</span><div class="pkg-mx" role="table" aria-labelledby="pkg-mx-t"><div role="row"><span role="columnheader">check</span>' + o.mx.cols.map(function (c) { return '<span role="columnheader" class="' + c[1] + '">' + esc(c[0]) + '</span>'; }).join("") + '</div>' + o.mx.rows.map(function (r) { return '<div role="row"><span role="rowheader">' + esc(r[0]) + '</span>' + r[1].map(function (c) { return '<span role="cell">' + mark(c[0], c[2] || c[1]) + (c[1] ? '<small>' + esc(c[1]) + '</small>' : '') + '</span>'; }).join("") + '</div>'; }).join("") + (o.mx.foot || []).map(function (r) { return '<div class="foot" role="row"><span role="rowheader">' + esc(r[0]) + '</span>' + r[1].map(function (c) { return '<span role="cell">' + esc(c) + '</span>'; }).join("") + '</div>'; }).join("") + '</div></div>';
    if (o.diff) h += '<div class="pkg-sub" id="recipe-diff">' + o.diff + '</div>';
    if (o.rings) h += o.rings;
    if (o.note) h += '<div class="pkg-note">' + lucide("info", 14) + '<span>' + o.note + '</span></div>';
    if (o.links && o.links.length) h += '<div class="pkg-links">' + o.links.map(function (l) { return '<a href="' + esc(l[2]) + '">' + lucide(l[0], 13) + esc(l[1]) + '</a>'; }).join("") + '</div>';
    return h;
  }
  function whoChip(role, login) { return '<span class="pkg-whoc">' + avatar(login) + '<span class="r">' + esc(role) + '</span>' + atLink(login) + '</span>'; }
  function glyphChip(role, label, kind, ini) { return '<span class="pkg-whoc">' + glyph(label, kind, ini) + '<span class="r">' + esc(role) + '</span>' + esc(label) + '</span>'; }
  // An agent's mark from its name (claude-code, gpt-5, gemini …), or its initials; the pool's square; anyone else's initials.
  function markOf(agent) { var s = String(agent || "").toLowerCase(); return /claude|anthropic/.test(s) ? "claude-color" : /gpt|openai|codex/.test(s) ? "openai" : /gemini/.test(s) ? "gemini-color" : /grok|xai/.test(s) ? "grok" : /qwen/.test(s) ? "qwen-color" : /kimi/.test(s) ? "kimi" : /cursor/.test(s) ? "cursor" : /copilot/.test(s) ? "githubcopilot" : /opencode/.test(s) ? "opencode" : /llama|meta/.test(s) ? "meta-color" : null; }
  function glyph(label, kind, ini) {
    if (kind === "agent" && markOf(label)) return '<span class="pkg-glyph agent">' + agentMark(markOf(label), label, 14) + '</span>';
    return '<span class="pkg-glyph ' + (kind || "") + '" title="' + esc(label) + '">' + esc(ini || String(label || "?").slice(0, 2).toUpperCase()) + '</span>';
  }
  function panelOf(id) {
    var fac = isFactory();
    if (stateOf() === "none" && id !== "rings") return nonePanel(id);
    if (id === "source") return fac ? requestPanel() : upstreamPanel();
    if (id === "build") return fac ? buildPanel() : syncedBuildPanel();
    if (id === "review") return fac ? reviewPanel() : panel({ title: "Review", tag: "not needed", tone: "na", who: [glyphChip("agents", "none", "", "—")], note: "Mirrored as " + esc(upstreamName()) + " publishes it, its signature checked on the way in. Agents only work in the factory: a synced package is never rebuilt, so there is no build to review." });
    return ringsPanel();
  }
  // A name no ring serves and nobody requested: what the factory would do with it, and the way to ask.
  function nonePanel(id) {
    var askFor = '<a href="/factory?name=' + encodeURIComponent(name) + '#request">Request ' + esc(name) + ' →</a>';
    if (id === "source") return panel({ title: "Not in the pool", tag: "free name", tone: "wait", note: "No ring serves " + esc(name) + " and nobody requested it. " + askFor });
    if (id === "build") return panel({ title: "Build", tag: "nothing built", tone: "na", note: "Nothing is built before a request: the factory builds a package from its contributor's recipe, then the project builds it again. <a href=\"/docs/how-it-works\">How a package gets in ›</a>" });
    return panel({ title: "Review", tag: "nothing to review", tone: "na", note: "A maintainer who did not request it reviews a package once it is built." });
  }
  function requestPanel() {
    var req = (ST && ST.request) || {}, pk = (ST && ST.package) || {}, checks = req.checks || [];
    var proj = pk.project || pk.url || "";
    return panel({
      title: "The request", tag: req.complete ? "checked" : "incomplete", tone: req.complete ? "ok" : "warn",
      who: pk.owner ? [whoChip("by", pk.owner)] : [],
      fields: [
        ["package", "name", esc(name) + (pk.status === "rejected" && !blockedBy() ? "" : " · reserved")],
        [/github\.com/.test(proj) ? "github" : "globe", "source", proj ? '<a href="' + esc(proj) + '">' + esc(proj.replace(/^https?:\/\/(www\.)?/, "")) + '</a>' : "—"],
        ["scale", "licence", esc(pk.license || "—")],
        ["cpu", "architectures", esc((req.arches && req.arches.length ? req.arches : pk.arches || []).join(" · ") || "—")],
        ["tag", "release", esc(req.version || "—")],
        ["calendar", "sent", esc(onDay(req.created_at || pk.created_at))]
      ],
      rowsTitle: "Checked when it was sent" + (req.id ? " · request #" + req.id : ""),
      rows: checks.map(function (c) { return [c.ok ? "ok" : "fail", esc(c.item) + (c.note ? ' <span class="dim">· ' + esc(c.note) + '</span>' : ''), c.ok ? "done" : "to put right"]; }),
      // A request that came back — rejected, or no architecture built — says why, in the server's words.
      note: pk.detail && !blockedBy() && ["registered", "rejected", "unmaintained"].indexOf(pk.status) >= 0 ? "Back with its requester: " + esc(pk.detail) : "",
      links: [req.record ? ["file-json", "request.json", req.record] : null, req.signature ? ["key-round", "its signature", req.signature] : null, pk.owner ? ["user", "@" + pk.owner + "'s page", userHref(pk.owner)] : null].filter(Boolean)
    });
  }
  function upstreamPanel() {
    if (!D) return panel({ title: "Upstream", tag: "not served", tone: "wait", note: "No ring serves " + esc(name) + " on " + esc(arch) + "." });
    var m = D.manifest || {}, pi = m.pkginfo || {}, seal = D.seal || {}, up = seal.upstream || {}, pv = D.provenance;
    var rows = [
      [up.verified ? "ok" : "fail", up.verified ? "Signature checked against the " + esc(up.keyring) + " keyring" : "No upstream signature stored for this object", ""],
      ["ok", "Stored once, served as built — never rebuilt", ""],
      ["ok", "Entered the pool " + esc(onDay(seal.indexed_at)), ""]
    ];
    if (pv) rows.push([pv.source === "local" ? "ok" : pv.source === "aur" ? "warn" : "wait", (pv.source === "aur" ? "AUR-synced recipe" + (pv.upstream_commit ? ' tracking <a href="' + esc(pv.aur) + '">' + esc(pv.upstream_commit.slice(0, 7)) + '</a>' : '') : pv.source === "local" ? "Omarchy's own recipe" : "Recipe of unknown origin") + ' in <a href="' + esc(pv.pkgbuild) + '">omarchy-pkgs</a>' + (pv.pkgbuild_commit ? ', last changed ' + esc(pv.pkgbuild_commit.slice(0, 7)) + ' ' + esc(ago(pv.pkgbuild_committed_at)) : '') + (pv.release_ring === "fast" ? ' · built natively for every channel' : '') + (pv.pinned ? ' · version pinned per release' : ''), ""]);
    return panel({
      title: "Upstream", tag: "imported", tone: "ok",
      who: [pi.packager ? glyphChip("packaged by", pi.packager.replace(/<.*>/, "").trim()) : glyphChip("packaged by", upstreamName()), glyphChip("mirrored by", "the pool", "pool", "▣")],
      fields: [
        ["database", "repository", esc(upstreamName()) + " · " + esc(D.package.source)],
        ["globe", "project", m.url ? '<a href="' + esc(m.url) + '">' + esc(m.url.replace(/^https?:\/\//, "")) + '</a>' : "—"],
        ["scale", "licence", esc((m.licenses || []).join(", ") || "—")],
        ["calendar", "built", pi.builddate ? esc(new Date(pi.builddate * 1000).toISOString().slice(0, 10)) : "—"]
      ].concat(pi.base && pi.base !== D.name ? [["package", "base", pkgLink(pi.base)]] : []),
      rowsTitle: "Verified when it entered the pool", rows: rows,
      links: [["file-archive", D.package.filename, D.pool_url]].concat(up.signature ? [["key-round", ".sig", up.signature]] : [])
    });
  }
  // The gate's checks a row stands for, by the names vet_package writes (the build worker's gate): failed, warned, passed, or not run.
  function gateMark(b, keys) {
    var v = b && b.result && b.result.vet;
    if (!b) return ["na", "", "no build"];
    if (!v) return b.status === "failed" ? ["na", "", "the build did not get that far"] : ["wait", "", "not run yet"];
    var hit = function (list) { return (list || []).filter(function (n) { return keys.some(function (k) { return n === k || n.indexOf(k + ":") === 0; }); }); };
    var f = hit(v.failed), w = hit(v.warned);
    return f.length ? ["fail", "failed", f.join(", ")] : w.length ? ["warn", "warning", w.join(", ")] : ["ok", "", "passed"];
  }
  function buildMark(b) {
    if (!b) return ["na", "", "no build"];
    if (b.status === "queued") return waitsForNative(b) ? ["wait", "native worker", waitsForNative(b) + ": it could not run emulated"] : ["wait", "queued", "waiting for a worker"];
    if (b.status === "leased" || b.status === "building") return ["run", "try " + Math.max(1, b.attempts || 1), "building"];
    if (b.status === "staged" || b.status === "done") return ["ok", "", "built"];
    if (b.status === "failed") return ["fail", (b.attempts || 1) + (b.attempts === 1 ? " try" : " tries"), b.error || "failed"];
    return ["na", b.status, b.status];
  }
  function colsOf() { var ts = targetsOf() || {}; return ARCHES.map(function (a) { var s = (ts[a] || {}).status; return s === "not_supported" ? [a + " · not supported", "dim-t"] : !isFactory() || ts[a] || servedOn(a).length ? [a, "ok-t"] : [a + " · not requested", "dim-t"]; }); }
  function buildPanel() {
    var cs = ARCHES.map(chainFor), bs = cs.map(function (c) { return c && c.contributor; });
    var ts = targetsOf() || {}, anyRun = bs.some(function (b) { return b && (b.status === "leased" || b.status === "queued"); }), anyOk = bs.some(function (b) { return b && (b.status === "staged" || b.status === "done"); });
    var agent = D && D.seal && D.seal.chain && D.seal.chain.source_build && D.seal.chain.source_build.agent;
    var au = cs.map(function (c) { return c && c.audit; });
    var rows = [
      ["Built in a clean container", bs.map(buildMark)],
      ["Sources pinned by checksum", bs.map(function (b) { return gateMark(b, ["checksums"]); })],
      ["The recipe lints clean", bs.map(function (b) { return gateMark(b, ["shellcheck", "namcap-pkgbuild"]); })],
      ["namcap clean on the package", bs.map(function (b) { return gateMark(b, ["namcap-package", "namcap-libmap"]); })],
      ["Files and metadata in order", bs.map(function (b) { return gateMark(b, ["files", "metadata", "prebuilt-debug"]); })],
      ["The upstream tests run", bs.map(function (b) { return gateMark(b, ["check"]); })],
      ["Installs and starts with a real pacman", bs.map(function (b) { return gateMark(b, ["smoke"]); })],
      ["Audited by a second agent", au.map(function (a, i) { if (!bs[i]) return ["na", "", "no build"]; if (!a) return ["wait", "", "not queued yet"]; var v = a.result && a.result.verdict; return a.status !== "done" ? ["run", a.status, "the audit is " + a.status] : v === "ok" || v === "pass" ? ["ok", "", (a.result && a.result.summary) || "ok"] : v === "fail" || v === "block" ? ["fail", v, (a.result && a.result.summary) || v] : ["warn", v || "done", (a.result && a.result.summary) || ""]; })]
    ];
    var notes = ARCHES.filter(function (a, i) { return (ts[a] || {}).status === "not_supported" || (bs[i] && bs[i].status === "failed"); }).map(function (a) { var b = bs[ARCHES.indexOf(a)]; return esc(a) + (ts[a] && ts[a].status === "not_supported" ? " did not build after the tries it had, so it is not supported; the other architectures go on to the review" : " failed") + (b && b.error ? ': “' + esc(b.error.slice(0, 240)) + '”' : '') + '.' + (b ? retryAtSize(b) : ''); });
    return panel({
      title: "Factory build", tag: anyRun ? "running" : anyOk ? "ready" : bs.some(Boolean) ? "not built" : "waiting", tone: anyRun ? "run" : anyOk ? "ok" : bs.some(Boolean) ? "fail" : "wait",
      who: (agent ? [glyphChip("built by", agent, "agent")] : []).concat(bs.filter(Boolean).map(function (b) { return glyphChip("on", wtShort(b.lease_owner || "a worker"), "", "W"); })),
      mx: { title: "The same checks on every architecture", cols: colsOf(), rows: rows, foot: [["tries", bs.map(function (b) { return b ? String(b.attempts || 0) : "—"; })], ["time", bs.map(function (b) { return b ? (b.status === "leased" ? "running" : dur(b.duration_ms) || "—") : "—"; })], ["worker", bs.map(function (b) { return b && b.lease_owner ? wtShort(b.lease_owner) : "—"; })]] },
      note: notes.length ? notes.join(" ") : !bs.some(Boolean) ? "Nothing built yet: the request waits for a worker of its architecture." : "",
      links: ARCHES.map(function (a, i) { return bs[i] ? ["scroll-text", a + " · build #" + bs[i].id, evidenceHref(bs[i].id)] : null; }).filter(Boolean)
    });
  }
  function syncedBuildPanel() {
    if (!D) return panel({ title: "Build", tag: "not served", tone: "wait", note: "No ring serves " + esc(name) + " on " + esc(arch) + "." });
    var u = upstreamName();
    var per = function (fn) { return ARCHES.map(function (a) { var rs = servedOn(a); return rs.length ? fn(a, rs) : ["na", "", "not served on " + a]; }); };
    return panel({
      title: "Build", tag: "verified", tone: "ok",
      who: [glyphChip("built by", u), glyphChip("verified by", "the pool", "pool", "▣")],
      mx: { title: "What the pool checks on every architecture", cols: ARCHES.map(function (a) { return [servedOn(a).length ? a : a + " · not served", servedOn(a).length ? "ok-t" : "dim-t"]; }), rows: [
        ["Built and signed upstream", per(function () { return ["na", "upstream", "built by " + u + ", not here"]; })],
        ["Upstream signature verified", per(function (a, rs) { return rs[0].has_signature === false ? ["fail", "none", "no upstream signature"] : ["ok", "", "checked against the keyring on import"]; })],
        ["Stored once, served as built", per(function () { return ["ok", "", "one object, the same bytes in every ring"]; })],
        ["Health and ABI checks on promotion", per(function (a, rs) { var p = rs.filter(function (r) { return promoted(r.ring); })[0]; return p ? ["ok", "", "passed on its way into " + p.ring] : ["wait", rs[0].ring, "checked when it is promoted out of " + PROMISED_UPWARD[0]]; })],
        ["Two green health checks in " + PROMISED_RINGS[0], per(function (a, rs) { return rs.some(function (r) { return r.ring === PROMISED_RINGS[0]; }) ? ["ok", "", "in " + PROMISED_RINGS[0]] : ["wait", "", "not in " + PROMISED_RINGS[0] + " yet"]; })]
      ] },
      note: "Built and signed by " + esc(u) + ". The pool never rebuilds a synced package: it checks the signature, stores the file once and promotes it on evidence. <a href=\"/docs/how-it-works\">How a package gets in ›</a>"
    });
  }
  // The review shown on an architecture: the one of the build its target names once that build is done (or decided); while a newer build is still on its way, the one the rings stand on.
  // A maintainer's claim is the review until it is decided, even while a newer version of the package builds beside it (#282).
  function reviewChain(a) { var k = claimOf(a), t = chainFor(a), s = ((targetsOf() || {})[a] || {}).status || ""; return k ? k : t && (t.project || t.approval || t.withdrawn || ["building", "waiting", ""].indexOf(s) < 0) ? t : approvedChain(a) || t; }
  function reviewPanel() {
    var ts = targetsOf() || {}, owner = (ST && ST.package && ST.package.owner) || "", status = function (a) { return (ts[a] || {}).status || ""; };
    var cur = ARCHES.map(chainFor), stand = ARCHES.map(approvedChain), cs = ARCHES.map(reviewChain);
    var ps = cs.map(function (c) { return c && c.project; });
    var decided = cs.filter(function (c) { return c && (c.approval || c.withdrawn); })[0], ap = decided && (decided.approval || decided.withdrawn);
    // Every architecture built (or not supported) and nobody took it yet: the review is ready for a maintainer, and its checks are all still to come.
    var ready = ARCHES.some(function (a) { return ["built", "reviewing", "reviewed"].indexOf(status(a)) >= 0; });
    // Beside it, the other build: a newer one in the factory while the rings serve an approved one, or the approved one while this review decides a newer.
    var other = ARCHES.map(function (a, i) { return stand[i] && cur[i] && stand[i] !== cur[i] ? { a: a, cur: cur[i], stand: stand[i] } : null; }).filter(Boolean)[0];
    var besides = !other ? "" : cs.indexOf(other.stand) >= 0 ? " A newer build, " + esc(((other.cur.contributor || other.cur.project || {}).version) || "") + ", is on its way: its review starts once it is built." : " " + esc(other.stand.approval.version || "The last version") + " stays approved by " + atLink(other.stand.approval.by) + " meanwhile" + (other.stand.publish && other.stand.publish.status !== "done" ? "; its publish job carries it into edge." : ".");
    // Blocked before any review: nothing was decided, and nothing will be until another maintainer lifts the block.
    if (blockedBy() && !ps.some(Boolean) && !ap) return panel({ title: "Review", tag: "blocked", tone: "na", note: "Blocked before any review decided it. Once another maintainer lifts the block, a new build and a new review start it over." });
    if (!ps.some(Boolean) && !ap && !ready) return panel({ title: "Review", tag: "waiting", tone: "wait", note: "Starts once every architecture is built or not supported. A maintainer who did not request the package has the project build it again on a trusted worker, then decides; " + (owner ? atLink(owner) + " can never review their own request." : "nobody reviews their own request.") + besides });
    var trials = cs.map(function (c) { return c && c.trial; }), pubs = cs.map(function (c) { return c && c.publish; }), audit = cs.map(function (c) { return c && c.audit; }).filter(Boolean)[0];
    // A project build an emulated worker sent back (#281) says what it waits for, in the shell's words.
    var wn = ps.map(function (p) { return waitsForNative(p); }).filter(Boolean)[0], rv = reviewOf();
    var tone = ap ? (ap.withdrawn_at ? "na" : ap.decision === "approved" ? "ok" : "fail") : wn ? "warn" : ps.some(function (p) { return p && (p.status === "leased" || p.status === "queued"); }) ? "run" : ps.some(Boolean) ? "warn" : "wait";
    // Undecided, the tag is Review's word, as the chip and the stage say it (#282), then what a rebuild sent back waits for (#281).
    var tag = ap ? (ap.withdrawn_at ? "withdrawn" : ap.decision) : rv === "in-review" ? (wn ? "in review · " + wn : tone === "run" ? "in review · rebuilding" : "in review") : rv === "ready" ? "ready for review" : wn || "waiting";
    // A cell with no project build yet: to come on an architecture that is built, nothing on one that is not supported or not requested.
    var none = function (i, what) { var s = status(ARCHES[i]); return s === "not_supported" ? ["na", "", "not supported"] : !s ? ["na", "", "not requested"] : ["wait", "", what]; };
    var trialMark = function (t, i) { if (!ps[i]) return none(i, "tried once the project built it again"); if (!t) return ["wait", "", "not tried yet"]; var v = t.result && t.result.verdict; return t.status !== "done" ? ["run", t.status, "the trial is " + t.status] : v === "ok" ? ["ok", "", "a real pacman installed it in the lab"] : ["fail", v || "failed", "the trial did not install it"]; };
    var decideMark = function (c, i) { var a = c && (c.approval || c.withdrawn); if (!a) return c && c.project ? ["wait", "", "waiting for a maintainer"] : none(i, "decided after the project's build"); return a.withdrawn_at ? ["na", "withdrawn", a.withdrawn_reason || "withdrawn"] : a.decision === "approved" ? ["ok", "", "approved by " + a.by] : ["fail", a.decision, a.note || a.decision]; };
    var rows = [
      [ap ? "ok" : "wait", ap ? atLink(ap.by) + " did not request it" : "A maintainer other than " + (owner ? atLink(owner) : "the requester") + " decides", ""],
      [ps.some(function (p) { return p && (p.status === "staged" || p.status === "done"); }) ? "ok" : ps.some(Boolean) ? "run" : "wait", "Built again from the recipe on a trusted worker; the contributor's bytes never ship", ""],
      audit ? [audit.status !== "done" ? "run" : ["ok", "pass"].indexOf((audit.result || {}).verdict) >= 0 ? "ok" : "warn", "Audit: " + esc(((audit.result || {}).verdict || audit.status)) + ((audit.result || {}).summary ? ' <span class="dim">· ' + esc(audit.result.summary) + '</span>' : ''), ""] : ["wait", "Audit by a second agent", ""],
      [trials.some(function (t) { return t && t.result && t.result.verdict === "ok"; }) ? "ok" : trials.some(Boolean) ? "run" : "wait", "Tried in the lab by a real pacman", ""],
      [ap ? (ap.withdrawn_at ? "na" : ap.decision === "approved" ? "ok" : "fail") : "wait", "Verdict: " + (ap ? esc(ap.withdrawn_at ? "withdrawn" : ap.decision) + (ap.note ? ' <span class="dim">· “' + esc(ap.note) + '”</span>' : '') : "pending"), ""]
    ];
    var withRecipes = cs.some(function (c) { return c && c.recipes && c.recipes.contributor && c.recipes.project; });
    var diff = RECIPES.html || (withRecipes ? '<span class="op-label">Recipe vs the factory</span>' + (RECIPES.asked ? '<p class="pkg-small">Reading the two recipes…</p>' : '<button type="button" class="op-btn pkg-recipes" data-recipes>Compare the two recipes</button>') : "");
    var agentOf = audit && audit.result && audit.result.model;
    return panel({
      title: "Independent review", tag: tag, tone: tone,
      who: (ap ? [whoChip("by", ap.by)] : []).concat(agentOf ? [glyphChip("audited with", agentOf, "agent")] : []),
      rowsTitle: "Reviewer checklist", rows: rows,
      mx: { title: "Built again on a project worker", cols: colsOf(), rows: [
        ["Built again by the project", ps.map(function (p, i) { return p ? buildMark(p) : none(i, "built again once a maintainer asks"); })],
        ["The project's gate", ps.map(function (p, i) { var v = p && p.result && p.result.vet; return !p ? none(i, "run on the project's build") : !v ? ["wait", "", "not run yet"] : v.verdict === "fail" ? ["fail", "failed", (v.failed || []).join(", ")] : v.warnings ? ["warn", v.warnings + " warning" + (v.warnings > 1 ? "s" : ""), (v.warned || []).join(", ")] : ["ok", "", "clean"]; })],
        ["Installed in the lab by a real pacman", trials.map(trialMark)],
        ["Decided", cs.map(decideMark)]
      ], foot: [["time", ps.map(function (p) { return p ? (p.status === "leased" ? "running" : dur(p.duration_ms) || "—") : "—"; })], ["worker", ps.map(function (p) { return p && p.lease_owner ? wtShort(p.lease_owner) : "—"; })], ["result", pubs.map(function (p, i) { return p ? (p.status === "done" ? "published" : p.status) : ps[i] && ps[i].status === "staged" ? "in the lab" : "—"; })]] },
      diff: diff,
      note: (ap && ap.decision === "approved" && !ap.withdrawn_at ? "Approved" + (ap.note ? ": “" + esc(ap.note) + "”" : "") + ". The project's build, not the contributor's, is the one that ships." : ap && ap.withdrawn_at ? "Withdrawn by " + (ap.withdrawn_by ? atLink(ap.withdrawn_by) : "a maintainer") + (ap.withdrawn_reason ? ": “" + esc(ap.withdrawn_reason) + "”" : "") + ". It is void from then on; another review decides." : !ps.some(Boolean) ? "Built, waiting for a maintainer who did not request it to have the project build it again on a trusted worker; " + (owner ? atLink(owner) + " can never review their own request." : "nobody reviews their own request.") : "The project's build, not the contributor's, is the one that ships.") + besides,
      links: ARCHES.map(function (a, i) { return ps[i] ? ["scroll-text", a + " · review build #" + ps[i].id, evidenceHref(ps[i].id)] : null; }).filter(Boolean)
    });
  }
  // The two recipes of a review, read once when a reader asks to compare them: the contributor's and the project's, by the addresses the story gives, and the lines between them. A recipe is a few kilobytes; one over RECIPE_MAX is not read whole (its length first, when the answer says it) nor compared here.
  var RECIPE_MAX = 262144;
  function loadRecipes() {
    if (RECIPES.asked) return;
    var c = ARCHES.map(reviewChain).filter(function (x) { return x && x.recipes && x.recipes.contributor && x.recipes.project; })[0];
    if (!c) return;
    RECIPES.asked = true;
    var el0 = $("#recipe-diff"); if (el0) el0.innerHTML = '<span class="op-label">Recipe vs the factory</span><p class="pkg-small">Reading the two recipes…</p>';
    var long = '<span class="op-label">Recipe vs the factory</span><p class="pkg-small">Too long to compare here; the build pages show both.</p>';
    var text = function (u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); if (Number(r.headers.get("content-length")) > RECIPE_MAX) throw new Error("long"); return r.text(); }).then(function (t) { if (t.length > RECIPE_MAX) throw new Error("long"); return t; }); };
    Promise.all([text(c.recipes.contributor), text(c.recipes.project)]).then(function (two) { RECIPES.html = diffHtml(two[0], two[1]); }, function (e) { RECIPES.html = e && e.message === "long" ? long : '<span class="op-label">Recipe vs the factory</span><p class="pkg-small">The two recipes are no longer in staging; the build pages keep what is on the record.</p>'; }).then(function () { var el = $("#recipe-diff"); if (el) el.innerHTML = RECIPES.html; });
  }
  // A line diff (the longest common subsequence of two short files): the changed lines, one line of context around each change.
  function diffHtml(a, b) {
    var x = a.replace(/\n$/, "").split("\n"), y = b.replace(/\n$/, "").split("\n");
    if (x.length * y.length > 250000) return '<span class="op-label">Recipe vs the factory</span><p class="pkg-small">Too long to compare here; the build pages show both.</p>';
    var n = x.length, m = y.length, L = [], i, j;
    for (i = 0; i <= n; i++) { L.push(new Array(m + 1).fill(0)); }
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    var out = [];
    for (i = 0, j = 0; i < n || j < m;) {
      if (i < n && j < m && x[i] === y[j]) { out.push([" ", x[i]]); i++; j++; }
      else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) { out.push(["+", y[j]]); j++; }
      else { out.push(["-", x[i]]); i++; }
    }
    var changed = out.filter(function (l) { return l[0] !== " "; }).length;
    if (!changed) return '<span class="op-label">' + lucide("git-compare", 14) + ' Recipe vs the factory · the same</span><p class="pkg-small">The project\'s agent wrote the recipe again and it came out line for line the same.</p>';
    var keep = out.map(function (l, k) { return l[0] !== " " || (out[k - 1] && out[k - 1][0] !== " ") || (out[k + 1] && out[k + 1][0] !== " "); }), lines = [], gap = false;
    out.forEach(function (l, k) { if (keep[k]) { lines.push('<div class="' + (l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx") + '">' + esc(l[0] + " " + l[1]) + '</div>'); gap = false; } else if (!gap) { lines.push('<div class="gap">  …</div>'); gap = true; } });
    return '<span class="op-label">' + lucide("git-compare", 14) + ' Recipe vs the factory · ' + changed + ' line' + (changed > 1 ? "s" : "") + '</span><div class="pkg-diff">' + lines.join("") + '</div>';
  }
  function ringsPanel() {
    var b = blockedBy(), served = ARCHES.some(function (a) { return servedOn(a).length; });
    var head = '<thead><tr><th>ring</th>' + ARCHES.map(function (a) { return '<th>' + esc(a) + '</th>'; }).join("") + '<th class="num">#</th></tr></thead>';
    var body = RINGS.map(function (r) {
      var cells = ARCHES.map(function (a) { var x = inRing(a, r); return b ? '<td class="dim">' + (x ? "removed" : "—") + '</td>' : x && x.version ? '<td title="' + esc((x.source || "") + (x.sha256 ? " · sha256 " + x.sha256 : "") + (x.size_download ? " · " + bytes(x.size_download) : "")) + '">' + esc(x.version) + '</td>' : x ? '<td>✓</td>' : '<td class="dim">—</td>'; }).join("");
      var mine = inRing(arch, r);
      return '<tr' + (D && r === D.shown_ring ? ' class="on"' : '') + '><td><a href="' + pkgHref(name, r, arch) + '" style="color:' + hue(r) + '">' + r + '</a></td>' + cells + '<td class="num dim">' + (mine && mine.release_seq ? "#" + mine.release_seq : "") + '</td></tr>';
    }).join("");
    var tl = timeline(), state = stateOf();
    var rings = '<div class="pkg-rings"><div class="pkg-rt"><table class="op-table">' + head + '<tbody>' + body + '</tbody></table></div><div class="pkg-tl"><span class="op-label">On the record</span>' + (tl.length ? tl.map(function (e) { return '<div><span class="w">' + esc(e[0]) + '</span><span class="sq" style="color:' + e[1] + '"></span><span class="t" title="' + esc(e[2] + " " + e[3]) + '"><b style="color:' + e[1] + '">' + esc(e[2]) + '</b><span>' + esc(e[3]) + '</span></span></div>'; }).join("") : '<p class="pkg-small">Nothing yet.</p>') + '</div></div>';
    return panel({
      title: "In the rings", tag: b ? "blocked" : served ? "live" : state === "rejected" || state === "none" ? "none" : publishing() ? "publishing" : "not yet", tone: b ? "fail" : served ? "ok" : publishing() ? "run" : state === "rejected" || state === "none" ? "na" : "wait", rings: rings,
      note: b ? "A block " + (((ST && ST.chains) || []).some(function (c) { return c.withdrawn; }) ? "withdraws the approval and takes" : "takes") + " the package out of every ring, on every architecture; it goes back to the factory. Another maintainer lifts it." : served ? "A ring moves up only on evidence: health and ABI checks on both architectures. The same sha256 in two rings is the very same file. <a href=\"/docs/how-it-works\">How it works ›</a>" : state === "none" ? "No ring serves " + esc(name) + "." : state === "rejected" ? "Rejected: no ring serves it. Its requester can send it again." : publishing() ? "Approved: its publish job carries it into edge." : "Not in any ring yet. It enters edge once a maintainer approves it."
    });
  }
  // What happened to the package, as the record has it, oldest first: the request, every decision and every publish — whichever build each was about, so a newer build in the factory never hides the approval the rings serve — the block; then the rings that serve it now.
  function timeline() {
    var ev = [], pk = (ST && ST.package) || {}, req = (ST && ST.request) || {}, b = blockedBy();
    if (isFactory()) {
      if (req.created_at || pk.created_at) ev.push([req.created_at || pk.created_at, "var(--dim)", "requested", pk.owner ? "by @" + pk.owner : ""]);
      ((ST && ST.chains) || []).forEach(function (c) {
        var a = c.approval || c.withdrawn, t = c.project || c.contributor || {}, p = c.publish;
        if (a) ev.push([a.created_at, a.decision === "approved" ? "var(--green)" : "var(--red)", a.decision, "by @" + a.by + " · " + (a.version || t.version || "") + " · " + (a.arch || t.arch)]);
        if (a && a.withdrawn_at && !b) ev.push([a.withdrawn_at, "var(--dim)", "withdrawn", "by @" + (a.withdrawn_by || "a maintainer")]);
        if (p && p.status === "done") ev.push([p.finished_at || p.created_at, "var(--edge)", "entered edge", "publish job #" + p.id + " · " + p.arch]);
        else if (p && (p.status === "queued" || p.status === "leased")) ev.push([p.created_at, "var(--blue)", "publishing", "publish job #" + p.id + " · " + p.arch]);
        else if (p && p.status === "failed") ev.push([p.finished_at || p.created_at, "var(--red)", "publish failed", "publish job #" + p.id + " · " + p.arch]);
      });
    } else if (D && D.seal) ev.push([D.seal.indexed_at, "var(--dim)", "entered the pool", "synced from " + sourceWords(D.package.source, arch)]);
    if (b) ev.push([b.blocked_at, "var(--red)", "blocked", "by @" + (b.blocked_by || "a maintainer") + " · out of every ring"]);
    var at = function (iso) { var t = Date.parse(iso); return isNaN(t) ? 0 : t; };
    var out = ev.sort(function (x, y) { return at(x[0]) - at(y[0]); }).map(function (e) { return [since(e[0]), e[1], e[2], e[3]]; });
    if (!b) PROMISED_UPWARD.forEach(function (r) { var x = inRing(arch, r); if (x) out.push(["now", hue(r), "in " + r, x.release_seq ? "release #" + x.release_seq : arch]); });
    return out;
  }

  // ---- security: the version itself, then what it loads — grouped by the dependency it comes through, one square per advisory in its severity's colour.
  function advItem(a, match) { return '<li><span class="sev" style="color:' + (SEV_COLOR[a.severity] || "var(--dim)") + '">' + esc(a.severity) + '</span><a href="' + esc(a.url) + '">' + esc((a.cves || []).join(", ") || a.id) + '</a><span class="dim" title="how sure the match is — Security explains the three words">' + esc(match || a.match) + (a.fixed ? ' · fixed in ' + esc(a.fixed) : '') + (a.kev ? ' · <span style="color:' + SEV_COLOR.exploited + '">exploited in the wild</span>' : '') + (a.epss != null && a.epss >= 0.1 ? ' · EPSS ' + (a.epss * 100).toFixed(0) + '%' : '') + '</span></li>'; }
  function renderSecurity() {
    var b = blockedBy(), own = $("#sec-own"), exp = $("#sec-exposed");
    if (!D) {
      $("#sec-icon").className = "pkg-h" + (b ? " fail-t" : "");
      own.innerHTML = '<span class="op-label">On this version</span><b class="big ' + (b ? "fail-t" : "dim-t") + '">' + (b ? "blocked" : "—") + '</b><span>' + (b ? "revoked from every ring" : "matched once a ring serves it") + '</span>';
      exp.innerHTML = '<p>Advisories are matched against what the rings serve; no ring serves ' + esc(name) + ' on ' + esc(arch) + (servedAnywhere() ? '. ' + elsewhere() : ' yet.') + '</p>';
      return;
    }
    var s = D.security || { advisories: [], exposed: [] }, open = s.advisories.filter(function (a) { return a.status === "vulnerable"; }), fixed = s.advisories.length - open.length;
    var tone = b || open.length ? "fail-t" : "ok-t";
    $("#sec-icon").className = "pkg-h " + tone;
    own.innerHTML = '<span class="op-label">On this version</span><b class="big ' + tone + '">' + (open.length ? num(open.length) + " open" : "clean") + '</b><span>' + (fixed ? num(fixed) + " advisor" + (fixed > 1 ? "ies" : "y") + " fixed in this version" : open.length ? "on " + esc(D.package.version) : "no advisory open on this version") + '</span>';
    // The version's own open advisories lead the list, open: the same row a dependency's has.
    var mine = open.length ? '<details class="pkg-adv" open><summary><b>' + esc(D.name) + '</b><span class="via">this version · ' + esc(D.package.version) + '</span><span class="dots">' + open.map(function (a) { return '<i style="color:' + (SEV_COLOR[a.severity] || "var(--dim)") + '" title="' + esc(a.severity) + '"></i>'; }).join("") + '</span></summary><ul>' + open.map(function (a) { return advItem(a); }).join("") + '</ul></details>' : '';
    var groups = {}, order = [];
    s.exposed.forEach(function (e) { if (!groups[e.via]) { groups[e.via] = { via: e.via, how: (e.declared ? "declared" : "") + (e.declared && e.sonames.length ? " + " : "") + (e.sonames.length ? "loads " + e.sonames.join(", ") : ""), items: [] }; order.push(e.via); } groups[e.via].items.push(e.advisory); });
    var sevs = {}; s.exposed.forEach(function (e) { sevs[e.advisory.severity] = (sevs[e.advisory.severity] || 0) + 1; });
    exp.innerHTML = mine + '<div class="pkg-sech"><span class="op-label">Through its dependencies · ' + num(s.exposed.length) + '</span><span class="pkg-sevs">' + SEVERITIES.filter(function (k) { return sevs[k]; }).map(function (k) { return '<span style="color:' + (SEV_COLOR[k] || "var(--dim)") + '"><i class="pkg-sq"></i>' + sevs[k] + ' ' + esc(k) + '</span>'; }).join("") + '</span></div>' +
      (order.length ? order.map(function (v) { var g = groups[v]; return '<details class="pkg-adv"><summary><b>' + esc(v) + '</b><span class="via">' + esc(g.how) + '</span><span class="dots">' + g.items.map(function (a) { return '<i style="color:' + (SEV_COLOR[a.severity] || "var(--dim)") + '" title="' + esc(a.severity + " · " + (a.cves || []).join(", ")) + '"></i>'; }).join("") + '</span></summary><ul>' + g.items.map(function (a) { return advItem(a); }).join("") + '<li><a href="' + pkgHref(v, ring, arch) + '">' + esc(v) + '’s page →</a></li></ul></details>'; }).join("") : '<p>Nothing open on anything it depends on or loads.</p>');
  }

  // ---- what it depends on, one per package: what it declares and the packages its libraries come from — the graph's
  // right column and the header's count, one list, so the two never disagree (#275).
  function dependsOn() {
    var right = {}, order = [];
    (D.depends || []).forEach(function (x) { var k = x.provider ? x.provider.name : x.name; if (!right[k]) { right[k] = { name: k, version: x.provider ? x.provider.version : "", provided: !!x.provider, declared: false, sonames: [] }; order.push(k); } right[k].declared = true; });
    (D.links || []).forEach(function (x) { var k = x.provider ? x.provider.name : x.soname; if (!right[k]) { right[k] = { name: k, version: x.provider ? x.provider.version : "", provided: !!x.provider, declared: false, sonames: [] }; order.push(k); } right[k].sonames.push(x.soname); });
    return order.map(function (k) { return right[k]; });
  }

  // ---- a name in the graph cut in the middle, never at its end: where its tail starts — the word in which it parts from the name in the graph
  // it shares the longest prefix with, else its last word; 0 for a name of one word (cut at its end). Two names that share a prefix keep what
  // tells them apart: aarch64-linux-gnu-gcc and aarch64-linux-gnu-linux-api-headers read "aarch64-li…gcc" and "aarch64-li…linux-api-headers"
  // in a narrow node, never both "aarch64-linux-g…" (#282).
  function nameCut(names) {
    return function (n) {
      var common = 0;
      names.forEach(function (m) { if (m === n) return; var i = 0; while (i < n.length && i < m.length && n.charAt(i) === m.charAt(i)) i++; if (i > common) common = i; });
      var word = function (upTo) { for (var i = upTo - 1; i > 0; i--) if ("-_.+".indexOf(n.charAt(i - 1)) >= 0) return i; return 0; };
      return (common && word(Math.min(common + 1, n.length))) || word(n.length);
    };
  }

  // ---- the dependencies: what requires it on the left, what it declares and loads on the right, connected; the rest in full below.
  function renderDeps() {
    var el = $("#deps");
    if (!D) { el.innerHTML = '<p class="pkg-small" style="margin:0">The graph is drawn from the object a ring serves; no ring serves ' + esc(name) + ' on ' + esc(arch) + ' yet.</p>'; return; }
    var vuln = {}; ((D.security && D.security.exposed) || []).forEach(function (e) { vuln[e.via] = (vuln[e.via] || 0) + 1; });
    var MAX = 12, req = D.required_by || [], deps = dependsOn();
    var left = req.slice(0, req.length > MAX ? MAX - 1 : MAX), rightShown = deps.slice(0, deps.length > MAX * 2 ? MAX * 2 - 1 : MAX * 2);
    var cut = nameCut([D.name].concat(left.map(function (x) { return x.name; }), rightShown.map(function (x) { return x.name; })));
    var node = function (x, side) {
      var tag = side === "left" ? (x.sonames.length ? ['so', x.sonames[0]] : ['decl', "depends"]) : (!x.provided ? ['none', "not in " + D.shown_ring] : x.sonames.length ? ['so', x.sonames[0]] : ['decl', "declared"]);
      var at = cut(x.name), nm = at ? '<span class="nh" style="--t:' + (x.name.length - at) + '">' + esc(x.name.slice(0, at)) + '</span><span class="nt">' + esc(x.name.slice(at)) + '</span>' : '<span class="nh">' + esc(x.name) + '</span>';
      return '<a class="pkg-node' + (side === "right" && vuln[x.name] ? " adv" : "") + (side === "right" && !x.provided ? " gone" : "") + '" href="' + pkgHref(x.name, ring, arch) + '" title="' + esc(x.name + (x.version ? " " + x.version : "") + (x.sonames.length ? " · loads " + x.sonames.join(", ") : " · " + tag[1]) + (vuln[x.name] ? " · " + vuln[x.name] + " open advisor" + (vuln[x.name] > 1 ? "ies" : "y") : "")) + '">' + (side === "right" && vuln[x.name] ? '<i class="dot"></i>' : '') + '<span class="l"><span class="nm">' + nm + '</span>' + (side === "right" && x.version ? '<span class="v">' + esc(x.version) + '</span>' : '') + '<span class="t ' + tag[0] + '">' + esc(tag[1]) + '</span></span></a>';
    };
    var lNodes = left.map(function (x) { return node(x, "left"); }), rNodes = rightShown.map(function (x) { return node(x, "right"); });
    if (req.length > left.length) lNodes.push('<button type="button" class="pkg-node" data-more="rb">+' + num(req.length - left.length) + ' more</button>');
    if (deps.length > rightShown.length) rNodes.push('<button type="button" class="pkg-node" data-more="dep">+' + num(deps.length - rightShown.length) + ' more</button>');
    if (!lNodes.length) lNodes.push('<span class="pkg-node gone" title="nothing in ' + esc(D.shown_ring) + ' requires it">nothing requires it</span>');
    if (!rNodes.length) rNodes.push('<span class="pkg-node gone">no dependencies</span>');
    var nl = lNodes.length, nr = rNodes.length, H = Math.max(nl, nr, 2) * 26 - 2, lPad = (H - (nl * 26 - 2)) / 2, rPad = (H - (nr * 26 - 2)) / 2, cy = H / 2;
    var colour = function (x, side) { return side === "right" && !x.provided ? "var(--line)" : x.sonames.length ? "var(--green)" : "var(--blue)"; };
    var paths = function (list, pad, side) { return list.map(function (x, i) { var y = pad + i * 26 + 12; return '<path d="' + (side === "left" ? "M0 " + y + " C32 " + y + " 32 " + cy + " 64 " + cy : "M0 " + cy + " C32 " + cy + " 32 " + y + " 64 " + y) + '" fill="none" stroke="' + colour(x, side) + '" stroke-width="1" opacity="0.8"/>'; }).join(""); };
    var ownOpen = ((D.security && D.security.advisories) || []).some(function (a) { return a.status === "vulnerable"; });
    var provides = ((D.manifest || {}).provides || []).filter(function (x) { return x.split(/[<>=]/)[0] !== D.name; });
    var full = function (id, title, items) { return '<details class="pkg-more" id="' + id + '"><summary>' + esc(title) + '</summary><ul>' + items.join("") + '</ul></details>'; };
    var comps = (D.manifest && D.manifest.components) || [];
    el.innerHTML = '<div class="pkg-graph"><span class="op-label gl">Required by · ' + num(req.length) + (req.length >= 400 ? "+" : "") + '</span>' +
      '<div class="pkg-gcol l" style="padding-block:' + lPad + 'px">' + lNodes.join("") + '</div>' +
      '<svg class="l" width="64" height="' + H + '" aria-hidden="true">' + paths(left, lPad, "left") + '</svg>' +
      '<div class="pkg-center' + (ownOpen ? " fail" : "") + '" title="' + esc(ownOpen ? "an advisory is open on this version" : D.name) + '">' + esc(D.name) + '</div>' +
      '<svg class="r" width="64" height="' + H + '" aria-hidden="true">' + paths(rightShown, rPad, "right") + '</svg>' +
      '<span class="op-label gr">Depends on · ' + num(deps.length) + '</span><div class="pkg-gcol r" style="padding-block:' + rPad + 'px">' + rNodes.join("") + '</div></div>' +
      '<div class="pkg-gfoot"><span>provides <b>' + (provides.length ? esc(provides.join(" · ")) : "only itself") + '</b></span><span>loads <b>' + ((D.links || []).length ? (D.links || []).map(function (l) { return esc(l.soname); }).join(" · ") : "nothing dynamically") + '</b></span></div>' +
      (req.length > left.length ? full("rb-all", "Everything in " + D.shown_ring + " that requires it · " + num(req.length) + (req.length >= 400 ? "+" : ""), req.map(function (x) { return '<li>' + pkgLink(x.name) + ' <span title="' + esc(x.sonames.join(", ")) + '">' + (x.declared ? "declared" : "") + (x.declared && x.sonames.length ? " + " : "") + (x.sonames.length ? "loads " + x.sonames.length + " lib" + (x.sonames.length > 1 ? "s" : "") : "") + '</span></li>'; })) : "") +
      (deps.length > rightShown.length ? full("dep-all", "Everything it depends on · " + num(deps.length), deps.map(function (x) { return '<li>' + (x.provided ? pkgLink(x.name) + ' <span>' + esc(x.version) + '</span>' : esc(x.name) + ' <span>not in ' + esc(D.shown_ring) + '</span>') + '</li>'; })) : "") +
      (comps.length ? '<details class="pkg-more" id="components-section"><summary>Libraries built into its binaries · ' + num(comps.length) + '</summary><p class="pkg-small">Go modules and crates.io crates a statically linked binary was built with: no soname shows them, the security layer matches advisories against them.</p><div class="table-wrap"><table class="op-table" id="components"><thead><tr><th>Ecosystem</th><th>Name</th><th>Version</th></tr></thead><tbody></tbody></table></div></details>' : "");
    if (comps.length) pager("#components", comps, function (x) {
      var href = x.ecosystem === "Go" ? "https://pkg.go.dev/" + x.name + "@" + x.version : x.ecosystem === "crates.io" ? "https://crates.io/crates/" + x.name + "/" + x.version : "";
      return '<tr><td>' + esc(x.ecosystem) + '</td><td>' + (href ? '<a href="' + esc(href) + '">' + esc(x.name) + '</a>' : esc(x.name)) + '</td><td class="mono">' + esc(x.version) + '</td></tr>';
    }, { n: 25 });
  }
  // "+N more" opens the whole list under the graph.
  $("#deps").addEventListener("click", function (ev) { var b = ev.target.closest ? ev.target.closest("[data-more]") : null; if (!b) return; var d = $(b.getAttribute("data-more") === "rb" ? "#rb-all" : "#dep-all"); if (d) { d.open = true; d.scrollIntoView({ block: "nearest" }); } });

  // ---- the files: collapsed, read once when opened.
  function renderFilesHead() {
    var btn = $("#load-files");
    $("#files-count").textContent = D && D.files != null ? num(D.files) + (D.files === 1 ? " file" : " files") : "";
    btn.disabled = !D;
    if (!D) { btn.title = "the files are read from the object a ring serves; no ring serves " + name + " on " + arch + " yet"; $("#files-label").textContent = "once a ring serves it"; $("#files").hidden = true; btn.setAttribute("aria-expanded", "false"); }
  }
  $("#load-files").onclick = function () {
    var box = $("#files"), btn = $("#load-files"), open = box.hidden;
    box.hidden = !open; btn.setAttribute("aria-expanded", String(open)); $("#files-label").textContent = open ? "hide" : "show";
    if (!open || FILES) return;
    box.innerHTML = '<span>loading…</span>';
    busy(fetch("/api/v1/package/" + encodeURIComponent(name) + "/files?ring=" + ((D && D.shown_ring) || ring) + "&arch=" + arch)).then(function (r) { return r.json(); }).then(function (d) {
      FILES = (d.files || []).filter(function (f) { return !/\/$/.test(f); });
      $("#files-count").textContent = num(FILES.length) + (FILES.length === 1 ? " file" : " files");
      // The first FILES_SHOWN as a grid, each path whole on hover; a longer list (a toolchain installs tens of thousands) is one block of text when asked for, never an element per file.
      box.innerHTML = FILES.length ? FILES.slice(0, FILES_SHOWN).map(function (f) { return '<span title="' + esc(f) + '">' + esc(f) + '</span>'; }).join("") + (FILES.length > FILES_SHOWN ? '<button type="button" data-all-files>Show all ' + num(FILES.length) + ' files</button>' : '') : '<span>' + esc(d.error || "no files") + '</span>';
    }).catch(function (e) { box.innerHTML = '<span>failed: ' + esc(errorText(e)) + '</span>'; });
  };
  var FILES_SHOWN = 400;
  $("#files").addEventListener("click", function (ev) { var b = ev.target.closest ? ev.target.closest("[data-all-files]") : null; if (!b || !FILES) return; var pre = document.createElement("pre"); pre.textContent = FILES.join("\n"); $("#files").innerHTML = ""; $("#files").appendChild(pre); });

  // ---- install: the command, or the words to give an agent; nothing to install before a ring serves it.
  var AGENTS = [["Claude Code", "claude-color"], ["Codex", "openai"], ["Cursor", "cursor"], ["Gemini CLI", "gemini-color"], ["GitHub Copilot", "githubcopilot"], ["Grok", "grok"], ["OpenCode", "opencode"], ["Qwen Code", "qwen-color"], ["Kimi", "kimi"], ["Meta", "meta-color"]];
  function renderInstall() {
    var b = blockedBy(), servedHere = D && promised(servedOn(arch)).length, agent = MODE === "agent", state = stateOf(), t = (targetsOf() || {})[arch];
    document.querySelectorAll("#install [data-mode]").forEach(function (x) { var on = x.getAttribute("data-mode") === MODE; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1; });
    $("#install-b").setAttribute("aria-labelledby", "install-" + MODE);
    var text = agent ? "Install " + name + " from omarchy-pool on my ring, and check the seal first." : "sudo pacman -S " + name;
    // Why there is nothing to install, in the words of where the package stands.
    var why = b ? "Blocked. Not installable from any ring."
      : D && PROMISED_RINGS.indexOf(D.shown_ring) < 0 ? "In the lab only: tried, not promised. Installable after approval."
      : state === "none" ? 'Not in the pool: nothing to install. <a href="/factory?name=' + encodeURIComponent(name) + '#request">Request ' + esc(name) + ' →</a>'
      : state === "rejected" ? "Rejected: not installable. Its requester can send it again."
      : !D && servedAnywhere() ? "Not served on " + esc(arch) + (t && t.status === "not_supported" ? ": it did not build there" : "") + ". " + elsewhere()
      : publishing() ? "Approved: installable once its publish job lands it in edge."
      : isFactory() ? "Not in a ring yet. Installable after approval." : "Not served on " + esc(arch) + ".";
    $("#install-b").innerHTML = (servedHere && !b ? '<div class="op-code"><code><span class="op-prompt">' + (agent ? "› " : "$ ") + '</span>' + esc(text) + '</code><button type="button" class="op-copy" data-op-copy="' + esc(text) + '">copy</button></div>'
      : '<div class="pkg-noinst">' + lucide("circle-slash", 15) + '<span>' + why + '</span></div>') +
      (agent ? '<div class="pkg-agents"><span>Works with</span>' + AGENTS.map(function (a) { return '<span class="pkg-am">' + agentMark(a[1], a[0], 18) + '</span>'; }).join("") + '</div><span class="pkg-small">Your agent speaks to the pool through omarchy-cli. <a href="/agents">Connect it ›</a></span>' : '<span class="pkg-small">Pool not set up yet? <a href="/docs/get-started">Set it up once ›</a></span>');
  }
  // Command and Agent are tabs: a click or the arrow keys choose one, and the chosen one takes the focus.
  function setMode(m, focus) { MODE = m; renderInstall(); if (focus) $("#install-" + m).focus(); }
  document.querySelectorAll("#install [data-mode]").forEach(function (t) { t.onclick = function () { setMode(t.getAttribute("data-mode")); }; });
  $("#install-tabs").addEventListener("keydown", function (ev) { if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return; setMode(MODE === "cmd" ? "agent" : "cmd", true); ev.preventDefault(); });

  // ---- the seal: six gates on each architecture, the object's sha256 and the seal as JSON.
  function gateCells(a) {
    var fac = isFactory(), b = blockedBy(), rs = servedOn(a), ts = targetsOf() || {}, c = sealChain(a), state = stateOf();
    var all = function (tone, why) { return [0, 1, 2, 3, 4, 5].map(function () { return [tone, why]; }); };
    if (state === "none") return all("na", "not in the pool");
    if (!rs.length && ts[a] && ts[a].status === "not_supported") return all("na", a + " is not supported");
    if (!rs.length && fac && !ts[a]) return all("na", "not requested for " + a);
    if (b) return all("fail", "revoked: blocked by " + (b.blocked_by || "a maintainer"));
    if (!rs.length && state === "rejected") return all("na", "rejected: nothing to seal");
    if (!rs.length) return all(fac ? "wait" : "na", fac ? "not sealed yet: no ring serves it" : "not served on " + a);
    // The gates are the object the rings serve on this architecture — its row in the answer, and the chain whose approval stands behind it, never a newer build still in the factory.
    var top = rs[0], open = D && D.arches && D.arches[a] ? D.arches[a].open : D404 && D404.arches && D404.arches[a] ? D404.arches[a].open : D && !D.arches && a === arch ? ((D.security && D.security.advisories) || []).filter(function (x) { return x.status === "vulnerable"; }).length : null;
    var inR = function (test) { return rs.some(function (r) { return test(r.ring); }); };
    // Signed: the object's own row says whether its .sig is stored (the pool's signature, or the upstream's kept on import); the seal's key alone is not a signature of this object.
    var signed = fac ? (top.has_signature || (top.has_signature === undefined && a === arch && D && D.seal && D.seal.signature) ? ["ok", "signed by the pool's key"] : ["wait", "the pool signs it when it publishes"]) : (top.has_signature === false ? ["fail", "no upstream signature"] : ["ok", "upstream signature verified on import"]);
    var tr = c && c.trial, installs = fac ? (tr && tr.result && tr.result.verdict === "ok" ? ["ok", "a real pacman installed it in the lab"] : tr ? ["fail", "the lab's trial did not install it"] : ["wait", "not tried in the lab"]) : ["na", "not installed one by one: the ring's health check resolves the whole ring with a real pacman"];
    var abi = inR(promoted) ? ["ok", "passed the ABI check on its way out of edge"] : ["wait", "checked when it is promoted out of edge"];
    var adv = open === null || open === undefined ? ["wait", "not matched yet"] : open ? ["fail", open + " open advisor" + (open > 1 ? "ies" : "y")] : ["ok", "no advisory open on it"];
    var healthy = inR(function (r) { return r === PROMISED_RINGS[0]; }) ? ["ok", "two green health checks in a row before stable"] : ["wait", "stable takes two green health checks in a row"];
    var ap = c && c.approval, last = fac ? (ap && ap.decision === "approved" && !ap.withdrawn_at ? ["ok", "brought by " + ((ST && ST.package && ST.package.owner) || "its contributor") + ", rebuilt and approved by " + ap.by] : ["wait", "no standing approval on " + a]) : ["ok", "served as " + upstreamName() + " built and signed it"];
    return [signed, installs, abi, adv, healthy, last];
  }
  function renderSeal() {
    var fac = isFactory(), b = blockedBy(), sealed = promised(servedOn(arch)).length, state = stateOf();
    var gates = [["key-round", "Signed"], ["package-check", "Installs"], ["binary", "ABI"], ["shield-check", "No open advisory"], ["heart-pulse", "Healthy"], fac || state === "none" ? ["users", "Two people"] : ["copy", "Mirrored as-is"]];
    var cells = ARCHES.map(gateCells), row = D ? inRing(arch, D.shown_ring) : null;
    $("#seal-icon").className = "pkg-h " + (b ? "fail-t" : sealed ? "ok-t" : "dim-t");
    $("#seal-ctx").textContent = b ? "revoked" : D ? D.shown_ring + (row ? " #" + row.release_seq : "") + " · " + arch : servedAnywhere() ? "not served on " + arch : "not sealed yet";
    // A table to assistive tech: a gate per row, an architecture per column, each mark's reason in words.
    $("#seal").innerHTML = '<div role="row"><span role="columnheader"><span class="pkg-vh">gate</span></span>' + ARCHES.map(function (a) { return '<span role="columnheader" title="' + esc(a) + '">' + esc(a.replace("_64", "").replace("aarch64", "arm")) + '<span class="pkg-vh"> (' + esc(a) + ')</span></span>'; }).join("") + '</div>' +
      gates.map(function (g, i) { return '<div role="row"><span class="g" role="rowheader">' + lucide(g[0], 14) + '<span>' + esc(g[1]) + '</span></span>' + cells.map(function (cs, k) { return '<span role="cell">' + mark(cs[i][0], ARCHES[k] + ": " + cs[i][1]) + '</span>'; }).join("") + '</div>'; }).join("");
    var seal = D && D.seal, links = [];
    if (seal && seal.signature) links.push('<a href="' + esc(seal.signature.object) + '">signature</a>');
    if (seal && seal.upstream && seal.upstream.signature) links.push('<a href="' + esc(seal.upstream.signature) + '">signature</a>');
    if (seal && seal.attestation) links.push('<a href="' + esc(seal.attestation.statement) + '">attestation</a>' + (seal.attestation.signature ? ' <a href="' + esc(seal.attestation.signature) + '">.sig</a>' : ''));
    $("#seal-foot").innerHTML = '<span title="' + esc(D ? D.package.sha256 : "") + '">sha256 ' + (D ? esc(D.package.sha256.slice(0, 12)) + "…" : "—") + '</span><span>' + links.join(" · ") + (D ? (links.length ? ' · ' : '') + '<a href="/api/v1/packages/' + esc(D.package.sha256) + '/provenance">seal JSON ›</a>' : '') + '</span>';
  }

  // ---- people and agents, and the facts.
  // A package's maintainer in the pool, the server's word (D.maintenance.maintainer: who adopted it, or whose approval stands) — on the answer, or on the 404 of an architecture that does not serve it; a factory package no ring serves yet is its approver's, as the server says of one it serves. A registration its owner left unmaintained has nobody until a maintainer adopts it (#247), its approval standing or not — the server says so too.
  function maintainerOf() {
    var m = (D && D.maintenance && D.maintenance.maintainer) || (D404 && D404.maintenance && D404.maintenance.maintainer);
    if (m && m.login) return m;
    if (unmaintained()) return null;
    var c = ARCHES.map(approvedChain).filter(Boolean)[0];
    return c ? { login: c.approval.by, since: c.approval.created_at, adopted: false } : null;
  }
  function person(role, label, note, av) { return '<div class="pkg-person">' + av + '<div><span class="r">' + esc(role) + '</span><span class="l">' + label + (note ? '<span> · ' + esc(note) + '</span>' : '') + '</span></div></div>'; }
  function renderPeople() {
    var fac = isFactory(), rows = [], mt = maintainerOf(), nobody = glyph("—", "", "—");
    if (stateOf() === "none") {
      rows.push(person("requested by", "nobody yet", "", nobody));
      rows.push(person("maintainer", "none", "", nobody));
    } else if (fac) {
      // The people behind what the rings serve: on each architecture the chain whose approval stands, else the one its target names — a newer build in the factory is Review's, not theirs.
      var pk = (ST && ST.package) || {}, chain = D && D.seal && D.seal.chain, sb = chain && chain.source_build;
      var cs = ARCHES.map(sealChain).filter(Boolean), ap = cs.map(function (c) { return c.approval; }).filter(Boolean)[0], au = cs.map(function (c) { return c.audit && c.audit.result && c.audit.result.model; }).filter(Boolean)[0];
      var built = cs.map(function (c) { return c.contributor && c.contributor.lease_owner; }).filter(Boolean)[0], rebuilt = cs.map(function (c) { return c.project && c.project.lease_owner; }).filter(Boolean)[0];
      // Undecided: Review's word, the chip's (#282).
      var rv = reviewOf();
      // A registration a maintainer adopted is theirs (#247): the maintainer row below names them, adopted — they did not request it.
      if (pk.owner && !(mt && mt.adopted && mt.login === pk.owner)) rows.push(person("requested by", atLink(pk.owner), "", avatar(pk.owner)));
      if (sb && sb.agent) rows.push(person("drafted & built by", esc(sb.agent), built ? wtShort(built) : "", glyph(sb.agent, "agent")));
      else if (built || !rebuilt) rows.push(person("built on", built ? esc(wtShort(built)) : "not yet", built ? "its contributor's worker" : "", glyph("W", "", "W")));
      rows.push(ap ? person("reviewed by", atLink(ap.by), ap.decision === "approved" ? "rebuilt from scratch" : ap.decision, avatar(ap.by)) : person("reviewed by", rv ? STATE[rv][1] : "not yet", "", nobody));
      if (au) rows.push(person("audit agent", esc(au), "second opinion", glyph(au, "agent")));
      if (rebuilt) rows.push(person("rebuilt on", esc(wtShort(rebuilt)), "a project worker", glyph("▣", "pool", "▣")));
      rows.push(mt ? person("maintainer", atLink(mt.login), mt.adopted ? "adopted " + since(mt.since) + " ago" : "", avatar(mt.login)) : person("maintainer", "none yet", "", nobody));
    } else {
      var pi = (D && D.manifest && D.manifest.pkginfo) || {}, packager = pi.packager ? pi.packager.replace(/<.*>/, "").trim() : "";
      rows.push(person("packaged by", esc(packager || upstreamName()), packager ? upstreamName() : "", glyph(packager || upstreamName())));
      rows.push(person("mirrored by", "the pool", "not rebuilt", glyph("▣", "pool", "▣")));
      rows.push(person("agents", "none", "the factory's alone", nobody));
      rows.push(mt ? person("pool maintainer", atLink(mt.login), "adopted " + since(mt.since) + " ago", avatar(mt.login)) : person("pool maintainer", "none yet", "", nobody));
    }
    $("#who").innerHTML = rows.join("");
  }
  function sizeWords(z) { return "size " + esc(String(z.size)) + " · " + esc(String(z.disk_gb)) + " GB of disk" + (z.from === "page" ? " · set on this page" : z.from === "file" ? " · factory/sizing" : z.disk_from ? "" : " · the default"); }
  // A maintainer sets the size (the select) and the disk budget (the line, in GB; empty: factory/sizing's, or 20 per size) — on the journal with who.
  $("#facts").addEventListener("click", function (ev) {
    var t = ev.target.closest ? ev.target.closest("[data-set-size]") : null; if (!t) return;
    var z = ((ST && ST.package) || {}).sizing || { size: 1 }, opts = [{ value: "", text: "As factory/sizing says, or 1", selected: z.from !== "page" }];
    for (var n = 1; n <= SIZES.max; n++) opts.push({ value: String(n), text: "size " + n + " — " + n * SIZES.cpus + " CPUs, " + n * SIZES.mem_gb + " GB" + (n > SIZES.community_max ? " (a contributor's build runs at " + SIZES.community_max + ")" : ""), selected: z.from === "page" && z.size === n });
    ask({ title: "The size of " + name, text: "What its builds ask for: the CPUs and memory of the size, clamped to the largest host alive. The disk budget is in GB.", select: { label: "Size", options: opts }, input: true, placeholder: "disk budget in GB — empty: factory/sizing's, or 20 per size", confirm: "Set" }).then(function (r) {
      if (r === null) return;
      var disk = r.note === "" ? null : Number(r.note);
      if (disk !== null && !(disk >= 1 && disk === Math.floor(disk))) { toast("The disk budget is a whole number of GB.", "error"); return; }
      api("POST", "/api/v1/factory/packages/" + encodeURIComponent(name) + "/size", { size: r.pick === "" ? null : Number(r.pick), disk_gb: disk }).then(function (d) {
        if (d.error) { toast(esc(d.error), "error"); return; }
        if (ST && ST.package) ST.package.sizing = d.sizing;
        toast(esc(name) + ": " + sizeWords(d.sizing) + "."); renderFacts();
      }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    });
  });
  function fact(icon, k, v, cls) { return '<div>' + lucide(icon, 15, k) + '<span' + (cls ? ' class="' + cls + '"' : '') + ' title="' + esc(k) + '">' + v + '</span></div>'; }
  function renderFacts() {
    var rows = [], m = D ? D.manifest || {} : {}, pi = m.pkginfo || {}, pk = (ST && ST.package) || {};
    if (isFactory()) {
      var proj = pk.project || pk.url || m.url || "";
      rows.push(fact(/github\.com/.test(proj) ? "github" : "globe", "source", proj ? '<a href="' + esc(proj) + '">' + esc(proj.replace(/^https?:\/\/(www\.)?/, "")) + '</a>' : "—"));
      rows.push(fact("scale", "licence", esc(pk.license || (m.licenses || []).join(", ") || "—")));
      rows.push(fact("factory", "origin", "factory · only in the pool"));
      if (pk.category) rows.push(fact("tag", "category", esc(pk.category)));
      // The size and disk budget its builds ask for (#337): this page's word, factory/sizing's, or the default; a maintainer sets it here.
      if (pk.sizing) rows.push(fact("cpu", "size", sizeWords(pk.sizing) + (isMaintainer() ? ' <button type="button" class="op-btn" data-set-size>Set</button>' : "")));
      rows.push(fact("calendar", "requested", esc(onDay((ST && ST.request && ST.request.created_at) || pk.created_at))));
    } else if (D) {
      rows.push(fact("globe", "project", m.url ? '<a href="' + esc(m.url) + '">' + esc(m.url.replace(/^https?:\/\//, "")) + '</a>' : "—"));
      rows.push(fact("scale", "licence", esc((m.licenses || []).join(", ") || "—")));
      rows.push(fact("database", "origin", esc(sourceWords(D.package.source, arch))));
      rows.push(fact("calendar", "built", pi.builddate ? esc(new Date(pi.builddate * 1000).toISOString().slice(0, 10)) : "—"));
    } else if (originOf()) rows.push(fact("database", "origin", esc(sourceWords(originOf().source, originOf().arch)) + " · on " + esc(originOf().arch)));
    if (D) rows.push(fact("file-archive", "download", '<a href="' + esc(D.pool_url) + '">' + bytes(D.package.size_download) + ' · .pkg.tar.zst</a>' + (D.package.has_signature || (D.seal && D.seal.signature) ? ' · <a href="' + esc(D.pool_url) + '.sig">.sig</a>' : '')));
    else rows.push(fact("file-archive", "download", servedAnywhere() ? "no file for " + esc(arch) : "no file in a ring", "dim-t"));
    $("#facts").innerHTML = rows.join("");
  }

  // ---- You: the same page for everyone; what you can do on it is yours. A visitor signs in, the contributor who requested it asks for an update and never reviews it, a maintainer blocks it (the reason on the record), adopts it when nobody looks after it, lifts a block another maintainer made, opens its review. A name nobody requested is anyone's to request.
  function btn(label, attrs, cls) { return '<' + (attrs.indexOf("href=") === 0 ? 'a ' + attrs : 'button type="button" ' + attrs) + ' class="op-btn' + (cls ? " " + cls : "") + '">' + esc(label) + '</' + (attrs.indexOf("href=") === 0 ? "a" : "button") + '>'; }
  function reviewBuild() { var cs = ARCHES.map(chainFor).filter(Boolean), c = cs.filter(function (x) { return x.project && x.project.status === "staged"; })[0] || cs.filter(function (x) { return x.contributor && x.contributor.status === "staged"; })[0]; return c ? (c.project && c.project.status === "staged" ? c.project : c.contributor).id : null; }
  // The reason typed into the brake's form, kept across a redraw (a refusal, a second render): the form is drawn again, the words are not lost.
  var DRAFT = "";
  function renderYou() {
    var me = WHO.me, login = WHO.login, fac = isFactory(), b = blockedBy(), st = stateOf(), pk = (ST && ST.package) || {}, mt = maintainerOf();
    var icon = "eye", who = "not signed in", text = "", btns = [], lock = "";
    var blockBtn = gate(btn("Block", 'data-act="block"', "danger"), fac && !b, !fac ? "a synced package is served as its source publishes it; the brake blocks what the factory built" : "blocked already");
    var request = btn("Request " + name, 'href="/factory?name=' + encodeURIComponent(name) + '#request"', "primary");
    // text is HTML: every login in it is atLink's, everything else escaped here.
    if (!me) { text = st === "none" ? "Nobody requested " + esc(name) + " yet. Sign in to request it." : "Everything on this page is public. Sign in to request changes or review."; if (st === "none") btns.push(request); btns.push(btn("Sign in with GitHub", 'href="' + esc(signInHref()) + '" rel="nofollow"', st === "none" ? "" : "primary")); }
    else if (st === "none") { icon = "user"; who = "@" + login + (isMaintainer() ? " · maintainer" : " · contributor"); text = "No ring serves " + esc(name) + " and nobody requested it."; btns.push(request); }
    else if (pk.owner && pk.owner === login) {
      // A registration a maintainer adopted (#247) is theirs as a request is its requester's: its bumps come to their workers, and another maintainer reviews them.
      var took = mt && mt.adopted && mt.login === login;
      icon = "user"; who = "@" + login + (took ? " · maintainer" : " · requester");
      var req = (ST && ST.request) || {}, why = b ? "blocked: another maintainer lifts the block first" : req.busy ? "a build of it is running (#" + req.busy + "); ask again when it ends" : ["approved", "published"].indexOf(pk.status) >= 0 ? "approved: a new upstream release is built as a bump, by itself" : "not while it is " + (pk.status || "in the factory");
      text = took ? "You adopted this package: its registration is yours, and its bumps come to your workers." : "You requested this package.";
      // A block is refused by the server before anything else (routes/contributors.ts): the renewal is grey while it holds, whatever the registration's status says.
      btns.push(gate(btn("Request an update", 'href="/factory?renew=' + encodeURIComponent(name) + '#request"', "primary"), !!req.renewable && !b, why));
      btns.push(btn("Your requests", 'href="' + userHref(login) + '"'));
      if (isMaintainer()) btns.push(blockBtn);
      lock = took ? "You can't review its builds: another maintainer does." : "You can't review your own request.";
    } else if (isMaintainer()) {
      icon = "shield"; who = "@" + login + " · maintainer";
      if (b) { text = b.blocked_by === login ? "You blocked it. Another maintainer lifts the block." : "Blocked by " + atLink(b.blocked_by) + ". You can lift the block; the reason goes on the record."; btns.push(gate(btn("Lift the block", 'data-act="unblock"', "primary"), b.blocked_by !== login, login + " blocked " + name + "; another maintainer lifts it")); }
      else if (st === "building") { text = "Builds are still running. Nothing to review yet."; btns.push(btn("Open the review queue", 'href="/review"')); btns.push(blockBtn); }
      else if (st === "ready" || st === "in-review") { var tst = targetsOf() || {}, at = function (w) { return Object.keys(tst).some(function (a) { return tst[a].status === w; }); }; text = at("reviewed") ? "The project built it again: the decision is a maintainer's." : at("reviewing") ? "The project builds it again; the decision follows." : "Ready for a maintainer: have the project build it again, then decide."; var rb = reviewBuild(); btns.push(btn("Open review", 'href="' + (rb ? "/build/" + rb : "/review") + '"', "primary")); btns.push(blockBtn); }
      else if (!mt && servedAnywhere()) { text = unmaintained() ? "Left unmaintained by " + atLink(pk.owner) + ". Adopt it: you look after it in the pool, and its registration and bumps become yours." : "No pool maintainer yet. Any maintainer can look after it."; btns.push(btn("Adopt", 'data-act="adopt"', "primary")); btns.push(blockBtn); }
      else {
        var decider = ((ST && ST.chains) || []).map(function (c) { return c.approval; }).filter(function (a) { return a && a.decision === "rejected"; })[0];
        text = mt ? (mt.login === login ? "You maintain this package." : "Maintained by " + atLink(mt.login) + ".") : st === "approved" || publishing() ? "Approved; its publish job carries it into edge." : st === "rejected" ? "Rejected" + (decider ? " by " + atLink(decider.by) : "") + "; back with its requester." : "Not in any ring.";
        if (mt && !D && servedAnywhere()) text += " Not served on " + esc(arch) + ".";
        btns.push(blockBtn);
      }
    } else { icon = "user"; who = "@" + login + " · contributor"; text = "Something wrong with it?"; btns.push(btn("Report a problem", 'href="https://github.com/firemanxbr/omarchy-pool/issues/new?title=' + encodeURIComponent(name + ": ") + '"')); }
    $("#you-icon").innerHTML = lucide(icon, 15);
    $("#you-who").textContent = who;
    $("#you").innerHTML = '<p>' + text + '</p>' + (btns.length ? '<div class="pkg-btns">' + btns.join("") + '</div>' : '') + (lock ? '<span class="pkg-lock">' + lucide("lock", 13) + esc(lock) + '</span>' : '') +
      (ASK ? '<form class="pkg-ask" id="you-ask"><input id="you-why" placeholder="Why? This goes on the record." aria-label="the reason, on the record" aria-describedby="you-err" autocomplete="off" value="' + esc(DRAFT) + '"><p class="err" id="you-err" role="alert" hidden></p>' + (ASK === "block" && (needsPasskey() || PK_SAID) ? '<p class="pk' + (PK_SAID && PK_OK ? " ok" : "") + '" role="status" aria-live="polite">' + (PK_SAID || esc("You hold no passkey yet. Your device makes one now, then confirms the block with it.")) + '</p>' : '') + '<div class="pkg-btns"><button type="submit" class="op-btn ' + (ASK === "block" ? "danger" : "primary") + '">' + (ASK === "block" ? lucide("key-round", 14) + esc(needsPasskey() ? "Register a passkey and block" : "Block " + name + " with your passkey") : esc("Lift the block")) + '</button><button type="button" class="op-btn" data-act="cancel">Cancel</button></div></form>' : '');
    var f = $("#you-ask");
    if (f) {
      f.onsubmit = function (ev) { ev.preventDefault(); act(ASK, $("#you-why").value.trim()); };
      $("#you-why").oninput = function () { DRAFT = $("#you-why").value; };
      // Escape closes the form as Cancel does.
      f.onkeydown = function (ev) { if (ev.key === "Escape") { ev.preventDefault(); closeAsk(); } };
      $("#you-why").focus();
    }
  }
  // The form closed (cancelled, or its act done): the focus goes back to the button that opened it, or to the card's heading when that button is gone or grey.
  function closeAsk() { var what = ASK; ASK = null; DRAFT = ""; PK_SAID = ""; renderYou(); refocus(what); }
  // A maintainer with no passkey yet (#287): Block's first press registers one here, the form staying open with its reason — its next press blocks with it. PK_SAID is what the form says since, as HTML (PK_OK: a passkey made here); while the device asks, the form says so and Block keeps the focus (aria-disabled, not disabled).
  var PK_SAID = "", PK_OK = false;
  function registerFirst() {
    var go = document.querySelector('#you-ask button[type="submit"]'), said = document.querySelector("#you-ask .pk");
    if (go) { if (go.getAttribute("aria-disabled") === "true") return; go.setAttribute("aria-disabled", "true"); }
    if (said) { said.className = "pk"; said.textContent = "Answer your device: your fingerprint, face or PIN."; }
    firstPasskey("Nothing was decided.").then(function (r) {
      // Cancelled while the device asked: the form is gone, and there is nothing more to say.
      if (ASK !== "block") return;
      PK_SAID = r.error ? "" : firstSaid(r, "Press Block " + name + " with your passkey: your device confirms it."); PK_OK = !!r.passkey;
      renderYou();
      if (r.error) { var e = $("#you-err"); e.hidden = false; e.textContent = r.error; }
      var again = document.querySelector('#you-ask button[type="submit"]'); if (again) again.focus();
    });
  }
  function refocus(what) { var b = what ? document.querySelector('#you [data-act="' + what + '"]:not([disabled])') : null; (b || $("#h-you")).focus(); }
  // What a press does: the brake asks its reason in place, then posts once; Adopt posts at once. The answer is drawn at once — the page's data is cached for minutes, the decision is not.
  $("#you").addEventListener("click", function (ev) {
    var t = ev.target.closest ? ev.target.closest("[data-act]") : null; if (!t || t.disabled) return;
    var what = t.getAttribute("data-act");
    if (what === "cancel") { closeAsk(); return; }
    if (what === "adopt") { act("adopt", ""); return; }
    ASK = what; DRAFT = ""; PK_SAID = ""; renderYou();
  });
  function act(what, why) {
    if (what !== "adopt" && why.length < 4) { var e = $("#you-err"); e.hidden = false; e.textContent = "Say why, in a few words — the record keeps it."; $("#you-why").focus(); return; }
    if (what === "block" && needsPasskey()) { registerFirst(); return; }
    document.querySelectorAll("#you button").forEach(function (b) { b.disabled = true; });
    var path = "/api/v1/factory/packages/" + encodeURIComponent(name) + "/" + what;
    // A block is confirmed with the maintainer's passkey (#271): the answer rides with the reason. Adopt and a lift post as they are.
    (what === "block" ? passkeyed("block:package:" + name, function (assertion) { return api("POST", path, { reason: why, assertion: assertion }); }) : api("POST", path, what === "adopt" ? {} : { reason: why })).then(function (d) {
      // Refused: said, and the form stays open with its words for another try.
      if (d.error) { toast(refusalHtml(d), "error"); renderYou(); if (!ASK) refocus(what); return; }
      // Adopt makes you its maintainer in the pool: the package stays what it was, synced or built here — and a registration left unmaintained is yours as well (d.registration: whom it was taken from, where it stands now).
      if (what === "adopt") {
        var box = D || D404; box.maintenance = box.maintenance || {}; box.maintenance.maintainer = { login: WHO.login, since: d.since || new Date().toISOString(), adopted: true };
        if (d.registration && ST && ST.package) { ST.package.owner = WHO.login; ST.package.status = d.registration.status; }
        toast("You now look after " + esc(name) + " in the pool" + (d.registration ? ", and its registration is yours." : ".")); renderAll(); refocus(what); return;
      }
      // The brake is a factory package's (Block is grey on any other): its story, as the next read will tell it.
      ST = ST || { package: { name: name }, chains: [], rings: [] };
      // A block takes the package out of every ring and withdraws the approval it stood on; a lift leaves it out of them, back in the factory: the page draws it as the next read will, not from the answers it came with.
      if (what === "block") {
        ST.package.blocked_at = d.at; ST.package.blocked_by = WHO.login; ST.package.blocked_reason = why; ST.package.status = "rejected";
        (ST.chains || []).forEach(function (c) { if (c.approval && c.approval.decision === "approved" && !c.approval.withdrawn_at) { c.withdrawn = Object.assign({}, c.approval, { withdrawn_at: d.at, withdrawn_by: WHO.login, withdrawn_reason: why, standing: false }); c.approval = null; } });
        toast("Blocked — out of every ring, back in the factory. Another maintainer lifts it.");
      } else { ST.package.blocked_at = null; ST.package.blocked_by = null; ST.package.blocked_reason = null; ST.package.status = "registered"; toast("The block is lifted: back in the factory, a new build and a new review start it over."); }
      ST.rings = []; D404 = { error: name + " is in no ring: " + (what === "block" ? "blocked" : "back in the factory"), arches: {} }; D = null;
      ASK = null; DRAFT = ""; PK_SAID = "";
      renderAll(); refocus(what === "block" ? "unblock" : "block");
    }, function (e) { toast("failed: " + esc(errorText(e)), "error"); renderYou(); if (!ASK) refocus(what); });
  }

  // DRAWN: the page was drawn whole once — before it, who is looking has nothing to change.
  var DRAWN = false;
  function renderAll() { DRAWN = true; renderHead(); renderTiles(); renderChain(); renderSecurity(); renderDeps(); renderFilesHead(); renderInstall(); renderSeal(); renderPeople(); renderFacts(); renderYou(); }

  // The package in its ring and architecture first. An address that named no architecture opens on one that serves it, when the default does not. The index can be busy during a bulk import: a transient 5xx gets retried.
  function loadPackage(attempt) {
    busy(fetch("/api/v1/package/" + encodeURIComponent(name) + "?ring=" + ring + "&arch=" + arch)).then(function (r) {
      if (r.status >= 500) throw new Error("index busy (HTTP " + r.status + ")");
      return r.json().then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (a) {
      // Every link on the page carries the ring the answer is about: the one asked, or the most stable that serves it.
      if (a.ok) { D = a.d; ring = D.shown_ring; } else D404 = a.d;
      var there = !D && !archAsked ? ARCHES.filter(function (x) { return x !== arch && servedOn(x).length; })[0] : null;
      if (there) { arch = there; archAsked = true; D404 = null; loadPackage(attempt); return; }
      withStory();
    }).catch(function (e) {
      if (attempt < 4) { $("#desc").textContent = "The index is busy (" + e.message + "); retrying…"; setTimeout(function () { loadPackage(attempt + 1); }, 4000 * attempt); }
      else $("#desc").textContent = "Could not load this package right now: " + e.message + ". Reload to try again.";
    });
  }
  // The factory's story, only for what the factory built or no ring serves: a synced package has none — found here, or served elsewhere by synced rings alone — and asking would cost a request for a 404. A factory package draws what its answer holds (the tiles, security, the graph, the files) at once, and the rest when its story lands.
  function withStory() {
    var rows = ARCHES.map(servedOn).reduce(function (all, x) { return all.concat(x); }, []);
    if (D ? D.package.source !== "factory" : rows.length && !rows.some(function (r) { return r.source === "factory"; })) { renderAll(); return; }
    if (D) { renderTiles(); renderSecurity(); renderDeps(); renderFilesHead(); }
    fetch("/api/v1/factory/packages/" + encodeURIComponent(name) + "/story").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }).then(function (st) {
      if (st && st.package) ST = st;
      sizesAlive(st);
      // The story is the fresher word (30 s at the edge, the package's answer 10 min): when it puts this architecture in no ring — blocked, or lifted and back in the factory — the answer's object is not what a ring serves any more, and the page draws it as served nowhere here. (A publish younger than the story's 30 s waits for its next read.)
      if (D && ST && ST.rings && !ST.rings.some(function (r) { return r.arch === arch; })) { D404 = { error: name + " is in no ring for " + arch, arches: D.arches }; D = null; }
      renderAll();
    });
  }
  renderTiles();
  loadPackage(1);
  // Who is looking decides the You card alone; the rest is everyone's.
  whoami(function () { if (DRAWN) renderYou(); });
`;

export function packageHtml(name: string, poolUrl: string, version: RunningVersion): string {
  return page({
    path: `/package/${name}`,
    title: `${name} · omarchy-pool`,
    description: `${name}: where it comes from, how it got into the pool, its seal, its dependencies and files.`,
    active: "pool",
    body: packageBody(name),
    script: PACKAGE_SCRIPT.replace("__SOURCE_WORDS__", JSON.stringify(SOURCE_WORDS)) + RETRY_AT_SIZE,
    poolUrl,
    version,
    kit: true,
    css: PACKAGE_CSS,
  });
}

/**
 * What /package/<name> is made of (#244). Everyone reads the same page:
 * two GETs draw it — the package in its ring and architecture (an address
 * that names no architecture opens on one that serves it), then the
 * factory's story of it for what the factory built or no ring serves (a
 * synced package has no story and is not asked for one, whichever
 * architecture is read) — and the file list and the two recipes of a
 * review when a reader asks for them. Only You changes with the
 * viewer, and its three acts are the brake, lifting it and Adopt, each the
 * maintainers' and refused by the server to anyone else. The fixture's zlib
 * is the page (xz requires it, the advisory is on it); xz is the other end
 * of the same edges — it declares zlib and loads its library, so it is
 * exposed through it; `ours` in edge is what a factory package's page reads
 * (its seal's chain, its approval, its publish), `mine`'s story — decided,
 * not yet in the pool — is a factory package no ring serves, and `hers` is
 * blocked.
 */
export const PACKAGE_COMPONENTS = (F: Fixture): Component[] => {
  const page = `/package/${F.pkg}`;
  const pkg = `/api/v1/package/${F.pkg}?ring=stable&arch=${F.arch}`;
  const pkg2 = `/api/v1/package/${F.pkg2}?ring=stable&arch=${F.arch}`;
  const built = `/api/v1/package/${F.publishedPkg}?ring=edge&arch=${F.arch}`;
  const story = `/api/v1/factory/packages/${F.factoryPkg}/story`;
  const shipped = `/api/v1/factory/packages/${F.publishedPkg}/story`;
  return [
    {
      id: "package.crumbs",
      page,
      anchor: ['class="crumbs"', 'href="/packages"', `id="crumb">${F.pkg}<`],
      script: ["location.pathname"],
      visible: EVERYONE,
    },
    {
      // The name (served), the version and the state, where it comes from — the factory, or the source in meta.ts's words — and each architecture: the targets' chips (the shell's targetChips, the server's word), or where a synced package is served.
      id: "package.header",
      page,
      anchor: [`<h1 id="title">${F.pkg}</h1>`, 'id="pkg-ver"', 'id="pkg-state"', 'id="pkg-mark"', 'id="desc"', 'id="pkg-chips"'],
      script: ['"#pkg-state"', "STATE[stateOf()]", "factory · only in the pool", "'synced · '", "sourceWords(o.source, o.arch)", "function originOf()", "SOURCE_WORDS = {", "targetChips(targetsOf())", "servedChips()", "m.description", "pk.description", "versionOf()", "ST.review"],
      reads: [
        { path: pkg, fields: ["name", "package.version", "package.source", "manifest.description", "seal.upstream.project", "arches.x86_64.rings.0.ring", "arches.aarch64.rings"] },
        { path: story, fields: ["package.description", "package.status", "targets", "targets.x86_64.status", "request.version", "review"] },
        // A name no ring serves on this architecture: the answer says where the others serve it, and the page links there or to the factory.
        { path: `/api/v1/package/not-a-package?ring=stable&arch=${F.arch}`, status: 404, fields: ["error", "arches.x86_64.rings", "arches.aarch64.rings"] },
        // Served on another architecture: the answer also says where it comes from, whether an advisory is open there and who looks after it — what the page says of the package whichever architecture is read.
        { path: `/api/v1/package/${F.pkg2}?ring=stable&arch=aarch64`, status: 404, fields: ["error", "arches.x86_64.rings.0.ring", "arches.x86_64.rings.0.source", "arches.x86_64.open", "maintenance.maintainer"] },
      ],
      visible: EVERYONE,
    },
    {
      // Every ring the server lists (RINGS_TEXT, the lab included), the API's shown_ring lit, a ring that does not serve it on this architecture dashed; a chip is the package's one address in that ring or architecture.
      id: "package.ring-arch-pickers",
      page,
      anchor: ['<nav class="op-seg" id="pg-ring"', '<nav class="op-seg" id="pg-arch"'],
      script: ['"#pg-ring"', '"#pg-arch"', "RINGS = Object.keys(RINGS_TEXT)", "function ringChips(d, has)", "pkgHref(d.name, r, arch)", "pkgHref(name, shown || ring, a)", "d.shown_ring"],
      reads: [
        { path: pkg, fields: ["name", "ring", "shown_ring", "arch", "arches.x86_64.rings.0.ring"] },
        { path: `/api/v1/package/${F.pkg}?ring=lab&arch=${F.arch}`, fields: ["ring", "shown_ring"] },
      ],
      visible: EVERYONE,
    },
    {
      // A block is said first, above the tiles: who, when, the reason on the record.
      id: "package.blocked",
      page,
      anchor: ['id="pkg-blocked" hidden'],
      script: ['"#pkg-blocked"', "blockedBy()", "b.blocked_reason", "Another maintainer can lift the block."],
      reads: [{ path: `/api/v1/factory/packages/${F.blockedPkg}/story`, fields: ["package.blocked_at", "package.blocked_by", "package.blocked_reason"] }],
      visible: EVERYONE,
    },
    {
      // Five tiles, each a link to its section; Version opens the Rings stage.
      id: "package.tiles",
      page,
      anchor: ['id="pg-tiles"', 'class="op-stats pkg-tiles"'],
      script: ['"#pg-tiles"', '"Version"', '"Size"', '"Depends on"', '"Required by"', '"Security"', "p.size_download", "p.size_installed", "row.release_seq", 'data-stage="', '"#op-chain", "rings"'],
      reads: [{ path: pkg, fields: ["package.version", "package.size_download", "package.size_installed", "shown_ring", "arch", "depends", "links", "required_by", "security.advisories.0.status", "security.exposed", "arches.x86_64.rings.0.release_seq"] }],
      visible: EVERYONE,
    },
    {
      // How it got here: four stages, a tab each, with its state per architecture — the targets' word for a factory package, where it is served for a synced one — and the chosen one's panel below. A claim whose rebuild an emulated worker sent back says, on its Review stage, the native worker it waits for, as the Factory's card does (the shell's waitsForNative, #281).
      id: "package.stages",
      page,
      anchor: ['id="op-chain"', 'id="stages"', 'role="tablist"', 'id="stage-panel"', 'role="tabpanel"', 'id="chain-note"'],
      script: ['"#stages"', "stagesOf()", "defaultStage()", '"Upstream"', '"Request"', '"Factory build"', '"Review"', '"Rings"', "not needed · mirrored", 'role="tab"', "aria-selected", "ArrowRight", "peopleCount()", "waitsForNative(k.project)", 'waits ? ["warn", "native worker"]', "s.full || s.sum"],
      reads: [
        { path: story, fields: ["targets", "chains.0.contributor.status", "chains.0.contributor.attempts", "chains.0.contributor.finished_at", "chains.0.approval", "request.checks", "request.complete", "request.created_at", "package.owner", "review"] },
        { path: pkg, fields: ["seal.upstream.project", "manifest.pkginfo.builddate", "arches.x86_64.rings"] },
      ],
      visible: EVERYONE,
    },
    {
      // The request as it was checked when it was sent: its fields, its six lines, its signed record.
      id: "package.request-panel",
      page,
      anchor: ['id="stage-panel"'],
      script: ["requestPanel()", "req.checks", "c.item", "c.note", "req.record", "req.signature", '"request.json"', "Back with its requester: "],
      reads: [{ path: story, fields: ["request.checks.0.item", "request.checks.0.ok", "request.checks.0.note", "request.version", "request.arches", "request.record", "request.signature", "request.id", "package.project", "package.license", "package.detail"] }],
      visible: EVERYONE,
    },
    {
      // A synced package's upstream: where it was imported from, its signature checked on the way in, and for an OPR package where its recipe comes from.
      id: "package.upstream-panel",
      page,
      anchor: ['id="stage-panel"'],
      script: ["upstreamPanel()", "up.verified", "up.keyring", "D.provenance", "pv.source", "pv.pkgbuild", "D.pool_url", "pi.base"],
      reads: [{ path: pkg, fields: ["seal.upstream.verified", "seal.upstream.keyring", "seal.upstream.signature", "seal.indexed_at", "manifest.url", "manifest.licenses", "manifest.pkginfo.builddate", "manifest.pkginfo.packager", "package.filename", "pool_url", "provenance"] }],
      visible: EVERYONE,
    },
    {
      // The contributor's build per architecture as the gate says it (vet_package's checks by name) and the second agent's audit; for a synced package, what the pool checks of a build it never makes.
      id: "package.build-panels",
      page,
      anchor: ['id="stage-panel"'],
      script: ["buildPanel()", "syncedBuildPanel()", 'gateMark(b, ["checksums"])', 'gateMark(b, ["smoke"])', "v.failed", "v.warned", "evidenceHref(bs[i].id)", "wtShort(b.lease_owner", "rs[0].has_signature", "retryAtSize(b)", "function oomSize(b)", "data-retry-size"],
      reads: [
        { path: story, fields: ["chains.0.contributor.result.vet.verdict", "chains.0.contributor.result.vet.failed", "chains.0.contributor.result.vet.warned", "chains.0.contributor.lease_owner", "chains.0.contributor.duration_ms", "chains.0.contributor.error", "chains.0.audit"] },
        { path: shipped, fields: ["chains.0.audit.status", "chains.0.audit.result.verdict", "chains.0.audit.result.summary"] },
        { path: pkg, fields: ["arches.x86_64.rings.0.has_signature"] },
      ],
      // Retry at size (#337): a maintainer's, on a build that ran out of memory; the probe's task never did, so nothing is queued.
      acts: [{ method: "POST", path: `/api/v1/factory/tasks/${F.projectTask}/retry`, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 409 } }],
      visible: EVERYONE,
    },
    {
      // The review: the project's build per architecture, its gate, the lab's trial, the decision and the reviewer's checklist — and the two recipes compared, read by the addresses the story gives when a reader asks to compare them. A project build an emulated worker sent back tags the panel and its cell with the native worker it waits for (the shell's waitsForNative, #281).
      id: "package.review-panel",
      page,
      anchor: ['id="stage-panel"'],
      script: ["reviewPanel()", "ps.map(function (p) { return waitsForNative(p); })", "waitsForNative(b) ? [\"wait\", \"native worker\"", "c.project", "c.trial", "c.publish", "ap.withdrawn_at", "evidenceHref(ps[i].id)", "data-recipes", "loadRecipes()", "c.recipes.contributor", "c.recipes.project", "diffHtml(two[0], two[1])", "Recipe vs the factory", "RECIPE_MAX"],
      reads: [
        { path: shipped, fields: ["chains.0.project.status", "chains.0.project.result.vet.verdict", "chains.0.project.lease_owner", "chains.0.trial.status", "chains.0.trial.result.verdict", "chains.0.publish.status", "chains.0.approval.by", "chains.0.approval.note", "chains.0.approval.decision", "chains.0.audit.result.model", "chains.0.recipes.contributor", "chains.0.recipes.project"] },
        { path: story, fields: ["chains.0.recipes.contributor", "chains.0.recipes.project"] },
        { path: `/api/v1/factory/tasks/${F.contributorTask}/artifacts/PKGBUILD`, json: false },
        { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/PKGBUILD`, json: false },
      ],
      visible: EVERYONE,
    },
    {
      // Every ring on both architectures, and what the record says happened: the request, every decision and publish whichever build it was about, the rings now, the block.
      id: "package.rings-panel",
      page,
      anchor: ['id="stage-panel"'],
      script: ["ringsPanel()", "timeline()", "On the record</span>", "x.release_seq", "x.sha256", "hue(r)", "pkgHref(name, r, arch)", "publishing()", '"publishing into edge"'],
      reads: [
        { path: pkg, fields: ["arches.x86_64.rings.0.version", "arches.x86_64.rings.0.release_seq", "arches.x86_64.rings.0.sha256", "arches.x86_64.rings.0.source", "arches.x86_64.rings.0.size_download", "seal.indexed_at"] },
        { path: shipped, fields: ["chains.0.publish.finished_at", "chains.0.publish.id", "chains.0.approval.created_at", "request.created_at", "rings.0.ring", "rings.0.arch"] },
      ],
      visible: EVERYONE,
    },
    {
      // The version's own advisories, then what it loads: grouped by the dependency they come through, a square per advisory in the shell's colour for its severity.
      id: "package.security",
      page,
      anchor: ['id="sec-section"', 'id="sec-own"', 'id="sec-exposed"', 'href="/docs/security#confidence"'],
      script: ['"#sec-own"', '"#sec-exposed"', "advItem", "SEV_COLOR[a.severity]", "SEV_COLOR.exploited", "a.epss", "a.fixed", "e.via", "e.sonames", "e.advisory", "SEVERITIES.filter"],
      reads: [
        { path: pkg, fields: ["package.version", "security.advisories.0.id", "security.advisories.0.severity", "security.advisories.0.status", "security.advisories.0.cves", "security.advisories.0.match", "security.advisories.0.fixed", "security.advisories.0.kev", "security.advisories.0.epss", "security.advisories.0.url"] },
        { path: pkg2, fields: ["security.exposed.0.via", "security.exposed.0.declared", "security.exposed.0.sonames", "security.exposed.0.advisory.severity", "security.exposed.0.advisory.url", "security.exposed.0.advisory.cves", "security.exposed.0.advisory.match"] },
      ],
      visible: EVERYONE,
    },
    {
      // Left: what requires the page's package (zlib's side); right: what it declares and loads (xz's side), with the providers that carry an advisory; the SVG connectors between; the whole lists and the embedded libraries under it. A name wider than its node is cut in the middle, its tail kept (nameCut, #282).
      id: "package.graph",
      page,
      anchor: ['id="deps-section"', 'id="deps"'],
      script: ['"#deps"', "renderDeps", "D.required_by", "x.provider.name", "pkgHref(x.name, ring, arch)", "vuln[x.name]", 'data-more="rb"', 'data-more="dep"', '<svg class="l" width="64"', '<svg class="r" width="64"', "function nameCut(names)", '<span class="nh">', '<span class="nh" style="--t:', '<span class="nt">'],
      reads: [
        { path: pkg, fields: ["name", "shown_ring", "required_by", "required_by.0.name", "required_by.0.declared", "required_by.0.sonames", "manifest.provides", "security.advisories.0.status"] },
        { path: pkg2, fields: ["depends.0.name", "depends.0.provider.name", "depends.0.provider.version", "links.0.soname", "links.0.provider.name", "security.exposed.0.via"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "package.components-table",
      page,
      anchor: ['id="deps"'],
      script: ['id="components-section"', 'pager("#components"', "x.ecosystem", "x.name", "x.version"],
      reads: [{ path: pkg, fields: ["manifest.components", "manifest.components.0.ecosystem", "manifest.components.0.name", "manifest.components.0.version"] }],
      visible: EVERYONE,
    },
    {
      // Collapsed: the count from the package's answer, the list read once when opened.
      id: "package.files",
      page,
      anchor: ['id="files-section"', 'id="load-files"', 'aria-controls="files"', 'id="files" hidden', 'id="files-count"'],
      script: ['"#load-files"', '"#files"', '"/files?ring="', "d.files", "D.files"],
      reads: [
        { path: `/api/v1/package/${F.pkg}/files?ring=stable&arch=${F.arch}`, fields: ["name", "ring", "arch", "files"] },
        { path: pkg, fields: ["files"] },
      ],
      visible: EVERYONE,
    },
    {
      // Install: the command, or the words to give an agent (the kit's marks of the agents it works with); nothing to install before a promised ring serves it here.
      id: "package.install",
      page,
      anchor: ['id="install"', 'id="install-b"', 'data-mode="cmd"', 'data-mode="agent"'],
      script: ["renderInstall", '"sudo pacman -S "', "check the seal first", 'class="op-copy" data-op-copy="', "agentMark(a[1], a[0], 18)", 'href="/docs/get-started"', 'href="/agents"', "Installable after approval."],
      reads: [{ path: pkg, fields: ["shown_ring", "arches.x86_64.rings.0.ring"] }],
      visible: EVERYONE,
    },
    {
      // The seal: six gates on each architecture, what each mark means on hover, the object's sha256, its signatures and attestation, the seal as JSON.
      id: "package.seal",
      page,
      anchor: ['id="seal-section"', 'id="seal"', 'id="seal-foot"', 'id="seal-ctx"'],
      script: ["gateCells", '"Signed"', '"Installs"', '"ABI"', '"No open advisory"', '"Healthy"', '"Two people"', '"Mirrored as-is"', "/provenance\">seal JSON ›", "seal.attestation.statement", "D.arches[a].open"],
      reads: [
        { path: pkg, fields: ["seal.signature", "seal.upstream.signature", "package.sha256", "arches.x86_64.open", "arches.aarch64.open", "arches.x86_64.rings.0.has_signature"] },
        { path: built, fields: ["seal.signature.object", "seal.attestation", "maintenance.maintainer"] },
        { path: `/api/v1/packages/${F.sha}/provenance`, fields: ["origin", "seal", "object", "sha256"] },
      ],
      visible: EVERYONE,
    },
    {
      // The people are the shell's icon and link (@login), their role the maintainer set's; the agents their kit marks; a package's maintainer in the pool is the server's word (maintenance.maintainer: who adopted it, or whose approval stands) — on the 404 of an architecture that does not serve it too. The people of a factory package are those of the approval the rings serve, never of a newer build still in the factory.
      id: "package.people",
      page,
      anchor: ['id="who-section"', 'id="who"'],
      script: ["renderPeople", "D.maintenance.maintainer", "D404.maintenance.maintainer", "sealChain", "sb.agent", "avatar(pk.owner)", "atLink(ap.by)", '"pool maintainer"'],
      reads: [
        { path: pkg, fields: ["maintenance.maintainer", "manifest.pkginfo.packager"] },
        { path: built, fields: ["maintenance.maintainer.login", "maintenance.maintainer.adopted", "seal.chain.source_build.agent"] },
        { path: shipped, fields: ["package.owner", "chains.0.approval.by", "chains.0.audit.result.model", "chains.0.contributor.lease_owner", "chains.0.project.lease_owner"] },
        { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "package.facts",
      page,
      anchor: ['id="facts-section"', 'id="facts"'],
      script: ["renderFacts", '"licence"', '"origin"', "D.pool_url", "D.package.has_signature", "pk.category", "sizeWords(pk.sizing)", "data-set-size", '"/size"', "z.from"],
      reads: [
        { path: pkg, fields: ["manifest.url", "manifest.licenses", "manifest.pkginfo.builddate", "pool_url", "package.has_signature", "package.size_download"] },
        { path: shipped, fields: ["package.project", "package.license", "package.category", "package.created_at", "package.sizing.size", "package.sizing.disk_gb", "package.sizing.from"] },
      ],
      // A package's size (#337): a maintainer's; the probe names none, so nothing is set.
      acts: [{ method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/size`, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 400 } }],
      visible: EVERYONE,
    },
    {
      // You: the one card that changes with the viewer. A visitor signs in; the contributor who requested it asks for an update (the renewal, grey with the story's reason when it is not taken) and never reviews it; a maintainer blocks it with a reason on the record and their passkey (#271) (a factory package: a synced one is grey with why), lifts a block another maintainer made, adopts a package the pool serves that nobody looks after, opens its review. The server refuses every act to anyone else.
      id: "package.you",
      page,
      anchor: ['id="you-section"', 'id="you"', 'id="you-who"'],
      script: ["renderYou", "signInHref()", '"Sign in with GitHub"', '"Request an update"', "You can't review your own request.", '"Adopt"', '"Block"', '"Lift the block"', '"Open review"', "!!req.renewable && !b", "isMaintainer()", "Why? This goes on the record.", 'role="alert"', '"Left unmaintained by "', "d.registration", 'passkeyed("block:package:" + name', '" with your passkey"', 'toast(refusalHtml(d), "error")'],
      reads: [{ path: story, fields: ["request.renewable", "request.busy", "package.owner", "package.status"] }],
      acts: [
        // No reason, no block: the probes change nothing.
        { method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/block`, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 400 } },
        { method: "POST", path: `/api/v1/factory/packages/${F.blockedPkg}/unblock`, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 400 } },
        // ours is served under m2's approval: it has its maintainer, and the probe adopts nothing — the one Adopt, Review's No maintainer tab's too (routes/adopt.ts).
        { method: "POST", path: `/api/v1/factory/packages/${F.publishedPkg}/adopt`, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 409 } },
      ],
      visible: EVERYONE,
    },
  ];
};
