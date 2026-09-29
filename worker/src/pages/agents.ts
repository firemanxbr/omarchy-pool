/**
 * Agents (#249): the pool from the reader's own agent. omarchy-cli is an
 * MCP server on the machine (`omarchy-cli mcp`, crates/omarchy-cli/src/
 * mcp.rs), and this page says how to connect it: the agents it is written
 * for, one prompt per role (use, contribute, maintain), the three steps —
 * install the client, add the server to the agent, ask it something — and
 * the tools. The chapter (/docs/omarchy-cli-mcp) says what each tool
 * answers; the page links it rather than say it twice.
 *
 * Everything here is the server's: no read, no poll, nothing asked of D1,
 * so a view costs one render and the edge keeps the page for a minute. The
 * one choice on it — whose configuration step 2 shows — is the address's
 * (?agent=), so the picker is a row of links that works with script off
 * and an address that is shared shows the agent it names; the script only
 * switches in place.
 *
 * It says only what exists. The tools are the ones mcp.rs serves: the six
 * reads anyone's machine has, and the seven write tools of #252 a machine
 * lists once `omarchy-cli login` granted its agent the scopes they need —
 * contribute, or review and block for a maintainer (`--maintain`). Every
 * role card offers its prompt to copy, and step 4 is the login, with the
 * chosen agent's name. test/agents.test.ts reads mcp.rs and holds the table
 * to it.
 */
import { page } from "./layout";
import { agentMark, lucide, type AgentMark } from "./kit";
import { EVERYONE, type Component, type Fixture } from "./components";
import { escapeHtml } from "../html";
import type { RunningVersion } from "../meta";

/** The server's name in every agent's configuration, and the command that starts it (the client's own subcommand). */
export const SERVER_NAME = "omarchy-pool";
export const SERVER_COMMAND = "omarchy-cli mcp";

/** Where the chapter says how an agent acts as its person: the grant, the scopes, the drafts the person confirms. */
export const LOGIN_DOCS = "/docs/omarchy-cli-mcp#write-tools";

export interface AgentConfig {
  /** The address's ?agent= and the panel's id (agent-<key>). */
  key: string;
  /** The agent's name, as its makers write it: what the mark says to a screen reader and on hover. */
  label: string;
  /** Its mark in the kit (kit.ts AGENT_MARKS; the licences are in src/assets/icons/). */
  mark: AgentMark;
  /** Where the snippet goes: "in your terminal" for a command, otherwise the file it is added to. */
  where: string;
  /** What to run or add, in the form the agent's own documentation gives for a local (stdio) server. */
  snippet: string;
  /** That documentation, and the day the snippet was checked against it (#249: every snippet checked before it ships). */
  docs: string;
  checked: string;
}

/**
 * The agents step 2 offers, in the prototype's order, each checked against
 * its makers' current documentation on the day it names. A command is
 * given where the agent documents one, a file where it does not (or where
 * the file is the form its documentation leads with). The scope is the
 * user's wherever the agent has one, so the server is there in every
 * project, as the client is on the machine: Claude Code and Gemini CLI
 * would otherwise write to the current project only; Qwen Code, Copilot
 * CLI and Grok Build write the user's configuration by default. The
 * prototype also showed Meta's mark: no agent of Meta's documents a local
 * MCP server today, so it is not offered. A snippet is updated only
 * against the agent's documentation, and the day with it.
 */
export const AGENTS: AgentConfig[] = [
  {
    key: "claude-code",
    label: "Claude Code",
    mark: "claude-color",
    where: "in your terminal",
    snippet: `claude mcp add --scope user ${SERVER_NAME} -- ${SERVER_COMMAND}`,
    docs: "https://code.claude.com/docs/en/mcp",
    checked: "2026-09-29",
  },
  {
    key: "codex",
    label: "Codex",
    mark: "openai",
    where: "~/.codex/config.toml",
    snippet: `[mcp_servers.${SERVER_NAME}]\ncommand = "omarchy-cli"\nargs = ["mcp"]`,
    docs: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
    checked: "2026-09-29",
  },
  {
    key: "cursor",
    label: "Cursor",
    mark: "cursor",
    where: "~/.cursor/mcp.json",
    snippet: `{\n  "mcpServers": {\n    "${SERVER_NAME}": {\n      "type": "stdio",\n      "command": "omarchy-cli",\n      "args": ["mcp"]\n    }\n  }\n}`,
    docs: "https://cursor.com/docs/mcp",
    checked: "2026-09-29",
  },
  {
    key: "gemini-cli",
    label: "Gemini CLI",
    mark: "gemini-color",
    where: "in your terminal",
    snippet: `gemini mcp add --scope user ${SERVER_NAME} ${SERVER_COMMAND}`,
    docs: "https://geminicli.com/docs/tools/mcp-server/",
    checked: "2026-09-29",
  },
  {
    key: "copilot",
    label: "GitHub Copilot",
    mark: "githubcopilot",
    where: "Copilot CLI, in your terminal",
    snippet: `copilot mcp add ${SERVER_NAME} -- ${SERVER_COMMAND}`,
    docs: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers",
    checked: "2026-09-29",
  },
  {
    key: "grok",
    label: "Grok Build",
    mark: "grok",
    where: "in your terminal",
    snippet: `grok mcp add ${SERVER_NAME} -- ${SERVER_COMMAND}`,
    docs: "https://docs.x.ai/build/features/mcp-servers",
    checked: "2026-09-29",
  },
  {
    key: "opencode",
    label: "OpenCode",
    mark: "opencode",
    where: "~/.config/opencode/opencode.json",
    snippet: `{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "${SERVER_NAME}": {\n      "type": "local",\n      "command": ["omarchy-cli", "mcp"],\n      "enabled": true\n    }\n  }\n}`,
    docs: "https://opencode.ai/docs/mcp-servers/",
    checked: "2026-09-29",
  },
  {
    key: "qwen-code",
    label: "Qwen Code",
    mark: "qwen-color",
    where: "in your terminal",
    snippet: `qwen mcp add ${SERVER_NAME} ${SERVER_COMMAND}`,
    docs: "https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/",
    checked: "2026-09-29",
  },
  {
    key: "kimi-code",
    label: "Kimi Code",
    mark: "kimi",
    where: "~/.kimi-code/mcp.json",
    snippet: `{\n  "mcpServers": {\n    "${SERVER_NAME}": {\n      "command": "omarchy-cli",\n      "args": ["mcp"]\n    }\n  }\n}`,
    docs: "https://moonshotai.github.io/kimi-code/en/customization/mcp",
    checked: "2026-09-29",
  },
];

/** The agent the address names, or the first: a key the list does not have is no choice. */
export function agentOf(key: string | null | undefined): AgentConfig {
  return AGENTS.find((a) => a.key === key) ?? AGENTS[0];
}

export type ToolRole = "use" | "contribute" | "maintain";
export interface Tool {
  name: string;
  /** What it answers or does, in a few words: the chapter has the whole of it. */
  does: string;
  role: ToolRole;
}

/**
 * The tools `omarchy-cli mcp` serves, in the order its tools/list gives
 * them (mcp.rs: read_tools(), then write_tools()): the six reads for using
 * the pool, then the seven write tools of #252 — listed on a machine whose
 * agent was granted their scope with `omarchy-cli login`. The agent drafts
 * a decision and the person confirms it in the browser, which is why two
 * of them end "you confirm"; letting go of a claim is not a decision, and
 * asks for a reason on the record instead. test/agents.test.ts reads
 * mcp.rs and holds this list to it.
 */
export const MCP_TOOLS: Tool[] = [
  { name: "status", does: "your ring, its release and the updates waiting", role: "use" },
  { name: "check", does: "is a package safe on this machine?", role: "use" },
  { name: "info", does: "a package in your ring, with its seal", role: "use" },
  { name: "search", does: "find packages in your ring", role: "use" },
  { name: "list", does: "installed from your ring: current, update or ahead", role: "use" },
  { name: "security", does: "open advisories on what is installed here", role: "use" },
  { name: "request_package", does: "send a request to the factory", role: "contribute" },
  { name: "request_status", does: "follow a request and its builds", role: "contribute" },
  { name: "review_claim", does: "claim a package that is ready", role: "maintain" },
  { name: "review_release", does: "let go of a claim, with a reason", role: "maintain" },
  { name: "review_context", does: "request, recipe and logs, no artifacts", role: "maintain" },
  { name: "submit_review", does: "approve, request changes or reject; you confirm", role: "maintain" },
  { name: "block", does: "pull a package from every ring; you confirm", role: "maintain" },
];

/** The login each role's tools need: none for the reads, the grant for the rest (review and block a maintainer's). */
export const ROLE_LOGIN: Readonly<Record<ToolRole, string | null>> = { use: null, contribute: "omarchy-cli login", maintain: "omarchy-cli login --maintain" };

interface RoleCard {
  role: ToolRole;
  eyebrow: string;
  title: string;
  prompt: string;
  /** The tools the prompt needs, by name: MCP_TOOLS'. */
  tools: string[];
}

/**
 * One card per role, each with a prompt to copy. Use asks only what the
 * read-only tools answer — installing stays with the person, as the
 * server's own instructions say. Contribute and Maintain need the write
 * tools, so their card says which login grants them; a maintainer's
 * verdict comes back as a link they confirm in the browser.
 */
export const ROLES: RoleCard[] = [
  {
    role: "use",
    eyebrow: "Use",
    title: "Install anything, safely",
    prompt: "Is ghostty in my ring? Check it is safe on this machine and show me its seal before I install it.",
    tools: ["search", "check", "info"],
  },
  {
    role: "contribute",
    eyebrow: "Contribute",
    title: "Get your project in",
    prompt: "Request my-app on omarchy-pool: github.com/me/my-app, MIT, x86_64 and aarch64. Follow it until it is ready for review.",
    tools: ["request_package", "request_status"],
  },
  {
    role: "maintain",
    eyebrow: "Maintain",
    title: "Review what others asked for",
    prompt: "Claim their-app for review, rebuild it from scratch, and show me the recipe, the logs and your verdict before I decide.",
    tools: ["review_claim", "review_context", "submit_review"],
  },
];

/** The question step 3 suggests: one the read-only tools answer (status). */
export const FIRST_QUESTION = "which ring is this machine on, and what updates are waiting?";

/** A tool's name as the page writes it. */
function toolName(name: string): string {
  return `<code>${escapeHtml(name)}</code>`;
}

/** A link to this page with that agent shown: what the script switches in place, and what a browser without script follows. */
const agentHref = (a: AgentConfig) => `?agent=${encodeURIComponent(a.key)}#connect`;

function roleCard(r: RoleCard): string {
  const login = ROLE_LOGIN[r.role];
  return `<article class="op-card ag-role" id="role-${r.role}">
        <div class="ag-role-h"><span class="ag-role-k">${escapeHtml(r.eyebrow)}</span></div>
        <h2>${escapeHtml(r.title)}</h2>
        <div class="op-code"><code><span class="op-prompt">› </span>${escapeHtml(r.prompt)}</code></div>
        <div class="ag-role-f"><span class="ag-uses">${r.tools.map(toolName).join(" · ")}${login ? `<span class="ag-login">after <a href="#login"><code>${escapeHtml(login)}</code></a></span>` : ""}</span><button type="button" class="op-copy ag-copy" data-op-copy="${escapeHtml(r.prompt)}">copy prompt</button></div>
      </article>`;
}

/** A snippet run in the terminal, one line, as against a file's content (JSON or TOML, whose lines and indentation are its structure). */
export const isCommand = (a: AgentConfig) => a.where.endsWith("in your terminal");

/** Step 2's panel for one agent: where it goes, the snippet with its copy button (a file's kept on its lines: ag-file), and the documentation it was checked against. Every panel is served; all but the chosen one hidden. */
function agentPanel(a: AgentConfig, chosen: AgentConfig): string {
  return `<div class="ag-cfg" id="agent-${escapeHtml(a.key)}"${a === chosen ? "" : " hidden"}>
              <p class="ag-where">${escapeHtml(a.label)} · ${escapeHtml(a.where)} · <a href="${escapeHtml(a.docs)}">docs →</a></p>
              <div class="op-code${isCommand(a) ? "" : " ag-file"}"><code>${escapeHtml(a.snippet)}</code><button type="button" class="op-copy" data-op-copy>copy</button></div>
            </div>`;
}

function toolRow(t: Tool): string {
  return `<tr><th scope="row">${toolName(t.name)}</th><td>${escapeHtml(t.does)}</td><td class="ag-role-c">${t.role}</td></tr>`;
}

function body(chosen: AgentConfig): string {
  return `<div class="ag">
  <section class="ag-hero">
    <p class="op-eyebrow">Agents</p>
    <h1 class="op-hero">Use the pool with your agent</h1>
    <nav class="ag-marks" aria-label="Agents it connects to">${AGENTS.map((a) => `<a href="${agentHref(a)}" data-agent="${escapeHtml(a.key)}">${agentMark(a.mark, a.label, 18)}</a>`).join("")}</nav>
  </section>

  <section class="ag-roles" aria-label="A prompt for each role">
      ${ROLES.map(roleCard).join("\n      ")}
  </section>

  <section class="ag-row" aria-label="Connect it, and its tools">
    <div class="op-card ag-connect" id="connect">
      <div class="op-card-h"><h2 class="ag-card-t">${lucide("plug", 16)}Connect it</h2><small>one MCP server: ${escapeHtml(SERVER_COMMAND)}</small></div>
      <ol class="ag-steps" role="list">
        <li><span class="ag-n" aria-hidden="true">1</span>
          <div class="ag-step">
            <h3>Install the client</h3>
            <div class="op-code"><code>sudo pacman -S omarchy-cli</code><button type="button" class="op-copy" data-op-copy>copy</button></div>
            <p class="ag-note">From your ring once it serves omarchy-cli, on a machine <a href="/docs/get-started">set up for the pool</a>. Until then, the release binary: <a href="/docs/get-started#cli">how to install it →</a></p>
          </div>
        </li>
        <li><span class="ag-n" aria-hidden="true">2</span>
          <div class="ag-step">
            <div class="ag-step-h"><h3 id="ag-pick-t">Add it to your agent</h3><nav class="ag-pick" aria-labelledby="ag-pick-t">${AGENTS.map((a) => `<a href="${agentHref(a)}" data-agent="${escapeHtml(a.key)}"${a === chosen ? ' aria-current="true"' : ""}>${agentMark(a.mark, a.label, 12)}</a>`).join("")}</nav></div>
            ${AGENTS.map((a) => agentPanel(a, chosen)).join("\n            ")}
          </div>
        </li>
        <li><span class="ag-n" aria-hidden="true">3</span>
          <div class="ag-step">
            <h3>Ask it something</h3>
            <div class="op-code ag-ask"><code><span class="op-prompt">› </span>${escapeHtml(FIRST_QUESTION)}</code></div>
          </div>
        </li>
        <li id="login"><span class="ag-n" aria-hidden="true">4</span>
          <div class="ag-step">
            <h3>Let it act as you</h3>
            <div class="op-code"><code>omarchy-cli login --agent "<span data-agent-name>${escapeHtml(chosen.label)}</span>"</code><button type="button" class="op-copy" data-op-copy>copy</button></div>
            <p class="ag-note">For Contribute and Maintain: your browser opens the pool's grant page, signed in with GitHub, and the token stays on this machine. A maintainer adds <code>--maintain</code> for review and block, granted for seven days. A verdict or a block the agent drafts waits for you to confirm it in the browser; approve and block ask for your passkey, registered on your page. <a href="${LOGIN_DOCS}">How it works →</a></p>
          </div>
        </li>
      </ol>
    </div>

    <div class="op-card ag-tools" id="tools">
      <div class="op-card-h"><h2 class="ag-card-t">${lucide("wrench", 16)}Tools</h2><small>contribute and maintain after <a href="#login">step 4</a></small></div>
      <table>
        <thead class="ag-vh"><tr><th scope="col">Tool</th><th scope="col">What it does</th><th scope="col">Role</th></tr></thead>
        <tbody>
          ${MCP_TOOLS.map(toolRow).join("\n          ")}
        </tbody>
      </table>
      <div class="op-card-f"><a href="/docs/omarchy-cli-mcp">What each tool answers →</a></div>
    </div>
  </section>
</div>`;
}

/**
 * The page's own layout, in the prototype's measures: a 1120px page (the
 * frame's main is wider), the kit's primitives refined where the prototype
 * draws them smaller — the code wells of the cards and the steps, a copy
 * that is a word in green on a card's foot.
 */
const CSS = String.raw`
  .ag { max-width: calc(var(--content-max) - 2 * var(--gutter)); margin: 0 auto; padding: 12px 0 16px; display: grid; gap: var(--section-gap); }
  .ag section { margin: 0; }
  .ag h2, .ag h3 { letter-spacing: normal; }
  .ag a:focus-visible, .ag button:focus-visible { outline: 1px solid var(--green); outline-offset: 2px; }
  .ag-vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .ag-hero { display: grid; gap: 14px; }
  .ag-marks { display: flex; flex-wrap: wrap; gap: 6px; }
  .ag-marks a, .ag-pick a { display: grid; place-items: center; border: 1px solid var(--line); background: var(--bg-deep); color: var(--text); }
  .ag-marks a { padding: 9px; } .ag-pick a { padding: 6px; }
  .ag-marks a:hover, .ag-pick a:hover { border-color: var(--dim); }
  .ag-pick a[aria-current="true"] { border-color: var(--green); }
  .ag-roles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 12px; }
  .ag-role { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto 1fr auto; }
  .ag-role-h { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 14px 16px 0; }
  .ag-role-h .op-pill { padding: 0 7px; line-height: 1.4; }
  .ag-role-k { font-size: var(--fs-label); letter-spacing: var(--tracking-label); text-transform: uppercase; color: var(--green); }
  .ag-role h2 { padding: 4px 16px 12px; font: 600 18px/1.25 var(--font-display); }
  .ag-role .op-code { margin: 0 16px; padding: 10px 12px; }
  .ag-role .op-code code { font-size: 13px; }
  .ag-role-f { display: flex; justify-content: space-between; align-items: flex-start; gap: 6px 12px; flex-wrap: wrap; margin-top: 12px; padding: 12px 16px; border-top: 1px solid var(--line); font-size: 12px; color: var(--dim); }
  .ag-uses { flex: 1 1 180px; min-width: 0; } .ag-uses code { font: inherit; }
  .ag-login { display: block; margin-top: 4px; } .ag-login code { font: inherit; white-space: nowrap; }
  .ag-login a, .ag-where a, .ag-note a, .ag-tools .op-card-h a, .ag-tools .op-card-f a { color: var(--green); text-decoration: none; }
  .ag-login a:hover, .ag-where a:hover, .ag-note a:hover, .ag-tools .op-card-h a:hover, .ag-tools .op-card-f a:hover { text-decoration: underline; }
  .op-copy.ag-copy { padding: 0; border: 0; background: none; color: var(--green); font-size: 12px; white-space: nowrap; }
  .op-copy.ag-copy:hover { text-decoration: underline; } .op-copy.ag-copy.copied { background: none; color: var(--green); }
  .ag-row { display: flex; flex-wrap: wrap; gap: 16px; align-items: stretch; }
  .ag-connect { flex: 1 1 560px; min-width: 0; } .ag-tools { flex: 1 1 380px; min-width: 0; }
  .ag-card-t { display: flex; align-items: center; gap: 10px; font: 600 15px var(--font-display); }
  .ag-card-t .op-i { color: var(--dim); }
  /* Without its markers an <ol> is no list to WebKit, so VoiceOver would read neither order nor numbers (theirs are aria-hidden): the <ol> says role="list". */
  .ag-steps { list-style: none; margin: 0; padding: 16px; display: grid; gap: 16px; }
  .ag-steps > li { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 12px; }
  .ag-n { color: var(--green); font-weight: 700; line-height: 1.5; }
  .ag-step { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; min-width: 0; }
  .ag-step h3 { font: 400 13.5px/1.5 var(--font-mono); }
  .ag-step .op-code { padding: 10px 12px; }
  /* A command or a configuration is read and retyped as it is, so no well breaks a word (the kit's wrap anywhere, which split "omarchy-" from "cli"): a command, and step 3's question, wrap between words only, the whole of it in view on a phone; a file's content keeps its lines, whose indentation is its structure, and a well too narrow for one scrolls, as the prototype's do, the copy button staying put. The step's columns are minmax(0, 1fr) for that: an auto column would grow to the longest line and push the well and the picker out of the card. */
  .ag-step .op-code code { font-size: 12.5px; line-height: 1.7; overflow-wrap: normal; }
  .ag-step .ag-file code { flex: 1 1 auto; white-space: pre; overflow-x: auto; }
  .ag-step-h { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  .ag-pick { display: flex; flex-wrap: wrap; gap: 4px; }
  .ag-cfg { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .ag-where, .ag-note { margin: 0; font-size: 12px; color: var(--dim); }
  .ag-ask code { color: var(--muted); }
  .ag-tools table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .ag-tools th, .ag-tools td { padding: 8px 6px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
  .ag-tools tr > :first-child { padding-left: 16px; } .ag-tools tr > :last-child { padding-right: 16px; }
  .ag-tools tbody tr:last-child > * { border-bottom: 0; }
  .ag-tools tbody th { font-size: 13px; font-weight: 400; letter-spacing: normal; text-transform: none; color: inherit; white-space: nowrap; }
  .ag-tools tbody th code { font-size: 12.5px; color: var(--green); }
  .ag-tools td { color: var(--muted); font-size: 12.5px; }
  .ag-tools td.ag-role-c { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); white-space: nowrap; text-align: right; }
  .ag-tools .op-card-f { justify-content: flex-start; }
  /* A narrow card (a tablet's, a phone's) stacks each row: the name and its role on one line, what it does under them, the whole width. */
  .ag-tools { container-type: inline-size; }
  @container (max-width: 420px) {
    .ag-tools tbody tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 2px 12px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
    .ag-tools tbody tr:last-child { border-bottom: 0; }
    .ag-tools.op-card tbody tr > :is(th, td) { padding: 0; border: 0; }
    .ag-tools tbody td:not(.ag-role-c) { grid-column: 1 / -1; grid-row: 2; }
  }
  @media (max-width: 720px) {
    .ag-marks { gap: 4px; } .ag-marks a { padding: 7px; }
    .ag-steps { padding: 16px 12px; } .ag-steps > li { grid-template-columns: 14px minmax(0, 1fr); gap: 10px; }
  }
`;

/**
 * The picker, with script: a plain click on an agent's link — in step 2 or
 * a mark under the title — shows that agent's panel and hides the others,
 * marks its link in the picker current, and rewrites the address to the
 * one the link names, with no new history entry; a mark under the title
 * then brings the steps into view and moves the focus to that agent's link
 * in the picker, so the keyboard is where the page went: a reader who
 * pressed Enter on a mark tabs on from step 2, not from the title (with
 * script off, the fragment moves the focus the same way). A click with a
 * modifier (a new tab) is the browser's, and a key the list does not have
 * changes nothing.
 */
const SCRIPT = (agents: AgentConfig[]) => String.raw`
  var AGENT_KEYS = ${JSON.stringify(agents.map((a) => a.key))}, AGENT_NAMES = ${JSON.stringify(Object.fromEntries(agents.map((a) => [a.key, a.label])))};
  function showAgent(key) {
    if (AGENT_KEYS.indexOf(key) < 0) return false;
    AGENT_KEYS.forEach(function (k) { var panel = document.getElementById("agent-" + k); if (panel) panel.hidden = k !== key; });
    document.querySelectorAll("[data-agent-name]").forEach(function (n) { n.textContent = AGENT_NAMES[key]; });
    document.querySelectorAll(".ag-pick a[data-agent]").forEach(function (a) { if (a.getAttribute("data-agent") === key) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current"); });
    var q = new URLSearchParams(location.search); q.set("agent", key);
    history.replaceState(null, "", "?" + q + "#connect");
    return true;
  }
  document.addEventListener("click", function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest("a[data-agent]") : null;
    if (!a || ev.defaultPrevented || ev.button || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    if (!showAgent(a.getAttribute("data-agent"))) return;
    ev.preventDefault();
    if (a.closest(".ag-pick")) return;
    var steps = document.getElementById("connect"); if (steps) steps.scrollIntoView({ block: "start" });
    var inPicker = document.querySelector('.ag-pick a[data-agent="' + a.getAttribute("data-agent") + '"]'); if (inPicker) inPicker.focus({ preventScroll: true });
  });
`;

export function agentsHtml(poolUrl: string, version: RunningVersion, agent?: string | null): string {
  return page({
    path: "/agents",
    title: "Agents · omarchy-pool",
    description: "Use the pool from your own agent: omarchy-cli as an MCP server, how to add it to Claude Code, Codex, Cursor, Gemini CLI and more, and the tools it offers.",
    active: "none",
    body: body(agentOf(agent)),
    script: SCRIPT(AGENTS),
    poolUrl,
    version,
    kit: true,
    css: CSS,
  });
}

export const AGENTS_COMPONENTS = (_F: Fixture): Component[] => [
  {
    // The title and the agents' marks, each a link to the steps with its agent shown.
    id: "agents.hero",
    page: "/agents",
    anchor: ['<p class="op-eyebrow">Agents</p>', '<h1 class="op-hero">Use the pool with your agent</h1>', '<nav class="ag-marks" aria-label="Agents it connects to">', ...AGENTS.map((a) => `<a href="?agent=${a.key}#connect" data-agent="${a.key}"><i class="op-b op-b-${a.mark}"`)],
    reads: [{ path: "/agents?agent=codex", json: false }],
    visible: EVERYONE,
  },
  {
    // One card per role with its prompt, the kit's copy putting it on the clipboard; Contribute and Maintain name the login their tools need, step 4's.
    id: "agents.roles",
    page: "/agents",
    anchor: ['id="role-use"', 'id="role-contribute"', 'id="role-maintain"', 'class="op-copy ag-copy" data-op-copy="', '<span class="ag-login">after <a href="#login"><code>omarchy-cli login</code></a></span>', '<span class="ag-login">after <a href="#login"><code>omarchy-cli login --maintain</code></a></span>'],
    visible: EVERYONE,
  },
  {
    // The four steps: the client from the ring (the release binary until the reader's serves it), the server added to the agent, a first question, and the login that grants the write tools, with the chosen agent's name.
    id: "agents.connect",
    page: "/agents",
    anchor: ['id="connect"', '<ol class="ag-steps" role="list">', "<code>sudo pacman -S omarchy-cli</code>", 'href="/docs/get-started#cli">how to install it →</a>', `<small>one MCP server: ${SERVER_COMMAND}</small>`, FIRST_QUESTION, '<li id="login">', `<code>omarchy-cli login --agent "<span data-agent-name>${AGENTS[0].label}</span>"</code>`, `<a href="${LOGIN_DOCS}">How it works →</a>`],
    reads: [{ path: "/docs/get-started", json: false }, { path: "/docs/omarchy-cli-mcp", json: false }],
    visible: EVERYONE,
  },
  {
    // Step 2's picker: a link per agent to this page with it shown (the server draws the choice), and every agent's panel served, the chosen one alone not hidden, a file's content in a well that keeps its lines; the script switches in place, and a mark under the title leaves the focus on the picker.
    id: "agents.picker",
    page: "/agents",
    anchor: ['<nav class="ag-pick" aria-labelledby="ag-pick-t">', ...AGENTS.map((a) => `id="agent-${a.key}"`), '<div class="op-code ag-file"><code>'],
    script: ["function showAgent(", '"agent-" + k', 'a.setAttribute("aria-current", "true")', 'history.replaceState(null, "", "?" + q + "#connect")', 'closest("a[data-agent]")', "inPicker.focus({ preventScroll: true })", 'document.querySelectorAll("[data-agent-name]")', "n.textContent = AGENT_NAMES[key]"],
    visible: EVERYONE,
  },
  {
    // The tools: what omarchy-cli mcp serves, the reads then the write tools a login grants; the chapter has the arguments and the answers.
    id: "agents.tools",
    page: "/agents",
    anchor: ['id="tools"', '<small>contribute and maintain after <a href="#login">step 4</a></small>', 'href="/docs/omarchy-cli-mcp">What each tool answers →</a>', ...MCP_TOOLS.map((t) => `<tr><th scope="row"><code>${t.name}</code></th>`)],
    reads: [{ path: "/docs/omarchy-cli-mcp", json: false }],
    visible: EVERYONE,
  },
];
