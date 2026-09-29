/**
 * Status (#248): how the pool is doing, on one page — whether every ring is
 * healthy, each ring's releases, the sources it syncs from and the workers
 * doing the work, the health checks and the rollbacks, the advisories on
 * what a ring serves, and the journal of everything the pool did, with who
 * did it and with which agent. The Pipeline, the Journal and Security were
 * pages of their own until #240 moved their addresses here (index.ts
 * MOVED: /journal lands on #journal, /security on #advisories, their
 * queries kept); this page is what they became, drawn with the v1 kit
 * (pages/kit.ts) after the handoff's design (startScreen = status).
 *
 * What a maintainer could do there is here: roll a ring back, on its card
 * (to the release before its head, unless the head is a rollback) and in
 * its history (to any release the stats carry). The information is the same
 * for everyone and only the actions change (the v1 rule, #238): the buttons
 * are drawn for a maintainer, once the session says so, and for nobody
 * else. Deciding a staged build is Review's, and the Pipeline's copy of its
 * queue went with the Pipeline.
 *
 * The numbers behind all of it — the service check, the pool's jobs, every
 * source's coverage, the charts, the bill — are one section at the end,
 * closed until opened: what the Status page was before #248, kept whole,
 * with the Pipeline's requested packages until the Factory draws them (#246).
 *
 * Every read is an endpoint the dashboard already had, no faster than the
 * old pages read it: the stats every minute (liveStats), the service check
 * every minute, the worker listing every minute (as the Status page read it
 * with each stats poll: a miss reads the tasks table), the requested
 * packages with it while the numbers are open, the rollbacks and the
 * fast-tracks every five minutes (the Pipeline's promotions chart), a
 * journal filter's newest lines once a minute while it is picked (the
 * Journal's pace, and fewer rows: see the journal below), and an advisories
 * report once per ring and architecture looked at (half an hour at the
 * edge; the Pool reads the same address).
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import { CHARTS } from "./charts";
import { lucide } from "./kit";
import { EXPECTED_SOURCES, JOURNAL_KINDS, PROMOTED_RINGS, UPSTREAMS, type RunningVersion } from "../meta";
import { ESTIMATE_CADENCE } from "../cost";
import { RULES } from "../scheduler";
import { RECENT_EVENTS, RING_HISTORY } from "../routes/stats";

/**
 * The Sources card's rows: the projects the pool syncs from, in the
 * handoff's order, each with its repositories as the card names them — a
 * coverage row of the stats (EXPECTED_SOURCES in meta.ts: a source and an
 * architecture) per repository. The factory is a row too; nothing syncs it,
 * it publishes what a maintainer approves. test/status-page.test.ts fails a
 * source added to meta.ts and left out here.
 */
export const SOURCE_PROJECTS: [string, [source: string, arch: string, repo: string][]][] = [
  ["Arch Linux", [["core", "x86_64", "core"], ["extra", "x86_64", "extra"], ["multilib", "x86_64", "multilib"]]],
  ["Arch Linux ARM", [["core", "aarch64", "core"], ["extra", "aarch64", "extra"], ["alarm", "aarch64", "alarm"], ["aur", "aarch64", "aur"]]],
  ["Chaotic", [["chaotic", "x86_64", "chaotic-aur"]]],
  ["Omarchy", [["packages", "x86_64", "OPR"], ["packages", "aarch64", "OPR"]]],
  ["Asahi", [["asahi", "aarch64", "asahi"]]],
  ["Asahi ALARM", [["asahi-alarm", "aarch64", "asahi-alarm"]]],
  ["Factory", [["factory", "x86_64", "the pool"], ["factory", "aarch64", "the pool"]]],
];

/** What the page's script gets of them: each repository with the words its row's tooltip says — what it is, where it is read from, the key its packages verify against. */
function sourcesForScript() {
  return SOURCE_PROJECTS.map(([name, repos]) => ({
    name,
    synced: repos.some(([source]) => source !== "factory"),
    repos: repos.map(([source, arch, repo]) => {
      const e = EXPECTED_SOURCES.find((x) => x.source === source && x.arch === arch);
      return { source, arch, repo, title: e ? `${e.title} · ${e.upstream} · ${UPSTREAMS[e.upstream].keyring}` : `${source} ${arch}` };
    }),
  }));
}

/** The five feeds the security layer matches every run (Security's own list before #248): what the Advisories card counts and names on hover. */
const FEEDS = ["Arch Security Tracker", "Debian Security Tracker", "OSV", "CISA KEV", "EPSS"];

/**
 * The page's own rules, beside the kit's (#239): the handoff's Status —
 * 1120px wide, 40px between sections, square, 1px lines, green the one
 * accent — in the palette's names only, and motion only where the reader
 * did not ask for less (the frame stops every animation then). Served in
 * the head after the kit's sheet (page({ css })), as the other kit pages
 * serve theirs, so a rule here refines a primitive at equal weight.
 */
const CSS = String.raw`
  .st { max-width: calc(var(--content-max) - 2 * var(--gutter)); margin: 12px auto 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--section-gap); }
  .st section { margin: 0; } /* the frame's 44px under a section; the grid's gap is the space between them here */
  .st h2.op-label, .st h3.op-label { margin: 0; font: 400 var(--fs-label)/1.4 var(--font-mono); letter-spacing: var(--tracking-label); }
  .st .st-link, .st-sec-h a { color: var(--green); text-decoration: none; font-size: 12.5px; } .st .st-link:hover, .st-sec-h a:hover { color: var(--text); }
  .st-dim { color: var(--dim); } .st-empty { margin: 0; padding: 14px 16px; font-size: 13px; color: var(--dim); }
  .st-hero { display: flex; flex-wrap: wrap; gap: 32px 40px; align-items: flex-end; }
  .st-hero-t { flex: 1 1 480px; min-width: 0; display: grid; gap: 14px; }
  .st-title { display: flex; align-items: center; gap: 14px; }
  .st-mark { width: 14px; height: 14px; flex: none; background: var(--dim); }
  .st-mark.ok { background: var(--green); } .st-mark.warn { background: var(--amber); } .st-mark.fail { background: var(--red); }
  .st-lede { margin: 0; font-size: 13.5px; color: var(--muted); max-width: 72ch; }
  .st-tiles { flex: 1 1 360px; grid-template-columns: 1fr 1fr; }
  .st-sec { display: grid; gap: 12px; }
  .st-sec-h { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .st-rings { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 12px; }
  .st-ring { padding: 14px 16px; display: grid; gap: 12px; align-content: start; }
  .st-ring.edge { --st-hue: var(--edge); } .st-ring.rc { --st-hue: var(--rc); } .st-ring.stable { --st-hue: var(--stable); }
  .st-ring-h { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .st-ring-t { display: flex; align-items: baseline; gap: 10px; } .st-seq { font-size: 13px; color: var(--dim); }
  .st-health { display: flex; gap: 5px; align-items: center; font-size: 11px; color: var(--dim); } .st-health .op-arch { width: 9px; height: 9px; }
  .st-ring-n { display: flex; gap: 28px; } .st-ring-n > div { display: grid; } .st-ring-n .op-label { font-size: 11px; }
  .st-ring-n b { font: 600 17px/1.35 var(--font-display); font-variant-numeric: tabular-nums; }
  .st-strip { display: grid; gap: 5px; } .st-rs { display: flex; gap: 3px; }
  .st-r { flex: 1; min-width: 0; height: 14px; background: var(--st-hue, var(--dim)); border: 1px solid var(--st-hue, var(--dim)); }
  a.st-r:hover { filter: brightness(1.15); } .st-r.rb { background: var(--red); border-color: var(--red); } .st-r.head { background: transparent; } /* the release served now is hollow, red-edged when it is a rollback */
  .st-r.none { background: transparent; border: 1px dashed var(--line); }
  .st-strip-l { display: flex; justify-content: space-between; gap: 10px; font-size: 11.5px; color: var(--dim); }
  .st-next { display: flex; align-items: center; gap: 8px; min-width: 0; padding-top: 10px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--muted); }
  .st-next > .op-i { color: var(--dim); } .st-next > span { flex: 1; min-width: 0; } /* wrapped, never cut: "stable candidate · 1 of 2 green checks" is one fact */
  .st-next.warn > span { color: var(--amber); } .st-next.fail > span { color: var(--red); }
  .st-wait { margin: 0; font-size: 13px; color: var(--dim); }
  .st .st-rb { flex: none; padding: 3px 10px; font-size: 12px; } .st-acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: -4px; } /* 26px tall: a destructive control keeps the 24px target */
  .st-hist td:nth-child(1), .st-hist td:nth-child(3), .st-hist td:nth-child(6), .st-hist td:nth-child(7) { white-space: nowrap; } .st-hist td:nth-child(7) .st-rb { margin-left: 8px; }
  .st-note { margin: 0; font-size: 12.5px; color: var(--muted); }
  .st-pair { display: flex; flex-wrap: wrap; gap: 16px; align-items: stretch; }
  .st-src { flex: 1 1 560px; } .st-wk { flex: 1 1 360px; display: grid; grid-template-rows: auto 1fr auto; }
  .st-chk { flex: 1 1 520px; } .st-adv { flex: 1 1 400px; display: grid; grid-template-rows: auto auto 1fr auto; grid-template-columns: minmax(0, 1fr); }
  .st-h { display: flex; align-items: center; gap: 10px; color: var(--dim); }
  /* A card's title is a heading (the outline: Releases, Sources, Workers, … each an h2, a fold inside a section an h3), drawn as the kit's card title (.op-card-h > b). */
  .st .st-t { margin: 0; font: 600 15px var(--font-display); color: var(--text); letter-spacing: normal; text-transform: none; }
  .st-scroll { overflow-x: auto; }
  .st .op-table th:first-child, .st .op-table td:first-child { padding-left: 16px; } .st .op-table th:last-child, .st .op-table td:last-child { padding-right: 16px; }
  /* The handoff's columns: the source keeps room for its longest name ("Arch Linux ARM"), the repositories take what the three numbers leave and are cut first. */
  .st-src-t { min-width: 520px; table-layout: fixed; } .st-src-t th:nth-child(1) { width: 168px; } .st-src-t th:nth-child(3) { width: 84px; } .st-src-t th:nth-child(4) { width: 60px; } .st-src-t th:nth-child(5) { width: 92px; }
  .st-src-t td { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .st-src-t td:nth-child(2) { font-size: 12px; color: var(--dim); }
  /* A source that is not on time says so in words under its time, not by colour alone; the repositories under the name are the phone's (the column is the desktop's). */
  .st-src-t .s-when small { display: block; font-size: 11.5px; } .st-src-t .s-repos { display: none; }
  .st-dot { display: inline-block; width: 8px; height: 8px; margin-right: 8px; vertical-align: 1px; background: var(--green); }
  .st-dot.warn { background: var(--amber); } .st-dot.fail { background: var(--red); } .st-dot.run { background: var(--blue); } .st-dot.na { background: transparent; border: 1px dashed var(--dim); }
  .st-src-t .s-plus { color: var(--green); } .st-src-t .s-when { color: var(--dim); } .st-src-t .s-when.run { color: var(--blue); } .st-src-t .s-when.warn { color: var(--amber); } .st-src-t .s-when.fail { color: var(--red); }
  .st-w { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  .st-wbox { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--line); background: var(--bg-deep); }
  .st-wt { display: grid; gap: 5px; min-width: 0; }
  .st-wl { display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); } .st-wl > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st-wj { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .st-wj b { font-weight: 600; } .st-wj a { color: var(--text); text-decoration: none; } .st-wj a:hover { color: var(--green); } .st-wj .st-dim { margin-left: 8px; }
  .st-w.off .st-wj { color: var(--dim); }
  .st-w.notready .st-wj { color: var(--dim); } .st-w.notready .st-wj b { color: var(--red); }
  .st-wbar { position: relative; height: 2px; overflow: hidden; background: var(--line); } .st-wbar i { position: absolute; top: 0; bottom: 0; left: 0; width: 0; }
  .st-w.busy .st-wbar i { width: 100%; background: var(--blue); }
  @media (prefers-reduced-motion: no-preference) { .st-w.busy .st-wbar i { width: 30%; animation: st-run 1.6s linear infinite; } }
  @keyframes st-run { from { left: -30%; } to { left: 100%; } }
  .st-ini { display: inline-grid; place-items: center; width: 16px; height: 16px; background: var(--panel-2); color: var(--muted); font: 700 8px/1 var(--font-mono); }
  .st-pool { display: inline-grid; place-items: center; width: 16px; height: 16px; flex: none; background: var(--green); color: var(--green-ink); font-size: 9px; font-weight: 700; }
  .st-c { display: grid; grid-template-columns: 34px 62px 64px 14px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--line); font-size: 13px; }
  .st-c > * { min-width: 0; } .st-c .c-ago, .st-c .c-rel { font-size: 12px; color: var(--dim); white-space: nowrap; } .st-c .c-arch { font-size: 12px; color: var(--muted); }
  .st-c .c-d { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); } .st-c.fail .c-d { color: var(--red); }
  .st-c .c-ring.edge { color: var(--edge); } .st-c .c-ring.rc { color: var(--rc); } .st-c .c-ring.stable { color: var(--stable); }
  .st-sev { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1px; background: var(--line); border-bottom: 1px solid var(--line); }
  /* Five cells in a card that shares its row (400px at its narrowest): a label keeps its word whole — "critical" never breaks mid-word. */
  .st-sv { background: var(--panel); padding: 12px 10px; display: grid; gap: 2px; min-width: 0; } .st-sv b { font: 600 22px/1.1 var(--font-display); font-variant-numeric: tabular-nums; }
  .st-sv span { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--dim); white-space: nowrap; }
  .st-top { padding: 12px 16px; display: grid; gap: 9px; align-content: start; }
  .st-x { display: grid; gap: 4px; } .st-x-h { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; min-width: 0; }
  .st-x-h > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .st-x-h a { color: var(--text); text-decoration: none; font-weight: 600; } .st-x-h a:hover { color: var(--green); }
  .st-x-h small { margin-left: 8px; font-size: 12px; color: var(--dim); } .st-x-n { flex: none; font-size: 12px; color: var(--muted); white-space: nowrap; }
  .st-bar { height: 2px; background: var(--line); } .st-bar i { display: block; height: 2px; }
  @media (prefers-reduced-motion: no-preference) { .st-bar i { transition: width 1.2s ease; } }
  .st-adv-f { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--muted); } .st-adv-f > .op-i { color: var(--green); }
  .st-adv-f a { color: var(--muted); text-decoration: none; } .st-adv-f a:hover { color: var(--green); }
  .st-red { color: var(--red); }
  .st-chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .st-chips button { padding: 2px 10px; border: 1px solid var(--line); background: transparent; color: var(--dim); font: 12.5px/1.6 var(--font-mono); cursor: pointer; }
  .st-chips button:hover { color: var(--text); } .st-chips button.on { border-color: var(--green); color: var(--text); }
  /* Keyboard focus is the frame's square green line on everything the page draws (the header's, the kit's tiles): around a link's text, on the edge of a boxed control. */
  .st a:focus-visible, .st button:focus-visible, .st summary:focus-visible, .st input:focus-visible, .st select:focus-visible { outline: 1px solid var(--green); outline-offset: 2px; }
  .st a.op-stat:focus-visible, .st .st-chips button:focus-visible, .st .op-seg button:focus-visible, .st .op-btn:focus-visible, .st summary:focus-visible, .st input:focus-visible, .st select:focus-visible { outline-offset: -1px; }
  .st-j { display: grid; grid-template-columns: 36px 8px 150px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--line); font-size: 13px; }
  .st-j > * { min-width: 0; } .st-j .j-ago { font-size: 12px; color: var(--dim); white-space: nowrap; }
  .st-j .j-sq { width: 8px; height: 8px; background: var(--dim); } .st-j .j-ev { font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st-j .j-what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .st-j .j-what a { color: var(--text); text-decoration: none; } .st-j .j-what a:hover { color: var(--green); }
  .st-j .j-what .j-diff { margin-left: 8px; font-size: 12px; color: var(--green); }
  .st-j .j-who { display: flex; align-items: center; gap: 6px; justify-content: flex-end; font-size: 12px; color: var(--muted); white-space: nowrap; } .st-j .j-who a { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); text-decoration: none; } .st-j .j-who a:hover { color: var(--green); }
  .st-j .j-sq.edge { background: var(--edge); } .st-j .j-ev.edge { color: var(--edge); } .st-j .j-sq.rc { background: var(--rc); } .st-j .j-ev.rc { color: var(--rc); }
  .st-j .j-sq.stable, .st-j .j-sq.ok { background: var(--green); } .st-j .j-ev.stable, .st-j .j-ev.ok { color: var(--green); }
  .st-j .j-sq.warn { background: var(--amber); } .st-j .j-ev.warn { color: var(--amber); } .st-j .j-sq.fail { background: var(--red); } .st-j .j-ev.fail { color: var(--red); }
  .st-jr .op-card-f { justify-content: space-between; }
  details.st-fold > summary { cursor: pointer; list-style: none; } details.st-fold > summary::-webkit-details-marker { display: none; }
  details.st-fold > summary::after { content: "▸"; color: var(--dim); } details.st-fold[open] > summary::after { content: "▾"; }
  details.st-fold:not([open]) > summary { border-bottom: 0; }
  details.st-fold > summary > small { flex: 1; }
  .st-fold-b { padding: 16px; display: grid; gap: 14px; min-width: 0; }
  .st-fold-b .pager { margin: 0; } .st-fold-b .table-wrap { background: var(--panel); }
  .st-picks { display: flex; flex-wrap: wrap; gap: 8px 16px; }
  .st-num h3 { font-size: 15px; margin: 6px 0 0; } .st-num .tiles, .st-num .charts { margin: 0; } .st-num p.sub { margin: 0; font-size: 13px; color: var(--muted); }
  @media (max-width: 640px) {
    .st-j { grid-template-columns: 36px 8px minmax(0, 1fr) auto; row-gap: 2px; } .st-j .j-ev { grid-area: 1 / 3; } .st-j .j-who { grid-area: 1 / 4; } .st-j .j-what { grid-area: 2 / 3 / auto / -1; }
    /* A check's line wraps under its ring: what it says, and a rollback's "#from → #to" beside it. */
    .st-c { grid-template-columns: 30px 50px minmax(0, 1fr) auto; row-gap: 2px; } .st-c .op-mark { justify-self: end; } .st-c .c-d { grid-column: 2 / 4; } .st-c .c-rel { grid-column: 4; justify-self: end; }
    .st-sv { padding: 10px 6px; } .st-sv span { font-size: 10px; letter-spacing: .02em; }
    .st-ring-n { gap: 20px; }
    /* A phone keeps the numbers in view, each under a label it has room for; a source's name wraps, its repositories are a line under it. */
    .st-src-t { min-width: 0; } .st-src-t th:nth-child(2), .st-src-t td:nth-child(2) { display: none; } .st-src-t th, .st-src-t td { padding-left: 8px; padding-right: 8px; }
    .st-src-t th:nth-child(1) { width: auto; } .st-src-t th:nth-child(3) { width: 80px; } .st-src-t th:nth-child(4) { width: 56px; } .st-src-t th:nth-child(5) { width: 96px; }
    .st-src-t td:nth-child(1) { white-space: normal; } .st-src-t .s-repos { display: block; font-size: 11.5px; color: var(--dim); }
  }
`;

const BODY = String.raw`
<div class="st">
  <section class="st-hero" aria-labelledby="headline">
    <div class="st-hero-t">
      <p class="op-eyebrow">Status</p>
      <h1 class="op-hero st-title"><span class="st-mark" id="st-mark" aria-hidden="true"></span><span id="headline">Checking the rings…</span></h1>
      <p class="st-lede" id="st-lede">Every sync, release, check and decision is on the record.</p>
    </div>
    <div class="op-stats st-tiles">
      <a class="op-stat" href="#sources"><span class="k">Last sync</span><b class="n" id="t-sync-n">—</b><span class="s" id="t-sync-s">&nbsp;</span></a>
      <a class="op-stat" href="#checks"><span class="k">Health checks</span><b class="n" id="t-checks-n">—</b><span class="s" id="t-checks-s">today</span></a>
      <a class="op-stat" href="#checks"><span class="k">Rollbacks</span><b class="n" id="t-rollbacks-n">—</b><span class="s" id="t-rollbacks-s">this month</span></a>
      <a class="op-stat" href="#advisories"><span class="k">Open advisories</span><b class="n" id="t-adv-n">—</b><span class="s" id="t-adv-s">&nbsp;</span></a>
    </div>
  </section>

  <section class="st-sec" id="releases" aria-labelledby="releases-h">
    <div class="st-sec-h"><h2 class="op-label" id="releases-h">Releases</h2><a href="/diff">What stable last changed →</a></div>
    <div class="st-rings" id="st-rings">${PROMOTED_RINGS.map((ring) => `<article class="op-card ${ring} st-ring"><div class="st-ring-h"><span class="st-ring-t"><b class="op-ring-name ${ring}">${ring}</b></span></div><p class="st-wait">Loading</p></article>`).join("")}</div>
    <p class="st-note" id="rb-state" hidden></p>
    <details class="op-card st-fold" id="history">
      <summary class="op-card-h"><h3 class="st-t">Ring history</h3><small>the last ${RING_HISTORY} releases of each ring and what each changed</small></summary>
      <div class="st-fold-b"><div class="table-wrap"><table class="op-table st-hist" id="history-table"><thead><tr><th>Release</th><th>Ring</th><th class="num">Packages</th><th>From</th><th>Note</th><th>When</th><th></th></tr></thead><tbody></tbody></table></div></div>
    </details>
  </section>

  <div class="st-pair">
    <section class="op-card st-src" id="sources" aria-labelledby="sources-h">
      <div class="op-card-h"><span class="st-h">${lucide("refresh-cw", 16)}<h2 class="st-t" id="sources-h">Sources</h2></span><small>signatures checked against each project's key</small></div>
      <div class="st-scroll"><table class="op-table st-src-t"><thead><tr><th>Source</th><th>Repos</th><th class="num">Packages</th><th class="num">Today</th><th class="num">Synced</th></tr></thead><tbody id="sources-rows"></tbody></table></div>
    </section>
    <section class="op-card st-wk" id="workers" aria-labelledby="workers-h">
      <div class="op-card-h"><span class="st-h">${lucide("cpu", 16)}<h2 class="st-t" id="workers-h">Workers</h2></span><small id="workers-busy"></small></div>
      <div id="workers-list"></div>
      <div class="op-card-f"><span class="st-note" id="workers-note"></span><a class="st-link" href="/workers">Every worker →</a></div>
    </section>
  </div>

  <div class="st-pair">
    <section class="op-card st-chk" id="checks" aria-labelledby="checks-h">
      <div class="op-card-h"><span class="st-h">${lucide("heart-pulse", 16)}<h2 class="st-t" id="checks-h">Health checks &amp; rollbacks</h2></span><small>green checks promote · a red one rolls back</small></div>
      <div id="checks-list"></div>
    </section>
    <section class="op-card st-adv" id="advisories" aria-labelledby="advisories-h">
      <div class="op-card-h"><span class="st-h">${lucide("shield", 16)}<h2 class="st-t" id="advisories-h">Advisories</h2></span><small id="adv-note"></small></div>
      <div class="st-sev" id="adv-sev"></div>
      <div class="st-top"><h3 class="op-label">Most exposure</h3><div id="adv-top"></div></div>
      <div class="st-adv-f">${lucide("zap", 13)}<a id="adv-fast" href="/status?kind=fast-track#journal">&nbsp;</a></div>
    </section>
  </div>

  <details class="op-card st-fold" id="advisory-list">
    <summary class="op-card-h"><h2 class="st-t">Every open advisory</h2><small id="adv-list-note">by ring and architecture, with how sure each match is</small></summary>
    <div class="st-fold-b">
      <div class="st-picks"><div class="op-seg" id="pick-ring" role="group" aria-label="Ring"></div><div class="op-seg" id="pick-arch" role="group" aria-label="Architecture"></div><div class="op-seg" id="pick-conf" role="group" aria-label="Confidence"></div></div>
      <p class="st-note" id="updated"></p>
      <div class="table-wrap"><table class="op-table" id="vuln"><thead><tr><th>Severity</th><th>Package</th><th>Version</th><th>Advisories</th><th>Confidence</th><th>Exposes</th><th>Fixed in</th></tr></thead><tbody></tbody></table></div>
      <p class="st-note"><b>exact</b>: the tracker knows this distribution's version, or the build information names the embedded module's version. <b>name-version</b>: a newer version upstream fixes it. <b>name-only</b>: still open upstream, no version to compare. <b>Fixed in</b>: rings already serving a version with no open advisory. <a class="st-link" href="/docs/security">The feeds and the confidences, explained →</a></p>
    </div>
  </details>

  <section class="op-card st-jr" id="journal" aria-labelledby="journal-h">
    <div class="op-card-h"><span class="st-h">${lucide("scroll-text", 16)}<h2 class="st-t" id="journal-h">Journal</h2><span class="op-live-dot" title="live"></span></span><div class="st-chips" id="journal-chips" role="group" aria-label="Show in the journal"></div></div>
    <div id="journal-list"></div>
    <div class="op-card-f"><span class="st-note" id="journal-count"></span><button type="button" class="op-btn" id="journal-more" hidden>Show more</button></div>
  </section>

  <details class="op-card st-fold st-num" id="numbers">
    <summary class="op-card-h"><span class="st-h">${lucide("activity", 16)}<h2 class="st-t">The numbers</h2></span><small>the service, the pool's jobs, every source's coverage, the charts and the bill</small></summary>
    <div class="st-fold-b">
      <h3>Service</h3>
      <p class="sub">Measured now by the API: whether it reaches the index and the pool.</p>
      <div class="svc" id="service"></div>
      <h3>The pipeline, in numbers</h3>
      <p class="sub">The pool's jobs this week — what ran, what failed, what waits — one count for the tiles, the charts and the table.</p>
      <div class="tiles" id="systiles"></div>
      <div class="charts">
        <div class="chart"><h3>Pool growth <span>7 days</span></h3><div class="sub">bytes stored once, from the metrics snapshots</div><div id="c-pool"></div></div>
        <div class="chart"><h3>Imports per day <span>14 days</span></h3><div class="sub">packages brought into the pool by the sync runs</div><div id="c-imports"></div></div>
        <div class="chart"><h3>Health <span>14 days</span></h3><div class="sub">worst result per day, per ring and architecture</div><div id="c-health"></div></div>
        <div class="chart"><h3>Sync throughput <span>last runs</span></h3><div class="sub">MB/s per sync run, one worker each</div><div id="c-sync"></div></div>
        <div class="chart"><h3>Worker minutes <span>per day</span></h3><div class="sub">time the project's workers spent on pool jobs</div><div id="c-minutes"></div></div>
        <div class="chart"><h3>Pool jobs <span>7 days</span></h3><div class="sub">sync, promote, health, gc pulled by workers: done, failed, waiting</div><div id="c-jobs"></div></div>
        <div class="chart"><h3>Factory builds <span>14 days</span></h3><div class="sub">per day: contributors' builds staged, the project's published, failed</div><div id="c-builds"></div></div>
      </div>
      <div class="table-wrap"><table id="workflows"><thead><tr><th>Job</th><th>Last</th><th class="num">Runs 7d</th><th class="num">Failed</th><th class="num">Waiting</th><th class="num">Minutes 7d</th></tr></thead><tbody></tbody></table></div>
      <h3>Jobs and builds</h3>
      <p class="sub">Leased first, then queued, then the latest finished; each row says what it did.</p>
      <div class="table-wrap"><table id="tasks"><thead><tr><th>#</th><th>Package</th><th>Arch</th><th>Status</th><th>Reason</th><th>Worker</th><th>Took</th><th>Result</th></tr></thead><tbody></tbody></table></div>
      <h3>Coverage</h3>
      <p class="sub">What upstream serves and what <code>edge</code> and <code>stable</code> pin; a source is late after <span id="late-after">…</span> hours without a sync.</p>
      <div class="table-wrap"><table id="coverage"><thead><tr><th>Source</th><th>Arch</th><th class="num">Upstream</th><th class="num">In edge</th><th class="num">Missing</th><th class="num">In stable</th><th>Progress</th><th class="num">Size</th><th>Last sync</th></tr></thead><tbody></tbody></table></div>
      <p class="sub" id="provenance" hidden></p>
      <p class="sub" id="any" hidden></p>
      <h3>Requested packages</h3>
      <p class="sub">Every package a contributor asked for, its request signed on the record, and where it stands.</p>
      <p class="st-note" id="registry-note"></p>
      <div class="table-wrap" id="registry-wrap" hidden><table id="registry"><thead><tr><th>Package</th><th>Project</th><th>Owner</th><th>Arches</th><th>Version · licence</th><th>Stage</th><th>Detail</th><th>Updated</th></tr></thead><tbody></tbody></table></div>
    </div>
  </details>
</div>
`;

const SCRIPT = String.raw`
__CHARTS__
  var KINDS = __KINDS__, SOURCES = __SOURCES__, HISTORY = __HISTORY__, PROMOTE_EVERY_MIN = __PROMOTE_EVERY__, FEEDS = __FEEDS__;
  var q = new URLSearchParams(location.search);
  var STATS = null, STATS_DOWN = null, FACTORY = null, SERVICE = null, ROLLBACKS = null, ROLLBACKS_DOWN = null, FAST = null, REPORTS = {}, NUMBERS = false, LANDED = false;
  // The workers as every other page counts them (the shell's workerCounts over the live listing): the Workers card and the numbers' tile read it; WC_DOWN is the reason the listing did not answer, said where the workers would be.
  var WC = null, WC_DOWN = null;
  skeletonRows("#coverage", 9, 5); skeletonRows("#workflows", 7, 4); skeletonTiles("#systiles", 8); skeletonRows("#tasks", 8, 4);
  // The hours a source may go without a sync before it is late: the shell's one number (LATE_MS), the one problemsOf and the Sources card count with.
  $("#late-after").textContent = Math.round(LATE_MS / 3600e3);

  // ---- the hero: all rings healthy, or what is not — worst first: a service check that did not answer, the pool's numbers that did not, a ring whose latest health check failed, rings with nothing to judge yet, syncs falling behind. A ring nobody has checked yet is not called unhealthy, and no ring is called healthy before a check said so.
  function andList(list) { return list.length < 2 ? list.join("") : list.slice(0, -1).join(", ") + " and " + list[list.length - 1]; }
  // A failure's reason as the hero's one sentence: what the API answered (its status, and its error when it said one), or the browser's word for no answer at all.
  function reasonLine(e) {
    var m = errorText(e), code = e && e.status ? "HTTP " + e.status : (/^HTTP \d+/.exec(m) || [""])[0];
    return (code ? "The API answered " + code + (m === code ? "" : ": " + m) : "No answer from the API: " + m) + ".";
  }
  // What keeps the syncs behind, counted as the Last sync tile and the Sources card count — a project, not a coverage row: no sync yet, or none for four hours (they run every three; the shell's problemsOf says when), and the sources not on time.
  function behindOf(d) {
    var why = !newest(d.latest, "sync") ? ["no sync yet"] : problemsOf(d).filter(function (x) { return x.indexOf("no sync for ") === 0; });
    var fams = sourceRows(d).filter(function (s) { return s.synced; }), off = fams.filter(function (s) { return s.state !== "ok" && s.state !== "run"; }).length;
    if (off) why.push(off + " of " + fams.length + " sources not on time");
    return why;
  }
  function drawHero() {
    var d = STATS, why = d ? behindOf(d) : [], sick = [], failedOn = [], released = [], checked = [];
    if (d) PROMISED_RINGS.forEach(function (ring) {
      ARCHES.forEach(function (arch) {
        var h = latest(d.latest, "health", ring, arch); if (!h) return;
        if (checked.indexOf(ring) < 0) checked.push(ring);
        if (h.status === "error") { failedOn.push(ring + " " + (h.source || arch)); if (sick.indexOf(ring) < 0) sick.push(ring); }
      });
      if (ringOf(d, ring).release) released.push(ring);
    });
    var title = "Checking the rings…", tone = "", lede = "Every sync, release, check and decision is on the record.";
    if (SERVICE && SERVICE.down) { title = SERVICE.down; tone = "fail"; lede = SERVICE.why; }
    else if (!d && STATS_DOWN) { title = "The pool's numbers did not answer"; tone = "fail"; lede = STATS_DOWN; }
    else if (sick.length) { title = andList(sick) + " not healthy"; tone = "fail"; }
    else if (d && !checked.length) { title = released.length ? "No health check yet" : "No ring released yet"; }
    else if (why.length) { title = "All rings healthy, syncs behind"; tone = "warn"; }
    else if (d) { title = "All rings healthy"; tone = "ok"; }
    // One sentence under it: where the check failed, or what is behind (a sentence that starts with "no sync" or a number, never a ring's name, so capitalising it is safe).
    if (!(SERVICE && SERVICE.down) && d && failedOn.length) lede = "The latest health check failed on " + andList(failedOn) + (why.length ? "; " + why.join(" and ") : "") + ".";
    else if (!(SERVICE && SERVICE.down) && d && why.length) { var line = why.join(" and "); lede = line.charAt(0).toUpperCase() + line.slice(1) + (released.length ? "; the rings keep serving what they have." : "."); }
    $("#headline").textContent = title; $("#st-mark").className = "st-mark " + tone; $("#st-lede").textContent = lede;
  }

  // ---- the four numbers beside it, each a link to the section that proves it. A number counts up when it first lands and when it changes; a poll that brings the same number leaves it be (countUp starts again from 0, and the Health checks tile is drawn again with every stats poll and every listing).
  function tileCount(el, to) { if (!el || el.stTo === to) return; el.stTo = to; countUp(el, to); }
  function drawTiles(d) {
    var lastSync = newest(d.latest, "sync"), fams = sourceRows(d).filter(function (s) { return s.synced; }), onTime = fams.filter(function (s) { return s.state === "ok" || s.state === "run"; }).length;
    $("#t-sync-n").textContent = lastSync ? span(Date.now() - Date.parse(lastSync.created_at)) : "never";
    $("#t-sync-s").textContent = onTime + " of " + fams.length + " sources on time";
    // Today's health checks of the rings a check covers (the stats' 14 days of them), and how many failed — the word is the shell's.
    var today = new Date().toISOString().slice(0, 10), checks = ((d.series || {}).health || []).filter(function (h) { return h.created_at.slice(0, 10) === today && PROMISED_RINGS.indexOf(h.ring) >= 0; });
    var failed = checks.filter(function (h) { return h.status === "error"; }).length;
    tileCount($("#t-checks-n"), checks.length);
    $("#t-checks-s").textContent = !checks.length ? "none yet today" : failed ? "today · " + num(failed) + " " + HEALTH_WORD.error : "today · all green";
  }
  // A rollback is one line of the journal's: ops::rollback writes it with the release it made; a promotion that rolled itself back writes a second line after it (rolled_back_to) that is the same event, counted once.
  function rollbacksOf(list) { return (list || []).filter(function (e) { return !(e.payload && e.payload.rolled_back_to); }); }
  function drawRollbackTile() {
    var n = $("#t-rollbacks-n"), s = $("#t-rollbacks-s");
    if (ROLLBACKS_DOWN && !ROLLBACKS) { n.textContent = "—"; s.innerHTML = '<span title="' + esc(ROLLBACKS_DOWN) + '">did not answer</span>'; return; }
    if (!ROLLBACKS) return;
    var month = new Date().toISOString().slice(0, 7);
    tileCount(n, rollbacksOf(ROLLBACKS).filter(function (e) { return e.created_at.slice(0, 7) === month; }).length);
    s.textContent = "this month";
  }
  // An advisories report, asked once per ring and architecture (half an hour at the edge): the tile's and the card's are one answer when they name the same pair. A report that did not answer is asked again next time.
  function report(ring, arch) {
    var k = ring + "|" + arch;
    REPORTS[k] = REPORTS[k] || api("GET", "/api/v1/security?ring=" + ring + "&arch=" + arch).catch(function (e) { delete REPORTS[k]; throw e; });
    return REPORTS[k];
  }
  // Open in stable as every page counts it: the shell's one rule at its default confidence (advisoriesAt, advisoryCounts), from the report the Pool reads at the same address.
  function loadStableTile() {
    report(PROMISED_RINGS[0], ARCHES[0]).then(function (s) { var t = advisoryCounts(advisoriesAt(s)); countUp($("#t-adv-n"), t.packages); $("#t-adv-s").textContent = "in " + PROMISED_RINGS[0]; $("#t-adv-s").title = "packages " + PROMISED_RINGS[0] + " serves for " + ARCHES[0] + " with an open advisory · " + confWord(); })
      .catch(function (e) { $("#t-adv-n").textContent = "—"; $("#t-adv-s").innerHTML = '<span title="' + esc(noAnswer("security report", e)) + '">did not answer</span>'; });
  }

  // ---- releases: a card per ring, the way a package climbs (PROMISED_UPWARD).
  function ringOf(d, ring) { return d.rings.filter(function (x) { return x.ring === ring; })[0] || {}; }
  // A ring's releases the stats carry (its last HISTORY, stats.ts), oldest first.
  function historyOf(d, ring) { return (d.releases || []).filter(function (r) { return r.ring === ring; }).sort(function (a, b) { return a.seq - b.seq; }).slice(-HISTORY); }
  // A rollback is a release whose selection is an earlier release of its own ring (the stats' source_ring); a promotion's comes from another ring's head; a sync's or a publish's from the ring itself.
  function isRollback(r) { return !!r.source_id && r.source_ring === r.ring; }
  // An architecture a ring serves: a database rendered for it, or a source of it pinned.
  function serves(r, arch) { return (r.artifacts || []).some(function (a) { return a.kind === "db" && a.arch === arch; }) || (r.sources || []).some(function (s) { return s.arch === arch; }); }
  // Green checks in a row on a ring and an architecture since its head was released — the gate's own count (gate.rs greens_since): the health rows newest first, up to the first failure or the head's time.
  function greensSince(d, ring, arch, since) {
    var rows = ((d.series || {}).health || []).filter(function (h) { return h.ring === ring && h.arch === arch; }).sort(function (a, b) { return b.id - a.id; }), n = 0;
    for (var i = 0; i < rows.length && rows[i].created_at > since && rows[i].status !== "error"; i++) n++;
    return n;
  }
  // Where a ring's head goes next. edge and rc climb to the ring above by evidence: already there (the head above copied this one), held back (a failed check, or a gate's reason other than the soak), or a candidate — its green checks since release, against the soak the step's last gate asked for. stable has nothing above: what moves it is rc's head coming in, tried every PROMOTE_EVERY_MIN minutes (scheduler.ts RULES).
  function nextOf(d, ring) {
    var at = PROMISED_UPWARD.indexOf(ring), up = PROMISED_UPWARD[at + 1], r = ringOf(d, ring), rel = r.release;
    if (!rel) return { text: "no release yet" };
    if (!up) {
      var tried = latest(d.latest, "gate", ring, PROMISED_UPWARD[at - 1]), due = tried ? Date.parse(tried.created_at) + PROMOTE_EVERY_MIN * 60000 - Date.now() : null;
      return { text: due === null ? "promoted by evidence, tried every " + span(PROMOTE_EVERY_MIN * 60000) : due > 60000 ? "next promotion window in " + span(due) : "next promotion window any minute now" };
    }
    var above = ringOf(d, up).release;
    if (above && above.source_id === rel.id) return { text: "promoted to " + up + " " + ago(above.created_at) };
    var arches = ARCHES.filter(function (a) { return serves(r, a); });
    var failed = arches.filter(function (a) { var h = latest(d.latest, "health", ring, a); return h && h.status === "error"; });
    if (failed.length) return { text: "held back · " + failed.join(", ") + " " + HEALTH_WORD.error + " its health check", tone: "fail" };
    var gt = latest(d.latest, "gate", up, ring), p = (gt && gt.payload) || {};
    var held = gt && gt.created_at > rel.created_at && p.verdict === "block" ? (p.reasons || []).filter(function (x) { return !/green health check/.test(x); })[0] : null;
    if (held) return { text: "held back · " + held, tone: "warn" };
    var greens = arches.length ? Math.min.apply(null, arches.map(function (a) { return greensSince(d, ring, a, rel.created_at); })) : 0;
    return { text: up + " candidate · " + (p.soak_checks ? Math.min(greens, p.soak_checks) + " of " + p.soak_checks : greens) + " green check" + ((p.soak_checks || greens) === 1 ? "" : "s") };
  }
  // The roll back a maintainer is offered: the shell's button (data-rollback; the click asks why, posts the job once and writes #rb-state). Drawn for a maintainer and nobody else — the action is theirs alone (POST /factory/jobs checks the role).
  function rollbackButton(ring, id, label) { return isMaintainer() ? ' <button type="button" class="op-btn danger st-rb" data-rollback="' + id + '" data-ring="' + ring + '" title="point ' + ring + ' back at release ' + id + '">' + esc(label) + '</button>' : ""; }
  // A maintainer's forced promotion (#284): the ring's head into the ring above, past its evidence and the gate. Drawn for a maintainer on a ring that has one above; the click asks why and which architectures — both, or one alone, its own act — then their passkey (the shell's passkeyed, for exactly this promotion), and queues the promote job once — writing #rb-state as a roll back does.
  function forceButton(ring, up) { return isMaintainer() ? '<button type="button" class="op-btn danger st-rb" data-force="' + ring + '" data-to="' + up + '" title="' + esc("promote " + ring + "'s head into " + up + " now, past its evidence and the gate") + '">' + esc("Force into " + up) + '</button>' : ""; }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-force]") : null; if (!b) return;
    var from = b.getAttribute("data-force"), to = b.getAttribute("data-to"), el = $("#rb-state");
    b.disabled = true;
    var both = [{ value: "", text: "Both architectures", selected: true }].concat(ARCHES.map(function (a) { return { value: a, text: a + " only" }; }));
    ask({ title: "Force " + from + " into " + to + "?", text: esc(to + " serves " + from + "'s head at once, past the evidence and the gate: both architectures, or the one you pick. Its health check still rolls it back. Your passkey confirms it, and the journal keeps why."), select: { label: "Architectures", options: both }, input: "required", confirm: "Force with your passkey", first: "Register a passkey and force", nothing: "Nothing was queued.", danger: true }).then(function (go) {
      if (go === null) { b.disabled = false; return; }
      var arch = go.pick, params = { from: from, to: to, force: "yes", note: go.note };
      if (arch) params.arch = arch;
      return passkeyed("promote:force:" + from + ":" + to + (arch ? ":" + arch : ""), function (assertion) { return api("POST", "/api/v1/factory/jobs", { kind: "promote", params: params, assertion: assertion }); }).then(function (j) {
        if (j.error) b.disabled = false;
        el.hidden = false;
        el.innerHTML = j.error ? pillHtml("error", "refused") + " " + refusalHtml(j) : pillHtml("ok", "queued") + " forced promotion of <b>" + esc(from) + "</b> into <b>" + esc(to) + "</b>" + (arch ? " (" + esc(arch) + " only)" : "") + " is task #" + esc(j.task || "?") + " — a project worker runs it, the journal records it with your passkey";
      });
    }).catch(function (e) { b.disabled = false; toast("failed: " + esc(errorText(e)), "error"); });
  });
  function ringCard(d, ring) {
    var r = ringOf(d, ring), rel = r.release, hist = historyOf(d, ring), rb = hist.filter(isRollback).length, next = nextOf(d, ring);
    var head = '<div class="st-ring-h"><span class="st-ring-t"><b class="op-ring-name ' + ring + '">' + ring + '</b>' + (rel ? '<span class="st-seq">#' + rel.seq + '</span>' : '') + '</span>';
    if (!rel) return head + '</div><p class="st-wait">no release yet</p>';
    var health = ARCHES.filter(function (a) { return serves(r, a); }).map(function (arch) {
      var h = latest(d.latest, "health", ring, arch), tone = !h ? "na" : h.status === "ok" ? "ok" : h.status === "warn" ? "warn" : "fail";
      return '<span class="op-arch ' + tone + '" title="' + esc(arch + " · " + (h ? HEALTH_WORD[h.status] + " · checked " + ago(h.created_at) : "no health check yet")) + '"></span>';
    }).join("");
    var slots = "";
    for (var k = hist.length; k < HISTORY; k++) slots += '<span class="st-r none"></span>';
    slots += hist.map(function (x) {
      var what = isRollback(x) ? "rollback to release " + x.source_id : x.source_ring ? "from " + x.source_ring : x.note || "";
      var tip = "#" + x.seq + " · " + ago(x.created_at) + (what ? " · " + what : "") + (x.is_head ? " · served now" : "");
      var cls = "st-r" + (isRollback(x) ? " rb" : "") + (x.is_head ? " head" : "");
      return x.parent_id ? '<a class="' + cls + '" href="/diff?ring=' + ring + '&from=' + x.parent_id + '&to=' + x.id + '" title="' + esc(tip) + '" tabindex="-1"></a>' : '<span class="' + cls + '" title="' + esc(tip) + '"></span>';
    }).join("");
    // The card's roll back points the ring at the release before its head, named by its sequence and its id — the dialog and the note after it say the id. A head that is a rollback has no such button: its parent is the release it rolled away from, the one that failed; the history offers every release, by name, to a maintainer who means it.
    var prev = hist.filter(function (x) { return x.id === rel.parent_id; })[0], headRow = hist.filter(function (x) { return x.id === rel.id; })[0];
    var back = rel.parent_id && !(headRow && isRollback(headRow)) ? rollbackButton(ring, rel.parent_id, "Roll back to " + (prev ? "#" + prev.seq + " (release " + rel.parent_id + ")" : "release " + rel.parent_id)) : "";
    var up = PROMISED_UPWARD[PROMISED_UPWARD.indexOf(ring) + 1], acts = (up ? forceButton(ring, up) : "") + back;
    var rbWord = rb ? rb + (rb === 1 ? " rollback" : " rollbacks") : "no rollbacks";
    return head + '<span class="st-health">' + health + '<span>health</span></span></div>' +
      '<div class="st-ring-n"><div><span class="op-label">released</span><b>' + ago(rel.created_at) + '</b></div><div><span class="op-label">packages</span><b>' + num(r.package_count) + '</b></div></div>' +
      '<div class="st-strip"><div class="st-rs" role="img" aria-label="' + esc("the last " + hist.length + " releases of " + ring + ", " + rbWord) + '">' + slots + '</div><div class="st-strip-l"><span>last ' + HISTORY + ' releases</span><span>' + rbWord + '</span></div></div>' +
      '<div class="st-next' + (next.tone ? " " + next.tone : "") + '">' + lucide("arrow-up-right", 13) + '<span title="' + esc(next.text) + '">' + esc(next.text) + '</span></div>' + (acts ? '<div class="st-acts">' + acts + '</div>' : "");
  }
  function drawRings(d) {
    $("#st-rings").innerHTML = PROMISED_UPWARD.map(function (ring) { return '<article class="op-card ' + ring + ' st-ring" id="ring-' + ring + '">' + ringCard(d, ring) + '</article>'; }).join("");
  }
  // Every release the stats carry of the promised rings, newest first: what it changed (its diff against its parent), where its selection came from, and a maintainer's roll back on every release but a head.
  function drawHistory(d) {
    var rows = (d.releases || []).filter(function (r) { return PROMISED_RINGS.indexOf(r.ring) >= 0; });
    pager("#history-table", rows, function (r) {
      var from = isRollback(r) ? "rollback to release " + r.source_id : r.source_id ? "promoted from " + (r.source_ring || "release " + r.source_id) : "—";
      var acts = (r.parent_id ? '<a class="st-link" href="/diff?ring=' + r.ring + '&from=' + r.parent_id + '&to=' + r.id + '" title="what release ' + r.id + ' changed">diff</a>' : '') + (r.is_head ? "" : rollbackButton(r.ring, r.id, "roll back"));
      return '<tr><td>#' + r.seq + (r.is_head ? ' <span class="op-pill ok" title="what ' + r.ring + ' serves now">head</span>' : '') + ' <span class="st-dim">release ' + r.id + '</span></td><td><span class="op-ring ' + r.ring + '">' + r.ring + '</span></td><td class="num">' + num(r.package_count) + '</td><td' + (isRollback(r) ? ' class="st-red"' : '') + '>' + esc(from) + '</td><td class="st-dim">' + esc(r.note || "") + '</td><td class="st-dim" title="' + esc(r.created_at) + '">' + ago(r.created_at) + '</td><td>' + acts + '</td></tr>';
    }, { empty: "no release yet", n: 10, text: function (r) { return [r.id, r.ring, r.seq, r.note, r.source_ring].join(" "); } });
  }

  // ---- sources: a row per project the pool syncs from (SOURCES: its repositories, EXPECTED_SOURCES in meta.ts), summed over their coverage rows; late by the shell's one rule (lateSync), syncing while a sync job of the worker listing holds one of its repositories. The factory is live: it publishes what maintainers approve, when they approve it.
  function syncingNow() {
    var on = {};
    ((FACTORY || {}).tasks || []).forEach(function (t) {
      if (t.kind !== "sync" || t.status !== "leased") return;
      var p = t.params || {}, list = [];
      try { list = p.sources ? JSON.parse(p.sources) : [{ source: p.source, arch: p.arch }]; } catch (e) { list = []; }
      list.forEach(function (s) { on[s.source + "/" + (s.arch || p.arch)] = 1; });
    });
    return on;
  }
  function sourceRows(d) {
    var cov = {}, now = syncingNow(), published = (jobsSummary(d.series, 1).byKind.publish || {}).done || 0;
    (d.coverage || []).forEach(function (c) { cov[c.source + "/" + c.arch] = c; });
    return SOURCES.map(function (s) {
      var rows = s.repos.map(function (x) { return cov[x.source + "/" + x.arch]; }).filter(Boolean);
      var synced = rows.filter(function (c) { return c.last_sync; }), late = rows.filter(lateSync), broken = rows.filter(function (c) { return c.last_status === "error"; });
      var syncing = s.repos.some(function (x) { return now[x.source + "/" + x.arch]; });
      var state = !s.synced ? "ok" : syncing ? "run" : broken.length ? "fail" : late.length ? "warn" : !synced.length ? "na" : "ok";
      return {
        name: s.name, repos: s.repos, synced: s.synced, state: state, rows: rows,
        packages: rows.reduce(function (n, c) { return n + Number(c.indexed || 0); }, 0),
        today: s.synced ? rows.reduce(function (n, c) { return n + Number(c.today || 0); }, 0) : published,
        oldest: synced.map(function (c) { return c.last_sync; }).sort()[0] || null,
      };
    });
  }
  function drawSources(d) {
    $("#sources-rows").innerHTML = sourceRows(d).map(function (s) {
      var repos = s.repos.map(function (x) { return x.repo; }).filter(function (x, i, a) { return a.indexOf(x) === i; }).join(" · ");
      var byRepo = {}; s.rows.forEach(function (c) { byRepo[c.source + "/" + c.arch] = c; });
      var tip = s.repos.map(function (x) { var c = byRepo[x.source + "/" + x.arch]; return x.title + " (" + x.arch + ")" + (s.synced ? ": " + (c && c.last_sync ? "synced " + ago(c.last_sync) + (lateSync(c) ? ", late" : "") : "not synced yet") : ""); }).join("\n");
      var when = !s.synced ? "live" : s.state === "run" ? "syncing…" : s.oldest ? ago(s.oldest) : "never";
      // Late or failed is said in a word under the time, not by the colour alone.
      var word = s.state === "warn" ? "late" : s.state === "fail" ? "failed" : "";
      return '<tr title="' + esc(tip) + '"><td><span class="st-dot ' + s.state + '"></span>' + esc(s.name) + '<small class="s-repos">' + esc(repos) + '</small></td><td>' + esc(repos) + '</td><td class="num">' + num(s.packages) + '</td><td class="num s-plus">+' + num(s.today) + '</td><td class="num s-when ' + s.state + '">' + esc(when) + (word ? '<small>' + word + '</small>' : '') + '</td></tr>';
    }).join("");
  }

  // ---- workers: the project's, the ones doing the pool's jobs and the maintainers' rebuilds — a contributor's are on /workers. An agent's mark from what a worker says it runs ("<provider>/<model>"), or the name #252 writes on a line an agent drafted ("Claude Code"): the provider, or the name's first word, looked up; the mark says the agent's name on hover and to a screen reader. One the kit has no mark for is its initials in a square, as the handoff draws one.
  var AGENT_MARKS = { anthropic: "claude-color", claude: "claude-color", "claude-code": "claude-color", openai: "openai", codex: "openai", gpt: "openai", gemini: "gemini-color", google: "gemini-color", xai: "grok", grok: "grok", qwen: "qwen-color", alibaba: "qwen-color", moonshot: "kimi", kimi: "kimi", meta: "meta-color", llama: "meta-color", cursor: "cursor", opencode: "opencode", github: "githubcopilot", copilot: "githubcopilot" };
  // An agent's name as a reader says it, never its slug: the provider looked up ("claude-code" is Claude Code) and the model's words spelled out ("claude-sonnet-5" is Claude Sonnet 5, "gpt-5" GPT 5) — "Claude Code · Claude Sonnet 5"; a name #252 writes ("Claude Code") is one already.
  var AGENT_NAMES = { anthropic: "Anthropic", claude: "Claude", "claude-code": "Claude Code", openai: "OpenAI", codex: "Codex", gpt: "GPT", gemini: "Gemini", google: "Google", xai: "xAI", grok: "Grok", qwen: "Qwen", alibaba: "Alibaba", moonshot: "Moonshot", kimi: "Kimi", meta: "Meta", llama: "Llama", cursor: "Cursor", opencode: "opencode", github: "GitHub", copilot: "Copilot" };
  function spelled(s) { return String(s).split(/[-_]+/).filter(Boolean).map(function (w) { return AGENT_NAMES[w.toLowerCase()] || (/^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w); }).join(" "); }
  function modelOf(agent) { var cut = agent.indexOf("/"); return spelled(cut > 0 ? agent.slice(cut + 1) : agent); }
  function agentName(agent) { var s = String(agent || ""), cut = s.indexOf("/"); return cut > 0 ? (AGENT_NAMES[s.slice(0, cut).toLowerCase()] || spelled(s.slice(0, cut))) + " · " + modelOf(s) : spelled(s); }
  function agentOf(name) {
    var s = String(name || ""), cut = s.indexOf("/"), key = (cut > 0 ? s.slice(0, cut) : s.split(/[\s-]/)[0]).toLowerCase(), mark = AGENT_MARKS[key];
    return mark ? agentMark(mark, agentName(s)) : '<span class="st-ini" title="' + esc(agentName(s)) + '">' + esc((cut > 0 ? s.slice(cut + 1) : s).slice(0, 2).toUpperCase()) + '</span>';
  }
  function workerLine(w, t) {
    var working = w.alive && !!w.current_task, model = w.agent ? modelOf(w.agent) : "—";
    // Alive, nothing in hand, not ready — what it declares needs an agent that did not answer (the listing's ready; the shell's words for why, whole on hover), as the Workers page's failed pill says it: never "idle, waiting for work" (#273). It is handed no agent work — no audit, no review: build — until its agent answers; the jobs that need none still come.
    var down = w.alive && !working && !w.ready;
    var doing = !w.alive ? '<b>offline</b><span class="st-dim">' + esc(span(Date.now() - Date.parse(w.last_seen))) + '</span>'
      : down ? '<span class="st-dot fail" aria-hidden="true"></span><b>not ready</b><span class="st-dim">' + esc(wtNotReady(w)) + '</span>'
      : !working ? '<b>idle</b><span class="st-dim">waiting for work</span>'
      : !t ? '<a href="/build/' + Number(w.current_task) + '"><b>task #' + Number(w.current_task) + '</b></a>'
      : '<a href="/build/' + t.id + '"><b>' + esc(t.kind === "build" ? t.name : t.kind) + '</b></a><span class="st-dim">' + esc([t.kind === "build" ? [t.version, t.arch].filter(Boolean).join(" · ") : paramsLabel(t), t.started_at ? span(Date.now() - Date.parse(t.started_at)) : ""].filter(Boolean).join(" · ")) + '</span>';
    return '<div class="st-w' + (working ? " busy" : "") + (w.alive ? "" : " off") + (down ? " notready" : "") + '"><span class="st-wbox">' + (w.agent ? agentOf(w.agent) : '<span class="st-ini" title="no agent: the pool\'s jobs need none">—</span>') + '</span>' +
      '<div class="st-wt"><div class="st-wl">' + workerName(w) + '<span>' + esc(model) + '</span></div><div class="st-wj"' + (down ? ' title="' + esc(wtNotReady(w)) + '"' : '') + '>' + doing + '</div><div class="st-wbar"><i></i></div></div></div>';
  }
  function drawWorkers() {
    $("#workers-note").textContent = WC_DOWN || "";
    if (!FACTORY) { if (WC_DOWN) $("#workers-busy").textContent = "—"; return; }
    var rank = { project: 0, review: 1 }, tasks = {};
    (FACTORY.tasks || []).forEach(function (t) { tasks[t.id] = t; });
    var ws = (FACTORY.workers || []).filter(function (w) { return wtKind(w) !== "community"; }).sort(function (a, b) { return rank[wtKind(a)] - rank[wtKind(b)] || ARCHES.indexOf(a.arch) - ARCHES.indexOf(b.arch) || (a.id < b.id ? -1 : 1); });
    var c = workerCounts(ws);
    var down = ws.filter(function (w) { return w.alive && !w.revoked_at && !w.current_task && !w.ready; }).length;
    $("#workers-busy").textContent = num(c.building) + " of " + num(c.registered) + " busy" + (down ? " · " + num(down) + " not ready" : "");
    $("#workers-list").innerHTML = ws.map(function (w) { return workerLine(w, tasks[w.current_task]); }).join("") || '<p class="st-empty">no project worker registered</p>';
  }
  function workerById(id) { return ((FACTORY || {}).workers || []).filter(function (w) { return w.id === id; })[0] || null; }
  // The listing once a minute, at the stats' pace — the one read of the Workers card, the syncing marks, the journal's agents and the numbers' jobs (a hundred rows while the numbers are open, ten otherwise: leased tasks come first). Its edge copy lives 10 s and a miss reads the tasks table whole, so the page asks no more often than the Status page before #248 did (once per stats poll).
  function loadFactory() {
    if (NUMBERS) loadRegistry();
    api("GET", "/api/v1/factory?limit=" + (NUMBERS ? 100 : 10)).then(function (f) {
      FACTORY = f; WC = workerCounts(f.workers); WC_DOWN = null;
      drawWorkers(); drawTasks();
      if (STATS) { renderSystem(STATS); drawSources(STATS); drawTiles(STATS); }
      if (JLAST.length) drawJournal([], true);
    }).catch(function (e) { WC_DOWN = noAnswer("worker listing", e); drawWorkers(); if (STATS) renderSystem(STATS); });
  }

  // ---- health checks and rollbacks: the latest check of every ring and architecture the stats carry, and the rollbacks of the last 30 days, newest first.
  function checkWord(d, ring, arch, h) {
    var at = PROMISED_UPWARD.indexOf(ring), up = PROMISED_UPWARD[at + 1], rel = ringOf(d, ring).release;
    if (h.status === "error") return HEALTH_WORD.error + " · " + h.summary;
    if (!up || !rel) return HEALTH_WORD[h.status] + (rel ? " · serving #" + rel.seq : "");
    var above = ringOf(d, up).release;
    if (above && above.source_id === rel.id) return HEALTH_WORD[h.status] + " · in " + up;
    var gt = latest(d.latest, "gate", up, ring), soak = gt && gt.payload && gt.payload.soak_checks;
    var greens = greensSince(d, ring, arch, rel.created_at);
    return (soak ? Math.min(greens, soak) + " of " + soak : greens) + " green · " + up + " candidate";
  }
  // A rollback's releases by their sequence where the stats carry them: from the head it replaced to the one it went back to.
  function rollbackRange(d, e) {
    var p = e.payload || {}, byId = {}; (d.releases || []).forEach(function (r) { byId[r.id] = r; });
    var made = byId[p.release_id], gone = made && byId[made.parent_id], back = byId[p.to_release_id];
    if (!made && !back) return "";
    return (gone ? "#" + gone.seq : "") + " → " + (back ? "#" + back.seq : "release " + Number(p.to_release_id));
  }
  function drawChecks(d) {
    var rows = [], month = Date.now() - 30 * 86400e3;
    PROMISED_RINGS.forEach(function (ring) {
      var r = ringOf(d, ring);
      ARCHES.forEach(function (arch) {
        var h = latest(d.latest, "health", ring, arch); if (!h || !serves(r, arch)) return;
        rows.push({ at: h.created_at, ring: ring, arch: h.source || NULL_SOURCE_ARCH, ok: h.status !== "error", tone: h.status === "error" ? "fail" : "", d: checkWord(d, ring, arch, h), rel: r.release ? "#" + r.release.seq : "" });
      });
    });
    rollbacksOf(ROLLBACKS).filter(function (e) { return Date.parse(e.created_at) > month; }).slice(0, 5).forEach(function (e) {
      var p = e.payload || {};
      rows.push({ at: e.created_at, ring: e.ring || "", arch: e.source || "both", ok: false, tone: "fail", d: "rolled back · " + (p.note || e.summary), rel: rollbackRange(d, e) });
    });
    rows.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
    $("#checks-list").innerHTML = rows.map(function (x) {
      return '<div class="st-c ' + x.tone + '"><span class="c-ago" title="' + esc(x.at) + '">' + esc(span(Date.now() - Date.parse(x.at))) + '</span><span class="c-ring ' + esc(x.ring) + '">' + esc(x.ring) + '</span><span class="c-arch">' + esc(x.arch) + '</span><i class="op-mark ' + (x.ok ? "ok" : "fail") + '">' + (x.ok ? "✓" : "✗") + '</i><span class="c-d" title="' + esc(x.d) + '">' + esc(x.d) + '</span><span class="c-rel">' + esc(x.rel) + '</span></div>';
    }).join("") || '<p class="st-empty">no health check yet</p>';
  }
  // The journal's rollbacks and fast-tracks, every five minutes: the Rollbacks tile and list, the Advisories card's foot.
  function loadEvidence() {
    api("GET", "/api/v1/events?kind=rollback&limit=50").then(function (d) { ROLLBACKS = d.events || []; ROLLBACKS_DOWN = null; }).catch(function (e) { ROLLBACKS_DOWN = noAnswer("journal", e); })
      .then(function () { drawRollbackTile(); if (STATS) drawChecks(STATS); });
    api("GET", "/api/v1/events?kind=fast-track&limit=50").then(function (d) { FAST = d.events || []; drawFast(); }).catch(function (e) { if (!FAST) $("#adv-fast").textContent = noAnswer("journal", e); });
  }
  // The security fixes the fast-track pulled into a ring this week, a fix counted once (payload.fixes: the security layer's; a factory build the trial installed takes the same lane and is no fix).
  function drawFast() {
    var week = Date.now() - 7 * 86400e3, n = (FAST || []).filter(function (e) { return Date.parse(e.created_at) > week && e.payload && Array.isArray(e.payload.fixes); }).reduce(function (s, e) { return s + e.payload.fixes.length; }, 0);
    $("#adv-fast").textContent = n ? num(n) + " security fix" + (n === 1 ? "" : "es") + " fast-tracked this week" : "No security fix fast-tracked this week";
  }

  // ---- advisories: the card counts one report — the ring and the architecture picked (stable and the first architecture unless the address says; /security?ring=rc lands here with its query) — by the shell's one rule at the confidence picked (advisoriesAt, advisoryCounts), a package once, by its worst severity; its colour is the shell's (SEV_COLOR). The list below it is that report, row by row.
  var ADV_RING = PROMISED_RINGS.indexOf(q.get("ring")) >= 0 ? q.get("ring") : PROMISED_RINGS[0];
  var ADV_ARCH = ARCHES.indexOf(q.get("arch")) >= 0 ? q.get("arch") : ARCHES[0];
  var ADV_CONF = SEC_CONFS.indexOf(q.get("conf")) >= 0 ? q.get("conf") : SEC_CONF;
  if (q.get("ring") || q.get("arch") || q.get("conf")) $("#advisory-list").open = true;
  // The shell's pick(), on this page: the chosen button says so to a screen reader too (aria-pressed, which the kit draws as it draws .on), and the address keeps the section it points at — pick() writes the query alone, and a reload would land at the top of a long page.
  function choose(sel, values, current, on, opts, hash) {
    pick(sel, values, current, function (v) { if (hash && window.history && history.replaceState) history.replaceState(null, "", location.pathname + location.search + hash); on(v); }, opts);
    var el = $(sel); if (el) el.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-v") === current)); });
  }
  function advId(a) { return String(a.id || "").replace(/^(arch|debian|osv):/, "").replace(/:[^:]*$/, ""); }
  function exposureOf(r) { var x = r.v.exposure || {}; return Number(x.declared || 0) + Number(x.loads || 0); }
  function loadAdvisories() {
    choose("#pick-ring", PROMISED_RINGS, ADV_RING, function (v) { ADV_RING = v; loadAdvisories(); }, { url: "ring" }, "#advisory-list");
    choose("#pick-arch", ARCHES, ADV_ARCH, function (v) { ADV_ARCH = v; loadAdvisories(); }, { url: "arch" }, "#advisory-list");
    choose("#pick-conf", SEC_CONFS, ADV_CONF, function (v) { ADV_CONF = v; loadAdvisories(); }, { url: "conf" }, "#advisory-list");
    $("#updated").textContent = "Reading " + ADV_RING + " · " + ADV_ARCH + " — the report covers every package the ring serves…";
    skeletonRows("#vuln", 7, 3);
    var ring = ADV_RING, arch = ADV_ARCH;
    report(ring, arch).then(function (d) { if (ring === ADV_RING && arch === ADV_ARCH) drawAdvisories(d, ring, arch); })
      .catch(function (e) { var why = noAnswer("security report", e, "#updated"); $("#adv-note").textContent = ring + " · " + arch; $("#adv-top").innerHTML = '<p class="st-empty">' + esc(why) + '</p>'; });
  }
  function drawAdvisories(d, ring, arch) {
    var rows = advisoriesAt(d, ADV_CONF), c = advisoryCounts(rows);
    $("#adv-note").innerHTML = (c.kev ? '<span style="color:' + SEV_COLOR.exploited + '" title="in CISA KEV">' + num(c.kev) + ' exploited</span> · ' : '') + esc(ring + " · " + arch + " · ") + '<span title="' + esc(FEEDS.length + " public feeds: " + FEEDS.join(", ") + (d.updated_at ? " · refreshed " + ago(d.updated_at) : "")) + '">every 3 h</span>';
    $("#adv-sev").innerHTML = SEVERITIES.map(function (s) { return '<div class="st-sv"><b style="color:' + SEV_COLOR[s] + '">' + num(c[s]) + '</b><span>' + esc(s) + '</span></div>'; }).join("");
    var top = rows.filter(function (r) { return exposureOf(r) > 0; }).sort(function (a, b) { return exposureOf(b) - exposureOf(a); }).slice(0, 4), max = top.length ? exposureOf(top[0]) : 1;
    $("#adv-top").innerHTML = top.map(function (r) {
      var what = r.advs.length === 1 ? advId(r.advs[0]) + " · " + r.worst : r.advs.length + " · " + r.worst;
      return '<div class="st-x"><div class="st-x-h"><span><a href="' + pkgHref(r.v.name, ring, arch) + '">' + esc(r.v.name) + '</a><small>' + esc(what) + '</small></span><span class="st-x-n">' + num(exposureOf(r)) + ' package' + (exposureOf(r) === 1 ? '' : 's') + '</span></div><div class="st-bar"><i style="width:' + Math.round(100 * exposureOf(r) / max) + '%;background:' + SEV_COLOR[r.worst] + '"></i></div></div>';
    }).join("") || '<p class="st-empty" style="padding:0">nothing ' + esc(ring) + ' serves depends on a package with an open advisory</p>';
    $("#adv-list-note").textContent = ring + " · " + arch + " · " + confWord(ADV_CONF) + " · " + num(c.packages) + " package" + (c.packages === 1 ? "" : "s");
    $("#updated").textContent = (d.updated_at ? "Advisories refreshed " + ago(d.updated_at) + " · " : "No security run recorded yet · ") + num(d.advisories_total) + " advisories in the index";
    pager("#vuln", rows, function (r) {
      var v = r.v;
      return '<tr><td>' + sevPill(r.worst) + (r.kev ? ' ' + pillHtml(SEV_PILL.exploited, "exploited", "in CISA KEV") : '') + (r.epss >= 0.1 ? ' ' + pillHtml("warn", "epss " + (r.epss * 100).toFixed(0) + "%", "EPSS " + (r.epss * 100).toFixed(0) + "%") : '') + '</td>' +
        '<td><a href="' + pkgHref(v.name, ring, arch) + '"><b>' + esc(v.name) + '</b></a> <span class="st-dim">' + esc(v.source) + '</span></td><td class="mono">' + esc(v.version) + '</td>' +
        '<td>' + r.advs.map(function (a) { var link = runHref(a.url); return (link ? '<a class="st-link" href="' + esc(link) + '">' + esc(advId(a)) + '</a>' : esc(advId(a))) + (a.fixed ? ' <span class="st-dim">fixed in ' + esc(a.fixed) + '</span>' : ''); }).join("<br>") + '</td>' +
        '<td>' + esc(r.advs.map(function (a) { return a.match; }).filter(function (m, i, all) { return all.indexOf(m) === i; }).join(", ")) + '</td>' +
        '<td>' + (v.exposure && (v.exposure.declared || v.exposure.loads) ? num(v.exposure.declared) + ' declared · ' + num(v.exposure.loads) + ' load it' : '<span class="st-dim">nothing</span>') + '</td>' +
        '<td>' + (v.fixed_in && v.fixed_in.length ? v.fixed_in.map(function (f) { return '<a class="st-link" href="' + pkgHref(v.name, f.ring, arch) + '">' + esc(f.ring) + ' ' + esc(f.version) + '</a>'; }).join(", ") : '<span class="st-dim">—</span>') + '</td></tr>';
    }, { empty: "nothing with an open advisory at this confidence level", text: function (r) { return [r.v.name, r.v.version, r.worst, r.advs.map(advId).join(" ")].join(" "); } });
    endSkeleton();
  }

  // ---- the journal, live: the newest lines, with who did each and with which agent. ?kind= picks a chip, or a kind of the journal's own (KINDS: meta.ts's list, what /journal?kind= named), so an old link stays filtered.
  //
  // What it reads, and how often. All is the stats poll's own newest lines (nothing more to ask) until Show more asks the journal for its window, once; a chip asks for its kinds once when it is picked, and again at each Show more. Then, once a minute while a chip is picked, only the newest twenty of each of its kinds are asked and added to what is drawn — three kinds at most, sixty rows a minute, under the two hundred a minute the Journal read — and the window is asked again only when they do not reach what is drawn (more lines came in than that); under All the stats poll's lines do the same.
  var GROUPS = { all: null, syncs: ["sync"], promotions: ["promote", "fast-track"], decisions: ["approve", "withdraw", "review"], blocks: ["block", "rollback"] };
  var CHIPS = { all: "All", syncs: "Syncs", promotions: "Promotions", decisions: "Decisions", blocks: "Blocks" };
  // A kind whose word is a chip's comes under that chip (?kind=sync is Syncs); any other kind the address names is a chip of its own, named in words.
  var GROUP_OF = { sync: "syncs", promote: "promotions", block: "blocks" };
  var KIND_CHIPS = { gate: "Gates", "fast-track": "Fast-tracks", health: "Health checks", trial: "Trials", abi: "ABI checks", security: "Security runs", render: "Renders", publish: "Publishes", verify: "Verifies", rollback: "Rollbacks", relayout: "Relayouts", gc: "Clean-ups", deploy: "Deploys", cost: "Bills", audience: "Audience", provenance: "Provenance", dispatch: "Dispatches", job: "Jobs", build: "Builds", enqueue: "Enqueues", request: "Requests", review: "Project builds", approve: "Approvals", withdraw: "Withdrawals", trust: "Trust", role: "Roles", category: "Categories", bump: "Bumps", worker: "Workers", leak: "Leaks" };
  var asked = q.get("kind");
  var JF = Object.prototype.hasOwnProperty.call(GROUPS, asked) ? asked : GROUP_OF[asked] || (KINDS.indexOf(asked) >= 0 ? asked : "all");
  // The window: twenty lines, up to the two hundred the Journal read; the stats carry the newest RECENT (stats.ts). JLAST is what is drawn, newest first; JFULL whether the read that filled the window came back full, so the journal may hold more; JTOP the newest line drawn, what a line that just arrived is newer than.
  var JSTART = 20, JMAX = 200, RECENT = __RECENT__, JLIMIT = JSTART, JLAST = [], JFULL = false, JTOP = null;
  function chipLabel(v) { return CHIPS[v] || KIND_CHIPS[v] || v; }
  function chipIds() { var ids = Object.keys(CHIPS); return ids.indexOf(JF) >= 0 ? ids : ids.concat([JF]); }
  function drawChips() {
    choose("#journal-chips", chipIds(), JF, function (v) { JF = v; JLIMIT = JSTART; JLAST = []; JFULL = false; JTOP = null; drawChips(); loadJournal(); }, { url: "kind", label: function (v) { return esc(chipLabel(v)); } }, "#journal");
  }
  // A line's verb, in the handoff's words: what happened, in the past tense, and where to for what moves a ring.
  function verbOf(e) {
    var p = e.payload || {}, to = e.ring ? " → " + e.ring : "", failed = e.status === "error";
    if (e.kind === "sync") return failed ? "sync failed" : "synced" + to;
    if (e.kind === "promote") return failed ? "promotion failed" : "promoted" + to;
    if (e.kind === "fast-track") return "fast-tracked" + to;
    if (e.kind === "gate") return "gate · " + (p.verdict === "block" ? "held back" : p.verdict === "skip" ? "nothing new" : "passed");
    if (e.kind === "health") return (e.ring ? e.ring + " " : "") + (HEALTH_WORD[e.status] || e.status);
    if (e.kind === "rollback") return "rolled back" + (e.ring ? " " + e.ring : "");
    if (e.kind === "approve") return e.status === "ok" ? "approved" : "rejected";
    if (e.kind === "withdraw") return "withdrawn";
    if (e.kind === "review") return "project build asked";
    if (e.kind === "block") return e.status === "ok" ? "block lifted" : "blocked";
    if (e.kind === "request") return e.status === "ok" ? "requested" : "request dropped";
    if (e.kind === "build") return e.status === "ok" ? "built" : failed ? "build failed" : "build retried";
    if (e.kind === "publish") return "published" + to;
    if (e.kind === "job") return failed ? "job failed" : "job done";
    if (e.kind === "trial") return failed ? "trial failed" : e.status === "warn" ? "trial warned" : "trial passed";
    if (e.kind === "abi") return failed ? "ABI break" : e.status === "warn" ? "ABI warning" : "ABI checked";
    if (e.kind === "security") return failed ? "advisory run failed" : "advisories matched";
    if (e.kind === "render") return failed ? "render failed" : "rendered" + to;
    if (e.kind === "verify") return failed ? "verify failed" : e.status === "warn" ? "verified, repaired" : "verified";
    if (e.kind === "relayout") return failed ? "relayout failed" : "pool relaid out";
    if (e.kind === "gc") return failed ? "clean-up failed" : "pool cleaned up";
    if (e.kind === "deploy") return failed ? "deploy failed" : "deployed";
    if (e.kind === "cost") return "bill estimated";
    if (e.kind === "audience") return "audience counted";
    if (e.kind === "provenance") return "recipes traced";
    if (e.kind === "dispatch") return "job queued";
    if (e.kind === "enqueue") return failed ? "enqueue failed" : "builds queued";
    if (e.kind === "trust") return p.proposed_by ? "trust proposed" : p.trust === "project" ? "trusted" : p.trust === "community" ? "made community" : "worker revoked";
    if (e.kind === "role") return "role changed";
    if (e.kind === "category") return p.by === "agent" ? "category proposed" : "category set";
    if (e.kind === "bump") return e.status === "ok" ? "update queued" : "unmaintained";
    if (e.kind === "worker") return e.status === "warn" ? "update needed" : "worker told";
    if (e.kind === "leak") return "secret withheld";
    return e.kind + (failed ? " failed" : "");
  }
  // Its colour: a ring's hue for what moved a ring, red for what stopped something (a rollback, a block, a rejection, a withdrawal, a failure), green for an approval, amber for a warning.
  function toneOf(e) {
    if (e.status === "error" || e.kind === "rollback" || e.kind === "withdraw" || (e.kind === "block" && e.status !== "ok") || (e.kind === "approve" && e.status !== "ok")) return "fail";
    if ((e.kind === "sync" || e.kind === "promote" || e.kind === "fast-track" || e.kind === "publish") && PROMISED_RINGS.indexOf(e.ring) >= 0) return e.ring;
    if (e.kind === "approve") return "ok";
    return e.status === "warn" ? "warn" : "";
  }
  // Who did it, and with which agent. The people a line names: payload.by (a login, or two where two maintainers' word made it: "m1, m2"; "agent" is the project's own agent), payload.proposed_by (a trust proposal), else the contributor a request or a queue is for (payload.owner). A line a worker wrote of its own work — a job, a build, what the pool told it (WORKER_LINES) — is its owner's, or the pool's for the project's; no other line borrows a worker's owner. The agent: #252's, on a line a person's agent drafted (payload.via.agent), or the worker's where the work was an agent's — a build (its recipe drafted) or an audit (the second agent's report); a sync or a promotion is the pool's own, and names none. A worker's agent is the one it runs now (the listing): the line does not record it.
  var LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/, WORKER_LINES = { job: 1, build: 1, worker: 1 };
  function whoOf(e) {
    var p = e.payload || {}, isLogin = function (x) { return typeof x === "string" && x !== "agent" && LOGIN.test(x); };
    var own = !!WORKER_LINES[e.kind] && typeof p.worker === "string";
    var people = (typeof p.by === "string" ? p.by.split(/,\s*/) : []).concat([p.proposed_by]).filter(isLogin);
    if (!people.length && !own && isLogin(p.owner)) people = [p.owner];
    var w = own ? workerById(p.worker) : null;
    if (!people.length && own && (w ? wtKind(w) === "community" && isLogin(w.owner) : isLogin(p.owner))) people = [w ? w.owner : p.owner];
    var agentWork = e.kind === "build" || (e.kind === "job" && p.kind === "audit");
    var agent = (p.via && typeof p.via.agent === "string" && p.via.agent) || (agentWork && w && w.agent) || "";
    var mark = agent ? agentOf(agent) : p.by === "agent" ? '<span class="st-ini" title="the project\'s agent">AI</span>' : "";
    if (people.length) return mark + people.slice(0, 2).map(function (person, i) { return '<a href="' + userHref(person) + '"' + whoAttr(person) + '>' + (mark || i ? '' : '<span class="st-ini" aria-hidden="true">' + esc(person.slice(0, 2).toUpperCase()) + '</span>') + esc(person) + '</a>'; }).join(", ");
    return (mark || '<span class="st-pool" aria-hidden="true">▣</span>') + '<span>the pool</span>';
  }
  // One line: when, its colour, what happened, the line itself — linked to the run that produced it (an https link only: runHref) and to the diff of the release it made (a whole number only: the payload is whatever a job posted) — and who.
  function journalRow(e, fresh) {
    var run = runHref(e.payload && e.payload.ci && e.payload.ci.run_url), rid = e.payload && Number(e.payload.release_id), diff = "", tone = toneOf(e), age = Date.now() - Date.parse(e.created_at);
    if (rid > 0 && rid === Math.floor(rid) && PROMISED_RINGS.indexOf(e.ring) >= 0 && (e.kind === "promote" || e.kind === "rollback" || e.kind === "sync" || e.kind === "fast-track")) diff = '<a class="j-diff" href="/diff?ring=' + e.ring + '&to=' + rid + '" title="what release ' + rid + ' changed">diff</a>';
    return '<div class="st-j' + (fresh ? " op-fresh" : "") + '"><span class="j-ago" title="' + esc(e.created_at) + '">' + (age < 10000 ? "now" : esc(span(age))) + '</span><span class="j-sq ' + tone + '"></span><span class="j-ev ' + tone + '">' + esc(verbOf(e)) + '</span>' +
      '<span class="j-what" title="' + esc(e.summary) + '">' + (run ? '<a href="' + esc(run) + '" title="open the run">' + esc(e.summary) + '</a>' : esc(e.summary)) + diff + '</span><span class="j-who">' + whoOf(e) + '</span></div>';
  }
  // Lines added to what is drawn: a line once, newest first, the metrics snapshots left out (a snapshot is no line of the journal's), the newest JLIMIT kept. A line newer than the newest drawn before lights up as it arrives; again is a redraw for the agents the listing brought, with nothing new in it. Show more stays while the journal may hold more than is drawn: a read came back full (its metrics lines counted), or more lines are known than the window shows.
  function drawJournal(list, again) {
    var ids = {}, all = JLAST.concat(list.filter(function (e) { return e.kind !== "metrics"; })).filter(function (e) { if (ids[e.id]) return false; ids[e.id] = 1; return true; }).sort(function (a, b) { return b.id - a.id; });
    var kept = all.slice(0, JLIMIT), top = JTOP;
    $("#journal-list").innerHTML = kept.map(function (e) { return journalRow(e, top !== null && !again && e.id > top); }).join("") || '<p class="st-empty">nothing on the record yet</p>';
    JLAST = kept; JTOP = Math.max(JTOP || 0, kept.length ? kept[0].id : 0);
    $("#journal-count").textContent = (kept.length === 1 ? "the newest line" : kept.length ? "the " + num(kept.length) + " newest lines" : "") + (kept.length && JF !== "all" ? " · " + chipLabel(JF) : "");
    $("#journal-more").hidden = !(JFULL || all.length > JLIMIT) || JLIMIT >= JMAX;
  }
  // A read of the journal for the filter picked: each of its kinds (the whole journal under All) at limit. The answer is dropped when the reader picked another filter or window since it was asked, so a slow answer never draws over the chip picked after it.
  function readJournal(limit) {
    var f = JF, lim = JLIMIT, kinds = f === "all" ? [null] : GROUPS[f] || [f];
    return Promise.all(kinds.map(function (k) { return api("GET", "/api/v1/events?" + (k ? "kind=" + encodeURIComponent(k) + "&" : "") + "limit=" + limit); }))
      .then(function (lists) { return f === JF && lim === JLIMIT ? lists.map(function (l) { return l.events || []; }) : null; });
  }
  // The window, asked once: a chip picked, Show more pressed, or fresh lines that did not reach what is drawn. All's first twenty are the stats poll's.
  function loadJournal() {
    if (JF === "all" && JLIMIT === JSTART) { if (STATS) statsLines(STATS); return; }
    var lim = JLIMIT;
    readJournal(lim).then(function (lists) { if (!lists) return; JFULL = lists.some(function (l) { return l.length >= lim; }); drawJournal([].concat.apply([], lists)); })
      .catch(function (e) { noAnswer("journal", e, "#journal-count"); });
  }
  // Whether fresh lines reach what is drawn, so adding them leaves no hole: they came back short (every line there is), or share a line with it, or go back past its oldest. Otherwise more came in than was asked, and the window is read again.
  function reaches(list, limit) {
    if (list.length < limit) return true;
    if (!JLAST.length) return false;
    var have = {}; JLAST.forEach(function (e) { have[e.id] = 1; });
    return list.some(function (e) { return have[e.id]; }) || Math.min.apply(null, list.map(function (e) { return e.id; })) < JLAST[JLAST.length - 1].id;
  }
  // Once a minute while a chip is picked: the newest twenty of each of its kinds, added to what is drawn. All's are the stats poll's (statsLines).
  function refreshJournal() {
    if (JF === "all") return;
    readJournal(JSTART).then(function (lists) {
      if (!lists) return;
      if (!lists.every(function (l) { return reaches(l, JSTART); })) return loadJournal();
      drawJournal([].concat.apply([], lists));
    }).catch(function (e) { noAnswer("journal", e, "#journal-count"); });
  }
  // Under All, each stats poll: its newest lines are the first window whole, and past Show more they are added to what is drawn the same way.
  function statsLines(d) {
    var list = d.events || [];
    if (JLIMIT > JSTART && !reaches(list, RECENT)) return loadJournal();
    if (JLIMIT === JSTART) JFULL = list.length >= RECENT;
    drawJournal(list);
  }
  $("#journal-more").addEventListener("click", function () { JLIMIT = Math.min(JMAX, JLIMIT * 2 + 10); loadJournal(); });

  // ---- the numbers: the Status page before #248, kept whole — the jobs of the week are the shell's one reduce over the series (jobsSummary), the minutes its workerMinutes, the workers its workerCounts over the listing (WC); the metrics snapshot is read for when it was taken and the pool's history.
  function renderSystem(d) {
    var m = d.metrics, js = jobsSummary(d.series, 7), wm = workerMinutes(d.series, 7);
    var pool = d.pool, refAny = pool.referenced_by_any_release || {}, rec = pool.reclaimable || { objects: 0, bytes: 0 };
    var ringBytes = d.rings.reduce(function (x, r) { return x + (r.bytes || 0); }, 0);
    var pending = Math.max(0, (pool.objects || 0) - (refAny.objects || 0));
    var lastSyncEv = newest(d.latest, "sync"), synced = (d.coverage || []).filter(function (c) { return c.upstream_total != null; }).length, expected = (d.coverage || []).length;
    var sec = d.security || {}, secEv = latest(d.latest, "security");
    // Promotion is by evidence: the gate's last word per step, not a clock.
    var gateRc = latest(d.latest, "gate", "rc", "edge"), gateStable = latest(d.latest, "gate", "stable", "rc");
    var gateWord = function (g) { if (!g) return "no attempt yet"; var v = (g.payload && g.payload.verdict) || (g.status === "ok" ? "promote" : g.status === "warn" ? "skip" : "block"); return (v === "promote" ? "promoted" : v === "skip" ? "nothing new" : "blocked") + " " + ago(g.created_at); };
    var tiles = [
      ["Jobs waiting now", num(js.waiting), "pool jobs queued or leased, whatever their age" + (WC ? " · " + num(WC.alive) + " worker(s) alive, " + num(WC.building) + " building" : WC_DOWN ? " · " + esc(WC_DOWN) : "")],
      ["Jobs, 7 days", num(js.runs), num(js.failed) + " failed · " + num(js.done) + " done"],
      // The sum of the chart below (workerMinutes over jobs_daily), the number the Workers page says — not the snapshot's.
      ["Worker minutes, 7 days", num(wm.total), "on the project's workers, both architectures"],
      // Every coverage row, per architecture, the factory's among them (it builds, it never syncs) — the Pool's tile counts sources by name and leaves those out, and says so too.
      ["Sources synced", synced + " / " + expected, "rows per architecture · " + (lastSyncEv ? "last sync " + ago(lastSyncEv.created_at) + " · every 3 hours" : "no sync yet")],
      ["Promotion, by evidence", "edge → rc: " + gateWord(gateRc), "rc → stable: " + gateWord(gateStable) + " · after every sync, then every 3 h; two green checks make stable"],
      ["Security data", sec.updated_at ? ago(sec.updated_at) : "never", num(sec.advisories) + " advisories · Arch + Debian trackers, KEV, EPSS · every 3 h" + (secEv && secEv.status !== "ok" ? " · last run " + secEv.status : "")],
      ["Stored once", bytes(pool.bytes), num(pool.objects) + " objects, one per sha256"],
      ["Served by the rings", bytes(ringBytes), "what three copied trees would hold"],
      ["Reclaimable", bytes(rec.bytes), num(rec.objects) + " objects past retention" + (pending ? " · " + num(pending) + " awaiting a release" : "")],
      ["Snapshot", m ? ago(m.recorded_at) : "never", m ? "the pool measures itself every 30 minutes" : "no snapshot yet"],
      ["Estimated bill", "…", "Cloudflare, this month"]
    ];
    setTiles("#systiles", tiles);
    drawBill();

    var S = d.series || {};
    $("#c-pool").innerHTML = area((S.metrics || []).map(function (r) { return { t: Date.parse(r.created_at), v: Number(r.bytes || 0) }; }), bytes) +
      (S.metrics && S.metrics.length ? '<div class="legend"><span><i style="background:' + C.green + '"></i>' + num(S.metrics[S.metrics.length - 1].objects) + ' objects now</span></div>' : '');
    var days14 = lastDays(14), byDay = {};
    (S.imports_daily || []).forEach(function (r) { byDay[r.day] = r; });
    $("#c-imports").innerHTML = bars(days14.map(function (dd) { var r = byDay[dd]; return { label: dd.slice(5), value: r ? Number(r.packages) : 0, title: dd + ": " + (r ? num(r.packages) + " packages, " + bytes(r.bytes) + " in " + r.runs + " run(s)" : "no sync") }; }), num);
    // The shell's grid (heatGrid): the rings in the reader's order, the shell's word for a result.
    $("#c-health").innerHTML = heatGrid(S.health);
    var runs = (S.sync_runs || []).slice().reverse().filter(function (r) { return r.bytes && r.duration_ms; });
    $("#c-sync").innerHTML = bars(runs.map(function (r) { var mbs = Number(r.bytes) / 1048576 / (Number(r.duration_ms) / 1000); return { label: r.source.slice(0, 5) + (r.arch === "aarch64" ? "/arm" : ""), value: Math.round(mbs * 10) / 10, color: r.status === "ok" ? C.green : C.amber, title: r.source + " " + r.arch + " " + ago(r.created_at) + ": " + num(r.uploaded) + " packages, " + bytes(r.bytes) + " in " + dur(r.duration_ms) + " → " + (Math.round(mbs * 10) / 10) + " MB/s" + (r.concurrency ? " with " + r.concurrency + " workers" : "") }; }), function (v) { return v + " MB/s"; });
    // Per kind and per day, the shell's one reduce (js above): the bars, the tooltips and the table read its buckets.
    var byKind = js.byKind;
    $("#c-jobs").innerHTML = hbars(Object.keys(byKind).sort(function (a, b) { return (byKind[b].done + byKind[b].failed) - (byKind[a].done + byKind[a].failed); }).map(function (k) { var v = byKind[k]; return { label: k, note: num(v.runs) + " · " + Math.round(v.ms / 60000) + " min", parts: [{ v: v.done, color: C.green, name: "done" }, { v: v.failed, color: C.red, name: "failed" }, { v: v.waiting, color: C.blue, name: "waiting" }] }; })) +
      '<div class="legend"><span><i style="background:' + C.green + '"></i>done</span><span><i style="background:' + C.red + '"></i>failed</span><span><i style="background:' + C.blue + '"></i>waiting</span></div>';
    // The shell's builds per day (staged, published, failed), one bar a day: red on a day more builds failed than got through.
    var builds = buildsByDay(S, 14);
    $("#c-builds").innerHTML = bars(builds.labels.map(function (dd, i) { var staged = builds.days[i].staged, published = builds.days[i].published, failed = builds.days[i].failed; return { label: dd.slice(5), value: staged + published + failed, color: failed > published + staged ? C.red : C.green, title: dd + ": " + staged + " staged, " + published + " published, " + failed + " failed" }; }), function (v) { return v + " build(s)"; });
    // The minutes per day are the shell's one sum (workerMinutes), the tile above its total; the jobs and failures of the day ride the tooltip.
    $("#c-minutes").innerHTML = bars(wm.labels.map(function (dd, i) { var r = js.byDay[dd]; return { label: dd.slice(5), value: wm.values[i], color: C.blue, title: dd + ": " + (r ? wm.values[i] + " min in " + r.runs + " jobs, " + r.failed + " failed" : "no jobs") }; }), function (v) { return v + " min"; });
    // One row per job kind: the journal's latest entry and the week's totals — the same buckets the chart drew, so the column sums to the tile.
    var kinds = Object.keys(js.byKind).sort().map(function (k) { var v = js.byKind[k], l = (d.latest || []).filter(function (e) { return e.kind === k; }).sort(function (x, y) { return Date.parse(y.created_at) - Date.parse(x.created_at); })[0]; return { kind: k, last: l, runs: v.runs, failed: v.failed, waiting: v.waiting, minutes: Math.round(v.ms / 60000) }; });
    pager("#workflows", kinds, function (w) {
      var l = w.last, st = l ? l.status : "—", cls = st === "ok" ? "ok" : st === "error" ? "error" : st === "warn" ? "warn" : "";
      return '<tr><td>' + esc(w.kind) + '</td><td><span class="dot ' + cls + '"></span>' + esc(st) + (l ? ' <span class="when">' + ago(l.created_at) + '</span>' : '') + '</td><td class="num">' + num(w.runs) + '</td><td class="num">' + (w.failed ? '<span style="color:var(--red)">' + num(w.failed) + '</span>' : '0') + '</td><td class="num">' + (w.waiting ? '<span style="color:var(--blue)">' + num(w.waiting) + '</span>' : '0') + '</td><td class="num">' + num(w.minutes) + '</td></tr>';
    }, { empty: 'no jobs yet — the pool queues them on schedule and project workers pull them', n: 25 });
  }

  // The bill, estimated __CADENCE__ from Cloudflare's analytics (cost.ts); the guard pauses writing jobs over budget. Asked once per stats poll, as the page always did, and kept (BILL) for the tiles drawn again between polls when the listing answers. The colour and the figure are the shell's (costColor, usd).
  var BILL = null;
  function loadCost() {
    api("GET", "/api/v1/cost").then(function (c) { BILL = { c: c }; drawBill(); }).catch(function (e) { BILL = { why: noAnswer("cost estimate", e) }; drawBill(); });
  }
  function drawBill() {
    var el = $("#systiles"), cell = el && el.children[el.children.length - 1], c = BILL && BILL.c; if (!cell || !BILL) return;
    if (BILL.why) { setTile(cell, '<div class="k">Estimated bill</div><div class="v num">—</div><div class="s">' + esc(BILL.why) + '</div>'); return; }
    if (!c || c.error) { setTile(cell, '<div class="k">Estimated bill</div><div class="v num">—</div><div class="s">no estimate yet (__CADENCE__)</div>'); return; }
    setTile(cell, '<div class="k">Estimated bill</div><div class="v num" style="color:' + costColor(c) + '">' + usd(c.projected_usd) + '</div><div class="s">projected for ' + esc(c.month) + ' · ' + usd(c.month_to_date_usd) + ' so far · ' + ago(c.estimated_at) + (c.guard ? ' · <b>over budget: writing jobs paused</b>' : '') + '</div>');
  }

  // What a pool job was asked, in words, from the params the brain wrote when it queued the job (src/scheduler.ts syncJobFor, src/jobs.ts): the scheduler's sync is one task per architecture with every source of it as a JSON list in sources; a sync queued by hand for one source names it; promote and rollback name their rings; render, health and verify a ring and an architecture; gc how many releases to keep. The three jobs on a build — the audit and the trial queued when it staged (routes/factory.ts), the publish its approval queued (routes/review.ts) — name the package and the build.
  function paramsLabel(t) {
    var p = t.params || {};
    if (t.kind === "audit" || t.kind === "trial" || t.kind === "publish") return [p.name, p.version, p.task ? "build #" + p.task : null].filter(Boolean).join(" · ");
    if (t.kind === "sync" && p.sources) { var n = 0; try { n = JSON.parse(p.sources).length; } catch (e) {} return [p.arch, n + " source" + (n === 1 ? "" : "s")].filter(Boolean).join(" · "); }
    if (t.kind === "sync") return [p.source && p.arch ? p.source + "/" + p.arch : p.source, p.ring ? "→ " + p.ring : null].filter(Boolean).join(" ");
    if (t.kind === "promote") return [p.from && p.to ? p.from + " → " + p.to : null, p.arch, p.force === "yes" ? "forced" : null].filter(Boolean).join(" · ");
    if (t.kind === "rollback") return [p.ring && p.to ? p.ring + " → release " + p.to : p.ring, p.arch].filter(Boolean).join(" · ");
    if (t.kind === "gc") return p.keep ? "keep " + p.keep : "";
    if (t.kind === "verify") return [p.ring && p.arch ? p.ring + "/" + p.arch : p.ring || p.arch, p.repair === "no" ? "report only" : null].filter(Boolean).join(" · ");
    return p.ring && p.arch ? p.ring + "/" + p.arch : "";
  }
  // A pool job's result, in words: what it did rather than its JSON. The shapes are what the Rust jobs post (crates/pkg-repo/src/work.rs, every result: serde_json::json!), and test/pool-jobs.test.ts runs this over one done job of every kind seeded as work.rs writes it — a field renamed there and not here reads as a zero, which is what every sync row said until 2026-09-18. A release is named by its id first — "release 512", the number the diff page and the roll back read — with the ring's head "(edge #346)" after it where the result carries the sequence: one column, one form.
  function jobResult(t) {
    var r = t.result || {};
    var releaseWords = function (list) { return list.length ? " · release " + list.map(function (x) { return x.id + " (" + x.ring + " #" + x.seq + ")"; }).join(", ") : " · unchanged"; };
    if (t.kind === "sync" && r.sources) {
      var sum = { upstream_total: 0, uploaded: 0, removed: 0, failed: 0 }, down = [];
      r.sources.forEach(function (s) { if (s.error) down.push(s.source); Object.keys(sum).forEach(function (k) { sum[k] += Number(s[k] || 0); }); });
      return "upstream " + num(sum.upstream_total) + " · uploaded " + num(sum.uploaded) + " · removed " + num(sum.removed) + (sum.failed ? " · failed " + num(sum.failed) : "") + (down.length ? " · " + down.join(", ") + " down" : "") + releaseWords(r.releases || []);
    }
    if (t.kind === "sync") { var ring = (t.params || {}).ring; return "upstream " + num(r.upstream_total) + " · uploaded " + num(r.uploaded) + " · removed " + num(r.removed) + (r.failed ? " · failed " + num(r.failed) : "") + (r.release ? " · release " + r.release[0] + " (" + (ring ? ring + " " : "") + "#" + r.release[1] + ")" : " · unchanged"); }
    if (t.kind === "promote") {
      var p = t.params || {};
      return r.verdict === "promoted" ? "promoted → " + (p.to || "") + ", release " + r.release_id
        : r.verdict === "blocked" ? "blocked — " + (r.reasons || []).join("; ")
        : r.verdict === "rolled-back" ? "rolled back to release " + r.to + " — health failed on " + (r.unhealthy || []).join(", ")
        : r.verdict === "skip" ? "nothing to promote" + (r.why ? " — " + r.why : "") : JSON.stringify(r);
    }
    if (t.kind === "rollback") return r.ring + " rolled back to release " + r.to + " as release " + r.release_id;
    if (t.kind === "health") return r.ok ? HEALTH_WORD.ok : HEALTH_WORD.error;
    if (t.kind === "gc") return "kept the last " + r.keep + " releases per ring";
    if (t.kind === "render") return "rendered " + (r.repos || []).join(", ");
    if (t.kind === "security") return num(r.matches_vulnerable) + " vulnerable / " + num(r.matches_fixed) + " fixed matches · " + num(r.kev) + " in KEV" + ((r.fast_tracked || []).length ? " · fast-tracked into " + r.fast_tracked.map(function (f) { return f.ring + " (" + num(f.fixes) + " fix" + (f.fixes === 1 ? "" : "es") + ")"; }).join(", ") : " · nothing to fast-track") + ((r.rolled_back || []).length ? " · rolled back " + r.rolled_back.join(", ") : "");
    if (t.kind === "verify") return num(r.objects) + " objects" + (r.bad_signatures ? " · " + num(r.bad_signatures) + " bad signatures, " + num(r.repaired_signatures) + " repaired" : "") + (r.mismatched ? " · " + num(r.mismatched) + " mismatched, " + num(r.repinned) + " re-pinned" : "") + (r.unfixable ? " · " + num(r.unfixable) + " unfixable" : !r.bad_signatures && !r.mismatched ? " · all verify" : "");
    if (t.kind === "relayout") return num(r.moved) + " moved · " + num(r.ghosts) + " ghosts · " + num(r.missing) + " missing · " + num(r.purged) + " old keys purged" + ((r.errors || []).length ? " · " + num(r.errors.length) + " errors" : "");
    if (t.kind === "enqueue") return "main@" + String(r.commit || "").slice(0, 7) + ": " + num((r.queued || []).length) + " queued, " + num((r.skipped || []).length) + " skipped, " + num(r.up_to_date) + " up to date";
    // The three jobs on a build, in the words Review's pills use for the same facts: the audit's report, the trial's verdict over the packages it installed, the file the publish put in the pool and the rings the fast lane gave it.
    if (t.kind === "audit") { var nf = (r.findings || []).length; return r.verdict + " · " + num(nf) + " finding" + (nf === 1 ? "" : "s") + (r.summary ? " — " + r.summary : ""); }
    if (t.kind === "trial") { var np = (r.packages || []).length; return (r.verdict === "ok" ? "installs" : "trial " + r.verdict) + " · " + num(np) + " package" + (np === 1 ? "" : "s"); }
    if (t.kind === "publish") return "published " + (r.filename || "") + ((r.fast_track || []).length ? " · fast-tracked to " + r.fast_track.join(", ") : "") + ((r.rendered || []).length ? " · rendered " + r.rendered.join(", ") : "");
    // A kind this page has no words for yet: its JSON, cut — every kind the pool queues has its sentence above, and pool-jobs.test.ts runs one done job of each.
    return JSON.stringify(r).slice(0, 90);
  }
  // Every task of the listing: a build by its package, a pool job by what it was asked and what it did; the worker it ran on the shell's wtId (the listing's row, or the bare id where the listing no longer has one); a published build linked in edge at its one address, a staged one's evidence at its page; one an emulated worker sent back, the native worker it waits for (the shell's nativePill).
  function drawTasks() {
    if (!FACTORY) return;
    var byId = {}; (FACTORY.workers || []).forEach(function (w) { byId[w.id] = w; });
    pager("#tasks", FACTORY.tasks || [], function (t) {
      var result = t.status === "staged"
        ? '<span class="mono">' + esc(t.result_filename || "") + '</span> ' + evidenceLink(t)
        : t.status === "done" && t.result_filename && t.result_filename !== "-"
        ? (t.publish === 0 ? '<span class="mono">' + esc(t.result_filename) + '</span>' : '<a href="' + pkgHref(t.name, "edge", t.arch) + '" class="mono">' + esc(t.result_filename) + '</a>')
        : t.status === "done" && t.result ? '<span class="muted">' + esc(jobResult(t)) + '</span>'
        : (t.error ? '<span class="muted" title="' + esc(t.error) + '">' + esc(t.error.slice(0, 90)) + '</span>' : '<span class="muted">—</span>');
      var what = t.kind && t.kind !== "build" ? '<b>' + esc(t.kind) + '</b> <span class="muted">' + esc(paramsLabel(t)) + '</span>' : '<b>' + esc(t.name) + '</b>' + (t.version ? ' <span class="mono muted">' + esc(t.version) + '</span>' : '');
      return '<tr><td><a href="/build/' + t.id + '" title="the task, whole: what happened, the worker, the evidence">' + t.id + '</a></td><td>' + what + '</td><td>' + esc(t.arch) + '</td>' +
        '<td>' + taskPill(t.status) + (waitsForNative(t) ? ' ' + nativePill(t) : '') + (t.trust === "community" ? ' <span class="pill none" title="a contributor\'s build: goes to staging, a maintainer approves">' + esc(t.owner || "community") + '</span>' : '') + (t.publish === 0 && t.trust !== "community" ? ' <span class="pill none" title="built and measured, never published">dry run</span>' : '') + (t.attempts > 1 ? ' <span class="muted">attempt ' + t.attempts + '/' + t.max_attempts + '</span>' : '') + '</td><td>' + esc(t.reason) + '</td>' +
        '<td>' + (t.lease_owner ? wtId(byId[t.lease_owner] || t.lease_owner) : '<span class="muted">—</span>') + '</td><td>' + (dur(t.duration_ms) || "—") + '</td><td>' + result + '</td></tr>';
    }, { empty: "nothing queued or built yet", text: function (t) { return [t.id, t.kind, t.name, t.arch, t.status, t.reason, t.lease_owner, t.owner, paramsLabel(t)].join(" "); } });
  }

  // OPR recipes in stable by where each comes from: Omarchy's own, synced from the AUR, unknown — the facts, as each package page says them.
  function renderProvenance(d) {
    var pv = d.provenance && d.provenance.stable; var el = $("#provenance"); if (!pv || !el || !pv.packages) return;
    el.hidden = false;
    el.innerHTML = '<b>OPR recipes in stable:</b> ' + num(pv.packages) + ' packages — ' + num(pv.local) + " Omarchy's own, " + num(pv.aur) + ' synced from the AUR' + (pv.unknown ? ', ' + num(pv.unknown) + ' of unknown origin' : '') + ' (<a href="https://github.com/omacom/omarchy-pkgs/tree/master/pkgbuilds">omarchy-pkgs</a>, read daily; each package page says which).';
  }
  // Architecture-independent packages in stable, and how many of them the pool stores once per architecture (each architecture's source signs its own copy).
  function renderAny(d) {
    var a = d.any && d.any.stable; var el = $("#any"); if (!a || !el || !a.names) return;
    el.hidden = false;
    el.innerHTML = '<b>Architecture-independent packages in stable:</b> ' + num(a.names) + ' (' + num(a.objects) + ' objects, ' + bytes(a.bytes) + ') — ' + num(a.twice) + ' of them stored once per architecture (' + bytes(a.extra_bytes) + ').';
  }
  function renderCoverage(d) {
    renderProvenance(d);
    renderAny(d);
    var cov = (d.coverage || []).slice().sort(function (a, b) { return a.arch === b.arch ? (a.source < b.source ? -1 : 1) : ARCHES.indexOf(a.arch) - ARCHES.indexOf(b.arch); });
    function pctOf(have, up) { if (!up) return 0; var p = 100 * have / up; return p >= 100 ? 100 : Math.floor(p); }
    pager("#coverage", cov, function (c) {
      var pending = c.upstream_total == null, pct = pctOf(c.indexed, c.upstream_total);
      return '<tr><td title="' + esc(c.upstream || "") + '">' + esc(c.source) + '</td><td>' + esc(c.arch) + '</td><td class="num">' + (pending ? '—' : num(c.upstream_total)) + '</td><td class="num">' + num(c.indexed) + '</td><td class="num">' + (pending ? '—' : c.missing ? '<span style="color:var(--amber)">' + num(c.missing) + '</span>' : '0') + '</td><td class="num">' + num(c.pinned_stable) + '</td>' +
        '<td>' + (pending ? pillHtml("none", "not synced yet") : '<span class="bar"><i class="' + (pct < 100 ? 'partial' : '') + '" style="width:' + pct + '%"></i></span><span class="pct">' + pct + '%</span>') + '</td><td class="num">' + bytes(c.bytes) + '</td><td class="when" title="' + esc(c.last_sync || "") + '">' + (pending ? '—' : ago(c.last_sync) + (lateSync(c) ? ' ' + pillHtml("warn", "late") : c.last_status !== "ok" ? ' ' + pillHtml(c.last_status, c.last_status) : '')) + '</td></tr>';
    }, { n: 25 });
  }
  // The service, measured now: four lines from one answer, and the hero's first word when the index or the pool behind the API does not answer. The check answers 503 when either failed, with the body that says which — read here, not through api(), which rejects every 5xx and would call a check that answered one that did not. A check that did not answer — no body of its shape, or nothing at all — is one line saying so, not "answering" over a body that has no times, and not a TypeError's text.
  function renderService() {
    busy(fetch("/api/v1/status")).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (s) {
        // Anything else is api()'s failure, in its words: the body's error, or "HTTP <status>".
        if (!s || !s.index || !s.pool || !s.checked_at) { var e = new Error((s && s.error) || "HTTP " + r.status); e.status = r.status; throw e; }
        return s;
      });
    }).then(function (s) {
      var items = [
        ["ok", "API", "answering · " + esc(s.checked_at.replace("T", " ").slice(0, 19)) + " UTC"],
        [s.index.ok ? "ok" : "error", "index · D1", s.index.ok ? s.index.ms + " ms" : esc(s.index.error || "failed")],
        [s.pool.ok ? "ok" : "error", "pool · R2", s.pool.ok ? s.pool.ms + " ms" : esc(s.pool.error || "failed")],
        [s.signing ? "ok" : "warn", "signing", s.signing ? "the pool's key is loaded" : "no signing key"]
      ];
      $("#service").innerHTML = items.map(function (t) { return '<div><i class="led ' + t[0] + '"></i><b>' + t[1] + '</b><span>' + t[2] + '</span></div>'; }).join("");
      var down = [s.index.ok ? null : "the index (" + (s.index.error || "failed") + ")", s.pool.ok ? null : "the pool (" + (s.pool.error || "failed") + ")"].filter(Boolean);
      SERVICE = { down: !s.index.ok ? "The index is not answering" : !s.pool.ok ? "The pool is not answering" : null, why: down.length ? "The API could not reach " + down.join(" or ") + " just now." : "" };
      drawHero();
    }).catch(function (e) {
      var why = noAnswer("service check", e);
      $("#service").innerHTML = '<div><i class="led error"></i><b>API</b><span>' + esc(why) + '</span></div>';
      SERVICE = { down: "The service check did not answer", why: reasonLine(e) };
      drawHero();
    });
  }
  // The pool's numbers did not answer (liveStats's read of /api/v1/stats): said in the hero and once where each section drawn from them would be — never "Checking the rings…" and "Loading" for good. A poll that fails after one answered leaves what it drew: a refresh that failed is not a pool that emptied (the shell's rule, noAnswer).
  function statsDown(e) {
    if (STATS) return;
    var why = noAnswer("pool's numbers", e), line = '<p class="st-empty">' + esc(why) + '</p>', tip = ' title="' + esc(why) + '"';
    STATS_DOWN = reasonLine(e);
    drawHero();
    $("#st-rings").innerHTML = PROMISED_UPWARD.map(function (ring) { return '<article class="op-card ' + ring + ' st-ring" id="ring-' + ring + '"><div class="st-ring-h"><span class="st-ring-t"><b class="op-ring-name ' + ring + '">' + ring + '</b></span></div><p class="st-wait"' + tip + '>did not answer</p></article>'; }).join("");
    $("#sources-rows").innerHTML = '<tr><td colspan="5" class="st-dim"' + tip + '>' + esc(why) + '</td></tr>';
    $("#checks-list").innerHTML = line;
    ["#t-sync", "#t-checks"].forEach(function (t) { $(t + "-n").textContent = "—"; $(t + "-s").innerHTML = '<span' + tip + '>did not answer</span>'; });
    if (JF === "all" && JLIMIT === JSTART && !JLAST.length) { $("#journal-list").innerHTML = line; $("#journal-more").hidden = true; }
  }

  // ---- the requested packages, while the numbers are open (the Pipeline's registry before #248, until the Factory draws its line, #246): the factory's list, read with the listing (half a minute at the edge); the table is served hidden and shown once it has its rows, the note saying why when they did not come. A project's address is a link only when it is https (runHref): it is whatever the request said.
  function loadRegistry() {
    api("GET", "/api/v1/factory/packages").then(function (d) { $("#registry-note").textContent = ""; $("#registry-wrap").hidden = false; renderRegistry(d.packages || []); })
      .catch(function (e) { noAnswer("factory's packages", e, "#registry-note"); });
  }
  function renderRegistry(pkgs) {
    pager("#registry", pkgs, function (p) {
      var det = p.detected || {}, home = String(p.project || p.url || ""), link = runHref(home);
      return '<tr><td><b>' + esc(p.name) + '</b>' + (p.request_id ? ' <a class="st-link" href="' + esc(POOL + "/factory/" + encodeURIComponent(p.name) + "/" + Number(p.request_id) + "/request.json") + '" title="the request, on the record">#' + Number(p.request_id) + '</a>' : '') + '</td>' +
        '<td>' + (link ? '<a class="st-link" href="' + esc(link) + '">' + esc(home.replace(/^https:\/\/(www\.)?(github\.com\/)?/, "")) + '</a>' : esc(home)) + '</td><td>' + esc(p.owner) + '</td><td>' + esc((p.arches || []).join(", ")) + '</td>' +
        '<td>' + esc([p.release || det.latest_tag, p.license || det.license].filter(Boolean).join(" · ")) + '</td><td>' + taskPill(p.status) + (p.staged_builds ? ' <span class="muted">' + num(p.staged_builds) + ' staged</span>' : '') + '</td><td>' + esc(p.detail || "") + '</td><td>' + ago(p.updated_at) + '</td></tr>';
    }, { empty: 'no package requested yet — <a href="/factory">be the first</a>', text: function (p) { return [p.name, p.category, p.owner, p.url, p.status].join(" "); } });
  }

  // ---- the page: what the address names is opened (a fold) and landed on once the first answer drew what is above it; the rest keeps its pace.
  function land() {
    if (LANDED) return; LANDED = true;
    var id = location.hash ? location.hash.slice(1) : "", el = id && document.getElementById ? document.getElementById(id) : null;
    if (el && el.tagName === "DETAILS") el.open = true;
    // /security lands on the Advisories card: its list, every open advisory, is opened below it, as the page it was showed it.
    if (id === "advisories") $("#advisory-list").open = true;
    if (el && el.scrollIntoView) el.scrollIntoView();
  }
  function render(d) {
    STATS = d;
    drawHero(); drawTiles(d); drawRings(d); drawHistory(d); drawSources(d); drawChecks(d);
    if (JF === "all") statsLines(d);
    renderCoverage(d); renderSystem(d); loadCost(); endSkeleton(); land();
  }
  $("#numbers").addEventListener("toggle", function () { NUMBERS = !!this.open; if (NUMBERS) loadFactory(); });
  // The rings, the history and a maintainer's buttons are drawn again once the session says who is looking.
  whoami(function () { if (STATS) { drawRings(STATS); drawHistory(STATS); } });
  drawChips(); loadJournal(); setInterval(refreshJournal, 60000);
  loadFactory(); setInterval(loadFactory, 60000);
  loadEvidence(); setInterval(loadEvidence, 300000);
  loadStableTile(); loadAdvisories();
  renderService(); setInterval(renderService, 60000);
  liveStats(render, 60000, statsDown);
`;

export function statusHtml(poolUrl: string, version: RunningVersion): string {
  // rc → stable is tried on the scheduler's rule (scheduler.ts RULES), read here when the page is drawn: the stable card's next window follows it.
  const promoteEvery = RULES.find((r) => r.job?.kind === "promote" && r.job.params.to === "stable")?.every ?? 180;
  return page({
    path: "/status",
    title: "Status · omarchy-pool",
    description: "Whether every ring is healthy, each ring's releases, the sources and the workers, the health checks and rollbacks, the advisories, and the journal of everything the pool did.",
    active: "none",
    kit: true,
    css: CSS,
    body: BODY,
    script: SCRIPT.replace("__CHARTS__", CHARTS)
      .replace("__KINDS__", JSON.stringify(JOURNAL_KINDS))
      .replace("__SOURCES__", JSON.stringify(sourcesForScript()))
      .replace("__HISTORY__", String(RING_HISTORY))
      .replace("__RECENT__", String(RECENT_EVENTS))
      .replace("__PROMOTE_EVERY__", String(promoteEvery))
      .replace("__FEEDS__", JSON.stringify(FEEDS))
      .split("__CADENCE__").join(ESTIMATE_CADENCE),
    poolUrl,
    version,
  });
}

/**
 * What /status is made of: the design's six sections, then the numbers.
 * Everything reads what the dashboard already served — the stats (liveStats),
 * the worker listing, the journal by kind, an advisories report, the
 * service check, the bill — and nothing writes but a maintainer's roll back,
 * the shell's job (POST /factory/jobs), and their forced promotion, the same
 * job with their passkey (#284). The stable ring is the third of
 * RINGS (edge, rc, stable, lab), so a release's fields are read at
 * `rings.2`; the fixture's two stable releases are the ring's history.
 */
export const STATUS_COMPONENTS = (F: Fixture): Component[] => {
  const stats = "/api/v1/stats";
  const report = `/api/v1/security?ring=stable&arch=${F.arch}`;
  return [
    {
      // All rings healthy, or what is not: a service check that did not answer, a ring whose latest check failed, the shell's problemsOf.
      id: "status.hero",
      page: "/status",
      anchor: ['<p class="op-eyebrow">Status</p>', 'id="st-mark"', 'id="headline"', 'id="st-lede"', "Every sync, release, check and decision is on the record."],
      script: ['"#headline"', "problemsOf(d)", '"All rings healthy"', '" not healthy"', 'latest(d.latest, "health", ring, arch)', "SERVICE.down", "liveStats(render, 60000, statsDown)", '"The pool\'s numbers did not answer"', "reasonLine(e)", '"No ring released yet"', '" sources not on time"'],
      reads: [{ path: stats, fields: ["latest", "latest.0.kind", "latest.0.status", "latest.0.ring", "latest.0.source", "latest.0.created_at", "coverage.0.last_sync", "coverage.0.late"] }],
      visible: EVERYONE,
    },
    {
      // The four numbers, each a link to its section: the last sync and the sources on time, today's health checks, the rollbacks of the month (a rollback once: rolled_back_to marks a promotion's own second line), the packages open in stable.
      id: "status.tiles",
      page: "/status",
      anchor: ['<a class="op-stat" href="#sources">', 'id="t-sync-n"', 'id="t-checks-n"', 'id="t-rollbacks-n"', '<a class="op-stat" href="#advisories">', 'id="t-adv-n"'],
      script: ['newest(d.latest, "sync")', '" sources on time"', 'tileCount($("#t-checks-n"), checks.length)', "el.stTo === to", "HEALTH_WORD.error", "e.payload.rolled_back_to", '"this month"', '"/api/v1/events?kind=rollback&limit=50"', "advisoryCounts(advisoriesAt(s))", "confWord()"],
      reads: [
        { path: stats, fields: ["series.health", "series.health.0.ring", "series.health.0.status", "series.health.0.created_at", "coverage.0.indexed", "coverage.0.last_status"] },
        { path: "/api/v1/events?kind=rollback&limit=50", fields: ["events"] },
        { path: report, fields: ["vulnerable", "vulnerable.0.advisories.0.match", "vulnerable.0.advisories.0.severity"] },
      ],
      visible: EVERYONE,
    },
    {
      // A card per ring the way a package climbs: its release, when, how many packages, its health per architecture (the shell's HEALTH_WORD on hover), its last releases — a rollback red, each linking its diff — and where it goes next.
      id: "status.releases",
      page: "/status",
      anchor: ['<section class="st-sec" id="releases"', 'id="st-rings"', '<a href="/diff">What stable last changed →</a>'],
      script: ["PROMISED_UPWARD.map(function (ring)", "historyOf(d, ring)", "r.source_ring === r.ring", 'href="/diff?ring=', "num(r.package_count)", "HEALTH_WORD[h.status]", '" rollbacks"', "serves(r, arch)"],
      reads: [
        {
          path: stats,
          fields: [
            "rings.2.ring", "rings.2.release.id", "rings.2.release.seq", "rings.2.release.parent_id", "rings.2.release.source_id", "rings.2.release.created_at", "rings.2.package_count", "rings.2.sources.0.arch", "rings.2.artifacts.0.kind", "rings.2.artifacts.0.arch",
            "releases", "releases.0.id", "releases.0.ring", "releases.0.seq", "releases.0.parent_id", "releases.0.source_id", "releases.0.source_ring", "releases.0.note", "releases.0.created_at", "releases.0.is_head",
          ],
        },
        { path: "/diff", json: false },
      ],
      visible: EVERYONE,
    },
    {
      // Where a ring's head goes next: in the ring above already, held back, or a candidate with its green checks since release (the gate's own count) against the soak the step's last gate asked for; stable's next window on the scheduler's rule.
      id: "status.next-promotion",
      page: "/status",
      anchor: ['id="st-rings"'],
      script: ['latest(d.latest, "gate", up, ring)', "greensSince(d, ring, a, rel.created_at)", "p.soak_checks", '"held back · "', '" candidate · "', "PROMOTE_EVERY_MIN * 60000", '"next promotion window in "'],
      reads: [{ path: stats, fields: ["latest", "series.health.0.id", "series.health.0.arch"] }],
      visible: EVERYONE,
    },
    {
      // A maintainer's roll back: on a ring's card (to the release before its head, named by its sequence and its id; none when the head is a rollback, whose parent is the release that failed) and on every release of the history but a head — the shell's button (data-rollback: it asks why, posts the job once, writes #rb-state), drawn for a maintainer only. Queued, never run: no worker claims it in the tests, so what stable serves does not change; `to` is a string, as the button's attribute sends it.
      id: "status.rollback",
      page: "/status",
      anchor: ['id="rb-state" hidden'],
      script: ["function rollbackButton(ring, id, label) { return isMaintainer() ?", 'data-rollback="', 'data-ring="', '"Roll back to "', "!(headRow && isRollback(headRow))", 'whoami(function () { if (STATS) { drawRings(STATS); drawHistory(STATS); } })'],
      reads: [{ path: "/auth/me", as: "maintainer", fields: ["role"] }],
      acts: [{ method: "POST", path: "/api/v1/factory/jobs", body: { kind: "rollback", params: { ring: "stable", to: String(F.previousRelease), note: "the Status page's roll back, from the fixture" } }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 201 } }],
      visible: ["maintainer"],
    },
    {
      // A maintainer's forced promotion (#284): on edge's and rc's cards, the head into the ring above past its evidence and the gate — asked why and which architectures (both, or one), confirmed with the maintainer's passkey for exactly this promotion (the shell's passkeyed), queued once, written to #rb-state. The tests' pool.test is no relying party, so every maintainer is refused there (rp_unavailable) and nothing is queued; the passkey's door is passkey-doors.test.ts's.
      id: "status.force-promotion",
      page: "/status",
      anchor: ['id="rb-state" hidden'],
      script: ["function forceButton(ring, up) { return isMaintainer() ?", 'data-force="', '"Force into " + up', 'PROMISED_UPWARD[PROMISED_UPWARD.indexOf(ring) + 1]', 'ARCHES.map(function (a) { return { value: a, text: a + " only" }; })', 'select: { label: "Architectures", options: both }', 'passkeyed("promote:force:" + from + ":" + to + (arch ? ":" + arch : "")', 'force: "yes"', "if (arch) params.arch = arch;", '"Force with your passkey"', "refusalHtml(j)"],
      reads: [{ path: "/auth/me", as: "maintainer", fields: ["role"] }],
      acts: [{ method: "POST", path: "/api/v1/factory/jobs", body: { kind: "promote", params: { from: "rc", to: "stable", force: "yes", note: "the Status page's forced promotion, from the fixture" } }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } }],
      visible: ["maintainer"],
    },
    {
      // Every release the stats carry of the promised rings: what it changed, where it came from, a maintainer's roll back.
      id: "status.history",
      page: "/status",
      anchor: ['<details class="op-card st-fold" id="history">', 'id="history-table"'],
      script: ['pager("#history-table"', '"rollback to release "', '"promoted from "', "'&from=' + r.parent_id + '&to=' + r.id", "r.is_head"],
      reads: [{ path: stats, fields: ["releases.0.id", "releases.0.ring", "releases.0.seq", "releases.0.package_count", "releases.0.parent_id", "releases.0.source_id", "releases.0.source_ring", "releases.0.note", "releases.0.created_at", "releases.0.is_head"] }],
      visible: EVERYONE,
    },
    {
      // A row per project the pool syncs from, summed over its coverage rows: its repositories, the packages edge pins, what its syncs brought today (the stats' coverage.today), when the least recent of them synced — late by the shell's one rule, syncing while a leased sync task holds one; the factory's today is its publish jobs done today.
      id: "status.sources",
      page: "/status",
      anchor: ['id="sources"', 'id="sources-rows"', '<th class="num">Today</th>'],
      script: ['$("#sources-rows").innerHTML', "c.today", "lateSync(c)", 'c.last_status === "error"', "syncingNow()", 't.kind !== "sync" || t.status !== "leased"', "jobsSummary(d.series, 1).byKind.publish", '"syncing…"', '"live"'],
      reads: [
        { path: stats, fields: ["coverage", "coverage.0.source", "coverage.0.arch", "coverage.0.indexed", "coverage.0.today", "coverage.0.last_sync", "coverage.0.last_status", "coverage.0.late", "series.jobs_daily"] },
        // Leased tasks come first in the listing; the fixture's sync job, done, is read further down it.
        { path: "/api/v1/factory?limit=10", fields: ["tasks", "tasks.0.kind", "tasks.0.status", "tasks.0.params"] },
        { path: "/api/v1/factory?limit=100", fields: ["tasks.kind=sync.params.arch", "tasks.kind=sync.params.sources"] },
      ],
      visible: EVERYONE,
    },
    {
      // The project's workers, live (the listing once a minute): the agent's mark (the kit's agentMark) and the model, both named as a reader says them, the worker's name, what each is doing and for how long, a bar that runs while it works; one alive but not ready said so, with why (the shell's wtNotReady, the agent's error on hover — #273), and counted beside the busy; how many are busy (the shell's workerCounts); the listing that did not answer said in the card's foot.
      id: "status.workers",
      page: "/status",
      anchor: ['id="workers"', 'id="workers-list"', 'id="workers-busy"', 'id="workers-note"', 'href="/workers"'],
      script: ['api("GET", "/api/v1/factory?limit=" + (NUMBERS ? 100 : 10))', "setInterval(loadFactory, 60000)", 'wtKind(w) !== "community"', "workerCounts(ws)", '" busy"', "workerName(w)", "agentMark(mark, agentName(s))", "modelOf(w.agent)", "paramsLabel(t)", 'WC_DOWN = noAnswer("worker listing", e)', "w.alive && !working && !w.ready", "wtNotReady(w)", "<b>not ready</b>", '" not ready"'],
      reads: [
        { path: "/api/v1/factory?limit=10", fields: ["workers", "workers.0.id", "workers.0.arch", "workers.0.side", "workers.0.labels", "workers.0.alive", "workers.0.ready", "workers.0.agent_error", "workers.0.agent_checked_at", "workers.0.current_task", "workers.0.agent", "workers.0.last_seen", "tasks.0.id", "tasks.0.kind", "tasks.0.name", "tasks.0.started_at"] },
        { path: "/workers", json: false },
      ],
      visible: EVERYONE,
    },
    {
      // The latest check of every ring and architecture, in the shell's word, with its green checks since release and where it climbs; and the rollbacks of the last 30 days, from the head they replaced to the release they went back to.
      id: "status.checks",
      page: "/status",
      anchor: ['id="checks"', 'id="checks-list"', "Health checks &amp; rollbacks"],
      script: ['$("#checks-list").innerHTML', "checkWord(d, ring, arch, h)", 'HEALTH_WORD.error + " · " + h.summary', "h.source || NULL_SOURCE_ARCH", '"rolled back · "', "rollbackRange(d, e)", "p.to_release_id", '"no health check yet"'],
      reads: [
        { path: stats, fields: ["latest.0.summary", "releases.0.parent_id"] },
        { path: "/api/v1/events?kind=rollback&limit=50", fields: ["events"] },
      ],
      visible: EVERYONE,
    },
    {
      // One report — the ring and architecture picked, stable and the first architecture unless the address says — counted by the shell's rule at the confidence picked: a package once under its worst severity (the server's SEVERITIES) in the shell's colour (SEV_COLOR), the exploited ones named; the packages most depend on; the security fixes the fast-track pulled this week.
      id: "status.advisories",
      page: "/status",
      anchor: ['<section class="op-card st-adv" id="advisories"', 'id="adv-sev"', 'id="adv-top"', 'id="adv-fast"', 'href="/status?kind=fast-track#journal"'],
      script: ['api("GET", "/api/v1/security?ring=" + ring + "&arch=" + arch)', "advisoriesAt(d, ADV_CONF)", "SEVERITIES.map(function (s)", "SEV_COLOR[s]", "SEV_COLOR.exploited", "exposureOf(r)", "SEV_COLOR[r.worst]", "FEEDS.length", '"/api/v1/events?kind=fast-track&limit=50"', "e.payload.fixes.length", '" fast-tracked this week"'],
      reads: [
        { path: report, fields: ["updated_at", "vulnerable", "vulnerable.0.name", "vulnerable.0.advisories.0.id", "vulnerable.0.advisories.0.severity", "vulnerable.0.advisories.0.kev", "vulnerable.0.exposure.declared", "vulnerable.0.exposure.loads"] },
        { path: "/api/v1/events?kind=fast-track&limit=50", fields: ["events"] },
      ],
      visible: EVERYONE,
    },
    {
      // The ring's report row by row (Security's table before #248), behind the pickers — ring, architecture, confidence — that the address carries (/security?ring=rc&arch=aarch64 lands here with its query and opens it).
      id: "status.advisory-list",
      page: "/status",
      anchor: ['<details class="op-card st-fold" id="advisory-list">', 'id="pick-ring"', 'id="pick-arch"', 'id="pick-conf"', 'id="updated"', 'id="vuln"', 'href="/docs/security"'],
      script: ['choose("#pick-ring", PROMISED_RINGS, ADV_RING', 'choose("#pick-arch", ARCHES, ADV_ARCH', 'choose("#pick-conf", SEC_CONFS, ADV_CONF', '"aria-pressed"', 'if (id === "advisories") $("#advisory-list").open = true', 'SEC_CONFS.indexOf(q.get("conf")) >= 0 ? q.get("conf") : SEC_CONF', '$("#advisory-list").open = true', 'pager("#vuln", rows', "sevPill(r.worst)", 'pillHtml(SEV_PILL.exploited, "exploited", "in CISA KEV")', "pkgHref(v.name, ring, arch)", "pkgHref(v.name, f.ring, arch)", "runHref(a.url)", "d.advisories_total"],
      reads: [
        { path: report, fields: ["advisories_total", "vulnerable.0.version", "vulnerable.0.source", "vulnerable.0.advisories.0.url", "vulnerable.0.advisories.0.fixed", "vulnerable.0.advisories.0.match", "vulnerable.0.advisories.0.epss", "vulnerable.0.fixed_in"] },
        { path: `/api/v1/security?ring=rc&arch=${F.arch}`, fields: ["ring", "arch", "vulnerable"] },
        { path: "/api/v1/security?ring=stable&arch=aarch64", fields: ["ring", "arch", "vulnerable"] },
        { path: "/docs/security", json: false },
      ],
      visible: EVERYONE,
    },
    {
      // The journal, live: All from the stats poll's newest lines, a chip asking the journal for its kinds when it is picked and for their newest twenty once a minute after (the window read again only when they do not reach it); an answer for a chip or a window no longer picked is dropped; ?kind= picks a chip or one of the journal's own kinds (KINDS, meta.ts), so /journal?kind=role stays filtered; Show more asks for more, up to two hundred lines, and stays while a read came back full.
      id: "status.journal",
      page: "/status",
      anchor: ['<section class="op-card st-jr" id="journal"', 'id="journal-chips"', 'id="journal-list"', 'id="journal-count"', 'id="journal-more"'],
      script: ["var KINDS = ", 'KINDS.indexOf(asked) >= 0 ? asked : "all"', 'syncs: ["sync"]', 'promotions: ["promote", "fast-track"]', 'decisions: ["approve", "withdraw", "review"]', 'blocks: ["block", "rollback"]', '{ url: "kind"', '"/api/v1/events?" + (k ? "kind=" + encodeURIComponent(k) + "&" : "") + "limit=" + limit', "setInterval(refreshJournal, 60000)", "f === JF && lim === JLIMIT", "reaches(l, JSTART)", "JFULL = lists.some(function (l) { return l.length >= lim; })", '"#journal"', 'noAnswer("journal", e, "#journal-count")', "op-fresh"],
      reads: [
        { path: stats, fields: ["events", "events.0.id", "events.0.kind", "events.0.status", "events.0.ring", "events.0.summary", "events.0.created_at", "events.0.payload"] },
        { path: "/api/v1/events?kind=sync&limit=20", fields: ["events"] },
        { path: "/api/v1/events?kind=approve&limit=20", fields: ["events", "events.0.payload.by"] },
        { path: "/api/v1/events?limit=50", fields: ["events", "events.0.kind"] },
      ],
      visible: EVERYONE,
    },
    {
      // Each line's who and agent: the people it names (payload.by, payload.proposed_by, payload.owner), the worker a job or a build ran on (payload.worker: its owner or the pool, and its agent where the work was an agent's), the agent #252 writes (payload.via.agent), else the pool; its run linked only when https (runHref), its release's diff only when a whole number.
      id: "status.journal-rows",
      page: "/status",
      anchor: ['id="journal-list"'],
      script: ["function journalRow(e, fresh)", "runHref(e.payload && e.payload.ci && e.payload.ci.run_url), rid = e.payload && Number(e.payload.release_id)", "rid === Math.floor(rid)", "function whoOf(e)", "p.via && typeof p.via.agent", "workerById(p.worker)", "[p.proposed_by]", "WORKER_LINES[e.kind]", 'p.kind === "audit"', "userHref(person)", '"the pool"', "function verbOf(e)", "function toneOf(e)"],
      reads: [{ path: "/api/v1/factory?limit=10", fields: ["workers.0.id", "workers.0.owner", "workers.0.agent"] }],
      visible: EVERYONE,
    },
    {
      id: "status.numbers",
      page: "/status",
      anchor: ['<details class="op-card st-fold st-num" id="numbers">', "<h3>The pipeline, in numbers</h3>"],
      script: ['$("#numbers").addEventListener("toggle"', "NUMBERS = !!this.open"],
      visible: EVERYONE,
    },
    {
      id: "status.service",
      page: "/status",
      anchor: ["<h3>Service</h3>", 'id="service"'],
      script: ['busy(fetch("/api/v1/status"))', '"#service"', "s.index.ok", "s.pool.ok", "s.signing", "setInterval(renderService, 60000)", 'noAnswer("service check", e)', '"The index is not answering"', '"The API could not reach "'],
      reads: [{ path: "/api/v1/status", fields: ["checked_at", "index.ok", "index.ms", "pool.ok", "pool.ms", "signing"] }],
      visible: EVERYONE,
    },
    {
      id: "status.system-tiles",
      page: "/status",
      anchor: ['id="systiles"'],
      // The workers alive and building are the shell's workerCounts over the live listing (loadFactory), the same as every other page — and, the listing not answering, the tile says so where the clause would be (the shell's noAnswer); the jobs of the week and the ones waiting the shell's jobsSummary over the series the table and the charts below draw, the worker minutes its workerMinutes — never the metrics snapshot's numbers, read only for when it was taken.
      script: ['setTiles("#systiles"', "jobsSummary(d.series, 7)", '"Jobs waiting now", num(js.waiting)', '"Jobs, 7 days", num(js.runs)', "num(js.failed)", "num(js.done)", "workerCounts(f.workers)", "WC.alive", "WC.building", 'WC_DOWN = noAnswer("worker listing", e)', 'WC_DOWN ? " · " + esc(WC_DOWN)', '"Worker minutes, 7 days", num(wm.total)', "workerMinutes(d.series, 7)", '"Sources synced"', '"rows per architecture · "', '"Promotion, by evidence"', 'latest(d.latest, "gate", "rc", "edge")', "pool.referenced_by_any_release", "pool.reclaimable", "sec.updated_at"],
      reads: [
        {
          path: stats,
          fields: [
            "metrics.recorded_at", "series.jobs_daily", "series.jobs_daily.0.day", "series.jobs_daily.0.kind", "series.jobs_daily.0.status", "series.jobs_daily.0.n", "series.jobs_daily.0.ms",
            "pool.objects", "pool.bytes", "pool.referenced_by_any_release.objects", "pool.reclaimable.objects", "pool.reclaimable.bytes",
            "rings.0.bytes", "coverage.0.upstream_total", "latest.0.kind", "latest.0.status", "latest.0.created_at",
            "security.updated_at", "security.advisories",
          ],
        },
        { path: "/api/v1/factory?limit=10", fields: ["workers", "workers.0.alive", "workers.0.current_task", "workers.0.revoked_at"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "status.bill-tile",
      page: "/status",
      anchor: ['id="systiles"'],
      script: ['api("GET", "/api/v1/cost")', '"Estimated bill"', "c.error", 'noAnswer("cost estimate", e)', "costColor(c)", "usd(c.projected_usd)", "usd(c.month_to_date_usd)", "c.estimated_at", "c.guard", "over budget: writing jobs paused", `no estimate yet (${ESTIMATE_CADENCE})`],
      reads: [{ path: "/api/v1/cost", fields: ["status", "projected_usd", "month", "month_to_date_usd", "estimated_at", "guard"] }],
      visible: EVERYONE,
    },
    {
      id: "status.chart-pool",
      page: "/status",
      anchor: ['id="c-pool"', "<h3>Pool growth <span>7 days</span></h3>"],
      script: ['"#c-pool"', "S.metrics", "r.bytes", "objects now"],
      reads: [{ path: stats, fields: ["series.metrics", "series.metrics.0.created_at", "series.metrics.0.bytes", "series.metrics.0.objects"] }],
      visible: EVERYONE,
    },
    {
      id: "status.chart-imports",
      page: "/status",
      anchor: ['id="c-imports"', "<h3>Imports per day <span>14 days</span></h3>"],
      script: ['"#c-imports"', "S.imports_daily", "r.packages", "r.runs"],
      reads: [{ path: stats, fields: ["series.imports_daily", "series.imports_daily.0.day", "series.imports_daily.0.packages", "series.imports_daily.0.bytes", "series.imports_daily.0.runs"] }],
      visible: EVERYONE,
    },
    {
      id: "status.chart-health",
      page: "/status",
      anchor: ['id="c-health"', "<h3>Health <span>14 days</span></h3>"],
      script: ['"#c-health"', "heatGrid(S.health)"],
      reads: [{ path: stats, fields: ["series.health", "series.health.0.ring", "series.health.0.arch", "series.health.0.created_at", "series.health.0.status"] }],
      visible: EVERYONE,
    },
    {
      id: "status.chart-sync",
      page: "/status",
      anchor: ['id="c-sync"', "<h3>Sync throughput <span>last runs</span></h3>"],
      script: ['"#c-sync"', "S.sync_runs", "r.duration_ms", "r.uploaded", "r.concurrency"],
      reads: [
        {
          path: stats,
          fields: ["series.sync_runs", "series.sync_runs.0.source", "series.sync_runs.0.arch", "series.sync_runs.0.status", "series.sync_runs.0.bytes", "series.sync_runs.0.duration_ms", "series.sync_runs.0.uploaded", "series.sync_runs.0.concurrency", "series.sync_runs.0.created_at"],
        },
      ],
      visible: EVERYONE,
    },
    {
      id: "status.chart-minutes",
      page: "/status",
      anchor: ['id="c-minutes"', "<h3>Worker minutes <span>per day</span></h3>"],
      script: ['"#c-minutes"', "wm.labels", "wm.values[i]", "js.byDay[dd]", "r.failed", '" min"'],
      reads: [{ path: stats, fields: ["series.jobs_daily", "series.jobs_daily.0.day", "series.jobs_daily.0.status", "series.jobs_daily.0.n", "series.jobs_daily.0.ms"] }],
      visible: EVERYONE,
    },
    {
      id: "status.chart-jobs",
      page: "/status",
      anchor: ['id="c-jobs"', "<h3>Pool jobs <span>7 days</span></h3>"],
      script: ['"#c-jobs"', "hbars(", "var byKind = js.byKind", "num(v.runs)", 'name: "waiting"', "</i>waiting</span>"],
      reads: [{ path: stats, fields: ["series.jobs_daily.0.kind", "series.jobs_daily.0.status", "series.jobs_daily.0.n", "series.jobs_daily.0.ms"] }],
      visible: EVERYONE,
    },
    {
      id: "status.chart-builds",
      page: "/status",
      anchor: ['id="c-builds"', "<h3>Factory builds <span>14 days</span></h3>"],
      script: ['"#c-builds"', "buildsByDay(S, 14)", "failed > published + staged", '" build(s)"'],
      reads: [{ path: stats, fields: ["series.builds_daily", "series.builds_daily.0.day", "series.builds_daily.0.status", "series.builds_daily.0.n"] }],
      visible: EVERYONE,
    },
    {
      id: "status.workflows-table",
      page: "/status",
      anchor: ['id="workflows"', "<th>Job</th>", '<th class="num">Runs 7d</th>'],
      script: ['pager("#workflows"', "var v = js.byKind[k]", "e.kind === k", "runs: v.runs", "waiting: v.waiting", "w.waiting", "w.minutes", "no jobs yet"],
      reads: [{ path: stats, fields: ["series.jobs_daily.0.kind", "series.jobs_daily.0.status", "series.jobs_daily.0.n", "series.jobs_daily.0.ms", "latest.0.kind", "latest.0.status", "latest.0.created_at"] }],
      visible: EVERYONE,
    },
    {
      // The Pipeline's Build tasks before #248: the worker a task ran on is the shell's wtId over the listing's row (the bare id where the listing no longer has one); a published build links its package in edge at the shell's one address. A pool job's row is worded from its params and its result (paramsLabel, jobResult): the fields named per kind are the ones the Rust jobs post (crates/pkg-repo/src/work.rs) and the brain queues (src/scheduler.ts, src/jobs.ts), on the fixture's done job of that kind; pool-jobs.test.ts reads the words. A build an emulated worker sent back says the native worker it waits for (params.needs_native, the shell's nativePill — #281).
      id: "status.jobs-table",
      page: "/status",
      anchor: ['id="tasks"', "<h3>Jobs and builds</h3>"],
      script: ['pager("#tasks"', 'href="/build/', "evidenceLink(t)", 'pkgHref(t.name, "edge", t.arch)', "wtId(byId[t.lease_owner] || t.lease_owner)", "t.result_filename", "jobResult(t)", "paramsLabel(t)", "t.max_attempts", "r.sources", "r.releases", "sum.upstream_total", 'x.id + " (" + x.ring + " #" + x.seq + ")"', 't.kind === "audit"', 't.kind === "trial"', 't.kind === "publish"', "r.findings", "r.packages", "r.fast_track", "r.ok ? HEALTH_WORD.ok : HEALTH_WORD.error", "nativePill(t)"],
      reads: [
        { path: "/api/v1/factory?limit=100", fields: ["workers.0.id", "workers.0.owner", "tasks.0.id", "tasks.0.kind", "tasks.0.name", "tasks.0.version", "tasks.0.arch", "tasks.0.status", "tasks.0.trust", "tasks.0.owner", "tasks.0.publish", "tasks.0.attempts", "tasks.0.max_attempts", "tasks.0.reason", "tasks.0.lease_owner", "tasks.0.duration_ms", "tasks.0.result_filename", "tasks.0.result", "tasks.0.error", "tasks.0.params",
          "tasks.kind=sync.params.arch", "tasks.kind=sync.params.sources", "tasks.kind=sync.result.arch", "tasks.kind=sync.result.sources.0.source", "tasks.kind=sync.result.sources.0.upstream_total", "tasks.kind=sync.result.sources.0.uploaded", "tasks.kind=sync.result.sources.0.removed", "tasks.kind=sync.result.sources.0.failed", "tasks.kind=sync.result.releases.0.ring", "tasks.kind=sync.result.releases.0.id", "tasks.kind=sync.result.releases.0.seq", "tasks.kind=sync.result.rendered",
          "tasks.kind=promote.params.from", "tasks.kind=promote.params.to", "tasks.kind=promote.result.verdict", "tasks.kind=promote.result.release_id",
          "tasks.kind=rollback.params.ring", "tasks.kind=rollback.params.to", "tasks.kind=rollback.result.ring", "tasks.kind=rollback.result.to", "tasks.kind=rollback.result.release_id",
          "tasks.kind=render.params.ring", "tasks.kind=render.params.arch", "tasks.kind=render.result.repos",
          "tasks.kind=health.params.ring", "tasks.kind=health.params.arch", "tasks.kind=health.result.ok",
          "tasks.kind=gc.result.keep",
          "tasks.kind=security.result.matches_vulnerable", "tasks.kind=security.result.matches_fixed", "tasks.kind=security.result.kev", "tasks.kind=security.result.fast_tracked.0.ring", "tasks.kind=security.result.fast_tracked.0.fixes", "tasks.kind=security.result.rolled_back",
          "tasks.kind=verify.result.objects", "tasks.kind=verify.result.bad_signatures", "tasks.kind=verify.result.repaired_signatures", "tasks.kind=verify.result.mismatched", "tasks.kind=verify.result.repinned", "tasks.kind=verify.result.unfixable",
          "tasks.kind=relayout.result.moved", "tasks.kind=relayout.result.ghosts", "tasks.kind=relayout.result.missing", "tasks.kind=relayout.result.errors", "tasks.kind=relayout.result.purged",
          "tasks.kind=enqueue.result.commit", "tasks.kind=enqueue.result.queued", "tasks.kind=enqueue.result.skipped", "tasks.kind=enqueue.result.up_to_date",
          // The three jobs on a build, by the fixture's done one of each (a queued publish, mine's, has no result yet; the first row by kind could be it).
          `tasks.id=${F.jobs.audit}.params.task`, `tasks.id=${F.jobs.audit}.params.name`, `tasks.id=${F.jobs.audit}.result.verdict`, `tasks.id=${F.jobs.audit}.result.summary`, `tasks.id=${F.jobs.audit}.result.findings`,
          `tasks.id=${F.jobs.trial}.params.task`, `tasks.id=${F.jobs.trial}.params.name`, `tasks.id=${F.jobs.trial}.params.version`, `tasks.id=${F.jobs.trial}.result.verdict`, `tasks.id=${F.jobs.trial}.result.packages`,
          `tasks.id=${F.jobs.publish}.params.task`, `tasks.id=${F.jobs.publish}.params.name`, `tasks.id=${F.jobs.publish}.params.version`, `tasks.id=${F.jobs.publish}.result.filename`] },
        // A staged row's evidence is its build's page (the shell's evidenceLink), where what the build left is listed.
        { path: `/build/${F.contributorTask}`, json: false },
      ],
      visible: EVERYONE,
    },
    {
      id: "status.coverage-table",
      page: "/status",
      // Late is the shell's one rule (lateSync over the server's mark, LATE_MS otherwise): the sentence over the table names the shell's number, the row wears the pill by it.
      anchor: ['id="coverage"', '<th class="num">In stable</th>', "<th>Progress</th>", 'id="late-after"'],
      script: ['pager("#coverage"', "c.pinned_stable", "c.upstream_total", "not synced yet", '"#late-after"', "Math.round(LATE_MS / 3600e3)", 'pillHtml("warn", "late")'],
      reads: [
        {
          path: stats,
          fields: ["coverage.0.source", "coverage.0.arch", "coverage.0.upstream", "coverage.0.upstream_total", "coverage.0.indexed", "coverage.0.missing", "coverage.0.pinned_stable", "coverage.0.bytes", "coverage.0.last_sync", "coverage.0.last_status", "coverage.0.late"],
        },
      ],
      visible: EVERYONE,
    },
    {
      id: "status.provenance-note",
      page: "/status",
      anchor: ['id="provenance" hidden'],
      script: ['"#provenance"', "d.provenance && d.provenance.stable", "pv.aur", "pv.unknown"],
      reads: [{ path: stats, fields: ["provenance.stable.packages", "provenance.stable.local", "provenance.stable.aur", "provenance.stable.unknown"] }],
      visible: EVERYONE,
    },
    {
      // The Pipeline's registry until the Factory draws its line (#246): every requested package, its signed request on the record, read while the numbers are open.
      id: "status.registry-table",
      page: "/status",
      anchor: ['id="registry-wrap" hidden', 'id="registry"', 'id="registry-note"', "<h3>Requested packages</h3>"],
      script: ['api("GET", "/api/v1/factory/packages")', "function renderRegistry(pkgs)", 'pager("#registry"', "p.staged_builds", '"/request.json"', "det.latest_tag", "runHref(home)", "if (NUMBERS) loadRegistry()"],
      reads: [{ path: "/api/v1/factory/packages", fields: ["packages.0.name", "packages.0.request_id", "packages.0.project", "packages.0.url", "packages.0.owner", "packages.0.arches", "packages.0.release", "packages.0.license", "packages.0.status", "packages.0.staged_builds", "packages.0.detail", "packages.0.updated_at", "packages.0.category", "packages.0.detected"] }],
      visible: EVERYONE,
    },
    {
      id: "status.any-note",
      page: "/status",
      anchor: ['id="any" hidden'],
      script: ['"#any"', "d.any && d.any.stable", "a.twice", "a.extra_bytes"],
      reads: [{ path: stats, fields: ["any.stable.names", "any.stable.objects", "any.stable.bytes", "any.stable.twice", "any.stable.extra_bytes"] }],
      visible: EVERYONE,
    },
  ];
};
