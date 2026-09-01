# madfam-org/.github

Org-shared GitHub Actions for MADFAM.

The reusable quality-gate workflow (`madfam-quality-gates.yml`) is under review
in PR #1 and is **not yet on `main`** — `uses: ...@main` references will not
resolve until it merges.

> This repo must stay **public or internal**. A private repo cannot host a
> reusable workflow other repos call: GitHub rejects the caller's run before
> scheduling any job (0 jobs, 0s, a red X for a gate that never ran).
