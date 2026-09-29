/**
 * A maintainer without a passkey is guided, not stopped (#287). Option A,
 * decided by the maintainer on 2026-09-29: the passkey stays required for
 * approve, block and a forced promotion, and a maintainer who holds none is
 * told before it matters, registers the first where the act needs it, and
 * the act completes:
 *
 * - /auth/me tells a maintainer's pages whether they hold one — one entry of
 *   the passkeys' index, asked for a maintainer only — and the shell's
 *   notice says what needs one and that nothing else does, with Register a
 *   passkey now: always on Review and on their own page, once anywhere else
 *   (this browser keeps that it was shown: nothing is written to the pool),
 *   gone once they hold one.
 * - The dialogs of approve, block and a forced promotion offer Register a
 *   passkey and approve (… and block, … and force). The first press makes
 *   the passkey with the session alone and the dialog stays open; the next
 *   answers the pool's challenge for exactly that act and login, and the act
 *   is done — no page left, nothing half decided. A cancelled registration
 *   decides nothing, and the dialog says so. The act's journal line says the
 *   passkey was registered just now.
 * - Everything else a maintainer does asks for no passkey: the list below is
 *   the pinned one.
 *
 * The shell runs as a page runs it (HELPERS), with a dialog this file can
 * press, the software authenticator (soft-authenticator.mjs) as the
 * browser's navigator.credentials, and the Worker at the relying party's
 * address (localhost) behind its fetch — the session's cookie and the
 * page's Origin on every call. The refusals of each door are
 * passkey-decisions' and passkey-doors'; the registration's own rules,
 * passkeys.test.ts's.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/routes/contributors";
import { HAS_PASSKEY_SQL, JUST_NOW_MINUTES, PASSKEY_BY_CREDENTIAL_SQL } from "../src/routes/passkeys";
import { HELPERS } from "../src/pages/layout";
import { CATEGORIES } from "../src/categories";
import { runScript, scriptOf, seedDashboard, type Fixture } from "./fixture";
import { decider } from "./decide";
import { assert as answer, b64url, createAuthenticator, register, unb64url } from "./soft-authenticator.mjs";

/** The dashboard as the tests reach it where a passkey works (relyingParty): localhost, as wrangler dev's. */
const WEB = "http://localhost:8787";
const AGENT = "claude-code/claude-sonnet-5";
const checklist = { official: true, license: true, unshipped: true, evidence: true };

type Authenticator = Awaited<ReturnType<typeof createAuthenticator>>;
type Answer = { status: number; json: any };

async function raw(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Answer> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(WEB + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}
/** A call as the login's page makes it: the session's cookie, the page's Origin, JSON. */
const asPage = (login: string, method: string, path: string, body?: unknown) => raw(method, path, { cookie: `omc=oms_${login}`, origin: WEB, "content-type": "application/json" }, body);
/** A call with a token — a contributor's, a worker's — as a script makes it. */
const call = (method: string, path: string, body: unknown, token: string) => raw(method, `/api/v1${path}`, { "content-type": "application/json", authorization: `Bearer ${token}` }, body);

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok(), what).toBe(true);
};
const line = async (kind: string, key: string, value: string | number) => {
  const e = await env.DB.prepare(`SELECT summary, payload FROM events WHERE kind = ? AND json_extract(payload, '$.${key}') = ? ORDER BY id DESC LIMIT 1`).bind(kind, value).first<{ summary: string; payload: string }>();
  return e ? { summary: e.summary, payload: JSON.parse(e.payload) } : null;
};
const passkeysOf = async (login: string) => (await env.DB.prepare("SELECT id FROM passkeys WHERE login = ?").bind(login).all<{ id: string }>()).results.map((r) => r.id);

// ---------- the shell, as a page runs it, with a dialog this file can press ----------

const SHELL = HELPERS.split("__POOL_URL__").join("http://pool.test").split("__RINGS_TEXT__").join("{}").split("__WICON__").join("{}").split("__LATE_AFTER_HOURS__").join("9").split("__PROMISED_RINGS__").join("[]").split("__ARCHES__").join('["x86_64","aarch64"]').split("__SEVERITIES__").join("[]").split("__WORKER_ALIVE_MINUTES__").join("10");
const FUNCTIONS = ["ask", "decideDialog", "passkeyed", "firstPasskey", "needsPasskey", "api", "whoami", "refusalHtml"];

/** An element as the shell writes it: what it was given, its attributes, its focus. */
function node(): any {
  const attrs: Record<string, string> = {};
  return {
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, children: [] as any[], hidden: false, innerHTML: "", textContent: "", title: "", className: "", value: "", id: "",
    appendChild(c: any) { this.children.push(c); return c; }, insertBefore(n: any) { this.children.unshift(n); return n; }, removeChild() {}, remove() {},
    setAttribute(k: string, v: unknown) { attrs[k] = String(v); }, getAttribute: (k: string) => (k in attrs ? attrs[k] : null), removeAttribute(k: string) { delete attrs[k]; }, hasAttribute: (k: string) => k in attrs,
    focus() { this.focused = true; }, closest: () => null, addEventListener() {}, querySelector: () => node(), querySelectorAll: () => [], firstChild: null,
  };
}

/** The dashboard's dialog (ask): the parts it has are the ones its HTML carries; the form's submit button starts with the words it was drawn with. */
function dialog(): any {
  const d = node(), parts: Record<string, any> = {};
  const has: Record<string, string> = { ".pk": 'class="pk"', textarea: "<textarea", select: "<select", ".err": 'class="err"', ".val code": 'class="val"', "pre.block": 'class="block"', ".take": 'class="take"', ".alt": 'class="alt ' };
  Object.assign(d, {
    isDialog: true, open: false, removed: false, listeners: {} as Record<string, (ev: unknown) => void>,
    showModal() { d.open = true; }, close() { d.open = false; }, remove() { d.removed = true; },
    addEventListener(t: string, f: (ev: unknown) => void) { d.listeners[t] = f; },
    querySelector(sel: string) {
      if (sel in has && !d.innerHTML.includes(has[sel])) return null;
      if (!parts[sel]) {
        parts[sel] = node();
        if (sel === "form") parts.form.querySelector = (s: string) => (s === 'button[type="submit"]' ? d.submit() : null);
      }
      return parts[sel];
    },
    submit() { return (parts.submit ||= Object.assign(node(), { textContent: (/<button type="submit"[^>]*>([^<]*)<\/button>/.exec(d.innerHTML) ?? ["", ""])[1].replace(/&amp;/g, "&") })); },
  });
  return d;
}

/**
 * The shell for `login` on `pathname`: its fetch is the Worker with the
 * login's session and the page's Origin (what it posted is kept), its
 * navigator.credentials the software authenticator `a` — create() and get(),
 * each with the options it was handed kept — or what the test makes them
 * do; localStorage is `store`, or one that throws.
 */
function shellAs(login: string | null, o: { pathname?: string; a?: Authenticator; store?: Map<string, string> | "blocked"; create?: (options: any) => Promise<unknown>; get?: (options: any) => Promise<unknown> } = {}) {
  const posted: string[] = [], created: any[] = [], asked: any[] = [], dialogs: any[] = [], nodes: Record<string, any> = {};
  const document = {
    querySelector: (sel: string) => (nodes[sel] = nodes[sel] || node()),
    querySelectorAll: () => [], addEventListener() {}, createElement: (tag: string) => (tag === "dialog" ? dialog() : node()),
    body: { appendChild(c: any) { if (c.isDialog) dialogs.push(c); return c; } }, documentElement: { getAttribute: () => null }, title: "",
  };
  const buf = (v: string) => unb64url(v).buffer;
  const navigator = {
    credentials: {
      create: async (options: any) => {
        created.push(options.publicKey);
        if (o.create) return o.create(options);
        const k = options.publicKey, r = await register(o.a!, { challenge: b64url(k.challenge), origin: WEB, rpId: k.rp.id });
        return { rawId: buf(r.id), response: { clientDataJSON: buf(r.clientDataJSON), attestationObject: buf(r.attestationObject) } };
      },
      get: async (options: any) => {
        asked.push(options.publicKey);
        if (o.get) return o.get(options);
        const k = options.publicKey, x = await answer(o.a!, { challenge: b64url(k.challenge), origin: WEB, rpId: k.rpId });
        return { rawId: buf(x.credential), response: { clientDataJSON: buf(x.client_data), authenticatorData: buf(x.authenticator_data), signature: buf(x.signature), userHandle: null } };
      },
    },
  };
  const store = o.store ?? new Map<string, string>();
  const localStorage = store === "blocked"
    ? { getItem() { throw new Error("SecurityError: storage is blocked"); }, setItem() { throw new Error("SecurityError: storage is blocked"); } }
    : { getItem: (k: string) => (store.has(k) ? store.get(k) : null), setItem: (k: string, v: string) => void store.set(k, String(v)) };
  const fetchAs = async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") posted.push(path);
    const { cache: _cache, ...rest } = init ?? {};
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(WEB + path, { ...rest, headers: { ...(rest.headers as Record<string, string>), ...(login ? { cookie: `omc=oms_${login}` } : {}), origin: WEB } }), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  const window = { matchMedia: null, PublicKeyCredential: function () {}, isSecureContext: true };
  const make = new Function("document", "window", "fetch", "location", "innerWidth", "navigator", "localStorage", `${SHELL}\n return { ${[...FUNCTIONS.map((f) => `${f}: ${f}`), "who: function () { return WHO; }"].join(", ")} };`);
  const ran = make(document, window, fetchAs, { pathname: o.pathname ?? "/status", search: "", origin: WEB }, 1280, navigator, localStorage) as Record<string, any>;
  const ready = new Promise<void>((r) => ran.whoami(() => r()));
  return { ...ran, ready, posted, created, asked, dialogs, nodes } as any;
}

/**
 * A served page's own script for `login`, run as runScript runs a page (its
 * document keeps what is written, by selector), with the software
 * authenticator `a` as the browser's navigator.credentials, a secure
 * context, and the Worker at the relying party's address behind its fetch —
 * the session's cookie and the page's Origin on every call. `functions` and
 * `variables` are handed back to press what a reader presses.
 */
async function pageAs(path: string, login: string, a: Authenticator, o: { functions: string[]; variables?: string[] }) {
  const ctx = createExecutionContext();
  const html = await (await worker.fetch(new Request(WEB + path, { headers: { cookie: `omc=oms_${login}` } }), env, ctx)).text();
  await waitOnExecutionContext(ctx);
  const posted: string[] = [];
  const buf = (v: string) => unb64url(v).buffer;
  (globalThis as any).__pkPageNavigator = {
    credentials: {
      create: async (options: any) => {
        const k = options.publicKey, r = await register(a, { challenge: b64url(k.challenge), origin: WEB, rpId: k.rp.id });
        return { rawId: buf(r.id), response: { clientDataJSON: buf(r.clientDataJSON), attestationObject: buf(r.attestationObject) } };
      },
      get: async (options: any) => {
        const k = options.publicKey, x = await answer(a, { challenge: b64url(k.challenge), origin: WEB, rpId: k.rpId });
        return { rawId: buf(x.credential), response: { clientDataJSON: buf(x.client_data), authenticatorData: buf(x.authenticator_data), signature: buf(x.signature), userHandle: null } };
      },
    },
  };
  const browser = "window.PublicKeyCredential = function () {}; window.isSecureContext = true; var navigator = globalThis.__pkPageNavigator;";
  const code = scriptOf(html).trim().replace(/^\(function \(\) \{/, `(function () {${browser}`);
  const url = new URL(WEB + path);
  const ran = runScript(code, {
    pathname: url.pathname, search: url.search, functions: o.functions, variables: o.variables,
    fetch: async (p: string, init?: RequestInit) => {
      if (init?.method === "POST") posted.push(p);
      const { cache: _cache, ...rest } = init ?? {};
      const c = createExecutionContext();
      const res = await worker.fetch(new Request(WEB + p, { ...rest, headers: { ...(rest.headers as Record<string, string>), cookie: `omc=oms_${login}`, origin: WEB } }), env, c);
      await waitOnExecutionContext(c);
      return res;
    },
  });
  return { ran, nodes: ran.nodes, posted };
}

/** A press of the dialog's submit button, as the browser's submit event reaches the shell. */
const press = (d: any) => d.querySelector("form").onsubmit({ preventDefault() {} });

// ---------- the builds a maintainer decides: alice's request, her build, the project's rebuild ----------

const claimAs = async (token: string, name: string) => {
  await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'not this story' WHERE status IN ('queued', 'leased') AND name != ? AND kind = 'build'").bind(name).run();
  const c = await call("POST", "/factory/claim", { arch: "x86_64", agent: token === "omw_px" ? AGENT : "openai/gpt-5", agent_status: "ok", kinds: ["build"] }, token);
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return c.json as { task: { id: number; name: string }; token: string };
};
const stage = async (c: { task: { id: number; name: string }; token: string }, who: string) => {
  const file = `${c.task.name}-1.0-1-x86_64.pkg.tar.zst`;
  for (const f of ["PKGBUILD", "build.log", "PKGINFO", file]) expect((await raw("PUT", `/api/v1/factory/tasks/${c.task.id}/artifacts/${f}`, { authorization: `Bearer ${c.token}` }, `${who}'s ${f}`)).status).toBe(201);
  const done = await call("POST", `/factory/tasks/${c.task.id}/complete`, { sha256: (who === "the project" ? "d" : "c").repeat(64), filename: file, version: "1.0-1" }, c.token);
  expect(done.json).toMatchObject({ status: "staged" });
};
/** alice's request, built by her worker: the contributor's build, staged — a package in review. */
const ready = async (name: string) => {
  expect((await call("POST", "/factory/packages", { name, url: `https://${name}.example`, source: `https://${name}.example/${name}-1.0.tar.gz`, version: "1.0", description: `${name}, a tool for the guided passkey's tests`, license: "MIT", arches: ["x86_64"], checklist }, "omc_alice")).status).toBe(201);
  const c = await claimAs("omw_cx", name);
  await stage(c, "alice");
  return c.task.id;
};
/** …claimed by m1, rebuilt by the project: the build a maintainer approves. */
const reviewed = async (name: string) => {
  const contributor = await ready(name);
  expect((await call("POST", `/factory/tasks/${contributor}/build`, { worker: "px", note: "pin the tag" }, "omc_m1")).status).toBe(200);
  const rb = await claimAs("omw_px", name);
  await stage(rb, "the project");
  return { contributor, project: rb.task.id };
};

let F: Fixture;
/** The maintainers of this file who hold no passkey when it starts: each test's own, so what one registers changes no other's. */
const NEW = ["m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11", "m12", "m13"];

beforeAll(async () => {
  F = await seedDashboard(env);
  const h = (t: string) => sha256Hex(t);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO factory_maintainers (login) VALUES ${NEW.map(() => "(?)").join(", ")}`).bind(...NEW),
    ...(await Promise.all([...NEW.map((l) => [l, "maintainer"]), ["carl", "contributor"]].map(async ([l, role]) => env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role) VALUES (?, ?, ?, ?)").bind(l, await h(`omc_${l}`), await h(`oms_${l}`), role)))),
    env.DB.prepare(`INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, agent, agent_status, kinds) VALUES
      ('cx', 'x86_64', 'alice', ?, 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z', 'openai/gpt-5', 'ok', '["build"]'),
      ('px', 'x86_64', 'm2', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z', ?, 'ok', '["build"]')`).bind(await h("omw_cx"), await h("omw_px"), AGENT),
  ]);
});

describe("told before it matters (#287)", () => {
  it("/auth/me says whether a maintainer holds a passkey — to a maintainer only, from one entry of the passkeys' index", async () => {
    expect((await asPage("m8", "GET", "/auth/me")).json).toMatchObject({ login: "m8", role: "maintainer", passkey: false });
    // m1 holds one: the fixture's first decision registered it (decide.ts).
    expect((await asPage(F.m1, "GET", "/auth/me")).json).toMatchObject({ login: F.m1, role: "maintainer", passkey: true });
    // Nobody else is asked for one: a contributor's answer has no word of it, and nobody's is the 401.
    const bob = (await asPage(F.contributor, "GET", "/auth/me")).json;
    expect(bob).toMatchObject({ login: F.contributor, role: "contributor" });
    expect("passkey" in bob).toBe(false);
    expect((await raw("GET", "/auth/me", {})).status).toBe(401);
    // Through the (login, created_at) index, one entry at most — never a scan of passkeys; the assertion's read of a passkey stays on its credential's index.
    const plan = async (sql: string) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind("x").all<{ detail: string }>()).results.map((r) => r.detail).join(" | ");
    expect(await plan(HAS_PASSKEY_SQL)).toMatch(/SEARCH passkeys USING COVERING INDEX idx_passkeys_login \(login=\?\)/);
    expect(await plan(PASSKEY_BY_CREDENTIAL_SQL)).toMatch(/SEARCH passkeys USING INDEX idx_passkeys_credential \(credential_id=\?\)/);
    expect(HAS_PASSKEY_SQL).toMatch(/LIMIT 1$/);
  });

  it("draws the notice on Review and on the maintainer's own page every time; anywhere else once, as this browser keeps it; for nobody else", async () => {
    const notice = (s: any) => (s.nodes["#pk-notice"]?.hidden === false ? s.nodes["#pk-notice"].innerHTML as string : "");
    const review = shellAs("m8", { pathname: "/review" });
    await review.ready;
    await until(() => notice(review) !== "", "the notice on Review");
    const html = notice(review);
    expect(html).toContain("<b>You hold no passkey yet.</b> Approve, block and a forced promotion are confirmed with one, and so is a reset of another maintainer's passkeys. Nothing else you do asks for it.");
    expect(html).toContain('<a href="/docs/governance#passkeys">How it works</a>');
    expect(html).toContain('<button type="button" class="pk-now">Register a passkey now</button>');
    // Where it is always drawn there is nothing to put off: no Not now.
    expect(html).not.toContain("Not now");
    expect(review.nodes["#pk-notice"].className).toBe("notice warn pk-notice");
    expect(review.nodes["#pk-notice"].getAttribute("role")).toBe("region");
    const own = shellAs("m8", { pathname: "/user/m8" });
    await own.ready;
    await until(() => notice(own) !== "", "the notice on their own page");
    // Anywhere else: once. This browser keeps that it was shown; the pool is asked to remember nothing.
    const store = new Map<string, string>();
    const status = shellAs("m8", { pathname: "/status", store });
    await status.ready;
    await until(() => notice(status) !== "", "the notice once, on the first page they see");
    expect(notice(status)).toContain('<button type="button" class="ghost pk-later">Not now</button>');
    expect([...store.keys()]).toEqual(["op-pk-notice:m8"]);
    for (const pathname of ["/packages", "/status", "/user/alice"]) {
      const again = shellAs("m8", { pathname, store });
      await again.ready;
      expect(notice(again), pathname).toBe("");
    }
    // …and Review and their own page still draw it.
    const back = shellAs("m8", { pathname: "/review", store });
    await back.ready;
    await until(() => notice(back) !== "", "the notice on Review again");
    // A browser that keeps nothing (storage blocked) is not told on every page: Review and their own page tell it.
    const blocked = shellAs("m8", { pathname: "/factory", store: "blocked" });
    await blocked.ready;
    expect(notice(blocked)).toBe("");
    // Nobody else: a maintainer who holds one, a contributor, nobody signed in.
    for (const who of [F.m1, F.contributor, null]) {
      const s = shellAs(who, { pathname: "/review" });
      await s.ready;
      expect(notice(s), String(who)).toBe("");
      expect(s.needsPasskey(), String(who)).toBe(false);
    }
    expect(review.needsPasskey()).toBe(true);
  });

  it("goes once they hold one: Register a passkey now makes it with the session alone, and no page draws the notice after", async () => {
    const a = await createAuthenticator();
    const s = shellAs("m8", { pathname: "/review", a });
    await s.ready;
    await until(() => s.nodes["#pk-notice"]?.hidden === false, "the notice");
    const r = await s.firstPasskey();
    expect(r.passkey?.id, JSON.stringify(r)).toMatch(/^pk_[0-9a-f]{32}$/);
    expect(s.posted).toEqual(["/auth/passkeys/challenge", "/auth/passkeys"]);
    // What the browser was asked for: this relying party, user verification required, no attestation.
    expect(s.created[0]).toMatchObject({ rp: { id: "localhost" }, attestation: "none", authenticatorSelection: { userVerification: "required" } });
    expect(s.nodes["#pk-notice"]).toMatchObject({ hidden: true, innerHTML: "" });
    expect(s.needsPasskey()).toBe(false);
    expect(await passkeysOf("m8")).toEqual([r.passkey.id]);
    expect((await line("passkey", "passkey", r.passkey.id))!.summary).toBe(`m8 registered a passkey (ES256, ${r.passkey.id})`);
    expect((await asPage("m8", "GET", "/auth/me")).json.passkey).toBe(true);
    const next = shellAs("m8", { pathname: "/review" });
    await next.ready;
    expect(next.nodes["#pk-notice"]).toBeUndefined();
  });
});

describe("registered at the moment of need (#287)", () => {
  it("Approve: the first press registers the passkey and the dialog stays; the next approves with it, for exactly that build — one flow, no page left, and the line says so", async () => {
    const { project } = await reviewed("guidedapprove");
    const a = await createAuthenticator();
    const s = shellAs("m4", { pathname: `/build/${project}`, a });
    await s.ready;
    const done = s.decideDialog("approve", `guidedapprove 1.0-1 (build #${project})`, {});
    const d = s.dialogs[0];
    expect(d.open).toBe(true);
    expect(d.submit().textContent).toBe("Register a passkey and approve");
    expect(d.querySelector(".pk").textContent).toBe("You hold no passkey yet. Your device makes one now, then confirms this with it.");
    press(d);
    await until(() => d.querySelector(".pk").className === "pk ok", "the passkey registered");
    // Registered with the session alone, and the dialog is still open: nothing is decided yet.
    expect(s.posted).toEqual(["/auth/passkeys/challenge", "/auth/passkeys"]);
    expect(d.open).toBe(true);
    expect(d.submit().textContent).toBe("Approve with your passkey");
    expect(d.submit().focused).toBe(true);
    expect(d.querySelector(".pk").textContent).toBe("Your passkey is registered. Press Approve with your passkey: your device confirms this with it.");
    const [held] = await passkeysOf("m4");
    expect(held).toMatch(/^pk_/);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE task_id = ?").bind(project).first<{ n: number }>()).toEqual({ n: 0 });
    // The next press: the dialog resolves with the note, and the act is confirmed with the passkey just made, for exactly this build.
    d.querySelector("textarea").value = "reads well";
    press(d);
    expect(await done).toBe("reads well");
    expect(d.open).toBe(false);
    const decided = await s.passkeyed(`approve:${project}`, (assertion: unknown) => s.api("POST", `/api/v1/factory/tasks/${project}/approve`, { note: "reads well", assertion }));
    expect(decided.__status, JSON.stringify(decided)).toBe(200);
    expect(decided).toMatchObject({ decision: "approved", by: "m4", via: "web", passkey: held });
    expect(s.posted).toEqual(["/auth/passkeys/challenge", "/auth/passkeys", "/auth/passkeys/assert", `/api/v1/factory/tasks/${project}/approve`]);
    // The browser was asked once to create and once to answer, the answer for this act and login, user verification required.
    expect([s.created.length, s.asked.length]).toEqual([1, 1]);
    expect(s.asked[0]).toMatchObject({ rpId: "localhost", userVerification: "required" });
    const l = (await line("approve", "task", project))!;
    expect(l.summary).toMatch(/^guidedapprove 1\.0 \(x86_64\) approved by m4 with a passkey registered just now \(rebuilt with /);
    expect(l.payload).toMatchObject({ by: "m4", via: "web", passkey: held, registered_just_now: true });
    // The next decision with it is an ordinary one: its line says nothing of it.
    const second = await reviewed("guidedagain");
    const again = await s.passkeyed(`approve:${second.project}`, (assertion: unknown) => s.api("POST", `/api/v1/factory/tasks/${second.project}/approve`, { note: "reads well", assertion }));
    expect(again.__status, JSON.stringify(again)).toBe(200);
    const l2 = (await line("approve", "task", second.project))!;
    expect(l2.summary).toMatch(/approved by m4 \(rebuilt with/);
    expect(l2.payload.registered_just_now).toBeUndefined();
  });

  it("keeps the challenge bound to the act: the registration decides nothing, and an answer made for one act decides no other", async () => {
    const { project } = await reviewed("boundapprove");
    const a = await createAuthenticator();
    const s = shellAs("m7", { pathname: "/review", a });
    await s.ready;
    const r = await s.firstPasskey("Nothing was decided.");
    expect(r.passkey?.id, JSON.stringify(r)).toMatch(/^pk_/);
    // The registration is not an approval: the door still asks for the act's own answer.
    const bare = await asPage("m7", "POST", `/api/v1/factory/tasks/${project}/approve`, { note: "reads well" });
    expect([bare.status, bare.json.code]).toEqual([403, "passkey_required"]);
    // An answer made for blocking the package, or for another build, approves nothing; the one for this build does.
    const blockAnswer = await s.passkeyed("block:package:boundapprove", (assertion: unknown) => s.api("POST", `/api/v1/factory/tasks/${project}/approve`, { note: "reads well", assertion }));
    expect([blockAnswer.__status, blockAnswer.code]).toEqual([403, "challenge"]);
    const other = await s.passkeyed(`approve:${project + 1000}`, (assertion: unknown) => s.api("POST", `/api/v1/factory/tasks/${project}/approve`, { note: "reads well", assertion }));
    expect([other.__status, other.code]).toEqual([403, "challenge"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE task_id = ?").bind(project).first<{ n: number }>()).toEqual({ n: 0 });
    const ok = await s.passkeyed(`approve:${project}`, (assertion: unknown) => s.api("POST", `/api/v1/factory/tasks/${project}/approve`, { note: "reads well", assertion }));
    expect(ok.__status, JSON.stringify(ok)).toBe(200);
    expect(ok.passkey).toBe(r.passkey.id);
  });

  it("a cancelled registration decides nothing, and the dialog says so and stays, to press again or cancel", async () => {
    const { project } = await reviewed("cancelapprove");
    const cancel = () => Promise.reject(Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" }));
    const s = shellAs("m9", { pathname: "/review", create: cancel });
    await s.ready;
    const done = s.decideDialog("approve", `cancelapprove (build #${project})`, {});
    const d = s.dialogs[0];
    press(d);
    await until(() => d.querySelector(".pk").className === "pk err", "the refusal in the dialog");
    expect(d.querySelector(".pk").textContent).toBe("No passkey was registered: the request was cancelled or timed out. Nothing was decided.");
    // Still open, still the first press's words, nothing registered, nothing asked of the act's door.
    expect(d.open).toBe(true);
    expect(d.submit().textContent).toBe("Register a passkey and approve");
    expect(d.submit().getAttribute("aria-disabled")).toBeNull();
    expect(s.posted).toEqual(["/auth/passkeys/challenge"]);
    expect(await passkeysOf("m9")).toEqual([]);
    expect(s.needsPasskey()).toBe(true);
    // Cancel: nothing was decided — the dialog answers null, and no approval stands.
    d.querySelector(".cancel").onclick();
    expect(await done).toBeNull();
    expect(d.open).toBe(false);
    expect(s.posted).toEqual(["/auth/passkeys/challenge"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE task_id = ?").bind(project).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("Block, on Review's brake: Register a passkey and block, then the block with it — the package out, the line saying the passkey is new", async () => {
    await ready("guidedblock");
    const a = await createAuthenticator();
    const s = shellAs("m5", { pathname: "/review", a });
    await s.ready;
    // The brake's dialog, as review.ts asks it.
    const done = s.ask({ title: "Block package guidedblock?", text: "Its builds stop and it leaves the rings; another maintainer lifts it.", confirm: "Block with your passkey", first: "Register a passkey and block", danger: true });
    const d = s.dialogs[0];
    expect(d.submit().textContent).toBe("Register a passkey and block");
    press(d);
    await until(() => d.querySelector(".pk").className === "pk ok", "the passkey registered");
    expect(d.submit().textContent).toBe("Block with your passkey");
    press(d);
    await done;
    const r = await s.passkeyed("block:package:guidedblock", (assertion: unknown) => s.api("POST", "/api/v1/factory/packages/guidedblock/block", { reason: "ships a token stealer", assertion }));
    expect(r.__status, JSON.stringify(r)).toBe(200);
    const [held] = await passkeysOf("m5");
    expect(r).toMatchObject({ blocked: "guidedblock", by: "m5", passkey: held });
    const l = (await line("block", "name", "guidedblock"))!;
    expect(l.summary).toMatch(/^guidedblock blocked by m5 with a passkey registered just now: ships a token stealer/);
    expect(l.payload).toMatchObject({ by: "m5", passkey: held, registered_just_now: true });
    // A contributor's block, the other half of the brake, says it the same way on its own first use.
    const b = await createAuthenticator();
    const t = shellAs("m11", { pathname: "/review", a: b });
    await t.ready;
    expect((await t.firstPasskey()).passkey?.id).toMatch(/^pk_/);
    const c = await t.passkeyed("block:contributor:carl", (assertion: unknown) => t.api("POST", "/api/v1/factory/contributors/carl/block", { reason: "requests under a name that is not his", assertion }));
    expect(c.__status, JSON.stringify(c)).toBe(200);
    expect((await line("block", "login", "carl"))!.summary).toMatch(/^carl blocked by m11 with a passkey registered just now: requests under a name that is not his/);
  });

  it("a forced promotion, on Status: Register a passkey and force, then the promotion queued with it — and a passkey registered long ago is not new", async () => {
    const a = await createAuthenticator();
    const s = shellAs("m6", { pathname: "/status", a });
    await s.ready;
    // The dialog as status.ts asks it: why, which architectures, and the passkey.
    const both = [{ value: "", text: "Both architectures", selected: true }, { value: "x86_64", text: "x86_64 only" }, { value: "aarch64", text: "aarch64 only" }];
    const done = s.ask({ title: "Force rc into stable?", text: "stable serves rc's head at once.", select: { label: "Architectures", options: both }, input: "required", confirm: "Force with your passkey", first: "Register a passkey and force", nothing: "Nothing was queued.", danger: true });
    const d = s.dialogs[0];
    expect(d.submit().textContent).toBe("Register a passkey and force");
    // The reason is asked first, as before: an empty one registers nothing.
    press(d);
    expect(d.querySelector(".err").textContent).toBe("Say why, in a few words — the record keeps it.");
    expect(s.posted).toEqual([]);
    d.querySelector("textarea").value = "stable lags a security fix";
    press(d);
    await until(() => d.querySelector(".pk").className === "pk ok", "the passkey registered");
    expect(d.submit().textContent).toBe("Force with your passkey");
    press(d);
    expect(await done).toEqual({ note: "stable lags a security fix", pick: "" });
    const r = await s.passkeyed("promote:force:rc:stable", (assertion: unknown) => s.api("POST", "/api/v1/factory/jobs", { kind: "promote", params: { from: "rc", to: "stable", force: "yes", note: "stable lags a security fix" }, assertion }));
    expect(r.__status, JSON.stringify(r)).toBe(201);
    const [held] = await passkeysOf("m6");
    expect(r.passkey).toBe(held);
    const l = (await line("dispatch", "task", r.task))!;
    expect(l.summary).toBe(`promote rc → stable forced past its evidence, queued by m6 as task ${r.task} with their passkey (${held}), registered just now`);
    expect(l.payload).toMatchObject({ by: "m6", via: "web", passkey: held, registered_just_now: true });
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE id = ?").bind(r.task).run();
    // A passkey whose first use comes more than ten minutes after its registration is not "just now".
    const b = await createAuthenticator();
    const t = shellAs("m3", { pathname: "/status", a: b });
    await t.ready;
    const reg = await t.firstPasskey("Nothing was queued.");
    await env.DB.prepare(`UPDATE passkeys SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${JUST_NOW_MINUTES + 1} minutes') WHERE id = ?`).bind(reg.passkey.id).run();
    const late = await t.passkeyed("promote:force:edge:rc", (assertion: unknown) => t.api("POST", "/api/v1/factory/jobs", { kind: "promote", params: { from: "edge", to: "rc", force: "yes", note: "rc lags a fix" }, assertion }));
    expect(late.__status, JSON.stringify(late)).toBe(201);
    const l2 = (await line("dispatch", "task", late.task))!;
    expect(l2.summary).toBe(`promote edge → rc forced past its evidence, queued by m3 as task ${late.task} with their passkey (${reg.passkey.id})`);
    expect(l2.payload.registered_just_now).toBeUndefined();
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE id = ?").bind(late.task).run();
  });

  it("a passkey registered meanwhile, elsewhere: the dialog says the login holds one, and its next press confirms with it", async () => {
    const { project } = await reviewed("elsewhere");
    const a = await createAuthenticator();
    const s = shellAs("m10", { pathname: "/review", a });
    await s.ready;
    expect(s.needsPasskey()).toBe(true);
    // Another tab registers m10's first passkey, with the same device, after this page asked /auth/me.
    const o = await asPage("m10", "POST", "/auth/passkeys/challenge", {});
    expect((await asPage("m10", "POST", "/auth/passkeys", { label: "the other tab", ...(await register(a, { challenge: o.json.publicKey.challenge, origin: WEB, rpId: "localhost" })) })).status).toBe(201);
    const done = s.decideDialog("approve", `elsewhere (build #${project})`, {});
    const d = s.dialogs[0];
    expect(d.submit().textContent).toBe("Register a passkey and approve");
    press(d);
    await until(() => d.querySelector(".pk").className === "pk ok", "the dialog's word");
    expect(d.querySelector(".pk").textContent).toBe("You hold a passkey already. Press Approve with your passkey: your device confirms this with it.");
    expect(d.submit().textContent).toBe("Approve with your passkey");
    expect(s.needsPasskey()).toBe(false);
    // Nothing more was stored: a second passkey needs the first's answer, and none was given.
    expect((await passkeysOf("m10")).length).toBe(1);
    press(d);
    await done;
    const r = await s.passkeyed(`approve:${project}`, (assertion: unknown) => s.api("POST", `/api/v1/factory/tasks/${project}/approve`, { note: "reads well", assertion }));
    expect(r.__status, JSON.stringify(r)).toBe(200);
  });

  it("Review's own confirmation: Register a passkey and approve, then Confirm with your passkey — the same workspace, the build approved", async () => {
    const { project } = await reviewed("reviewform");
    const a = await createAuthenticator();
    const p = await pageAs("/review?package=reviewform", "m12", a, { functions: ["workPkg", "round", "renderDecide", "registerFirst", "decide"], variables: ["CONFIRM"] });
    await until(() => !!p.ran.workPkg(), "the workspace's package");
    p.ran.setCONFIRM({ what: "approve", id: project });
    p.ran.renderDecide(p.ran.round(), p.ran.workPkg());
    expect(p.nodes["#rv-confirm-go"].innerHTML).toContain("Register a passkey and approve");
    expect(p.nodes["#rv-confirm-t"].textContent).toContain("You hold no passkey yet: your device makes one now, then confirms the approval with it.");
    const go = p.nodes["#rv-confirm-go"];
    go.disabled = true;
    p.ran.registerFirst(go);
    await until(() => (p.nodes["#rv-confirm-go"].innerHTML as string).includes("Confirm with your passkey"), "the confirmation's next press");
    expect(go.disabled).toBe(false);
    expect(p.nodes["#rv-confirm-t"].textContent).toContain("Your passkey is registered. Confirm, and your device approves with it.");
    expect(p.posted).toEqual(["/auth/passkeys/challenge", "/auth/passkeys"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE task_id = ?").bind(project).first<{ n: number }>()).toEqual({ n: 0 });
    p.ran.decide("approve", project);
    await until(() => p.posted.length === 4, "the approval posted");
    expect(p.posted.slice(2)).toEqual(["/auth/passkeys/assert", `/api/v1/factory/tasks/${project}/approve`]);
    await until(() => !!p.nodes["#toasts"]?.children?.length, "the toast");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE task_id = ? AND decision = 'approved'").bind(project).first<{ n: number }>()).toEqual({ n: 1 });
    expect((await line("approve", "task", project))!.summary).toMatch(/approved by m12 with a passkey registered just now/);
  });

  it("a package's own Block: Register a passkey and block, the reason kept, then Block with your passkey — the package out of every ring", async () => {
    await ready("pageblock");
    const a = await createAuthenticator();
    const p = await pageAs("/package/pageblock", "m13", a, { functions: ["renderYou", "act"], variables: ["ASK"] });
    await until(() => (p.nodes["#you-who"]?.textContent ?? "").startsWith("@m13"), "You, drawn for m13");
    p.ran.setASK("block");
    p.ran.renderYou();
    const you = () => p.nodes["#you"].innerHTML as string;
    expect(you()).toContain("Register a passkey and block");
    expect(you()).toContain('<p class="pk" role="status" aria-live="polite">You hold no passkey yet. Your device makes one now, then confirms the block with it.</p>');
    p.ran.act("block", "ships a token stealer");
    await until(() => you().includes("Block pageblock with your passkey"), "the form's next press");
    expect(you()).toContain('<p class="pk ok" role="status" aria-live="polite">Your passkey is registered. Press Block pageblock with your passkey: your device confirms it.</p>');
    expect(p.posted).toEqual(["/auth/passkeys/challenge", "/auth/passkeys"]);
    expect(await env.DB.prepare("SELECT blocked_at FROM factory_packages WHERE name = 'pageblock'").first()).toEqual({ blocked_at: null });
    p.ran.act("block", "ships a token stealer");
    await until(() => p.posted.length === 4, "the block posted");
    expect(p.posted.slice(2)).toEqual(["/auth/passkeys/assert", "/api/v1/factory/packages/pageblock/block"]);
    await until(() => !you().includes("Block pageblock with your passkey"), "the form closed");
    expect((await env.DB.prepare("SELECT blocked_by FROM factory_packages WHERE name = 'pageblock'").first<{ blocked_by: string }>())!.blocked_by).toBe("m13");
    expect((await line("block", "name", "pageblock"))!.summary).toMatch(/^pageblock blocked by m13 with a passkey registered just now: ships a token stealer/);
  });

  it("every dialog of an act a passkey confirms offers the registration: Approve, Review's confirmation and brake, a package's Block, Status's Force, a reset", async () => {
    const script = async (path: string) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`http://pool.test${path}`), env, ctx);
      await waitOnExecutionContext(ctx);
      return res.text();
    };
    const pages: [string, string[]][] = [
      [`/build/${F.projectTask}`, ['first: "Register a passkey and approve"']],
      ["/review", ['"Register a passkey and approve"', 'first: "Register a passkey and block"', 'firstPasskey("Nothing was decided.")', "if (CONFIRM.what === \"approve\" && needsPasskey()) { registerFirst(go); return; }", 'id="pk-notice"']],
      [`/package/${F.factoryPkg}`, ['"Register a passkey and block"', 'if (what === "block" && needsPasskey()) { registerFirst(); return; }', 'firstPasskey("Nothing was decided.")']],
      ["/status", ['first: "Register a passkey and force", nothing: "Nothing was queued."']],
      [`/user/${F.m2}`, ['first: "Register a passkey and reset", nothing: "Nothing was reset."', 'id="pk-notice"', "passkeyHeld(PK_HELD > 0)"]],
    ];
    for (const [path, needles] of pages) {
      const html = await script(path);
      for (const n of needles) expect(html, `${path}: ${n}`).toContain(n);
    }
  });
});

describe("everything else stays free (#287)", () => {
  it("pins the list: a maintainer with no passkey claims, reviews, requests changes, rejects, adopts, lifts a block, sets a category, withdraws, vouches for and revokes a worker, queues and cancels — and only approve, block, a forced promotion and a reset ask for one", async () => {
    const who = "m3b";
    const h = (t: string) => sha256Hex(t);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO factory_maintainers (login) VALUES (?)").bind(who),
      env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role) VALUES (?, ?, ?, 'maintainer')").bind(who, await h(`omc_${who}`), await h(`oms_${who}`)),
    ]);
    expect(await passkeysOf(who)).toEqual([]);
    const { decide } = decider(env);
    // What the acts land on: packages in review, one approved (by m2, with their passkey), one blocked and a contributor blocked by m1, a worker to vouch for and one to revoke.
    const inReview = await ready("freeclaim");
    const forChanges = await ready("freechanges");
    const forReject = await ready("freereject");
    const approved = await reviewed("freewithdraw");
    expect((await decide(F.m2, `/factory/tasks/${approved.project}/approve`, { note: "reads well" })).status).toBe(200);
    const toApprove = await reviewed("freeapprove");
    await ready("freeblocked");
    await env.DB.prepare("UPDATE factory_packages SET blocked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), blocked_by = 'm1', blocked_reason = 'the tests', status = 'rejected' WHERE name = 'freeblocked'").run();
    await env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role, blocked_at, blocked_by, blocked_reason) VALUES ('dana', ?, ?, 'contributor', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'm1', 'the tests')").bind(await h("omc_dana"), await h("oms_dana")).run();
    const revokeMe = await call("POST", "/factory/workers", { name: "spare", arch: "x86_64" }, `omc_${F.contributor}`);
    expect(revokeMe.status, JSON.stringify(revokeMe.json)).toBe(201);
    const act = (method: string, path: string, body?: unknown) => asPage(who, method, path, body);
    const PASSKEY_CODES = ["no_passkey", "passkey_required", "session_only"];
    // The free list, in the order the issue names it: each done by a maintainer who holds no passkey, with the session alone.
    const FREE: [string, () => Promise<Answer>, number][] = [
      ["claim a package: the project builds it again", () => act("POST", `/api/v1/factory/tasks/${inReview}/build`, { worker: "px", note: "pin the tag" }), 200],
      ["the review workspace: the list", () => act("GET", "/api/v1/factory/review"), 200],
      ["the review workspace: a package's story", () => act("GET", "/api/v1/factory/packages/freeclaim/story"), 200],
      ["release the claim", () => act("POST", `/api/v1/factory/tasks/${inReview}/release`, { reason: "another maintainer takes it" }), 200],
      ["request changes", () => act("POST", `/api/v1/factory/tasks/${forChanges}/changes`, { note: "pin the source to the release tag" }), 200],
      ["reject", () => act("POST", `/api/v1/factory/tasks/${forReject}/reject`, { note: "the source is not the upstream's" }), 200],
      ["adopt a package a ring serves", () => act("POST", `/api/v1/factory/packages/${F.pkg}/adopt`, {}), 200],
      ["lift a package's block", () => act("POST", "/api/v1/factory/packages/freeblocked/unblock", { reason: "lifted by the tests" }), 200],
      ["lift a contributor's block", () => act("POST", "/api/v1/factory/contributors/dana/unblock", { reason: "lifted by the tests" }), 200],
      ["set a package's category", () => act("POST", "/api/v1/factory/packages/freeclaim/category", { category: CATEGORIES[0] }), 200],
      ["withdraw an approval", () => act("POST", `/api/v1/factory/tasks/${approved.project}/withdraw`, { note: "approved before the trial was read" }), 200],
      ["vouch for a worker (a worker order): the first word, a second maintainer's to follow", () => act("POST", "/api/v1/factory/workers/cx/trust", { trust: "project" }), 202],
      ["revoke a worker (a worker order)", () => act("DELETE", `/api/v1/factory/workers/${revokeMe.json.worker}`), 200],
      ["queue a dry run by hand (the queue)", () => act("POST", "/api/v1/factory/enqueue", { name: "freesize", pkgbuild_ref: "abc123", reason: "sizing", arches: ["x86_64"], version: "1.0-1", publish: false }), 201],
      ["roll a ring back (the queue)", () => act("POST", "/api/v1/factory/jobs", { kind: "rollback", params: { ring: "stable", to: String(F.previousRelease), note: "the tests roll back" } }), 201],
      ["promote by evidence (the queue)", () => act("POST", "/api/v1/factory/jobs", { kind: "promote", params: { from: "rc", to: "stable" } }), 201],
      ["a note on the journal", () => act("POST", "/api/v1/events", { kind: "note", summary: "the tests' note" }), 201],
    ];
    for (const [what, send, want] of FREE) {
      const r = await send();
      expect(PASSKEY_CODES, `${what}: ${JSON.stringify(r.json)}`).not.toContain(r.json?.code);
      expect(r.status, `${what}: ${JSON.stringify(r.json)}`).toBe(want);
    }
    // Cancel what the queue just took: a task of the queue is cancelled with the session too.
    const queued = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'freesize' AND status = 'queued'").first<{ id: number }>())!.id;
    const cancelled = await act("POST", `/api/v1/factory/tasks/${queued}/cancel`);
    expect([cancelled.status, PASSKEY_CODES.includes(cancelled.json?.code)], JSON.stringify(cancelled.json)).toEqual([200, false]);
    // The passkey's list, and nothing more: each refused with the way to register one, nothing decided.
    const PASSKEY: [string, () => Promise<Answer>][] = [
      ["approve", () => act("POST", `/api/v1/factory/tasks/${toApprove.project}/approve`, { note: "reads well" })],
      ["block a package", () => act("POST", "/api/v1/factory/packages/freeclaim/block", { reason: "ships a token stealer" })],
      ["block a contributor", () => act("POST", `/api/v1/factory/contributors/${F.contributor}/block`, { reason: "spam requests" })],
      ["force a promotion", () => act("POST", "/api/v1/factory/jobs", { kind: "promote", params: { from: "rc", to: "stable", force: "yes", note: "the tests force" } })],
      ["reset another maintainer's passkeys", () => act("POST", "/auth/passkeys/reset", { login: F.m1, reason: "lost by the tests" })],
    ];
    for (const [what, send] of PASSKEY) {
      const r = await send();
      expect([r.status, r.json?.code, r.json?.register], `${what}: ${JSON.stringify(r.json)}`).toEqual([403, "no_passkey", `/user/${who}#passkeys`]);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE task_id = ?").bind(toApprove.project).first<{ n: number }>()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT blocked_at FROM factory_packages WHERE name = 'freeclaim'").first()).toEqual({ blocked_at: null });
    expect(await env.DB.prepare("SELECT blocked_at FROM contributors WHERE login = ?").bind(F.contributor).first()).toEqual({ blocked_at: null });
    expect(await passkeysOf(F.m1)).toHaveLength(1);
  });
});
