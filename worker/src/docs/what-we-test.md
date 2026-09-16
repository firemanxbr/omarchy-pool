# What we test

Every package the factory builds passes the same gate before it is
evidence, and a group of packages — a desktop app, a prebuilt binary —
must do more. This page is that list, written once: the agents that draft
and audit recipes read exactly this text as their skills, the gate enforces
what a program can enforce, and a maintainer decides last, on the evidence
of both.

## Why we test the way we test

Two kinds of checks work on every package, and they are not the same kind
of thing.

**The gate is deterministic.** `vet_package`, in the build worker, runs
the same checks on every package in the same order and writes `vet.json`:
same input, same verdict, and a failure is a fact a maintainer can read in
the log. It cannot be argued with and it cannot hallucinate; it can only be
incomplete.

**The agents are not.** The agent that drafts a recipe and the second
agent that audits a contributor's build can write a wrong recipe or wave a
wrong one through. The skills on this page make them more accurate — a
finding names the check the gate has, a recipe follows the conventions the
gate enforces — but a skill mitigates, it does not solve. That is why an
agent's output is evidence for a person, never a decision.

**So a lesson goes to both places.** When a build fails for a reason we did
not test for, or a package ships with a fault the gate did not see, the
lesson becomes a rule in a skill — so the agents stop making the mistake —
and, whenever a program can check it, a check in the gate — so nobody
can. The skills carry the knowledge; the gate carries the proof. Over
time the gate grows, the agents' work gets more accurate, and what reaches
the rings has fewer surprises in it. *What we learned*, at the end of this
page, is the log.

<!-- skills -->

## How this page grows

A skill is a markdown file in the repository: `factory/skills/general/` for
what applies to every package, `factory/skills/groups/<group>.md` for a
group — its first paragraph says when it applies. A pull request adds or
changes one; with the next release it is on this page, in the worker image
beside the prompts, and in front of every agent that drafts or audits a
recipe. Nothing is written twice.

When a lesson can be a check, it also goes to the gate — `vet_package` in
`factory/worker/omarchy-build-worker.sh` — with a name, and the skill names
that check in brackets so the two stay one list. A check that needs a
tool the build container lacks adds the tool to `prepare_container`.

To propose a skill or a check: a pull request, with the failure that
taught it — the task, the log line, the package — in the description. A
maintainer merges it like any other change to the process.

## What we learned

- **2026-09-16 — desktop apps (Electron).** Twelve of fourteen of the
  project's rebuilds failed the gate on the same two checks while the
  contributors' builds of the same packages passed. *namcap-package*
  reported ELF files under `/opt`: the gate meant to allow that for
  self-contained applications, but its exemption named namcap's rule id
  and namcap was run without `-m`, so the exemption never matched.
  *smoke* started the application with `--version` in a container with no
  display and no D-Bus, where Chromium dies (exit 139) whatever the
  package. The gate now runs namcap with `-m`, and for a desktop
  application checks what a start would have proved instead — the
  executable behind the launcher exists, `ldd` resolves every library, the
  `.desktop` entry is valid — while a command-line binary must still start.
  The *Desktop apps* and *Prebuilt binaries* skills were written from the
  recipe that passed.
