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

### When a build does not pass

A build that failed, or failed the gate, or was blocked by the audit, is
the contributor's to fix — and the page says how, on the row of that
architecture (each architecture is built on a worker of its own, so one
can be ready while the other failed). The tools, in the order to try them:

1. **Read the evidence.** The log says what stopped it; the gate's log
   names each failed check, and this page explains it; the audit's report
   lists its findings with a fix for each; the PKGBUILD the agent wrote is
   beside them.
2. **Build again, with the lesson.** The next build of that architecture
   starts from the last build's PKGBUILD and what stopped it — the log,
   the gate's verdict, the audit's report — whether that build failed,
   was rejected or was stopped at the gate: the drafter corrects instead
   of starting from nothing. A **hint** the contributor writes in the
   Build dialog goes with it: the binary's name, a build flag, a
   dependency, what the recipe should do differently. Inside one build the
   agent gets three attempts, each from the last log. (A package whose
   repository ships its own PKGBUILD is built as it is, with no drafting:
   the fix is made there, tagged, and the request renewed with the tag.)
3. **Choose the worker.** A request lands in the **shared queue** the
   moment its record is written — every contributor's shared worker takes
   from it, the best idle one of the architecture first (native before
   emulated, then the most cores), the others after three minutes; the
   page says where a build stands ("3 of 7"). The Build dialog offers the
   queue or one of the contributor's own workers, which takes it at once;
   a queued build can be taken out and put back from the same dialog —
   nothing puts it back by itself. A build that ran *emulated* (x86_64
   under qemu on an aarch64 host) may need nothing but a native worker: a
   toolchain that cannot start there fails the build as soon as it is
   installed, with the reason — before any correction turn of the drafter.
   Revoking a worker frees the builds asked for it.
4. **Build it at home first.** The same image runs on any machine with
   the contributor's own agent key (*Workers* in the docs): what passes
   there is what they queue here.

A maintainer chooses the same way for the project's build: which of the
project's workers — one that builds and whose agent answers, native or
emulated — and the note they write is the hint the project's agent drafts
with.

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
| A request on the record: licence and source named, as the form asks today (2 when it predates the checklist — renew it) | 5 | The project built it again (−3 per extra attempt, at least 6) | 15 |
| A build that succeeds (−3 per extra attempt, at least 4) | 15 | The project's gate: clean 10, with warnings 7 | 10 |
| The gate: clean 15, with warnings 10, failed 0 | 15 | The trial installed it | 15 |
| The audit: ok 15, warn 10 (5 with a high finding), block 0 | 15 | A decision with a note (3 without) | 5 |
| | | The category settled | 5 |

A chain is **ready** for a maintainer when the contributor's half is
complete: a build that succeeded, the gate passed, the audit answered —
and the request as the form would take it today, naming the version the
build is of. A request the pool wrote from a registration made before the
form existed confirmed nothing; the contributor renews it from their page
(the same form, filled from the record) and the build is ready again. The
request judges what is still to be decided: a bump — the pool's own build
of a new release from the approved recipe — and a chain already decided
are not scored against it. Each architecture is its own chain: one can be
ready while the other failed, and a person's page shows them one by one.

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
- **2026-09-17 — a prebuilt binary's debug split, and the version a draft
  is of.** omarchy-cli's first x86_64 build (a `-bin` recipe from the
  release tarball) built and failed the gate on namcap's
  *dangling-symlink* in `omarchy-cli-bin-debug`: makepkg's default
  `debug` option makes a `-debug` split of build-id symlinks for a package
  that compiled nothing. The agent read the symptom, not the cause. The
  gate now names the rule — `options=('!debug')` for a recipe without
  `build()` [prebuilt-debug] — and the skill says so first. The same day
  the drafter was found building GitHub's latest tag instead of the
  release the request names (asked at v0.0.168, drafted at 0.0.175): a
  drafted build now carries the request's version.
- **2026-09-17 — rustc under emulation.** Four x86_64 builds of felix
  failed the same way on the Studio's emulated worker, three drafter
  attempts each, the agent "correcting" a PKGBUILD that was never the
  problem: `rustc` cannot start there. The host's kernel (Asahi) uses
  16 KB pages; qemu-user can only place a file mapping on a 16 KB
  boundary, and `libedit.so.0` — pulled by rustc through libLLVM — asks
  for its data segment at a 4 KB one (`mmap … = EFAULT`, "failed to map
  segment"). gcc, python, git, bsdtar and cargo itself start; rustc and
  rustup's own toolchain do not. Two things followed: an emulated worker
  now probes every toolchain a recipe installs and fails the build at once
  when one cannot start, and the shared queue hands a build to a native
  worker first whenever one is idle.
- **2026-09-17 — the request predates the form.** The first packages were
  registered before the request form existed; the pool wrote their
  records from what it had, with an empty checklist and often an unknown
  version, and the score gave them the full five points for "a request on
  the record" — so a package could read *ready for a maintainer* on a
  request nobody had confirmed. The request is now checked the way the
  form checks it, one function for the story, for Review and for the
  page: an incomplete one earns two points, is not ready, and says what to
  put right; the contributor renews it from their page. A package's status
  was also one word for two architectures, each built on a worker of its
  own — *registered* after a failed x86_64 build hid an aarch64 build
  waiting for a maintainer. A person's page now shows each architecture as
  its own chain.
- **2026-09-17 — a worker that died without a word.** omarchy-cli's
  aarch64 build was claimed five times by the Studio's community worker
  and reported nothing five times: each lease expired half an hour later,
  the pool queued the build again, the same worker took it and died the
  same way — a day lost to a package that built fine on the first native
  worker of another contributor. The drafter had named the package
  `omarchy-cli-bin` (a prebuilt binary, as the skill says) while the
  task was named `omarchy-cli`; the worker looked for its package with
  `ls` and a glob that matched nothing, and under `nullglob` the pattern
  vanished, `ls` listed the working directory instead, and `attempt.log`
  became the "package" — `tar` on it ended the shell with status 2,
  before any call to the pool. Two things followed: the worker takes the
  task's own package from the globs themselves (`<name>-…`, then
  `<name>-bin-…`, then whatever makepkg wrote, or fails the build when
  there is none), and the shell has *last words* — whatever ends it while
  it holds a task is reported to the pool at once, with the command that
  did it, so a death costs a minute on the dashboard, not a day of leases.
- **2026-09-18 — one package, two architectures, two namcaps.** Two drafts
  of omarchy-cli 0.0.168, neither naming `depends=`, met the gate the same
  morning: the aarch64 one passed with a warning, the x86_64 one — the first
  build to reach the gate on a native x86_64 worker — failed on
  *namcap-package* `dependency-detected-not-included libgcc`, on its third
  attempt: the first had not linked (Arch's x86_64 makepkg.conf turns `lto`
  on and a crate's assembly came out as bitcode — the drafter wrote `!lto`,
  as Arch's recipes do), the second had failed the gate on the `-debug`
  split makepkg's `debug` option makes there and not on Arch Linux ARM,
  whose build-id symlinks point into the main package that namcap resolves
  against the installed one — and the gate runs before the install. The pool
  builds with `!debug` now: it serves no debug package, and one recipe
  builds the same set on both architectures. Then `libgcc`. Arch had split
  `gcc-libs` into one package per library in February 2026 (gcc 15.2.1:
  `libgcc`, `libstdc++`, `libgomp`…) and left the name as a meta-package
  that owns no file, so `libgcc_s.so.1` is `libgcc`'s — and the gate's
  exemption, written in September, named `gcc-libs`: a name checked against
  memory, not against `pacman -Qo` on a live system. The aarch64 pass was
  not a pass: namcap 3.6.0 finds a library's owner through `ldconfig -p` and
  takes as 64-bit only the lines tagged `libc6,x86-64`; on aarch64 the tag
  is `libc6,AArch64`, no library finds its map, and the scan warns
  `library-no-package-associated` about libc itself instead of naming a
  missing dependency — the same package, checked with namcap taught that tag
  (a fix namcap's master has carried since January, unreleased), reports
  `glibc` and `libgcc` exactly as x86_64 does. Three things followed: the
  gate exempts what Arch's guideline exempts, `glibc`, and takes every other
  name namcap finds as a dependency to list — `libgcc` and `libstdc++` as
  Arch's own recipes list them, `libgomp` and the rest that the old name
  used to cover; the build container teaches namcap that the aarch64 tag is
  64-bit before the gate runs, and says *namcap-libmap* beside the warnings
  when a libc has no package, so a blind scan reads as one — a warning, and
  thinner evidence costs the score five points until the worker is fixed;
  and the exemption for an ELF under `/opt`, which named the id namcap
  prints as information (`elffile-not-in-allowed-dirs`) and never the one it
  prints as the error (`elffile-in-questionable-dirs`), now names both. And
  the one warning every x86_64 binary carried — `unused-sodepend` on the
  dynamic loader, which the linker names NEEDED and `ldd -u` never sees used
  — is no longer weighed: it cost every Rust package five points of the
  gate's fifteen and no recipe could clear it. The skill and the prompt name
  the runtime the way Arch does, and the drafter's own tool writes `glibc`
  and `libgcc` into a Rust recipe before any model reads it.
