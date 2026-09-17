import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkUpdates, pkgverOf } from "../src/updates";
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
