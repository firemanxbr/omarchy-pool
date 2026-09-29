/**
 * The two pages an agent sends its person to (#252, routes/agents.ts), each
 * a form the person posts with their browser session, and nothing an agent
 * can post for them:
 *
 *   /auth/agent          the grant: which agent, which scopes, until when,
 *                        and where the code goes (this machine's loopback);
 *                        Grant or Deny
 *   /auth/confirm/<id>   a draft: the package, the verdict, the note, who
 *                        drafted it with which agent, and the pool's own
 *                        evidence — Confirm (with a passkey for approve and
 *                        block, #257; the package's name typed for a
 *                        rejection and a block) or Discard
 *
 * Both are drawn by the server from the facts the route read: a form, its
 * nonce, and the words. The grant has no script; the confirmation of
 * approve and block has one, the passkey's (CONFIRM_SCRIPT): WebAuthn is a
 * browser API, so the page asks the pool for a challenge, hands it to
 * navigator.credentials.get() and posts the answer with the form — the
 * server verifies it, the script decides nothing. A login without a passkey
 * is told so, with the way to register one, and offered no Confirm.
 * Everything a person or an agent wrote — the agent's name, the note, a
 * package's name — is escaped. Neither page is for an index (noindex;
 * /auth/ is closed to crawlers), and neither is kept by any cache: they are
 * one session's.
 */
import { page } from "./layout";
import { lucide } from "./kit";
import { escapeHtml } from "../html";
import { DASHBOARD_HOST, type RunningVersion } from "../meta";
import { SCOPE_TOOLS, type Scope } from "../agents";

const esc = escapeHtml;

/** What each scope lets the agent do, in the person's words. */
export const SCOPE_WORDS: Readonly<Record<Scope, string>> = {
  contribute: "request packages in your name and follow them",
  review: "claim a package for review, let a claim go, read its evidence, and draft a verdict you confirm here",
  block: "draft a block you confirm here",
};

/** When, as a person reads it: the day and the minute, UTC. */
export function whenUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const CSS = String.raw`
  .aa { max-width: 720px; margin: 0 auto; padding: 12px 0 24px; display: grid; gap: 16px; }
  .aa section { margin: 0; }
  .aa h1 { font: 600 26px/1.2 var(--font-display); letter-spacing: normal; }
  .aa .lead { margin: 6px 0 0; color: var(--muted); font-size: 14px; }
  .aa dl { display: grid; grid-template-columns: minmax(96px, max-content) minmax(0, 1fr); gap: 8px 16px; margin: 0; font-size: 13.5px; }
  .aa dt { color: var(--dim); font-size: var(--fs-label); letter-spacing: var(--tracking-label); text-transform: uppercase; padding-top: 2px; }
  .aa dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .aa ul.scopes { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .aa ul.scopes code { color: var(--green); }
  .aa .note { white-space: pre-wrap; border-left: 2px solid var(--line); padding: 2px 0 2px 10px; color: var(--text); }
  .aa .said { font-size: 12.5px; color: var(--dim); margin: 0; }
  .aa .aa-notes { display: flex; flex-direction: column; gap: 0; }
  .aa #pk-said:not(:empty) { margin-bottom: 8px; }
  .aa #pk-said.err { border: 1px solid var(--red); padding: 10px 12px; color: var(--text); font-size: 13.5px; }
  .aa #pk-said.err a { color: var(--green); }
  .aa .refused { border: 1px solid var(--red); padding: 10px 12px; color: var(--text); font-size: 13.5px; }
  .aa .refused b { color: var(--red); }
  .aa .done { border: 1px solid var(--green); padding: 10px 12px; font-size: 13.5px; }
  .aa form { display: grid; gap: 12px; }
  .aa label { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
  .aa input[type=text] { font: inherit; font-size: 14px; padding: 7px 10px; border: 1px solid var(--line); background: var(--bg-deep); color: var(--text); min-width: 0; }
  .aa input[type=text]:focus-visible, .aa .op-btn:focus-visible, .aa a:focus-visible { outline: 1px solid var(--green); outline-offset: 2px; }
  .aa .aa-acts { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .aa .aa-ev { font-size: 13px; } .aa .aa-ev .said { padding: 10px 16px 12px; border-top: 1px solid var(--line); }
  .aa .aa-ev a, .aa .said a, .aa .lead a, .aa dd a { color: var(--green); }
  .aa table.op-table td:first-child { color: var(--dim); white-space: nowrap; }
  .aa .aa-pk { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--line); padding: 10px 12px; font-size: 13.5px; }
  .aa .aa-pk svg { flex: none; margin-top: 2px; color: var(--green); }
  .aa .aa-pk p { margin: 0; }
  .aa .aa-acts .op-btn { white-space: normal; text-align: left; max-width: 100%; }
  .aa .aa-acts .op-btn svg { flex: none; }
  @media (max-width: 520px) { .aa dl { grid-template-columns: minmax(0, 1fr); gap: 2px; } .aa dd { margin-bottom: 8px; } .aa h1 { font-size: 22px; } }
`;

function frame(o: { path: string; title: string; body: string; poolUrl: string; version: RunningVersion; script?: string }): string {
  return page({
    script: o.script,
    path: o.path,
    title: `${o.title} · omarchy-pool`,
    description: "A page for the person signed in: what their agent asks for, confirmed in the browser.",
    active: "none",
    body: `<div class="aa">${o.body}</div>`,
    poolUrl: o.poolUrl,
    version: o.version,
    kit: true,
    css: CSS,
    noindex: true,
  });
}

/** A page that only says something: a refusal, or what was done. */
export function agentMessageHtml(o: { path: string; title: string; heading: string; text: string; tone: "refused" | "done"; poolUrl: string; version: RunningVersion; links?: { href: string; label: string }[] }): string {
  const links = (o.links ?? []).map((l) => `<a class="op-btn" href="${esc(l.href)}">${esc(l.label)}</a>`).join(" ");
  return frame({
    path: o.path,
    title: o.title,
    poolUrl: o.poolUrl,
    version: o.version,
    body: `<section><p class="op-eyebrow">Agents</p><h1>${esc(o.heading)}</h1></section>
  <section class="${o.tone}" role="${o.tone === "refused" ? "alert" : "status"}">${o.text}</section>${links ? `\n  <div class="aa-acts">${links}</div>` : ""}`,
  });
}

export interface GrantView {
  login: string;
  agent: string;
  scopes: Scope[];
  port: number;
  state: string;
  challenge: string;
  days: number | null;
  expires_at: string;
  /** Why Grant is not offered, in the words the POST would answer: review or block for a contributor, a block, three live grants. */
  refusal: string | null;
  /** The live grant of the same agent name this one replaces. */
  replaces: { id: string; created_at: string } | null;
  live: number;
  ts: string;
  nonce: string;
}

/** The grant: what the agent asks for, and Grant or Deny, posted with the session to /auth/agent. */
export function grantHtml(v: GrantView, path: string, poolUrl: string, version: RunningVersion): string {
  const scopes = v.scopes.map((s) => `<li><b>${s}</b> — ${esc(SCOPE_WORDS[s])}: ${SCOPE_TOOLS[s].map((t) => `<code>${t}</code>`).join(", ")}</li>`).join("");
  const hidden = [
    ["agent", v.agent], ["scopes", v.scopes.join(",")], ["port", String(v.port)], ["state", v.state], ["challenge", v.challenge], ["method", "S256"], ["days", v.days === null ? "" : String(v.days)], ["ts", v.ts], ["nonce", v.nonce],
  ].map(([k, x]) => `<input type="hidden" name="${k}" value="${esc(x)}">`).join("");
  const loopback = `http://127.0.0.1:${v.port}/`;
  return frame({
    path,
    title: "Grant an agent",
    poolUrl,
    version,
    body: `<section>
    <p class="op-eyebrow">Agents</p>
    <h1>${lucide("key-round", 22)} Let ${esc(v.agent)} act as ${esc(v.login)}?</h1>
    <p class="lead">omarchy-cli on this machine asks for a token for the agent you named. It acts as you through the tools below and nothing else. A verdict or a block it drafts waits for you to confirm it here. Approve and block also ask for your passkey.</p>
  </section>
  <section class="op-card">
    <div class="op-card-h"><b>What it asks for</b><small>read it before you grant</small></div>
    <div class="op-card-b"><dl>
      <dt>Agent</dt><dd><b>${esc(v.agent)}</b> <span class="said">(the name the command was given)</span></dd>
      <dt>Acting as</dt><dd>${esc(v.login)}</dd>
      <dt>Scopes</dt><dd><ul class="scopes">${scopes}</ul></dd>
      <dt>Expires</dt><dd>${esc(whenUtc(v.expires_at))}${v.scopes.some((s) => s !== "contribute") ? ` <span class="said">— review and block are granted for seven days</span>` : ""}</dd>
      <dt>The code goes to</dt><dd><code>${esc(loopback)}</code> <span class="said">— this machine; the command there swaps it for the token</span></dd>
    </dl></div>
    <div class="op-card-f"><span class="said">${v.replaces ? `It replaces your grant to ${esc(v.agent)} of ${esc(whenUtc(v.replaces.created_at))}.` : `${v.live} of 3 live grants.`} Revoke any of them on <a href="/user/${esc(v.login)}#agents">your page</a>.</span></div>
  </section>
  ${v.refusal ? `<section class="refused" role="alert"><b>Not granted.</b> ${esc(v.refusal)}</section>` : ""}
  <form method="post" action="/auth/agent">${hidden}
    <div class="aa-acts">${v.refusal ? "" : `<button class="op-btn primary" type="submit" name="action" value="grant">Grant</button>`}<button class="op-btn" type="submit" name="action" value="deny">Deny</button></div>
    <p class="said">Did you not start this with <code>omarchy-cli login</code> on this machine? Press Deny. A grant ends when you revoke it, run <code>omarchy-cli logout</code>, or it expires.</p>
  </form>`,
  });
}

/** One architecture of the package in review: its contributor's build and the project's rebuild, their gates, the audit, the trial. */
export interface ConfirmChain {
  arch: string;
  contributor: { id: number; status: string; vet: string | null } | null;
  project: { id: number; status: string; vet: string | null } | null;
  audit: string | null;
  trial: string | null;
}

export interface ConfirmEvidence {
  /** The build the verdict was drafted on. */
  task: { id: number; arch: string; trust: string; status: string; version: string | null };
  /** Every architecture the decision covers — one review decides them all — the draft's own first. */
  chains: ConfirmChain[];
}

/**
 * What the confirmation says to a maintainer without a passkey (#257) — the
 * page, the POST and the challenge in the same words; the POST and the
 * challenge, which were tried, add "Nothing was decided."
 */
export const NO_PASSKEY = "Approve and block are confirmed with a passkey, which an agent's software cannot supply: your device asks for your fingerprint, face or PIN. You have none yet. Register one on your page, then open this draft again.";
/** …and on an address where no passkey works (the POST adds "Nothing was decided." as well). */
export const PASSKEY_ELSEWHERE = `Approve and block are confirmed with a passkey, which works on ${DASHBOARD_HOST} only (and on localhost in development): open the draft's link there.`;

/**
 * What a waiting draft of approve or block asks for (#257): the person's
 * passkey. `ready` — they hold one: Confirm starts the browser's request;
 * `none` — they hold none: the page says so and links to their page's
 * Passkeys section, with no Confirm; `unavailable` — an address where no
 * passkey works. null for request changes and reject, which ask for none.
 */
export interface ConfirmPasskey {
  state: "ready" | "none" | "unavailable";
  /** The person's own Passkeys section. */
  register: string;
}

export interface ConfirmView {
  draft: { id: string; login: string; agent: string; client: string | null; verdict: string; note: string; name: string; task_id: number | null; created_at: string; expires_at: string; state: string; outcome: Record<string, unknown> | null };
  /** The verdict as it stands now: null when the predicate allows it, else its refusal. */
  refusal: string | null;
  /** For a block: the registration's word and owner. */
  pkg: { owner: string; status: string } | null;
  evidence: ConfirmEvidence | null;
  nonce: string;
  passkey?: ConfirmPasskey | null;
}

/**
 * The passkey's half of a confirmation, in the page (#257). Confirm is the
 * form's first submit button, so Enter in the typed name confirms as a click
 * does and never lands on Discard; the script takes that submission, asks the
 * pool for a challenge bound to this draft (POST /auth/confirm/<id>/challenge,
 * with the form's nonce), hands it to navigator.credentials.get() with user
 * verification required, and posts the answer with the form. Discard goes as
 * it is. While the browser asks, Confirm keeps the focus (aria-disabled, not
 * disabled), so a cancel leaves the keyboard where it was. What happened is
 * said in #pk-said — always in the page, only its words change, so a screen
 * reader hears each one — plainly, and marked as a failure when it is one;
 * a login whose last passkey went meanwhile is given the link to register
 * one. The server verifies everything; the script only carries.
 */
export const CONFIRM_SCRIPT = String.raw`
  (function () {
    var btn = document.getElementById("pk-confirm"); if (!btn) return;
    var form = btn.form, said = document.getElementById("pk-said"), busy = false;
    function sentence(text) { return String(text || "").trim().replace(/[.\s]+$/, "") + "."; }
    function say(text, failed, link) {
      said.className = "said" + (failed ? " err" : "");
      said.textContent = text || "";
      if (link) { said.appendChild(document.createTextNode(" ")); var a = document.createElement("a"); a.href = link.href; a.textContent = link.label; said.appendChild(a); }
    }
    function idle() { busy = false; btn.removeAttribute("aria-disabled"); }
    function b64(buf) { var b = new Uint8Array(buf), s = ""; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
    function bytes(s) { var t = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (t.length % 4) t += "="; var bin = atob(t), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
    function put(name, value) { var i = form.querySelector('input[type=hidden][name="' + name + '"]'); if (!i) { i = document.createElement("input"); i.type = "hidden"; i.name = name; form.appendChild(i); } i.value = value; }
    // What went wrong, in a person's words: the browser's refusals by their name, the pool's in its own sentence, never a raw message twice punctuated.
    function failed(e) {
      idle();
      var n = e && e.name;
      if (e && e.code === "no_passkey") return say(e.message, true, { href: e.register, label: "Register a passkey" });
      if (e && e.pool) return say(/Nothing was decided\.$/.test(sentence(e.message)) ? sentence(e.message) : sentence(e.message) + " Nothing was decided.", true);
      if (n === "NotAllowedError" || n === "AbortError") return say("No passkey answered: the request was cancelled or timed out. Nothing was decided. Press Confirm to try again.", true);
      if (n === "SecurityError") return say("Your browser will not ask for a passkey on this address. Open the draft's link as your agent gave it. Nothing was decided.", true);
      if (n === "NotSupportedError") return say("This browser or device cannot use your passkey here. Nothing was decided.", true);
      say("Your passkey could not be asked: " + sentence(e && e.message ? e.message : String(e)) + " Nothing was decided.", true);
    }
    form.addEventListener("submit", function (ev) {
      var by = ev.submitter || document.activeElement;
      if (by && by !== btn && by.tagName === "BUTTON" && by.value === "discard") return;
      ev.preventDefault();
      if (busy) return;
      if (!window.PublicKeyCredential || !navigator.credentials || !window.isSecureContext) { say("This browser cannot use a passkey on this page. Open the draft in a browser that can. Nothing was decided.", true); return; }
      busy = true; btn.setAttribute("aria-disabled", "true"); say("Waiting for your passkey: answer your device.");
      fetch(form.getAttribute("action") + "/challenge", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "nonce=" + encodeURIComponent(form.elements.nonce.value) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var x = new Error(d.error || "the pool answered HTTP " + r.status); x.pool = true; x.code = d.code; x.register = d.register; throw x; } return d.publicKey; }); })
        .then(function (o) {
          return navigator.credentials.get({ publicKey: { challenge: bytes(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: o.userVerification, allowCredentials: o.allowCredentials.map(function (c) { return { type: c.type, id: bytes(c.id) }; }) } });
        })
        .then(function (cred) {
          if (!cred) { var x = new Error("no passkey answered"); x.name = "NotAllowedError"; throw x; }
          var r = cred.response;
          put("credential", b64(cred.rawId)); put("client_data", b64(r.clientDataJSON)); put("authenticator_data", b64(r.authenticatorData)); put("signature", b64(r.signature)); put("user_handle", r.userHandle ? b64(r.userHandle) : "");
          put("action", "confirm");
          say("Checking your passkey…");
          form.submit();
        })
        .catch(failed);
    });
    // Back to this page from the answer (the browser kept it): Confirm is live again, and nothing of the last answer is posted with Discard.
    window.addEventListener("pageshow", function (ev) { if (!ev.persisted) return; idle(); say(""); var a = form.querySelector('input[type=hidden][name="action"]'); if (a) a.remove(); });
  })();
`;

/** The verdict in the person's words, and whether confirming it needs the package's name typed (reject and block). */
export const VERDICT_WORDS: Readonly<Record<string, { label: string; act: string; does: string; typed: boolean; danger: boolean }>> = {
  approve: { label: "Approve", act: "approve", does: "the project's build goes into edge, and on through the rings", typed: false, danger: false },
  request_changes: { label: "Request changes", act: "request changes on", does: "the builds in review stop and the note goes to the requester; the name stays theirs", typed: false, danger: false },
  reject: { label: "Reject", act: "reject", does: "the builds in review stop and the name is free again", typed: true, danger: true },
  block: { label: "Block", act: "block", does: "the package leaves every ring, its builds stop, the approval it stood on is withdrawn, and its project is refused to new requests until another maintainer lifts it", typed: true, danger: true },
};

function evidenceRows(e: ConfirmEvidence, name: string): string {
  const build = (label: string, b: { id: number; status: string; vet: string | null } | null) =>
    b ? `<tr><td>${label}</td><td><a href="/build/${b.id}">#${b.id}</a> · ${esc(b.status)}${b.vet ? ` · gate ${esc(b.vet)}` : ""} · <a href="/api/v1/factory/tasks/${b.id}/artifacts/build.log">build.log</a> · <a href="/api/v1/factory/tasks/${b.id}/artifacts/PKGBUILD">PKGBUILD</a></td></tr>` : `<tr><td>${label}</td><td>none</td></tr>`;
  const arch = (c: ConfirmChain) => `<tbody>
      <tr><th colspan="2">${esc(c.arch)}</th></tr>
      ${build("Contributor's build", c.contributor)}
      <tr><td>Audit</td><td>${esc(c.audit ?? "none")}</td></tr>
      ${build("Project's rebuild", c.project)}
      <tr><td>Trial</td><td>${esc(c.trial ?? "none")}</td></tr>
    </tbody>`;
  const many = e.chains.length > 1;
  return `${many ? `<p class="said">One review decides every architecture: confirming decides all ${e.chains.length} below.</p>` : ""}<table class="op-table">${e.chains.map(arch).join("")}</table>
    <p class="said">The pool's own evidence, not the agent's reading of it. The whole workspace: <a href="/review?package=${encodeURIComponent(name)}">Review →</a></p>`;
}

/** A draft, with Confirm and Discard while it waits; what became of it after. */
export function confirmHtml(v: ConfirmView, path: string, poolUrl: string, version: RunningVersion): string {
  const d = v.draft, w = VERDICT_WORDS[d.verdict] ?? { label: d.verdict, act: d.verdict, does: "", typed: true, danger: true };
  const ask = `${w.act.charAt(0).toUpperCase()}${w.act.slice(1)} ${d.name}?`;
  const waiting = d.state === "waiting";
  const outcome = !waiting
    ? `<section class="${d.state === "confirmed" ? "done" : "refused"}" role="status"><b>${esc(d.state === "confirmed" ? "Confirmed" : d.state === "expired" ? "Expired" : d.state === "discarded" ? "Discarded" : "Refused")}.</b> ${esc(d.state === "expired" ? "Nobody confirmed it within thirty minutes; nothing was decided. Ask the agent for a new draft." : d.state === "discarded" ? String((d.outcome as { error?: string } | null)?.error ?? "Nothing was decided.") : String((d.outcome as { error?: string; summary?: string } | null)?.error ?? (d.outcome as { summary?: string } | null)?.summary ?? ""))}</section>`
    : "";
  // Approve and block ask for the person's passkey (#257): a Confirm that starts the browser's request when they hold one, the way to register one when they hold none — never a Confirm without it.
  const pk = waiting && !v.refusal ? (v.passkey ?? null) : null;
  const offered = !v.refusal && (!pk || pk.state === "ready");
  const pkNote = !pk
    ? ""
    : pk.state === "ready"
      ? `<div class="aa-pk">${lucide("key-round", 16)}<p>Confirm asks for your passkey. Your device asks for your fingerprint, face or PIN, which no agent's software can supply. The pool checks the answer against the key you registered.</p></div>`
      : pk.state === "none"
        ? `<section class="refused" role="alert"><b>Register a passkey first.</b> ${esc(NO_PASSKEY)}</section>`
        : `<section class="refused" role="alert"><b>Not on this address.</b> ${esc(PASSKEY_ELSEWHERE)}</section>`;
  const confirmBtn = !offered
    ? pk && pk.state === "none" ? `<a class="op-btn primary" href="${esc(pk.register)}">${lucide("key-round", 14)}Register a passkey</a>` : ""
    : pk
      ? `<button class="op-btn ${w.danger ? "danger" : "primary"}" type="submit" name="action" value="confirm" id="pk-confirm">${lucide("key-round", 14)}Confirm with your passkey: ${esc(w.act)} ${esc(d.name)}</button>`
      : `<button class="op-btn ${w.danger ? "danger" : "primary"}" type="submit" name="action" value="confirm">Confirm: ${esc(w.act)} ${esc(d.name)}</button>`;
  const form = waiting
    ? `<form method="post" action="/auth/confirm/${esc(d.id)}">
    <input type="hidden" name="nonce" value="${esc(v.nonce)}">
    ${v.refusal ? `<section class="refused" role="alert"><b>It cannot be confirmed now.</b> ${esc(v.refusal)}</section>` : ""}
    ${pkNote}
    ${w.typed && offered ? `<label><span>Type <b>${esc(d.name)}</b> to ${esc(w.label.toLowerCase())} it</span><input type="text" name="name" autocomplete="off" spellcheck="false" required pattern="${esc(d.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}"></label>` : ""}
    <div class="aa-acts">${confirmBtn}<button class="op-btn" type="submit" name="action" value="discard" formnovalidate>Discard the draft</button></div>
    <div class="aa-notes">${pk && pk.state === "ready" ? `<p class="said" id="pk-said" role="status" aria-live="polite"></p><noscript><p class="said">A passkey is asked for by this page's script: turn it on to confirm.</p></noscript>` : ""}
    <p class="said">Drafts expire at ${esc(whenUtc(d.expires_at))}. Nothing is decided until you confirm, and a draft decides once.</p></div>
  </form>`
    : "";
  return frame({
    path,
    title: ask,
    poolUrl,
    version,
    body: `<section>
    <p class="op-eyebrow">Agents · a draft to confirm</p>
    <h1>${esc(ask)}</h1>
    <p class="lead">${esc(d.agent)} drafted this for ${esc(d.login)}. ${esc(w.does ? `If you confirm it, ${w.does}.` : "")}</p>
  </section>
  <section class="op-card">
    <div class="op-card-h"><b>The draft</b><small>${esc(d.id)}</small></div>
    <div class="op-card-b"><dl>
      <dt>Package</dt><dd><a href="/package/${encodeURIComponent(d.name)}">${esc(d.name)}</a>${v.pkg ? ` <span class="said">— ${esc(v.pkg.status)}, requested by ${esc(v.pkg.owner)}</span>` : ""}</dd>
      <dt>Verdict</dt><dd><b>${esc(w.label)}</b></dd>
      <dt>${d.verdict === "block" ? "Reason" : "Note"}</dt><dd><div class="note">${esc(d.note)}</div></dd>
      <dt>Drafted by</dt><dd>${esc(d.agent)}${d.client ? ` <span class="said">(its client says: ${esc(d.client)})</span>` : ""}, for ${esc(d.login)}, at ${esc(whenUtc(d.created_at))}</dd>
    </dl></div>
  </section>
  ${v.evidence ? `<section class="op-card"><div class="op-card-h"><b>The evidence</b><small>drafted on build #${v.evidence.task.id}, ${esc(v.evidence.task.arch)}${v.evidence.task.version ? `, ${esc(v.evidence.task.version)}` : ""}${v.evidence.chains.length > 1 ? ` · ${v.evidence.chains.map((c) => esc(c.arch)).join(" · ")}` : ""}</small></div><div class="aa-ev">${evidenceRows(v.evidence, d.name)}</div></section>` : ""}
  ${outcome}${form}`,
    script: waiting && v.passkey?.state === "ready" && !v.refusal ? CONFIRM_SCRIPT : undefined,
  });
}
