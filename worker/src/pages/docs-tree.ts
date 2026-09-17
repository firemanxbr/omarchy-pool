/**
 * The documentation's one map: chapters in reading order, each with the
 * sections its page carries (the `id` is the anchor on that page). Every
 * docs page draws the same sidebar from it — the search, and the chapters
 * that open into their sections — so a reader never leaves the shell:
 * the index, a chapter, a section are one layout with the map beside it.
 */

import { lead, outline, sectionText } from "../markdown";
import architecture from "../docs/architecture.md";
import runbook from "../docs/runbook.md";
import testing from "../docs/testing.md";
import migration from "../docs/migration.md";
import factory from "../docs/factory.md";
import workerHost from "../docs/worker-host.md";
import securityModel from "../docs/security-model.md";
import contributing from "../docs/contributing.md";
import proofOfConcept from "../docs/proof-of-concept.md";
import openWork from "../docs/open-work.md";
import omarchyCliMcp from "../docs/omarchy-cli-mcp.md";
import whatWeTest from "../docs/what-we-test.md";
// The skills the agents read (factory/skills), spliced into the What we test chapter: one text, two readers.
import skillEveryPackage from "../../../factory/skills/general/every-package.md";
import skillDesktopApps from "../../../factory/skills/groups/desktop-apps.md";
import skillPrebuiltBinaries from "../../../factory/skills/groups/prebuilt-binaries.md";

export type DocKey =
  | "index"
  | "get-started"
  | "workers"
  | "how-it-works"
  | "what-we-test"
  | "governance"
  | "security"
  | "glossary"
  | "api"
  | "omarchy-cli-mcp"
  | "architecture"
  | "runbook"
  | "testing"
  | "migration"
  | "factory"
  | "worker-host"
  | "security-model"
  | "contributing"
  | "proof-of-concept"
  | "open-work";

/** The two halves of the map: what a person using or joining the pool reads, and what a person working on its code reads. */
export type DocGroup = "pool" | "code";

export interface DocSection {
  /** The anchor on the chapter's page. */
  id: string;
  title: string;
  /** What the section answers, in a line: what the search matches, what the index shows. */
  blurb: string;
}

export interface DocChapter {
  key: DocKey;
  href: string;
  label: string;
  blurb: string;
  secs: DocSection[];
  group: DocGroup;
}

/**
 * A chapter written in markdown (src/docs/*.md), rendered by the dashboard
 * (markdown.ts, pages/doc.ts). `from` is the directory the file lived in
 * when its relative links were written, so they still resolve: to another
 * chapter or to the code on GitHub.
 */
export interface MdChapter {
  key: DocKey;
  label: string;
  text: string;
  from: string;
  group: DocGroup;
}

/** The skills, the general ones first, where the chapter's marker stands — the same files every agent reads (factory/bin/agent.py, skills_text). */
export const SKILLS: { file: string; text: string }[] = [
  { file: "factory/skills/general/every-package.md", text: skillEveryPackage },
  { file: "factory/skills/groups/desktop-apps.md", text: skillDesktopApps },
  { file: "factory/skills/groups/prebuilt-binaries.md", text: skillPrebuiltBinaries },
];
const WHAT_WE_TEST = whatWeTest.replace("<!-- skills -->", SKILLS.map((s) => s.text.trim()).join("\n\n"));

export const MD_CHAPTERS: MdChapter[] = [
  { key: "omarchy-cli-mcp", label: "omarchy-cli as an MCP server", text: omarchyCliMcp, from: "docs", group: "pool" },
  { key: "what-we-test", label: "What we test", text: WHAT_WE_TEST, from: ".", group: "pool" },
  { key: "architecture", label: "Architecture", text: architecture, from: "docs", group: "code" },
  { key: "runbook", label: "Runbook", text: runbook, from: "docs", group: "code" },
  { key: "testing", label: "Testing", text: testing, from: "docs", group: "code" },
  { key: "migration", label: "Migration", text: migration, from: "docs", group: "code" },
  { key: "factory", label: "The factory", text: factory, from: "factory", group: "code" },
  { key: "worker-host", label: "The worker host", text: workerHost, from: "factory/host", group: "code" },
  { key: "security-model", label: "Security model", text: securityModel, from: ".", group: "code" },
  { key: "contributing", label: "Contributing", text: contributing, from: ".", group: "code" },
  { key: "proof-of-concept", label: "The proof of concept", text: proofOfConcept, from: "poc", group: "code" },
  { key: "open-work", label: "Open work", text: openWork, from: ".", group: "code" },
];

/** The map's entry for a markdown chapter: its first paragraph, its level-two headings as sections with the text under each. */
function mdChapter(c: MdChapter): DocChapter {
  return {
    key: c.key,
    href: `/docs/${c.key}`,
    label: c.label,
    blurb: lead(c.text),
    group: c.group,
    secs: outline(c.text)
      .filter((h) => h.level === 2)
      .map((h) => ({ id: h.id, title: h.title, blurb: sectionText(c.text, h.id) })),
  };
}

const POOL_CHAPTERS: DocChapter[] = [
  {
    key: "get-started",
    group: "pool",
    href: "/docs/get-started",
    label: "Get started",
    blurb: "Point pacman at a ring: the one command, or the key and the sections by hand; the thin client; switching rings.",
    secs: [
      { id: "which-ring", title: "Which ring is for me?", blurb: "stable for a machine you rely on, rc to see problems first, edge for CI and throwaway machines, the lab to try a build" },
      { id: "ring", title: "Choose a ring and your architecture", blurb: "stable, rc, edge or lab; x86_64 or aarch64 — the command and the sections below follow" },
      { id: "command", title: "The one command", blurb: "curl the setup script, pick a ring: the key, the Include line, then omarchy update — --ring switches, --remove undoes" },
      { id: "key", title: "Trust the database key", blurb: "one import: the key signs the databases and what the factory builds; every other package keeps its upstream signature" },
      { id: "conf", title: "Configure pacman by hand", blurb: "the sections the ring serves right now, one per source, above [core]" },
      { id: "cli", title: "omarchy-cli", blurb: "status, check, upgrade, security; the release tarball until it lands on your ring" },
      { id: "switching", title: "Switching rings, going back", blurb: "only the repository names change; a ring rolls back by itself" },
    ],
  },
  {
    key: "workers",
    group: "pool",
    href: "/docs/workers",
    label: "Run a worker",
    blurb: "One signed image, with Docker or Podman: your own packages, the project's jobs — the registration decides, not the image.",
    secs: [
      { id: "registration", title: "What the registration decides", blurb: "community trust builds its owner's packages; project trust runs the pool's jobs — the token, never the image" },
      { id: "roles", title: "The three roles", blurb: "pool, review, community — what each takes, who registers it, whether it needs two maintainers' trust" },
      { id: "before", title: "Before you start", blurb: "docker or podman, a GitHub token with no permissions, the disk the builds need" },
      { id: "contributor", title: "As a contributor: your own packages", blurb: "the broker holds the token and the agent key and runs no build; the builder is born with nothing" },
      { id: "project", title: "As a maintainer: the pool's jobs and approved rebuilds", blurb: "OMARCHY_WORKER_ROLE pool or review, trusted by two maintainers, on the project's host" },
      { id: "claude-code", title: "A Claude subscription as the agent", blurb: "claude setup-token, Claude Code in print mode, no tools — your subscription, your terms" },
      { id: "secrets", title: "What a build can see", blurb: "nothing the log cannot show: no token, no key, no credential of the host" },
      { id: "running", title: "Keeping it running", blurb: "restart policies, the stop timeout a build needs, the image's updates, cosign" },
    ],
  },
  {
    key: "how-it-works",
    group: "pool",
    href: "/docs/how-it-works",
    label: "How it works",
    blurb: "Where every package comes from, the gates it passes, what protects you — and what the pool does for the people who bring packages in and the people who decide.",
    secs: [
      { id: "sources", title: "Where every package comes from", blurb: "Arch Linux, Arch Linux ARM, the OPR's edge channel, Omarchy for Apple Silicon, Asahi Linux, the optional AUR selections, the factory — each verified against its own keyring, stored once, one directory per source" },
      { id: "stages", title: "What happens to a package", blurb: "sync, pin in edge, promote on evidence, render and verify, serve — the five stages, lit one at a time; the lab beside them, where a real pacman installs a build before anyone decides; the fast lane" },
      { id: "protects", title: "What protects you", blurb: "signatures twice, a real pacman before you, the ABI check, the security layer, immutable releases with automatic rollback, one rule between sources, nothing skips the gates" },
      { id: "never", title: "What a build can never touch", blurb: "the broker holds the credentials and runs no build, the builder is born with nothing, a log that carries a secret is refused, two maintainers' word on a worker, a record withdrawn with a tombstone, the signing key inside the Worker" },
      { id: "people", title: "For contributors and maintainers", blurb: "a request on the record, the same tools at home, an audit before a human, the evidence on one row, the project builds it again, the trial, nobody decides on their own package" },
      { id: "behind", title: "How far behind upstream", blurb: "edge within 3 h, rc minutes after the checks pass, stable about 6 h after rc, a fast-tracked fix at once" },
      { id: "server", title: "Why one host is enough", blurb: "one set of databases per ring, one section per source, the order that decides" },
      { id: "trust", title: "What you trust", blurb: "the projects' own keys unchanged, one database key from the pool" },
      { id: "seal", title: "The seal", blurb: "where every package came from, with proof: the project and keyring for a synced one, the whole chain and a signed attestation for a factory one" },
      { id: "pieces", title: "The pieces", blurb: "the pool on R2, the index in D1, one Worker for the API and this site, the jobs, the factory, the tools" },
    ],
  },
  {
    key: "governance",
    group: "pool",
    href: "/docs/governance",
    label: "Governance",
    blurb: "Two roles, one file, decisions by pull request: contributors and maintainers, the project's workers, blocking, becoming a maintainer, the record.",
    secs: [
      { id: "maintainers", title: "The maintainers", blurb: "read live from factory/MAINTAINERS.toml on main — one list, no areas, nobody above it" },
      { id: "learn", title: "We do not use what you built, we learn from it", blurb: "a contributor's build is evidence; the project builds it again on a trusted worker; the second agent's audit" },
      { id: "roles", title: "What each role does", blurb: "contributor, maintainer, the project's workers — what each does, and what none may" },
      { id: "categories", title: "Categories, not groups", blurb: "what a package is about — one of a fixed list, proposed by the project's agent, settled by a maintainer; never who may approve" },
      { id: "becoming", title: "Becoming a maintainer", blurb: "contribute first, a maintainer proposes you, another approves — one pull request; the bootstrap exception, and the one door left" },
      { id: "workers", title: "Workers, compute and agents", blurb: "one image, the registration decides; yours and only yours; ready is not online; agent keys stay with the owner, on the broker" },
      { id: "bumps", title: "Bumps and packages nobody builds", blurb: "a new upstream release is built as evidence again; 14 days for the owner's worker, 30 days and the package is unmaintained" },
      { id: "blocking", title: "Blocking", blurb: "a contributor or a package out of the pool, the reason on the record, another maintainer lifts it" },
      { id: "record", title: "The record and the score", blurb: "role lines, signed approvals, trust lines, signed blocks; one number from what the pool keeps anyway" },
    ],
  },
  {
    key: "security",
    group: "pool",
    href: "/docs/security",
    label: "Security",
    blurb: "Five public feeds matched every three hours against what each ring serves; how sure a match is; the fast-track.",
    secs: [
      { id: "feeds", title: "The five feeds", blurb: "Arch Security Tracker, Debian Security Tracker, OSV, CISA KEV, EPSS" },
      { id: "confidence", title: "How sure we are", blurb: "exact, name-version, name-only" },
      { id: "exposure", title: "Exposure through the graph", blurb: "an advisory on a library also marks what loads it; the package page shows the chain" },
      { id: "fast-track", title: "The fast-track", blurb: "a confident advisory with a clean newer version in edge goes to rc and stable at once, with the usual health check and rollback" },
    ],
  },
  {
    key: "glossary",
    group: "pool",
    href: "/docs/glossary",
    label: "Glossary",
    blurb: "The words on these pages, one line each.",
    secs: [],
  },
  {
    key: "api",
    group: "pool",
    href: "/api",
    label: "API",
    blurb: "Every endpoint the dashboard and the tools use, with examples.",
    secs: [
      { id: "read", title: "Read", blurb: "version, status, stats, releases, packages, search, graph, security, events, cost — public, no token" },
      { id: "factory", title: "The factory (read)", blurb: "workers, the queue, the registry, what is staged for review, approvals, maintainers, trust, blocks" },
      { id: "examples", title: "Examples", blurb: "curl, jq, the thin client" },
      { id: "write-jobs", title: "Write (jobs only)", blurb: "what a worker calls with its lease and per-job token" },
      { id: "write-people", title: "Write (people)", blurb: "register, request, build, approve, reject, trust, block — a contributor's or a maintainer's token" },
    ],
  },
];

/** The whole map: the pool's chapters, then the code's — with the markdown chapters placed where they read. */
export const DOCS_TREE: DocChapter[] = (() => {
  const md = new Map(MD_CHAPTERS.map((c) => [c.key, mdChapter(c)]));
  const pool = POOL_CHAPTERS.flatMap((c) => (c.key === "get-started" ? [c, md.get("omarchy-cli-mcp")!] : c.key === "how-it-works" ? [c, md.get("what-we-test")!] : [c]));
  const code = MD_CHAPTERS.filter((c) => c.group === "code").map((c) => md.get(c.key)!);
  return [...pool, ...code];
})();

/** The glossary: a term, and what it means on these pages. Each is a section of the Glossary chapter, so the search finds it. */
export const GLOSSARY: [string, string][] = [
  ["ring", "A complete, signed set of pacman databases over the same packages: edge, rc, stable — and the lab beside them, where a build is tried by a real pacman before a maintainer sends it to edge; nothing in the lab is promised or promoted."],
  ["release", "One immutable selection of packages for a ring; a ring's history is the list of its releases."],
  ["head", "The release a ring serves right now. Pointing the ring at an earlier release is a rollback."],
  ["evidence", "What a decision is made on: a health check, an ABI check, a security scan — or a contributor's build (PKGBUILD, log, manifest) in their staging workspace for a maintainer to read. Never what users install."],
  ["staging workspace", "Where a contributor's builds land: theirs, public, evidence; 5 GB per contributor, reclaimed when a build is decided."],
  ["soak", "The green health checks a ring must collect before the next one takes it: one for edge → rc, two in a row (about six hours) for rc → stable."],
  ["fast-track", "A confident advisory with a clean newer version already in edge, or a factory build the trial installed, goes to rc and stable at once — with the usual health check and rollback."],
  ["the lab", "The fourth ring, beside the three: the factory's builds are pinned there and installed by a real pacman (the trial) before a maintainer decides; nothing in it is promised or promoted."],
  ["the trial", "A real pacman installing the project's build from the lab, in a clean container, before a maintainer approves it; its transcript sits beside the audit."],
  ["OPR", "The Omarchy Package Repository: Omarchy's own packages; its edge channel is a source of the pool, and it earns rc and stable here like every other source."],
  ["ABI check", "Before a promotion: does anything the ring serves load a library whose symbol versions the promotion would change? If so, the promotion is blocked."],
  ["lease", "A worker's claim on a task: it holds the lease while it builds and heartbeats; an expired lease puts the task back in the queue."],
  ["trust", "Two maintainers' word on a worker's registration — one proposes, another confirms, never the owner — that lets it run the project's jobs and rebuilds; one maintainer takes it back."],
  ["the broker", "The one process on a worker's host that holds the token and the agent key and runs no build; the builder beside it is born with nothing and speaks to it."],
  ["category", "What a package is about, for a person browsing the pool — one of a fixed list; proposed by the project's agent, settled by a maintainer."],
  ["the seal", "A package's provenance, served with it: the project and keyring for a synced package; the whole chain and a signed attestation for a factory one."],
  ["track record", "One number, from what the pool records anyway: what you brought that a maintainer let in, what you built, what you decided."],
];

/** The chapter a key names, for the pages that draw the sidebar. */
export function chapterOf(key: DocKey): DocChapter | undefined {
  return DOCS_TREE.find((c) => c.key === key);
}
