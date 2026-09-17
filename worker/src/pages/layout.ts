/**
 * Shared page frame of the dashboard: styles (omarchy.org's Tokyo Night look),
 * the header with the four doors and the running version, the footer,
 * and the small helpers every page script uses. No build step: each page is a
 * string with a <script> that reads /api/v1/stats.
 */
import type { RunningVersion } from "../meta";
import { DOCS_TREE, GLOSSARY, type DocKey } from "./docs-tree";
import { RING_TEXT } from "../meta";
import { escapeHtml } from "../html";

export const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

const CSS = String.raw`
  :root {
    --bg: #1a1b26; --bg-deep: #0e0e14; --panel: #1f2230; --panel-2: #13141c; --line: #2a2e3f;
    --text: #c0caf5; --muted: #a9b1d6; --dim: #8b93b8; --green: #9ece6a; --green-ink: #0c0e10;
    --amber: #e0af68; --red: #f7768e; --blue: #7aa2f7;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; } /* a class with its own display (.gate is a grid) must not undo hidden — the Factory's sign-in gate stayed visible after signing in */
  html { color-scheme: dark; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
  a { color: var(--text); }
  h1, h2, h3 { font-family: Geist, "JetBrains Mono", sans-serif; letter-spacing: -0.02em; margin: 0; }
  h1 { font-size: 30px; font-weight: 600; }
  h2 { font-size: 22px; font-weight: 600; }
  h3 { font-size: 16px; font-weight: 600; }
  code, .mono { font-family: "JetBrains Mono", ui-monospace, monospace; }
  .num { font-variant-numeric: tabular-nums; }

  header { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 24px; padding: 14px 32px; border-bottom: 1px solid var(--line); background: var(--bg-deep); }
  header .hmid { display: flex; align-items: center; gap: 34px; justify-self: center; }
  header .brand { display: flex; align-items: center; gap: 12px; font-weight: 600; color: var(--text); text-decoration: none; }
  header .brand .mark { width: 22px; height: 22px; background: var(--green); display: grid; place-items: center; color: var(--green-ink); font-size: 12px; font-weight: 700; }
  header nav { display: flex; gap: 22px; font-size: 14px; }
  header nav a { color: var(--muted); text-decoration: none; padding-bottom: 2px; border-bottom: 1px solid transparent; }
  header nav a:hover { color: var(--text); }
  header nav a.active { color: var(--text); border-bottom-color: var(--green); }
  header .account { font-size: 13px; border: 1px solid var(--line); padding: 5px 11px; white-space: nowrap; display: inline-flex; align-items: center; max-width: min(46vw, 420px); justify-self: end; }
  header .account #account { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
  /* A long GitHub login never wraps the header: the name is cut with an ellipsis (the full one is the link's title). */
  header .account b { max-width: 18ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header #status { margin-left: 0; }
  header .account:hover { border-color: var(--green); }
  header .account a { color: var(--text); text-decoration: none; }
  header .account .who { color: var(--muted); }
  header .account #signout { color: var(--muted); margin-left: 10px; padding-left: 10px; border-left: 1px solid var(--line); }
  header .account #signout:hover { color: var(--text); }
  .gh { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); text-decoration: none; font-size: 13.5px; }
  .gh:hover { color: var(--text); }
  .gh svg { width: 18px; height: 18px; fill: currentColor; }
  .status { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--dim); text-decoration: none; }
  .status .led { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); box-shadow: 0 0 0 0 rgba(158,206,106,0); }
  .status.online .led { background: var(--green); animation: pulse 2.4s ease-out infinite; }
  .status.online { color: var(--green); }
  .status.degraded .led { background: var(--amber); } .status.degraded { color: var(--amber); }
  .status.offline .led { background: var(--red); } .status.offline { color: var(--red); }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(158,206,106,.55); } 70% { box-shadow: 0 0 0 7px rgba(158,206,106,0); } 100% { box-shadow: 0 0 0 0 rgba(158,206,106,0); } }
  .v.bump { animation: bump .5s ease-out; } @keyframes bump { 0% { color: var(--green); } 100% { color: inherit; } }
  .ring .desc { font-size: 13px; color: var(--muted); line-height: 1.5; }
  .ring .cta { margin-top: auto; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .ring .cta a { font-size: 13px; color: var(--green); text-decoration: none; }
  .ring .cta a:hover { text-decoration: underline; }
  .pill.rec { color: var(--green-ink); background: var(--green); border-color: var(--green); }
  .steps { display: grid; gap: 16px; max-width: 900px; }
  .step { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; }
  .step h3 { margin-bottom: 6px; }
  .step p { color: var(--muted); font-size: 14px; margin: 0 0 10px; }
  .choice { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 12px; }
  .choice button { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); padding: 5px 12px; font: inherit; font-size: 13px; cursor: pointer; }
  .choice button.on { color: var(--green-ink); background: var(--green); border-color: var(--green); }
  .step pre { position: relative; padding-right: 76px; white-space: pre-wrap; word-break: break-all; }
  .copy { position: absolute; right: 8px; top: 8px; font-size: 12px; color: var(--dim); cursor: pointer; border: 1px solid var(--line); padding: 1px 8px; background: var(--panel); }
  .copy:hover { color: var(--text); }
  footer .sep { color: var(--line); }
  .searchbar { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; margin: 0 0 10px; }
  .searchbar input { flex: 1 1 380px; font: inherit; font-size: 15px; padding: 9px 12px; background: var(--panel-2); color: var(--text); border: 1px solid var(--line); }
  .searchbar input:focus { outline: none; border-color: var(--green); }
  .searchbar .choice { margin: 0; }
  .crumbs { color: var(--dim); font-size: 13px; margin: 0 0 6px; } .crumbs a { color: var(--muted); text-decoration: none; }
  .gloss-list { display: grid; grid-template-columns: max-content 1fr; gap: 10px 18px; max-width: 900px; } .gloss-list dt { font-family: Geist, sans-serif; font-weight: 600; font-size: 14px; } .gloss-list dt a { color: var(--text); text-decoration: none; } .gloss-list dt:target a { color: var(--green); } .gloss-list dd { margin: 0; color: var(--muted); font-size: 13.5px; }
  .shot { border: 1px solid var(--line); background: var(--panel-2); padding: 14px 16px; color: var(--dim); font-size: 13px; margin: 8px 0 14px; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px 10px; font-size: 13px; color: var(--muted); margin: 10px 0 36px; }
  .meta .sep { color: var(--line); }
  ul.plain { list-style: none; margin: 0; padding: 0; font-size: 13.5px; line-height: 1.8; }
  ul.plain.cols { columns: 2; column-gap: 24px; } ul.plain li { break-inside: avoid; }
  ul.plain a { text-decoration: none; color: var(--text); border-bottom: 1px dotted var(--dim); } ul.plain a:hover { color: var(--green); }
  #graph svg { width: 100%; height: auto; display: block; } #graph a { cursor: pointer; } #graph a:hover rect { stroke-width: 2; }
  .choice-btn { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); padding: 3px 10px; font: inherit; font-size: 12.5px; cursor: pointer; vertical-align: middle; margin-left: 8px; }
  #files { max-height: 420px; overflow: auto; }
  footer .gh { font-size: 13px; }
  header .spacer { display: none; }
  .btn { background: var(--green); color: var(--green-ink); font-weight: 500; padding: 6px 14px; text-decoration: none; font-size: 14px; }
  .btn:hover { filter: brightness(1.08); }
  .ver { font-size: 12.5px; letter-spacing: .04em; color: var(--green); border: 1px solid var(--green); padding: 2px 8px; text-decoration: none; white-space: nowrap; }
  .ver:hover { background: var(--green); color: var(--green-ink); }

  main { max-width: 1240px; margin: 0 auto; padding: 36px 32px 40px; }
  main > :last-child { margin-bottom: 0; } /* the last box on a page (the sponsor ask, a table) sits close to the footer: no leftover space */
  .lede { color: var(--muted); margin: 8px 0 0; max-width: 78ch; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin: 28px 0 40px; }
  .tile { background: var(--panel); padding: 18px 20px; }
  .tile .k { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  .tile .v { font-family: Geist, sans-serif; font-size: 30px; font-weight: 600; margin-top: 4px; }
  .tile .s { font-size: 13px; color: var(--muted); margin-top: 2px; }

  section { margin: 0 0 44px; }
  section > h2 { margin-bottom: 4px; }
  section > p.sub { color: var(--muted); margin: 0 0 16px; font-size: 14px; }

  .rings { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: 16px; }
  .ring { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
  .ring .head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .ring .name { font-family: Geist, sans-serif; font-size: 20px; font-weight: 600; }
  .ring .rel { color: var(--muted); font-size: 13px; }
  button.small { font-size: 12px; padding: 2px 8px; margin-left: 6px; }
  .pill { display: inline-block; font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; padding: 2px 8px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
  .pill.ok { color: var(--green); border-color: var(--green); }
  .pill.warn { color: var(--amber); border-color: var(--amber); }
  .mono.warn { color: var(--amber); }
  .iconbtn { background: none; border: 0; padding: 0 2px; cursor: pointer; color: var(--muted); vertical-align: middle; } .iconbtn:hover { color: var(--text); } .iconbtn .ic { width: 14px; height: 14px; }
  dialog.ask.wide { width: min(880px, 94vw); } dialog.ask pre.block { max-height: 60vh; overflow: auto; margin: 0; background: var(--bg-deep); border: 1px solid var(--line); padding: 10px 12px; font: 12px/1.5 "JetBrains Mono", monospace; color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; }
  .pill.error { color: var(--red); border-color: var(--red); }
  .pill.none { color: var(--dim); }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 13.5px; }
  .kv dt { color: var(--dim); }
  .kv dd { margin: 0; }
  .sources { display: flex; flex-wrap: wrap; gap: 6px; }
  .arch { border-top: 1px solid var(--line); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
  .archhead { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .archname { font-family: "JetBrains Mono", monospace; font-size: 12.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  pre .c { color: var(--dim); }
  .howto { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr)); gap: 16px; }
  .howto .arch { border: 1px solid var(--line); background: var(--panel); padding: 16px 18px; }
  .src { border: 1px solid var(--line); padding: 2px 8px; font-size: 12.5px; background: var(--panel-2); }
  pre { margin: 0; background: var(--bg-deep); border: 1px solid var(--line); padding: 10px 12px; font-size: 12.5px; overflow-x: auto; color: var(--muted); }
  pre b { color: var(--green); font-weight: 500; }

  /* Loading: a thin bar at the top while any request is in flight, and
     skeleton rows/tiles so a page never looks frozen or jumps in from nothing. */
  #progress { position: fixed; top: 0; left: 0; height: 2px; width: 0; background: var(--green); z-index: 50; opacity: 0; transition: opacity .2s; }
  #progress.on { opacity: 1; animation: progress 1.6s ease-in-out infinite; }
  @keyframes progress { 0% { width: 0; margin-left: 0 } 50% { width: 60%; margin-left: 20% } 100% { width: 0; margin-left: 100% } }
  /* .skl is the shimmering bar; .skel marks a placeholder row or tile (removed when data lands). */
  .skl { display: inline-block; height: 12px; width: 70%; border-radius: 2px; background: linear-gradient(90deg, var(--line) 25%, var(--panel-2) 50%, var(--line) 75%); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; vertical-align: middle; }
  tr.skel td:nth-child(2n) .skl { width: 45%; } tr.skel td:nth-child(3n) .skl { width: 30%; }
  .tile.skel .v .skl { height: 26px; width: 55%; } .tile.skel .s .skl { width: 80%; }
  @keyframes shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
  .empty.loading { color: var(--dim); }
  .empty.loading::after { content: "…"; animation: dots 1.2s steps(4, end) infinite; }
  @keyframes dots { 0% { content: "" } 25% { content: "." } 50% { content: ".." } 75% { content: "..." } }

  .form { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 12px 18px; align-items: end; margin: 14px 0; }
  .form label { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--dim); letter-spacing: .04em; text-transform: uppercase; }
  .form label .choice label { flex-direction: row; text-transform: none; letter-spacing: 0; font-size: 13.5px; color: var(--text); align-items: center; gap: 6px; }
  .form .checklist { grid-column: 1 / -1; display: grid; gap: 7px; padding: 10px 12px; border: 1px solid var(--line); background: var(--bg-deep); }
  .form .checklist label { flex-direction: row; align-items: flex-start; gap: 9px; text-transform: none; letter-spacing: 0; font-size: 13px; color: var(--muted); line-height: 1.45; } .form .checklist input { margin-top: 3px; flex: none; }
  .form details.form-more { grid-column: 1 / -1; } .form details.form-more summary { cursor: pointer; font-size: 12.5px; color: var(--dim); letter-spacing: .04em; text-transform: uppercase; }
  .request-panel { max-width: 860px; } .request-panel .form { margin-top: 4px; } .request-panel .done { border: 1px solid var(--green); background: var(--panel-2); padding: 14px 16px; font-size: 13.5px; margin-top: 12px; } .request-panel .done b { color: var(--text); }
  .form details.form-more[open] { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 12px 18px; } .form details.form-more[open] summary { grid-column: 1 / -1; }
  .form input[type="text"], .form input[type="url"], .form select, .searchbar input[type="password"] { background: var(--bg-deep); border: 1px solid var(--line); color: var(--text); padding: 8px 10px; font: inherit; font-size: 13.5px; }
  .form button, .searchbar button, table button { background: var(--panel-2); border: 1px solid var(--line); color: var(--text); padding: 8px 14px; font: inherit; font-size: 13.5px; cursor: pointer; }
  .form button:hover, .searchbar button:hover, table button:hover { border-color: var(--green); }
  table button { padding: 3px 9px; font-size: 12.5px; }

  a.button { display: inline-block; border: 1px solid var(--green); padding: 8px 14px; text-decoration: none; color: var(--text); }
  a.button:hover { background: var(--panel-2); }
  .pager { display: flex; gap: 10px; align-items: center; margin: 10px 0 6px; font-size: 12.5px; color: var(--dim); flex-wrap: wrap; }
  .pager input { background: var(--bg-deep); border: 1px solid var(--line); color: var(--text); padding: 5px 9px; font: inherit; font-size: 12.5px; min-width: 200px; }
  .pager select { background: var(--bg-deep); border: 1px solid var(--line); color: var(--text); padding: 5px 6px; font: inherit; font-size: 12.5px; }
  .pager .count { margin-left: auto; }
  select.cat { background: var(--bg-deep); border: 1px solid var(--line); color: var(--text); padding: 2px 4px; font: inherit; font-size: 12px; margin-top: 3px; }

  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); font-weight: 500; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .table-wrap { overflow-x: auto; border: 1px solid var(--line); background: var(--panel); }
  .dot { display: inline-block; width: 8px; height: 8px; margin-right: 8px; vertical-align: middle; background: var(--dim); }
  .dot.ok { background: var(--green); } .dot.warn { background: var(--amber); } .dot.error { background: var(--red); }
  .kind { display: inline-block; min-width: 68px; color: var(--blue); }
  .when { color: var(--dim); white-space: nowrap; }
  .muted { color: var(--muted); }
  footer { border-top: 1px solid var(--line); background: var(--bg-deep); padding: 18px 32px 20px; font-size: 13px; color: var(--dim); display: grid; grid-template-columns: 1fr auto 1fr; align-items: start; gap: 16px 24px; }
  footer .more { justify-self: center; } footer .fright { justify-self: end; }
  footer a { color: var(--muted); text-decoration: none; }

  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr)); gap: 16px; margin: 16px 0; }
  .chart { border: 1px solid var(--line); background: var(--panel); padding: 14px 16px 10px; min-width: 0; }
  .chart h3 { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .chart h3 span { font-family: "JetBrains Mono", monospace; font-size: 12px; font-weight: 400; color: var(--dim); }
  .chart .sub { font-size: 12.5px; color: var(--dim); margin: 2px 0 8px; }
  .chart svg { display: block; width: 100%; overflow: visible; }
  .chart .empty { color: var(--dim); font-size: 13px; padding: 24px 0; text-align: center; }
  .bar { display: inline-block; height: 8px; background: var(--panel-2); border: 1px solid var(--line); width: 140px; vertical-align: middle; position: relative; }
  .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--green); }
  .bar i.partial { background: var(--amber); }
  .pct { font-size: 12px; color: var(--muted); margin-left: 8px; }
  .legend { display: flex; gap: 14px; font-size: 12px; color: var(--muted); margin-top: 6px; flex-wrap: wrap; }
  .legend i { display: inline-block; width: 10px; height: 10px; margin-right: 5px; vertical-align: middle; }
  a.run { color: var(--muted); text-decoration: none; border-bottom: 1px dotted var(--dim); }
  a.run:hover { color: var(--text); }
  #graph { overflow-x: auto; } #graph svg { min-width: 720px; }
  @media (max-width: 720px) {
    header { grid-template-columns: 1fr auto; grid-template-areas: "brand account" "mid mid"; gap: 10px 12px; padding: 12px 16px; }
    header .brand { grid-area: brand; } header .account { grid-area: account; max-width: 60vw; }
    header .hmid { grid-area: mid; justify-self: stretch; gap: 16px; overflow-x: auto; white-space: nowrap; padding-bottom: 4px; margin: 0 -16px; padding-left: 16px; padding-right: 16px; scrollbar-width: none; }
    header .hmid::-webkit-scrollbar { display: none; }
    header nav { gap: 16px; }
    footer { grid-template-columns: 1fr; justify-items: start; }
    main { padding: 20px 16px 28px; }
    h1 { font-size: 22px; line-height: 1.25; } h2 { font-size: 19px; }
    .lede { font-size: 14px; }
    .tile .v { font-size: 24px; }
    .searchbar input { flex-basis: 100%; }
    .meta { margin-bottom: 24px; }
    ul.plain.cols { columns: 1; }
    .step pre { padding-right: 12px; padding-top: 34px; } .copy { top: 6px; }
    footer { padding: 16px 16px 18px; gap: 12px 14px; } footer .fright { justify-self: start; justify-items: start; }
    section { margin-bottom: 32px; }
  }
  /* ---- the three doors: heroes, diagrams, cards, live pieces (v2 of the dashboard) ---- */
  :root { --lilac: #bb9af7; --edge: var(--lilac); --rc: var(--blue); --stable: var(--green); --lab: var(--amber); }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  h1, h2, h3 { text-wrap: balance; }
  header .brand { white-space: nowrap; } header .account { flex: none; } header nav { gap: 18px; }
  header .account .avatar { width: 22px; height: 22px; font-size: 10.5px; margin-right: 8px; vertical-align: middle; }
  header nav a small { color: var(--dim); font-size: 11px; margin-left: 5px; letter-spacing: .06em; text-transform: uppercase; }
  footer .fleft, footer .fright { display: grid; gap: 5px; align-content: start; } footer .fleft { justify-items: start; } footer .fright { justify-items: end; }
  footer .fnote { font-size: 12px; color: var(--dim); line-height: 1.4; } footer a.fnote:hover { color: var(--text); }
  footer .fbadge { display: inline-flex; align-items: center; } footer .fbadge svg { display: block; height: 20px; width: auto; } footer .fbadge:hover svg { filter: brightness(1.1); }
  footer .more { display: inline-flex; gap: 10px 14px; flex-wrap: wrap; } footer .more a.active { color: var(--green); }
  .hero { display: grid; gap: 14px; margin: 0 0 32px; max-width: 900px; }
  .hero h1 { font-size: 34px; line-height: 1.15; max-width: 22ch; }
  .hero.compact { margin-bottom: 22px; } .hero.compact h1 { font-size: 28px; }
  .eyebrow { margin: 0; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--green); }
  .hero .lede { margin: 0; max-width: 70ch; font-size: 15.5px; }
  .cta-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-top: 6px; }
  .btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--line); } .btn.ghost:hover { border-color: var(--green); filter: none; }
  .btn { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--green); cursor: pointer; font: inherit; font-size: 14px; }
  .btn svg { width: 16px; height: 16px; fill: currentColor; }
  .hint { font-size: 13px; color: var(--dim); }
  .h2row { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-bottom: 4px; } .h2row h2 { margin: 0; } .h2row .hint:not(:last-child) { margin-right: auto; }
  .more-link { font-size: 13px; color: var(--green); text-decoration: none; } .more-link:hover { text-decoration: underline; } button.more-link { background: none; border: 0; padding: 0; cursor: pointer; font: inherit; font-size: 13px; }
  .sub a, .lede a { color: var(--green); text-decoration: none; } .sub a:hover, .lede a:hover { text-decoration: underline; }
  .tile .v.ok { color: var(--green); } .tile .v.warn { color: var(--amber); }
  .tiles.six { grid-template-columns: repeat(auto-fit, minmax(min(172px, 100%), 1fr)); }
  .tiles.five { grid-template-columns: repeat(auto-fit, minmax(min(188px, 100%), 1fr)); }
  .tiles.four { grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); margin: 16px 0; } .tiles.four .tile .v { font-size: 40px; line-height: 1.1; margin-top: 6px; }
  a.tile { color: inherit; text-decoration: none; display: block; } a.tile:hover { background: var(--panel-2); } a.tile:hover .v { color: var(--green); }
  .feed-box { border: 1px solid var(--line); background: var(--panel); padding: 16px 20px; }
  .pill.blue { color: var(--blue); border-color: var(--blue); } .pill.lilac { color: var(--lilac); border-color: var(--lilac); }
  .dot.blue { background: var(--blue); }
  .dim { color: var(--dim); }
  .searchbar input[type="search"], .searchbar input[type="text"] { -webkit-appearance: none; appearance: none; border-radius: 0; background: var(--bg-deep); font-size: 14px; padding: 10px 14px; }
  .searchbar input::placeholder { color: var(--dim); } .searchbar input::-webkit-search-decoration, .searchbar input::-webkit-search-cancel-button { -webkit-appearance: none; }
  .searchbar input:focus { box-shadow: 0 0 0 3px rgba(158,206,106,.14); }
  .pool-search { position: relative; flex: 1 1 440px; max-width: 640px; }
  .pool-search svg { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); width: 17px; height: 17px; fill: none; stroke: var(--dim); stroke-width: 2; stroke-linecap: round; pointer-events: none; }
  .searchbar .pool-search input[type="search"] { width: 100%; padding: 11px 14px 11px 42px; font-size: 15px; }
  .pool-search:focus-within svg { stroke: var(--green); }
  /* What the box answers as you type: a package a line, the full search last. */
  .suggest { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 30; background: var(--panel); border: 1px solid var(--line); box-shadow: 0 12px 32px rgba(0, 0, 0, .45); text-align: left; }
  .suggest a { display: grid; grid-template-columns: minmax(120px, auto) auto auto minmax(0, 1fr); gap: 12px; align-items: center; padding: 9px 14px; color: var(--text); text-decoration: none; border-bottom: 1px solid var(--line); font-size: 13px; }
  .suggest a:last-child { border-bottom: 0; } .suggest a:hover, .suggest a:focus { background: var(--panel-2); outline: none; }
  .suggest a b { font-weight: 600; color: var(--green); } .suggest a .d { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .suggest a.all { display: block; color: var(--green); font-size: 12.5px; padding: 10px 14px; }
  .suggest .none { padding: 10px 14px; color: var(--dim); font-size: 12.5px; }

  figure.diagram { margin: 0; border: 1px solid var(--line); background: var(--panel); padding: 14px 16px 10px; overflow-x: auto; }
  figure.diagram svg { display: block; width: 100%; height: auto; min-width: 760px; font-family: "JetBrains Mono", ui-monospace, monospace; }
  figure.diagram.live-diagram svg { min-width: 820px; }
  figure.diagram figcaption { font-size: 12.5px; color: var(--dim); margin-top: 8px; }
  .d-box { fill: var(--panel-2); stroke: var(--line); stroke-width: 1.2; } .d-box.hi { stroke: var(--green); }
  .d-box.edge { stroke: var(--edge); } .d-box.rc { stroke: var(--rc); } .d-box.stable { stroke: var(--stable); } .d-box.amber { stroke: var(--amber); } .d-box.dim { stroke: var(--dim); }
  .d-box.dimmed { opacity: .45; } .d-l.dimmed { opacity: .35; }
  /* No ligatures in a diagram: JetBrains Mono fuses "-<" into one glyph, and omarchy-<source>-<ring>.db loses a bracket. */
  .d-t, .d-s, .d-lab { font-variant-ligatures: none; }
  .d-t { fill: var(--text); font-size: 13px; font-weight: 600; font-family: Geist, "JetBrains Mono", sans-serif; } .d-t.small { font-size: 12.5px; }
  .d-t.edge { fill: var(--edge); } .d-t.rc { fill: var(--rc); } .d-t.stable { fill: var(--stable); } .d-t.amber { fill: var(--amber); }
  .d-s { fill: var(--dim); font-size: 11px; } .d-s.live { fill: var(--green); font-weight: 500; } .d-s.amber { fill: var(--amber); }
  .d-lab { fill: var(--muted); font-size: 11px; } .d-lab.hi { fill: var(--green); }
  .d-l { stroke: var(--dim); stroke-width: 1.2; fill: none; } .d-l.hi { stroke: var(--green); } .d-l.dash { stroke-dasharray: 4 4; } .d-l.warn { stroke: var(--amber); }
  .d-queue { fill: var(--bg-deep); stroke: var(--line); } .d-chip { fill: var(--panel-2); stroke: var(--line); }

  .rings .ring { border-top: 3px solid var(--line); gap: 10px; } .ring.stable { border-top-color: var(--stable); } .ring.rc { border-top-color: var(--rc); } .ring.edge { border-top-color: var(--edge); } .ring.lab { border-top-color: var(--lab); }
  .pill.lab { color: var(--amber); border-color: var(--amber); }
  /* The lab is the fourth ring, not a fourth choice: one slim row under the three, its parts side by side. */
  .rings .ring.lab { grid-column: 1 / -1; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 10px 22px; padding: 14px 20px; }
  .rings .ring.lab .head { flex: 0 0 auto; } .rings .ring.lab .desc { flex: 1 1 320px; } .rings .ring.lab .cta { margin-top: 0; flex: 0 0 auto; gap: 18px; }
  .ring .health { display: flex; gap: 8px; flex-wrap: wrap; } .ring .lag { font-size: 12px; color: var(--dim); } .ring .desc b { color: var(--text); } .ring .head .rel { white-space: nowrap; font-size: 12px; } .ring .cta a { white-space: nowrap; }
  .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 16px; }
  .feature { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; display: grid; gap: 8px; align-content: start; }
  .feature .ic { width: 28px; height: 28px; color: var(--green); } .feature .ic svg { width: 28px; height: 28px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .feature h3 { margin: 4px 0 0; } .feature p { margin: 0; font-size: 13.5px; color: var(--muted); }
  .feature a { color: var(--green); text-decoration: none; font-size: 13px; } .feature a:hover { text-decoration: underline; }
  .feature .proof { font-size: 12.5px; color: var(--dim); border-top: 1px solid var(--line); padding-top: 8px; margin-top: 4px; } .feature .proof b { color: var(--text); font-weight: 500; }
  .ways { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); gap: 16px; }
  .way { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; display: grid; gap: 8px; align-content: start; }
  .way .tag { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); display: flex; justify-content: space-between; } .way p { margin: 0; font-size: 13.5px; color: var(--muted); } .way .go { margin-top: 6px; }
  .start-grid { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 16px; align-items: stretch; }
  .start-cmd h3 { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .mini.five { grid-template-columns: repeat(5, 1fr); } .mini.four { grid-template-columns: repeat(4, 1fr); }
  .people-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); font-size: 12.5px; }
  .people-row .person { padding: 3px 8px 3px 3px; font-size: 12.5px; } .people-row .person .avatar { width: 22px; height: 22px; font-size: 10px; }
  .people-row a:not(.person) { margin-left: auto; }
  .cov { display: grid; gap: 7px; font-size: 12.5px; }
  .cov-row { display: grid; grid-template-columns: 96px minmax(0, 1fr) 156px minmax(0, 1fr) 156px; gap: 10px; align-items: center; }
  .cov-row.head { margin-bottom: 2px; } .cov-row .k { margin: 0; }
  .cov-row .l { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cov-row .bar { height: 8px; width: auto; background: var(--panel-2); border: 1px solid var(--line); position: relative; display: block; } .cov-row .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--green); } .cov-row .bar i.partial { background: var(--amber); }
  .cov-row .p { text-align: right; color: var(--muted); white-space: nowrap; }
  /* A phone: 96 + 156 + 156 px of columns do not fit in 340 — the source on a
     line of its own, then one line per architecture, named before its count
     (the head row would have nothing to head). The text leaked out of the box
     on a smartphone, 2026-09-17. */
  @media (max-width: 640px) {
    .cov { gap: 12px; }
    .cov-row { grid-template-columns: minmax(0, 1fr) auto; row-gap: 4px; }
    .cov-row.head { display: none; }
    .cov-row .l { grid-column: 1 / -1; }
    .cov-row .p.num::before { content: attr(data-arch) " · "; color: var(--muted); }
  }
  .open-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 16px; }
  .ring-heads { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); margin: 12px 0 10px; }
  .ring-head { background: var(--panel-2); padding: 8px 10px; display: grid; gap: 1px; text-decoration: none; color: inherit; min-width: 0; } .ring-head:hover { background: var(--panel); }
  .ring-head .k { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; } .ring-head b { font-family: Geist, sans-serif; font-size: 20px; font-weight: 600; line-height: 1.15; } .ring-head .s { font-size: 11.5px; color: var(--dim); line-height: 1.4; }
  .feed a.row { text-decoration: none; color: inherit; cursor: pointer; }
  tr.project-row td { background: var(--panel-2); } tr.project-row td:first-child { box-shadow: inset 3px 0 0 var(--green); } .feed a.row:hover .what { color: var(--text); }
  .charts.three { grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); }
  .charts.three .chart { display: flex; flex-direction: column; } .charts.three .chart > .mini { margin-top: auto; }
  .charts.three #c-sec { display: flex; flex-direction: column; flex: 1; } .charts.three #c-sec .hrows { flex: 1; align-content: space-evenly; } .charts.three #c-sec > p { margin-top: auto; }
  .coverage-box { border: 1px solid var(--line); background: var(--panel); padding: 14px 16px 10px; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr)); gap: 10px 28px; margin: 16px 0; }
  .coverage-box .k { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); margin-bottom: 6px; }
  .start-side { display: grid; gap: 16px; grid-template-rows: auto 1fr; }
  .cli-card, .community-card { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; display: grid; gap: 10px; align-content: start; }
  .community-card { border-color: var(--green); }
  .cli-card h3, .community-card h3 { display: flex; justify-content: space-between; align-items: baseline; } .cli-card p, .community-card p { margin: 0; font-size: 13px; color: var(--muted); }
  .cli-card pre, .share pre, .doc-sec pre { position: relative; white-space: pre-wrap; word-break: normal; overflow-wrap: anywhere; } .cli-card pre, .share pre { padding-right: 76px; }
  .community-card .big { font-family: Geist, sans-serif; font-size: 40px; font-weight: 600; line-height: 1.05; color: var(--green); }
  .community-card .people { margin-top: 4px; }
  .tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 12px; }
  .tabs button { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); padding: 5px 12px; font: inherit; font-size: 13px; cursor: pointer; } .tabs button.on { color: var(--green-ink); background: var(--green); border-color: var(--green); }
  .mini { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 12px; font-size: 11.5px; color: var(--dim); letter-spacing: .06em; text-transform: uppercase; }
  .mini b { display: block; font-family: Geist, sans-serif; font-size: 18px; font-weight: 600; color: var(--text); letter-spacing: 0; text-transform: none; line-height: 1.2; }
  .mini-list { margin-top: 12px; display: grid; gap: 5px; font-size: 12.5px; } .mini-list .k { font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); margin-bottom: 2px; }
  .hrows { display: grid; gap: 7px; font-size: 12.5px; }
  .hrow { display: grid; grid-template-columns: 150px 1fr 52px; gap: 10px; align-items: center; }
  .hrow .l { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .hrow .l small { color: var(--dim); }
  .hrow .bar { height: 10px; width: auto; background: var(--panel-2); border: 1px solid var(--line); position: relative; display: block; } .hrow .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--green); } .hrow .bar i.partial { background: var(--amber); }
  .hrow .p { text-align: right; color: var(--muted); }
  .tip { position: fixed; pointer-events: none; background: var(--bg-deep); border: 1px solid var(--line); color: var(--text); font-size: 12px; padding: 5px 9px; z-index: 30; white-space: nowrap; display: none; }
  .ax { fill: var(--dim); font-size: 10.5px; } .grid { stroke: var(--line); stroke-width: 1; } .mark { cursor: default; } .mark:hover { opacity: .8; }
  .heat { display: grid; gap: 3px; font-size: 11px; } .heat .r { display: grid; grid-template-columns: 110px repeat(14, 1fr); gap: 3px; align-items: center; }
  .heat .r .l { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .heat .c { aspect-ratio: 1; background: var(--line); min-width: 0; }
  .heat .c.ok { background: var(--green); opacity: .75; } .heat .c.warn { background: var(--amber); } .heat .c.error { background: var(--red); } .heat .c:hover { outline: 1px solid var(--text); }
  .heat .days { display: grid; grid-template-columns: 110px repeat(14, 1fr); gap: 3px; color: var(--dim); font-size: 10px; } .heat .days span { text-align: center; }

  .avatar { display: inline-grid; place-items: center; width: 28px; height: 28px; background: var(--panel-2); border: 1px solid var(--line); color: var(--text); font-size: 12px; font-weight: 600; font-family: Geist, sans-serif; flex: none; text-decoration: none; }
  .avatar.lg { width: 64px; height: 64px; font-size: 24px; border-color: var(--green); } .avatar.m { background: var(--green); color: var(--green-ink); border-color: var(--green); }
  .people { display: flex; flex-wrap: wrap; gap: 10px; }
  .person { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); background: var(--panel); padding: 5px 10px 5px 5px; text-decoration: none; color: var(--text); font-size: 13px; max-width: 100%; } .person:hover { border-color: var(--green); } .person > b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .person .r { color: var(--dim); font-size: 11.5px; }
  .landed { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 12px; }
  .land { border: 1px solid var(--line); background: var(--panel); padding: 12px 14px; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; align-items: center; }
  .land .avatar { grid-row: span 3; } .land .n { font-weight: 500; display: flex; justify-content: space-between; gap: 8px; align-items: baseline; } .land .n .v { color: var(--dim); font-size: 12px; } .land .n a { color: var(--text); text-decoration: none; } .land .n a:hover { color: var(--green); }
  .land .b { font-size: 12.5px; color: var(--dim); } .land .b a { color: var(--muted); text-decoration: none; }
  /* Where a landed package is today: the four rings, lit as it reaches them. */
  .land .rings { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .rb { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; border: 1px solid var(--line); padding: 2px 7px; color: var(--dim); opacity: .5; font-style: normal; }
  .rb svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .rb.on { opacity: 1; } .rb.lab.on { color: var(--lab); border-color: var(--lab); } .rb.edge.on { color: var(--edge); border-color: var(--edge); } .rb.rc.on { color: var(--rc); border-color: var(--rc); } .rb.stable.on { color: var(--stable); border-color: var(--stable); }
  .community { display: grid; grid-template-columns: 1.2fr 1fr; gap: 16px; align-items: start; }
  .community .box { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; display: grid; gap: 12px; align-content: start; } .community .box p { margin: 0; font-size: 13.5px; color: var(--muted); }
  .community .stats { display: flex; gap: 22px; flex-wrap: wrap; } .community .stats a { color: inherit; text-decoration: none; } .community .stats a:hover b { color: var(--green); } .community .stats > * b { display: block; font-family: Geist, sans-serif; font-size: 24px; font-weight: 600; line-height: 1.1; } .community .stats > * span { font-size: 12px; color: var(--dim); letter-spacing: .06em; text-transform: uppercase; }
  .sponsor { border: 1px solid var(--green); background: var(--panel); padding: 18px 20px; display: grid; grid-template-columns: 1fr auto; gap: 12px 24px; align-items: center; margin-top: 16px; }
  .sponsor p { margin: 0; font-size: 13.5px; color: var(--muted); max-width: 72ch; } .sponsor p b { color: var(--text); }
  .sponsor .needs { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .sponsor .mail { font-family: Geist, sans-serif; font-size: 18px; font-weight: 600; color: var(--green); text-decoration: none; white-space: nowrap; } .sponsor .mail:hover { text-decoration: underline; }
  .sponsor .side { display: grid; gap: 8px; justify-items: end; } .sponsor .promise { font-size: 12px; color: var(--dim); text-align: right; max-width: 30ch; }
  .sponsor.compact { padding: 14px 18px; }

  .gate { border: 1px dashed var(--line); background: var(--panel); padding: 24px; display: grid; grid-template-columns: 1fr auto; gap: 18px 28px; align-items: center; }
  .gate h3 { margin-bottom: 6px; } .gate p { margin: 0; color: var(--muted); font-size: 13.5px; max-width: 70ch; }
  .gate ul { margin: 8px 0 0; padding: 0; list-style: none; font-size: 13px; color: var(--muted); display: flex; gap: 6px 18px; flex-wrap: wrap; } .gate ul li::before { content: "▸ "; color: var(--green); }
  .gate .cta { display: grid; gap: 8px; justify-items: center; } .gate .cta .hint { text-align: center; max-width: 26ch; }
  .gate .lock, .private-head .lock { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  .private-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; border-top: 1px solid var(--line); padding-top: 28px; margin-bottom: 18px; }
  .private-head .lock { border: 1px solid var(--line); padding: 2px 8px; } .private-head h2 { margin: 0; } .private-head .right { margin-left: auto; display: flex; gap: 12px; align-items: center; }
  .two { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; }
  /* Review: yours first — two groups of one-line rows (waiting, decided) — then the one table everyone reads and maintainers act on. */
  .notice { border: 1px solid var(--line); background: var(--panel); padding: 12px 16px; font-size: 13.5px; color: var(--muted); margin: 0 0 16px; } .notice.warn { border-color: var(--amber); } .notice b { color: var(--text); }
  .rgroups { display: grid; gap: 22px; margin-bottom: 44px; }
  .rgroup h3 { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 8px; } .rgroup h3 .dim { font-size: 12px; font-weight: 400; font-family: "JetBrains Mono", monospace; }
  .rrows { display: grid; gap: 1px; background: var(--line); border: 1px solid var(--line); }
  .rrow { background: var(--panel); padding: 9px 14px; display: grid; grid-template-columns: minmax(160px, 1fr) auto minmax(0, 2.6fr) auto; gap: 6px 14px; align-items: center; font-size: 13px; box-shadow: inset 3px 0 0 var(--line); }
  .rrow.act { box-shadow: inset 3px 0 0 var(--amber); } .rrow.ok { box-shadow: inset 3px 0 0 var(--green); }
  .rrow .n { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .rrow .s { color: var(--muted); min-width: 0; } .rrow .s .pill { margin-right: 4px; }
  .rrow .go { font-size: 12.5px; color: var(--green); text-decoration: none; white-space: nowrap; justify-self: end; } .rrow .go:hover { text-decoration: underline; }
  .rrows > p { background: var(--panel); padding: 10px 14px; }
  tr.for-you td:first-child { box-shadow: inset 3px 0 0 var(--amber); } tr.mine-row td:first-child { box-shadow: inset 3px 0 0 var(--line); }
  details.tool { border: 1px solid var(--line); background: var(--panel); padding: 12px 16px; } details.tool summary { cursor: pointer; font-weight: 500; } details.tool summary .dim { font-weight: 400; font-size: 12.5px; margin-left: 8px; } details.tool[open] summary { margin-bottom: 12px; }
  #mine-queue { margin: 0 0 18px; } #mine-queue b { color: var(--text); } #mine-queue a { color: var(--green); text-decoration: none; }
  .panel { border: 1px solid var(--line); background: var(--panel); padding: 16px 18px; min-width: 0; }
  .panel h3 { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 10px; }
  .panel h3 a, .panel h3 button { font-family: "JetBrains Mono", monospace; font-size: 12.5px; font-weight: 400; color: var(--green); text-decoration: none; background: none; border: 0; cursor: pointer; padding: 0; } .panel h3 a:hover, .panel h3 button:hover { text-decoration: underline; }
  .panel table { font-size: 13px; } .panel th, .panel td { padding: 6px 8px; }
  .wcards { display: grid; gap: 10px; }
  .wcard { border: 1px solid var(--line); background: var(--panel-2); padding: 10px 12px; display: grid; grid-template-columns: auto 1fr auto; gap: 2px 12px; align-items: center; font-size: 13px; }
  .wcard .led { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); grid-row: span 2; } .wcard .led.on { background: var(--green); } .wcard .led.busy { background: var(--blue); }
  .wcard b { font-weight: 500; } .wcard .m { font-size: 12px; color: var(--dim); grid-column: 2; } .wcard .pill { grid-row: span 2; }
  .small-btn { background: var(--panel-2); border: 1px solid var(--line); color: var(--text); padding: 3px 9px; font: inherit; font-size: 12.5px; cursor: pointer; text-decoration: none; } .small-btn:hover { border-color: var(--green); }

  .state-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 0 0 24px; }
  .ticker { border: 1px solid var(--line); background: var(--panel); padding: 12px 16px; display: grid; gap: 6px; font-size: 13px; min-height: 230px; align-content: start; }
  .ticker .row { display: grid; grid-template-columns: 78px 92px 1fr auto; gap: 12px; align-items: baseline; animation: tick .5s ease-out; }
  .ticker .row .what { color: var(--blue); } .ticker .row .where { color: var(--dim); } .ticker .row .when { color: var(--dim); font-size: 12px; white-space: nowrap; }
  .ticker .head { display: flex; justify-content: space-between; font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); border-bottom: 1px solid var(--line); padding-bottom: 6px; margin-bottom: 4px; }
  .live { color: var(--green); display: inline-flex; align-items: center; gap: 6px; } .live i { width: 7px; height: 7px; border-radius: 50%; background: var(--green); animation: pulse 2.4s ease-out infinite; }
  @keyframes tick { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
  /* The Pool's feed: one line per event, the newest on top, cut at the box's edge (the full text on hover and on click). */
  .feed { display: grid; gap: 0; font-size: 12.5px; }
  .feed .row { display: grid; grid-template-columns: 44px 76px minmax(0, 1fr); gap: 10px; align-items: baseline; padding: 5px 0; border-bottom: 1px solid var(--line); cursor: default; }
  .feed .row:last-child { border-bottom: 0; } .feed .row.new { animation: tick .6s ease-out; }
  .feed .when { color: var(--dim); font-size: 11.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .feed .kind { min-width: 0; font-size: 12px; } .feed .kind .dot { margin-right: 6px; }
  .feed .what { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .feed .row.open .what { white-space: normal; overflow-wrap: anywhere; }
  .feed-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; } .feed-head b { color: var(--text); } .feed-head .live { font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; flex: none; }
  .live-grid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 16px; }
  .counters { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
  .counters div { background: var(--panel); padding: 12px 14px; } .counters b { display: block; font-family: Geist, sans-serif; font-size: 24px; font-weight: 600; line-height: 1.1; } .counters span { font-size: 11.5px; color: var(--dim); letter-spacing: .06em; text-transform: uppercase; } .counters b.ok { color: var(--green); }
  .flow { display: flex; align-items: stretch; gap: 0; overflow-x: auto; padding-bottom: 4px; }
  .flow .st { border: 1px solid var(--line); background: var(--panel); padding: 12px 16px; min-width: 150px; display: grid; gap: 2px; align-content: start; }
  .flow .st b { font-family: Geist, sans-serif; font-size: 26px; font-weight: 600; line-height: 1.1; } .flow .st .k { font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); } .flow .st .s { font-size: 12px; color: var(--muted); }
  .flow .st.hum { border-color: var(--amber); } .flow .st.hum .k { color: var(--amber); } .flow .st.you { border-color: var(--green); } .flow .ar { display: grid; place-items: center; color: var(--dim); padding: 0 8px; font-size: 18px; }
  .roles-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 16px; }
  .role { border: 1px solid var(--line); background: var(--panel); padding: 16px 18px; display: grid; gap: 8px; align-content: start; border-top: 3px solid var(--line); }
  .role.k-project { border-top-color: var(--green); } .role.k-review { border-top-color: var(--blue); } .role.k-contrib { border-top-color: var(--lilac); }
  .role .u { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; font-size: 12px; }
  .role h3 { display: flex; justify-content: space-between; align-items: baseline; } .role h3 span { font-family: "JetBrains Mono", monospace; font-size: 12px; font-weight: 400; color: var(--dim); } .role p { margin: 0; font-size: 12.5px; color: var(--muted); }
  .role .kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; font-size: 12.5px; } .role .kv dt { color: var(--dim); } .role .kv dd { margin: 0; text-align: right; }
  .role .kchart { margin-top: 4px; } .role .kchart svg { display: block; width: 100%; overflow: visible; } .role .mini { margin-top: 8px; gap: 6px; font-size: 10.5px; letter-spacing: .04em; white-space: nowrap; } .role .mini b { font-size: 16px; }
  /* The worker tables: the id whole and on one line, a state word in its own column, icons for what a word would only repeat, the machine's usage as three small meters. */
  .wtable { font-size: 12.5px; } .wtable .avatar { width: 24px; height: 24px; font-size: 10.5px; } .wtable td { white-space: nowrap; padding-left: 6px; padding-right: 6px; } .wtable th { padding-left: 6px; padding-right: 6px; white-space: normal; line-height: 1.25; vertical-align: bottom; } .wtable .wid { font-size: 11.5px; } .wtable .pill { vertical-align: middle; font-size: 10.5px; padding: 2px 7px; } .wtable a.pill { text-decoration: none; }
  .ic { display: inline-block; width: 14px; height: 14px; vertical-align: -3px; color: var(--muted); } .ic.emu { color: var(--amber); } .ic.shared { color: var(--lilac); } .ic + .ic { margin-left: 2px; }
  .agent { display: inline-flex; align-items: center; gap: 6px; } .agent .prov { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 3px; border: 1px solid var(--line); background: var(--panel-2); font-family: Geist, sans-serif; font-size: 9.5px; font-weight: 600; letter-spacing: .04em; } .agent .dot { margin-right: 0; }
  .usage { display: inline-grid; grid-template-columns: repeat(3, 28px); gap: 5px; } .usage .u1 { display: grid; gap: 3px; text-align: center; font-size: 12px; line-height: 1; } .usage .u1 i { display: block; height: 3px; background: var(--panel-2); position: relative; } .usage .u1 i::after { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: var(--v); background: var(--green); } .usage .u1.warn i::after { background: var(--amber); } .usage .u1.hot i::after { background: var(--red); }
  /* A build's page: the timeline, the evidence read in place. */
  .tl { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 0; } .tl li { display: grid; grid-template-columns: 16px 1fr auto; gap: 8px; align-items: start; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13px; } .tl li .dot { margin: 5px 0 0; } .tl li .d { color: var(--muted); } .tl li .when { font-size: 12px; }
  .tl li.skel { border: 0; } .acts { margin: -20px 0 28px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; }
  .ev { border: 1px solid var(--line); background: var(--panel); margin-top: 10px; } .ev summary { cursor: pointer; padding: 10px 14px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 13px; list-style: none; } .ev summary::-webkit-details-marker { display: none; } .ev summary::before { content: "▸"; color: var(--dim); } .ev[open] summary::before { content: "▾"; } .ev .body { padding: 0 14px 14px; }
  .ev-table { width: 100%; font-size: 12.5px; } .ev-table th, .ev-table td { padding: 5px 8px; vertical-align: top; } .ev pre.code { white-space: pre; line-height: 1.5; max-height: 640px; overflow: auto; } .ev pre .ln { display: inline-block; width: 3ch; margin-right: 12px; text-align: right; color: var(--dim); user-select: none; }
  /* Decisions ask in the dashboard: one dialog, and a toast that says what happened. */
  dialog.ask { border: 1px solid var(--line); background: var(--panel); color: var(--text); padding: 0; width: min(520px, calc(100vw - 32px)); box-shadow: 0 24px 60px rgba(0,0,0,.5); } dialog.ask::backdrop { background: rgba(10, 11, 16, .72); }
  dialog.ask form { padding: 20px 22px; display: grid; gap: 12px; } dialog.ask h3 { margin: 0; font-family: Geist, sans-serif; font-size: 17px; } dialog.ask .t { margin: 0; font-size: 13.5px; color: var(--muted); } dialog.ask textarea { width: 100%; box-sizing: border-box; background: var(--bg-deep); color: var(--text); border: 1px solid var(--line); padding: 8px 10px; font: 13px "JetBrains Mono", monospace; resize: vertical; }
  dialog.ask .val { display: flex; gap: 8px; align-items: stretch; } dialog.ask .val code { flex: 1; min-width: 0; overflow-wrap: anywhere; background: var(--bg-deep); border: 1px solid var(--line); padding: 8px 10px; font: 12.5px "JetBrains Mono", monospace; color: var(--text); } dialog.ask .row .grow { flex: 1; } dialog.ask .val .take { white-space: nowrap; } dialog.ask button.alt.danger { border-color: var(--red); color: var(--red); }
  dialog.ask .err { margin: 0; font-size: 12.5px; color: var(--red); } dialog.ask label.pick { display: grid; gap: 4px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; } dialog.ask label.pick select { width: 100%; box-sizing: border-box; background: var(--bg-deep); color: var(--text); border: 1px solid var(--line); padding: 7px 10px; font: 13px "JetBrains Mono", monospace; text-transform: none; letter-spacing: 0; } dialog.ask .row { display: flex; justify-content: flex-end; gap: 8px; } dialog.ask button.danger { border-color: var(--red); color: var(--red); } dialog.ask button.ghost { color: var(--muted); }
  #toasts { position: fixed; right: 16px; bottom: 16px; z-index: 90; display: grid; gap: 8px; max-width: min(460px, calc(100vw - 32px)); } .toast { border: 1px solid var(--line); background: var(--panel); padding: 10px 14px; font-size: 13px; border-left: 3px solid var(--green); cursor: pointer; transition: opacity .3s, transform .3s; } .toast.error { border-left-color: var(--red); } .toast.warn { border-left-color: var(--amber); } .toast.out { opacity: 0; transform: translateY(6px); }
  /* A person's page: the package rows open into the story and the next step. */
  table.pk td:first-child { width: 28px; padding-right: 0; } .expand { background: none; border: 0; color: var(--dim); font-size: 14px; cursor: pointer; padding: 2px 6px; } .expand:hover { color: var(--text); }
  tr.pkopen td { background: var(--bg-deep); padding: 12px 14px 14px; } .pkstory { display: grid; gap: 10px; } .pknext { display: flex; gap: 10px 16px; align-items: center; flex-wrap: wrap; font-size: 13px; } .pknext .acts-inline { margin-left: auto; display: inline-flex; gap: 8px; } .pknext button.ghost { color: var(--muted); }
  .arch-st { white-space: nowrap; margin-right: 8px; font-size: 12.5px; }
  .wt-legend { font-size: 12px; margin: 10px 0 0; display: flex; gap: 6px 18px; flex-wrap: wrap; align-items: center; }
  .cklist { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: 16px; } .ckcol { border: 1px solid var(--line); background: var(--panel); padding: 14px 16px; border-top: 3px solid var(--line); } .ckcol.contributor { border-top-color: var(--lilac); } .ckcol.maintainer { border-top-color: var(--green); }
  .ckcol h3 { display: flex; justify-content: space-between; align-items: baseline; margin: 0; } .ckcol h3 .num { font-family: Geist, sans-serif; font-size: 20px; font-weight: 600; } .ckcol p { margin: 4px 0 10px; font-size: 12.5px; } .ckcol ul { list-style: none; margin: 0; padding: 0; } .ckcol li { display: grid; grid-template-columns: 18px 1fr auto; gap: 8px; align-items: start; padding: 7px 0; border-top: 1px solid var(--line); font-size: 13px; } .ckcol li .pts { font-size: 12.5px; white-space: nowrap; }
  .ck { font-style: normal; font-weight: 700; } .ck.ok { color: var(--green); } .ck.part { color: var(--amber); } .ck.bad { color: var(--red); } .ck.pending { color: var(--dim); }
  .pkreq { border: 1px solid var(--line); background: var(--panel); padding: 12px 14px; margin: 0 0 12px; } .pkreq.incomplete { border-left: 3px solid var(--amber); } .pkreq-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; font-size: 13px; } .pkreq-head .btn.small { margin-left: auto; padding: 4px 10px; font-size: 12px; }
  .pkreq-list { list-style: none; margin: 8px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(400px, 100%), 1fr)); gap: 4px 24px; } .pkreq-list li { display: grid; grid-template-columns: 16px 1fr; gap: 6px; font-size: 12.5px; align-items: start; min-width: 0; } .pkreq-list li div { overflow-wrap: anywhere; }
  .pkarch { border: 1px solid var(--line); background: var(--bg-deep); padding: 12px 14px; margin: 0 0 12px; } .pkarch-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; font-size: 13px; } .pkarch-head .arch-name { font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 14px; } .pkarch-head .acts-inline { margin-left: auto; }
  .pkarch .pknext-line { margin: 8px 0 10px; font-size: 13px; color: var(--muted); } .howto { margin: 6px 0 0; padding-left: 22px; display: block; max-width: 72ch; color: var(--text); } .howto li { font-size: 12.5px; margin: 3px 0; } .howto li::marker { color: var(--green); font-weight: 700; } .pkarch .cklist { gap: 12px; } .pkarch .ckcol { padding: 10px 12px; } .pkarch .ckcol h3 { font-size: 14px; } .pkarch .ckcol h3 .num { font-size: 16px; } .pkarch .ckcol li { font-size: 12.5px; padding: 5px 0; }
  table.pk td.stands { max-width: 360px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } table.pk td.arches { white-space: nowrap; }
  .tile .v .dim { font-weight: 400; }
  .fchainrow { border: 1px solid var(--line); background: var(--panel); margin-top: 10px; } .fhead { display: flex; justify-content: space-between; gap: 10px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); font-size: 13px; }
  .fsteps { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); gap: 1px; background: var(--line); } .fstep { background: var(--panel); padding: 10px 12px; display: grid; grid-template-columns: 14px 1fr; gap: 6px; align-items: start; font-size: 12.5px; } .fstep .dot { margin: 4px 0 0; } .fstep b { display: block; font-size: 12.5px; } .fstep span { color: var(--muted); }
  .last .dot { margin-right: 6px; } .last a, .last .v { display: inline-block; max-width: 96px; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; } .last .v { color: var(--dim); font-size: 11.5px; max-width: 70px; }
  .agent .mono { font-size: 11.5px; max-width: 64px; overflow: hidden; text-overflow: ellipsis; }
  .maint-list { display: grid; gap: 8px; } .maint-list .m { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; font-size: 13px; }
  .maint-list .m .bar { height: 8px; width: auto; display: block; background: var(--panel-2); border: 1px solid var(--line); position: relative; } .maint-list .m .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--green); }
  .queue-pos { border: 1px solid var(--green); background: var(--panel-2); padding: 12px 14px; font-size: 13px; display: grid; gap: 4px; } .queue-pos b { font-family: Geist, sans-serif; font-size: 20px; }
  .budget { border: 1px solid var(--line); background: var(--panel); padding: 16px 18px; display: grid; grid-template-columns: 1fr auto; gap: 8px 24px; align-items: center; }
  .budget .bar { grid-column: 1 / -1; height: 12px; width: auto; display: block; background: var(--panel-2); border: 1px solid var(--line); position: relative; } .budget .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--green); }
  .budget .bar em { position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--amber); } .budget .bar em::after { content: "guard"; position: absolute; top: -16px; left: -14px; font-size: 10px; color: var(--amber); font-style: normal; }
  .budget b { font-family: Geist, sans-serif; font-size: 22px; font-weight: 600; } .budget .k { font-size: 12px; color: var(--dim); }
  .heads { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 12px; }
  .headc { border: 1px solid var(--line); background: var(--panel); padding: 12px 14px; display: grid; gap: 4px; font-size: 13px; border-left: 3px solid var(--line); }
  .headc.stable { border-left-color: var(--stable); } .headc.rc { border-left-color: var(--rc); } .headc.edge { border-left-color: var(--edge); }
  .headc .n { display: flex; justify-content: space-between; align-items: baseline; } .headc .n b { font-family: Geist, sans-serif; font-size: 17px; } .headc .m { color: var(--dim); font-size: 12px; } .headc .acts { display: flex; gap: 6px; margin-top: 4px; }
  .svc { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin: 0 0 36px; }
  .svc div { background: var(--panel); padding: 12px 14px; display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: center; font-size: 13px; }
  .svc .led { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); grid-row: span 2; } .svc .led.ok { background: var(--green); animation: pulse 2.4s ease-out infinite; } .svc .led.warn { background: var(--amber); } .svc .led.error { background: var(--red); }
  .svc span { grid-column: 2; color: var(--dim); font-size: 12px; }
  .feeds { display: grid; gap: 8px; margin-top: 8px; } .feed { display: grid; grid-template-columns: 1fr; gap: 1px; font-size: 12.5px; border-bottom: 1px solid var(--line); padding-bottom: 6px; } .feed span { color: var(--muted); } .feed:last-child { border-bottom: 0; }

  .profile-head { display: grid; grid-template-columns: auto 1fr auto; gap: 18px 22px; align-items: center; margin-bottom: 24px; }
  .profile-head h1 { font-size: 30px; max-width: none; } .profile-head .line { color: var(--muted); font-size: 13.5px; margin: 4px 0 0; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .share { border: 1px solid var(--green); background: var(--panel); padding: 18px 20px; display: grid; grid-template-columns: 1fr; gap: 12px; }
  .share p { margin: 0; font-size: 13.5px; color: var(--muted); } .share pre { position: relative; padding-right: 76px; white-space: pre-wrap; word-break: break-all; } .share .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .score { display: grid; grid-template-columns: auto 1fr; gap: 4px 18px; align-items: center; } .score b { font-family: Geist, sans-serif; font-size: 44px; font-weight: 600; color: var(--green); line-height: 1; } .score .f { font-size: 12.5px; color: var(--dim); } .score .f code { color: var(--muted); }
  .activity { display: flex; align-items: flex-end; gap: 3px; height: 54px; } .activity i { flex: 1; background: var(--green); opacity: .75; min-height: 2px; } .activity i:hover { opacity: 1; }
  .who { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 16px; }
  .whoc { border: 1px solid var(--line); background: var(--panel); padding: 16px 18px; display: grid; grid-template-columns: auto 1fr; gap: 14px; align-items: center; text-decoration: none; color: var(--text); }
  a.whoc:hover { border-color: var(--green); } .whoc .k { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); } .whoc b { display: block; font-family: Geist, sans-serif; font-size: 18px; font-weight: 600; } .whoc span { font-size: 12.5px; color: var(--muted); }
  .whoc.wait { border-color: var(--amber); border-style: dashed; }
  .whorow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; color: var(--muted); margin: -4px 0 12px; } .whorow .avatar { width: 24px; height: 24px; font-size: 10.5px; }
  .pkname { font-weight: 600; color: var(--text); text-decoration: none; border-bottom: 1px dotted var(--dim); } .pkname:hover { color: var(--green); border-bottom-color: var(--green); } .pkname .go { color: var(--green); font-weight: 400; }
  .by { display: inline-flex; gap: 4px; } .by .avatar { width: 24px; height: 24px; font-size: 10.5px; }
  .pk-grid { grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); align-items: start; margin-top: 4px; }
  /* The results: the page's search box is the search, so the table's own filter stays hidden; its size and count remain. A description is two lines at most; who made it stays on one. */
  .pk-results .pager { margin: 0 0 6px; } .pk-results .pager input { display: none; }
  .pk-results td:nth-child(4) { white-space: nowrap; } .pk-results .clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .pk-grid + .tiles { margin-top: 28px; }
  #results tr.sel td { background: var(--panel-2); }

  .docs { display: grid; grid-template-columns: 230px 1fr; gap: 24px; align-items: start; }
  .docs-side { position: sticky; top: 16px; display: grid; gap: 10px; }
  .docs-side input { background: var(--bg-deep); border: 1px solid var(--line); color: var(--text); padding: 8px 10px; font: inherit; font-size: 13.5px; width: 100%; } .docs-side input:focus { outline: none; border-color: var(--green); }
  .docs-home { display: block; font-family: Geist, sans-serif; font-weight: 600; font-size: 14px; color: var(--muted); text-decoration: none; padding: 2px 10px 6px; } .docs-home.on, .docs-home:hover { color: var(--text); }
  .docs-nav { display: grid; gap: 2px; } .docs-nav details { border-left: 2px solid transparent; } .docs-nav details[open] { border-left-color: var(--green); background: var(--panel); }
  .docs-nav summary { list-style: none; cursor: pointer; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 6px 10px; font-size: 13.5px; color: var(--muted); } .docs-nav summary::-webkit-details-marker { display: none; }
  .docs-nav summary::before { content: "›"; color: var(--dim); font-size: 13px; width: 8px; transition: transform .12s; } .docs-nav details[open] > summary::before { transform: rotate(90deg); }
  .docs-nav summary a { color: inherit; text-decoration: none; flex: 1; } .docs-nav summary:hover, .docs-nav summary a.on { color: var(--text); } .docs-nav summary small { color: var(--dim); font-size: 11px; }
  .docs-nav ul { list-style: none; margin: 0 0 6px; padding: 0 0 0 10px; display: grid; gap: 1px; } .docs-nav li a { display: block; padding: 3px 10px; font-size: 12.5px; color: var(--dim); text-decoration: none; border-left: 1px solid var(--line); } .docs-nav li a:hover { color: var(--text); border-left-color: var(--muted); }
  .docs-hits { display: grid; gap: 6px; } .docs-hits .hit { display: block; text-decoration: none; color: inherit; padding: 10px 12px; } .docs-hits .hit.none { color: var(--dim); font-size: 13px; cursor: default; }
  .docs-hits .hit b { font-size: 13.5px; } .docs-hits .hit span:last-child { display: block; font-size: 12px; color: var(--dim); margin-top: 2px; }
  .docs-group { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); padding: 12px 10px 4px; }
  .md h2 { margin: 30px 0 8px; } .md h3 { margin: 22px 0 6px; } .md h4 { margin: 16px 0 4px; font-size: 14px; } .md .anchor { color: inherit; text-decoration: none; } .md .anchor:hover::after { content: " #"; color: var(--dim); }
  .md p, .md li { color: var(--muted); font-size: 14px; line-height: 1.6; max-width: 82ch; } .md ul, .md ol { padding-left: 22px; margin: 0 0 12px; } .md li { margin: 3px 0; } .md li > ul, .md li > ol { margin: 4px 0 0; }
  .md pre { background: var(--bg-deep); border: 1px solid var(--line); padding: 12px 14px; overflow-x: auto; margin: 0 0 14px; font-size: 12.5px; line-height: 1.5; } .md code { color: var(--text); }
  .md blockquote { border-left: 2px solid var(--line); margin: 0 0 12px; padding: 2px 14px; color: var(--muted); } .md hr { border: 0; border-top: 1px solid var(--line); margin: 20px 0; }
  .md .table-wrap { margin: 0 0 14px; } .md table td, .md table th { vertical-align: top; } .md strong { color: var(--text); }
  .md figure.diagram { margin: 6px 0 16px; } .md figure.diagram figcaption { max-width: 82ch; line-height: 1.5; }
  .doc-figure { margin: 0 0 16px; background: var(--panel); border: 1px solid var(--line); padding: 10px; } .doc-figure img { display: block; width: 100%; max-width: 1100px; height: auto; margin: 0 auto; }
  .docs-hint { font-size: 12px; color: var(--dim); padding: 0 10px; } .docs-main { min-width: 0; }
  .docs-main > h1:first-child { margin-top: 2px; }
  .doc-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 14px; }
  .doc-card { border: 1px solid var(--line); background: var(--panel); padding: 16px 18px; display: grid; gap: 8px; align-content: start; } .doc-card h3 { margin: 0; } .doc-card h3 a { color: var(--text); text-decoration: none; } .doc-card h3 a:hover { color: var(--green); }
  .doc-card p { margin: 0; font-size: 13.5px; color: var(--muted); } .doc-secs { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-top: 4px; }
  .doc-secs a { font-size: 12px; color: var(--dim); text-decoration: none; border: 1px solid var(--line); padding: 2px 8px; } .doc-secs a:hover { color: var(--text); border-color: var(--muted); }
  .docs-main h2 { margin-bottom: 4px; } .docs-main h3 { margin: 22px 0 8px; } .docs-main p { color: var(--muted); font-size: 14px; max-width: 78ch; margin: 0 0 10px; } .docs-main p code, .docs-main li code { color: var(--text); }
  .docs-main ul { margin: 0 0 12px; padding-left: 18px; color: var(--muted); font-size: 13.5px; }
  .doc-sec { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; margin-bottom: 16px; } .doc-sec h3:first-child { margin-top: 0; }
  .hits { display: grid; gap: 8px; } .hit { border: 1px solid var(--line); background: var(--panel); padding: 12px 14px; cursor: pointer; } .hit:hover { border-color: var(--green); }
  .hit .ch { font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--green); } .hit b { display: block; margin: 2px 0; } .hit span { font-size: 13px; color: var(--muted); }
  mark { background: rgba(224,175,104,.35); color: var(--text); padding: 0 2px; }
  .stepper { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin: 0 0 12px; }
  .stepper button { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); padding: 8px 10px; font: inherit; font-size: 13px; cursor: pointer; text-align: left; display: grid; gap: 2px; } .stepper button small { color: var(--dim); font-size: 11px; }
  .stepper button.on { border-color: var(--green); color: var(--text); } .stepper button.on small { color: var(--green); }
  .quiz { display: grid; gap: 10px; } .quiz .q { display: flex; justify-content: space-between; gap: 12px; align-items: center; font-size: 13.5px; color: var(--muted); flex-wrap: wrap; }
  .quiz .q .yn { display: flex; gap: 4px; } .quiz .q .yn button { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); padding: 3px 10px; font: inherit; font-size: 12.5px; cursor: pointer; } .quiz .q .yn button.on { color: var(--green-ink); background: var(--green); border-color: var(--green); }
  .verdict { border: 1px solid var(--green); background: var(--panel-2); padding: 12px 14px; font-size: 13.5px; } .verdict b { font-family: Geist, sans-serif; font-size: 20px; }
  .cando { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; } .cando ul { list-style: none; padding: 0; margin: 0; font-size: 13.5px; } .cando li { padding: 4px 0; border-bottom: 1px solid var(--line); }
  .cando .yes li::before { content: "✓ "; color: var(--green); } .cando .no li::before { content: "✕ "; color: var(--red); } .cando h4 { margin: 0 0 6px; font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  .ep { border: 1px solid var(--line); background: var(--panel-2); margin-bottom: 6px; } .ep summary { list-style: none; cursor: pointer; padding: 8px 12px; display: grid; grid-template-columns: 62px 1fr auto; gap: 12px; align-items: center; font-size: 13px; } .ep summary::-webkit-details-marker { display: none; }
  .ep .m { font-size: 11.5px; font-weight: 600; letter-spacing: .04em; } .ep .m.get { color: var(--green); } .ep .m.post { color: var(--blue); } .ep .m.del, .ep .m.put { color: var(--amber); } .ep .who { font-size: 11px; color: var(--dim); letter-spacing: .06em; text-transform: uppercase; }
  .ep .body { padding: 0 12px 12px; display: grid; gap: 8px; } .ep .body p { margin: 0; font-size: 13px; } .ep[open] summary { border-bottom: 1px solid var(--line); }
  .gloss { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; } .gloss button { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); padding: 4px 10px; font: inherit; font-size: 12.5px; cursor: pointer; } .gloss button.on { border-color: var(--green); color: var(--text); }
  .srcs { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); gap: 8px; margin-bottom: 12px; } .srcs button { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); padding: 10px 12px; font: inherit; font-size: 13px; cursor: pointer; text-align: left; } .srcs button.on { border-color: var(--green); color: var(--text); }
  .timeline { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; } .timeline div { border: 1px solid var(--line); background: var(--panel-2); padding: 12px 14px; font-size: 13px; color: var(--muted); } .timeline b { display: block; color: var(--text); margin-bottom: 4px; }
  @media (max-width: 900px) {
    .community, .two, .profile-head, .live-grid, .docs, .cando, .start-grid, .pk-grid, .open-grid { grid-template-columns: 1fr; }
    .docs-side { position: static; } .stepper { grid-template-columns: repeat(2, 1fr); } .timeline { grid-template-columns: 1fr; } .gloss-list { grid-template-columns: 1fr; }
    .gate, .sponsor { grid-template-columns: 1fr; } .rrow { grid-template-columns: 1fr auto; } .rrow .s, .rrow .go { grid-column: 1 / -1; } .rrow .go { justify-self: start; } .sponsor .side { justify-items: start; } .sponsor .promise { text-align: left; }
    .heat .r, .heat .days { grid-template-columns: 80px repeat(14, 1fr); }
  }
  .live-grid > * { min-width: 0; } .ticker .row > span { min-width: 0; overflow-wrap: anywhere; }
  #seal .mono, .meta .mono, .kv dd .mono, .whorow, .whoc span { overflow-wrap: anywhere; }
  /* A control gated by the shell's gate(): everyone sees it, the person who may not use it sees it grey, and the reason is its title — so the pointer stays on it (no pointer-events: none) and the hover stays quiet. A link gated the same way is stopped by the shell's click handler. A control disabled by state (a build in flight, a button pressed) is the same grey: one look for "not now", whatever the reason. */
  button[disabled], select[disabled], input[disabled], textarea[disabled], a.disabled { opacity: .45; cursor: not-allowed; }
  button[disabled]:hover, a.disabled:hover { border-color: var(--line); text-decoration: none; }
  .decide { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  @media (max-width: 720px) {
    .hero h1 { font-size: 24px; } .hrow { grid-template-columns: 110px 1fr 46px; }
    .ticker .row { grid-template-columns: 1fr; gap: 1px; padding-bottom: 6px; border-bottom: 1px solid var(--line); } .ticker .row .when { font-size: 11px; }
    .flow .st { min-width: 130px; } .roles-grid { grid-template-columns: 1fr; }
  }
`;

/** The icons the worker tables use instead of a word: a chip for the architecture (dashed when emulated), arrows for a shared worker, one person for an owner's own. */
export const WORKER_ICONS = {
  native: '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-label="native"><rect x="4" y="4" width="8" height="8"/><path d="M6 1v3M10 1v3M6 12v3M10 12v3M1 6h3M1 10h3M12 6h3M12 10h3"/></svg>',
  emu: '<svg class="ic emu" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-label="emulated"><rect x="4" y="4" width="8" height="8" stroke-dasharray="2 1.5"/><path d="M6 1v3M10 1v3M6 12v3M10 12v3M1 6h3M1 10h3M12 6h3M12 10h3"/></svg>',
  shared: '<svg class="ic shared" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-label="shared"><path d="M2 5h10M9 2l3 3-3 3M14 11H4M7 8l-3 3 3 3"/></svg>',
  own: '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-label="own"><circle cx="8" cy="5" r="3"/><path d="M2 15c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>',
  log: '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-label="log"><path d="M3 2h7l3 3v9H3z"/><path d="M5 7h6M5 9.5h6M5 12h4"/></svg>',
};

/**
 * What the shell's gate(html, false, why) writes, for a page that serves a
 * control grey before its script runs: every button, select, input and
 * textarea in it disabled with the reason in its title, every link
 * class="disabled" with its href set aside — the same attributes, so the
 * served control and the one the script draws again are one
 * (decision-cell.test.ts holds the two to each other).
 */
export function servedGrey(html: string, why: string): string {
  const tip = ` aria-disabled="true" title="${escapeHtml(why)}"`;
  return html.replace(/<(button|select|input|textarea|a)\b([^>]*)>/g, (_m, tag: string, attrs: string) => {
    attrs = attrs.replace(/\s*\/$/, "").replace(/\s+(title|aria-disabled|tabindex)="[^"]*"/g, "").replace(/\s+disabled(="[^"]*")?(?=[\s>]|$)/g, "");
    if (tag !== "a") return `<${tag}${attrs} disabled${tip}>`;
    attrs = attrs.replace(/\shref="/, ' data-href="');
    return `<a${/\sclass="/.test(attrs) ? attrs.replace(/\sclass="/, ' class="disabled ') : attrs + ' class="disabled"'} tabindex="-1"${tip}>`;
  });
}

/**
 * The shell: the helpers every page script runs after, spliced by page()
 * before the page's own script. A helper two pages need lives here (a chart
 * primitive in charts.ts CHARTS); a page declares only what it alone draws
 * — test/pages.test.ts fails a page that declares a name the shell has.
 */
export const HELPERS = String.raw`
  var POOL = "__POOL_URL__";
  var RINGS_TEXT = __RINGS_TEXT__;
  var WICON = __WICON__;
  var $ = function (s) { return document.querySelector(s); };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function bytes(n) { n = Number(n || 0); var u = ["B", "KB", "MB", "GB", "TB"], i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + " " + u[i]; }
  function num(n) { return Number(n || 0).toLocaleString("en-US"); }
  function ago(iso) { if (!iso) return "—"; var s = (Date.now() - Date.parse(iso)) / 1000; if (s < 60) return Math.floor(s) + "s ago"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago"; return Math.floor(s / 86400) + "d ago"; }
  function dur(ms) { if (ms == null) return ""; if (ms < 1000) return ms + " ms"; if (ms < 60000) return (ms / 1000).toFixed(1) + " s"; return Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s"; }
  function latest(list, kind, ring, source) {
    for (var i = 0; i < list.length; i++) { var e = list[i]; if (e.kind === kind && (ring == null || e.ring === ring) && (source == null || e.source === source)) return e; }
    if (source === "x86_64") for (var j = 0; j < list.length; j++) { var f = list[j]; if (f.kind === kind && (ring == null || f.ring === ring) && !f.source) return f; }
    return null;
  }
  // Header pill = the service: online when the API answers and it can reach
  // the index and the pool right now (/api/v1/status measures both), degraded
  // when one of them fails, offline when the API itself does not answer.
  // Whether the pipeline is keeping up is a different question (problemsOf).
  function setStatus(state, title) { var el = $("#status"); if (!el) return; el.className = "status " + state; el.querySelector("span").textContent = state; el.title = title || ""; }
  function serviceStatus() {
    if (!$("#status")) return; // no indicator on this page (the header lost its pill; the Status page measures on its own)
    fetch("/api/v1/status", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {
      var why = [];
      if (!s.index.ok) why.push("index: " + (s.index.error || "failed"));
      if (!s.pool.ok) why.push("pool: " + (s.pool.error || "failed"));
      setStatus(s.ok ? "online" : "degraded", s.ok ? "API, index (" + s.index.ms + " ms) and pool (" + s.pool.ms + " ms) answering" : why.join(" · "));
    }).catch(function (e) { setStatus("offline", "API not answering: " + e); });
  }
  // What is wrong, if anything: no sync for four hours (they run every three), a source not synced
  // for six (a long import holds the pipeline's queue, so small sources wait),
  // or a ring whose latest health check failed. The header pill and the
  // status page use the same list.
  // The newest event of a kind across d.latest (one per kind, source and
  // ring) — the 40-event window of d.events fills with job lines and can
  // miss a sync that happened an hour ago.
  function newest(list, kind) {
    var best = null;
    (list || []).forEach(function (e) { if (e.kind === kind && (!best || e.created_at > best.created_at)) best = e; });
    return best;
  }
  function problemsOf(d) {
    var sync = newest(d.latest, "sync"), why = [];
    if (!sync || Date.now() - Date.parse(sync.created_at) > 4 * 3600e3) why.push("no sync for " + (sync ? ago(sync.created_at).replace(" ago", "") : "ever"));
    var late = (d.coverage || []).filter(function (c) { return c.last_sync && Date.now() - Date.parse(c.last_sync) > 9 * 3600e3; });
    if (late.length) why.push(late.length + " source(s) not synced for 9 h");
    (d.latest || []).forEach(function (e) { if (e.kind === "health" && e.status === "error") why.push(e.ring + " " + (e.source || "x86_64") + " failed its health check"); });
    return why;
  }
  // Pipeline pill (where a page has one): keeping up, or what is behind.
  function pipelineFrom(d) {
    var el = $("#pipeline-state"); if (!el) return;
    var why = problemsOf(d);
    el.className = "pill " + (why.length ? "warn" : "ok");
    el.textContent = why.length ? "pipeline behind: " + why.join(" · ") : "pipeline keeping up";
  }
  // Every table: the first 10 rows, a page size (10/25/50/100) and a filter,
  // so a page never renders hundreds of rows at once. State survives the
  // periodic refreshes. text(row) is what the filter matches; empty is the
  // message for no rows.
  function pager(sel, rows, render, opts) {
    opts = opts || {}; var table = document.querySelector(sel); if (!table) return;
    pager.state = pager.state || {}; var st = pager.state[sel] = pager.state[sel] || { n: opts.n || 10, q: "" };
    var wrap = table.parentElement, bar = wrap.previousElementSibling;
    if (!bar || !bar.classList.contains("pager")) {
      bar = document.createElement("div"); bar.className = "pager";
      bar.innerHTML = '<input type="search" placeholder="filter this table…" aria-label="filter"> <select aria-label="rows per page"><option>10</option><option>25</option><option>50</option><option>100</option></select> <span class="count"></span>';
      wrap.parentElement.insertBefore(bar, wrap);
      bar.querySelector("select").value = String(st.n);
    }
    // Bound again on every call: a page that refreshes its rows (every 15 s, after a Build) filters the rows it has now, not the first load's.
    bar.querySelector("input").oninput = function () { st.q = this.value.toLowerCase(); draw(); };
    bar.querySelector("select").onchange = function () { st.n = Number(this.value); draw(); };
    function text(r) { return (opts.text ? opts.text(r) : JSON.stringify(r)).toLowerCase(); }
    function draw() {
      var f = st.q ? rows.filter(function (r) { return text(r).indexOf(st.q) >= 0; }) : rows;
      table.tBodies[0].innerHTML = f.slice(0, st.n).map(render).join("") || '<tr><td colspan="99" class="muted">' + (opts.empty || "nothing here") + '</td></tr>';
      bar.querySelector(".count").textContent = f.length > st.n ? "showing " + st.n + " of " + f.length : f.length + (f.length === 1 ? " row" : " rows");
      if (opts.after) opts.after();
    }
    draw();
  }
  // Who is signed in (the omc cookie), as the page's controls ask it: me is /auth/me's answer as it came (null for nobody), login and role its two words. The anonymous identity until the answer, and for nobody.
  function identity(me) { return { me: me || null, login: me ? me.login : "", role: me ? me.role : "" }; }
  var WHO = identity(null);
  function isMaintainer() { return WHO.role === "maintainer"; }
  function isOwner(login) { return !!login && WHO.login === login; }
  // The sign-in that comes back to this address, query included: a renewal's name, a search, a ring rides in the query, and the page() served only the path. Encoded once as a query value, the slashes kept so it reads as the page.
  function signInHref() { return "/auth/github?next=" + encodeURIComponent(location.pathname + location.search).replace(/%2F/g, "/"); }
  // Every sign-in the page served for its own path — the header's, a gate's — is rewritten to the whole address once the query is known; a sign-in to another page (the Factory gate's /me) is left as served.
  if (location.search) document.querySelectorAll('a[href^="/auth/github?next="]').forEach(function (a) { if (a.getAttribute("href") === "/auth/github?next=" + encodeURIComponent(location.pathname).replace(/%2F/g, "/")) a.href = signInHref(); });
  // The header shows the login and the role; sign out is on every page: /auth/logout clears the cookie.
  function accountChip(me) {
    var a = $("#account"); if (!a) return;
    a.innerHTML = '<span class="avatar' + (me.role === "maintainer" ? " m" : "") + '">' + esc(String(me.login).slice(0, 2)) + '</span><b>' + esc(me.login) + '</b>'; a.href = "/user/" + encodeURIComponent(me.login); a.title = esc(me.login) + " · " + esc(me.role) + " — signed in with GitHub as " + me.login + (me.areas && me.areas.length ? " (" + me.areas.join(", ") + ")" : "");
    var out = $("#signout"); if (out) { out.hidden = false; }
  }
  // One fetch of /auth/me per page: the shell asks first, and every whoami(cb) a page makes gets the same answer — from the fetch in flight, or from what it said. A fetch that fails, or a header that throws, still answers every page: nobody.
  var whoAnswer = null;
  function whoami(cb) {
    whoAnswer = whoAnswer || fetch("/auth/me", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (me) { WHO = identity(me); if (me) accountChip(me); }).catch(function () {});
    if (cb) whoAnswer.then(function () { cb(WHO.me); });
  }
  whoami();
  // SMIL animations (the diagrams) stop when the viewer asked for less motion.
  if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) document.querySelectorAll("svg").forEach(function (s) { if (s.pauseAnimations) s.pauseAnimations(); });
  // Charts and bars carry their value in data-tip; one fixed box follows the pointer.
  (function () {
    var tip = document.createElement("div"); tip.className = "tip"; document.body.appendChild(tip);
    document.addEventListener("mousemove", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-tip]") : null;
      if (!t) { tip.style.display = "none"; return; }
      tip.textContent = t.getAttribute("data-tip"); tip.style.display = "block";
      var x = e.clientX + 14, y = e.clientY + 14; if (x + tip.offsetWidth > innerWidth - 8) x = e.clientX - tip.offsetWidth - 10;
      tip.style.left = x + "px"; tip.style.top = y + "px";
    });
  })();
  // A person, as an icon: two letters, green for a maintainer. No photos anywhere on the dashboard.
  function avatar(login, role, cls) { return '<a class="avatar ' + (cls || "") + (role === "maintainer" ? " m" : "") + '" href="/user/' + encodeURIComponent(login) + '" title="' + esc(login) + (role ? " · " + esc(role) : "") + '">' + esc(String(login).slice(0, 2)) + '</a>'; }
  // The same icon with no link of its own — for inside a link (a chip), where a nested anchor would split.
  function avatarIcon(login, role) { return '<span class="avatar' + (role === "maintainer" ? " m" : "") + '">' + esc(String(login).slice(0, 2)) + '</span>'; }
  // A person as a chip: the icon carries the role (green = maintainer), the whole chip is the link to the profile.
  // A worker's id is "<owner>-<name>-<arch>-<4 random>" (POST /factory/workers): the tables
  // show the name — the owner and the architecture have columns of their own — and keep the id on hover.
  function workerName(w) {
    var id = String(w.id || ""), s = id;
    if (w.owner && s.indexOf(w.owner + "-") === 0) s = s.slice(w.owner.length + 1);
    s = s.replace(/-[a-z0-9]{4}$/, "");
    if (w.arch && s.endsWith("-" + w.arch)) s = s.slice(0, -(w.arch.length + 1));
    return '<span class="mono" title="' + esc(id) + '">' + esc(s || id) + '</span>';
  }
  // ---- decisions ask in the dashboard, never in the browser's own box: one dialog, a note when the action wants one, a promise of the note (null = cancelled).
  //   ask({ title, text, input: "required" | "optional" | false, placeholder, confirm: "Approve", danger: true })
  // The dashboard's question: a title, a line, a note when the action wants one (input: "required" | "optional"), a choice when there is one (select: { label, options: [{ value, text, disabled, selected }] }), the button. Resolves the note as a string — or, with a select, { note, pick } — and null when cancelled.
  function ask(o) {
    return new Promise(function (resolve) {
      var d = document.createElement("dialog"); d.className = "ask";
      var sel = o.select && o.select.options && o.select.options.length ? '<label class="pick"><span>' + esc(o.select.label || "Where") + '</span><select>' + o.select.options.map(function (x) { return '<option value="' + esc(x.value) + '"' + (x.disabled ? ' disabled' : '') + (x.selected ? ' selected' : '') + '>' + esc(x.text) + '</option>'; }).join("") + '</select></label>' : '';
      // A value to take away (a link, a token): shown once, copied with one press.
      var val = o.value !== undefined ? '<div class="val"><code></code><button type="button" class="take">' + esc(o.copy || "Copy") + '</button></div>' : '';
      // A block of text to read, as it is (a log): monospace, scrolling, never marked up.
      var pre = o.pre !== undefined ? '<pre class="block"></pre>' : '';
      // A second way out (alt): the other thing this dialog can do — take a build out of the queue while the main button puts it back.
      var alt = o.alt ? '<button type="button" class="alt ' + (o.alt.danger ? "danger" : "ghost") + '">' + esc(o.alt.text) + '</button>' : '';
      d.innerHTML = '<form method="dialog"><h3></h3><p class="t"></p>' + val + pre + sel + (o.input ? '<textarea rows="3" placeholder="' + esc(o.placeholder || (o.input === "required" ? "why — it goes on the record" : "a note for the record (optional)")) + '"></textarea><p class="err" hidden></p>' : '') + '<div class="row">' + alt + '<span class="grow"></span><button type="button" class="ghost cancel">' + esc(o.cancel || "Cancel") + '</button>' + (o.confirm === null ? '' : '<button type="submit" class="' + (o.danger ? "danger" : "") + '">' + esc(o.confirm || "OK") + '</button>') + '</div></form>';
      d.querySelector("h3").textContent = o.title || ""; d.querySelector(".t").innerHTML = o.text || "";
      if (o.value !== undefined) d.querySelector(".val code").textContent = o.value;
      if (o.pre !== undefined) { var pr = d.querySelector("pre.block"); pr.textContent = o.pre; d.classList.add("wide"); setTimeout(function () { pr.scrollTop = pr.scrollHeight; }, 0); }
      document.body.appendChild(d);
      var ta = d.querySelector("textarea"), se = d.querySelector("select"), form = d.querySelector("form"), done = function (v) { d.close(); d.remove(); resolve(v); };
      var answer = function (extra) { var v = ta ? ta.value.trim() : ""; var out = se || o.alt || extra ? { note: v, pick: se ? se.value : "" } : v; if (extra && typeof out === "object") out.alt = true; return out; };
      d.querySelector(".cancel").onclick = function () { done(null); };
      // A sticky dialog (a token shown once) closes by its buttons only — not by a tap beside it, not by Escape.
      d.addEventListener("cancel", function (ev) { ev.preventDefault(); if (!o.sticky) done(null); });
      d.addEventListener("click", function (ev) { if (ev.target === d && !o.sticky) done(null); });
      var cp = d.querySelector(".take"); if (cp) cp.onclick = function () { navigator.clipboard.writeText(o.value).then(function () { cp.textContent = "Copied"; setTimeout(function () { cp.textContent = o.copy || "Copy"; }, 1500); }); };
      var al = d.querySelector(".alt"); if (al) al.onclick = function () { done(answer(true)); };
      form.onsubmit = function (ev) {
        ev.preventDefault();
        var v = ta ? ta.value.trim() : "";
        if (o.input === "required" && v.length < 4) { d.querySelector(".err").hidden = false; d.querySelector(".err").textContent = "Say why, in a few words — the record keeps it."; ta.focus(); return; }
        done(answer(false));
      };
      d.showModal(); if (ta) ta.focus();
    });
  }
  // The workers a build may go to, as the choice in the Build dialog, from the factory listing (/api/v1/factory): for a contributor's build, theirs and the ones the project shares; for the project's build, the project's own that build. The first option leaves it to the rule.
  // The choice of worker in the Build dialog, from the factory listing (/api/v1/factory): for a contributor's build, the shared queue (any shared worker, the best idle one first, the asker's own at once) or one of the asker's own workers; for the project's build, one of the project's; queue is where the build already stands, when it does.
  function whereOptions(workers, arch, login, forProject, needsAgent, queue, pinnedTo) {
    if (needsAgent === undefined) needsAgent = true;
    var can = (workers || []).filter(function (w) { return w.arch === arch && !w.revoked_at && (forProject ? (w.side === "omarchy" && (!w.kinds || w.kinds.indexOf("build") >= 0)) : (w.side !== "omarchy" && (w.owner === login || w.mode === "shared"))); });
    // A drafted build (the project's always) goes only to a worker whose agent answered: pinned to another it would wait forever.
    // An outdated worker (behind the latest image past the grace) is handed nothing: pinned to it a build would wait until it updates.
    var stale = function (w) { return !!(w.update && w.update.required); };
    var fit = function (w) { return w.alive && !stale(w) && (!needsAgent || w.agent_status === "ok"); };
    var word = function (w) { return (w.owner && w.owner !== login ? w.owner + "'s " : forProject ? "" : "your ") + wtShort(w.id) + " · " + (w.alive ? (stale(w) ? "outdated — update it" : w.current_task ? "building" : "idle") : "offline") + " · " + (w.labels && w.labels.emulated ? "emulated" : "native") + (w.agent ? " · " + w.agent + (w.agent_status !== "ok" ? " (not answering)" : "") : " · no agent"); };
    var mine = can.filter(function (w) { return w.owner === login && !forProject; }), shared = can.filter(function (w) { return w.mode === "shared" && !forProject; }), project = forProject ? can : [];
    var online = shared.filter(fit), idle = online.filter(function (w) { return !w.current_task; }), native = idle.filter(function (w) { return !(w.labels && w.labels.emulated); });
    var state = idle.length ? idle.length + " idle now, " + native.length + " native" : online.length ? "all " + online.length + " online busy" : shared.length ? "none of " + shared.length + " online" : "no shared worker for " + arch;
    var opts = [];
    if (forProject) opts.push({ value: "", text: "Any of the project's workers for " + arch + (project.length ? "" : " (none is registered)"), selected: !pinnedTo });
    else opts.push({ value: "", text: "The queue — the best idle shared worker takes it" + (queue ? " (yours is " + queue.position + " of " + queue.total + ")" : "") + " · " + state, selected: !pinnedTo });
    // A build already asked for one worker keeps that choice unless changed.
    mine.concat(project).forEach(function (w) { opts.push({ value: w.id, text: word(w), disabled: !fit(w) && w.id !== pinnedTo, selected: w.id === pinnedTo }); });
    if (pinnedTo && !opts.some(function (o) { return o.value === pinnedTo; })) opts.push({ value: pinnedTo, text: wtShort(pinnedTo) + " · as asked", selected: true });
    return { label: "Worker", options: opts, count: can.length, native: native.length, idle: idle.length, online: online.length, shared: shared.length, mine: mine.length, state: state };
  }
  function wtShort(id) { var parts = String(id).split("-"); return parts.length > 3 ? parts.slice(-3).join("-") : id; }

  // A line that says what happened, where the eye is: bottom right, gone in a few seconds (an error stays until clicked).
  function toast(text, cls) {
    var box = $("#toasts"); if (!box) { box = document.createElement("div"); box.id = "toasts"; document.body.appendChild(box); }
    var t = document.createElement("div"); t.className = "toast " + (cls || "ok"); t.innerHTML = text; box.appendChild(t);
    var go = function () { t.classList.add("out"); setTimeout(function () { t.remove(); }, 300); };
    t.onclick = go; if (cls !== "error") setTimeout(go, 6000);
  }
  // ---- the worker tables (the Workers page, a person's page): the same row for the same kind of worker everywhere.
  // The kind: project (pool jobs) and review are the project's, told apart by the role the worker reported; everything else is a contributor's.
  function wtKind(w) { if (w.side !== "omarchy") return "community"; var r = w.labels && w.labels.role; return r === "review" ? "review" : "project"; }
  function wtPerson(l) { return l ? avatar(l) : '<span class="muted" title="a registration from before owners: the project\'s">—</span>'; }
  // The id without the owner's prefix (the owner has a column), never past 32 characters: whole segments go from after the first, the tail — role, arch, the random suffix — stays; the whole id on hover.
  function wtId(w) {
    var names = (w.trusted_by || "").split(",").map(function (n) { return n.trim(); }).filter(Boolean);
    var tip = [w.labels && w.labels.where ? "on " + w.labels.where : "", w.hostname && w.hostname !== "?" ? "host " + w.hostname : "", w.kinds && w.kinds.length ? "takes: " + w.kinds.join(", ") : "", names.length ? "trusted by " + names.join(", ") : w.trust_proposed_by ? "proposed for project trust by " + w.trust_proposed_by + ", awaiting a second maintainer's word" : ""].filter(Boolean).join(" · ");
    var id = String(w.id || ""), shown = w.owner && id.indexOf(w.owner + "-") === 0 ? id.slice(w.owner.length + 1) : id, parts = shown.split("-");
    while (shown.length > 32 && parts.length > 3) { parts.splice(1, 1); shown = parts[0] + "-…-" + parts.slice(1).join("-"); }
    if (shown.length > 32) shown = shown.slice(0, 18) + "…" + shown.slice(-13);
    return '<span class="mono wid" title="' + esc([id, tip].filter(Boolean).join(" · ")) + '">' + esc(shown) + '</span>';
  }
  // The state, one word: building (a task in hand), failed (alive but not ready — its agent did not answer), idle, offline (with how long). Seen-when on hover.
  function wtStatus(w) {
    var seen = "seen " + ago(w.last_seen);
    if (w.revoked_at) return '<span class="pill none" title="revoked ' + esc(ago(w.revoked_at)) + '">revoked</span>';
    if (!w.alive) return '<span class="pill none" title="not seen in the last ten minutes">offline · ' + esc(ago(w.last_seen).replace(" ago", "")) + '</span>';
    if (w.current_task) return '<a class="pill blue" href="/build/' + w.current_task + '" title="task #' + w.current_task + ' · ' + esc(seen) + '">building</a>';
    if (w.update && w.update.required) return '<a class="pill warn" href="/docs/workers#update" title="' + esc("its image is " + w.update.yours + ", the pool is at " + w.update.latest + ": every worker follows the latest image — it is handed nothing until it updates · " + seen) + '">outdated</a>';
    if (!w.ready) return '<span class="pill error" title="' + esc((w.agent_error ? "its agent did not answer: " + w.agent_error : !w.agent ? "no agent: a contributor's builds and the audits need one that answers" : "not ready for the work it declares") + " · " + seen) + '">failed</span>';
    return '<span class="pill ok" title="' + esc("alive, nothing in hand · " + seen) + '">idle</span>';
  }
  function wtVersion(w) {
    if (!w.version || w.version === "container") return '<span class="muted" title="an image from before the version was reported">—</span>';
    var u = w.update;
    if (u && u.outdated) return '<span class="mono ' + (u.required ? 'warn' : 'muted') + '" title="' + esc("the pool is at " + u.latest + (u.required ? ": handed nothing until it updates" : ": the rollout's grace, updating")) + '">' + esc(w.version) + (u.behind ? ' · ' + u.behind + ' behind' : ' · behind') + '</span>';
    return '<span class="mono" title="the release this worker\'s image was built from">' + esc(w.version) + '</span>';
  }
  function wtArch(w, icon) { return esc(w.arch) + (icon ? ' ' + (w.labels && w.labels.emulated ? WICON.emu.replace('aria-label', 'title="emulated: the other architecture, under qemu on this host" aria-label') : WICON.native.replace('aria-label', 'title="native" aria-label')) : ''); }
  // The worker's own log, an icon on every row that opens the tail: live for its owner and the maintainers, grey with the pool's own refusal (403 to anyone else, in these words) for everyone else — the dashboard's rule, never an icon dropped by role.
  function wtLog(w) { return ' ' + gate('<button type="button" class="iconbtn" data-wlog="' + esc(w.id) + '" title="its own log — the lines between tasks, as it sent them">' + WICON.log + '</button>', isMaintainer() || isOwner(w.owner), orSignIn("the worker\'s log is its owner\'s and the maintainers\' to read")); }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-wlog]") : null; if (!b) return;
    var id = b.getAttribute("data-wlog");
    fetch("/api/v1/factory/workers/" + encodeURIComponent(id) + "/log", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { toast(esc(d.error), "error"); return; }
      ask({ title: id, text: d.at ? "its own log, last line " + esc(ago(d.at)) + " — a build's output is on the build's page" : "nothing sent yet — the log arrives with each claim, within the minute", pre: d.log || "", confirm: null, cancel: "Close" });
    }).catch(function () { toast("could not load the log", "error"); });
  });
  function wtMode(w) { return w.mode === "shared" ? WICON.shared.replace('aria-label', 'title="shared: builds whatever is queued, anyone\'s" aria-label') : WICON.own.replace('aria-label', 'title="' + esc(w.packages && w.packages.length ? "own packages: " + w.packages.join(", ") : "the owner\'s packages only") + '" aria-label'); }
  var WT_PROV = { anthropic: "A", "claude-code": "CC", openai: "OA", gemini: "G", xai: "X" };
  // The agent, and whether it answers: the dot is the last probe (green answered, red did not, grey never asked), the chip the provider, then the model.
  function wtAgent(w) {
    if (!w.agent) return '<span class="muted">—</span>';
    var i = w.agent.indexOf("/"), prov = i > 0 ? w.agent.slice(0, i) : "", model = i > 0 ? w.agent.slice(i + 1) : w.agent;
    var st = w.agent_status === "ok" ? "ok" : w.agent_status === "error" ? "error" : "";
    var tip = w.agent + (st === "ok" ? " · answered " + ago(w.agent_checked_at) : st === "error" ? " · no answer " + ago(w.agent_checked_at) + (w.agent_error ? ": " + w.agent_error : "") : " · not probed yet");
    return '<span class="agent" title="' + esc(tip) + '"><i class="dot ' + st + '"></i><span class="prov">' + esc(WT_PROV[prov] || prov.slice(0, 2).toUpperCase() || "?") + '</span><span class="mono">' + esc(model.replace(/^claude-/, "")) + '</span></span>';
  }
  // What the machine uses: three meters, the worker's own average (with the claim), amber past 70, red past 90.
  function wtUsage(w) {
    var u = w.usage; if (!u) return '<span class="muted" title="not reported yet: an image from before usage was reported, or its first minute">—</span>';
    var tip = "average of the last " + (u.minutes || "?") + " min, reported " + ago(w.usage_at) + " · cpu " + u.cpu + "%" + (u.cores ? " of " + u.cores + " cores" : "") + " · ram " + u.ram + "%" + (u.ram_gb ? " of " + u.ram_gb + " GB" : "") + " · disk " + u.disk + "%" + (u.disk_gb ? " of " + u.disk_gb + " GB" : "");
    return '<span class="usage" title="' + esc(tip) + '">' + [u.cpu, u.ram, u.disk].map(function (v) { v = Math.round(Number(v) || 0); return '<span class="u1' + (v >= 90 ? " hot" : v >= 70 ? " warn" : "") + '" style="--v:' + v + '%"><b class="num">' + v + '</b><i></i></span>'; }).join("") + '</span>';
  }
  // The last task the worker finished — a package (linked, with its version) or a pool job by name — and how it ended.
  function wtLast(w) {
    var l = w.last_task; if (!l) return '<span class="muted" title="nothing finished since the pool started keeping this">—</span>';
    var tip = "task #" + l.id + " · " + l.kind + " " + (l.status === "failed" ? "failed" : l.status) + " " + ago(l.at);
    var pkg = l.kind === "build" || l.kind === "audit" || l.kind === "publish" || l.kind === "trial";
    return '<span class="last" title="' + esc(tip) + '"><i class="dot ' + (l.status === "failed" ? "error" : "ok") + '"></i>' + (pkg ? '<a href="/build/' + l.id + '">' + esc(l.name) + '</a>' + (l.version ? ' <span class="v mono">' + esc(l.version) + '</span>' : '') : '<a class="mono" href="/build/' + l.id + '">' + esc(l.name) + '</a> <span class="v">' + ago(l.at) + '</span>') + '</span>';
  }
  function wtCounts(w) { return num(w.builds_done) + ' / ' + num(w.builds_failed); }
  // The header and the row of each kind of table; "extra" is one more cell (a person's own page puts its buttons there).
  var WT_HEAD = {
    project: '<th>Worker</th><th>Status</th><th>Arch</th><th>Version</th><th>Maintainer</th><th title="what the machine uses: an average the worker keeps and reports with its claims">CPU · RAM · Disk</th><th>Done / failed</th><th>Last job</th>',
    review: '<th>Worker</th><th>Status</th><th>Arch</th><th>Version</th><th>Maintainer</th><th>Agent</th><th title="what the machine uses: an average the worker keeps and reports with its claims">CPU · RAM · Disk</th><th>Done / failed</th><th>Last reviewed</th>',
    community: '<th>Worker</th><th>Status</th><th>Owner</th><th>Arch</th><th>Version</th><th title="shared: builds whatever is queued · own: the owner\'s packages only">Mode</th><th>Agent</th><th title="what the machine uses: an average the worker keeps and reports with its claims">CPU · RAM · Disk</th><th>Done / failed</th><th>Last build</th>'
  };
  function workerRow(w, kind, extra) {
    var cells = kind === "project" ? [wtId(w) + wtLog(w), wtStatus(w), wtArch(w, false), wtVersion(w), wtPerson(w.owner), wtUsage(w), wtCounts(w), wtLast(w)]
      : kind === "review" ? [wtId(w) + wtLog(w), wtStatus(w), wtArch(w, true), wtVersion(w), wtPerson(w.owner), wtAgent(w), wtUsage(w), wtCounts(w), wtLast(w)]
      : [wtId(w) + wtLog(w), wtStatus(w), wtPerson(w.owner), wtArch(w, true), wtVersion(w), wtMode(w), wtAgent(w), wtUsage(w), wtCounts(w), wtLast(w)];
    return '<tr><td>' + cells.join('</td><td>') + '</td>' + (extra ? '<td>' + extra + '</td>' : '') + '</tr>';
  }
  // The three tables a page serves through workerPanels(): the head per kind (one more cell when the page adds one, a person's page its buttons), the skeleton until the rows come, the legend. The page then draws each kind through pager() with workerRow().
  function wtTables(extra) {
    ["project", "review", "community"].forEach(function (k) {
      var t = document.querySelector("#w-" + k); if (!t) return;
      t.querySelector("thead tr").innerHTML = WT_HEAD[k] + (extra ? "<th></th>" : "");
      skeletonRows("#w-" + k, (WT_HEAD[k].match(/<th/g) || []).length + (extra ? 1 : 0), 2);
    });
    var l = document.querySelector("#wt-legend"); if (l) l.innerHTML = WT_LEGEND;
  }
  // What the pager's filter searches on a worker's row: its id, owner, arch, version, mode, agent, who trusted it, its last task, its labels.
  function wtText(w) { return [w.id, w.owner, w.arch, w.version, w.mode, w.agent, w.trusted_by, w.last_task && w.last_task.name, JSON.stringify(w.labels || {})].join(" "); }
  var WT_LEGEND = '<p class="dim wt-legend">' + '<span>' + WICON.native + ' native</span><span>' + WICON.emu + ' emulated</span><span>' + WICON.shared + ' shared</span><span>' + WICON.own + ' own packages</span><span><span class="pill ok">idle</span> waiting</span><span><span class="pill blue">building</span> a task in hand</span><span><span class="pill error">failed</span> its agent does not answer</span><span><span class="pill warn">outdated</span> behind the latest image, handed nothing</span><span><span class="pill none">offline</span> not seen in ten minutes</span><span>' + WICON.log + ' its own log (its owner, the maintainers)</span></p>';
  // A person's login as a link to their page; a pill with a title. Shared by the pages that tell a package's story.
  function personLink(l) { return l ? '<a href="/user/' + encodeURIComponent(l) + '">' + esc(l) + '</a>' : '<span class="muted">—</span>'; }
  function pillHtml(cls, text, title) { return '<span class="pill ' + cls + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>'; }
  // One build status, one colour, on every page: queued grey, building blue, staged and done green, failed and rejected red, cancelled and withdrawn grey. A package's own words (registered, waiting, approved, unmaintained) wear the same pills.
  var TASK_PILL = { queued: "none", leased: "blue", building: "blue", staged: "ok", done: "ok", failed: "error", rejected: "error", cancelled: "none", withdrawn: "none", registered: "none", requested: "none", waiting: "warn", drafting: "blue", validating: "blue", review: "warn", approved: "ok", unmaintained: "warn" };
  function taskPill(status, title) { return pillHtml(TASK_PILL[status] || "none", status === "leased" ? "building" : status, title); }
  // An advisory's severity: critical and high red, medium amber, low blue, unknown grey.
  function sevPill(s) { return pillHtml({ critical: "error", high: "error", medium: "warn", low: "blue", unknown: "none" }[s] || "none", s); }
  // A build's class (score.ts): A and B green, C amber, D red — the pill says the class and the points, the hover what the maintainer's half would make of it; text and title replace those where a row has room for the letter only.
  var CLASS_CLS = { A: "ok", B: "ok", C: "warn", D: "error" };
  function classPill(sc, text, title) { return pillHtml(CLASS_CLS[sc.class] || "none", text || "class " + sc.class + " · " + sc.points + "/100", title || "today; with the maintainer's half green: " + sc.projected); }
  // A row of choices, one lit (the rings, the architectures, a journal's kinds): values are the words, current the one on, on(value) what a press does. opts.url names the query parameter the choice is written to, so the address carries it; opts.label(value) is a button's own markup where the word is not what it shows (a stage's name over its rhythm).
  function pick(sel, values, current, on, opts) {
    opts = opts || {}; var el = $(sel); if (!el) return;
    var label = opts.label || esc;
    el.innerHTML = values.map(function (v) { return '<button type="button" class="' + (v === current ? "on" : "") + '" data-v="' + esc(v) + '">' + label(v) + '</button>'; }).join("");
    el.querySelectorAll("button").forEach(function (b) { b.onclick = function () { var v = b.getAttribute("data-v"); if (opts.url) { var q = new URLSearchParams(location.search); q.set(opts.url, v); history.replaceState(null, "", "?" + q); } on(v); }; });
  }
  // The copy chips beside a command (.copy with data-copy="key"): map is { key: "#selector" }, the text of that element goes to the clipboard, the chip says so for a moment — and says when the browser refused (no permission, plain http).
  function copyChips(map) {
    document.querySelectorAll(".copy[data-copy]").forEach(function (b) {
      // The chip's own word is what comes back — read once here, not at the click: a second press within the moment would bring "copied" back for good.
      var was = b.textContent, sel = map[b.getAttribute("data-copy")];
      b.onclick = function () {
        var el = sel ? $(sel) : null; if (!el) return;
        navigator.clipboard.writeText(el.textContent).then(function () { b.textContent = "copied"; }, function () { b.textContent = "could not copy"; }).then(function () { setTimeout(function () { b.textContent = was; }, 1500); });
      };
    });
  }
  // One call to the API, JSON in and JSON out: the answer's body whatever the status — an error's message is in it — with the status on it as __status, so a page tells refused from done; the progress bar runs while it is in flight.
  function api(method, path, body) {
    return busy(fetch(path, { method: method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).then(function (r) { return r.json().catch(function () { return { error: "HTTP " + r.status }; }).then(function (d) { d.__status = r.status; return d; }); });
  }
  // A figure in the prose (a diagram's label, a sentence's number): every element with data-live="key" says text.
  function live(key, text) { document.querySelectorAll('[data-live="' + key + '"]').forEach(function (el) { el.textContent = text; }); }
  // One line of the journal (/api/v1/events), the same on the Journal and the Pipeline: the status, the kind, the ring and the source, the summary linked to the run that produced it and to the diff of the release it made, how long it took, when.
  function eventRow(e) {
    var run = e.payload && e.payload.ci && e.payload.ci.run_url, rid = e.payload && e.payload.release_id, diff = "";
    if (rid && e.ring && (e.kind === "promote" || e.kind === "rollback" || e.kind === "sync" || e.kind === "fast-track")) diff = ' <a class="run" href="/diff?ring=' + esc(e.ring) + '&to=' + rid + '" title="what release ' + rid + ' changed">diff</a>';
    return '<tr><td><span class="dot ' + esc(e.status) + '"></span>' + esc(e.status) + '</td><td><span class="kind">' + esc(e.kind) + '</span></td><td>' + esc(e.ring || "") + '</td><td>' + esc(e.source || "") + '</td><td>' + (run ? '<a class="run" href="' + esc(run) + '" title="open the run">' + esc(e.summary) + '</a>' : esc(e.summary)) + diff + '</td><td class="num">' + dur(e.duration_ms) + '</td><td class="when" title="' + esc(e.created_at) + '">' + ago(e.created_at) + '</td></tr>';
  }
  // Roll a ring back to a release: asked in the dashboard's dialog, posted once as a pool job, the answer written to #rb-state where the page has one. Resolves with the job's answer, null when cancelled.
  function askRollback(ring, to) {
    return ask({ title: "Roll " + ring + " back to release " + to + "?", text: "The ring serves that release again at once; the journal keeps why.", input: "required", confirm: "Roll back", danger: true }).then(function (note) {
      if (note === null) return null;
      return api("POST", "/api/v1/factory/jobs", { kind: "rollback", params: { ring: ring, to: to, note: note } }).then(function (j) {
        var el = $("#rb-state"); if (el) { el.hidden = false; el.innerHTML = j.error ? pillHtml("error", "refused") + ' ' + esc(j.error) : pillHtml("ok", "queued") + ' rollback of <b>' + esc(ring) + '</b> to release ' + esc(to) + ' is task #' + esc(j.task || "?") + ' — a project worker runs it, the journal records it'; }
        return j;
      });
    });
  }
  // The rollback button (data-rollback="<release id>" data-ring="<ring>") is the shell's: the click stops here, so a page binding the same button asks nobody twice — and a button whose job was queued stays disabled: enabled again it queued the job twice (the Journal and the Pipeline both did).
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-rollback]") : null; if (!b) return;
    ev.stopImmediatePropagation(); b.disabled = true;
    askRollback(b.getAttribute("data-ring"), b.getAttribute("data-rollback")).then(function (j) { if (j === null || j.error) b.disabled = false; }, function (e) { b.disabled = false; toast("failed: " + esc(String(e)), "error"); });
  });
  // ---- a control gated by role. The dashboard's rule: every role sees every control, the same for all; what a role cannot do is the same control disabled, grey, with the reason in its title — never hidden, never absent, never a sentence in its place. ok true returns the control as given; false marks every button, select, input and textarea in it disabled (aria-disabled, title = why, an existing title replaced) and every link class="disabled" with tabindex -1 and its href moved to data-href — a link without an href is followed by nothing, not a middle click, not "open in a new tab", not a drag — and the click handler below stops the rest. The reason is the server's where it has one (can.why on a review row, on GET /factory/tasks/:id/can), so a grey button is one the POST would refuse in the same words.
  function gate(html, ok, why) {
    if (ok) return html;
    return html.replace(/<(button|select|input|textarea|a)\b([^>]*)>/g, function (m, tag, attrs) {
      attrs = attrs.replace(/\s*\/$/, "").replace(/\s+(title|aria-disabled|tabindex)="[^"]*"/g, "").replace(/\s+disabled(="[^"]*")?(?=[\s>]|$)/g, "");
      var tip = ' aria-disabled="true" title="' + esc(why) + '"';
      if (tag !== "a") return "<" + tag + attrs + " disabled" + tip + ">";
      attrs = attrs.replace(/\shref="/, ' data-href="');
      return "<a" + (/\sclass="/.test(attrs) ? attrs.replace(/\sclass="/, ' class="disabled ') : attrs + ' class="disabled"') + ' tabindex="-1"' + tip + ">";
    });
  }
  // A gated link goes nowhere: caught first (capture), before any page's handler on the same click.
  document.addEventListener("click", function (ev) { var a = ev.target.closest ? ev.target.closest("a.disabled") : null; if (a) { ev.preventDefault(); ev.stopImmediatePropagation(); } }, true);
  // The reason a page gives its own gate, for whoever is looking: nobody signed in reads the sign-in first, as the server's own first refusal is the 401 — the same word on every grey control of a page, the Decision cell's included.
  function orSignIn(why) { return WHO.me ? why : "sign in with GitHub"; }

  // ---- the three verdicts on a staged build, as Review's table reads them: the gate (the worker's own checks on the build), the audit (the project's second agent), the trial (a real pacman installing the project's build in the lab). The pill, then the evidence as a link when the row has one (href: t.evidence.tests / .audit / .trial) — what warned or failed, the findings, the transcript — and as a word when it has none.
  function gatePill(v, href) {
    if (!v) return '<span class="dim" title="built before the gate existed">—</span>';
    var more = function (text, title) { return href ? ' <a class="run" href="' + esc(href) + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + text + '</a>' : ' <span class="muted"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + text + '</span>'; };
    if (v.verdict === "pass") return pillHtml("ok", "pass") + more(v.warnings ? v.warnings + " warning" + (v.warnings === 1 ? "" : "s") : "clean", (v.warned || []).join(", "));
    return pillHtml("error", v.verdict) + more(esc((v.failed || []).join(", ")));
  }
  function auditPill(a, href) {
    a = a || { status: "none" };
    if (a.status === "done" && a.verdict) {
      var text = a.findings ? a.findings + " finding" + (a.findings === 1 ? "" : "s") + (a.high ? ", " + a.high + " high" : "") : "report";
      return pillHtml(a.verdict === "ok" ? "ok" : a.verdict === "warn" ? "warn" : "error", a.verdict) + (href ? ' <a class="run" href="' + esc(href) + '" title="' + esc(a.summary || "") + '">' + text + '</a>' : ' <span class="muted" title="' + esc(a.summary || "") + '">' + text + '</span>');
    }
    if (a.status === "queued") return '<span class="muted">waiting</span>';
    if (a.status === "leased") return '<span class="muted">running</span>';
    if (a.status === "failed") return pillHtml("none", "failed", a.error || "");
    if (a.status === "done") return pillHtml("none", "unreadable");
    return '<span class="muted">—</span>';
  }
  function trialPill(t, href) {
    t = t || { status: "none" };
    if (t.status === "done" && t.verdict) {
      var ok = t.verdict === "ok";
      return pillHtml(ok ? "ok" : "error", ok ? "installs" : t.verdict) + (href ? ' <a class="run" href="' + esc(href) + '" title="the lab above edge: pacman -S, hooks, files">transcript</a>' : '');
    }
    if (t.status === "queued") return '<span class="muted">waiting</span>';
    if (t.status === "leased") return '<span class="muted">installing</span>';
    if (t.status === "failed") return pillHtml("none", "did not run", t.error || "");
    if (t.status === "done") return pillHtml("none", "unreadable");
    return '<span class="muted" title="only the project\'s build is tried">—</span>';
  }

  // ---- the Decision cell of a build, the same for every viewer: Approve, Reject (Drop, its note preset, on a build of a version already approved — t.already), Build by the project, and Withdraw the approval when one stands on the row (t.standing, as the review list says it; t.approval, as a build's page reads it) — each enabled where t.can says so and grey with t.can.why in its title otherwise. t is a row of GET /factory/review, or { id, name, version, arch, can, already, approval } put together from a task and GET /factory/tasks/:id/can. A row nobody can act on shows the same buttons, all grey. The buttons carry the task id (data-approve="12" …) and the click is the shell's (below): the page registers onDecided(fn) to draw again.
  function decisionCell(t) {
    var c = t.can || { why: {} }, why = c.why || {}, id = t.id;
    var btn = function (what, text, extra) { return gate('<button type="button" data-' + what + '="' + id + '"' + (extra || "") + '>' + text + '</button>', !!c[what], why[what] || "not now"); };
    var standing = t.standing === true || !!(t.approval && t.approval.decision === "approved" && !t.approval.withdrawn_at);
    var label = t.name ? t.name + (t.version ? " " + t.version : "") + " (build #" + id + ")" : "build #" + id;
    return '<span class="decide" data-task="' + id + '" data-label="' + esc(label) + '" data-arch="' + esc(t.arch || "") + '">'
      + btn("approve", "Approve")
      + (t.already ? btn("reject", "Drop", ' data-note="a build of a version already approved (#' + t.already.task + ')" title="the same name, version and architecture were approved as build #' + t.already.task + ' — nothing to decide; drop it"') : btn("reject", "Reject"))
      + btn("build", "Build by the project")
      + (standing ? btn("withdraw", "Withdraw the approval", ' title="take the approval back: the package leaves every ring, another maintainer decides — the reason goes on the record"') : "")
      + '</span>';
  }
  // The four decisions' dialogs, one place for Review, the Pipeline and a build's page: what the decision does, the note it wants (a rejection's is required — the contributor reads it), and for the project's build the choice of worker, the project's own for the architecture, read when the dialog opens. label names the build ("build #12", "mine 1.0-2 (build #12)"); opts.arch picks the workers; opts.note, given (Drop), answers at once, no dialog. Resolves as ask() does: the note, { note, pick } with a worker chosen, null when cancelled.
  function decideDialog(what, label, opts) {
    opts = opts || {};
    if (opts.note) return Promise.resolve(opts.note);
    if (what === "build") return fetch("/api/v1/factory?limit=10").then(function (r) { return r.json(); }).then(function (d) { return d.workers || []; }).catch(function () { return []; }).then(function (ws) {
      return ask({ title: "Have the project build " + label + " again", text: "A trusted review worker builds the recipe again with the project's agent — the contributor's bytes are never used. The result shows in review when it is staged.", select: whereOptions(ws, opts.arch || "x86_64", WHO.login, true), input: "optional", placeholder: "a hint for the project's agent (optional)", confirm: "Build by the project" });
    });
    if (what === "reject") return ask({ title: "Reject " + label, text: "The contributor reads the note and builds again. The rejection is on the record.", input: "required", placeholder: "what is wrong, in a line or two", confirm: "Reject", danger: true });
    if (what === "withdraw") return ask({ title: "Withdraw the approval of " + label, text: "The approval stays on the record and is void from now on; the package leaves every ring it reached; another maintainer decides.", input: "required", placeholder: "why take it back", confirm: "Withdraw", danger: true });
    return ask({ title: "Approve " + label, text: "The project's build goes into edge, signed by the pool; the approval is on the record with your name.", input: "optional", confirm: "Approve" });
  }
  // What the toast says once the server said yes: where the build went, the task the project builds it as and on what, what the withdrawal emptied.
  function decidedText(what, d, dropped) {
    if (what === "approve") return "Approved — the project's build goes into edge (publish job <a href=\"/build/" + d.publish + "\">#" + d.publish + "</a>).";
    if (what === "build") return "The project is building it: task <a href=\"/build/" + d.task + "\">#" + d.task + "</a>, on " + (d.pinned_to ? esc(wtShort(d.pinned_to)) : "a review worker") + " with the project's agent.";
    if (what === "withdraw") return "Withdrawn — the approval is void; the package leaves " + esc((d.rings || []).map(function (r) { return r.ring; }).join(", ") || "no ring") + "; another maintainer decides.";
    return dropped ? "Dropped." : "Rejected — the contributor sees the note.";
  }
  // The decision buttons are the shell's (data-approve / data-reject / data-build / data-withdraw = the task id, inside decisionCell's .decide): the click stops here, asks through decideDialog, posts once through api() and tells every fn a page gave onDecided — fn(what, id, answer) — to draw again. The button is disabled from the click and enabled again on cancel or refusal only, so a decision is never posted twice (a rejected row draws again without the button). A page's own Build buttons (a person's page names a package in data-build) are outside .decide and untouched.
  var DECIDED = [];
  function onDecided(fn) { DECIDED.push(fn); }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest(".decide button[data-approve], .decide button[data-reject], .decide button[data-build], .decide button[data-withdraw]") : null; if (!b) return;
    ev.stopImmediatePropagation(); if (b.disabled) return;
    var what = ["approve", "reject", "build", "withdraw"].filter(function (w) { return b.hasAttribute("data-" + w); })[0], id = b.getAttribute("data-" + what), cell = b.closest(".decide");
    b.disabled = true;
    decideDialog(what, cell.getAttribute("data-label") || "build #" + id, { arch: cell.getAttribute("data-arch"), note: b.getAttribute("data-note") }).then(function (got) {
      if (got === null) { b.disabled = false; return; }
      var body = { note: got && typeof got === "object" ? got.note : got };
      if (got && typeof got === "object" && got.pick) body.worker = got.pick;
      return api("POST", "/api/v1/factory/tasks/" + id + "/" + what, body).then(function (d) {
        if (d.error) { b.disabled = false; toast(esc(d.error), "error"); return; }
        toast(decidedText(what, d, b.hasAttribute("data-note")), what === "withdraw" ? "warn" : "ok");
        DECIDED.forEach(function (fn) { fn(what, Number(id), d); });
      });
    }).catch(function (e) { b.disabled = false; toast("failed: " + esc(String(e)), "error"); });
  });
  // One chain of the factory's story (routes/story.ts) as a row of steps: built by the contributor → the gate → the audit → built again by the project → tried in the lab → decided. The package page and a person's page draw the same row.
  function chainRow(c) {

    var sc = c.score, cc = c.contributor, pb = c.project, a = c.approval;
      var step = function (state, title, detail) { return '<div class="fstep ' + state + '"><i class="dot ' + (state === "ok" ? "ok" : state === "bad" ? "error" : state === "warn" ? "warn" : "") + '"></i><div><b>' + title + '</b><span>' + detail + '</span></div></div>'; };
      var vet = cc && cc.result && cc.result.vet, audit = c.audit, pvet = pb && pb.result && pb.result.vet, trial = c.trial;
      return '<div class="fchainrow"><div class="fhead"><span>' + (cc ? personLink(cc.owner) + '\'s build <a href="/build/' + cc.id + '">#' + cc.id + '</a> · ' + esc(cc.version || '') + ' · ' + esc(cc.arch) : 'the project\'s build <a href="/build/' + pb.id + '">#' + pb.id + '</a> · ' + esc(pb.version || '') + ' · ' + esc(pb.arch)) + '</span>' + classPill(sc) + '</div><div class="fsteps">'
        + (cc ? step(cc.status === "staged" || cc.status === "done" ? "ok" : cc.status === "failed" ? "bad" : "", "Built by the contributor", (cc.status === "staged" || cc.status === "done" ? "succeeded" : cc.status) + (cc.finished_at ? ' · ' + ago(cc.finished_at) : '') + (cc.attempts > 1 ? ' · ' + cc.attempts + ' attempts' : '')) : '')
        + (cc ? step(vet ? (vet.verdict === "pass" ? (vet.warnings ? "warn" : "ok") : "bad") : "", "The gate", vet ? (vet.verdict === "pass" ? (vet.warnings ? vet.warnings + " warning(s)" : "clean") : vet.fails + " failed") : "not run") : '')
        + (cc ? step(audit && audit.status === "done" ? ({ ok: "ok", warn: "warn", block: "bad" }[audit.result && audit.result.verdict] || "ok") : "", "The audit", audit ? (audit.status === "done" ? (audit.result && audit.result.verdict || "done") + (audit.result && audit.result.model ? ' · ' + esc(audit.result.model) : '') : audit.status) : "not yet") : '')
        + step(pb ? (pb.status === "staged" || pb.status === "done" ? "ok" : pb.status === "failed" ? "bad" : "") : "", "Built again by the project", pb ? '<a href="/build/' + pb.id + '">#' + pb.id + '</a> · ' + (pb.status === "staged" || pb.status === "done" ? "succeeded" : pb.status) + (pvet ? ' · gate ' + (pvet.verdict === "pass" ? (pvet.warnings ? pvet.warnings + " warning(s)" : "clean") : "failed") : '') : (sc.ready ? "ready: a maintainer asks for it" : "after the contributor's half"))
        + step(trial && trial.status === "done" ? (trial.result && trial.result.verdict === "ok" ? "ok" : "bad") : "", "Tried in the lab", trial ? (trial.status === "done" ? (trial.result && trial.result.verdict === "ok" ? "a real pacman installed it" : "could not: " + esc(trial.result && trial.result.verdict || "")) : trial.status) : "not yet")
        + step(a ? (a.decision === "approved" ? "ok" : "bad") : c.withdrawn ? "warn" : "", "Decided", a ? esc(a.decision) + ' by ' + personLink(a.by) + ' ' + ago(a.created_at) + (a.note ? ' — ' + esc(a.note) : '') : c.withdrawn ? 'the approval by ' + personLink(c.withdrawn.by) + ' was withdrawn ' + ago(c.withdrawn.withdrawn_at) + ' by ' + personLink(c.withdrawn.withdrawn_by) + ': ' + esc(c.withdrawn.withdrawn_reason || '') + ' — another maintainer decides' : (pb && pb.status === "staged" ? "waiting for a maintainer — never the owner" : "not yet"))
        + '</div></div>';
  }
  // One half of the score (score.ts) as a column of checks: the mark, the item, its note, the points — a build's page draws the two halves, a person's page draws them per architecture. extra(item) adds the evidence link that proves an item.
  function ckColumn(sc, who, title, lede, extra) {
    var items = sc.items.filter(function (i) { return i.who === who; }), pts = items.reduce(function (n, i) { return n + i.points; }, 0);
    return '<div class="ckcol ' + who + '"><h3>' + title + ' <span class="num">' + pts + '<span class="dim">/50</span></span></h3><p class="dim">' + lede + '</p><ul>' + items.map(function (i) {
      var mark = i.state === "pending" ? '<i class="ck pending" title="still to come">○</i>' : i.points === i.max ? '<i class="ck ok">✓</i>' : i.points > 0 ? '<i class="ck part">✓</i>' : '<i class="ck bad">✗</i>';
      var more = extra ? extra(i) : "";
      return '<li>' + mark + '<div><b>' + esc(i.item) + '</b> <span class="dim">' + esc(i.note) + '</span>' + (more ? ' ' + more : '') + '</div><span class="num pts">' + i.points + '<span class="dim">/' + i.max + '</span></span></li>';
    }).join("") + '</ul></div>';
  }
  // The request on the record (request.ts), as the form checks it today: six lines, each green or not, and the way to put it right — "Renew the request", drawn for every reader once a line is not green (the dashboard's rule: the same control for all), live for the owner (own) while a renewal is taken (renewable: nothing of it is being built), grey with the reason in its title otherwise — the state's for the owner (whyNot: "renew it once build #12 is done"), the role's for everyone else (why: "only alice renews the request"; the sign-in for nobody).
  function requestBlock(q, own, name, renewable, whyNot, why) {
    if (!q) return '<div class="pkreq"><b>The request</b> <span class="dim">none on the record</span></div>';
    var bad = q.checks.filter(function (c) { return !c.ok; }).length;
    if (renewable === undefined) renewable = true;
    return '<div class="pkreq' + (q.complete ? '' : ' incomplete') + '"><div class="pkreq-head"><b>The request</b> '
      + (q.id ? '<a href="' + esc(q.record) + '" title="request.json, written once, signed by the pool">#' + q.id + '</a>' + (q.signature ? ' <a class="dim" href="' + esc(q.signature) + '">sig</a>' : '') : '') + (q.version ? ' · ' + esc(q.version) : '') + (q.created_at ? ' · ' + ago(q.created_at) : '')
      + ' ' + (q.complete ? pillHtml("ok", "complete", "what the form asks today, all on the record") : pillHtml("warn", bad + " to put right", "the form would not take it today"))
      + (q.complete ? '' : ' ' + gate('<a class="btn small" href="/request?renew=' + encodeURIComponent(name) + '" title="the same form, filled from the record; the confirmations are yours to tick">Renew the request</a>', !!own && !!renewable, own ? (whyNot || "renew it once nothing of it is being built") : (why || orSignIn("only its owner renews the request"))))
      + '</div><ul class="pkreq-list">' + q.checks.map(function (c) { return '<li><i class="ck ' + (c.ok ? 'ok">✓' : 'bad">✗') + '</i><div><b>' + esc(c.item) + '</b> <span class="dim">' + esc(c.note) + '</span></div></li>'; }).join("") + '</ul></div>';
  }
  // A chain's state in one word and its colour — the pill an architecture wears.
  function chainState(c) {
    if (!c) return { cls: "none", text: "no build yet" };
    var cc = c.contributor, pb = c.project, a = c.approval, sc = c.score;
    if (a && a.decision === "approved") return { cls: "ok", text: "approved" };
    if (c.withdrawn) return { cls: "warn", text: "approval withdrawn" };
    if (a && a.decision === "rejected") return { cls: "error", text: "rejected" };
    if (pb && (pb.status === "queued" || pb.status === "leased")) return { cls: "blue", text: "the project is building it" };
    if (pb && pb.status === "staged") return { cls: "ok", text: "built again by the project" };
    if (pb && pb.status === "failed") return { cls: "error", text: "the project's build failed" };
    if (cc && (cc.status === "queued")) return { cls: "blue", text: "queued" + (cc.queue ? " · " + cc.queue.position + " of " + cc.queue.total : cc.pinned_to ? " · for " + wtShort(cc.pinned_to) : "") };
    if (cc && (cc.status === "leased")) return { cls: "blue", text: "building" };
    if (cc && cc.status === "failed") return { cls: "error", text: "the build failed" };
    if (cc && cc.status === "cancelled") return { cls: "none", text: "superseded" };
    if (cc && cc.status === "staged") return sc.ready ? { cls: "ok", text: "ready for a maintainer" } : { cls: "warn", text: "not ready yet" };
    return { cls: "none", text: cc ? cc.status : "—" };
  }
  // The evidence a chain's step left, as links beside the checklist's items (the artifacts of the build the item is about).
  function ckEvidence(c) {
    var art = function (t, file, text) { return t ? '<a class="run" href="/api/v1/factory/tasks/' + t.id + '/artifacts/' + file + '">' + text + '</a>' : ''; };
    var cc = c.contributor, pb = c.project, tr = c.trial;
    return function (i) {
      if (i.item === "A build that succeeds") return cc ? art(cc, "build.log", "log") + (cc.status === "staged" || cc.status === "done" ? ' ' + art(cc, "PKGBUILD", "PKGBUILD") : '') : '';
      if (i.item === "The gate passed") return cc && cc.result && cc.result.vet ? art(cc, "tests.log", "tests") + ' ' + art(cc, "vet.json", "vet.json") : '';
      if (i.item === "The audit") return c.audit && c.audit.status === "done" ? art(cc, "audit.md", "report") : '';
      if (i.item === "The project built it again") return pb ? art(pb, "build.log", "log") : '';
      if (i.item === "The project's gate") return pb && pb.result && pb.result.vet ? art(pb, "tests.log", "tests") : '';
      if (i.item === "The trial installed it") return tr && tr.status === "done" ? art(pb, "trial.log", "transcript") : '';
      return '';
    };
  }
  // One architecture of a package: its latest chain — the state, the class, the build and the worker that held it, the two halves of the score with their evidence, the earlier builds — and the one line that says whose turn it is (next is the page's own wording); acts is the page's buttons for this architecture.
  function archPanel(arch, chainsOfArch, next, acts) {
    var c = chainsOfArch[0], st = chainState(c);
    var head = '<div class="pkarch-head"><span class="arch-name">' + esc(arch) + '</span> ' + pillHtml(st.cls, st.text);
    if (c) {
      var sc = c.score, cc = c.contributor, pb = c.project, t = cc || pb;
      head += ' ' + classPill(sc) + (sc.class !== sc.projected ? ' <span class="dim">→ ' + esc(sc.projected) + '</span>' : '');
      head += ' <span class="dim">·</span> <a href="/build/' + t.id + '">#' + t.id + '</a>' + (t.version ? ' <span class="dim">' + esc(t.version) + '</span>' : '') + (t.lease_owner ? ' <span class="dim">on</span> ' + wtId({ id: t.lease_owner, owner: t.owner }) : '') + (t.finished_at ? ' <span class="dim">· ' + ago(t.finished_at) + '</span>' : t.started_at ? ' <span class="dim">· started ' + ago(t.started_at) + '</span>' : '') + (t.duration_ms ? ' <span class="dim">· ' + Math.round(t.duration_ms / 1000) + ' s</span>' : '');
    }
    head += (acts ? '<span class="acts-inline">' + acts + '</span>' : '') + '</div>';
    if (!c) return '<section class="pkarch">' + head + '<p class="sub" style="margin:8px 0 0">' + next + '</p></section>';
    var ev = ckEvidence(c), cc2 = c.contributor;
    var earlier = chainsOfArch.slice(1, 6).map(function (x) { var s2 = chainState(x), t2 = x.contributor || x.project; return '<a href="/build/' + t2.id + '" title="' + esc(s2.text) + ' · class ' + esc(x.score.class) + '">#' + t2.id + '</a> <span class="dim">' + esc(s2.text) + '</span>'; });
    return '<section class="pkarch">' + head + '<div class="pknext-line">' + next + '</div><div class="cklist">'
      + ckColumn(c.score, "contributor", "The contributor's half", cc2 ? personLink(cc2.owner) + ' · build <a href="/build/' + cc2.id + '">#' + cc2.id + '</a>' : 'nobody yet', ev)
      + ckColumn(c.score, "maintainer", "The maintainer's half", c.project ? 'the project\'s build <a href="/build/' + c.project.id + '">#' + c.project.id + '</a>' + (c.approval ? ' · decided by ' + personLink(c.approval.by) : c.withdrawn ? ' · the approval by ' + personLink(c.withdrawn.by) + ' was withdrawn' : ' · not decided') : 'not started' + (c.score.ready ? ' — ready to begin' : ''), ev)
      + '</div>' + (earlier.length ? '<p class="sub" style="margin:8px 0 0">Earlier: ' + earlier.join(' · ') + '</p>' : '') + '</section>';
  }
  function personChip(login, role, extra) { return '<a class="person" href="/user/' + encodeURIComponent(login) + '" title="' + esc(login) + ' · ' + esc(role) + '">' + avatarIcon(login, role) + '<b>' + esc(login) + '</b>' + (extra ? ' <span class="r">' + extra + '</span>' : '') + '</a>'; }
  // A tile with a fifth element is a link: the number, and the page that proves it.
  function setTiles(sel, list) { var el = $(sel); if (!el) return; list.forEach(function (t, i) { var cell = el.children[i], tag = t[4] ? "A" : "DIV"; if (!cell || cell.tagName !== tag) { var made = document.createElement(tag); made.className = "tile"; if (cell) { made.innerHTML = cell.innerHTML; el.replaceChild(made, cell); } else el.appendChild(made); cell = made; } if (t[4]) cell.href = t[4]; setTile(cell, '<div class="k">' + t[0] + '</div><div class="v num' + (t[3] ? " " + t[3] : "") + '">' + t[1] + '</div><div class="s">' + t[2] + '</div>'); }); while (el.children.length > list.length) el.removeChild(el.lastChild); }
  // Every fetch a page starts goes through busy(): the bar at the top stays
  // on while at least one is in flight.
  function busy(p) {
    var el = $("#progress"); busy.n = (busy.n || 0) + 1; if (el) el.classList.add("on");
    return p.finally(function () { busy.n = Math.max(0, (busy.n || 1) - 1); if (!busy.n && el) el.classList.remove("on"); });
  }
  // Placeholders until the first data arrives: rows for a table, cells for
  // tiles. A render replaces a placeholder's content and drops the mark;
  // endSkeleton() removes whatever placeholders are left over.
  function skeletonRows(tableSel, cols, rows) {
    var tb = document.querySelector(tableSel + " tbody"); if (!tb || tb.children.length) return;
    var row = '<tr class="skel">' + new Array(cols + 1).join('<td><span class="skl"></span></td>') + '</tr>';
    tb.innerHTML = new Array((rows || 4) + 1).join(row);
  }
  function skeletonTiles(sel, n) {
    var el = $(sel); if (!el || el.children.length) return;
    el.innerHTML = new Array((n || 4) + 1).join('<div class="tile skel"><div class="k"><span class="skl"></span></div><div class="v"><span class="skl"></span></div><div class="s"><span class="skl"></span></div></div>');
  }
  function skeletonText(sel) { var el = $(sel); if (el && !el.textContent.trim()) { el.classList.add("empty", "loading"); el.textContent = "Loading"; } }
  function endSkeleton() { document.querySelectorAll(".skel").forEach(function (el) { el.remove(); }); document.querySelectorAll(".empty.loading").forEach(function (el) { el.classList.remove("empty", "loading"); if (el.textContent === "Loading") el.textContent = ""; }); }
  // Numbers that change between refreshes flash briefly, so the page reads as live.
  function setTile(el, html) { el.classList.remove("skel"); if (el.innerHTML !== html) { el.innerHTML = html; el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); } }
  function liveStats(render, everyMs) {
    function load() {
      serviceStatus();
      busy(fetch("/api/v1/stats")).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (d) { pipelineFrom(d); render(d); endSkeleton(); })
        .catch(function () {});
    }
    load();
    setInterval(load, everyMs || 20000);
  }
`;

export interface PageOptions {
  title: string;
  description: string;
  /** Which of the three doors (or the docs) is highlighted; detail pages highlight none. */
  active: "pool" | "factory" | "review" | "pipeline" | "docs" | "none";
  /** Documentation pages: which chapter, for the section's own navigation. */
  doc?: DocKey;
  body: string;
  script?: string;
  poolUrl: string;
  version: RunningVersion;
  /**
   * The path this page is served at ("/workers", "/build/12"): the header's
   * Sign in carries it as `next`, so signing in returns the reader to the
   * page they pressed it on. A page with one route passes its own; a page
   * with a parameter builds it from the parameter, unencoded — the frame
   * encodes it once, as a query value.
   */
  path: string;
}

/** Four doors — use it, contribute to it, maintain it, watch it run. Everything else, the documentation included, is one link away in the footer. */
export const NAV: { key: PageOptions["active"]; href: string; label: string; sub?: string }[] = [
  { key: "pool", href: "/", label: "Pool", sub: "use" },
  { key: "factory", href: "/factory", label: "Factory", sub: "contribute" },
  { key: "review", href: "/review", label: "Review", sub: "maintain" },
  { key: "pipeline", href: "/pipeline", label: "Pipeline", sub: "live" },
];

/**
 * The detail pages and the documentation, pushed to the side: linked from
 * the footer and from the doors. Every page with a route of its own is here
 * or in NAV, so no page is reached only through another page's content —
 * what the pool serves first (packages, their security, its status and its
 * history), then who runs it (workers, people), then the way in (a request),
 * then what explains it (the docs, the API). The footer lights the entry
 * whose path the reader is on or under, so a package's page lights Packages
 * and a chapter lights Docs.
 */
export const MORE: { href: string; label: string }[] = [
  { href: "/packages", label: "Packages" },
  { href: "/security", label: "Security" },
  { href: "/status", label: "Status" },
  { href: "/journal", label: "Journal" },
  { href: "/workers", label: "Workers" },
  { href: "/people", label: "People" },
  { href: "/request", label: "Request" },
  { href: "/docs", label: "Docs" },
  { href: "/api", label: "API" },
];

/**
 * The line under the docs map that says where the rest is, written from
 * MORE so it cannot name a page the footer does not link (it once
 * said Review was in the footer): "Packages, Security, … and the API are
 * pages of their own — linked from the footer; the four doors are the header."
 */
export function docsHint(): string {
  const rest = MORE.filter((m) => m.href !== "/docs").map((m) => (m.label === "API" ? "the API" : m.label));
  return `${rest.slice(0, -1).join(", ")} and ${rest[rest.length - 1]} are pages of their own — linked from the footer; the four doors are the header.`;
}

/** The three kinds of worker, as their tables name them: the project's, the review ones, the contributors'. */
export type WorkerKind = "project" | "review" | "community";

/**
 * The three worker tables as every page serves them — the Workers page,
 * the People page, a person's — one panel per kind with the kind's name
 * and the page's one line under it, the table the shell's script fills
 * (wtTables() the head and the skeleton, workerRow() the rows), the legend
 * after them. The order is the page's; a panel with `hidden` is a person's,
 * shown once a row is theirs, and a page that hides a panel gives it an id
 * (`wp-<kind>`) to show it by. The frame lives here so the row it holds
 * and the panel around it cannot drift apart.
 */
export function workerPanels(kinds: { kind: WorkerKind; blurb: string; hidden?: boolean }[]): string {
  const NAME: Record<WorkerKind, string> = { project: "Project", review: "Review", community: "Contributors" };
  return kinds.map((k, i) => `<div class="panel"${k.hidden ? ` id="wp-${k.kind}" hidden` : ""}${i ? ' style="margin-top:16px"' : ""}><h3>${NAME[k.kind]} <span class="dim" style="font-size:12px;font-weight:400">${escapeHtml(k.blurb)}</span></h3>
      <div class="table-wrap" style="border:0"><table id="w-${k.kind}" class="wtable"><thead><tr></tr></thead><tbody></tbody></table></div></div>`).join("\n    ") + `\n    <div id="wt-legend"></div>`;
}

const LICENSE_URL = "https://github.com/firemanxbr/omarchy-pool/blob/main/LICENSE";

/** One badge in the footer: this is built for Omarchy, and the link goes there. */
const BUILT_FOR_OMARCHY =
  '<svg viewBox="0 0 156 20" width="156" height="20" role="img" aria-label="built for Omarchy"><rect width="86" height="20" fill="#2a2e3f"/><rect x="86" width="70" height="20" fill="#9ece6a"/><rect x="6" y="5" width="10" height="10" fill="#9ece6a"/><rect x="9" y="8" width="4" height="4" fill="#2a2e3f"/><text x="21" y="14" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#c0caf5">built for</text><text x="121" y="14" text-anchor="middle" font-family="Geist, sans-serif" font-size="11" font-weight="700" fill="#0c0e10">Omarchy</text></svg>';

export type { DocKey } from "./docs-tree";

/**
 * The documentation's shell: every docs page — the index, a chapter — is
 * the same layout, the map beside the text. The sidebar carries the search
 * and the chapters; the current one is open on its sections, the others
 * open on a click; a section is a link to its anchor on its chapter's
 * page. The search (docsSearch, below) matches chapters, sections and the
 * glossary and answers with links, so a reader never leaves the shell.
 */
function docsShell(current: DocKey, body: string): string {
  const tree = DOCS_TREE.map((c, i) => {
    const on = c.key === current;
    const label = i > 0 && c.group === "code" && DOCS_TREE[i - 1].group !== "code" ? '<div class="docs-group">For people working on the pool</div>' : "";
    const secs = c.key === "glossary"
      ? GLOSSARY.map(([term]) => `<li><a href="${c.href}#${termId(term)}">${escapeHtml(term)}</a></li>`)
      : c.secs.map((sec) => `<li><a href="${c.href}#${sec.id}">${escapeHtml(sec.title)}</a></li>`);
    return `${label}<details${on ? " open" : ""}><summary><a href="${c.href}"${on ? ' class="on"' : ""}>${escapeHtml(c.label)}</a>${secs.length ? `<small>${secs.length}</small>` : ""}</summary><ul>${secs.join("")}</ul></details>`;
  });
  return `<div class="docs">
  <aside class="docs-side">
    <a class="docs-home${current === "index" ? " on" : ""}" href="/docs">Documentation</a>
    <input type="search" id="docs-q" placeholder="search the docs…" aria-label="search the docs" autocomplete="off">
    <div class="docs-hits" id="docs-hits" hidden></div>
    <nav class="docs-nav" id="docs-nav" aria-label="Chapters">${tree.join("")}</nav>
    <div class="docs-hint">${docsHint()}</div>
  </aside>
  <div class="docs-main">
${body}
  </div>
</div>`;
}

/** The anchor of a glossary term on the Glossary page. */
export function termId(term: string): string {
  return "term-" + term.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The search over the map, on every docs page: chapters, sections, the glossary — each hit a link. */
const DOCS_SEARCH = String.raw`
  (function () {
    var q = $("#docs-q"), hits = $("#docs-hits"), nav = $("#docs-nav"); if (!q || !hits || !nav) return;
    var TREE = __DOCS_TREE__, GLOSSARY = __GLOSSARY__;
    var items = [];
    TREE.forEach(function (c) {
      items.push({ ch: c.label, title: c.label, text: c.blurb, href: c.href });
      c.secs.forEach(function (s) { items.push({ ch: c.label, title: s.title, text: s.blurb, href: c.href + "#" + s.id }); });
    });
    GLOSSARY.forEach(function (g) { items.push({ ch: "Glossary", title: g[0], text: g[1], href: "/docs/glossary#" + g[2] }); });
    function hl(t, needle) { var i = t.toLowerCase().indexOf(needle); return i < 0 ? esc(t) : esc(t.slice(0, i)) + "<mark>" + esc(t.slice(i, i + needle.length)) + "</mark>" + esc(t.slice(i + needle.length)); }
    q.oninput = function () {
      var needle = q.value.trim().toLowerCase();
      if (!needle) { hits.hidden = true; nav.hidden = false; return; }
      var found = items.filter(function (it) { return (it.ch + " " + it.title + " " + it.text).toLowerCase().indexOf(needle) >= 0; }).slice(0, 12);
      hits.innerHTML = found.length
        ? found.map(function (it) { return '<a class="hit" href="' + it.href + '"><span class="ch">' + esc(it.ch) + '</span><b>' + hl(it.title, needle) + '</b><span>' + hl(it.text, needle) + '</span></a>'; }).join("")
        : '<div class="hit none">nothing in the docs says “' + esc(q.value.trim()) + '”</div>';
      hits.hidden = false; nav.hidden = true;
    };
    q.onkeydown = function (e) { if (e.key === "Escape") { q.value = ""; q.oninput(); } };
  })();
`;

/**
 * The page-view counter, when the deployment names one (ANALYTICS): Google
 * Analytics 4 for a G-… id — it sets cookies, so the Pool page's "no
 * cookies" line is only true without it — or Cloudflare Web Analytics for
 * a beacon token, which sets none. Nothing at all otherwise.
 */
function analyticsTag(v: RunningVersion): string {
  const id = v.analytics;
  if (/^G-[A-Z0-9]{4,20}$/.test(id)) return `\n<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>\n<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}',{anonymize_ip:true});</script>`;
  if (/^[a-f0-9]{32}$/.test(id)) return `\n<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${id}"}'></script>`;
  return "";
}

/** A path as the value of `next`: what would end the value or change it in a query (a `+` reads as a space there, an `&` as the next parameter) is encoded, the slashes are kept so the address reads as the page. */
function nextOf(path: string): string {
  return encodeURIComponent(path).replace(/%2F/g, "/");
}

export function page(o: PageOptions): string {
  const v = o.version;
  const tag = escapeHtml(v.version);
  const chip = v.release_url
    ? `<a class="ver" href="${escapeHtml(v.release_url)}" title="running release">${tag}</a>`
    : `<span class="ver" title="local build">${tag}</span>`;
  const nav = NAV.map((n) => `<a href="${n.href}"${n.key === o.active ? ' class="active"' : ""}>${n.label}${n.sub ? `<small>${n.sub}</small>` : ""}</a>`).join("\n    ");
  const more = MORE.map((m) => `<a href="${m.href}">${m.label}</a>`).join("");
  const body = o.doc ? docsShell(o.doc, o.body) : o.body;
  const pool = o.poolUrl.replace(/\/$/, "");
  const docsSearch = o.doc
    ? DOCS_SEARCH.replace("__DOCS_TREE__", JSON.stringify(DOCS_TREE.map((c) => ({ label: c.label, blurb: c.blurb, href: c.href, secs: c.secs })))).replace("__GLOSSARY__", JSON.stringify(GLOSSARY.map(([t, d]) => [t, d, termId(t)])))
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)}</title>
<meta name="description" content="${escapeHtml(o.description)}">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#1a1b26">${analyticsTag(v)}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Geist:wght@500;600;700&display=swap">
<style>${CSS}</style>
</head>
<body>
<div id="progress"></div>
<header>
  <a class="brand" href="/"><span class="mark">▣</span> omarchy-pool</a>
  <div class="hmid">
    ${chip}
    <nav>
      ${nav}
    </nav>
  </div>
  <span class="account"><a id="account" href="/auth/github?next=${escapeHtml(nextOf(o.path))}" title="contributors and maintainers sign in with GitHub">Sign in</a><a id="signout" href="/auth/logout" hidden title="sign out of the dashboard on this browser">sign out</a></span>
</header>

<main>
${body}
</main>

<footer>
  <div class="fleft"><a class="fbadge" href="https://omarchy.org/" title="Built for Omarchy">${BUILT_FOR_OMARCHY}</a><span class="fnote">a community pool — not official Omarchy</span></div>
  <span class="more">${more}</span>
  <div class="fright"><a class="gh" href="https://github.com/firemanxbr/omarchy-pool" title="omarchy-pool on GitHub">${GITHUB_ICON} GitHub</a><a class="fnote" href="${LICENSE_URL}" title="the code is open source under the MIT licence">MIT License</a></div>
</footer>

<script>
(function () {
  // The footer lights the entry the reader is on or under: /package/<name> is Packages, /docs/<chapter> is Docs, /diff is the Journal's; a build lights nothing here, its door is Review.
  document.querySelectorAll("footer .more a").forEach(function (a) { var href = a.getAttribute("href"), here = location.pathname; if (here === href || here.indexOf(href + "/") === 0 || (href === "/packages" && here.indexOf("/package/") === 0) || (href === "/journal" && here === "/diff")) a.classList.add("active"); });
${HELPERS.split("__POOL_URL__").join(pool).split("__RINGS_TEXT__").join(JSON.stringify(RING_TEXT)).split("__WICON__").join(JSON.stringify(WORKER_ICONS))}
${o.script ?? ""}
${docsSearch}
})();
</script>
</body>
</html>`;
}
