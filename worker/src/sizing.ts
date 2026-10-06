/**
 * `factory/sizing/tasks.toml` as the pool reads it (#337, design v2 §7.3,
 * §7.4; D31): the size and disk budget a maintainer set for a package, in a
 * pull request another maintainer approved (CODEOWNERS makes every
 * maintainer an owner of factory/sizing/). The file ships with the release
 * like hosts.ts's manifest, so the pool deployed from a release sizes tasks
 * by that release's file; the dispatcher reads the same file from the
 * release's checkout for its network exceptions
 * (crates/pkg-repo/src/dispatch/sizing.rs).
 *
 * A package's own page may set its size and budget too
 * (factory_packages.size, disk_gb, POST /factory/packages/:name/size): that
 * one maintainer's word, journaled, wins over the file until it is cleared.
 * Neither is a size the task gets as is: the claim clamps it to the signed
 * maximum (a contributor's lower) and to the largest host alive
 * (selection.ts).
 *
 * Schema 1, as the dispatcher reads it: an unknown key, a size that is not
 * a whole number from 1, or a budget that is not a whole number of GB from 1
 * makes the file not read — the pool then sizes nothing from it and says so
 * in its log; worker/test/selection.test.ts reads the shipped file, so a
 * release never carries one that does not read.
 *
 * Below both, the size the pool learned from a package's own builds (#330,
 * design v2 §7.4; D31): raised after an out-of-memory kill the engine
 * reported, never above a contributor's 2 for a contributor's build nor the
 * signed maximum, and decayed after five builds in a row that peaked lower
 * (factory_packages.learned_*; the rules are `afterOom` and `afterBuild`
 * below, the writes routes/factory.ts `learnSize`). A maintainer's size, on
 * the page or in the file, wins over it.
 */
import { parse } from "smol-toml";
import tasksToml from "../../factory/sizing/tasks.toml";
import { BUILD_GB_PER_SIZE, COMMUNITY_MAX_SIZE, MAX_SIZE, SIDECARS_MEM_MB, TASK_UNITS, UNIT } from "./hosts";

export interface Sizing { size: number | null; disk_gb: number | null }

const KEYS = ["size", "disk_gb", "network", "reason"];

/** The file read whole, or why not. */
export function readSizing(text: string): Map<string, Sizing> | string {
  let f: Record<string, unknown>;
  try {
    f = parse(text) as Record<string, unknown>;
  } catch (e) {
    return `factory/sizing/tasks.toml does not read: ${String(e)}`;
  }
  if (f.schema !== 1) return `factory/sizing/tasks.toml is schema ${String(f.schema)}, the pool reads 1`;
  for (const k of Object.keys(f)) if (k !== "schema" && k !== "package") return `factory/sizing/tasks.toml: unknown key ${k}`;
  const out = new Map<string, Sizing>();
  const pkgs = (f.package ?? {}) as Record<string, unknown>;
  if (typeof pkgs !== "object" || Array.isArray(pkgs)) return "factory/sizing/tasks.toml: [package] is a table of packages";
  for (const [name, v] of Object.entries(pkgs)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return `factory/sizing/tasks.toml: ${name} is not a table`;
    const e = v as Record<string, unknown>;
    for (const k of Object.keys(e)) if (!KEYS.includes(k)) return `factory/sizing/tasks.toml: ${name} has an unknown key ${k}`;
    const whole = (x: unknown) => x === undefined || (typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= 4096);
    if (!whole(e.size)) return `factory/sizing/tasks.toml: ${name}'s size is a whole number from 1`;
    if (!whole(e.disk_gb)) return `factory/sizing/tasks.toml: ${name}'s disk_gb is a whole number of GB from 1`;
    if (e.size !== undefined || e.disk_gb !== undefined) out.set(name, { size: (e.size as number | undefined) ?? null, disk_gb: (e.disk_gb as number | undefined) ?? null });
  }
  return out;
}

let SHIPPED: Map<string, Sizing> | null = null;

/** The release's own file, read once per isolate; a file that does not read sizes nothing (logged). */
export function shippedSizing(): Map<string, Sizing> {
  if (SHIPPED) return SHIPPED;
  const r = readSizing(tasksToml);
  if (typeof r === "string") {
    console.error(r);
    SHIPPED = new Map();
  } else SHIPPED = r;
  return SHIPPED;
}

/**
 * A package's remembered size (#330, design v2 §7.4; D31): what the pool
 * learned from its builds, apart from any size a maintainer set. `size` is 2
 * up to the signed maximum, or null — nothing learned, size 1; `lower` counts
 * the builds in a row since that peaked below what the next size down gives;
 * `task`, `why` and `at` name the report that last changed the size: an
 * engine-reported out-of-memory kill that raised it (`oom`), or the fifth
 * lower peak that let it decay (`decay`).
 */
export interface Learned { size: number | null; lower: number; task: number | null; why: "oom" | "decay" | null; at: string | null }

/** Builds in a row that peaked lower before a remembered size decays one step (D31). */
export const DECAY_AFTER = 5;

/** A package's learned_* columns as a remembered size: anything that is not a whole size from 2 is nothing learned. */
export function learnedOf(r: { learned_size?: unknown; learned_lower?: unknown; learned_task?: unknown; learned_why?: unknown; learned_at?: unknown }): Learned {
  const whole = (x: unknown, min: number) => (typeof x === "number" && Number.isInteger(x) && x >= min ? x : null);
  return {
    size: whole(r.learned_size, 2),
    lower: whole(r.learned_lower, 0) ?? 0,
    task: whole(r.learned_task, 1),
    why: r.learned_why === "oom" || r.learned_why === "decay" ? r.learned_why : null,
    at: typeof r.learned_at === "string" ? r.learned_at : null,
  };
}

/**
 * The memory, in MB, the size below `size` gives a build's container: its
 * units' memory less both sidecars' (a model kind's agent sidecar included,
 * the smallest container that size runs), so a build that peaked below it
 * would have fitted there, whatever kind of build it was.
 */
export function peakBelowMb(size: number): number {
  return (size - 1) * TASK_UNITS.build_per_size * UNIT.mem_gb * 1024 - SIDECARS_MEM_MB.egress - SIDECARS_MEM_MB.agent;
}

/** The largest size learning gives a build of this trust: a contributor's 2 (community_max_size), the signed maximum otherwise. */
export const learnCap = (trust: string): number => (trust === "community" ? COMMUNITY_MAX_SIZE : MAX_SIZE);

/**
 * After the engine killed a build at its memory limit, running at size
 * `ran`: the remembered size becomes `ran` + 1 — never above the cap of the
 * build's trust (learnCap: a recipe that runs itself out of memory on purpose
 * gets a contributor's build no further than 2), never lower than it was —
 * and the lower peaks counted start over. One step, not a doubling (D31):
 * each step costs the build an attempt and a maintainer sees it. null when
 * nothing changes.
 */
export function afterOom(cur: Learned, o: { ran: number; trust: string; task: number; at: string }): Learned | null {
  const was = cur.size ?? 1;
  const size = Math.max(was, Math.min(learnCap(o.trust), Math.max(1, o.ran) + 1));
  if (size === was) return cur.lower ? { ...cur, lower: 0 } : null;
  return { size, lower: 0, task: o.task, why: "oom", at: o.at };
}

/**
 * After a build completed with its memory high-water mark, `peak_mb`: below
 * what the size under the remembered one gives (peakBelowMb), one more lower
 * peak, and the fifth in a row lets the size decay one step — from 2 to
 * nothing learned; at or above it, the count starts over (that build needed
 * the size). null when nothing changes, and always when nothing is learned.
 */
export function afterBuild(cur: Learned, o: { peak_mb: number; task: number; at: string }): Learned | null {
  if (cur.size === null) return null;
  if (o.peak_mb >= peakBelowMb(cur.size)) return cur.lower ? { ...cur, lower: 0 } : null;
  const lower = cur.lower + 1;
  if (lower < DECAY_AFTER) return { ...cur, lower };
  return { size: cur.size > 2 ? cur.size - 1 : null, lower: 0, task: o.task, why: "decay", at: o.at };
}

/** A remembered size as the package page shows it: the size, the lower peaks counted of the five, and what last changed it. */
export interface LearnedView { size: number; lower: number; of: number; task: number | null; why: "oom" | "decay" | null; at: string | null }

/**
 * What a package's builds ask for, as its page shows it: the size and the
 * disk budget set on the page, else factory/sizing's, else the size learned
 * from its builds (#330), else size 1 — the budget the page's, else the
 * file's, else the signed GB per size of that size — before the claim clamps
 * the size (a contributor's to 2, every one to the largest host alive).
 * `from` says whose word the size is, `disk_from` the budget's; `learned`,
 * only while a size is learned, what the pool remembers whether or not a
 * maintainer's size wins over it.
 */
export function sizingView(pkg: { name?: unknown; size?: unknown; disk_gb?: unknown; learned_size?: unknown; learned_lower?: unknown; learned_task?: unknown; learned_why?: unknown; learned_at?: unknown }): {
  size: number; disk_gb: number; from: "page" | "file" | "learned" | null; disk_from: "page" | "file" | null; learned?: LearnedView;
} {
  const file = typeof pkg.name === "string" ? shippedSizing().get(pkg.name) : undefined;
  const pageSize = typeof pkg.size === "number" ? pkg.size : null;
  const pageDisk = typeof pkg.disk_gb === "number" ? pkg.disk_gb : null;
  const learned = learnedOf(pkg);
  const size = pageSize ?? file?.size ?? learned.size ?? 1;
  const disk = pageDisk ?? file?.disk_gb ?? null;
  return {
    size, disk_gb: disk ?? BUILD_GB_PER_SIZE * size,
    from: pageSize !== null ? "page" : file?.size ? "file" : learned.size !== null ? "learned" : null,
    disk_from: pageDisk !== null ? "page" : file?.disk_gb ? "file" : null,
    ...(learned.size !== null ? { learned: { size: learned.size, lower: learned.lower, of: DECAY_AFTER, task: learned.task, why: learned.why, at: learned.at } } : {}),
  };
}
