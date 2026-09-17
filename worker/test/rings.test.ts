/**
 * The rings are one list. meta.ts owns it — RINGS, PROMOTED_RINGS, the
 * two derived orders, ringsSql() for the queries and sortRings() for the
 * lists — and index.ts re-exports it. Five routes had typed the four names
 * into their SQL and their sort order by hand (2026-09-18), so a ring
 * added to the constant would have been missing from "which rings serve
 * this package" on a build's page, Review, a person's page, the package
 * story and a registration. This file reads the server's sources and
 * fails a file that types two ring names side by side — an IN list, an
 * array, an alternation — outside the constant's own home, and pins what
 * the helpers say.
 */
import { describe, expect, it } from "vitest";
import { RINGS, PROMOTED_RINGS, RINGS_BY_STABILITY, RINGS_UPWARD, isRing, ringsSql, sortRings, sourceOfRepo } from "../src/meta";
import * as index from "../src/index";

// The server's sources, as text (Vite's ?raw): every file under src/ and src/routes/ except the pages, the docs and meta.ts, which owns the list.
const sources = Object.entries(import.meta.glob("../src/{*,routes/*}.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>)
  .filter(([path]) => !path.endsWith("/meta.ts"))
  .map(([path, text]) => [path.replace(/^.*\/src\//, "src/"), text] as const);

describe("the rings, said once", () => {
  it("are the list index.ts re-exports, and every order is derived from it", () => {
    expect(index.RINGS).toBe(RINGS);
    expect(index.PROMOTED_RINGS).toBe(PROMOTED_RINGS);
    expect(index.RINGS_BY_STABILITY).toBe(RINGS_BY_STABILITY);
    expect(index.isRing).toBe(isRing);
    expect([...RINGS_BY_STABILITY]).toEqual([...[...PROMOTED_RINGS].reverse(), ...RINGS.filter((r) => !(PROMOTED_RINGS as readonly string[]).includes(r))]);
    expect([...RINGS_UPWARD]).toEqual([...RINGS_BY_STABILITY].reverse());
    for (const r of RINGS) expect(isRing(r)).toBe(true);
    expect(isRing("prod")).toBe(false);
  });

  it("write the SQL fragment and the served order from the constant, and refuse a name that is not a ring's", () => {
    expect(ringsSql(RINGS)).toBe(RINGS.map((r) => `'${r}'`).join(", "));
    expect(ringsSql(PROMOTED_RINGS)).toBe("'edge', 'rc', 'stable'");
    expect(() => ringsSql(["x'; DROP TABLE packages; --"] as unknown as typeof RINGS)).toThrow(/not a ring/);
    expect(sortRings(["stable", "lab", "rc", "edge"])).toEqual([...RINGS_UPWARD]);
    expect(sortRings(["stable", "other", "edge"])).toEqual(["edge", "stable", "other"]);
    // A rendered repository's name carries the ring; the pattern is written from the list, so a fifth ring is read too.
    for (const r of RINGS) expect(sourceOfRepo(`omarchy-core-${r}`)).toBe("core");
    expect(sourceOfRepo("omarchy-core-prod")).toBeNull();
  });

  it("are typed by hand in no server file", () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.map(([p]) => p)).toContain("src/routes/review.ts");
    const name = RINGS.join("|");
    const pairs = new RegExp(`['"](${name})['"]\\s*,\\s*['"](${name})['"]`); // IN ('lab', 'edge', …) or ["lab", "edge", …]
    const alternation = new RegExp(`\\((${name})\\|(${name})`); // a regex naming the rings
    const typed = sources.filter(([, text]) => pairs.test(text) || alternation.test(text)).map(([p]) => p);
    expect(typed, "ring lists typed by hand — write them from RINGS / PROMOTED_RINGS through ringsSql() or sortRings() (meta.ts)").toEqual([]);
  });
});
