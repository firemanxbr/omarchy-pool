/**
 * Which machine a library is built for, from what the index holds (#275).
 * pkg-extract records a library a package ships twice — the soname
 * (`libz.so.1`) and Arch's `libz.so=1-64`, whose suffix is its ELF class —
 * and nothing of its ELF machine; the file list says where it lies. Two
 * rules follow, one per fact:
 *
 * - The class. A 32-bit binary (lib32, i686) loads 32-bit libraries, a
 *   64-bit one 64-bit libraries: lib32-curl's libc.so.6 is lib32-glibc's,
 *   whatever it declares. A package's class is read off its manifest once,
 *   at indexing (`packages.elf_class`, migration 0041).
 * - The machine. A library in a toolchain's sysroot, `/usr/<target>/`
 *   (`/usr/aarch64-linux-gnu/lib/libstdc++.so.6`), is another machine's,
 *   on no path this machine's loader searches — whatever the package's own
 *   architecture: aarch64-linux-gnu-gcc is an x86_64 package. An `any`
 *   package's libraries are all another machine's (the lookup's own rule).
 */

/** Arch's form of a library by class, `libz.so=1-64`: the capability, and the constraint that carries the class. */
export const CLASS_FORM = /^(.*\.so)(=.*-(32|64))$/;

/**
 * The ELF classes a package's objects are built for: `32`, `32 64` when it
 * ships both, and null for the machine's own — 64-bit on both architectures
 * the pool serves — or nothing to tell by (a package that ships no library
 * and declares none is a program of the machine's class). Read from the
 * libraries it ships and declares in the class form, and the ones it
 * declares it needs. Migration 0041 computes the same over the rows it
 * found; test/soname-provider.test.ts holds the two together.
 */
export function elfClassOf(m: { provides?: string[]; pkginfo?: { depends?: string[] } }): string | null {
  const bits = new Set([...(m.provides ?? []), ...(m.pkginfo?.depends ?? [])].map((r) => r.match(CLASS_FORM)?.[3]).filter((b) => !!b));
  return bits.has("32") ? (bits.has("64") ? "32 64" : "32") : null;
}

/** Whether a binary of class `a` can load a library of class `b` (either null: the machine's own, 64-bit). */
export function classesMeet(a: string | null, b: string | null): boolean {
  const of = (x: string | null) => (x ?? "64").split(" ");
  return of(a).some((c) => of(b).includes(c));
}

/** The same test in SQL, over two columns or parameters. */
export function classesMeetSql(a: string, b: string): string {
  return `((instr(coalesce(${a}, '64'), '64') > 0 AND instr(coalesce(${b}, '64'), '64') > 0) OR (instr(coalesce(${a}, '64'), '32') > 0 AND instr(coalesce(${b}, '64'), '32') > 0))`;
}

/** The soname a capability names: itself (`libz.so.1`), or a class form's (`libz.so` with `=1-64`); null for anything else. */
export function sonameOf(capability: string, constraint = ""): string | null {
  const form = `${capability}${constraint}`.match(CLASS_FORM);
  if (form) return `${form[1]}.${form[2].slice(1, form[2].lastIndexOf("-"))}`;
  return /\.so\.[0-9]/.test(capability) && !constraint ? capability : null;
}

/** A toolchain's sysroot: the first directory under /usr named for a target (`aarch64-linux-gnu`) — no directory of the machine's own has a dash. */
const SYSROOT = /^\/?usr\/[^/]*-[^/]*\//;

/** Whether a package ships a soname only inside a sysroot: another machine's library. Unknown (no file of that name listed) is not. */
export function onlyInSysroot(files: string[], soname: string): boolean {
  const at = files.filter((f) => f === soname || f.endsWith(`/${soname}`));
  return at.length > 0 && at.every((f) => SYSROOT.test(f));
}
