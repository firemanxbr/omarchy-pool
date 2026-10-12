/**
 * The package's approval on the pages (#416): Review's workspace and the
 * package's own page offer Approve package — every architecture the request
 * names, one decision — and Approve <arch> only, per architecture, with the
 * reason the others do not ship; every viewer gets the same buttons, grey
 * with the server's reason where they may not press one, never hidden. The
 * scripts run as the pages run them (runScript in test/fixture.ts) over the
 * Worker's own answers, as the role's browser reads them; the decision is
 * posted by the page with the maintainer's passkey (soft-authenticator.mjs)
 * for exactly that act, and the record and the package's page then say what
 * it shipped: "approved for x86_64 and aarch64", or "approved for x86_64
 * only: <reason>", the other architecture "not shipping".
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/routes/contributors";
import { HELPERS } from "../src/pages/layout";
import { runScript, scriptOf } from "./fixture";
import { assert as answer, b64url, createAuthenticator, register, unb64url } from "./soft-authenticator.mjs";

/** The dashboard where a passkey works (relyingParty): localhost, as wrangler dev's. */
const WEB = "http://localhost:8787";
const checklist = { official: true, license: true, unshipped: true, evidence: true };
type Authenticator = Awaited<ReturnType<typeof createAuthenticator>>;
type Answer = { status: number; json: any };

async function raw(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Answer> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(WEB + path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}
const call = (method: string, path: string, body: unknown, token?: string) => raw(method, `/api/v1${path}`, { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body);
const asPage = (login: string, method: string, path: string, body?: unknown) => raw(method, path, { cookie: `omc=oms_${login}`, origin: WEB, "content-type": "application/json" }, body);
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 600 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok(), what).toBe(true);
};

// ---------- the builds: alice's requests for both architectures, built by m1's legacy pair, built again by m2's project workers ----------

async function claim(worker: string, arch: string, name: string) {
  const c = await call("POST", "/factory/claim", { arch, agent: "openai/gpt-5", agent_status: "ok", ...(worker.startsWith("omw_p") ? { kinds: ["build"] } : {}) }, worker);
  expect(c.status, `${worker} claims ${name}: ${JSON.stringify(c.json)}`).toBe(200);
  expect(c.json.task).toMatchObject({ name, arch });
  return c.json as { task: { id: number; name: string; arch: string }; token: string };
}
async function stage(c: { task: { id: number; name: string; arch: string }; token: string }) {
  const file = `${c.task.name}-1.0-1-${c.task.arch}.pkg.tar.zst`;
  for (const f of ["PKGBUILD", "build.log", "PKGINFO", file]) expect((await raw("PUT", `/api/v1/factory/tasks/${c.task.id}/artifacts/${f}`, { authorization: `Bearer ${c.token}` }, `${f} of ${c.task.id}`)).status).toBe(201);
  expect((await call("POST", `/factory/tasks/${c.task.id}/complete`, { sha256: "c".repeat(64), filename: file, version: "1.0-1" }, c.token)).json).toMatchObject({ status: "staged" });
  return c.task.id;
}
/** half: x86_64 built and built again by the project; aarch64 did not build. */
async function half(name: string): Promise<{ px: number; arm: number }> {
  expect((await call("POST", "/factory/packages", { name, url: `https://${name}.example`, source: `https://${name}.example/${name}-1.0.tar.gz`, version: "1.0", description: `${name}, built on one architecture`, license: "MIT", arches: ["x86_64", "aarch64"], checklist }, "omc_alice")).status).toBe(201);
  const x = await stage(await claim("omw_cx", "x86_64", name));
  const a = await claim("omw_ca", "aarch64", name);
  expect((await call("POST", `/factory/tasks/${a.task.id}/fail`, { error: "exit 4: no linker for aarch64", final: true }, a.token)).json).toMatchObject({ status: "failed" });
  expect((await call("POST", `/factory/tasks/${x}/build`, {}, "omc_m1")).status).toBe(200);
  return { px: await stage(await claim("omw_px", "x86_64", name)), arm: a.task.id };
}
/** both: each architecture built and built again by the project. */
async function both(name: string): Promise<{ rx: number; ra: number }> {
  expect((await call("POST", "/factory/packages", { name, url: `https://${name}.example`, source: `https://${name}.example/${name}-1.0.tar.gz`, version: "1.0", description: `${name}, built on both`, license: "MIT", arches: ["x86_64", "aarch64"], checklist }, "omc_alice")).status).toBe(201);
  const x = await stage(await claim("omw_cx", "x86_64", name));
  await stage(await claim("omw_ca", "aarch64", name));
  const asked = await call("POST", `/factory/tasks/${x}/build`, {}, "omc_m1");
  const [rx, ra] = asked.json.tasks as number[];
  expect(await stage(await claim("omw_px", "x86_64", name))).toBe(rx);
  expect(await stage(await claim("omw_pa", "aarch64", name))).toBe(ra);
  return { rx, ra };
}

// ---------- the pages, as a role's browser runs them ----------

/** A button as the page keeps it (the decisions are drawn once, then gated in place): its attributes, disabled or not. */
function button(attrs: Record<string, string>): any {
  const a: Record<string, string> = { ...attrs };
  return { disabled: true, focus() {}, setAttribute(k: string, v: unknown) { a[k] = String(v); }, getAttribute: (k: string) => (k in a ? a[k] : null), removeAttribute(k: string) { delete a[k]; }, hasAttribute: (k: string) => k in a, attrs: a };
}

/**
 * A served page's script for `login` (or nobody), its fetch the Worker with the session and the page's Origin, the software authenticator
 * `a` as navigator.credentials; `buttons` what the document's querySelectorAll finds for Review's decisions; `fresh`, the story and the
 * record read past the edge's thirty seconds, as a read a minute later would (they are cached by their address).
 */
async function pageAs(path: string, login: string | null, o: { a?: Authenticator; functions: string[]; variables?: string[]; buttons?: any[]; fresh?: boolean }) {
  const ctx = createExecutionContext();
  const html = await (await worker.fetch(new Request(WEB + path, { headers: login ? { cookie: `omc=oms_${login}` } : {} }), env, ctx)).text();
  await waitOnExecutionContext(ctx);
  const posted: { path: string; body: any }[] = [];
  const buf = (v: string) => unb64url(v).buffer;
  (globalThis as any).__approveNavigator = {
    credentials: {
      get: async (options: any) => {
        const k = options.publicKey, x = await answer(o.a!, { challenge: b64url(k.challenge), origin: WEB, rpId: k.rpId });
        return { rawId: buf(x.credential), response: { clientDataJSON: buf(x.client_data), authenticatorData: buf(x.authenticator_data), signature: buf(x.signature), userHandle: null } };
      },
    },
  };
  const browser = "window.PublicKeyCredential = function () {}; window.isSecureContext = true; var navigator = globalThis.__approveNavigator;";
  const code = scriptOf(html).trim().replace(/^\(function \(\) \{/, `(function () {${browser}`);
  const url = new URL(WEB + path);
  const ran = runScript(code, {
    pathname: url.pathname, search: url.search, functions: o.functions, variables: o.variables,
    querySelectorAll: (sel) => (sel === "#rv-btns [data-decide]" ? (o.buttons ?? []) : []),
    fetch: async (p: string, init?: RequestInit) => {
      if (init?.method === "POST") posted.push({ path: p, body: init.body ? JSON.parse(String(init.body)) : null });
      const { cache: _cache, ...rest } = init ?? {};
      if (o.fresh && /\/(story|approvals)(\?|$)/.test(p)) p += `${p.includes("?") ? "&" : "?"}after=${++READS}`;
      const c = createExecutionContext();
      const res = await worker.fetch(new Request(WEB + p, { ...rest, headers: { ...(rest.headers as Record<string, string>), ...(login ? { cookie: `omc=oms_${login}` } : {}), origin: WEB } }), env, c);
      await waitOnExecutionContext(c);
      return res;
    },
  });
  return { ran, nodes: ran.nodes, posted };
}

/** The shell's script, its placeholders filled as a page's are. */
const SHELL = HELPERS.split("__POOL_URL__").join("http://pool.test").split("__RINGS_TEXT__").join("{}").split("__WICON__").join("{}").split("__LATE_AFTER_HOURS__").join("9").split("__PROMISED_RINGS__").join("[]").split("__ARCHES__").join('["x86_64","aarch64"]').split("__SEVERITIES__").join("[]").split("__WORKER_ALIVE_MINUTES__").join("10");
/** The shell's drawing functions alone, as decision-cell.test.ts runs them. */
function shell(): any {
  return runScript(SHELL, { pathname: "/package/x", functions: ["approveCell", "approvedFor", "notShipping", "targetChips", "decidedText"] });
}
/** Every button of a drawn cell — of the decision's cell (.decide) where the html holds one — its label, its task, whether it is disabled and why. */
function buttons(html: string) {
  html = /<span class="decide"[^>]*>[\s\S]*?<\/span>/.exec(html)?.[0] ?? html;
  return [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map((m) => ({
    text: m[2],
    task: /data-(?:approve|only)="(\d+)"/.exec(m[1])?.[1] ?? null,
    disabled: /\sdisabled\b/.test(m[1]),
    title: /title="([^"]*)"/.exec(m[1])?.[1] ?? null,
  }));
}

const keys: Record<string, Authenticator> = {};
/** A read past the edge's cache gets an address of its own. */
let READS = 0;
let H: { px: number; arm: number }, B: { rx: number; ra: number };

beforeAll(async () => {
  const h = (t: string) => sha256Hex(t);
  const people: [string, string][] = [["m1", "maintainer"], ["m2", "maintainer"], ["alice", "contributor"], ["bob", "contributor"]];
  await env.DB.batch([
    env.DB.prepare("INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2')"),
    ...(await Promise.all(people.map(async ([l, role]) => env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role) VALUES (?, ?, ?, ?)").bind(l, await h(`omc_${l}`), await h(`oms_${l}`), role)))),
    env.DB.prepare(`INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES
      ('cx', 'x86_64', 'm1', ?, 'shared', 'community', NULL, '2000-01-01T00:00:00Z'),
      ('ca', 'aarch64', 'm1', ?, 'shared', 'community', NULL, '2000-01-01T00:00:00Z'),
      ('px', 'x86_64', 'm2', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z'),
      ('pa', 'aarch64', 'm2', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z')`).bind(await h("omw_cx"), await h("omw_ca"), await h("omw_px"), await h("omw_pa")),
  ]);
  // m2's passkey, registered on their page — the first, with the session alone.
  keys.m2 = await createAuthenticator();
  const o = await asPage("m2", "POST", "/auth/passkeys/challenge", {});
  expect((await asPage("m2", "POST", "/auth/passkeys", { label: "laptop", ...(await register(keys.m2, { challenge: o.json.publicKey.challenge, origin: WEB, rpId: "localhost" })) })).status).toBe(201);
  H = await half("onearch");
  B = await both("botharch");
});

describe("the shell's approveCell, approvedFor and the target's word", () => {
  it("draws Approve package and Approve <arch> only for every viewer: grey with the role's reason, the server's for a maintainer, live where its can says so", async () => {
    const s = shell();
    const canOf = async (task: number) => (await asPage("m2", "GET", `/api/v1/factory/tasks/${task}/can`)).json.can;
    // Nobody signed in, a contributor: the same three buttons, grey, the role's words — no can is read for them.
    for (const who of ["sign in with GitHub", "a maintainer decides"]) {
      const cell = s.approveCell({ name: "onearch", version: "1.0", arches: ["x86_64", "aarch64"], rows: { x86_64: { id: H.px, can: null } }, who });
      expect(buttons(cell)).toEqual([
        { text: "Approve package", task: String(H.px), disabled: true, title: who },
        { text: "Approve x86_64 only", task: String(H.px), disabled: true, title: who },
        { text: "Approve aarch64 only", task: null, disabled: true, title: who },
      ]);
    }
    // A maintainer: the package refused while aarch64 did not build — the server's reason — and x86_64 alone live; aarch64 has nothing of the project's to approve.
    const c = await canOf(H.px);
    const cell = s.approveCell({ name: "onearch", version: "1.0", arches: ["x86_64", "aarch64"], rows: { x86_64: { id: H.px, can: c } }, who: "" });
    expect(buttons(cell)).toEqual([
      { text: "Approve package", task: String(H.px), disabled: true, title: c.why.approve },
      { text: "Approve x86_64 only", task: String(H.px), disabled: false, title: null },
      { text: "Approve aarch64 only", task: null, disabled: true, title: "the project has no staged build of aarch64 to approve" },
    ]);
    expect(c.why.approve).toBe(`aarch64 did not build (task ${H.arm}): the package is approved once every architecture it names is built again by the project — or approve x86_64 only, with the reason aarch64 does not ship`);
    // The one-architecture button says what the others are, for its dialog.
    expect(cell).toContain(`data-only="${H.px}" data-arch="x86_64" data-others="aarch64"`);
    // Built on both: the package live, its dialog told each architecture's build; either one alone live too, posted on its own build. A row whose can is not read yet waits, saying so.
    const [cx, ca] = [await canOf(B.rx), await canOf(B.ra)];
    const full = s.approveCell({ name: "botharch", version: "1.0", arches: ["x86_64", "aarch64"], rows: { x86_64: { id: B.rx, can: cx }, aarch64: { id: B.ra, can: ca } }, who: "" });
    expect(buttons(full).map((b) => [b.text, b.task, b.disabled])).toEqual([["Approve package", String(B.rx), false], ["Approve x86_64 only", String(B.rx), false], ["Approve aarch64 only", String(B.ra), false]]);
    expect(full).toContain(`data-builds="x86_64 (build #${B.rx}) and aarch64 (build #${B.ra})"`);
    const reading = s.approveCell({ name: "botharch", arches: ["x86_64", "aarch64"], rows: { x86_64: { id: B.rx, can: null } }, who: "", why: "reading what you may do here…" });
    expect(buttons(reading).map((b) => b.title)).toEqual(["reading what you may do here…", "reading what you may do here…", "the project has no staged build of aarch64 to approve"]);
  });

  it("words what an approval shipped as the record does, an architecture set aside as not shipping, and the toast of one alone", () => {
    const s = shell();
    expect(s.approvedFor({ arches: ["x86_64", "aarch64"], only_reason: null })).toBe("approved for x86_64 and aarch64");
    expect(s.approvedFor({ arches: ["aarch64"], only_reason: "upstream ships no x86_64 build" })).toBe("approved for aarch64 only: upstream ships no x86_64 build");
    expect(s.approvedFor({ arch: "x86_64" })).toBe("approved for x86_64");
    expect(s.notShipping({ not_shipping: { x86_64: 4 } })).toEqual(["x86_64"]);
    const chips = s.targetChips({ x86_64: { status: "not_shipping", task: 4 }, aarch64: { status: "approved", task: 9 } });
    expect(chips).toContain('<span class="pill tgt none dashed" title="x86_64: set aside by an approval of another architecture alone; the reason is on the record (build #4)">x86_64 · not shipping</span>');
    expect(s.decidedText("only", { arches: ["aarch64"], only_reason: "upstream ships no x86_64 build", not_shipping: { x86_64: 4 }, publishes: { aarch64: 12 } })).toBe('Approved for aarch64 only — the project\'s build goes into edge (publish job <a href="/build/12">#12</a>); x86_64 does not ship.');
    expect(s.decidedText("approve", { arches: ["x86_64", "aarch64"], only_reason: null, not_shipping: {}, publishes: { x86_64: 12, aarch64: 13 } })).toBe('Approved — the project\'s builds go into edge (publish jobs <a href="/build/12">#12</a>, <a href="/build/13">#13</a>).');
    // A bump whose new version did not build on aarch64: aarch64 stays at the version in the pool, never "does not ship".
    expect(s.decidedText("only", { arches: ["x86_64"], only_reason: "aarch64 2.0 fails to link", not_shipping: {}, kept: { aarch64: "1.0-1" }, publishes: { x86_64: 14 } })).toBe('Approved for x86_64 only — the project\'s build goes into edge (publish job <a href="/build/14">#14</a>); aarch64 stays at 1.0-1.');
  });

  it("posts one architecture alone through the same door, with its reason and the passkey's answer for exactly that act", async () => {
    // The shell as a page runs it, its dialog and its passkey taken over by the test — what it asks, the act it binds — and its click heard as the document hears it.
    const said: any[] = [], subjects: string[] = [], sent: { path: string; body: any }[] = [], heard: ((ev: unknown) => void)[] = [];
    const run = new Function("document", "window", "fetch", "location", "innerWidth", "SAID", "SUBJECTS",
      `${SHELL}\nask = function (o) { SAID.push(o); return Promise.resolve(o.input === "required" ? "upstream ships no aarch64 build" : ""); };\npasskeyed = function (what, post) { SUBJECTS.push(what); return post({ credential: "c" }); };\nreturn {};`);
    const el = (): any => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, children: [], setAttribute() {}, getAttribute: () => null, insertBefore() {}, innerHTML: "", textContent: "", addEventListener() {}, remove() {} });
    const document: any = { querySelector: el, querySelectorAll: () => [], addEventListener: (t: string, f: (ev: unknown) => void) => { if (t === "click") heard.push(f); }, createElement: el, body: el(), documentElement: { getAttribute: () => null } };
    const answered = { decision: "approved", arches: ["x86_64"], only_reason: "upstream ships no aarch64 build", not_shipping: { aarch64: H.arm }, publishes: { x86_64: 99 } };
    run(document, { matchMedia: null }, async (path: string, init?: RequestInit) => { sent.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null }); return new Response(JSON.stringify(answered), { status: 200, headers: { "content-type": "application/json" } }); }, { pathname: "/package/onearch", search: "", origin: WEB }, 1280, said, subjects);
    // A press of Approve x86_64 only, inside approveCell's .decide.
    const cell = { getAttribute: (k: string) => (({ "data-label": "onearch 1.0", "data-arch": "x86_64" }) as Record<string, string>)[k] ?? null };
    const attrs: Record<string, string> = { "data-only": String(H.px), "data-arch": "x86_64", "data-others": "aarch64" };
    const b: any = { disabled: false, getAttribute: (k: string) => attrs[k] ?? null, hasAttribute: (k: string) => k in attrs, closest: (sel: string) => (sel === ".decide" ? cell : sel.includes("button[data-only]") ? b : null) };
    for (const f of heard) f({ target: b, stopImmediatePropagation() {} });
    await until(() => sent.some((x) => x.path.endsWith("/approve")), "the approval posted");
    // The dialog asked for the reason — required — and named the architecture, and what does not ship.
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ title: "Approve x86_64 only — onearch 1.0", input: "required", confirm: "Approve x86_64 only with your passkey", first: "Register a passkey and approve" });
    expect(said[0].text).toContain("aarch64 does not ship: its builds in review stop.");
    // The passkey's answer for exactly that act, and the approve door with `only` and the reason.
    expect(subjects).toEqual([`approve:${H.px}:x86_64`]);
    expect(sent.filter((x) => x.path.endsWith("/approve"))).toEqual([{ path: `/api/v1/factory/tasks/${H.px}/approve`, body: { only: "x86_64", reason: "upstream ships no aarch64 build", assertion: { credential: "c" } } }]);
  });
});

describe("Review's workspace", () => {
  it("offers Approve package and Approve <arch> only, gated in place by the server's can, names each build, and asks the reason before it posts", async () => {
    const decisions = [button({ "data-decide": "approve" }), button({ "data-decide": "only", "data-arch": "x86_64" }), button({ "data-decide": "only", "data-arch": "aarch64" }), button({ "data-decide": "changes" }), button({ "data-decide": "reject" })];
    const p = await pageAs("/review?package=botharch", "m2", { a: keys.m2, functions: ["workPkg", "round", "renderDecide", "decisionText"], variables: ["CONFIRM"], buttons: decisions });
    await until(() => !!p.ran.workPkg() && p.ran.round().length === 2, "the workspace's package and its story");
    p.ran.renderDecide(p.ran.round(), p.ran.workPkg());
    // Built on both: the package live on the build that speaks for it, each architecture alone live on its own build.
    expect(decisions.slice(0, 3).map((b) => [b.disabled, b.getAttribute("data-task")])).toEqual([[false, expect.any(String)], [false, String(B.rx)], [false, String(B.ra)]]);
    // The package's confirmation names each architecture and its build.
    const v = p.ran.workPkg().version;
    expect(p.ran.decisionText("approve", p.ran.round(), p.ran.workPkg())).toBe(`Approve botharch ${v} for x86_64 (build #${B.rx}) and aarch64 (build #${B.ra})? The project's build enters edge. Your passkey confirms it.`);
    expect(p.ran.decisionText("only", p.ran.round(), p.ran.workPkg(), "aarch64")).toBe(`Approve botharch ${v} for aarch64 only (build #${B.ra})? x86_64 does not ship: build #${B.rx} stops. Say why below — the record and the package's page show it. Your passkey confirms it.`);
  });

  it("refuses the package with the server's reason while an architecture did not build, and posts x86_64 alone with its reason — the record then says what shipped", async () => {
    const decisions = [button({ "data-decide": "approve" }), button({ "data-decide": "only", "data-arch": "x86_64" }), button({ "data-decide": "only", "data-arch": "aarch64" }), button({ "data-decide": "changes" }), button({ "data-decide": "reject" })];
    const p = await pageAs("/review?package=onearch", "m2", { a: keys.m2, functions: ["workPkg", "round", "renderDecide", "decide"], variables: ["CONFIRM"], buttons: decisions });
    await until(() => !!p.ran.workPkg() && p.ran.round().length === 2, "the workspace's package and its story");
    p.ran.renderDecide(p.ran.round(), p.ran.workPkg());
    const [pkg, x86, arm] = decisions;
    expect([pkg.disabled, pkg.getAttribute("title")]).toEqual([true, `aarch64 did not build (task ${H.arm}): the package is approved once every architecture it names is built again by the project — or approve x86_64 only, with the reason aarch64 does not ship`]);
    expect([x86.disabled, x86.getAttribute("data-task"), x86.getAttribute("title")]).toEqual([false, String(H.px), null]);
    expect([arm.disabled, arm.getAttribute("data-task"), arm.getAttribute("title")]).toEqual([true, null, "the project has no staged build of aarch64 to approve"]);
    // Pressed: the confirmation asks why aarch64 does not ship, in place.
    p.ran.setCONFIRM({ what: "only", id: H.px, arch: "x86_64" });
    p.ran.renderDecide(p.ran.round(), p.ran.workPkg());
    expect(p.nodes["#rv-confirm-t"].textContent).toBe(`Approve onearch ${p.ran.workPkg().version} for x86_64 only (build #${H.px})? aarch64 does not ship: its builds in review stop. Say why below — the record and the package's page show it. Your passkey confirms it.`);
    expect(p.nodes["#rv-confirm-why"].hidden).toBe(false);
    expect(p.nodes["#rv-confirm-why"].placeholder).toBe("why aarch64 does not ship — on the record and the package's page");
    expect(p.nodes["#rv-confirm-go"].innerHTML).toContain("Confirm with your passkey");
    // Without a reason nothing is posted: the page says why.
    p.ran.decide("only", H.px, "x86_64");
    expect(p.nodes["#rv-err"].textContent).toBe("Say why aarch64 does not ship, in a few words: the record and the package's page show it.");
    expect(p.posted).toEqual([]);
    p.nodes["#rv-confirm-why"].value = "upstream ships no aarch64 build";
    p.ran.decide("only", H.px, "x86_64");
    await until(() => p.posted.some((x) => x.path.endsWith("/approve")), "the approval posted");
    expect(p.posted.map((x) => x.path)).toEqual(["/auth/passkeys/assert", `/api/v1/factory/tasks/${H.px}/approve`]);
    expect(p.posted[0].body).toEqual({ for: `approve:${H.px}:x86_64` });
    expect(p.posted[1].body).toMatchObject({ only: "x86_64", reason: "upstream ships no aarch64 build" });
    await until(() => !!p.nodes["#toasts"]?.children?.length, "the toast");
    expect(await env.DB.prepare("SELECT arches, only_reason, not_shipping FROM reviews WHERE name = 'onearch'").first()).toEqual({ arches: '["x86_64"]', only_reason: "upstream ships no aarch64 build", not_shipping: JSON.stringify({ aarch64: H.arm }) });
    // Opened again, the workspace says what the approval shipped, beside where it is — the record read past the edge's thirty seconds, as the next minute's read would.
    const again = await pageAs("/review?package=onearch", null, { functions: ["renderWork"], fresh: true });
    await until(() => String(again.nodes["#rv-w-state"]?.innerHTML ?? "").includes("rv-scope"), "the decided state");
    expect(again.nodes["#rv-w-state"].innerHTML).toContain('<span class="rv-scope">approved for x86_64 only: upstream ships no aarch64 build</span>');
    expect(again.nodes["#rv-w-chips"].innerHTML).toContain(">aarch64 · not shipping</span>");
  });
});

describe("the package's page", () => {
  it("draws the decision in its review stage for everyone — grey with the role's reason, live for a maintainer as the server says — and, decided, what shipped and what does not", async () => {
    // botharch, undecided: anyone sees the three buttons, grey; m2 sees them live once its can is read.
    const anyone = await pageAs("/package/botharch", null, { functions: ["reviewPanel"], variables: ["ST"] });
    await until(() => String(anyone.ran.reviewPanel ? (() => { try { return anyone.ran.reviewPanel(); } catch { return ""; } })() : "").includes("Decide the package"), "the review stage with its decision");
    const grey = buttons(anyone.ran.reviewPanel());
    expect(grey.map((b) => [b.text, b.disabled, b.title])).toEqual([["Approve package", true, "sign in with GitHub"], ["Approve x86_64 only", true, "sign in with GitHub"], ["Approve aarch64 only", true, "sign in with GitHub"]]);
    const m2 = await pageAs("/package/botharch", "m2", { a: keys.m2, functions: ["reviewPanel"] });
    await until(() => { try { return buttons(m2.ran.reviewPanel()).filter((b) => !b.disabled).length === 3; } catch { return false; } }, "m2's buttons, live");
    expect(buttons(m2.ran.reviewPanel()).map((b) => [b.text, b.task])).toEqual([["Approve package", String(B.rx)], ["Approve x86_64 only", String(B.rx)], ["Approve aarch64 only", String(B.ra)]]);
    // onearch, approved for x86_64 alone (the test above): the stage says so with its reason, aarch64 "not shipping" in its column and its Decided cell; nothing left to decide.
    const decided = await pageAs("/package/onearch", "m2", { a: keys.m2, functions: ["reviewPanel", "colsOf", "stagesOf"], fresh: true });
    await until(() => { try { return decided.ran.reviewPanel().includes("Approved for x86_64 only") && !decided.ran.reviewPanel().includes("sign in with GitHub"); } catch { return false; } }, "the decided stage, as m2 reads it");
    const panel = decided.ran.reviewPanel();
    expect(panel).toContain("Approved for x86_64 only: “upstream ships no aarch64 build” — aarch64 does not ship");
    expect(panel).toContain("Verdict: approved for x86_64 only: upstream ships no aarch64 build");
    // Nothing left to decide, said on the same buttons, grey: approved already, and what it shipped.
    expect(buttons(panel).map((b) => [b.text, b.disabled, b.title])).toEqual([["Approve package", true, "already approved for x86_64 only: upstream ships no aarch64 build"], ["Approve x86_64 only", true, "already approved for x86_64 only: upstream ships no aarch64 build"], ["Approve aarch64 only", true, "already approved for x86_64 only: upstream ships no aarch64 build"]]);
    expect(panel).toContain("<small>not shipping</small>");
    expect(decided.ran.colsOf()).toEqual([["x86_64", "ok-t"], ["aarch64 · not shipping", "dim-t"]]);
    const review = decided.ran.stagesOf().find((x: any) => x.id === "review");
    expect(review.sum).toBe("@m2 · rebuilt · approved for x86_64 only");
    // The full line says the scope once, with its reason.
    expect(review.full).toBe("@m2 · rebuilt · approved for x86_64 only: upstream ships no aarch64 build");
    expect(review.archs).toContain('title="aarch64: not shipping"');
  });

  it("stops saying an architecture does not ship once it is approved too, at the same version: its column, its Decided cell and the stage's note say where it stands", async () => {
    // latearch: x86_64 approved alone while aarch64 did not build; aarch64 built again at the same version, and approved as the package.
    const { px } = await half("latearch");
    const approveAs = async (task: number, body: Record<string, unknown>) => {
      const o = await asPage("m2", "POST", "/auth/passkeys/assert", { for: `approve:${task}${typeof body.only === "string" ? `:${body.only}` : ""}` });
      const assertion = await answer(keys.m2, { challenge: o.json.publicKey.challenge, origin: WEB, rpId: "localhost" });
      return asPage("m2", "POST", `/api/v1/factory/tasks/${task}/approve`, { ...body, assertion });
    };
    expect((await approveAs(px, { only: "x86_64", reason: "aarch64 has no linker yet" })).status).toBe(200);
    expect((await call("POST", "/factory/packages/latearch/build", { arches: ["aarch64"] }, "omc_alice")).status).toBe(201);
    const ca = await stage(await claim("omw_ca", "aarch64", "latearch"));
    expect((await call("POST", `/factory/tasks/${ca}/build`, {}, "omc_m1")).status).toBe(200);
    const pa = await stage(await claim("omw_pa", "aarch64", "latearch"));
    const ok = await approveAs(pa, { note: "aarch64 links now" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const p = await pageAs("/package/latearch", null, { functions: ["reviewPanel", "colsOf"], fresh: true });
    await until(() => { try { return p.ran.reviewPanel().includes("Approved for x86_64 only"); } catch { return false; } }, "the decided stage");
    const panel = p.ran.reviewPanel();
    // x86_64's approval keeps its own words — x86_64 alone, and why — and nothing says aarch64 does not ship: it is approved.
    expect(panel).toContain("Approved for x86_64 only: “aarch64 has no linker yet”.");
    expect(panel).not.toContain("does not ship");
    expect(panel).not.toContain("<small>not shipping</small>");
    expect(panel).toContain("approved for aarch64 by m2");
    expect(p.ran.colsOf()).toEqual([["x86_64", "ok-t"], ["aarch64", "ok-t"]]);
  });
});
