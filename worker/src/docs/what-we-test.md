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

## Who does what

Two people are behind every package the factory ships, and neither does
the other's part.

**The contributor** — anyone signed in, a maintainer included — requests
the package on the record (the project, the licence, the source) from the
dashboard or through the API, and brings **a build that passes the gate**
on their own worker: the recipe, the log, the manifest, the gate's verdict
and the second agent's audit are the evidence, staged in their workspace.
A build that fails, or fails the gate, is the contributor's to fix; it
never reaches a maintainer's queue. When the evidence is complete the
build is *ready for a maintainer*, and only then is a maintainer's time
asked for.

**The maintainer** never uses the contributor's bytes. They read the
evidence, have the project build the recipe again on a trusted worker
with the project's agent, watch that build pass the same gate, see a real
pacman install it from the lab (the trial), and decide — approve with a
note, or reject with the reason, which sends it back to the contributor.
A maintainer who brought the package is its contributor: **nobody decides
on their own package**, whatever their role, so two people are always
between a recipe and the rings.

Until the maintainer decides, the project's build sits in the lab: pinned,
tried, visible on the package's page under *From the factory*, never
promised and never promoted. Approved, it enters edge and earns rc and
stable on the same evidence as every synced package. A maintainer can
still block it later — the reason on the record, another maintainer lifts
it — and it leaves every ring at once.

An approval can be **withdrawn** by any maintainer, the one who gave it
included: one that broke the rule (a package approved by the person who
brought it, as the first package was during the bootstrap), or one a
maintainer no longer stands behind. The approval stays on the record and
is void from then on; the package leaves every ring it reached through
it; the chain is evidence again and waits for another maintainer's
decision. The reason is a signed decision and a journal line, and the
contributor sees it on their build's page.

## The score

Every chain — a contributor's build, the project's build of it, the
decision — earns points, fifty for each half, from what the pool recorded:

| The contributor's half | points | The maintainer's half | points |
|---|---:|---|---:|
| A request on the record: licence and source named | 5 | The project built it again (−3 per extra attempt, at least 6) | 15 |
| A build that succeeds (−3 per extra attempt, at least 4) | 15 | The project's gate: clean 10, with warnings 7 | 10 |
| The gate: clean 15, with warnings 10, failed 0 | 15 | The trial installed it | 15 |
| The audit: ok 15, warn 10 (5 with a high finding), block 0 | 15 | A decision with a note (3 without) | 5 |
| | | The category settled | 5 |

The **class** is the score today: **A** from 90, **B** from 75, **C**
from 55, **D** below. Beside it the dashboard shows the class the chain
reaches with the maintainer's half green — what a maintainer is told
before starting. A package's class is that of its latest approved chain
(or its latest chain, before any decision); the same rules rank every
package in the factory, and nothing here decides anything: the number
ranks, people approve. The rules are `worker/src/score.ts`, one function,
tested.

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
