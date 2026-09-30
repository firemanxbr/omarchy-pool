/**
 * Status (#248), the page the Pipeline, the Journal and Security became:
 * every section the design names is served, and the sections the old
 * addresses land on are there (index.ts MOVED: /journal → #journal,
 * /security → #advisories); the stats carry each ring's last releases with
 * where their selection came from, so a rollback is drawn red, and what
 * each source's syncs brought today; every source the pool syncs is a row
 * of the Sources card; the hero says all rings are healthy only when a
 * check said so, names the ring that is not, and says what did not answer;
 * the journal says who did a line and with which agent, and reads no more
 * than it draws; and a maintainer's roll back — on a ring's card and in its
 * history — is drawn for a maintainer and for nobody else, and refused by
 * the server to everyone else. The page's own script runs here (runScript
 * in test/fixture.ts) over the Worker's real answers on the fixture, as
 * each role would get them, and over a stubbed answer where a test says so.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { MOVED } from "../src/index";
import { issueJobToken } from "../src/jobtoken";
import { EXPECTED_SOURCES, RINGS } from "../src/meta";
import { releaseWindowsSql, RING_HISTORY } from "../src/routes/stats";
import { SOURCE_PROJECTS } from "../src/pages/status";
import { runScript, scriptOf, seedDashboard, type Fixture, type Ran } from "./fixture";

let F: Fixture;
let HTML: string;
let SCRIPT: string;

async function real(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const json = async (path: string) => (await real(path)).json() as Promise<any>;

beforeAll(async () => {
  F = await seedDashboard(env);
  HTML = await (await real("/status")).text();
  SCRIPT = scriptOf(HTML);
});

/** Past the edge's copy of an answer: every read a fresh one, so a test that wrote a row reads it. */
let fresh = 0;
const uncached = (path: string) => `${path}${path.includes("?") ? "&" : "?"}fresh=${++fresh}`;

/** The functions and variables of the page's script the tests call and set. */
const FUNCTIONS = ["whoOf", "drawHero", "tileCount", "loadJournal", "refreshJournal", "renderService"];
const VARIABLES = ["STATS", "JF", "JLIMIT", "JLAST"];

/** The page's script run as `cookie`'s reader would get it (nobody for none): every read the Worker's own answer. */
async function drawn(cookie?: string, search = ""): Promise<Ran> {
  const fetch = (path: string, init?: RequestInit) => real(path === "/auth/me" ? path : uncached(path), { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...(cookie ? { cookie: `omc=${cookie}` } : {}) } });
  const d = runScript(SCRIPT, { pathname: "/status", search, functions: FUNCTIONS, variables: VARIABLES, fetch });
  // The stats poll, the session and the listing answer over a real D1: wait for the cards and the history to be drawn from them, and for the session's second draw.
  for (let i = 0; i < 100 && !/st-ring-n/.test(d.nodes["#st-rings"]?.innerHTML ?? ""); i++) await new Promise((r) => setTimeout(r, 30));
  await new Promise((r) => setTimeout(r, 150));
  return d;
}

describe("the Status page", () => {
  it("serves every section the design names, drawn with the kit, and the sections the old addresses land on", () => {
    for (const id of ["releases", "st-rings", "history", "sources", "workers", "checks", "advisories", "advisory-list", "journal", "numbers"]) expect(HTML, id).toMatch(new RegExp(`\\sid="${id}"`));
    expect(HTML).toContain('<p class="op-eyebrow">Status</p>');
    expect(HTML).toContain('<h1 class="op-hero st-title">');
    expect(HTML).toMatch(/<link rel="stylesheet" href="\/assets\/kit\.[0-9a-f]{8}\.css">/);
    // /pipeline, /journal and /security land here (#240): each fragment a MOVED address names is an element of the page.
    const here = Object.entries(MOVED).filter(([, to]) => to.startsWith("/status"));
    expect(here.map(([from]) => from).sort()).toEqual(["/journal", "/pipeline", "/security"]);
    for (const [from, to] of here) {
      const section = to.split("#")[1];
      if (section) expect(HTML, `${from} → ${to}`).toMatch(new RegExp(`<[a-z]+\\b[^>]*\\sid="${section}"`));
    }
    // Every ring the pool promises has its card before the script answers, in the order a package climbs.
    const cards = [...HTML.matchAll(/<article class="op-card (\w+) st-ring">/g)].map((m) => m[1]);
    expect(cards).toEqual(["edge", "rc", "stable"]);
  });

  it("draws no roll back for a visitor or a contributor, and a maintainer's on a ring's card and in its history", async () => {
    // Served: no control at all — it is drawn for a maintainer once the session says so.
    expect(HTML.replace(/<script[\s\S]*?<\/script>/g, "")).not.toContain("data-rollback=");
    for (const cookie of [undefined, F.sessions.contributor, F.sessions.owner]) {
      const d = await drawn(cookie);
      expect(d.nodes["#st-rings"].innerHTML, `${cookie ?? "nobody"}: the cards are drawn`).toContain("st-ring-n");
      expect(d.nodes["#history-table tbody"].innerHTML, `${cookie ?? "nobody"}: the history is drawn`).toContain(`release ${F.previousRelease}`);
      expect(d.nodes["#st-rings"].innerHTML, cookie ?? "nobody").not.toContain("data-rollback=");
      expect(d.nodes["#history-table tbody"].innerHTML, cookie ?? "nobody").not.toContain("data-rollback=");
    }
    const m = await drawn(F.sessions.maintainer);
    // stable's card offers the release before its head (the fixture's first stable release); edge's head has none before it.
    expect(m.nodes["#st-rings"].innerHTML).toContain(`data-rollback="${F.previousRelease}" data-ring="stable"`);
    // Its label names the release by its sequence and by the id the dialog and the note after it say.
    expect(m.nodes["#st-rings"].innerHTML).toContain(`>Roll back to #1 (release ${F.previousRelease})</button>`);
    // The history offers every release but a head: stable's first, not its second.
    expect(m.nodes["#history-table tbody"].innerHTML).toContain(`data-rollback="${F.previousRelease}" data-ring="stable"`);
    expect(m.nodes["#history-table tbody"].innerHTML).not.toContain(`data-rollback="${F.release}"`);
    // What it posts is the shell's rollback job, a maintainer's alone: the button is not the boundary, the server is — nobody, the contributor and the owner are refused, and none of them queues a job (the manifest's act shows the maintainer's accepted).
    expect(SCRIPT).toContain('kind: "rollback", params: { ring: ring, to: to, note: note }');
    const queued = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE kind = 'rollback'").first<{ n: number }>())!.n;
    const before = await queued();
    for (const [cookie, want] of [[undefined, 401], [F.sessions.contributor, 403], [F.sessions.owner, 403]] as const) {
      const res = await real("/api/v1/factory/jobs", { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie: `omc=${cookie}` } : {}) }, body: JSON.stringify({ kind: "rollback", params: { ring: "stable", to: String(F.previousRelease), note: "not theirs to do" } }) });
      expect(res.status, cookie ?? "nobody").toBe(want);
    }
    expect(await queued()).toBe(before);
  });

  it("carries each ring's last releases in the stats, with where each came from, and draws a rollback red", async () => {
    // stable pointed back at its first release, as the rollback job does: a new release whose selection is an earlier one of its own ring.
    const token = await issueJobToken(env, { t: 1, k: "rollback", s: ["release:stable"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
    const made = await real("/api/v1/releases", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ ring: "stable", from_release_id: F.previousRelease, note: "the test's rollback" }) });
    expect(made.status).toBe(201);
    const rolled = ((await made.json()) as { release: { id: number; seq: number } }).release;
    const stats = await json(uncached("/api/v1/stats"));
    // At most RING_HISTORY of a ring, newest first overall — the newest releases of every ring leading, as the fifteen the list was.
    for (const ring of RINGS) expect(stats.releases.filter((r: { ring: string }) => r.ring === ring).length, ring).toBeLessThanOrEqual(RING_HISTORY);
    const ids = stats.releases.map((r: { id: number }) => r.id);
    expect(ids).toEqual([...ids].sort((a: number, b: number) => b - a));
    const row = stats.releases.find((r: { id: number }) => r.id === rolled.id);
    expect(row).toMatchObject({ ring: "stable", source_id: F.previousRelease, source_ring: "stable", parent_id: F.release, is_head: 1 });
    // A promotion's selection comes from another ring, a sync's or a publish's from nowhere but the ring itself.
    for (const r of stats.releases) if (r.source_id === null) expect(r.source_ring, `release ${r.id}`).toBeNull();
    // The card draws it red, counts it, and the history says what it was.
    const d = await drawn();
    const stable = /<article class="op-card stable st-ring"[\s\S]*?<\/article>/.exec(d.nodes["#st-rings"].innerHTML)![0];
    // The rollback is what stable serves now: hollow, as the head always is, and red-edged.
    expect(stable).toContain(`<a class="st-r rb head" href="/diff?ring=stable&from=${F.release}&to=${rolled.id}"`);
    expect(stable).toContain("1 rollback<");
    expect(d.nodes["#history-table tbody"].innerHTML).toContain(`rollback to release ${F.previousRelease}`);
    // A maintainer's card offers no roll back now: the head's parent is the release it rolled away from, and "Roll back to #2" would serve it again. The history still names every release but the head, the one rolled away from among them, for a maintainer who means it.
    const m = await drawn(F.sessions.maintainer);
    const mStable = /<article class="op-card stable st-ring"[\s\S]*?<\/article>/.exec(m.nodes["#st-rings"].innerHTML)![0];
    expect(mStable).not.toContain("data-rollback=");
    expect(m.nodes["#history-table tbody"].innerHTML).toContain(`data-rollback="${F.release}" data-ring="stable"`);
    expect(m.nodes["#history-table tbody"].innerHTML).not.toContain(`data-rollback="${rolled.id}"`);
  });

  it("says what each source's syncs brought today, from the rows the day's imports already read", async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload, created_at) VALUES ('sync', 'edge', 'extra', 'ok', 'extra x86_64: 7 new', ?, ?)").bind(JSON.stringify({ arch: "x86_64", uploaded: 7, bytes_uploaded: 700 }), now),
      env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload, created_at) VALUES ('sync', 'edge', 'extra', 'ok', 'extra x86_64: 3 new', ?, ?)").bind(JSON.stringify({ arch: "x86_64", uploaded: 3, bytes_uploaded: 300 }), now),
      // Yesterday's sync is not today's.
      env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload, created_at) VALUES ('sync', 'edge', 'extra', 'ok', 'extra x86_64: 5 new', ?, ?)").bind(JSON.stringify({ arch: "x86_64", uploaded: 5, bytes_uploaded: 500 }), new Date(Date.now() - 86400e3).toISOString()),
    ]);
    const stats = await json(uncached("/api/v1/stats"));
    const extra = stats.coverage.find((c: { source: string; arch: string }) => c.source === "extra" && c.arch === "x86_64");
    const today = now.slice(0, 10);
    const all = await env.DB.prepare("SELECT source, COALESCE(json_extract(payload, '$.arch'), 'x86_64') AS arch, SUM(json_extract(payload, '$.uploaded')) AS n FROM events WHERE kind = 'sync' AND substr(created_at, 1, 10) = ? GROUP BY source, arch").bind(today).all<{ source: string; arch: string; n: number }>();
    expect(extra.today).toBe(all.results.find((r) => r.source === "extra" && r.arch === "x86_64")!.n);
    expect(extra.today).toBeGreaterThanOrEqual(10);
    // The per-day series is the same sum, one row a day as before.
    const day = stats.series.imports_daily.find((r: { day: string }) => r.day === today);
    expect(day.packages).toBe(all.results.reduce((n, r) => n + Number(r.n), 0));
    expect(Object.keys(day).sort()).toEqual(["bytes", "day", "packages", "runs"]);
    // Every coverage row carries the word, a zero where nothing came today.
    for (const c of stats.coverage) expect(typeof c.today, `${c.source}/${c.arch}`).toBe("number");
    // The Sources card's Arch Linux row sums its repositories' today.
    const d = await drawn();
    const arch = [...d.nodes["#sources-rows"].innerHTML.matchAll(/<tr[^>]*><td><span class="st-dot[^"]*"><\/span>([^<]+)<small class="s-repos">([^<]*)<\/small><\/td><td>([^<]*)<\/td><td class="num">([\d,]+)<\/td><td class="num s-plus">\+([\d,]+)<\/td>/g)].find((m) => m[1] === "Arch Linux")!;
    const x86 = stats.coverage.filter((c: { source: string; arch: string }) => ["core", "extra", "multilib"].includes(c.source) && c.arch === "x86_64");
    expect(Number(arch[5])).toBe(x86.reduce((n: number, c: { today: number }) => n + c.today, 0));
    // The repositories: a column on a desktop, a line under the name on a phone (the CSS shows one of the two).
    expect(arch[3]).toBe("core · extra · multilib");
    expect(arch[2]).toBe(arch[3]);
    // A source that is not on time says so in a word, not by its colour alone.
    for (const row of d.nodes["#sources-rows"].innerHTML.split("</tr>").filter((r: string) => r.includes("st-dot warn"))) expect(row).toContain("<small>late</small>");
  });

  it("has a Sources row for every source the pool syncs, and nothing it does not", () => {
    const mapped = SOURCE_PROJECTS.flatMap(([, repos]) => repos.map(([source, arch]) => `${source}/${arch}`));
    expect([...new Set(mapped)].length, "a repository in two rows").toBe(mapped.length);
    expect(mapped.sort()).toEqual(EXPECTED_SOURCES.map((e) => `${e.source}/${e.arch}`).sort());
  });

  it("says all rings are healthy only when they are, and names the ring that is not", async () => {
    const d = await drawn();
    const stats = await json(uncached("/api/v1/stats"));
    // The fixture's sources were synced longer ago than the pool allows: every ring healthy, the syncs behind — amber, and one sentence says what, counting sources as the Last sync tile does (a project, not a row per architecture).
    d.setSTATS(stats);
    d.drawHero();
    expect(d.nodes["#headline"].textContent).toBe("All rings healthy, syncs behind");
    expect(d.nodes["#st-mark"].className).toBe("st-mark warn");
    expect(d.nodes["#st-lede"].textContent).toMatch(/^(No sync for \S+|\d+ of \d+ sources not on time)/);
    expect(d.nodes["#st-lede"].textContent).toMatch(/; the rings keep serving what they have\.$/);
    expect(d.nodes["#st-lede"].textContent).not.toContain("(s)");
    // Every source synced a minute ago, each of its architectures: all rings healthy, in green, and the design's one sentence.
    const now = new Date(Date.now() - 60e3).toISOString();
    const fed = { ...stats, coverage: stats.coverage.map((c: object) => ({ ...c, late: false, last_sync: now, last_status: "ok" })), latest: stats.latest.map((e: { kind: string }) => (e.kind === "sync" ? { ...e, created_at: now } : e)) };
    d.setSTATS(fed);
    d.drawHero();
    expect(d.nodes["#headline"].textContent).toBe("All rings healthy");
    expect(d.nodes["#st-mark"].className).toBe("st-mark ok");
    expect(d.nodes["#st-lede"].textContent).toBe("Every sync, release, check and decision is on the record.");
    // rc fails its check on x86_64: the hero says rc, in red, and the lede says where — its name never capitalised.
    const sick = { ...fed, latest: [...fed.latest.filter((e: { kind: string; ring: string }) => !(e.kind === "health" && e.ring === "rc")), { kind: "health", ring: "rc", source: F.arch, status: "error", summary: "rc x86_64: pacman check failed", created_at: new Date().toISOString() }] };
    d.setSTATS(sick);
    d.drawHero();
    expect(d.nodes["#headline"].textContent).toBe("rc not healthy");
    expect(d.nodes["#st-mark"].className).toBe("st-mark fail");
    expect(d.nodes["#st-lede"].textContent).toBe(`The latest health check failed on rc ${F.arch}.`);
    // Nothing to judge yet is not healthy: no health check at all, and no ring released either.
    const unchecked = { ...fed, latest: fed.latest.filter((e: { kind: string }) => e.kind !== "health") };
    d.setSTATS(unchecked);
    d.drawHero();
    expect(d.nodes["#headline"].textContent).toBe("No health check yet");
    expect(d.nodes["#st-mark"].className).toBe("st-mark ");
    d.setSTATS({ ...unchecked, rings: unchecked.rings.map((r: object) => ({ ...r, release: null })) });
    d.drawHero();
    expect(d.nodes["#headline"].textContent).toBe("No ring released yet");
  });

  it("says the pool's numbers did not answer where each section drawn from them would be, never 'Checking the rings…' for good", async () => {
    // The stats poll fails; the service check and everything else answer.
    const fetch = (path: string, init?: RequestInit) => (path.startsWith("/api/v1/stats") ? Promise.resolve(new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "content-type": "application/json" } })) : real(path === "/auth/me" ? path : uncached(path), init));
    const d = runScript(SCRIPT, { pathname: "/status", functions: FUNCTIONS, variables: VARIABLES, fetch });
    for (let i = 0; i < 100 && d.nodes["#headline"]?.textContent !== "The pool's numbers did not answer"; i++) await new Promise((r) => setTimeout(r, 30));
    expect(d.nodes["#headline"].textContent).toBe("The pool's numbers did not answer");
    expect(d.nodes["#st-mark"].className).toBe("st-mark fail");
    expect(d.nodes["#st-lede"].textContent).toBe("The API answered HTTP 500.");
    const why = "the pool's numbers did not answer: HTTP 500";
    expect(d.nodes["#st-rings"].innerHTML).not.toContain("Loading");
    expect(d.nodes["#st-rings"].innerHTML.match(/>did not answer</g)).toHaveLength(3);
    for (const sel of ["#sources-rows", "#checks-list", "#journal-list"]) expect(d.nodes[sel].innerHTML, sel).toContain(why);
    expect(d.nodes["#journal-list"].innerHTML).not.toContain("nothing on the record");
    expect(d.nodes["#t-sync-n"].textContent).toBe("—");
    expect(d.nodes["#t-checks-n"].textContent).toBe("—");
    // Show more is served hidden, drawn only once there are lines under it.
    expect(HTML).toContain('id="journal-more" hidden>Show more</button>');
    expect(d.nodes["#journal-more"].hidden).toBe(true);
  });

  it("names the part the service check found down: its 503 is an answer, not a check that did not answer", async () => {
    const down = { ok: false, state: "degraded", api: { ok: true }, index: { ok: false, ms: 5000, error: "index did not answer within 5 s" }, pool: { ok: true, ms: 3 }, signing: true, checked_at: new Date().toISOString() };
    const fetch = (path: string, init?: RequestInit) => (path === "/api/v1/status" ? Promise.resolve(new Response(JSON.stringify(down), { status: 503, headers: { "content-type": "application/json" } })) : real(path === "/auth/me" ? path : uncached(path), init));
    const d = runScript(SCRIPT, { pathname: "/status", functions: FUNCTIONS, variables: VARIABLES, fetch });
    for (let i = 0; i < 100 && d.nodes["#headline"]?.textContent !== "The index is not answering"; i++) await new Promise((r) => setTimeout(r, 30));
    expect(d.nodes["#headline"].textContent).toBe("The index is not answering");
    expect(d.nodes["#st-mark"].className).toBe("st-mark fail");
    expect(d.nodes["#st-lede"].textContent).toBe("The API could not reach the index (index did not answer within 5 s) just now.");
    expect(d.nodes["#service"].innerHTML).toContain('<i class="led error"></i><b>index · D1</b><span>index did not answer within 5 s</span>');
    // A check with nothing of its shape did not answer: the hero says so, and the lede only the reason, in one sentence.
    const none = runScript(SCRIPT, { pathname: "/status", functions: FUNCTIONS, variables: VARIABLES, fetch: (path: string, init?: RequestInit) => (path === "/api/v1/status" ? Promise.resolve(new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "content-type": "application/json" } })) : real(path === "/auth/me" ? path : uncached(path), init)) });
    for (let i = 0; i < 100 && none.nodes["#headline"]?.textContent !== "The service check did not answer"; i++) await new Promise((r) => setTimeout(r, 30));
    expect(none.nodes["#headline"].textContent).toBe("The service check did not answer");
    expect(none.nodes["#st-lede"].textContent).toBe("The API answered HTTP 500: internal error.");
  });

  it("counts a tile up when its number lands or changes, never again for the same number (the Health checks tile is drawn with every poll)", async () => {
    const d = await drawn();
    const el = { textContent: "" };
    d.tileCount(el, 3);
    expect(el.textContent).toBe("3");
    el.textContent = "untouched";
    d.tileCount(el, 3);
    expect(el.textContent).toBe("untouched");
    d.tileCount(el, 4);
    expect(el.textContent).toBe("4");
  });

  it("says who did a line of the journal, and with which agent", async () => {
    const d = await drawn();
    // A person the line names: their page, never a login as a URL of its own.
    const by = d.whoOf({ kind: "approve", payload: { by: F.m2 } });
    expect(by).toContain(`href="/user/${F.m2}"`);
    expect(by).toContain(`>${F.m2}</a>`);
    // The agent #252 writes on a line a person's agent drafted: its mark, named.
    const via = d.whoOf({ kind: "approve", payload: { by: F.m2, via: { agent: "Claude Code" } } });
    expect(via).toContain('class="op-b op-b-claude-color"');
    expect(via).toContain('aria-label="Claude Code"');
    // A pool job on the project's worker: the pool's own work, and no agent's — a sync is not drafted.
    const workers = (await json(uncached("/api/v1/factory?limit=10"))).workers as { id: string; agent: string | null }[];
    const w1 = workers.find((w) => w.id === F.worker)!, w3 = workers.find((w) => w.id === F.communityWorker)!;
    expect(w1.agent).toBe("claude-code/claude-sonnet-5");
    expect(w3.agent).toBe("openai/gpt-5");
    const job = d.whoOf({ kind: "job", payload: { worker: F.worker, kind: "sync" } });
    expect(job).toContain("the pool");
    expect(job).not.toContain("op-b");
    // An audit is the second agent's report: the pool, with the agent the worker runs, named as a reader says it.
    const audit = d.whoOf({ kind: "job", payload: { worker: F.worker, kind: "audit" } });
    expect(audit).toContain("the pool");
    expect(audit).toContain('aria-label="Claude Code · Claude Sonnet 5"');
    // A build on alice's worker: hers, with the agent that drafted its recipe.
    const build = d.whoOf({ kind: "build", payload: { worker: F.communityWorker } });
    expect(build).toContain(`href="/user/${F.owner}"`);
    expect(build).toContain('aria-label="OpenAI · GPT 5"');
    // A trust proposal is the maintainer's who proposed it — not the worker's owner, and no agent's.
    const proposed = d.whoOf({ kind: "trust", payload: { worker: F.communityWorker, proposed_by: F.m1, owner: F.owner } });
    expect(proposed).toContain(`href="/user/${F.m1}"`);
    expect(proposed).not.toContain(`/user/${F.owner}"`);
    expect(proposed).not.toContain("op-b");
    // Two maintainers' word: both of them.
    const trusted = d.whoOf({ kind: "trust", payload: { worker: F.communityWorker, trust: "project", by: `${F.m1}, ${F.m2}`, owner: F.owner } });
    expect(trusted).toContain(`href="/user/${F.m1}"`);
    expect(trusted).toContain(`href="/user/${F.m2}"`);
    // The Workers card names the agent and the model the same way, never the slug.
    expect(d.nodes["#workers-list"].innerHTML).toContain('aria-label="Claude Code · Claude Sonnet 5"');
    expect(d.nodes["#workers-list"].innerHTML).toContain("<span>Claude Sonnet 5</span>");
    expect(d.nodes["#workers-list"].innerHTML).not.toContain("claude-code/");
    // Nobody named: the pool's mark. Something that is not a login is never a link.
    expect(d.whoOf({ kind: "sync", payload: null })).toContain("the pool");
    expect(d.whoOf({ kind: "approve", payload: { by: '"><img src=x>' } })).not.toMatch(/<img|href="\/user\//);
  });

  it("draws a live project worker whose agent did not answer as not ready, with the agent's error — never idle, waiting for work (#273)", async () => {
    // A review worker's claim after the rollout: its agent proxy refused the probe. It audits, so its agent must answer: not ready.
    const refused = "URLError: <urlopen error [Errno 111] Connection refused>";
    const before = await env.DB.prepare("SELECT agent_status, agent_error, agent_checked_at, current_task, kinds FROM build_workers WHERE id = ?").bind(F.worker).first<{ agent_status: string | null; agent_error: string | null; agent_checked_at: string | null; current_task: number | null; kinds: string | null }>();
    await env.DB.prepare(`UPDATE build_workers SET agent_status = 'error', agent_error = ?, agent_checked_at = ?, current_task = NULL, kinds = '["build","publish","audit"]', last_seen = ? WHERE id = ?`)
      .bind(refused, new Date(Date.now() - 5 * 60e3).toISOString(), new Date().toISOString(), F.worker).run();
    try {
      const d = await drawn();
      for (let i = 0; i < 100 && !/st-w/.test(d.nodes["#workers-list"]?.innerHTML ?? ""); i++) await new Promise((r) => setTimeout(r, 30));
      const list = d.nodes["#workers-list"].innerHTML as string;
      const line = /<div class="st-w notready">[\s\S]*?<div class="st-wbar">/.exec(list)?.[0] ?? "";
      expect(line, list).toContain(`title="${F.worker}"`);
      // The reason in the shell's words (wtNotReady, as /workers says it), whole on hover, with when it was checked; a red mark and the word.
      const why = `its agent did not answer: ${refused.replace(/</g, "&lt;").replace(/>/g, "&gt;")} · checked 5m ago`;
      expect(line).toContain(`<div class="st-wj" title="${why}"><span class="st-dot fail" aria-hidden="true"></span><b>not ready</b><span class="st-dim">${why}</span></div>`);
      expect(line).not.toContain("waiting for work");
      expect(d.nodes["#workers-busy"].textContent).toMatch(/^\d+ of \d+ busy · 1 not ready$/);
    } finally {
      await env.DB.prepare("UPDATE build_workers SET agent_status = ?, agent_error = ?, agent_checked_at = ?, current_task = ?, kinds = ? WHERE id = ?").bind(before!.agent_status, before!.agent_error, before!.agent_checked_at, before!.current_task, before!.kinds, F.worker).run();
    }
    // Its agent answering again, the same worker is idle, and nothing is counted not ready.
    const d = await drawn();
    for (let i = 0; i < 100 && !/st-w/.test(d.nodes["#workers-list"]?.innerHTML ?? ""); i++) await new Promise((r) => setTimeout(r, 30));
    expect(d.nodes["#workers-list"].innerHTML).not.toContain("not ready");
    expect(d.nodes["#workers-busy"].textContent).not.toContain("not ready");
  });

  it("keeps Show more under All while the journal holds more: a read that came back full, its metrics snapshots counted", async () => {
    // Three hundred lines, a metrics snapshot every twenty-fifth: /events answers the newest `limit` of them, snapshots and all, as it does.
    const journal = Array.from({ length: 300 }, (_, i) => ({ id: 100000 - i, kind: i % 25 === 3 ? "metrics" : "sync", ring: "edge", source: "extra", status: "ok", summary: `line ${i}`, payload: null, created_at: new Date(Date.now() - i * 60e3).toISOString() }));
    const fetch = (path: string, init?: RequestInit) => {
      const m = /^\/api\/v1\/events\?limit=(\d+)$/.exec(path);
      return m ? Promise.resolve(new Response(JSON.stringify({ events: journal.slice(0, Number(m[1])) }), { headers: { "content-type": "application/json" } })) : real(path === "/auth/me" ? path : uncached(path), init);
    };
    const d = runScript(SCRIPT, { pathname: "/status", functions: FUNCTIONS, variables: VARIABLES, fetch });
    for (let i = 0; i < 100 && !/st-ring-n/.test(d.nodes["#st-rings"]?.innerHTML ?? ""); i++) await new Promise((r) => setTimeout(r, 30));
    // Show more, pressed once and twice: 50 asked, 48 lines (two snapshots), and the button stays — the answer was full.
    for (const [limit, lines] of [[50, 48], [110, 105]] as const) {
      d.setJLIMIT(limit);
      d.setJLAST([]);
      d.loadJournal();
      await new Promise((r) => setTimeout(r, 60));
      expect(d.nodes["#journal-count"].textContent, `${limit}`).toBe(`the ${lines} newest lines`);
      expect(d.nodes["#journal-more"].hidden, `${limit}`).toBe(false);
    }
    // At the two hundred the Journal read, no more.
    d.setJLIMIT(200);
    d.loadJournal();
    await new Promise((r) => setTimeout(r, 60));
    expect(d.nodes["#journal-more"].hidden).toBe(true);
  });

  it("draws the chip picked last, never a slower answer for the chip picked before it", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    // Syncs answer late; Blocks at once.
    const fetch = (path: string, init?: RequestInit) => (path.startsWith("/api/v1/events?kind=sync&") ? held.then(() => real(uncached(path), init)) : real(path === "/auth/me" ? path : uncached(path), init));
    const d = runScript(SCRIPT, { pathname: "/status", functions: FUNCTIONS, variables: VARIABLES, fetch });
    for (let i = 0; i < 100 && !/st-ring-n/.test(d.nodes["#st-rings"]?.innerHTML ?? ""); i++) await new Promise((r) => setTimeout(r, 30));
    for (const chip of ["syncs", "blocks"]) {
      d.setJF(chip);
      d.setJLAST([]);
      d.loadJournal();
    }
    await new Promise((r) => setTimeout(r, 100));
    release();
    await new Promise((r) => setTimeout(r, 150));
    expect(d.nodes["#journal-count"].textContent).toMatch(/ · Blocks$/);
    expect(d.nodes["#journal-list"].innerHTML).not.toContain('">synced');
  });

  it("refreshes a picked chip with the newest twenty of each of its kinds, however far Show more went", async () => {
    const asked: string[] = [];
    const fetch = (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/v1/events")) asked.push(path);
      return real(path === "/auth/me" ? path : uncached(path), init);
    };
    const d = runScript(SCRIPT, { pathname: "/status", search: "?kind=decisions", functions: FUNCTIONS, variables: VARIABLES, fetch });
    for (let i = 0; i < 100 && !/Decisions$/.test(d.nodes["#journal-count"]?.textContent ?? ""); i++) await new Promise((r) => setTimeout(r, 30));
    // Show more, twice: the window read once at 110 a kind.
    d.setJLIMIT(110);
    d.loadJournal();
    await new Promise((r) => setTimeout(r, 100));
    expect(asked.filter((p) => p.endsWith("&limit=110")).sort()).toEqual(["/api/v1/events?kind=approve&limit=110", "/api/v1/events?kind=review&limit=110", "/api/v1/events?kind=withdraw&limit=110"]);
    // The minute's refresh: twenty a kind, not the window again.
    asked.length = 0;
    d.refreshJournal();
    await new Promise((r) => setTimeout(r, 100));
    expect(asked.filter((p) => !p.includes("kind=rollback") && !p.includes("kind=fast-track")).sort()).toEqual(["/api/v1/events?kind=approve&limit=20", "/api/v1/events?kind=review&limit=20", "/api/v1/events?kind=withdraw&limit=20"]);
  });

  it("reads each ring's last releases on its index: a few rows per ring, however many releases the table holds", async () => {
    // Three hundred more releases in every ring, as a few months of syncs leave them.
    for (const ring of RINGS) {
      const top = (await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM releases WHERE ring = ?").bind(ring).first<{ s: number }>())!.s;
      await env.DB.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300) INSERT INTO releases (ring, seq, note) SELECT ?1, ?2 + i, 'volume' FROM n").bind(ring, top).run();
    }
    const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM releases").first<{ n: number }>())!.n;
    expect(total).toBeGreaterThan(RINGS.length * 300);
    const sql = releaseWindowsSql();
    // Every read of the releases table is a search — each ring's window on its (ring, seq) index, the release and its source by primary key — never a pass over it.
    const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(RING_HISTORY, ...RINGS).all<{ detail: string }>()).results.map((r) => r.detail);
    expect(plan.filter((d) => /^SCAN (releases|r|s)\b/.test(d)), plan.join("; ")).toEqual([]);
    expect(plan.filter((d) => /^SEARCH releases USING (COVERING )?INDEX \S+ \(ring=\?\)/.test(d)), plan.join("; ")).toHaveLength(RINGS.length);
    const read = await env.DB.prepare(sql).bind(RING_HISTORY, ...RINGS).all();
    expect(read.results).toHaveLength(RINGS.length * RING_HISTORY);
    expect(read.meta.rows_read, "rows read for the windows").toBeLessThan(RINGS.length * RING_HISTORY * 6);
  });

  // #277, part 3: what rolls each host out, and a release whose image does not start — lines from the listing alone.
  it("says once per host what rolls it out when it is not an updater that follows the pool, and which workers went silent after a deploy", () => {
    const { fleetLines } = runScript(SCRIPT, { pathname: "/status", functions: ["fleetLines"] }) as unknown as { fleetLines: (ws: unknown[], pool: unknown, now: number) => [string, string][] };
    const now = Date.parse("2026-09-30T12:00:00Z"), min = 60000;
    const ago = (m: number) => new Date(now - m * min).toISOString();
    const w = (o: Record<string, unknown>) => ({ id: "w", alive: true, side: "omarchy", labels: { where: "omarchy-studio" }, last_seen: ago(1), set_rollout: "follows", ...o });
    const pool = { version: "v1.0.3", deployed_at: ago(60) };
    // Every project worker follows: nothing to say.
    expect(fleetLines([w({}), w({ id: "w2" })], pool, now)).toEqual([]);
    // The Studio before its one-time step: one info line for the host, however many of its workers say so; a contributor's worker never speaks for a host.
    const timer = fleetLines([w({ set_rollout: "timer" }), w({ id: "w2", set_rollout: "timer" }), w({ id: "c", side: "community", set_rollout: "unknown" })], pool, now);
    expect(timer).toHaveLength(1);
    expect(timer[0][0]).toBe("info");
    expect(timer[0][1]).toContain("omarchy-studio: the one-time step of the runbook's");
    expect(timer[0][1]).toContain("Update is unavailable there; releases still arrive through its timer");
    // Two rollouts, an updater not running: a warning each, per host; an offline worker says nothing of its host.
    const warns = fleetLines([w({ set_rollout: "both" }), w({ id: "x", labels: { where: "box-2" }, set_rollout: "stopped" }), w({ id: "y", labels: { where: "box-3" }, set_rollout: "stopped", alive: false })], pool, now);
    expect(warns.map((l) => l[0])).toEqual(["warn", "warn"]);
    expect(warns[0][1]).toContain("box-2: its updater is not running — releases do not reach it");
    expect(warns[1][1]).toContain("omarchy-studio: two rollouts run on this host");
    // Silent since the deploy: two workers, or one of the project's, alive in the hour before it and not heard from for 15 min.
    const silent = (ws: Record<string, unknown>[], p = pool) => fleetLines(ws.map(w), p, now).filter((l) => l[0] === "fail");
    const c = { side: "community", set_rollout: "unknown" };
    expect(silent([{ ...c, last_seen: ago(40) }])).toEqual([]);
    expect(silent([{ ...c, last_seen: ago(40) }, { ...c, id: "c2", last_seen: ago(90) }])[0][1]).toContain("2 workers alive before the deploy of v1.0.3");
    expect(silent([{ last_seen: ago(20) }])[0][1]).toContain("1 worker alive before the deploy of v1.0.3");
    expect(silent([{ last_seen: ago(20) }])[0][1]).toContain("has not claimed for 15 min — if the image does not start, roll it back");
    // One gone long before the deploy, one still heard from (a drain heartbeats), a deploy under 15 min old, a revoked one: nothing.
    expect(silent([{ last_seen: ago(200) }, { id: "d", last_seen: ago(2) }])).toEqual([]);
    // Silent since a moment within the deploy's rollout (a drain of up to 3 h, then an image that does not start): still said, hours on.
    const earlier = { version: "v1.0.3", deployed_at: ago(6 * 60) };
    expect(silent([{ last_seen: ago(6 * 60 - 150) }], earlier)[0][1]).toContain("1 worker alive before the deploy of v1.0.3");
    // Quiet only after the rollout was over — a host rebooted, a network out, a machine turned off days after a good release: no line
    // that asks for a rollback.
    expect(silent([{ last_seen: ago(60) }, { id: "d", last_seen: ago(20) }], earlier)).toEqual([]);
    expect(silent([{ last_seen: ago(20) }, { id: "d", last_seen: ago(30) }], { version: "v1.0.3", deployed_at: ago(2 * 24 * 60) })).toEqual([]);
    expect(silent([{ last_seen: ago(20) }], { version: "v1.0.3", deployed_at: ago(10) })).toEqual([]);
    expect(silent([{ last_seen: ago(20), revoked_at: ago(5) }])).toEqual([]);
    expect(silent([{ last_seen: ago(20) }], { version: "dev", deployed_at: null })).toEqual([]);
  });
});
