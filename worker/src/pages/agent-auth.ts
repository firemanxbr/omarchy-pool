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
 *                        evidence — Confirm (the package's name typed for a
 *                        rejection and a block) or Discard
 *
 * Both are drawn by the server from the facts the route read, with no
 * script of their own: a form, its nonce, and the words. Everything a person
 * or an agent wrote — the agent's name, the note, a package's name — is
 * escaped. Neither page is for an index (noindex; /auth/ is closed to
 * crawlers), and neither is kept by any cache: they are one session's.
 */
import { page } from "./layout";
import { lucide } from "./kit";
import { escapeHtml } from "../html";
import type { RunningVersion } from "../meta";
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
  .aa .refused { border: 1px solid var(--red); padding: 10px 12px; color: var(--text); font-size: 13.5px; }
  .aa .refused b { color: var(--red); }
  .aa .done { border: 1px solid var(--green); padding: 10px 12px; font-size: 13.5px; }
  .aa form { display: grid; gap: 12px; }
  .aa label { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
  .aa input[type=text] { font: inherit; font-size: 14px; padding: 7px 10px; border: 1px solid var(--line); background: var(--bg-deep); color: var(--text); min-width: 0; }
  .aa input[type=text]:focus-visible, .aa .op-btn:focus-visible, .aa a:focus-visible { outline: 1px solid var(--green); outline-offset: 2px; }
  .aa .acts { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .aa .ev { display: grid; gap: 6px; font-size: 13px; }
  .aa .ev a, .aa .said a, .aa .lead a, .aa dd a { color: var(--green); }
  .aa table.op-table td:first-child { color: var(--dim); white-space: nowrap; }
  @media (max-width: 520px) { .aa dl { grid-template-columns: minmax(0, 1fr); gap: 2px; } .aa dd { margin-bottom: 8px; } .aa h1 { font-size: 22px; } }
`;

function frame(o: { path: string; title: string; body: string; poolUrl: string; version: RunningVersion }): string {
  return page({
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
  <section class="${o.tone}" role="${o.tone === "refused" ? "alert" : "status"}">${o.text}</section>${links ? `\n  <div class="acts">${links}</div>` : ""}`,
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
    <p class="lead">omarchy-cli on this machine asks for a token for the agent you named. It acts as you through the tools below and nothing else; a verdict or a block it drafts waits for you to confirm it here.</p>
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
    <div class="acts">${v.refusal ? "" : `<button class="op-btn primary" type="submit" name="action" value="grant">Grant</button>`}<button class="op-btn" type="submit" name="action" value="deny">Deny</button></div>
    <p class="said">Did you not start this with <code>omarchy-cli login</code> on this machine? Press Deny. A grant ends when you revoke it, run <code>omarchy-cli logout</code>, or it expires.</p>
  </form>`,
  });
}

export interface ConfirmEvidence {
  /** The build the verdict was drafted on, and the chain it is in. */
  task: { id: number; arch: string; trust: string; status: string; version: string | null };
  contributor: { id: number; status: string; vet: string | null } | null;
  project: { id: number; status: string; vet: string | null } | null;
  audit: string | null;
  trial: string | null;
}

export interface ConfirmView {
  draft: { id: string; login: string; agent: string; client: string | null; verdict: string; note: string; name: string; task_id: number | null; created_at: string; expires_at: string; state: string; outcome: Record<string, unknown> | null };
  /** The verdict as it stands now: null when the predicate allows it, else its refusal. */
  refusal: string | null;
  /** For a block: the registration's word and owner. */
  pkg: { owner: string; status: string } | null;
  evidence: ConfirmEvidence | null;
  nonce: string;
}

/** The verdict in the person's words, and whether confirming it needs the package's name typed (reject and block). */
export const VERDICT_WORDS: Readonly<Record<string, { label: string; does: string; typed: boolean; danger: boolean }>> = {
  approve: { label: "Approve", does: "the project's build goes into edge, and on through the rings", typed: false, danger: false },
  request_changes: { label: "Request changes", does: "the builds in review stop and the note goes to the requester; the name stays theirs", typed: false, danger: false },
  reject: { label: "Reject", does: "the builds in review stop and the name is free again", typed: true, danger: true },
  block: { label: "Block", does: "the package leaves every ring, its builds stop, the approval it stood on is withdrawn, and its project is refused to new requests until another maintainer lifts it", typed: true, danger: true },
};

function evidenceRows(e: ConfirmEvidence, name: string): string {
  const build = (label: string, b: { id: number; status: string; vet: string | null } | null) =>
    b ? `<tr><td>${label}</td><td><a href="/build/${b.id}">#${b.id}</a> · ${esc(b.status)}${b.vet ? ` · gate ${esc(b.vet)}` : ""} · <a href="/api/v1/factory/tasks/${b.id}/artifacts/build.log">build.log</a> · <a href="/api/v1/factory/tasks/${b.id}/artifacts/PKGBUILD">PKGBUILD</a></td></tr>` : `<tr><td>${label}</td><td>none</td></tr>`;
  return `<table class="op-table"><tbody>
      ${build("Contributor's build", e.contributor)}
      <tr><td>Audit</td><td>${esc(e.audit ?? "none")}</td></tr>
      ${build("Project's rebuild", e.project)}
      <tr><td>Trial</td><td>${esc(e.trial ?? "none")}</td></tr>
    </tbody></table>
    <p class="said">The pool's own evidence, not the agent's reading of it. The whole workspace: <a href="/review?package=${encodeURIComponent(name)}">Review →</a></p>`;
}

/** A draft, with Confirm and Discard while it waits; what became of it after. */
export function confirmHtml(v: ConfirmView, path: string, poolUrl: string, version: RunningVersion): string {
  const d = v.draft, w = VERDICT_WORDS[d.verdict] ?? { label: d.verdict, does: "", typed: true, danger: true };
  const waiting = d.state === "waiting";
  const outcome = !waiting
    ? `<section class="${d.state === "confirmed" ? "done" : "refused"}" role="status"><b>${esc(d.state === "confirmed" ? "Confirmed" : d.state === "expired" ? "Expired" : d.state === "discarded" ? "Discarded" : "Refused")}.</b> ${esc(d.state === "expired" ? "Nobody confirmed it within thirty minutes; nothing was decided. Ask the agent for a new draft." : d.state === "discarded" ? "Nothing was decided." : String((d.outcome as { error?: string; summary?: string } | null)?.error ?? (d.outcome as { summary?: string } | null)?.summary ?? ""))}</section>`
    : "";
  const form = waiting
    ? `<form method="post" action="/auth/confirm/${esc(d.id)}">
    <input type="hidden" name="nonce" value="${esc(v.nonce)}">
    ${v.refusal ? `<section class="refused" role="alert"><b>It cannot be confirmed now.</b> ${esc(v.refusal)}</section>` : ""}
    ${w.typed && !v.refusal ? `<label>Type <b>${esc(d.name)}</b> to ${esc(w.label.toLowerCase())} it<input type="text" name="name" autocomplete="off" spellcheck="false" required pattern="${esc(d.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}"></label>` : ""}
    <div class="acts">${v.refusal ? "" : `<button class="op-btn ${w.danger ? "danger" : "primary"}" type="submit" name="action" value="confirm">Confirm: ${esc(w.label.toLowerCase())} ${esc(d.name)}</button>`}<button class="op-btn" type="submit" name="action" value="discard">Discard the draft</button></div>
    <p class="said">Drafts expire at ${esc(whenUtc(d.expires_at))}. Nothing is decided until you confirm, and a draft decides once.</p>
  </form>`
    : "";
  return frame({
    path,
    title: `${w.label} ${d.name}?`,
    poolUrl,
    version,
    body: `<section>
    <p class="op-eyebrow">Agents · a draft to confirm</p>
    <h1>${esc(w.label)} ${esc(d.name)}?</h1>
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
  ${v.evidence ? `<section class="op-card"><div class="op-card-h"><b>The evidence</b><small>build #${v.evidence.task.id}, ${esc(v.evidence.task.arch)}${v.evidence.task.version ? `, ${esc(v.evidence.task.version)}` : ""}</small></div><div class="ev">${evidenceRows(v.evidence, d.name)}</div></section>` : ""}
  ${outcome}${form}`,
  });
}
