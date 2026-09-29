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
 * Reading costs the pool a few calls to a forge's API, so it is kept cheap:
 * only a person signed in makes the pool read (a visitor gets what the
 * address alone says), only the three forges are asked — never an address
 * a caller made up —, nothing is read where SOURCE_CHECK is off (the tests,
 * the end-to-end run: no host is asked there), and an answer that read the
 * repository is public at the edge for ten minutes, one copy per address.
 * An answer that read nothing is never kept.
 */
import { json, type Env } from "../index";
import { contributorOf, detect, parseProjectUrl } from "./contributors";
import { LICENSE } from "../request";

/** The forges the form reads, by their host: GitHub through the request's own detect(), the other two through their APIs. */
export const FORGES = { "github.com": "GitHub", "gitlab.com": "GitLab", "codeberg.org": "Codeberg" } as const;
export type Forge = keyof typeof FORGES;

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

/** The forge an address is on and the repository's path there: GitHub's owner/repo, GitLab's group/…/project, Codeberg's owner/repo — the ".git", a trailing slash and a view (GitLab's /-/tree/main) set aside. */
export function forgeOf(url: string): { forge: Forge; path: string; repo: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (u.protocol !== "https:" || !(host in FORGES)) return null;
  let segs = u.pathname.split("/").filter(Boolean);
  const view = segs.indexOf("-");
  if (view >= 0) segs = segs.slice(0, view);
  if (host !== "gitlab.com") segs = segs.slice(0, 2);
  if (segs.length < 2) return null;
  segs[segs.length - 1] = segs[segs.length - 1].replace(/\.git$/, "");
  if (!segs.every((s) => /^[A-Za-z0-9_.-]+$/.test(s))) return null;
  return { forge: host as Forge, path: segs.join("/"), repo: segs[segs.length - 1] };
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

/** A GitHub repository, read by the request's own detect(): the release the request would build (the tag in the address, else the latest), and nothing for the form to send — the request reads GitHub itself. */
async function readGitHub(project: string, tagInUrl: string | null, sourceInUrl: string | null, env: Env, fetcher: typeof fetch): Promise<SourceRead | { error: string }> {
  const d = await detect(project, env, fetcher);
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

/**
 * GET /factory/source?url= — what the address says (`project`, the
 * `forge`, the `name` a request would take from it) and, for a person
 * signed in, what the repository says (`read`: true, with the fields of
 * SourceRead); `why` says why nothing was read. An address the request
 * would refuse is answered 400 in the request's words (parseProjectUrl).
 */
export async function handleSourceRead(url: URL, request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  const raw = normaliseUrl(url.searchParams.get("url") ?? "");
  if (!raw) return json({ error: "url is required: the project's repository on GitHub, GitLab or Codeberg, or its home page" }, 400, { "cache-control": "no-store" });
  const parsed = parseProjectUrl(raw);
  if ("error" in parsed) return json({ error: parsed.error }, 400, { "cache-control": "no-store" });
  const where = forgeOf(raw);
  const name = (parsed.github?.repo ?? where?.repo ?? parsed.project.split("/").pop() ?? "").toLowerCase();
  const base = { url: raw, project: parsed.project, forge: where ? FORGES[where.forge] : null, name };
  const unread = (why: string) => json({ ...base, read: false, why }, 200, { "cache-control": "no-store" });
  if (!where) return unread("not on GitHub, GitLab or Codeberg: name the release — its source and its version");
  if (env.SOURCE_CHECK === "off") return unread("this pool reads no repository (SOURCE_CHECK is off)");
  if (!(await contributorOf(request, env))) return unread("sign in, and the pool reads the repository");
  const got = await readSource(raw, env, fetcher);
  if (!got || "error" in got) return unread(got ? got.error : "not read");
  return json({ ...base, read: true, ...got }, 200, { "cache-control": "public, max-age=600" });
}
