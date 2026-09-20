/**
 * The package page's exposure, and the cost of the two lookups that go
 * from a list of names into a ring. The first block reads the page over
 * the fixture (test/fixture.ts): xz declares zlib and loads libz.so.1, the
 * advisory is on stable's zlib, so xz's page must list it under `exposed`
 * with the way in — the field the ring lookup feeds, which no other test
 * read. The second block seeds a ring the size of a small one and measures
 * the lookups the way test/graph.test.ts measures the closure: D1's own
 * rows_read, bounded by the names asked for, never by the ring. Left to
 * the planner, both walked every member of the ring for every call (64.8 k
 * rows a page view; 1.6 B rows a day under the crawl of 2026-09-19 — the
 * pool's largest reader), so a planner regression fails here.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { providersInRing } from "../src/routes/search";
import { cleanIn } from "../src/routes/security";
import { seedDashboard, type Fixture } from "./fixture";

const API = "http://pool.test/api/v1";

async function call(path: string): Promise<{ status: number; json: any }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(API + path), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

let F: Fixture;

beforeAll(async () => {
  F = await seedDashboard(env);
});

describe("the package page's exposure", () => {
  it("lists an open advisory of what the package depends on or loads, and says the way in: via, declared, sonames", async () => {
    const xz = await call(`/package/${F.pkg2}?ring=stable&arch=${F.arch}`);
    expect(xz.status).toBe(200);
    expect(xz.json.security.advisories).toEqual([]);
    expect(xz.json.security.exposed).toHaveLength(1);
    expect(xz.json.security.exposed[0]).toMatchObject({
      via: F.pkg,
      declared: true,
      sonames: ["libz.so.1"],
      advisory: { id: "arch:AVG-9999:zlib", tracker: "arch", cves: ["CVE-2099-0001"], severity: "high", match: "exact", kev: true, epss: 0.9 },
    });
    // The vulnerable object itself carries the advisory and is exposed through nothing.
    const zlib = await call(`/package/${F.pkg}?ring=stable&arch=${F.arch}`);
    expect(zlib.json.security.advisories.map((a: { id: string }) => a.id)).toEqual(["arch:AVG-9999:zlib"]);
    expect(zlib.json.security.exposed).toEqual([]);
    // Edge serves the fixed zlib: clean there.
    expect((await call(`/package/${F.pkg}?ring=edge&arch=${F.arch}`)).json.security).toEqual({ advisories: [], exposed: [] });
  });

  it("resolves the exposure in the ring the object is shown from — the lab asked for, stable's neighbours answered", async () => {
    const lab = await call(`/package/${F.pkg2}?ring=lab&arch=${F.arch}`);
    expect(lab.json).toMatchObject({ ring: "lab", shown_ring: "stable" });
    expect(lab.json.security.exposed.map((e: { via: string }) => e.via)).toEqual([F.pkg]);
  });

  it("is cached at the edge for ten minutes", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${API}/package/${F.pkg2}?ring=stable&arch=${F.arch}`), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.headers.get("cache-control")).toBe("public, max-age=600");
  });
});

// A ring of N packages in rc, every third one in the lab too — the same
// rows must come back whichever ring is asked, and the lab is a ring like
// any other in ring_packages.
async function seedRing(n: number) {
  const base = 100000;
  const pk: string[] = [], rc: string[] = [], lab: string[] = [];
  for (let i = 1; i <= n; i++) {
    pk.push(`(${base + i}, 'ringsha${i}', 'ringpkg${i}', '1-1', 'x86_64', 'ringpkg${i}-1-1-x86_64.pkg.tar.zst', 100, 100, 1, '{"name":"ringpkg${i}","version":"1-1"}', 'extra', 'extra/x86_64/ringpkg${i}', 'x86_64')`);
    rc.push(`('rc', ${base + i})`);
    if (i % 3 === 0) lab.push(`('lab', ${base + i})`);
  }
  const chunk = async (rows: string[], head: string) => { for (let i = 0; i < rows.length; i += 400) await env.DB.prepare(`${head} ${rows.slice(i, i + 400).join(",")}`).run(); };
  await chunk(pk, "INSERT INTO packages (id, sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch) VALUES");
  await chunk(rc, "INSERT INTO ring_packages (ring, package_id) VALUES");
  await chunk(lab, "INSERT INTO ring_packages (ring, package_id) VALUES");
  return base;
}

describe("a lookup from names into a ring reads the names, not the ring", () => {
  it("the package page's providers: one row per name in the ring, whichever ring, a few rows read per name", async () => {
    const n = 1000, base = await seedRing(n);
    const names = Array.from({ length: 40 }, (_, i) => `ringpkg${n - 7 * i}`);
    const rc = await providersInRing(env, "rc", "x86_64", names);
    expect(rc.results.map((r) => r.name).sort()).toEqual([...names].sort());
    expect(rc.results.every((r) => r.id === base + Number(r.name.slice("ringpkg".length)))).toBe(true);
    // Left to the planner: the ring's members (n) and a package row each — 2 n rows; this way, a few per name.
    expect(rc.meta.rows_read).toBeLessThan(8 * names.length);
    // The lab serves every third one; the other architecture none.
    const lab = await providersInRing(env, "lab", "x86_64", names);
    expect(lab.results.map((r) => r.name).sort()).toEqual(names.filter((m) => Number(m.slice("ringpkg".length)) % 3 === 0).sort());
    expect(lab.meta.rows_read).toBeLessThan(8 * names.length);
    expect((await providersInRing(env, "rc", "aarch64", names)).results).toEqual([]);
    expect((await providersInRing(env, "rc", "x86_64", ["nothing-of-this-name"])).results).toEqual([]);
  });

  it("the Security page's fixed elsewhere: the clean objects of the names in the ring, whether scanned, a few rows read per name", async () => {
    const n = 1000, base = 100000;
    const names = Array.from({ length: 40 }, (_, i) => `ringpkg${n - 7 * i}`);
    // Two of them are vulnerable in rc, one was scanned for components.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO advisories (id, source, package, cves, severity, status, affected, fixed, summary, url, updated_at) VALUES ('arch:AVG-1:ringpkg', 'arch', 'ringpkg', '[\"CVE-2099-0002\"]', 'high', 'vulnerable', NULL, NULL, 'seeded', 'https://security.archlinux.org/AVG-1', '2026-09-20T00:00:00Z')"),
      env.DB.prepare("INSERT INTO package_advisories (package_id, advisory_id, match, status, updated_at) VALUES (?, 'arch:AVG-1:ringpkg', 'exact', 'vulnerable', '2026-09-20T00:00:00Z'), (?, 'arch:AVG-1:ringpkg', 'exact', 'vulnerable', '2026-09-20T00:00:00Z')").bind(base + n, base + n - 7),
      env.DB.prepare("INSERT INTO package_components (package_id, ecosystem, name, version) VALUES (?, 'Go', 'golang.org/x/net', 'v0.30.0')").bind(base + n - 14),
    ]);
    const clean = await cleanIn(env, "rc", "x86_64", names);
    expect(clean.results.map((r) => r.name).sort()).toEqual(names.slice(2).sort());
    expect(clean.results.find((r) => r.name === `ringpkg${n - 14}`)).toEqual({ name: `ringpkg${n - 14}`, version: "1-1", scanned: 1 });
    expect(clean.results.filter((r) => r.scanned).length).toBe(1);
    expect(clean.meta.rows_read).toBeLessThan(8 * names.length);
    // The lab's members answer the same way; the ring that serves none of them answers nothing.
    const lab = await cleanIn(env, "lab", "x86_64", names);
    expect(lab.results.map((r) => r.name).sort()).toEqual(names.slice(2).filter((m) => Number(m.slice("ringpkg".length)) % 3 === 0).sort());
    expect((await cleanIn(env, "edge", "x86_64", names)).results).toEqual([]);
  });
});
