/**
 * Every component a page declares (src/pages/components.ts), checked
 * against the served dashboard on the fixture (test/fixture.ts): its
 * anchor is in the page's HTML and its literals in the page's script; what
 * it reads is routed and answers JSON with the fields it draws; what it
 * does is routed with its method — and with no other — and answers per
 * role what the manifest says. The other way round too: every path a
 * page's script fetches is claimed by an entry on that page or on the
 * shell. Deleting the route, the element or the field a component lives on
 * fails here by name; the acorn walk in pages.test.ts covers the script's
 * own names. Every check is a soft assertion: one run names every
 * component the broken thing was holding up, not the first.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { allComponents, SHELL_COMPONENTS, type Component, type Role } from "../src/pages/components";
import { scriptOf, seedDashboard, type Fixture } from "./fixture";

let F: Fixture;
let COMPONENTS: Component[];

/** The roles in the order an act's expectations run, whatever order the manifest typed them in: the first call as a maintainer comes last. */
const ROLES: Role[] = ["anonymous", "contributor", "owner", "maintainer"];

beforeAll(async () => {
  F = await seedDashboard(env);
  COMPONENTS = allComponents(F);
});

async function call(method: string, path: string, as: Role = "anonymous", body?: unknown): Promise<{ status: number; type: string; text: string }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  // The browser's cookie, as tests/e2e-worker.sh sends it.
  if (as !== "anonymous") headers.cookie = `omc=${F.sessions[as]}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  const type = res.headers.get("content-type") ?? "";
  // An icon is bytes, not text: read it as such so the runtime does not warn.
  let text = "";
  if (/^(text\/|application\/(json|manifest))/.test(type)) text = await res.text();
  else await res.arrayBuffer();
  return { status: res.status, type, text };
}

/** A dotted key on a JSON answer: "events.0.kind"; undefined once a step is missing, a null leaf is a value. */
const at = (o: unknown, dotted: string): unknown => dotted.split(".").reduce<any>((v, k) => (v == null ? undefined : v[k]), o);

/** A page's HTML, fetched once; "" for a page that does not answer 200, which is reported once and then skipped. */
const pages = new Map<string, string>();
async function served(page: string): Promise<string> {
  if (!pages.has(page)) {
    const r = await call("GET", page);
    expect.soft(r.status, page).toBe(200);
    pages.set(page, r.status === 200 ? r.text : "");
  }
  return pages.get(page)!;
}

/** The one body a missing route gives (index.ts); a routed read that has nothing to say says something else. */
const routed = (res: { status: number; text: string }): "routed" | "unrouted" => (res.status === 404 && /^\{"error":"not found"\}$/.test(res.text) ? "unrouted" : "routed");

/**
 * The end of a JavaScript expression starting at `from`: the index of the
 * first `,`, `;` or closing bracket at the top level, outside any string.
 */
function endOfExpression(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") { if (depth === 0) return i; depth--; }
    else if ((ch === "," || ch === ";") && depth === 0) return i;
  }
  return src.length;
}

/**
 * The path an expression asks for, as a shape: a string literal is itself,
 * a variable declared from a literal path (`API`, `url`) is that path, and
 * anything else — an id, a name, a call, a bracketed choice — is one
 * segment, `X`; the query is dropped. `"/api/v1/users/" +
 * encodeURIComponent(login) + (own ? "?t=" + Date.now() : "")` is
 * `/api/v1/users/X`, `API + "/tasks/" + id + "/" + what` is
 * `/api/v1/factory/tasks/X/X`.
 */
function shapeOf(expr: string, vars: Map<string, string>): string {
  let out = "";
  for (let i = 0; i < expr.length; ) {
    const ch = expr[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      for (; j < expr.length && expr[j] !== ch; j++) if (expr[j] === "\\") j++;
      out += expr.slice(i + 1, j);
      i = j + 1;
    } else if (ch === "(") {
      i = endOfExpression(expr, i + 1) + 1;
      out += "X";
    } else if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[\w$]/.test(expr[j])) j++;
      const name = expr.slice(i, j);
      out += expr[i - 1] === "." ? "X" : (vars.get(name) ?? "X");
      i = j;
    } else {
      if (!/[\s+]/.test(ch)) out += "X";
      i++;
    }
  }
  return out.replace(/X+/g, "X").split("?")[0];
}

/** Every `var name = "/…"` in a script, the paths a fetch is built from. */
function pathVariables(script: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of script.matchAll(/\bvar\s+/g)) {
    let i = m.index! + m[0].length;
    for (;;) {
      const name = /^[A-Za-z_$][\w$]*/.exec(script.slice(i))?.[0];
      if (!name) break;
      i += name.length;
      while (script[i] === " ") i++;
      if (script[i] !== "=") break;
      i++;
      while (script[i] === " ") i++;
      const end = endOfExpression(script, i);
      const expr = script.slice(i, end);
      if (/^"\//.test(expr)) vars.set(name, shapeOf(expr, vars));
      if (script[end] !== ",") break;
      i = end + 1;
      while (/\s/.test(script[i])) i++;
    }
  }
  return vars;
}

/** The paths a page's script fetches, as shapes — through `fetch(…)`, through the shell's `api(method, path)` (a whole path), and through the page's `call(method, path)` helper where it still has one (a path under its `API`). */
function fetched(script: string): string[] {
  const vars = pathVariables(script);
  const api = vars.get("API") ?? "";
  const shapes: string[] = [];
  for (const m of script.matchAll(/\bfetch\(/g)) shapes.push(shapeOf(script.slice(m.index! + m[0].length, endOfExpression(script, m.index! + m[0].length)), vars));
  for (const m of script.matchAll(/\bapi\("(?:GET|POST|PUT|DELETE)",\s*/g)) shapes.push(shapeOf(script.slice(m.index! + m[0].length, endOfExpression(script, m.index! + m[0].length)), vars));
  for (const m of script.matchAll(/\bcall\("(?:GET|POST|PUT|DELETE)",\s*/g)) shapes.push(api + shapeOf(script.slice(m.index! + m[0].length, endOfExpression(script, m.index! + m[0].length)), vars));
  // A shape that is not a path of this origin (an evidence file's URL) says nothing; `API + path` is the helper itself, whose callers are read above.
  return shapes.filter((s) => s.startsWith("/") && s !== `${api}X`);
}

describe("every component the pages declare", () => {
  it("has an id of its own", () => {
    const ids = COMPONENTS.map((c) => c.id);
    expect(ids.length).toBeGreaterThan(0);
    expect([...new Set(ids)].length, `duplicated: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(", ")}`).toBe(ids.length);
  });

  it("is in the served HTML at its anchor, and its script names what it draws", async () => {
    for (const c of COMPONENTS) {
      const html = await served(c.page);
      if (!html) continue;
      const script = scriptOf(html);
      for (const a of [c.anchor].flat()) expect.soft(html, `${c.id}: anchor ${a} on ${c.page}`).toContain(a);
      for (const s of c.script ?? []) expect.soft(script, `${c.id}: script literal ${s} on ${c.page}`).toContain(s);
    }
  });

  it("reads endpoints that are routed and answer JSON with the fields it draws", async () => {
    for (const c of COMPONENTS) {
      for (const r of c.reads ?? []) {
        const res = await call("GET", r.path, r.as);
        const route = routed(res);
        expect.soft(route, `${c.id}: GET ${r.path} is unrouted`).toBe("routed");
        if (route === "unrouted") continue;
        if (res.status !== (r.status ?? 200)) {
          expect.soft(res.status, `${c.id}: GET ${r.path} as ${r.as ?? "anonymous"} → ${res.text.slice(0, 120)}`).toBe(r.status ?? 200);
          continue;
        }
        if (r.json === false) continue;
        if (!/^application\/json/.test(res.type)) {
          expect.soft(res.type, `${c.id}: ${r.path} is not JSON`).toMatch(/^application\/json/);
          continue;
        }
        const body = JSON.parse(res.text);
        for (const f of r.fields ?? []) expect.soft(at(body, f), `${c.id}: ${r.path} lacks ${f} in ${res.text.slice(0, 200)}`).not.toBeUndefined();
      }
    }
  });

  it("acts through endpoints that are routed with the declared method and gated by role", async () => {
    for (const c of COMPONENTS) {
      for (const a of c.acts ?? []) {
        // The route exists for this method: whatever it answers, it is not the generic 404. The probe is a contributor
        // who owns nothing and reviews nothing, so no route performs the act for him — and every route answers him
        // rather than the 401 the factory's prefixes give to nobody at all, which would hide a route that is gone.
        const probe = await call(a.method, a.path, "contributor");
        const route = routed(probe);
        expect.soft(route, `${c.id}: ${a.method} ${a.path} is unrouted`).toBe("routed");
        if (route === "unrouted") continue;
        // …and not for another method: the method is part of the route.
        const wrong = await call("PATCH", a.path, "maintainer");
        expect.soft(wrong.status, `${c.id}: PATCH ${a.path} should be 404`).toBe(404);
        for (const role of ROLES) {
          const want = a.expect[role];
          if (want === undefined) continue;
          const res = await call(a.method, a.path, role, a.body ?? {});
          expect.soft([want].flat(), `${c.id}: ${a.method} ${a.path} as ${role} → ${res.status} ${res.text.slice(0, 120)}`).toContain(res.status);
        }
      }
    }
  });

  it("declares every endpoint the page scripts fetch", async () => {
    // Drift the other way: a fetch in a page's script with no component on that page claiming its path. A shape's
    // `X` stands for one segment of whatever the script puts there, so `/api/v1/factory/tasks/X/X` is claimed by an
    // act on `/api/v1/factory/tasks/2/approve`. Pages that run the same script are one page — /factory and its old
    // address, a person's page for each person, the request form with and without a renewal — so what any of them
    // claims counts for all; the shell's entries hold for every page, as its script does.
    const shell = SHELL_COMPONENTS(F);
    const claims = (cs: Component[]): string[] => cs.flatMap((c) => [...(c.reads ?? []).map((r) => r.path), ...(c.acts ?? []).map((a) => a.path)]).map((p) => p.split("?")[0]);
    const matches = (shape: string, claimed: string[]): boolean => {
      const re = new RegExp(`^${shape.split("X").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
      return claimed.some((p) => re.test(p));
    };
    const scripts = new Map<string, string>();
    for (const page of new Set(COMPONENTS.map((c) => c.page))) scripts.set(page, scriptOf(await served(page)));
    for (const [page, script] of scripts) {
      if (!script) continue;
      const same = [...scripts].filter(([, s]) => s === script).map(([p]) => p);
      const claimed = claims([...COMPONENTS.filter((c) => same.includes(c.page)), ...shell]);
      for (const shape of new Set(fetched(script))) expect.soft(matches(shape, claimed), `${page}: the script fetches ${shape} and no component on the page declares it`).toBe(true);
    }
  });
});
