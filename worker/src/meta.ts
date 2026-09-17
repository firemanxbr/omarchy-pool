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
  const m = repo.match(/^omarchy-(.+)-(edge|rc|stable|lab)$/);
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
  { source: "factory", arch: "x86_64", upstream: "the factory", title: "Built by the factory from reviewed PKGBUILDs (factory/pkgbuilds)" },
  { source: "factory", arch: "aarch64", upstream: "the factory", title: "Built by the factory from reviewed PKGBUILDs (factory/pkgbuilds)" },
];
