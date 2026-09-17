import type { Env } from "./index";

export const REPO_URL = "https://github.com/firemanxbr/omarchy-pool";
export const DASHBOARD_HOST = "omarchy-pool.firemanxbr.org";
export const LEGACY_DASHBOARD_HOST = "dashboard-omarchy.firemanxbr.org";

export interface RunningVersion {
  version: string;
  commit: string | null;
  deployed_at: string | null;
  release_url: string | null;
  commit_url: string | null;
  /** The page-view counter every page carries, if this deployment has one (ANALYTICS in wrangler.toml): a GA4 id (G-…) or a Cloudflare Web Analytics token; empty = none. */
  analytics: string;
}

/** What is running: the release tag, its commit and when it was deployed — and what the shell of every page needs to know about this deployment. */
export function version(env: Env): RunningVersion {
  const v = env.POOL_VERSION || "dev";
  const commit = env.POOL_COMMIT || null;
  return {
    version: v,
    commit,
    deployed_at: env.POOL_DEPLOYED_AT || null,
    release_url: v === "dev" ? null : `${REPO_URL}/releases/tag/${v}`,
    commit_url: commit ? `${REPO_URL}/commit/${commit}` : null,
    analytics: (env.ANALYTICS || "").trim(),
  };
}

/**
 * A source is late when its last sync is older than this. One number for
 * the Status page's headline, its table and the shell's problem list: the
 * headline said nine hours while the table marked rows late at six, on the
 * same page (2026-09-18). The shell's nine won — a long import of one
 * source makes the others wait their turn, and six flagged them for it.
 * /api/v1/stats marks each coverage row `late` by it, and layout.ts hands
 * it to every page script as LATE_MS, so the pages hold no copy.
 */
export const LATE_AFTER_HOURS = 9;

/**
 * The rings. edge, rc and stable are the promise: a package enters edge
 * signature-verified and reaches rc and stable by evidence, whichever
 * source built it. lab is the fourth, beside them, where nothing is
 * promised and nothing is promoted from: the factory's builds land there
 * first and a real pacman tries them against edge (the trial job), any
 * object of the pool can be pinned there to be tried in a combination,
 * and only a maintainer's approval takes a build from there to edge. No
 * sync targets it; `--ring lab` on a machine is the lab above the edge.
 *
 * This is the one list. index.ts re-exports it for the routes; the SQL
 * that asks "which rings serve this package" is written from it through
 * ringsSql(), the order a served list is read in is sortRings(), so a ring
 * added here is in every query and every order the server writes. Five
 * routes typed the four names by hand before (2026-09-18).
 */
export const RINGS = ["edge", "rc", "stable", "lab"] as const;
export type Ring = (typeof RINGS)[number];
/** The rings a package is promoted through, in order. */
export const PROMOTED_RINGS = ["edge", "rc", "stable"] as const;
/**
 * The same rings from the most stable down — stable, rc, edge, then the
 * lab, which is below edge and promised nothing — the order a reader
 * picks a ring in and the order the package page falls back through when
 * the asked ring does not serve the package. Derived, so it cannot drift
 * from RINGS; the ring texts (RING_TEXT) keep this order too.
 */
export const RINGS_BY_STABILITY: readonly Ring[] = [...[...PROMOTED_RINGS].reverse(), ...RINGS.filter((r) => !(PROMOTED_RINGS as readonly string[]).includes(r))];
/** The order a package climbs — lab, edge, rc, stable — the order the rings that serve a package are listed in. Derived from RINGS_BY_STABILITY, read the other way. */
export const RINGS_UPWARD: readonly Ring[] = [...RINGS_BY_STABILITY].reverse();

export function isRing(s: string): s is Ring {
  return (RINGS as readonly string[]).includes(s);
}

/**
 * A ring list as a SQL `IN (…)` fragment, `'lab', 'edge', 'rc', 'stable'`,
 * to splice into a query. The values are the constants above, never a
 * caller's input: a name that is not plain lowercase letters throws
 * rather than reaching the query, so the fragment can only ever be the
 * rings' own names.
 */
export function ringsSql(rings: readonly Ring[]): string {
  for (const r of rings) if (!/^[a-z]+$/.test(r)) throw new Error(`not a ring name: ${r}`);
  return rings.map((r) => `'${r}'`).join(", ");
}

/** The rings that serve a package, in the order a package climbs (RINGS_UPWARD). A name that is no ring sorts last. */
export function sortRings<T extends string>(rings: T[]): T[] {
  const at = (r: string) => { const i = (RINGS_UPWARD as readonly string[]).indexOf(r); return i < 0 ? RINGS_UPWARD.length : i; };
  return [...rings].sort((a, b) => at(a) - at(b));
}

/**
 * What each ring is, said once: the Pool page's cards, the Docs, Get
 * started and the status tiles read it from here (layout.ts hands it to
 * every page script as RINGS_TEXT). Promotion is by evidence, when the
 * evidence is there (scheduler.ts, gate.rs) — the words say so.
 */
export const RING_TEXT: Record<string, { title: string; text: string; lag: string; desc: string }> = {
  stable: {
    title: "Recommended for daily use",
    text: "What <b>rc</b> served through two green checks in a row — promoted the moment the second passed.",
    lag: "≈ 6 h after rc, on evidence",
    desc: "Recommended. What rc served through two green checks in a row, promoted on evidence — about six hours after rc — and rolled back automatically if a check fails.",
  },
  rc: {
    title: "For testers",
    text: "<b>edge</b>, right after a real pacman and an ABI check passed on both architectures.",
    lag: "minutes after edge's checks pass",
    desc: "Edge, promoted the moment a real pacman and an ABI check passed on both architectures. For testers.",
  },
  edge: {
    title: "For CI and developers",
    text: "What upstream published in the last three hours, signature-verified.",
    lag: "≤ 3 h behind upstream",
    desc: "What upstream published in the last three hours, signature-verified only. For CI and developers.",
  },
  lab: {
    title: "For trying a build",
    text: "The factory's builds before anyone decides, above <b>edge</b>. Nothing here is promised.",
    lag: "not a promise",
    desc: "The lab: a build the project made, tried by a real pacman, served above edge. Nothing here is promised or promoted; a maintainer's approval sends it to edge.",
  },
};

/**
 * The order of the sources in the pacman include (routes/setup.ts), which
 * is priority: pacman takes a package from the first repository that has
 * it. Omarchy's own packages (the OPR) and the factory's builds come first
 * — as [omarchy] sits above [core] on an Omarchy install — then Arch's
 * core, extra, multilib, Arch Linux ARM's alarm, and the optional sources
 * last. On a Mac the Asahi fork and asahi-alarm come before all of them:
 * their kernel, graphics and Apple-specific builds must win. A ring holds
 * every source's build of a name (routes/releases.ts); this order is the
 * only thing that decides between them.
 */
export const REPO_ORDER = ["asahi", "asahi-alarm", "packages", "factory", "core", "extra", "multilib", "alarm"];

/** Where a source sits in REPO_ORDER; the optional ones after all of it. */
export function sourceRank(source: string): number {
  const i = REPO_ORDER.indexOf(source);
  return i < 0 ? REPO_ORDER.length : i;
}

/** The source a rendered repository lists: `omarchy-<source>-<ring>` → `<source>`; null for any other name. */
export function sourceOfRepo(repo: string): string | null {
  const m = repo.match(new RegExp(`^omarchy-(.+)-(${RINGS.join("|")})$`));
  return m ? m[1] : null;
}

/**
 * Every upstream repository the pipeline mirrors (the SOURCES table of
 * SYNC_SOURCES in scheduler.ts), so the dashboard can show what has not been synced yet.
 */
export const EXPECTED_SOURCES: { source: string; arch: string; upstream: string; optional?: boolean; title: string }[] = [
  { source: "core", arch: "x86_64", upstream: "mirror.omarchy.org", title: "Arch Linux core" },
  { source: "extra", arch: "x86_64", upstream: "mirror.omarchy.org", title: "Arch Linux extra" },
  { source: "multilib", arch: "x86_64", upstream: "mirror.omarchy.org", title: "Arch Linux multilib" },
  { source: "packages", arch: "x86_64", upstream: "pkgs.omarchy.org", title: "Omarchy (OPR), the edge channel" },
  { source: "chaotic", arch: "x86_64", upstream: "builds.garudalinux.org", optional: true, title: "chaotic-aur: prebuilt AUR packages (only names no other source provides)" },
  { source: "core", arch: "aarch64", upstream: "os.archlinuxarm.org", title: "Arch Linux ARM core" },
  { source: "extra", arch: "aarch64", upstream: "os.archlinuxarm.org", title: "Arch Linux ARM extra" },
  { source: "alarm", arch: "aarch64", upstream: "os.archlinuxarm.org", title: "Arch Linux ARM alarm" },
  { source: "packages", arch: "aarch64", upstream: "pkgs.omarchy.org", title: "Omarchy (OPR), the edge channel" },
  { source: "asahi", arch: "aarch64", upstream: "github.com/maralcbr/omarchy-pkgs", title: "Omarchy for Apple Silicon: the fork's newest stable snapshot" },
  { source: "asahi-alarm", arch: "aarch64", upstream: "github.com/asahi-alarm/asahi-alarm", title: "Asahi Linux for Arch Linux ARM: kernel, graphics, firmware" },
  { source: "aur", arch: "aarch64", upstream: "os.archlinuxarm.org", optional: true, title: "Arch Linux ARM's prebuilt AUR selection (only names no other source provides)" },
  { source: "factory", arch: "x86_64", upstream: "the factory", title: "Built by the factory from contributors' recipes, built again by the project and decided by a maintainer" },
  { source: "factory", arch: "aarch64", upstream: "the factory", title: "Built by the factory from contributors' recipes, built again by the project and decided by a maintainer" },
];
