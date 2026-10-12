/**
 * A person's page, drawn: the page's own button makers and blocks
 * (src/pages/user.ts — renderTop, renderRegister, buildBtn, removeBtn,
 * workerActs, withdrawBtn, pkgBlock, archLine, drawPackages, poolCap) and
 * the shell's log icon run over the fixture for every role, from the same
 * two answers the browser has — /auth/me for who is looking and GET
 * /users/alice/can for what they may do here. The rule it proves is the
 * dashboard's first: every viewer gets every control, the same for all, and
 * the one who may not press one gets it disabled, grey, with the server's
 * reason in its title — never hidden, never a sentence in its place. Since
 * #412 the package is the unit: a block per registration with a line per
 * architecture and its Build, drawn without opening anything, the story
 * and the builds folded under it behind one control; a worker's row has
 * Drain beside Revoke; a host's row the way to its page's pool cap. One
 * exception, the last block below (#331, #346): where a maintainer's machine
 * goes — a host — is drawn for a maintainer on their own page only, and no
 * worker form for anyone (no legacy registration is made any more);
 * everyone else keeps the served line that their packages build on the
 * pool's hosts. The
 * script is the served page's, run as a browser would (runScript in
 * test/fixture.ts); the build page's Decision cell is decision-cell.test.ts.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { POOL_HOSTS } from "../src/routes/contributors";
import { KIT_SHEET_PATH } from "../src/pages/kit";
import { legacyWorker, runScript, scriptOf, seedDashboard, type Fixture } from "./fixture";

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
  nodes: Record<string, { innerHTML: string; outerHTML: string; hidden?: boolean }>;
  setCAN(c: unknown): void;
  setWHO(w: unknown): void;
  setPKGS(p: unknown): void;
  setBUILDS(b: unknown): void;
  setOPEN(o: unknown): void;
  setSTORIES(s: unknown): void;
  identity(me: unknown): unknown;
  renderTop(): void;
  renderRegister(): void;
  renderPoolLine(role: string): void;
  buildBtn(name: string, arch: string | null, stopped: string | null, title: string): string;
  removeBtn(name: string): string;
  workerActs(w: unknown): string;
  withdrawBtn(a: unknown, standing: boolean): string;
  wtLog(w: unknown): string;
  pkgBlock(p: unknown): string;
  archLine(p: unknown, arch: string, registered: string[]): string;
  drawPackages(): void;
  poolCap(h: unknown): string;
}

/** The served page's script, run once, with the page's button makers, its blocks and the shell's log icon reachable. */
async function drawn(login = F.owner): Promise<Drawn> {
  const page = await get(`/user/${login}`, "");
  expect(page.status).toBe(200);
  return runScript(scriptOf(page.text), {
    pathname: `/user/${login}`,
    functions: ["identity", "renderTop", "renderRegister", "renderPoolLine", "buildBtn", "removeBtn", "workerActs", "withdrawBtn", "wtLog", "pkgBlock", "archLine", "drawPackages", "poolCap"],
    variables: ["CAN", "WHO", "PKGS", "BUILDS", "OPEN", "STORIES"],
  }) as Drawn;
}

/** Every button and link in a piece of HTML, in order: its text, whether it is grey, its title, where it goes. */
function controls(html: string): { text: string; grey: boolean; title: string | null; href: string | null }[] {
  return [...html.matchAll(/<(button|a)\b([^>]*)>([^<]*(?:<svg[\s\S]*?<\/svg>)?)<\/\1>/g)].map((m) => ({
    text: m[3].replace(/<svg[\s\S]*?<\/svg>/, "").trim() || (/aria-label="([^"]*)"/.exec(m[3]) ?? [null, "?"])[1]!,
    grey: m[1] === "button" ? /\sdisabled\b/.test(m[2]) && /aria-disabled="true"/.test(m[2]) : /class="disabled\b/.test(m[2]) && /aria-disabled="true"/.test(m[2]),
    title: (/title="([^"]*)"/.exec(m[2]) ?? [null, null])[1],
    href: (/\shref="([^"]*)"/.exec(m[2]) ?? [null, null])[1],
  }));
}
/** The one control of a piece of HTML whose text is `text`. */
function control(html: string, text: string) {
  const c = controls(html).filter((x) => x.text === text);
  expect(c, `${text} in ${html.slice(0, 160)}`).toHaveLength(1);
  return c[0];
}

/** The page as `as` has it: who is looking (the shell's /auth/me) and the caller's rights on `login`'s page (GET /users/<login>/can). */
async function asRole(d: Drawn, as: Who, login = F.owner) {
  const me = await get("/auth/me", as);
  d.setWHO(d.identity(me.status === 200 ? me.json : null));
  const can = await get(`/api/v1/users/${login}/can`, as);
  expect(can.status).toBe(200);
  d.setCAN(can.json.can);
}

/** The profile as the page reads it: alice's registrations and her last fifty builds, past the edge's copy. */
async function profile(login = F.owner) {
  const p = await get(`/api/v1/users/${login}?t=${Date.now()}`, "");
  expect(p.status).toBe(200);
  return p.json;
}

const SIGN_IN = "sign in with GitHub";
const LOG_WORD = "the worker's log is its owner's and the maintainers' to read";
const ORDERS_BY = "only alice or a maintainer gives it orders";

describe("a person's page draws every control for every viewer, grey with the server's reason where the viewer may not press it", () => {
  let d: Drawn;
  let laptop: any;
  let gone: any;
  let approval: any;
  beforeAll(async () => {
    d = await drawn();
    // alice's own registration from before #331 (it claims nothing since #343): its row as the listing serves it.
    laptop = (await get("/api/v1/factory?limit=50", "")).json.workers.find((w: any) => w.id === F.ownerWorker);
    expect(laptop.owner).toBe(F.owner);
    // A worker alice registered before #331 and revoked: its row stays on her page, its buttons grey with the state's word for everyone.
    const box = await legacyWorker(env, "alice", "box", F.arch);
    expect((await call("DELETE", `/api/v1/factory/workers/${box}`, "alice")).status).toBe(200);
    gone = { ...laptop, id: box, revoked_at: "2026-09-17T00:00:00Z" };
    // The one standing approval of the fixture: m2's, of the project's build of alice's package, on m2's page.
    approval = (await get(`/api/v1/users/${F.m2}`, "")).json.approvals.find((a: any) => a.task_id === F.projectTask);
    expect(approval.decision).toBe("approved");
  });

  /** Everything the page draws for one viewer, as text: control → [grey, title]. */
  async function everything(as: Who) {
    await asRole(d, as);
    d.renderTop(); d.renderRegister();
    const one = (html: string) => { const c = controls(html); expect(c).toHaveLength(1); return c[0]; };
    // A worker's row (#412): Drain, Revoke, then the way to its page's Operate.
    const [drain, revoke, operate] = controls(d.workerActs(laptop));
    const [drainGone, revokeGone] = controls(d.workerActs(gone));
    return {
      Share: one(d.nodes["#share-btn"].innerHTML.split("</button>")[0] + "</button>"),
      Token: one(d.nodes["#share-btn"].innerHTML.split("</button>")[1] + "</button>"),
      "+ request one": one(d.nodes["#pk-request"].outerHTML),
      "Build all": one(d.buildBtn(F.factoryPkg, null, null, "every architecture the request names")),
      [`Build ${F.arch}`]: one(d.buildBtn(F.factoryPkg, F.arch, null, "this architecture only")),
      "Build all (a build in flight)": one(d.buildBtn(F.factoryPkg, null, "a build is in flight", "every architecture the request names")),
      "Remove mine": one(d.removeBtn(F.factoryPkg)),
      "Remove ours": one(d.removeBtn(F.publishedPkg)),
      "Drain laptop": drain,
      "Revoke laptop": revoke,
      "Operate laptop": operate,
      "log laptop": one(d.wtLog(laptop)),
      "Drain box (revoked)": drainGone,
      "Revoke box (revoked)": revokeGone,
      Withdraw: one(d.withdrawBtn(approval, true)),
      "Withdraw (nothing standing)": one(d.withdrawBtn({ ...approval, withdrawn_at: "2026-09-17T00:00:00Z" }, false)),
    };
  }
  const grey = (title: string) => expect.objectContaining({ grey: true, title });
  const live = expect.objectContaining({ grey: false });
  const revoked = () => grey(`${gone.id} is revoked already`);
  // The way to a worker's page is a link, live for everyone: the page is public, and its own buttons say who may press them.
  const operate = () => expect.objectContaining({ grey: false, text: "Operate →", href: `/worker/${F.ownerWorker}#wk-operate` });

  it("nobody signed in: every control, all grey, each titled with the sign-in — the state's reason first where there is one; Share and the way to a worker's page alone are live, the pages being public", async () => {
    const e = await everything("");
    for (const [name, c] of Object.entries(e)) expect(c, name).toEqual(name === "Share" ? live : name === "Operate laptop" ? operate() : grey(name === "Build all (a build in flight)" ? "a build is in flight" : SIGN_IN));
    expect(d.nodes["#share-btn"].innerHTML).toBe('<button type="button" class="op-btn" id="share-open" title="the link to this page, to post anywhere">Share</button> <button type="button" class="op-btn" id="token-open" disabled aria-disabled="true" title="sign in with GitHub">Token</button>');
    expect(d.nodes["#pk-request"].outerHTML).toBe('<a class="disabled more-link" id="pk-request" data-href="/factory#request" tabindex="-1" aria-disabled="true" title="sign in with GitHub">+ request one →</a>');
  });

  it("bob, a contributor who owns nothing: the same controls, grey with whose they are — and, for what is his on his own page, where that is", async () => {
    expect(await everything("bob")).toEqual({
      Share: live,
      Token: grey("only alice mints their token — yours is on /user/bob"),
      "+ request one": grey("only alice requests here — yours is on /user/bob"),
      "Build all": grey("only alice builds here — yours is on /user/bob"),
      [`Build ${F.arch}`]: grey("only alice builds here — yours is on /user/bob"),
      "Build all (a build in flight)": grey("a build is in flight"),
      "Remove mine": grey("only alice removes it, or a maintainer"),
      "Remove ours": grey("only alice removes it, or a maintainer"),
      "Drain laptop": grey(ORDERS_BY),
      "Revoke laptop": grey("only alice or a maintainer revokes a worker here"),
      "Operate laptop": operate(),
      "log laptop": grey(LOG_WORD),
      "Drain box (revoked)": revoked(),
      "Revoke box (revoked)": revoked(),
      Withdraw: grey("a maintainer decides"),
      "Withdraw (nothing standing)": grey("a maintainer decides"),
    });
  });

  it("alice, the owner: her workspace live — but Remove on an approved or published package is a maintainer's, Withdraw a maintainer's, and her revoked worker is gone", async () => {
    expect(await everything("alice")).toEqual({
      Share: live, Token: live, "+ request one": live,
      "Build all": live, [`Build ${F.arch}`]: live,
      "Build all (a build in flight)": grey("a build is in flight"),
      "Remove mine": grey("mine is approved: a maintainer removes it"),
      "Remove ours": grey("ours is published: a maintainer removes it"),
      "Drain laptop": live, "Revoke laptop": live, "Operate laptop": operate(), "log laptop": live,
      "Drain box (revoked)": revoked(),
      "Revoke box (revoked)": revoked(),
      Withdraw: grey("a maintainer decides"),
      "Withdraw (nothing standing)": grey("a maintainer decides"),
    });
    // Live, the control is the served one with its own title: the owner's Token and request link untouched by the gate.
    expect(d.nodes["#share-btn"].innerHTML).toContain('<button type="button" class="op-btn" id="token-open" title="a token for scripts and CI">Token</button>');
    expect(d.nodes["#pk-request"].outerHTML).toBe('<a class="more-link" id="pk-request" href="/factory#request">+ request one →</a>');
  });

  it("m1, a maintainer on alice's page: drain, revoke, remove, withdraw and the log are theirs; the workspace stays alice's", async () => {
    expect(await everything("m1")).toEqual({
      Share: live,
      Token: grey("only alice mints their token — yours is on /user/m1"),
      "+ request one": grey("only alice requests here — yours is on /user/m1"),
      "Build all": grey("only alice builds here — yours is on /user/m1"),
      [`Build ${F.arch}`]: grey("only alice builds here — yours is on /user/m1"),
      "Build all (a build in flight)": grey("a build is in flight"),
      "Remove mine": live, "Remove ours": live,
      "Drain laptop": live, "Revoke laptop": live, "Operate laptop": operate(), "log laptop": live,
      "Drain box (revoked)": revoked(),
      "Revoke box (revoked)": revoked(),
      Withdraw: live,
      "Withdraw (nothing standing)": grey("nothing standing to withdraw"),
    });
    // The row as m1 has it: Drain and Revoke live with their own titles, the way to its page's Operate, no mode button (#343); Withdraw live on the standing approval.
    expect(d.workerActs(laptop)).toBe(`<button type="button" class="small-btn" data-worker-order="drain" data-worker="${F.ownerWorker}" title="hand it nothing from its next claim: a task in hand runs to its end">Drain</button> <button type="button" class="small-btn" data-revoke="${F.ownerWorker}" title="revoke this worker's token">Revoke</button> <a class="small-btn" href="/worker/${F.ownerWorker}#wk-operate" title="its page: Re-check agent, Restart, Update, Stop its task">Operate →</a>`);
    expect(d.withdrawBtn(approval, true)).toBe(`<button type="button" class="small-btn" data-withdraw="${F.projectTask}" data-name="${F.factoryPkg} ${approval.version}" title="take the approval back: the package leaves every ring, another maintainer decides — the reason goes on the record">Withdraw</button>`);
  });

  it("the project's worker on m1's page: Drain and Revoke are a maintainer's, and no mode button for any role (#343)", async () => {
    const w1 = (await get("/api/v1/factory?limit=10", "")).json.workers.find((w: any) => w.id === F.worker);
    expect(w1.trust).toBe("project");
    for (const as of ["", "bob", "alice", "m1", "m2"] as Who[]) {
      await asRole(d, as, F.m1);
      const acts = controls(d.workerActs(w1));
      expect(acts.map((a) => a.text), `${as || "nobody"}: Drain, Revoke and the way to its page`).toEqual(["Drain", "Revoke", "Operate →"]);
      const [drain, revoke] = acts;
      expect(revoke, `${as || "nobody"}: revoke`).toEqual(as === "m1" || as === "m2" ? live : grey(as ? "only m1 or a maintainer revokes a worker here" : SIGN_IN));
      expect(drain, `${as || "nobody"}: drain`).toEqual(as === "m1" || as === "m2" ? live : grey(as ? "only m1 or a maintainer gives it orders" : SIGN_IN));
    }
  });
});

describe("a worker's row: Drain beside Revoke, and the way to its page (#412)", () => {
  let d: Drawn;
  beforeAll(async () => { d = await drawn(); });

  it("a drained worker's row offers Resume, grey with the worker orders' word on who lifts it; a host's registration leads to its host's page", async () => {
    const laptop = (await get("/api/v1/factory?limit=50", "")).json.workers.find((w: any) => w.id === F.ownerWorker);
    const drained = { ...laptop, drained: { at: "2026-10-12T10:00:00.000Z", by: "m1", reason: "a disk to replace" } };
    // The row's rights as /can says them for a drained worker (users-can.test.ts drains one at the door and reads them back).
    await asRole(d, "m1");
    d.setCAN({ why: {}, packages: {}, workers: { [F.ownerWorker]: { revoke: true, drain: false, resume: true, why: { drain: "drained already (by m1, 10:00 UTC: a disk to replace) — Resume ends it" } } } });
    expect(control(d.workerActs(drained), "Resume")).toEqual(expect.objectContaining({ grey: false, title: "hand it work again from its next claim" }));
    expect(d.workerActs(drained)).toContain(`data-worker-order="resume" data-worker="${F.ownerWorker}"`);
    expect(controls(d.workerActs(drained)).map((c) => c.text)).toEqual(["Resume", "Revoke", "Operate →"]);
    d.setCAN({ why: {}, packages: {}, workers: { [F.ownerWorker]: { revoke: false, drain: false, resume: false, why: { revoke: "x", drain: "x", resume: "m1 drained it: alice or m1 resumes it" } } } });
    expect(control(d.workerActs(drained), "Resume")).toEqual(expect.objectContaining({ grey: true, title: "m1 drained it: alice or m1 resumes it" }));
    // A host's registration: its operations are its host's page's Stop it card (Suspend, Resume, Retire, Drain), not a worker's; the pool cap is the hosts table's own cell.
    const reg = { ...laptop, kind: "host", host_id: F.host };
    expect(control(d.workerActs(reg), "Operate →")).toEqual(expect.objectContaining({ grey: false, href: `/hosts/${F.host}#hp-operate`, title: "its host's page: Suspend, Resume, Retire, Drain" }));
  });

  it("after a Drain, the row is drawn again with the rights that come back, whichever of the two reads lands first", async () => {
    const laptop = (await get("/api/v1/factory?limit=50", "")).json.workers.find((w: any) => w.id === F.ownerWorker);
    const drained = { ...laptop, drained: { at: "2026-10-12T10:00:00.000Z", by: "m1", reason: "a disk to replace" } };
    // The page as a browser runs it, whose /can answers only once the test says what it holds; /auth/me and the rest never answer, so nothing but the test draws.
    let rights: unknown = null;
    const page = await get(`/user/${F.owner}`, "");
    const r = runScript(scriptOf(page.text), {
      pathname: `/user/${F.owner}`,
      functions: ["identity", "loadCan", "renderWorkers"],
      variables: ["CAN", "WHO", "FACTORY"],
      fetch: (p: string) => (p.endsWith("/can") && rights ? Promise.resolve(Response.json({ login: F.owner, can: rights })) : new Promise<Response>(() => {})),
    }) as any;
    r.setWHO(r.identity((await get("/auth/me", "m1")).json));
    const rows = () => ["community", "review", "project"].map((k) => r.nodes[`#w-${k} tbody`]?.innerHTML ?? "").join("");
    // The listing landed first: the worker drained, its row drawn with the rights from before the Drain — Resume grey.
    r.setFACTORY({ workers: [drained] });
    r.setCAN({ why: {}, packages: {}, workers: { [F.ownerWorker]: { revoke: true, drain: true, resume: false, why: { resume: "it is not drained: there is nothing to resume" } } } });
    r.renderWorkers();
    expect(control(rows(), "Resume")).toEqual(expect.objectContaining({ grey: true, title: "it is not drained: there is nothing to resume" }));
    // Then /can, with the rights the Drain left: the row is drawn again with them, without waiting for the next tick.
    rights = { why: {}, packages: {}, workers: { [F.ownerWorker]: { revoke: true, drain: false, resume: true, why: { drain: "drained already (by m1, 10:00 UTC: a disk to replace) — Resume ends it" } } } };
    await r.loadCan();
    expect(control(rows(), "Resume")).toEqual(expect.objectContaining({ grey: false, title: "hand it work again from its next claim" }));
    // The same rights again (the minute's read): the tables are not drawn again.
    for (const k of ["community", "review", "project"]) if (r.nodes[`#w-${k} tbody`]) r.nodes[`#w-${k} tbody`].innerHTML = "kept";
    await r.loadCan();
    expect(rows()).not.toContain("Resume");
  });
});

describe("a package is one block with its architectures inside (#412)", () => {
  let d: Drawn;
  let P: any;
  const block = (name: string) => d.pkgBlock(P.packages.find((p: any) => p.name === name));
  const lines = (html: string) => html.split('<div class="up-arch">').slice(1);
  beforeAll(async () => {
    d = await drawn();
    P = await profile();
    d.setPKGS(P.packages); d.setBUILDS(P.builds); d.setOPEN({}); d.setSTORIES({});
  });

  it("a line per architecture — where it stands, its latest build, the gate on it — with its Build at the line's end, and Build all and Remove on the head: all drawn without opening anything", async () => {
    await asRole(d, "alice");
    const mine = P.packages.find((p: any) => p.name === F.factoryPkg);
    const html = block(F.factoryPkg);
    expect(html).toContain(`<article class="up-pkg" data-pkg="${F.factoryPkg}">`);
    expect(html).toContain(`<a class="up-name" href="/package/${F.factoryPkg}?ring=stable&arch=${F.arch}">${F.factoryPkg}</a>`);
    // The architectures its request names, each a line; nothing folded open yet.
    const ls = lines(html);
    expect(ls).toHaveLength(JSON.parse(mine.arches).length);
    const x = ls[0];
    expect(x).toContain(`<b>${F.arch}</b>`);
    const newest = P.builds.find((b: any) => b.name === F.factoryPkg && b.arch === F.arch);
    expect(x).toContain(`<a href="/build/${newest.id}" title="the build, whole">#${newest.id}</a>`);
    // The target's word and its square, the server's (targets.ts).
    const t = mine.targets[F.arch];
    expect(x).toContain('<span class="op-arch ');
    expect(x).toContain(`>${t.status.replace("_", " ")}</span>`);
    // Its Build is on the line, live for alice; Build all and Remove on the head.
    expect(control(x, `Build ${F.arch}`).grey).toBe(false);
    expect(control(html, "Build all").grey).toBe(false);
    expect(control(html, "Remove")).toEqual(expect.objectContaining({ grey: true, title: `${F.factoryPkg} is approved: a maintainer removes it` }));
    // One control opens it, closed for now: its story and its builds are not drawn.
    expect(html).toContain(`<button type="button" class="up-more" data-expand="${F.factoryPkg}" aria-expanded="false">▸ The story · `);
    expect(html).not.toContain('class="up-open"');
    expect(html).not.toContain("<table");
  });

  it("bob and nobody see the same block and the same Build, grey with whose it is", async () => {
    await asRole(d, "bob");
    const x = lines(block(F.factoryPkg))[0];
    expect(control(x, `Build ${F.arch}`)).toEqual(expect.objectContaining({ grey: true, title: "only alice builds here — yours is on /user/bob" }));
    await asRole(d, "");
    expect(control(block(F.factoryPkg), "Build all")).toEqual(expect.objectContaining({ grey: true, title: SIGN_IN }));
  });

  it("opened, its builds are folded under it — the number, the version linking the package on the build's ring and architecture, the evidence — and its story with each architecture's score and audit", async () => {
    await asRole(d, "alice");
    d.setOPEN({ [F.factoryPkg]: true });
    let html = block(F.factoryPkg);
    expect(html).toContain('aria-expanded="true">▾ The story · ');
    expect(html).toContain('<p class="up-note">loading the story…</p>');
    const mine = P.builds.filter((b: any) => b.name === F.factoryPkg);
    expect(html.match(/<tr><td><a href="\/build\//g)).toHaveLength(mine.length);
    expect(html).toContain(`<tr><td><a href="/build/${F.contributorTask}" title="the build, whole">${F.contributorTask}</a></td>`);
    expect(html).toContain(`href="/build/${F.contributorTask}#evidence"`);
    expect(html).not.toContain("/artifacts/");
    // The story read: its request, a panel per architecture with the two halves of the score — and the line gains the class and the audit.
    const st = (await get(`/api/v1/factory/packages/${F.factoryPkg}/story`, "")).json;
    d.setSTORIES({ [F.factoryPkg]: st });
    html = block(F.factoryPkg);
    expect(html).toContain('<div class="pkreq');
    expect(html).toContain('<section class="pkarch">');
    expect(html).toContain("The contributor's half");
    expect(lines(html)[0]).toMatch(/class [A-D] · \d+\/100/);
    // The fixture's newest build of it has no audit yet (its chain's audit is not queued): the line says so, as its panel's checklist does.
    expect(lines(html)[0]).toContain('<span class="pill none">no audit yet</span>');
    // Its buttons stay the block's: the story under it builds and removes nothing.
    const open = html.slice(html.indexOf('<div class="up-open">'));
    expect(open).not.toContain("data-build=");
    expect(open).not.toContain("data-remove=");
    d.setOPEN({}); d.setSTORIES({});
  });

  it("a Build is grey by the line's state first — a build running, the package blocked, an architecture the request no longer names — and a queued build's Build says it moves or takes it out", async () => {
    await asRole(d, "alice");
    const reg = [F.arch];
    const p = { name: F.factoryPkg, arches: JSON.stringify(reg), status: "waiting", targets: { [F.arch]: { status: "reviewing", task: 9001 } } };
    d.setBUILDS([{ id: 9001, name: F.factoryPkg, arch: F.arch, status: "queued", trust: "project", created_at: new Date().toISOString() }]);
    expect(control(d.archLine(p, F.arch, reg), `Build ${F.arch}`)).toEqual(expect.objectContaining({ grey: true, title: "a build is running" }));
    expect(control(d.pkgBlock(p), "Build all")).toEqual(expect.objectContaining({ grey: true, title: "a build is in flight" }));
    // Blocked: the door's words, for the line and the head.
    const blocked = { ...p, targets: {}, blocked_at: "2026-10-12T10:00:00Z", blocked_reason: "a fork, not the upstream" };
    d.setBUILDS([]);
    const why = `${F.factoryPkg} is blocked by a maintainer: a fork, not the upstream`;
    expect(control(d.archLine(blocked, F.arch, reg), `Build ${F.arch}`)).toEqual(expect.objectContaining({ grey: true, title: why }));
    expect(control(d.pkgBlock(blocked), "Build all")).toEqual(expect.objectContaining({ grey: true, title: why }));
    expect(d.pkgBlock(blocked)).toContain(`<span class="pill error" title="${why}">blocked</span>`);
    // An architecture its request dropped keeps its line and its builds; its Build is grey with what the door answers.
    d.setBUILDS([{ id: 9002, name: F.factoryPkg, arch: "aarch64", status: "failed", trust: "community", created_at: new Date().toISOString() }]);
    const dropped = { ...p, targets: {} };
    expect(lines(d.pkgBlock(dropped)).map((l) => /<b>([^<]+)<\/b>/.exec(l)![1])).toEqual([F.arch, "aarch64"]);
    expect(control(d.archLine(dropped, "aarch64", reg), "Build aarch64")).toEqual(expect.objectContaining({ grey: true, title: `arches must name one the request has: ${F.arch}` }));
    // A contributor's build waiting in the queue: Build stays live, and its title says what it does then.
    d.setBUILDS([{ id: 9003, name: F.factoryPkg, arch: F.arch, status: "queued", trust: "community", queue: { position: 2, total: 5 }, created_at: new Date().toISOString() }]);
    const queued = d.archLine({ ...p, targets: { [F.arch]: { status: "building", task: 9003 } } }, F.arch, reg);
    expect(control(queued, `Build ${F.arch}`)).toEqual(expect.objectContaining({ grey: false, title: "name a worker, or take it out of the queue" }));
    expect(queued).toContain(`<span class="when" title="in the queue for ${F.arch}">2 of 5</span>`);
    // The gate on a staged build, in its words.
    d.setBUILDS([{ id: 9004, name: F.factoryPkg, arch: F.arch, status: "staged", trust: "community", gate: "pass", gate_warnings: 2, created_at: new Date().toISOString() }]);
    expect(d.archLine({ ...p, targets: { [F.arch]: { status: "built", task: 9004 } } }, F.arch, reg)).toContain(">gate 2 warnings</span>");
    d.setBUILDS(P.builds);
  });

  it("the builds of a name no longer registered here keep a block of their own, folded, and nothing is a flat list of builds", async () => {
    await asRole(d, "alice");
    d.setBUILDS([...P.builds, { id: 9100, name: "removed-one", arch: F.arch, version: "1.0-1", status: "failed", trust: "community", reason: "contributor", created_at: new Date().toISOString() }]);
    d.drawPackages();
    const html = d.nodes["#packages"].innerHTML;
    expect(html.match(/<article class="up-pkg" data-pkg="/g)).toHaveLength(P.packages.length + 1);
    expect(html).toContain('<article class="up-pkg" data-pkg="*"><div class="up-pkg-h"><span class="up-name">Other names</span></div>');
    expect(html).toContain('data-expand="*" aria-expanded="false">▸ Their builds · 1 build</button>');
    d.setOPEN({ "*": true }); d.drawPackages();
    expect(d.nodes["#packages"].innerHTML).toContain('<b>removed-one</b> <span class="mono">1.0-1</span>');
    d.setOPEN({}); d.setBUILDS(P.builds);
    // Served: no table of builds of its own, and the packages card with its blocks' place.
    const served = (await get(`/user/${F.owner}`, "")).text.replace(/<script\b[\s\S]*?<\/script>/g, "");
    expect(served).not.toContain('id="builds"');
    expect(served).toContain('<div class="up-pkgs" id="packages">');
  });
});

describe("a host's row leads to its page, where its pool cap is set (#412)", () => {
  it("the cap as the listing says it to its owner and the maintainers, the way there for anyone else", async () => {
    const d = await drawn(F.m1);
    const cell = (h: unknown) => controls(d.poolCap(h))[0];
    expect(cell({ id: F.host, pool_cap_units: 4 })).toEqual(expect.objectContaining({ text: "4 units →", href: `/hosts/${F.host}#hp-facts`, grey: false }));
    expect(cell({ id: F.host, pool_cap_units: 1 }).text).toBe("1 unit →");
    expect(cell({ id: F.host, pool_cap_units: null }).text).toBe("none →");
    expect(cell({ id: F.host }).text).toBe("set →");
    // The listing: its owner and the maintainers read the cap, anyone else does not.
    expect((await get(`/api/v1/hosts?owner=${F.m1}`, "m2")).json.hosts[0]).toHaveProperty("pool_cap_units");
    expect((await get(`/api/v1/hosts?owner=${F.m1}`, "")).json.hosts[0]).not.toHaveProperty("pool_cap_units");
    expect((await get(`/user/${F.m1}`, "")).text).toContain("<th>Pool cap</th>");
  });
});

describe("the page is drawn with the v1 kit (#412), as the redesigned pages are", () => {
  it("links the kit's sheet, and serves its head, its numbers and its cards", async () => {
    const html = (await get(`/user/${F.owner}`, "")).text;
    expect(/<head>([\s\S]*?)<\/head>/.exec(html)![1]).toContain(`<link rel="stylesheet" href="${KIT_SHEET_PATH}">`);
    for (const piece of ['<div class="up">', '<section class="up-head" aria-labelledby="title">', '<h1 class="op-hero" id="title">', '<div class="op-stats" id="tiles">', '<section class="op-card" id="packages-section" aria-labelledby="packages-h">', '<section class="op-card" id="record-section" aria-labelledby="record-h">']) expect(html).toContain(piece);
  });
});

describe("the workers are the maintainers' hosts (#331, #346): no worker form for anyone; a maintainer on their own page reads that their machine joins as a host; everyone else reads that their packages build on the pool's hosts", () => {
  const LINE = `Nothing to run here: ${POOL_HOSTS}, which the maintainers provide.`;

  it("served: the line and the way to the packaging docs, for everyone — no form, no toggle, no \"Run a worker\" in the page itself", async () => {
    for (const login of [F.owner, F.m1]) {
      const served = (await get(`/user/${login}`, "")).text;
      const html = served.replace(/<script\b[\s\S]*?<\/script>/g, "");
      expect(html, login).toContain('<div id="w-own"><p class="sub" id="w-pool"');
      expect(html, login).toContain(LINE);
      expect(html, login).toContain('<a href="/docs/factory#contribute-a-package">How packaging works →</a>');
      expect(html, login).toContain('<span id="w-slot"></span>');
      for (const absent of ['id="worker-form"', 'id="w-toggle"', 'id="w-name"', 'href="/docs/workers">Run a worker']) expect(html, `${login}: ${absent}`).not.toContain(absent);
    }
  });

  /** What the worker section holds once the page has drawn for `as` on `login`'s page: the slot beside the heading, the block under it, the form. */
  async function section(as: Who, login = F.owner) {
    const d = await drawn(login);
    await asRole(d, as, login);
    d.renderRegister();
    return { slot: d.nodes["#w-slot"]?.innerHTML ?? "", own: d.nodes["#w-own"]?.innerHTML ?? "", form: d.nodes["#worker-form"]?.innerHTML ?? "" };
  }

  it("nobody, bob, alice (whose page it is): nothing drawn over the served line — no form, no toggle, no \"Run a worker\"", async () => {
    for (const as of ["", "bob", "alice"] as Who[]) expect(await section(as), as || "nobody").toEqual({ slot: "", own: "", form: "" });
    // alice on bob's page, and bob on his own: the same.
    expect(await section("alice", F.contributor)).toEqual({ slot: "", own: "", form: "" });
    expect(await section("bob", F.contributor)).toEqual({ slot: "", own: "", form: "" });
  });

  it("a maintainer: where their machine goes — a host — and that no legacy registration is made any more, on their own page only; no toggle, no form", async () => {
    const own = await section("m1", F.m1);
    expect(own.slot).toBe("");
    expect(own.form).toBe("");
    expect(own.own).toContain("Maintainers only");
    expect(own.own).toContain("The legacy registrations from before hosts retired with P3 (#346)");
    expect(own.own).toContain('<a href="/docs/worker-host#maintainer-hosts">How a host joins →</a>');
    for (const absent of ['id="worker-form"', 'id="w-toggle"', "Register worker", 'href="/docs/workers">Run a worker']) expect(own.own + own.slot, absent).not.toContain(absent);
    // A contributor's page and another maintainer's: the served line stays, nothing is drawn over it — no form greyed with a reason that is not alice's.
    expect(await section("m1", F.owner)).toEqual({ slot: "", own: "", form: "" });
    expect(await section("m1", F.m2)).toEqual({ slot: "", own: "", form: "" });
  });

  it("the served line is hidden on a maintainer's page, whose section lists the hosts they provide, and kept on a contributor's", async () => {
    for (const [role, hidden] of [["maintainer", true], ["contributor", false]] as const) {
      const d = await drawn(role === "maintainer" ? F.m1 : F.owner);
      d.renderPoolLine(role);
      expect((d.nodes["#w-pool"] as unknown as { hidden: boolean }).hidden, role).toBe(hidden);
    }
  });
});
