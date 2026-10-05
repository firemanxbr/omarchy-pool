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
 */
import { parse } from "smol-toml";
import tasksToml from "../../factory/sizing/tasks.toml";
import { BUILD_GB_PER_SIZE } from "./hosts";

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
 * What a package's builds ask for, as its page shows it: the size and the
 * disk budget set on the page, else factory/sizing's, else size 1 and the
 * signed GB per size — before the claim clamps the size (a contributor's to
 * 2, every one to the largest host alive). `from` says whose word the size
 * is, `disk_from` the budget's.
 */
export function sizingView(pkg: { name?: unknown; size?: unknown; disk_gb?: unknown }): { size: number; disk_gb: number; from: "page" | "file" | null; disk_from: "page" | "file" | null } {
  const file = typeof pkg.name === "string" ? shippedSizing().get(pkg.name) : undefined;
  const pageSize = typeof pkg.size === "number" ? pkg.size : null;
  const pageDisk = typeof pkg.disk_gb === "number" ? pkg.disk_gb : null;
  const size = pageSize ?? file?.size ?? 1;
  const disk = pageDisk ?? file?.disk_gb ?? null;
  return { size, disk_gb: disk ?? BUILD_GB_PER_SIZE * size, from: pageSize !== null ? "page" : file?.size ? "file" : null, disk_from: pageDisk !== null ? "page" : file?.disk_gb ? "file" : null };
}
