/**
 * A maintainer without a passkey is guided, not stopped (#287). Option A,
 * decided by the maintainer on 2026-09-29: the passkey stays required for
 * approve, block and a forced promotion, and a maintainer who holds none is
 * told before it matters, registers the first where the act needs it, and
 * the act completes:
 *
 * - /auth/me tells a maintainer's pages whether they hold one — one entry of
 *   the passkeys' index, asked for a maintainer only, and not asked again
 *   once the browser knows they hold one (?held=) — and the shell's notice
 *   says what needs one and that nothing else does, with Register a passkey
 *   now: always on Review and on their own page, once anywhere else (this
 *   browser keeps that it was shown: nothing is written to the pool), gone
 *   once they hold one.
 * - The dialogs of approve, block and a forced promotion, and an agent's
 *   draft's page, offer Register a passkey and approve (… and block, … and
 *   force). The first press makes the passkey with the session alone and the
 *   dialog stays open; the next answers the pool's challenge for exactly
 *   that act and login, and the act is done — no page left, nothing half
 *   decided. A cancelled registration decides nothing, and the dialog says
 *   so. A passkey the pool lists for the login already is used, never made
 *   again, and the dialog says where it is listed. The act's journal line
 *   says the passkey was registered just now.
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
import { CONFIRM_SCRIPT } from "../src/pages/agent-auth";
import { s256 } from "../src/agents";
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

/** An element as the shell writes it: what it was given, its attributes, its focus, the element it finds by a selector (the same one each time), whether it was removed. */
function node(): any {
  const attrs: Record<string, string> = {}, found: Record<string, any> = {};
  return {
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, children: [] as any[], hidden: false, innerHTML: "", textContent: "", title: "", className: "", value: "", id: "",
    appendChild(c: any) { this.children.push(c); return c; }, insertBefore(n: any) { this.children.unshift(n); return n; }, removeChild() {}, remove() { this.removed = true; },
    setAttribute(k: string, v: unknown) { attrs[k] = String(v); }, getAttribute: (k: string) => (k in attrs ? attrs[k] : null), removeAttribute(k: string) { delete attrs[k]; }, hasAttribute: (k: string) => k in attrs,
    focus() { this.focused = true; }, closest: () => null, addEventListener() {}, querySelector: (sel: string) => (found[sel] ||= node()), querySelectorAll: () => [], firstChild: null,
  };
}

/** What a device holds, as a browser's create() checks it (WebAuthn §6.3.2, step 3): an authenticator that holds a credential the options exclude refuses with InvalidStateError. */
const excluded = (a: Authenticator | undefined, k: any) => !!a && (k.excludeCredentials ?? []).some((c: any) => b64url(c.id) === b64url(a.credentialId));
const invalidState = () => Object.assign(new Error("The authenticator was previously registered."), { name: "InvalidStateError" });

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
 * login's session and the page's Origin (what it fetched and what it posted
 * are kept), its navigator.credentials the software authenticator `a` —
 * create() and get(), each with the options it was handed kept, create()
 * refusing what the options exclude as a browser does — or what the test
 * makes them do; localStorage is `store`, or one that throws. A page's own
 * `script` runs after it, with the elements `byId` as getElementById finds
 * them; click(target) is a click the document's listeners hear.
 */
function shellAs(login: string | null, o: { pathname?: string; a?: Authenticator; store?: Map<string, string> | "blocked"; create?: (options: any) => Promise<unknown>; get?: (options: any) => Promise<unknown>; script?: string; byId?: Record<string, any> } = {}) {
  const posted: string[] = [], fetched: string[] = [], created: any[] = [], asked: any[] = [], dialogs: any[] = [], nodes: Record<string, any> = {}, heard: Record<string, ((ev: unknown) => void)[]> = {};
  const document = {
    querySelector: (sel: string) => (nodes[sel] = nodes[sel] || node()),
    querySelectorAll: () => [], addEventListener(t: string, f: (ev: unknown) => void) { (heard[t] ||= []).push(f); }, createElement: (tag: string) => (tag === "dialog" ? dialog() : node()),
    getElementById: (id: string) => o.byId?.[id] ?? null,
    body: { appendChild(c: any) { if (c.isDialog) dialogs.push(c); return c; } }, documentElement: { getAttribute: () => null }, title: "",
  };
  const buf = (v: string) => unb64url(v).buffer;
  const navigator = {
    credentials: {
      create: async (options: any) => {
        created.push(options.publicKey);
        if (o.create) return o.create(options);
        if (excluded(o.a, options.publicKey)) throw invalidState();
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
    ? { getItem() { throw new Error("SecurityError: storage is blocked"); }, setItem() { throw new Error("SecurityError: storage is blocked"); }, removeItem() { throw new Error("SecurityError: storage is blocked"); } }
    : { getItem: (k: string) => (store.has(k) ? store.get(k) : null), setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) };
  const fetchAs = async (path: string, init?: RequestInit) => {
    fetched.push(path);
    if (init?.method === "POST") posted.push(path);
    const { cache: _cache, credentials: _credentials, ...rest } = init ?? {};
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(WEB + path, { ...rest, headers: { ...(rest.headers as Record<string, string>), ...(login ? { cookie: `omc=oms_${login}` } : {}), origin: WEB } }), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  const window = { matchMedia: null, PublicKeyCredential: function () {}, isSecureContext: true, addEventListener() {} };
  const make = new Function("document", "window", "fetch", "location", "innerWidth", "navigator", "localStorage", `${SHELL}\n${o.script ?? ""}\n return { ${[...FUNCTIONS.map((f) => `${f}: ${f}`), "who: function () { return WHO; }"].join(", ")} };`);
  const ran = make(document, window, fetchAs, { pathname: o.pathname ?? "/status", search: "", origin: WEB }, 1280, navigator, localStorage) as Record<string, any>;
  const ready = new Promise<void>((r) => ran.whoami(() => r()));
  const click = (target: unknown) => (heard.click ?? []).forEach((f) => f({ target }));
  return { ...ran, ready, posted, fetched, created, asked, dialogs, nodes, click } as any;
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
        if (excluded(a, options.publicKey)) throw invalidState();
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
const NEW = ["m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11", "m12", "m13", "m14", "m15", "m16", "m17", "m18", "m19", "m20"];

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
    // A page whose browser knows the login holds one names it (?held=<login>): the pool reads nothing for it, so a maintainer's page view costs what it did before #287 — and another login's answer is read as before.
    const known = (await asPage(F.m1, "GET", `/auth/me?held=${F.m1}`)).json;
    expect(known).toMatchObject({ login: F.m1, role: "maintainer" });
    expect("passkey" in known).toBe(false);
    expect((await asPage("m8", "GET", `/auth/me?held=${F.m1}`)).json).toMatchObject({ login: "m8", role: "maintainer", passkey: false });
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

  it("this browser keeps that a maintainer holds one: its next pages ask the pool nothing for it; a refusal saying none, and a sign-out, make it forget", async () => {
    const store = new Map<string, string>();
    const a = await createAuthenticator();
    const s = shellAs("m14", { pathname: "/status", a, store });
    await s.ready;
    // Nothing known yet: the pool is asked, and says none.
    expect(s.fetched[0]).toBe("/auth/me");
    expect(s.needsPasskey()).toBe(true);
    expect(store.has("op-pk-held")).toBe(false);
    expect((await s.firstPasskey()).passkey?.id).toMatch(/^pk_/);
    expect(store.get("op-pk-held")).toBe("m14");
    // The next page names the login, and the pool reads nothing for it: the page takes the browser's word.
    const next = shellAs("m14", { pathname: "/review", store });
    await next.ready;
    expect(next.fetched[0]).toBe("/auth/me?held=m14");
    expect(next.who().me.passkey).toBe(true);
    expect(next.needsPasskey()).toBe(false);
    expect(next.nodes["#pk-notice"]).toBeUndefined();
    // Its passkey goes behind this browser's back (removed from another browser): the first act that asks for it is refused with none, and the page knows it from then on — the notice back on Review, the dialogs offering the registration, and the browser asking the pool again.
    await env.DB.prepare("DELETE FROM passkeys WHERE login = 'm14'").run();
    const refused = await next.passkeyed("approve:1", () => Promise.reject(new Error("nothing is posted without an answer")));
    expect([refused.__status, refused.code], JSON.stringify(refused)).toEqual([403, "no_passkey"]);
    expect(next.needsPasskey()).toBe(true);
    expect(store.has("op-pk-held")).toBe(false);
    await until(() => next.nodes["#pk-notice"]?.hidden === false, "the notice back on Review");
    const again = shellAs("m14", { pathname: "/review", store });
    await again.ready;
    expect(again.fetched[0]).toBe("/auth/me");
    expect(again.needsPasskey()).toBe(true);
    // Signed out — a reset signs its login out — the browser forgets it.
    store.set("op-pk-held", "m14");
    const out = shellAs(null, { pathname: "/", store });
    await out.ready;
    expect(out.fetched[0]).toBe("/auth/me?held=m14");
    expect(store.has("op-pk-held")).toBe(false);
    // A login the browser does not know is read as before, whatever it remembers of another.
    store.set("op-pk-held", F.m1);
    const other = shellAs("m9", { pathname: "/status", store });
    await other.ready;
    expect(other.needsPasskey()).toBe(true);
    expect(store.get("op-pk-held")).toBe(F.m1);
  });

  it("the notice's own button: the passkey made, the notice says so in its place and takes the keyboard; Not now hands the keyboard to the page's heading", async () => {
    /** A click on the notice's button `cls`, as the document hears it. */
    const pressIn = (s: any, cls: string) => {
      const box = s.nodes["#pk-notice"];
      const t: any = Object.assign(node(), { closest: (sel: string) => (sel === ".pk-notice" ? box : sel === cls ? t : null) });
      s.click(t);
      return t;
    };
    const a = await createAuthenticator();
    const s = shellAs("m15", { pathname: "/review", a });
    await s.ready;
    await until(() => s.nodes["#pk-notice"]?.hidden === false, "the notice");
    const box = s.nodes["#pk-notice"], b = pressIn(s, ".pk-now");
    // While the device asks: the button stays where the keyboard is, and the notice says what to do.
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(box.querySelector(".pk-said").textContent).toBe("Answer your device: your fingerprint, face or PIN.");
    await until(() => box.className === "notice pk-notice ok", "the passkey registered");
    // Done: still drawn, in green, its words saying so — the buttons gone, the keyboard on the words a screen reader reads out; nothing else to dismiss.
    expect(box.hidden).toBe(false);
    expect(box.querySelector(".pk-text").innerHTML).toBe("Your passkey is registered. Approve, block and a forced promotion ask for it from now on.");
    expect(box.querySelector(".pk-text").focused).toBe(true);
    expect(box.querySelector(".pk-text").getAttribute("tabindex")).toBe("-1");
    expect(box.querySelector(".pk-btns").removed).toBe(true);
    expect(box.querySelector(".pk-said").textContent).toBe("");
    expect(box.getAttribute("data-registering")).toBeNull();
    expect(s.nodes["#toasts"]).toBeUndefined();
    expect(s.needsPasskey()).toBe(false);
    expect(await passkeysOf("m15")).toHaveLength(1);
    // Registered elsewhere since the page asked — another tab, or whoever else holds the session: none is made, and the notice says where it is listed and who resets one they did not make.
    const t = shellAs("m16", { pathname: "/user/m16", a: await createAuthenticator() });
    await t.ready;
    await until(() => t.nodes["#pk-notice"]?.hidden === false, "the notice on their page");
    const o = await asPage("m16", "POST", "/auth/passkeys/challenge", {});
    expect((await asPage("m16", "POST", "/auth/passkeys", { label: "another tab", ...(await register(await createAuthenticator(), { challenge: o.json.publicKey.challenge, origin: WEB, rpId: "localhost" })) })).status).toBe(201);
    pressIn(t, ".pk-now");
    await until(() => t.nodes["#pk-notice"].className === "notice pk-notice warn", "the notice's word");
    expect(t.created).toEqual([]);
    expect(t.nodes["#pk-notice"].querySelector(".pk-text").innerHTML).toBe('You hold a passkey already, registered elsewhere: <a href="/user/m16#passkeys">your page</a> lists it. Approve, block and a forced promotion ask for it from now on. If you did not register it, ask another maintainer to reset your passkeys.');
    // Not now, once elsewhere: the notice goes, and the keyboard goes on to the page's heading — never to nowhere.
    const u = shellAs("m17", { pathname: "/status" });
    await u.ready;
    await until(() => u.nodes["#pk-notice"]?.hidden === false, "the notice once");
    pressIn(u, ".pk-later");
    expect(u.nodes["#pk-notice"].hidden).toBe(true);
    expect(u.nodes["main h1"]).toMatchObject({ focused: true });
    expect(u.nodes["main h1"].getAttribute("tabindex")).toBe("-1");
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
    // The text says what the act does; its line about the passkey is the box's, not "Your passkey confirms it" over "You hold no passkey yet".
    expect(d.querySelector(".t").innerHTML).toMatch(/The approval is on the record with your name\.$/);
    press(d);
    await until(() => d.querySelector(".pk").className === "pk ok", "the passkey registered");
    // Registered with the session alone, and the dialog is still open: nothing is decided yet.
    expect(s.posted).toEqual(["/auth/passkeys/challenge", "/auth/passkeys"]);
    expect(d.open).toBe(true);
    expect(d.submit().textContent).toBe("Approve with your passkey");
    expect(d.submit().focused).toBe(true);
    expect(d.querySelector(".pk").innerHTML).toBe("Your passkey is registered. Press Approve with your passkey: your device confirms this with it.");
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
    // Holding one, the dialog is the ordinary one: its line says the passkey confirms it, and no box of the first press.
    const later = s.decideDialog("approve", `guidedagain 1.0-1 (build #${second.project})`, {});
    const d2 = s.dialogs[1];
    expect(d2.querySelector(".t").innerHTML).toMatch(/The approval is on the record with your name\. Your passkey confirms it: your device asks for your fingerprint, face or PIN\.$/);
    expect(d2.querySelector(".pk")).toBeNull();
    expect(d2.submit().textContent).toBe("Approve with your passkey");
    d2.querySelector(".cancel").onclick();
    expect(await later).toBeNull();
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

  it("a passkey registered meanwhile — another tab on this device, or anyone with the session: the dialog makes none, says where it is listed and who resets one they did not make, and its next press confirms with it", async () => {
    const { project } = await reviewed("elsewhere");
    const a = await createAuthenticator();
    // The browser's create() refuses a credential the options exclude that this device holds (InvalidStateError), as a real one does.
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
    await until(() => d.submit().textContent === "Approve with your passkey", "the dialog's next press");
    // The pool's options listed the passkey the login holds: the device was asked for nothing, and nothing more was stored.
    expect(s.created).toEqual([]);
    expect(s.posted).toEqual(["/auth/passkeys/challenge"]);
    expect((await passkeysOf("m10")).length).toBe(1);
    expect(s.needsPasskey()).toBe(false);
    // It may not be theirs — whoever holds the session can register the first: the words say where it is listed and who resets it, in amber.
    expect(d.querySelector(".pk").className).toBe("pk");
    expect(d.querySelector(".pk").innerHTML).toBe('You hold a passkey already, registered elsewhere: <a href="/user/m10#passkeys">your page</a> lists it. Press Approve with your passkey: your device confirms this with it. If you did not register it, ask another maintainer to reset your passkeys.');
    expect(d.submit().focused).toBe(true);
    press(d);
    await done;
    const r = await s.passkeyed(`approve:${project}`, (assertion: unknown) => s.api("POST", `/api/v1/factory/tasks/${project}/approve`, { note: "reads well", assertion }));
    expect(r.__status, JSON.stringify(r)).toBe(200);
  });

  it("two first registrations racing: the one the pool refused as a second goes on with the one it holds; the one whose request a newer one replaced says so, and its next press goes on with the passkey held", async () => {
    // A first registration of the same login stored while this device answered — the moment between this one's challenge and its answer (one registration challenge is live a login, so only the pool's own race gets there): the pool refuses this one as a second (passkey_required), and the dialog goes on with the one held.
    const other = await createAuthenticator(), mine = await createAuthenticator();
    const s = shellAs("m18", { pathname: "/review", a: mine, create: async (options: any) => {
      await env.DB.prepare("INSERT INTO passkeys (id, login, credential_id, public_key, alg, rp_id, label) VALUES (?, 'm18', ?, ?, -7, 'localhost', 'another device')").bind(`pk_${"a".repeat(32)}`, b64url(other.credentialId), b64url(other.cose)).run();
      const k = options.publicKey, r = await register(mine, { challenge: b64url(k.challenge), origin: WEB, rpId: k.rp.id });
      return { rawId: unb64url(r.id).buffer, response: { clientDataJSON: unb64url(r.clientDataJSON).buffer, attestationObject: unb64url(r.attestationObject).buffer } };
    } });
    await s.ready;
    expect(await s.firstPasskey("Nothing was decided.")).toEqual({ held: true });
    expect(s.needsPasskey()).toBe(false);
    expect(await passkeysOf("m18")).toHaveLength(1);
    // Two tabs of one login press at once: the later request replaces the earlier's challenge, so the earlier's answer is refused — in the dialog's words, not the person page's — and its next press goes on with the passkey the later one stored, asking the device for nothing.
    const a = await createAuthenticator();
    let answer: () => void = () => {};
    const waited = new Promise<void>((r) => (answer = r));
    const first = shellAs("m19", { pathname: "/review", a, create: async (options: any) => {
      await waited;
      const k = options.publicKey, r = await register(a, { challenge: b64url(k.challenge), origin: WEB, rpId: k.rp.id });
      return { rawId: unb64url(r.id).buffer, response: { clientDataJSON: unb64url(r.clientDataJSON).buffer, attestationObject: unb64url(r.attestationObject).buffer } };
    } });
    const later = shellAs("m19", { pathname: "/status", a });
    await first.ready;
    await later.ready;
    const pending = first.firstPasskey("Nothing was decided.");
    await until(() => first.created.length === 1, "the first tab's device asked");
    expect((await later.firstPasskey("Nothing was queued.")).passkey?.id).toMatch(/^pk_/);
    answer();
    expect(await pending).toEqual({ error: "A newer passkey request of yours replaced this one: press again. Nothing was decided.", code: "challenge" });
    expect(first.needsPasskey()).toBe(true);
    expect(await first.firstPasskey("Nothing was decided.")).toEqual({ held: true });
    expect(first.created).toHaveLength(1);
    expect(first.needsPasskey()).toBe(false);
    expect(await passkeysOf("m19")).toHaveLength(1);
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
    p.ran.registerFirst(go);
    // While the device asks, the confirmation says so where a screen reader hears it (#rv-confirm-pk, a status), and Confirm keeps the focus: never disabled.
    expect(p.nodes["#rv-confirm-pk"].innerHTML).toBe("Answer your device: your fingerprint, face or PIN.");
    expect(go.disabled).not.toBe(true);
    await until(() => (p.nodes["#rv-confirm-go"].innerHTML as string).includes("Confirm with your passkey"), "the confirmation's next press");
    expect(go.disabled).not.toBe(true);
    expect(p.nodes["#rv-confirm-pk"].innerHTML).toBe("Your passkey is registered. Confirm, and your device approves with it.");
    // The text no longer says a passkey will be made, nor twice that one confirms it.
    expect(p.nodes["#rv-confirm-t"].textContent).toMatch(/The project's build enters edge\.$/);
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
    // While the device asks, the form says so in its status line, and Block keeps the focus.
    expect(p.nodes["#you-ask .pk"].textContent).toBe("Answer your device: your fingerprint, face or PIN.");
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

  it("an agent's draft: its page offers Register a passkey and approve, then Confirm with your passkey — the draft confirmed with the passkey made there, the line saying so", async () => {
    // m20's agent, logged in as omarchy-cli does it: the grant page, Grant, the loopback's code, the swap.
    const page = async (method: "GET" | "POST", path: string, form?: Record<string, string>) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(WEB + path, { method, redirect: "manual", headers: { cookie: "omc=oms_m20", ...(form ? { origin: WEB, "content-type": "application/x-www-form-urlencoded" } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined }), env, ctx);
      await waitOnExecutionContext(ctx);
      return { status: res.status, text: await res.text(), location: res.headers.get("location") };
    };
    const hidden = (html: string): Record<string, string> => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([a-z_]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")]));
    const verifier = "verifier-m20-guided-".padEnd(64, "x");
    const q = new URLSearchParams({ agent: "Claude Code", scopes: "contribute,review,block", port: "48123", state: "state-" + "s".repeat(16), challenge: await s256(verifier), method: "S256" });
    const granted = await page("POST", "/auth/agent", { ...hidden((await page("GET", `/auth/agent?${q}`)).text), action: "grant" });
    expect(granted.status, granted.text.slice(0, 400)).toBe(303);
    const swapped = await raw("POST", "/auth/agent/token", { "content-type": "application/json", "cf-connecting-ip": "10.20.0.1" }, { code: new URL(granted.location!).searchParams.get("code"), code_verifier: verifier });
    expect(swapped.status, JSON.stringify(swapped.json)).toBe(200);
    const { project } = await reviewed("agentfirst");
    const drafted = await call("POST", "/factory/drafts", { name: "agentfirst", task: project, verdict: "approve", note: "reads well" }, swapped.json.token);
    expect(drafted.json.state, JSON.stringify(drafted.json)).toBe("waiting");
    // The agent tells its person before the page: the page registers the passkey, then confirms with it.
    expect(drafted.json.next).toBe("m20 has no passkey yet, and an approval is confirmed with one: open the link in a browser signed in as m20. The page registers one on that device, then confirms with it: your device asks for your fingerprint, face or PIN. Nothing is decided until then.");
    const d = drafted.json.draft as string;
    const html = (await page("GET", `/auth/confirm/${d}`)).text;
    expect(html).toContain('data-next="Confirm with your passkey: approve agentfirst"');
    expect(html).toContain("Register a passkey and approve agentfirst</button>");
    expect(html).toContain("You hold no passkey yet. The first press makes one on this device, and the next confirms the draft with it.");
    expect(html).toMatch(/<p class="said" id="pk-said" role="status" aria-live="polite"><\/p>/);
    expect(html).not.toContain("Register a passkey first.");
    // The page's script, run as the browser runs it after the shell, with the form it serves and the software authenticator.
    const inputs: Record<string, any> = {};
    const form: any = {
      heard: {} as Record<string, (ev: unknown) => void>, submitted: false, elements: { nonce: { value: hidden(html).nonce } },
      addEventListener(t: string, f: (ev: unknown) => void) { this.heard[t] = f; }, getAttribute: (k: string) => (k === "action" ? `/auth/confirm/${d}` : null),
      querySelector: (sel: string) => inputs[/name="([a-z_]+)"/.exec(sel)?.[1] ?? ""] ?? null, appendChild(i: any) { inputs[i.name] = i; return i; }, submit() { this.submitted = true; },
    };
    const label = { textContent: "Register a passkey and approve agentfirst" };
    const btn = Object.assign(node(), { form, tagName: "BUTTON", value: "confirm", lastChild: label });
    btn.setAttribute("data-next", "Confirm with your passkey: approve agentfirst");
    const said = node(), note = node();
    note.setAttribute("data-next", /<p id="pk-note" data-next="([^"]*)">/.exec(html)![1]);
    const a = await createAuthenticator();
    const s = shellAs("m20", { pathname: `/auth/confirm/${d}`, a, script: CONFIRM_SCRIPT, byId: { "pk-confirm": btn, "pk-said": said, "pk-note": note } });
    await s.ready;
    const submit = () => form.heard.submit({ submitter: btn, preventDefault() {} });
    submit();
    expect(said.textContent).toBe("Answer your device: your fingerprint, face or PIN.");
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    await until(() => label.textContent === "Confirm with your passkey: approve agentfirst", "Confirm's next press");
    expect(btn.getAttribute("data-next")).toBeNull();
    expect(btn.getAttribute("aria-disabled")).toBeNull();
    expect(said.innerHTML).toBe("Your passkey is registered. Press Confirm with your passkey: your device confirms the draft with it.");
    // The note above it says what a holder's says: no "You hold no passkey yet" over "Your passkey is registered".
    expect(note.textContent).toBe("Confirm asks for your passkey. Your device asks for your fingerprint, face or PIN, which no agent's software can supply. The pool checks the answer against the key you registered.");
    expect(s.posted).toEqual(["/auth/passkeys/challenge", "/auth/passkeys"]);
    expect(await env.DB.prepare("SELECT state FROM drafts WHERE id = ?").bind(d).first()).toEqual({ state: "waiting" });
    // The next press: the draft's own challenge, the passkey's answer, the form posted.
    submit();
    await until(() => form.submitted, "the form posted");
    expect(s.posted.slice(2)).toEqual([`/auth/confirm/${d}/challenge`]);
    expect(Object.keys(inputs).sort()).toEqual(["action", "authenticator_data", "client_data", "credential", "signature", "user_handle"]);
    const done = await page("POST", `/auth/confirm/${d}`, { ...hidden(html), ...Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, String(i.value)])) });
    expect(done.status, done.text.slice(0, 600)).toBe(200);
    expect(done.text).toContain("confirmed in the browser with a passkey registered just now.");
    const [held] = await passkeysOf("m20");
    const l = (await line("approve", "task", project))!;
    expect(l.summary).toMatch(/^agentfirst 1\.0 \(x86_64\) approved by m20 — drafted by Claude Code, confirmed in the browser with a passkey registered just now/);
    expect(l.payload.through).toMatchObject({ draft: d, passkey: held, registered_just_now: true });
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
