/**
 * Status (#248), the page the Pipeline, the Journal and Security became:
 * every section the design names is served, and the sections the old
 * addresses land on are there (index.ts MOVED: /journal → #journal,
 * /security → #advisories); the stats carry each ring's last releases with
 * where their selection came from, so a rollback is drawn red, and what
 * each source's syncs brought today; every source the pool syncs is a row
 * of the Sources card; the hero says all rings are healthy only when they
 * are, and names the ring that is not; the journal says who did a line and
 * with which agent; and a maintainer's roll back — on a ring's card and in
 * its history — is drawn for a maintainer and for nobody else. The page's
 * own script runs here (runScript in test/fixture.ts) over the Worker's
 * real answers on the fixture, as each role would get them.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { MOVED } from "../src/index";
import { issueJobToken } from "../src/jobtoken";
import { EXPECTED_SOURCES, RINGS } from "../src/meta";
import { RING_HISTORY } from "../src/routes/stats";
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

/** The page's script run as `cookie`'s reader would get it (nobody for none): every read the Worker's own answer. */
async function drawn(cookie?: string, search = ""): Promise<Ran> {
  const fetch = (path: string, init?: RequestInit) => real(path === "/auth/me" ? path : uncached(path), { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...(cookie ? { cookie: `omc=${cookie}` } : {}) } });
  const d = runScript(SCRIPT, { pathname: "/status", search, functions: ["whoOf", "drawHero"], variables: ["STATS"], fetch });
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
    expect(m.nodes["#st-rings"].innerHTML).toContain(">Roll back to #1</button>");
    // The history offers every release but a head: stable's first, not its second.
    expect(m.nodes["#history-table tbody"].innerHTML).toContain(`data-rollback="${F.previousRelease}" data-ring="stable"`);
    expect(m.nodes["#history-table tbody"].innerHTML).not.toContain(`data-rollback="${F.release}"`);
    // What it posts is the shell's rollback job, a maintainer's alone (the manifest's act proves the roles).
    expect(SCRIPT).toContain('kind: "rollback", params: { ring: ring, to: to, note: note }');
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
    const arch = [...d.nodes["#sources-rows"].innerHTML.matchAll(/<tr[^>]*><td><span class="st-dot[^"]*"><\/span>([^<]+)<\/td><td>([^<]*)<\/td><td class="num">([\d,]+)<\/td><td class="num s-plus">\+([\d,]+)<\/td>/g)].find((m) => m[1] === "Arch Linux")!;
    const x86 = stats.coverage.filter((c: { source: string; arch: string }) => ["core", "extra", "multilib"].includes(c.source) && c.arch === "x86_64");
    expect(Number(arch[4])).toBe(x86.reduce((n: number, c: { today: number }) => n + c.today, 0));
    expect(arch[2]).toBe("core · extra · multilib");
  });

  it("has a Sources row for every source the pool syncs, and nothing it does not", () => {
    const mapped = SOURCE_PROJECTS.flatMap(([, repos]) => repos.map(([source, arch]) => `${source}/${arch}`));
    expect([...new Set(mapped)].length, "a repository in two rows").toBe(mapped.length);
    expect(mapped.sort()).toEqual(EXPECTED_SOURCES.map((e) => `${e.source}/${e.arch}`).sort());
  });

  it("says all rings are healthy only when they are, and names the ring that is not", async () => {
    const d = await drawn();
    const stats = await json(uncached("/api/v1/stats"));
    // The fixture's sources were synced longer ago than the pool allows (the shell's problemsOf): every ring healthy, the syncs behind — amber, and the lede says what is late.
    d.setSTATS(stats);
    d.drawHero();
    expect(d.nodes["#headline"].textContent).toBe("All rings healthy, syncs behind");
    expect(d.nodes["#st-mark"].className).toBe("st-mark warn");
    expect(d.nodes["#st-lede"].textContent).toMatch(/no sync for |source\(s\) not synced for /);
    expect(d.nodes["#st-lede"].textContent).toContain("The rings keep serving what they have");
    // Every source synced a minute ago: all rings healthy, in green, and the design's one sentence.
    const now = new Date(Date.now() - 60e3).toISOString();
    const fed = { ...stats, coverage: stats.coverage.map((c: object) => ({ ...c, late: false })), latest: stats.latest.map((e: { kind: string }) => (e.kind === "sync" ? { ...e, created_at: now } : e)) };
    d.setSTATS(fed);
    d.drawHero();
    expect(d.nodes["#headline"].textContent).toBe("All rings healthy");
    expect(d.nodes["#st-mark"].className).toBe("st-mark ok");
    expect(d.nodes["#st-lede"].textContent).toBe("Every sync, release, check and decision is on the record.");
    // rc fails its check on x86_64: the hero says rc, in red, and the lede says why.
    const sick = { ...fed, latest: [...fed.latest.filter((e: { kind: string; ring: string }) => !(e.kind === "health" && e.ring === "rc")), { kind: "health", ring: "rc", source: F.arch, status: "error", summary: "rc x86_64: pacman check failed", created_at: new Date().toISOString() }] };
    d.setSTATS(sick);
    d.drawHero();
    expect(d.nodes["#headline"].textContent).toBe("rc not healthy");
    expect(d.nodes["#st-mark"].className).toBe("st-mark fail");
    expect(d.nodes["#st-lede"].textContent).toContain(`rc ${F.arch} failed its health check`);
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
    // A job on the project's worker: the pool, with the agent the worker runs.
    const w1 = (await json(uncached("/api/v1/factory?limit=10"))).workers.find((w: { id: string }) => w.id === F.worker);
    const job = d.whoOf({ kind: "job", payload: { worker: F.worker } });
    expect(job).toContain("the pool");
    if (w1?.agent) expect(job).toContain(`aria-label="${w1.agent}"`);
    // Nobody named: the pool's mark. Something that is not a login is never a link.
    expect(d.whoOf({ kind: "sync", payload: null })).toContain("the pool");
    expect(d.whoOf({ kind: "approve", payload: { by: '"><img src=x>' } })).not.toMatch(/<img|href="\/user\//);
  });
});
