/**
 * A person's page, drawn: the page's own button makers (src/pages/user.ts —
 * renderTop, renderRegister, buildBtn, removeBtn, workerActs, withdrawBtn)
 * and the shell's log icon run over the fixture for every role, from the
 * same two answers the browser has — /auth/me for who is looking and GET
 * /users/alice/can for what they may do here. The rule it proves is the
 * dashboard's first: every viewer gets every control, the same for all, and
 * the one who may not press one gets it disabled, grey, with the server's
 * reason in its title — never hidden, never a sentence in its place. The
 * script is the served page's, run as a browser would (runScript in
 * test/fixture.ts); the build page's Decision cell is decision-cell.test.ts.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { runScript, scriptOf, seedDashboard, type Fixture } from "./fixture";

let F: Fixture;
type Who = "" | "bob" | "alice" | "m1" | "m2";

beforeAll(async () => {
  F = await seedDashboard(env);
});

async function call(method: string, path: string, as: Who, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = as ? { cookie: `omc=oms_${as}` } : {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* a page */ }
  return { status: res.status, text, json };
}
const get = (path: string, as: Who) => call("GET", path, as);

interface Drawn {
  nodes: Record<string, { innerHTML: string; outerHTML: string }>;
  setCAN(c: unknown): void;
  setWHO(w: unknown): void;
  identity(me: unknown): unknown;
  renderTop(): void;
  renderRegister(): void;
  buildBtn(name: string, arch: string | null, stopped: string | null, title: string): string;
  removeBtn(name: string): string;
  workerActs(w: unknown): string;
  withdrawBtn(a: unknown, standing: boolean): string;
  wtLog(w: unknown): string;
}

/** The served page's script, run once, with the page's button makers and the shell's log icon reachable. */
async function drawn(): Promise<Drawn> {
  const page = await get(`/user/${F.owner}`, "");
  expect(page.status).toBe(200);
  return runScript(scriptOf(page.text), {
    pathname: `/user/${F.owner}`,
    functions: ["identity", "renderTop", "renderRegister", "buildBtn", "removeBtn", "workerActs", "withdrawBtn", "wtLog"],
    variables: ["CAN", "WHO"],
  }) as Drawn;
}

/** Every button and link in a piece of HTML, in order: its text, whether it is grey, its title. */
function controls(html: string): { text: string; grey: boolean; title: string | null }[] {
  return [...html.matchAll(/<(button|a)\b([^>]*)>([^<]*(?:<svg[\s\S]*?<\/svg>)?)<\/\1>/g)].map((m) => ({
    text: m[3].replace(/<svg[\s\S]*?<\/svg>/, "").trim() || (/aria-label="([^"]*)"/.exec(m[3]) ?? [null, "?"])[1]!,
    grey: m[1] === "button" ? /\sdisabled\b/.test(m[2]) && /aria-disabled="true"/.test(m[2]) : /class="disabled\b/.test(m[2]) && /aria-disabled="true"/.test(m[2]),
    title: (/title="([^"]*)"/.exec(m[2]) ?? [null, null])[1],
  }));
}

/** The page as `as` has it: who is looking (the shell's /auth/me) and the caller's rights on `login`'s page (GET /users/<login>/can). */
async function asRole(d: Drawn, as: Who, login = F.owner) {
  const me = await get("/auth/me", as);
  d.setWHO(d.identity(me.status === 200 ? me.json : null));
  const can = await get(`/api/v1/users/${login}/can`, as);
  expect(can.status).toBe(200);
  d.setCAN(can.json.can);
}

const SIGN_IN = "sign in with GitHub";
const WORKERS_WORD = "sharing is the owner's word alone: a maintainer can set a worker to its owner's packages, not share it";
const LOG_WORD = "the worker's log is its owner's and the maintainers' to read";
const NO_MODE = "a project worker takes the project's work; it has no shared or own mode";

describe("a person's page draws every control for every viewer, grey with the server's reason where the viewer may not press it", () => {
  let d: Drawn;
  let w3: any;
  let gone: any;
  let approval: any;
  beforeAll(async () => {
    d = await drawn();
    w3 = (await get("/api/v1/factory?limit=10", "")).json.workers.find((w: any) => w.id === F.communityWorker);
    expect(w3.owner).toBe(F.owner);
    // A worker alice registered and revoked: its row stays on her page, its buttons grey with the state's word for everyone.
    const box = await call("POST", "/api/v1/factory/workers", "alice", { name: "box", arch: F.arch });
    expect(box.status, box.text).toBe(201);
    expect((await call("DELETE", `/api/v1/factory/workers/${box.json.worker}`, "alice")).status).toBe(200);
    gone = { ...w3, id: box.json.worker, revoked_at: "2026-09-17T00:00:00Z" };
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
      "Register worker": controls(d.nodes["#worker-form"].innerHTML)[0],
      "Build all": one(d.buildBtn(F.factoryPkg, null, null, "every architecture the request names")),
      [`Build ${F.arch}`]: one(d.buildBtn(F.factoryPkg, F.arch, null, "this architecture only")),
      "Build all (a build in flight)": one(d.buildBtn(F.factoryPkg, null, "a build is in flight", "every architecture the request names")),
      "Remove mine": one(d.removeBtn(F.factoryPkg)),
      "Remove ours": one(d.removeBtn(F.publishedPkg)),
      "Share w3": controls(d.workerActs(w3))[0],
      "Own only w3": controls(d.workerActs({ ...w3, mode: "shared" }))[0],
      "Revoke w3": controls(d.workerActs(w3))[1],
      "log w3": one(d.wtLog(w3)),
      "Share box (revoked)": controls(d.workerActs(gone))[0],
      "Revoke box (revoked)": controls(d.workerActs(gone))[1],
      Withdraw: one(d.withdrawBtn(approval, true)),
      "Withdraw (nothing standing)": one(d.withdrawBtn({ ...approval, withdrawn_at: "2026-09-17T00:00:00Z" }, false)),
    };
  }
  const grey = (title: string) => expect.objectContaining({ grey: true, title });
  const live = expect.objectContaining({ grey: false });
  const revoked = () => grey(`${gone.id} is revoked already`);

  it("nobody signed in: every control, all grey, each titled with the sign-in — the state's reason first where there is one; Share alone is live, the page being public", async () => {
    const e = await everything("");
    for (const [name, c] of Object.entries(e)) expect(c, name).toEqual(name === "Share" ? live : grey(name === "Build all (a build in flight)" ? "a build is in flight" : SIGN_IN));
    expect(d.nodes["#share-btn"].innerHTML).toBe('<button type="button" class="btn" id="share-open" title="the link to this page, to post anywhere">Share</button> <button type="button" class="btn ghost" id="token-open" disabled aria-disabled="true" title="sign in with GitHub">Token</button>');
    expect(d.nodes["#pk-request"].outerHTML).toBe('<a class="disabled more-link" id="pk-request" data-href="/request" tabindex="-1" aria-disabled="true" title="sign in with GitHub">+ request one →</a>');
    // The toggle before the register form is served live for everyone and never drawn again: it only shows the form, whose fields are the ones served grey.
    const served = (await get(`/user/${F.owner}`, "")).text;
    expect(served).toContain('<button type="button" class="more-link" id="w-toggle" title="the form: a name, an architecture, one command to run it">+ register one</button>');
    expect(served).toContain('<input type="text" id="w-name" placeholder="laptop" required disabled aria-disabled="true" title="only alice registers a worker here">');
    expect(d.nodes["#w-toggle"].outerHTML).toBe("");
  });

  it("bob, a contributor who owns nothing: the same controls, grey with whose they are — and, for what is his on his own page, where that is", async () => {
    expect(await everything("bob")).toEqual({
      Share: live,
      Token: grey("only alice mints their token — yours is on /user/bob"),
      "+ request one": grey("only alice requests here — yours is on /user/bob"),
      "Register worker": grey("only alice registers a worker here — yours is on /user/bob"),
      "Build all": grey("only alice builds here — yours is on /user/bob"),
      [`Build ${F.arch}`]: grey("only alice builds here — yours is on /user/bob"),
      "Build all (a build in flight)": grey("a build is in flight"),
      "Remove mine": grey("only alice removes it, or a maintainer"),
      "Remove ours": grey("only alice removes it, or a maintainer"),
      "Share w3": grey(WORKERS_WORD),
      "Own only w3": grey("only alice or a maintainer sets where it builds"),
      "Revoke w3": grey("only alice or a maintainer revokes a worker here"),
      "log w3": grey(LOG_WORD),
      "Share box (revoked)": revoked(),
      "Revoke box (revoked)": revoked(),
      Withdraw: grey("a maintainer decides"),
      "Withdraw (nothing standing)": grey("a maintainer decides"),
    });
  });

  it("alice, the owner: her workspace live — but Remove on an approved or published package is a maintainer's, Withdraw a maintainer's, and her revoked worker is gone", async () => {
    expect(await everything("alice")).toEqual({
      Share: live, Token: live, "+ request one": live, "Register worker": live,
      "Build all": live, [`Build ${F.arch}`]: live,
      "Build all (a build in flight)": grey("a build is in flight"),
      "Remove mine": grey("mine is approved: a maintainer removes it"),
      "Remove ours": grey("ours is published: a maintainer removes it"),
      "Share w3": live, "Own only w3": live, "Revoke w3": live, "log w3": live,
      "Share box (revoked)": revoked(), "Revoke box (revoked)": revoked(),
      Withdraw: grey("a maintainer decides"),
      "Withdraw (nothing standing)": grey("a maintainer decides"),
    });
    // Live, the control is the served one with its own title: the owner's Token and request link untouched by the gate.
    expect(d.nodes["#share-btn"].innerHTML).toContain('<button type="button" class="btn ghost" id="token-open" title="a token for scripts and CI">Token</button>');
    expect(d.nodes["#pk-request"].outerHTML).toBe('<a class="more-link" id="pk-request" href="/request">+ request one →</a>');
  });

  it("m1, a maintainer on alice's page: revoke, own only, remove, withdraw and the log are theirs; the workspace and sharing a worker stay alice's", async () => {
    expect(await everything("m1")).toEqual({
      Share: live,
      Token: grey("only alice mints their token — yours is on /user/m1"),
      "+ request one": grey("only alice requests here — yours is on /user/m1"),
      "Register worker": grey("only alice registers a worker here — yours is on /user/m1"),
      "Build all": grey("only alice builds here — yours is on /user/m1"),
      [`Build ${F.arch}`]: grey("only alice builds here — yours is on /user/m1"),
      "Build all (a build in flight)": grey("a build is in flight"),
      "Remove mine": live, "Remove ours": live,
      "Share w3": grey(WORKERS_WORD),
      "Own only w3": live, "Revoke w3": live, "log w3": live,
      "Share box (revoked)": revoked(), "Revoke box (revoked)": revoked(),
      Withdraw: live,
      "Withdraw (nothing standing)": grey("nothing standing to withdraw"),
    });
    // The row as m1 has it: the mode button grey with the owner's word, Revoke live with its own title; Withdraw live on the standing approval.
    expect(d.workerActs(w3)).toBe(`<button type="button" class="small-btn" data-mode="${F.communityWorker}" data-to="shared" disabled aria-disabled="true" title="${WORKERS_WORD}">Share</button> <button type="button" class="small-btn" data-revoke="${F.communityWorker}" title="revoke this worker's token">Revoke</button>`);
    expect(d.withdrawBtn(approval, true)).toBe(`<button type="button" class="small-btn" data-withdraw="${F.projectTask}" data-name="${F.factoryPkg} ${approval.version}" title="take the approval back: the package leaves every ring, another maintainer decides — the reason goes on the record">Withdraw</button>`);
  });

  it("the project's worker on m1's page: its mode is nobody's to set — the door's 409 in the title for every role — and Revoke is a maintainer's", async () => {
    const w1 = (await get("/api/v1/factory?limit=10", "")).json.workers.find((w: any) => w.id === F.worker);
    expect(w1.trust).toBe("project");
    for (const as of ["", "bob", "alice", "m1", "m2"] as Who[]) {
      await asRole(d, as, F.m1);
      const [mode, revoke] = controls(d.workerActs(w1));
      expect(mode, `${as || "nobody"}: mode`).toEqual(grey(as ? NO_MODE : SIGN_IN));
      expect(revoke, `${as || "nobody"}: revoke`).toEqual(as === "m1" || as === "m2" ? live : grey(as ? "only m1 or a maintainer revokes a worker here" : SIGN_IN));
    }
  });
});
