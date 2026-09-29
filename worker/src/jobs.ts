/**
 * A maintainer runs a pool job by hand — a sync, a promotion, a render, a
 * health check, the security run, gc, the PKGBUILD reconcile — the way the
 * scheduler does: a task in the queue that a project worker executes with
 * a per-job token. No credential of the maintainer's touches the pool.
 *
 * A promotion forced past its evidence and the gate (`force: "yes"`) ships
 * what no check passed, so it is confirmed with the maintainer's passkey,
 * in the browser (#284): the door's `gate` (routes/passkeys.ts webGate) for
 * exactly this promotion — its rings and its architecture — refuses a
 * token of any kind, and the answer and the journal's line name the passkey.
 */
import { json, readJson, type Env } from "./index";
import { PROMOTED_RINGS, REPO_ARCHES, RINGS } from "./meta";
import { createJob, SYNC_SOURCES, syncJobFor } from "./scheduler";
import type { Contributor } from "./routes/contributors";
import { forcedSubject, type PasskeyGate } from "./routes/passkeys";

// The rings and the architectures are meta.ts's; the messages name them from the lists, so a ring or an architecture added there is named here.
const PROMISED: readonly string[] = PROMOTED_RINGS;
const ALL_RINGS: readonly string[] = RINGS;
const ARCHES: readonly string[] = REPO_ARCHES;

/** The jobs a maintainer may queue by hand — the switch below, one case each; the API page's row and `pkg-repo job`'s refusal name this list. */
export const JOB_KINDS = ["sync", "promote", "rollback", "render", "health", "security", "enqueue", "gc", "verify", "relayout", "trial"] as const;

export async function handleQueueJob(c: Contributor, request: Request, env: Env, gate?: (subject: string) => PasskeyGate): Promise<Response> {
  const b = await readJson<{ kind?: string; params?: Record<string, unknown>; arch?: string; assertion?: unknown }>(request);
  if (b instanceof Response) return b;
  if (!(JOB_KINDS as readonly string[]).includes(b.kind ?? "")) return json({ error: `kind must be one of ${JOB_KINDS.join(", ")}` }, 400);
  const p = b.params ?? {};
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  let job: { kind: string; params: Record<string, string>; arch: string };
  /** The passkey a forced promotion was confirmed with (#284); null for every other job. */
  let passkey: string | null = null;
  switch (b.kind) {
    case "sync": {
      // A whole architecture (one release per ring, like the scheduler's), or one source.
      if (!s("source")) {
        const arch = s("arch") || "x86_64";
        if (!ARCHES.includes(arch)) return json({ error: "sync needs arch (x86_64, aarch64), or a source" }, 400);
        job = syncJobFor(arch);
        break;
      }
      const src = SYNC_SOURCES.find((x) => x.source === s("source") && x.arch === (s("arch") || "x86_64") && x.ring === (s("ring") || "edge"));
      if (!src) return json({ error: "sync needs a known source, arch and ring", sources: SYNC_SOURCES.map((x) => `${x.source}/${x.arch}→${x.ring}`) }, 400);
      job = { kind: "sync", params: { ...src, defer_to: src.defer_to ?? "" }, arch: src.arch };
      break;
    }
    case "promote": {
      const from = s("from"), to = s("to");
      if (!PROMISED.includes(from) || !PROMISED.includes(to) || from === to) return json({ error: `promote needs from and to (${PROMISED.join(", ")} — the lab is never promoted)` }, 400);
      const params: Record<string, string> = { from, to, note: s("note") || `manual ${from} → ${to} by ${c.login}` };
      if (s("arch")) {
        // One architecture only: its evidence, its gate, its rows; the other keeps what the target serves.
        if (!ARCHES.includes(s("arch"))) return json({ error: "arch must be x86_64 or aarch64" }, 400);
        params.arch = s("arch");
      }
      if (s("force") === "yes") {
        // Skips the evidence and the gate (the target's health still decides): the maintainer's passkey for exactly this promotion, in the browser, or nothing is queued (#284).
        if (!gate) return json({ error: "a promotion forced past its evidence is confirmed with a passkey, and this door asks for none: nothing was queued", code: "passkey_required" }, 403);
        const ok = await gate(forcedSubject(from, to, params.arch))(b.assertion);
        if (ok instanceof Response) return ok;
        passkey = ok.passkey;
        params.force = "yes";
      }
      job = { kind: "promote", params, arch: "x86_64" };
      break;
    }
    case "rollback": {
      const ring = s("ring"), to = s("to");
      if (!ALL_RINGS.includes(ring) || !/^\d+$/.test(to)) return json({ error: `rollback needs ring (${ALL_RINGS.join(", ")}) and to (a release id of that ring)` }, 400);
      // An earlier release of the ring, never another ring's (#284): stable pointed at edge's selection would be a promotion past
      // rc, the gate and the soak with no passkey — the forced promotion's door without its guard. The release by its primary key.
      const of = await env.DB.prepare("SELECT ring FROM releases WHERE id = ?").bind(Number(to)).first<{ ring: string }>();
      if (of?.ring !== ring) return json({ error: `release ${to} is ${of ? `${of.ring}'s` : "no release"}: a rollback points ${ring} at an earlier release of its own, never another ring's (a promotion is the way up); nothing was queued`, code: "another_ring" }, 400);
      const params: Record<string, string> = { ring, to, note: s("note") || `rollback to release ${to} by ${c.login}` };
      if (s("arch")) {
        if (!ARCHES.includes(s("arch"))) return json({ error: "arch must be x86_64 or aarch64" }, 400);
        params.arch = s("arch");
      }
      job = { kind: "rollback", params, arch: "x86_64" };
      break;
    }
    case "render":
    case "health": {
      const ring = s("ring"), arch = s("arch") || "x86_64";
      if (!ALL_RINGS.includes(ring) || !ARCHES.includes(arch)) return json({ error: `${b.kind} needs ring (${ALL_RINGS.join(", ")}) and arch (x86_64, aarch64)` }, 400);
      job = { kind: b.kind, params: { ring, arch }, arch };
      break;
    }
    case "gc":
      job = { kind: "gc", params: s("keep") ? { keep: s("keep") } : {}, arch: "x86_64" };
      break;
    case "relayout":
      // The one-time move of every object into its source's directory (routes/relayout.ts).
      job = { kind: "relayout", params: {}, arch: "x86_64" };
      break;
    case "trial": {
      // The trial of a staged project build again, by hand: its package into the lab, a real pacman installs it.
      const t = /^\d+$/.test(s("task")) ? await env.DB.prepare("SELECT id, name, arch, version, result_filename, trust, status FROM build_tasks WHERE id = ? AND kind = 'build'").bind(Number(s("task"))).first<{ id: number; name: string; arch: string; version: string | null; result_filename: string | null; trust: string; status: string }>() : null;
      if (!t) return json({ error: "trial needs task, a staged build's id" }, 400);
      if (t.trust !== "project" || t.status !== "staged" || !t.result_filename) return json({ error: `task ${t.id} is not a staged build of the project's (${t.trust}, ${t.status}); only the project's builds are tried` }, 409);
      job = { kind: "trial", params: { task: String(t.id), name: t.name, arch: t.arch, version: t.version ?? "", files: JSON.stringify([t.result_filename]) }, arch: t.arch };
      break;
    }
    case "security":
    case "enqueue":
      job = { kind: b.kind, params: {}, arch: ARCHES.includes(b.arch ?? "") ? (b.arch as string) : "x86_64" };
      break;
    case "verify": {
      // Every ring and architecture by default; repair=no only reports.
      const params: Record<string, string> = {};
      if (s("ring")) { if (!PROMISED.includes(s("ring"))) return json({ error: `ring must be one of ${PROMISED.join(", ")} (the lab holds no OPR object to verify)` }, 400); params.ring = s("ring"); }
      if (s("arch")) { if (!ARCHES.includes(s("arch"))) return json({ error: "arch must be x86_64 or aarch64" }, 400); params.arch = s("arch"); }
      if (s("repair") === "no") params.repair = "no";
      job = { kind: "verify", params, arch: "x86_64" };
      break;
    }
    default:
      // Unreachable: the kind was checked against JOB_KINDS above; lists.test.ts holds the cases to that list.
      return json({ error: `kind must be one of ${JOB_KINDS.join(", ")}` }, 400);
  }
  const id = await createJob(env, job, `queued by ${c.login}`);
  // A forced promotion's line says so, amber, with the passkey that confirmed it (#284).
  const forced = passkey ? { status: "warn", summary: `promote ${job.params.from} → ${job.params.to}${job.params.arch ? ` (${job.params.arch})` : ""} forced past its evidence, queued by ${c.login} as task ${id} with their passkey (${passkey})` } : { status: "ok", summary: `${job.kind} queued by ${c.login} as task ${id}` };
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('dispatch', ?, ?, ?, ?, ?)")
    .bind(job.params.to ?? job.params.ring ?? null, job.params.source ?? null, forced.status, forced.summary, JSON.stringify({ task: id, job, by: c.login, ...(passkey ? { via: "web", passkey } : {}) }))
    .run();
  return json({ task: id, job, ...(passkey ? { passkey } : {}) }, 201);
}
