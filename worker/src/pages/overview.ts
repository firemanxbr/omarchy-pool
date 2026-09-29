/**
 * The Pool (#243): the door for Omarchy users, search first. The hero is
 * the one sentence of what the pool is and a box that finds a package as
 * you type, the requests a maintainer let through lately under it, and
 * four numbers that count up; then the chain a package travels from its
 * source to your machine, the one command that points pacman at a ring (or
 * the words to ask your agent) beside the packages moving through the pool
 * now, and what the rings' newest releases brought. Every number is the
 * pool's own, from the APIs the dashboard already reads; nothing on the
 * page needs an account, and what the old page explained lives one link
 * away (Status, the docs).
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import { agentMark, lucide, type AgentMark } from "./kit";
import { escapeHtml } from "../html";
import { KEEP_RELEASES } from "../db";
import { PKGNAME } from "../request";
import { DASHBOARD_HOST, EXPECTED_SOURCES, PROMOTED_RINGS, REPO_ARCHES, RING_TEXT, RINGS_BY_STABILITY, type RunningVersion, type Upstream } from "../meta";

/**
 * The sources the chain lists, by the project a sync reads (meta.ts
 * UPSTREAMS), in the handoff's words and order. Typed by the upstreams, so
 * a project added there does not build until it has a name here.
 */
export const SOURCE_NAME: Record<Upstream, string> = {
  "mirror.omarchy.org": "Arch Linux",
  "os.archlinuxarm.org": "Arch Linux ARM",
  "builds.garudalinux.org": "Chaotic",
  "pkgs.omarchy.org": "Omarchy",
  "github.com/maralcbr/omarchy-pkgs": "Asahi",
  "github.com/asahi-alarm/asahi-alarm": "Asahi ALARM",
  "the factory": "Factory",
};

/**
 * Each source with the repositories it is made of (`<source>/<arch>`, the
 * rows of /api/v1/stats' coverage), for the script. The factory builds
 * what it serves: it never syncs, so it is never late (`built`).
 */
const SOURCES = (Object.keys(SOURCE_NAME) as Upstream[]).map((u) => ({
  name: SOURCE_NAME[u],
  keys: EXPECTED_SOURCES.filter((e) => e.upstream === u).map((e) => `${e.source}/${e.arch}`),
  built: u === "the factory",
}));

/** Where a package comes from in the handoff's few words, by repository ("extra/x86_64" → "Arch extra"): EXPECTED_SOURCES' `origin`, as the ⌘K menu says it. */
const ORIGIN: Record<string, string> = Object.fromEntries(EXPECTED_SOURCES.map((e) => [`${e.source}/${e.arch}`, e.origin]));

/** The rings a reader points pacman at, most stable first (the shell's PROMISED_RINGS), and the same rings the way a package climbs them. */
const PROMISED = RINGS_BY_STABILITY.filter((r) => (PROMOTED_RINGS as readonly string[]).includes(r));
const CLIMB = [...PROMOTED_RINGS];

/** The agents the prompt is written for, with the mark the kit draws for each (kit.ts AGENT_MARKS): the handoff's list, in its order. */
const AGENTS: [string, AgentMark][] = [
  ["Claude Code", "claude-color"], ["Codex", "openai"], ["Cursor", "cursor"], ["Gemini CLI", "gemini-color"], ["GitHub Copilot", "githubcopilot"],
  ["Grok", "grok"], ["OpenCode", "opencode"], ["Qwen Code", "qwen-color"], ["Kimi", "kimi"], ["Meta", "meta-color"],
];

/** A segment of the chain: its gate's word over a line three squares run along — still, evenly spaced, for a reader who asked for less motion. Each square rides a box as wide as the line, so the move is a transform the compositor runs, never a layout per frame. */
const track = (label: string, hue: string, seconds: number) =>
  `<div class="home-track${hue ? ` ${hue}` : ""}" style="--dur:${seconds}s"><span>${label}</span><i aria-hidden="true"><b></b><b></b><b></b></i></div>`;

const ringLine = (r: string) => escapeHtml(`${RING_TEXT[r].title} · ${RING_TEXT[r].lag}`);

/** What the page is before its script runs: the frame of every section, the command for the most stable ring, and placeholders where the numbers land. */
const BODY = String.raw`
  <section class="home-top">
    <div class="home-lead">
      <p class="op-eyebrow">For Omarchy users</p>
      <h1 class="op-hero">Arch, Arch Linux ARM, Omarchy and Asahi packages, tested before they reach you</h1>
      <form class="home-search" action="/packages" method="get" role="search">
        <div class="home-box">${lucide("search", 18)}<input type="search" name="q" id="pool-q" placeholder="Search the pool's packages" aria-label="Find a package" aria-keyshortcuts="/" aria-controls="pool-results" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"><kbd aria-hidden="true">/</kbd></div>
        <div class="home-results" id="pool-results" hidden></div>
        <span class="home-said" id="pool-said" role="status"></span>
      </form>
      <div class="home-asked" id="pool-asked" hidden></div>
    </div>
    <div class="op-stats home-stats" id="pool-stats">
      <a class="op-stat" href="/packages"><span class="k">Packages</span><b class="n" id="n-pkgs"><span class="skl"></span></b><span class="s" id="s-pkgs">${REPO_ARCHES.join(" + ")}</span></a>
      <a class="op-stat" href="/status?kind=sync#journal"><span class="k">Into edge today</span><b class="n" id="n-edge"><span class="skl"></span></b><span class="s" id="s-edge"></span></a>
      <a class="op-stat" href="/diff?ring=stable"><span class="k">Stable release</span><b class="n" id="n-rel"><span class="skl"></span></b><span class="s" id="s-rel"></span></a>
      <a class="op-stat" href="/status"><span class="k">Sources</span><b class="n" id="n-src"><span class="skl"></span></b><span class="s" id="s-src"></span></a>
    </div>
  </section>

  <section aria-labelledby="flow-h">
    <div class="home-head"><h2 class="op-label" id="flow-h">From upstream to your machine</h2><a class="home-more" href="/docs/how-it-works">The full story →</a></div>
    <div class="home-flow">
      <ul class="home-sources" id="pool-sources">${SOURCES.map((s) => `<li><span>${escapeHtml(s.name)}</span><b>…</b></li>`).join("")}</ul>
      ${track("signed", "", 2.4)}
      <div class="home-node pool"><b>pool</b><span id="fl-pool">verified</span></div>
      ${CLIMB.map((r, i) => `${track(i === 0 ? "ABI" : "health", r, 2.8 + 0.6 * i)}\n      <div class="home-node ${r}"><b>${r}</b><span id="fl-${r}">…</span></div>`).join("\n      ")}
      ${track("install", CLIMB[CLIMB.length - 1], 2.6)}
      <div class="home-node you"><i aria-hidden="true">▣</i><b>your Omarchy</b></div>
    </div>
  </section>

  <section class="home-use">
    <div class="op-card home-setup" id="get-started">
      <div class="op-card-h">
        <h2 class="home-card-t">Point pacman at a ring</h2>
        <div class="op-tabs" id="setup-tabs" role="tablist" aria-label="How to set it up"><button type="button" role="tab" id="tab-command" data-mode="command" aria-selected="true" aria-controls="setup-panel">Command</button><button type="button" role="tab" id="tab-agent" data-mode="agent" aria-selected="false" aria-controls="setup-panel" tabindex="-1">Ask your agent</button></div>
      </div>
      <div class="op-card-b" id="setup-panel" role="tabpanel" aria-labelledby="tab-command">
        <div class="op-seg home-rings" id="pick-ring" role="group" aria-label="Ring">${PROMISED.map((r, i) => `<button type="button" class="${r}" data-ring="${r}" aria-pressed="${i === 0}"><span class="op-ring-name ${r}">${r}</span><small></small></button>`).join("")}</div>
        <p class="home-ringline"><span id="ring-line">${ringLine(PROMISED[0])}</span><a href="/setup">Read the script first →</a></p>
        <div class="op-code" id="setup-well"><code><span class="op-prompt">$ </span>curl -fsSL https://${DASHBOARD_HOST}/setup | sudo bash -s -- --ring ${PROMISED[0]}</code><button type="button" class="op-copy" data-op-copy="">copy</button></div>
        <div class="home-agents" id="setup-agents" hidden><span>Works with</span>${AGENTS.map(([name, mark]) => `<span class="m">${agentMark(mark, name)}</span>`).join("")}</div>
      </div>
      <details class="home-own"><summary><span><i class="chev" aria-hidden="true">›</i>Bring your own package</span><small>factory</small></summary>
        <div class="b"><span>The pool's agents build it. Two people review it.</span><span><a class="op-btn primary" href="/factory">Request a package</a><a class="op-btn" href="/agents">Ask your agent</a></span></div>
      </details>
    </div>
    <div class="op-card home-live">
      <div class="op-card-h"><h2 class="home-card-t">Live <i class="op-live-dot"></i></h2><small id="live-count"></small></div>
      <div class="home-feed" id="live-feed"><div>${'<span class="home-ev wait"><span class="skl"></span></span>'.repeat(5)}</div></div>
      <div class="op-card-f"><a class="home-more" href="/status#journal">Full journal →</a></div>
    </div>
  </section>

  <section aria-labelledby="new-h">
    <div class="home-head"><h2 class="op-label" id="new-h">New in the pool</h2><a class="home-more" href="/packages">All packages →</a></div>
    <div class="home-cards" id="pool-new">${'<span class="op-card home-pkg wait"><span class="skl"></span><span class="skl"></span></span>'.repeat(4)}</div>
  </section>
`;

/**
 * The page's own rules: the layout of its four sections, and what no other
 * page draws — the search box, the chain, the live lines, the cards. The
 * rest is the kit's (tiles, cards, tabs, the ring picker, the code well,
 * chips). Square, 1px lines, tokens only, as the kit is; what moves stops
 * under prefers-reduced-motion (the frame's rule), and the chain's squares
 * then stand evenly along their line. Focus is the design's 1px green line
 * on everything a reader can reach here, the kit's chips, copy button,
 * buttons and tabs included — inside the tab, since the tab row scrolls
 * and would clip a line drawn outside it.
 */
const CSS = String.raw`
  /* ---- the Pool (#243, pages/overview.ts) */
  main { max-width: var(--content-max); padding: 48px var(--gutter) 56px; display: grid; gap: var(--section-gap); }
  main > section { margin: 0; min-width: 0; }
  .home-top { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 32px 40px; }
  .home-lead { flex: 1 1 520px; min-width: 0; display: grid; gap: 18px; }
  .home-stats { flex: 1 1 360px; grid-template-columns: 1fr 1fr; }
  .home-search { position: relative; margin: 0; }
  .home-box { display: flex; align-items: center; gap: 12px; height: 54px; padding: 0 16px; border: 1px solid var(--line); background: var(--bg-deep); color: var(--green); transition: border-color .12s; }
  .home-box:focus-within { border-color: var(--green); }
  .home-box input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; border-radius: 0; outline: 0; background: transparent; color: var(--text); font: 16px var(--font-mono); -webkit-appearance: none; appearance: none; }
  .home-box input::placeholder { color: var(--dim); opacity: 1; }
  .home-box input::-webkit-search-decoration, .home-box input::-webkit-search-cancel-button { -webkit-appearance: none; }
  .home-box kbd { flex: none; padding: 0 6px; border: 1px solid var(--line); color: var(--dim); font: 11.5px/1.6 var(--font-mono); }
  @media (hover: none) and (pointer: coarse) { .home-box kbd { display: none; } }
  .home-results { position: absolute; left: 0; right: 0; top: 100%; z-index: 6; border: 1px solid var(--line); border-top: 0; background: var(--panel); }
  .home-results a { color: var(--green); text-decoration: none; }
  .home-results a.r { display: grid; grid-template-columns: minmax(110px, 150px) minmax(0, 1fr) auto; gap: 14px; align-items: baseline; padding: 10px 16px; border-top: 1px solid var(--line); color: var(--text); font-size: 13.5px; }
  .home-results a.r:hover, .home-results a.r:focus-visible { background: var(--panel-2); }
  .home-results a:focus-visible { outline: 1px solid var(--green); outline-offset: -1px; }
  .home-results b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .home-results .d { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .home-results .o { color: var(--dim); font-size: 12px; white-space: nowrap; }
  .home-results .none, .home-results a.all { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--line); font-size: 13.5px; }
  .home-results .none span { color: var(--muted); } .home-results .none .go { display: flex; flex-wrap: wrap; gap: 6px 18px; } .home-results a.all { font-size: 12.5px; }
  .home-said { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .home-asked { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12.5px; }
  .home-asked > span { margin-right: 2px; color: var(--dim); }
  .home-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin: 0 0 12px; }
  .home-head h2 { font-family: var(--font-mono); }
  .home-more { font-size: 12.5px; color: var(--green); text-decoration: none; white-space: nowrap; } .home-more:hover { text-decoration: underline; }
  .home-more:focus-visible, .home-ringline a:focus-visible, .home-asked .op-chip:focus-visible, .home-setup .op-copy:focus-visible, .home-own .op-btn:focus-visible { outline: 1px solid var(--green); outline-offset: 2px; }
  .home-flow { display: flex; align-items: center; padding: 18px 20px; border: 1px solid var(--line); background: var(--panel); overflow-x: auto; scrollbar-width: none; }
  .home-sources { flex: none; width: 176px; margin: 0 6px 0 0; padding: 0; list-style: none; display: grid; gap: 1px; }
  .home-sources li { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; line-height: 1.55; }
  .home-sources span { color: var(--muted); white-space: nowrap; } .home-sources b { font-weight: 400; font-variant-numeric: tabular-nums; }
  .home-track { flex: 1 1 64px; min-width: max-content; display: grid; gap: 6px; padding: 0 6px; --dot: var(--muted); }
  .home-track.edge { --dot: var(--edge); } .home-track.rc { --dot: var(--rc); } .home-track.stable { --dot: var(--stable); }
  .home-track > span { font-size: 11.5px; color: var(--dim); text-align: center; white-space: nowrap; }
  .home-track > i { position: relative; display: block; height: 7px; overflow: hidden; }
  .home-track > i::before { content: ""; position: absolute; left: 0; right: 0; top: 3px; height: 1px; background: var(--line); }
  .home-track b { position: absolute; top: 0; left: 0; width: 100%; height: 7px; transform: translateX(16%); animation: home-flow var(--dur) linear infinite; }
  .home-track b::before { content: ""; position: absolute; top: 0; left: 0; width: 7px; height: 7px; background: var(--dot); }
  .home-track b + b { transform: translateX(47%); animation-delay: calc(var(--dur) / -3); } .home-track b + b + b { transform: translateX(78%); animation-delay: calc(var(--dur) / -1.5); }
  @keyframes home-flow { from { transform: translateX(-8px); } to { transform: translateX(100%); } }
  .home-node { flex: none; display: grid; justify-items: center; gap: 1px; padding: 8px 14px; border: 1px solid var(--line); background: var(--bg-deep); }
  .home-node b { font: 600 17px/1.2 var(--font-display); } .home-node span { font-size: 12px; color: var(--dim); white-space: nowrap; }
  .home-node.pool { padding: 10px 14px; border-color: var(--green); } .home-node.pool b { color: var(--green); }
  .home-node.edge { border-top: 2px solid var(--edge); } .home-node.edge b { color: var(--edge); }
  .home-node.rc { border-top: 2px solid var(--rc); } .home-node.rc b { color: var(--rc); }
  .home-node.stable { border-top: 2px solid var(--stable); } .home-node.stable b { color: var(--stable); }
  .home-node.you { display: flex; align-items: center; gap: 8px; padding: 10px 14px; } .home-node.you b { font-size: 15px; }
  .home-node.you i { width: 18px; height: 18px; display: grid; place-items: center; background: var(--green); color: var(--green-ink); font-size: 10px; font-style: normal; font-weight: 700; }
  .home-use { display: flex; flex-wrap: wrap; gap: 16px; align-items: stretch; }
  .home-setup { flex: 1 1 560px; display: grid; align-content: start; }
  .home-live { flex: 1 1 380px; display: grid; grid-template-rows: auto 1fr auto; }
  .home-card-t { margin: 0; display: inline-flex; align-items: center; gap: 10px; font: 600 15px var(--font-display); letter-spacing: normal; }
  .home-setup .op-card-b { display: grid; gap: 12px; }
  .home-rings { flex-wrap: nowrap; }
  .home-rings > button { flex: 1 1 0; min-width: 0; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 9px 12px; background: var(--panel-2); }
  .home-rings > button:focus-visible { outline: 1px solid var(--green); outline-offset: 2px; } .home-setup .op-tabs > button:focus-visible { outline: 1px solid var(--green); outline-offset: -1px; }
  .home-rings small { font-size: 12px; color: var(--dim); }
  .home-ringline { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; margin: 0; font-size: 13px; color: var(--muted); }
  .home-ringline a { font-size: 12.5px; color: var(--green); text-decoration: none; white-space: nowrap; } .home-ringline a:hover { text-decoration: underline; }
  .home-agents { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; } .home-agents > span:first-child { margin-right: 4px; font-size: 12px; color: var(--dim); }
  .home-agents .m { display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid var(--line); background: var(--bg-deep); }
  .home-own { border-top: 1px solid var(--line); }
  .home-own summary { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 11px 16px; font-size: 13.5px; cursor: pointer; list-style: none; }
  .home-own summary::-webkit-details-marker { display: none; }
  .home-own summary:hover { background: var(--panel-2); } .home-own summary:focus-visible { outline: 1px solid var(--green); outline-offset: -1px; }
  .home-own summary > span { display: flex; align-items: center; gap: 10px; } .home-own summary small { font-size: 12px; color: var(--dim); }
  .home-own .chev { display: inline-block; color: var(--green); font-style: normal; transition: transform .12s; } .home-own[open] .chev { transform: rotate(90deg); }
  .home-own .b { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px 16px; padding: 4px 16px 16px; font-size: 13px; color: var(--muted); }
  .home-own .b > span:last-child { display: flex; flex-wrap: wrap; gap: 8px; }
  .home-feed { position: relative; min-height: 200px; }
  .home-feed > div { position: absolute; inset: 0; overflow: hidden; display: grid; align-content: start; }
  .home-ev { display: grid; grid-template-columns: 34px 8px minmax(0, 1fr) auto; gap: 10px; align-items: center; width: 100%; padding: 8px 16px; border: 0; border-bottom: 1px solid var(--line); background: transparent; color: var(--text); font: 13px/1.6 var(--font-mono); text-align: left; cursor: pointer; --hue: var(--muted); }
  .home-ev:focus-visible { outline: 1px solid var(--green); outline-offset: -1px; }
  .home-ev.wait { display: block; cursor: default; }
  .home-ev.edge { --hue: var(--edge); } .home-ev.rc { --hue: var(--rc); } .home-ev.stable, .home-ev.ok { --hue: var(--green); } .home-ev.lab, .home-ev.warn { --hue: var(--amber); } .home-ev.fail { --hue: var(--red); }
  .home-ev .w { font-size: 12px; color: var(--dim); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .home-ev .sq { width: 8px; height: 8px; background: var(--hue); }
  .home-ev .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .home-ev .t b { font-weight: 600; } .home-ev .t span { margin-left: 8px; color: var(--dim); }
  .home-ev .e { font-size: 12px; color: var(--hue); white-space: nowrap; }
  .home-ev.open .t { white-space: normal; overflow-wrap: anywhere; }
  .home-quiet { margin: 0; padding: 14px 16px; font-size: 13px; color: var(--dim); }
  .home-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(240px, 100%), 1fr)); gap: 12px; }
  .home-cards > .home-quiet, .home-cards > .none { grid-column: 1 / -1; padding: 0; }
  .home-pkg { display: grid; gap: 6px; padding: 12px 14px; color: var(--text); text-decoration: none; }
  a.home-pkg:hover { border-color: var(--green); } a.home-pkg:focus-visible { outline: 1px solid var(--green); outline-offset: -1px; }
  .home-pkg.wait { min-height: 92px; align-content: start; }
  .home-pkg .h { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; min-width: 0; }
  .home-pkg .h b { font: 600 15px var(--font-display); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .home-pkg .h span { font-size: 12px; color: var(--dim); white-space: nowrap; }
  .home-pkg .v { font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .home-pkg .c { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 11.5px; }
  .home-pkg .from { padding: 0 6px; border: 1px solid var(--line); color: var(--muted); line-height: 1.6; white-space: nowrap; } .home-pkg .a { padding: 0 2px; color: var(--dim); }
  @media (max-width: 720px) {
    main { padding: 24px 16px 32px; gap: 32px; }
    .home-flow { padding: 14px 16px; }
    /* Live stacks under the setup card here: it grows to hold its lines instead of hiding some. */
    .home-feed > div { position: static; }
  }
  @media (max-width: 560px) {
    .home-results a.r { grid-template-columns: minmax(0, auto) minmax(0, 1fr); } .home-results .o { display: none; }
    .home-rings > button { flex-direction: column; gap: 0; }
  }
`;

const SCRIPT = String.raw`
  // ---- the Pool (#243). One poll of the stats, a minute apart as before, draws the four numbers, the chain, the rings' releases in the picker and the Live lines; what reached the rings is asked once per release of theirs, and the packages people asked for once per page.
  var SOURCES = __SOURCES__, ORIGIN = __ORIGIN__, NAME = __NAME__, CARDS = 12, SHOWN = 6, WEEK_MS = 7 * 86400e3;
  var STILL = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  var q = new URLSearchParams(location.search), box = $("#pool-q"), out = $("#pool-results");
  var ring = PROMISED_RINGS.indexOf(q.get("ring")) >= 0 ? q.get("ring") : PROMISED_RINGS[0], mode = "command", total = 0, landed = false;
  function originOf(source, arch) { return ORIGIN[source + "/" + arch] || source || ""; }
  // Where a package comes from, as a search row says it: the factory's builds are only in the pool, everything else is synced from its project. A factory name no promised ring serves says where it is instead — a trial in the lab, a request not in a ring yet, a blocked one — never "in the pool".
  function fromWhere(source, arch, where) {
    if (source !== "factory") return "synced · " + originOf(source, arch);
    return where === "lab" ? "factory · in the lab only" : where === "blocked" ? "factory · blocked" : where === "requested" ? "factory · not in a ring yet" : "factory · only in the pool";
  }
  // The source a card names: the project, as the chain lists it.
  function sourceName(source, arch) { var k = source + "/" + arch, s = SOURCES.filter(function (x) { return x.keys.indexOf(k) >= 0; })[0]; return s ? s.name : originOf(source, arch); }
  function headOf(d, name) { return ((d.rings || []).filter(function (r) { return r.ring === name; })[0] || {}).release || null; }
  // A section's one quiet line: that it has nothing to show, or which read did not answer (the shell's sentence, noAnswer).
  function quiet(text) { return '<p class="home-quiet">' + esc(text) + '</p>'; }

  // ---- the four numbers. They count up the first time they land (the kit's countUp: at once for a reader who asked for less motion) and are simply written after that. Packages is the pool's names — one name is one package on every architecture it is built for, as the handoff has it — from the metrics snapshot the stats read.
  function land(sel, n, fmt) { var el = $(sel); if (!el) return; if (!landed) countUp(el, n, fmt); else el.textContent = (fmt || num)(n); }
  // Stable's health in one word: the shell's, over the latest check on each architecture — the worst of them, and which architecture it is when only one was checked yet.
  function stableHealth(d) {
    var got = ARCHES.map(function (a) { return latest(d.latest || [], "health", "stable", a); }).filter(Boolean);
    if (!got.length) return "no health check yet";
    var worst = got.some(function (h) { return h.status === "error"; }) ? "error" : got.some(function (h) { return h.status === "warn"; }) ? "warn" : "ok";
    return HEALTH_WORD[worst] + (got.length < ARCHES.length ? " on " + (got[0].source || NULL_SOURCE_ARCH) : "");
  }
  // The sources, counted from the coverage rows: what edge serves from each, one architecture at a time — a source on both counts its larger side, since a name built for both is one package. A source is in sync when every repository of it synced and none is late (the shell's lateSync, the server's mark); the factory builds what it serves and is never behind.
  function sourcesOf(d) {
    var cov = d.coverage || [];
    return SOURCES.map(function (s) {
      var rows = cov.filter(function (c) { return s.keys.indexOf(c.source + "/" + c.arch) >= 0; }), per = {};
      rows.forEach(function (c) { per[c.arch] = (per[c.arch] || 0) + (c.indexed || 0); });
      var n = Object.keys(per).reduce(function (m, a) { return Math.max(m, per[a]); }, 0);
      var never = !s.built && (!rows.length || rows.some(function (c) { return !c.last_sync; })), late = !s.built && rows.some(lateSync);
      return { name: s.name, n: n, never: never, late: late && !never };
    });
  }
  function numbers(d) {
    var today = new Date().toISOString().slice(0, 10), sync = newest(d.latest, "sync"), rel = headOf(d, "stable");
    var imp = ((d.series || {}).imports_daily || []).filter(function (r) { return r.day === today; })[0];
    total = (d.pool || {}).names || 0;
    land("#n-pkgs", total);
    land("#n-edge", imp ? imp.packages : 0, function (n) { return "+" + num(n); });
    $("#s-edge").textContent = sync ? "last sync " + ago(sync.created_at) : "no sync yet";
    if (rel) land("#n-rel", rel.seq, function (n) { return "#" + num(n); }); else $("#n-rel").textContent = "—";
    $("#s-rel").innerHTML = rel ? '<i class="op-live-dot"></i>' + esc(ago(rel.created_at) + " · " + stableHealth(d)) : "no release yet";
    var src = sourcesOf(d), late = src.filter(function (s) { return s.late; }).map(function (s) { return s.name; }), never = src.filter(function (s) { return s.never; }).map(function (s) { return s.name; });
    land("#n-src", src.length - late.length - never.length, function (n) { return n + " / " + src.length; });
    $("#s-src").textContent = late.length || never.length ? [late.length ? "late: " + late.join(", ") : "", never.length ? "not synced yet: " + never.join(", ") : ""].filter(Boolean).join(" · ") : "all in sync";
    landed = true;
  }
  // The stats did not answer before anything landed: each number reads "—" with "did not answer" under it and the reason on hover — the shell's words (tilesUnanswered), never a 0 —, the chain's figures "—", and Live and the cards say which read did not answer, once each. A poll that fails after one answered leaves what that one drew, as the shell's lists do (noAnswer).
  function statsDown(e) {
    if (landed) return;
    var text = noAnswer("pool's stats", e);
    ["pkgs", "edge", "rel", "src"].forEach(function (k) { $("#n-" + k).textContent = "—"; $("#s-" + k).innerHTML = '<span title="' + esc(text) + '">did not answer</span>'; });
    $("#pool-sources").innerHTML = SOURCES.map(function (s) { return '<li><span>' + esc(s.name) + '</span><b>—</b></li>'; }).join("");
    PROMISED_RINGS.forEach(function (r) { var el = $("#fl-" + r); if (el) el.textContent = "—"; });
    $("#live-feed").innerHTML = '<div>' + quiet(text) + '</div>';
    $("#pool-new").innerHTML = quiet(text);
  }

  // ---- the chain: every source with what edge serves from it, the pool's names, each ring's release.
  function chain(d) {
    $("#pool-sources").innerHTML = sourcesOf(d).map(function (s) { return '<li><span>' + esc(s.name) + '</span><b>' + num(s.n) + '</b></li>'; }).join("");
    $("#fl-pool").textContent = num(total) + " verified";
    PROMISED_RINGS.forEach(function (r) { var h = headOf(d, r), el = $("#fl-" + r); if (el) el.textContent = h ? "#" + h.seq : "no release"; });
  }

  // ---- Point pacman at a ring: the picked ring (?ring= picks one on arrival), the command or the words for an agent, its copy button. The well is written again when the ring or the mode changes, and only then: a poll leaves it alone, so the copy button keeps its focus and its "copied", and a selection a reader is making in the command stays.
  var drawnSetup = "";
  function command(r) { return "curl -fsSL " + location.origin + "/setup | sudo bash -s -- --ring " + r; }
  function askAgent(r) { return "Set up omarchy-pool on this machine on the " + r + " ring, with the script at " + location.origin + "/setup. After that I'll install packages with pacman as usual."; }
  // Each ring's release beside its name in the picker: all a poll changes in the card.
  function ringNumbers(d) {
    document.querySelectorAll("#pick-ring button[data-ring]").forEach(function (b) { var h = headOf(d, b.getAttribute("data-ring")); if (h) b.querySelector("small").textContent = "#" + h.seq; });
  }
  function drawSetup() {
    var agent = mode === "agent", now = mode + " " + ring;
    if (now === drawnSetup) return;
    drawnSetup = now;
    document.querySelectorAll("#pick-ring button[data-ring]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-ring") === ring)); });
    document.querySelectorAll("#setup-tabs [role=tab]").forEach(function (t) { var on = t.getAttribute("data-mode") === mode; t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1; });
    $("#setup-panel").setAttribute("aria-labelledby", "tab-" + mode);
    $("#ring-line").textContent = RINGS_TEXT[ring].title + " · " + RINGS_TEXT[ring].lag;
    $("#setup-well").innerHTML = '<code><span class="op-prompt">' + (agent ? "› " : "$ ") + '</span>' + esc(agent ? askAgent(ring) : command(ring)) + '</code><button type="button" class="op-copy" data-op-copy="">' + (agent ? "copy prompt" : "copy") + '</button>';
    $("#setup-agents").hidden = !agent;
  }
  $("#pick-ring").addEventListener("click", function (ev) { var b = ev.target.closest ? ev.target.closest("button[data-ring]") : null; if (b) { ring = b.getAttribute("data-ring"); drawSetup(); } });
  // The two tabs, as a tab list is worked: a press, or ← and → between them.
  $("#setup-tabs").addEventListener("click", function (ev) { var t = ev.target.closest ? ev.target.closest("[role=tab]") : null; if (t) { mode = t.getAttribute("data-mode"); drawSetup(); } });
  $("#setup-tabs").addEventListener("keydown", function (ev) {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    mode = mode === "command" ? "agent" : "command";
    drawSetup();
    $("#tab-" + mode).focus();
  });

  // ---- Live: packages moving through the pool — a sync that brought or dropped packages, a promotion, a security fix, a rollback, the factory's publish —, newest first, from the journal's newest lines and its latest line of each kind (both in the stats), a line that arrived since the last poll lit for a moment (the kit's op-fresh). The rest of the journal (checks, renders, jobs, the factory's bookkeeping) is one link away, and a promotion the journal writes twice (the ring's line and the copy's) is said once. A line opens to its whole text on a press.
  var MOVES = ["sync", "promote", "fast-track", "rollback", "publish"], seen = null, opened = {}, shownFeed = null;
  function moves(d) {
    var had = {}, promoted = {};
    return (d.events || []).concat(d.latest || []).filter(function (e) {
      var p = e.payload || {}, rel = e.kind === "promote" && p.release_id ? e.ring + "#" + p.release_id : "";
      if (had[e.id] || MOVES.indexOf(e.kind) < 0 || (e.kind === "sync" && !(p.uploaded > 0) && !(p.removed > 0)) || (rel && promoted[rel])) return false;
      had[e.id] = true; if (rel) promoted[rel] = true;
      return true;
    }).sort(function (a, b) { return b.id - a.id; });
  }
  // What a line says happened, in the handoff's words and the colour of where it went: the ring's hue, amber for a security fix, red for a rollback and a failure, the factory's in grey.
  function said(e) {
    var r = e.ring && RINGS_TEXT[e.ring] ? e.ring : "", bad = e.status === "error" ? "fail" : e.status === "warn" ? "warn" : "";
    if (e.kind === "sync") return { word: "synced → edge", hue: bad || "edge" };
    if (e.kind === "promote") return { word: r ? "promoted → " + r : "promoted", hue: bad || r };
    if (e.kind === "fast-track") return { word: "security fix" + (r ? " → " + r : ""), hue: bad || "warn" };
    if (e.kind === "rollback") return { word: "rolled back" + (r ? " · " + r : ""), hue: "fail" };
    return { word: "built in the factory", hue: bad };
  }
  function evRow(e, fresh) {
    var s = String(e.summary || ""), cut = s.indexOf(": "), w = said(e);
    var text = cut > 0 ? '<b>' + esc(s.slice(0, cut)) + '</b><span>' + esc(s.slice(cut + 2)) + '</span>' : '<b>' + esc(s) + '</b>';
    return '<button type="button" class="home-ev ' + w.hue + (fresh ? " op-fresh" : "") + (opened[e.id] ? " open" : "") + '" data-id="' + esc(e.id) + '" aria-expanded="' + !!opened[e.id] + '" title="' + esc(s) + '"><span class="w">' + span(Date.now() - Date.parse(e.created_at)) + '</span><i class="sq"></i><span class="t">' + text + '</span><span class="e">' + esc(w.word) + '</span></button>';
  }
  function liveRows() { return [].slice.call(document.querySelectorAll("#live-feed .home-ev[data-id]")); }
  // A line the panel has no room for is out of the tab order and hidden from a screen reader, as it is from the eye: the panel does not scroll. Measured again whenever the panel changes size (the setup card beside it sets its height).
  function fit() {
    var inner = $("#live-feed > div");
    if (!inner || !inner.getBoundingClientRect) return;
    var bottom = inner.getBoundingClientRect().bottom;
    liveRows().forEach(function (b) { var off = b.getBoundingClientRect().bottom > bottom + 1; b.tabIndex = off ? -1 : 0; if (off) b.setAttribute("aria-hidden", "true"); else b.removeAttribute("aria-hidden"); });
  }
  function feed(d) {
    var today = new Date().toISOString().slice(0, 10), rows = moves(d).slice(0, 8), key = rows.map(function (e) { return e.id; }).join(","), fresh = {}, by = {};
    // The day's syncs, exact: the stats' daily series counts every one, where the journal's forty newest lines hold a fraction of a busy day.
    var imp = ((d.series || {}).imports_daily || []).filter(function (r) { return r.day === today; })[0], runs = imp ? imp.runs : 0;
    $("#live-count").textContent = runs ? num(runs) + (runs === 1 ? " sync today" : " syncs today") : "no sync yet today";
    // The same lines as the last poll: only their ages move, so a line keeps the focus, its open state and a reader's place.
    if (key && key === shownFeed) {
      rows.forEach(function (e) { by[e.id] = e; });
      liveRows().forEach(function (b) { var e = by[b.getAttribute("data-id")], w = b.querySelector(".w"); if (e && w) w.textContent = span(Date.now() - Date.parse(e.created_at)); });
      return;
    }
    var focused = document.activeElement, back = focused && focused.closest && focused.closest("#live-feed") ? focused.getAttribute("data-id") : null;
    if (seen) rows.forEach(function (e) { if (!seen[e.id]) fresh[e.id] = true; });
    $("#live-feed").innerHTML = '<div>' + (rows.map(function (e) { return evRow(e, fresh[e.id]); }).join("") || '<p class="home-quiet">No package moved lately.</p>') + '</div>';
    seen = {}; rows.forEach(function (e) { seen[e.id] = true; });
    shownFeed = key;
    // A line that had the focus has it again when it is still there.
    var again = back ? liveRows().filter(function (b) { return b.getAttribute("data-id") === back; })[0] : null;
    if (again) again.focus({ preventScroll: true });
    fit();
  }
  $("#live-feed").addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest(".home-ev[data-id]") : null; if (!b) return;
    var id = b.getAttribute("data-id"); opened[id] = !opened[id];
    b.classList.toggle("open", opened[id]); b.setAttribute("aria-expanded", String(opened[id]));
    fit();
  });
  if (window.ResizeObserver) new ResizeObserver(fit).observe($("#live-feed"));

  // ---- New in the pool: what the rings' newest releases brought, added or upgraded, from the diff of each against its parent — the address the Packages page asks for stable's, so the two share the edge's copy; each card says how long ago. The page asks only about releases retention keeps whole (KEEP_RELEASES, db.ts: the newest of each ring), so a diff is always folded from the newer release's deltas and the older one's counts, and never rebuilds a release: each ring's head, and the release before it when that one's own parent is still kept, as far as the stats' latest releases show the ring. A release older than a week, or the first of its ring, adds nothing. So the section is the newest releases' arrivals, not the week's: older diffs would rebuild what retention pruned.
  var KEEP_RELEASES = __KEEP__, asked = {}, shownKey = null, WORDS = [], typing = null;
  function releasesOf(d, r) {
    var head = headOf(d, r);
    if (!head || !head.parent_id) return [];
    var mine = (d.releases || []).filter(function (x) { return x.ring === r; }).sort(function (a, b) { return b.seq - a.seq; }).slice(0, KEEP_RELEASES);
    var ids = mine.map(function (x) { return x.id; }), before = mine.filter(function (x) { return x.id === head.parent_id; })[0], out = [head];
    // Every kept release of the ring in sight and the head's parent not among them (two releases made from one head at once): nothing is asked.
    if (mine.length === KEEP_RELEASES && !before) return [];
    if (mine.length === KEEP_RELEASES && before.parent_id && ids.indexOf(before.parent_id) >= 0) out.push(before);
    return out.filter(function (x) { return Date.now() - Date.parse(x.created_at) < WEEK_MS; });
  }
  function diffOf(rel) {
    var u = "/api/v1/releases/" + rel.ring + "/diff?from=" + rel.parent_id + "&to=" + rel.id;
    if (!asked[u]) asked[u] = api("GET", u).catch(function (e) { delete asked[u]; throw e; });
    return asked[u].then(function (df) { return { rel: rel, df: df }; }, function (e) { return { rel: rel, error: e }; });
  }
  // The heads first; the releases before them only when the heads brought fewer than twelve names.
  function arrivals(d) {
    var rings = PROMISED_RINGS.map(function (r) { return releasesOf(d, r); }).filter(function (l) { return l.length; });
    var key = rings.map(function (l) { return l.map(function (x) { return x.id; }).join("+"); }).join(",");
    if (key === shownKey) return;
    shownKey = key;
    if (!rings.length) { $("#pool-new").innerHTML = quiet("No ring has a new release this week."); return; }
    Promise.all(rings.map(function (l) { return diffOf(l[0]); })).then(function (heads) {
      if (key !== shownKey) return;
      var failed = heads.filter(function (g) { return g.error; });
      if (failed.length === heads.length) { shownKey = null; $("#pool-new").innerHTML = quiet(noAnswer("rings' latest changes", failed[0].error)); return; }
      if (drawNew(heads.map(function (g) { return [g]; })) >= CARDS || !rings.some(function (l) { return l.length > 1; })) return;
      Promise.all(rings.map(function (l) { return l[1] ? diffOf(l[1]) : null; })).then(function (older) {
        if (key === shownKey) drawNew(heads.map(function (g, i) { return older[i] ? [g, older[i]] : [g]; }));
      });
    });
  }
  // One card per name, its architectures together, the newest release of its ring first; within a release the sources in turn, so forty rebuilds from one source do not hide the rest; the rings in turn, most stable first, until twelve; newest first.
  function drawNew(groups) {
    var lists = groups.map(function (gs) {
      var list = [], had = {};
      gs.forEach(function (g) {
        if (g.error) return;
        var df = g.df || {}, by = {}, order = [], bySource = {}, sources = [];
        (df.added || []).map(function (p) { return { name: p.name, arch: p.arch, version: p.version, source: p.source }; })
          .concat((df.upgraded || []).map(function (p) { return { name: p.name, arch: p.arch, version: p.to, source: p.source }; }))
          .forEach(function (p) {
            if (had[p.name]) return;
            var c = by[p.name];
            if (!c) { c = by[p.name] = { name: p.name, version: p.version, source: p.source, arches: [], ring: g.rel.ring, at: g.rel.created_at }; order.push(c); }
            if (c.arches.indexOf(p.arch) < 0) c.arches.push(p.arch);
          });
        order.forEach(function (c) { had[c.name] = true; if (!bySource[c.source]) { bySource[c.source] = []; sources.push(c.source); } bySource[c.source].push(c); });
        for (var i = 0, n = list.length; list.length < n + order.length; i++) sources.forEach(function (s) { if (bySource[s][i]) list.push(bySource[s][i]); });
      });
      return list;
    });
    var picked = [], taken = {}, next = lists.map(function () { return 0; }), more = true;
    while (more && picked.length < CARDS) {
      more = false;
      lists.forEach(function (list, i) {
        while (next[i] < list.length && taken[list[next[i]].name]) next[i]++;
        if (next[i] < list.length && picked.length < CARDS) { taken[list[next[i]].name] = true; picked.push(list[next[i]]); next[i]++; more = true; }
      });
    }
    picked.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
    $("#pool-new").innerHTML = picked.map(function (c) {
      var arch = c.arches.length > 1 && ARCHES.every(function (a) { return c.arches.indexOf(a) >= 0; }) ? "both" : c.arches.join(" · ");
      return '<a class="op-card ' + c.ring + ' home-pkg" href="' + esc(pkgHref(c.name, c.ring, c.arches[0])) + '" title="' + esc(c.name + " " + c.version + " reached " + c.ring + " " + ago(c.at)) + '"><span class="h"><b>' + esc(c.name) + '</b><span>' + span(Date.now() - Date.parse(c.at)) + '</span></span><span class="v">' + esc(c.version) + '</span><span class="c"><span class="op-ring ' + c.ring + '">' + c.ring + '</span><span class="from">' + esc(sourceName(c.source, c.arches[0])) + '</span><span class="a">' + esc(arch) + '</span></span></a>';
    }).join("") || quiet("Nothing new in the rings' latest releases.");
    offer(picked.map(function (c) { return c.name; }));
    return picked.length;
  }

  // ---- the box's placeholder: the pool's count, and a name the page just drew in New in the pool — a package a ring serves, never a request — typed out a letter at a time, or still for a reader who asked for less motion. The typing waits, writing nothing, while the box holds a query or the tab is hidden.
  function placeholder(word) { box.placeholder = "Search " + (total ? num(total) + " " : "the pool's ") + "packages" + (word ? " · try " + word : ""); }
  function offer(names) {
    names.forEach(function (n) { if (WORDS.indexOf(n) < 0 && WORDS.length < 8) WORDS.push(n); });
    if (!WORDS.length) return placeholder("");
    if (STILL) return placeholder(WORDS[0]);
    if (typing) return;
    var wi = 0, ci = 0, dir = 1;
    (function type() {
      if (box.value || document.hidden) { typing = setTimeout(type, 1000); return; }
      var w = WORDS[wi % WORDS.length], wait = dir > 0 ? 90 : 40;
      ci += dir;
      if (ci >= w.length) { dir = -1; wait = 1600; } else if (ci <= 0) { dir = 1; wi++; wait = 400; }
      placeholder(w.slice(0, Math.max(0, ci)) + "▌");
      typing = setTimeout(type, wait);
    })();
  }

  // ---- Requested: what people asked the factory for and a maintainer let through (the registry's own landed: approved, or in the pool), newest first — the registry the Packages page reads, once per page. The pool counts no downloads and keeps no searches, so a request is the one measure of interest it has; a name only asked for, rejected or blocked stays off the front page, since anyone signed in may ask for any name.
  var registry = null;
  function registryRows() {
    if (!registry) registry = api("GET", "/api/v1/factory/packages").then(function (d) { return d.packages || []; }, function (e) { registry = null; throw e; });
    return registry;
  }
  registryRows().then(function (rows) {
    var wanted = rows.filter(function (p) { return p.landed && !p.blocked_at; }).sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); }).slice(0, 5);
    if (!wanted.length) return;
    $("#pool-asked").innerHTML = '<span>Requested</span>' + wanted.map(function (p) { return '<button type="button" class="op-chip" data-name="' + esc(p.name) + '">' + esc(p.name) + '</button>'; }).join("");
    $("#pool-asked").hidden = false;
  }, function () {});
  $("#pool-asked").addEventListener("click", function (ev) { var b = ev.target.closest ? ev.target.closest("button[data-name]") : null; if (b) { box.value = b.getAttribute("data-name"); box.focus(); lookFor(box.value.trim().toLowerCase()); } });

  // ---- the search box: as you type, the first matches in stable, each its package page; Enter is the whole search, on the Packages page. It asks what the ⌘K menu asks, at the very same address and in lower case, so the two share the edge's copy: nothing below two characters, one search per pause (200 ms). Stable on the first architecture first; when that finds nothing, the same search on the others (an Asahi or a Raspberry Pi package is on aarch64 alone), at the same address shape and as cached. A pacman name (the request's own rule, request.ts PKGNAME, spliced in) no row is named for may still be a package — only in edge or the lab, reserved by a request — so it is looked up at the package page's own address on each architecture, then among the factory's names, and drawn first where it is, as the menu draws it; "Request it" is offered only for a name found nowhere, beside the whole search, and the Factory's request card takes the name from ?name=. What the rows say is said to a screen reader too.
  var timer = null, seq = 0, places = {};
  function closeResults() { out.hidden = true; out.innerHTML = ""; $("#pool-said").textContent = ""; }
  function showResults(html, words) { out.innerHTML = html; out.hidden = false; $("#pool-said").textContent = words; }
  function rowHtml(name, desc, where, href) { return '<a class="r" href="' + esc(href) + '"><b>' + esc(name) + '</b><span class="d">' + esc(desc || "") + '</span><span class="o">' + esc(where) + '</span></a>'; }
  function search(term, arch) {
    return fetch("/api/v1/search?q=" + encodeURIComponent(term) + "&ring=stable&arch=" + arch + "&limit=9").then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).then(function (d) { return d.packages || []; });
  }
  // Where a name the search did not find is: in a ring on some architecture (the package page's own answer, the lab included, says which), else among the factory's names — a request, which no ring serves yet, or a blocked one.
  function whereIs(term) {
    if (places[term] !== undefined) return Promise.resolve(places[term]);
    var i = 0;
    function onArch() {
      if (i >= ARCHES.length) return registryRows().then(function (rows) {
        var p = rows.filter(function (x) { return x.name === term; })[0];
        return p ? { name: term, arch: (p.arches || [])[0] || ARCHES[0], ring: "stable", source: "factory", where: p.blocked_at ? "blocked" : "requested", description: p.description } : false;
      });
      var arch = ARCHES[i++];
      return fetch("/api/v1/package/" + term + "?ring=stable&arch=" + arch).then(function (r) {
        if (r.status === 404) return onArch();
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json().then(function (d) { return { name: term, arch: arch, ring: d.shown_ring, source: (d.package || {}).source, where: d.shown_ring === "lab" ? "lab" : "", description: (d.manifest || {}).description }; });
      });
    }
    return onArch().then(function (found) { places[term] = found; return found; });
  }
  function drawFound(term, rows, found) {
    var first = found ? [rowHtml(found.name, found.description, fromWhere(found.source, found.arch, found.where), pkgHref(found.name, found.ring, found.arch))] : [];
    var list = first.concat(rows.slice(0, SHOWN - first.length).map(function (p) { return rowHtml(p.name, p.description, fromWhere(p.source, p.repo_arch), pkgHref(p.name, "stable", p.repo_arch)); }));
    var whole = '<a href="/packages?q=' + encodeURIComponent(term) + '">Search all packages →</a>';
    if (list.length) {
      var cut = rows.length + first.length > list.length;
      return showResults(list.join("") + (cut ? '<a class="all" href="/packages?q=' + encodeURIComponent(term) + '">All results for “' + esc(term) + '” →</a>' : ""), list.length + (list.length === 1 ? " package" : " packages") + (cut ? ", and more on the Packages page" : ""));
    }
    if (!NAME.test(term)) return showResults('<div class="none"><span>Nothing in stable matches “' + esc(term) + '”.</span><span class="go">' + whole + '</span></div>', "Nothing in stable matches “" + term + "”");
    showResults('<div class="none"><span>No “' + esc(term) + '” yet.</span><span class="go">' + whole + '<a href="' + "/factory?name=" + encodeURIComponent(term) + "#request" + '">Request it →</a></span></div>', "No “" + term + "” yet: you can request it");
  }
  function lookFor(term) {
    var my = ++seq;
    if (term.length < 2) { closeResults(); return; }
    search(term, ARCHES[0]).then(function (rows) {
      return rows.length ? rows : Promise.all(ARCHES.slice(1).map(function (a) { return search(term, a); })).then(function (l) { return [].concat.apply([], l); });
    }).then(function (rows) {
      if (my !== seq) return;
      if (!NAME.test(term) || rows.some(function (p) { return p.name === term; })) return drawFound(term, rows, null);
      return whereIs(term).then(function (found) { if (my === seq) drawFound(term, rows, found); });
    }).catch(function (e) { if (my === seq) { var text = "the package search did not answer: " + errorText(e); showResults('<div class="none"><span>' + esc(text) + '</span></div>', text); } });
  }
  // Every keystroke makes an answer still on its way for an earlier term stale; the next pause asks again.
  box.addEventListener("input", function () {
    clearTimeout(timer);
    seq++;
    var term = box.value.trim().toLowerCase();
    if (term.length < 2) { closeResults(); return; }
    timer = setTimeout(function () { if (box.value.trim().toLowerCase() === term) lookFor(term); }, 200);
  });
  // ↓ from the box walks the rows, ↑ back to it; Esc closes them and keeps the box.
  box.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") closeResults();
    else if (ev.key === "ArrowDown" && !out.hidden) { var first = out.querySelector("a"); if (first) { ev.preventDefault(); first.focus(); } }
  });
  out.addEventListener("keydown", function (ev) {
    var links = [].slice.call(out.querySelectorAll("a")), at = links.indexOf(document.activeElement);
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); var to = at + (ev.key === "ArrowDown" ? 1 : -1); if (to < 0) box.focus(); else if (links[to]) links[to].focus(); }
    else if (ev.key === "Escape") { closeResults(); box.focus(); }
  });
  box.addEventListener("focus", function () { if (out.innerHTML) out.hidden = false; });
  document.addEventListener("click", function (ev) { if (!out.hidden && !out.contains(ev.target) && ev.target !== box) out.hidden = true; });

  drawSetup();
  liveStats(function (d) { numbers(d); chain(d); ringNumbers(d); feed(d); arrivals(d); if (!typing) placeholder(WORDS[0]); }, 60000, statsDown);
`;

export function overviewHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/",
    title: "omarchy-pool",
    description: "Arch, Arch Linux ARM, Omarchy and Asahi packages for Omarchy, tested before they reach you: one pool, three rings, rolled back automatically.",
    active: "pool",
    kit: true,
    css: CSS,
    body: BODY,
    script: SCRIPT.replace("__SOURCES__", () => JSON.stringify(SOURCES)).replace("__ORIGIN__", () => JSON.stringify(ORIGIN)).replace("__KEEP__", String(KEEP_RELEASES)).replace("__NAME__", () => String(PKGNAME)),
    poolUrl,
    version,
  });
}

/**
 * What / is made of. The door is public end to end: nothing on it changes
 * with the role, every read is an anonymous GET, and there is no act. Most
 * of it draws from /api/v1/stats, so each unit declares that read with the
 * fields it takes from it; the rings of that answer come in RINGS order
 * (edge, rc, stable, lab), so `rings.2` is stable, the ring the fixture
 * released twice — its head's diff against its parent is what the
 * fixture's stable release changed.
 */
export const OVERVIEW_COMPONENTS = (F: Fixture): Component[] => {
  const stats = "/api/v1/stats";
  return [
    {
      id: "pool.hero",
      page: "/",
      anchor: ['<section class="home-top">', '<p class="op-eyebrow">For Omarchy users</p>', 'class="op-hero">Arch, Arch Linux ARM, Omarchy and Asahi packages, tested before they reach you</h1>'],
      visible: EVERYONE,
    },
    {
      // The box / focuses (aria-keyshortcuts="/", the ⌘K menu's hook: layout.ts GO_MENU), and the one search the menu asks too, at this very address and in lower case, so the two share the edge's copy — on the other architectures at the same address shape when the first finds nothing; a pacman name no row is named for is looked up at the package page's own address, then among the factory's names, and drawn first where it is; Request is the menu's (the Factory's request card with the name, #246), offered beside the whole search only for a name found nowhere; what the rows say is said to a screen reader too.
      id: "pool.search",
      page: "/",
      anchor: ['<form class="home-search" action="/packages" method="get" role="search">', 'name="q"', 'id="pool-q"', 'aria-keyshortcuts="/"', 'id="pool-results"', '<span class="home-said" id="pool-said" role="status"></span>'],
      script: ['"/api/v1/search?q=" + encodeURIComponent(term) + "&ring=stable&arch=" + arch + "&limit=9"', "search(term, ARCHES[0])", "ARCHES.slice(1).map(function (a) { return search(term, a); })", "box.value.trim().toLowerCase()", 'pkgHref(p.name, "stable", p.repo_arch)', '"/api/v1/package/" + term + "?ring=stable&arch=" + arch', "d.shown_ring", "NAME.test(term)", "rows.some(function (p) { return p.name === term; })", '"/factory?name=" + encodeURIComponent(term) + "#request"', "Request it →", "Search all packages →", "fromWhere(p.source, p.repo_arch)", '"factory · not in a ring yet"', '$("#pool-said").textContent'],
      reads: [
        { path: `/api/v1/search?q=${F.pkg}&ring=stable&arch=${F.arch}&limit=9`, fields: ["packages", "packages.0.name", "packages.0.source", "packages.0.repo_arch", "packages.0.description"] },
        { path: `/api/v1/search?q=${F.pkg}&ring=stable&arch=aarch64&limit=9`, fields: ["packages"] },
        { path: `/api/v1/package/${F.pkg}?ring=stable&arch=${F.arch}`, fields: ["name", "shown_ring", "package.source", "manifest.description"] },
        { path: `/api/v1/package/zzfoo?ring=stable&arch=${F.arch}`, status: 404 },
        { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.name", "packages.0.arches", "packages.0.blocked_at", "packages.0.description"] },
        { path: "/factory?name=zzfoo", json: false },
        { path: `/packages?q=${F.pkg}`, json: false },
      ],
      visible: EVERYONE,
    },
    {
      // What people asked the factory for and a maintainer let through (the registry's landed), none blocked, newest first: the registry the Packages page and the menu read.
      id: "pool.requested",
      page: "/",
      anchor: ['<div class="home-asked" id="pool-asked" hidden></div>'],
      script: ['api("GET", "/api/v1/factory/packages")', "p.landed && !p.blocked_at", "String(b.created_at).localeCompare(String(a.created_at))", "<span>Requested</span>", 'class="op-chip" data-name="'],
      reads: [{ path: "/api/v1/factory/packages", fields: ["packages", "packages.0.name", "packages.0.created_at", "packages.0.landed", "packages.0.blocked_at"] }],
      visible: EVERYONE,
    },
    {
      // The four numbers, each a link to the page that proves it, counted up by the kit the first time they land; "—" and "did not answer" when the stats never answered (the poll's failure, liveStats' third argument).
      id: "pool.tiles",
      page: "/",
      anchor: ['<div class="op-stats home-stats" id="pool-stats">', 'id="n-pkgs"', 'id="s-pkgs"', 'id="n-edge"', 'id="n-rel"', 'id="n-src"', 'href="/status?kind=sync#journal"', 'href="/diff?ring=stable"'],
      script: ["countUp(el, n, fmt)", "(d.pool || {}).names", "imports_daily", 'newest(d.latest, "sync")', 'latest(d.latest || [], "health", "stable", a)', "HEALTH_WORD[worst]", "rows.some(lateSync)", '"all in sync"', "function statsDown(e)", 'noAnswer("pool\'s stats", e)', "did not answer</span>", "60000, statsDown)"],
      reads: [
        {
          path: stats,
          fields: [
            "pool.names", "series.imports_daily.0.day", "series.imports_daily.0.packages", "latest",
            "rings.2.ring", "rings.2.release.seq", "rings.2.release.created_at",
            "coverage.0.source", "coverage.0.arch", "coverage.0.indexed", "coverage.0.last_sync", "coverage.0.late",
          ],
        },
        { path: "/diff?ring=stable", json: false },
        { path: "/status", json: false },
      ],
      visible: EVERYONE,
    },
    {
      // The chain from the sources to your machine, drawn by the server from meta.ts's upstreams and rings, its numbers the stats'.
      id: "pool.flow",
      page: "/",
      anchor: ['<h2 class="op-label" id="flow-h">From upstream to your machine</h2>', 'href="/docs/how-it-works">The full story →', 'id="pool-sources"', "<span>Arch Linux ARM</span>", 'id="fl-pool"', 'id="fl-edge"', 'id="fl-rc"', 'id="fl-stable"', "<b>your Omarchy</b>"],
      script: ['$("#pool-sources")', "sourcesOf(d)", "c.indexed", '"#fl-" + r', '" verified"'],
      reads: [{ path: stats, fields: ["pool.names", "coverage", "coverage.0.indexed", "rings.0.release", "rings.2.release.seq"] }],
      visible: EVERYONE,
    },
    {
      // Point pacman at a ring: the ⌘K menu's "Set up the pool" lands here (#get-started). The three rings a reader points pacman at are the shell's PROMISED_RINGS; the command pipes /setup into sudo, and the script is a link away to read first.
      id: "pool.setup",
      page: "/",
      anchor: ['id="get-started"', 'id="setup-tabs" role="tablist"', 'id="tab-command"', 'id="tab-agent"', 'id="pick-ring"', 'data-ring="stable"', 'data-ring="rc"', 'data-ring="edge"', 'id="ring-line"', 'id="setup-well"', 'class="op-copy" data-op-copy=""', '<a href="/setup">Read the script first →</a>'],
      script: ['PROMISED_RINGS.indexOf(q.get("ring"))', "/setup | sudo bash -s -- --ring ", "RINGS_TEXT[ring].title", '"copy prompt"', 'ev.key !== "ArrowLeft"', "if (now === drawnSetup) return;", "ringNumbers(d)"],
      reads: [
        { path: "/setup", json: false },
        { path: stats, fields: ["rings.0.release.seq", "rings.1.ring", "rings.2.release.seq"] },
      ],
      visible: EVERYONE,
    },
    {
      // The agents the prompt is written for: the kit's marks, named for a screen reader and on hover.
      id: "pool.agents",
      page: "/",
      anchor: ['id="setup-agents" hidden', '<span>Works with</span>', 'class="op-b op-b-claude-color"', 'aria-label="Claude Code"', 'aria-label="Meta"'],
      script: ['$("#setup-agents").hidden = !agent'],
      visible: EVERYONE,
    },
    {
      id: "pool.own",
      page: "/",
      anchor: ['<details class="home-own">', "Bring your own package", '<a class="op-btn primary" href="/factory">Request a package</a>', '<a class="op-btn" href="/agents">Ask your agent</a>'],
      reads: [{ path: "/factory", json: false }, { path: "/agents", json: false }],
      visible: EVERYONE,
    },
    {
      // Live: packages moving through the pool, from the journal's newest lines and its latest of each kind in the stats, a line that arrived since the last poll lit for a moment, the day's syncs counted by the stats' daily series; Full journal is Status's section.
      id: "pool.live",
      page: "/",
      anchor: ['id="live-feed"', 'id="live-count"', '<a class="home-more" href="/status#journal">Full journal →</a>', 'class="op-live-dot"'],
      script: ['$("#live-feed").innerHTML', 'MOVES = ["sync", "promote", "fast-track", "rollback", "publish"]', "(d.events || []).concat(d.latest || [])", "moves(d).slice(0, 8)", '" op-fresh"', "e.summary", '"synced → edge"', '"built in the factory"', '" syncs today"', "key === shownFeed", "new ResizeObserver(fit)"],
      reads: [
        { path: stats, fields: ["events", "events.0.id", "events.0.kind", "events.0.status", "events.0.summary", "events.0.created_at", "events.0.ring", "events.0.payload", "latest", "latest.0.id", "latest.0.kind", "series.imports_daily.0.day", "series.imports_daily.0.runs"] },
        { path: "/status", json: false },
      ],
      visible: EVERYONE,
    },
    {
      // New in the pool: each ring's newest release against its parent, at the address the Packages page reads stable's.
      id: "pool.new",
      page: "/",
      anchor: ['<h2 class="op-label" id="new-h">New in the pool</h2>', 'id="pool-new"', 'href="/packages">All packages →'],
      script: ['"/api/v1/releases/" + rel.ring + "/diff?from=" + rel.parent_id + "&to=" + rel.id', `var KEEP_RELEASES = ${KEEP_RELEASES}`, "if (!head || !head.parent_id) return [];", "Date.now() - Date.parse(x.created_at) < WEEK_MS", "df.added", "df.upgraded", "pkgHref(c.name, c.ring, c.arches[0])", 'noAnswer("rings\' latest changes"'],
      reads: [
        { path: stats, fields: ["rings.2.release.id", "rings.2.release.parent_id", "rings.2.release.created_at", "releases", "releases.0.id", "releases.0.ring", "releases.0.seq", "releases.0.parent_id", "releases.0.created_at"] },
        { path: `/api/v1/releases/stable/diff?from=${F.previousRelease}&to=${F.release}`, fields: ["added", "added.0.name", "added.0.arch", "added.0.version", "added.0.source", "upgraded", "upgraded.0.name", "upgraded.0.arch", "upgraded.0.to", "upgraded.0.source"] },
        { path: "/packages", json: false },
      ],
      visible: EVERYONE,
    },
  ];
};
