/**
 * The journal's door and its rows: any job token may POST /events, and the
 * Journal, the Pipeline's feed and the Status incidents draw the payload for
 * every reader — so the two fields the pages write into an address are
 * checked at the door (an https run link, a release's id) and, for a row that
 * predates the check, drawn only when they are what the page expects.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { issueJobToken, scopesFor } from "../src/jobtoken";
import { runScript, scriptOf, seedDashboard } from "./fixture";

const API = "http://pool.test/api/v1";

async function post(path: string, body: unknown, token: string): Promise<{ status: number; json: any }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(API + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function get(path: string): Promise<string> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res.text();
}

// A pool job's token (the project's sync) and a community build's, with the scopes scopesFor gives each.
let token: string;
let community: string;
beforeAll(async () => {
  await seedDashboard(env);
  const e = Math.floor(Date.now() / 1000) + 3600;
  token = await issueJobToken(env, { t: 2, k: "sync", s: scopesFor("sync", 2, "project", { ring: "edge" }), e, w: "w-pool" });
  community = await issueJobToken(env, { t: 1, k: "build", s: scopesFor("build", 1, "community", {}), e, w: "w-test" });
});

const BAD_URL = "javascript:alert(document.cookie)";
const BAD_ID = '1"><img src=x onerror=alert(1)>';

describe("the journal's door", () => {
  // The gate reads health and abi rows as evidence, the Status page as the ring's state: a community build's token cannot post any of it — the door is the project's jobs' alone.
  it("refuses a community build's token, whatever it posts", async () => {
    const forged = { kind: "health", ring: "edge", source: "x86_64", status: "error", summary: "edge x86_64 failed its health check" };
    expect((await post("/events", forged, community)).status).toBe(403);
    expect((await post("/events", { kind: "build", summary: "built" }, community)).status).toBe(403);
    const health = JSON.parse(await get("/api/v1/events?kind=health&limit=200")) as { events: { summary: string }[] };
    expect(health.events.some((e) => e.summary === forged.summary)).toBe(false);
  });

  it("takes a job's event with an https run link and a release id, and refuses any other link or id", async () => {
    expect((await post("/events", { kind: "build", summary: "built", payload: { ci: { run_url: "https://github.com/o/r/actions/runs/1" }, release_id: 7 } }, token)).status).toBe(201);
    expect((await post("/events", { kind: "build", summary: "built", payload: { note: "no link at all" } }, token)).status).toBe(201);
    const url = await post("/events", { kind: "build", summary: "built", payload: { ci: { run_url: BAD_URL } } }, token);
    expect(url.status).toBe(400);
    expect(url.json.error).toContain("run_url");
    expect((await post("/events", { kind: "build", summary: "built", payload: { ci: { run_url: "http://example.org/run" } } }, token)).status).toBe(400);
    const id = await post("/events", { kind: "promote", ring: "edge", summary: "promoted", payload: { release_id: BAD_ID } }, token);
    expect(id.status).toBe(400);
    expect(id.json.error).toContain("release_id");
    expect((await post("/events", { kind: "promote", ring: "edge", summary: "promoted", payload: { release_id: 1.5 } }, token)).status).toBe(400);
  });
});

describe("the journal's rows", () => {
  // A row written before the door checked, or by hand in D1: the shell's eventRow and the Pipeline's feedRow draw it without the link and without the id; the Status incidents row is inline and pinned by its manifest to runHref().
  const stored = { id: 1, kind: "promote", ring: "edge", source: null, status: "ok", summary: "promoted <b>x</b>", created_at: new Date().toISOString(), duration_ms: 10, payload: { ci: { run_url: BAD_URL }, release_id: BAD_ID } };
  const clean = { ...stored, payload: { ci: { run_url: "https://github.com/o/r/actions/runs/1" }, release_id: 42 } };

  it("the shell's eventRow links only an https run and a numeric release", async () => {
    const { eventRow } = runScript(scriptOf(await get("/journal")), { pathname: "/journal", functions: ["eventRow"] });
    const bad = eventRow(stored);
    expect(bad).not.toContain("javascript:");
    expect(bad).not.toContain("<img");
    expect(bad).not.toContain("/diff?");
    expect(bad).toContain("promoted &lt;b&gt;x&lt;/b&gt;");
    const good = eventRow(clean);
    expect(good).toContain('href="https://github.com/o/r/actions/runs/1"');
    expect(good).toContain('href="/diff?ring=edge&to=42"');
  });

  it("the Pipeline's feedRow links only an https run", async () => {
    const { feedRow } = runScript(scriptOf(await get("/pipeline")), { pathname: "/pipeline", functions: ["feedRow"] });
    const bad = feedRow(stored, false);
    expect(bad).not.toContain("javascript:");
    expect(bad).toContain("promoted &lt;b&gt;x&lt;/b&gt;");
    expect(feedRow(clean, false)).toContain('href="https://github.com/o/r/actions/runs/1"');
  });
});
