/**
 * The Factory (#246): the door for contributors, drawn with the v1 kit.
 * One sentence of what happens — you send the source, agents write and
 * build it, a maintainer reviews it — four numbers, then the three things a
 * contributor comes for: the request card (a form, or a prompt for their
 * own agent), the workers and what each is doing right now, and the line a
 * request travels, one card per package. Signed in, the reader's own
 * requests close the page.
 *
 * The request card is the one place a package is requested: /request, the
 * page it had of its own, redirects here with its query (index.ts MOVED),
 * so the ⌘K menu's Request "<name>" (?name=) and a person's "Renew the
 * request" (?renew=) land on this card. Its checks are the request's own:
 * the name by request.ts's PKGNAME, spliced in, and by the server's rule
 * over the name (GET /factory/names/:name — reserved, taken, blocked, the
 * handler's very words); the repository by what the request reads of it
 * (GET /factory/source). Sending reserves the name in one statement
 * (reserveName): two people sending one name at once, one of them has it.
 *
 * Everything is public and the same for everyone. What a session changes
 * is the send — "Sign in to send" for nobody, the card kept across the
 * sign-in; the POST for a person — and the reader's own requests. The line
 * and the workers are the pool's own rows: the workers from the factory
 * listing's live read (the tasks in flight, through the queue's index),
 * every minute while the tab is shown; the line from the registry, where
 * each package's targets say where each architecture stands (targets.ts),
 * read again when a build starts or ends — a card moves when its job ends —
 * and every five minutes; a shipped card worded, and linked, by where its
 * approval stands today (approvalWhere over the approvals list).
 */
import { page } from "./layout";
import { EVERYONE, SIGNED_IN, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";
import { REPO_ARCHES } from "../meta";
import { CHECKLIST, PKGNAME, PKGNAME_RULE } from "../request";
import { escapeHtml } from "../html";
import { agentMark, lucide, type AgentMark, type LucideName } from "./kit";
import { LOGIN_DOCS, SERVER_COMMAND } from "./agents";

/** A confirmation as the form asks it: the checklist's sentence (src/request.ts, the one text) as a line — capitalised, a full stop, escaped as the chapter's copy is by the markdown renderer. */
const asLine = (s: string) => escapeHtml(`${s.charAt(0).toUpperCase()}${s.slice(1)}.`);

/** The line a request travels, left to right: a column's name, its icon and its hue (the kit's tones; the text's own for a maintainer's review). */
const LINE: [string, LucideName][] = [
  ["Checking", "file-search"],
  ["Building", "hammer"],
  ["Ready for review", "inbox"],
  ["In review", "user-check"],
  ["Shipped", "package-check"],
];

/** The agents a prompt works with, as the handoff shows them: their marks (pages/kit.ts, their owners' trademarks), named. */
const WORKS_WITH: [string, AgentMark][] = [
  ["Claude Code", "claude-color"], ["Codex", "openai"], ["Cursor", "cursor"], ["Gemini CLI", "gemini-color"], ["GitHub Copilot", "githubcopilot"],
  ["Grok", "grok"], ["OpenCode", "opencode"], ["Qwen Code", "qwen-color"], ["Kimi", "kimi"], ["Meta", "meta-color"],
];

/** What an agent needs for the two tools (#252): the login with its own name, which grants them. The Agents page walks through it, step 4. */
const AGENT_LOGIN = 'omarchy-cli login --agent "&lt;its name&gt;"';
const AGENT_LOGIN_NOTE = "Your agent gets both tools once you log it in with its name. Your browser asks you to grant it, and the token stays on your machine.";

/** The licences a request names most, offered as the field is typed in; any SPDX identifier is taken (request.ts LICENSE). */
const SPDX = ["MIT", "Apache-2.0", "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "LGPL-2.1-or-later", "LGPL-3.0-or-later", "AGPL-3.0-or-later", "BSD-2-Clause", "BSD-3-Clause", "MPL-2.0", "ISC", "Unlicense", "0BSD", "Zlib", "EUPL-1.2", "custom:proprietary"];

/** The sign-in the send is for nobody: it comes back to the Factory, the name typed so far carried in the address (the script keeps it current). */
const SIGN_IN_TO_SEND = `<a class="op-btn" id="fx-send" href="/auth/github?next=/factory">Sign in to send</a>`;

const BODY = String.raw`
<div class="fx">
  <section class="fx-hero" aria-labelledby="fx-title">
    <div class="fx-lede">
      <p class="op-eyebrow">For contributors</p>
      <h1 class="op-hero" id="fx-title">Get your project into Omarchy</h1>
      <ul class="fx-steps">
        <li>${lucide("send", 15)}You send the source</li>
        <li>${lucide("bot", 15)}Agents write and build it</li>
        <li>${lucide("users", 15)}A maintainer reviews it</li>
      </ul>
    </div>
    <div class="op-stats fx-stats" id="tiles">
      <a class="op-stat" id="t-line" href="#line"><span class="k">In the factory</span><b class="n" id="t-line-n"><span class="skl"></span></b><span class="s" id="t-line-s">requests on the line</span></a>
      <a class="op-stat" id="t-building" href="#workers"><span class="k">Building now</span><b class="n" id="t-building-n"><span class="skl"></span></b><span class="s" id="t-building-s">workers busy</span></a>
      <a class="op-stat" id="t-ready" href="/review"><span class="k">Ready for review</span><b class="n" id="t-ready-n"><span class="skl"></span></b><span class="s" id="t-ready-s">waiting for a claim</span></a>
      <a class="op-stat" id="t-shipped" href="/packages?origin=factory"><span class="k">Shipped</span><b class="n" id="t-shipped-n"><span class="skl"></span></b><span class="s" id="t-shipped-s">approved by a maintainer</span></a>
    </div>
  </section>

  <section class="fx-pair" aria-label="Request a package, and the workers">
    <div class="op-card fx-request" id="request">
      <div class="op-card-h"><h2 class="fx-h" id="fx-head">Request a package</h2>
        <div class="op-tabs" role="tablist" aria-label="How to send it">
          <button type="button" role="tab" id="tab-form" aria-selected="true" aria-controls="fx-form">Form</button>
          <button type="button" role="tab" id="tab-agent" aria-selected="false" aria-controls="fx-agent" tabindex="-1">Ask your agent</button>
        </div>
      </div>
      <form class="fx-form" id="fx-form" role="tabpanel" aria-labelledby="tab-form" onsubmit="return false" novalidate>
        <div class="fx-field">
          <div class="fx-lab"><label class="op-label" for="fx-name">Name</label><span class="fx-say" id="fx-name-say" aria-live="polite"></span></div>
          <div class="fx-in" id="fx-name-box">${lucide("package", 15)}<input id="fx-name" type="text" placeholder="the name people will pacman -S" maxlength="100" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="fx-name-why"></div>
          <p class="fx-why" id="fx-name-why" hidden></p>
        </div>
        <div class="fx-field">
          <div class="fx-lab"><label class="op-label" for="fx-url">Source</label><span class="fx-say" id="fx-url-say" aria-live="polite"></span></div>
          <div class="fx-in" id="fx-url-box"><span class="fx-ic" id="fx-url-icon">${lucide("github", 15)}</span><input id="fx-url" type="text" inputmode="url" placeholder="github.com/you/project" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="fx-url-why"></div>
          <p class="fx-why" id="fx-url-why" hidden></p>
          <div class="fx-found" id="fx-found" hidden></div>
        </div>
        <div class="fx-row">
          <div class="fx-field fx-lic">
            <label class="op-label" for="fx-license">Licence</label>
            <div class="fx-in">${lucide("scale", 15)}<input id="fx-license" type="text" list="spdx" placeholder="detected from the repository" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
            <datalist id="spdx">${SPDX.map((l) => `<option>${l}</option>`).join("")}</datalist>
          </div>
          <div class="fx-field fx-archs">
            <span class="op-label" id="fx-archs-label">Architectures</span>
            <div class="op-seg fx-seg" role="group" aria-labelledby="fx-archs-label">${REPO_ARCHES.map((a) => `<button type="button" data-arch="${a}" aria-pressed="true"><b class="fx-tick" aria-hidden="true">✓</b>${a}</button>`).join("")}</div>
          </div>
        </div>
        <div class="fx-field">
          <label class="op-label" for="fx-desc">Description</label>
          <div class="fx-in">${lucide("text", 15)}<input id="fx-desc" type="text" placeholder="one line: what it does" maxlength="120" autocomplete="off"></div>
        </div>
        <details class="fx-more" id="fx-more"><summary>Not on GitHub, GitLab or Codeberg? Name the release</summary>
          <div class="fx-row">
            <div class="fx-field"><label class="op-label" for="fx-source">Release</label><div class="fx-in">${lucide("file-archive", 15)}<input id="fx-source" type="text" inputmode="url" placeholder="https://…/project-1.2.3.tar.gz" autocomplete="off" spellcheck="false"></div></div>
            <div class="fx-field fx-ver"><label class="op-label" for="fx-version">Version</label><div class="fx-in">${lucide("tag", 15)}<input id="fx-version" type="text" placeholder="1.2.3" autocomplete="off" spellcheck="false"></div></div>
          </div>
        </details>
        <fieldset class="fx-confirm" id="fx-checklist"><legend class="op-label">You confirm</legend>
${Object.entries(CHECKLIST).map(([key, text]) => `          <label><input type="checkbox" data-check="${key}"> ${asLine(text)}</label>`).join("\n")}
        </fieldset>
        <div class="fx-send">
          <span class="fx-lock">${lucide("lock", 13)}Sending reserves the name. It's freed if the request is rejected.</span>
          <span id="fx-send-slot">${SIGN_IN_TO_SEND}</span>
        </div>
        <p class="fx-state" id="fx-state" role="status"></p>
        <div class="fx-done" id="fx-done" tabindex="-1" hidden></div>
      </form>
      <div class="fx-agent" id="fx-agent" role="tabpanel" aria-labelledby="tab-agent" hidden>
        <p>Your agent fills in the request and follows it for you.</p>
        <div class="op-code"><code><span class="op-prompt">› </span><span id="fx-prompt">Request &lt;name&gt; on omarchy-pool.</span></code><button type="button" class="op-copy" data-op-copy="">copy prompt</button></div>
        <div class="fx-with"><span>Works with</span>${WORKS_WITH.map(([label, mark]) => `<span class="fx-mark">${agentMark(mark, label, 22)}</span>`).join("")}</div>
        <p class="fx-tools"><span>${lucide("plug", 13)} Through <code>${SERVER_COMMAND}</code> · <code>request_package</code> · <code>request_status</code></span></p>
        <p class="fx-tools-note">${AGENT_LOGIN_NOTE}</p>
        <div class="op-code"><code>${AGENT_LOGIN}</code><button type="button" class="op-copy" data-op-copy="">copy</button></div>
        <p class="fx-tools-note">Connect your agent on <a href="/agents#connect">the Agents page</a>. <a href="${LOGIN_DOCS}">The MCP chapter</a> says what each tool answers.</p>
      </div>
      <ol class="fx-next" aria-label="What happens next">
        <li>${lucide("file-search", 14)}<b>Checked</b><span>licence, source, name</span></li>
        <li>${lucide("hammer", 14)}<b>Built</b><span>on each architecture</span></li>
        <li>${lucide("user-check", 14)}<b>Reviewed</b><span>by a maintainer, never the requester</span></li>
        <li>${lucide("layers", 14)}<b>In edge</b><span>then rc → stable</span></li>
      </ol>
    </div>

    <div class="op-card fx-workers" id="workers">
      <div class="op-card-h"><h2 class="fx-h">Workers <span class="op-live-dot" title="live: what runs now, every minute"></span></h2><small id="fx-busy"></small></div>
      <div class="fx-wlist" id="fx-wlist"><p class="fx-wempty"><span class="skl"></span></p></div>
      <div class="op-card-f fx-wfoot"><span>each with the agent it reports</span><a href="/workers">All workers →</a></div>
    </div>
  </section>

  <section class="fx-line" id="line" aria-labelledby="line-label">
    <div class="fx-shead"><h2 class="op-label" id="line-label">On the line</h2><span class="fx-hint" id="line-note">live · a card moves when its job ends</span></div>
    <div class="fx-board-wrap"><div class="fx-board" id="board">
${LINE.map(([name, icon], i) => `      <div class="fx-col c${i}"><div class="fx-colh">${lucide(icon, 14)}<span>${escapeHtml(name)}</span><b class="n" id="col-${i}-n"></b></div><div class="fx-cards" id="col-${i}"></div></div>`).join("\n")}
    </div></div>
  </section>

  <section class="fx-mine" id="mine" hidden aria-labelledby="mine-label">
    <div class="fx-shead"><h2 class="op-label" id="mine-label">Your requests · <span id="mine-n">0</span></h2><a class="fx-maint" id="mine-maint" href="/docs/governance#becoming">How to become a maintainer ›</a></div>
    <div class="fx-mlist" id="mine-list"></div>
    <p class="fx-lockline">${lucide("lock", 13)}You never review your own requests. Another maintainer picks them up.</p>
  </section>
</div>
`;

/**
 * The page's own rules: what the kit's primitives do not draw — the
 * frame of 1120px, the hero's two halves, a field of the form, the
 * workers' rows, the line's board and cards, the reader's rows. Every rule
 * sits under .fx; where it refines a kit class it names .fx too, and
 * colours are the palette's names.
 */
const FACTORY_CSS = String.raw`
  .fx { max-width: calc(var(--content-max) - 2 * var(--gutter)); margin: 0 auto; padding-top: 12px; display: grid; gap: var(--section-gap); }
  .fx section { margin: 0; min-width: 0; }
  .fx a { text-decoration: none; }
  .fx h2.op-label { margin: 0; font-family: var(--font-mono); letter-spacing: var(--tracking-label); }
  .fx .op-card-h > h2.fx-h { margin: 0; font: 600 15px var(--font-display); }
  /* Focus is one 1px green line, square, on everything a reader can reach: the kit's button and copy well and the page's links included, which the browser drew its own rounded ring on. */
  .fx a:focus-visible, .fx .op-btn:focus-visible, .fx .op-copy:focus-visible, .fx-done:focus-visible { outline: 1px solid var(--green); outline-offset: 1px; }
  .fx-hero { display: flex; flex-wrap: wrap; gap: 32px 40px; align-items: flex-end; }
  .fx-lede { flex: 1 1 480px; min-width: 0; display: grid; gap: 16px; }
  .fx .op-hero { max-width: 600px; }
  .fx-steps { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 10px 22px; font-size: 13.5px; color: var(--muted); }
  .fx-steps li { display: flex; align-items: center; gap: 8px; } .fx-steps .op-i { color: var(--green); }
  .fx .fx-stats { flex: 1 1 360px; grid-template-columns: 1fr 1fr; }
  .fx .fx-stats .skl { width: 36px; height: 24px; }
  .fx-pair { display: flex; flex-wrap: wrap; gap: 16px; align-items: stretch; }
  .fx .fx-request { flex: 1 1 560px; display: grid; grid-template-rows: auto 1fr auto; }
  .fx .fx-workers { flex: 1 1 380px; display: grid; grid-template-rows: auto 1fr auto; }
  .fx-form, .fx-agent { margin: 0; padding: 16px; display: grid; gap: 14px; align-content: start; min-width: 0; }
  .fx-field { display: grid; gap: 6px; min-width: 0; }
  .fx-lab { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; min-width: 0; }
  .fx-say { min-width: 0; font-size: 12.5px; color: var(--dim); text-align: right; overflow-wrap: anywhere; }
  .fx-say a { color: inherit; } .fx-say a:hover { text-decoration: underline; }
  .fx-in { display: flex; align-items: center; gap: 10px; height: 42px; padding: 0 12px; min-width: 0; background: var(--bg-deep); border: 1px solid var(--line); color: var(--dim); }
  /* The field's focus is an outline, so the border stays the check's (ok, bad, warn, run) and neither hides the other. */
  .fx-in:focus-within { outline: 1px solid var(--green); outline-offset: 1px; }
  .fx-in input { flex: 1; min-width: 0; height: 100%; padding: 0; background: transparent; border: 0; outline: 0; color: var(--text); font: 14px var(--font-mono); }
  .fx-in input::placeholder { color: var(--dim); }
  .fx-ic { display: flex; }
  .fx-say.ok { color: var(--green); } .fx-say.bad { color: var(--red); } .fx-say.warn { color: var(--amber); } .fx-say.run { color: var(--blue); }
  .fx-in.ok { border-color: var(--green); } .fx-in.bad { border-color: var(--red); } .fx-in.warn { border-color: var(--amber); } .fx-in.run { border-color: var(--blue); }
  .fx-why { margin: 0; font-size: 12px; color: var(--dim); overflow-wrap: anywhere; } .fx-why.bad { color: var(--red); } .fx-why.warn { color: var(--amber); }
  .fx-found { display: flex; flex-wrap: wrap; gap: 6px 16px; padding-top: 2px; font-size: 12.5px; color: var(--muted); }
  .fx-found > span { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
  .fx-found b { font-weight: 700; } .fx-found .ok { color: var(--green); } .fx-found .bad { color: var(--red); } .fx-found .warn { color: var(--amber); }
  .fx-row { display: flex; flex-wrap: wrap; gap: 14px; }
  .fx-row > .fx-field { flex: 1 1 180px; } .fx-row > .fx-archs { flex: 1 1 240px; } .fx-row > .fx-ver { flex: 0 1 170px; }
  .fx .fx-seg { height: 42px; flex-wrap: nowrap; }
  .fx .fx-seg > button { flex: 1 1 0; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 8px; color: var(--dim); }
  .fx .fx-seg > button[aria-pressed="true"] { color: var(--text); }
  .fx-tick { width: 12px; text-align: center; } .fx-seg > [aria-pressed="false"] .fx-tick { visibility: hidden; }
  .fx-seg > button:focus-visible, .fx .op-tabs > button:focus-visible, .fx-more summary:focus-visible, .fx-confirm input:focus-visible { outline: 1px solid var(--green); outline-offset: 1px; }
  /* The kit's tabs scroll sideways (overflow-x), which clips an outline to its box: two pixels of room inside it, given back outside. */
  .fx .op-card-h .op-tabs { padding: 2px; margin: -2px; }
  .fx-more summary { cursor: pointer; font-size: 12.5px; color: var(--dim); } .fx-more summary:hover { color: var(--text); } .fx-more[open] summary { margin-bottom: 10px; }
  .fx-confirm { margin: 0; padding: 10px 12px; min-width: 0; display: grid; gap: 6px; border: 1px solid var(--line); background: var(--bg-deep); }
  .fx-confirm legend { padding: 0 4px; }
  .fx-confirm label { display: flex; align-items: flex-start; gap: 9px; font-size: 12.5px; line-height: 1.45; color: var(--muted); cursor: pointer; }
  /* A confirmation's box drawn square, as every box of the page: the browser's is rounded. */
  .fx-confirm input { flex: none; display: grid; place-content: center; width: 14px; height: 14px; margin: 2px 0 0; -webkit-appearance: none; appearance: none; border: 1px solid var(--dim); background: var(--bg-deep); cursor: pointer; }
  .fx-confirm input:checked { border-color: var(--green); } .fx-confirm input:checked::before { content: "✓"; color: var(--green); font: 700 11px/1 var(--font-mono); }
  .fx-send { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding-top: 14px; border-top: 1px solid var(--line); }
  .fx-lock, .fx-lockline { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 12.5px; color: var(--dim); }
  .fx .fx-send .op-btn { padding: 7px 16px; font-size: 13.5px; } .fx .fx-send .op-btn[aria-disabled="true"] { opacity: .6; cursor: progress; }
  .fx-state { margin: 0; font-size: 12.5px; color: var(--muted); } .fx-state:empty { display: none; } .fx-state.bad { color: var(--red); }
  .fx-done { display: grid; gap: 6px; padding: 10px 12px; border: 1px solid var(--green); background: var(--bg-deep); font-size: 13px; }
  .fx-done > span { overflow-wrap: anywhere; } .fx-done a { color: var(--green); } .fx-done a:hover { text-decoration: underline; } .fx-done .warn { color: var(--amber); } .fx-done .dim { color: var(--dim); }
  .fx-sent { display: flex; align-items: flex-start; gap: 8px; } .fx-sent > .op-i { color: var(--green); margin-top: 3px; }
  .fx-follow { display: flex; flex-wrap: wrap; gap: 6px 18px; }
  .fx-agent p { margin: 0; font-size: 13px; color: var(--muted); }
  .fx-with { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; } .fx-with > span:first-child { margin-right: 4px; font-size: 12px; color: var(--dim); }
  .fx-mark { display: grid; padding: 4px; border: 1px solid var(--line); background: var(--bg-deep); color: var(--text); }
  .fx-agent .fx-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--dim); } .fx-tools code { color: var(--muted); }
  .fx-agent .fx-tools-note { font-size: 12px; color: var(--dim); } .fx-tools-note code { color: var(--muted); } .fx-tools-note a { color: var(--green); } .fx-tools-note a:hover { text-decoration: underline; }
  .fx-next { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 1px; background: var(--line); border-top: 1px solid var(--line); }
  .fx-next li { display: grid; grid-template-columns: auto 1fr; align-content: start; align-items: center; gap: 3px 8px; padding: 12px 14px; background: var(--panel-2); }
  .fx-next .op-i { color: var(--green); } .fx-next b { font: 600 13.5px var(--font-display); } .fx-next span { grid-column: 1 / -1; font-size: 12px; color: var(--dim); }
  .fx-workers .op-card-h > b { display: flex; align-items: center; gap: 10px; }
  .fx-wlist { display: grid; align-content: start; }
  .fx-wrow { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 12px; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  .fx-wbox { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--line); background: var(--bg-deep); color: var(--dim); font-size: 11px; }
  .fx-wmain { display: grid; gap: 5px; min-width: 0; }
  /* The worker's name and its agent, each whole: the agent wraps under the name when both do not fit, never "AAR…" beside "CLAUDE-SONNET…" (#282);
     it keeps to the right edge on its own line too, so every row reads its agent in one place. */
  .fx-wtop { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 8px; min-width: 0; font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  .fx-wtop > span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .fx-wtop > span + span { margin-left: auto; } .fx-wtop .mono { font-size: inherit; }
  .fx-wjob { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--text); }
  .fx-wjob b { font-weight: 600; } .fx-wjob a { color: inherit; } .fx-wjob a:hover { color: var(--green); } .fx-wjob .fx-step { margin-left: 8px; color: var(--dim); }
  .fx-wrow.idle .fx-wjob { color: var(--dim); }
  .fx-wrow.notready .fx-wjob { color: var(--dim); } .fx-wrow.notready .fx-wjob b { color: var(--red); }
  .fx-wmark { display: inline-block; width: 8px; height: 8px; margin-right: 8px; vertical-align: 1px; background: var(--red); }
  .fx-bar { height: 2px; background: var(--line); } .fx-bar i { display: block; height: 2px; background: var(--blue); transition: width .7s linear; } .fx-bar i.unknown { background: var(--dim); }
  .fx-wempty { margin: 0; padding: 14px 16px; font-size: 13px; color: var(--dim); } .fx-wempty a { color: var(--green); }
  .fx .fx-wfoot { flex-wrap: wrap; justify-content: space-between; border-top: 0; color: var(--dim); } .fx-wfoot a { color: var(--green); } .fx-wfoot a:hover { text-decoration: underline; }
  .fx-shead { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  .fx-hint { font-size: 12px; color: var(--dim); }
  .fx-board-wrap { overflow-x: auto; border: 1px solid var(--line); scrollbar-width: thin; }
  .fx-board { display: grid; grid-template-columns: repeat(5, minmax(190px, 1fr)); gap: 1px; min-width: 960px; background: var(--line); }
  .c0 { --fx-c: var(--muted); } .c1 { --fx-c: var(--blue); } .c2 { --fx-c: var(--amber); } .c3 { --fx-c: var(--text); } .c4 { --fx-c: var(--green); } .c-off { --fx-c: var(--dim); }
  .fx-col { display: grid; align-content: start; gap: 8px; min-width: 0; min-height: 260px; padding: 12px; background: var(--panel); }
  .fx-colh { display: flex; align-items: center; gap: 8px; padding-bottom: 4px; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .fx-colh .op-i { color: var(--fx-c); } .fx-colh .n { margin-left: auto; font: 600 15px var(--font-display); letter-spacing: 0; color: var(--fx-c); }
  .fx-cards { display: grid; gap: 8px; min-width: 0; }
  .fx-card { display: grid; gap: 6px; min-width: 0; padding: 9px 10px; border: 1px solid var(--line); border-top: 2px solid var(--fx-c); background: var(--bg-deep); color: var(--text); }
  .fx-card:hover { border-color: var(--green); border-top-color: var(--fx-c); } .fx a.fx-card:focus-visible { outline: 1px solid var(--green); outline-offset: -1px; }
  @keyframes fx-fresh { from { background-color: var(--panel-2); } to { background-color: var(--bg-deep); } }
  .fx-card.op-fresh { animation-name: fx-fresh; }
  .fx-c1, .fx-c2 { display: flex; justify-content: space-between; gap: 8px; min-width: 0; } .fx-c1 { align-items: baseline; } .fx-c2 { align-items: center; }
  .fx-c1 > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fx-c1 b { font: 600 14px var(--font-display); } .fx-c1 .v { margin-left: 6px; font-size: 11.5px; color: var(--dim); } .fx-c1 .age { font-size: 11.5px; color: var(--dim); white-space: nowrap; }
  .fx-by { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: var(--muted); } .fx-by > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fx .fx-by .avatar { width: 16px; height: 16px; font-size: 7px; font-weight: 700; }
  .fx-sq { display: flex; gap: 3px; } .fx .fx-sq .op-arch { width: 9px; height: 9px; } .fx .op-arch.wait { background: transparent; }
  /* An architecture nobody asked for: the faintest square, apart from one whose build failed (the kit's dashed na). */
  .fx .op-arch.off { background: transparent; border: 1px solid var(--line); }
  .fx-note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--dim); } .fx-note.warn { color: var(--amber); } .fx-note.bad { color: var(--red); }
  .fx-none { margin: 0; padding: 2px; font-size: 12px; color: var(--dim); }
  .fx-more-n { padding: 2px; font-size: 12px; color: var(--dim); }
  .fx-mlist { border: 1px solid var(--line); background: var(--panel); }
  .fx-mrow { display: grid; grid-template-columns: minmax(140px, 1.2fr) 170px auto minmax(0, 1.6fr) 14px; gap: 14px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); font-size: 13px; color: var(--text); }
  .fx-mrow:last-child { border-bottom: 0; } .fx-mrow:hover { background: var(--panel-2); } .fx a.fx-mrow:focus-visible, .fx a.op-stat:focus-visible, .fx .fx-wjob a:focus-visible { outline: 1px solid var(--green); outline-offset: -1px; }
  .fx-mrow .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .fx-mrow .nm b { font-weight: 600; } .fx-mrow .nm span { margin-left: 6px; font-size: 12px; color: var(--dim); }
  .fx-stage { display: flex; align-items: center; gap: 8px; font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--fx-c); }
  .fx-mrow .note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--dim); } .fx-mrow .go { color: var(--green); }
  .fx-maint { font-size: 12.5px; color: var(--green); } .fx-maint:hover { text-decoration: underline; }
  .fx-mempty { margin: 0; padding: 12px 16px; font-size: 13px; color: var(--dim); }
  .fx-lockline { margin-top: 12px; font-size: 12px; }
  @media (max-width: 720px) {
    .fx { padding-top: 0; }
    .fx .op-hero { font-size: 30px; }
    .fx-mrow { grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; } .fx-mrow .note { grid-column: 1 / -1; } .fx-mrow .go { display: none; }
    /* The prompt keeps the width: its copy button goes under it. */
    .fx .op-code { flex-wrap: wrap; }
    /* On a phone the line wraps: its columns one under another, not a board to scroll sideways. */
    .fx-board { grid-template-columns: minmax(0, 1fr); min-width: 0; } .fx-col { min-height: 0; }
  }
`;

const SCRIPT = String.raw`
  // ---- the rules the page shares with the server: a name by the request's own PKGNAME (request.ts, spliced — never a copy), the line's columns.
  var NAME_RULE = ${String(PKGNAME)}, NAME_WORDS = ${JSON.stringify(PKGNAME_RULE)};
  var LINE = ${JSON.stringify(LINE)};
  // A worker reports its agent as "<provider>/<model>" (routes/factory.ts touchWorker): the provider's mark, where the kit has one.
  var AGENT_MARK = { "claude-code": "claude-color", anthropic: "claude-color", claude: "claude-color", openai: "openai", codex: "openai", gemini: "gemini-color", google: "gemini-color", xai: "grok", grok: "grok", cursor: "cursor", copilot: "githubcopilot", "github-copilot": "githubcopilot", opencode: "opencode", qwen: "qwen-color", kimi: "kimi", moonshot: "kimi", meta: "meta-color" };
  // Where a target stands, as a square's tone: built on the way to the pool, running, not supported (dashed), nothing in flight (hollow). The words are the shell's (TARGET_WORD).
  var SQUARE = { waiting: "wait", building: "run", reviewing: "run", built: "ok", reviewed: "ok", approved: "ok", published: "ok", not_supported: "na" };
  // The answers the page draws from, and why one did not come: the registry (the line, the tiles, your requests), the listing (the workers), the review list (what waits for a maintainer), the week's series (how long a job of a kind takes), the maintainer set.
  var REG = null, LISTING = null, REVIEW = null, STATS = null, MAINT = null, DOWN = { reg: "", listing: "", review: "" };
  // The registry answers its most recently updated rows (the server's PACKAGES_PAGE) and says when it stopped before the last (truncated): a number counted over it is then a floor, drawn "12+" as People draws it.
  var REG_CUT = false;
  // Where each package stood when the line was last drawn, and when a card moved: a card that moved is lit for a moment (the kit's op-fresh).
  var SEEN = {}, SEEN_REVIEW = false, FRESH = {}, SIG = null, AGAIN = null, READY = null, REVIEWING = null;
  var ON = {}; ARCHES.forEach(function (a) { ON[a] = true; });
  var params = new URLSearchParams(location.search);
  // A renewal (?renew=<name>, from "Renew the request" on the package's rows): the same card, filled from the record. A name brought here (?name=, the ⌘K menu's Request "<name>"): the card's name, as given — a pacman name only.
  var RENEW = params.get("renew"), NAMED = params.get("name") || "";
  if (!NAME_RULE.test(RENEW || "")) RENEW = null;
  if (!NAME_RULE.test(NAMED)) NAMED = "";

  function val(sel) { var el = $(sel); return el && el.value ? String(el.value).trim() : ""; }
  function nameOf() { return val("#fx-name").toLowerCase(); }
  function archesOn() { return ARCHES.filter(function (a) { return ON[a]; }); }
  // An address as a person pastes it, the scheme added when there is none — the server's normaliseUrl (routes/sources.ts) says the same.
  function urlOf() { var u = val("#fx-url"); return u && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? "https://" + u : u; }
  function since(iso) { return iso ? ago(iso).replace(" ago", "") : ""; }
  // What a field's check says: a few words in the slot beside its label, the whole reason on hover — and, where the few words are not enough to act on, in the line under the field (the field's description, so a screen reader reads it with it).
  function said(sel, box, text, tone, title, why) {
    var el = $(sel); if (el) { el.className = "fx-say" + (tone ? " " + tone : ""); el.innerHTML = text; el.title = title || ""; }
    var b = box ? $(box) : null; if (b) b.className = "fx-in" + (tone ? " " + tone : "");
    var w = $(sel.replace("-say", "-why")); if (w) { w.textContent = why || ""; w.hidden = !why; w.className = "fx-why" + (tone === "bad" || tone === "warn" ? " " + tone : ""); }
  }

  // ---- the name: its rule first, in the page (PKGNAME), then the server's word on it (GET /factory/names/:name — the request's own rule over the registry, the approvals, the builds and the sources), asked once per name and architectures, a quarter of a second after the typing stops.
  // SENT: the names this page sent and the pool reserved, the reader's from that answer on — the check's own answer is thirty seconds old at the edge, and said "available" of the name just reserved.
  var NAMES = {}, SENT = {}, nameTimer = null, NAME_STATE = null;
  function checkName() {
    var n = nameOf(); clearTimeout(nameTimer);
    if (!n) { NAME_STATE = null; said("#fx-name-say", "#fx-name-box", "", ""); return ready(); }
    if (!NAME_RULE.test(n)) return nameSays({ name: n, state: "invalid" });
    if (SENT[n]) return nameSays(SENT[n]);
    var key = n + "?" + archesOn().join(",");
    if (NAMES[key]) return nameSays(NAMES[key]);
    nameSays({ name: n, state: "checking" });
    nameTimer = setTimeout(function () {
      api("GET", "/api/v1/factory/names/" + encodeURIComponent(n) + "?arches=" + archesOn().join(",")).then(function (d) {
        if (d.error) throw new Error(d.error);
        NAMES[key] = d; if (nameOf() === n) nameSays(d);
      }).catch(function (e) { if (nameOf() === n) nameSays({ name: n, state: "unknown", why: errorText(e) }); });
    }, 250);
  }
  // What the check says, in the handoff's words: available, taken (linked to its page), reserved by a pending request, invalid characters — and the holder's own name as theirs. The title is the request's refusal, word for word; the line under the field says it where the slot's words do not tell the reader what to do.
  function nameSays(d) {
    NAME_STATE = d;
    var n = d.name, own = !!d.owner && d.owner === WHO.login && d.state !== "blocked";
    // What a source ships of the name on the architectures asked (the check's provided): the request skips those and builds the rest.
    var skip = (d.provided || []).filter(function (p) { return archesOn().indexOf(p.arch) >= 0; });
    var skipWhy = skip.map(function (p) { return p.source + " ships " + p.version + " for " + p.arch; }).join(" · ");
    if (d.state === "invalid") said("#fx-name-say", "#fx-name-box", "✗ invalid characters", "bad", "a pacman name: " + NAME_WORDS);
    else if (d.state === "checking") said("#fx-name-say", "#fx-name-box", "⟳ checking", "run");
    else if (d.state === "unknown") said("#fx-name-say", "#fx-name-box", "could not check", "", d.why, "The check did not answer (" + d.why + "); sending still checks the name.");
    else if (own) said("#fx-name-say", "#fx-name-box", d.renew ? "✗ yours · can't renew now" : "✓ yours · sending renews the request", d.renew ? "warn" : "ok", d.renew || "", d.renew || "");
    else if (d.state === "available") said("#fx-name-say", "#fx-name-box", "✓ available" + (skip.length ? " · " + esc(skip.map(function (p) { return p.arch; }).join(", ")) + " skipped" : d.freed === "rejected" ? " · freed by a review" : d.freed === "unmaintained" ? " · unmaintained, yours to take over" : ""), "ok", skipWhy, skipWhy ? skipWhy + ": the request builds the other architectures." : "");
    else if (d.state === "reserved") said("#fx-name-say", "#fx-name-box", "✗ reserved by a pending request", "warn", d.why);
    // Taken: linked to the package in edge where edge serves it (the check's in_edge) — a name in the pool by an approval alone may be in no ring, and a link naming one would say what no fact does.
    else if (d.state === "taken") {
      var inEdge = (d.in_edge || []).filter(function (a) { return archesOn().indexOf(a) >= 0; }).concat(d.in_edge || [])[0];
      said("#fx-name-say", "#fx-name-box", inEdge ? '<a href="' + esc(pkgHref(n, "edge", inEdge)) + '">✗ taken · open it ›</a>' : "✗ taken", "bad", d.why);
    }
    else if (d.state === "blocked") said("#fx-name-say", "#fx-name-box", "✗ blocked by a maintainer", "bad", d.why);
    else said("#fx-name-say", "#fx-name-box", "✗ being built now", "warn", d.why);
    ready(); signInLink();
  }
  // Whether the name may be sent: available, or the reader's own and renewable.
  function nameOk() { var d = NAME_STATE; return !!d && (d.state === "available" || (!!d.owner && d.owner === WHO.login && d.state !== "blocked" && !d.renew)); }

  // ---- the source: what the address says, and for a person signed in what the repository says (GET /factory/source — the request's own detect() on GitHub, GitLab's and Codeberg's APIs), half a second after the typing stops. What it read fills the fields nobody typed in; a field it filled follows the next repository read.
  var READS = {}, urlTimer = null, AUTO = {};
  function readUrl() {
    var u = urlOf(); clearTimeout(urlTimer);
    if (!u) { urlSays(null); return; }
    if (READS[u]) { urlSays(READS[u]); return; }
    urlSays({ reading: true });
    urlTimer = setTimeout(function () {
      api("GET", "/api/v1/factory/source?url=" + encodeURIComponent(u)).then(function (d) { if (!d.__status || d.__status < 400) READS[u] = d; if (urlOf() === u) urlSays(d); })
        .catch(function (e) { if (urlOf() === u) urlSays({ error: errorText(e) }); });
    }, 500);
  }
  function fill(sel, value) {
    var el = $(sel); if (!el || !value) return;
    if (!val(sel) || AUTO[sel] === el.value) { el.value = value; AUTO[sel] = value; }
  }
  function urlSays(d) {
    var found = $("#fx-found"), icon = $("#fx-url-icon");
    if (icon) icon.innerHTML = lucide(d && d.forge && d.forge !== "GitHub" ? "git-fork" : "github", 15);
    if (!d) { said("#fx-url-say", "#fx-url-box", "", ""); if (found) found.hidden = true; return prompt(); }
    if (d.reading) said("#fx-url-say", "#fx-url-box", "⟳ reading…", "run");
    else if (d.error) said("#fx-url-say", "#fx-url-box", "✗ not usable", "bad", d.error, d.error);
    else if (d.read) said("#fx-url-say", "#fx-url-box", "✓ found on " + esc(d.forge), "ok");
    else if (d.forge) said("#fx-url-say", "#fx-url-box", "✓ " + esc(d.forge), "", d.why, d.why);
    else { said("#fx-url-say", "#fx-url-box", "name the release below", "warn", d.why); var more = $("#fx-more"); if (more) more.open = true; }
    if (found) {
      found.hidden = !d.read;
      if (d.read) found.innerHTML = [
        '<span><b class="ok">✓</b>repository is public' + (d.archived ? ' · <b class="warn">archived</b>' : '') + '</span>',
        d.license ? '<span><b class="ok">✓</b>licence: ' + esc(d.license) + '</span>' : '<span><b class="warn">✗</b>no licence found: name it</span>',
        d.version ? '<span><b class="ok">✓</b>latest release ' + esc(d.version) + '</span>' : '<span><b class="bad">✗</b>no release or tag yet</span>'
      ].join("");
    }
    // The name from the address, the rest from the repository — only where nobody typed.
    if (d.name) { fill("#fx-name", d.name); checkName(); }
    if (d.read) {
      fill("#fx-license", d.license);
      fill("#fx-desc", d.description ? String(d.description).slice(0, 120) : "");
      // Off GitHub the request builds the release the form names: the reading names it.
      if (d.send && d.send.source) { fill("#fx-source", d.send.source); fill("#fx-version", d.send.version); }
    }
    prompt(); ready(); signInLink();
  }

  // ---- the architectures: one toggle each, from ARCHES (meta.ts, spliced by the shell); a name's check is for the ones asked.
  document.querySelectorAll("#fx-form [data-arch]").forEach(function (b) {
    b.addEventListener("click", function () { var a = b.getAttribute("data-arch"); ON[a] = !ON[a]; b.setAttribute("aria-pressed", ON[a] ? "true" : "false"); checkName(); prompt(); });
  });

  // ---- the two tabs: the form, or the prompt for the reader's own agent — the prompt is the form's fields in a sentence.
  function tab(form) {
    var tf = $("#tab-form"), ta = $("#tab-agent");
    if (tf) { tf.setAttribute("aria-selected", form ? "true" : "false"); tf.setAttribute("tabindex", form ? "0" : "-1"); }
    if (ta) { ta.setAttribute("aria-selected", form ? "false" : "true"); ta.setAttribute("tabindex", form ? "-1" : "0"); }
    $("#fx-form").hidden = !form; $("#fx-agent").hidden = form;
    if (!form) prompt();
  }
  [["#tab-form", true], ["#tab-agent", false]].forEach(function (t) {
    var el = $(t[0]); if (!el) return;
    el.addEventListener("click", function () { tab(t[1]); });
    // The tablist's keys: an arrow to the other tab, Home to the first, End to the last.
    el.addEventListener("keydown", function (ev) {
      var to = ev.key === "ArrowRight" || ev.key === "ArrowLeft" ? !t[1] : ev.key === "Home" ? true : ev.key === "End" ? false : null;
      if (to === null) return;
      ev.preventDefault(); tab(to); var go = $(to ? "#tab-form" : "#tab-agent"); if (go && go.focus) go.focus();
    });
  });
  function prompt() {
    var on = archesOn(), el = $("#fx-prompt"); if (!el) return;
    var archText = on.length === ARCHES.length ? ARCHES.join(" and ") : on.length ? on.join(" and ") + " only" : "<architectures>";
    el.textContent = "Request " + (nameOf() || "<name>") + " on omarchy-pool: source " + (urlOf() || "<repository URL>") + ", licence " + (val("#fx-license") || "<licence>") + ", " + archText + ". Follow it until it is ready for review, and tell me if a build fails.";
  }

  // ---- sending: the sign-in for nobody — the card kept for the way back (the name in the address, the rest in this tab's session storage, drawn again on return) and the card itself the landing (#request) —, the POST for a person. Sending reserves the name (reserveName, one statement): the server is the judge, the page only says what is missing first.
  var FIELDS = ["#fx-name", "#fx-url", "#fx-license", "#fx-desc", "#fx-source", "#fx-version"], DRAFT = "omarchy-pool:factory-draft";
  // The tab's session storage, or none where the browser refuses it (a private window, site data blocked): the card then comes back with its name only.
  var STORE = (function () { try { return window.sessionStorage || null; } catch (e) { return null; } })();
  function signInLink() {
    var a = $("#fx-send"); if (!a || WHO.me) return;
    var n = nameOf(), next = "/factory" + (NAME_RULE.test(n) ? "?name=" + encodeURIComponent(n) : location.search) + "#request";
    a.setAttribute("href", "/auth/github?next=" + encodeURIComponent(next).replace(/%2F/g, "/"));
  }
  function keepDraft() {
    var d = { arches: archesOn(), checks: checklist(), more: !!($("#fx-more") && $("#fx-more").open) };
    FIELDS.forEach(function (f) { d[f] = val(f); });
    try { if (STORE) STORE.setItem(DRAFT, JSON.stringify(d)); } catch (e) {}
  }
  // The card as it was before the sign-in, once: every field, the architectures, the confirmations ticked — then the draft is gone.
  function draftBack() {
    var d = null;
    try { d = STORE ? JSON.parse(STORE.getItem(DRAFT) || "null") : null; if (STORE) STORE.removeItem(DRAFT); } catch (e) { d = null; }
    if (!d || typeof d !== "object") return false;
    FIELDS.forEach(function (f) { var el = $(f); if (el && typeof d[f] === "string" && d[f]) el.value = d[f]; });
    if (Array.isArray(d.arches) && d.arches.length) { ARCHES.forEach(function (a) { ON[a] = d.arches.indexOf(a) >= 0; }); pressed(); }
    document.querySelectorAll("#fx-checklist input[data-check]").forEach(function (i) { i.checked = !!(d.checks && d.checks[i.getAttribute("data-check")]); });
    if (d.more && $("#fx-more")) $("#fx-more").open = true;
    return true;
  }
  function pressed() { document.querySelectorAll("#fx-form [data-arch]").forEach(function (b) { b.setAttribute("aria-pressed", ON[b.getAttribute("data-arch")] ? "true" : "false"); }); }
  function checklist() { var c = {}; document.querySelectorAll("#fx-checklist input[data-check]").forEach(function (i) { c[i.getAttribute("data-check")] = i.checked; }); return c; }
  // A project off GitHub is built from the release the card names (the request refuses it without both); a GitLab or Codeberg read fills them in.
  function offGitHub() { var u = urlOf(); return !!u && !/^https:\/\/(www\.)?github\.com\//i.test(u); }
  function missingOf() {
    var d = val("#fx-desc"), c = checklist(), n = NAME_STATE;
    // The name's check still out, or failed: the server decides on sending; a name the check refused is not sent.
    if (nameOf() && n && n.state === "checking") return "One moment: the name is being checked.";
    if (nameOf() && n && n.state !== "unknown" && !nameOk()) return "Pick a name that is available.";
    if (!urlOf()) return "Add the repository's address.";
    if (offGitHub() && (!val("#fx-source") || !val("#fx-version"))) return "Name the release: its source and its version.";
    if (!val("#fx-license")) return "Add the licence, an SPDX identifier.";
    if (!archesOn().length) return "Pick at least one architecture.";
    if (d.length < 8) return "Add the description: one line, 8 to 120 characters.";
    if (Object.keys(c).some(function (k) { return !c[k]; })) return "Tick every confirmation above.";
    return "";
  }
  function ready() { var b = $("#fx-send"); if (b && WHO.me && b.classList) b.classList.toggle("primary", !missingOf() && (nameOk() || !nameOf())); }
  function state(text, bad) { var el = $("#fx-state"); if (el) { el.textContent = text; el.className = "fx-state" + (bad ? " bad" : ""); } }
  // While the POST is out the button says so (aria-disabled) and keeps the focus: a disabled button drops it to the page's top.
  var SENDING = false;
  function send() {
    if (SENDING) return;
    var miss = missingOf(); if (miss) { state(miss, true); if (/^Name the release/.test(miss) && $("#fx-more")) $("#fx-more").open = true; return; }
    var body = { url: urlOf(), description: val("#fx-desc"), license: val("#fx-license"), arches: archesOn(), checklist: checklist() };
    if (nameOf()) body.name = nameOf();
    if (val("#fx-source")) body.source = val("#fx-source");
    if (val("#fx-version")) body.version = val("#fx-version");
    var btn = $("#fx-send"); SENDING = true; btn.setAttribute("aria-disabled", "true"); state("Checking the pool, the project and the source…"); $("#fx-done").hidden = true;
    api("POST", "/api/v1/factory/packages", body).then(function (d) {
      SENDING = false; btn.setAttribute("aria-disabled", "false");
      if (d.error) { state(d.error, true); return; }
      state("");
      var p = d.package || {}, b = d.build || {}, q = d.request || {}, detected = {};
      try { detected = typeof p.detected === "string" ? JSON.parse(p.detected) || {} : p.detected || {}; } catch (e) { detected = {}; }
      $("#fx-done").hidden = false;
      $("#fx-done").innerHTML = '<span class="fx-sent">' + lucide("circle-check", 15) + '<span><b>' + esc(p.name) + '</b> ' + esc(p.release || "") + ' sent · name reserved · <a href="' + esc(q.record) + '">request #' + esc(q.id) + '</a>' + (q.signature ? ' (<a href="' + esc(q.signature) + '">signature</a>)' : '') + (detected.build_system && detected.build_system !== "unknown" ? ' · ' + esc(detected.build_system) + ' detected' : '') + '</span></span>'
        + (b.tasks && b.tasks.length ? '<span>' + taskPill("queued") + ' build ' + b.tasks.map(function (t) { return '<a href="/build/' + t + '">#' + t + '</a>'; }).join(", ") + ' for ' + esc((b.arches || []).join(", ")) + (b.queue ? ' · ' + esc(Object.keys(b.queue).map(function (a) { return a + ": " + b.queue[a].position + " of " + b.queue[a].total + " in the shared queue"; }).join(" · ")) : '') + '</span>' : b.error ? '<span class="warn">not queued: ' + esc(b.error) + '</span>' : '')
        + (d.skipped && d.skipped.length ? '<span class="dim">' + esc(d.skipped.map(function (s) { return s.arch + " skipped: " + s.source + " ships " + s.version; }).join(" · ")) + '</span>' : '')
        + '<span class="fx-follow"><a href="#line">Follow it on the line ›</a><a href="' + userHref(WHO.login) + '">Your page →</a></span>';
      // The name is the reader's now, whatever the check's copy at the edge still says.
      if (p.name) SENT[p.name] = { name: p.name, state: "reserved", owner: WHO.login, status: p.status, renew: null, why: p.name + " is " + p.status + ", requested by " + WHO.login, provided: [] };
      // The card on the line at once — the POST's own registration, its targets settled — as a registry row: not landed (the request refuses a name in the pool). The registry's copy at the edge is thirty seconds old at most: read again once it has gone.
      if (p.name) {
        var row = { name: p.name, owner: p.owner, status: p.status, release: p.release, detail: p.detail, targets: d.targets || p.targets || {}, updated_at: p.updated_at || new Date().toISOString(), blocked_at: null, landed: false };
        JUST[p.name] = row; REG = withJust(REG || []); FRESH[p.name] = Date.now(); draw();
        clearTimeout(AGAIN); AGAIN = setTimeout(loadRegistry, 35000);
      }
      // The card starts over: the fields, the confirmations, every architecture on, and a renewal's heading and button back to a request's.
      FIELDS.forEach(function (s) { var el = $(s); if (el) el.value = ""; });
      document.querySelectorAll("#fx-checklist input[data-check]").forEach(function (i) { i.checked = false; });
      ARCHES.forEach(function (a) { ON[a] = true; }); pressed();
      if (RENEW) {
        RENEW = null; $("#fx-head").textContent = "Request a package"; btn.textContent = "Send request";
        // The address without ?renew=: a reload draws a new request's card, not the renewal again.
        if (window.history && window.history.replaceState) window.history.replaceState(null, "", location.pathname + location.hash);
      }
      NAMES = {}; AUTO = {}; checkName(); urlSays(null); prompt(); ready();
      // What was sent is read out and the focus goes there, not back to the top of the page.
      if ($("#fx-done").focus) $("#fx-done").focus();
    }).catch(function (e) { SENDING = false; btn.setAttribute("aria-disabled", "false"); state("failed: " + errorText(e), true); });
  }
  // A renewal, filled from the record (the package's story): the fields as the record has them, the lines the checks marked, the confirmations the reader's to tick again.
  function prefill(name) {
    fetch("/api/v1/factory/packages/" + encodeURIComponent(name) + "/story?t=" + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).then(function (st) {
      if (!st || !st.package) return;
      var p = st.package, q = st.request || {};
      $("#fx-head").textContent = "Renew the request for " + name;
      var btn = $("#fx-send"); if (btn) btn.textContent = "Renew the request";
      // The project as its home; the version and the source as the record names them (a GitHub project too: otherwise the request would take the latest tag, and the staged build would be of another version).
      $("#fx-url").value = p.project || p.url || "";
      $("#fx-name").value = name; $("#fx-desc").value = p.description || ""; $("#fx-license").value = p.license || "";
      var arches = q.arches && q.arches.length ? q.arches : (p.arches || []);
      ARCHES.forEach(function (a) { ON[a] = arches.indexOf(a) >= 0; });
      pressed();
      var known = q.version && q.version !== "unknown";
      $("#fx-version").value = known ? q.version : "";
      $("#fx-source").value = known && p.source && p.source !== p.project ? p.source : "";
      // Off GitHub the release is the card's to name: its fields open, filled or not.
      if ($("#fx-version").value || $("#fx-source").value || offGitHub()) $("#fx-more").open = true;
      var bad = q.checks ? q.checks.filter(function (c) { return !c.ok; }) : [];
      state(bad.length ? "The record's lines to put right: " + bad.map(function (c) { return c.item + " (" + c.note + ")"; }).join(" · ") : "");
      checkName(); prompt();
    }).catch(function () {});
  }

  // ---- the workers: every one alive, busy first — its agent's mark, its job and step from the listing's task, and how far it is against what a job of its kind took this week (the stats series: the jobs' and the builds' time, per kind).
  function markOf(agent) { var prov = String(agent || "").split("/")[0].toLowerCase(); return AGENT_MARK[prov] || null; }
  function taskOf(id) { var ts = (LISTING && LISTING.tasks) || []; for (var i = 0; i < ts.length; i++) if (ts[i].id === id) return ts[i]; return null; }
  function stepOf(t) {
    var p = t.params || {}, tries = t.attempts > 1 ? " · try " + t.attempts + " of " + t.max_attempts : "", ref = String(t.pkgbuild_ref || "");
    if (t.kind === "build" && t.trust === "project") return (p.review ? "rebuilding from scratch" : "building") + " on " + t.arch + tries;
    if (t.kind === "build") return (ref.indexOf("draft:") === 0 ? "writing the PKGBUILD" : ref.indexOf("bump:") === 0 ? "building the new version" : "building") + " on " + t.arch + tries;
    if (t.kind === "audit") return "auditing build #" + (p.task || "?");
    if (t.kind === "trial") return "installing it in the lab";
    if (t.kind === "publish") return "publishing it into edge";
    // A pool job: what it works on — a sync its sources, a ring's jobs the ring.
    var sources = p.sources; try { sources = typeof sources === "string" ? JSON.parse(sources) : sources; } catch (e) { sources = null; }
    var on = Array.isArray(sources) ? sources.map(function (x) { return x && x.source; }).filter(Boolean).join(", ") : p.to || p.ring || p.source || "";
    return (t.name !== t.kind ? t.kind + " · " : "") + (on || "running") + tries;
  }
  function typicalMs(t) {
    var s = (STATS && STATS.series) || {}, n = 0, ms = 0, rows = t.kind === "build" ? s.builds_daily : s.jobs_daily;
    (rows || []).forEach(function (r) { if ((t.kind === "build" ? r.trust === t.trust : r.kind === t.kind) && (r.status === "done" || r.status === "staged")) { n += Number(r.n || 0); ms += Number(r.ms || 0); } });
    return n && ms ? ms / n : null;
  }
  function progressOf(t) {
    if (!t || !t.started_at) return { pct: null, title: "running" };
    var el = Math.max(0, Date.now() - Date.parse(t.started_at)), typ = typicalMs(t), mins = Math.max(1, Math.round(el / 60000));
    if (!typ) return { pct: null, title: "running " + mins + " min · nothing of its kind finished this week to measure it against" };
    return { pct: Math.min(95, Math.round(100 * el / typ)), title: "running " + mins + " min · a " + t.kind + " like it takes about " + Math.max(1, Math.round(typ / 60000)) + " min this week" };
  }
  function workerRowOf(w) {
    var t = w.current_task ? taskOf(w.current_task) : null, mark = markOf(w.agent), model = w.agent ? String(w.agent).split("/").slice(1).join("/") || w.agent : "";
    var box = '<span class="fx-wbox">' + (mark ? agentMark(mark, w.agent, 22) : '<span title="' + esc(w.agent || "no agent reported") + '">—</span>') + '</span>';
    var top = '<div class="fx-wtop"><span>' + workerName(w) + ' · ' + esc(w.arch) + '</span><span title="' + esc(w.agent || "no agent reported") + '">' + esc(model || "—") + '</span></div>';
    // Alive but not ready — what it declares needs an agent that did not answer (the listing's ready, the pool's workerReady; the shell's words for why, the agent's own error on hover), as the Workers page's failed pill says it: never "idle, waiting for work" (#273). It is handed no agent work — no draft, no audit — until its agent answers; work that needs none (a contributor's plain build) still comes.
    if (!w.current_task && !w.ready) { var why = wtNotReady(w); return '<div class="fx-wrow notready">' + box + '<div class="fx-wmain">' + top + '<div class="fx-wjob" title="' + esc(why) + '"><i class="fx-wmark" aria-hidden="true"></i><b>not ready</b><span class="fx-step">' + esc(why) + '</span></div><div class="fx-bar"><i style="width:0%"></i></div></div></div>'; }
    if (!w.current_task) return '<div class="fx-wrow idle">' + box + '<div class="fx-wmain">' + top + '<div class="fx-wjob"><b>idle</b><span class="fx-step">waiting for work</span></div><div class="fx-bar"><i style="width:0%"></i></div></div></div>';
    var p = progressOf(t);
    return '<div class="fx-wrow">' + box + '<div class="fx-wmain">' + top + '<div class="fx-wjob"><a href="/build/' + esc(w.current_task) + '"><b>' + esc(t ? t.name : "#" + w.current_task) + '</b></a><span class="fx-step">' + esc(t ? stepOf(t) : "running") + '</span></div>'
      + '<div class="fx-bar" title="' + esc(p.title) + '"><i' + (p.pct === null ? ' class="unknown"' : '') + ' style="width:' + (p.pct === null ? 100 : p.pct) + '%"></i></div></div></div>';
  }
  function drawWorkers() {
    var list = $("#fx-wlist"), head = $("#fx-busy"); if (!list) return;
    if (!LISTING) { if (DOWN.listing) { list.innerHTML = '<p class="fx-wempty">' + esc(DOWN.listing) + '</p>'; if (head) head.textContent = ""; } return; }
    // Busy first, then the ones not ready (what a maintainer looks at), then the idle.
    var rank = function (w) { return w.current_task ? 0 : w.ready ? 2 : 1; };
    var ws = (LISTING.workers || []).filter(function (w) { return w.alive && !w.revoked_at; }).sort(function (a, b) { return rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    var working = ws.filter(function (w) { return w.current_task; }).length, down = ws.filter(function (w) { return !w.current_task && !w.ready; }).length, shown = ws.slice(0, 6);
    if (head) head.textContent = num(working) + " busy · " + num(ws.length - working - down) + " idle" + (down ? " · " + num(down) + " not ready" : "");
    // The rest are counted, not linked: the card's foot is the way to every worker.
    list.innerHTML = (shown.length ? shown.map(workerRowOf).join("") + (ws.length > shown.length ? '<p class="fx-wempty">' + num(ws.length - shown.length) + ' more alive</p>' : '') : '<p class="fx-wempty">No worker is alive right now. A request waits in the queue until one is.</p>')
      // A refresh that did not answer leaves the last answer's rows, and says so.
      + (DOWN.listing ? '<p class="fx-wempty">' + esc(DOWN.listing) + '</p>' : '');
  }

  // ---- the line: where each package stands, from its targets (targets.ts — where each of its architectures stands, the server's one rule): building while an architecture builds, ready for review once it is built and nothing of it runs, in review while the project's rebuild is queued, running or staged, shipped once approved; checking while nothing of it is in flight. Rejected, blocked and unmaintained registrations are off the line, and so is a request whose every build failed after its tries: nothing of it moves until its owner renews it.
  var OFF = { rejected: 1, unmaintained: 1 }, SHIPPED = { approved: 1, published: 1 }, BUILT = { built: 1 }, CLAIMED = { reviewing: 1, reviewed: 1 }, RUNS = { building: 1, reviewing: 1 };
  // The one target word that says "in the pool" (targets.ts) — a target's, never the registry's status, and never a ring: where it is served is the approval's (approvalWhere).
  var IN_POOL = { published: 1 };
  function statuses(p) { var t = p.targets || {}; return Object.keys(t).map(function (a) { return t[a].status; }); }
  function allFailed(p) { var st = statuses(p); return st.length > 0 && st.every(function (s) { return s === "not_supported"; }); }
  function lineOf(p) {
    if (p.blocked_at || OFF[p.status]) return -1;
    var st = statuses(p), has = function (s) { return st.indexOf(s) >= 0; };
    if (has("building")) return 1;
    if (st.some(function (s) { return CLAIMED[s]; })) return 3;
    if (st.some(function (s) { return BUILT[s]; })) return 2;
    if (st.some(function (s) { return SHIPPED[s]; }) || (!st.length && p.landed)) return 4;
    if (allFailed(p)) return -1;
    return 0;
  }
  // The two review columns are Review's, word for word (#274): a package the review list names is filed by the list's own state (routes/review.ts, the one rule) — ready, waiting for a claim: Ready for review; in_review, from the claim until the decision, a new version building beside it too: In review; neither — a build of a version already approved, one whose gate or audit is not through yet —: in neither column, shipped once it landed, else still checking. One the list does not name (it holds the hundred newest staged builds), or before the list answered: its targets' place.
  function stageOf(p) {
    var s = lineOf(p), r = REVIEW && s >= 0 ? stateIn(p.name) : undefined;
    if (r === undefined) return s;
    if (r === "in_review") return 3;
    if (r === "ready") return 2;
    return s === 2 || s === 3 ? (p.landed ? 4 : 0) : s;
  }
  function stateIn(name) { var l = REVIEW.packages || []; for (var i = 0; i < l.length; i++) if (l[i].name === name) return l[i].state; return undefined; }
  // Whether a worker holds a build of the package right now — its contributor's or the project's: the live read's leased task behind one of its targets.
  function running(p) { var t = p.targets || {}; return Object.keys(t).some(function (a) { var x = taskOf(t[a].task); return RUNS[t[a].status] && !!x && x.status === "leased"; }); }
  // The architectures a card names: each one in the pool's order, with the shell's word for where it stands — and the faintest square for one nobody asked for. An approved one says where its approval stands today (approvalWhere's title), not the target's word, which promises edge of a publish that may have failed.
  function squares(p) {
    var t = p.targets || {}, a0 = standingOf(p);
    return '<span class="fx-sq">' + ARCHES.map(function (a) {
      var x = t[a], w = x ? TARGET_WORD[x.status] : null;
      var word = !x ? "not requested" : x.status === "approved" ? (a0 ? approvalWhere(a0).title : "approved by a maintainer") : w ? w[2] : x.status;
      return '<i class="op-arch ' + (x ? SQUARE[x.status] || "wait" : "off") + '" title="' + esc(a + " · " + word) + '"></i>';
    }).join("") + '</span>';
  }
  // The standing approval of a shipped package, as the approvals list says it (the row Review's Decided line reads): null until that list answered, or for one older than its page.
  function standingOf(p) { return APPROVED ? APPROVED[p.name] || null : null; }
  // What a card's build sent back by an emulated worker waits for (#281), in the shell's words: any of its targets standing at that status, not the first one only. The live read's row says it (waitsForNative); one past its twenty rows, the package's own detail, which the fail report wrote naming that task (routes/factory.ts, handleFail). "" when none waits.
  function nativeWait(p, status) {
    var t = p.targets || {}, d = String(p.detail || "");
    return Object.keys(t).map(function (a) {
      var x = t[a]; if (x.status !== status || !x.task) return "";
      var r = taskOf(x.task); if (r) return waitsForNative(r);
      return d.indexOf("(task " + x.task + ")") >= 0 && d.indexOf("native " + a + " worker") >= 0 ? "waiting for a native " + a + " worker" : "";
    }).filter(Boolean)[0] || "";
  }
  // A card's line: what is happening to it now, in a few words — the running job's step from the listing, what is built and what is not supported; a shipped one where its approval stands today, in the shell's one word (approvalWhere: its rings, blocked, publish failed or cancelled, publishing). Its tone: "" (dim), warn or bad.
  function noteOf(p, s) {
    var t = p.targets || {}, arches = Object.keys(t), ns = arches.filter(function (a) { return t[a].status === "not_supported"; });
    var off = ns.length ? ns.join(", ") + " not supported" : "";
    if (s === 0) return [arches.some(function (a) { return BUILT[t[a].status]; }) ? "built · not ready yet" : "on the record · no build yet", ""];
    if (s === 1) {
      var run = arches.filter(function (a) { return t[a].status === "building"; }).map(function (a) { return taskOf(t[a].task); }).filter(Boolean)[0], wb = nativeWait(p, "building");
      var doing = wb || (run ? (run.status === "leased" ? stepOf(run) : "queued for a worker") : "queued for a worker");
      return [(off ? off + " · " : "") + doing, off || wb ? "warn" : ""];
    }
    if (s === 2) {
      var built = arches.filter(function (a) { return BUILT[t[a].status]; });
      return [(built.length === arches.length && arches.length > 1 ? "built on every architecture" : built.join(", ") + " built") + (off ? " · " + off : ""), off ? "warn" : ""];
    }
    // In review: the project's rebuild running, or staged for a maintainer's decision — or a new version building while the claim on the last one stands. Short enough for the card's one line at 1024.
    // The project's rebuild an emulated worker sent back says what it waits for (nativeWait, #281).
    if (s === 3) { var at = function (w) { return arches.some(function (a) { return t[a].status === w; }); }, wn = nativeWait(p, "reviewing"); return [(wn ? wn : at("reviewing") ? "project rebuilding" : at("building") ? "new version building" : "rebuild staged") + (off ? " · " + off : ""), wn ? "warn" : ""]; }
    var a = standingOf(p);
    if (a) { var where = approvalWhere(a); return [where.word + (off ? " · " + off : ""), where.cls === "error" ? "bad" : ""]; }
    // No row to read yet: the targets' own word — in the pool once published; an approval alone promises nothing of its publish.
    return [(arches.some(function (x) { return IN_POOL[t[x].status]; }) ? TARGET_WORD.published[2] : "approved by a maintainer") + (off ? " · " + off : ""), ""];
  }
  // Where a card leads: a package on its way, its page as the lab has it; a shipped one, the most stable ring its approval says serves it — and, served by none, its build, as Review's Decided line leads: never a package address naming a ring no fact supports (the card said edge of a publish that failed).
  function hrefOf(p, s) {
    var t = p.targets || {}, arch = Object.keys(t)[0] || ARCHES[0];
    if (s !== 4) return pkgHref(p.name, "lab", arch);
    var a = standingOf(p), rings = a ? a.rings || [] : [];
    if (rings.length) return pkgHref(p.name, ringName(servedRing(rings)), a.arch || arch);
    var task = a ? a.task_id : (t[arch] || {}).task;
    return task ? "/build/" + task : pkgHref(p.name, "lab", arch);
  }
  function cardOf(p, s) {
    var note = noteOf(p, s);
    // The owner's initials are a picture of the name beside them: hidden from a screen reader, which reads the card as name, version, owner, line.
    return '<a class="fx-card' + (FRESH[p.name] && Date.now() - FRESH[p.name] < 1600 ? " op-fresh" : "") + '" href="' + esc(hrefOf(p, s)) + '">'
      + '<span class="fx-c1"><span><b>' + esc(p.name) + '</b><span class="v">' + esc(p.release || "") + '</span></span><span class="age" title="' + esc(p.updated_at || "") + '">' + esc(since(p.updated_at)) + '</span></span>'
      + '<span class="fx-c2"><span class="fx-by">' + (p.owner ? '<span aria-hidden="true">' + avatarIcon(p.owner) + '</span>' : "") + '<span>' + esc(p.owner || "—") + '</span></span>' + squares(p) + '</span>'
      + '<span class="fx-note' + (note[1] ? " " + note[1] : "") + '" title="' + esc(note[0]) + '">' + esc(note[0]) + '</span></a>';
  }
  var COUNTS = null;
  function drawBoard() {
    if (!REG) { if (DOWN.reg) { $("#line-note").textContent = DOWN.reg; for (var i = 0; i < LINE.length; i++) { $("#col-" + i + "-n").textContent = "—"; } } return; }
    // A refresh that did not answer leaves the last answer's cards, and says so.
    $("#line-note").textContent = DOWN.reg || "live · a card moves when its job ends";
    // The first drawing with the review list is a first drawing too: a card the list files in another column did not move.
    var cols = [[], [], [], [], []], now = Date.now(), first = !Object.keys(SEEN).length || SEEN_REVIEW !== !!REVIEW;
    SEEN_REVIEW = !!REVIEW;
    REG.forEach(function (p) {
      var s = stageOf(p);
      // A card that moved, or one that arrived after the first drawing, is lit a moment and kept at the top of its column for a minute.
      if (!first && SEEN[p.name] !== s && s >= 0) FRESH[p.name] = now;
      SEEN[p.name] = s;
      if (s >= 0) cols[s].push(p);
    });
    var older = function (a, b) { return String(a.updated_at || "") < String(b.updated_at || "") ? -1 : 1; };
    // The queue's order, oldest first — but what just moved and the reader's own come first, so "Follow it on the line" finds it.
    var pinned = function (p) { return (FRESH[p.name] && now - FRESH[p.name] < 60000) || (WHO.login && p.owner === WHO.login) ? 1 : 0; };
    cols.forEach(function (list, i) {
      list.sort(i === 4 ? function (a, b) { return older(b, a); } : function (a, b) { return pinned(b) - pinned(a) || older(a, b); });
      // A column counts its own cards: a shipped package being built again is a card in the column it is in, and only there.
      var shown = list.slice(0, 5);
      $("#col-" + i + "-n").textContent = num(list.length);
      $("#col-" + i).innerHTML = list.length ? shown.map(function (p) { return cardOf(p, i); }).join("") + (list.length > shown.length ? '<span class="fx-more-n">+' + num(list.length - shown.length) + (i === 4 ? " earlier" : " more") + '</span>' : '') : '<p class="fx-none">nothing here now</p>';
    });
    var onLine = cols[0].concat(cols[1], cols[2], cols[3]);
    COUNTS = {
      line: onLine.length,
      // On the line again: a shipped package with a new version on its way — in the factory and shipped both, and said so under the tile.
      again: onLine.filter(function (p) { return p.landed; }).length,
      running: LISTING ? onLine.filter(running).length : null,
      queued: LISTING ? cols[1].filter(function (p) { return !running(p); }).length : null,
      landed: REG.filter(function (p) { return p.landed; })
    };
    // What waits for a maintainer is the review list's own count (one truth with Review's tile): read again when the targets move a package into, out of or between the two review columns — a claim —, never on a clock. The targets' place, not the list's: the list's own answer never asks for itself again.
    var inReview = REG.map(function (p) { var s = lineOf(p); return s === 2 || s === 3 ? p.name + ":" + s : ""; }).filter(Boolean).sort().join(",");
    if (READY !== null && inReview !== READY) { clearTimeout(REVIEWING); REVIEWING = setTimeout(loadReview, 1500); }
    READY = inReview;
    // Where a shipped card's approval stands is the approvals list's: read when the Shipped column changes, never on a clock.
    var shipped = cols[4].map(function (p) { return p.name + ":" + statuses(p).join("/"); }).sort().join(",");
    if (shipped !== SHIPPED_SIG) { SHIPPED_SIG = shipped; if (shipped) loadApprovals(); }
  }

  // ---- the four numbers: the line's own counts, the builds a worker holds now (the live read), the review list's ready (Review's own tile: waiting for a claim), the registry's landed (approved by a maintainer — the Pool's and People's word). A list that did not answer reads "—", its reason on hover.
  var LANDED_ONCE = {};
  function atLeast(n) { return num(n) + "+"; }
  function tile(key, row, why) {
    var n = $("#t-" + key + "-n"), s = $("#t-" + key + "-s"); if (!n || !s) return;
    if (!row) { if (why) { n.textContent = "—"; s.innerHTML = '<span title="' + esc(why) + '">did not answer</span>'; } return; }
    if (!LANDED_ONCE[key]) { LANDED_ONCE[key] = true; countUp(n, row[3], row[4]); } else n.textContent = row[4] ? row[4](row[3]) : row[1];
    n.title = row[5] || "";
    s.innerHTML = row[2];
  }
  function drawTiles() {
    var wc = LISTING ? workerCounts(LISTING.workers || []) : null, from = {};
    if (COUNTS) COUNTS.landed.forEach(function (p) { if (p.owner && MAINT && !Object.prototype.hasOwnProperty.call(MAINT, p.owner)) from[p.owner] = 1; });
    tile("line", COUNTS ? ["In the factory", num(COUNTS.line), "requests on the line" + (COUNTS.again ? " · " + num(COUNTS.again) + " of them new versions" : ""), COUNTS.line] : null, DOWN.reg);
    // Building now is what workers hold at this moment; the Building column's other cards wait in the queue.
    tile("building", COUNTS && wc && COUNTS.running !== null ? ["Building now", num(COUNTS.running), num(COUNTS.queued) + " queued · " + num(wc.building) + " of " + num(wc.alive) + " workers busy", COUNTS.running] : null, DOWN.reg || DOWN.listing);
    // Ready for review is Review's own tile, word for word: the list's ready, waiting for a claim — a package claimed is in review on both pages, never counted here (#274).
    tile("ready", REVIEW ? ["Ready for review", num(REVIEW.ready), "waiting for a claim", REVIEW.ready] : null, DOWN.review);
    var landed = COUNTS ? COUNTS.landed : [];
    // Counted over the registry's newest rows: when it was cut, at least that many, the reason on hover.
    tile("shipped", COUNTS ? ["Shipped", num(landed.length), "approved by a maintainer, from " + num(Object.keys(from).length) + (REG_CUT ? "+" : "") + " contributors", landed.length, REG_CUT ? atLeast : null, REG_CUT ? "at least: the registry read here is its newest " + num(REG.length) + " requests" : ""] : null, DOWN.reg);
  }

  // ---- your requests: signed in only — each of your packages where it stands on the line, with the rule that you never decide your own, and the way to become a maintainer.
  var OFF_WORD = { rejected: ["Rejected", "circle-slash"], unmaintained: ["Unmaintained", "circle-slash"], blocked: ["Blocked", "ban"] };
  function drawMine() {
    var sec = $("#mine"); if (!sec) return;
    sec.hidden = !WHO.me; if (!WHO.me) return;
    var list = $("#mine-list"), maint = $("#mine-maint");
    if (!REG) { list.innerHTML = '<p class="fx-mempty">' + esc(DOWN.reg || "Loading") + '</p>'; return; }
    var mine = REG.filter(function (p) { return p.owner === WHO.login; }).sort(function (a, b) { return String(b.updated_at || "") < String(a.updated_at || "") ? -1 : 1; });
    $("#mine-n").textContent = num(mine.length);
    list.innerHTML = mine.map(function (p) {
      var s = stageOf(p), off = p.blocked_at ? OFF_WORD.blocked : OFF_WORD[p.status], failed = s < 0 && !off && allFailed(p);
      var word = s >= 0 ? LINE[s] : off || (failed ? ["Not built", "circle-slash"] : ["Off the line", "circle-slash"]);
      var note = s >= 0 ? noteOf(p, s)[0] : failed ? "every architecture's build failed after its tries · renew it to try again" : (p.detail || "");
      return '<a class="fx-mrow ' + (s >= 0 ? "c" + s : "c-off") + '" href="' + esc(hrefOf(p, s)) + '"><span class="nm"><b>' + esc(p.name) + '</b><span>' + esc(p.release || "") + '</span></span><span class="fx-stage">' + lucide(word[1], 13) + esc(word[0]) + '</span>' + squares(p) + '<span class="note">' + esc(note) + '</span><span class="go" aria-hidden="true">›</span></a>';
    }).join("") || '<p class="fx-mempty">Nothing yet. Your first request shows up here.</p>';
    if (isMaintainer()) { maint.setAttribute("href", "/review"); maint.textContent = "Review queue" + (REVIEW ? " · " + num(REVIEW.ready) + " ready · " + num(REVIEW.in_review) + " in review" : "") + " ›"; }
    else {
      var approved = mine.filter(function (p) { return p.landed; }).length;
      maint.setAttribute("href", "/docs/governance#becoming");
      maint.textContent = approved ? num(approved) + " approved · you can apply to maintain ›" : "Get one approved to become a maintainer ›";
    }
  }

  function draw() { drawBoard(); drawTiles(); drawWorkers(); drawMine(); }

  // ---- the reads. The registry: at load, again when a build starts or ends (its copy at the edge is thirty seconds old at most, so once more after that), and every five minutes for what moves no build (a rejection). What runs now (the listing's live read: the workers and the tasks in flight, through the queue's index): every minute. A tab nobody looks at asks for neither; shown again, it asks for what is due. The review list: at load, and when a package enters or leaves the review columns; the approvals list: at load, and when the Shipped column changes.
  var LIVE_MS = 60000, LAST_LISTING = 0, APPROVED = null, SHIPPED_SIG = null;
  // JUST: the registrations this page sent, as the POST answered them, kept over a registry answer older than each (the edge's copy of the minute before) until one as new has it — the card never leaves the line and comes back.
  var JUST = {};
  function withJust(rows) {
    var out = rows.slice();
    Object.keys(JUST).forEach(function (n) {
      var i = -1; out.forEach(function (p, k) { if (p.name === n) i = k; });
      if (i >= 0 && String(out[i].updated_at || "") >= String(JUST[n].updated_at || "")) { delete JUST[n]; return; }
      if (i >= 0) out[i] = JUST[n]; else out.push(JUST[n]);
    });
    return out;
  }
  function loadRegistry() {
    return api("GET", "/api/v1/factory/packages").then(function (d) { REG = withJust(d.packages || []); REG_CUT = !!d.truncated; DOWN.reg = ""; draw(); })
      .catch(function (e) { DOWN.reg = noAnswer("registry", e); draw(); });
  }
  function loadListing() {
    LAST_LISTING = Date.now();
    return api("GET", "/api/v1/factory?live=1&limit=20").then(function (d) {
      LISTING = d; DOWN.listing = "";
      // A build that starts or ends moves a card; a pool job moves none, and reads no registry.
      var sig = (d.tasks || []).filter(function (t) { return t.kind === "build"; }).map(function (t) { return "#" + t.id + ":" + t.status; }).sort().join(",");
      if (SIG !== null && sig !== SIG) { loadRegistry(); clearTimeout(AGAIN); AGAIN = setTimeout(loadRegistry, 35000); }
      SIG = sig; draw();
    }).catch(function (e) { DOWN.listing = noAnswer("worker listing", e); draw(); });
  }
  function loadReview() {
    return api("GET", "/api/v1/factory/review").then(function (d) { REVIEW = d; DOWN.review = ""; drawBoard(); drawTiles(); drawMine(); })
      .catch(function (e) { DOWN.review = noAnswer("review list", e); drawTiles(); });
  }
  // The approvals that stand, first per name (the list is newest first). One that did not answer leaves the shipped cards with their targets' own word.
  function loadApprovals() {
    return api("GET", "/api/v1/factory/approvals").then(function (d) {
      if (d.error) return;
      var by = {}; (d.approvals || []).forEach(function (a) { if (a.standing && !by[a.name]) by[a.name] = a; });
      APPROVED = by; drawBoard(); drawMine();
    }).catch(function () {});
  }
  loadRegistry(); loadListing(); loadReview();
  setInterval(function () { if (!document.hidden) loadListing(); }, LIVE_MS);
  setInterval(function () { if (!document.hidden) loadRegistry(); }, 300000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden && Date.now() - LAST_LISTING >= LIVE_MS) loadListing(); });
  maintainerSet(function (m) { MAINT = m || {}; drawTiles(); });
  // The week's series: how long a job of a kind takes, what a worker's bar is measured against — the old Factory's rhythm, two minutes.
  liveStats(function (d) { STATS = d; drawWorkers(); }, 120000);

  // ---- the fields, live for everyone: a visitor checks a name and builds a prompt; only the send is a person's.
  var fields = [["#fx-name", function () { var el = $("#fx-name"), low = el.value.toLowerCase(); if (low !== el.value) el.value = low; AUTO["#fx-name"] = null; checkName(); prompt(); signInLink(); }], ["#fx-url", function () { readUrl(); prompt(); }], ["#fx-license", function () { prompt(); ready(); }], ["#fx-desc", ready], ["#fx-source", ready], ["#fx-version", ready]];
  fields.forEach(function (f) { var el = $(f[0]); if (el) el.addEventListener("input", f[1]); });
  document.querySelectorAll("#fx-checklist input[data-check]").forEach(function (i) { i.addEventListener("change", ready); });
  // Enter in a field sends, as a form does — a person's; nobody's is told what sending takes.
  $("#fx-form").addEventListener("keydown", function (ev) {
    var el = ev.target;
    if (ev.key !== "Enter" || ev.isComposing || !el || el.tagName !== "INPUT" || el.type === "checkbox") return;
    ev.preventDefault();
    if (WHO.me) send(); else state("Sign in to send: the card is kept for the way back.");
  });
  // The sign-in keeps the card: what it holds is drawn again when the reader comes back.
  var signIn = $("#fx-send"); if (signIn) signIn.addEventListener("click", keepDraft);
  if (NAMED && !RENEW) { $("#fx-name").value = NAMED; }
  if (!RENEW && draftBack()) { readUrl(); ready(); }
  if (nameOf()) checkName();
  prompt();
  // The agent's tab has an address of its own (/factory#fx-agent): a page that points a reader at their agent lands on it.
  if (location.hash === "#fx-agent") { tab(false); var card = $("#request"); if (card && card.scrollIntoView) card.scrollIntoView(); }
  // Who is looking: nobody keeps the sign-in, a person gets the send — and their requests, and a renewal filled from the record.
  whoami(function (me) {
    if (me) {
      $("#fx-send-slot").innerHTML = '<button type="button" class="op-btn" id="fx-send">' + (RENEW ? "Renew the request" : "Send request") + '</button>';
      $("#fx-send").addEventListener("click", send);
      if (RENEW) prefill(RENEW);
    } else signInLink();
    if (NAME_STATE) nameSays(NAME_STATE);
    ready(); drawMine();
  });
`;

export function factoryHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/factory",
    title: "Factory · omarchy-pool",
    description: "Get your project into Omarchy: send the source, the pool's agents write and build it on every architecture, a maintainer who did not ask for it reviews it.",
    active: "factory",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
    kit: true,
    css: FACTORY_CSS,
  });
}

/**
 * What /factory is made of. Everything is served for everyone and is the
 * same for all; a session changes the send (the sign-in for nobody, the
 * POST for a person) and shows the reader's own requests. The acts are the
 * request as the card sends it — whole, short of a confirmation, a release
 * not named, a renewal from the record — so the handler is proved to check
 * what the card asks; the reads are the checks the card makes while the
 * fields are typed, the lists the line, the tiles and the workers are drawn
 * from.
 */
export const FACTORY_COMPONENTS = (F: Fixture): Component[] => {
  // The four confirmations typed by hand, not read from CHECKLIST — the boxes are rendered from it, so a fifth
  // sentence added there and not here makes the request answer 400 here.
  const confirmed = { official: true, license: true, unshipped: true, evidence: true };
  // bob's request, as the card sends it: a project that is not on GitHub, GitLab or Codeberg (the tests run without the network),
  // so the release is named by hand — the "Not on GitHub, GitLab or Codeberg?" fields.
  const theirs = {
    url: "https://theirs.example", name: "theirs", source: "https://theirs.example/theirs-1.0.tar.gz", version: "1.0",
    description: "Theirs, the package the form asks for in the tests", license: "MIT", arches: [F.arch], checklist: confirmed,
  };
  // alice's request, renewed from the record: the story's fields, sent back.
  const renewal = {
    url: "https://mine.example", name: F.factoryPkg, source: "https://mine.example/mine-1.0.tar.gz", version: "1.0",
    description: "Mine, a small tool for the tests", license: "MIT", arches: [F.arch], checklist: confirmed,
  };
  return [
    {
      // The hero: the eyebrow, the title, the three steps with their icons — one of them honest about who reviews: one maintainer, never the requester.
      id: "factory.hero",
      page: "/factory",
      anchor: ['<p class="op-eyebrow">For contributors</p>', '<h1 class="op-hero" id="fx-title">Get your project into Omarchy</h1>', "You send the source", "Agents write and build it", "A maintainer reviews it", 'class="op-i op-i-send"', 'class="op-i op-i-bot"', 'class="op-i op-i-users"'],
      visible: EVERYONE,
    },
    {
      // Four numbers: the line's own counts — in the factory (a shipped package on the line again for a new version said so), building now (what a worker holds this moment: the live read's leased tasks behind a card's targets, the rest of the Building column queued) —, the review list's own `ready` — Review's Ready for review tile, word for word: a package waiting for a claim, never one claimed, which is in review on both pages (#274) — and the registry's `landed`, captioned as what it counts: approved by a maintainer, from the contributors who are not in the maintainer set. A list that did not answer reads "—" with its reason on hover.
      id: "factory.tiles",
      page: "/factory",
      anchor: ['<div class="op-stats fx-stats" id="tiles">', 'id="t-line-n"', 'id="t-building-n"', 'id="t-ready-n"', 'id="t-shipped-n"', "In the factory", "Building now", "Ready for review", "Shipped"],
      script: ["function drawTiles()", '"Ready for review"', "num(REVIEW.ready)", '"waiting for a claim"', "workerCounts(LISTING.workers || [])", "p.landed", "maintainerSet(function (m)", '"approved by a maintainer, from "', '" contributors"', "countUp(n, row[3], row[4])", "REG_CUT = !!d.truncated", "REG_CUT ? atLeast : null", "did not answer", "function running(p)", 'x.status === "leased"', '" of them new versions"', '" queued · "'],
      reads: [
        { path: "/api/v1/factory/packages", fields: ["truncated", "packages", "packages.0.name", "packages.0.owner", "packages.0.landed", "packages.0.targets"] },
        { path: "/api/v1/factory/review", fields: ["ready"] },
        { path: "/api/v1/factory?live=1&limit=20", fields: ["workers", "workers.0.alive", "workers.0.current_task", "workers.0.revoked_at", "tasks", "tasks.0.id", "tasks.0.status"] },
        { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login"] },
      ],
      visible: EVERYONE,
    },
    {
      // The request card's form, live for everyone: the name, the source, the licence with its list, one toggle per architecture (ARCHES, the pool's order), the description. Anyone signed in sends it, and the name is then the sender's: the same request by anyone else is refused.
      id: "factory.request-form",
      page: "/factory",
      anchor: ['<div class="op-card fx-request" id="request">', 'id="tab-form" aria-selected="true"', '<form class="fx-form" id="fx-form"', 'id="fx-name"', 'id="fx-url"', 'id="fx-license" type="text" list="spdx"', '<datalist id="spdx">', "<option>MIT</option>", "<option>custom:proprietary</option>", 'id="fx-desc"', 'data-arch="x86_64" aria-pressed="true"', 'data-arch="aarch64" aria-pressed="true"', "Sending reserves the name. It's freed if the request is rejected."],
      script: ["ARCHES.forEach(function (a) { ON[a] = true; })", 'document.querySelectorAll("#fx-form [data-arch]")', 'api("POST", "/api/v1/factory/packages", body)', "if (nameOf()) body.name = nameOf();", "arches: archesOn()", "checklist: checklist()", "function missingOf()"],
      acts: [{ method: "POST", path: "/api/v1/factory/packages", body: theirs, expect: { anonymous: 401, contributor: 201, owner: 409, maintainer: 409 } }],
      visible: EVERYONE,
    },
    {
      // The name's live check, by the request's own rule: PKGNAME spliced in (request.ts), then the server's word — available (the architectures a source ships skipped), reserved, taken (linked to its page in edge where edge serves it), blocked, being built — asked once per name and architectures; the holder reads "yours", and the name just sent is the sender's.
      id: "factory.name-check",
      page: "/factory",
      anchor: ['id="fx-name-say"', 'id="fx-name-box"'],
      script: [`var NAME_RULE = ${String(PKGNAME)}`, `NAME_WORDS = ${JSON.stringify(PKGNAME_RULE)}`, '"/api/v1/factory/names/" + encodeURIComponent(n) + "?arches=" + archesOn().join(",")', '"✗ invalid characters"', '"✓ available"', '"✗ reserved by a pending request"', "✗ taken · open it ›", '"✗ blocked by a maintainer"', '"✓ yours · sending renews the request"'],
      reads: [
        { path: `/api/v1/factory/names/${F.factoryPkg}?arches=${F.arch}`, fields: ["name", "arches", "state", "why", "owner", "status", "freed", "renew", "provided", "in_edge"] },
        { path: "/api/v1/factory/names/a-name-nobody-has", fields: ["state", "why"] },
      ],
      visible: EVERYONE,
    },
    {
      // The source: what the address says for everyone, what the repository says for a person — read by the request's own detect() on GitHub, GitLab's and Codeberg's APIs — filling the licence, the description and the name nobody typed; off those three, the release is named by hand.
      id: "factory.source-read",
      page: "/factory",
      anchor: ['id="fx-url-say"', 'id="fx-found"', '<details class="fx-more" id="fx-more"><summary>Not on GitHub, GitLab or Codeberg? Name the release</summary>', 'id="fx-source"', 'id="fx-version"'],
      script: ['"/api/v1/factory/source?url=" + encodeURIComponent(u)', 'fill("#fx-license", d.license)', 'fill("#fx-source", d.send.source)', '"✓ found on "', "latest release ", 'body.source = val("#fx-source")', 'body.version = val("#fx-version")'],
      reads: [
        { path: "/api/v1/factory/source?url=https://github.com/alice/mine", fields: ["url", "project", "forge", "name", "read", "why"] },
        { path: "/api/v1/factory/source?url=https://gitlab.com/alice/mine", as: "contributor", fields: ["forge", "name", "read", "why"] },
      ],
      // A project that is not on a forge the pool reads has no tag to read: without the release the request is refused before anything is written.
      acts: [
        {
          method: "POST",
          path: "/api/v1/factory/packages",
          body: { url: "https://elsewhere.example", name: "elsewhere", description: "Elsewhere, a release the form must be told about", license: "MIT", arches: [F.arch], checklist: confirmed },
          expect: { anonymous: 401, contributor: 400, owner: 400, maintainer: 400 },
        },
      ],
      visible: EVERYONE,
    },
    {
      // The four confirmations, every one a key of CHECKLIST with its sentence as the line: the server's one text, never a copy. One box left unticked and the request is refused, whoever asks.
      id: "factory.checklist",
      page: "/factory",
      anchor: ['<fieldset class="fx-confirm" id="fx-checklist">', ...Object.entries(CHECKLIST).map(([k, t]) => `data-check="${k}"> ${asLine(t)}</label>`)],
      script: ['querySelectorAll("#fx-checklist input[data-check]")', 'c[i.getAttribute("data-check")] = i.checked'],
      acts: [{ method: "POST", path: "/api/v1/factory/packages", body: { ...theirs, checklist: { ...confirmed, evidence: false } }, expect: { anonymous: 401, contributor: 400, owner: 400, maintainer: 400 } }],
      visible: EVERYONE,
    },
    {
      // The send: "Sign in to send" for nobody, served so and coming back to the Factory's card (#request) with the name typed so far in the address and the rest of the card in the tab's session storage; the button for a person — Enter in a field presses it —, aria-disabled while the POST is in flight so the focus stays, and what was sent — the record, its signature, the build system, the builds queued — once it is, the focus moved there; the name then the sender's on the card and the card on the line at once, whatever the edge's copies still say.
      id: "factory.send",
      page: "/factory",
      anchor: ['<span id="fx-send-slot"><a class="op-btn" id="fx-send" href="/auth/github?next=/factory">Sign in to send</a></span>', 'id="fx-state"', 'id="fx-done"'],
      script: ["function signInLink()", '"/auth/github?next=" + encodeURIComponent(next)', '"#request"', "function keepDraft()", "function draftBack()", "window.sessionStorage", '"Send request"', 'btn.setAttribute("aria-disabled", "true")', '"Checking the pool, the project and the source…"', "state(d.error, true)", "esc(q.record)", "q.signature", "detected.build_system", 'taskPill("queued")', "b.queue[a].position", "userHref(WHO.login)", "Follow it on the line ›", 'SENT[p.name] = { name: p.name, state: "reserved", owner: WHO.login', 'FRESH[p.name] = Date.now(); draw();', '$("#fx-done").focus()', 'ev.key !== "Enter"'],
      reads: [
        { path: "/auth/github?next=/factory", status: 302, json: false },
        { path: "/auth/me", status: 401 },
        { path: "/auth/me", as: "contributor", fields: ["login", "role"] },
      ],
      visible: EVERYONE,
    },
    {
      // A renewal (?renew=<name>): the card filled from the record — the story's fields, the lines its checks marked — and the button says so. The record is public and the card asks nothing about ownership: the server refuses the name to anyone but alice. Her own renewal is refused while an approval stands and taken once an act withdrew it.
      id: "factory.renew",
      page: `/factory?renew=${F.factoryPkg}`,
      anchor: ['id="fx-head"', 'id="request"'],
      script: ['params.get("renew")', "if (RENEW) prefill(RENEW)", '"/api/v1/factory/packages/" + encodeURIComponent(name) + "/story?t=" + Date.now()', '"Renew the request for " + name', "q.checks.filter(function (c) { return !c.ok; })", "p.project || p.url", "q.arches && q.arches.length ? q.arches : (p.arches || [])", 'q.version && q.version !== "unknown"', "p.source && p.source !== p.project"],
      reads: [
        {
          path: `/api/v1/factory/packages/${F.factoryPkg}/story?t=0`,
          fields: ["package", "package.project", "package.url", "package.description", "package.license", "package.source", "package.arches", "request", "request.checks", "request.checks.0.ok", "request.checks.0.item", "request.checks.0.note", "request.arches", "request.version"],
        },
      ],
      acts: [{ method: "POST", path: "/api/v1/factory/packages", body: renewal, expect: { anonymous: 401, contributor: 409, maintainer: 409, owner: [200, 409] } }],
      visible: EVERYONE,
    },
    {
      // The ⌘K menu's Request "<name>" lands here: the name as given, a pacman name only, filled in for whoever is looking.
      id: "factory.named",
      page: "/factory?name=zzfoo",
      anchor: ['id="fx-name"'],
      script: ['params.get("name")', "if (!NAME_RULE.test(NAMED)) NAMED = \"\";", '$("#fx-name").value = NAMED;'],
      visible: EVERYONE,
    },
    {
      // The other tab: a prompt built from the form, copied with the kit's well, the agents it works with, and the two MCP tools it uses (#252, served by omarchy-cli mcp) — with what an agent needs for them: the login with its name, in a well of its own, and where to connect it (the Agents page) and read what each tool answers (the MCP chapter). None of it says proposed.
      id: "factory.agent-tab",
      page: "/factory",
      anchor: ['id="tab-agent" aria-selected="false"', 'id="fx-agent" role="tabpanel"', '<button type="button" class="op-copy" data-op-copy="">copy prompt</button>', 'id="fx-prompt"', ...WORKS_WITH.map(([label, mark]) => `op-b-${mark}" style="--op-i-s:22px" role="img" aria-label="${label}"`), `<code>${SERVER_COMMAND}</code> · <code>request_package</code> · <code>request_status</code>`, `<p class="fx-tools-note">${AGENT_LOGIN_NOTE}</p>`, `<code>${AGENT_LOGIN}</code><button type="button" class="op-copy" data-op-copy="">copy</button>`, 'href="/agents#connect"', `href="${LOGIN_DOCS}"`],
      script: ["function tab(form)", 'location.hash === "#fx-agent"', "function prompt()", '"Request " + (nameOf() || "<name>") + " on omarchy-pool: source "', "ARCHES.join(\" and \")"],
      reads: [{ path: "/agents", json: false }, { path: "/docs/omarchy-cli-mcp", json: false }],
      visible: EVERYONE,
    },
    {
      // What happens next, under the card: checked, built, reviewed, in edge.
      id: "factory.next-steps",
      page: "/factory",
      anchor: ['<ol class="fx-next" aria-label="What happens next">', "<b>Checked</b><span>licence, source, name</span>", "<b>Built</b><span>on each architecture</span>", "<b>Reviewed</b><span>by a maintainer, never the requester</span>", "<b>In edge</b><span>then rc → stable</span>"],
      visible: EVERYONE,
    },
    {
      // The workers, live: each one alive, busy first, then any not ready (its agent did not answer: the listing's ready, the shell's wtNotReady for why, the agent's error on hover — #273), with its agent's mark, its job and step from the listing's task, and how far it is against the week's time of a job of its kind (the stats series: jobs_daily and builds_daily carry ms). What runs now is the listing's live read (the tasks in flight through the queue's index, no counts), every minute, and nothing while the tab is hidden: the whole listing read every task twice, and every twenty seconds was a page nobody watched costing the most.
      id: "factory.workers",
      page: "/factory",
      anchor: ['<div class="op-card fx-workers" id="workers">', 'id="fx-busy"', 'id="fx-wlist"', '<a href="/workers">All workers →</a>', 'class="op-live-dot"'],
      script: ['api("GET", "/api/v1/factory?live=1&limit=20")', "LIVE_MS = 60000", "if (!document.hidden) loadListing();", '"visibilitychange"', "function workerRowOf(w)", "agentMark(mark, w.agent, 22)", "workerName(w)", "!w.current_task && !w.ready", "wtNotReady(w)", "<b>not ready</b>", '" not ready"', "function stepOf(t)", '"rebuilding from scratch"', '"writing the PKGBUILD"', "function typicalMs(t)", "s.builds_daily", "s.jobs_daily", "liveStats(function (d) { STATS = d; drawWorkers(); }, 120000)", 'noAnswer("worker listing", e)'],
      reads: [
        {
          path: "/api/v1/factory?live=1&limit=20",
          fields: ["workers", "workers.0.id", "workers.0.arch", "workers.0.agent", "workers.0.alive", "workers.0.ready", "workers.0.agent_error", "workers.0.agent_checked_at", "workers.0.current_task", "workers.0.revoked_at", "tasks", "tasks.0.id", "tasks.0.name", "tasks.0.kind", "tasks.0.trust", "tasks.0.status", "tasks.0.arch", "tasks.0.attempts", "tasks.0.max_attempts", "tasks.0.started_at", "tasks.0.pkgbuild_ref", "tasks.0.params"],
        },
        { path: "/api/v1/stats", fields: ["series.jobs_daily", "series.builds_daily", "series.builds_daily.0.ms", "series.builds_daily.0.trust", "series.builds_daily.0.status", "series.builds_daily.0.n"] },
        { path: "/workers", json: false },
      ],
      visible: EVERYONE,
    },
    {
      // The line: five columns, a card per package placed by its targets (targets.ts, the server's rule for where each architecture stands) — checking, building, ready for review, in review, shipped —, the two review columns filed by the review list's own `state` for every package it names (ready: waiting for a claim; in_review: claimed until the decision — routes/review.ts, the rule Review files by, #274), each counting its own cards, an empty one saying so; a request whose every build failed is off it. Each card links the package's one address, its architectures as the kit's squares with the shell's words; a shipped one says where its approval stands in the shell's one word (approvalWhere over GET /factory/approvals, read when the column changes) and leads to the ring that serves it or, in none, to its build. Read again when a build starts or ends, and a card that moved is lit. A build an emulated worker sent back says the native worker it waits for, whichever of its architectures it is (nativeWait: the shell's waitsForNative over the live read's task, else the package's detail naming it, #281).
      id: "factory.line",
      page: "/factory",
      anchor: ['<section class="fx-line" id="line"', 'id="line-note"', "live · a card moves when its job ends", 'id="board"', ...LINE.map((_, i) => `id="col-${i}"`), ...LINE.map(([name]) => `<span>${escapeHtml(name)}</span>`)],
      script: ['api("GET", "/api/v1/factory/packages")', "function stageOf(p)", "function lineOf(p)", 'has("building")', "CLAIMED = { reviewing: 1, reviewed: 1 }", "BUILT = { built: 1 }", 'if (r === "in_review") return 3;', 'if (r === "ready") return 2;', "return s === 2 || s === 3 ? (p.landed ? 4 : 0) : s;", "if (allFailed(p)) return -1;", "TARGET_WORD[x.status]", "function hrefOf(p, s)", "approvalWhere(a)", "servedRing(rings)", '"/build/" + task', 'api("GET", "/api/v1/factory/approvals")', "avatarIcon(p.owner)", " op-fresh", "nothing here now", "if (SIG !== null && sig !== SIG) { loadRegistry();", 't.kind === "build"', "if (!document.hidden) loadRegistry();", 'noAnswer("registry", e)', "function nativeWait(p, status)", 'nativeWait(p, "building")', 'nativeWait(p, "reviewing")'],
      reads: [
        { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.name", "packages.0.owner", "packages.0.status", "packages.0.release", "packages.0.targets", "packages.0.updated_at", "packages.0.landed", "packages.0.blocked_at", "packages.0.detail"] },
        { path: "/api/v1/factory/review", fields: ["packages", "packages.0.name", "packages.0.state"] },
        { path: "/api/v1/factory/approvals", fields: ["approvals", "approvals.0.name", "approvals.0.standing", "approvals.0.rings", "approvals.0.task_id", "approvals.0.arch", "approvals.0.publish_status", "approvals.0.blocked_at"] },
      ],
      visible: EVERYONE,
    },
    {
      // Your requests: signed in only — the reader's packages where they stand on the line (or off it, with the registration's own words), the rule that nobody reviews their own, and the way to the review queue for a maintainer — the list's `ready` and `in_review`, Review's two tiles — or to becoming one for a contributor.
      id: "factory.mine",
      page: "/factory",
      anchor: ['<section class="fx-mine" id="mine" hidden', 'id="mine-n"', 'id="mine-list"', 'href="/docs/governance#becoming"', "You never review your own requests. Another maintainer picks them up."],
      script: ["function drawMine()", "sec.hidden = !WHO.me", "p.owner === WHO.login", '"Not built"', '"Review queue"', '" ready · "', "num(REVIEW.in_review)", '" approved · you can apply to maintain ›"', '"Get one approved to become a maintainer ›"', "Nothing yet. Your first request shows up here."],
      reads: [
        { path: "/api/v1/factory/packages", fields: ["packages.0.owner", "packages.0.landed"] },
        { path: "/api/v1/factory/review", fields: ["ready", "in_review"] },
        { path: "/docs/governance", json: false },
      ],
      visible: SIGNED_IN,
    },
  ];
};
