/**
 * The request on the record, checked the way the form checks it — the
 * same rules, one function, read by the package's story (a person's page,
 * the package page), by Review (the score) and by the request page when a
 * request is renewed. A request the pool wrote from a registration made
 * before the form existed (`migrated`) confirmed nothing: its checklist
 * is empty, its version may be unknown, and the checks say so — the
 * contributor renews it in a minute, and the score stops guessing.
 */

/** What the contributor confirms with the request; every item, or no request. */
export const CHECKLIST: Record<string, string> = {
  official: "the URL is the project's own repository or its official release — not a fork, not a mirror",
  license: "the licence is the one the project declares (an SPDX identifier)",
  unshipped: "no upstream the pool mirrors ships this package already, and nobody else requested it",
  evidence: "my build is evidence a maintainer learns from, never what users get; the pool may reject or block it",
};

/** SPDX identifier or expression; `custom:` is what Arch writes for the rest. */
export const LICENSE = /^(custom:[A-Za-z0-9._+-]+|[A-Za-z0-9._+-]+(?:\s+(?:OR|AND|WITH)\s+[A-Za-z0-9._+-]+)*)$/;

/** The registration's fields the checks read (factory_packages). */
export interface RequestedPackage {
  project: string | null;
  source: string | null;
  description: string | null;
  license: string | null;
  detected?: string | Record<string, unknown> | null;
}

/** The request row (package_requests), as stored. */
export interface RequestRow {
  id: number;
  version: string;
  checklist: string | null;
  migrated: number;
  record: string;
  sha256: string;
  created_at: string;
  arches?: string | null;
}

export interface RequestCheck {
  key: "project" | "source" | "description" | "license" | "checklist" | "record";
  ok: boolean;
  item: string;
  note: string;
}

export interface RequestChecks {
  checks: RequestCheck[];
  /** Every check green: what the form would accept today. */
  complete: boolean;
  /** The four confirmations, as recorded. */
  confirmed: Record<string, boolean>;
  migrated: boolean;
}

const parse = (s: unknown): Record<string, unknown> => {
  if (!s) return {};
  if (typeof s === "object") return s as Record<string, unknown>;
  try { return JSON.parse(String(s)) as Record<string, unknown>; } catch { return {}; }
};
const https = (s: string | null | undefined): s is string => typeof s === "string" && /^https:\/\/[^\s]+$/.test(s);
/** A URL as a note reads it: the host and the last path segment — github.com/…/v2.16.1.tar.gz. */
const tail = (s: string) => {
  const bare = s.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  const parts = bare.split("/");
  return parts.length > 3 ? `${parts[0]}/…/${parts[parts.length - 1]}` : bare;
};

/** The checks, in the order the form asks; a package with no request row fails the record and the checklist. */
export function requestChecks(pkg: RequestedPackage, req: RequestRow | null): RequestChecks {
  const detected = parse(pkg.detected);
  const confirmed = Object.fromEntries(Object.keys(CHECKLIST).map((k) => [k, parse(req?.checklist)[k] === true]));
  const nConfirmed = Object.values(confirmed).filter(Boolean).length;
  const migrated = !!req && req.migrated === 1;
  const version = (req?.version ?? "").trim();
  const versionKnown = !!version && version !== "unknown";
  const description = (pkg.description ?? "").trim();
  const license = (pkg.license ?? "").trim();
  const ghLicense = typeof detected.license === "string" && detected.license !== "NOASSERTION" ? detected.license : null;
  const licenseAgrees = !ghLicense || ghLicense.toLowerCase() === license.toLowerCase();
  const checks: RequestCheck[] = [
    { key: "project", ok: https(pkg.project), item: "The project's home", note: https(pkg.project) ? tail(pkg.project) : "no project URL on the record" },
    {
      key: "source", ok: https(pkg.source) && versionKnown && pkg.source !== pkg.project,
      item: "The source of the version",
      note: !https(pkg.source) ? "no source URL" : !versionKnown ? "the version is unknown — name the release" : pkg.source === pkg.project ? `${version}, but the source is the project's home, not a release` : `${version} · ${tail(pkg.source)}`,
    },
    { key: "description", ok: description.length >= 8 && description.length <= 120, item: "One line for pacman", note: description ? (description.length > 120 ? `${description.length} characters — 120 is the most` : description.length < 8 ? "too short" : description) : "missing" },
    { key: "license", ok: !!license && LICENSE.test(license) && licenseAgrees, item: "The licence, an SPDX identifier", note: !license ? "missing" : !LICENSE.test(license) ? `${license} is not an SPDX identifier` : !licenseAgrees ? `${license} — GitHub says ${ghLicense}` : license + (ghLicense ? " · GitHub agrees" : "") },
    {
      key: "checklist", ok: nConfirmed === Object.keys(CHECKLIST).length,
      item: "The four confirmations",
      note: nConfirmed === Object.keys(CHECKLIST).length ? "confirmed by the contributor" : migrated ? "none — written from a registration made before the request form; renew the request to confirm them" : req ? `${nConfirmed} of ${Object.keys(CHECKLIST).length}` : "no request on the record",
    },
    { key: "record", ok: !!req && !!req.record, item: "Written once, signed", note: req ? `request #${req.id} · ${req.created_at.slice(0, 10)}` : "no record" },
  ];
  return { checks, complete: checks.every((c) => c.ok), confirmed, migrated };
}
