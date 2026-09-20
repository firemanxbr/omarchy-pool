/**
 * The security view's `fixed_in`: a version elsewhere counts as clean only
 * when it was examined the same way — a package whose vulnerable object
 * carries embedded components (what OSV advisories are about) is not
 * "fixed" in a ring that serves an object indexed before the component
 * scan existed (no components, no advisories, no knowledge).
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { issueJobToken } from "../src/jobtoken";
import { packageKey } from "../src/r2";

const API = "http://pool.test/api/v1";

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new Request(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

const sha = (s: string) => Array.from({ length: 64 }, (_, i) => s.charCodeAt(i % s.length).toString(16).slice(-1)).join("");

/** A Go binary in the pool: `components` is what pkg-extract found in it (none for an object indexed before the scan). */
async function index(repoArch: string, version: string, components: { ecosystem: string; name: string; version: string }[], token: string): Promise<{ sha256: string; id: number }> {
  const filename = `smolvm-${version}-${repoArch}.pkg.tar.zst`;
  const bytes = new TextEncoder().encode(`fake ${filename}`);
  await env.PACKAGES.put(packageKey("packages", repoArch, filename), bytes);
  const s = sha(`${repoArch}/${filename}`);
  const r = await call("POST", `/packages?source=packages&arch=${repoArch}`, {
    schema_version: 1, name: "smolvm", version, arch: repoArch, sha256: s, filename, size_download: bytes.length, size_installed: 1,
    description: "a small vm", provides: ["smolvm"], requires: [], pkginfo: { provides: [] }, files: ["usr/bin/smolvm"], components,
  }, token);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { sha256: s, id: r.json.id };
}

let old: { sha256: string; id: number };
let cur: { sha256: string; id: number };

beforeAll(async () => {
  const pool = await issueJobToken(env, { t: 1, k: "test", s: ["pool:write"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
  const edge = await issueJobToken(env, { t: 2, k: "test", s: ["release:edge"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
  const rc = await issueJobToken(env, { t: 3, k: "test", s: ["release:rc"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
  // 1.15.0 indexed before the component scan existed; 1.15.1 scanned, and vulnerable through a Go module.
  old = await index("x86_64", "1.15.0-1", [], pool);
  cur = await index("x86_64", "1.15.1-1", [{ ecosystem: "Go", name: "golang.org/x/net", version: "v0.20.0" }], pool);
  expect((await call("POST", "/releases", { ring: "rc", add: [old.sha256] }, rc)).status).toBe(201);
  expect((await call("POST", "/releases", { ring: "edge", add: [cur.sha256] }, edge)).status).toBe(201);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO advisories (id, source, package, cves, severity, status, affected, fixed, summary, url, updated_at) VALUES ('osv:GO-2024-1234:smolvm', 'osv', 'smolvm', '[\"CVE-2024-1234\"]', 'critical', 'vulnerable', NULL, NULL, 'x/net', 'https://osv.dev/GO-2024-1234', '2026-09-14T00:00:00Z')"),
    env.DB.prepare("INSERT INTO package_advisories (package_id, advisory_id, match, status, updated_at) VALUES (?, 'osv:GO-2024-1234:smolvm', 'exact', 'vulnerable', '2026-09-14T00:00:00Z')").bind(cur.id),
  ]);
});

describe("GET /security fixed_in", () => {
  it("does not call a version clean when it was never scanned for the components the advisory is about", async () => {
    const view = (await call("GET", "/security?ring=edge&arch=x86_64&_=1")).json;
    const v = view.vulnerable.find((p: any) => p.name === "smolvm");
    expect(v, JSON.stringify(view)).toBeTruthy();
    expect(v.fixed_in).toEqual([]);
  });
  it("does once the other object carries components and no open advisory", async () => {
    await env.DB.prepare("INSERT INTO package_components (package_id, ecosystem, name, version) VALUES (?, 'Go', 'golang.org/x/net', 'v0.30.0')").bind(old.id).run();
    const view = (await call("GET", "/security?ring=edge&arch=x86_64&_=2")).json;
    const v = view.vulnerable.find((p: any) => p.name === "smolvm");
    expect(v.fixed_in).toEqual([{ ring: "rc", version: "1.15.0-1" }]);
  });
});

/** Something in the pool that depends on smolvm: by name, or by a library it provides. */
async function dependant(name: string, requires: string[], token: string): Promise<string> {
  const filename = `${name}-1.0-1-x86_64.pkg.tar.zst`;
  const bytes = new TextEncoder().encode(`fake ${filename}`);
  await env.PACKAGES.put(packageKey("packages", "x86_64", filename), bytes);
  const s = sha(`x86_64/${filename}`);
  const r = await call("POST", "/packages?source=packages&arch=x86_64", {
    schema_version: 1, name, version: "1.0-1", arch: "x86_64", sha256: s, filename, size_download: bytes.length, size_installed: 1,
    description: name, provides: [name], requires, pkginfo: { provides: [] }, files: [`usr/bin/${name}`],
  }, token);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return s;
}

describe("GET /security exposure", () => {
  it("counts what depends on a vulnerable package in that ring, by name and by a library it provides", async () => {
    const pool = await issueJobToken(env, { t: 4, k: "test", s: ["pool:write"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
    const edge = await issueJobToken(env, { t: 5, k: "test", s: ["release:edge"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
    const rc = await issueJobToken(env, { t: 6, k: "test", s: ["release:rc"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
    // The vulnerable object also ships a library.
    await env.DB.prepare("INSERT INTO package_provides (package_id, capability, declared) VALUES (?, 'libsmol.so.1', 0)").bind(cur.id).run();
    const byName = await dependant("smol-cli", ["smolvm"], pool);
    const byLibrary = await dependant("smol-gui", ["libsmol.so.1"], pool);
    const elsewhere = await dependant("smol-rc-only", ["smolvm"], pool);
    expect((await call("POST", "/releases", { ring: "edge", add: [byName, byLibrary] }, edge)).status).toBe(201);
    expect((await call("POST", "/releases", { ring: "rc", add: [elsewhere] }, rc)).status).toBe(201);

    const view = (await call("GET", "/security?ring=edge&arch=x86_64&_=3")).json;
    const v = view.vulnerable.find((p: any) => p.name === "smolvm");
    expect(v.exposure).toEqual({ declared: 1, loads: 1 });
    expect(view.totals.exposed).toBe(2);
    // rc serves a clean smolvm: nothing there is exposed.
    const rcView = (await call("GET", "/security?ring=rc&arch=x86_64&_=3")).json;
    expect(rcView.vulnerable.find((p: any) => p.name === "smolvm")).toBeUndefined();
    expect(rcView.totals.exposed).toBe(0);
  });
});

/**
 * The security job's writes. It runs every three hours and posts the whole
 * set every time (4.6 k advisories, 8 k CVEs, 7.4 k matches on production);
 * an upsert that changes nothing must write nothing, and the prune that
 * follows must delete only what the run did not post — keyed by the run's
 * own key set, since updated_at no longer moves on every run.
 */
describe("PUT /security/advisories, /security/matches and POST /security/prune", () => {
  const A = "arch:AVG-1:smolvm", B = "debian:CVE-2099-3:smolvm", OSV = "osv:GO-2024-1234:smolvm";
  let token: string;
  const advisories = (cves: string[]) => [
    { id: A, source: "arch", package: "smolvm", cves, severity: "high", status: "fixed", affected: "1.15.1-1", fixed: "1.15.2-1", summary: null, url: "https://security.archlinux.org/AVG-1" },
    { id: B, source: "debian", package: "smolvm", cves: ["CVE-2099-3"], severity: "medium", status: "vulnerable", affected: null, fixed: "1.16", summary: "a debian one", url: "https://security-tracker.debian.org/tracker/CVE-2099-3" },
  ];
  const cves = (epss: number) => [
    { cve: "CVE-2099-1", kev: true, kev_added: "2026-09-01", epss, epss_percentile: 0.9995 },
    { cve: "CVE-2099-2", kev: false, kev_added: null, epss: null, epss_percentile: null },
    { cve: "CVE-2099-3", kev: false, kev_added: null, epss: 0.5, epss_percentile: 0.5 },
  ];
  const matches = () => [
    { sha256: cur.sha256, advisory: A, match: "exact", status: "vulnerable" },
    { sha256: old.sha256, advisory: A, match: "exact", status: "fixed" },
    { sha256: cur.sha256, advisory: B, match: "name-version", status: "vulnerable" },
  ];
  const held = async () => ({
    advisories: (await env.DB.prepare("SELECT id FROM advisories ORDER BY id").all<{ id: string }>()).results.map((r) => r.id),
    matches: (await env.DB.prepare("SELECT p.sha256, pa.advisory_id FROM package_advisories pa JOIN packages p ON p.id = pa.package_id ORDER BY 1, 2").all<{ sha256: string; advisory_id: string }>()).results.map((r) => [r.sha256, r.advisory_id]),
  });

  beforeAll(async () => {
    token = await issueJobToken(env, { t: 7, k: "test", s: ["security:write"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
  });

  it("a second identical PUT writes no row; a changed field writes its row", async () => {
    const first = await call("PUT", "/security/advisories", { advisories: advisories(["CVE-2099-1", "CVE-2099-2"]), cves: cves(0.123456), updated_at: "2026-09-20T00:00:00Z" }, token);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.rows_written).toBeGreaterThan(0);
    const firstMatches = await call("PUT", "/security/matches", { matches: matches(), updated_at: "2026-09-20T00:00:00Z" }, token);
    expect(firstMatches.status).toBe(200);
    expect(firstMatches.json).toMatchObject({ matches: 3, unknown_sha256: 0 });
    expect(firstMatches.json.rows_written).toBeGreaterThan(0);

    // The next run, three hours later, posts the same set: nothing is written, updated_at included.
    const again = await call("PUT", "/security/advisories", { advisories: advisories(["CVE-2099-1", "CVE-2099-2"]), cves: cves(0.123456), updated_at: "2026-09-20T03:00:00Z" }, token);
    expect(again.json.rows_written).toBe(0);
    const againMatches = await call("PUT", "/security/matches", { matches: matches(), updated_at: "2026-09-20T03:00:00Z" }, token);
    expect(againMatches.json.rows_written).toBe(0);
    expect(await env.DB.prepare("SELECT updated_at FROM advisories WHERE id = ?").bind(A).first("updated_at")).toBe("2026-09-20T00:00:00Z");
    expect(await env.DB.prepare("SELECT updated_at FROM package_advisories WHERE advisory_id = ?").bind(A).first("updated_at")).toBe("2026-09-20T00:00:00Z");

    // A status that moved is written, with the run's updated_at; the other rows still are not.
    const moved = matches();
    moved[1].status = "vulnerable";
    const changed = await call("PUT", "/security/matches", { matches: moved, updated_at: "2026-09-20T06:00:00Z" }, token);
    expect(changed.json.rows_written).toBeGreaterThan(0);
    expect(changed.json.rows_written).toBeLessThanOrEqual(3);
    const rows = (await env.DB.prepare("SELECT status, updated_at FROM package_advisories WHERE advisory_id = ? ORDER BY package_id").bind(A).all<{ status: string; updated_at: string }>()).results;
    expect(rows).toEqual([{ status: "vulnerable", updated_at: "2026-09-20T06:00:00Z" }, { status: "vulnerable", updated_at: "2026-09-20T00:00:00Z" }]);
    const advisoryChanged = await call("PUT", "/security/advisories", { advisories: advisories(["CVE-2099-1", "CVE-2099-2"]).map((a) => (a.id === A ? { ...a, status: "vulnerable" } : a)), updated_at: "2026-09-20T06:00:00Z" }, token);
    expect(advisoryChanged.json.rows_written).toBeGreaterThan(0);
    expect(advisoryChanged.json.rows_written).toBeLessThanOrEqual(3);
    expect(await env.DB.prepare("SELECT status, updated_at FROM advisories WHERE id = ?").bind(B).first()).toEqual({ status: "vulnerable", updated_at: "2026-09-20T00:00:00Z" });
  });

  it("an EPSS score is kept to three decimals, so the daily refresh rewrites only the CVEs whose score moved", async () => {
    expect(await env.DB.prepare("SELECT epss, epss_percentile FROM cve_meta WHERE cve = 'CVE-2099-1'").first()).toEqual({ epss: 0.123, epss_percentile: 1 });
    const same = await call("PUT", "/security/advisories", { cves: cves(0.1234), updated_at: "2026-09-21T00:00:00Z" }, token);
    expect(same.json.rows_written).toBe(0);
    const moved = await call("PUT", "/security/advisories", { cves: cves(0.1236), updated_at: "2026-09-21T00:00:00Z" }, token);
    expect(moved.json.rows_written).toBe(1);
    expect(await env.DB.prepare("SELECT epss, updated_at FROM cve_meta WHERE cve = 'CVE-2099-1'").first()).toEqual({ epss: 0.124, updated_at: "2026-09-21T00:00:00Z" });
  });

  it("the prune deletes exactly what the run did not post, by its key set", async () => {
    const before = await held();
    expect(before.advisories).toEqual([A, B, OSV]);
    expect(before.matches.length).toBe(4);
    // Everything held is in the run's set: nothing goes.
    const full = { advisories: [A, B, OSV], matches: [[cur.sha256, A], [old.sha256, A], [cur.sha256, B], [cur.sha256, OSV]] };
    const nothing = await call("POST", "/security/prune?before=2026-09-21T00:00:00Z", full, token);
    expect(nothing.status, JSON.stringify(nothing.json)).toBe(200);
    expect(nothing.json).toEqual({ pruned: { matches: 0, advisories: 0 } });
    expect(await held()).toEqual(before);
    // One match the run did not see again (the old object left the rings): that pair only.
    const one = await call("POST", "/security/prune?before=2026-09-21T00:00:00Z", { ...full, matches: full.matches.filter((m) => m[0] !== old.sha256) }, token);
    expect(one.json).toEqual({ pruned: { matches: 1, advisories: 0 } });
    const afterOne = await held();
    expect(afterOne.advisories).toEqual([A, B, OSV]);
    expect(afterOne.matches).toEqual(before.matches.filter((m) => m[0] !== old.sha256));
    // An advisory the trackers dropped: the advisory and, with it, its matches.
    const two = await call("POST", "/security/prune?before=2026-09-21T00:00:00Z", { advisories: [A, OSV], matches: [[cur.sha256, A], [cur.sha256, OSV]] }, token);
    expect(two.json).toEqual({ pruned: { matches: 1, advisories: 1 } });
    expect(await held()).toEqual({ advisories: [A, OSV], matches: [[cur.sha256, A], [cur.sha256, OSV]] });
  });

  it("a prune without the run's keys (an older pkg-repo) is refused and deletes nothing", async () => {
    await env.DB.prepare("INSERT INTO events (kind, status, summary, payload) VALUES ('security', 'ok', '2 advisories matched', ?)").bind(JSON.stringify({ arch_advisories: 1, osv_advisories: 1, run_at: "2026-09-21T00:00:00Z" })).run();
    const before = await held();
    for (const body of [{}, { advisories: [A, OSV] }, { matches: [] }, { advisories: "all", matches: [] }]) {
      const r = await call("POST", "/security/prune?before=2026-09-21T03:00:00Z", body, token);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error).toMatch(/advisories.*matches/);
    }
    expect(await held()).toEqual(before);
    const warned = (await env.DB.prepare("SELECT status, summary FROM events WHERE kind = 'security' AND status = 'warn'").all<{ status: string; summary: string }>()).results;
    expect(warned.length).toBe(4);
    expect(warned[0].summary).toMatch(/prune/);
    // The Security page still reads the last run that matched, not the refusal.
    const view = (await call("GET", "/security?ring=edge&arch=x86_64&_=4")).json;
    expect(view.advisories_total).toBe(2);
    expect(view.updated_at).toBe("2026-09-21T00:00:00Z");
  });
});
