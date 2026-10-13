import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkUpdates, pkgverOf } from "../src/updates";
import { isBump } from "../src/score";
import { pkgbuildFields } from "../src/requests";
import { parseProjectUrl, sha256Hex } from "../src/routes/contributors";

describe("bumps", () => {
  it("turns a release tag into a pkgver", () => {
    expect(pkgverOf("v1.2.3")).toBe("1.2.3");
    expect(pkgverOf("2024-01-05")).toBe("2024.01.05");
    expect(pkgverOf("release/1.0")).toBe("1.0");
    expect(pkgverOf("V3.0-rc1")).toBe("3.0.rc1");
  });

  // An approval that was taken back counts for nothing (stands(), standsSql()): the daily check
  // read `decision` alone and queued a bump from a withdrawn recipe. Three packages, one upstream
  // answer each — v2.0.0 — and only the approvals that stand get a build.
  it("queues a bump from a standing approval and none from a withdrawn one", async () => {
    await env.DB.prepare("INSERT INTO contributors (login, token_hash, role) VALUES ('alice', ?, 'contributor'), ('m1', ?, 'maintainer')").bind(await sha256Hex("omc_alice"), await sha256Hex("omc_m1")).run();
    // A staged community build per package, and the approval a maintainer signed on it.
    const staged = async (name: string, version: string): Promise<number> =>
      (await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, staged_prefix) VALUES (?, 'x86_64', ?, 'draft:x', 'contributor', 100, 'staged', 0, 'community', 'alice', 'build', ?) RETURNING id")
        .bind(name, version, `staging/alice/${name}/`).first<{ id: number }>())!.id;
    const approve = async (task: number, name: string, version: string, withdrawn = false): Promise<void> => {
      await env.DB.prepare("INSERT INTO approvals (task_id, name, arch, version, decision, by, withdrawn_at, withdrawn_by, withdrawn_reason) VALUES (?, ?, 'x86_64', ?, 'approved', 'm1', ?, ?, ?)")
        .bind(task, name, version, withdrawn ? "2026-09-18T10:00:00.000Z" : null, withdrawn ? "m1" : null, withdrawn ? "the owner approved it" : null).run();
    };
    for (const name of ["kept", "taken", "twice"]) {
      await env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status) VALUES (?, 'alice', ?, '["x86_64","aarch64"]', 'approved')`).bind(name, `https://github.com/alice/${name}`).run();
    }
    // kept: one approval, standing. taken: one approval, withdrawn. twice: an older one that stands and a newer one taken back.
    const kept = await staged("kept", "1.0.0-1");
    await approve(kept, "kept", "1.0.0-1");
    const taken = await staged("taken", "1.0.0-1");
    await approve(taken, "taken", "1.0.0-1", true);
    const twiceOld = await staged("twice", "1.0.0-1");
    await approve(twiceOld, "twice", "1.0.0-1");
    const twiceNew = await staged("twice", "1.5.0-1");
    await approve(twiceNew, "twice", "1.5.0-1", true);

    const asked: string[] = [];
    const github: typeof fetch = async (input) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ tag_name: "v2.0.0" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const summary = await checkUpdates(env, new Date("2026-09-18T12:00:00Z"), github);
    expect(summary).toContain("2 package(s) checked");
    expect(asked.map((u) => u.replace(/^.*\/repos\//, "")).sort()).toEqual(["alice/kept/releases/latest", "alice/twice/releases/latest"]);

    const bumps = (await env.DB.prepare("SELECT name, arch, version, pkgbuild_ref, status, trust, owner FROM build_tasks WHERE reason = 'bump to v2.0.0' ORDER BY name, arch").all<{ name: string; arch: string; version: string; pkgbuild_ref: string; status: string; trust: string; owner: string }>()).results;
    expect(bumps.map((b) => `${b.name} ${b.arch}`)).toEqual(["kept aarch64", "kept x86_64", "twice aarch64", "twice x86_64"]);
    for (const b of bumps) expect(b).toMatchObject({ version: "2.0.0-1", status: "queued", trust: "community", owner: "alice" });
    // Into the queue at once, for the pool's hosts (#343): the fourteen days a bump waited for its owner's own worker are gone, and
    // nothing writes shared_after any more.
    expect((await env.DB.prepare("SELECT shared_after FROM build_tasks WHERE reason = 'bump to v2.0.0'").all()).results).toEqual(bumps.map(() => ({ shared_after: null })));
    expect(await env.DB.prepare("SELECT detail FROM factory_packages WHERE name = 'kept'").first()).toEqual({ detail: "v2.0.0 released upstream; a build is queued for the pool's hosts" });
    // The recipe a bump starts from is the approval that stands — kept's own, and twice's older one, never the withdrawn newer one.
    expect(bumps.filter((b) => b.name === "kept").map((b) => b.pkgbuild_ref)).toEqual([`bump:${kept}@v2.0.0`, `bump:${kept}@v2.0.0`]);
    expect(bumps.filter((b) => b.name === "twice").map((b) => b.pkgbuild_ref)).toEqual([`bump:${twiceOld}@v2.0.0`, `bump:${twiceOld}@v2.0.0`]);
    // The package whose only approval was withdrawn is untouched: no build, no new status, no event.
    const untouched = await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'taken'").first<{ status: string }>();
    expect(untouched?.status).toBe("approved");
    const events = (await env.DB.prepare("SELECT summary FROM events WHERE kind = 'bump' ORDER BY id").all<{ summary: string }>()).results.map((e) => e.summary);
    expect(events).toHaveLength(2);
    expect(events.join("\n")).not.toContain("taken");
  });
});

// #435: a bump has no agent, so a recipe that no longer builds the new release failed again at every tag (omarchy-cli's
// built the whole workspace; its bump to v1.1.4 failed on both architectures). An architecture whose last bump since the
// approval failed gets its next one drafted, with the failed build as the lesson; the other keeps the approved recipe.
describe("a bump after a failed one", () => {
  it("is drafted for the new tag with the failed build as its lesson, on that architecture only", async () => {
    await env.DB.prepare("INSERT INTO contributors (login, token_hash, role) VALUES ('fx', ?, 'maintainer'), ('m2', ?, 'maintainer')").bind(await sha256Hex("omc_fx"), await sha256Hex("omc_m2")).run();
    const task = async (name: string, arch: string, version: string, ref: string, reason: string, status: string, at: string): Promise<number> =>
      (await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, created_at) VALUES (?, ?, ?, ?, ?, 100, ?, 0, ?, 'fx', 'build', ?) RETURNING id")
        .bind(name, arch, version, ref, reason, status, ref.startsWith("review:") ? "project" : "community", at).first<{ id: number }>())!.id;
    const url = "https://github.com/firemanxbr/omarchy-pool";
    for (const name of ["omarchy-cli", "steady"]) {
      await env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status) VALUES (?, 'fx', ?, '["x86_64","aarch64"]', 'approved')`).bind(name, name === "steady" ? "https://github.com/fx/steady" : url).run();
    }
    // omarchy-cli: the project's build approved at 0.0.168 (task 1410's part), then the bump to v1.1.4 — failed on x86_64 (the link), cancelled on aarch64.
    const approvedTask = await task("omarchy-cli", "aarch64", "0.0.168", "review:506", "project build asked by fx", "done", "2026-10-08T17:31:40.295Z");
    await env.DB.prepare("INSERT INTO approvals (task_id, name, arch, version, decision, by, created_at) VALUES (?, 'omarchy-cli', 'aarch64', '0.0.168', 'approved', 'm2', '2026-10-12T19:45:23.098Z')").bind(approvedTask).run();
    const failedX86 = await task("omarchy-cli", "x86_64", "1.1.4-1", `bump:${approvedTask}@v1.1.4`, "bump to v1.1.4", "failed", "2026-10-13T05:50:46.098Z");
    await task("omarchy-cli", "aarch64", "1.1.4-1", `bump:${approvedTask}@v1.1.4`, "bump to v1.1.4", "cancelled", "2026-10-13T05:50:46.098Z");
    // steady: a bump that failed before the approval that stands — what was approved since is the recipe, not that failure.
    const steadyOld = await task("steady", "x86_64", "0.9-1", "bump:1@v0.9", "bump to v0.9", "failed", "2026-10-01T05:50:00.000Z");
    const steadyApproved = await task("steady", "x86_64", "1.0-1", "draft:https://github.com/fx/steady@v1.0", "contributor", "staged", "2026-10-02T05:50:00.000Z");
    await env.DB.prepare("INSERT INTO approvals (task_id, name, arch, version, decision, by, created_at) VALUES (?, 'steady', 'x86_64', '1.0-1', 'approved', 'm2', '2026-10-03T00:00:00.000Z')").bind(steadyApproved).run();
    expect(steadyOld).toBeLessThan(steadyApproved);

    const github = (tag: string): typeof fetch => async () => new Response(JSON.stringify({ tag_name: tag }), { status: 200, headers: { "content-type": "application/json" } });
    expect(await checkUpdates(env, new Date("2026-10-14T05:45:00Z"), github("v1.1.5"))).toContain("omarchy-cli: v1.1.5 queued");
    type Row = { name: string; arch: string; id: number; version: string; pkgbuild_ref: string; reason: string; params: string | null; trust: string; status: string };
    const queued = async (reason: string) => (await env.DB.prepare("SELECT name, arch, id, version, pkgbuild_ref, reason, params, trust, status FROM build_tasks WHERE reason = ? AND name IN ('omarchy-cli', 'steady') ORDER BY name, arch").bind(reason).all<Row>()).results;
    const v115 = await queued("bump to v1.1.5");
    expect(v115.map((t) => [t.name, t.arch, t.pkgbuild_ref, t.params])).toEqual([
      ["omarchy-cli", "aarch64", `bump:${approvedTask}@v1.1.5`, null],
      ["omarchy-cli", "x86_64", `draft:${url}@v1.1.5`, JSON.stringify({ lesson: failedX86 })],
      ["steady", "aarch64", `bump:${steadyApproved}@v1.1.5`, null],
      ["steady", "x86_64", `bump:${steadyApproved}@v1.1.5`, null],
    ]);
    for (const t of v115) expect(t).toMatchObject({ version: "1.1.5-1", trust: "community", status: "queued" });
    // Both are bumps, whichever recipe they start from: the score reads them as evidence for the maintainer, not the request's.
    for (const t of v115) expect(isBump(t)).toBe(true);
    expect(isBump({ pkgbuild_ref: `draft:${url}@v0.0.168`, reason: "contributor" })).toBe(false);
    // The journal says which architecture was drafted again, and from which build.
    const line = await env.DB.prepare("SELECT summary, payload FROM events WHERE kind = 'bump' AND summary LIKE 'omarchy-cli:%' ORDER BY id DESC LIMIT 1").first<{ summary: string; payload: string }>();
    expect(line?.summary).toBe(`omarchy-cli: upstream v1.1.5 (approved 0.0.168); build queued on x86_64, aarch64 — drafted again on x86_64 (its last bump, build ${failedX86}, failed)`);
    expect(JSON.parse(line!.payload)).toMatchObject({ tag: "v1.1.5", drafted: { x86_64: failedX86 } });
    expect(JSON.parse((await env.DB.prepare("SELECT payload FROM events WHERE kind = 'bump' AND summary LIKE 'steady:%'").first<{ payload: string }>())!.payload)).not.toHaveProperty("drafted");

    // The draft failed too, and so did aarch64's bump: the next tag is drafted on both, each from its own last failure.
    const draftX86 = v115.find((t) => t.name === "omarchy-cli" && t.arch === "x86_64")!.id;
    const bumpArm = v115.find((t) => t.name === "omarchy-cli" && t.arch === "aarch64")!.id;
    await env.DB.prepare("UPDATE build_tasks SET status = 'failed' WHERE id IN (?, ?)").bind(draftX86, bumpArm).run();
    await checkUpdates(env, new Date("2026-10-15T05:45:00Z"), github("v1.1.6"));
    const v116 = (await queued("bump to v1.1.6")).filter((t) => t.name === "omarchy-cli");
    expect(v116.map((t) => [t.arch, t.pkgbuild_ref, t.params])).toEqual([
      ["aarch64", `draft:${url}@v1.1.6`, JSON.stringify({ lesson: bumpArm })],
      ["x86_64", `draft:${url}@v1.1.6`, JSON.stringify({ lesson: draftX86 })],
    ]);

    // Staged, then approved at 1.1.6: the next bump starts from the approved recipe again, on both.
    for (const t of v116) await env.DB.prepare("UPDATE build_tasks SET status = 'staged' WHERE id = ?").bind(t.id).run();
    const review = await task("omarchy-cli", "x86_64", "1.1.6-1", `review:${v116[1].id}`, "project build asked by fx", "done", "2026-10-15T09:00:00.000Z");
    await env.DB.prepare("INSERT INTO approvals (task_id, name, arch, version, decision, by, created_at) VALUES (?, 'omarchy-cli', 'x86_64', '1.1.6-1', 'approved', 'm2', '2026-10-15T10:00:00.000Z')").bind(review).run();
    await checkUpdates(env, new Date("2026-10-16T05:45:00Z"), github("v1.1.7"));
    expect((await queued("bump to v1.1.7")).filter((t) => t.name === "omarchy-cli").map((t) => [t.arch, t.pkgbuild_ref, t.params])).toEqual([
      ["aarch64", `bump:${review}@v1.1.7`, null],
      ["x86_64", `bump:${review}@v1.1.7`, null],
    ]);
  });
});

describe("package requests", () => {
  it("reads the project's home, the tag and the source from the URL a contributor pastes", () => {
    expect(parseProjectUrl("https://github.com/Owner/Tool.git")).toEqual({ project: "https://github.com/Owner/Tool", github: { owner: "Owner", repo: "Tool" }, tag: null, source: null });
    expect(parseProjectUrl("https://github.com/kyoheiu/felix/archive/refs/tags/v2.16.1.tar.gz")).toEqual({ project: "https://github.com/kyoheiu/felix", github: { owner: "kyoheiu", repo: "felix" }, tag: "v2.16.1", source: "https://github.com/kyoheiu/felix/archive/refs/tags/v2.16.1.tar.gz" });
    expect(parseProjectUrl("https://github.com/eradman/entr/releases/tag/5.8")).toMatchObject({ project: "https://github.com/eradman/entr", tag: "5.8", source: null });
    expect(parseProjectUrl("https://www.spotify.com/download/linux/")).toEqual({ project: "https://www.spotify.com/download/linux", github: null, tag: null, source: null });
    expect(parseProjectUrl("https://github.com/only-owner")).toMatchObject({ error: expect.stringContaining("repository") });
    expect(parseProjectUrl("http://example.org/x")).toMatchObject({ error: "url must be https" });
  });
  it("reads url, pkgdesc and license from a staged PKGBUILD (the backfill's source of truth)", () => {
    expect(pkgbuildFields("pkgname=felix\npkgdesc='tui file manager'\nurl=\"https://github.com/kyoheiu/felix\"\nlicense=('MIT')\n")).toEqual({ url: "https://github.com/kyoheiu/felix", pkgdesc: "tui file manager", license: "MIT" });
    expect(pkgbuildFields("pkgname=x\n")).toEqual({ url: null, pkgdesc: null, license: null });
    expect(pkgbuildFields('pkgdesc="The popular web browser by Google (Stable Channel)"\nurl=https://brave.com/origin/download\nlicense=(\'custom:chrome\')\n')).toEqual({ url: "https://brave.com/origin/download", pkgdesc: "The popular web browser by Google (Stable Channel)", license: "custom:chrome" });
  });
});
