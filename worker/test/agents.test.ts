/**
 * The Agents page (#249, src/pages/agents.ts): a page of its own at the
 * footer's /agents, drawn with the v1 kit and reading nothing; the tools it
 * calls available are the ones `omarchy-cli mcp` serves today (read from
 * mcp.rs itself), and the seven write tools #252 proposes are marked *
 * wherever they are named, the two role cards that need them saying so and
 * offering nothing to copy; every agent
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
import { AGENTS, FIRST_QUESTION, MCP_TOOLS, PROPOSAL_URL, PROPOSED_TOOLS, ROLES, SERVER_NAME, agentOf } from "../src/pages/agents";
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

/** The tools mcp.rs lists (tools()), in its order. */
function servedTools(): string[] {
  const body = /fn tools\(\) -> Value \{([\s\S]*?)\n\}/.exec(mcpSource)?.[1] ?? "";
  return [...body.matchAll(/"name": "([a-z_]+)"/g)].map((m) => m[1]);
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

  it("calls available only what omarchy-cli mcp serves today, in its order, and marks every proposed tool * wherever it is named", async () => {
    const served = servedTools();
    expect(served.length).toBeGreaterThanOrEqual(6);
    expect(MCP_TOOLS.map((t) => t.name), "the page's list is mcp.rs's").toEqual(served);
    // The proposal of #252 as it was signed off on 2026-09-29 (PR #253), its seven tools in its order: none of them is served — the day one is, it moves to MCP_TOOLS and loses its *.
    expect(PROPOSED_TOOLS.map((t) => t.name)).toEqual(["request_package", "request_status", "review_claim", "review_release", "review_context", "submit_review", "block"]);
    expect(PROPOSED_TOOLS.map((t) => t.role)).toEqual(["contribute", "contribute", "maintain", "maintain", "maintain", "maintain", "maintain"]);
    for (const t of PROPOSED_TOOLS) expect(served, t.name).not.toContain(t.name);
    const html = await page(), tools = /<div class="op-card ag-tools" id="tools">[\s\S]*?<\/table>/.exec(html)![0];
    const rows = [...tools.matchAll(/<tr( class="proposed")?><th scope="row"><code>([a-z_]+)(<span aria-hidden="true">\*<\/span>)?<\/code>/g)].map((m) => ({ name: m[2], proposed: !!m[1], star: !!m[3] }));
    expect(rows.map((r) => r.name)).toEqual([...served, ...PROPOSED_TOOLS.map((t) => t.name)]);
    for (const r of rows) {
      const later = PROPOSED_TOOLS.some((t) => t.name === r.name);
      expect(r.proposed, `${r.name}: drawn as ${later ? "proposed" : "available"}`).toBe(later);
      expect(r.star, `${r.name}: its *`).toBe(later);
    }
    // The star says "proposed" to a screen reader, and the head says what it means and links the proposal by what it is, not by the star.
    expect(tools.match(/<span class="ag-vh"> \(proposed\)<\/span>/g)?.length).toBe(PROPOSED_TOOLS.length);
    expect(tools).toContain(`<small>* proposed, not built yet · <a href="${PROPOSAL_URL}">the proposal →</a></small>`);
    // Every name the page writes with a star is proposed, and every proposed name it writes has one: the cards' feet too.
    for (const m of html.matchAll(/<code>([a-z_]+)(<span aria-hidden="true">\*<\/span>)?<\/code>/g)) {
      if (!served.includes(m[1]) && !PROPOSED_TOOLS.some((t) => t.name === m[1])) continue;
      expect(!!m[2], `${m[1]}: its *`).toBe(PROPOSED_TOOLS.some((t) => t.name === m[1]));
    }
    // The chapter says what each one answers, and its own example registers the server under the name every snippet here gives it: a reader who follows both has one name for it.
    expect(html).toContain('<a href="/docs/omarchy-cli-mcp">What each tool answers →</a>');
    const chapter = await page("/docs/omarchy-cli-mcp");
    expect(chapter).toContain(esc(`{ "mcpServers": { "${SERVER_NAME}": { "command": "omarchy-cli", "args": ["mcp"] } } }`));
    expect(chapter).not.toContain(esc(`"mcpServers": { "omarchy":`));
  });

  it("gives each role a prompt and the tools it needs, a prompt to copy only where they are served, and says where they are proposed and where the web does it today", async () => {
    const html = await page();
    expect(ROLES.map((r) => r.role)).toEqual(["use", "contribute", "maintain"]);
    for (const r of ROLES) {
      const c = card(html, r.role);
      expect(c, r.role).not.toBe("");
      expect(c).toContain(`<span class="op-prompt">› </span>${r.prompt}`);
      // The kit's copy takes the attribute's text: the prompt, escaped once. Only where an agent could carry it out today.
      const button = `<button type="button" class="op-copy ag-copy" data-op-copy="${r.prompt.replace(/"/g, "&quot;")}">copy prompt</button>`;
      for (const t of r.tools) expect(c, `${r.role}: ${t}`).toContain(`<code>${t}`);
      const later = r.tools.filter((t) => PROPOSED_TOOLS.some((p) => p.name === t));
      if (r.role === "use") {
        // Use asks only what the read-only tools answer.
        expect(later, "use needs no proposed tool").toEqual([]);
        for (const t of r.tools) expect(MCP_TOOLS.map((x) => x.name), t).toContain(t);
        expect(c).not.toContain("proposed</span>");
        expect(c).toContain(button);
      } else {
        expect(later, `${r.role}: every tool it needs is proposed`).toEqual(r.tools);
        expect(c).toContain('<span class="op-pill wait">proposed</span>');
        expect(c).toContain(`not built yet · on the web: <a href="${r.today!.href}">`);
        // Shown as an example: nothing to copy that no agent could do yet.
        expect(c, r.role).not.toContain("op-copy");
      }
    }
    // Step 3's question is one a served tool answers (status), not one that needs the proposal.
    expect(html).toContain(`<span class="op-prompt">› </span>${FIRST_QUESTION}`);
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
      if (a.where.endsWith("in your terminal")) expect(a.snippet, a.label).toMatch(/ omarchy-pool (?:-- )?omarchy-cli mcp$/);
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
      expect(html, a.label).toContain(`<code>${esc(a.snippet)}</code>`);
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
    let onClick: (ev: unknown) => void = () => {};
    const document = {
      getElementById: (id: string) => (id === "connect" ? steps : id.startsWith("agent-") ? panel[id.slice("agent-".length)] ?? null : null),
      querySelectorAll: (sel: string) => (sel === ".ag-pick a[data-agent]" ? picker : []),
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
    // Three steps a screen reader hears as a list in order: WebKit drops the list of an <ol> drawn without markers, and the drawn numbers are aria-hidden.
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
    // A command's or a configuration's line in steps 1 and 2 never wraps (the kit's wells wrap anywhere: "omarchy-" / "cli"), and a narrow well scrolls; step 3's question wraps between words, never inside one.
    expect(css).toContain(".ag-step .op-code code { font-size: 12.5px; line-height: 1.7; overflow-wrap: normal; }");
    expect(css).toContain(".ag-step .op-code:not(.ag-ask) code { flex: 1 1 auto; white-space: pre; overflow-x: auto; }");
    // …and it scrolls inside its card: every box between the card and the well may be narrower than the longest line, or a phone's step 2 pushes the well and the picker past the card's edge.
    expect(css).toContain(".ag-connect { flex: 1 1 560px; min-width: 0; }");
    expect(css).toContain(".ag-step { display: grid; grid-template-columns: minmax(0, 1fr);");
    expect(css).toContain(".ag-cfg { display: grid; grid-template-columns: minmax(0, 1fr);");
    expect(await page()).toContain('<div class="op-code ag-ask"><code>');
  });
});
