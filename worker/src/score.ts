/**
 * A package's class, from what the factory recorded about it — the same
 * rules for every package, written down on /docs/what-we-test (*The score*).
 *
 * Two halves, fifty points each, because two people are behind every
 * package the factory ships and neither can do the other's part: the
 * contributor brings the request and a build that passes the gate; the
 * maintainer has the project build it again, reads the evidence, tries it,
 * decides. A build the contributor could not get through the gate is not a
 * maintainer's time; a package nobody rebuilt and tried is not a user's.
 *
 * The class is the score the chain has *today* (A ≥ 90, B ≥ 75, C ≥ 55,
 * D below); `projected` is what it would be with the maintainer's half
 * complete and green — what the dashboard tells a maintainer before they
 * start. Nothing here decides anything: the number ranks, people approve.
 */

export interface ChainInput {
  /** The contributor's build: how many leases it took, how it ended. */
  contributor: { attempts: number; status: string; version?: string | null; bump?: boolean } | null;
  /** The gate on the contributor's build (vet.json's summary). */
  vet: { verdict: string; fails: number; warnings: number } | null;
  /** The second agent's report on it. */
  audit: { status: string; verdict?: string | null; high?: number; findings?: number } | null;
  /** The request on the record: a licence and a source named; `complete` when the form would accept it today (request.ts) — false for one that predates the checklist, null when not looked at; `version` is the release it names, so a build of another version is not this request's evidence. */
  request: { license: string | null; source: string | null; complete?: boolean | null; version?: string | null } | null;
  /** The project's build of it, its gate and its trial. */
  project: { status: string; attempts: number } | null;
  projectVet: { verdict: string; fails: number; warnings: number } | null;
  trial: { status: string; verdict?: string | null } | null;
  /** The decision on the record, and whether a maintainer settled the category. */
  approval: { decision: string; note: string | null } | null;
  category: string | null;
}

export interface ScoreItem {
  who: "contributor" | "maintainer";
  item: string;
  points: number;
  max: number;
  /** done: the item is settled (points earned or not); pending: still to come. */
  state: "done" | "pending";
  note: string;
}

export interface Score {
  points: number;
  max: number;
  class: "A" | "B" | "C" | "D";
  /** The class with the maintainer's half complete and green. */
  projected: "A" | "B" | "C" | "D";
  /** Whether the contributor's half is complete — a maintainer's work can start. */
  ready: boolean;
  items: ScoreItem[];
}

export const CLASSES: [number, "A" | "B" | "C" | "D"][] = [
  [90, "A"],
  [75, "B"],
  [55, "C"],
  [0, "D"],
];

export function classOf(points: number): "A" | "B" | "C" | "D" {
  return CLASSES.find(([min]) => points >= min)?.[1] ?? "D";
}

export function scoreChain(c: ChainInput): Score {
  const items: ScoreItem[] = [];
  const add = (who: ScoreItem["who"], item: string, points: number, max: number, state: ScoreItem["state"], note: string) => items.push({ who, item, points, max, state, note });

  // ---- the contributor's half (50)
  const built = c.contributor && ["staged", "done"].includes(c.contributor.status);
  const attempts = c.contributor?.attempts ?? 0;
  const named = !!(c.request && c.request.license && c.request.source);
  // A build is this request's evidence when it is of the version the request names (the task's version is the tag without its v, dashes as underscores).
  const asVersion = (tag: string) => tag.replace(/^[vV]/, "").replace(/-/g, "_");
  // (A bump — the pool's own build of a new upstream release from the approved recipe — is evidence for the maintainer, not for the request.)
  const stale = !!(named && !c.contributor?.bump && c.request?.version && c.contributor?.version && c.request.version !== "unknown" && asVersion(c.request.version) !== c.contributor.version);
  const incomplete = !c.request || !named || c.request.complete === false || stale;
  add("contributor", "A request on the record", named ? (incomplete ? 2 : 5) : 0, 5, c.request ? "done" : "pending", !c.request ? "no request on the record" : !named ? "the licence or the source is missing" : c.request.complete === false ? "licence and source named, but the request is incomplete — renew it" : stale ? `the request names ${c.request.version}, this build is ${c.contributor?.version} — build again` : "licence and source named");
  add("contributor", "A build that succeeds", built ? Math.max(4, 15 - 3 * Math.max(0, attempts - 1)) : 0, 15, c.contributor ? (built || c.contributor.status === "failed" || c.contributor.status === "cancelled" ? "done" : "pending") : "pending", c.contributor ? (built ? (attempts <= 1 ? "first attempt" : `${attempts} attempts`) : c.contributor.status === "failed" ? "the build failed" : c.contributor.status) : "no build yet");
  add("contributor", "The gate passed", c.vet ? (c.vet.verdict === "pass" ? (c.vet.warnings ? 10 : 15) : 0) : 0, 15, c.vet ? "done" : "pending", c.vet ? (c.vet.verdict === "pass" ? (c.vet.warnings ? `${c.vet.warnings} warning(s)` : "clean") : `${c.vet.fails} check(s) failed`) : built ? "no verdict on the record (built before the gate)" : "not run yet");
  const auditDone = c.audit?.status === "done";
  const auditPts = !auditDone ? 0 : c.audit?.verdict === "ok" ? 15 : c.audit?.verdict === "warn" ? (c.audit.high ? 5 : 10) : 0;
  add("contributor", "The audit", auditPts, 15, auditDone || c.audit?.status === "failed" ? "done" : "pending", auditDone ? `${c.audit?.verdict ?? "done"}${c.audit?.findings ? `, ${c.audit.findings} finding(s)` : ""}${c.audit?.high ? `, ${c.audit.high} high` : ""}` : c.audit ? (c.audit.status === "failed" ? "the audit did not run" : c.audit.status) : "not queued yet");

  // ---- the maintainer's half (50)
  const rebuilt = c.project && ["staged", "done"].includes(c.project.status);
  add("maintainer", "The project built it again", rebuilt ? Math.max(6, 15 - 3 * Math.max(0, (c.project?.attempts ?? 1) - 1)) : 0, 15, c.project ? (rebuilt || c.project.status === "failed" ? "done" : "pending") : "pending", c.project ? (rebuilt ? "on a trusted worker, with the project's agent" : c.project.status === "failed" ? "the project's build failed" : c.project.status) : "not asked yet");
  add("maintainer", "The project's gate", c.projectVet ? (c.projectVet.verdict === "pass" ? (c.projectVet.warnings ? 7 : 10) : 0) : 0, 10, c.projectVet ? "done" : "pending", c.projectVet ? (c.projectVet.verdict === "pass" ? (c.projectVet.warnings ? `${c.projectVet.warnings} warning(s)` : "clean") : "failed") : "not run yet");
  const tried = c.trial?.status === "done";
  add("maintainer", "The trial installed it", tried && c.trial?.verdict === "ok" ? 15 : 0, 15, tried || c.trial?.status === "failed" ? "done" : "pending", tried ? (c.trial?.verdict === "ok" ? "a real pacman, from the lab" : `could not: ${c.trial?.verdict}`) : c.trial ? c.trial.status : "not tried yet");
  add("maintainer", "A decision with a note", c.approval ? (c.approval.decision === "approved" ? (c.approval.note ? 5 : 3) : 0) : 0, 5, c.approval ? "done" : "pending", c.approval ? `${c.approval.decision}${c.approval.note ? ", with a note" : ""}` : "waiting");
  add("maintainer", "The category settled", c.category ? 5 : 0, 5, c.category ? "done" : "pending", c.category ? c.category : "a maintainer picks one");

  const points = items.reduce((n, i) => n + i.points, 0);
  const max = items.reduce((n, i) => n + i.max, 0);
  const contributorPts = items.filter((i) => i.who === "contributor").reduce((n, i) => n + i.points, 0);
  const projected = classOf(contributorPts + 50);
  // Ready for a maintainer: built, through the gate, audited — and a request as the form would take it today, of this version (an incomplete one is the contributor's to renew; a build of another version is the contributor's to redo).
  const ready = !!(built && c.vet?.verdict === "pass" && (auditDone || c.audit?.status === "failed") && !incomplete);
  return { points, max, class: classOf(points), projected, ready, items };
}
