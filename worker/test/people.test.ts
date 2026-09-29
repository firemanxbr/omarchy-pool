/**
 * The People page (#251), drawn: the served page's own script run as a
 * browser would (runScript in test/fixture.ts) over the Worker's real
 * answers on the fixture, for nobody, for a contributor with nothing
 * approved, for the contributor whose package a maintainer approved and for
 * a maintainer. What it proves: the numbers, the maintainers' cards and the
 * contributors' ranking are the record's — the maintainer set, the
 * decisions, the registry's landed, the project's workers — and nothing
 * the page types; and the way in follows the dashboard's rule — one
 * button for everyone, live only for a signed-in contributor with an
 * approved package, grey with the reason in its title for everyone else,
 * never absent.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { APPLY_URL } from "../src/governance";
import { SIGN_IN } from "../src/routes/contributors";
import { fetchPage, runScript, scriptOf, seedDashboard, type Fixture, type Ran } from "./fixture";

let F: Fixture;
let served: string;

beforeAll(async () => {
  F = await seedDashboard(env);
  served = await (await real("/people")).text();
});

/** The Worker's answer to a path, as the browser on the page gets it: with the session's cookie when there is one. */
async function real(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await fetchPage(new Request(`http://pool.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const api = async (path: string) => (await real(path)).json() as Promise<any>;

/** The page's script, run as `session` (the fixture's cookie value, null for nobody) until the Become card is drawn for them. */
async function drawnAs(session: string | null, functions: string[] = [], variables: string[] = []): Promise<Ran> {
  const d = runScript(scriptOf(served), {
    pathname: "/people",
    functions,
    variables,
    fetch: (path, init) => real(path, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...(session ? { cookie: `omc=${session}` } : {}) } }),
  });
  for (let i = 0; i < 200 && !d.nodes["#apply-slot"]?.innerHTML; i++) await new Promise((r) => setTimeout(r, 10));
  expect(d.nodes["#apply-slot"]?.innerHTML, "the Become card was drawn").toBeTruthy();
  return d;
}

describe("the People page", () => {
  it("serves the frame of the design: the title, the three tiles, the two lists, the steps and Open the issue grey for nobody", () => {
    expect(served).toContain('<h1 class="op-hero">No owner. A community on the record.</h1>');
    expect(served).toContain('<link rel="stylesheet" href="/assets/kit.');
    for (const [k, line] of [["maintainers", "in MAINTAINERS.toml"], ["contributors", "with a request"], ["reviews", "this month"]]) expect(served).toContain(`<span class="s" id="s-${k}">${line}</span>`);
    for (const step of ["Get one package approved", "Open an issue on GitHub", "Maintainers open a PR"]) expect(served).toContain(`<b>${step}</b>`);
    // Served grey with the sign-in as the reason, its address set aside: what the shell's gate() draws for nobody, so the page reads the same before its script and without one.
    expect(served).toContain(`<a class="disabled op-btn" id="apply" data-href="${APPLY_URL}" tabindex="-1" aria-disabled="true" title="${SIGN_IN}">Open the issue</a>`);
    expect(APPLY_URL).toBe("https://github.com/firemanxbr/omarchy-pool/issues/new?template=maintainer.yml");
    // No worker table here since #251: the Workers page is one link away, where the Pool's tile lands.
    expect(served).not.toContain('class="wtable"');
    expect(served).toContain('<a id="workers" href="/workers">');
  });

  it("counts the record: the maintainers the pool applied, everyone with a request, the decisions signed this month", async () => {
    const d = await drawnAs(null);
    const maint = (await api("/api/v1/factory/maintainers")).maintainers as { login: string }[];
    const pkgs = (await api("/api/v1/factory/packages")).packages as { owner: string; landed: boolean }[];
    const decisions = (await api("/api/v1/factory/approvals")).approvals as { created_at: string }[];
    const now = new Date(), month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    expect(d.nodes["#n-maintainers"].textContent).toBe(String(maint.length));
    expect(d.nodes["#n-contributors"].textContent).toBe(String(new Set(pkgs.map((p) => p.owner)).size));
    expect(d.nodes["#n-reviews"].textContent).toBe(String(decisions.filter((a) => Date.parse(a.created_at) >= month).length));
    expect(maint.length).toBeGreaterThan(0);
  });

  it("draws a card per maintainer: since when, the agent a project worker of theirs reports, the decisions signed, the packages whose standing approval is theirs", async () => {
    const d = await drawnAs(null);
    const cards = d.nodes["#maintainers-list"].innerHTML.split('<article class="op-card pp-mcard">').slice(1) as string[];
    const maint = (await api("/api/v1/factory/maintainers")).maintainers as { login: string }[];
    const decisions = (await api("/api/v1/factory/approvals")).approvals as { by: string; name: string; standing: boolean; blocked_at: string | null }[];
    expect(cards.map((c) => /@([A-Za-z0-9-]+)<\/a>/.exec(c)?.[1])).toEqual(maint.map((m) => m.login));
    for (const [i, m] of maint.entries()) {
      const signed = decisions.filter((a) => a.by === m.login);
      const kept = [...new Set(signed.filter((a) => a.standing && !a.blocked_at).map((a) => a.name))];
      expect(cards[i], m.login).toContain(`<b>${signed.length}</b><span>reviews</span>`);
      expect(cards[i], m.login).toContain(`<b>${kept.length}</b><span>maintains</span>`);
      for (const name of kept) expect(cards[i], `${m.login} maintains ${name}`).toContain(`>${name}</a>`);
      expect(cards[i], m.login).toMatch(/<span>since [A-Z][a-z]{2} \d{4}<\/span>/);
    }
    // m1's approval of pulled stands, and m2 blocked the package: not one m1 maintains.
    const m1 = cards[maint.findIndex((m) => m.login === F.m1)];
    expect(decisions.some((a) => a.name === F.pulledPkg && a.standing && a.blocked_at)).toBe(true);
    expect(m1).not.toContain(`>${F.pulledPkg}</a>`);
    // m1's project worker reports its agent: the kit's mark, named; m2 has no project worker, and the card says the agent is not known.
    expect(m1).toContain('<i class="op-b op-b-claude-color" style="--op-i-s:14px" role="img" aria-label="Claude Code · claude-sonnet-5" title="Claude Code · claude-sonnet-5"></i>');
    expect(cards[maint.findIndex((m) => m.login === F.m2)]).toContain('title="no project worker of theirs reports an agent">—</span>');
  });

  it("ranks the contributors by approved packages, the registry's landed, and tags a maintainer", async () => {
    const d = await drawnAs(null);
    const pkgs = (await api("/api/v1/factory/packages")).packages as { owner: string; landed: boolean }[];
    const rows = [...(d.nodes["#contributors-list"].innerHTML as string).matchAll(/<a class="pp-person" href="\/user\/([^"]+)"[^>]*>[\s\S]*?<span class="pp-st" title="[^"]*">([^<]*)<\/span><\/a>/g)].map((m) => [m[1], m[2]]);
    const approved = (login: string) => pkgs.filter((p) => p.owner === login && p.landed).length;
    expect(rows.map((r) => r[0]).sort()).toEqual([...new Set(pkgs.map((p) => p.owner))].sort());
    for (let i = 1; i < rows.length; i++) expect(approved(rows[i - 1][0]), `${rows[i - 1][0]} before ${rows[i][0]}`).toBeGreaterThanOrEqual(approved(rows[i][0]));
    const requests = (login: string) => pkgs.filter((p) => p.owner === login).length;
    for (const [login, st] of rows) expect(st, login).toBe(approved(login) ? `${approved(login)} approved` : requests(login) === 1 ? "first request in" : `${requests(login)} requests in`);
    expect(rows[0][1]).toMatch(/^\d+ approved$/);
    expect(d.nodes["#contributors-list"].innerHTML).toContain(`title="${approved(F.owner)} approved by a maintainer, built by the project · `);
  });

  it("shows the first rows of a long ranking, and all of them on Show all", async () => {
    const d = await drawnAs(null, ["drawContributors"], ["RANKED", "ALL_ROWS"]);
    d.setRANKED(Array.from({ length: 20 }, (_, i) => ({ login: `person${i}`, requests: 1, approved: 20 - i })));
    d.drawContributors();
    const count = () => (d.nodes["#contributors-list"].innerHTML.match(/class="pp-person"/g) ?? []).length;
    expect(count()).toBe(16);
    expect(d.nodes["#contributors-all"]).toMatchObject({ hidden: false, textContent: "Show all 20" });
    d.setALL_ROWS(true);
    d.drawContributors();
    expect(count()).toBe(20);
    expect(d.nodes["#contributors-all"].hidden).toBe(true);
  });

  // The dashboard's rule: the same button for everyone; live for the one viewer who may apply, grey with the reason in its title for everyone else — nobody reads the sign-in first.
  it("opens the issue only for a signed-in contributor with an approved package, and says why to everyone else", async () => {
    const nobody = await drawnAs(null);
    expect(nobody.nodes["#you"].textContent).toBe("Sign in to see if you are eligible");
    expect(nobody.nodes["#apply-slot"].innerHTML).toBe(`<a class="disabled op-btn" id="apply" data-href="${APPLY_URL}" tabindex="-1" aria-disabled="true" title="${SIGN_IN}">Open the issue</a>`);

    const bob = await drawnAs(F.sessions.contributor);
    expect(bob.nodes["#you"].textContent).toBe(`@${F.contributor} · no package approved yet`);
    expect(bob.nodes["#apply-slot"].innerHTML).toContain('aria-disabled="true" title="get one package approved first">Open the issue</a>');

    const pkgs = (await api("/api/v1/factory/packages")).packages as { owner: string; landed: boolean }[];
    const mine = pkgs.filter((p) => p.owner === F.owner && p.landed).length;
    expect(mine).toBeGreaterThan(0);
    const alice = await drawnAs(F.sessions.owner);
    expect(alice.nodes["#you"].textContent).toBe(`@${F.owner} · ${mine} approved · eligible`);
    expect(alice.nodes["#apply-slot"].innerHTML).toBe(`<a class="op-btn primary" id="apply" href="${APPLY_URL}" title="opens the maintainer application on GitHub">Open the issue</a>`);

    const m2 = await drawnAs(F.sessions.maintainer);
    expect(m2.nodes["#you"].textContent).toBe("You are a maintainer.");
    expect(m2.nodes["#apply-slot"].innerHTML).toContain('aria-disabled="true" title="you are a maintainer already">Open the issue</a>');
  });
});
