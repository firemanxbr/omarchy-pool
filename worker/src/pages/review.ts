/**
 * Review (#247): the maintainers' door, drawn with the v1 kit. Two views of
 * one page, the same for every role:
 *
 * - The queue, public and read-only for anyone who is not a maintainer:
 *   four tiles (ready, in review, approved this week, blocked), four tabs
 *   (Ready, In review, Blocked, No maintainer) with a row action each —
 *   Claim, Open, Lift block, Adopt — and the maintainers with the three
 *   steps to become one. The viewer's own requests say "yours · locked".
 * - The workspace (/review?package=<name>), side by side: the factory's
 *   build as the reference on the left (the request as checked, its
 *   PKGBUILD, its log per architecture — learnt from, never reused), the
 *   project's rebuild on the right (the steps, the rebuilt PKGBUILD with
 *   the lines that differ lit, the rebuild's log), then the checklist and
 *   the verdict with the agent's draft, and the three decisions — Approve,
 *   Request changes, Reject — each confirmed before it is posted.
 *
 * A claim is "Build by the project" (routes/review.ts): the project's
 * rebuild of the package on a review worker, the maintainer's choice of
 * agent pinning the worker that drafts it (an idle one first). What is
 * decided is the server's rule, read, never the page's: the list files
 * each package (`state`) and counts them (`ready`, `in_review`), every row
 * carries what the viewer may do on it (`can`, with the reason), and a
 * control the viewer may not use is drawn grey with that reason in its
 * title (the shell's gate()) — never hidden. Nothing here reads a package
 * out of staging: the evidence the workspace shows is the public text
 * (PKGBUILD, build.log) of each build — the rebuild's while it runs, once
 * it built and after it shipped.
 *
 * Read and redrawn every minute, it keeps the reader's place: the queue's
 * rows are no live region (one short line says the tab and its count when
 * they change), the control a keyboard was on keeps the focus through a
 * redraw, the three decisions are drawn once and gated in place, and the
 * confirmation takes the focus when it opens and gives it back when it
 * closes (Cancel, or Escape). The project's workers are read when a claim
 * or the workspace first needs them, never for the queue alone.
 */
import { page, servedGrey } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import { lucide } from "./kit";
import type { RunningVersion } from "../meta";
import { CATEGORIES } from "../categories";

/** The brake's form (block a contributor or a package): served grey with the reason, drawn again through the shell's gate() once whoami answers — live for a maintainer. It is the Blocked tab's. */
const BLOCK_WHY = "a maintainer blocks; another maintainer lifts";
const BLOCK_FORM = `<input id="block-what" placeholder="contributor login, or package name" required aria-label="contributor login, or package name"> <input id="block-why" placeholder="why — the record and the contributor see this" required minlength="4" aria-label="why"> <button type="submit" class="op-btn danger">Block</button>`;

/** The tiles as served, before the lists answer: the labels and "—", the line under each in its place. */
const TILES = [
  ["Ready for review", "waiting for a claim"],
  ["In review", "claimed by maintainers"],
  ["Approved", "this week"],
  ["Blocked", "back in the factory"],
] as const;
const tile = ([k, s]: readonly [string, string]) => `<div class="op-stat"><span class="k">${k}</span><b class="n">—</b><span class="s">${s}</span></div>`;

/** The tabs, in the design's order: the id the script files a package under, and the label. */
const TABS = [
  ["ready", "Ready"],
  ["review", "In review"],
  ["blocked", "Blocked"],
  ["unmaintained", "No maintainer"],
] as const;

/** The three decisions of the workspace, drawn once and kept (renderDecide sets what each may do): a redraw would take the focus from the one a keyboard is on. */
const DECIDE = [
  ["approve", "Approve", " primary"],
  ["changes", "Request changes", ""],
  ["reject", "Reject", " danger"],
] as const;
/** Their reason before the lists answer: the page's word for a package with nothing in review. */
const NOTHING = "nothing of this package is in review";

const BODY = String.raw`
<div class="rv">
  <div class="rv-view" id="rv-queue">
    <section class="rv-hero">
      <div class="rv-lede">
        <p class="op-eyebrow">For maintainers</p>
        <h1 class="op-hero">Review what others asked for</h1>
        <p class="rv-facts"><a href="/docs/governance">${lucide("lock", 15)}Never your own requests</a><a href="/docs/governance">${lucide("refresh-cw", 15)}Rebuild from scratch</a><a href="/docs/factory">${lucide("package-check", 15)}Your build is the one that ships</a></p>
      </div>
      <div class="op-stats rv-stats" id="rv-tiles">${TILES.map(tile).join("")}</div>
    </section>
    <section class="rv-pair">
      <div class="op-card rv-list" id="rv-list" data-tab="ready">
        <div class="rv-bar">
          <div class="op-tabs rv-tabs" id="rv-tabs" role="tablist" aria-label="The queue">${TABS.map(([id, t], i) => `<button type="button" role="tab" id="rv-tab-${id}" aria-controls="rv-rows" data-tab="${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${t}<span class="n"><span class="rv-sr">: </span><span id="rv-n-${id}"></span></span></button>`).join("")}</div>
          <span class="rv-who" id="rv-who">read-only · maintainers claim and review</span>
        </div>
        <div class="rv-rows" id="rv-rows" role="tabpanel" aria-labelledby="rv-tab-ready"><p class="rv-empty">Loading</p></div>
        <p class="rv-sr" id="rv-said" aria-live="polite"></p>
        <p class="rv-note" id="rv-note"></p>
        <form class="rv-brake" id="brake"><span class="op-label">Block a contributor or a package</span><span class="rv-brake-f" id="block-form">${servedGrey(BLOCK_FORM, BLOCK_WHY)}</span></form>
      </div>
      <aside class="op-card rv-maint" id="rv-maint" aria-label="Maintainers">
        <div class="op-card-h"><b>${lucide("users", 16)}Maintainers</b><small id="rv-maint-n"></small></div>
        <div class="rv-mrows" id="rv-maints"></div>
        <div class="rv-steps" id="rv-become"><a href="/docs/governance">${lucide("package-check")}<span>1 approved package</span></a><a href="https://github.com/firemanxbr/omarchy-pool/issues/new">${lucide("github")}<span>open an issue</span></a><a href="https://github.com/firemanxbr/omarchy-pool/blob/main/factory/MAINTAINERS.toml">${lucide("git-pull-request")}<span>a PR adds you</span></a></div>
      </aside>
    </section>
  </div>

  <div class="rv-view rv-work" id="rv-work" hidden>
    <div class="rv-crumbs"><span><a href="/review" id="rv-back">Review</a> / <span id="rv-w-crumb"></span></span><span class="rv-claim"><span id="rv-w-claim"></span><span id="rv-w-release"></span></span></div>
    <section class="rv-whead">
      <div class="rv-wid">
        <span class="op-box lg wait" id="rv-w-box">${lucide("user-check", 26)}</span>
        <div class="rv-wname">
          <div class="rv-wtitle"><h1 id="rv-w-name"></h1><span class="rv-wver" id="rv-w-ver"></span><span id="rv-w-state"></span></div>
          <div class="rv-wchips" id="rv-w-chips"></div>
        </div>
      </div>
      <dl class="rv-fields" id="rv-w-fields"></dl>
    </section>
    <p class="rv-werr" id="rv-w-err" hidden></p>
    <section class="rv-side">
      <div class="rv-pane rv-factory" id="rv-factory">
        <div class="rv-pane-h"><span>${lucide("factory", 15)}<b>Factory</b><span class="rv-tag">reference</span></span><span class="rv-agent" id="rv-f-agent"></span></div>
        <div class="rv-pane-b">
          <div class="rv-block"><span class="op-label">Request, as checked</span><div class="rv-checks" id="rv-f-req"></div></div>
          <div class="rv-block"><span class="op-label">PKGBUILD</span><div class="rv-code" id="rv-f-pkgbuild"></div></div>
          <div class="rv-block"><div class="rv-bh"><span class="op-label">Build log</span><span class="op-tabs rv-logtabs" id="rv-f-tabs"></span></div><div class="rv-code log" id="rv-f-log"></div><div class="rv-evid" id="rv-f-evid"></div></div>
          <p class="rv-foot">${lucide("ban", 13)}Learn from it. Its packages are never reused.</p>
        </div>
      </div>
      <div class="rv-pane rv-yours" id="rv-yours">
        <div class="rv-pane-h"><span>${lucide("refresh-cw", 15)}<b id="rv-y-title">The rebuild</b><span class="rv-tag ok">review worker</span></span><span class="rv-agents" id="rv-agents"></span></div>
        <div class="rv-pane-b">
          <div class="rv-block"><div class="rv-bh"><span class="op-label">Steps</span><span class="rv-pct" id="rv-pct"></span></div><div class="rv-checks" id="rv-steps"></div><div class="rv-progress"><i id="rv-progress"></i></div><div class="rv-claimbar" id="rv-claimbar"></div></div>
          <div class="rv-block"><div class="rv-bh"><span class="op-label">PKGBUILD</span><span class="rv-diffnote" id="rv-diffnote"></span></div><div class="rv-code" id="rv-y-pkgbuild"></div></div>
          <div class="rv-block"><span class="op-label">Rebuild log</span><div class="rv-code log" id="rv-y-log"></div><div class="rv-evid" id="rv-y-evid"></div></div>
          <p class="rv-foot">${lucide("package-check", 13)}If approved, this build is the one that ships.</p>
        </div>
      </div>
    </section>
    <section class="op-card rv-decide" id="rv-decide">
      <div class="rv-checklist"><span class="op-label">Checklist</span><div id="rv-checklist"></div></div>
      <div class="rv-verdict">
        <label class="op-label" for="rv-note-in">Verdict · goes on the record</label>
        <textarea id="rv-note-in" rows="2" placeholder="The agent drafts a verdict when the rebuild ends"></textarea>
        <span id="rv-usedraft"></span>
        <div class="rv-btns" id="rv-btns">${DECIDE.map(([what, label, cls]) => `<button type="button" class="op-btn${cls}" data-decide="${what}" disabled aria-disabled="true" title="${NOTHING}">${label}</button>`).join("")}</div>
        <p class="rv-err" id="rv-err" role="alert"></p>
        <div class="rv-confirm" id="rv-confirm" role="group" aria-labelledby="rv-confirm-t" hidden><span id="rv-confirm-t"></span><span class="rv-confirm-b"><button type="button" class="op-btn go" id="rv-confirm-go">Confirm</button><button type="button" class="op-btn" id="rv-confirm-no">Cancel</button></span></div>
      </div>
    </section>
  </div>
</div>
`;

/**
 * The page's own layout (layout.ts `css`): what the kit has no piece for —
 * the 1120px frame, the queue's rows, the maintainers card, the workspace's
 * panes, code wells with numbered lines and the lines a diff lights, the
 * checklist and the verdict. Every rule is under an rv- class, and .rv in
 * front where it refines a kit primitive. Tokens only; the motion (the
 * progress bar, the kit's live dot and fresh rows) stops under
 * prefers-reduced-motion by the frame's rule.
 */
const CSS = String.raw`
  .rv { max-width: 1056px; margin: 0 auto; padding-top: 12px; }
  .rv a { text-decoration: none; } .rv section { margin: 0; }
  .rv :is(a, button, select, textarea, input):focus-visible { outline: 1px solid var(--green); outline-offset: 2px; }
  .rv-sr { position: absolute; width: 1px; height: 1px; margin: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .rv-view { display: grid; grid-template-columns: minmax(0, 1fr); gap: 40px; align-content: start; } .rv-view[hidden] { display: none; }
  .rv-hero > *, .rv-pair > *, .rv-whead > * { min-width: 0; }
  .rv-hero { display: flex; flex-wrap: wrap; gap: 32px 40px; align-items: flex-end; }
  .rv-lede { flex: 1 1 480px; min-width: 0; display: grid; gap: 16px; }
  .rv .op-hero { max-width: 600px; }
  .rv-facts { margin: 0; display: flex; flex-wrap: wrap; gap: 10px 22px; font-size: 13.5px; color: var(--muted); }
  .rv-facts a { display: inline-flex; align-items: center; gap: 8px; color: inherit; text-decoration: underline dotted var(--line); text-underline-offset: 4px; } .rv-facts a:is(:hover, :focus-visible) { color: var(--text); text-decoration-color: var(--dim); } .rv-facts .op-i { color: var(--green); }
  .rv .rv-stats { flex: 1 1 360px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rv .rv-stats .s span[title] { text-decoration: underline dotted; }
  .rv-pair { display: flex; flex-wrap: wrap; gap: 16px; align-items: stretch; }
  .rv-list { flex: 1 1 600px; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr auto auto; }
  .rv-bar { display: flex; justify-content: space-between; align-items: center; gap: 0 12px; flex-wrap: wrap; padding: 0 16px; border-bottom: 1px solid var(--line); }
  .rv .rv-tabs { min-width: 0; gap: 18px; font-size: 13.5px; }
  .rv .rv-tabs > button { padding: 12px 0 11px; }
  .rv-tabs .n { margin-left: 6px; color: var(--dim); font-size: 12px; }
  .rv-who { padding: 10px 0; font-size: 12px; color: var(--dim); }
  .rv-rows { display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; }
  .rv-row { display: grid; grid-template-columns: minmax(140px, 1.1fr) minmax(0, 1.7fr) auto 44px auto; gap: 14px; align-items: center; padding: 11px 16px; border-bottom: 1px solid var(--line); font-size: 13px; }
  .rv-rows > .rv-row:last-child, .rv-mrows > .rv-mrow:last-child { border-bottom: 0; }
  /* The name and its version, each whole: a version that does not fit beside the name wraps under it, never "0.0.1…" for 0.0.168 (#282); a name
     or a version wider than the cell alone (an epoch or a git version) is cut there with an ellipsis, whole in its title, never drawn past it. */
  .rv-name { min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 6px; } .rv-name > :first-child { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rv-name a { color: var(--text); } .rv-name a:hover { color: var(--green); } .rv-name b { font-weight: 600; } .rv-name .v { flex: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; color: var(--dim); font-size: 12px; white-space: nowrap; }
  .rv-sub { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 12.5px; color: var(--muted); } .rv-sub .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .rv-sub a { color: inherit; } .rv-sub a:hover { color: var(--green); }
  .rv-av { flex: none; display: inline-grid; place-items: center; width: 18px; height: 18px; background: var(--bg-deep); color: var(--text); font-size: 8px; font-weight: 700; text-transform: uppercase; }
  .rv-av.lg { width: 26px; height: 26px; font-size: 11px; } .rv-av.sm { width: 16px; height: 16px; font-size: 7px; }
  .rv-archs { display: flex; gap: 3px; } .rv .rv-archs .op-arch { width: 9px; height: 9px; }
  .rv-age { font-size: 12px; color: var(--dim); text-align: right; white-space: nowrap; }
  .rv-act { justify-self: end; }
  .rv .op-btn.sm { padding: 3px 11px; font-size: 12.5px; line-height: 1.5; }
  .rv .op-btn[disabled] { opacity: 1; background: transparent; border-color: var(--line); color: var(--dim); }
  .rv-empty { margin: 0; padding: 16px; font-size: 13px; color: var(--dim); }
  .rv-note { margin: 0; padding: 10px 16px; font-size: 12.5px; color: var(--amber); } .rv-note:empty { display: none; }
  .rv-brake { display: none; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 12px 16px; border-top: 1px solid var(--line); } .rv-list[data-tab="blocked"] .rv-brake { display: flex; }
  .rv-brake-f { flex: 1 1 420px; display: flex; flex-wrap: wrap; gap: 8px; }
  .rv-brake input, .rv-claimbar input { flex: 1 1 180px; min-width: 0; padding: 5px 10px; border: 1px solid var(--line); border-radius: 0; background: var(--bg-deep); color: var(--text); font: 13px var(--font-mono); }
  .rv-brake input:focus, .rv-claimbar input:focus, .rv-verdict textarea:focus { outline: none; border-color: var(--green); }
  .rv-maint { flex: 1 1 320px; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr auto; }
  .rv-maint .op-card-h b { display: inline-flex; align-items: center; gap: 10px; } .rv-maint .op-card-h .op-i { color: var(--dim); }
  .rv-mrow { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); }
  .rv-mwho { display: grid; min-width: 0; line-height: 1.35; } .rv-mwho > span { display: flex; align-items: center; gap: 6px; font-size: 13px; } .rv-mwho a { color: var(--text); } .rv-mwho a:hover { color: var(--green); }
  .rv-mwho .you { color: var(--green); font-size: 11px; } .rv-mwho .s { display: block; color: var(--dim); font-size: 12px; }
  /* The line under a maintainer wraps between its parts, never inside one: "reviewing bitwarden · 3 reviews · 1 package" read "1 p…" at 1280 (#282). */
  .rv-mwho .s > span { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: top; }
  .rv-mag { display: grid; place-items: center; width: 24px; height: 24px; border: 1px solid var(--line); background: var(--bg-deep); } .rv-mag.none { border: 0; background: transparent; }
  .rv-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: var(--line); border-top: 1px solid var(--line); }
  .rv-steps a { display: grid; gap: 2px; align-content: start; padding: 10px 12px; background: var(--panel-2); color: var(--muted); font-size: 12px; } .rv-steps a:hover { color: var(--text); } .rv-steps .op-i { color: var(--green); }
  .rv-work { gap: 16px; }
  .rv-crumbs { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 13px; color: var(--dim); } .rv-crumbs a { color: var(--muted); } .rv-crumbs a:hover { color: var(--text); }
  .rv-claim { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; } .rv-claimed { display: inline-flex; align-items: center; gap: 8px; color: var(--amber); } .rv-claimed.other { color: var(--muted); } .rv-claimed.none { color: var(--dim); }
  .rv-whead { display: flex; flex-wrap: wrap; gap: 16px 28px; align-items: flex-start; justify-content: space-between; }
  .rv-wid { display: flex; gap: 16px; align-items: flex-start; min-width: 0; } .rv-wname { display: grid; gap: 6px; min-width: 0; }
  .rv-wtitle { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; } .rv-wtitle h1 { margin: 0; font: 600 30px/1.15 var(--font-display); letter-spacing: -0.02em; overflow-wrap: anywhere; } .rv-wver { color: var(--dim); font: 500 16px var(--font-display); }
  .rv-wchips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12.5px; }
  .rv .rv-wchips .op-chip { padding: 1px 8px; font-size: 12.5px; } .rv .op-chip.by { gap: 6px; padding-left: 2px; color: var(--text); } .rv .op-chip.ok { border-color: var(--green); color: var(--green); } .rv .op-chip.run { border-color: var(--blue); color: var(--blue); }
  .rv-fields { flex: 1 1 460px; margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px 20px; }
  .rv-field { display: grid; min-width: 0; }
  .rv-field dt { display: flex; align-items: center; gap: 10px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  .rv-field dd { margin: 0; padding-left: 25px; font-size: 13.5px; overflow-wrap: anywhere; } .rv-field dd a { color: var(--text); } .rv-field dd a:hover { color: var(--green); }
  .rv-field select { max-width: 100%; padding: 1px 4px; border: 1px solid var(--line); border-radius: 0; background: var(--bg-deep); color: var(--text); font: 13px var(--font-mono); }
  .rv-side { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(440px, 100%), 1fr)); gap: 16px; }
  .rv-werr { margin: 0; padding: 12px 16px; border: 1px solid var(--line); font-size: 13.5px; color: var(--muted); } .rv-werr[hidden] { display: none; } .rv-werr a { color: var(--text); text-decoration: underline dotted var(--dim); text-underline-offset: 4px; }
  .rv-pane { min-width: 0; border: 1px solid var(--line); background: var(--panel-2); } .rv-yours { border-color: var(--green); background: var(--panel); }
  .rv-pane-h { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid var(--line); }
  .rv-pane-h > span:first-child { display: flex; align-items: center; gap: 8px; color: var(--dim); } .rv-yours .rv-pane-h > span:first-child { color: var(--green); } .rv-pane-h b { color: var(--text); font: 600 15px var(--font-display); }
  .rv-tag { padding: 0 7px; border: 1px solid var(--line); color: var(--dim); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; } .rv-tag.ok { border-color: var(--green); color: var(--green); }
  .rv-agent { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dim); }
  .rv-agents { display: flex; flex-wrap: wrap; gap: 4px; }
  .rv-agents button { display: grid; place-items: center; padding: 3px; border: 1px solid var(--line); border-radius: 0; background: var(--bg-deep); color: var(--text); cursor: pointer; } .rv-agents button[aria-pressed="true"] { border-color: var(--green); } .rv-agents button:focus-visible { outline: 1px solid var(--green); }
  .rv-pane-b { display: grid; gap: 12px; align-content: start; padding: 14px; }
  .rv-block { display: grid; gap: 6px; min-width: 0; } .rv-bh { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  .rv-pct, .rv-diffnote { font-size: 11.5px; color: var(--dim); } .rv-diffnote.warn { color: var(--amber); }
  .rv .rv-logtabs { gap: 12px; font-size: 12.5px; }
  .rv-checks { border: 1px solid var(--line); background: var(--bg-deep); font-size: 13px; }
  .rv-check { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 5px 10px; border-bottom: 1px solid var(--line); font-size: 13px; } .rv-check:last-child { border-bottom: 0; }
  .rv-check .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .rv-check.dim .t { color: var(--dim); } .rv-check .w { color: var(--dim); font-size: 11.5px; white-space: nowrap; }
  .rv-progress { height: 2px; background: var(--line); } .rv-progress i { display: block; width: 0; height: 2px; background: var(--green); transition: width 1s linear; }
  .rv-claimbar { display: flex; flex-wrap: wrap; gap: 8px; } .rv-claimbar:empty { display: none; }
  .rv-code { min-height: 120px; max-height: 420px; overflow: auto; border: 1px solid var(--line); background: var(--bg-deep); font: 12px/1.7 var(--font-mono); }
  .rv-l { display: grid; grid-template-columns: 30px minmax(0, 1fr); } .rv-l .n { padding-right: 8px; text-align: right; color: var(--dim); opacity: .7; user-select: none; } .rv-l .t { padding-right: 10px; white-space: pre; color: var(--muted); }
  .rv-code:not(.log) .rv-l .t { color: var(--text); }
  .rv-l.add { background: color-mix(in srgb, var(--green) 14%, transparent); } .rv-l.del { background: color-mix(in srgb, var(--red) 14%, transparent); }
  .rv-l.err .t { color: var(--red); } .rv-l.agent .t { color: var(--amber); } .rv-l.none .t { color: var(--dim); white-space: normal; }
  .rv-evid { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; font-size: 12px; color: var(--dim); } .rv-evid:empty { display: none; } .rv-evid a { color: var(--muted); } .rv-evid a:hover { color: var(--green); } .rv-evid > span { display: inline-flex; align-items: center; gap: 6px; }
  .rv-foot { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--dim); }
  .rv-decide { display: flex; flex-wrap: wrap; }
  .rv-checklist { flex: 1 1 380px; display: grid; gap: 8px; align-content: start; padding: 16px; border-right: 1px solid var(--line); }
  .rv-cl { display: flex; gap: 10px; align-items: baseline; font-size: 13.5px; } .rv-cl .op-mark { flex: none; width: 14px; } .rv-cl.dim { color: var(--dim); }
  .rv-verdict { flex: 1 1 420px; display: grid; gap: 12px; align-content: start; padding: 16px; }
  .rv-verdict textarea { min-height: 40px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 0; background: var(--bg-deep); color: var(--text); font: 13px var(--font-mono); resize: vertical; }
  .rv-draft { justify-self: start; display: inline-flex; align-items: center; gap: 6px; padding: 0; border: 0; background: none; color: var(--green); font: inherit; font-size: 12.5px; cursor: pointer; } .rv-draft:hover { color: var(--text); }
  .rv-btns { display: flex; flex-wrap: wrap; gap: 8px; } .rv .rv-btns .op-btn { padding: 7px 14px; font-size: 13.5px; }
  .rv-err { margin: 0; color: var(--red); font-size: 12.5px; } .rv-err:empty { display: none; }
  .rv-confirm { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 12px; border: 1px dashed var(--green); font-size: 13px; } .rv-confirm[hidden] { display: none; }
  .rv-confirm.warn { border-color: var(--amber); } .rv-confirm.danger { border-color: var(--red); } .rv-confirm-b { display: flex; gap: 8px; }
  .rv .rv-confirm .op-btn.go { background: var(--green); border-color: var(--green); color: var(--green-ink); } .rv .rv-confirm.warn .op-btn.go { background: var(--amber); border-color: var(--amber); } .rv .rv-confirm.danger .op-btn.go { background: var(--red); border-color: var(--red); }
  @media (max-width: 720px) {
    .rv { padding-top: 0; } .rv-view { gap: 28px; } .rv-work { gap: 16px; }
    .rv-row { grid-template-columns: minmax(0, 1fr) auto auto auto; grid-template-areas: "name archs age act" "sub sub sub sub"; row-gap: 6px; }
    .rv-name { grid-area: name; } .rv-sub { grid-area: sub; } .rv-archs { grid-area: archs; } .rv-age { grid-area: age; } .rv-act { grid-area: act; }
    .rv-sub .t { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .rv .rv-tabs { flex-wrap: wrap; column-gap: 18px; }
    .rv-checklist { border-right: 0; border-bottom: 1px solid var(--line); }
    .rv-wtitle h1 { font-size: 26px; } .rv-wid .op-box.lg { width: 44px; height: 44px; }
  }
`;

const SCRIPT = String.raw`
  var API = "/api/v1/factory", CATEGORIES = ${JSON.stringify(CATEGORIES)}, AGENT_KEY = "op-review-agent";
  // The lists the page is drawn from, null until each answers: REVIEW the review list (its rows, what each viewer may do on them, and where each package stands — state, ready, in_review), APPROVALS the record, BLOCKS the brake's, REGISTRY the factory's registrations (the No maintainer tab; UNMAINTAINED its unmaintained ones, asked for only when the list of all came back full), WORKERS the project's workers (the agents a claim can choose, for a maintainer — read when a claim or the workspace first needs them, never with the queue). DOWN is why the review list did not answer, said once in #rv-note; a list that did not answer draws "—" and its reason, never an empty state.
  var REVIEW = null, APPROVALS = null, BLOCKS = null, REGISTRY = null, UNMAINTAINED = null, WORKERS = null, DOWN = null, BLOCKS_DOWN = null, REGISTRY_DOWN = null, DRAWN = false, SEEN = null, SAID = "";
  // The tab shown: the address's ?tab= (a tab is a link another page can give), Ready unless it names one of the four.
  var TABS = ${JSON.stringify(TABS)}, TAB = (function () { var t = new URLSearchParams(location.search || "").get("tab"); return TABS.map(function (x) { return x[0]; }).indexOf(t) >= 0 ? t : TABS[0][0]; })();
  // The workspace: the package open (the address's ?package=), its story (GET .../story: the registration, the request as checked, a chain per build), the text evidence read once per file, the architecture whose log is shown, the decision waiting for its confirmation, the running rebuild's worker log (read with the story, a maintainer's). FRESH is a query of its own for the one read of the story after this viewer changed it — the edge keeps the story thirty seconds — and is spent by that read: the polls after it share the edge's copy again.
  var OPEN = null, STORY = null, STORY_DOWN = null, FRESH = "", TEXT = {}, LOGARCH = null, CONFIRM = null, WLOG = null;

  function workHref(name) { return "/review?package=" + encodeURIComponent(name); }
  function openedName() { var q = new URLSearchParams(location.search || ""); return q.get("package") || null; }
  // How long ago, the way the queue says it: "now" under five seconds, then "10s", "3m", "2h", "5d".
  function since(iso) { if (!iso) return ""; var s = (Date.now() - Date.parse(iso)) / 1000; return s < 5 ? "now" : ago(iso).replace(" ago", ""); }
  function at(login) { return login ? '<a href="' + userHref(login) + '"' + whoAttr(login) + '>@' + esc(login) + '</a>' : '<span class="muted">—</span>'; }
  function av(login, cls) { return '<span class="rv-av' + (cls ? " " + cls : "") + '" aria-hidden="true">' + esc(String(login || "?").slice(0, 1)) + '</span>'; }
  function mark(m, cls, title) { return '<i class="op-mark ' + cls + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + m + '</i>'; }
  var MARK = { ok: "✓", run: "⟳", fail: "✗", wait: "○", na: "—" };
  // A rebuild that built: staged for the review, or done — published under the approval that decided it.
  function built(b) { return !!b && (b.status === "staged" || b.status === "done"); }

  // ---- an agent as the workers report it ("<provider>/<model>"): its mark from the kit, its name as a person reads it.
  var MARKS = [[/^(anthropic|claude)/, "claude-color"], [/^(openai|codex|gpt)/, "openai"], [/^(gemini|google)/, "gemini-color"], [/^(xai|grok)/, "grok"], [/^cursor/, "cursor"], [/^(github|copilot)/, "githubcopilot"], [/^opencode/, "opencode"], [/^qwen/, "qwen-color"], [/^(kimi|moonshot)/, "kimi"], [/^(meta|llama)/, "meta-color"]];
  function markOf(a) { var parts = String(a || "").toLowerCase().split("/"); for (var i = 0; i < MARKS.length; i++) if (MARKS[i][0].test(parts[0]) || MARKS[i][0].test(parts[parts.length - 1])) return MARKS[i][1]; return null; }
  function agentName(a) { if (!a) return ""; return String(a).split("/").pop().split(/[-_]/).map(function (w) { return /^gpt$/i.test(w) ? "GPT" : w.charAt(0).toUpperCase() + w.slice(1); }).join(" ").replace(/^GPT /, "GPT-"); }
  function agentIcon(a, size) { var m = markOf(a); return m ? agentMark(m, agentName(a) + " · " + a, size || 16) : '<span class="rv-av" title="' + esc(a || "no agent") + '">' + esc(agentName(a).slice(0, 1) || "?") + '</span>'; }

  // ---- the queue: one entry per package, as the list files it — the rows it is made of, the one that speaks for it (lead), the claim on it.
  function pkgs() {
    if (!REVIEW) return [];
    var byId = {}; (REVIEW.staged || []).forEach(function (t) { byId[t.id] = t; });
    return (REVIEW.packages || []).map(function (p) {
      var rows = (p.rows || []).map(function (id) { return byId[id]; }).filter(Boolean);
      return { name: p.name, owner: p.owner, version: p.version, targets: p.targets || {}, state: p.state, claim: p.claim, rows: rows, lead: byId[p.lead] || rows[0] || null };
    });
  }
  // The tab a package is filed under: the server's word (state), never a rule of the page's — a package neither ready nor claimed (an architecture still building) is in no tab; a build of a version already approved is Ready's to drop.
  function tabOf(p) { return p.state === "in_review" ? "review" : p.state === "ready" ? "ready" : p.rows.some(function (t) { return t.already; }) ? "ready" : null; }
  function archSquares(targets) {
    return '<span class="rv-archs">' + ARCHES.filter(function (a) { return targets && targets[a]; }).map(function (a) {
      var st = targets[a].status, tone = st === "not_supported" ? "na" : st === "building" || st === "reviewing" ? "run" : st === "waiting" ? "wait" : "ok";
      return '<i class="op-arch ' + tone + '" title="' + esc(a + ": " + String(st).replace("_", " ")) + '"></i>';
    }).join("") + '</span>';
  }
  function notSupported(targets) { return ARCHES.filter(function (a) { return targets && targets[a] && targets[a].status === "not_supported"; }); }
  function row(name, href, ver, sub, archs, age, act, fresh) {
    return '<div class="rv-row' + (fresh ? " op-fresh" : "") + '"><span class="rv-name">' + (href ? '<a href="' + esc(href) + '" title="' + esc(name) + '"><b>' + esc(name) + '</b></a>' : '<b title="' + esc(name) + '">' + esc(name) + '</b>') + (ver ? '<span class="v" title="' + esc(ver) + '">' + esc(ver) + '</span>' : '') + '</span><span class="rv-sub">' + sub + '</span>' + (archs || '<span class="rv-archs"></span>') + '<span class="rv-age">' + esc(age || "") + '</span><span class="rv-act">' + act + '</span></div>';
  }
  // A row's one button: live where the viewer may, grey with the server's reason where not (gate); the label is the design's for each case, and its name says which package it acts on (a list of rows of "Claim" names nothing).
  function btn(label, attrs, ok, why, cls, named) { return gate('<button type="button" class="op-btn sm' + (cls ? " " + cls : "") + '"' + (attrs || "") + (named ? ' aria-label="' + esc(named) + '"' : '') + '>' + esc(label) + '</button>', ok, why || "not now"); }
  function readyRow(p, fresh) {
    var t = p.lead || {}, own = isOwner(p.owner), ns = notSupported(p.targets), pb = t.project_build, c = t.can || { why: {} };
    var sub = av(p.owner) + '<span class="t">' + at(p.owner) + (ns.length ? ' · ' + esc(ns.join(" · ")) + ' not supported' : '') + (pb && pb.status === "failed" ? ' · the rebuild failed' : '') + (t.already ? ' · a version already approved' : '') + '</span>';
    var act;
    if (t.already) act = '<span class="decide" data-task="' + t.id + '" data-label="' + esc(p.name + " " + (t.version || "") + " (build #" + t.id + ")") + '" data-arch="' + esc(t.arch) + '">' + gate('<button type="button" class="op-btn sm" data-reject="' + t.id + '" data-note="a build of a version already approved (#' + t.already.task + ')" aria-label="Drop ' + esc(p.name) + ' ' + esc(t.version || "") + '">Drop</button>', !!c.reject, c.why.reject || "not now") + '</span>';
    else if (own) act = btn("yours · locked", "", false, c.why.build || ("you brought " + p.name + " — another maintainer reviews it"));
    else if (isMaintainer()) act = btn("Claim", ' data-claim="' + t.id + '" data-name="' + esc(p.name) + '" data-arch="' + esc(t.arch) + '"', !!c.build, c.why.build, "primary", "Claim " + p.name);
    else act = btn("maintainers claim", "", false, orSignIn("a maintainer claims it"));
    return row(p.name, pkgHref(p.name, "lab", t.arch), p.version, sub, archSquares(p.targets), since(t.finished_at), act, fresh);
  }
  function reviewRow(p, fresh) {
    var cl = p.claim || {}, t = p.lead || {}, mine = isMaintainer() && isOwner(cl.by);
    var sub = av(cl.by) + '<span class="t">claimed by ' + at(cl.by) + ' · asked by ' + at(p.owner) + '</span>';
    var act = isMaintainer() ? '<a class="op-btn sm' + (mine ? " primary" : "") + '" href="' + esc(workHref(p.name)) + '" aria-label="Open ' + esc(p.name) + '">Open</a>' : btn("in progress", "", false, orSignIn("a maintainer is rebuilding it"));
    return row(p.name, pkgHref(p.name, "lab", t.arch), p.version, sub, archSquares(p.targets), since(cl.at), act, fresh);
  }
  // Lift, on every blocked row: another maintainer's than the one who blocked.
  function liftBtn(kind, what, b) {
    var label = !isMaintainer() ? "on the record" : isOwner(b.blocked_by) ? "another maintainer lifts it" : "Lift block";
    return btn(label, ' data-unblock="' + kind + '" data-what="' + esc(what) + '"', isMaintainer() && !isOwner(b.blocked_by), isMaintainer() ? "another maintainer lifts it" : orSignIn("a maintainer lifts it"), "", "Lift the block on " + what);
  }
  // A block's line: who and why — the whole reason on hover, and on two lines where the row is narrow (the reason is what the record and the contributor read).
  function blockSub(b) { return av(b.blocked_by) + '<span class="t" title="' + esc("@" + (b.blocked_by || "") + " · " + (b.blocked_reason || "")) + '">' + at(b.blocked_by) + ' · ' + esc(b.blocked_reason || "") + '</span>'; }
  function blockedRows() {
    if (!BLOCKS) return null;
    return (BLOCKS.packages || []).map(function (b) { return row(b.name, pkgHref(b.name, null, null), "", blockSub(b), "", since(b.blocked_at), liftBtn("packages", b.name, b)); })
      .concat((BLOCKS.contributors || []).map(function (b) { return row("@" + b.login, userHref(b.login), "contributor", blockSub(b), "", since(b.blocked_at), liftBtn("contributors", b.login, b)); }));
  }
  // No maintainer: a package its owner left unmaintained — no build of its bump for thirty days — for a maintainer to adopt. From the registry's list, or — when that list came back full, and an older registration could be missing from it — from the read of the unmaintained ones. Adopt is the one door (routes/adopt.ts), the package page's too: on a package a ring serves it makes the adopter its maintainer in the pool and gives them the registration; where it is refused (a package in no ring, a build of it still open), the toast says the server's reason — the page guesses no ring.
  function unmaintained() { var list = UNMAINTAINED || REGISTRY; return list ? (list.packages || []).filter(function (p) { return p.status === "unmaintained" && !p.blocked_at; }) : null; }
  function unmaintainedRows() {
    var list = unmaintained(); if (!list) return null;
    return list.map(function (p) {
      var label = !isMaintainer() ? "maintainers adopt" : isOwner(p.owner) ? "yours · build it" : "Adopt";
      return row(p.name, pkgHref(p.name, null, null), p.release, av(p.owner) + '<span class="t">left by ' + at(p.owner) + (p.detail ? ' · ' + esc(p.detail) : '') + '</span>', archSquares(p.targets), since(p.updated_at), btn(label, ' data-adopt="' + esc(p.name) + '"', isMaintainer() && !isOwner(p.owner), isMaintainer() ? "it is yours: build it to take it up again" : orSignIn("a maintainer adopts it"), "primary", "Adopt " + p.name));
    });
  }

  // ---- the four tiles: the list's own numbers (ready, in_review), the week's approvals on the record, the packages blocked — and the contributors blocked beside them, which the Blocked tab lists too. A list that did not answer: "—" and "did not answer", the reason on hover.
  function renderTiles() {
    var el = $("#rv-tiles"); if (!el) return;
    var cell = function (k, n, s, down) { return '<div class="op-stat"><span class="k">' + k + '</span><b class="n" data-n="' + (n === null ? "" : n) + '">' + (n === null ? "—" : num(n)) + '</b><span class="s">' + (down ? '<span title="' + esc(down) + '">did not answer</span>' : s) + '</span></div>'; };
    var mine = pkgs().filter(function (p) { return p.state === "in_review" && p.claim && isOwner(p.claim.by); }).length;
    var week = APPROVALS ? APPROVALS.filter(function (a) { return a.standing && Date.now() - Date.parse(a.created_at) < 7 * 86400e3; }).length : null;
    var people = BLOCKS ? (BLOCKS.contributors || []).length : 0;
    el.innerHTML = [
      cell("Ready for review", REVIEW ? REVIEW.ready : null, "waiting for a claim", !REVIEW && DOWN),
      cell("In review", REVIEW ? REVIEW.in_review : null, isMaintainer() ? num(mine) + " claimed by you" : "claimed by maintainers", !REVIEW && DOWN),
      cell("Approved", week, "this week", !APPROVALS && DOWN),
      cell("Blocked", BLOCKS ? (BLOCKS.packages || []).length : null, "back in the factory" + (people ? " · and " + num(people) + " contributor" + (people === 1 ? "" : "s") : ""), !BLOCKS && BLOCKS_DOWN),
    ].join("");
    // The numbers count up the first time they land (countUp: 1.1 s, or at once for a reader who asked for less motion).
    if (!renderTiles.done && REVIEW) { renderTiles.done = true; (el.querySelectorAll(".n[data-n]") || []).forEach(function (n) { var v = n.getAttribute("data-n"); if (v !== "") countUp(n, Number(v)); }); }
  }

  // ---- the tabs and the rows of the one chosen. The rows are drawn again with every answer; the control a keyboard was on is found again by what it acts on and keeps the focus. What a screen reader hears is one short line (#rv-said) when the tab or its count changes, never the rows read out again.
  function focusKey(el) {
    if (!el || !el.getAttribute) return null;
    var k = ["data-claim", "data-adopt", "data-reject", "data-what"].filter(function (a) { return el.hasAttribute(a); })[0];
    return k ? "[" + k + '="' + el.getAttribute(k) + '"]' : el.getAttribute("href") ? 'a[href="' + el.getAttribute("href") + '"]' : null;
  }
  function renderQueue() {
    renderTiles();
    var all = pkgs(), ready = all.filter(function (p) { return tabOf(p) === "ready"; }), review = all.filter(function (p) { return tabOf(p) === "review"; });
    var blocked = blockedRows(), unm = unmaintained();
    var counts = { ready: REVIEW ? ready.length : null, review: REVIEW ? review.length : null, blocked: blocked ? blocked.length : null, unmaintained: unm ? unm.length : null };
    Object.keys(counts).forEach(function (k) { var n = $("#rv-n-" + k); if (n) n.textContent = counts[k] === null ? "" : num(counts[k]); });
    document.querySelectorAll("#rv-tabs [data-tab]").forEach(function (b) { var on = b.getAttribute("data-tab") === TAB; b.setAttribute("aria-selected", String(on)); b.setAttribute("tabindex", on ? "0" : "-1"); });
    var list = $("#rv-list"); if (list) list.setAttribute("data-tab", TAB);
    renderWho();
    // A row that was not there on the last draw is lit and fades (the kit's op-fresh); the first draw lights nothing.
    var seen = {}, fresh = function (key) { seen[key] = true; return !!SEEN && !SEEN[key]; };
    var rows, down = null;
    if (TAB === "ready") { rows = REVIEW ? ready.map(function (p) { return readyRow(p, fresh("r:" + p.name)); }) : null; down = DOWN; }
    else if (TAB === "review") { rows = REVIEW ? review.map(function (p) { return reviewRow(p, fresh("v:" + p.name)); }) : null; down = DOWN; }
    else if (TAB === "blocked") { rows = blocked; down = BLOCKS_DOWN; }
    else { rows = unmaintainedRows(); down = REGISTRY_DOWN; }
    var el = $("#rv-rows");
    if (el) {
      var had = el.contains && document.activeElement && el.contains(document.activeElement) ? focusKey(document.activeElement) : null;
      el.innerHTML = rows ? (rows.join("") || '<p class="rv-empty">Nothing here right now.</p>') : '<p class="rv-empty">' + (down ? esc(down) : "Loading") + '</p>';
      el.setAttribute("aria-labelledby", "rv-tab-" + TAB);
      var again = had && el.querySelector ? el.querySelector(had) : null; if (again && again.focus) again.focus();
    }
    var said = $("#rv-said"), label = TABS.filter(function (x) { return x[0] === TAB; })[0][1], line = counts[TAB] === null ? "" : label + ": " + num(counts[TAB]);
    if (said && line !== SAID) { SAID = line; said.textContent = line; }
    if (REVIEW) SEEN = Object.assign(SEEN || {}, seen);
    renderMaintainers();
  }
  function renderWho() {
    var el = $("#rv-who"); if (!el) return;
    var a = chosenAgent();
    el.innerHTML = isMaintainer() ? 'you · ' + at(WHO.login) + (a ? ' with ' + esc(agentName(a)) : '') : 'read-only · maintainers claim and review';
  }

  // ---- the maintainers: the one list the pool keeps (the shell's maintainerSet), each with what they are reviewing now, their decisions on the record the page reads, the packages they brought, and the agent of their claim (the slot empty when they have none).
  function renderMaintainers() {
    maintainerSet(function (set) {
      var logins = Object.keys(set || {}).sort(), el = $("#rv-maints"); if (!el) return;
      var n = $("#rv-maint-n"); if (n) n.textContent = num(logins.length) + " active";
      var claims = pkgs().filter(function (p) { return p.state === "in_review" && p.claim; });
      el.innerHTML = logins.map(function (l) {
        var cur = claims.filter(function (p) { return p.claim.by === l; })[0], reviews = (APPROVALS || []).filter(function (a) { return a.by === l; }).length, brought = REGISTRY ? (REGISTRY.packages || []).filter(function (p) { return p.owner === l; }).length : 0;
        var agent = cur && cur.claim.agent;
        return '<div class="rv-mrow">' + av(l, "lg") + '<div class="rv-mwho"><span>' + at(l) + (isOwner(l) ? '<span class="you">you</span>' : '') + '</span><span class="s" title="decisions in the record\'s newest hundred; packages they brought">' + (cur ? ['reviewing ' + esc(cur.name)] : []).concat([num(reviews) + ' review' + (reviews === 1 ? '' : 's'), num(brought) + ' package' + (brought === 1 ? '' : 's')]).map(function (x, i, all) { return '<span>' + x + (i < all.length - 1 ? ' ·' : '') + '</span>'; }).join(" ") + '</span></div>' + (agent ? '<span class="rv-mag" title="' + esc(agent) + '">' + agentIcon(agent, 16) + '</span>' : '<span class="rv-mag none"></span>') + '</div>';
      }).join("") || '<p class="rv-empty">No maintainer listed yet.</p>';
    });
  }

  // ---- the agents a claim may choose: the project's workers that build, alive, current, whose agent answered — one choice per agent, the viewer's last choice kept in this browser. The workers are read once, for a maintainer, when a claim or the workspace first needs them (the listing reads the queue's counts too: not a read for every view of the queue).
  var WORKERS_READ = null;
  function needWorkers() {
    if (!isMaintainer()) return Promise.resolve([]);
    WORKERS_READ = WORKERS_READ || api("GET", "/api/v1/factory?limit=10").then(function (d) { WORKERS = d.workers || []; renderWho(); if (OPEN) renderWork(); return WORKERS; }).catch(function () { WORKERS = []; return WORKERS; });
    return WORKERS_READ;
  }
  function agentWorkers(arch) {
    // A drained worker (#277) is handed nothing until it is resumed: a claim never pins its rebuild to one.
    return (WORKERS || []).filter(function (w) { return w.side === "omarchy" && !w.revoked_at && !w.drained && (!w.kinds || w.kinds.indexOf("build") >= 0) && w.alive && w.agent && w.agent_status === "ok" && !(w.update && w.update.required) && (!arch || w.arch === arch); });
  }
  function agentsFor(arch) { var seen = {}; return agentWorkers(arch).map(function (w) { return w.agent; }).filter(function (a) { if (seen[a]) return false; seen[a] = true; return true; }); }
  function keptAgent() { try { return localStorage.getItem(AGENT_KEY); } catch (e) { return null; } }
  // The agent a claim would choose: the viewer's last choice while a worker serves it, else the first served; before the workers are read, the last choice as kept.
  function chosenAgent(arch) {
    if (WORKERS === null) return keptAgent();
    var list = agentsFor(arch), k = keptAgent();
    return list.indexOf(k) >= 0 ? k : list[0] || null;
  }
  function choose(a) { try { localStorage.setItem(AGENT_KEY, a); } catch (e) { /* a browser that keeps nothing: the choice lasts the page */ } }

  // ---- a claim: the project's rebuild, pinned to a review worker with the chosen agent — an idle one first — for the lead's architecture (the server gives the others a worker with the same agent where one is live); a hint for the agent from the workspace.
  function claim(id, name, arch, hint) {
    return needWorkers().then(function () {
      var a = chosenAgent(arch), ws = agentWorkers(arch).filter(function (x) { return x.agent === a; }), w = ws.filter(function (x) { return !x.current_task; })[0] || ws[0];
      return api("POST", API + "/tasks/" + id + "/build", { worker: w ? w.id : undefined, note: hint || undefined });
    }).then(function (d) {
      if (d.error) { toast(esc(d.error), "error"); return null; }
      toast("Claimed — the project rebuilds " + esc(name) + " from scratch" + (d.agent ? " with " + esc(agentName(d.agent)) : "") + ".");
      FRESH = "?after=" + Date.now(); open(name, true); load();
      return d;
    }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
  }
  // A release: the claim let go, whole, with a reason on the record — every rebuild of it stops, the ones staged too, and the package waits for a claim again.
  function release(id, name, reason) {
    return api("POST", API + "/tasks/" + id + "/release", { reason: reason }).then(function (d) {
      if (d.error) { toast(esc(d.error), "error"); return null; }
      FRESH = "?after=" + Date.now(); load(); if (OPEN) loadWork();
      return d;
    });
  }

  // ---- the workspace: where each architecture stands and the chain behind it — the factory's build, the project's rebuild (while it runs, once it built, and after it shipped), their audit and trial — from the story.
  function round() {
    var s = STORY; if (!s) return [];
    var targets = s.targets || {}, asked = (s.package && s.package.arches) || Object.keys(targets);
    return ARCHES.filter(function (a) { return asked.indexOf(a) >= 0 || targets[a]; }).map(function (a) {
      var t = targets[a] || { status: "waiting", task: null }, chains = s.chains || [];
      var c = chains.filter(function (ch) { return (ch.contributor && ch.contributor.id === t.task) || (ch.project && ch.project.id === t.task); })[0] || chains.filter(function (ch) { return ch.contributor && ch.contributor.arch === a; })[0] || null;
      var p = c && c.project && ["queued", "leased", "staged", "failed", "done"].indexOf(c.project.status) >= 0 ? c.project : null;
      return { arch: a, target: t, asked: asked.indexOf(a) >= 0, factory: c && c.contributor, rebuild: p, audit: c && c.audit, trial: p && c.trial, approval: c && c.approval };
    });
  }
  function workPkg() { return pkgs().filter(function (p) { return p.name === OPEN; })[0] || null; }
  function vetOk(t) { var v = t && t.result && t.result.vet; return v ? v.verdict === "pass" : null; }
  function trialOk(tr) { return tr && tr.status === "done" ? !!(tr.result && tr.result.verdict === "ok") : null; }
  // A build's evidence where the review list holds the build: its row carries the addresses (the server's; a page writes none by hand), the PKGBUILD's and the log's read once each. A build the list does not hold has its evidence on its own page (the shell's evidenceLink).
  function evidenceOf(id) { var t = REVIEW ? (REVIEW.staged || []).filter(function (r) { return r.id === id; })[0] : null; return t ? t.evidence : null; }
  // A build the list no longer holds (decided, or failed): the addresses its own answer lists (GET .../tasks/<id>, public and cached, what its page reads), the public text only.
  var EVID = {}, EVID_FILE = { pkgbuild: "PKGBUILD", log: "build.log" };
  function evidenceUrl(id, which) {
    var ev = evidenceOf(id); if (ev && ev[which]) return Promise.resolve(ev[which]);
    EVID[id] = EVID[id] || api("GET", API + "/tasks/" + id).then(function (d) { return d.evidence || []; }).catch(function () { return []; });
    return EVID[id].then(function (list) { var f = list.filter(function (x) { return x.name === EVID_FILE[which] && x.public; })[0]; return f ? f.url : null; });
  }
  function textOf(id, which) {
    return evidenceUrl(id, which).then(function (url) {
      if (!url) return null;
      TEXT[url] = TEXT[url] || fetch(url).then(function (r) { return r.ok ? r.text() : null; }).catch(function () { return null; });
      return TEXT[url];
    });
  }
  // Where the bytes came from: the worker that held the lease, whose it is, the host it names, who vouched for it — the review list's built_by of the build.
  function builtOn(id) { var t = REVIEW ? (REVIEW.staged || []).filter(function (r) { return r.id === id; })[0] : null, b = t && t.built_by; return b ? '<span title="' + esc((b.owner ? b.owner + "'s " : "") + "worker " + b.worker + (b.where ? " on " + b.where : "") + (b.trusted_by ? " — trusted on the word of " + b.trusted_by : "")) + '">on ' + esc(b.where || b.worker) + '</span>' : ""; }
  function elsewhere(id, text) { return '<div class="rv-l none"><span class="n"></span><span class="t">' + esc(text) + ' ' + evidenceLink({ id: id }, "on its build's page") + '</span></div>'; }
  // Numbered lines, the ones a diff marks lit, a log's errors in red and the agent's turns in amber; the last n of a long log. A PKGBUILD shows its first RECIPE_LINES lines and says where the rest is: a recipe of a hundred thousand lines stalls a tab, and it is the contributor's text.
  var RECIPE_LINES = 1000;
  function numbered(text, marks, n) {
    var all = String(text).replace(/\n$/, "").split("\n"), from = n && all.length > n ? all.length - n : 0;
    return all.slice(from).map(function (l, i) {
      var cls = marks ? (marks[from + i] ? " " + marks[from + i] : "") : /error|failed|fatal/i.test(l) ? " err" : /^agent\b/i.test(l) ? " agent" : "";
      return '<div class="rv-l' + cls + '"><span class="n">' + (from + i + 1) + '</span><span class="t">' + esc(l) + '</span></div>';
    }).join("");
  }
  function recipe(text, marks, id) {
    var all = String(text).replace(/\n$/, "").split("\n");
    if (all.length <= RECIPE_LINES) return numbered(text, marks);
    return numbered(all.slice(0, RECIPE_LINES).join("\n"), marks) + elsewhere(id, num(all.length - RECIPE_LINES) + " more lines; the whole file is");
  }
  // A log's well shows its end: the newest lines are the ones a reviewer reads first.
  function tail(el, html) { if (!el) return; el.innerHTML = html; el.scrollTop = el.scrollHeight; }
  function empty(text) { return '<div class="rv-l none"><span class="n"></span><span class="t">' + esc(text) + '</span></div>'; }
  // What two PKGBUILDs share (the longest common run of lines): what is left on either side is the diff — the factory's lines the rebuild dropped, the rebuild's own.
  function diff(a, b) {
    a = a.slice(0, 400); b = b.slice(0, 400);
    var n = a.length, m = b.length, L = [], i, j;
    for (i = 0; i <= n; i++) { L.push(new Array(m + 1).fill(0)); }
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    var left = {}, right = {}; i = 0; j = 0;
    while (i < n && j < m) { if (a[i] === b[j]) { i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) left[i++] = "del"; else right[j++] = "add"; }
    for (; i < n; i++) left[i] = "del"; for (; j < m; j++) right[j] = "add";
    return { left: left, right: right, differ: Object.keys(right).length };
  }
  function diffCount(n) { return num(n) + " line" + (n === 1 ? " differs" : "s differ"); }

  function open(name, push) {
    OPEN = name; CONFIRM = null; LOGARCH = null; STORY = null; STORY_DOWN = null; WLOG = null;
    if (push && typeof history !== "undefined" && history.pushState) history.pushState({ package: name }, "", workHref(name));
    var q = $("#rv-queue"), w = $("#rv-work"); if (q) q.hidden = true; if (w) w.hidden = false;
    document.title = name + " · Review · omarchy-pool";
    var n = $("#rv-note-in"); if (n) n.value = "";
    if (typeof scrollTo === "function") scrollTo(0, 0);
    renderWork(); loadWork(); needWorkers();
  }
  function back(push) {
    OPEN = null; CONFIRM = null;
    if (push && typeof history !== "undefined" && history.pushState) history.pushState({}, "", "/review");
    var q = $("#rv-queue"), w = $("#rv-work"); if (q) q.hidden = false; if (w) w.hidden = true;
    document.title = "Review · omarchy-pool";
    renderQueue();
  }
  // The story, and — for a maintainer, while the project's rebuild runs — its worker's own log: both once per minute, the log with the story it belongs to, never with every draw.
  function loadWork() {
    var name = OPEN; if (!name) return;
    var q = FRESH; FRESH = "";
    api("GET", API + "/packages/" + encodeURIComponent(name) + "/story" + q).then(function (d) {
      if (OPEN !== name) return;
      if (d.error) { STORY = null; STORY_DOWN = d.error; } else { STORY = d; STORY_DOWN = null; }
      renderWork();
      var b = round().map(function (r) { return r.rebuild; }).filter(function (x) { return x && x.status === "leased" && x.lease_owner; })[0];
      if (!b || !isMaintainer()) { WLOG = null; return; }
      api("GET", API + "/workers/" + encodeURIComponent(b.lease_owner) + "/log").then(function (l) { if (OPEN !== name) return; WLOG = { id: b.id, worker: b.lease_owner, log: l && l.log ? l.log : "" }; renderWork(); }).catch(function () { WLOG = { id: b.id, worker: b.lease_owner, log: "" }; });
    }).catch(function (e) { STORY_DOWN = noAnswer("package's story", e); renderWork(); });
  }

  // Each draw of the workspace has a number: an answer that lands after a later draw (a log, a PKGBUILD) is that draw's no more, and writes nothing.
  var GEN = 0;
  function current(gen) { return gen === GEN; }
  function renderWork() {
    if (!OPEN) return;
    GEN++;
    var s = STORY, reg = s && s.package, R = round(), p = workPkg(), lead = p && p.lead, cl = p && p.claim, name = OPEN;
    $("#rv-w-crumb").textContent = name; $("#rv-w-name").textContent = name;
    $("#rv-w-ver").textContent = (p && p.version) || (s && s.request && s.request.version) || "";
    // A story that did not answer — a name the factory never saw, or no answer at all — is one line under the head, with the way to the package's own page; nothing of the workspace is drawn around it.
    var err = $("#rv-w-err"), side = $("#rv-work .rv-side"), dec = $("#rv-decide"), gone = !s && !!STORY_DOWN;
    if (err) { err.hidden = !gone; err.innerHTML = gone ? esc(STORY_DOWN) + ' — <a href="' + esc(pkgHref(name, null, null)) + '">its package page</a>' : ""; }
    if (side) side.hidden = gone; if (dec) dec.hidden = gone;
    if (!s) {
      $("#rv-w-fields").innerHTML = ""; $("#rv-w-chips").innerHTML = ""; $("#rv-w-claim").innerHTML = ""; $("#rv-w-release").innerHTML = ""; $("#rv-w-state").innerHTML = "";
      if (!gone) ["#rv-f-req", "#rv-f-pkgbuild", "#rv-f-log", "#rv-steps", "#rv-y-pkgbuild", "#rv-y-log"].forEach(function (sel) { var el = $(sel); if (el) el.innerHTML = empty("Loading"); });
      renderDecide(R, p);
      return;
    }
    // The claim, and what the viewer may do with it: Release while there is one, grey with the server's reason where the viewer may not.
    var mine = !!cl && isOwner(cl.by), running = cl && (cl.status === "queued" || cl.status === "leased");
    $("#rv-w-claim").innerHTML = cl ? '<span class="rv-claimed' + (mine ? "" : " other") + '">' + (running ? '<span class="op-live-dot"></span>' : '') + 'claimed by ' + (mine ? "you" : at(cl.by)) + ' · <span id="rv-w-since">' + esc(since(cl.at) === "now" ? "just now" : since(cl.at)) + '</span></span>' : '<span class="rv-claimed none">' + (p && p.state === "ready" ? "not claimed yet" : "not in review") + '</span>';
    var c = (lead && lead.can) || { why: {} };
    $("#rv-w-release").innerHTML = cl ? gate('<button type="button" class="op-btn sm" id="rv-release"' + (lead ? ' data-task="' + lead.id + '"' : '') + '>Release claim</button>', !!c.release, c.why.release || "not now") : "";
    // The state: in review (claimed), ready, or — decided — where the approval that stands is today (the shell's approvalWhere), else the registry's word.
    var a = (APPROVALS || []).filter(function (x) { return x.name === name && x.standing; })[0], state, tone;
    if (p && p.state === "in_review") { state = '<span class="op-pill warn">in review</span>'; tone = "warn"; }
    else if (p && p.state === "ready") { state = '<span class="op-pill ok">ready for review</span>'; tone = "ok"; }
    else if (a) { var w = approvalWhere(a); tone = { ok: "ok", error: "fail", blue: "run" }[w.cls] || "wait"; state = '<span class="op-pill ' + tone + '" title="' + esc(w.title || "") + '">' + esc(w.word) + '</span>'; }
    else { state = '<span class="op-pill wait">' + esc(reg ? String(reg.status || "").replace("_", " ") : "not a factory package") + '</span>'; tone = "wait"; }
    $("#rv-w-state").innerHTML = state;
    var box = $("#rv-w-box"); if (box) box.className = "op-box lg " + tone;
    // Who asked, and where each architecture stands: one name, one package.
    var owner = (reg && reg.owner) || (p && p.owner);
    $("#rv-w-chips").innerHTML = (owner ? '<span class="op-chip by">' + av(owner, "sm") + 'requested by ' + at(owner) + '</span>' : '') + R.map(function (r) {
      var st = r.target.status, tone = st === "not_supported" ? "na" : st === "building" || st === "reviewing" ? "run" : st === "waiting" ? "" : "ok";
      return '<span class="op-chip ' + tone + '" title="' + esc(r.arch + ": " + st.replace("_", " ")) + '">' + esc(r.arch) + (st === "not_supported" ? ' · not supported' : st === "waiting" ? ' · waiting' : '') + '</span>';
    }).join("");
    // The request's facts, and the category a maintainer settles here: a term (its icon, its name) and its value, one pair to each group.
    var src = reg && (reg.project || reg.url), host = src ? String(src).replace(/^https?:\/\//, "").replace(/\/$/, "") : "";
    var cat = gate('<select data-category="' + esc(name) + '" aria-label="category">' + (reg && reg.category ? '' : '<option value="" selected>category…</option>') + CATEGORIES.map(function (x) { return '<option' + (reg && x === reg.category ? ' selected' : '') + '>' + x + '</option>'; }).join("") + '</select>', isMaintainer() && !!reg, isMaintainer() ? "not a factory package" : orSignIn("a maintainer sets the category"));
    var field = function (icon, k, v) { return '<div class="rv-field"><dt>' + lucide(icon, 15) + '<span>' + k + '</span></dt><dd>' + v + '</dd></div>'; };
    $("#rv-w-fields").innerHTML = field(/github\.com/.test(host) ? "github" : "globe", "source", src && runHref(src) ? '<a href="' + esc(src) + '" rel="nofollow">' + esc(host) + '</a>' : esc(host || "—"))
      + field("scale", "licence", esc((reg && reg.license) || "—")) + field("tag", "release", esc((s.request && s.request.version) || (p && p.version) || "—"))
      + field("cpu", "asked for", esc(((reg && reg.arches) || []).join(" · ") || "—")) + field("layers", "category", cat);
    renderFactory(R, lead); renderRebuild(R, p); renderDecide(R, p);
  }

  // ---- left: the factory's build, as the reference — the request as checked, its recipe, its log per architecture, its evidence.
  function renderFactory(R, lead) {
    var s = STORY, req = s.request, reg = s.package;
    $("#rv-f-agent").innerHTML = lead && lead.kind === "contributor" && lead.agent ? agentIcon(lead.agent, 16) + esc(agentName(lead.agent)) : "";
    $("#rv-f-req").innerHTML = (reg ? '<div class="rv-check">' + mark("✓", "ok") + '<span class="t">The name ' + esc(reg.name) + ', reserved for @' + esc(reg.owner) + '</span><span class="w"></span></div>' : '') + (req ? (req.checks || []).map(function (x) {
      return '<div class="rv-check' + (x.ok ? "" : " dim") + '">' + mark(x.ok ? "✓" : "✗", x.ok ? "ok" : "fail") + '<span class="t" title="' + esc(x.note || "") + '">' + esc(x.item) + (x.note ? ' <span class="dim">· ' + esc(x.note) + '</span>' : '') + '</span><span class="w"></span></div>';
    }).join("") : empty("no request on the record"));
    var f = R.filter(function (r) { return r.factory && r.factory.status === "staged"; })[0] || R.filter(function (r) { return r.factory; })[0];
    if (!LOGARCH || !R.some(function (r) { return r.arch === LOGARCH; })) LOGARCH = f ? f.arch : R.length ? R[0].arch : null;
    // The log's architecture: a switch, pressed on the one shown.
    $("#rv-f-tabs").innerHTML = R.map(function (r) { var on = r.arch === LOGARCH; return '<button type="button" data-logarch="' + esc(r.arch) + '" aria-pressed="' + on + '"' + (on ? ' class="on"' : '') + ' aria-label="' + esc(r.arch + " build log") + '">' + esc(r.arch) + '</button>'; }).join("");
    var mine = R.filter(function (r) { return r.arch === LOGARCH; })[0];
    // The two PKGBUILDs side by side: read once each, then diffed.
    var y = f && R.filter(function (r) { return r.arch === f.arch && built(r.rebuild); })[0];
    var gen = GEN;
    Promise.all([f ? textOf(f.factory.id, "pkgbuild") : Promise.resolve(null), y ? textOf(y.rebuild.id, "pkgbuild") : Promise.resolve(null)]).then(function (t) {
      if (!current(gen)) return;
      var d = t[0] !== null && t[1] !== null ? diff(t[0].replace(/\n$/, "").split("\n"), t[1].replace(/\n$/, "").split("\n")) : null;
      $("#rv-f-pkgbuild").innerHTML = t[0] !== null ? recipe(t[0], d ? d.left : {}, f.factory.id) : f ? elsewhere(f.factory.id, "Its PKGBUILD is") : empty("nothing built yet");
      $("#rv-y-pkgbuild").innerHTML = t[1] !== null ? recipe(t[1], d ? d.right : {}, y.rebuild.id) : y ? elsewhere(y.rebuild.id, "Its PKGBUILD is") : empty("Written from the request's facts by the claim's agent; the factory's recipe is only read.");
      var note = $("#rv-diffnote"); if (note) { note.textContent = d ? (d.differ ? diffCount(d.differ) + " from the factory's" : "the same as the factory's") : R.some(function (r) { return r.rebuild && r.rebuild.status === "leased"; }) ? "being written…" : R.some(function (r) { return r.rebuild && r.rebuild.status === "queued"; }) ? R.map(function (r) { return waitsForNative(r.rebuild); }).filter(Boolean)[0] || "waiting for a review worker" : ""; note.className = "rv-diffnote" + (d && d.differ ? " warn" : ""); }
      DIFFED = d;
      renderSteps(R);
    });
    if (mine && mine.factory) textOf(mine.factory.id, "log").then(function (t) { if (current(gen)) tail($("#rv-f-log"), t !== null ? numbered(t, null, 40) : elsewhere(mine.factory.id, mine.factory.error ? mine.factory.error + " — the log is" : "Its log is")); });
    else $("#rv-f-log").innerHTML = empty(mine ? LOGARCH + ": " + String(mine.target.status).replace("_", " ") : "nothing built yet");
    // The evidence under the log, each verdict named: the gate's, the audit's, then the build and where it ran.
    var fev = mine && mine.factory ? evidenceOf(mine.factory.id) || {} : null;
    $("#rv-f-evid").innerHTML = fev ? '<span>gate ' + gatePill(vetOf(mine.factory), fev.tests) + '</span> <span>audit ' + auditPill(auditOf(mine.audit), mine.audit ? fev.audit : "") + '</span> <a href="/build/' + mine.factory.id + '">build #' + mine.factory.id + '</a> ' + builtOn(mine.factory.id) : '';
  }
  var DIFFED = null;
  function vetOf(t) { return (t && t.result && t.result.vet) || null; }
  function auditOf(a) { if (!a) return null; var r = a.result || {}; return a.status === "done" ? { status: "done", verdict: r.verdict, summary: r.summary, findings: (r.findings || []).length } : { status: a.status, error: a.error }; }

  // ---- right: the rebuild — its steps (the request checked again, the recipe drafted from scratch, a build per architecture, a real pacman installing it, the comparison), its log, the claim to start it.
  function renderSteps(R) {
    var rb = R.filter(function (r) { return r.rebuild; }), done = rb.filter(function (r) { return built(r.rebuild); }), req = STORY && STORY.request;
    var S = function (t, m, when, title) { return { t: t, m: m, when: when || "", title: title || "" }; };
    var steps = [S("Re-check the request", req ? (req.complete ? "ok" : "fail") : "wait", "", req && !req.complete ? "the request is not complete as the form asks today" : "")];
    steps.push(S("Derive the recipe from scratch", rb.some(function (r) { return r.rebuild.status === "leased"; }) ? "run" : done.length ? "ok" : rb.length && rb.every(function (r) { return r.rebuild.status === "failed"; }) ? "fail" : "wait", rb.some(function (r) { return r.rebuild.status === "leased"; }) ? "now" : rb.length ? "" : "after a claim"));
    ARCHES.forEach(function (a) {
      var r = R.filter(function (x) { return x.arch === a; })[0], b = r && r.rebuild;
      if (!r || !r.asked) steps.push(S("Build " + a, "na", "not requested"));
      else if (!b) steps.push(S("Build " + a, r.target.status === "not_supported" ? "na" : "wait", r.target.status === "not_supported" ? "not supported" : ""));
      else if (b.status === "queued") steps.push(waitsForNative(b) ? S("Build " + a, "wait", "native worker", waitsForNative(b) + ": it could not run emulated") : S("Build " + a, "wait", "queued"));
      else if (b.status === "leased") steps.push(S("Build " + a, "run", "now"));
      else if (built(b)) steps.push(S("Build " + a, vetOk(b) === false ? "fail" : "ok", b.duration_ms ? dur(b.duration_ms) : "", vetOk(b) === false ? "the gate did not pass" : ""));
      else steps.push(S("Build " + a, "fail", "failed", b.error || ""));
    });
    var trials = done.map(function (r) { return r.trial; });
    steps.push(S("Install with a real pacman", !done.length ? "wait" : trials.some(function (t) { return trialOk(t) === false || (t && t.status === "failed"); }) ? "fail" : trials.every(function (t) { return trialOk(t); }) ? "ok" : trials.some(function (t) { return t && t.status === "leased"; }) ? "run" : "wait", "", "the trial: pacman -S from the lab, hooks, files"));
    steps.push(S("Compare with the factory", DIFFED ? "ok" : "wait", DIFFED ? diffCount(DIFFED.differ) : ""));
    $("#rv-steps").innerHTML = steps.map(function (x) { return '<div class="rv-check' + (x.m === "wait" || x.m === "na" ? " dim" : "") + '">' + mark(MARK[x.m], x.m, x.title) + '<span class="t">' + esc(x.t) + '</span><span class="w">' + esc(x.when) + '</span></div>'; }).join("");
    var counted = steps.filter(function (x) { return x.m !== "na"; }), ok = counted.filter(function (x) { return x.m === "ok"; }).length, pct = counted.length ? Math.round(ok / counted.length * 100) : 0;
    var p = workPkg(), agent = rebuildAgent(R, p);
    $("#rv-pct").textContent = (agent ? agentName(agent) + " · " : "") + (pct === 100 ? "done" : pct + "%");
    var bar = $("#rv-progress"); if (bar && bar.style) bar.style.width = pct + "%";
    renderChecklist(R, steps);
  }
  // The agent of the rebuild: the one its worker ran when it staged (built_with), the one the claim chose, else the one that built it (the review list's row of the project's build).
  function rebuildAgent(R, p) {
    var b = R.map(function (r) { return r.rebuild; }).filter(function (x) { return x && x.params && (x.params.built_with || x.params.agent); })[0];
    if (b) return b.params.built_with || b.params.agent;
    var cl = p && p.claim; if (cl && cl.agent) return cl.agent;
    var pr = p && p.rows.filter(function (t) { return t.kind === "project" && t.agent; })[0]; return pr ? pr.agent : null;
  }
  function renderRebuild(R, p) {
    var lead = p && p.lead, c = (lead && lead.can) || { why: {} }, cl = p && p.claim, arch = lead ? lead.arch : null;
    // Whose rebuild it is, in the words of whoever reads it: yours on your own claim, the claimant's on another's, the project's otherwise.
    var title = $("#rv-y-title"); if (title) title.textContent = cl && isMaintainer() && isOwner(cl.by) ? "Your rebuild" : cl && cl.by ? "@" + cl.by + "'s rebuild" : "The rebuild";
    // The agents to choose from, for a maintainer: the chosen one lit; choosing another while your claim's rebuild is queued or running rebuilds it with that agent, from scratch.
    var list = isMaintainer() ? agentsFor(arch) : [], cur = cl && cl.agent ? cl.agent : chosenAgent(arch);
    $("#rv-agents").innerHTML = list.map(function (a) { return '<button type="button" data-agent="' + esc(a) + '" aria-pressed="' + (a === cur) + '" title="' + esc(agentName(a) + " · " + a) + '" aria-label="' + esc("rebuild with " + agentName(a)) + '">' + agentIcon(a, 18) + '</button>'; }).join("") || (cur ? '<span class="rv-agent">' + agentIcon(cur, 16) + esc(agentName(cur)) + '</span>' : '');
    // Not claimed yet: the claim, with a hint for the project's agent — the one way a maintainer's word reaches the recipe.
    $("#rv-claimbar").innerHTML = p && p.state === "ready" && lead && lead.kind === "contributor" ? gate('<input id="rv-hint" placeholder="a hint for the project\'s agent (optional)" aria-label="a hint for the project\'s agent"><button type="button" class="op-btn primary" data-claim="' + lead.id + '" data-name="' + esc(p.name) + '" data-arch="' + esc(lead.arch) + '" data-hint="1">Claim and rebuild</button>', !!c.build, c.why.build || "not now") : "";
    // The rebuild's log: the project's build.log once it built; while a worker holds it, the worker's own log (its owner's and the maintainers', read with the story); before, what it waits for.
    var shown = R.filter(function (r) { return r.arch === LOGARCH && r.rebuild; })[0] || R.filter(function (r) { return r.rebuild; })[0], b = shown && shown.rebuild, log = $("#rv-y-log"), gen = GEN;
    if (!b) log.innerHTML = empty(cl ? "queued for a review worker" : "Nothing yet: a maintainer's claim starts the rebuild.");
    else if (built(b) || b.status === "failed") textOf(b.id, "log").then(function (t) { if (current(gen)) tail(log, t !== null ? numbered(t, null, 40) : elsewhere(b.id, b.error ? b.error + " — the log is" : "Its log is")); });
    else if (b.status === "leased" && WLOG && WLOG.id === b.id) tail(log, WLOG.log ? numbered(WLOG.log, null, 40) : empty("building on " + WLOG.worker + "; nothing logged yet"));
    // Sent back by an emulated worker (#281): no review worker of that kind takes it again, so the words are the shell's.
    else log.innerHTML = empty(b.status === "leased" ? "building on " + (b.lease_owner || "a review worker") + (isMaintainer() ? "" : " — its log is here once it built") : waitsForNative(b) ? waitsForNative(b) + ": it could not run emulated" : "queued for a review worker");
    var yev = b ? evidenceOf(b.id) || {} : {};
    $("#rv-y-evid").innerHTML = b ? (built(b) ? '<span>gate ' + gatePill(vetOf(b), yev.tests) + '</span> <span>trial ' + trialPill(shown.trial ? { status: shown.trial.status, verdict: shown.trial.result && shown.trial.result.verdict } : null, shown.trial ? yev.trial : "") + '</span> ' : '') + '<a href="/build/' + b.id + '">build #' + b.id + '</a> ' + builtOn(b.id) : '';
  }

  // ---- below: the checklist, the verdict with the agent's draft, and the three decisions — each confirmed before it is posted. Each line of the checklist is what the pool checks, nothing it cannot.
  function renderChecklist(R, steps) {
    var s = STORY, reg = s && s.package, req = s && s.request, rb = R.filter(function (r) { return r.rebuild; }), done = rb.filter(function (r) { return built(r.rebuild); });
    var asked = R.filter(function (r) { return r.asked && r.target.status !== "not_supported"; });
    var C = function (t, m) { return '<div class="rv-cl' + (m === "wait" ? " dim" : "") + '">' + mark(MARK[m], m) + '<span>' + t + '</span></div>'; };
    var who = WHO.me ? at(WHO.login) : "The reviewer";
    $("#rv-checklist").innerHTML = [
      C(who + " did not request it", !WHO.me ? "wait" : reg && isOwner(reg.owner) ? "fail" : "ok"),
      C("Request re-checked from scratch", req ? (req.complete ? "ok" : "fail") : "wait"),
      C("Rebuilt by the project, not the factory's package", done.length ? "ok" : rb.some(function (r) { return r.rebuild.status === "leased"; }) ? "run" : "wait"),
      C("The project's gate passed", done.length ? (done.every(function (r) { return vetOk(r.rebuild) !== false; }) ? "ok" : "fail") : "wait"),
      C("Rebuilt on every architecture it supports", asked.length && asked.every(function (r) { return built(r.rebuild); }) ? "ok" : asked.some(function (r) { return r.rebuild && r.rebuild.status === "failed"; }) ? "fail" : asked.some(function (r) { return r.rebuild && r.rebuild.status === "leased"; }) ? "run" : "wait"),
      C("Installs with a real pacman", done.length && done.every(function (r) { return trialOk(r.trial); }) ? "ok" : done.some(function (r) { return trialOk(r.trial) === false; }) ? "fail" : "wait"),
    ].join("");
  }
  // The agent's draft of a verdict, once the rebuild is staged: the second agent's summary of the factory's build (its audit), and what the rebuild showed — the gate, the trial, what is not supported. Words to start from; the note is the maintainer's.
  function draftOf(R) {
    var staged = R.filter(function (r) { return r.rebuild && r.rebuild.status === "staged"; }); if (!staged.length) return "";
    var au = R.map(function (r) { return r.audit; }).filter(function (a) { return a && a.status === "done" && a.result && a.result.summary; })[0];
    var ns = R.filter(function (r) { return r.target.status === "not_supported"; }).map(function (r) { return r.arch; });
    var first = au ? String(au.result.summary).replace(/\.?\s*$/, ". ") : "";
    first = first.charAt(0).toUpperCase() + first.slice(1);
    return first + "Rebuilt from scratch on " + staged.map(function (r) { return r.arch; }).join(" and ") + ": the gate " + (staged.every(function (r) { return vetOk(r.rebuild) !== false; }) ? "passed" : "did not pass") + (staged.every(function (r) { return trialOk(r.trial); }) ? ", a real pacman installed it" : "") + (ns.length ? "; " + ns.join(" · ") + " not supported" : "") + ".";
  }
  // A control the page keeps and gates in place, the way gate() draws one: disabled with the reason in its title, or live.
  function setGate(el, ok, why) { if (!el) return; el.disabled = !ok; if (ok) { el.removeAttribute("aria-disabled"); el.removeAttribute("title"); } else { el.setAttribute("aria-disabled", "true"); el.setAttribute("title", why); } }
  function renderDecide(R, p) {
    var rows = p ? p.rows : [], lead = p && p.lead, proj = rows.filter(function (t) { return t.kind === "project" && t.lead; })[0] || rows.filter(function (t) { return t.kind === "project"; })[0] || lead;
    var none = "nothing of " + OPEN + " is in review", ca = (proj && proj.can) || { why: {} }, cl = (lead && lead.can) || { why: {} };
    var draft = draftOf(R), note = $("#rv-note-in"), agent = rebuildAgent(R, p);
    // The verdict is a maintainer's to write: the same field for everyone, grey with the reason for anyone else.
    if (note) { note.placeholder = draft || "The agent drafts a verdict when the rebuild ends"; note.disabled = !isMaintainer(); note.title = isMaintainer() ? "" : orSignIn("a maintainer writes the verdict"); }
    $("#rv-usedraft").innerHTML = draft && note && !note.value && isMaintainer() ? '<button type="button" class="rv-draft" id="rv-draft">' + (agent ? agentIcon(agent, 14) : '') + "Use the agent's draft</button>" : '';
    // The three decisions stay where they are: each one's task and whether the viewer may press it, the server's reason where not — the focus stays on the one a keyboard is on.
    var gates = { approve: [proj, !!ca.approve, ca.why.approve], changes: [lead, !!cl.changes, cl.why.changes], reject: [lead, !!cl.reject, cl.why.reject] };
    document.querySelectorAll("#rv-btns [data-decide]").forEach(function (b) {
      var g = gates[b.getAttribute("data-decide")]; if (!g) return;
      if (g[0]) b.setAttribute("data-task", String(g[0].id)); else b.removeAttribute("data-task");
      setGate(b, g[1] && !!g[0], g[2] || none);
    });
    var box = $("#rv-confirm");
    if (box) {
      var was = !box.hidden;
      box.hidden = !CONFIRM;
      if (CONFIRM) {
        box.className = "rv-confirm" + (CONFIRM.what === "reject" ? " danger" : CONFIRM.what === "changes" ? " warn" : "");
        $("#rv-confirm-t").textContent = confirmText(CONFIRM.what, R, p);
        // The confirmation takes the focus when it opens: Confirm, one Tab from Cancel; Escape closes it. Approve's Confirm asks for the passkey (#271), and says so.
        var go = $("#rv-confirm-go"); if (go) go.innerHTML = CONFIRM.what === "approve" ? lucide("key-round", 14) + "Confirm with your passkey" : "Confirm";
        if (!was && go && go.focus) go.focus();
      }
    }
  }
  // Out of the confirmation, the focus goes back to the decision it confirmed.
  function unconfirm() { var what = CONFIRM && CONFIRM.what; CONFIRM = null; renderDecide(round(), workPkg()); var b = what ? $('#rv-btns [data-decide="' + what + '"]') : null; if (b && b.focus) b.focus(); }
  // What the confirmation says the decision does: approve publishes the rebuild on every architecture it covers; reject frees a request's name (a package already in the pool keeps it); changes go back to the factory with the name kept.
  function confirmText(what, R, p) {
    var name = OPEN, ver = (p && p.version) || "", arches = R.filter(function (r) { return r.rebuild && r.rebuild.status === "staged"; }).map(function (r) { return r.arch; }), ns = notSupported(p ? p.targets : {}), owner = (STORY && STORY.package && STORY.package.owner) || (p && p.owner);
    var inPool = (APPROVALS || []).some(function (a) { return a.name === name && a.standing; }), mine = p && p.claim && isOwner(p.claim.by);
    if (what === "approve") return "Approve " + name + " " + ver + " for " + (arches.join(" + ") || "every architecture rebuilt") + (ns.length ? " (" + ns.join(" · ") + " not supported)" : "") + "? " + (mine ? "Your build enters edge." : "The project's build enters edge.") + " Your passkey confirms it.";
    if (what === "reject") return inPool ? "Reject " + name + " " + ver + "? The version is rejected; " + name + " stays in the pool." : "Reject " + name + "? The name is freed and the requester is told why.";
    return "Send " + name + " back to the factory with your note? The name stays " + (owner ? "@" + owner + "'s" : "the requester's") + ".";
  }
  function decide(what, id) {
    var note = ($("#rv-note-in").value || "").trim(), err = $("#rv-err");
    if (what !== "approve" && note.length < 4) { err.textContent = "Say why in a few words: the requester reads it, and it goes on the record."; return; }
    err.textContent = "";
    // Approve is confirmed with the maintainer's passkey (#271): the answer rides in the body; changes and reject post as they are.
    var body = { note: note || undefined }, send = function (assertion) { if (assertion) body.assertion = assertion; return api("POST", API + "/tasks/" + id + "/" + what, body); };
    (what === "approve" ? passkeyed("approve:" + id, send) : send()).then(function (d) {
      // Refused: said once, beside the buttons (an alert), with the way to add a passkey as a link when the maintainer holds none.
      if (d.error) { err.innerHTML = refusalHtml(d); return; }
      CONFIRM = null; $("#rv-note-in").value = "";
      toast(what === "changes" ? "Sent back to the factory — the requester reads your note; the name stays theirs." : decidedText(what, d), what === "approve" ? "ok" : "warn");
      FRESH = "?after=" + Date.now(); load(); loadWork();
    }).catch(function (e) { err.textContent = "failed: " + errorText(e); });
  }

  // ---- the page's clicks, one handler: a tab, a claim, an open, a lift, an adopt, an agent, a log's architecture, the draft, a decision and its confirmation, the release.
  function chooseTab(id, focus) {
    TAB = id; if (typeof history !== "undefined" && history.replaceState) history.replaceState({}, "", TAB === TABS[0][0] ? "/review" : "/review?tab=" + TAB); renderQueue();
    var b = focus ? $("#rv-tab-" + id) : null; if (b && b.focus) b.focus();
  }
  document.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest ? ev.target : null; if (!t) return;
    var tab = t.closest("#rv-tabs [data-tab]");
    if (tab) { chooseTab(tab.getAttribute("data-tab")); return; }
    var a = t.closest('a[href^="/review?package="]');
    if (a && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && ev.button === 0) { ev.preventDefault(); open(new URLSearchParams(a.getAttribute("href").split("?")[1]).get("package"), true); return; }
    if (t.closest("#rv-back")) { ev.preventDefault(); back(true); return; }
    var c = t.closest("button[data-claim]");
    if (c && !c.disabled) { c.disabled = true; var h = c.hasAttribute("data-hint") ? $("#rv-hint") : null; claim(Number(c.getAttribute("data-claim")), c.getAttribute("data-name"), c.getAttribute("data-arch"), h ? h.value.trim() : "").then(function () { c.disabled = false; }); return; }
    var u = t.closest("button[data-unblock]");
    if (u && !u.disabled) { lift(u.getAttribute("data-unblock"), u.getAttribute("data-what")); return; }
    var ad = t.closest("button[data-adopt]");
    if (ad && !ad.disabled) { adopt(ad.getAttribute("data-adopt")); return; }
    var ag = t.closest("button[data-agent]");
    if (ag) { pickAgent(ag.getAttribute("data-agent")); return; }
    var la = t.closest("button[data-logarch]");
    if (la) { LOGARCH = la.getAttribute("data-logarch"); renderWork(); var again = $('#rv-f-tabs [data-logarch="' + LOGARCH + '"]'); if (again && again.focus) again.focus(); return; }
    if (t.closest("#rv-draft")) { var n = $("#rv-note-in"), R = round(); n.value = draftOf(R); renderDecide(R, workPkg()); if (n.focus) n.focus(); return; }
    var d = t.closest("button[data-decide]");
    if (d && !d.disabled) { CONFIRM = { what: d.getAttribute("data-decide"), id: Number(d.getAttribute("data-task")) }; renderDecide(round(), workPkg()); return; }
    if (t.closest("#rv-confirm-no")) { unconfirm(); return; }
    var go = t.closest("#rv-confirm-go");
    if (go && CONFIRM) { go.disabled = true; decide(CONFIRM.what, CONFIRM.id); setTimeout(function () { go.disabled = false; }, 1500); return; }
    var rl = t.closest("#rv-release");
    if (rl && !rl.disabled) askRelease(Number(rl.getAttribute("data-task")));
  });
  // The keyboard: the queue's tabs move with the arrows, Home and End (one tab stop for the four); Escape closes an open confirmation.
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && CONFIRM && OPEN) { ev.preventDefault(); unconfirm(); return; }
    var tab = ev.target && ev.target.closest ? ev.target.closest("#rv-tabs [data-tab]") : null; if (!tab) return;
    var ids = TABS.map(function (x) { return x[0]; }), i = ids.indexOf(tab.getAttribute("data-tab")), to = ev.key === "ArrowRight" ? (i + 1) % ids.length : ev.key === "ArrowLeft" ? (i + ids.length - 1) % ids.length : ev.key === "Home" ? 0 : ev.key === "End" ? ids.length - 1 : -1;
    if (to < 0) return;
    ev.preventDefault(); chooseTab(ids[to], true);
  });
  function askRelease(id) {
    var p = workPkg(), by = p && p.claim && p.claim.by;
    ask({ title: "Release " + (!by || isOwner(by) ? "your claim" : "@" + by + "'s claim") + " on " + OPEN, text: "Every rebuild of the claim stops, a staged one too, and the package waits for a claim again. The record keeps who let it go and why.", input: "required", placeholder: "why — it goes on the record", confirm: "Release claim", danger: true }).then(function (why) {
      if (why === null) return;
      release(id, OPEN, why).then(function (d) { if (d) toast("Claim released — " + esc(OPEN) + " is back in the queue."); }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    });
  }
  // Another agent: kept for the next claim; on your own claim still queued or running, the rebuild starts again from scratch with it — the claim released with that reason, then made again.
  function pickAgent(a) {
    var p = workPkg(), cl = p && p.claim, lead = p && p.lead;
    choose(a); renderWho();
    if (!cl || !isOwner(cl.by) || cl.agent === a || !(cl.status === "queued" || cl.status === "leased") || !lead) { renderWork(); return; }
    ask({ title: "Rebuild " + OPEN + " with " + agentName(a) + "?", text: "The rebuild with " + esc(agentName(cl.agent) || "the review worker's agent") + " stops, and " + esc(agentName(a)) + " derives the recipe again from scratch.", confirm: "Rebuild" }).then(function (go) {
      if (go === null) return;
      release(lead.id, OPEN, "rebuilding with " + a).then(function (d) { if (d) claim(lead.id, OPEN, lead.arch, ""); });
    });
  }
  // The brake, on the Blocked tab: lift with a reason (another maintainer's), and block a contributor or a package — one field takes either: a login that exists is a contributor, anything else a package.
  function lift(kind, what) {
    ask({ title: "Lift the block on " + what, text: "The record keeps why.", input: "required", confirm: "Lift it" }).then(function (why) {
      if (why === null) return;
      api("POST", API + "/" + kind + "/" + encodeURIComponent(what) + "/unblock", { reason: why }).then(function (d) { if (d.error) toast(esc(d.error), "error"); else toast("Block lifted — " + esc(what) + " goes back to the factory."); load(); }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    });
  }
  function adopt(name) {
    ask({ title: "Adopt " + name + "?", text: "You become its maintainer in the pool, and its registration becomes yours: its bumps come to your workers, and another maintainer reviews them. On the record with your name.", input: "optional", placeholder: "a note for the record (optional)", confirm: "Adopt" }).then(function (why) {
      if (why === null) return;
      api("POST", API + "/packages/" + encodeURIComponent(name) + "/adopt", { reason: why || undefined }).then(function (d) { if (d.error) toast(esc(d.error), "error"); else toast("You now maintain " + esc(name) + " in the pool."); load(); }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    });
  }
  document.addEventListener("submit", function (ev) {
    if (!ev.target || ev.target.id !== "brake") return;
    ev.preventDefault();
    var what = $("#block-what").value.trim(), why = $("#block-why").value.trim();
    if (!what || why.length < 4) return;
    busy(fetch("/api/v1/users/" + encodeURIComponent(what))).then(function (r) { return r.status === 200 ? "contributors" : "packages"; }).then(function (kind) {
      ask({ title: "Block " + (kind === "contributors" ? "contributor " : "package ") + what + "?", text: (kind === "contributors" ? "Their builds stop and their packages leave the rings" : "Its builds stop and it leaves the rings") + "; another maintainer lifts it. The reason: <i>" + esc(why) + "</i>. Your passkey confirms it.", confirm: "Block with your passkey", danger: true }).then(function (go) {
        if (go === null) return;
        // A block is confirmed with the maintainer's passkey (#271), for this contributor or this package.
        passkeyed("block:" + (kind === "contributors" ? "contributor:" : "package:") + what, function (assertion) { return api("POST", API + "/" + kind + "/" + encodeURIComponent(what) + "/block", { reason: why, assertion: assertion }); }).then(function (d) {
          if (d.error) toast(refusalHtml(d), "error"); else { toast("Blocked."); $("#block-what").value = ""; $("#block-why").value = ""; }
          load();
        }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
    });
  });
  // The category, settled here by a maintainer: the same select for everyone, grey for whoever is not one.
  document.addEventListener("change", function (ev) {
    var s = ev.target && ev.target.closest ? ev.target.closest("select[data-category]") : null; if (!s || !s.value) return;
    api("POST", API + "/packages/" + encodeURIComponent(s.getAttribute("data-category")) + "/category", { category: s.value }).then(function (d) { if (d.error) toast(esc(d.error), "error"); else toast("Category set."); FRESH = "?after=" + Date.now(); loadWork(); }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
  });
  if (typeof window.addEventListener === "function") window.addEventListener("popstate", function () { var n = openedName(); if (n) open(n, false); else back(false); });
  // A shell decision the page drew (Drop, on a build of a version already approved): draw again once it landed.
  onDecided(function () { load(); });

  // ---- the lists: the review list and the record together, the brake's, the registry — each said where it draws when it did not answer; a refresh that fails leaves the last answer's rows.
  function load() {
    Promise.all([api("GET", API + "/review"), api("GET", API + "/approvals")]).then(function (rs) {
      REVIEW = rs[0]; APPROVALS = rs[1].approvals || []; DRAWN = true; DOWN = null;
      var note = $("#rv-note"); if (note) note.textContent = "";
      renderQueue(); if (OPEN) renderWork();
    }).catch(function (e) { DOWN = noAnswer("review list", e, "#rv-note"); renderQueue(); });
    api("GET", API + "/blocks").then(function (d) { if (!d.error) { BLOCKS = d; BLOCKS_DOWN = null; renderQueue(); } }).catch(function (e) { BLOCKS_DOWN = noAnswer("brake's record", e); renderQueue(); });
    api("GET", API + "/packages").then(function (d) {
      if (d.error) return;
      REGISTRY = d; REGISTRY_DOWN = null; renderQueue();
      // The list of all is the newest registrations, a page of them: when it says it was truncated, the unmaintained ones are asked for on their own, so an older one still has its row.
      if (d.truncated) api("GET", API + "/packages?status=unmaintained").then(function (u) { if (!u.error) { UNMAINTAINED = u; renderQueue(); } }).catch(function () { /* the list of all stands in for it */ });
      else UNMAINTAINED = null;
    }).catch(function (e) { REGISTRY_DOWN = noAnswer("registry", e); renderQueue(); });
  }
  whoami(function () {
    $("#block-form").innerHTML = gate(${JSON.stringify(BLOCK_FORM)}, isMaintainer(), orSignIn(${JSON.stringify(BLOCK_WHY)}));
    renderQueue(); if (OPEN) { needWorkers(); renderWork(); }
  });
  load();
  var first = openedName(); if (first) open(first, false);
  // Every minute, as before: the lists, and the workspace's story (and, while it runs, the rebuild's log).
  setInterval(function () { load(); if (OPEN) loadWork(); }, 60000);
  // The claim's age, by the second: the clock only, no read.
  setInterval(function () { var el = OPEN ? $("#rv-w-since") : null, p = el && workPkg(); if (p && p.claim) el.textContent = since(p.claim.at) === "now" ? "just now" : since(p.claim.at); }, 1000);
`;

export function reviewHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/review",
    title: "Review · omarchy-pool",
    description: "Review what others asked for: claim a package, rebuild it from scratch on a review worker, and decide with the factory's build beside yours.",
    active: "review",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
    kit: true,
    css: CSS,
  });
}

/**
 * What /review is made of, the same for every role: the hero with its
 * facts, the four tiles, the queue — its tabs and their rows, the brake on
 * the Blocked tab — the maintainers card, and the workspace a package opens
 * into. Every read is a public list (/factory/review, /factory/approvals,
 * /factory/blocks, /factory/packages, a package's story and its builds'
 * text evidence) or what a session unlocks (/auth/me, a worker's log, the
 * project's workers for the choice of agent); every act is a maintainer's —
 * claim, release, approve, request changes, reject, lift, block, adopt, the
 * category — and every role sees its control, grey with the reason where
 * the act would be refused. The acts that change the fixture run on rows
 * of their own: changes asked on `disposable` (the first to decide it; the
 * build page's rejection of it answers 409 after), and on the later build
 * of `mine` a claim, its release and a rejection, each 409 where an
 * earlier act already moved the row; the Pipeline rejects `spare`.
 */
export const REVIEW_COMPONENTS = (F: Fixture): Component[] => [
  {
    id: "review.hero",
    page: "/review",
    anchor: ['<p class="op-eyebrow">For maintainers</p>', '<h1 class="op-hero">Review what others asked for</h1>', "Never your own requests", "Rebuild from scratch", "Your build is the one that ships", 'href="/docs/governance"'],
    visible: EVERYONE,
  },
  {
    // The list's own numbers — ready (waiting for a claim) and in_review (claimed), counted by the server by the rule that files each package — the week's standing approvals, the packages blocked; "—" and the reason while a list did not answer, never a 0.
    id: "review.tiles",
    page: "/review",
    anchor: ['id="rv-tiles"', "Ready for review", "waiting for a claim", "back in the factory"],
    script: ["REVIEW.ready", "REVIEW.in_review", '" claimed by you"', "a.standing", "did not answer", "countUp(n, Number(v))"],
    reads: [
      { path: "/api/v1/factory/review", fields: ["ready", "in_review", "packages", "packages.0.state", "packages.0.claim"] },
      { path: "/api/v1/factory/approvals", fields: ["approvals", "approvals.0.created_at", "approvals.0.standing"] },
      { path: "/api/v1/factory/blocks", fields: ["packages"] },
    ],
    visible: EVERYONE,
  },
  {
    // The four tabs; a package is filed by the server's `state`, never a rule of the page's. Ready's rows: Claim for a maintainer (the row's can.build, the server's reason where not), "yours · locked" on the viewer's own, "maintainers claim" for anyone else; a build of a version already approved is Ready's to Drop (the shell's decision).
    id: "review.ready",
    page: "/review",
    anchor: ['id="rv-tabs"', 'data-tab="ready"', 'data-tab="review"', 'data-tab="blocked"', 'data-tab="unmaintained"', 'id="rv-rows"', 'id="rv-who"'],
    script: ["function tabOf(p)", 'p.state === "in_review"', '"yours · locked"', '"maintainers claim"', "data-claim=", "c.why.build", "archSquares(p.targets)", "Nothing here right now.</p>", "read-only · maintainers claim and review", 'data-reject="'],
    reads: [{ path: "/api/v1/factory/review", fields: ["staged", "staged.0.id", "staged.0.name", "staged.0.version", "staged.0.owner", "staged.0.kind", "staged.0.arch", "staged.0.finished_at", "staged.0.targets", "staged.0.can.build", "staged.0.can.why", "staged.0.already", "staged.0.claim", "packages.0.name", "packages.0.rows", "packages.0.lead", "packages.0.targets", "packages.0.state"] }],
    acts: [{ method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/build`, body: {}, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: [200, 409] } }],
    visible: EVERYONE,
  },
  {
    // In review: who claimed it, whose request it is, since when; Open for a maintainer (lit for the one who claimed it), "in progress" for anyone else.
    id: "review.in-review",
    page: "/review",
    anchor: ['data-tab="review"'],
    script: ["function reviewRow(p, fresh)", "claimed by ' + at(cl.by)", "' · asked by ' + at(p.owner)", '"in progress"', "workHref(p.name)"],
    reads: [{ path: "/api/v1/factory/review", fields: ["packages.0.claim", "staged.0.claim"] }],
    visible: EVERYONE,
  },
  {
    // Blocked: the brake's record, a Lift on every row — another maintainer's than the one who blocked — and the brake's form, served grey and drawn again through gate() for a maintainer. The acts lift what the fixture seeded — carol and her package, blocked by m1 — as m2; the form lands on rows the handler refuses.
    id: "review.blocked",
    page: "/review",
    anchor: ['id="brake"', 'id="block-form"', 'id="block-what"', 'id="block-why"', 'minlength="4"', `title="${BLOCK_WHY}"`],
    script: ["function blockedRows()", "function liftBtn(kind, what, b)", '"another maintainer lifts it"', '"on the record"', "\"/unblock\"", '$("#block-form").innerHTML = gate(', '"/api/v1/users/"', 'r.status === 200 ? "contributors" : "packages"', '"/block"', 'noAnswer("brake\'s record", e)', 'passkeyed("block:" + (kind === "contributors" ? "contributor:" : "package:") + what', 'if (d.error) toast(refusalHtml(d), "error")'],
    reads: [
      { path: "/api/v1/factory/blocks", fields: ["contributors", "contributors.0.login", "contributors.0.blocked_at", "contributors.0.blocked_by", "contributors.0.blocked_reason", "packages.0.name", "packages.0.blocked_at", "packages.0.blocked_by", "packages.0.blocked_reason"] },
      { path: `/api/v1/users/${F.owner}`, fields: ["login"] },
      { path: `/api/v1/users/${F.factoryPkg}`, status: 404 },
    ],
    acts: [
      { method: "POST", path: `/api/v1/factory/contributors/${F.blockedContributor}/unblock`, body: { reason: "lifted by the tests" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } },
      { method: "POST", path: `/api/v1/factory/packages/${F.blockedPkg}/unblock`, body: { reason: "lifted by the tests" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } },
      { method: "POST", path: `/api/v1/factory/contributors/${F.m1}/block`, body: { reason: "typed into the brake by the tests" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 409 } },
      { method: "POST", path: `/api/v1/factory/packages/${F.pkg}/block`, body: { reason: "typed into the brake by the tests" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 404 } },
    ],
    visible: EVERYONE,
  },
  {
    // No maintainer: the registrations left unmaintained, Adopt for a maintainer — the one Adopt, the package page's too (routes/adopt.ts); the fixture has none, so the act answers what a maintainer adopting a package that has one gets: ours, served under m2's approval.
    id: "review.unmaintained",
    page: "/review",
    anchor: ['data-tab="unmaintained"'],
    script: ["function unmaintained()", 'p.status === "unmaintained"', '"maintainers adopt"', "data-adopt=", '"/adopt"', '"/packages?status=unmaintained"', "d.truncated"],
    reads: [
      { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.name", "packages.0.status", "packages.0.owner", "packages.0.detail", "packages.0.targets", "packages.0.updated_at", "packages.0.blocked_at"] },
      { path: "/api/v1/factory/packages?status=unmaintained", fields: ["packages"] },
    ],
    acts: [{ method: "POST", path: `/api/v1/factory/packages/${F.publishedPkg}/adopt`, body: {}, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 409 } }],
    visible: EVERYONE,
  },
  {
    // The maintainers, from the one list the pool keeps, and the three steps to become one.
    id: "review.maintainers",
    page: "/review",
    anchor: ['id="rv-maint"', 'id="rv-maints"', 'id="rv-become"', "1 approved package", "open an issue", "a PR adds you", 'href="https://github.com/firemanxbr/omarchy-pool/blob/main/factory/MAINTAINERS.toml"'],
    script: ["function renderMaintainers()", "maintainerSet(function (set)", '" active"', "'reviewing ' + esc(cur.name)"],
    reads: [{ path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login"] }],
    visible: EVERYONE,
  },
  {
    // The workspace's head: the claim and Release (the row's can.release, the server's reason where not), the package, who asked, where each architecture stands, the request's facts and the category a maintainer settles here.
    id: "review.workspace-head",
    page: "/review",
    anchor: ['id="rv-work"', 'id="rv-back"', 'id="rv-w-claim"', 'id="rv-w-release"', 'id="rv-w-name"', 'id="rv-w-state"', 'id="rv-w-chips"', 'id="rv-w-fields"'],
    script: ["'claimed by ' + (mine ? \"you\" : at(cl.by))", '>Release claim</button>', "c.why.release", "approvalWhere(a)", "'requested by '", "select data-category=", 'orSignIn("a maintainer sets the category")', '"/category"', '"/release"', '"/story"'],
    reads: [
      { path: `/api/v1/factory/packages/${F.factoryPkg}/story`, fields: ["package.owner", "package.arches", "package.license", "package.project", "package.category", "targets", "request.checks", "request.complete", "request.version", "chains", "chains.0.contributor", "chains.0.project", "chains.0.audit", "chains.0.trial"] },
      { path: "/api/v1/factory/review", fields: ["staged.0.can.release", "staged.0.can.changes"] },
    ],
    acts: [
      { method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/category`, body: { category: CATEGORIES[0] }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } },
      { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/release`, body: { reason: "released by the tests" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: [200, 409] } },
    ],
    visible: EVERYONE,
  },
  {
    // Left, the factory as the reference: the request as checked, its PKGBUILD and its log per architecture — the public text evidence of each build, never its package — the gate and the audit.
    id: "review.factory-pane",
    page: "/review",
    anchor: ['id="rv-factory"', "Request, as checked", 'id="rv-f-pkgbuild"', 'id="rv-f-log"', 'id="rv-f-tabs"', "Learn from it. Its packages are never reused."],
    script: ["function evidenceOf(id)", "function evidenceUrl(id, which)", "x.public", "function builtOn(id)", "b.trusted_by", 'textOf(f.factory.id, "pkgbuild")', 'textOf(mine.factory.id, "log")', "gatePill(vetOf(mine.factory), fev.tests)", "auditPill(auditOf(mine.audit)", "evidenceLink({ id: id }", "data-logarch="],
    reads: [
      { path: `/api/v1/factory/tasks/${F.contributorTask}/artifacts/PKGBUILD`, json: false },
      { path: `/api/v1/factory/tasks/${F.contributorTask}/artifacts/build.log`, json: false },
      { path: `/api/v1/factory/tasks/${F.contributorTask}/artifacts/tests.log`, json: false },
      { path: `/api/v1/factory/tasks/${F.contributorTask}/artifacts/audit.md`, json: false },
      { path: "/api/v1/factory/review", fields: ["staged.0.evidence.pkgbuild", "staged.0.evidence.log", "staged.0.evidence.tests", "staged.0.evidence.audit", "staged.0.evidence.trial", "staged.0.built_by", "staged.0.agent"] },
      { path: `/api/v1/factory/tasks/${F.contributorTask}`, fields: ["evidence", "evidence.0.name", "evidence.0.url", "evidence.0.public"] },
    ],
    visible: EVERYONE,
  },
  {
    // Right, the rebuild — "Your rebuild" to the maintainer who claimed it, the claimant's to anyone else: the agents a maintainer's claim may choose (the project's workers, read when a claim or the workspace first needs them), the steps with their progress, the rebuilt PKGBUILD with the lines that differ from the factory's lit, the log — the worker's own while it runs (a maintainer's read, with the story), the build's once it built — and Claim with a hint where nobody claimed it. A rebuild an emulated worker sent back says, in its step, its recipe's note and its log, the native worker it waits for (the shell's waitsForNative, #281).
    id: "review.rebuild-pane",
    page: "/review",
    anchor: ['id="rv-yours"', '<b id="rv-y-title">The rebuild</b>', 'id="rv-agents"', 'id="rv-steps"', 'id="rv-progress"', 'id="rv-y-pkgbuild"', 'id="rv-diffnote"', 'id="rv-y-log"', "If approved, this build is the one that ships."],
    script: ["function diff(a, b)", '"s differ"', '" from the factory\'s"', '"Your rebuild"', "\"'s rebuild\"", '"Re-check the request"', '"Derive the recipe from scratch"', '"Install with a real pacman"', '"Compare with the factory"', ">Claim and rebuild</button>", "data-agent=", '"/workers/"', '"/log"', "localStorage.getItem(AGENT_KEY)", "function needWorkers()", "RECIPE_LINES = 1000", '"native worker"', "waitsForNative(b)", "waitsForNative(r.rebuild)"],
    reads: [
      { path: "/api/v1/factory?limit=10", fields: ["workers", "workers.0.id", "workers.0.arch", "workers.0.side", "workers.0.kinds", "workers.0.alive", "workers.0.agent", "workers.0.agent_status"] },
      { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/PKGBUILD`, json: false },
      { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/build.log`, json: false },
      { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/trial.log`, json: false },
      { path: `/api/v1/factory/workers/${F.worker}/log`, as: "maintainer", fields: ["id", "log"] },
    ],
    visible: EVERYONE,
  },
  {
    // Below: the checklist, the verdict with the agent's draft, and the three decisions — each confirmed in place before it is posted, approve with the maintainer's passkey (#271), each grey with the server's reason where the viewer may not. The acts: approve on the project's build (409 once decided, 403 without a passkey's answer), changes on disposable's own row, a rejection of mine's later build.
    id: "review.decide",
    page: "/review",
    anchor: ['id="rv-decide"', "Checklist", "Verdict · goes on the record", 'id="rv-note-in"', 'id="rv-btns"', 'data-decide="approve"', 'data-decide="changes"', 'data-decide="reject"', 'id="rv-err" role="alert"', 'id="rv-confirm" role="group" aria-labelledby="rv-confirm-t"', 'id="rv-confirm-go"'],
    script: ["function draftOf(R)", "Use the agent's draft", "function setGate(el, ok, why)", "ca.why.approve", "cl.why.changes", "cl.why.reject", '"Your build enters edge."', "? The name is freed and the requester is told why.", '" back to the factory with your note?', '" did not request it"', '"Rebuilt by the project, not the factory\'s package"', 'ev.key === "Escape"', 'passkeyed("approve:" + id, send)', '"Confirm with your passkey"', "err.innerHTML = refusalHtml(d)"],
    reads: [{ path: "/api/v1/factory/review", fields: ["staged.0.can.approve", "staged.0.can.reject", "staged.0.can.changes", "staged.0.lead"] }],
    acts: [
      { method: "POST", path: `/api/v1/factory/tasks/${F.projectTask}/approve`, body: { note: "reads well" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: [403, 409] } },
      { method: "POST", path: `/api/v1/factory/tasks/${F.disposableTask}/changes`, body: { note: "pin the source to the release tag" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } },
      { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/reject`, body: { note: "the source is not the upstream's" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: [200, 409] } },
    ],
    visible: EVERYONE,
  },
];
