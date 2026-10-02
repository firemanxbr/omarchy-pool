/**
 * A contributor's or maintainer's public page: who they are on GitHub,
 * what they registered and built, what they approved, the workers they run.
 * Their own page is also their workspace — "Sign in with GitHub" lands here:
 * Build and remove on the packages, register and revoke on the workers, the
 * evidence of every build, the staging quota, a token for scripts. Everything
 * is the public API (`/api/v1/factory/*`) with the browser session.
 *
 * The page is the same for every role: Share and Token, the way to request
 * and to register, Build, Remove and Renew on a package, Revoke and the
 * mode on a worker, Withdraw on an approval, the evidence of every build —
 * drawn for everyone. What this viewer may not do is the same control grey
 * with the reason in its title (the shell's gate()), never hidden and never
 * a sentence in its place; the reason is the server's own word
 * (GET /users/<login>/can, no-store: the profile is cached for everyone,
 * the rights are the caller's), so a grey button is one the door would
 * refuse in the same words. A maintainer keeps what is theirs on anyone's
 * page — revoke, own only, remove, withdraw.
 */
import { page, servedGrey, workerPanels } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";
import { POOL_HOSTS } from "../routes/contributors";
import { OWNER_NOT_MAINTAINER } from "../hosts";
import { SELF_CAUSE } from "../routes/passkeys";

/**
 * The controls served grey for everyone, whose they are in their title —
 * the shell's servedGrey, what gate() writes — and drawn again through
 * gate() once the server said what this viewer may do: live for the owner,
 * the sign-in for nobody. One template each, in the HTML and in the script.
 * Share and the register toggle are served live: the page is public and
 * its link is anyone's, and the toggle only shows the form, whose fields
 * are the gated ones.
 */
const SHARE_BTN = `<button type="button" class="btn" id="share-open" title="the link to this page, to post anywhere">Share</button>`;
const TOKEN_BTN = `<button type="button" class="btn ghost" id="token-open" title="a token for scripts and CI">Token</button>`;
const REQUEST_LINK = `<a class="more-link" id="pk-request" href="/factory#request">+ request one →</a>`;
const REGISTER_TOGGLE = `<button type="button" class="more-link" id="w-toggle" title="the form: a name, an architecture, one command to run it">+ register one</button>`;
const WORKER_FORM = `<label>Name <input type="text" id="w-name" placeholder="laptop" required></label> <label>Architecture <select id="w-arch"><option>x86_64</option><option>aarch64</option></select></label> <button type="submit" id="w-btn">Register worker</button>`;
/**
 * The workers are the maintainers' (#331, design v2 §6.5): the project
 * provides them for everyone and its maintainers are their only providers.
 * The one exception to the page's rule that every control is drawn for
 * every viewer: "Run a worker" and the worker form are not served, and the
 * script draws them for a maintainer on their own page only (the shell's
 * isMaintainer() and isOwner(), from /auth/me); everyone else reads that
 * their packages build on the pool's hosts, with the way to the packaging
 * docs — except on a maintainer's page, whose section lists the hosts they
 * provide, where the line is hidden. POST /factory/workers refuses a
 * contributor with the same sentence (POOL_HOSTS).
 */
const poolHostsLine = () => `<p class="sub" id="w-pool" style="margin:0 0 10px;font-size:12.5px">Nothing to run here: ${POOL_HOSTS}, which the maintainers provide. Request a package and the pool builds it. <a href="/docs/factory#contribute-a-package">How packaging works →</a></p>`;
const WORKER_OWN = `<p class="sub" style="margin:0 0 10px;font-size:12.5px">Maintainers only: the project's compute is its maintainers' hosts. Register one and run the signed image with the token it gives you, shown once; a new registration is listed as a community set until two maintainers trust it for the project. <a href="/docs/workers">Run a worker →</a></p><form id="worker-form" class="form" onsubmit="return false" hidden></form><div id="w-new" hidden><p class="sub">Your worker token, shown once. One command wherever the worker lives (docker or podman):</p><pre id="w-cmd"></pre></div>`;
/**
 * Add a host (#321, design v2 §6.1): a maintainer's, on their own page — a
 * name and where it runs; the answer is one command to paste on the machine,
 * with a one-time token in the environment of `sh`. The machine enrolls and
 * the host waits here, with its fingerprint, for its owner's Confirm.
 */
const HOST_TOGGLE = `<button type="button" class="more-link" id="h-toggle" title="a name, where it runs, then one command to paste on the machine">+ add a host</button>`;
const HOST_FORM = `<label>Name <input type="text" id="h-name" placeholder="vps-1" pattern="[a-z0-9](?:[a-z0-9\\-]{0,30}[a-z0-9])?" title="lowercase letters, digits and dashes, 1 to 32, not ending in a dash" required></label> <label>Where <input type="text" id="h-where" maxlength="80" placeholder="a VPS in Falkenstein" autocomplete="off"></label> <button type="submit" id="h-btn">Add a host</button>`;
const HOST_OWN = `<p class="sub" style="margin:0 0 10px;font-size:12.5px">Maintainers only: a host runs the signed host bundle and one isolated container per task, as many as its capacity allows. Paste the command on the machine, as the user the agent runs as; it prints the host key's fingerprint, and this page shows it with <b>Confirm</b>. Nothing claims before that. <a href="/docs/worker-host#maintainer-hosts">How a host joins →</a></p><form id="host-form" class="form" onsubmit="return false" hidden></form><div id="h-new" hidden><p class="sub" style="font-size:12.5px">One command, on the machine, within 15 minutes; the token works once, and no process's arguments (<code>ps</code>) show it:</p><pre><span class="copy" data-copy="host">copy</span><span id="h-cmd"></span></pre></div>`;
/** Add a passkey (#257): a name for it and the button that starts the browser's request — a maintainer's. */
const PASSKEY_FORM = `<label>Name <input type="text" id="pk-label" maxlength="40" placeholder="this laptop" autocomplete="off"></label> <button type="submit" id="pk-add">Add a passkey</button>`;
/** …and what stands in its place for someone who is not a maintainer but still holds a passkey (a maintainer once): the reason, visible, and their Remove below. */
const PASSKEY_NOT_A_MAINTAINER = `<p class="sub" id="pk-not" style="margin:0">Passkeys are for maintainers: they confirm approve and block. You can remove the ones you hold below.</p>`;

/**
 * The page's own rules (#257): the passkeys' status line is always in the
 * page — empty, it takes no room — so a screen reader hears each thing it
 * says, and a failure is marked as one (the kit's red, as a refusal is); the
 * action column is named for a screen reader; on a phone the algorithm
 * column goes, so Remove stays on the screen; a heading a link landed on
 * shows its focus square, as the kit's controls do.
 */
const CSS = String.raw`
  .u-sr { position: absolute; width: 1px; height: 1px; margin: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  #passkeys > p#pk-said:empty { margin: 0; }
  #passkeys > p#pk-said.err { color: var(--text); border: 1px solid var(--red); padding: 10px 12px; font-size: 13.5px; }
  #passkeys h2:focus-visible, #agents h2:focus-visible { outline: 1px solid var(--green); outline-offset: 2px; }
  #pk-reset > p#pk-reset-said:empty { margin: 0; }
  #pk-reset > p#pk-reset-said.err { color: var(--text); border: 1px solid var(--red); padding: 10px 12px; font-size: 13.5px; }
  #pk-reset .form button.danger, #pk-reset .form button.danger:hover { border-color: var(--red); color: var(--red); }
  @media (max-width: 520px) { #pk-table th:nth-child(2), #pk-table td:nth-child(2) { display: none; } }
  /* On a phone the hosts table keeps Host, Status, Units and Confirm in view: the arches are in the Host cell's detail, the release and the report on the host page. */
  @media (max-width: 520px) { #hosts-table th:nth-child(3), #hosts-table td:nth-child(3), #hosts-table th:nth-child(5), #hosts-table td:nth-child(5), #hosts-table th:nth-child(6), #hosts-table td:nth-child(6) { display: none; } }
  #h-new pre { position: relative; padding-right: 76px; white-space: pre-wrap; overflow-wrap: anywhere; }
  #hosts-table .h-detail { overflow-wrap: anywhere; min-width: 16ch; }
  #h-stop { margin-top: 10px; display: grid; gap: 8px; justify-items: start; }
  #h-stop .small-btn.danger { border-color: var(--red); color: var(--red); }
`;

const body = (login: string) => String.raw`
  <div id="pk-notice" hidden></div>
  <div class="profile-head">
    <span class="avatar lg" id="avatar">…</span>
    <div><p class="crumbs"><a href="/factory">Factory</a> / <span id="crumb"></span></p><h1 id="title">…</h1><p class="line" id="line"></p></div>
    <span id="share-btn">${SHARE_BTN} ${servedGrey(TOKEN_BTN, `only ${login} mints their token`)}</span>
  </div>
  <div class="tiles" id="tiles"></div>
  <div class="two" style="margin-bottom:44px">
    <div class="panel"><h3>Activity <span class="dim" style="font-size:12px;font-weight:400">16 weeks · builds, decisions, packages</span></h3><div class="activity" id="activity"></div><p class="sub" id="activity-note" style="margin:8px 0 0;font-size:12.5px"></p></div>
    <div class="panel"><h3>Track record <a href="/docs/governance">the formula →</a></h3><div class="score"><b id="score">…</b><div class="f" id="score-f"></div></div></div>
  </div>

  <section id="record-section" hidden>
    <h2>Track record</h2>
    <p class="sub">From the record the pool keeps anyway — what this person brought that a maintainer let in, what they built, what they decided. One number, with a formula anyone can check (<a href="/docs/governance">Governance</a>): it says where the work was done, not who someone is.</p>
    <div class="table-wrap"><table id="record"><thead><tr><th>Contributed</th><th>Maintained</th><th>Score</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Packages</h2>${servedGrey(REQUEST_LINK, `only ${login} requests here`)}</div>
    <p class="sub">Registered by this contributor: the name is theirs, the pool builds it as evidence, the project builds it again, <b>another</b> maintainer decides — a maintainer who brings a package is its contributor. Open a row: the request as the form checks it, then each architecture on its own — its build, the gate, the audit, the score, whether it is ready for a maintainer.</p>
    <div class="table-wrap"><table id="packages" class="pk"><thead><tr><th></th><th>Package</th><th>Category</th><th>Project</th><th>Arches</th><th>Stage</th><th>Where it stands</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Builds</h2><span class="dim" id="quota" style="font-size:12px"></span></div>
    <p class="sub">On the pool's hosts — evidence for a maintainer, never what users get directly. The number opens the build, whole; its evidence — the log, the PKGBUILD — is read on that page, which says so when a build left none.</p>
    <div class="table-wrap"><table id="builds"><thead><tr><th>#</th><th>Package</th><th>Arch</th><th>Status</th><th>Why</th><th>Worker</th><th>Took</th><th>When</th><th>Evidence</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Workers</h2><span id="w-slot"></span></div>
    <p class="sub">The machines under this name, as the <a href="/workers">Workers</a> page shows them — the review ones and the pool's, when this person keeps them, and a legacy community one.</p>
    <div id="w-own">${poolHostsLine()}</div>
    ${workerPanels([
      { kind: "community", blurb: "legacy community sets, until they retire: their owner's packages, or whatever is queued when shared", hidden: true },
      { kind: "review", blurb: "the maintainers' side: builds again, publishes, audits", hidden: true },
      { kind: "project", blurb: "the pool's own jobs, on the host this maintainer keeps", hidden: true },
    ])}
    <p class="sub" id="w-none" hidden style="margin:0">No worker registered under this name.</p>
  </section>

  <section id="hosts" hidden>
    <div class="h2row"><h2>Hosts</h2><span id="h-slot"></span></div>
    <p class="sub">The machines this maintainer provides: each enrolled by its owner, confirmed by fingerprint, and trusted by the same pull request that named them a maintainer.</p>
    <div id="h-own"></div>
    <div class="table-wrap"><table id="hosts-table"><thead><tr><th>Host</th><th>Status</th><th>Arches</th><th>Units</th><th>Release</th><th>Reported</th><th aria-label="Confirm"></th></tr></thead><tbody></tbody></table></div>
    <p class="sub" id="h-none" hidden style="margin:0">No host under this name.</p>
    <div id="h-notices" hidden style="margin-top:10px"></div>
    <div id="h-stop" hidden></div>
  </section>

  <section id="agents" hidden>
    <div class="h2row"><h2>Agents</h2><a class="more-link" href="/agents#login">+ grant one →</a></div>
    <p class="sub">The agents you let act as you through omarchy-cli's tools (<code>omarchy-cli login</code>), and the decisions they drafted for you. Only you see this section: nothing an agent drafts is decided, or on the record, until you confirm it in the browser. <a href="/docs/omarchy-cli-mcp#write-tools">How it works →</a></p>
    <div class="table-wrap"><table id="grants"><thead><tr><th>Agent</th><th>Scopes</th><th>Granted</th><th>Expires</th><th>Last used</th><th>State</th></tr></thead><tbody></tbody></table></div>
    <div class="table-wrap"><table id="drafts"><thead><tr><th>Drafted</th><th>Package</th><th>Verdict</th><th>Agent</th><th>State</th><th>Note</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section id="passkeys" hidden>
    <div class="h2row"><h2>Passkeys</h2></div>
    <p class="sub">Approve and block are confirmed with a passkey: on Review, on a package's page, and what your agents draft. Your device asks for your fingerprint, face or PIN, which no token and no agent can supply. Your first passkey is added with your session. Adding another, or removing one, asks for a passkey you hold. Lost your only one? Another maintainer resets them, and your token and your agents' grants go with them. The pool keeps each one's public key and credential id, nothing else, and the journal says when one is added, removed or reset. Only you see this section. <a href="/docs/omarchy-cli-mcp#write-tools">How it works →</a></p>
    <form id="pk-form" class="form" onsubmit="return false"></form>
    <p class="sub" id="pk-said" role="status" aria-live="polite"></p>
    <div class="table-wrap"><table id="pk-table"><thead><tr><th>Name</th><th>Algorithm</th><th>Added</th><th>Last used</th><th><span class="u-sr">Remove</span></th></tr></thead><tbody></tbody></table></div>
  </section>

  <section id="pk-reset" hidden>
    <div class="h2row"><h2>A lost passkey</h2></div>
    <p class="sub">A maintainer who lost their only passkey gets a way back from another maintainer. Every passkey of theirs goes, with their token and their agents' grants, and they are signed out. They add a new passkey and make a new token after signing in with GitHub again. Your own passkey confirms the reset, and the reason goes on the public journal and on a record the pool signs.</p>
    <form id="pk-reset-form" class="form" onsubmit="return false"><label>Why <input type="text" id="pk-reset-why" minlength="4" maxlength="300" placeholder="lost their phone and their key" autocomplete="off" required></label> <button type="submit" id="pk-reset-go" class="danger">Reset the passkeys</button></form>
    <p class="sub" id="pk-reset-said" role="status" aria-live="polite"></p>
  </section>

  <section id="approvals-section" hidden>
    <h2>Approvals</h2>
    <p class="sub">Decisions this maintainer signed: what they let into the pool — and where it stands today, ring by ring — what they sent back, what they took back. A standing approval is taken back from here by a maintainer: the package leaves every ring, another maintainer decides.</p>
    <div class="table-wrap"><table id="approvals"><thead><tr><th>When</th><th>Package</th><th>Arch</th><th>Decision</th><th>Where it stands</th><th>Note</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  var login = decodeURIComponent(location.pathname.split("/")[2] || "");
  $("#crumb").textContent = login;
  skeletonTiles("#tiles", 4); skeletonRows("#packages", 7, 2); skeletonRows("#builds", 9, 3);
  var API = "/api/v1/factory";
  // ---- what this viewer may do here, from the server: GET /users/<login>/can (no-store — the profile is cached for everyone, the rights are the caller's) says for each control whether it is live and, where not, why, in the words the door would refuse with. Every control below is drawn for everyone and reads CAN; nobody's answer — nothing, the sign-in as the reason — until it lands.
  var CAN = { why: {}, packages: {}, workers: {} };
  function may(right) { return CAN[right] === true; }
  function reason(right) { return CAN.why[right] || "sign in with GitHub"; }
  // Remove is answered per registration (an approved one is a maintainer's to remove, one in a ring nobody's): the row's answer where the server gave one, the page's otherwise.
  function removeOf(name) { var p = CAN.packages[name]; return p ? { ok: p.remove === true, why: p.why || "" } : { ok: may("remove"), why: reason("remove") }; }
  // Revoke and the mode are answered per worker (a revoked one is gone, a project's has no mode: the state's word first, the door's own): the row's answer where the server gave one, the role's otherwise.
  function workerCan(w, right) { var x = CAN.workers[w.id]; return x ? { ok: x[right] === true, why: (x.why && x.why[right]) || "" } : { ok: may(right), why: reason(right) }; }
  var SHARE_BTN = ${JSON.stringify(SHARE_BTN)}, TOKEN_BTN = ${JSON.stringify(TOKEN_BTN)}, REQUEST_LINK = ${JSON.stringify(REQUEST_LINK)}, WORKER_FORM = ${JSON.stringify(WORKER_FORM)}, REGISTER_TOGGLE = ${JSON.stringify(REGISTER_TOGGLE)}, WORKER_OWN = ${JSON.stringify(WORKER_OWN)};
  var HOST_TOGGLE = ${JSON.stringify(HOST_TOGGLE)}, HOST_FORM = ${JSON.stringify(HOST_FORM)}, HOST_OWN = ${JSON.stringify(HOST_OWN)};
  var DRAWN = false, WORKER_DRAWN = false, HOST_DRAWN = false, HOSTS = null, WAIT_UNTIL = 0, HOST_T = 0;
  function loadCan() {
    return api("GET", "/api/v1/users/" + encodeURIComponent(login) + "/can").then(function (d) {
      if (d.__status !== 200 || !d.can) return;
      // The controls outside the tables are drawn again only when their gate changed: what the owner typed in the register form stays through a refresh.
      var was = topState(); CAN = d.can;
      if (DRAWN && topState() !== was) { renderTop(); renderRegister(); }
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
  var OPEN = {}, LATEST = {}, FACTORY = null, STORIES = {};
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
  // The way to request a package, for everyone, the owner's to press: served grey with whose it is, drawn again from the server's word. The way in for a worker — "Run a worker", the toggle and the form behind it — is a maintainer's (#331): drawn for a maintainer on their own page only, the form's fields grey with why where the server says no (blocked); everyone else keeps the served line, their packages build on the pool's hosts.
  function renderRegister() {
    $("#pk-request").outerHTML = gate(REQUEST_LINK, may("request"), reason("request"));
    if (!isMaintainer() || !isOwner(login)) return;
    if (!WORKER_DRAWN) {
      WORKER_DRAWN = true;
      $("#w-own").innerHTML = WORKER_OWN; $("#w-slot").innerHTML = REGISTER_TOGGLE;
      $("#w-toggle").onclick = function () { $("#worker-form").hidden = !$("#worker-form").hidden; };
    }
    $("#worker-form").innerHTML = gate(WORKER_FORM, may("register"), reason("register"));
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
      var detail = h.fingerprint ? '<div class="muted h-detail" style="font-size:12px">' + esc((h.hostname || "") + (h.where ? " · " + h.where : "")) + (h.capacity ? " · " + esc(hostCaps(h)) : "") + '<br><span class="mono">' + esc(h.fingerprint) + '</span>' + (h.below_minimum ? '<br>' + esc(h.below_minimum) : '') + '</div>' : '';
      // Who stopped it and why, readable on a phone too (the pill's title is a hover).
      if ((h.status === "suspended" || h.status === "retired") && h.status_by) detail += '<div class="muted" style="font-size:12px">' + esc(h.status + " by " + h.status_by + (h.status_reason ? ": " + h.status_reason : "")) + '</div>';
      return '<tr><td><a href="/hosts/' + esc(h.id) + '">' + esc(h.name) + '</a>' + detail + '</td><td>' + pillHtml(p[0], p[1], h.status_reason ? h.status + " by " + (h.status_by || "?") + ": " + h.status_reason : "") + (h.claims_stopped_at && h.status !== "retired" ? " " + pillHtml("error", "claims stopped", NOT_LISTED) : "") + '</td><td>' + esc((h.arches || []).join(", ")) + '</td><td>' + (h.units === undefined || h.units === null ? '<span class="muted">—</span>' : num(h.units)) + '</td><td>' + esc(h.release_applied || "—") + '</td><td>' + (h.alive ? "yes" : '<span class="muted">no</span>') + '</td><td>' + confirm + '</td></tr>';
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
    ask({ title: "Confirm " + b.getAttribute("data-name"), text: "Compare the fingerprint with the one the machine printed. They must be the same: then this host gets its worker registration and claims from its next round." + (h && h.fingerprint ? '<br><code>' + esc(h.fingerprint) + '</code>' : ''), confirm: "Confirm" }).then(function (go) {
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
  // A worker's buttons, on every row for whoever looks — a revoked worker's and a project's too, grey with the state's word: the mode is the brain's to set — shared (everyone's queue) or its owner's packages only — from the worker's next claim, nothing restarts; and Revoke stops its token. Own only and Revoke are the owner's or a maintainer's, sharing the owner's word alone: the server says which, and why not, per row.
  function workerActs(w) {
    var toShared = w.mode !== "shared", mode = workerCan(w, toShared ? "share_worker" : "own_only"), revoke = workerCan(w, "revoke");
    return gate('<button type="button" class="small-btn" data-mode="' + esc(w.id) + '" data-to="' + (toShared ? "shared" : "dedicated") + '" title="' + (toShared ? "build everyone\'s queue too, from its next claim" : "build its owner\'s packages only, from its next claim") + '">' + (toShared ? "Share" : "Own only") + '</button>', mode.ok, mode.why)
      + ' ' + gate('<button type="button" class="small-btn" data-revoke="' + esc(w.id) + '" title="revoke this worker\'s token">Revoke</button>', revoke.ok, revoke.why);
  }
  function loadWorkers() { return fetch("/api/v1/factory?limit=10" + fresh("&")).then(function (r) { return r.json(); }).then(function (d) { FACTORY = d; renderWorkers(); }).catch(function () {}); }
  // A package's story (routes/story.ts), in its open row: the request as the form checks it today, then one panel per architecture — each is built on a worker of its own and can be ready while the other failed — with its latest chain, the two halves of the score with their evidence, and the one line that says whose turn it is.
  function story(name) {
    var el = storyEl(name); if (!el) return;
    if (STORIES[name]) el.innerHTML = storyHtml(name, STORIES[name]); // what was drawn stays while the fresh one loads: no flicker on the refresh
    fetch("/api/v1/factory/packages/" + encodeURIComponent(name) + "/story" + fresh("?")).then(function (r) { return r.ok ? r.json() : null; }).then(function (st) {
      if (!st) { if (!STORIES[name]) el.innerHTML = '<div class="muted">no story yet</div>'; return; }
      STORIES[name] = st;
      el.innerHTML = storyHtml(name, st);
    }).catch(function () { if (!STORIES[name]) el.innerHTML = '<div class="muted">could not load the story</div>'; });
  }
  // The open row's story element, by the package's name (pacman names carry @ . _ + -; an id made of them would collide).
  function storyEl(name) { var els = document.querySelectorAll(".pkstory[data-story]"); for (var i = 0; i < els.length; i++) if (els[i].getAttribute("data-story") === name) return els[i]; return null; }
  // Build, on every story for whoever looks: grey by state first — a build in flight, the package blocked, the same for all — and by role otherwise (the owner builds, nobody else: the server's word); the title says which. arch null is Build all.
  function buildBtn(name, arch, stopped, title) {
    var btn = '<button type="button"' + (arch ? ' class="small-btn"' : '') + ' data-build="' + esc(name) + '"' + (arch ? ' data-arch="' + esc(arch) + '"' : '') + ' title="' + esc(title) + '">Build ' + (arch ? esc(arch) : "all") + '</button>';
    return gate(btn, !stopped && may("build"), stopped || reason("build"));
  }
  function removeBtn(name) { var r = removeOf(name); return gate('<button type="button" class="ghost" data-remove="' + esc(name) + '" title="remove the registration">Remove</button>', r.ok, r.why); }
  // Withdraw, on every approval row for whoever looks: live for a maintainer where the approval stands (standing: approved, not withdrawn — the row's own fact), grey with why not otherwise — nothing standing on the row for a maintainer, the role's reason (the server's word) for anyone else.
  function withdrawBtn(a, standing) { return gate('<button type="button" class="small-btn" data-withdraw="' + a.task_id + '" data-name="' + esc(a.name + " " + (a.version || "")) + '" title="take the approval back: the package leaves every ring, another maintainer decides — the reason goes on the record">Withdraw</button>', may("withdraw") && standing, may("withdraw") ? "nothing standing to withdraw" : reason("withdraw")); }
  // A blocked package builds for nobody: the door's words (POST /factory/packages/:name/build).
  function blockedWhy(name, pkg) { return name + " is blocked by a maintainer" + (pkg.blocked_reason ? ": " + pkg.blocked_reason : ""); }
  function storyHtml(name, st) {
      var pkg = st.package || {}, registered = (pkg.arches && pkg.arches.length ? pkg.arches : (st.request && st.request.arches) || []).slice(), arches = registered.slice();
      var archOf = function (c) { return (c.contributor || c.project || {}).arch; };
      st.chains.forEach(function (c) { var a = archOf(c); if (a && arches.indexOf(a) < 0) arches.push(a); }); // an architecture the request dropped keeps its story, without a Build
      var inFlight = function (c) { return c && ((c.contributor && (c.contributor.status === "queued" || c.contributor.status === "leased")) || (c.project && (c.project.status === "queued" || c.project.status === "leased"))); };
      var anyBusy = st.chains.some(inFlight);
      // A renewal is taken while the package is registered, staged, rejected or unmaintained and nothing of it is being built — the story says (request.renewable, request.busy).
      var renewable = !!(st.request && st.request.renewable);
      var whyNot = st.request && st.request.busy ? "renew it once build #" + st.request.busy + " is done" : pkg.status === "approved" || pkg.status === "published" ? "in the pool as it was; new releases come as bumps, built from the approved recipe" : "renew it once nothing of it is being built";
      var head = '<div class="pknext">' + (pkg.blocked_at ? pillHtml("error", "blocked") + ' ' + ago(pkg.blocked_at) + ' by ' + personLink(pkg.blocked_by) + ': ' + esc(pkg.blocked_reason || '') + ' — another maintainer lifts it.' : summary(st, arches))
        + '<span class="acts-inline">' + buildBtn(name, null, anyBusy ? "a build is in flight" : pkg.blocked_at ? blockedWhy(name, pkg) : null, "every architecture the request names") + ' ' + removeBtn(name) + '</span></div>';
      var panels = arches.map(function (a) {
        var mine = st.chains.filter(function (c) { return archOf(c) === a; });
        var running = mine[0] && ((mine[0].contributor && mine[0].contributor.status === "leased") || (mine[0].project && (mine[0].project.status === "queued" || mine[0].project.status === "leased")));
        var queued = mine[0] && mine[0].contributor && mine[0].contributor.status === "queued";
        var acts = registered.indexOf(a) >= 0 ? buildBtn(name, a, running ? "a build is running" : pkg.blocked_at ? blockedWhy(name, pkg) : null, queued ? "name a worker, or take it out of the queue" : "this architecture only") : '';
        return archPanel(a, mine, nextStep(st, mine[0]), acts);
      }).join("");
      // The package's page on the most stable ring that serves it and that ring's architecture — the shell's servedRing over the story's rows, the shell's one address; a package in no ring yet opens on the shell's default.
      var served = servedRing(st.rings);
      return head + requestBlock(st.request, may("request"), name, renewable, whyNot, reason("request")) + panels
        + '<p class="sub" style="margin:4px 0 0"><a href="' + pkgHref(name, served && served.ring, served && served.arch) + '">The package\'s page →</a>' + (st.rings && st.rings.length ? ' · in <b>' + esc(st.rings.map(function (r) { return r.ring + " (" + r.arch + ")"; }).join(", ")) + '</b>' : '') + '</p>';
  }
  // The package in one line: what each architecture waits for, and the request when it is not what the form asks today.
  function summary(st, arches) {
    var parts = arches.map(function (a) {
      var c = st.chains.filter(function (x) { return (x.contributor || x.project || {}).arch === a; })[0], s2 = chainState(c);
      return '<b class="mono">' + esc(a) + '</b> ' + pillHtml(s2.cls, s2.text);
    });
    var req = st.request && !st.request.complete ? ' <span class="dim">·</span> ' + pillHtml("warn", "request incomplete", "the form would not take it today — a maintainer's time is not asked yet") + (st.request.renewable ? ' <span class="dim">' + (isOwner(login) ? "renew it below" : "renewed below by " + esc(login)) + '</span>' : '') : '';
    return parts.join(' <span class="dim">·</span> ') + req;
  }
  // What comes next for one architecture, from its latest chain: whose turn it is, what for — and, when it is the reader's own package, how: the evidence to read, the button to press, where the build can run, what to write for the agent.
  function nextStep(st, c) {
    var own = isOwner(login), pkg = st.package || {}, rings = (st.rings || []).filter(function (r) { return !c || r.arch === (c.contributor || c.project || {}).arch; }).map(function (r) { return r.ring; });
    var incomplete = st.request && !st.request.complete;
    var steps = function (items) { return '<ol class="howto">' + items.map(function (x) { return '<li>' + x + '</li>'; }).join("") + '</ol>'; };
    var drafted = function (t) { return !t || !t.pkgbuild_ref || t.pkgbuild_ref.indexOf("draft:") === 0; };
    if (!c) return 'No build yet — ' + (own ? 'press <b>Build</b>: it goes to the shared queue (the best idle shared worker takes it; a native worker of yours at once), the gate checks it, the second agent audits it.' : 'the contributor\'s build comes first.');
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
        'Choose <b>where</b> in the same dialog' + (emulated ? ': this one ran <b>emulated</b> (' + esc(arch) + ' under qemu on ' + esc(wtShort(worker.id)) + ') — a native worker may be all it needs' : '') + (where && where.native ? ' — ' + where.native + ' native ' + esc(arch) + ' worker(s) online' : where && where.count ? ' — ' + where.count + ' worker(s) can take it' : ' — the project\'s shared workers take it') + '.',
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
      if (cc.shared_after && cc.shared_after > new Date().toISOString()) return 'Queued (<a href="/build/' + cc.id + '">#' + cc.id + '</a>) for ' + (own ? 'your' : 'the owner\'s') + ' own worker — a new release, built from the approved recipe; the shared workers take it from ' + esc(cc.shared_after.slice(0, 10)) + '.' + (own ? ' Press <b>Build ' + esc(arch) + '</b> to name a worker or to take it out.' : '');
      var q = cc.queue ? '<b>' + cc.queue.position + ' of ' + cc.queue.total + '</b> in the shared queue for ' + esc(arch) : 'in the shared queue for ' + esc(arch);
      // Sent back by an emulated worker a toolchain could not start on: only a native one takes it, the owner's own included — an emulated one of theirs is not "at once".
      if (cc.params && cc.params.needs_native) return 'Queued (<a href="/build/' + cc.id + '">#' + cc.id + '</a>) — ' + q + ': a toolchain or a library could not start <b>emulated</b>, so a <b>native</b> ' + esc(arch) + ' worker takes it' + (where ? ' — ' + esc(where.state) : '') + (own ? '. Press <b>Build ' + esc(arch) + '</b> to name a worker or to take it out of the queue.' : '.') + ' This page follows it.';
      return 'Queued (<a href="/build/' + cc.id + '">#' + cc.id + '</a>) — ' + q + ': the best idle shared worker takes it' + (where ? ' — ' + esc(where.state) : '') + (own ? '; a native worker of yours takes it at once. Press <b>Build ' + esc(arch) + '</b> to name a worker or to take it out of the queue.' : '.') + ' This page follows it.';
    }
    if (cc && cc.status === "leased") return 'Building (<a href="/build/' + cc.id + '">#' + cc.id + '</a>) on ' + (cc.lease_owner ? wtId(cc.lease_owner) : 'a worker') + (emulated ? ' — emulated' : '') + ' — this page follows it.';
    if (cc && cc.status === "failed") return 'The build failed (<a href="/build/' + cc.id + '">#' + cc.id + '</a>)' + (cc.error ? ' — <b>' + esc(String(cc.error).slice(0, 160)) + '</b>' : '') + (own ? again(cc.attempts > 1 ? 'the agent tried ' + cc.attempts + ' times inside this build' : '') : ' — the contributor fixes it.');
    if (cc && cc.status === "cancelled") return 'Superseded (<a href="/build/' + cc.id + '">#' + cc.id + '</a>)' + (cc.error ? ' — ' + esc(String(cc.error).slice(0, 140)) : '') + '.';
    if (cc && cc.status === "staged") {
      if (sc.ready) return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> passed the gate' + (c.audit && c.audit.status === "done" ? ', audited' : '') + ' — ' + (own ? 'nothing on your side: <b>another</b> maintainer (you brought it)' : 'a maintainer who did not bring it') + ' has the project build it again. Class ' + esc(sc.class) + ' → ' + esc(sc.projected) + '.';
      var vet = cc.result && cc.result.vet, audit = c.audit;
      if (incomplete) return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> is staged, but the request is not what the form asks today — ' + (own ? '<b>Renew the request</b> above: the same form, filled from the record; the build stays and is ready the moment the record is — of this version.' : 'the contributor renews the request; the build stays.');
      if (vet && vet.verdict !== "pass") return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> built, but <b>the gate failed</b>: ' + esc((vet.failed || []).join(", ")) + (own ? again('each failed check is named there and explained in <a href="/docs/what-we-test">What we test</a>') : ' — the contributor fixes the recipe and builds again.');
      if (audit && audit.status === "done" && audit.result && audit.result.verdict === "block") return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> passed the gate, but <b>the audit blocked it</b>: ' + esc(audit.result.summary || '') + (own ? again('the ' + art(cc, "audit.md", "report") + ' lists the findings and the fix for each') : ' — the contributor answers the findings and builds again.');
      if (audit && audit.status !== "done") return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> passed the gate; the audit is ' + esc(audit.status) + ' on the project\'s review worker — nothing to do until it answers.';
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
    setTiles("#tiles", [
      ["Packages", num(d.packages.length), "registered under this name"],
      ["Builds", num(c.total), num(c.staged) + " staged · " + num(c.published) + " published · " + num(c.failed) + " failed"],
      // Every decision on the record under this name — approvals standing or withdrawn, rejections — as the Pipeline's "decisions per maintainer" counts them; how many stand is the subtitle's.
      ["Decisions", num(d.approvals.length), d.role === "maintainer" ? num(d.approved_packages.length) + " package(s) let into the pool" : "not a maintainer"],
      ["Workers", num(wc.registered), num(wc.alive) + " alive now"]
    ]);
    // Sixteen weeks of what the record holds under this name: builds, decisions, packages touched.
    var weeks = []; for (var i = 15; i >= 0; i--) weeks.push(Date.now() - i * 7 * 86400000);
    var counts = weeks.map(function () { return 0; }), total = 0;
    var mark = function (iso) { var t = Date.parse(iso); if (!t) return; for (var i = weeks.length - 1; i >= 0; i--) { if (t >= weeks[i]) { counts[i]++; total++; break; } } };
    d.builds.forEach(function (b) { mark(b.created_at); }); d.approvals.forEach(function (a) { mark(a.created_at); }); d.packages.forEach(function (p) { mark(p.updated_at); });
    var mx = Math.max.apply(null, counts) || 1;
    $("#activity").innerHTML = counts.map(function (v, i) { return '<i style="height:' + Math.max(4, 100 * v / mx) + '%" data-tip="' + new Date(weeks[i]).toISOString().slice(0, 10) + ' · ' + v + (v === 1 ? " contribution" : " contributions") + '"></i>'; }).join("");
    $("#activity-note").textContent = total ? num(total) + " in the last 16 weeks — every one is a row below" : "nothing on the record in the last 16 weeks yet";
    var rec = d.record || { contributed: {}, maintained: {}, score: 0 }, has = Object.keys(rec.contributed).some(function (k) { return rec.contributed[k]; }) || Object.keys(rec.maintained).some(function (k) { return rec.maintained[k]; });
    $("#score").textContent = num(rec.score || 0);
    $("#score-f").innerHTML = "from what the pool recorded: what you brought that a maintainer let in, what you built, what you decided — it says where the work was done, not who someone is";
    if (has) {
      $("#record-section").hidden = false;
      pager("#record", [rec], function (r) {
        var c = r.contributed, m = r.maintained;
        var contributed = [c.approved ? num(c.approved) + " let in" : "", c.staged ? num(c.staged) + " staged" : "", c.bumps ? num(c.bumps) + " bump" + (c.bumps === 1 ? "" : "s") : "", c.donated ? num(c.donated) + " for others" : "", c.rejected ? num(c.rejected) + " rejected" : ""].filter(Boolean).join(" · ") || "—";
        var maintained = [m.approvals ? num(m.approvals) + " approval" + (m.approvals === 1 ? "" : "s") : "", m.rejections ? num(m.rejections) + " rejection" + (m.rejections === 1 ? "" : "s") : "", m.rebuilds_failed ? num(m.rebuilds_failed) + " rebuild" + (m.rebuilds_failed === 1 ? "" : "s") + " failed" : ""].filter(Boolean).join(" · ") || "—";
        return '<tr><td>' + contributed + '</td><td>' + maintained + '</td><td class="num">' + num(r.score) + '</td></tr>';
      });
    }
    // ---- packages: one row each, where each of its architectures stands — the server's targets (targetChips), else the stage from the latest builds per architecture — a row that opens into the story and the next step
    var byPkg = {}; d.builds.forEach(function (b) { var k = b.name + "/" + b.arch; if (!byPkg[k]) byPkg[k] = b; });
    LATEST = byPkg;
    pager("#packages", d.packages, function (p) {
      var arches = []; try { arches = JSON.parse(p.arches || "[]"); } catch (e) {}
      var per = targetChips(p.targets) || arches.map(function (a) { var b = byPkg[p.name + "/" + a]; return '<span class="arch-st" title="' + esc(a + ": " + (b ? b.status + (b.status === "leased" ? " (building)" : "") + " · #" + b.id : "no build yet")) + '">' + esc(a) + ' ' + (b ? taskPill(b.status) : pillHtml("none", "—")) + '</span>'; }).join("");
      var open = OPEN[p.name];
      // The name is the package's page (the shell's one address) on the first architecture the request names: a registration says no ring, so the shell's default asks for the most stable, and the server shows the most stable ring that serves it.
      return '<tr class="pkrow" data-pkg="' + esc(p.name) + '"><td><button type="button" class="expand" data-expand="' + esc(p.name) + '" title="' + (open ? "close" : "the story, and what comes next") + '">' + (open ? "▾" : "▸") + '</button></td><td><a href="' + pkgHref(p.name, null, arches[0]) + '"><b>' + esc(p.name) + '</b></a></td><td>' + (p.category ? pillHtml("none", p.category) : '<span class="dim">—</span>') + '</td><td>' + (p.url ? '<a href="' + esc(p.url) + '">' + esc(p.url.replace(/^https?:\/\/(www\.)?(github\.com\/)?/, "")) + '</a>' : '<span class="dim">—</span>') + '</td><td class="arches">' + per + '</td><td>' + taskPill(p.status) + '</td><td class="muted stands" title="' + esc(p.detail || "") + '">' + esc(p.detail || "") + '</td></tr>'
        + (open ? '<tr class="pkopen" data-pkg="' + esc(p.name) + '"><td colspan="7"><div class="pkstory" data-story="' + esc(p.name) + '">' + (STORIES[p.name] ? storyHtml(p.name, STORIES[p.name]) : '<div class="muted">loading the story…</div>') + '</div></td></tr>' : '');
    }, { empty: "no package registered", after: function () { Object.keys(OPEN).forEach(function (n) { if (OPEN[n]) story(n); }); }, text: function (p) { return [p.name, p.category, p.status, p.detail].join(" "); } });
    // ---- builds: the number is the build's page; the package's name its page on the build's architecture and the ring the build is about (ringOfBuild: the lab for a staged one, the shell's default for the rest — the ring Review and the build's page link too); the worker that held it, the bare id whole where the listing has no row (no owner guessed); the evidence, public, for whoever reads
    pager("#builds", d.builds, function (t) {
      return '<tr><td><a href="/build/' + t.id + '" title="the build, whole">' + t.id + '</a></td><td><a href="' + pkgHref(t.name, ringOfBuild(t.status, null), t.arch) + '"><b>' + esc(t.name) + '</b></a>' + (t.version ? ' <span class="mono muted">' + esc(t.version) + '</span>' : '') + '</td><td>' + esc(t.arch) + '</td><td>' + taskPill(t.status) + (t.needs_native ? ' ' + nativePill({ status: t.status, arch: t.arch, params: { needs_native: t.needs_native } }) : '') + (t.queue ? ' <span class="dim" title="in the shared queue for ' + esc(t.arch) + '">' + t.queue.position + ' of ' + t.queue.total + '</span>' : '') + '</td><td>' + esc(t.reason || "") + (t.trust === "project" ? ' ' + pillHtml("ok", "the project", "the project's own build, from a contributor's evidence") : '') + '</td><td>' + (t.lease_owner ? wtId(t.lease_owner) : t.pinned_to && t.status === "queued" ? '<span class="muted" title="asked for this worker only">waiting for ' + esc(wtShort(t.pinned_to)) + '</span>' : '<span class="muted">—</span>') + '</td><td>' + (dur(t.duration_ms) || "—") + '</td><td class="when">' + ago(t.created_at) + '</td><td>' + evidence(t) + '</td></tr>';
    }, { empty: "nothing built yet", text: function (t) { return [t.id, t.name, t.version, t.arch, t.status, t.reason, t.lease_owner].join(" "); } });
    renderReset(d);
    // ---- approvals: last, with the build behind each
    if (d.approvals.length || d.role === "maintainer") {
      $("#approvals-section").hidden = false;
      // A standing approval — the row's own standing, the server's word (approved, not withdrawn) — is a package in the pool: its rings say where, from the lab up, and the name opens the package on the most stable of them. Withdraw is on every row for whoever looks: live for a maintainer where an approval stands (it leaves every ring, another maintainer decides), grey with why not — nothing standing on the row, or the role, the server's word.
      pager("#approvals", d.approvals, function (a) {
        var standing = a.standing;
        var where = standing ? (a.rings && a.rings.length ? a.rings.map(function (r) { return pillHtml(r === "stable" ? "ok" : r === "rc" ? "blue" : r === "edge" ? "lilac" : "warn", r); }).join(" ") : '<span class="muted" title="approved, not served: the publish job did not run, or a later release dropped it">not served</span>') : '<span class="muted">—</span>';
        var act = ' ' + withdrawBtn(a, standing);
        return '<tr><td class="when">' + ago(a.created_at) + '</td><td><a href="' + pkgHref(a.name, servedRing(a.rings), a.arch) + '">' + esc(a.name) + '</a> <span class="mono muted">' + esc(a.version || "") + '</span> <a class="dim" href="/build/' + a.task_id + '">#' + a.task_id + '</a></td><td>' + esc(archesOf(a)) + '</td><td>' + (a.withdrawn_at ? taskPill("withdrawn", "withdrawn " + ago(a.withdrawn_at) + " by " + a.withdrawn_by + ": " + (a.withdrawn_reason || "")) : (a.changes ? taskPill("changes requested", "a rejection that asked for changes: the name stayed the requester's") : taskPill(a.decision))) + '</td><td>' + where + act + '</td><td class="muted">' + esc(a.withdrawn_at ? (a.withdrawn_reason || "") : (a.note || "")) + '</td></tr>';
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
    if (x) { var n = x.getAttribute("data-expand"); OPEN[n] = !OPEN[n]; load(); return; }
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
    var b = ev.target.closest ? ev.target.closest("button[data-build],button[data-remove],button[data-revoke],button[data-mode]") : null; if (!b) return;
    if (b.hasAttribute("data-build")) {
      var name = b.getAttribute("data-build"), arch = b.getAttribute("data-arch");
      // Where it runs is the asker's call (one architecture: a maintainer's own workers or the project's shared ones; all: the rule, or the shared ones at once); a hint goes to the agent that drafts the recipe.
      var st2 = STORIES[name], det = {}; try { det = JSON.parse((st2 && st2.package && st2.package.detected) || "{}"); } catch (e) {}
      var drafts = !det.has_pkgbuild; // the project's own PKGBUILD is built as it is: no agent, no hint
      var waiting = st2 ? st2.chains.filter(function (c) { return c.contributor && c.contributor.status === "queued" && (!arch || c.contributor.arch === arch); }).map(function (c) { return c.contributor; }) : [];
      var pinnedNow = waiting.length === 1 ? waiting[0].pinned_to : null;
      var where = FACTORY ? whereOptions(FACTORY.workers, arch || ARCHES[0], login, false, drafts, waiting.length === 1 ? waiting[0].queue : null, pinnedNow) : null;
      if (where && !arch) where.options = where.options.filter(function (o) { return o.value === ""; });
      var queuedNow = waiting.length > 0;
      ask({ title: (queuedNow ? (pinnedNow ? "Waiting for " + wtShort(pinnedNow) + ": " : "In the queue: ") : "Build ") + name + (arch ? " for " + arch : "") + (queuedNow ? "" : "?"), text: (queuedNow ? "Build <b>#" + waiting.map(function (t) { return t.id; }).join(", #") + "</b> " + (pinnedNow ? "waits for <b>" + esc(wtShort(pinnedNow)) + "</b> only. Keep that, send it to the shared queue instead, or take it out" : "waits in the shared queue. Leave it there, name a worker of yours to take it at once, or take it out") + " — nothing puts it back by itself; this button does. " : "") + (drafts ? "The worker drafts the recipe with its agent — from the last build's PKGBUILD and what stopped it, when there is one — builds it, runs the gate and stages the result as evidence; the second agent audits it. " : "The worker builds the project's own PKGBUILD as it is, runs the gate and stages the result as evidence; the second agent audits it. ") + (arch ? "This architecture only." : "Every architecture the request names."), select: where, input: drafts ? "optional" : false, placeholder: "a hint for the agent (optional): the binary's name, a build flag, a dependency, what to do differently", confirm: queuedNow ? (pinnedNow ? "Keep it so" : "Keep it queued") : "Build", alt: queuedNow ? { text: "Take it out of the queue", danger: true } : null }).then(function (go) {
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
    else if (b.hasAttribute("data-mode")) {
      var mid = b.getAttribute("data-mode"), to = b.getAttribute("data-to");
      api("POST", API + "/workers/" + encodeURIComponent(mid) + "/mode", { mode: to }).then(function (r) { if (r.error) toast(esc(r.error), "error"); else toast(esc(r.note || ("mode: " + to))); acted(); loadWorkers(); }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    }
    else if (b.hasAttribute("data-revoke")) {
      var wid = b.getAttribute("data-revoke");
      ask({ title: "Revoke " + wid + "?", text: "Its token stops working at once; a build it holds finishes on its own. Register a new one for a new token.", confirm: "Revoke", danger: true }).then(function (go) {
        if (go === null) return;
        api("DELETE", API + "/workers/" + encodeURIComponent(wid)).then(function (r) { if (r.error) toast(esc(r.error), "error"); else toast("Revoked."); acted(); load(); loadWorkers(); }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
    }
  });
  // The worker form is drawn for a maintainer only (renderRegister): one delegated handler, whenever it is there.
  document.addEventListener("submit", function (ev) { if (ev.target && ev.target.id === "worker-form") { ev.preventDefault(); registerWorker(); } });
  function registerWorker() {
    var body = { name: $("#w-name").value.trim(), arch: $("#w-arch").value };
    $("#w-btn").disabled = true;
    api("POST", API + "/workers", body).then(function (d) {
      $("#w-btn").disabled = false;
      if (d.error) { toast(esc(d.error), "error"); return; }
      $("#w-new").hidden = false;
      $("#w-cmd").textContent =
        "# one command, wherever the worker lives (docker or podman, with compose): it writes the compose file and a .env,\n" +
        "# pulls the signed image and starts the set — the broker that holds this token, the builder born with nothing,\n" +
        "# and the updater that keeps both on the pool's latest image (every worker follows it; one behind is handed nothing).\n" +
        "curl -fsSLo omarchy-worker " + location.origin + "/omarchy-worker && chmod +x omarchy-worker\n" +
        "./omarchy-worker start --token " + d.token + "\n\n" +
        "# everyone's queue too, a name for the machine, GitHub's API through the broker (a fine-grained token with no permissions):\n" +
        "./omarchy-worker start --token " + d.token + " --shared --where laptop --github-token github_pat_…\n" +
        "# your agent, on the broker, one of: --anthropic-key sk-… · --openai-key … · --gemini-key … · --xai-key … · --claude-token <claude setup-token>\n" +
        "# then: ./omarchy-worker status · logs · share on|off · update · stop\n" +
        "# the compose file it writes, for a hand-run set: " + location.origin + "/omarchy-worker/compose.yml\n" +
        "#   (.env beside it: OMARCHY_WORKER_TOKEN, COMPOSE_PROFILES=community, OMARCHY_WORKER_DIR=<this directory's absolute path>; the updater included)";
      $("#worker-form").reset(); $("#worker-form").hidden = true; acted(); load(); loadWorkers();
    }).catch(function (e) { $("#w-btn").disabled = false; toast("failed: " + esc(errorText(e)), "error"); });
  }
`;

export function userHtml(login: string, poolUrl: string, version: RunningVersion): string {
  return page({
    path: `/user/${login}`,
    title: `${login} · omarchy-pool`,
    description: `What ${login} contributes to and maintains in the pool.`,
    active: "factory",
    body: body(login),
    css: CSS,
    script: SCRIPT,
    poolUrl,
    version,
  });
}

/**
 * What /user/<login> is made of: everything draws from the person's profile
 * (`/api/v1/users/<login>`), the workers from the same listing the Workers
 * page reads, an open package row from its story, and what this viewer may
 * do from `/api/v1/users/<login>/can`. The page is public and reads the
 * same for every role: every control is drawn for everyone, and the
 * server's answer says which are live — the owner's workspace, a
 * maintainer's revoke, own-only, remove and withdraw — and why the others
 * are grey. The dialogs a button opens are folded into the entry that
 * renders the button. The entries are on alice's page (the contributor who
 * owns the package and the worker) except the Approvals section, which a
 * maintainer's page shows.
 *
 * The acts in order: the token; Remove, which refuses the owner of an
 * approved package; Build, which queues a build and sets the package
 * waiting; the worker registered, w3 shared and back to its owner's
 * packages, then revoked; the approval withdrawn last — the fixture has
 * one, and the build's page may have taken it back before this manifest.
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
      // What this viewer may do here, read before the first draw and again once a minute and after their own act: every control below reads CAN and is grey with the server's reason where it says no — nobody's answer, all false with the sign-in, until it lands; Remove per registration, Revoke and the mode per worker.
      id: "user.rights",
      page,
      anchor: [],
      script: ['"/can"', "function may(", "function reason(", "function removeOf(", "CAN.packages[name]", "function workerCan(", "CAN.workers[w.id]", '"sign in with GitHub"', "function loadCan(", "function acted(", "tick % 4 === 0) loadCan()"],
      reads: [
        { path: `${profile}/can`, fields: ["login", "can.request", "can.register", "can.token", "can.build", "can.dequeue", "can.remove", "can.revoke", "can.withdraw", "can.own_only", "can.share_worker", "can.why.request", "can.why.register", "can.why.token", "can.why.build", "can.why.remove", "can.why.revoke", "can.why.withdraw", "can.why.own_only", "can.why.share_worker", `can.packages.${F.factoryPkg}.remove`, `can.packages.${F.factoryPkg}.why`, `can.workers.${F.communityWorker}.revoke`, `can.workers.${F.communityWorker}.why.revoke`] },
        { path: `${profile}/can`, as: "contributor", fields: ["login", "can.why.request", "can.why.register", "can.why.token", "can.why.build", "can.why.remove", "can.why.revoke", "can.why.withdraw", "can.why.own_only", "can.why.share_worker", `can.packages.${F.factoryPkg}.why`, `can.workers.${F.communityWorker}.why.own_only`, `can.workers.${F.communityWorker}.why.share_worker`] },
        { path: `${profile}/can`, as: "owner", fields: ["login", "can.request", "can.register", "can.token", "can.build", "can.revoke", "can.own_only", "can.share_worker", "can.why.withdraw", `can.packages.${F.factoryPkg}.remove`, `can.packages.${F.factoryPkg}.why`, `can.workers.${F.communityWorker}.revoke`, `can.workers.${F.communityWorker}.own_only`, `can.workers.${F.communityWorker}.share_worker`] },
        { path: `${profile}/can`, as: "maintainer", fields: ["login", "can.remove", "can.revoke", "can.withdraw", "can.own_only", "can.why.request", "can.why.build", "can.why.share_worker", `can.packages.${F.factoryPkg}.remove`, `can.workers.${F.communityWorker}.revoke`, `can.workers.${F.communityWorker}.why.share_worker`] },
        // A maintainer's own page lists the project's worker: its mode is nobody's to set, the state's word for every role.
        { path: `/api/v1/users/${F.m1}/can`, as: "maintainer", fields: [`can.workers.${F.worker}.revoke`, `can.workers.${F.worker}.why.own_only`, `can.workers.${F.worker}.why.share_worker`] },
      ],
      visible: EVERYONE,
    },
    {
      id: "user.profile-head",
      page,
      anchor: ['id="avatar"', 'id="title"'],
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
      // The Workers tile counts as the shell counts (workerCounts): registered and alive, the listing's words.
      id: "user.tiles",
      page,
      anchor: ['id="tiles"'],
      script: ['"#tiles"', "d.build_counts", '"Decisions", num(d.approvals.length)', "d.approved_packages.length", "workerCounts(d.workers)", "wc.registered", "wc.alive"],
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
      id: "user.score-panel",
      page,
      anchor: ['href="/docs/governance">the formula', 'id="score"', 'id="score-f"'],
      script: ['"#score"', '"#score-f"', "rec.score"],
      reads: [{ path: profile, fields: ["record.score"] }],
      visible: EVERYONE,
    },
    {
      id: "user.record-section",
      page,
      anchor: ['id="record-section"', 'id="record"'],
      script: ['"#record-section"', 'pager("#record"', "rec.contributed", "rec.maintained", "m.rebuilds_failed"],
      reads: [{ path: profile, fields: ["record.contributed.approved", "record.contributed.staged", "record.contributed.bumps", "record.contributed.donated", "record.contributed.rejected", "record.maintained.approvals", "record.maintained.rejections", "record.maintained.rebuilds_failed", "record.score"] }],
      visible: EVERYONE,
    },
    {
      // The table, and the way to request a package: served grey with whose it is, drawn again from the server's word (the owner's).
      id: "user.packages-table",
      page,
      anchor: ['id="pk-request"', 'data-href="/factory#request"', `title="only ${F.owner} requests here"`, 'id="packages"'],
      script: ['pager("#packages"', '"#pk-request"', 'href=\\"/factory#request\\"', 'gate(REQUEST_LINK, may("request"), reason("request"))', "data-expand", 'JSON.parse(p.arches', "pkgHref(p.name, null, arches[0])", "p.detail", "targetChips(p.targets)", 'byPkg[p.name + "/" + a]', "data-story"],
      reads: [{ path: profile, fields: ["packages.0.name", "packages.0.category", "packages.0.url", "packages.0.arches", "packages.0.targets", "packages.0.status", "packages.0.detail", "builds.0.name", "builds.0.arch", "builds.0.status", "builds.0.id"] }],
      visible: EVERYONE,
    },
    {
      // The open row's first line, with Build all and Remove for everyone — Build the owner's, grey by state first (a build in flight, the package blocked); Remove answered per registration (a maintainer's on an approved one); the cue that the request is renewed below, for everyone, naming whose it is; the Remove dialog is this entry's.
      id: "user.story-head",
      page,
      anchor: ['id="packages"'],
      script: ['"/api/v1/factory/packages/"', '"/story"', "pkg.blocked_at", '"request incomplete"', '"renewed below by "', "acts-inline", "function buildBtn(", "function removeBtn(", "removeOf(name)", '"a build is in flight"', "function blockedWhy(", "data-build", "data-remove", '"Remove the registration of "', 'api("DELETE", API + "/packages/" + encodeURIComponent(rm))'],
      reads: [{ path: story, fields: ["package.arches", "package.status", "package.blocked_at", "request.arches", "request.complete", "request.renewable", "chains", "chains.0.contributor.arch", "chains.0.contributor.status", "chains.0.project", "chains.0.approval", "chains.0.score.ready"] }],
      // The owner is refused: by now a manifest before this one rejected one of the community's builds, which put the registration back to `registered`, and the project's build of it is still staged for a decision — the owner waits for the maintainers (409). A maintainer's removal would take the package with it, so none is sent.
      acts: [{ method: "DELETE", path: `/api/v1/factory/packages/${F.factoryPkg}`, expect: { anonymous: 401, contributor: 403, owner: 409 } }],
      visible: EVERYONE,
    },
    {
      // The request as the form checks it, with Renew the request for everyone: live for the owner while a renewal is taken, grey with the state's reason for the owner and the server's (can.why.request, the same word the build's page reads) for anyone else.
      id: "user.story-request-block",
      page,
      anchor: ['id="packages"'],
      script: ['requestBlock(st.request, may("request"), name, renewable, whyNot, reason("request"))', "st.request.renewable", "st.request.busy", '"renew it once build #"'],
      reads: [{ path: story, fields: ["request.id", "request.record", "request.signature", "request.version", "request.created_at", "request.complete", "request.checks", "request.checks.0.item", "request.checks.0.ok", "request.checks.0.note", "request.renewable", "request.busy", "request.arches"] }],
      visible: EVERYONE,
    },
    {
      // One panel per architecture, its Build for everyone: grey while a build runs or the package is blocked, by role otherwise.
      id: "user.story-arch-panel",
      page,
      anchor: ['id="packages"'],
      // The checklist's build items link the build's page at its evidence (the shell's evidenceLink); the gate, the audit and the trial link the file the story's row says is there.
      script: ["archPanel(a, mine, nextStep(st, mine[0]), acts)", "registered.indexOf(a) >= 0", "buildBtn(name, a,", '"a build is running"', "data-arch", 'href="/api/v1/factory/tasks/', "evidenceLink(cc)", "evidenceLink(pb)"],
      reads: [
        { path: story, fields: ["chains.0.contributor.id", "chains.0.contributor.status", "chains.0.contributor.arch", "chains.0.contributor.version", "chains.0.contributor.owner", "chains.0.contributor.lease_owner", "chains.0.contributor.params", "chains.0.contributor.finished_at", "chains.0.contributor.duration_ms", "chains.0.contributor.result.vet", "chains.0.project", "chains.0.audit", "chains.0.trial", "chains.0.approval", "chains.0.withdrawn", "chains.0.score.class", "chains.0.score.points", "chains.0.score.projected", "chains.0.score.ready", "chains.0.score.items.0.who", "chains.0.score.items.0.item", "chains.0.score.items.0.points", "package.blocked_at", "package.arches"] },
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
      script: ["function nextStep(", 'evidenceLink(cc, "the evidence of #" + cc.id)', "cc.pinned_to", "cc.shared_after", "cc.queue", "audit.result.verdict", '"A request on the record"', "whereOptions(FACTORY.workers, arch, login, false)", "a && a.standing", "personLink(a.by)", "pb && waitsForNative(pb)"],
      reads: [
        { path: story, fields: ["chains.0.approval", "chains.0.contributor.status", "chains.0.contributor.pinned_to", "chains.0.contributor.shared_after", "chains.0.contributor.attempts", "chains.0.contributor.pkgbuild_ref", "chains.0.contributor.version", "chains.0.contributor.error", "chains.0.contributor.result.vet.verdict", "chains.0.audit", "chains.0.score.items", "request.complete", "request.version", "rings"] },
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
      // Build <arch> and Build all open it — the owner's buttons, live for them alone: it chooses where the build runs, posts it, or takes the waiting one out of the queue (the owner's too: can.dequeue).
      id: "user.build-dialog",
      page,
      anchor: ['id="packages"'],
      script: ["st2.package.detected", "det.has_pkgbuild", "whereOptions(FACTORY.workers, arch || ARCHES[0]", "go.alt", '"/builds/" + t.id', '"/build", body', "body.worker = go.pick", "body.hint"],
      reads: [
        { path: factory, fields: ["workers.0.arch", "workers.0.owner", "workers.0.mode", "workers.0.side", "workers.0.alive", "workers.0.agent_status", "workers.0.update"] },
        { path: story, fields: ["package.detected", "chains.0.contributor.status", "chains.0.contributor.arch", "chains.0.contributor.pinned_to"] },
      ],
      acts: [
        { method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/build`, body: { arches: [F.arch] }, expect: { anonymous: 401, contributor: 404, owner: 201, maintainer: 404 } },
        { method: "DELETE", path: `/api/v1/factory/packages/${F.factoryPkg}/builds/${F.stagedTask}`, expect: { anonymous: 401, contributor: 403, owner: 409, maintainer: 403 } },
      ],
      visible: ["owner"],
    },
    {
      // The evidence column for everyone: one link per staged or failed row, to the build's page at its Evidence section (the shell's evidenceLink) — never a raw file the build may not have left. A build an emulated worker sent back wears the native worker it waits for (the shell's nativePill, #281).
      id: "user.builds-table",
      page,
      anchor: ['id="builds"', "<th>Evidence</th>"],
      script: ['pager("#builds"', "pkgHref(t.name, ringOfBuild(t.status, null), t.arch)", "wtId(t.lease_owner)", "t.pinned_to", "dur(t.duration_ms)", "t.queue", 'evidenceLink(t) : ""', "evidence(t)", "nativePill({ status: t.status, arch: t.arch, params: { needs_native: t.needs_native } })"],
      reads: [
        { path: profile, fields: ["builds.0.id", "builds.0.name", "builds.0.version", "builds.0.arch", "builds.0.status", "builds.0.reason", "builds.0.trust", "builds.0.lease_owner", "builds.0.pinned_to", "builds.0.duration_ms", "builds.0.created_at", "builds.0.needs_native"] },
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
      anchor: ['<section id="agents" hidden>', 'href="/agents#login">+ grant one →</a>', 'id="grants"', 'id="drafts"', 'href="/docs/omarchy-cli-mcp#write-tools">How it works →</a>'],
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
      anchor: ['<section id="passkeys" hidden>', 'id="pk-form"', 'id="pk-said"', 'id="pk-table"', 'href="/docs/omarchy-cli-mcp#write-tools">How it works →</a>'],
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
      anchor: ['<section id="pk-reset" hidden>', 'id="pk-reset-form"', 'id="pk-reset-why"', 'id="pk-reset-go" class="danger"', 'id="pk-reset-said"'],
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
      // The way in for a worker is a maintainer's (#331): served, the line that a contributor's packages build on the pool's hosts, with the packaging docs; hidden on a maintainer's page, whose section lists the hosts they provide; drawn for a maintainer on their own page only, "Run a worker", the toggle and the form, its fields grey with the server's word where it says no. The door refuses a contributor with the same sentence.
      id: "user.workers-register",
      page,
      anchor: ['id="w-slot"', 'id="w-own"', 'id="w-pool"', `Nothing to run here: ${POOL_HOSTS}, which the maintainers provide.`, 'href="/docs/factory#contribute-a-package"'],
      script: ["if (!isMaintainer() || !isOwner(login)) return;", 'function renderPoolLine(role) { var line = $("#w-pool"); if (line && role === "maintainer") line.hidden = true; }', "renderPoolLine(d.role);", "WORKER_OWN", "REGISTER_TOGGLE", '"#w-slot"', '"#w-toggle"', 'gate(WORKER_FORM, may("register"), reason("register"))', '"#worker-form"', '"#w-name"', '"#w-arch"', '"#w-btn"', 'api("POST", API + "/workers", body)', '\\"/docs/workers\\"'],
      acts: [{ method: "POST", path: "/api/v1/factory/workers", body: { name: "laptop", arch: F.arch }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 201 } }],
      visible: ["maintainer"],
    },
    {
      // Hosts (#321): "Add a host", its form and the command it answers are a maintainer's on their own page; the door refuses everyone else server-side, and a session's write without the page's own Origin for every role.
      id: "user.hosts-add",
      page: `/user/${F.m2}`,
      anchor: ['<section id="hosts" hidden>', 'id="h-slot"', 'id="h-own"', 'id="h-notices"'],
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
      // The hosts under this name for everyone; the fingerprint and the capacity for their owner and the maintainers; Confirm on one that waits, its owner's; a maintainer's notices of the others' new hosts.
      id: "user.hosts-table",
      page: `/user/${F.m1}`,
      anchor: ['id="hosts-table"', 'id="h-none"'],
      script: ['"/api/v1/hosts?owner=" + encodeURIComponent(login)', "function renderHosts()", "h.fingerprint", "hostCaps(h)", "data-host-confirm", '"only " + h.owner + " confirms their host"', '"/api/v1/hosts/" + encodeURIComponent(id) + "/confirm"', "HOSTS.notices", "n.line", 'href="/hosts/'],
      reads: [
        { path: `/api/v1/hosts?owner=${F.m1}`, fields: ["hosts", "hosts.0.id", "hosts.0.name", "hosts.0.owner", "hosts.0.status", "hosts.0.arches", "hosts.0.release_applied", "hosts.0.alive", "notices", "minimum"] },
        { path: `/api/v1/hosts?owner=${F.m1}`, as: "maintainer", fields: ["hosts.0.fingerprint", "hosts.0.capacity", "hosts.0.units", "hosts.0.lanes", "hosts.0.isolation", "hosts.0.hostname" ] },
      ],
      acts: [{ method: "POST", path: `/api/v1/hosts/${F.host}/confirm`, body: {}, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } }],
      visible: EVERYONE,
    },
    {
      id: "user.worker-token-block",
      page,
      anchor: [],
      script: ['"#w-new"', '"#w-cmd"', "--token \" + d.token"],
      visible: ["maintainer"],
    },
    {
      // The three panels by kind from one listing; every row — a revoked worker's and a project's too — carries Share / Own only and Revoke for whoever looks, grey with the state's word first (revoked already; a project worker has no mode) and the role's after (the owner's, and a maintainer's but for sharing, the owner's word alone), the shell's log icon beside the id the same way; the Revoke dialog is this entry's.
      id: "user.workers-tables",
      page,
      shared: "worker-table",
      anchor: ['id="wp-community"', 'id="w-community"', 'id="wp-review"', 'id="w-review"', 'id="wp-project"', 'id="w-project"', 'id="w-none"'],
      script: ['"/api/v1/factory?limit=10"', "w.owner === login", "wtKind(w)", "wtTables(true)", "workerRow(w, k, workerActs(w))", "text: wtText", "function workerActs(", 'workerCan(w, toShared ? "share_worker" : "own_only")', 'workerCan(w, "revoke")', "data-mode", "data-revoke", '"/mode"', 'api("DELETE", API + "/workers/" + encodeURIComponent(wid))', 'title="its own log — the lines between tasks, as it sent them"'],
      reads: [{ path: factory, fields: ["workers", "workers.0.id", "workers.0.owner", "workers.0.side", "workers.0.mode", "workers.0.arch", "workers.0.alive", "workers.0.revoked_at", "workers.0.labels", "workers.0.agent_status", "workers.0.update"] }],
      acts: [
        { method: "POST", path: `/api/v1/factory/workers/${F.communityWorker}/mode`, body: { mode: "shared" }, expect: { anonymous: 401, contributor: 403, owner: 200, maintainer: 403 } },
        { method: "POST", path: `/api/v1/factory/workers/${F.communityWorker}/mode`, body: { mode: "dedicated" }, expect: { anonymous: 401, contributor: 403, maintainer: 200, owner: 200 } },
        { method: "DELETE", path: `/api/v1/factory/workers/${F.communityWorker}`, expect: { anonymous: 401, contributor: 404, owner: 200 } },
      ],
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
      // Shown on a maintainer's page; whether an approval stands is the row's own `standing` (the server's word, never decision alone); Withdraw is on every row for whoever looks — live for a maintainer where an approval stands, grey with why not otherwise — with its dialog; the name opens the package on the most stable ring the row lists.
      id: "user.approvals-table",
      page: `/user/${F.m2}`,
      anchor: ['id="approvals-section"', 'id="approvals"'],
      script: ['"#approvals-section"', 'pager("#approvals"', "var standing = a.standing", "a.withdrawn_at", "a.rings", "pkgHref(a.name, servedRing(a.rings), a.arch)", "esc(archesOf(a))", "withdrawBtn(a, standing)", 'may("withdraw") && standing', '"nothing standing to withdraw"', "data-withdraw", '"/tasks/" + wid + "/withdraw"'],
      reads: [{ path: `/api/v1/users/${F.m2}`, fields: ["role", "approvals.0.task_id", "approvals.0.name", "approvals.0.arch", "approvals.0.arches", "approvals.0.version", "approvals.0.decision", "approvals.0.standing", "approvals.0.note", "approvals.0.created_at", "approvals.0.withdrawn_at", "approvals.0.rings", "approved_packages.0"] }],
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
