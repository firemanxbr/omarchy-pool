/**
 * What a log must not carry. A build is somebody else's code — the recipe
 * and the upstream's build system — and its transcript is public: on the
 * API while it is in staging, on the record (signed, kept) once it is
 * staged. The worker's environment is meant to hold nothing the build can
 * see (factory/worker/omarchy-build-worker.sh, *hold_secrets*); this is
 * the check the pool makes anyway, for the worker it does not run.
 *
 * The shapes are the tokens this pool mints, the keys the agents take, the
 * tokens GitHub and the clouds hand out, a private key block, a credential
 * in a URL, and a bare environment dump of the worker's own variables. A
 * hit refuses the file — the task fails with the reason, the record never
 * sees it — and names the kind and the line, never the match.
 */

const SHAPES: [string, RegExp][] = [
  ["a pool token (omw_ / omc_ / oms_)", /\bom[wcs]_[A-Za-z0-9_-]{16,}/],
  ["a pool job token (omj.)", /\bomj\.[A-Za-z0-9_-]{16,}/],
  ["an Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["an API key (sk-…)", /\bsk-[A-Za-z0-9_-]{40,}/],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["an xAI key", /\bxai-[A-Za-z0-9]{40,}/],
  ["a private key block", /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/],
  ["a bearer token", /\bBearer [A-Za-z0-9._~+/=-]{30,}/],
  ["a credential in a URL", /\/\/[^/\s:@]+:[^/\s@]{8,}@[^/\s]+/],
  [
    "the worker's environment",
    /^(?:OMARCHY_WORKER_TOKEN|FACTORY_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|XAI_API_KEY|GITHUB_TOKEN)=[A-Za-z0-9._~+/-]{16,}/m,
  ],
];

export type Leak = { kind: string; line: number };

/** The first thing in `text` that looks like a secret, or null. The line is 1-based; the match itself is never returned. */
export function findLeak(text: string): Leak | null {
  let first: { kind: string; index: number } | null = null;
  for (const [kind, re] of SHAPES) {
    const m = re.exec(text);
    if (m && (first === null || m.index < first.index)) first = { kind, index: m.index };
  }
  if (!first) return null;
  let line = 1;
  for (let i = 0; i < first.index; i++) if (text.charCodeAt(i) === 10) line++;
  return { kind: first.kind, line };
}

/** The refusal's words, the same at the PUT and on the record. */
export function leakMessage(filename: string, leak: Leak): string {
  return `${filename} carries what looks like ${leak.kind} (line ${leak.line}); the log of a build is public, and the worker's environment must hold nothing the build can see — clean the worker (docs: /docs/workers#secrets) and queue the build again`;
}
