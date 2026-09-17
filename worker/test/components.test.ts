/**
 * Every component a page declares (src/pages/components.ts), checked
 * against the served dashboard on the fixture (test/fixture.ts): its
 * anchor is in the page's HTML and its literals in the page's script; what
 * it reads is routed and answers JSON with the fields it draws; what it
 * does is routed with its method — and with no other — and answers per
 * role what the manifest says. The other way round too: an endpoint a
 * page script fetches with nobody claiming it. Deleting the route, the
 * element or the field a component lives on fails here by name; the acorn
 * walk in pages.test.ts covers the script's own names. Every check is a
 * soft assertion: one run names every component the broken thing was
 * holding up, not the first.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { allComponents, type Component, type Role } from "../src/pages/components";
import { seedDashboard, type Fixture } from "./fixture";

let F: Fixture;
let COMPONENTS: Component[];

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
  const text = /^(text\/|application\/(json|manifest))/.test(type) ? await res.text() : ((await res.arrayBuffer()), "");
  return { status: res.status, type, text };
}

/** A dotted key on a JSON answer: "events.0.kind"; undefined once a step is missing, a null leaf is a value. */
const at = (o: unknown, dotted: string): unknown => dotted.split(".").reduce<any>((v, k) => (v == null ? undefined : v[k]), o);
const scriptOf = (html: string): string => [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");

const pages = new Map<string, string>();
async function served(page: string): Promise<string> {
  if (!pages.has(page)) {
    const r = await call("GET", page);
    expect(r.status, page).toBe(200);
    pages.set(page, r.text);
  }
  return pages.get(page)!;
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
      const script = scriptOf(html);
      for (const a of [c.anchor].flat()) expect.soft(html, `${c.id}: anchor ${a} on ${c.page}`).toContain(a);
      for (const s of c.script ?? []) expect.soft(script, `${c.id}: script literal ${s} on ${c.page}`).toContain(s);
    }
  });

  /** The one body a missing route gives (index.ts); a routed read that has nothing to say says something else. */
  const routed = (res: { status: number; text: string }): "routed" | "unrouted" => (res.status === 404 && /^\{"error":"not found"\}$/.test(res.text) ? "unrouted" : "routed");

  it("reads endpoints that are routed and answer JSON with the fields it draws", async () => {
    for (const c of COMPONENTS) {
      for (const r of c.reads ?? []) {
        const res = await call("GET", r.path, r.as);
        if (routed(res) === "unrouted") {
          expect.soft("unrouted", `${c.id}: GET ${r.path} is unrouted`).toBe("routed");
          continue;
        }
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
        // The route exists for this method: whatever it answers without a session, it is not the generic 404.
        const probe = await call(a.method, a.path);
        if (routed(probe) === "unrouted") {
          expect.soft("unrouted", `${c.id}: ${a.method} ${a.path} is unrouted`).toBe("routed");
          continue;
        }
        // …and not for another method: the method is part of the route.
        const wrong = await call("PATCH", a.path, "maintainer");
        expect.soft(wrong.status, `${c.id}: PATCH ${a.path} should be 404`).toBe(404);
        for (const [role, want] of Object.entries(a.expect) as [Role, number | number[]][]) {
          const res = await call(a.method, a.path, role, a.body ?? {});
          expect.soft([want].flat(), `${c.id}: ${a.method} ${a.path} as ${role} → ${res.status} ${res.text.slice(0, 120)}`).toContain(res.status);
        }
      }
    }
  });

  it("declares every endpoint the page scripts fetch", async () => {
    // Drift the other way: a fetch("/api/v1/…") in a page with no component claiming it. The claimed paths are
    // compared without their query and with the fixture's ids and names replaced, so a script's prefix matches.
    const bound = new RegExp(`/(${[F.pkg, F.pkg2, F.contributor, F.owner, F.m1, F.m2, F.blockedContributor, F.factoryPkg, F.publishedPkg, F.blockedPkg, F.worker, F.communityWorker].join("|")})(/|$)`, "g");
    const claimed = new Set(
      COMPONENTS.flatMap((c) => [...(c.reads ?? []).map((r) => r.path.split("?")[0]), ...(c.acts ?? []).map((a) => a.path)]).map((p) => p.replace(/\/\d+(\/|$)/g, "/N$1").replace(bound, "/X$2")),
    );
    for (const page of new Set(COMPONENTS.map((c) => c.page))) {
      const script = scriptOf(await served(page));
      for (const m of script.matchAll(/"(\/api\/v1\/[a-z0-9/_-]+|\/auth\/me)/g)) {
        const hit = [...claimed].some((p) => p.startsWith(m[1].replace(/\/$/, "")));
        expect.soft(hit, `${page}: the script fetches ${m[1]} and no component declares it`).toBe(true);
      }
    }
  });
});
