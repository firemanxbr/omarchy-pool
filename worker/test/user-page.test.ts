/**
 * A person's page, drawn: the page's own button makers (src/pages/user.ts —
 * renderTop, renderRegister, buildBtn, removeBtn, workerActs, withdrawBtn)
 * run over the fixture for every role, from the same two answers the browser
 * has — /auth/me for who is looking and GET /users/alice/can for what they
 * may do here — and the build page's Decision cell beside them. The rule it
 * proves is the dashboard's first: every viewer gets every control, the same
 * for all, and the one who may not press one gets it disabled, grey, with the
 * server's reason in its title — never hidden, never a sentence in its place.
 * The script is the served page's, ES5 for a browser; here it runs against a
 * document that keeps what is written to it and a fetch that never answers,
 * so only the functions that draw are exercised.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { scriptOf, seedDashboard, type Fixture } from "./fixture";

let F: Fixture;
type Who = "" | "bob" | "alice" | "m1" | "m2";

beforeAll(async () => {
  F = await seedDashboard(env);
});

async function get(path: string, as: Who): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = as ? { cookie: `omc=oms_${as}` } : {};
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`, { headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* a page */ }
  return { status: res.status, text, json };
}

interface Drawn {
  nodes: Record<string, { innerHTML: string; outerHTML: string }>;
  setCan(c: unknown): void;
  setWho(me: unknown): void;
  renderTop(): void;
  renderRegister(): void;
  buildBtn(name: string, arch: string | null, stopped: string | null, title: string): string;
  removeBtn(name: string): string;
  workerActs(w: unknown, kind: string): string;
  withdrawBtn(a: unknown, standing: boolean): string;
  decisionCell(t: unknown): string;
}

/** The served page's script, run once: its IIFE opened so the page's functions can be reached, with a document that keeps every node written to by selector. */
async function drawn(): Promise<Drawn> {
  const page = await get(`/user/${F.owner}`, "");
  expect(page.status).toBe(200);
  const code = scriptOf(page.text).trim();
  expect(code.startsWith("(function () {") && code.endsWith("})();")).toBe(true);
  const body = code.slice("(function () {".length, -"})();".length);
  const nodes: Record<string, any> = {};
  const node = (): any => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {} }, children: [], hidden: false, innerHTML: "", outerHTML: "", textContent: "", title: "",
    appendChild() {}, setAttribute() {}, getAttribute: () => null, insertAdjacentHTML() {}, remove() {}, focus() {}, closest: () => null,
    querySelector: () => node(), querySelectorAll: () => [],
  });
  const document = {
    querySelector: (sel: string) => (nodes[sel] = nodes[sel] || node()),
    querySelectorAll: () => [], addEventListener() {}, createElement: node, body: node(), documentElement: { getAttribute: () => null }, title: "",
  };
  const make = new Function("document", "window", "fetch", "location", "innerWidth", "nodes", body + `
    return {
      nodes: nodes, setCan: function (c) { CAN = c; }, setWho: function (me) { WHO = identity(me); },
      renderTop: renderTop, renderRegister: renderRegister, buildBtn: buildBtn, removeBtn: removeBtn, workerActs: workerActs, withdrawBtn: withdrawBtn, decisionCell: decisionCell,
    };`);
  return make(document, { matchMedia: null }, () => new Promise(() => {}), { pathname: `/user/${F.owner}`, origin: "http://pool.test" }, 1024, nodes);
}

/** Every button and link in a piece of HTML, in order: its text, whether it is grey, its title. */
function controls(html: string): { text: string; grey: boolean; title: string | null }[] {
  return [...html.matchAll(/<(button|a)\b([^>]*)>([^<]*)<\/\1>/g)].map((m) => ({
    text: m[3].trim(),
    grey: m[1] === "button" ? /\sdisabled\b/.test(m[2]) && /aria-disabled="true"/.test(m[2]) : /class="disabled\b/.test(m[2]) && /aria-disabled="true"/.test(m[2]),
    title: (/title="([^"]*)"/.exec(m[2]) ?? [null, null])[1],
  }));
}

/** The page as `as` has it: who is looking (the shell's /auth/me) and the caller's rights on alice's page (GET /users/alice/can). */
async function asRole(d: Drawn, as: Who) {
  const me = await get("/auth/me", as);
  d.setWho(me.status === 200 ? me.json : null);
  const can = await get(`/api/v1/users/${F.owner}/can`, as);
  expect(can.status).toBe(200);
  d.setCan(can.json.can);
}

const SIGN_IN = "sign in with GitHub";
const WORKERS_WORD = "sharing is the owner's word alone: a maintainer can set a worker to its owner's packages, not share it";

describe("a person's page draws every control for every viewer, grey with the server's reason where the viewer may not press it", () => {
  let d: Drawn;
  let w3: any;
  let approval: any;
  beforeAll(async () => {
    d = await drawn();
    w3 = (await get("/api/v1/factory?limit=10", "")).json.workers.find((w: any) => w.id === F.communityWorker);
    expect(w3.owner).toBe(F.owner);
    // The one standing approval of the fixture: m2's, of the project's build of alice's package, on m2's page.
    approval = (await get(`/api/v1/users/${F.m2}`, "")).json.approvals.find((a: any) => a.task_id === F.projectTask);
    expect(approval.decision).toBe("approved");
  });

  /** Everything the page draws for one viewer, as text: control → [grey, title]. */
  async function everything(as: Who) {
    await asRole(d, as);
    d.renderTop(); d.renderRegister();
    const one = (html: string) => { const c = controls(html); expect(c).toHaveLength(1); return c[0]; };
    return {
      Share: one(d.nodes["#share-btn"].innerHTML.split("</button>")[0] + "</button>"),
      Token: one(d.nodes["#share-btn"].innerHTML.split("</button>")[1] + "</button>"),
      "+ request one": one(d.nodes["#pk-request"].outerHTML),
      "+ register one": one(d.nodes["#w-toggle"].outerHTML),
      "Register worker": controls(d.nodes["#worker-form"].innerHTML)[0],
      "Build all": one(d.buildBtn(F.factoryPkg, null, null, "every architecture the request names")),
      [`Build ${F.arch}`]: one(d.buildBtn(F.factoryPkg, F.arch, null, "this architecture only")),
      "Build all (a build in flight)": one(d.buildBtn(F.factoryPkg, null, "a build is in flight", "every architecture the request names")),
      "Remove mine": one(d.removeBtn(F.factoryPkg)),
      "Remove ours": one(d.removeBtn(F.publishedPkg)),
      "Share w3": controls(d.workerActs(w3, "community"))[0],
      "Own only w3": controls(d.workerActs({ ...w3, mode: "shared" }, "community"))[0],
      "Revoke w3": controls(d.workerActs(w3, "community"))[1],
      Withdraw: one(d.withdrawBtn(approval, true)),
      "Withdraw (nothing standing)": one(d.withdrawBtn({ ...approval, withdrawn_at: "2026-09-17T00:00:00Z" }, false)),
    };
  }
  const grey = (title: string) => expect.objectContaining({ grey: true, title });
  const live = expect.objectContaining({ grey: false });

  it("nobody signed in: every control, all grey, each titled with the sign-in — the state's reason first where there is one", async () => {
    const e = await everything("");
    for (const [name, c] of Object.entries(e)) expect(c, name).toEqual(grey(name === "Build all (a build in flight)" ? "a build is in flight" : SIGN_IN));
    expect(d.nodes["#share-btn"].innerHTML).toBe('<button type="button" class="btn" id="share-open" disabled aria-disabled="true" title="sign in with GitHub">Share</button> <button type="button" class="btn ghost" id="token-open" disabled aria-disabled="true" title="sign in with GitHub">Token</button>');
    expect(d.nodes["#pk-request"].outerHTML).toBe('<a class="disabled more-link" id="pk-request" data-href="/request" tabindex="-1" aria-disabled="true" title="sign in with GitHub">+ request one →</a>');
  });

  it("bob, a contributor who owns nothing: the same controls, grey with whose they are", async () => {
    expect(await everything("bob")).toEqual({
      Share: grey("only alice shares their page"),
      Token: grey("only alice mints their token"),
      "+ request one": grey("only alice requests here"),
      "+ register one": grey("only alice registers a worker here"),
      "Register worker": grey("only alice registers a worker here"),
      "Build all": grey("only alice builds here"),
      [`Build ${F.arch}`]: grey("only alice builds here"),
      "Build all (a build in flight)": grey("a build is in flight"),
      "Remove mine": grey("only alice removes it, or a maintainer"),
      "Remove ours": grey("only alice removes it, or a maintainer"),
      "Share w3": grey(WORKERS_WORD),
      "Own only w3": grey("only alice or a maintainer sets where it builds"),
      "Revoke w3": grey("only alice or a maintainer revokes a worker here"),
      Withdraw: grey("a maintainer decides"),
      "Withdraw (nothing standing)": grey("a maintainer decides"),
    });
  });

  it("alice, the owner: her workspace live — but Remove on an approved or published package is a maintainer's, and Withdraw a maintainer's", async () => {
    expect(await everything("alice")).toEqual({
      Share: live, Token: live, "+ request one": live, "+ register one": live, "Register worker": live,
      "Build all": live, [`Build ${F.arch}`]: live,
      "Build all (a build in flight)": grey("a build is in flight"),
      "Remove mine": grey("mine is approved: a maintainer removes it"),
      "Remove ours": grey("ours is published: a maintainer removes it"),
      "Share w3": live, "Own only w3": live, "Revoke w3": live,
      Withdraw: grey("a maintainer decides"),
      "Withdraw (nothing standing)": grey("a maintainer decides"),
    });
    // Live, the control is the served one with its own title: the owner's Token and request link untouched by the gate.
    expect(d.nodes["#share-btn"].innerHTML).toContain('<button type="button" class="btn ghost" id="token-open" title="a token for scripts and CI">Token</button>');
    expect(d.nodes["#pk-request"].outerHTML).toBe('<a class="more-link" id="pk-request" href="/request">+ request one →</a>');
  });

  it("m1, a maintainer on alice's page: revoke, own only, remove and withdraw are theirs; the workspace and sharing a worker stay alice's", async () => {
    expect(await everything("m1")).toEqual({
      Share: grey("only alice shares their page"),
      Token: grey("only alice mints their token"),
      "+ request one": grey("only alice requests here"),
      "+ register one": grey("only alice registers a worker here"),
      "Register worker": grey("only alice registers a worker here"),
      "Build all": grey("only alice builds here"),
      [`Build ${F.arch}`]: grey("only alice builds here"),
      "Build all (a build in flight)": grey("a build is in flight"),
      "Remove mine": live, "Remove ours": live,
      "Share w3": grey(WORKERS_WORD),
      "Own only w3": live, "Revoke w3": live,
      Withdraw: live,
      "Withdraw (nothing standing)": grey("nothing standing to withdraw"),
    });
    // The row as m1 has it: the mode button grey with the owner's word, Revoke live with its own title; Withdraw live on the standing approval.
    expect(d.workerActs(w3, "community")).toBe(`<button type="button" class="small-btn" data-mode="${F.communityWorker}" data-to="shared" disabled aria-disabled="true" title="${WORKERS_WORD}">Share</button> <button type="button" class="small-btn" data-revoke="${F.communityWorker}" title="revoke this worker's token">Revoke</button>`);
    expect(d.withdrawBtn(approval, true)).toBe(`<button type="button" class="small-btn" data-withdraw="${F.projectTask}" data-name="${F.factoryPkg} ${approval.version}" title="take the approval back: the package leaves every ring, another maintainer decides — the reason goes on the record">Withdraw</button>`);
  });

  it("the build page's four buttons on the project's approved build, per role: Withdraw live for m1 and m2, Approve grey — already approved — for both, everything grey with the sign-in for nobody and a maintainer decides for the rest", async () => {
    const task = (await get(`/api/v1/factory/tasks/${F.projectTask}`, "")).json;
    const cell = async (as: Who) => {
      const can = await get(`/api/v1/factory/tasks/${F.projectTask}/can`, as);
      expect(can.status).toBe(200);
      return controls(d.decisionCell({ id: task.task.id, name: task.task.name, version: task.task.version, arch: task.task.arch, can: can.json.can, approval: task.approval })).map((c) => [c.text, c.grey, c.title]);
    };
    const WITHDRAW = "take the approval back: the package leaves every ring, another maintainer decides — the reason goes on the record";
    expect(await cell("")).toEqual([["Approve", true, SIGN_IN], ["Reject", true, SIGN_IN], ["Build by the project", true, SIGN_IN], ["Withdraw the approval", true, SIGN_IN]]);
    expect(await cell("bob")).toEqual([["Approve", true, "a maintainer decides"], ["Reject", true, "a maintainer decides"], ["Build by the project", true, "a maintainer decides"], ["Withdraw the approval", true, "a maintainer decides"]]);
    expect(await cell("alice")).toEqual([["Approve", true, "a maintainer decides"], ["Reject", true, "a maintainer decides"], ["Build by the project", true, "a maintainer decides"], ["Withdraw the approval", true, "a maintainer decides"]]);
    for (const m of ["m1", "m2"] as Who[]) {
      expect(await cell(m), m).toEqual([
        ["Approve", true, "already approved"],
        ["Reject", true, "already approved — withdraw the approval first"],
        ["Build by the project", true, "the project's own build; the project builds from a contributor's staged build"],
        ["Withdraw the approval", false, WITHDRAW],
      ]);
    }
  });
});
