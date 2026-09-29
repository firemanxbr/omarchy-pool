/**
 * The Agents page (#249, src/pages/agents.ts): a page of its own at the
 * footer's /agents, drawn with the v1 kit and reading nothing; the tools it
 * lists are the ones `omarchy-cli mcp` serves (read from mcp.rs itself): the
 * six reads, then the seven write tools of #252 that a login grants, every
 * role card with its prompt to copy and the login its tools need, and step 4
 * the login with the chosen agent's name; every agent
 * it offers carries a mark from the kit, the documentation its snippet was
 * checked against and the day; the agent shown is the address's, and the
 * script switches it in place, leaving the focus where it scrolled; step 1
 * installs the client the way the docs say, and says where it is today;
 * and the page's own CSS keeps the frame's rules and never breaks a
 * command's line.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { AGENTS, FIRST_QUESTION, LOGIN_DOCS, MCP_TOOLS, ROLE_LOGIN, ROLES, SERVER_NAME, agentOf, isCommand } from "../src/pages/agents";
import { AGENT_MARKS, KIT_HELPERS, KIT_SHEET_PATH } from "../src/pages/kit";
import { ownScriptOf, scriptOf } from "./fixture";
// The MCP server's own source, as text (Vite's ?raw): the tests run inside workerd, which has no filesystem.
import mcpSource from "../../crates/omarchy-cli/src/mcp.rs?raw";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const page = async (path = "/agents") => (await get(path)).text();
/** The served body without its scripts and styles: what a reader sees. */
const shown = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
/** The opening tag of the element that carries an id. */
const opening = (html: string, id: string) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0] ?? "";
/** A role card, from its opening tag to its </article>. */
const card = (html: string, role: string) => new RegExp(`<article class="op-card ag-role" id="role-${role}">[\\s\\S]*?</article>`).exec(html)?.[0] ?? "";

/** The tools mcp.rs lists (read_tools(), then write_tools()), in its order. */
function servedTools(which: "read" | "write" | "all" = "all"): string[] {
  const of = (fn: string) => [...(new RegExp(`fn ${fn}\\(\\) -> Vec<Value> \\{([\\s\\S]*?)\\n\\}`).exec(mcpSource)?.[1] ?? "").matchAll(/"name": "([a-z_]+)"/g)].map((m) => m[1]);
  return which === "read" ? of("read_tools") : which === "write" ? of("write_tools") : [...of("read_tools"), ...of("write_tools")];
}

describe("the Agents page", () => {
  it("is a page of its own at the footer's address, drawn with the kit, its own rules after the kit's, and reads nothing", async () => {
    const res = await get("/agents");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const html = await res.text(), head = /<head>([\s\S]*?)<\/head>/.exec(html)![1];
    expect(head).toContain("<title>Agents · omarchy-pool</title>");
    // The frame's CSS, the kit's sheet, then the page's own: a rule of the page wins over the kit's at equal weight.
    const link = `<link rel="stylesheet" href="${KIT_SHEET_PATH}">`;
    expect(head.match(/\/assets\/kit\./g)?.length).toBe(1);
    expect(head.indexOf(link)).toBeGreaterThan(head.indexOf("</style>"));
    expect(head.lastIndexOf("<style>")).toBeGreaterThan(head.indexOf(link));
    expect(scriptOf(html)).toContain(KIT_HELPERS);
    // No read of its own: no fetch, no API call, no poll — a view is one render, kept at the edge a minute.
    const own = ownScriptOf(html)!;
    expect(own).not.toBeNull();
    for (const read of ["fetch(", "api(", "liveStats(", "/api/v1/", "setInterval("]) expect(own, read).not.toContain(read);
    // No door is lit: the footer names the page.
    expect(/<header>[\s\S]*?<\/header>/.exec(html)![0]).not.toContain('aria-current="page"');
    expect(html).toContain('<a href="/agents" class="accent">Agents</a>');
    // No emoji anywhere a reader sees.
    expect(shown(html)).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("lists what omarchy-cli mcp serves, in its order — the six reads, then the seven write tools a login grants — none of them marked proposed", async () => {
    const served = servedTools();
    expect(servedTools("read")).toEqual(["status", "check", "info", "search", "list", "security"]);
    // The seven of #252 as they were signed off on 2026-09-29 (PR #253), in their order, now served.
    expect(servedTools("write")).toEqual(["request_package", "request_status", "review_claim", "review_release", "review_context", "submit_review", "block"]);
    expect(MCP_TOOLS.map((t) => t.name), "the page's list is mcp.rs's").toEqual(served);
    expect(MCP_TOOLS.map((t) => t.role)).toEqual([...Array(6).fill("use"), "contribute", "contribute", "maintain", "maintain", "maintain", "maintain", "maintain"]);
    const html = await page(), tools = /<div class="op-card ag-tools" id="tools">[\s\S]*?<\/table>/.exec(html)![0];
    const rows = [...tools.matchAll(/<tr><th scope="row"><code>([a-z_]+)<\/code><\/th><td>[^<]*<\/td><td class="ag-role-c">([a-z]+)<\/td><\/tr>/g)].map((m) => [m[1], m[2]]);
    expect(rows).toEqual(MCP_TOOLS.map((t) => [t.name, t.role]));
    // Nothing is proposed any more: no star, no "proposed", no link to the proposal.
    expect(shown(html)).not.toMatch(/proposed|\*<\/span>|not built yet/);
    expect(tools).toContain('<small>contribute and maintain after <a href="#login">step 4</a></small>');
    // The chapter says what each one answers, and its own example registers the server under the name every snippet here gives it: a reader who follows both has one name for it.
    expect(html).toContain('<a href="/docs/omarchy-cli-mcp">What each tool answers →</a>');
    const chapter = await page("/docs/omarchy-cli-mcp");
    expect(chapter).toContain(esc(`{ "mcpServers": { "${SERVER_NAME}": { "command": "omarchy-cli", "args": ["mcp"] } } }`));
    expect(chapter).not.toContain(esc(`"mcpServers": { "omarchy":`));
    for (const t of served) expect(chapter, t).toContain(`<code>${t}</code>`);
  });

  it("gives each role a prompt to copy and the tools it needs, and names the login the write tools need — step 4, with the chosen agent's name", async () => {
    const html = await page();
    expect(ROLES.map((r) => r.role)).toEqual(["use", "contribute", "maintain"]);
    for (const r of ROLES) {
      const c = card(html, r.role);
      expect(c, r.role).not.toBe("");
      expect(c).toContain(`<span class="op-prompt">› </span>${r.prompt}`);
      // The kit's copy takes the attribute's text: the prompt, escaped once.
      expect(c).toContain(`<button type="button" class="op-copy ag-copy" data-op-copy="${r.prompt.replace(/"/g, "&quot;")}">copy prompt</button>`);
      for (const t of r.tools) {
        expect(c, `${r.role}: ${t}`).toContain(`<code>${t}</code>`);
        expect(MCP_TOOLS.find((x) => x.name === t)?.role, `${r.role}: ${t}`).toBe(r.role);
      }
      const login = ROLE_LOGIN[r.role];
      if (login) expect(c).toContain(`<span class="ag-login">after <a href="#login"><code>${login}</code></a></span>`);
      else expect(c).not.toContain("ag-login");
    }
    // Step 3's question is one a read answers (status); step 4 grants the rest, in the chosen agent's name.
    expect(html).toContain(`<span class="op-prompt">› </span>${FIRST_QUESTION}`);
    const step4 = /<li id="login">([\s\S]*?)<\/li>/.exec(html)![1];
    expect(step4).toContain(`<code>omarchy-cli login --agent "<span data-agent-name>${AGENTS[0].label}</span>"</code><button type="button" class="op-copy" data-op-copy>copy</button>`);
    expect(step4).toContain("<code>--maintain</code>");
    expect(step4).toContain(`<a href="${LOGIN_DOCS}">How it works →</a>`);
    expect((await page("/agents?agent=codex")).match(/<span data-agent-name>([^<]*)<\/span>/)?.[1]).toBe("Codex");
  });

  it("offers only agents whose snippet was checked: a mark from the kit, the documentation, the day, and the server under one name", async () => {
    const html = await page();
    expect(new Set(AGENTS.map((a) => a.key)).size).toBe(AGENTS.length);
    for (const a of AGENTS) {
      expect(Object.keys(AGENT_MARKS), a.label).toContain(a.mark);
      expect(a.docs, a.label).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\//);
      expect(a.checked, a.label).toMatch(/^20\d\d-\d\d-\d\d$/);
      expect(a.snippet, a.label).toContain(SERVER_NAME);
      // A command ends with the server's; a file's snippet is what the file holds — JSON that parses to the server by its name, starting omarchy-cli mcp, or TOML's one table.
      if (isCommand(a)) expect(a.snippet, a.label).toMatch(/ omarchy-pool (?:-- )?omarchy-cli mcp$/);
      else if (a.where.endsWith(".json")) {
        const entry = (a.key === "opencode" ? JSON.parse(a.snippet).mcp : JSON.parse(a.snippet).mcpServers)[SERVER_NAME];
        expect([entry.command, entry.args].flat().filter(Boolean), a.label).toEqual(["omarchy-cli", "mcp"]);
      } else if (a.where.endsWith(".toml")) expect(a.snippet, a.label).toBe(`[mcp_servers.${SERVER_NAME}]\ncommand = "omarchy-cli"\nargs = ["mcp"]`);
      else throw new Error(`${a.label}: a snippet goes in the terminal or in a .json or .toml file`);
      // Its mark under the title and in the picker, both links to this page with it shown; its panel with the snippet, where it goes and the documentation.
      const href = `href="?agent=${a.key}#connect" data-agent="${a.key}"`;
      expect(html.split(href).length - 1, a.label).toBe(2);
      expect(html, a.label).toContain(`<i class="op-b op-b-${a.mark}" style="--op-i-s:18px" role="img" aria-label="${esc(a.label)}"`);
      expect(html, a.label).toContain(`<p class="ag-where">${esc(a.label)} · ${esc(a.where)} · <a href="${esc(a.docs)}">docs →</a></p>`);
      // A file's content is served in a well that keeps its lines (ag-file); a command's wraps between words.
      expect(html, a.label).toContain(`<div class="op-code${isCommand(a) ? "" : " ag-file"}"><code>${esc(a.snippet)}</code>`);
    }
    // The prototype also showed Meta's mark; no agent of Meta's documents a local MCP server, so none is offered.
    expect(AGENTS.map((a) => a.mark)).not.toContain("meta-color");
  });

  it("shows the agent the address names — the first for none or a name it does not have — and the script switches it in place, the focus following a mark to the picker", async () => {
    const panels = (html: string) => AGENTS.map((a) => [a.key, /\shidden(?=[\s>])/.test(opening(html, `agent-${a.key}`))] as const);
    const current = (html: string) => [...html.matchAll(/<a href="\?agent=([a-z-]+)#connect" data-agent="[a-z-]+" aria-current="true">/g)].map((m) => m[1]);
    for (const [path, key] of [["/agents", AGENTS[0].key], ["/agents?agent=codex", "codex"], ["/agents?agent=opencode", "opencode"], ["/agents?agent=nope", AGENTS[0].key], [`/agents?agent=${encodeURIComponent('"><script>x</script>')}`, AGENTS[0].key]] as const) {
      const html = await page(path);
      expect(panels(html).filter(([, hidden]) => !hidden).map(([k]) => k), path).toEqual([key]);
      expect(current(html), path).toEqual([key]);
      expect(html, path).not.toContain("<script>x</script>");
    }
    expect(agentOf(null).key).toBe(AGENTS[0].key);
    expect(agentOf("codex").label).toBe("Codex");

    // The page's own script over a document of its own: the panels and the picker's links by the attributes it reads, the address it rewrites, the click it listens to.
    // The page's own statements: what follows the shell and the kit, less the close of page()'s one function.
    const own = ownScriptOf(await page())!.replace(/\}\)\(\);\s*$/, "");
    const panel: Record<string, { hidden: boolean }> = Object.fromEntries(AGENTS.map((a, i) => [a.key, { hidden: i > 0 }]));
    type Link = { attrs: Record<string, string>; getAttribute(n: string): string | null; setAttribute(n: string, v: string): void; removeAttribute(n: string): void; closest(sel: string): unknown; focus(o?: { preventScroll?: boolean }): void };
    // Where the focus is, and whether moving it scrolled: the page scrolls to the steps itself, and a focus that scrolled too would pull it elsewhere.
    let focused: { key: string; inPicker: boolean; preventScroll: boolean } | null = null;
    const link = (key: string, inPicker: boolean): Link => {
      const attrs: Record<string, string> = { "data-agent": key };
      const a: Link = { attrs, getAttribute: (n) => attrs[n] ?? null, setAttribute: (n, v) => { attrs[n] = v; }, removeAttribute: (n) => { delete attrs[n]; }, closest: (sel) => (sel === "a[data-agent]" ? a : sel === ".ag-pick" && inPicker ? {} : null), focus: (o) => { focused = { key, inPicker, preventScroll: !!o?.preventScroll }; } };
      return a;
    };
    const picker = AGENTS.map((a) => link(a.key, true)), marks = AGENTS.map((a) => link(a.key, false));
    picker[0].attrs["aria-current"] = "true";
    const steps = { scrolled: 0, scrollIntoView() { this.scrolled++; } };
    // Step 4's agent name, in the login command: it follows the choice.
    const names = [{ textContent: AGENTS[0].label }];
    let onClick: (ev: unknown) => void = () => {};
    const document = {
      getElementById: (id: string) => (id === "connect" ? steps : id.startsWith("agent-") ? panel[id.slice("agent-".length)] ?? null : null),
      querySelectorAll: (sel: string) => (sel === ".ag-pick a[data-agent]" ? picker : sel === "[data-agent-name]" ? names : []),
      querySelector: (sel: string) => picker.find((l) => sel === `.ag-pick a[data-agent="${l.attrs["data-agent"]}"]`) ?? null,
      addEventListener: (type: string, f: (ev: unknown) => void) => { if (type === "click") onClick = f; },
    };
    const replaced: string[] = [];
    const history = { replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url); } };
    new Function("document", "history", "location", "URLSearchParams", own)(document, history, { search: "?from=footer" }, URLSearchParams);
    const click = (target: unknown, mods: Record<string, unknown> = {}) => { const ev = { target, button: 0, defaultPrevented: false, prevented: false, preventDefault() { this.prevented = true; }, ...mods }; onClick(ev); return ev; };
    const visible = () => Object.entries(panel).filter(([, p]) => !p.hidden).map(([k]) => k);

    // A plain click in the picker: that panel alone, its link current, the address the link's (the rest of the query kept), no scroll, and the focus left on the link pressed.
    let ev = click(picker[2]);
    expect(ev.prevented).toBe(true);
    expect(visible()).toEqual([AGENTS[2].key]);
    expect(picker.filter((l) => l.attrs["aria-current"] === "true").map((l) => l.attrs["data-agent"])).toEqual([AGENTS[2].key]);
    expect(replaced.at(-1)).toBe(`?from=footer&agent=${AGENTS[2].key}#connect`);
    expect(names[0].textContent).toBe(AGENTS[2].label);
    expect(steps.scrolled).toBe(0);
    expect(focused).toBeNull();
    // A mark under the title (a click, or Enter on it): the same, the steps brought into view, and the focus moved to that agent's link in the picker without a scroll of its own — so the next Tab goes on from step 2, not from the title.
    ev = click(marks[4]);
    expect(ev.prevented).toBe(true);
    expect(visible()).toEqual([AGENTS[4].key]);
    expect(steps.scrolled).toBe(1);
    expect(focused).toEqual({ key: AGENTS[4].key, inPicker: true, preventScroll: true });
    expect(picker[4].attrs["aria-current"]).toBe("true");
    // A click with a modifier is the browser's (a new tab), and so is another button: nothing changes here.
    for (const mods of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
      ev = click(picker[0], mods);
      expect(ev.prevented, JSON.stringify(mods)).toBe(false);
      expect(visible()).toEqual([AGENTS[4].key]);
    }
    // A click on nothing of the picker's, or on a link whose key the list does not have, is left alone.
    expect(click({ closest: () => null }).prevented).toBe(false);
    expect(click(link("nope", true)).prevented).toBe(false);
    expect(visible()).toEqual([AGENTS[4].key]);
  });

  it("installs the client the way the docs say — from the ring once it serves it, the release binary until then — then names the server once", async () => {
    const html = await page();
    // Four steps a screen reader hears as a list in order: WebKit drops the list of an <ol> drawn without markers, and the drawn numbers are aria-hidden.
    expect(html).toContain('<ol class="ag-steps" role="list">');
    const step1 = /<h3>Install the client<\/h3>([\s\S]*?)<\/li>/.exec(html)![1];
    expect(step1).toContain('<div class="op-code"><code>sudo pacman -S omarchy-cli</code><button type="button" class="op-copy" data-op-copy>copy</button></div>');
    // The pacman line is not said to work today: no ring served omarchy-cli on 2026-09-29, so the note says when it does and links the way that works until then, named for what it opens.
    expect(step1).toContain('From your ring once it serves omarchy-cli, on a machine <a href="/docs/get-started">set up for the pool</a>. Until then, the release binary: <a href="/docs/get-started#cli">how to install it →</a>');
    // Where the link lands: Get started's omarchy-cli step, with the release tarball, saying the same.
    const started = await page("/docs/get-started");
    const cli = /<div class="step" id="cli">([\s\S]*?)<\/div>/.exec(started)?.[1] ?? "";
    expect(cli).toContain("A package of the factory once your ring serves it. Until then, the command below installs the binary from the latest");
    expect(cli).not.toContain("in every ring");
    expect(started).toContain("releases/latest/download/omarchy-pool-");
    expect(html).toContain("<small>one MCP server: omarchy-cli mcp</small>");
  });

  it("keeps the frame's rules in its own CSS: tokens only, square, no shadow, no gradient, and only the weights the fonts load", async () => {
    const head = /<head>([\s\S]*?)<\/head>/.exec(await page())![1];
    const css = [...head.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).at(-1)!;
    expect(css).toContain(".ag {");
    expect(css.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g) ?? []).toEqual([]);
    expect(css).not.toMatch(/border-radius|box-shadow|text-shadow|drop-shadow|gradient\(/);
    const weights = new Set([...css.matchAll(/font-weight:\s*(\d{3})|font:\s*(\d{3})\s/g)].map((m) => Number(m[1] ?? m[2])));
    for (const w of weights) expect([400, 500, 600, 700], String(w)).toContain(w);
    // Motion: none of its own.
    expect(css).not.toMatch(/animation|transition/);
    // No well of the steps breaks a word (the kit's wrap anywhere: "omarchy-" / "cli"): a command and the question wrap between words, and a file's content never wraps — a narrow well scrolls.
    expect(css).toContain(".ag-step .op-code code { font-size: 12.5px; line-height: 1.7; overflow-wrap: normal; }");
    expect(css).toContain(".ag-step .ag-file code { flex: 1 1 auto; white-space: pre; overflow-x: auto; }");
    expect(AGENTS.filter((a) => !isCommand(a)).map((a) => a.key)).toEqual(["codex", "cursor", "opencode", "kimi-code"]);
    // …and it scrolls inside its card: every box between the card and the well may be narrower than the longest line, or a phone's step 2 pushes the well and the picker past the card's edge.
    expect(css).toContain(".ag-connect { flex: 1 1 560px; min-width: 0; }");
    expect(css).toContain(".ag-step { display: grid; grid-template-columns: minmax(0, 1fr);");
    expect(css).toContain(".ag-cfg { display: grid; grid-template-columns: minmax(0, 1fr);");
  });
});
