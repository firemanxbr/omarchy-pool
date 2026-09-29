/**
 * What the pool reads of a project's repository for the Factory's form
 * (GET /factory/source?url=, #246): the name, the description, the licence
 * and the latest release, so a person pastes the repository and the form
 * fills in the rest. GitHub is read the way the request reads it — the same
 * detect() (routes/contributors.ts), so what the form shows is what the
 * request will record. GitLab (gitlab.com) and Codeberg (codeberg.org) are
 * read through their public APIs, and their release is named for the
 * request as the source tarball and its version (`send`): the request takes
 * a project that is not on GitHub by those two fields.
 *
 * Reading costs the pool two or three calls to a forge's API — on GitHub,
 * the token the scheduler's reads share — so it is kept cheap: only a
 * person signed in and not blocked makes the pool ask a forge, at most
 * READS_PER_HOUR times an hour; only the three forges are asked — never an
 * address a caller made up —; nothing is read where SOURCE_CHECK is off
 * (the tests, the end-to-end run: no host is asked there); and what a read
 * found is kept at the edge by the repository, not by the address as typed
 * — ten minutes, a minute when it found nothing — and answered to whoever
 * asks for that repository meanwhile, a visitor too: the repository's
 * public words, read once.
 */
import { edgeHit, edgeStore, json, type Env } from "../index";
import { machineOrigin } from "../meta";
import { contributorOf, detect, parseProjectUrl, workspace } from "./contributors";
import { FORGES, LICENSE, forgeOf, type Forge } from "../request";

/** The forges the form reads, by their host — GitHub through the request's own detect(), the other two through their APIs — and where on one an address points: the request's own rule (request.ts), so the record and the read name one repository. */
export { FORGES, forgeOf, type Forge };

/** What a read found: the repository's words and its latest release. `send` is what the request needs from the form to build that release — nothing for GitHub, which the request reads itself; the tarball and the version elsewhere. */
export interface SourceRead {
  description: string | null;
  license: string | null;
  version: string | null;
  source: string | null;
  archived: boolean;
  build_system: string | null;
  send: { source?: string; version?: string };
}

/** The SPDX identifiers a forge names in other cases (GitLab's keys are lower case), in the case SPDX writes them; a licence not listed is left for the person to name. */
const SPDX_KNOWN = ["MIT", "Apache-2.0", "GPL-2.0", "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0", "GPL-3.0-only", "GPL-3.0-or-later", "LGPL-2.1", "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0", "LGPL-3.0-only", "LGPL-3.0-or-later", "AGPL-3.0", "AGPL-3.0-only", "AGPL-3.0-or-later", "BSD-2-Clause", "BSD-3-Clause", "MPL-2.0", "ISC", "Unlicense", "0BSD", "Zlib", "CC0-1.0", "EPL-2.0", "BSL-1.0", "EUPL-1.2", "WTFPL", "Artistic-2.0"];
export function spdxOf(id: unknown): string | null {
  const k = typeof id === "string" ? id.trim().toLowerCase() : "";
  const known = SPDX_KNOWN.find((s) => s.toLowerCase() === k) ?? null;
  return known && LICENSE.test(known) ? known : null;
}

/** An address as a person pastes it: the scheme added when there is none ("gitlab.com/you/project"). */
export function normaliseUrl(raw: string): string {
  const u = raw.trim();
  return u && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? `https://${u}` : u;
}

async function getJson(fetcher: typeof fetch, url: string): Promise<unknown> {
  const res = await fetcher(url, { headers: { accept: "application/json", "user-agent": "omarchy-pool-factory" }, signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return res.json();
}

/** A GitLab project: its words, its licence (GitLab's key), its latest release or, without one, its newest tag, and the tarball GitLab serves for it. */
async function readGitLab(path: string, repo: string, fetcher: typeof fetch): Promise<SourceRead | { error: string }> {
  const api = `https://gitlab.com/api/v4/projects/${encodeURIComponent(path)}`;
  const meta = (await getJson(fetcher, `${api}?license=true`)) as { description?: string | null; archived?: boolean; license?: { key?: string; nickname?: string } | null } | null;
  if (!meta) return { error: `${path} not found on GitLab` };
  const releases = (await getJson(fetcher, `${api}/releases?per_page=1`)) as { tag_name?: string }[] | null;
  let tag = releases?.[0]?.tag_name ?? null;
  if (!tag) tag = ((await getJson(fetcher, `${api}/repository/tags?per_page=1`)) as { name?: string }[] | null)?.[0]?.name ?? null;
  const source = tag ? `https://gitlab.com/${path}/-/archive/${encodeURIComponent(tag)}/${repo}-${encodeURIComponent(tag)}.tar.gz` : null;
  return { description: meta.description?.trim() || null, license: spdxOf(meta.license?.key) ?? spdxOf(meta.license?.nickname), version: tag, source, archived: !!meta.archived, build_system: null, send: source && tag ? { source, version: tag } : {} };
}

/** A Codeberg repository (Forgejo's API): its words, the licences it detected, its latest release or newest tag, and its tarball. */
async function readCodeberg(path: string, fetcher: typeof fetch): Promise<SourceRead | { error: string }> {
  const api = `https://codeberg.org/api/v1/repos/${path}`;
  const meta = (await getJson(fetcher, api)) as { description?: string | null; archived?: boolean; licenses?: string[] | null } | null;
  if (!meta) return { error: `${path} not found on Codeberg` };
  let tag = ((await getJson(fetcher, `${api}/releases/latest`)) as { tag_name?: string } | null)?.tag_name ?? null;
  if (!tag) tag = ((await getJson(fetcher, `${api}/tags?limit=1`)) as { name?: string }[] | null)?.[0]?.name ?? null;
  const source = tag ? `https://codeberg.org/${path}/archive/${encodeURIComponent(tag)}.tar.gz` : null;
  return { description: meta.description?.trim() || null, license: spdxOf(meta.licenses?.[0]), version: tag, source, archived: !!meta.archived, build_system: null, send: source && tag ? { source, version: tag } : {} };
}

/** A GitHub repository, read by the request's own detect() short of the tree (the card shows no build system): the release the request would build (the tag in the address, else the latest), and nothing for the form to send — the request reads GitHub itself. */
async function readGitHub(project: string, tagInUrl: string | null, sourceInUrl: string | null, env: Env, fetcher: typeof fetch): Promise<SourceRead | { error: string }> {
  const d = await detect(project, env, fetcher, { tree: false });
  if (d.error) return { error: String(d.error) };
  const tag = tagInUrl ?? (typeof d.latest_tag === "string" ? d.latest_tag : null);
  const license = typeof d.license === "string" && d.license !== "NOASSERTION" && LICENSE.test(d.license) ? d.license : null;
  return { description: typeof d.description === "string" ? d.description.trim() || null : null, license, version: tag, source: sourceInUrl ?? (tag ? `${project}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz` : null), archived: d.archived === true, build_system: typeof d.build_system === "string" ? d.build_system : null, send: {} };
}

/** A repository read, whatever forge it is on; null for an address on none of them. */
export async function readSource(url: string, env: Env, fetcher: typeof fetch = fetch): Promise<SourceRead | { error: string } | null> {
  const where = forgeOf(url);
  if (!where) return null;
  try {
    if (where.forge === "github.com") {
      const parsed = parseProjectUrl(url);
      if ("error" in parsed) return { error: parsed.error };
      return await readGitHub(parsed.project, parsed.tag, parsed.source, env, fetcher);
    }
    return where.forge === "gitlab.com" ? await readGitLab(where.path, where.repo, fetcher) : await readCodeberg(where.path, fetcher);
  } catch (e) {
    return { error: String(e instanceof Error ? e.message : e) };
  }
}

/** How long a read is kept at the edge, by the repository it read (readKey): ten minutes; a read that failed — nothing there, the forge refusing — a minute, so a mistyped address typed again asks the forge nothing and a fixed one is read again soon. */
export const KEEP_READ = 600, KEEP_FAILED = 60;
/** The reads one person may have the pool ask a forge for in an hour: a person pasting a few projects asks a handful; a script asking thousands would spend the token the scheduler's GitHub reads live on (5000 an hour, shared by them all). */
export const READS_PER_HOUR = 60;

/** The edge key of a repository's read: the forge and the repository as forgeOf names them, in lower case (the three forges match a path so), and a tag the address named — never the address as typed, so a scheme, a slash, ".git", a view or a query more are the same read. Outside /api/v1, where no request's own URL is looked up (cachedApi), so only this handler reads it. */
function readKey(origin: string, where: { forge: Forge; path: string }, tag: string | null): Request {
  return new Request(`${origin}/_edge/source/${encodeURIComponent(`${where.forge}/${where.path}`.toLowerCase())}${tag ? `@${encodeURIComponent(tag)}` : ""}`);
}

/**
 * One more forge read for this person this hour, if they have one left:
 * the count is a number kept at the edge until the hour ends — per colo and
 * a read-modify-write, so approximate, and never a D1 row: a count is not
 * worth a write per read.
 */
async function spend(origin: string, login: string): Promise<boolean> {
  const hour = Math.floor(Date.now() / 3600000);
  const key = new Request(`${origin}/_edge/source-reads/${encodeURIComponent(login)}/${hour}`);
  const hit = await edgeHit(key);
  const n = hit ? Number(await hit.text()) || 0 : 0;
  if (n >= READS_PER_HOUR) return false;
  await edgeStore(key, new Response(String(n + 1)), Math.max(1, Math.ceil(((hour + 1) * 3600000 - Date.now()) / 1000)));
  return true;
}

/**
 * GET /factory/source?url= — what the address says (`project`, the
 * `forge`, the `name` a request would take from it) and what the repository
 * says (`read`: true, with the fields of SourceRead); `why` says why nothing
 * was read. An address the request would refuse is answered 400 in the
 * request's words (parseProjectUrl).
 *
 * A read is kept at the edge by the repository (readKey), and whoever asks
 * for that repository while it is kept gets it, a visitor too — the
 * repository's public words, read once. Only a person signed in, and not
 * blocked (the request refuses them the same way), makes the pool ask the
 * forge, at most READS_PER_HOUR times an hour. What was read or not is kept
 * under that key alone (x-pool-cache: cachedApi never keeps it under the
 * address as typed).
 */
export async function handleSourceRead(url: URL, request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  const raw = normaliseUrl(url.searchParams.get("url") ?? "");
  if (!raw) return json({ error: "url is required: the project's repository on GitHub, GitLab or Codeberg, or its home page" }, 400, { "cache-control": "no-store" });
  const parsed = parseProjectUrl(raw);
  if ("error" in parsed) return json({ error: parsed.error }, 400, { "cache-control": "no-store" });
  const where = forgeOf(raw);
  const name = (parsed.github?.repo ?? where?.repo ?? parsed.project.split("/").pop() ?? "").toLowerCase();
  const base = { url: raw, project: parsed.project, forge: where ? FORGES[where.forge] : null, name };
  const answer = (body: Record<string, unknown>, cache: string, edge: "hit" | "miss") => {
    const res = json({ ...base, ...body }, 200, { "cache-control": cache });
    res.headers.set("x-pool-cache", edge);
    return res;
  };
  const unread = (why: string) => answer({ read: false, why }, "no-store", "miss");
  if (!where) return unread("not on GitHub, GitLab or Codeberg: name the release — its source and its version");
  if (env.SOURCE_CHECK === "off") return unread("this pool reads no repository");
  const origin = machineOrigin(url), key = readKey(origin, where, parsed.tag);
  const kept = await edgeHit(key);
  if (kept) return answer((await kept.json()) as Record<string, unknown>, kept.headers.get("cache-control") ?? "no-store", "hit");
  const c = await contributorOf(request, env);
  if (!c) return unread("sign in, and the pool reads the repository");
  const blocked = workspace(c, c.login).request;
  if (!blocked.ok) return unread(blocked.why);
  if (!(await spend(origin, c.login))) return unread(`read ${READS_PER_HOUR} repositories for you this hour; fill the card in, and sending reads it`);
  const got = await readSource(raw, env, fetcher);
  const body = got && !("error" in got) ? { read: true, ...got } : { read: false, why: got ? got.error : "not read" };
  const keep = body.read ? KEEP_READ : KEEP_FAILED;
  await edgeStore(key, Response.json(body), keep);
  return answer(body, `public, max-age=${keep}`, "miss");
}
