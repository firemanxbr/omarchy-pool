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
 * is the send — "Sign in to send" for nobody, the POST for a person — and
 * the reader's own requests. The line and the workers are the pool's own
 * rows: the workers from the factory listing, polled as the Workers page
 * polls it; the line from the registry, where each package's targets say
 * where each architecture stands (targets.ts), read again when a job
 * starts or ends — a card moves when its job ends — and every five minutes.
 */
import { page } from "./layout";
import { EVERYONE, SIGNED_IN, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";
import { REPO_ARCHES } from "../meta";
import { CHECKLIST, PKGNAME, PKGNAME_RULE } from "../request";
import { escapeHtml } from "../html";
import { agentMark, lucide, type AgentMark, type LucideName } from "./kit";

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
      <a class="op-stat" id="t-ready" href="/review"><span class="k">Ready for review</span><b class="n" id="t-ready-n"><span class="skl"></span></b><span class="s" id="t-ready-s">waiting for a maintainer</span></a>
      <a class="op-stat" id="t-shipped" href="/packages?q=factory"><span class="k">Shipped</span><b class="n" id="t-shipped-n"><span class="skl"></span></b><span class="s" id="t-shipped-s">approved by a maintainer</span></a>
    </div>
  </section>

  <section class="fx-pair" aria-label="Request a package, and the workers">
    <div class="op-card fx-request" id="request">
      <div class="op-card-h"><b id="fx-head">Request a package</b>
        <div class="op-tabs" role="tablist" aria-label="How to send it">
          <button type="button" role="tab" id="tab-form" aria-selected="true" aria-controls="fx-form">Form</button>
          <button type="button" role="tab" id="tab-agent" aria-selected="false" aria-controls="fx-agent" tabindex="-1">Ask your agent</button>
        </div>
      </div>
      <form class="fx-form" id="fx-form" role="tabpanel" aria-labelledby="tab-form" onsubmit="return false" novalidate>
        <div class="fx-field">
          <div class="fx-lab"><label class="op-label" for="fx-name">Name</label><span class="fx-say" id="fx-name-say" aria-live="polite"></span></div>
          <div class="fx-in" id="fx-name-box">${lucide("package", 15)}<input id="fx-name" type="text" placeholder="the name people will pacman -S" maxlength="100" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
        </div>
        <div class="fx-field">
          <div class="fx-lab"><label class="op-label" for="fx-url">Source</label><span class="fx-say" id="fx-url-say" aria-live="polite"></span></div>
          <div class="fx-in" id="fx-url-box"><span class="fx-ic" id="fx-url-icon">${lucide("github", 15)}</span><input id="fx-url" type="text" inputmode="url" placeholder="github.com/you/project" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
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
        <div class="fx-done" id="fx-done" hidden></div>
      </form>
      <div class="fx-agent" id="fx-agent" role="tabpanel" aria-labelledby="tab-agent" hidden>
        <p>Your agent fills in the request and follows it for you.</p>
        <div class="op-code"><code><span class="op-prompt">› </span><span id="fx-prompt">Request &lt;name&gt; on omarchy-pool.</span></code><button type="button" class="op-copy" data-op-copy="">copy prompt</button></div>
        <div class="fx-with"><span>Works with</span>${WORKS_WITH.map(([label, mark]) => `<span class="fx-mark">${agentMark(mark, label, 22)}</span>`).join("")}</div>
        <p class="fx-tools">${lucide("plug", 13)}<span>Through <code>omarchy-cli mcp</code> · <code>request_package</code> · <code>request_status</code></span><span class="op-pill na" title="signed off, not built yet: #252">proposed</span></p>
        <p class="fx-tools-note">Those two tools are proposed, not built yet (<a href="/docs/omarchy-cli-mcp">the MCP chapter</a>). Until they are, an agent sends the same request with your token: <code>POST /api/v1/factory/packages</code> (<a href="/api">the API</a>).</p>
      </div>
      <ol class="fx-next" aria-label="What happens next">
        <li>${lucide("file-search", 14)}<b>Checked</b><span>licence, source, name</span></li>
        <li>${lucide("hammer", 14)}<b>Built</b><span>on each architecture</span></li>
        <li>${lucide("user-check", 14)}<b>Reviewed</b><span>by a maintainer, never the requester</span></li>
        <li>${lucide("layers", 14)}<b>In edge</b><span>then rc → stable</span></li>
      </ol>
    </div>

    <div class="op-card fx-workers" id="workers">
      <div class="op-card-h"><b>Workers <span class="op-live-dot" title="live: the listing, every twenty seconds"></span></b><small id="fx-busy"></small></div>
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
  .fx-in:focus-within { border-color: var(--green); }
  .fx-in input { flex: 1; min-width: 0; height: 100%; padding: 0; background: transparent; border: 0; outline: 0; color: var(--text); font: 14px var(--font-mono); }
  .fx-in input::placeholder { color: var(--dim); }
  .fx-ic { display: flex; }
  .fx-say.ok { color: var(--green); } .fx-say.bad { color: var(--red); } .fx-say.warn { color: var(--amber); } .fx-say.run { color: var(--blue); }
  .fx-in.ok { border-color: var(--green); } .fx-in.bad { border-color: var(--red); } .fx-in.warn { border-color: var(--amber); } .fx-in.run { border-color: var(--blue); }
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
  .fx-more summary { cursor: pointer; font-size: 12.5px; color: var(--dim); } .fx-more summary:hover { color: var(--text); } .fx-more[open] summary { margin-bottom: 10px; }
  .fx-confirm { margin: 0; padding: 10px 12px; min-width: 0; display: grid; gap: 6px; border: 1px solid var(--line); background: var(--bg-deep); }
  .fx-confirm legend { padding: 0 4px; }
  .fx-confirm label { display: flex; align-items: flex-start; gap: 9px; font-size: 12.5px; line-height: 1.45; color: var(--muted); cursor: pointer; }
  .fx-confirm input { flex: none; margin: 3px 0 0; accent-color: var(--green); }
  .fx-send { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding-top: 14px; border-top: 1px solid var(--line); }
  .fx-lock, .fx-lockline { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 12.5px; color: var(--dim); }
  .fx .fx-send .op-btn { padding: 7px 16px; font-size: 13.5px; }
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
  .fx-wtop { display: flex; justify-content: space-between; gap: 8px; min-width: 0; font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  .fx-wtop > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .fx-wtop .mono { font-size: inherit; }
  .fx-wjob { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--text); }
  .fx-wjob b { font-weight: 600; } .fx-wjob a { color: inherit; } .fx-wjob a:hover { color: var(--green); } .fx-wjob .fx-step { margin-left: 8px; color: var(--dim); }
  .fx-wrow.idle .fx-wjob { color: var(--dim); }
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
  .fx-card:hover { border-color: var(--green); border-top-color: var(--fx-c); } .fx-card:focus-visible { outline: 1px solid var(--green); outline-offset: -1px; }
  @keyframes fx-fresh { from { background-color: var(--panel-2); } to { background-color: var(--bg-deep); } }
  .fx-card.op-fresh { animation-name: fx-fresh; }
  .fx-c1, .fx-c2 { display: flex; justify-content: space-between; gap: 8px; min-width: 0; } .fx-c1 { align-items: baseline; } .fx-c2 { align-items: center; }
  .fx-c1 > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fx-c1 b { font: 600 14px var(--font-display); } .fx-c1 .v { margin-left: 6px; font-size: 11.5px; color: var(--dim); } .fx-c1 .age { font-size: 11.5px; color: var(--dim); white-space: nowrap; }
  .fx-by { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: var(--muted); } .fx-by > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fx .fx-by .avatar { width: 16px; height: 16px; font-size: 7px; font-weight: 700; }
  .fx-sq { display: flex; gap: 3px; } .fx .fx-sq .op-arch { width: 9px; height: 9px; } .fx .op-arch.wait { background: transparent; }
  .fx-note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--dim); } .fx-note.warn { color: var(--amber); }
  .fx-more-n { padding: 2px; font-size: 12px; color: var(--dim); }
  .fx-mlist { border: 1px solid var(--line); background: var(--panel); }
  .fx-mrow { display: grid; grid-template-columns: minmax(140px, 1.2fr) 170px auto minmax(0, 1.6fr) 14px; gap: 14px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); font-size: 13px; color: var(--text); }
  .fx-mrow:last-child { border-bottom: 0; } .fx-mrow:hover { background: var(--panel-2); } .fx-mrow:focus-visible { outline: 1px solid var(--green); outline-offset: -1px; }
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
  // Where each package stood when the line was last drawn, and when a card moved: a card that moved is lit for a moment (the kit's op-fresh).
  var SEEN = {}, FRESH = {}, SIG = null, AGAIN = null, READY = null, REVIEWING = null;
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
  function said(sel, box, text, tone, title) {
    var el = $(sel); if (el) { el.className = "fx-say" + (tone ? " " + tone : ""); el.innerHTML = text; el.title = title || ""; }
    var b = box ? $(box) : null; if (b) b.className = "fx-in" + (tone ? " " + tone : "");
  }

  // ---- the name: its rule first, in the page (PKGNAME), then the server's word on it (GET /factory/names/:name — the request's own rule over the registry, the approvals, the builds and the sources), asked once per name and architectures, a quarter of a second after the typing stops.
  var NAMES = {}, nameTimer = null, NAME_STATE = null;
  function checkName() {
    var n = nameOf(); clearTimeout(nameTimer);
    if (!n) { NAME_STATE = null; said("#fx-name-say", "#fx-name-box", "", ""); return ready(); }
    if (!NAME_RULE.test(n)) return nameSays({ name: n, state: "invalid" });
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
  // What the check says, in the handoff's words: available, taken (linked to its page), reserved by a pending request, invalid characters — and the holder's own name as theirs. The title is the request's refusal, word for word.
  function nameSays(d) {
    NAME_STATE = d;
    var n = d.name, own = !!d.owner && d.owner === WHO.login && d.state !== "blocked";
    if (d.state === "invalid") said("#fx-name-say", "#fx-name-box", "✗ invalid characters", "bad", "a pacman name: " + NAME_WORDS);
    else if (d.state === "checking") said("#fx-name-say", "#fx-name-box", "⟳ checking", "run");
    else if (d.state === "unknown") said("#fx-name-say", "#fx-name-box", "could not check: " + esc(d.why), "");
    else if (own) said("#fx-name-say", "#fx-name-box", d.renew ? "✗ yours · " + esc(d.renew) : "✓ yours · sending renews the request", d.renew ? "warn" : "ok");
    else if (d.state === "available") said("#fx-name-say", "#fx-name-box", "✓ available" + (d.freed === "rejected" ? " · freed by a review" : d.freed === "unmaintained" ? " · unmaintained, yours to take over" : ""), "ok");
    else if (d.state === "reserved") said("#fx-name-say", "#fx-name-box", "✗ reserved by a pending request", "warn", d.why);
    else if (d.state === "taken") said("#fx-name-say", "#fx-name-box", '<a href="' + esc(pkgHref(n, "edge", archesOn()[0] || ARCHES[0])) + '">✗ taken · open it ›</a>', "bad", d.why);
    else if (d.state === "blocked") said("#fx-name-say", "#fx-name-box", "✗ blocked by a maintainer", "bad", d.why);
    else said("#fx-name-say", "#fx-name-box", "✗ being built · renew it once it is done", "warn", d.why);
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
    if (d.reading) said("#fx-url-say", "#fx-url-box", "⟳ reading the address…", "run");
    else if (d.error) said("#fx-url-say", "#fx-url-box", "✗ " + esc(d.error), "bad");
    else if (d.read) said("#fx-url-say", "#fx-url-box", "✓ found on " + esc(d.forge), "ok");
    else if (d.forge) said("#fx-url-say", "#fx-url-box", "✓ " + esc(d.forge) + " · " + esc(d.why), "");
    else { said("#fx-url-say", "#fx-url-box", esc(d.why), "warn"); var more = $("#fx-more"); if (more) more.open = true; }
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
    el.addEventListener("keydown", function (ev) { if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") { ev.preventDefault(); tab(!t[1]); var other = $(t[1] ? "#tab-agent" : "#tab-form"); if (other && other.focus) other.focus(); } });
  });
  function prompt() {
    var on = archesOn(), el = $("#fx-prompt"); if (!el) return;
    var archText = on.length === ARCHES.length ? ARCHES.join(" and ") : on.length ? on.join(" and ") + " only" : "<architectures>";
    el.textContent = "Request " + (nameOf() || "<name>") + " on omarchy-pool: source " + (urlOf() || "<repository URL>") + ", licence " + (val("#fx-license") || "<licence>") + ", " + archText + ". Follow it until it is ready for review, and tell me if a build fails.";
  }

  // ---- sending: the sign-in for nobody (the name typed so far kept for the way back), the POST for a person. Sending reserves the name (reserveName, one statement): the server is the judge, the page only says what is missing first.
  function signInLink() {
    var a = $("#fx-send"); if (!a || WHO.me) return;
    var n = nameOf(), next = "/factory" + (NAME_RULE.test(n) ? "?name=" + encodeURIComponent(n) : location.search);
    a.setAttribute("href", "/auth/github?next=" + encodeURIComponent(next).replace(/%2F/g, "/"));
  }
  function checklist() { var c = {}; document.querySelectorAll("#fx-checklist input[data-check]").forEach(function (i) { c[i.getAttribute("data-check")] = i.checked; }); return c; }
  function missingOf() {
    var d = val("#fx-desc"), c = checklist(), n = NAME_STATE;
    // The name's check still out, or failed: the server decides on sending; a name the check refused is not sent.
    if (nameOf() && n && n.state === "checking") return "One moment: the name is being checked.";
    if (nameOf() && n && n.state !== "unknown" && !nameOk()) return "Pick a name that is available.";
    if (!urlOf()) return "Add the repository's address.";
    if (!val("#fx-license")) return "Add the licence, an SPDX identifier.";
    if (!archesOn().length) return "Pick at least one architecture.";
    if (d.length < 8) return "Add the description: one line, 8 to 120 characters.";
    if (Object.keys(c).some(function (k) { return !c[k]; })) return "Confirm the four lines above.";
    return "";
  }
  function ready() { var b = $("#fx-send"); if (b && WHO.me && b.classList) b.classList.toggle("primary", !missingOf() && (nameOk() || !nameOf())); }
  function state(text, bad) { var el = $("#fx-state"); if (el) { el.textContent = text; el.className = "fx-state" + (bad ? " bad" : ""); } }
  function send() {
    var miss = missingOf(); if (miss) { state(miss, true); return; }
    var body = { url: urlOf(), description: val("#fx-desc"), license: val("#fx-license"), arches: archesOn(), checklist: checklist() };
    if (nameOf()) body.name = nameOf();
    if (val("#fx-source")) body.source = val("#fx-source");
    if (val("#fx-version")) body.version = val("#fx-version");
    var btn = $("#fx-send"); btn.disabled = true; state("Checking the pool, the project and the source…"); $("#fx-done").hidden = true;
    api("POST", "/api/v1/factory/packages", body).then(function (d) {
      btn.disabled = false;
      if (d.error) { state(d.error, true); return; }
      state("");
      var p = d.package || {}, b = d.build || {}, q = d.request || {};
      $("#fx-done").hidden = false;
      $("#fx-done").innerHTML = '<span class="fx-sent">' + lucide("circle-check", 15) + '<span><b>' + esc(p.name) + '</b> ' + esc(p.release || "") + ' sent · name reserved · <a href="' + esc(q.record) + '">request #' + esc(q.id) + '</a>' + (q.signature ? ' (<a href="' + esc(q.signature) + '">signature</a>)' : '') + '</span></span>'
        + (b.tasks && b.tasks.length ? '<span>' + taskPill("queued") + ' build ' + b.tasks.map(function (t) { return '<a href="/build/' + t + '">#' + t + '</a>'; }).join(", ") + ' for ' + esc((b.arches || []).join(", ")) + (b.queue ? ' · ' + esc(Object.keys(b.queue).map(function (a) { return a + ": " + b.queue[a].position + " of " + b.queue[a].total + " in the shared queue"; }).join(" · ")) : '') + '</span>' : b.error ? '<span class="warn">not queued: ' + esc(b.error) + '</span>' : '')
        + (d.skipped && d.skipped.length ? '<span class="dim">' + esc(d.skipped.map(function (s) { return s.arch + " skipped: " + s.source + " ships " + s.version; }).join(" · ")) + '</span>' : '')
        + '<span class="fx-follow"><a href="#line">Follow it on the line ›</a><a href="' + userHref(WHO.login) + '">Your page →</a></span>';
      ["#fx-name", "#fx-url", "#fx-license", "#fx-desc", "#fx-source", "#fx-version"].forEach(function (s) { var el = $(s); if (el) el.value = ""; });
      document.querySelectorAll("#fx-checklist input[data-check]").forEach(function (i) { i.checked = false; });
      NAMES = {}; AUTO = {}; checkName(); urlSays(null); loadRegistry();
    }).catch(function (e) { btn.disabled = false; state("failed: " + errorText(e), true); });
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
      document.querySelectorAll("#fx-form [data-arch]").forEach(function (b) { b.setAttribute("aria-pressed", ON[b.getAttribute("data-arch")] ? "true" : "false"); });
      var known = q.version && q.version !== "unknown";
      $("#fx-version").value = known ? q.version : "";
      $("#fx-source").value = known && p.source && p.source !== p.project ? p.source : "";
      if ($("#fx-version").value || $("#fx-source").value) $("#fx-more").open = true;
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
    if (!w.current_task) return '<div class="fx-wrow idle">' + box + '<div class="fx-wmain">' + top + '<div class="fx-wjob"><b>idle</b><span class="fx-step">waiting for work</span></div><div class="fx-bar"><i style="width:0%"></i></div></div></div>';
    var p = progressOf(t);
    return '<div class="fx-wrow">' + box + '<div class="fx-wmain">' + top + '<div class="fx-wjob"><a href="/build/' + esc(w.current_task) + '"><b>' + esc(t ? t.name : "#" + w.current_task) + '</b></a><span class="fx-step">' + esc(t ? stepOf(t) : "running") + '</span></div>'
      + '<div class="fx-bar" title="' + esc(p.title) + '"><i' + (p.pct === null ? ' class="unknown"' : '') + ' style="width:' + (p.pct === null ? 100 : p.pct) + '%"></i></div></div></div>';
  }
  function drawWorkers() {
    var list = $("#fx-wlist"), head = $("#fx-busy"); if (!list) return;
    if (!LISTING) { if (DOWN.listing) { list.innerHTML = '<p class="fx-wempty">' + esc(DOWN.listing) + '</p>'; if (head) head.textContent = ""; } return; }
    var ws = (LISTING.workers || []).filter(function (w) { return w.alive && !w.revoked_at; }).sort(function (a, b) { return (b.current_task ? 1 : 0) - (a.current_task ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    var working = ws.filter(function (w) { return w.current_task; }).length, shown = ws.slice(0, 6);
    if (head) head.textContent = num(working) + " busy · " + num(ws.length - working) + " idle";
    list.innerHTML = (shown.length ? shown.map(workerRowOf).join("") + (ws.length > shown.length ? '<p class="fx-wempty">' + num(ws.length - shown.length) + ' more alive · <a href="/workers">every worker</a></p>' : '') : '<p class="fx-wempty">No worker is alive right now. A request waits in the queue until one is.</p>')
      // A refresh that did not answer leaves the last answer's rows, and says so.
      + (DOWN.listing ? '<p class="fx-wempty">' + esc(DOWN.listing) + '</p>' : '');
  }

  // ---- the line: where each package stands, from its targets (targets.ts — where each of its architectures stands, the server's one rule): building while an architecture builds, in review while the project builds it again, ready for review once it is built and nothing of it runs, shipped once approved; checking while nothing of it is in flight. Rejected, blocked and unmaintained registrations are off the line.
  var OFF = { rejected: 1, unmaintained: 1 }, SHIPPED = { approved: 1, published: 1 }, BUILT = { built: 1, reviewed: 1 };
  function statuses(p) { var t = p.targets || {}; return Object.keys(t).map(function (a) { return t[a].status; }); }
  function stageOf(p) {
    if (p.blocked_at || OFF[p.status]) return -1;
    var st = statuses(p), has = function (s) { return st.indexOf(s) >= 0; };
    if (has("building")) return 1;
    if (has("reviewing")) return 3;
    if (st.some(function (s) { return BUILT[s]; })) return 2;
    if (st.some(function (s) { return SHIPPED[s]; }) || (!st.length && p.landed)) return 4;
    return 0;
  }
  // The architectures a card names: each one requested, in the pool's order, with the shell's word for where it stands.
  function squares(p) {
    var t = p.targets || {};
    return '<span class="fx-sq">' + ARCHES.map(function (a) {
      var x = t[a], w = x ? TARGET_WORD[x.status] : null;
      return '<i class="op-arch ' + (x ? SQUARE[x.status] || "wait" : "na") + '" title="' + esc(a + " · " + (x ? (w ? w[2] : x.status) : "not requested")) + '"></i>';
    }).join("") + '</span>';
  }
  // A card's line: what is happening to it now, in a few words — the running job's step from the listing, what is built and what is not supported.
  function noteOf(p, s) {
    var t = p.targets || {}, arches = Object.keys(t), ns = arches.filter(function (a) { return t[a].status === "not_supported"; });
    var off = ns.length ? ns.join(", ") + " not supported" : "";
    if (s === 0) return ns.length && ns.length === arches.length ? ["no architecture built · back to its owner", true] : ["on the record · no build yet", false];
    if (s === 1) {
      var run = arches.filter(function (a) { return t[a].status === "building"; }).map(function (a) { return taskOf(t[a].task); }).filter(Boolean)[0];
      var doing = run ? (run.status === "leased" ? stepOf(run) : "queued for a worker") : "queued for a worker";
      return [(off ? off + " · " : "") + doing, !!off];
    }
    if (s === 2) {
      var built = arches.filter(function (a) { return BUILT[t[a].status]; });
      if (arches.some(function (a) { return t[a].status === "reviewed"; })) return ["the project's build is staged · a maintainer decides", false];
      return [(built.length === arches.length && arches.length > 1 ? "built on every architecture" : built.join(", ") + " built") + (off ? " · " + off : ""), !!off];
    }
    if (s === 3) return ["the project builds it again" + (off ? " · " + off : ""), false];
    var lead = arches.filter(function (a) { return SHIPPED[t[a].status]; })[0];
    return [(lead ? TARGET_WORD[t[lead].status][2] : "approved by a maintainer") + (off ? " · " + off : ""), false];
  }
  function cardOf(p, s) {
    var arch = Object.keys(p.targets || {})[0] || ARCHES[0], note = noteOf(p, s);
    return '<a class="fx-card' + (FRESH[p.name] && Date.now() - FRESH[p.name] < 1600 ? " op-fresh" : "") + '" href="' + esc(pkgHref(p.name, s === 4 ? "edge" : "lab", arch)) + '">'
      + '<span class="fx-c1"><span><b>' + esc(p.name) + '</b><span class="v">' + esc(p.release || "") + '</span></span><span class="age" title="' + esc(p.updated_at || "") + '">' + esc(since(p.updated_at)) + '</span></span>'
      + '<span class="fx-c2"><span class="fx-by">' + (p.owner ? avatarIcon(p.owner) : "") + '<span>' + esc(p.owner || "—") + '</span></span>' + squares(p) + '</span>'
      + '<span class="fx-note' + (note[1] ? " warn" : "") + '">' + esc(note[0]) + '</span></a>';
  }
  var COUNTS = null;
  function drawBoard() {
    if (!REG) { if (DOWN.reg) { $("#line-note").textContent = DOWN.reg; for (var i = 0; i < LINE.length; i++) { $("#col-" + i + "-n").textContent = "—"; } } return; }
    // A refresh that did not answer leaves the last answer's cards, and says so.
    $("#line-note").textContent = DOWN.reg || "live · a card moves when its job ends";
    var cols = [[], [], [], [], []], now = Date.now(), first = !Object.keys(SEEN).length;
    REG.forEach(function (p) {
      var s = stageOf(p);
      // A card that moved, or one that arrived after the first drawing, is lit a moment and kept at the top of its column for a minute.
      if (!first && SEEN[p.name] !== s && s >= 0) FRESH[p.name] = now;
      SEEN[p.name] = s;
      if (s >= 0) cols[s].push(p);
    });
    var landed = REG.filter(function (p) { return p.landed; });
    var older = function (a, b) { return String(a.updated_at || "") < String(b.updated_at || "") ? -1 : 1; };
    // The queue's order, oldest first — but what just moved and the reader's own come first, so "Follow it on the line" finds it.
    var pinned = function (p) { return (FRESH[p.name] && now - FRESH[p.name] < 60000) || (WHO.login && p.owner === WHO.login) ? 1 : 0; };
    cols.forEach(function (list, i) {
      list.sort(i === 4 ? function (a, b) { return older(b, a); } : function (a, b) { return pinned(b) - pinned(a) || older(a, b); });
      var total = i === 4 ? Math.max(landed.length, list.length) : list.length, shown = list.slice(0, 5);
      $("#col-" + i + "-n").textContent = num(total);
      $("#col-" + i).innerHTML = shown.map(function (p) { return cardOf(p, i); }).join("") + (total > shown.length ? '<span class="fx-more-n">+' + num(total - shown.length) + (i === 4 ? " earlier" : " more") + '</span>' : '');
    });
    COUNTS = { line: cols[0].length + cols[1].length + cols[2].length + cols[3].length, building: cols[1].length, landed: landed };
    // What waits for a maintainer is the review list's own count (one truth with Review's tile): read again when a package enters or leaves the two review columns, never on a clock.
    var inReview = cols[2].concat(cols[3]).map(function (p) { return p.name; }).sort().join(",");
    if (READY !== null && inReview !== READY) { clearTimeout(REVIEWING); REVIEWING = setTimeout(loadReview, 1500); }
    READY = inReview;
  }

  // ---- the four numbers: the line's own counts, the listing's busy workers, the review list's waiting (one truth with Review), the registry's landed (approved by a maintainer — the Pool's and People's word). A list that did not answer reads "—", its reason on hover.
  var LANDED_ONCE = {};
  function tile(key, row, why) {
    var n = $("#t-" + key + "-n"), s = $("#t-" + key + "-s"); if (!n || !s) return;
    if (!row) { if (why) { n.textContent = "—"; s.innerHTML = '<span title="' + esc(why) + '">did not answer</span>'; } return; }
    if (!LANDED_ONCE[key]) { LANDED_ONCE[key] = true; countUp(n, row[3]); } else n.textContent = row[1];
    s.innerHTML = row[2];
  }
  function drawTiles() {
    var wc = LISTING ? workerCounts(LISTING.workers || []) : null, from = {};
    if (COUNTS) COUNTS.landed.forEach(function (p) { if (p.owner && MAINT && !Object.prototype.hasOwnProperty.call(MAINT, p.owner)) from[p.owner] = 1; });
    tile("line", COUNTS ? ["In the factory", num(COUNTS.line), "requests on the line", COUNTS.line] : null, DOWN.reg);
    tile("building", COUNTS ? ["Building now", num(COUNTS.building), wc ? num(wc.building) + " of " + num(wc.alive) + " workers busy" : "packages building", COUNTS.building] : null, DOWN.reg);
    // The oldest one's age rides on hover: the tile says what the number is, in a line.
    tile("ready", REVIEW ? ["Ready for review", num(REVIEW.waiting), REVIEW.oldest_ms ? '<span title="the oldest has waited ' + esc(span(REVIEW.oldest_ms)) + '">waiting for a maintainer</span>' : "waiting for a maintainer", REVIEW.waiting] : null, DOWN.review);
    var landed = COUNTS ? COUNTS.landed : [];
    tile("shipped", COUNTS ? ["Shipped", num(landed.length), "approved by a maintainer, from " + num(Object.keys(from).length) + " contributors", landed.length] : null, DOWN.reg);
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
      var s = stageOf(p), off = p.blocked_at ? OFF_WORD.blocked : OFF_WORD[p.status], word = s >= 0 ? LINE[s] : off || ["Off the line", "circle-slash"];
      var note = s >= 0 ? noteOf(p, s)[0] : (p.detail || "");
      return '<a class="fx-mrow ' + (s >= 0 ? "c" + s : "c-off") + '" href="' + esc(pkgHref(p.name, s === 4 ? "edge" : "lab", Object.keys(p.targets || {})[0] || ARCHES[0])) + '"><span class="nm"><b>' + esc(p.name) + '</b><span>' + esc(p.release || "") + '</span></span><span class="fx-stage">' + lucide(word[1], 13) + esc(word[0]) + '</span>' + squares(p) + '<span class="note">' + esc(note) + '</span><span class="go" aria-hidden="true">›</span></a>';
    }).join("") || '<p class="fx-mempty">Nothing yet. Your first request shows up here.</p>';
    if (isMaintainer()) { maint.setAttribute("href", "/review"); maint.textContent = "Review queue" + (REVIEW ? " · " + num(REVIEW.waiting) + " waiting" : "") + " ›"; }
    else {
      var approved = mine.filter(function (p) { return p.landed; }).length;
      maint.setAttribute("href", "/docs/governance#becoming");
      maint.textContent = approved ? num(approved) + " approved · you can apply to maintain ›" : "Get one approved to become a maintainer ›";
    }
  }

  function draw() { drawBoard(); drawTiles(); drawWorkers(); drawMine(); }

  // ---- the reads. The registry: at load, again when a job starts or ends (its copy at the edge is thirty seconds old at most, so once more after that), and every five minutes for what moves no job (a rejection). The listing: every twenty seconds, the Workers page's rhythm and its very address. The review list: at load, and when a package enters or leaves the review columns.
  function loadRegistry() {
    return api("GET", "/api/v1/factory/packages").then(function (d) { REG = d.packages || []; DOWN.reg = ""; draw(); })
      .catch(function (e) { DOWN.reg = noAnswer("registry", e); draw(); });
  }
  function loadListing() {
    return api("GET", "/api/v1/factory?limit=10").then(function (d) {
      LISTING = d; DOWN.listing = "";
      var sig = (d.workers || []).map(function (w) { return w.id + ":" + (w.current_task || ""); }).concat((d.tasks || []).filter(function (t) { return t.status === "leased" || t.status === "queued"; }).map(function (t) { return "#" + t.id; })).sort().join(",");
      if (SIG !== null && sig !== SIG) { loadRegistry(); clearTimeout(AGAIN); AGAIN = setTimeout(loadRegistry, 35000); }
      SIG = sig; draw();
    }).catch(function (e) { DOWN.listing = noAnswer("worker listing", e); draw(); });
  }
  function loadReview() {
    return api("GET", "/api/v1/factory/review").then(function (d) { REVIEW = d; DOWN.review = ""; drawTiles(); drawMine(); })
      .catch(function (e) { DOWN.review = noAnswer("review list", e); drawTiles(); });
  }
  loadRegistry(); loadListing(); loadReview();
  setInterval(loadListing, 20000); setInterval(loadRegistry, 300000);
  maintainerSet(function (m) { MAINT = m || {}; drawTiles(); });
  // The week's series: how long a job of a kind takes, what a worker's bar is measured against — the old Factory's rhythm, two minutes.
  liveStats(function (d) { STATS = d; drawWorkers(); }, 120000);

  // ---- the fields, live for everyone: a visitor checks a name and builds a prompt; only the send is a person's.
  var fields = [["#fx-name", function () { var el = $("#fx-name"), low = el.value.toLowerCase(); if (low !== el.value) el.value = low; AUTO["#fx-name"] = null; checkName(); prompt(); signInLink(); }], ["#fx-url", function () { readUrl(); prompt(); }], ["#fx-license", function () { prompt(); ready(); }], ["#fx-desc", ready], ["#fx-source", ready], ["#fx-version", ready]];
  fields.forEach(function (f) { var el = $(f[0]); if (el) el.addEventListener("input", f[1]); });
  document.querySelectorAll("#fx-checklist input[data-check]").forEach(function (i) { i.addEventListener("change", ready); });
  if (NAMED && !RENEW) { $("#fx-name").value = NAMED; checkName(); }
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
      // Four numbers: the line's own counts (in the factory, building now), the review list's own `waiting` and `oldest_ms` — the number Review's and the Pipeline's tiles say — and the registry's `landed`, captioned as what it counts: approved by a maintainer, from the contributors who are not in the maintainer set. A list that did not answer reads "—" with its reason on hover.
      id: "factory.tiles",
      page: "/factory",
      anchor: ['<div class="op-stats fx-stats" id="tiles">', 'id="t-line-n"', 'id="t-building-n"', 'id="t-ready-n"', 'id="t-shipped-n"', "In the factory", "Building now", "Ready for review", "Shipped"],
      script: ["function drawTiles()", '"Ready for review"', "REVIEW.waiting", "REVIEW.oldest_ms", "span(REVIEW.oldest_ms)", "workerCounts(LISTING.workers || [])", "p.landed", "maintainerSet(function (m)", '"approved by a maintainer, from "', '" contributors"', "countUp(n, row[3])", "did not answer"],
      reads: [
        { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.name", "packages.0.owner", "packages.0.landed", "packages.0.targets"] },
        { path: "/api/v1/factory/review", fields: ["waiting", "oldest_ms"] },
        { path: "/api/v1/factory?limit=10", fields: ["workers", "workers.0.alive", "workers.0.current_task", "workers.0.revoked_at"] },
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
      // The name's live check, by the request's own rule: PKGNAME spliced in (request.ts), then the server's word — available, reserved, taken (linked to its page), blocked, being built — asked once per name and architectures; the holder reads "yours".
      id: "factory.name-check",
      page: "/factory",
      anchor: ['id="fx-name-say"', 'id="fx-name-box"'],
      script: [`var NAME_RULE = ${String(PKGNAME)}`, `NAME_WORDS = ${JSON.stringify(PKGNAME_RULE)}`, '"/api/v1/factory/names/" + encodeURIComponent(n) + "?arches=" + archesOn().join(",")', '"✗ invalid characters"', '"✓ available"', '"✗ reserved by a pending request"', "✗ taken · open it ›", '"✗ blocked by a maintainer"', '"✓ yours · sending renews the request"'],
      reads: [
        { path: `/api/v1/factory/names/${F.factoryPkg}?arches=${F.arch}`, fields: ["name", "arches", "state", "why", "owner", "status", "freed", "renew", "provided"] },
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
      // The send: "Sign in to send" for nobody, served so and coming back to the Factory with the name typed so far; the button for a person, disabled while the POST is in flight, and what was sent — the record, its signature, the builds queued — once it is.
      id: "factory.send",
      page: "/factory",
      anchor: ['<span id="fx-send-slot"><a class="op-btn" id="fx-send" href="/auth/github?next=/factory">Sign in to send</a></span>', 'id="fx-state"', 'id="fx-done"'],
      script: ["function signInLink()", '"/auth/github?next=" + encodeURIComponent(next)', '"Send request"', "btn.disabled = true", '"Checking the pool, the project and the source…"', "state(d.error, true)", "esc(q.record)", "q.signature", 'taskPill("queued")', "b.queue[a].position", "userHref(WHO.login)", "Follow it on the line ›"],
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
      // The other tab: a prompt built from the form, copied with the kit's well, the agents it works with, and the MCP tools it would use — proposed and not built (#252), said so, with the API that takes the same request today.
      id: "factory.agent-tab",
      page: "/factory",
      anchor: ['id="tab-agent" aria-selected="false"', 'id="fx-agent" role="tabpanel"', '<button type="button" class="op-copy" data-op-copy="">copy prompt</button>', 'id="fx-prompt"', ...WORKS_WITH.map(([label, mark]) => `op-b-${mark}" style="--op-i-s:22px" role="img" aria-label="${label}"`), "<code>request_package</code>", "<code>request_status</code>", '<span class="op-pill na" title="signed off, not built yet: #252">proposed</span>', 'href="/docs/omarchy-cli-mcp"', "<code>POST /api/v1/factory/packages</code>"],
      script: ["function tab(form)", 'location.hash === "#fx-agent"', "function prompt()", '"Request " + (nameOf() || "<name>") + " on omarchy-pool: source "', "ARCHES.join(\" and \")"],
      reads: [{ path: "/docs/omarchy-cli-mcp", json: false }, { path: "/api", json: false }],
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
      // The workers, live: each one alive, busy first, with its agent's mark, its job and step from the listing's task, and how far it is against the week's time of a job of its kind (the stats series: jobs_daily and builds_daily carry ms). The listing is polled as the Workers page polls it, at its very address.
      id: "factory.workers",
      page: "/factory",
      anchor: ['<div class="op-card fx-workers" id="workers">', 'id="fx-busy"', 'id="fx-wlist"', '<a href="/workers">All workers →</a>', 'class="op-live-dot"'],
      script: ['api("GET", "/api/v1/factory?limit=10")', "setInterval(loadListing, 20000)", "function workerRowOf(w)", "agentMark(mark, w.agent, 22)", "workerName(w)", "function stepOf(t)", '"rebuilding from scratch"', '"writing the PKGBUILD"', "function typicalMs(t)", "s.builds_daily", "s.jobs_daily", "liveStats(function (d) { STATS = d; drawWorkers(); }, 120000)", 'noAnswer("worker listing", e)'],
      reads: [
        {
          path: "/api/v1/factory?limit=10",
          fields: ["workers", "workers.0.id", "workers.0.arch", "workers.0.agent", "workers.0.alive", "workers.0.current_task", "workers.0.revoked_at", "tasks", "tasks.0.id", "tasks.0.name", "tasks.0.kind", "tasks.0.trust", "tasks.0.status", "tasks.0.arch", "tasks.0.attempts", "tasks.0.max_attempts", "tasks.0.started_at", "tasks.0.pkgbuild_ref", "tasks.0.params"],
        },
        { path: "/api/v1/stats", fields: ["series.jobs_daily", "series.builds_daily", "series.builds_daily.0.ms", "series.builds_daily.0.trust", "series.builds_daily.0.status", "series.builds_daily.0.n"] },
        { path: "/workers", json: false },
      ],
      visible: EVERYONE,
    },
    {
      // The line: five columns, a card per package placed by its targets (targets.ts, the server's rule for where each architecture stands) — checking, building, ready for review, in review, shipped — each card linking the package's one address, its architectures as the kit's squares with the shell's words; read again when a job starts or ends, and a card that moved is lit.
      id: "factory.line",
      page: "/factory",
      anchor: ['<section class="fx-line" id="line"', 'id="line-note"', "live · a card moves when its job ends", 'id="board"', ...LINE.map((_, i) => `id="col-${i}"`), ...LINE.map(([name]) => `<span>${escapeHtml(name)}</span>`)],
      script: ['api("GET", "/api/v1/factory/packages")', "function stageOf(p)", 'has("building")', 'has("reviewing")', "TARGET_WORD[x.status]", 'pkgHref(p.name, s === 4 ? "edge" : "lab", arch)', "avatarIcon(p.owner)", " op-fresh", "if (SIG !== null && sig !== SIG) { loadRegistry();", "setInterval(loadRegistry, 300000)", 'noAnswer("registry", e)'],
      reads: [
        { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.name", "packages.0.owner", "packages.0.status", "packages.0.release", "packages.0.targets", "packages.0.updated_at", "packages.0.landed", "packages.0.blocked_at", "packages.0.detail"] },
        { path: "/api/v1/factory/review", fields: ["waiting"] },
      ],
      visible: EVERYONE,
    },
    {
      // Your requests: signed in only — the reader's packages where they stand on the line (or off it, with the registration's own words), the rule that nobody reviews their own, and the way to the review queue for a maintainer or to becoming one for a contributor.
      id: "factory.mine",
      page: "/factory",
      anchor: ['<section class="fx-mine" id="mine" hidden', 'id="mine-n"', 'id="mine-list"', 'href="/docs/governance#becoming"', "You never review your own requests. Another maintainer picks them up."],
      script: ["function drawMine()", "sec.hidden = !WHO.me", "p.owner === WHO.login", '"Review queue"', '" approved · you can apply to maintain ›"', '"Get one approved to become a maintainer ›"', "Nothing yet. Your first request shows up here."],
      reads: [
        { path: "/api/v1/factory/packages", fields: ["packages.0.owner", "packages.0.landed"] },
        { path: "/docs/governance", json: false },
      ],
      visible: SIGNED_IN,
    },
  ];
};
