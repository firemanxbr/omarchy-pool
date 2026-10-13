/**
 * The legacy worker path is gone (#346, design v2 §21.4; S3, S8): once every
 * host had switched to the host agent, no legacy registration is made any
 * more, the Workers page lists only hosts, and the pages the Worker serves —
 * the docs above all — describe the maintainers' hosts: one bundle, one
 * isolated, credential-less container per task, capacity and lanes,
 * emulation, the isolation model with the invariants of design v2 §10.2 and
 * the levels of §19.3; never role containers (the pool, review and project
 * workers among them), the updater, the broker's relay or a contributor-run
 * worker. tests/legacy-path-gone.sh checks the
 * repository's side: the files gone, nothing naming them.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { GONE, HOST_DOCS } from "../src/routes/contributors";
import { DOCS_TREE } from "../src/pages/docs-tree";
import { DOC_DIAGRAMS } from "../src/pages/doc-diagrams";
import { seedDashboard, type Fixture } from "./fixture";

let F: Fixture;

beforeAll(async () => {
  F = await seedDashboard(env);
});

async function get(path: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, text: await res.text() };
}

describe("no legacy registration is made any more (#346)", () => {
  it("POST /factory/workers answers a maintainer 410 with why and the pointer to the maintainer-host docs, and writes nothing", async () => {
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM build_workers").first<{ n: number }>())!.n;
    const r = await get("/api/v1/factory/workers", { method: "POST", headers: { cookie: `omc=oms_${F.m1}`, "content-type": "application/json" }, body: JSON.stringify({ name: "studio-community", arch: F.arch }) });
    expect(r.status, r.text).toBe(410);
    expect(JSON.parse(r.text)).toEqual({ error: GONE.register, code: "gone", docs: HOST_DOCS });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM build_workers").first<{ n: number }>())!.n).toBe(before);
  });
});

describe("the pages describe the maintainers' hosts, never the legacy role containers (#346)", () => {
  // What the legacy sets ran with and were made of, each on a page it was on: none may come back.
  const GONE_WORDS = [
    "role container", "omarchy-rollout", "rollout.sh", "register.sh", "factory/host/setup.sh", "factory/image/compose.yml", "factory/host/compose.yml",
    "agent-proxy", "behind a broker", "OMARCHY_BROKER", "OMARCHY_WORKER_ROLE=updater", "omarchy-worker start", "Run a worker", "The three roles",
    "community set", "a community worker", "Legacy registrations", "<h2>Legacy",
    // The legacy sets' role containers by the names the docs gave them (`review worker` matches `review workers` too).
    "review worker", "pool worker", "project worker",
  ];
  const PAGES = ["/workers", "/docs", "/docs/glossary", "/api", ...new Set(DOCS_TREE.map((c) => c.href.replace(/#.*$/, "")))];

  it("every docs chapter, the docs index and glossary, the API page and the Workers page carry none of them", async () => {
    expect(PAGES).toEqual(expect.arrayContaining(["/docs/workers", "/docs/security-model", "/docs/factory", "/docs/worker-host", "/docs/runbook", "/docs/architecture", "/docs/testing"]));
    for (const path of PAGES) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      // testing.md describes the tests of what the Worker still keeps for a legacy registration not yet retired (its Update order,
      // set_rollout): it is held to the files, not to the words (tests/legacy-path-gone.sh).
      const words = path === "/docs/testing" ? GONE_WORDS.filter((w) => /[/.]/.test(w)) : GONE_WORDS;
      for (const w of words) expect(r.text, `${path}: ${w}`).not.toContain(w);
    }
    // The pages How it works and the docs index write in code, the API page's and every diagram a chapter draws: each on a page above,
    // and checked here by name too, so a diagram no chapter draws yet cannot bring one back.
    expect(PAGES).toEqual(expect.arrayContaining(["/docs", "/docs/how-it-works", "/api"]));
    for (const [name, draw] of Object.entries(DOC_DIAGRAMS)) {
      const svg = draw();
      for (const w of GONE_WORDS) expect(svg, `diagram ${name}: ${w}`).not.toContain(w);
    }
  });

  it("the security model says the trust levels and the isolation model: the invariants of design v2 §10.2 and the levels of §19.3", async () => {
    const t = (await get("/docs/security-model")).text;
    for (const s of [
      "packages only", "no worker is trusted one by one",
      // The pieces of a host and what each holds.
      "the dispatcher (the host set&#39;s one service", "a task&#39;s egress sidecar", "a task&#39;s agent sidecar", "a task container",
      // The nine invariants, by their first words.
      "No task container holds a token, key, password or socket, ever", "No container that runs recipe or package code can cause a write to the",
      "No process that holds the runtime socket, a pool token or a job token is", "The pool&#39;s signing key never leaves the pool",
      "The dispatcher never holds an agent key or a", "No agent process serves more than one task", "The host key never enters a container",
      "A task container reaches only public addresses", "A contributor&#39;s task never mounts a project cache",
      // The levels.
      "<code>subuid</code>", "<code>user</code>", "<code>root</code>", "<code>vm</code>", "<code>vm-shared</code>", "a recorded exception, until P6",
    ]) expect(t.replace(/'/g, "&#39;"), s).toContain(s);
  });

  it("the factory chapter says whose compute it is, the three roles of one image, capacity and lanes, and emulation as part of scaling", async () => {
    const t = (await get("/docs/factory")).text;
    for (const s of ["The project&#39;s compute is its maintainers&#39; hosts", "Three roles, no fixed container.", "Capacity and lanes.", "Emulation is part of scaling.", "Adding hosts is how the pool grows"]) {
      expect(t.replace(/'/g, "&#39;"), s).toContain(s);
    }
  });

  it("the worker host chapter and Run a host say how a host joins: the hosting requirement, prep-root.sh, enrollment and Confirm", async () => {
    const host = (await get("/docs/worker-host")).text.replace(/'/g, "&#39;");
    for (const s of ["The hosting requirement", "prep-root.sh", "a dedicated machine or VM", "a shared machine with a dedicated Unix user", "+ add a host", "Confirm"]) expect(host, s).toContain(s);
    const run = (await get("/docs/workers")).text;
    expect(run).toContain("<h1>Run a host</h1>");
    for (const id of ["hosts", "image", "before", "add", "capacity", "claude-code", "secrets", "running", "orders"]) expect(run, id).toContain(`<section id="${id}">`);
    expect(DOCS_TREE.find((c) => c.key === "workers")?.label).toBe("Run a host");
  });
});
