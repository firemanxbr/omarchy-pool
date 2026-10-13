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
// built the whole workspace; its bump to v1.1.4 failed on both architectures, the x86_64 one from the aarch64 recipe).
// Each architecture moves its own approved recipe; one whose last bump since the approval failed, or already left that
// recipe, leaves it too — a draft that learns from that last bump, or the source's own PKGBUILD at the tag.
describe("a bump after a failed one", () => {
  it("starts from its own architecture's approval, and leaves a recipe that failed until a newer one is approved", async () => {
    await env.DB.prepare("INSERT INTO contributors (login, token_hash, role) VALUES ('fx', ?, 'maintainer'), ('m2', ?, 'maintainer')").bind(await sha256Hex("omc_fx"), await sha256Hex("omc_m2")).run();
    const task = async (name: string, arch: string, version: string, ref: string, reason: string, status: string, at: string, params: string | null = null): Promise<number> =>
      (await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, created_at, params) VALUES (?, ?, ?, ?, ?, 100, ?, 0, ?, 'fx', 'build', ?, ?) RETURNING id")
        .bind(name, arch, version, ref, reason, status, ref.startsWith("review:") ? "project" : "community", at, params).first<{ id: number }>())!.id;
    const approve = (taskId: number, name: string, arch: string, version: string, at: string) =>
      env.DB.prepare("INSERT INTO approvals (task_id, name, arch, version, decision, by, created_at) VALUES (?, ?, ?, ?, 'approved', 'm2', ?)").bind(taskId, name, arch, version, at).run();
    const url = "https://github.com/firemanxbr/omarchy-pool";
    const ownUrl = "https://github.com/fx/own";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status) VALUES ('omarchy-cli', 'fx', ?, '["x86_64","aarch64"]', 'approved')`).bind(url),
      env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status) VALUES ('steady', 'fx', 'https://github.com/fx/steady', '["x86_64","aarch64"]', 'approved')`),
      // A source that ships its own PKGBUILD (bitwarden's shape): its request builds that recipe as it is.
      env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status, pkgbuild_path) VALUES ('own', 'fx', ?, '["aarch64"]', 'approved', 'PKGBUILD')`).bind(ownUrl),
    ]);
    // omarchy-cli as production has it: the project's aarch64 build (task 1410) and its x86_64 build (task 1582, made later), one
    // review approving both — x86_64's row first, so the name's newest approval is aarch64's — then the bump to v1.1.4 queued from
    // that newest one on both architectures, and failed on both.
    const approvedArm = await task("omarchy-cli", "aarch64", "0.0.168", "review:506", "project build asked by fx", "done", "2026-10-08T17:31:40.295Z");
    const approvedX86 = await task("omarchy-cli", "x86_64", "0.0.168", "review:531", "project build asked by fx", "done", "2026-10-12T15:11:51.911Z");
    await approve(approvedX86, "omarchy-cli", "x86_64", "0.0.168", "2026-10-12T19:45:23.098Z");
    await approve(approvedArm, "omarchy-cli", "aarch64", "0.0.168", "2026-10-12T19:45:23.098Z");
    const failedX86 = await task("omarchy-cli", "x86_64", "1.1.4-1", `bump:${approvedArm}@v1.1.4`, "bump to v1.1.4", "failed", "2026-10-13T05:50:46.098Z");
    const failedArm = await task("omarchy-cli", "aarch64", "1.1.4-1", `bump:${approvedArm}@v1.1.4`, "bump to v1.1.4", "failed", "2026-10-13T05:50:46.098Z");
    // steady: each architecture approved on its own build; a bump that failed before the approval that stands is not counted.
    const steadyOld = await task("steady", "x86_64", "0.9-1", "bump:1@v0.9", "bump to v0.9", "failed", "2026-10-01T05:50:00.000Z");
    const steadyX86 = await task("steady", "x86_64", "1.0-1", "draft:https://github.com/fx/steady@v1.0", "contributor", "staged", "2026-10-02T05:50:00.000Z");
    const steadyArm = await task("steady", "aarch64", "1.0-1", "draft:https://github.com/fx/steady@v1.0", "contributor", "staged", "2026-10-02T05:50:01.000Z");
    await approve(steadyX86, "steady", "x86_64", "1.0-1", "2026-10-03T00:00:00.000Z");
    await approve(steadyArm, "steady", "aarch64", "1.0-1", "2026-10-03T00:00:00.000Z");
    expect(steadyOld).toBeLessThan(steadyX86);
    // own: its approved build, then a bump of that recipe that failed.
    const ownApproved = await task("own", "aarch64", "1.0-1", `${ownUrl}@v1.0:PKGBUILD`, "contributor", "staged", "2026-10-02T06:00:00.000Z");
    await approve(ownApproved, "own", "aarch64", "1.0-1", "2026-10-03T00:00:00.000Z");
    const ownFailed = await task("own", "aarch64", "1.1.4-1", `bump:${ownApproved}@v1.1.4`, "bump to v1.1.4", "failed", "2026-10-13T05:50:46.098Z");

    const github = (tag: string): typeof fetch => async () => new Response(JSON.stringify({ tag_name: tag }), { status: 200, headers: { "content-type": "application/json" } });
    type Row = { name: string; arch: string; id: number; version: string; pkgbuild_ref: string; reason: string; params: string | null; trust: string; status: string };
    const queued = async (tag: string, name?: string) =>
      (await env.DB.prepare("SELECT name, arch, id, version, pkgbuild_ref, reason, params, trust, status FROM build_tasks WHERE reason = ? AND name IN ('omarchy-cli', 'own', 'steady') ORDER BY name, arch").bind(`bump to ${tag}`).all<Row>()).results.filter((t) => !name || t.name === name);
    const recipes = (rows: Row[]) => rows.map((t) => [t.name, t.arch, t.pkgbuild_ref, t.params ? JSON.parse(t.params) : null]);
    const journal = async (name: string) => (await env.DB.prepare("SELECT summary, payload FROM events WHERE kind = 'bump' AND summary LIKE ? ORDER BY id DESC LIMIT 1").bind(`${name}:%`).first<{ summary: string; payload: string }>())!;
    const run = async (day: string, tag: string) => expect(await checkUpdates(env, new Date(`${day}T05:45:00Z`), github(tag))).toContain(`omarchy-cli: ${tag} queued`);

    // v1.1.5: omarchy-cli drafted on both, each from its own failed bump; own from its source's PKGBUILD at the tag, no agent's
    // recipe in its place; steady moved on each architecture from that architecture's approved build.
    await run("2026-10-14", "v1.1.5");
    const v115 = await queued("v1.1.5");
    expect(recipes(v115)).toEqual([
      ["omarchy-cli", "aarch64", `draft:${url}@v1.1.5`, { bump: "v1.1.5", lesson: failedArm }],
      ["omarchy-cli", "x86_64", `draft:${url}@v1.1.5`, { bump: "v1.1.5", lesson: failedX86 }],
      ["own", "aarch64", `${ownUrl}@v1.1.5:PKGBUILD`, { bump: "v1.1.5" }],
      ["steady", "aarch64", `bump:${steadyArm}@v1.1.5`, { bump: "v1.1.5" }],
      ["steady", "x86_64", `bump:${steadyX86}@v1.1.5`, { bump: "v1.1.5" }],
    ]);
    for (const t of v115) expect(t).toMatchObject({ version: "1.1.5-1", trust: "community", status: "queued" });
    // Every one a bump, by what only the server writes; a draft a contributor asked is not one, whatever its reason says.
    for (const t of v115) expect(isBump(t)).toBe(true);
    expect(isBump({ pkgbuild_ref: `draft:${url}@v0.0.168`, params: JSON.stringify({ lesson: 1626 }) })).toBe(false);
    const forged = { pkgbuild_ref: `draft:${url}@v9`, params: null, reason: "bump to v9" };
    expect(isBump(forged)).toBe(false);
    // The journal says which architecture left the approved recipe, how, and after which build.
    let line = await journal("omarchy-cli");
    expect(line.summary).toBe(`omarchy-cli: upstream v1.1.5 (approved 0.0.168); build queued on x86_64, aarch64 — x86_64 drafted for the tag (its last bump, build ${failedX86}, failed); aarch64 drafted for the tag (its last bump, build ${failedArm}, failed)`);
    expect(JSON.parse(line.payload)).toMatchObject({ tag: "v1.1.5", recipes: { x86_64: `draft:${url}@v1.1.5`, aarch64: `draft:${url}@v1.1.5` }, after: { x86_64: failedX86, aarch64: failedArm } });
    expect((await journal("own")).summary).toBe(`own: upstream v1.1.5 (approved 1.0-1); build queued on aarch64 — aarch64 from the source's own PKGBUILD at the tag (its last bump, build ${ownFailed}, failed)`);
    expect(JSON.parse((await journal("steady")).payload)).not.toHaveProperty("after");

    // v1.1.6, nobody approved anything since: x86_64's draft staged — the approved recipe is still the one that failed, so the
    // next tag is drafted again from the draft that worked; aarch64's still builds — a draft with nothing to learn from yet.
    // own's source recipe staged: the source's again.
    const draftX86 = v115.find((t) => t.name === "omarchy-cli" && t.arch === "x86_64")!.id;
    const draftArm = v115.find((t) => t.name === "omarchy-cli" && t.arch === "aarch64")!.id;
    await env.DB.prepare("UPDATE build_tasks SET status = 'staged' WHERE id IN (?, ?)").bind(draftX86, v115.find((t) => t.name === "own")!.id).run();
    await env.DB.prepare("UPDATE build_tasks SET status = 'leased' WHERE id = ?").bind(draftArm).run();
    await run("2026-10-15", "v1.1.6");
    expect(recipes([...(await queued("v1.1.6", "omarchy-cli")), ...(await queued("v1.1.6", "own"))])).toEqual([
      ["omarchy-cli", "aarch64", `draft:${url}@v1.1.6`, { bump: "v1.1.6" }],
      ["omarchy-cli", "x86_64", `draft:${url}@v1.1.6`, { bump: "v1.1.6", lesson: draftX86 }],
      ["own", "aarch64", `${ownUrl}@v1.1.6:PKGBUILD`, { bump: "v1.1.6" }],
    ]);
    line = await journal("omarchy-cli");
    expect(line.summary).toContain(`x86_64 drafted for the tag (its last bump, build ${draftX86}, staged, not approved); aarch64 drafted for the tag (its last bump, build ${draftArm}, not built yet)`);

    // v1.1.7: x86_64's v1.1.6 draft failed — the next learns from that failure; aarch64's v1.1.5 and v1.1.6 drafts staged — the
    // newest is the lesson.
    const v116 = await queued("v1.1.6", "omarchy-cli");
    await env.DB.prepare("UPDATE build_tasks SET status = 'failed' WHERE id = ?").bind(v116[1].id).run();
    await env.DB.prepare("UPDATE build_tasks SET status = 'staged' WHERE id IN (?, ?)").bind(draftArm, v116[0].id).run();
    await run("2026-10-16", "v1.1.7");
    const v117 = await queued("v1.1.7", "omarchy-cli");
    expect(recipes(v117)).toEqual([
      ["omarchy-cli", "aarch64", `draft:${url}@v1.1.7`, { bump: "v1.1.7", lesson: v116[0].id }],
      ["omarchy-cli", "x86_64", `draft:${url}@v1.1.7`, { bump: "v1.1.7", lesson: v116[1].id }],
    ]);

    // Staged, the project built each architecture again and a maintainer approved the package at 1.1.7: the next bump moves each
    // architecture's newly approved recipe, and no draft.
    for (const t of v117) await env.DB.prepare("UPDATE build_tasks SET status = 'staged' WHERE id = ?").bind(t.id).run();
    const reviewArm = await task("omarchy-cli", "aarch64", "1.1.7-1", `review:${v117[0].id}`, "project build asked by fx", "done", "2026-10-16T09:00:00.000Z");
    const reviewX86 = await task("omarchy-cli", "x86_64", "1.1.7-1", `review:${v117[1].id}`, "project build asked by fx", "done", "2026-10-16T09:30:00.000Z");
    await approve(reviewX86, "omarchy-cli", "x86_64", "1.1.7-1", "2026-10-16T10:00:00.000Z");
    await approve(reviewArm, "omarchy-cli", "aarch64", "1.1.7-1", "2026-10-16T10:00:00.000Z");
    await run("2026-10-17", "v1.1.8");
    expect(recipes(await queued("v1.1.8", "omarchy-cli"))).toEqual([
      ["omarchy-cli", "aarch64", `bump:${reviewArm}@v1.1.8`, { bump: "v1.1.8" }],
      ["omarchy-cli", "x86_64", `bump:${reviewX86}@v1.1.8`, { bump: "v1.1.8" }],
    ]);
    expect(JSON.parse((await journal("omarchy-cli")).payload)).not.toHaveProperty("after");
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
