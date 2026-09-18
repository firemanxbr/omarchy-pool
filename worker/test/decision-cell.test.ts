/**
 * The Decision cell, drawn: the shell's decisionCell (HELPERS in
 * src/pages/layout.ts) run over the fixture's rows for every role, the way
 * Review and the Pipeline draw it from GET /factory/review and a build's page
 * from the task and GET /factory/tasks/:id/can. The rule it proves is the
 * dashboard's first: every viewer gets the same buttons — Approve, Reject,
 * Build by the project, Withdraw when an approval stands — and the one who
 * may not press one gets it disabled, grey, with the server's reason in its
 * title, never a sentence in its place. The shell's script is ES5 written
 * for a browser; here it runs against a document that answers nothing, so
 * only the functions that draw are exercised.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { HELPERS, servedGrey } from "../src/pages/layout";
import { runScript, seedDashboard, type Fixture } from "./fixture";

let F: Fixture;
type Who = "" | "bob" | "alice" | "m1" | "m2";

beforeAll(async () => {
  F = await seedDashboard(env);
});

/** The shell's drawing functions, taken out of HELPERS and run as a page runs them (runScript in test/fixture.ts). */
function shell(): { decisionCell: (t: unknown) => string; gate: (html: string, ok: boolean, why: string) => string } {
  const src = HELPERS.split("__POOL_URL__").join("http://pool.test").split("__RINGS_TEXT__").join("{}").split("__WICON__").join("{}");
  return runScript(src, { pathname: "/review", functions: ["decisionCell", "gate"] }) as any;
}

async function get(path: string, as: Who): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = as ? { cookie: `omc=oms_${as}` } : {};
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test/api/v1${path}`, { headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** The row Review draws: the staged list's row for `id`, as `as` reads it. */
async function row(id: number, as: Who) {
  const r = await get("/factory/review", as);
  const t = r.json.staged.find((s: any) => s.id === id);
  expect(t, `task ${id} in the review list`).toBeTruthy();
  return t;
}

/** The row a build's page puts together: the task's own answer (public, cached) plus the caller's rights from the no-store endpoint. */
async function buildRow(id: number, as: Who) {
  const [task, can] = await Promise.all([get(`/factory/tasks/${id}`, as), get(`/factory/tasks/${id}/can`, as)]);
  expect(task.status).toBe(200);
  expect(can.status).toBe(200);
  const T = task.json;
  return { id: T.task.id, name: T.task.name, version: T.task.version, arch: T.task.arch, can: can.json.can, approval: T.approval };
}

/** Every button of a cell, in order: its data-* decision, its title, whether it is disabled. */
function buttons(html: string): { what: string; text: string; disabled: boolean; title: string | null }[] {
  return [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map((m) => ({
    what: /data-(approve|reject|build|withdraw)=/.exec(m[1])![1],
    text: m[2],
    disabled: /\sdisabled\b/.test(m[1]) && /aria-disabled="true"/.test(m[1]),
    title: (/title="([^"]*)"/.exec(m[1]) ?? [null, null])[1],
  }));
}

const OWNER = (name: string) => `you brought ${name} — another maintainer decides; with one maintainer, that maintainer's own packages wait`;

describe("the Decision cell is the same buttons for every viewer, grey with the reason where the viewer may not decide", () => {
  it("nobody signed in: Approve, Reject and Build by the project, all grey, each titled with the sign-in", async () => {
    const html = shell().decisionCell(await row(F.stagedTask, ""));
    expect(html).toContain(`<span class="decide" data-task="${F.stagedTask}"`);
    expect(buttons(html)).toEqual([
      { what: "approve", text: "Approve", disabled: true, title: "sign in with GitHub" },
      { what: "reject", text: "Reject", disabled: true, title: "sign in with GitHub" },
      { what: "build", text: "Build by the project", disabled: true, title: "sign in with GitHub" },
    ]);
    // On the project's approved build the fourth button, Withdraw, is there too — grey like the others.
    const b = buttons(shell().decisionCell(await buildRow(F.projectTask, "")));
    expect(b.map((x) => x.what)).toEqual(["approve", "reject", "build", "withdraw"]);
    expect(b.every((x) => x.disabled && x.title === "sign in with GitHub")).toBe(true);
  });

  it("bob, a contributor: the same three buttons, grey, a maintainer decides", async () => {
    const b = buttons(shell().decisionCell(await row(F.stagedTask, "bob")));
    expect(b.map((x) => x.what)).toEqual(["approve", "reject", "build"]);
    expect(b.every((x) => x.disabled && x.title === "a maintainer decides")).toBe(true);
  });

  it("alice, who brought the package: as a contributor a maintainer decides; as a maintainer her own row stays grey with the owner rule", async () => {
    const asContributor = buttons(shell().decisionCell(await row(F.stagedTask, "alice")));
    expect(asContributor.every((x) => x.disabled && x.title === "a maintainer decides")).toBe(true);
    await env.DB.prepare("UPDATE contributors SET role = 'maintainer' WHERE login = 'alice'").run();
    try {
      const b = buttons(shell().decisionCell(await row(F.stagedTask, "alice")));
      expect(b.map((x) => [x.what, x.disabled])).toEqual([["approve", true], ["reject", true], ["build", true]]);
      expect(b[0].title).toMatch(/have the project build it first/); // a contributor's build: the kind comes before the owner
      expect(b[1].title).toBe(OWNER(F.factoryPkg));
      expect(b[2].title).toBe(OWNER(F.factoryPkg));
      // The project's build of her package: Approve and Reject are the owner's to leave alone; Withdraw, undoing, is not deciding.
      const p = buttons(shell().decisionCell(await buildRow(F.projectTask, "alice")));
      expect(p.map((x) => [x.what, x.disabled, x.title])).toEqual([
        ["approve", true, OWNER(F.factoryPkg)],
        ["reject", true, OWNER(F.factoryPkg)],
        ["build", true, "the project's own build; the project builds from a contributor's staged build"],
        ["withdraw", false, "take the approval back: the package leaves every ring, another maintainer decides — the reason goes on the record"],
      ]);
    } finally {
      await env.DB.prepare("UPDATE contributors SET role = 'contributor' WHERE login = 'alice'").run();
    }
  });

  it("m1, a maintainer, on a contributor's staged build: Reject and Build live, Approve grey until the project has built it", async () => {
    const b = buttons(shell().decisionCell(await row(F.stagedTask, "m1")));
    expect(b.map((x) => [x.what, x.disabled])).toEqual([["approve", true], ["reject", false], ["build", false]]);
    expect(b[0].title).toBe("a contributor's build is evidence, never what users get — have the project build it first, then approve the project's build");
    expect(b[1].title).toBeNull();
    expect(b[2].title).toBeNull();
  });

  it("m1 and m2 on the project's approved build: Approve grey (already approved), Reject grey (withdraw first), Build grey (the project's own), Withdraw live — for the one who approved it as for the other", async () => {
    for (const m of ["m1", "m2"] as Who[]) {
      const b = buttons(shell().decisionCell(await buildRow(F.projectTask, m)));
      expect(b.map((x) => [x.what, x.disabled, x.title]), m).toEqual([
        ["approve", true, "already approved"],
        ["reject", true, "already approved — withdraw the approval first"],
        ["build", true, "the project's own build; the project builds from a contributor's staged build"],
        ["withdraw", false, "take the approval back: the package leaves every ring, another maintainer decides — the reason goes on the record"],
      ]);
    }
  });

  it("a list row that carries a standing approval draws Withdraw as the build's page does — the same cell whichever page reads it", async () => {
    // The fixture's lists hold no such row (a chain approved leaves the review); the row is a build's page's, with `standing` where the list would put it.
    const t = await buildRow(F.projectTask, "m1");
    const asList = { id: t.id, name: t.name, version: t.version, arch: t.arch, can: t.can, standing: true };
    expect(buttons(shell().decisionCell(asList)).map((x) => x.what)).toEqual(["approve", "reject", "build", "withdraw"]);
    expect(buttons(shell().decisionCell({ ...asList, standing: false })).map((x) => x.what)).toEqual(["approve", "reject", "build"]);
  });

  it("gate() leaves a control alone when ok and disables every control in it with the reason otherwise — a link loses its href too, and a title already there gives way", () => {
    const { gate } = shell();
    const html = '<button type="button" title="press">Go</button> <a class="run" href="/x">there</a> <select><option>a</option></select>';
    expect(gate(html, true, "never shown")).toBe(html);
    const grey = gate(html, false, 'a maintainer "decides"');
    expect(grey).toBe('<button type="button" disabled aria-disabled="true" title="a maintainer &quot;decides&quot;">Go</button> <a class="disabled run" data-href="/x" tabindex="-1" aria-disabled="true" title="a maintainer &quot;decides&quot;">there</a> <select disabled aria-disabled="true" title="a maintainer &quot;decides&quot;"><option>a</option></select>');
    expect(grey).not.toContain(' href="');
    // A page that serves a control grey before its script runs writes the same attributes (servedGrey in layout.ts): the served control and the one gate() draws again are one.
    expect(servedGrey(html, 'a maintainer "decides"')).toBe(grey);
    const served = '<input id="w-name" placeholder="laptop" required> <a class="more-link" id="pk-request" href="/request">+ request one →</a>';
    expect(servedGrey(served, "only alice requests here")).toBe(gate(served, false, "only alice requests here"));
  });
});
