/**
 * New upstream releases of approved packages, built the way the first
 * version was: on the pool's hosts, as evidence for a maintainer. Once a
 * day the brain asks GitHub for each approved package's latest release
 * (one request per package, the scheduler's token when there is one) and,
 * for a tag newer than what was approved, queues a community build from
 * the approved PKGBUILD with pkgver moved to the tag (`bump:<task>@<tag>`).
 *
 * "Approved" is an approval that stands (standsSql, the rule every route
 * reads): a withdrawn one counts for nothing, so a package whose only
 * approval was taken back gets no bump and no bump starts from a
 * withdrawn recipe. Before 2026-09-18 this read `decision` alone.
 *
 * Each architecture starts from its own approval: the newest standing
 * approval of that architecture, the name's newest where it has none.
 * Before #435 the name's newest alone was read, so omarchy-cli's x86_64 bump
 * to v1.1.4 moved the aarch64 recipe (task 1410) — not x86_64's own (task
 * 1582), which had already learned to turn makepkg's lto off.
 *
 * A bump has no agent (design v2 §9.2: a recipe moved, not written), so a
 * recipe that no longer builds the new release would fail the same way at
 * every tag. When an architecture's last bump since the approval that
 * stands failed — or already left the approved recipe — that
 * architecture's next one leaves it too: a draft for the tag
 * (`draft:<url>@<tag>`, that last bump as its `lesson`: an agent writes the
 * recipe from that one's PKGBUILD and log, with the skills), or, for a
 * package whose source ships its own PKGBUILD (`pkgbuild_path`), that
 * PKGBUILD at the tag (`<url>@<tag>:<path>`), as its request built it —
 * never an agent's recipe in place of the upstream's. A draft that staged
 * stays the next tag's lesson until a maintainer approves a newer build:
 * the approved recipe is the one that failed. omarchy-cli's recipe built
 * the whole workspace, and its bump to v1.1.4 failed on both
 * architectures (#435). Every bump carries `params.bump` (the tag): what
 * tells it from a contributor's build (score.ts isBump, BUMP_SQL) is what
 * only the server writes, never `reason`. It is evidence like any bump,
 * and a maintainer decides it.
 *
 * The build goes to the queue at once, as a request's does: every
 * maintainer host builds every contributor's packages (#343, design v2
 * §8.2) — the fourteen days a bump once waited for its owner's own worker
 * are gone with the community worker tier. Thirty days without a build
 * and the package is unmaintained: no more bumps until its owner (or a
 * maintainer, by removing the registration for someone else) takes it up
 * again.
 */
import type { Env } from "./index";
import { standsSql } from "./routes/story";
import { BUMP_SQL } from "./score";
import { settleTargets } from "./targets";

const UNMAINTAINED_AFTER_DAYS = 30;

interface Pkg {
  name: string;
  owner: string;
  url: string;
  arches: string;
  status: string;
  /** The source's own PKGBUILD (a request that found one, queueBuilds), or null: the factory drafts the recipe. */
  pkgbuild_path: string | null;
}

/** An approval that stands: the task whose PKGBUILD a bump moves, the version it approved, when. */
interface Approved {
  task_id: number;
  version: string | null;
  created_at: string;
}

/** One architecture's bump: its recipe, the build a draft learns from, and the last bump it follows when it leaves the approved recipe. */
interface Recipe {
  ref: string;
  lesson: number | null;
  after: { id: number; status: string } | null;
}

/** `v1.2.3` → `1.2.3`, `release/1.0` → `1.0`; a pkgver cannot carry `-` or `/`, the usual tag punctuation becomes `.`. */
export function pkgverOf(tag: string): string {
  const last = tag.includes("/") ? tag.slice(tag.lastIndexOf("/") + 1) : tag;
  return last.replace(/^[vV]/, "").replace(/-/g, ".").replace(/[^A-Za-z0-9.+_:~]/g, "");
}

async function latestTag(url: string, env: Env, fetcher: typeof fetch): Promise<string | null> {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!m) return null;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "omarchy-pool" };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetcher(`https://api.github.com/repos/${m[1]}/${m[2].replace(/\.git$/, "")}/releases/latest`, { headers });
  if (res.status === 404) return null; // no releases: nothing to bump to
  if (!res.ok) throw new Error(`releases of ${m[1]}/${m[2]}: HTTP ${res.status}`);
  const r = (await res.json()) as { tag_name?: string; draft?: boolean; prerelease?: boolean };
  return r.tag_name && !r.draft && !r.prerelease ? r.tag_name : null;
}

/**
 * The recipe of one architecture's bump to `tag`: the approved PKGBUILD with pkgver moved (`bump:<task>@<tag>`), unless that
 * architecture's last bump since the approval failed or already left the approved recipe — then the source's own PKGBUILD at
 * the tag when the package has one (`<url>@<tag>:<path>`), else a draft for the tag that learns from that last bump (an ended
 * one's PKGBUILD and log; one still queued or running has none yet). Read by the name's index (name, arch, id), newest first
 * and no further back than the approved build: a task made after the approval has a larger id than the build it approved.
 */
async function bumpRecipe(env: Env, p: Pkg, arch: string, tag: string, approved: Approved): Promise<Recipe> {
  const last = await env.DB.prepare(
    `SELECT id, status, pkgbuild_ref FROM build_tasks WHERE name = ? AND arch = ? AND id > ? AND kind = 'build' AND trust = 'community' AND ${BUMP_SQL} AND created_at > ? ORDER BY id DESC LIMIT 1`,
  )
    .bind(p.name, arch, approved.task_id, approved.created_at)
    .first<{ id: number; status: string; pkgbuild_ref: string }>();
  if (last && (last.status === "failed" || !last.pkgbuild_ref.startsWith("bump:"))) {
    const after = { id: last.id, status: last.status };
    if (p.pkgbuild_path) return { ref: `${p.url}@${tag}:${p.pkgbuild_path}`, lesson: null, after };
    return { ref: `draft:${p.url}@${tag}`, lesson: ["queued", "leased"].includes(last.status) ? null : last.id, after };
  }
  return { ref: `bump:${approved.task_id}@${tag}`, lesson: null, after: null };
}

/** The journal's words for an architecture whose bump left the approved recipe: how, and after which build. */
function leftWords(arch: string, r: Recipe): string {
  const how = r.ref.startsWith("draft:") ? "drafted for the tag" : "from the source's own PKGBUILD at the tag";
  const s = r.after!.status;
  const state = s === "failed" ? "failed" : s === "queued" || s === "leased" ? "not built yet" : `${s}, not approved`;
  return `${arch} ${how} (its last bump, build ${r.after!.id}, ${state})`;
}

export async function checkUpdates(env: Env, now = new Date(), fetcher: typeof fetch = fetch): Promise<string> {
  const day = now.toISOString().slice(0, 10);
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = 'updates_checked'").first<{ value: string }>();
  if (last?.value === day) return "updates: checked today";
  const log: string[] = [];

  // The policy first: a bump nobody built in thirty days marks its package.
  const stale = await env.DB.prepare(
    `SELECT DISTINCT name FROM build_tasks WHERE status = 'queued' AND trust = 'community' AND reason LIKE 'bump to %' AND ${BUMP_SQL}
        AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-${UNMAINTAINED_AFTER_DAYS} days')`,
  )
    .bind(now.toISOString())
    .all<{ name: string }>();
  for (const { name } of stale.results) {
    await env.DB.batch([
      env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = ? WHERE name = ? AND status = 'queued' AND trust = 'community'").bind(`no worker built this bump in ${UNMAINTAINED_AFTER_DAYS} days; the package is unmaintained`, name),
      env.DB.prepare("UPDATE factory_packages SET status = 'unmaintained', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(`no worker built the last bump in ${UNMAINTAINED_AFTER_DAYS} days; bumps stop until the owner builds again or a maintainer removes the registration`, name),
      env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('bump', NULL, 'factory', 'warn', ?, ?)").bind(`${name} is unmaintained: no worker built its bump in ${UNMAINTAINED_AFTER_DAYS} days`, JSON.stringify({ name, days: UNMAINTAINED_AFTER_DAYS })),
    ]);
    await settleTargets(env, name);
    log.push(`${name}: unmaintained`);
  }

  const pkgs = await env.DB.prepare(
    `SELECT p.name, p.owner, p.url, p.arches, p.status, p.pkgbuild_path FROM factory_packages p
      WHERE p.status != 'unmaintained' AND p.blocked_at IS NULL AND p.url LIKE 'https://github.com/%'
        AND EXISTS (SELECT 1 FROM approvals a WHERE a.name = p.name AND ${standsSql("a.")})`,
  ).all<Pkg>();
  let checked = 0;
  for (const p of pkgs.results) {
    let tag: string | null;
    try {
      tag = await latestTag(p.url, env, fetcher);
    } catch (e) {
      log.push(`${p.name}: ${String(e)}`);
      continue;
    }
    checked++;
    if (!tag) continue;
    const want = pkgverOf(tag);
    // What was approved last and still stands: the version the package is at (each architecture's recipe is read below).
    const approved = await env.DB.prepare(`SELECT task_id, version, created_at FROM approvals WHERE name = ? AND ${standsSql()} ORDER BY id DESC LIMIT 1`).bind(p.name).first<Approved>();
    if (!approved) continue;
    const have = (approved.version ?? "").replace(/^\d+:/, "").replace(/-\d+$/, "");
    if (have === want) continue;
    // Queued, running or staged already — or taken out of the queue by its owner, which stands until the next release.
    const pending = await env.DB.prepare(`SELECT id FROM build_tasks WHERE name = ? AND reason = ? AND ${BUMP_SQL} AND (status IN ('queued', 'leased', 'staged') OR (status = 'cancelled' AND error LIKE 'taken out of the queue%'))`).bind(p.name, `bump to ${tag}`).first();
    if (pending) continue;
    const arches = (JSON.parse(p.arches || "[]") as string[]).filter((a) => a === "x86_64" || a === "aarch64");
    // Each architecture's recipe (#435): its own approval's, the name's newest where it has none — moved to the tag, or left
    // behind after that architecture's last bump failed or had already left it.
    const own = await Promise.all(
      arches.map((arch) => env.DB.prepare(`SELECT task_id, version, created_at FROM approvals WHERE name = ? AND arch = ? AND ${standsSql()} ORDER BY id DESC LIMIT 1`).bind(p.name, arch).first<Approved>()),
    );
    const recipes = await Promise.all(arches.map((arch, i) => bumpRecipe(env, p, arch, tag, own[i] ?? approved)));
    const left = arches.filter((_, i) => recipes[i].after !== null);
    await env.DB.batch([
      ...arches.map((arch, i) =>
        env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, params) VALUES (?, ?, ?, ?, ?, 100, 0, 'community', ?, 'build', ?)`)
          .bind(p.name, arch, `${want}-1`, recipes[i].ref, `bump to ${tag}`, p.owner, JSON.stringify({ bump: tag, ...(recipes[i].lesson === null ? {} : { lesson: recipes[i].lesson }) })),
      ),
      env.DB.prepare("UPDATE factory_packages SET status = 'waiting', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(`${tag} released upstream; a build is queued for the pool's hosts`, p.name),
      env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('bump', NULL, 'factory', 'ok', ?, ?)").bind(
        `${p.name}: upstream ${tag} (approved ${approved.version ?? "?"}); build queued on ${arches.join(", ")}${left.length ? ` — ${left.map((a) => leftWords(a, recipes[arches.indexOf(a)])).join("; ")}` : ""}`,
        JSON.stringify({ name: p.name, tag, approved: approved.version, arches, owner: p.owner, recipes: Object.fromEntries(arches.map((a, i) => [a, recipes[i].ref])), ...(left.length ? { after: Object.fromEntries(left.map((a) => [a, recipes[arches.indexOf(a)].after!.id])) } : {}) }),
      ),
    ]);
    await settleTargets(env, p.name);
    log.push(`${p.name}: ${tag} queued`);
  }
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('updates_checked', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").bind(day).run();
  return `updates: ${checked} package(s) checked${log.length ? " — " + log.join("; ") : ""}`;
}
