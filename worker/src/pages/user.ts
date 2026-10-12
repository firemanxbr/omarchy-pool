/**
 * A contributor's or maintainer's public page: who they are on GitHub,
 * what they registered and built, what they approved, the workers they run.
 * Their own page is also their workspace — "Sign in with GitHub" lands here:
 * Build and remove on the packages, drain and revoke on the workers, the
 * evidence of every build, the staging quota, a token for scripts. Everything
 * is the public API (`/api/v1/factory/*`) with the browser session.
 *
 * Drawn with the v1 kit since #412, as the redesigned pages are (a host's, a
 * worker's, a package's, Review): the head, four numbers, then a card per
 * part. The package is the unit: one block per registration, each of its
 * architectures a line inside it — where it stands, its latest build, the
 * gate on it, and its Build — with Build all and Remove on the block's head,
 * all of it drawn without opening anything. One control opens the package's
 * story (the request as the form checks it, each architecture's score with
 * the audit and what comes next) and its builds, folded under it: there is
 * no flat list of builds any more. A worker's row carries Drain, or Resume,
 * beside Revoke, and the way to its page's other operations; a host's row
 * links its page, where its pool cap is set.
 *
 * The page is the same for every role: Share and Token, the way to request
 * and to register, Build, Remove and Renew on a package, Drain and Revoke
 * on a worker, Withdraw on an approval, the evidence of every build —
 * drawn for everyone. What this viewer may not do is the same control grey
 * with the reason in its title (the shell's gate()), never hidden and never
 * a sentence in its place; the reason is the server's own word
 * (GET /users/<login>/can, no-store: the profile is cached for everyone,
 * the rights are the caller's), so a grey button is one the door would
 * refuse in the same words. A maintainer keeps what is theirs on anyone's
 * page — revoke, drain, remove, withdraw.
 */
import { page, servedGrey, workerPanels } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";
import { POOL_HOSTS } from "../routes/contributors";
import { OWNER_NOT_MAINTAINER } from "../hosts";
import { SELF_CAUSE } from "../routes/passkeys";
import { UNPIN_AFTER_DRAIN_MINUTES } from "../orders";

/**
 * The controls served grey for everyone, whose they are in their title —
 * the shell's servedGrey, what gate() writes — and drawn again through
 * gate() once the server said what this viewer may do: live for the owner,
 * the sign-in for nobody. One template each, in the HTML and in the script.
 * Share is served live: the page is public and its link is anyone's.
 */
const SHARE_BTN = `<button type="button" class="op-btn" id="share-open" title="the link to this page, to post anywhere">Share</button>`;
const TOKEN_BTN = `<button type="button" class="op-btn" id="token-open" title="a token for scripts and CI">Token</button>`;
const REQUEST_LINK = `<a class="more-link" id="pk-request" href="/factory#request">+ request one →</a>`;
/**
 * The workers are the maintainers' hosts (#331, #346, design v2 §6.5): the
 * project provides them for everyone and its maintainers are their only
 * providers. Nothing to run is served; a maintainer on their own page reads
 * that their new machine joins as a host (the Hosts section below) and that
 * no legacy registration is made any more (#346: POST /factory/workers
 * answers 410) — there is no worker form; everyone else reads that their
 * packages build on the pool's hosts, with the way to the packaging docs —
 * except on a maintainer's page, whose section lists the hosts they
 * provide, where the line is hidden. POST /factory/workers refuses a
 * contributor with the same sentence (POOL_HOSTS).
 */
const poolHostsLine = () => `<p class="sub" id="w-pool" style="margin:0 0 10px;font-size:12.5px">Nothing to run here: ${POOL_HOSTS}, which the maintainers provide. Request a package and the pool builds it. <a href="/docs/factory#contribute-a-package">How packaging works →</a></p>`;
const WORKER_OWN = `<p class="sub" style="margin:0 0 10px;font-size:12.5px">Maintainers only: the project's compute is its maintainers' hosts, and a new machine is added as a host (below). The legacy registrations from before hosts retired with P3 (#346): none is made any more, one not retired yet is listed here until its owner or a maintainer revokes it, and each keeps its history on its page. <a href="/docs/worker-host#maintainer-hosts">How a host joins →</a></p>`;
/**
 * Add a host (#321, design v2 §6.1): a maintainer's, on their own page — a
 * name and where it runs; the answer is one command to paste on the machine,
 * with a one-time token in the environment of `sh`. The machine enrolls and
 * the host waits here, with its fingerprint and where its key lives (in its
 * TPM, or a file, #330), for its owner's Confirm.
 */
const HOST_TOGGLE = `<button type="button" class="more-link" id="h-toggle" title="a name, where it runs, then one command to paste on the machine">+ add a host</button>`;
const HOST_FORM = `<label>Name <input type="text" id="h-name" placeholder="vps-1" pattern="[a-z0-9](?:[a-z0-9\\-]{0,30}[a-z0-9])?" title="lowercase letters, digits and dashes, 1 to 32, not ending in a dash" required></label> <label>Where <input type="text" id="h-where" maxlength="80" placeholder="a VPS in Falkenstein" autocomplete="off"></label> <button type="submit" id="h-btn">Add a host</button>`;
const HOST_OWN = `<p class="sub" style="margin:0 0 10px;font-size:12.5px">Maintainers only: a host runs the signed host bundle and one isolated container per task, as many as its capacity allows. Paste the command on the machine, as the user the agent runs as; it prints the host key's fingerprint, and this page shows it with <b>Confirm</b>. Nothing claims before that. <a href="/docs/worker-host#maintainer-hosts">How a host joins →</a></p><form id="host-form" class="form" onsubmit="return false" hidden></form><div id="h-new" hidden><p class="sub" style="font-size:12.5px">One command, on the machine, within 15 minutes; the token works once, and no process's arguments (<code>ps</code>) show it:</p><pre><span class="copy" data-copy="host">copy</span><span id="h-cmd"></span></pre></div>`;
/** Add a passkey (#257): a name for it and the button that starts the browser's request — a maintainer's. */
const PASSKEY_FORM = `<label>Name <input type="text" id="pk-label" maxlength="40" placeholder="this laptop" autocomplete="off"></label> <button type="submit" id="pk-add">Add a passkey</button>`;
/** …and what stands in its place for someone who is not a maintainer but still holds a passkey (a maintainer once): the reason, visible, and their Remove below. */
const PASSKEY_NOT_A_MAINTAINER = `<p class="sub" id="pk-not" style="margin:0">Passkeys are for maintainers: they confirm approve and block. You can remove the ones you hold below.</p>`;

/**
 * The page's own rules, served after the kit's sheet (#412): the 1056px
 * frame and its head, the two cards under the numbers, a package's block
 * and its architecture lines, the folded history, the hosts' table on a
 * phone. Every rule is under an up- class, or .up in front where it refines
 * a kit primitive. Tokens only.
 *
 * And the page's rules from before (#257): the passkeys' status line is
 * always in the page — empty, it takes no room — so a screen reader hears
 * each thing it says, and a failure is marked as one (the kit's red, as a
 * refusal is); the action column is named for a screen reader; on a phone
 * the algorithm column goes, so Remove stays on the screen; a heading a
 * link landed on shows its focus square, as the kit's controls do.
 */
const CSS = String.raw`
  /* One track no wider than the page: a worker table wider than a phone scrolls inside its own frame, never the page sideways. */
  .up { max-width: 1056px; margin: 0 auto; padding-top: 12px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .up > * { min-width: 0; }
  .up section { margin: 0; }
  .up a { text-decoration: none; } .up a:hover { color: var(--green); }
  .up :is(a, button):focus-visible { outline: 1px solid var(--green); outline-offset: 2px; }
  .up-head { display: grid; gap: 10px; } .up-head .crumbs { margin: 0; }
  .up-id { display: flex; flex-wrap: wrap; align-items: center; gap: 14px 18px; }
  .up-idt { flex: 1 1 360px; min-width: 0; display: grid; gap: 6px; }
  .up-idt .op-hero { max-width: none; overflow-wrap: anywhere; }
  .up-line { margin: 0; display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; font-size: 13px; color: var(--muted); }
  .up-line a { color: var(--muted); }
  .up-share { display: flex; flex-wrap: wrap; gap: 8px; }
  /* Four numbers in four columns, or two and two on a phone or a narrow window: never a track left empty. */
  #tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  @media (max-width: 899px) { #tiles { grid-template-columns: 1fr 1fr; } }
  #tiles .op-stat .n { white-space: normal; overflow-wrap: anywhere; }
  .up-pair { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 16px; }
  @media (max-width: 899px) { .up-pair { grid-template-columns: minmax(0, 1fr); } }
  .up .op-card-h h2 { margin: 0; font: 600 15px var(--font-display); letter-spacing: 0; }
  .up .op-card-h > a { color: var(--dim); font-size: 12.5px; }
  .up-hr { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
  .up-note { margin: 0; font-size: 12.5px; color: var(--dim); max-width: 760px; } .up-note a { color: var(--green); }
  .up-lede { padding: 12px 16px 0; }
  .up-pad { padding: 12px 16px; }
  .up-empty { margin: 0; padding: 14px 16px; font-size: 13px; color: var(--dim); }
  .up-score { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px 18px; align-items: center; }
  .up-score > b { font: 600 44px/1 var(--font-display); color: var(--green); font-variant-numeric: tabular-nums; }
  .up-score > .up-note { grid-column: 1 / -1; }
  .up-kv { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; font-size: 13px; }
  .up-kv dt { color: var(--dim); } .up-kv dd { margin: 0; overflow-wrap: anywhere; }
  .up .op-btn.sm { padding: 3px 11px; font-size: 12.5px; line-height: 1.5; }
  .up .op-btn[disabled] { opacity: 1; background: transparent; border-color: var(--line); color: var(--dim); }
  /* A package (#412): its head (the name, the stage, Build all and Remove), where it stands, a line per architecture with its Build at the
     line's end, and the one control that opens its story and its builds. On a phone an architecture's facts go under its name; its Build stays
     on the line. */
  .up-pkgs { display: grid; }
  .up-pkg { display: grid; gap: 6px; min-width: 0; padding: 12px 16px; border-top: 1px solid var(--line); }
  .up-pkgs > .up-pkg:first-child { border-top: 0; }
  .up-pkg.skel { padding: 16px; } .up-pkg.skel .skl { width: 60%; }
  .up-pkg-h { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-width: 0; }
  .up-name { font: 600 16px var(--font-display); color: var(--text); overflow-wrap: anywhere; }
  .up-acts { margin-left: auto; display: inline-flex; flex-wrap: wrap; gap: 8px; }
  .up-stands { margin: 0; font-size: 12.5px; color: var(--dim); overflow-wrap: anywhere; }
  .up-arches { display: grid; }
  .up-arch { display: grid; grid-template-columns: 10px 7ch minmax(0, 1fr) auto; gap: 6px 10px; align-items: center; padding: 7px 0; border-top: 1px dashed var(--line); font-size: 13px; }
  .up-arch > b { font: 600 13px var(--font-mono); }
  .up-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0; }
  .up-facts .v { color: var(--dim); font: 12px var(--font-mono); overflow-wrap: anywhere; }
  .up-facts .when { color: var(--dim); font-size: 12px; }
  @media (max-width: 560px) { .up-arch { grid-template-columns: 10px minmax(0, 1fr) auto; } .up-arch > .up-facts { grid-column: 2 / -1; grid-row: 2; } }
  .up-more { justify-self: start; padding: 2px 0; border: 0; background: none; color: var(--green); font: inherit; font-size: 12.5px; cursor: pointer; }
  .up-more:hover { text-decoration: underline; }
  .up-open { display: grid; gap: 12px; padding-top: 6px; min-width: 0; }
  .up-open .pkarch, .up-open .pkreq { margin: 0; }
  .up-table { overflow-x: auto; }
  .up-hist td { font-size: 12.5px; } .up-hist td.why { min-width: 140px; max-width: 320px; overflow-wrap: anywhere; }
  /* A build's row on a phone keeps the number, the version, the architecture, the status, when and the evidence; why, where and how long are on its page. */
  @media (max-width: 640px) { .up-hist :is(th, td):is(:nth-child(5), :nth-child(6), :nth-child(7)) { display: none; } }
  .up-sec-h { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 8px 14px; margin: 0 0 8px; }
  .up-sec-h h2 { margin: 0; font: 600 18px var(--font-display); letter-spacing: 0; }
  .up-sec-h + .up-note { margin-bottom: 12px; }
  .up-sr { position: absolute; width: 1px; height: 1px; margin: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  #pk-said:empty, #pk-reset-said:empty { margin: 0; }
  #pk-said.err, #pk-reset-said.err { color: var(--text); border: 1px solid var(--red); padding: 10px 12px; font-size: 13.5px; }
  #passkeys h2:focus-visible, #agents h2:focus-visible { outline: 1px solid var(--green); outline-offset: 2px; }
  #pk-reset .form button.danger, #pk-reset .form button.danger:hover { border-color: var(--red); color: var(--red); }
  @media (max-width: 520px) { #pk-table th:nth-child(2), #pk-table td:nth-child(2) { display: none; } }
  #hosts-table .h-detail { overflow-wrap: anywhere; min-width: 16ch; }
  /* On a phone the hosts table keeps Host, Status, Units and Confirm in view, its status wrapping rather than pushing Confirm out: the arches are in the Host cell's detail; the release, the report and the pool cap on the host page, which the name opens. */
  @media (max-width: 520px) { #hosts-table :is(th, td):is(:nth-child(3), :nth-child(5), :nth-child(6), :nth-child(7)) { display: none; } #hosts-table .pill { white-space: normal; } #hosts-table :is(th, td) { padding-left: 6px; padding-right: 6px; } #hosts-table .h-detail { min-width: 12ch; } }
  #h-new pre { position: relative; padding-right: 76px; white-space: pre-wrap; overflow-wrap: anywhere; }
  #h-stop { padding: 0 16px 14px; display: grid; gap: 8px; justify-items: start; }
  #h-stop .small-btn.danger { border-color: var(--red); color: var(--red); }
`;

/** A number's place before the profile answers: the kit's tile with the frame's skeleton bars, gone with the others (endSkeleton) when no profile answers. */
const SKELETON_STAT = `<div class="op-stat skel"><span class="k"><span class="skl"></span></span><b class="n"><span class="skl"></span></b><span class="s"><span class="skl"></span></span></div>`;

const body = (login: string) => String.raw`
  <div class="up">
  <div id="pk-notice" hidden></div>
  <section class="up-head" aria-labelledby="title">
    <p class="crumbs"><a href="/factory">Factory</a> / <span id="crumb"></span></p>
    <div class="up-id">
      <span class="avatar lg" id="avatar">…</span>
      <div class="up-idt"><h1 class="op-hero" id="title">…</h1><p class="up-line" id="line"></p></div>
      <span class="up-share" id="share-btn">${SHARE_BTN} ${servedGrey(TOKEN_BTN, `only ${login} mints their token`)}</span>
    </div>
  </section>

  <div class="op-stats" id="tiles">${SKELETON_STAT.repeat(4)}</div>

  <div class="up-pair">
    <section class="op-card" aria-labelledby="activity-h">
      <div class="op-card-h"><h2 id="activity-h">Activity</h2><small>16 weeks · builds, decisions, packages</small></div>
      <div class="op-card-b"><div class="activity" id="activity"></div><p class="up-note" id="activity-note" style="margin-top:8px"></p></div>
    </section>
    <section class="op-card" id="record-section" aria-labelledby="record-h">
      <div class="op-card-h"><h2 id="record-h">Track record</h2><a href="/docs/governance">the formula →</a></div>
      <div class="op-card-b up-score"><b id="score">…</b><dl class="up-kv" id="record"></dl><p class="up-note" id="score-f"></p></div>
    </section>
  </div>

  <section class="op-card" id="packages-section" aria-labelledby="packages-h">
    <div class="op-card-h"><h2 id="packages-h">Packages</h2><span class="up-hr"><small id="quota"></small>${servedGrey(REQUEST_LINK, `only ${login} requests here`)}</span></div>
    <p class="up-note up-lede">Registered under this name. The pool builds each one as evidence, the project builds it again, and <b>another</b> maintainer decides. A line per architecture: where it stands, its latest build, its Build.</p>
    <div class="up-pkgs" id="packages"><div class="up-pkg skel"><span class="skl"></span></div><div class="up-pkg skel"><span class="skl"></span></div></div>
  </section>

  <section class="up-workers" aria-labelledby="workers-h">
    <div class="up-sec-h"><h2 id="workers-h">Workers</h2><span id="w-slot"></span></div>
    <p class="up-note">The legacy registrations under this name, from before hosts, until they are retired (#346): each keeps its history on its page. The id opens a worker's page; Drain and Revoke are on its row. The machines this person provides are hosts, below and on the <a href="/workers">Workers</a> page.</p>
    <div id="w-own">${poolHostsLine()}</div>
    ${workerPanels([
      { kind: "community", blurb: "legacy community sets, until they retire: any contributor's packages, as a host builds them", hidden: true },
      { kind: "review", blurb: "the maintainers' side: builds again, publishes, audits", hidden: true },
      { kind: "project", blurb: "the pool's own jobs, on the host this maintainer keeps", hidden: true },
    ])}
    <p class="up-note" id="w-none" hidden>No worker registered under this name.</p>
  </section>

  <section class="op-card" id="hosts" aria-labelledby="hosts-h" hidden>
    <div class="op-card-h"><h2 id="hosts-h">Hosts</h2><span id="h-slot"></span></div>
    <div class="up-pad"><p class="up-note">The machines this maintainer provides: each enrolled by its owner, confirmed by fingerprint, and trusted by the same pull request that named them a maintainer. A host's page sets its pool cap.</p><div id="h-own"></div></div>
    <div class="up-table"><table class="op-table" id="hosts-table"><thead><tr><th>Host</th><th>Status</th><th>Arches</th><th>Units</th><th>Release</th><th>Reported</th><th>Pool cap</th><th aria-label="Confirm"></th></tr></thead><tbody></tbody></table></div>
    <p class="up-empty" id="h-none" hidden>No host under this name.</p>
    <div class="up-pad" id="h-notices" hidden></div>
    <div id="h-stop" hidden></div>
  </section>

  <section class="op-card" id="agents" aria-labelledby="agents-h" hidden>
    <div class="op-card-h"><h2 id="agents-h">Agents</h2><a class="more-link" href="/agents#login">+ grant one →</a></div>
    <p class="up-note up-lede">The agents you let act as you through omarchy-cli's tools (<code>omarchy-cli login</code>), and the decisions they drafted for you. Only you see this section: nothing an agent drafts is decided, or on the record, until you confirm it in the browser. <a href="/docs/omarchy-cli-mcp#write-tools">How it works →</a></p>
    <div class="up-pad"><div class="up-table"><table class="op-table" id="grants"><thead><tr><th>Agent</th><th>Scopes</th><th>Granted</th><th>Expires</th><th>Last used</th><th>State</th></tr></thead><tbody></tbody></table></div>
    <div class="up-table" style="margin-top:12px"><table class="op-table" id="drafts"><thead><tr><th>Drafted</th><th>Package</th><th>Verdict</th><th>Agent</th><th>State</th><th>Note</th></tr></thead><tbody></tbody></table></div></div>
  </section>

  <section class="op-card" id="passkeys" aria-labelledby="passkeys-h" hidden>
    <div class="op-card-h"><h2 id="passkeys-h">Passkeys</h2></div>
    <div class="up-pad" style="display:grid;gap:12px">
      <p class="up-note">Approve and block are confirmed with a passkey: on Review, on a package's page, and what your agents draft. Your device asks for your fingerprint, face or PIN, which no token and no agent can supply. Your first passkey is added with your session. Adding another, or removing one, asks for a passkey you hold. Lost your only one? Another maintainer resets them, and your token and your agents' grants go with them. The pool keeps each one's public key and credential id, nothing else, and the journal says when one is added, removed or reset. Only you see this section. <a href="/docs/omarchy-cli-mcp#write-tools">How it works →</a></p>
      <form id="pk-form" class="form" onsubmit="return false"></form>
      <p class="sub" id="pk-said" role="status" aria-live="polite"></p>
      <div class="up-table"><table class="op-table" id="pk-table"><thead><tr><th>Name</th><th>Algorithm</th><th>Added</th><th>Last used</th><th><span class="up-sr">Remove</span></th></tr></thead><tbody></tbody></table></div>
    </div>
  </section>

  <section class="op-card" id="pk-reset" aria-labelledby="pk-reset-h" hidden>
    <div class="op-card-h"><h2 id="pk-reset-h">A lost passkey</h2></div>
    <div class="up-pad" style="display:grid;gap:12px">
      <p class="up-note">A maintainer who lost their only passkey gets a way back from another maintainer. Every passkey of theirs goes, with their token and their agents' grants, and they are signed out. They add a new passkey and make a new token after signing in with GitHub again. Your own passkey confirms the reset, and the reason goes on the public journal and on a record the pool signs.</p>
      <form id="pk-reset-form" class="form" onsubmit="return false"><label>Why <input type="text" id="pk-reset-why" minlength="4" maxlength="300" placeholder="lost their phone and their key" autocomplete="off" required></label> <button type="submit" id="pk-reset-go" class="danger">Reset the passkeys</button></form>
      <p class="sub" id="pk-reset-said" role="status" aria-live="polite"></p>
    </div>
  </section>

  <section class="op-card" id="approvals-section" aria-labelledby="approvals-h" hidden>
    <div class="op-card-h"><h2 id="approvals-h">Approvals</h2></div>
    <p class="up-note up-lede">Decisions this maintainer signed: what they let into the pool, and where it stands today, ring by ring; what they sent back; what they took back. A maintainer takes a standing approval back from here: the package leaves every ring, another maintainer decides.</p>
    <div class="up-pad"><div class="up-table"><table class="op-table" id="approvals"><thead><tr><th>When</th><th>Package</th><th>Arch</th><th>Decision</th><th>Where it stands</th><th>Note</th></tr></thead><tbody></tbody></table></div></div>
  </section>
  </div>
`;

const SCRIPT = String.raw`
  var login = decodeURIComponent(location.pathname.split("/")[2] || "");
  $("#crumb").textContent = login;
  var API = "/api/v1/factory";
  // ---- what this viewer may do here, from the server: GET /users/<login>/can (no-store — the profile is cached for everyone, the rights are the caller's) says for each control whether it is live and, where not, why, in the words the door would refuse with. Every control below is drawn for everyone and reads CAN; nobody's answer — nothing, the sign-in as the reason — until it lands.
  var CAN = { why: {}, packages: {}, workers: {} };
  function may(right) { return CAN[right] === true; }
  function reason(right) { return CAN.why[right] || "sign in with GitHub"; }
  // Remove is answered per registration (an approved one is a maintainer's to remove, one in a ring nobody's): the row's answer where the server gave one, the page's otherwise.
  function removeOf(name) { var p = CAN.packages[name]; return p ? { ok: p.remove === true, why: p.why || "" } : { ok: may("remove"), why: reason("remove") }; }
  // Revoke, Drain and Resume are answered per worker (a revoked one is gone: the state's word first, the door's own): the row's answer where the server gave one, the role's otherwise.
  function workerCan(w, right) { var x = CAN.workers[w.id]; return x ? { ok: x[right] === true, why: (x.why && x.why[right]) || "" } : { ok: may(right), why: reason(right) }; }
  var SHARE_BTN = ${JSON.stringify(SHARE_BTN)}, TOKEN_BTN = ${JSON.stringify(TOKEN_BTN)}, REQUEST_LINK = ${JSON.stringify(REQUEST_LINK)}, WORKER_OWN = ${JSON.stringify(WORKER_OWN)};
  var HOST_TOGGLE = ${JSON.stringify(HOST_TOGGLE)}, HOST_FORM = ${JSON.stringify(HOST_FORM)}, HOST_OWN = ${JSON.stringify(HOST_OWN)};
  var DRAWN = false, WORKER_DRAWN = false, HOST_DRAWN = false, HOSTS = null, WAIT_UNTIL = 0, HOST_T = 0;
  function loadCan() {
    return api("GET", "/api/v1/users/" + encodeURIComponent(login) + "/can").then(function (d) {
      if (d.__status !== 200 || !d.can) return;
      // The controls outside the tables are drawn again only when their gate changed: what the owner typed in the register form stays through a refresh.
      var was = topState(), wasWorkers = JSON.stringify(CAN.workers); CAN = d.can;
      if (DRAWN && topState() !== was) { renderTop(); renderRegister(); }
      // A worker's row is drawn with its rights: once they change (a Drain, a Resume, a Revoke just pressed), the tables are drawn again with them, whichever of this read and the listing's lands first — a row drawn from the new listing with the old rights kept a grey Resume on a worker just drained until the next tick.
      if (JSON.stringify(CAN.workers) !== wasWorkers) renderWorkers();
    }).catch(function () {});
  }
  function topState() { return ["request", "register", "token"].map(function (r) { return may(r) + ":" + reason(r); }).join("|"); }
  // Past the edge cache for whoever may change what the page shows, so a Build, a Revoke, a Withdraw shows at once: the owner always, a maintainer for a minute and a half after their own act (past the edge's max-age, so the cached answer cannot draw the old state back); a reader gets the cached answer, which is the bill kept down. sep is the query's first character on the URL it goes on.
  var FRESH_UNTIL = 0;
  function fresh(sep) { return isOwner(login) || (isMaintainer() && Date.now() < FRESH_UNTIL) ? sep + "t=" + Date.now() : ""; }
  // After the viewer's own act: their rights may have changed with it (a registration gone, a worker revoked), and the next reads pass the cache.
  function acted() { FRESH_UNTIL = Date.now() + 90000; loadCan(); }
  // A staged or failed build's evidence, at the shell's one address for it (its page's Evidence section): the log and the PKGBUILD are read there, where a build that left nothing says so instead of a 404.
  function evidence(t) { return t.status === "staged" || t.status === "failed" ? evidenceLink(t) : ""; }
  // What the page holds: the packages opened, the listing the worker tables read, the stories read (and why one could not be), the profile's packages and builds, and the package list as last drawn.
  var OPEN = {}, FACTORY = null, STORIES = {}, STORY_ERR = {}, PKGS = [], BUILDS = [], DRAWN_PKGS = "";
  // Share and Token at the top, for everyone: the link to this page is anyone's to post (it is public, everything on it is on the record anyway — no door, so no gate), the token the owner's to mint — POST /factory/token mints the caller's own, whoever's page the button is on, which is why nobody else's is live.
  function renderTop() {
    var url = location.origin + userHref(login);
    $("#share-btn").innerHTML = SHARE_BTN + ' ' + gate(TOKEN_BTN, may("token"), reason("token"));
    $("#share-open").onclick = function () { ask({ title: "Share " + (isOwner(login) ? "your" : "this") + " profile", text: "This page is public — what it shows is what the pool recorded: packages, builds, decisions. Post the link wherever you like: a GitHub profile, LinkedIn, a blog.", value: url, copy: "Copy the link", confirm: null, cancel: "Close" }); };
    $("#token-open").onclick = function () {
      ask({ title: "A token for scripts and CI", text: "Sent as <code>Authorization: Bearer omc_…</code>. Shown once; it replaces the previous one — a worker's token is its own.", confirm: "Generate a token" }).then(function (go) {
        if (go === null) return;
        api("POST", API + "/token", {}).then(function (d) {
          if (d.error) { toast(esc(d.error), "error"); return; }
          ask({ title: "Your token", text: "Copy it now: the pool keeps only its hash, and this box closes by its button only. " + esc(d.note || ""), value: "export OMARCHY_CONTRIBUTOR_TOKEN=" + d.token, copy: "Copy", confirm: null, cancel: "Close", sticky: true });
        }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
    };
  }
  // The way to request a package, for everyone, the owner's to press: served grey with whose it is, drawn again from the server's word. A maintainer on their own page reads where their machine goes — a host, below — and that no legacy registration is made any more (#346): no form; everyone else keeps the served line, their packages build on the pool's hosts.
  function renderRegister() {
    $("#pk-request").outerHTML = gate(REQUEST_LINK, may("request"), reason("request"));
    if (!isMaintainer() || !isOwner(login) || WORKER_DRAWN) return;
    WORKER_DRAWN = true;
    $("#w-own").innerHTML = WORKER_OWN;
  }
  // Hosts (#321): the way in is a maintainer's, on their own page only — the toggle, the form and the command it answers; the hosts under this name for everyone, their details (the fingerprint, the capacity) for their owner and the maintainers, Confirm on a host that waits, live for its owner and grey with whose it is for anyone else.
  function renderHostForm() {
    if (!isMaintainer() || !isOwner(login) || HOST_DRAWN) return;
    HOST_DRAWN = true;
    $("#hosts").hidden = false;
    $("#h-own").innerHTML = HOST_OWN; $("#h-slot").innerHTML = HOST_TOGGLE;
    $("#host-form").innerHTML = HOST_FORM;
    $("#h-toggle").onclick = function () { $("#host-form").hidden = !$("#host-form").hidden; };
    copyChips({ host: "#h-cmd" });
  }
  function loadHosts() {
    return api("GET", "/api/v1/hosts?owner=" + encodeURIComponent(login)).then(function (d) { if (d.__status === 200) { HOSTS = d; renderHosts(); } }).catch(function () {});
  }
  // Where its key lives (#330): in its TPM, made there and never out of it, or a file — what its agent said at enrollment.
  function keyWhere(h) { var k = h.host_key; return !k ? "" : k.store === "tpm" ? " · its key is in its TPM, never out of it" : " · its key is a file" + (k.held ? " (not in its TPM: " + esc(k.held) + ")" : ""); }
  // The pool's cap on a host's units (#337) is set on its page, by its owner or any maintainer: the cell links there — the cap where the listing says it (to its owner and the maintainers), the way there for anyone else.
  function poolCap(h) { var v = h.pool_cap_units; return '<a href="/hosts/' + esc(h.id) + '#hp-facts" title="the pool\'s cap on its units: set on its page, by its owner or a maintainer">' + (v === undefined ? "set" : v === null ? "none" : num(v) + (v === 1 ? " unit" : " units")) + ' →</a>'; }
  function hostCaps(h) { return h.capacity ? num(h.capacity.cpus) + " CPUs, " + num(h.capacity.mem_gb) + " GB, " + h.lanes.map(function (l) { return l.arch + " " + l.mode; }).join(", ") + ", isolation " + (h.isolation || "?") + (h.dedicated ? " (dedicated)" : "") : ""; }
  function renderHosts() {
    if (!HOSTS) return;
    var hs = HOSTS.hosts || [];
    if (hs.length) $("#hosts").hidden = false;
    var pending = false;
    var rows = hs.map(function (h) {
      var p = h.status === "active" ? ["ok", "active"] : h.status === "pending-owner" ? ["warn", "waits for Confirm"] : h.status === "suspended" ? ["error", "suspended"] : ["na", h.status];
      if (h.status === "pending-owner") pending = true;
      var confirm = h.status === "pending-owner" ? gate('<button type="button" class="small-btn" data-host-confirm="' + esc(h.id) + '" data-name="' + esc(h.name) + '" title="the fingerprint matches what the machine printed: make it a pool host">Confirm</button>', isOwner(h.owner), "only " + h.owner + " confirms their host") : "";
      var detail = h.fingerprint ? '<div class="muted h-detail" style="font-size:12px">' + esc((h.hostname || "") + (h.where ? " · " + h.where : "")) + (h.capacity ? " · " + esc(hostCaps(h)) : "") + '<br><span class="mono">' + esc(h.fingerprint) + '</span>' + keyWhere(h) + (h.below_minimum ? '<br>' + esc(h.below_minimum) : '') + '</div>' : '';
      // Who stopped it and why, readable on a phone too (the pill's title is a hover).
      if ((h.status === "suspended" || h.status === "retired") && h.status_by) detail += '<div class="muted" style="font-size:12px">' + esc(h.status + " by " + h.status_by + (h.status_reason ? ": " + h.status_reason : "")) + '</div>';
      return '<tr><td><a href="/hosts/' + esc(h.id) + '">' + esc(h.name) + '</a>' + detail + '</td><td>' + pillHtml(p[0], p[1], h.status_reason ? h.status + " by " + (h.status_by || "?") + ": " + h.status_reason : "") + (h.claims_stopped_at && h.status !== "retired" ? " " + pillHtml("error", "claims stopped", NOT_LISTED) : "") + '</td><td>' + esc((h.arches || []).join(", ")) + '</td><td>' + (h.fleet && h.fleet.units !== null && h.fleet.units !== undefined ? num(h.fleet.units) + ' <span class="muted" title="the units its leases hold, and the ones free for a task now">' + num(h.fleet.units_busy) + ' busy · ' + num(h.fleet.units_free) + ' free</span>' : h.units === undefined || h.units === null ? '<span class="muted">—</span>' : num(h.units)) + '</td><td>' + esc(h.release_applied || "—") + '</td><td>' + (h.alive ? "yes" : '<span class="muted">no</span>') + '</td><td>' + poolCap(h) + '</td><td>' + confirm + '</td></tr>';
    });
    $("#hosts-table tbody").innerHTML = rows.join("");
    renderHostStop(hs);
    $("#h-none").hidden = hs.length > 0;
    // The other maintainers' new hosts (D40): a notice, no approval asked.
    var notes = isOwner(login) ? (HOSTS.notices || []) : [];
    $("#h-notices").hidden = !notes.length;
    $("#h-notices").innerHTML = notes.map(function (n) { return '<p class="sub" style="margin:0 0 6px">' + pillHtml("ok", "new host") + ' <a href="/hosts/' + esc(n.host) + '">' + esc(n.line) + '</a> · ' + esc(ago(n.at)) + '</p>'; }).join("");
    // While a host waits for its owner, or a token is out, the owner's page asks every five seconds: the machine shows up here as it enrolls. One timer, whoever called the draw; anyone else's page follows at the minute's tick.
    clearTimeout(HOST_T); HOST_T = 0;
    if (isOwner(login) && (pending || Date.now() < WAIT_UNTIL)) HOST_T = setTimeout(loadHosts, 5000);
  }
  // Stopping hosts (#322): an owner the maintainer list names again resumes all their hosts the sync stopped with one press and a passkey; on another maintainer's page, a maintainer removes them for cause — every host suspended, its tasks fenced — with a passkey and a reason. Every reader sees the controls, greyed with whose they are.
  function renderHostStop(hs) {
    var running = hs.filter(function (h) { return h.status === "active" || h.status === "suspended"; });
    var listStopped = hs.filter(function (h) { return h.claims_stopped_at && h.status !== "retired"; });
    var out = [];
    if (listStopped.length) out.push('<p class="sub" style="margin:0;font-size:12.5px">' + pillHtml("error", "claims stopped") + " " + esc(NOT_LISTED) + " at a sync of factory/MAINTAINERS.toml: " + listStopped.map(function (h) { return '<a href="/hosts/' + esc(h.id) + '">' + esc(h.name) + '</a>'; }).join(", ") + ". Their running tasks finish; listed again, one press brings them all back.</p>" + gate('<button type="button" class="small-btn" id="h-resume-all">Resume my hosts</button>', isOwner(login) && isMaintainer(), !WHO.me ? "sign in with GitHub" : !isOwner(login) ? "only " + login + " resumes their hosts, with their passkey" : NOT_LISTED_YOU));
    if (running.length) out.push(gate('<button type="button" class="small-btn danger" id="h-cause" title="suspend every host of ' + esc(login) + ' and fence their running tasks: another maintainer\'s act, with a passkey and a reason">Remove for cause…</button>', isMaintainer() && !isOwner(login), !WHO.me ? "sign in with GitHub" : isOwner(login) ? SELF_CAUSE : "removing a maintainer for cause is another maintainer's act"));
    $("#h-stop").hidden = !out.length;
    $("#h-stop").innerHTML = out.join("");
  }
  var NOT_LISTED = ${JSON.stringify(OWNER_NOT_MAINTAINER)}, SELF_CAUSE = ${JSON.stringify(SELF_CAUSE)}, NOT_LISTED_YOU = "you are not on factory/MAINTAINERS.toml now: once a pull request lists you again, this resumes them";
  function failed(e) { toast("failed: " + esc(errorText(e)), "error"); }
  function hostsDone(d) { if (d.error) { toast(esc(d.error), "error"); return; } toast(esc(d.line || "done")); loadHosts(); }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("#h-resume-all, #h-cause") : null;
    if (!b || b.disabled) return;
    var base = "/api/v1/hosts/owners/" + encodeURIComponent(login);
    if (b.id === "h-resume-all") {
      ask({ title: "Resume my hosts", text: "Every host of yours the maintainer list stopped claims again from its next claim. A suspended host stays suspended.", held: "Your passkey confirms it.", confirm: "Resume", first: "Register a passkey and resume", nothing: "Nothing was resumed." }).then(function (go) {
        if (go === null) return;
        passkeyed("host:resume-all:" + login, function (a) { return api("POST", base + "/resume", { assertion: a }); }).then(hostsDone).catch(failed);
      });
    } else {
      ask({ title: "Remove " + login + " for cause", text: "Every host of " + esc(login) + " that runs or is suspended is suspended now, and their running tasks are fenced. Taking them off factory/MAINTAINERS.toml stays a pull request. The reason goes on the public journal.", held: "Your passkey confirms it.", input: "required", confirm: "Remove for cause", first: "Register a passkey and remove for cause", nothing: "Nothing was removed.", danger: true }).then(function (r) {
        if (r === null) return;
        passkeyed("host:cause:" + login, function (a) { return api("POST", base + "/cause", { reason: r, assertion: a }); }).then(hostsDone).catch(failed);
      });
    }
  });
  document.addEventListener("submit", function (ev) { if (ev.target && ev.target.id === "host-form") { ev.preventDefault(); addHost(); } });
  function addHost() {
    $("#h-btn").disabled = true;
    api("POST", "/api/v1/hosts/enrollments", { name: $("#h-name").value.trim(), where: $("#h-where").value.trim() || undefined }).then(function (d) {
      $("#h-btn").disabled = false;
      if (d.error) { toast(esc(d.error), "error"); return; }
      $("#h-new").hidden = false;
      $("#h-cmd").textContent = d.command;
      $("#host-form").reset(); $("#host-form").hidden = true;
      WAIT_UNTIL = Date.parse(d.expires_at) || Date.now() + 15 * 60000; loadHosts();
    }).catch(function (e) { $("#h-btn").disabled = false; toast("failed: " + esc(errorText(e)), "error"); });
  }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-host-confirm]") : null;
    if (!b || b.disabled) return;
    var id = b.getAttribute("data-host-confirm"), h = (HOSTS && HOSTS.hosts || []).filter(function (x) { return x.id === id; })[0];
    ask({ title: "Confirm " + b.getAttribute("data-name"), text: "Compare the fingerprint with the one the machine printed. They must be the same: then this host gets its worker registration and claims from its next round." + (h && h.fingerprint ? '<br><code>' + esc(h.fingerprint) + '</code>' + keyWhere(h) : ''), confirm: "Confirm" }).then(function (go) {
      if (go === null) return;
      api("POST", "/api/v1/hosts/" + encodeURIComponent(id) + "/confirm", {}).then(function (d) {
        if (d.error) { toast(esc(d.error), "error"); return; }
        // The command is spent once its host is confirmed.
        $("#h-new").hidden = true; WAIT_UNTIL = 0;
        toast(esc(d.line || "confirmed")); loadHosts(); loadWorkers();
      }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    });
  });
  // The served line tells a contributor their packages build on the pool's hosts: on a maintainer's page — whose section lists the hosts they provide — it is hidden for every reader (#331); on their own page renderRegister has drawn the maintainer's block over it already.
  function renderPoolLine(role) { var line = $("#w-pool"); if (line && role === "maintainer") line.hidden = true; }
  // The workers under this name, from the same listing the Workers page reads — the same rows, by kind, in the order that reads for a person: theirs, the review ones, the pool's.
  function renderWorkers() {
    if (!FACTORY) return;
    var mine = FACTORY.workers.filter(function (w) { return w.owner === login; });
    var kinds = { community: [], review: [], project: [] };
    mine.forEach(function (w) { kinds[wtKind(w)].push(w); });
    var any = false;
    // The shell's head with one more cell, the buttons'; a panel with no row of this person's stays hidden, as does the legend when there is none.
    wtTables(true);
    ["community", "review", "project"].forEach(function (k) {
      var panel = $("#wp-" + k), rows = kinds[k];
      panel.hidden = !rows.length; if (!rows.length) return; any = true;
      pager("#w-" + k, rows, function (w) { return workerRow(w, k, workerActs(w)); }, { empty: "", text: wtText });
    });
    $("#w-none").hidden = any; $("#wt-legend").hidden = !any;
  }
  // A worker's buttons, on every row for whoever looks — a revoked worker's too, grey with the state's word: Drain, or Resume once drained (#412: a maintainer reaches it from here in one click, as on the worker's page), and Revoke, which stops its token — its owner's or a maintainer's: the server says which, and why not, per row; Drain and Resume in the worker orders' own words. Then the way to the rest of what can be done to it: its page's Operate (Re-check agent, Restart, Update, Stop its task), a host's registration its host's page. A worker's mode went with the community worker tier (#343).
  function workerActs(w) {
    var kind = w.drained ? "resume" : "drain", order = workerCan(w, kind), revoke = workerCan(w, "revoke");
    var host = w.kind === "host" && w.host_id, there = host ? "/hosts/" + encodeURIComponent(w.host_id) + "#hp-operate" : workerHref(w.id) + "#wk-operate";
    return gate('<button type="button" class="small-btn" data-worker-order="' + kind + '" data-worker="' + esc(w.id) + '" title="' + (kind === "drain" ? "hand it nothing from its next claim: a task in hand runs to its end" : "hand it work again from its next claim") + '">' + (kind === "drain" ? "Drain" : "Resume") + '</button>', order.ok, order.why)
      + ' ' + gate('<button type="button" class="small-btn" data-revoke="' + esc(w.id) + '" title="revoke this worker\'s token">Revoke</button>', revoke.ok, revoke.why)
      + ' <a class="small-btn" href="' + there + '" title="' + (host ? "its host's page: Suspend, Resume, Retire, Drain" :"its page: Re-check agent, Restart, Update, Stop its task") + '">Operate →</a>';
  }
  // Drain and Resume, asked as the worker's page asks them, with a reason for the journal: the order holds from its issue (#277, part 2), and the door's note says what follows.
  var UNPIN_MIN = ${UNPIN_AFTER_DRAIN_MINUTES};
  function workerOrder(kind, id) {
    var w = FACTORY ? FACTORY.workers.filter(function (x) { return x.id === id; })[0] : null;
    var text = kind === "drain" ? "The pool hands it nothing from its next claim" + (w && w.current_task ? "; task #" + w.current_task + " runs to its end" : "") + ". Builds asked for it by name go to the queue after " + UNPIN_MIN + " min. It stays drained, restarts included, until someone resumes it."
      : "The pool hands it work again from its next claim." + (w && w.drained && w.drained.by && w.drained.by !== WHO.login ? " " + w.drained.by + " drained it" + (w.drained.reason ? ": " + w.drained.reason : "") + " — the journal puts their words beside yours." : "");
    ask({ title: (kind === "drain" ? "Drain " : "Resume ") + id + "?", text: esc(text), input: "optional", placeholder: "why — it goes on the journal (optional)", confirm: kind === "drain" ? "Drain" : "Resume", danger: kind === "drain" }).then(function (why) {
      if (why === null) return;
      api("POST", API + "/workers/" + encodeURIComponent(id) + "/orders", { kind: kind, reason: why || (kind === "drain" ? "Drain" : "Resume") + " from " + login + "'s page" }).then(function (d) {
        if (d.error) { toast(esc(d.error), "error"); return; }
        toast(esc((kind === "drain" ? "Drained — " : "Resumed — ") + (d.note || ""))); acted(); loadWorkers();
      }).catch(failed);
    });
  }
  function loadWorkers() { return fetch("/api/v1/factory?limit=10" + fresh("&")).then(function (r) { return r.json(); }).then(function (d) { FACTORY = d; renderWorkers(); }).catch(function () {}); }
  // ---- packages (#412): the package is the unit. One block per registration: its head (the name, the stage, a block, Build all and Remove), where it stands, a line per architecture — where it stands (the server's targets, targets.ts), its latest build with the gate on it, its Build — and the one control that opens its story and its builds. All of it is the profile's (GET /users/<login>: the registration's row and the last fifty builds under this name), so nothing is read per package to draw it; the story (routes/story.ts) is read for a package opened only, as before, and adds the score and the audit to its lines.
  var TARGET_TONE = { waiting: "wait", building: "run", built: "ok", not_supported: "na", reviewing: "run", reviewed: "ok", approved: "ok", published: "ok" };
  var BUILD_TONE = { queued: "wait", leased: "run", staged: "ok", done: "ok", failed: "fail", cancelled: "na" };
  // The builds of a name no longer registered here — a registration removed — keep a block of their own, under a key no package's name can be (a pacman name has no "*").
  var OTHERS = "*";
  function buildsOf(name) { return BUILDS.filter(function (b) { return b.name === name; }); }
  // A package's architectures: the ones its request names — the only ones it builds — then any its targets or its builds still carry: an architecture the request dropped keeps its line and its builds, its Build grey with the door's word.
  function archesOfPkg(p) {
    var reg = []; try { reg = JSON.parse(p.arches || "[]"); } catch (e) {}
    var all = reg.slice(), add = function (a) { if (a && all.indexOf(a) < 0) all.push(a); };
    Object.keys(p.targets || {}).forEach(add); buildsOf(p.name).forEach(function (b) { add(b.arch); });
    return { registered: reg, all: all };
  }
  function inFlight(b) { return !!b && (b.status === "queued" || b.status === "leased"); }
  // Building now, which a Build of its architecture waits for: the contributor's build running, or the project's queued or running (its target says reviewing). A contributor's build that only waits in the queue is the Build dialog's to move or to take out.
  function running(t, b) { return (!!t && t.status === "reviewing") || (!!b && (b.status === "leased" || (b.trust === "project" && b.status === "queued"))); }
  // Build, on every package for whoever looks: grey by state first — a build in flight, the package blocked, an architecture the request no longer names: the same for all — and by role otherwise (the owner builds, nobody else: the server's word); the title says which. arch null is Build all.
  function buildBtn(name, arch, stopped, title) {
    var btn = '<button type="button" class="op-btn sm' + (arch ? '' : ' primary') + '" data-build="' + esc(name) + '"' + (arch ? ' data-arch="' + esc(arch) + '"' : '') + ' title="' + esc(title) + '">Build ' + (arch ? esc(arch) : "all") + '</button>';
    return gate(btn, !stopped && may("build"), stopped || reason("build"));
  }
  function removeBtn(name) { var r = removeOf(name); return gate('<button type="button" class="op-btn sm" data-remove="' + esc(name) + '" title="remove the registration">Remove</button>', r.ok, r.why); }
  // Withdraw, on every approval row for whoever looks: live for a maintainer where the approval stands (standing: approved, not withdrawn — the row's own fact), grey with why not otherwise — nothing standing on the row for a maintainer, the role's reason (the server's word) for anyone else.
  function withdrawBtn(a, standing) { return gate('<button type="button" class="small-btn" data-withdraw="' + a.task_id + '" data-name="' + esc(a.name + " " + (a.version || "")) + '" title="take the approval back: the package leaves every ring, another maintainer decides — the reason goes on the record">Withdraw</button>', may("withdraw") && standing, may("withdraw") ? "nothing standing to withdraw" : reason("withdraw")); }
  // A blocked package builds for nobody: the door's words (POST /factory/packages/:name/build).
  function blockedWhy(name, pkg) { return name + " is blocked by a maintainer" + (pkg.blocked_reason ? ": " + pkg.blocked_reason : ""); }
  // The gate on a staged build (its result's vet, on the profile's row): pass, clean or with its warnings, or what it said and how many checks failed.
  function gateWord(b) {
    if (!b.gate) return "";
    var pass = b.gate === "pass", n = Number(b.gate_warnings || 0);
    return pillHtml(pass ? (n ? "warn" : "ok") : "error", "gate " + (pass ? (n ? n + (n === 1 ? " warning" : " warnings") : "clean") : b.gate + (b.gate_fails ? " · " + b.gate_fails : "")), "the gate's verdict on build #" + b.id + ": each check is on its page");
  }
  // An architecture's latest chain in the package's story, once the story was read: the class its score gives and the audit's word.
  function chainOf(name, arch) { var st = STORIES[name]; return st ? st.chains.filter(function (c) { return (c.contributor || c.project || {}).arch === arch; })[0] || null : null; }
  function auditWord(a) { if (!a) return pillHtml("none", "no audit yet"); var v = a.result && a.result.verdict; return pillHtml(a.status === "done" ? ({ ok: "ok", warn: "warn", block: "error" }[v] || "none") : "none", "audit " + (a.status === "done" ? v || "done" : a.status === "leased" ? "running" : a.status), (a.result && a.result.summary) || ""); }
  // One architecture of a package as a line: its square and name, where it stands (the target's word), its latest build — its number, its version, the queue or the native worker it waits for, the worker that holds it — the gate on it, the score and the audit once the story is read, when, and its Build at the line's end.
  function archLine(p, a, reg) {
    var t = (p.targets || {})[a] || null, b = buildsOf(p.name).filter(function (x) { return x.arch === a; })[0] || null, c = chainOf(p.name, a);
    var tone = t ? TARGET_TONE[t.status] || "wait" : b ? BUILD_TONE[b.status] || "wait" : "na";
    var word = t ? t.status.replace("_", " ") : b ? (b.status === "leased" ? "building" : b.status) : "no build yet";
    var facts = ['<span class="op-pill ' + tone + '"' + (t && TARGET_WORD[t.status] ? ' title="' + esc(TARGET_WORD[t.status][2]) + '"' : '') + '>' + esc(word) + '</span>'];
    if (b) {
      facts.push('<a href="/build/' + b.id + '" title="the build, whole">#' + b.id + '</a>' + (b.version ? ' <span class="v">' + esc(b.version) + '</span>' : '') + (!t || t.task !== b.id ? ' ' + taskPill(b.status) : ''));
      if (b.needs_native) facts.push(nativePill({ status: b.status, arch: b.arch, params: { needs_native: b.needs_native, refused_4k: b.refused_4k } }));
      if (b.queue) facts.push('<span class="when" title="in the queue for ' + esc(a) + '">' + b.queue.position + ' of ' + b.queue.total + '</span>');
      if (b.status === "leased" && b.lease_owner) facts.push('<span class="when">on</span> ' + wtId(b.lease_owner));
      facts.push(gateWord(b));
    } else if (t && t.task) facts.push('<a href="/build/' + t.task + '" title="the build that says where it stands">#' + t.task + '</a>');
    if (c) facts.push(classPill(c.score) + ' ' + auditWord(c.audit));
    if (b) facts.push('<span class="when">' + ago(b.created_at) + '</span>');
    var act = reg.indexOf(a) < 0
      ? gate('<button type="button" class="op-btn sm" data-build="' + esc(p.name) + '" data-arch="' + esc(a) + '">Build ' + esc(a) + '</button>', false, "arches must name one the request has: " + reg.join(", "))
      : buildBtn(p.name, a, running(t, b) ? "a build is running" : p.blocked_at ? blockedWhy(p.name, p) : null, b && b.status === "queued" && b.trust === "community" ? "name a worker, or take it out of the queue" : "this architecture only");
    return '<div class="up-arch"><span class="op-arch ' + tone + '"></span><b>' + esc(a) + '</b><span class="up-facts">' + facts.filter(Boolean).join(" ") + '</span>' + act + '</div>';
  }
  // The one control that opens a block: the package's story and its builds, folded under it.
  function moreBtn(key, n, what) { var open = !!OPEN[key]; return '<button type="button" class="up-more" data-expand="' + esc(key) + '" aria-expanded="' + open + '">' + (open ? "▾ " : "▸ ") + what + ' · ' + num(n) + (n === 1 ? " build" : " builds") + '</button>'; }
  function pkgBlock(p) {
    var A = archesOfPkg(p), mine = buildsOf(p.name), open = !!OPEN[p.name];
    var flying = A.all.some(function (a) { var t = (p.targets || {})[a]; return (!!t && (t.status === "building" || t.status === "reviewing")) || inFlight(mine.filter(function (x) { return x.arch === a; })[0]); });
    var head = '<div class="up-pkg-h"><a class="up-name" href="' + pkgHref(p.name, null, A.registered[0]) + '">' + esc(p.name) + '</a> ' + taskPill(p.status) + (p.blocked_at ? ' ' + pillHtml("error", "blocked", blockedWhy(p.name, p)) : '') + (p.category ? ' <span class="op-chip">' + esc(p.category) + '</span>' : '')
      + '<span class="up-acts">' + buildBtn(p.name, null, flying ? "a build is in flight" : p.blocked_at ? blockedWhy(p.name, p) : null, "every architecture the request names") + removeBtn(p.name) + '</span></div>';
    return '<article class="up-pkg" data-pkg="' + esc(p.name) + '">' + head + (p.detail ? '<p class="up-stands">' + esc(p.detail) + '</p>' : '')
      + '<div class="up-arches">' + A.all.map(function (a) { return archLine(p, a, A.registered); }).join("") + '</div>'
      + moreBtn(p.name, mine.length, "The story") + (open ? '<div class="up-open">' + storyPart(p.name) + historyTable(mine, false) + '</div>' : '') + '</article>';
  }
  function othersBlock(rows) {
    return '<article class="up-pkg" data-pkg="' + OTHERS + '"><div class="up-pkg-h"><span class="up-name">Other names</span></div><p class="up-stands">Builds of a name no longer registered under this one.</p>'
      + moreBtn(OTHERS, rows.length, "Their builds") + (OPEN[OTHERS] ? '<div class="up-open">' + historyTable(rows, true) + '</div>' : '') + '</article>';
  }
  // A package's builds, folded under it — of the last fifty under this name, newest first: the number is the build's page; the version its package's page on the build's architecture and the ring the build is about (ringOfBuild: the lab for a staged one, the shell's default for the rest — the ring Review and the build's page link too); the worker that held it, the bare id whole where the listing has no row (no owner guessed); the evidence, public, for whoever reads.
  function historyTable(rows, named) {
    if (!rows.length) return '<p class="up-note">No build of it among the last fifty under this name: its page has them all.</p>';
    return '<div class="up-table"><table class="op-table up-hist"><thead><tr><th>#</th><th>' + (named ? "Package" : "Version") + '</th><th>Arch</th><th>Status</th><th>Why</th><th>Ran on</th><th>Took</th><th>When</th><th>Evidence</th></tr></thead><tbody>' + rows.map(function (t) {
      return '<tr><td><a href="/build/' + t.id + '" title="the build, whole">' + t.id + '</a></td><td><a href="' + pkgHref(t.name, ringOfBuild(t.status, null), t.arch) + '">' + (named ? '<b>' + esc(t.name) + '</b> ' : '') + '<span class="mono">' + esc(t.version || "—") + '</span></a></td><td>' + esc(t.arch) + '</td><td>' + taskPill(t.status) + (t.needs_native ? ' ' + nativePill({ status: t.status, arch: t.arch, params: { needs_native: t.needs_native, refused_4k: t.refused_4k } }) : '') + (t.queue ? ' <span class="dim" title="in the queue for ' + esc(t.arch) + '">' + t.queue.position + ' of ' + t.queue.total + '</span>' : '') + '</td><td class="why">' + esc(t.reason || "") + (t.trust === "project" ? ' ' + pillHtml("ok", "the project", "the project's own build, from a contributor's evidence") : '') + '</td><td>' + (t.lease_owner ? wtId(t.lease_owner) : t.pinned_to && t.status === "queued" ? '<span class="muted" title="asked for this worker only">waiting for ' + esc(wtShort(t.pinned_to)) + '</span>' : '<span class="muted">—</span>') + '</td><td>' + (dur(t.duration_ms) || "—") + '</td><td class="when">' + ago(t.created_at) + '</td><td>' + evidence(t) + '</td></tr>';
    }).join("") + '</tbody></table></div>';
  }
  // The list, drawn again only when what it draws changed: the refresh every fifteen seconds keeps the focus and the place of a block nobody touched.
  function drawPackages() {
    var names = PKGS.map(function (p) { return p.name; }), others = BUILDS.filter(function (b) { return names.indexOf(b.name) < 0; });
    var html = PKGS.map(pkgBlock).join("") + (others.length ? othersBlock(others) : "") || '<p class="up-empty">No package registered under this name.</p>';
    if (html !== DRAWN_PKGS) { $("#packages").innerHTML = html; DRAWN_PKGS = html; }
  }
  // A package's story (routes/story.ts), read for a package opened: the request as the form checks it today, then one panel per architecture — each is built on a worker of its own and can be ready while the other failed — with its latest chain, the two halves of the score with their evidence, and the one line that says whose turn it is. What was drawn stays while the fresh one loads: no flicker on the refresh.
  function story(name) {
    fetch("/api/v1/factory/packages/" + encodeURIComponent(name) + "/story" + fresh("?")).then(function (r) { return r.ok ? r.json() : null; }).then(function (st) {
      if (st) { STORIES[name] = st; delete STORY_ERR[name]; } else if (!STORIES[name]) STORY_ERR[name] = "no story yet";
      drawPackages();
    }).catch(function () { if (!STORIES[name]) STORY_ERR[name] = "could not load the story"; drawPackages(); });
  }
  function refreshStories() { Object.keys(OPEN).forEach(function (n) { if (OPEN[n] && n !== OTHERS) story(n); }); }
  function storyPart(name) { return STORIES[name] ? storyHtml(name, STORIES[name]) : '<p class="up-note">' + esc(STORY_ERR[name] || "loading the story…") + '</p>'; }
  // The story of an open package, under its lines: who blocked it and why, the request as the form checks it (Renew the request drawn for everyone, live for its owner while a renewal is taken), each architecture's panel — the two halves of its score with the gate, the audit and the trial, and what comes next — and the way to the package's page. Its buttons are the block's, above: nothing here builds or removes.
  function storyHtml(name, st) {
    var pkg = st.package || {}, arches = (pkg.arches && pkg.arches.length ? pkg.arches : (st.request && st.request.arches) || []).slice();
    var archOf = function (c) { return (c.contributor || c.project || {}).arch; };
    st.chains.forEach(function (c) { var a = archOf(c); if (a && arches.indexOf(a) < 0) arches.push(a); }); // an architecture the request dropped keeps its story
    // A renewal is taken while the package is registered, staged, rejected or unmaintained and nothing of it is being built — the story says (request.renewable, request.busy).
    var renewable = !!(st.request && st.request.renewable);
    var whyNot = st.request && st.request.busy ? "renew it once build #" + st.request.busy + " is done" : pkg.status === "approved" || pkg.status === "published" ? "in the pool as it was; new releases come as bumps, built from the approved recipe" : "renew it once nothing of it is being built";
    var panels = arches.map(function (a) { var mine = st.chains.filter(function (c) { return archOf(c) === a; }); return archPanel(a, mine, nextStep(st, mine[0]), ""); }).join("");
    // The package's page on the most stable ring that serves it and that ring's architecture — the shell's servedRing over the story's rows, the shell's one address; a package in no ring yet opens on the shell's default.
    var served = servedRing(st.rings);
    return (pkg.blocked_at ? '<p class="up-note">' + pillHtml("error", "blocked") + ' ' + ago(pkg.blocked_at) + ' by ' + personLink(pkg.blocked_by) + ': ' + esc(pkg.blocked_reason || '') + ' — another maintainer lifts it.</p>' : '')
      + requestBlock(st.request, may("request"), name, renewable, whyNot, reason("request")) + panels
      + '<p class="up-note"><a href="' + pkgHref(name, served && served.ring, served && served.arch) + '">The package\'s page →</a>' + (st.rings && st.rings.length ? ' · in <b>' + esc(st.rings.map(function (r) { return r.ring + " (" + r.arch + ")"; }).join(", ")) + '</b>' : '') + '</p>';
  }
  // What comes next for one architecture, from its latest chain: whose turn it is, what for — and, when it is the reader's own package, how: the evidence to read, the button to press, where the build can run, what to write for the agent.
  function nextStep(st, c) {
    var own = isOwner(login), pkg = st.package || {}, rings = (st.rings || []).filter(function (r) { return !c || r.arch === (c.contributor || c.project || {}).arch; }).map(function (r) { return r.ring; });
    var incomplete = st.request && !st.request.complete;
    var steps = function (items) { return '<ol class="howto">' + items.map(function (x) { return '<li>' + x + '</li>'; }).join("") + '</ol>'; };
    var drafted = function (t) { return !t || !t.pkgbuild_ref || t.pkgbuild_ref.indexOf("draft:") === 0; };
    if (!c) return 'No build yet — ' + (own ? 'press <b>Build</b>: it goes to the queue (the next host of its architecture with room takes it, contributors\' builds in turn), the gate checks it, the second agent audits it.' : 'the contributor\'s build comes first.');
    var cc = c.contributor, pb = c.project, a = c.approval, sc = c.score, arch = (cc || pb).arch;
    var worker = cc && cc.lease_owner && FACTORY ? FACTORY.workers.filter(function (w) { return w.id === cc.lease_owner; })[0] : null;
    var emulated = worker && worker.labels && worker.labels.emulated;
    var where = FACTORY ? whereOptions(FACTORY.workers, arch, login, false) : null;
    // The three tools a contributor has, in the order to try them.
    var again = function (why) {
      if (cc && !drafted(cc)) return steps([
        'Read what stopped it in ' + evidenceLink(cc, "the evidence of #" + cc.id) + ': the log' + (cc.status === "failed" ? '' : ', the gate\'s log') + (why ? ' — ' + why : '') + '.',
        'The recipe is the project\'s own PKGBUILD (<span class="mono">' + esc(String(cc.pkgbuild_ref).split(":").pop()) + '</span>), built as it is — no agent drafts it: fix it there, tag a release, <b>renew the request</b> with that tag, then press <b>Build ' + esc(arch) + '</b>.',
        'Choose <b>where</b> in the Build dialog' + (emulated ? ': this one ran <b>emulated</b> — a native worker may be all it needs' : '') + '.',
      ]);
      return steps([
        'Read what stopped it in ' + evidenceLink(cc, "the evidence of #" + cc.id) + ': the log' + (cc.status === "failed" ? '' : ', the gate\'s log') + ' and the PKGBUILD the agent wrote' + (why ? ' — ' + why : '') + '.',
        'Press <b>Build ' + esc(arch) + '</b>: the next build starts from that PKGBUILD and that log (the lesson), not from nothing — and from a <b>hint</b> you write in the dialog: the binary\'s name, a build flag, a dependency, what the recipe should do differently.',
        'Choose <b>where</b> in the same dialog' + (emulated ? ': this one ran <b>emulated</b> (' + esc(arch) + ' under qemu on ' + esc(wtShort(worker.id)) + ') — a native worker may be all it needs' : '') + (where && where.native ? ' — ' + where.native + ' native ' + esc(arch) + ' worker(s) online' : where && where.count ? ' — ' + where.count + ' worker(s) can take it' : ' — the pool\'s hosts take it') + '.',
      ]);
    };
    if (a && a.standing) return 'Approved by ' + personLink(a.by) + ' ' + ago(a.created_at) + (rings.length ? ' — in <b>' + esc(rings.join(" · ")) + '</b>, signed by the pool; it earns rc and stable like every synced package.' : ' — the publish job carries it into edge.');
    if (c.withdrawn) return 'The approval by ' + personLink(c.withdrawn.by) + ' was withdrawn by ' + personLink(c.withdrawn.withdrawn_by) + ': ' + esc(c.withdrawn.withdrawn_reason || '') + ' — another maintainer decides; ' + (own ? 'nothing to do on your side.' : 'nothing to do on the contributor\'s side.');
    if (a && a.decision === "rejected") return (a.changes ? 'Changes requested by ' : 'Rejected by ') + personLink(a.by) + ': <b>' + esc(a.note || '') + '</b>' + (own && cc ? again('the note above says what to change') : ' — the contributor fixes it and builds again.');
    // The project's build an emulated worker sent back (#281): what it waits for, in the shell's words.
    if (pb && waitsForNative(pb)) return 'The project builds it again (<a href="/build/' + pb.id + '">#' + pb.id + '</a>), ' + waitsForNative(pb) + ': a toolchain or a library could not start <b>emulated</b>. Then the trial, then a maintainer decides.' + (own ? ' Nothing on your side.' : '');
    if (pb && (pb.status === "queued" || pb.status === "leased")) return 'The project is building it again (<a href="/build/' + pb.id + '">#' + pb.id + '</a>) on a trusted worker, with the project\'s agent — then the trial, then a maintainer decides.' + (own ? ' Nothing on your side.' : '');
    if (pb && pb.status === "staged") return 'Built again by the project (<a href="/build/' + pb.id + '">#' + pb.id + '</a>): it waits for ' + (own ? '<b>another</b> maintainer\'s approval (you brought it)' : 'a maintainer\'s approval — never the one who brought it') + '. Class today ' + esc(sc.class) + ', ' + esc(sc.projected) + ' with the maintainer\'s half green.';
    if (pb && pb.status === "failed") return 'The project\'s build failed (<a href="/build/' + pb.id + '">#' + pb.id + '</a>)' + (pb.error ? ' — ' + esc(String(pb.error).slice(0, 140)) : '') + ' — a maintainer reads it and decides; your evidence stands.' + (own ? ' If the recipe is the cause, a new build of yours with the fix is the best help.' : '');
    if (cc && cc.status === "queued") {
      if (cc.pinned_to) return 'Queued (<a href="/build/' + cc.id + '">#' + cc.id + '</a>) for <b>' + esc(wtShort(cc.pinned_to)) + '</b> only' + (FACTORY && !FACTORY.workers.some(function (w) { return w.id === cc.pinned_to && w.alive; }) ? ' — <b>offline</b>: it claims when it is back' : '') + (own ? '. Press <b>Build ' + esc(arch) + '</b> to send it to the queue instead, or to take it out.' : '.');
      var q = cc.queue ? '<b>' + cc.queue.position + ' of ' + cc.queue.total + '</b> in the queue for ' + esc(arch) : 'in the queue for ' + esc(arch);
      // Sent back by an emulated worker a toolchain could not start on: only a native one takes it, the owner's own included — an emulated one of theirs is not "at once".
      if (cc.params && cc.params.needs_native) return 'Queued (<a href="/build/' + cc.id + '">#' + cc.id + '</a>) — ' + q + ': a toolchain or a library could not start <b>emulated</b>, so a <b>native</b> ' + esc(arch) + ' worker takes it' + (where ? ' — ' + esc(where.state) : '') + (own ? '. Press <b>Build ' + esc(arch) + '</b> to name a worker or to take it out of the queue.' : '.') + ' This page follows it.';
      return 'Queued (<a href="/build/' + cc.id + '">#' + cc.id + '</a>) — ' + q + ': the next host of ' + esc(arch) + ' with room takes it, contributors\' builds in turn' + (where ? ' — ' + esc(where.state) : '') + (own ? '. Press <b>Build ' + esc(arch) + '</b> to name a worker or to take it out of the queue.' : '.') + ' This page follows it.';
    }
    if (cc && cc.status === "leased") return 'Building (<a href="/build/' + cc.id + '">#' + cc.id + '</a>) on ' + (cc.lease_owner ? wtId(cc.lease_owner) : 'a worker') + (emulated ? ' — emulated' : '') + ' — this page follows it.';
    if (cc && cc.status === "failed") return 'The build failed (<a href="/build/' + cc.id + '">#' + cc.id + '</a>)' + (cc.error ? ' — <b>' + esc(String(cc.error).slice(0, 160)) + '</b>' : '') + (own ? again(cc.attempts > 1 ? 'the agent tried ' + cc.attempts + ' times inside this build' : '') : ' — the contributor fixes it.');
    if (cc && cc.status === "cancelled") return 'Superseded (<a href="/build/' + cc.id + '">#' + cc.id + '</a>)' + (cc.error ? ' — ' + esc(String(cc.error).slice(0, 140)) : '') + '.';
    if (cc && cc.status === "staged") {
      if (sc.ready) return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> passed the gate' + (c.audit && c.audit.status === "done" ? ', audited' : '') + ' — ' + (own ? 'nothing on your side: <b>another</b> maintainer (you brought it)' : 'a maintainer who did not bring it') + ' has the project build it again. Class ' + esc(sc.class) + ' → ' + esc(sc.projected) + '.';
      var vet = cc.result && cc.result.vet, audit = c.audit;
      if (incomplete) return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> is staged, but the request is not what the form asks today — ' + (own ? '<b>Renew the request</b> above: the same form, filled from the record; the build stays and is ready the moment the record is — of this version.' : 'the contributor renews the request; the build stays.');
      if (vet && vet.verdict !== "pass") return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> built, but <b>the gate failed</b>: ' + esc((vet.failed || []).join(", ")) + (own ? again('each failed check is named there and explained in <a href="/docs/what-we-test">What we test</a>') : ' — the contributor fixes the recipe and builds again.');
      if (audit && audit.status === "done" && audit.result && audit.result.verdict === "block") return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> passed the gate, but <b>the audit blocked it</b>: ' + esc(audit.result.summary || '') + (own ? again('the report in ' + evidenceLink(cc, "the evidence of #" + cc.id) + ' lists the findings and the fix for each') : ' — the contributor answers the findings and builds again.');
      if (audit && audit.status !== "done") return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> passed the gate; the audit is ' + esc(audit.status) + ' on a maintainer\'s host — nothing to do until it answers.';
      if (audit && audit.status === "failed") return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> passed the gate, but the audit did not run (' + esc(audit.error || '') + ') — ' + (own ? 'press <b>Build ' + esc(arch) + '</b> again: a new build gets a new audit.' : 'the contributor builds again.');
      var reqItem = (sc.items || []).filter(function (i) { return i.item === "A request on the record"; })[0];
      if (reqItem && reqItem.points < reqItem.max && st.request && st.request.version) return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> is staged, but the request now names <b>' + esc(st.request.version) + '</b> and this build is ' + esc(cc.version || '?') + ' — ' + (own ? 'press <b>Build ' + esc(arch) + '</b>: the build of that version is the evidence.' : 'the contributor builds that version.');
      return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> is staged, but not ready: ' + (!vet ? 'no gate verdict on the record (built before the gate)' : 'the audit has not answered') + ' — ' + (own ? 'press <b>Build ' + esc(arch) + '</b> again; the gate and the audit run on the new build.' : 'the contributor builds again.');
    }
    return esc(cc ? cc.status : "—");
  }
  function load() {
  return api("GET", "/api/v1/users/" + encodeURIComponent(login) + fresh("?")).then(function (d) {
    if (d.__status !== 200) { $("#title").textContent = login; $("#line").textContent = d.error || "not found"; endSkeleton(); return; }
    document.title = login + " · omarchy-pool";
    $("#title").innerHTML = esc(d.name || d.login) + ' <span class="dim" style="font-weight:500">@' + esc(d.login) + '</span>';
    // An icon, never a photo: two letters, green for a maintainer.
    $("#avatar").textContent = d.login.slice(0, 2); if (d.role === "maintainer") $("#avatar").classList.add("m");
    renderPoolLine(d.role);
    $("#line").innerHTML = pillHtml(d.role === "maintainer" ? "rec" : "ok", d.role) +
      (d.blocked ? pillHtml("error", "blocked: " + (d.blocked.reason || ""), "by " + (d.blocked.by || "") + ", " + (d.blocked.at || "")) : '') +
      (d.maintainer_since ? pillHtml("none", "since " + ago(d.maintainer_since), "listed in factory/MAINTAINERS.toml") : '') +
      '<span>since ' + esc(String(d.since).slice(0, 10)) + '</span><span class="dim">·</span><span>last seen ' + ago(d.last_seen) + '</span><span class="dim">·</span><a href="' + esc(d.github) + '" style="color:var(--muted);text-decoration:none">github.com/' + esc(d.login) + ' ↗</a>';
    // The workers counted as every tile counts them (the shell's workerCounts): registered is not revoked, alive is a heartbeat in the last WORKER_ALIVE_MINUTES — the rows are the listing's own (routes/factory.ts workerView), so the tile counts what the tables below draw.
    var c = d.build_counts, wc = workerCounts(d.workers);
    // The four numbers, the kit's tiles.
    $("#tiles").innerHTML = [
      ["Packages", num(d.packages.length), "registered under this name"],
      ["Builds", num(c.total), num(c.staged) + " staged · " + num(c.published) + " published · " + num(c.failed) + " failed"],
      // Every decision on the record under this name — approvals standing or withdrawn, rejections — as the Pipeline's "decisions per maintainer" counts them; how many stand is the subtitle's.
      ["Decisions", num(d.approvals.length), d.role === "maintainer" ? num(d.approved_packages.length) + " package(s) let into the pool" : "not a maintainer"],
      ["Workers", num(wc.registered), num(wc.alive) + " alive now"]
    ].map(function (t) { return '<div class="op-stat"><span class="k">' + t[0] + '</span><b class="n">' + t[1] + '</b><span class="s">' + t[2] + '</span></div>'; }).join("");
    // Sixteen weeks of what the record holds under this name: builds, decisions, packages touched.
    var weeks = []; for (var i = 15; i >= 0; i--) weeks.push(Date.now() - i * 7 * 86400000);
    var counts = weeks.map(function () { return 0; }), total = 0;
    var mark = function (iso) { var t = Date.parse(iso); if (!t) return; for (var i = weeks.length - 1; i >= 0; i--) { if (t >= weeks[i]) { counts[i]++; total++; break; } } };
    d.builds.forEach(function (b) { mark(b.created_at); }); d.approvals.forEach(function (a) { mark(a.created_at); }); d.packages.forEach(function (p) { mark(p.updated_at); });
    var mx = Math.max.apply(null, counts) || 1;
    $("#activity").innerHTML = counts.map(function (v, i) { return '<i style="height:' + Math.max(4, 100 * v / mx) + '%" data-tip="' + new Date(weeks[i]).toISOString().slice(0, 10) + ' · ' + v + (v === 1 ? " contribution" : " contributions") + '"></i>'; }).join("");
    $("#activity-note").textContent = total ? num(total) + " in the last 16 weeks — every one is a row below" : "nothing on the record in the last 16 weeks yet";
    // The track record, in its card for everyone: the score, and what it is made of — what this person brought that a maintainer let in, built, decided.
    var rec = d.record || { contributed: {}, maintained: {}, score: 0 }, rc = rec.contributed || {}, m = rec.maintained || {};
    $("#score").textContent = num(rec.score || 0);
    $("#score-f").textContent = "From what the pool recorded: what was brought that a maintainer let in, what was built, what was decided. It says where the work was done, not who someone is.";
    var contributed = [rc.approved ? num(rc.approved) + " let in" : "", rc.staged ? num(rc.staged) + " staged" : "", rc.bumps ? num(rc.bumps) + " bump" + (rc.bumps === 1 ? "" : "s") : "", rc.donated ? num(rc.donated) + " for others" : "", rc.rejected ? num(rc.rejected) + " rejected" : ""].filter(Boolean).join(" · ") || "—";
    var maintained = [m.approvals ? num(m.approvals) + " approval" + (m.approvals === 1 ? "" : "s") : "", m.rejections ? num(m.rejections) + " rejection" + (m.rejections === 1 ? "" : "s") : "", m.rebuilds_failed ? num(m.rebuilds_failed) + " rebuild" + (m.rebuilds_failed === 1 ? "" : "s") + " failed" : ""].filter(Boolean).join(" · ") || "—";
    $("#record").innerHTML = '<dt>Contributed</dt><dd>' + contributed + '</dd><dt>Maintained</dt><dd>' + maintained + '</dd>';
    // ---- packages (#412): the profile's registrations and its last fifty builds, a block per package with its builds folded under it; the stories of the ones opened are read again.
    PKGS = d.packages; BUILDS = d.builds;
    drawPackages(); refreshStories();
    renderReset(d);
    // ---- approvals: last, with the build behind each
    if (d.approvals.length || d.role === "maintainer") {
      $("#approvals-section").hidden = false;
      // A standing approval — the row's own standing, the server's word (approved, not withdrawn) — is a package in the pool: its rings say where, from the lab up, and the name opens the package on the most stable of them. Withdraw is on every row for whoever looks: live for a maintainer where an approval stands (it leaves every ring, another maintainer decides), grey with why not — nothing standing on the row, or the role, the server's word.
      pager("#approvals", d.approvals, function (a) {
        var standing = a.standing;
        var where = standing ? (a.rings && a.rings.length ? a.rings.map(function (r) { return pillHtml(r === "stable" ? "ok" : r === "rc" ? "blue" : r === "edge" ? "lilac" : "warn", r); }).join(" ") : '<span class="muted" title="approved, not served: the publish job did not run, or a later release dropped it">not served</span>') : '<span class="muted">—</span>';
        var act = ' ' + withdrawBtn(a, standing);
        return '<tr><td class="when">' + ago(a.created_at) + '</td><td><a href="' + pkgHref(a.name, servedRing(a.rings), a.arch) + '">' + esc(a.name) + '</a> <span class="mono muted">' + esc(a.version || "") + '</span> <a class="dim" href="/build/' + a.task_id + '">#' + a.task_id + '</a></td><td' + (a.only_reason ? ' title="' + esc(approvedFor(a)) + '"' : '') + '>' + esc(archesOf(a)) + (a.only_reason ? ' only' : '') + '</td><td>' + (a.withdrawn_at ? taskPill("withdrawn", "withdrawn " + ago(a.withdrawn_at) + " by " + a.withdrawn_by + ": " + (a.withdrawn_reason || "")) : (a.changes ? taskPill("changes requested", "a rejection that asked for changes: the name stayed the requester's") : taskPill(a.decision))) + '</td><td>' + where + act + '</td><td class="muted">' + esc(a.withdrawn_at ? (a.withdrawn_reason || "") : (a.note || "")) + '</td></tr>';
      }, { empty: "no decision yet" });
    }
    renderWorkers();
    endSkeleton();
  }).catch(function (e) { $("#line").textContent = "could not load: " + errorText(e); endSkeleton(); });
  }
  // The staging quota is the owner's own (GET /factory/me answers for the caller): the figure on their page, a dash on it for everyone else. The same answer carries their agents' grants and drafts (#252), which only they see.
  function quota() {
    if (!isOwner(login)) { $("#quota").textContent = "—"; $("#quota").title = "only " + login + " sees their staging"; return; }
    api("GET", API + "/me").then(function (d) { renderAgents(d); renderPasskeys(d); var st = d.staging; if (!st) return; $("#quota").textContent = "staging " + (st.bytes / 1048576).toFixed(1) + " MB of " + (st.quota_bytes / 1073741824).toFixed(0) + " GB · evidence expires after 30 days"; }).catch(function () {});
  }
  // ---- agents (#252): the owner's grants, each with Revoke while it lives, and the drafts their agents made — waiting ones with the link to confirm them, the rest with what became of them. Served hidden; shown to the owner only, from their own no-store /factory/me.
  var DRAFT_PILL = { waiting: "warn", confirmed: "ok", refused: "error", discarded: "none", expired: "none" };
  var VERDICT_WORDS = { approve: "approve", request_changes: "request changes", reject: "reject", block: "block" };
  function renderAgents(d) {
    if (!d.grants) return;
    $("#agents").hidden = false;
    pager("#grants", d.grants, function (g) {
      var lives = g.state === "live" || g.state === "pending";
      return '<tr><td><b>' + esc(g.agent) + '</b></td><td>' + (g.scopes || []).map(function (x) { return pillHtml(x === "contribute" ? "none" : "rec", x); }).join(" ") + '</td><td class="when">' + ago(g.created_at) + '</td><td class="when" title="' + esc(g.expires_at) + '">' + esc(String(g.expires_at).slice(0, 10)) + '</td><td class="when">' + (g.last_used ? ago(g.last_used) : '<span class="dim">never</span>') + '</td><td>' + (lives ? '<button type="button" class="btn ghost" data-grant-revoke="' + esc(g.id) + '" data-agent="' + esc(g.agent) + '" title="its token stops working at once">Revoke</button>' : taskPill(g.state === "revoked" ? "withdrawn" : "cancelled", g.state + (g.revoked_by ? " (" + g.revoked_by + ")" : ""))) + '</td></tr>';
    }, { empty: "no agent granted — omarchy-cli login --agent \"<its name>\"" });
    pager("#drafts", d.drafts || [], function (x) {
      var said = x.state === "waiting" ? '<a href="/auth/confirm/' + esc(x.id) + '">confirm or discard →</a>' : esc((x.outcome && (x.outcome.error || x.outcome.decision)) || "");
      return '<tr><td class="when">' + ago(x.created_at) + '</td><td><a href="' + pkgHref(x.name, null, null) + '"><b>' + esc(x.name) + '</b></a>' + (x.task_id ? ' <a class="dim" href="/build/' + x.task_id + '">#' + x.task_id + '</a>' : '') + '</td><td>' + esc(VERDICT_WORDS[x.verdict] || x.verdict) + '</td><td>' + esc(x.agent) + '</td><td>' + pillHtml(DRAFT_PILL[x.state] || "none", x.state) + ' <span class="muted">' + said + '</span></td><td class="muted">' + esc(x.note || "") + '</td></tr>';
    }, { empty: "no draft yet" });
    land("agents");
  }
  // A link to a section served hidden — "Your drafts" (#agents), "Register a passkey" (#passkeys) — found nothing to scroll to when the page loaded: once the section is drawn, the page goes there, once, and its heading takes the focus. The tables around it are still filling, so it is kept in place while the page grows — a few seconds at most, and never after the person scrolls, clicks or types.
  var LANDED = {};
  function land(id) {
    if (LANDED[id] || location.hash !== "#" + id) return;
    var sec = document.getElementById(id); if (!sec || sec.hidden) return;
    LANDED[id] = true;
    var h = sec.querySelector("h2"), there = function () { sec.scrollIntoView({ block: "start" }); };
    there();
    if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
    if (!window.ResizeObserver) return;
    var ro = new ResizeObserver(there), by = ["wheel", "touchstart", "keydown", "mousedown"];
    var stop = function () { ro.disconnect(); by.forEach(function (e) { window.removeEventListener(e, stop, true); }); };
    ro.observe(document.body);
    by.forEach(function (e) { window.addEventListener(e, stop, { capture: true, passive: true }); });
    setTimeout(stop, 4000);
  }
  // ---- passkeys (#257): the owner's, each with Remove, and Add a passkey — navigator.credentials.create() with the options the pool issued (user verification required), its answer posted for the pool to verify. Served hidden; shown to the owner only, from their own no-store /factory/me, and only to a maintainer or someone who still holds one (a maintainer once, who is told why there is no Add). #pk-said is always in the page and says each step — a failure marked as one — while Add a passkey keeps the focus (aria-disabled while the browser asks, never disabled).
  var PASSKEY_FORM = ${JSON.stringify(PASSKEY_FORM)}, PASSKEY_NOT_A_MAINTAINER = ${JSON.stringify(PASSKEY_NOT_A_MAINTAINER)}, PK_DRAWN = null, PK_BUSY = false;
  // How many passkeys the owner holds, from their /factory/me (#271): the first is added with the session alone, any other with an answer from one of them — asked at a press of its own and kept for the next (PK_VOUCH), as a browser takes one passkey request per press (Safari's rule).
  var PK_HELD = 0, PK_VOUCH = null;
  function pkB64(buf) { var b = new Uint8Array(buf), s = ""; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  function pkBytes(s) { var t = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (t.length % 4) t += "="; var bin = atob(t), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function pkSentence(text) { return String(text || "").trim().replace(/[.\s]+$/, "") + "."; }
  function pkSay(text, failed) { var el = $("#pk-said"); el.className = "sub" + (failed ? " err" : ""); el.textContent = text || ""; }
  function renderPasskeys(d) {
    if (!d.passkeys) return;
    var maintainer = !!(d.contributor && d.contributor.role === "maintainer");
    // Nobody but a maintainer adds one: a section with nothing to add and nothing to remove is not drawn for them at all, as the Approvals are not — unless it is on the screen already (they just removed their last one: the status line says so).
    if (!maintainer && !d.passkeys.length && $("#passkeys").hidden) return;
    $("#passkeys").hidden = false;
    PK_HELD = d.passkeys.length;
    // The shell's word on it follows the owner's own list (#287): the notice at the top goes once they hold one, and comes back when the last one went.
    passkeyHeld(PK_HELD > 0);
    // The form is drawn again only when it changed: a name being typed stays through a refresh.
    if (PK_DRAWN !== maintainer) { $("#pk-form").innerHTML = maintainer ? PASSKEY_FORM : PASSKEY_NOT_A_MAINTAINER; PK_DRAWN = maintainer; }
    pager("#pk-table", d.passkeys, function (k) {
      return '<tr><td><b>' + esc(k.label) + '</b></td><td class="mono">' + esc(k.alg) + '</td><td class="when" title="' + esc(k.created_at) + '">' + ago(k.created_at) + '</td><td class="when">' + (k.last_used ? ago(k.last_used) : '<span class="dim">never</span>') + '</td><td><button type="button" class="btn ghost" data-passkey-remove="' + esc(k.id) + '" data-label="' + esc(k.label) + '" title="it confirms nothing from now on" aria-label="Remove ' + esc(k.label) + '">Remove</button></td></tr>';
    }, { empty: maintainer ? "no passkey yet: approve and block wait until you add one" : "no passkey" });
    land("passkeys");
  }
  function addPasskey() {
    var btn = $("#pk-add"); if (!btn || btn.disabled || PK_BUSY) return;
    if (!window.PublicKeyCredential || !navigator.credentials || !window.isSecureContext) { pkSay("This browser cannot make a passkey on this page. It needs a secure address (https, or localhost) and passkey support.", true); return; }
    PK_BUSY = true; btn.setAttribute("aria-disabled", "true");
    var done = function () { PK_BUSY = false; btn.removeAttribute("aria-disabled"); };
    var again = function () { PK_VOUCH = null; btn.textContent = "Add a passkey"; };
    // A second passkey, first press: a passkey the owner holds answers for adding one (#271); the next press makes the new one with that answer.
    if (PK_HELD && !PK_VOUCH) {
      pkSay("First, a passkey you hold: answer your device with your fingerprint, face or PIN.");
      passkeyed("passkey:add", function (assertion) { PK_VOUCH = assertion; return Promise.resolve({ vouched: true }); }).then(function (r) {
        done();
        if (r.error) { again(); pkSay("Not added: " + pkSentence(r.error), true); return; }
        btn.textContent = "Add the new passkey";
        pkSay("Your passkey answered. Press Add the new passkey, then answer the new device.");
      }).catch(function (e) { done(); again(); pkSay("Not added: " + pkSentence(errorText(e)), true); });
      return;
    }
    pkSay("Answer your device: your fingerprint, face or PIN.");
    // The registration itself — with, for a login that holds one, that one's answer (#271): the first is the session's alone.
    var add = function (assertion) {
      return api("POST", "/auth/passkeys/challenge", {}).then(function (o) {
        if (o.error) { var x = new Error(o.error); x.pool = true; throw x; }
        var k = o.publicKey;
        return navigator.credentials.create({ publicKey: { challenge: pkBytes(k.challenge), rp: k.rp, user: { id: pkBytes(k.user.id), name: k.user.name, displayName: k.user.displayName }, pubKeyCredParams: k.pubKeyCredParams, timeout: k.timeout, attestation: k.attestation, authenticatorSelection: k.authenticatorSelection, excludeCredentials: k.excludeCredentials.map(function (c) { return { type: c.type, id: pkBytes(c.id) }; }) } });
      }).then(function (cred) {
        if (!cred) { var x = new Error("no passkey was made"); x.name = "NotAllowedError"; throw x; }
        return api("POST", "/auth/passkeys", { label: $("#pk-label").value, id: pkB64(cred.rawId), clientDataJSON: pkB64(cred.response.clientDataJSON), attestationObject: pkB64(cred.response.attestationObject), assertion: assertion });
      });
    };
    add(PK_VOUCH || undefined).then(function (r) {
      done(); again();
      if (r.error) { pkSay("Not added: " + pkSentence(r.error), true); return; }
      var said = "Passkey added: " + r.passkey.label + ". Approve and block ask for it.";
      $("#pk-label").value = ""; pkSay(said); toast(esc(said)); quota();
    }).catch(function (e) {
      done(); again();
      var n = e && e.name;
      pkSay(n === "NotAllowedError" || n === "AbortError" ? "No passkey was made: the request was cancelled or timed out. Press Add a passkey to try again."
        : n === "InvalidStateError" ? "This device holds a passkey of yours for the pool already. Use another device, or remove that one first."
        : n === "SecurityError" ? "Your browser will not make a passkey on this address. Open your page on the pool's own address."
        : n === "NotSupportedError" ? "This browser or device cannot make a passkey the pool takes."
        : "Not added: " + pkSentence(e && e.pool ? e.message : errorText(e)), true);
    });
  }
  document.addEventListener("submit", function (ev) { if (ev.target && ev.target.id === "pk-form") { ev.preventDefault(); addPasskey(); } });
  // One registered from the notice at the top of the page (#287): the table says so at once.
  onPasskey(function () { quota(); });
  // ---- a lost passkey (#271): another maintainer's way back for this one — every passkey of theirs removed, their token and their agents' grants revoked (#284), and their browser session ended, in one step the journal and a signed record keep, confirmed with the resetting maintainer's own passkey. Drawn for a maintainer on another maintainer's page, and for nobody else; the server says when there is nothing to reset, before the resetting maintainer's device is asked (the page reads nothing more to know it).
  function renderReset(d) {
    var show = d.role === "maintainer" && isMaintainer() && !isOwner(login);
    $("#pk-reset").hidden = !show;
    if (show) $("#pk-reset-go").textContent = "Reset " + login + "'s passkeys";
  }
  // The section's line says each outcome once — a live region, beside the form — as HTML: a refusal's link to add a passkey, the signed record's address.
  function resetSay(html, failed) { var el = $("#pk-reset-said"); el.className = "sub" + (failed ? " err" : ""); el.innerHTML = html || ""; }
  document.addEventListener("submit", function (ev) {
    if (!ev.target || ev.target.id !== "pk-reset-form") return;
    ev.preventDefault();
    var why = $("#pk-reset-why").value.trim();
    if (why.length < 4) { resetSay(esc("Say why in a few words: it goes on the public journal and the signed record."), true); return; }
    ask({ title: "Reset " + login + "'s passkeys?", text: "Every passkey of " + esc(login) + "'s goes, with their token and their agents' grants, and " + esc(login) + " is signed out. They add a new passkey and make a new token after signing in again. The reason: <i>" + esc(why) + "</i>.", held: "Your passkey confirms it.", confirm: "Reset with your passkey", first: "Register a passkey and reset", nothing: "Nothing was reset.", danger: true }).then(function (go) {
      if (go === null) return;
      passkeyed("passkey:reset:" + login, function (assertion) { return api("POST", "/auth/passkeys/reset", { login: login, reason: why, assertion: assertion }); }).then(function (r) {
        if (r.error) { resetSay("Not reset: " + refusalHtml({ error: pkSentence(r.error), register: r.register }), true); return; }
        $("#pk-reset-why").value = "";
        var g = (r.grants_revoked || []).length, said = esc("Reset: " + r.passkeys.length + " passkey" + (r.passkeys.length === 1 ? "" : "s") + " of " + login + "'s removed, their token" + (g ? " and " + g + " agent grant" + (g === 1 ? "" : "s") : "") + " revoked, and " + login + " signed out.");
        resetSay(said + (r.record ? ' The journal says who and why, and so does <a href="' + esc(r.record) + '">the signed record</a>.' : esc(" The journal says who and why. The signed record was not written: " + pkSentence(r.record_error || "the bucket refused it"))));
      }).catch(function (e) { resetSay(esc("Not reset: " + pkSentence(errorText(e))), true); });
    });
  });
  // Who is looking (the shell's whoami: one fetch of /auth/me per page) and what they may do, before the first draw — so the tables come with their buttons in the right state, drawn once.
  Promise.all([new Promise(function (r) { whoami(r); }), loadCan()]).then(function () {
    DRAWN = true;
    renderTop(); renderRegister(); renderHostForm(); quota();
    load(); loadWorkers(); loadHosts();
    // The page follows the work for whoever looks — a build queued, then building, then staged — no reload. A signed-in person's rights ride along once a minute (a block, an approval, a registration gone change what they may press — rarely, and each read is a D1 bill) and right after their own act; nobody's cannot change until they sign in, which is a new page.
    var tick = 0;
    setInterval(function () { tick++; if (WHO.me && tick % 4 === 0) loadCan(); load(); loadWorkers(); if (tick % 4 === 0) loadHosts(); }, 15000);
  });
  // Buttons inside paged tables: one delegated handler survives re-renders. A grey button (gate) never gets here: disabled, it takes no click.
  document.addEventListener("click", function (ev) {
    var x = ev.target.closest ? ev.target.closest("button[data-expand]") : null;
    if (x) { var n = x.getAttribute("data-expand"); OPEN[n] = !OPEN[n]; drawPackages(); if (OPEN[n] && n !== OTHERS) story(n); return; }
    var wo = ev.target.closest ? ev.target.closest("button[data-worker-order]") : null;
    if (wo) { if (!wo.disabled) workerOrder(wo.getAttribute("data-worker-order"), wo.getAttribute("data-worker")); return; }
    var pr = ev.target.closest ? ev.target.closest("button[data-passkey-remove]") : null;
    if (pr) {
      var pid = pr.getAttribute("data-passkey-remove"), plabel = pr.getAttribute("data-label");
      ask({ title: "Remove the passkey " + plabel + "?", text: "A passkey you hold confirms it: this one or another. It confirms nothing after, and the journal records that you removed it. Approve and block need another passkey of yours.", confirm: "Remove with your passkey", danger: true }).then(function (go) {
        if (go === null) return;
        passkeyed("passkey:remove:" + pid, function (assertion) { return api("POST", "/auth/passkeys/" + encodeURIComponent(pid) + "/remove", { assertion: assertion }); }).then(function (r) {
          if (r.error) pkSay("Not removed: " + pkSentence(r.error), true); else { pkSay("Removed: " + plabel + ". It confirms nothing from now on."); toast("Removed: " + esc(plabel) + "."); }
          quota();
        }).catch(function (e) { pkSay("Not removed: " + pkSentence(errorText(e)), true); });
      });
      return;
    }
    var gr = ev.target.closest ? ev.target.closest("button[data-grant-revoke]") : null;
    if (gr) {
      var gid = gr.getAttribute("data-grant-revoke"), gagent = gr.getAttribute("data-agent");
      ask({ title: "Revoke the grant to " + gagent + "?", text: "Its token stops working at once; what it did stays on the record. Grant it again with omarchy-cli login.", confirm: "Revoke", danger: true }).then(function (go) {
        if (go === null) return;
        api("POST", API + "/grants/" + encodeURIComponent(gid) + "/revoke", {}).then(function (r) { if (r.error) toast(esc(r.error), "error"); else toast("Revoked: " + esc(r.agent) + " acts as you no more."); quota(); }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
      return;
    }
    var w = ev.target.closest ? ev.target.closest("button[data-withdraw]") : null;
    if (w) {
      var wid = w.getAttribute("data-withdraw"), wname = w.getAttribute("data-name");
      ask({ title: "Withdraw the approval of " + wname, text: "The approval stays on the record and is void from now on; the package leaves every ring it reached — a release without it, the databases rendered again by the project's workers; another maintainer decides on the build.", input: "required", placeholder: "why take it back", confirm: "Withdraw", danger: true }).then(function (note) {
        if (note === null) return; w.disabled = true;
        api("POST", API + "/tasks/" + wid + "/withdraw", { note: note }).then(function (r) { if (r.error) { toast(esc(r.error), "error"); w.disabled = false; } else toast("Withdrawn — " + esc(wname) + " leaves " + esc((r.rings || []).map(function (x) { return x.ring; }).join(", ") || "no ring") + "; another maintainer decides."); acted(); load(); }).catch(function (e) { w.disabled = false; toast("failed: " + esc(errorText(e)), "error"); });
      });
      return;
    }
    var b = ev.target.closest ? ev.target.closest("button[data-build],button[data-remove],button[data-revoke]") : null; if (!b) return;
    if (b.hasAttribute("data-build")) {
      var name = b.getAttribute("data-build"), arch = b.getAttribute("data-arch");
      // Where it runs is the asker's call (one architecture: the queue, or one of the asker's own community registrations — a maintainer's legacy set, #343: a contributor has none and is offered the queue alone; all: the queue); a hint goes to the agent that drafts the recipe.
      // What it asks is the profile's (#412): whether the recipe is the project's own PKGBUILD (detected.has_pkgbuild) and the contributor's builds of it waiting in the queue — no story read to press it.
      var pk = PKGS.filter(function (x) { return x.name === name; })[0] || {};
      var drafts = !pk.has_pkgbuild; // the project's own PKGBUILD is built as it is: no agent, no hint
      var waiting = BUILDS.filter(function (t) { return t.name === name && t.trust === "community" && t.status === "queued" && (!arch || t.arch === arch); });
      var pinnedNow = waiting.length === 1 ? waiting[0].pinned_to : null;
      var where = FACTORY ? whereOptions(FACTORY.workers, arch || ARCHES[0], login, false, drafts, waiting.length === 1 ? waiting[0].queue : null, pinnedNow) : null;
      if (where && !arch) where.options = where.options.filter(function (o) { return o.value === ""; });
      var queuedNow = waiting.length > 0;
      ask({ title: (queuedNow ? (pinnedNow ? "Waiting for " + wtShort(pinnedNow) + ": " : "In the queue: ") : "Build ") + name + (arch ? " for " + arch : "") + (queuedNow ? "" : "?"), text: (queuedNow ? "Build <b>#" + waiting.map(function (t) { return t.id; }).join(", #") + "</b> " + (pinnedNow ? "waits for <b>" + esc(wtShort(pinnedNow)) + "</b> only. Keep that, send it to the queue instead, or take it out" : "waits in the queue. " + (where && where.mine ? "Leave it there, name a worker of yours, or take it out" : "Leave it there or take it out")) + " — nothing puts it back by itself; this button does. " : "") + (drafts ? "The worker drafts the recipe with its agent — from the last build's PKGBUILD and what stopped it, when there is one — builds it, runs the gate and stages the result as evidence; the second agent audits it. " : "The worker builds the project's own PKGBUILD as it is, runs the gate and stages the result as evidence; the second agent audits it. ") + (arch ? "This architecture only." : "Every architecture the request names."), select: where, input: drafts ? "optional" : false, placeholder: "a hint for the agent (optional): the binary's name, a build flag, a dependency, what to do differently", confirm: queuedNow ? (pinnedNow ? "Keep it so" : "Keep it queued") : "Build", alt: queuedNow ? { text: "Take it out of the queue", danger: true } : null }).then(function (go) {
        if (go === null) return; b.disabled = true;
        if (go && typeof go === "object" && go.alt) {
          // Out of the queue: each waiting build of the architecture(s) asked, one call each.
          Promise.all(waiting.map(function (t) { return api("DELETE", API + "/packages/" + encodeURIComponent(name) + "/builds/" + t.id); })).then(function (rs) {
            var bad = rs.filter(function (r) { return r.error; });
            if (bad.length) toast(esc(bad[0].error), "error"); else toast("Out of the queue: build #" + waiting.map(function (t) { return t.id; }).join(", #") + ". Press Build to queue it again.", "warn");
            OPEN[name] = true; acted(); load();
          }).catch(function (e) { b.disabled = false; toast("failed: " + esc(errorText(e)), "error"); });
          return;
        }
        var body = arch ? { arches: [arch] } : {};
        if (go && typeof go === "object") { if (go.pick) body.worker = go.pick; if (go.note) body.hint = go.note; } else if (go) body.hint = go;
        api("POST", API + "/packages/" + encodeURIComponent(name) + "/build", body).then(function (r) { if (r.error) toast(esc(r.error), "error"); else if (!(r.tasks || []).length) toast(esc(r.note || "nothing queued"), "warn"); else toast((queuedNow ? "Still queued: " : "Queued ") + (r.tasks || []).length + " build(s): " + esc((r.arches || []).join(", ")) + (r.pinned_to ? " — for " + esc(wtShort(r.pinned_to)) : r.queue && Object.keys(r.queue).length ? " — " + Object.keys(r.queue).map(function (a) { return a + " " + r.queue[a].position + " of " + r.queue[a].total; }).join(", ") : "") + (r.lessons && Object.keys(r.lessons).length ? " — from the last build's PKGBUILD and log" : "") + " — this page follows them."); OPEN[name] = true; acted(); load(); }).catch(function (e) { b.disabled = false; toast("failed: " + esc(errorText(e)), "error"); });
      });
    }
    else if (b.hasAttribute("data-remove")) {
      var rm = b.getAttribute("data-remove");
      ask({ title: "Remove the registration of " + rm + "?", text: "Its builds stop; the evidence on the record stays. Anyone can register the name again.", confirm: "Remove", danger: true }).then(function (go) {
        if (go === null) return;
        api("DELETE", API + "/packages/" + encodeURIComponent(rm)).then(function (r) { if (r.error) toast(esc(r.error), "error"); else toast("Removed " + esc(rm) + "."); delete OPEN[rm]; acted(); load(); }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
    }
    else if (b.hasAttribute("data-revoke")) {
      var wid = b.getAttribute("data-revoke");
      ask({ title: "Revoke " + wid + "?", text: "Its token stops working at once; a build it holds finishes on its own. Its history stays on its page; no new registration replaces it (#346) — a machine joins as a host.", confirm: "Revoke", danger: true }).then(function (go) {
        if (go === null) return;
        api("DELETE", API + "/workers/" + encodeURIComponent(wid)).then(function (r) { if (r.error) toast(esc(r.error), "error"); else toast("Revoked."); acted(); load(); loadWorkers(); }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
    }
  });
`;

export function userHtml(login: string, poolUrl: string, version: RunningVersion): string {
  return page({
    path: `/user/${login}`,
    title: `${login} · omarchy-pool`,
    description: `What ${login} contributes to and maintains in the pool.`,
    active: "factory",
    body: body(login),
    // The v1 kit (#412), as the redesigned pages are drawn: its sheet, then the rules above.
    kit: true,
    css: CSS,
    script: SCRIPT,
    poolUrl,
    version,
  });
}

/**
 * What /user/<login> is made of: everything draws from the person's profile
 * (`/api/v1/users/<login>`), the workers from the same listing the Workers
 * page reads, an open package's story from its story, and what this viewer
 * may do from `/api/v1/users/<login>/can`. The page is public and reads the
 * same for every role: every control is drawn for everyone, and the
 * server's answer says which are live — the owner's workspace, a
 * maintainer's revoke, drain, own-only, remove and withdraw — and why the
 * others are grey. The dialogs a button opens are folded into the entry
 * that renders the button. The entries are on alice's page (the
 * contributor who owns the package and the worker) except the Approvals
 * section, which a maintainer's page shows, and the hosts', which m1's and
 * m2's show.
 *
 * Since #412 the package is the unit: a block per registration, its
 * architectures as lines with their Build, its story and its builds folded
 * under it — the entries user.packages to user.package-builds — and a
 * worker's row carries Drain beside Revoke (user.worker-drain).
 *
 * The acts in order: the token; Remove, which refuses the owner of an
 * approved package; Build, which queues a build and sets the package
 * waiting; the worker registered, drained (refused here without the page's
 * Origin), then revoked; the approval withdrawn last — the fixture has one,
 * and the build's page may have taken it back before this manifest.
 */
export const USER_COMPONENTS = (F: Fixture): Component[] => {
  const page = `/user/${F.owner}`;
  const profile = `/api/v1/users/${F.owner}`;
  const story = `/api/v1/factory/packages/${F.factoryPkg}/story`;
  const factory = "/api/v1/factory?limit=10";
  const evidence = (task: number, file: string) => `/api/v1/factory/tasks/${task}/artifacts/${file}`;
  return [
    {
      id: "user.crumbs",
      page,
      anchor: ['class="crumbs"', 'href="/factory">Factory', 'id="crumb"'],
      script: ['"#crumb"', 'location.pathname.split("/")[2]'],
      visible: EVERYONE,
    },
    {
      // What this viewer may do here, read before the first draw and again once a minute and after their own act: every control below reads CAN and is grey with the server's reason where it says no — nobody's answer, all false with the sign-in, until it lands; Remove per registration, Revoke, Drain and Resume per worker.
      id: "user.rights",
      page,
      anchor: [],
      script: ['"/can"', "function may(", "function reason(", "function removeOf(", "CAN.packages[name]", "function workerCan(", "CAN.workers[w.id]", '"sign in with GitHub"', "function loadCan(", "function acted(", "tick % 4 === 0) loadCan()"],
      reads: [
        { path: `${profile}/can`, fields: ["login", "can.request", "can.register", "can.token", "can.build", "can.dequeue", "can.remove", "can.revoke", "can.withdraw", "can.why.request", "can.why.register", "can.why.token", "can.why.build", "can.why.remove", "can.why.revoke", "can.why.withdraw", `can.packages.${F.factoryPkg}.remove`, `can.packages.${F.factoryPkg}.why`, `can.workers.${F.ownerWorker}.revoke`, `can.workers.${F.ownerWorker}.why.revoke`, `can.workers.${F.ownerWorker}.drain`, `can.workers.${F.ownerWorker}.why.drain`, `can.workers.${F.ownerWorker}.resume`, `can.workers.${F.ownerWorker}.why.resume`] },
        { path: `${profile}/can`, as: "contributor", fields: ["login", "can.why.request", "can.why.register", "can.why.token", "can.why.build", "can.why.remove", "can.why.revoke", "can.why.withdraw", `can.packages.${F.factoryPkg}.why`, `can.workers.${F.ownerWorker}.why.drain`] },
        { path: `${profile}/can`, as: "owner", fields: ["login", "can.request", "can.register", "can.token", "can.build", "can.revoke", "can.why.withdraw", `can.packages.${F.factoryPkg}.remove`, `can.packages.${F.factoryPkg}.why`, `can.workers.${F.ownerWorker}.revoke`, `can.workers.${F.ownerWorker}.drain`] },
        { path: `${profile}/can`, as: "maintainer", fields: ["login", "can.remove", "can.revoke", "can.withdraw", "can.why.request", "can.why.build", `can.packages.${F.factoryPkg}.remove`, `can.workers.${F.ownerWorker}.revoke`, `can.workers.${F.ownerWorker}.drain`, `can.workers.${F.ownerWorker}.resume`] },
        // A maintainer's own page lists the project's worker: Revoke and Drain on its row, the maintainer's.
        { path: `/api/v1/users/${F.m1}/can`, as: "maintainer", fields: [`can.workers.${F.worker}.revoke`, `can.workers.${F.worker}.drain`] },
      ],
      visible: EVERYONE,
    },
    {
      // The head, the kit's (#412): the two letters, green for a maintainer, the name in the kit's display type.
      id: "user.profile-head",
      page,
      anchor: ['class="up-head"', 'id="avatar"', '<h1 class="op-hero" id="title">'],
      script: ['"#avatar"', '"#title"', 'd.login.slice(0, 2)', 'd.role === "maintainer"'],
      reads: [{ path: profile, fields: ["login", "name", "role"] }],
      visible: EVERYONE,
    },
    {
      id: "user.identity-line",
      page,
      anchor: ['id="line"'],
      script: ['"#line"', "d.blocked", "d.maintainer_since", "ago(d.last_seen)", "d.github"],
      reads: [
        { path: profile, fields: ["role", "blocked", "maintainer_since", "since", "last_seen", "github", "login"] },
        { path: `/api/v1/users/${F.m2}`, fields: ["role", "maintainer_since"] },
      ],
      visible: EVERYONE,
    },
    {
      // The four numbers as the kit's tiles; the Workers tile counts as the shell counts (workerCounts): registered and alive, the listing's words.
      id: "user.tiles",
      page,
      anchor: ['<div class="op-stats" id="tiles">'],
      script: ['"#tiles"', "d.build_counts", '"Decisions", num(d.approvals.length)', "d.approved_packages.length", "workerCounts(d.workers)", "wc.registered", "wc.alive", '<div class="op-stat"><span class="k">'],
      reads: [{ path: profile, fields: ["packages", "build_counts.total", "build_counts.staged", "build_counts.published", "build_counts.failed", "approvals", "approved_packages", "workers", "workers.0.revoked_at", "workers.0.alive", "workers.0.ready", "workers.0.side", "workers.0.current_task"] }],
      visible: EVERYONE,
    },
    {
      id: "user.activity-chart",
      page,
      anchor: ['id="activity"', 'id="activity-note"'],
      script: ['"#activity"', '"#activity-note"', "mark(b.created_at)", "mark(a.created_at)", "mark(p.updated_at)"],
      reads: [
        { path: profile, fields: ["builds.0.created_at", "packages.0.updated_at"] },
        { path: `/api/v1/users/${F.m2}`, fields: ["approvals.0.created_at"] },
      ],
      visible: EVERYONE,
    },
    {
      // The track record, a card for everyone (#412: no longer a section served hidden until it has a row): the score, what was contributed and maintained, the formula.
      id: "user.score-panel",
      page,
      anchor: ['id="record-section"', 'href="/docs/governance">the formula', 'id="score"', 'id="score-f"', '<dl class="up-kv" id="record">'],
      script: ['"#score"', '"#score-f"', "rec.score", '"#record"', "rec.contributed", "rec.maintained", "m.rebuilds_failed", "rc.donated"],
      reads: [{ path: profile, fields: ["record.score", "record.contributed.approved", "record.contributed.staged", "record.contributed.bumps", "record.contributed.donated", "record.contributed.rejected", "record.maintained.approvals", "record.maintained.rejections", "record.maintained.rebuilds_failed"] }],
      visible: EVERYONE,
    },
    {
      // The packages (#412): a block per registration, from the profile alone — its head with the name (the package's page on the first architecture the request names), the stage, a block, the category; where it stands; the way to request one, served grey with whose it is and drawn again from the server's word (the owner's). Drawn again only when what it draws changed.
      id: "user.packages",
      page,
      anchor: ['id="packages-section"', 'id="pk-request"', 'data-href="/factory#request"', `title="only ${F.owner} requests here"`, '<div class="up-pkgs" id="packages">'],
      script: ["function pkgBlock(", "function drawPackages(", '"#pk-request"', 'href=\\"/factory#request\\"', 'gate(REQUEST_LINK, may("request"), reason("request"))', "JSON.parse(p.arches", "pkgHref(p.name, null, A.registered[0])", "p.detail", "p.blocked_at", "html !== DRAWN_PKGS", "PKGS = d.packages; BUILDS = d.builds;"],
      reads: [{ path: profile, fields: ["packages.0.name", "packages.0.category", "packages.0.arches", "packages.0.targets", "packages.0.status", "packages.0.detail", "packages.0.blocked_at", "packages.0.blocked_reason", "packages.0.has_pkgbuild"] }],
      visible: EVERYONE,
    },
    {
      // A line per architecture, visible without opening anything (#412): where it stands (the target's word and its square), its latest build with its version, the queue or the native worker it waits for, the worker that holds it, the gate on it, the class and the audit once the story is read — and its Build, for everyone: grey while a build runs or the package is blocked, with the door's word for an architecture the request no longer names, by role otherwise.
      id: "user.package-arches",
      page,
      anchor: ['id="packages"'],
      script: ["function archLine(", "function archesOfPkg(", "TARGET_TONE", "TARGET_WORD[t.status]", '"a build is running"', '"arches must name one the request has: "', '"name a worker, or take it out of the queue"', "function gateWord(", "b.gate_warnings", "classPill(c.score)", "auditWord(c.audit)", "data-arch", 'nativePill({ status: b.status, arch: b.arch, params: { needs_native: b.needs_native, refused_4k: b.refused_4k } })'],
      reads: [{ path: profile, fields: ["packages.0.targets", "builds.0.name", "builds.0.arch", "builds.0.status", "builds.0.id", "builds.0.version", "builds.0.trust", "builds.0.gate", "builds.0.gate_warnings", "builds.0.gate_fails", "builds.0.lease_owner", "builds.0.needs_native", "builds.0.refused_4k"] }],
      visible: EVERYONE,
    },
    {
      // The package's head: Build all and Remove, for everyone — Build the owner's, grey by state first (a build in flight on any architecture, the package blocked); Remove answered per registration (a maintainer's on an approved one); the Remove dialog is this entry's.
      id: "user.package-acts",
      page,
      anchor: ['id="packages"'],
      script: ["function buildBtn(", "function removeBtn(", "removeOf(name)", '"a build is in flight"', "function blockedWhy(", "data-build", "data-remove", '"Remove the registration of "', 'api("DELETE", API + "/packages/" + encodeURIComponent(rm))'],
      // The owner is refused: by now a manifest before this one rejected one of the community's builds, which put the registration back to `registered`, and the project's build of it is still staged for a decision — the owner waits for the maintainers (409). A maintainer's removal would take the package with it, so none is sent.
      acts: [{ method: "DELETE", path: `/api/v1/factory/packages/${F.factoryPkg}`, expect: { anonymous: 401, contributor: 403, owner: 409 } }],
      visible: EVERYONE,
    },
    {
      // The one control that opens a package (#412): its story — read for an opened package only, again at each refresh while it is open — and its builds.
      id: "user.package-open",
      page,
      anchor: ['id="packages"'],
      script: ["function moreBtn(", "data-expand", 'aria-expanded="', "function story(", '"/api/v1/factory/packages/"', '"/story"', "function refreshStories(", '"loading the story…"', '"could not load the story"'],
      reads: [{ path: story, fields: ["package", "request", "chains", "rings"] }],
      visible: EVERYONE,
    },
    {
      // The request as the form checks it, under an opened package, with Renew the request for everyone: live for the owner while a renewal is taken, grey with the state's reason for the owner and the server's (can.why.request, the same word the build's page reads) for anyone else.
      id: "user.story-request-block",
      page,
      anchor: ['id="packages"'],
      script: ['requestBlock(st.request, may("request"), name, renewable, whyNot, reason("request"))', "st.request.renewable", "st.request.busy", '"renew it once build #"', "pkg.blocked_at"],
      reads: [{ path: story, fields: ["request.id", "request.record", "request.signature", "request.version", "request.created_at", "request.complete", "request.checks", "request.checks.0.item", "request.checks.0.ok", "request.checks.0.note", "request.renewable", "request.busy", "request.arches", "package.blocked_at", "package.arches"] }],
      visible: EVERYONE,
    },
    {
      // One panel per architecture under an opened package: its latest chain, the two halves of its score with the gate, the audit and the trial, the earlier builds — its Build is the line's, above.
      id: "user.story-arch-panel",
      page,
      anchor: ['id="packages"'],
      // The checklist's build items link the build's page at its evidence (the shell's evidenceLink); the gate, the audit and the trial link the file the story's row says is there.
      script: ['archPanel(a, mine, nextStep(st, mine[0]), "")', 'href="/api/v1/factory/tasks/', "evidenceLink(cc)", "evidenceLink(pb)"],
      reads: [
        { path: story, fields: ["chains.0.contributor.id", "chains.0.contributor.status", "chains.0.contributor.arch", "chains.0.contributor.version", "chains.0.contributor.owner", "chains.0.contributor.lease_owner", "chains.0.contributor.params", "chains.0.contributor.finished_at", "chains.0.contributor.duration_ms", "chains.0.contributor.result.vet", "chains.0.project", "chains.0.audit", "chains.0.trial", "chains.0.approval", "chains.0.withdrawn", "chains.0.score.class", "chains.0.score.points", "chains.0.score.projected", "chains.0.score.ready", "chains.0.score.items.0.who", "chains.0.score.items.0.item", "chains.0.score.items.0.points"] },
        { path: `/build/${F.contributorTask}`, json: false },
        { path: `/build/${F.projectTask}`, json: false },
        { path: evidence(F.contributorTask, "tests.log"), json: false },
        { path: evidence(F.contributorTask, "vet.json"), json: false },
        { path: evidence(F.contributorTask, "audit.md"), json: false },
        { path: evidence(F.projectTask, "trial.log"), json: false },
      ],
      visible: EVERYONE,
    },
    {
      id: "user.story-next-step",
      page,
      anchor: ['id="packages"'],
      script: ["function nextStep(", 'evidenceLink(cc, "the evidence of #" + cc.id)', "cc.pinned_to", "cc.queue", "audit.result.verdict", '"A request on the record"', "whereOptions(FACTORY.workers, arch, login, false)", "a && a.standing", "personLink(a.by)", "pb && waitsForNative(pb)"],
      reads: [
        { path: story, fields: ["chains.0.approval", "chains.0.contributor.status", "chains.0.contributor.pinned_to", "chains.0.contributor.attempts", "chains.0.contributor.pkgbuild_ref", "chains.0.contributor.version", "chains.0.contributor.error", "chains.0.contributor.result.vet.verdict", "chains.0.audit", "chains.0.score.items", "request.complete", "request.version", "rings"] },
        { path: factory, fields: ["workers.0.id", "workers.0.alive", "workers.0.labels"] },
        // The people it names — who decided, who withdrew — are the shell's, their role from the maintainer set it reads once per page.
        { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login"] },
      ],
      visible: EVERYONE,
    },
    {
      // The package's page on the most stable ring the story lists, the shell's one address.
      id: "user.story-footer",
      page,
      anchor: ['id="packages"'],
      script: ["pkgHref(name, served && served.ring, served && served.arch)", "servedRing(st.rings)", "st.rings.map"],
      reads: [{ path: story, fields: ["rings"] }],
      visible: EVERYONE,
    },
    {
      // Build <arch> and Build all open it — the owner's buttons, live for them alone: it chooses where the build runs, posts it, or takes the waiting one out of the queue (the owner's too: can.dequeue). What it asks is the profile's (#412): whether the recipe is the project's own PKGBUILD, and the builds of it waiting.
      id: "user.build-dialog",
      page,
      anchor: ['id="packages"'],
      script: ["pk.has_pkgbuild", 't.trust === "community" && t.status === "queued"', "whereOptions(FACTORY.workers, arch || ARCHES[0]", "go.alt", '"/builds/" + t.id', '"/build", body', "body.worker = go.pick", "body.hint"],
      reads: [
        { path: factory, fields: ["workers.0.arch", "workers.0.owner", "workers.0.side", "workers.0.alive", "workers.0.agent_status", "workers.0.update"] },
        { path: profile, fields: ["packages.0.has_pkgbuild", "builds.0.trust", "builds.0.pinned_to", "builds.0.status", "builds.0.arch"] },
      ],
      acts: [
        { method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/build`, body: { arches: [F.arch] }, expect: { anonymous: 401, contributor: 404, owner: 201, maintainer: 404 } },
        { method: "DELETE", path: `/api/v1/factory/packages/${F.factoryPkg}/builds/${F.stagedTask}`, expect: { anonymous: 401, contributor: 403, owner: 409, maintainer: 403 } },
      ],
      visible: ["owner"],
    },
    {
      // A package's builds, folded under it (#412) — no flat list of builds any more — and the builds of a name no longer registered here, in a block of their own. The evidence column for everyone: one link per staged or failed row, to the build's page at its Evidence section (the shell's evidenceLink) — never a raw file the build may not have left. A build an emulated worker sent back wears the native worker it waits for (the shell's nativePill, #281), its title saying whether a 4K-page one refused it too (refused_4k, #413).
      id: "user.package-builds",
      page,
      anchor: ['id="packages"'],
      script: ["function historyTable(", "function othersBlock(", '>Other names</span>', "pkgHref(t.name, ringOfBuild(t.status, null), t.arch)", "wtId(t.lease_owner)", "t.pinned_to", "dur(t.duration_ms)", "t.queue", 'evidenceLink(t) : ""', "evidence(t)", "nativePill({ status: t.status, arch: t.arch, params: { needs_native: t.needs_native, refused_4k: t.refused_4k } })"],
      reads: [
        { path: profile, fields: ["builds.0.id", "builds.0.name", "builds.0.version", "builds.0.arch", "builds.0.status", "builds.0.reason", "builds.0.trust", "builds.0.lease_owner", "builds.0.pinned_to", "builds.0.duration_ms", "builds.0.created_at", "builds.0.needs_native", "builds.0.refused_4k"] },
        { path: `/build/${F.contributorTask}`, json: false },
      ],
      visible: EVERYONE,
    },
    {
      // The cell is everyone's: the owner's own figure (GET /factory/me answers for the caller), a dash on their page for anyone else.
      id: "user.staging-quota",
      page,
      anchor: ['id="quota"'],
      script: ['"#quota"', 'api("GET", API + "/me")', "st.bytes", "st.quota_bytes", '$("#quota").textContent = "—"'],
      reads: [
        { path: "/api/v1/factory/me", status: 401 },
        { path: "/api/v1/factory/me", as: "owner", fields: ["staging.bytes", "staging.quota_bytes"] },
      ],
      visible: EVERYONE,
    },
    {
      // The owner's agents (#252): their grants with Revoke while each lives, and the drafts their agents made with the link to confirm a waiting one — served hidden, drawn from the owner's own no-store /factory/me, which answers nobody else (the public profile never carries a draft).
      id: "user.agents",
      page,
      anchor: ['<section class="op-card" id="agents" aria-labelledby="agents-h" hidden>', 'href="/agents#login">+ grant one →</a>', 'id="grants"', 'id="drafts"', 'href="/docs/omarchy-cli-mcp#write-tools">How it works →</a>'],
      script: ["function renderAgents(d)", '$("#agents").hidden = false', 'pager("#grants"', 'pager("#drafts"', "data-grant-revoke", "'<a href=\"/auth/confirm/' + esc(x.id)", 'api("POST", API + "/grants/" + encodeURIComponent(gid) + "/revoke", {})'],
      reads: [
        { path: "/api/v1/factory/me", status: 401 },
        { path: "/api/v1/factory/me", as: "owner", fields: ["grants", "drafts"] },
      ],
      acts: [{ method: "POST", path: "/api/v1/factory/grants/g_00000000000000000000000000000000/revoke", expect: { anonymous: 401, contributor: 404, owner: 404, maintainer: 404 } }],
      visible: ["owner"],
    },
    {
      // The owner's passkeys (#257): each with Remove, and Add a passkey — a maintainer's; someone else who still holds one is told why there is no Add, and a contributor who holds none is shown no section — served hidden and drawn from the owner's own no-store /factory/me, landed on when a link names #passkeys. Since #271 a second passkey and a removal ask for one the owner holds (the shell's passkeyed). The routes are the browser's session's only, on the relying party's address: the tests' pool.test is not one, so every signed-in role is refused there (rp_unavailable) and nobody signed in is asked to sign in.
      id: "user.passkeys",
      page,
      anchor: ['<section class="op-card" id="passkeys" aria-labelledby="passkeys-h" hidden>', 'id="pk-form"', 'id="pk-said"', 'id="pk-table"', 'href="/docs/omarchy-cli-mcp#write-tools">How it works →</a>'],
      script: ["function renderPasskeys(d)", '$("#passkeys").hidden = false', 'maintainer ? PASSKEY_FORM : PASSKEY_NOT_A_MAINTAINER', 'if (!maintainer && !d.passkeys.length && $("#passkeys").hidden) return;', 'land("passkeys")', 'pager("#pk-table"', "navigator.credentials.create", 'api("POST", "/auth/passkeys/challenge", {})', 'api("POST", "/auth/passkeys", {', "data-passkey-remove", 'api("POST", "/auth/passkeys/" + encodeURIComponent(pid) + "/remove", { assertion: assertion })', 'passkeyed("passkey:remove:" + pid', 'if (PK_HELD && !PK_VOUCH)', 'passkeyed("passkey:add", function (assertion) { PK_VOUCH = assertion;', '"Add the new passkey"', 'add(PK_VOUCH || undefined)', '"#pk-label"', '"#pk-add"', 'btn.setAttribute("aria-disabled", "true")', '"Passkey added: " + r.passkey.label', 'pkSay(said)'],
      reads: [{ path: "/api/v1/factory/me", as: "owner", fields: ["passkeys", "contributor.role"] }],
      acts: [
        { method: "POST", path: "/auth/passkeys/challenge", expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
        { method: "POST", path: "/auth/passkeys", expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
        { method: "POST", path: "/auth/passkeys/pk_00000000000000000000000000000000/remove", expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
      ],
      visible: ["owner"],
    },
    {
      // A lost passkey (#271): another maintainer's reset of this person's passkeys — their token and their agents' grants with them (#284) — with a reason and their own passkey — served hidden, drawn for a maintainer on another maintainer's page. The route is the browser's session's only, on the relying party's address: every signed-in role is refused on pool.test (rp_unavailable), nobody signed in is asked to sign in.
      id: "user.passkey-reset",
      page,
      anchor: ['<section class="op-card" id="pk-reset" aria-labelledby="pk-reset-h" hidden>', 'id="pk-reset-form"', 'id="pk-reset-why"', 'id="pk-reset-go" class="danger"', 'id="pk-reset-said"'],
      script: ["function renderReset(d)", 'd.role === "maintainer" && isMaintainer() && !isOwner(login)', '"Reset " + login + "\'s passkeys"', 'passkeyed("passkey:reset:" + login', 'api("POST", "/auth/passkeys/reset", { login: login, reason: why, assertion: assertion })', "refusalHtml({ error: pkSentence(r.error), register: r.register })", "r.grants_revoked", '" revoked, and "', '">the signed record</a>.', "The signed record was not written: "],
      acts: [{ method: "POST", path: "/auth/passkeys/reset", body: { login: F.m2, reason: "lost by the tests" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } }],
      visible: ["maintainer"],
    },
    {
      // Share and Token for everyone: Share live for all (the page is public, its link anyone's — no door), Token served grey with whose it is and drawn again from the server's word; the token dialogs are this entry's, the share dialog only copies the page's address.
      id: "user.share-token-buttons",
      page,
      anchor: ['id="share-btn"', 'id="share-open" title="the link to this page, to post anywhere"', 'id="token-open"', `title="only ${F.owner} mints their token"`],
      script: ['"#share-btn"', "SHARE_BTN + ' ' + gate(TOKEN_BTN, may(\"token\"), reason(\"token\"))", '"Share " + (isOwner(login) ? "your" : "this") + " profile"', '"#share-open"', '"#token-open"', 'api("POST", API + "/token", {})', "OMARCHY_CONTRIBUTOR_TOKEN", "sticky: true"],
      reads: [{ path: "/auth/me", as: "owner", fields: ["login"] }],
      acts: [{ method: "POST", path: "/api/v1/factory/token", expect: { anonymous: 401, contributor: 201, owner: 201 } }],
      visible: EVERYONE,
    },
    {
      // Nothing to run (#331, #346): served, the line that a contributor's packages build on the pool's hosts, with the packaging docs; hidden on a maintainer's page, whose section lists the hosts they provide; drawn for a maintainer on their own page only, where their machine goes — a host — and that no legacy registration is made any more: no form. The door refuses a contributor with the same sentence, and a maintainer with 410.
      id: "user.workers-register",
      page,
      anchor: ['id="w-slot"', 'id="w-own"', 'id="w-pool"', `Nothing to run here: ${POOL_HOSTS}, which the maintainers provide.`, 'href="/docs/factory#contribute-a-package"'],
      script: ["if (!isMaintainer() || !isOwner(login) || WORKER_DRAWN) return;", 'function renderPoolLine(role) { var line = $("#w-pool"); if (line && role === "maintainer") line.hidden = true; }', "renderPoolLine(d.role);", "WORKER_OWN", '"#w-own"', '\\"/docs/worker-host#maintainer-hosts\\"'],
      acts: [{ method: "POST", path: "/api/v1/factory/workers", body: { name: "laptop", arch: F.arch }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 410 } }],
      visible: ["maintainer"],
    },
    {
      // Hosts (#321): "Add a host", its form and the command it answers are a maintainer's on their own page; the door refuses everyone else server-side, and a session's write without the page's own Origin for every role.
      id: "user.hosts-add",
      page: `/user/${F.m2}`,
      anchor: ['<section class="op-card" id="hosts" aria-labelledby="hosts-h" hidden>', 'id="h-slot"', 'id="h-own"', 'id="h-notices"'],
      script: ["function renderHostForm()", "if (!isMaintainer() || !isOwner(login) || HOST_DRAWN) return;", "HOST_TOGGLE", "HOST_FORM", "HOST_OWN", '"#host-form"', '"#h-name"', '"#h-where"', '"#h-btn"', '"#h-cmd"', 'api("POST", "/api/v1/hosts/enrollments"', "d.command", "WAIT_UNTIL", '\\"/docs/worker-host#maintainer-hosts\\"'],
      acts: [{ method: "POST", path: "/api/v1/hosts/enrollments", body: { name: "vps-1" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } }],
      visible: ["maintainer"],
    },
    {
      // Stopping hosts (#322): an owner listed again resumes all their hosts the list stopped, with a passkey; another maintainer removes a
      // maintainer for cause, with a passkey and a reason. The doors refuse everyone else server-side, and a session's write without the
      // page's own Origin for every role.
      id: "user.hosts-stop",
      page: `/user/${F.m1}`,
      anchor: ['id="h-stop"'],
      script: ["function renderHostStop(hs)", "h.claims_stopped_at", 'id="h-resume-all"', 'id="h-cause"', 'passkeyed("host:resume-all:" + login', 'passkeyed("host:cause:" + login', 'base + "/resume"', 'base + "/cause"', '"/api/v1/hosts/owners/" + encodeURIComponent(login)', "NOT_LISTED", "SELF_CAUSE"],
      reads: [{ path: `/api/v1/hosts?owner=${F.m1}`, fields: ["hosts.0.status_by", "hosts.0.status_reason", "hosts.0.claims_stopped_at"] }],
      acts: [
        { method: "POST", path: `/api/v1/hosts/owners/${F.m1}/resume`, body: {}, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
        { method: "POST", path: `/api/v1/hosts/owners/${F.m1}/cause`, body: { reason: "a reason enough" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
      ],
      visible: EVERYONE,
    },
    {
      // The hosts under this name for everyone, each with its units busy and free (#324, its fleet row) and the way to its page, where its pool cap is set (#412: the cap itself for their owner and the maintainers); the fingerprint, where its key lives (#330) and the capacity for their owner and the maintainers; Confirm on one that waits, its owner's; a maintainer's notices of the others' new hosts.
      id: "user.hosts-table",
      page: `/user/${F.m1}`,
      anchor: ['<table class="op-table" id="hosts-table">', "<th>Pool cap</th>", 'id="h-none"'],
      script: ['"/api/v1/hosts?owner=" + encodeURIComponent(login)', "function renderHosts()", "h.fingerprint", "function keyWhere(h)", "hostCaps(h)", "data-host-confirm", '"only " + h.owner + " confirms their host"', '"/api/v1/hosts/" + encodeURIComponent(id) + "/confirm"', "HOSTS.notices", "n.line", 'href="/hosts/', "h.fleet.units_busy", "h.fleet.units_free", "function poolCap(h)", "#hp-facts", "h.pool_cap_units"],
      reads: [
        { path: `/api/v1/hosts?owner=${F.m1}`, fields: ["hosts", "hosts.0.id", "hosts.0.name", "hosts.0.owner", "hosts.0.status", "hosts.0.arches", "hosts.0.release_applied", "hosts.0.alive", "hosts.0.fleet.units", "hosts.0.fleet.units_busy", "hosts.0.fleet.units_free", "notices", "minimum"] },
        { path: `/api/v1/hosts?owner=${F.m1}`, as: "maintainer", fields: ["hosts.0.fingerprint", "hosts.0.host_key", "hosts.0.capacity", "hosts.0.units", "hosts.0.lanes", "hosts.0.isolation", "hosts.0.hostname", "hosts.0.pool_cap_units"] },
      ],
      acts: [{ method: "POST", path: `/api/v1/hosts/${F.host}/confirm`, body: {}, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } }],
      visible: EVERYONE,
    },
    {
      // The three panels by kind from one listing; every row — a revoked worker's and a project's too — carries Drain (or Resume), Revoke and the way to its page's Operate for whoever looks (#412), the buttons grey with the state's word first (revoked already) and the role's after (the owner's, and a maintainer's), the shell's log icon beside the id the same way; the Revoke dialog is this entry's. A worker's mode, and Share / Own only with it, are gone (#343): its door answers 410.
      id: "user.workers-tables",
      page,
      shared: "worker-table",
      anchor: ['id="wp-community"', 'id="w-community"', 'id="wp-review"', 'id="w-review"', 'id="wp-project"', 'id="w-project"', 'id="w-none"'],
      script: ['"/api/v1/factory?limit=10"', "w.owner === login", "wtKind(w)", "wtTables(true)", "workerRow(w, k, workerActs(w))", "text: wtText", "function workerActs(", 'workerCan(w, "revoke")', "data-revoke", 'api("DELETE", API + "/workers/" + encodeURIComponent(wid))', 'title="its own log — the lines between tasks, as it sent them"', '#wk-operate', '#hp-operate', "Operate →"],
      reads: [{ path: factory, fields: ["workers", "workers.0.id", "workers.0.owner", "workers.0.side", "workers.0.arch", "workers.0.alive", "workers.0.revoked_at", "workers.0.labels", "workers.0.agent_status", "workers.0.update", "workers.0.kind", "workers.0.host_id", "workers.0.drained"] }],
      acts: [
        { method: "DELETE", path: `/api/v1/factory/workers/${F.ownerWorker}`, expect: { anonymous: 401, contributor: 404, owner: 200 } },
      ],
      visible: EVERYONE,
    },
    {
      // Drain, or Resume once drained, on every worker's row for whoever looks (#412: a maintainer reaches a worker's Drain from its owner's page in one click): live for its owner and the maintainers where the worker orders' predicate says so (GET /users/:login/can's per-worker drain and resume, the door's own verdicts), grey with its word otherwise; its dialog asks why for the journal, as the worker's page does, and posts the order; the row is drawn again once the rights /can gives back change, whichever read lands first. A session's write without the page's own Origin is refused for every role (orders.ts writeGate), so the act here checks the door's gate, not a drain.
      id: "user.worker-drain",
      page,
      anchor: ['id="w-community"'],
      script: ["data-worker-order", 'workerCan(w, kind)', 'w.drained ? "resume" : "drain"', "function workerOrder(", 'API + "/workers/" + encodeURIComponent(id) + "/orders"', "UNPIN_MIN", '" drained it"', "d.note", "!== wasWorkers) renderWorkers()"],
      reads: [{ path: factory, fields: ["workers.0.drained", "workers.0.current_task"] }],
      acts: [{ method: "POST", path: `/api/v1/factory/workers/${F.ownerWorker}/orders`, body: { kind: "drain" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } }],
      visible: EVERYONE,
    },
    {
      id: "user.workers-legend",
      page,
      shared: "worker-legend",
      anchor: ['id="wt-legend"'],
      script: ["wtTables(true)", '$("#wt-legend").hidden = !any'],
      visible: EVERYONE,
    },
    {
      // Shown on a maintainer's page; whether an approval stands is the row's own `standing` (the server's word, never decision alone); an approval of one architecture alone says "only", its reason on hover (#416); Withdraw is on every row for whoever looks — live for a maintainer where an approval stands, grey with why not otherwise — with its dialog; the name opens the package on the most stable ring the row lists.
      id: "user.approvals-table",
      page: `/user/${F.m2}`,
      anchor: ['<section class="op-card" id="approvals-section" aria-labelledby="approvals-h" hidden>', '<table class="op-table" id="approvals">'],
      script: ['"#approvals-section"', 'pager("#approvals"', "var standing = a.standing", "a.withdrawn_at", "a.rings", "pkgHref(a.name, servedRing(a.rings), a.arch)", "esc(archesOf(a))", "a.only_reason ? ' only' : ''", "withdrawBtn(a, standing)", 'may("withdraw") && standing', '"nothing standing to withdraw"', "data-withdraw", '"/tasks/" + wid + "/withdraw"'],
      reads: [{ path: `/api/v1/users/${F.m2}`, fields: ["role", "approvals.0.task_id", "approvals.0.name", "approvals.0.arch", "approvals.0.arches", "approvals.0.only_reason", "approvals.0.version", "approvals.0.decision", "approvals.0.standing", "approvals.0.note", "approvals.0.created_at", "approvals.0.withdrawn_at", "approvals.0.rings", "approved_packages.0"] }],
      // The fixture's one approval was taken back by the build page's manifest, which walks before this one: nothing stands to withdraw.
      acts: [{ method: "POST", path: `/api/v1/factory/tasks/${F.projectTask}/withdraw`, body: { note: "the source is not the upstream's" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 404 } }],
      visible: EVERYONE,
    },
    {
      id: "user.not-found-state",
      page,
      anchor: ['id="line"'],
      script: ["d.__status !== 200", 'd.error || "not found"', '"could not load: "'],
      reads: [{ path: "/api/v1/users/nobody", status: 404, fields: ["error"] }],
      visible: EVERYONE,
    },
  ];
};
