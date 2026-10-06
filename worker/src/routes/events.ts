import { json, readJson, type Env } from "../index";
import type { Contributor } from "./contributors";

interface EventIn {
  kind: string;
  ring?: string | null;
  source?: string | null;
  status?: "ok" | "warn" | "error";
  summary: string;
  payload?: unknown;
  duration_ms?: number | null;
}

/**
 * The journal's kinds only the Worker's own doors write, never a job: a
 * claim and a release of a review (`review`), a decision (`approve`), an
 * adoption (`adopt`), a role or the governance file's exception taken up or
 * ended (`role`). Pages and the API read these lines as decisions people
 * took — the self-reviewed list and Status's count of it (#394), the
 * governance chapter's role changes — so a job's token that could post one
 * would forge a decision nobody took. No job posts them (pkg-repo's events
 * are health, abi, trial, promote, sync and the like).
 */
export const RESERVED_KINDS: readonly string[] = ["review", "approve", "adopt", "role"];

/**
 * POST /events — a line of the journal. A job's token posts what the job
 * did: a health check, an ABI check, a promotion, a sync — the rows the
 * promotion gate reads as evidence (a health row's soak, an abi row's
 * verdict) and Status draws as the rings' state — never a line of a kind
 * the Worker's doors write (RESERVED_KINDS). A maintainer by hand
 * (`hand`: the session or an `omc_` token) writes a `note` and nothing
 * else (#284): a health or abi row from a token would fill a soak or stand
 * for an ABI check no job ran, and the gate would promote past evidence
 * nobody made — a forced promotion without the passkey.
 */
export async function handlePostEvent(request: Request, env: Env, hand: Contributor | null): Promise<Response> {
  const e = await readJson<EventIn>(request);
  if (e instanceof Response) return e;
  if (!e?.kind || !e.summary) return json({ error: "kind and summary are required" }, 400);
  if (hand && e.kind !== "note") return json({ error: `a maintainer writes a note to the journal (kind "note"); a ${e.kind} line is a job's — what the gate and Status read as evidence; nothing was written`, code: "note_only" }, 403);
  if (RESERVED_KINDS.includes(e.kind)) return json({ error: `a ${e.kind} line is written by the pool's own doors — a decision, an adoption or a role a person took — never by a job; nothing was written`, code: "reserved_kind" }, 403);
  const status = e.status ?? "ok";
  if (!["ok", "warn", "error"].includes(status)) return json({ error: "bad status" }, 400);
  // The two payload fields the pages write into an address: a run's link must be an https URL and a release an id — any job token may post here, and Status's journal draws the payload for every reader.
  const p = e.payload as { ci?: { run_url?: unknown }; release_id?: unknown } | null | undefined;
  const run = p?.ci?.run_url;
  if (run !== undefined && !(typeof run === "string" && /^https:\/\//i.test(run))) return json({ error: "payload.ci.run_url must be an https URL" }, 400);
  const rid = p?.release_id;
  if (rid !== undefined && rid !== null && !(Number.isInteger(rid) && (rid as number) > 0)) return json({ error: "payload.release_id must be a release's id" }, 400);
  const row = await env.DB.prepare(
    "INSERT INTO events (kind, ring, source, status, summary, payload, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at",
  )
    .bind(e.kind, e.ring ?? null, e.source ?? null, status, e.summary, e.payload === undefined ? null : JSON.stringify(e.payload), e.duration_ms ?? null)
    .first<{ id: number; created_at: string }>();
  return json(row, 201);
}

export async function handleGetEvents(url: URL, env: Env): Promise<Response> {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const kind = url.searchParams.get("kind");
  const rows = kind
    ? await env.DB.prepare("SELECT * FROM events WHERE kind = ? ORDER BY id DESC LIMIT ?").bind(kind, limit).all()
    : await env.DB.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").bind(limit).all();
  return json({
    events: rows.results.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload as string) : null })),
  });
}
