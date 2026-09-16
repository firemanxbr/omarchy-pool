# Contributing

Everything in the repository — code, documentation, commit messages — is in
English. Branch from `main`, open a pull request, let CI and E2E pass; pull
requests are squash-merged and every merge is a release.

The whole of it — the workflow, what CI checks, how a release happens, the
governance file, the tests to keep in step — is documented where it runs:
**https://omarchy-pool.firemanxbr.org/docs/contributing** (its source is
[`worker/src/docs/contributing.md`](worker/src/docs/contributing.md)). The
documentation itself lives on the dashboard too: a chapter is a markdown
file under `worker/src/docs/`, rendered by the Worker, changed by pull
request like anything else.
