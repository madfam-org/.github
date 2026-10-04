# madfam-org/.github — org-shared GitHub Actions

Reusable workflows every MADFAM repo can inherit instead of re-vendoring the same
CI logic. Today: **`madfam-quality-gates.yml`** — two independent gates behind two
inputs.

## Why the byte gate exists

On **2026-09-01** a literal **NUL byte** inside a string in one of the org's
repositories (written as an "impossible id" sentinel) **passed every gate we had**:
Node ran it, `tsc` typed it, the bundler packed it, lint was clean and the tests were
green. In production it broke evaluation of the served chunk, and with it the
hydration of *every* client island — with **no console error at all**. Git's only
tell was the word `Bin` in `git diff --stat` (the change was reverted, then re-landed).

The gate makes that one signal explicit and blocking: raw control bytes, a BOM
anywhere in the file, and U+2028/U+2029 in code all fail CI with file, line and
column. An "impossible" sentinel is written with impossible **text**
(`'::name:declared::'`), never with bytes no editor renders.

## Usage

```yaml
jobs:
  quality-gates:
    uses: madfam-org/.github/.github/workflows/madfam-quality-gates.yml@main
    with:
      byte_check: true
      size_check: false
```

### Inputs

| Input | Type | Default | Meaning |
|---|---|---|---|
| `byte_check` | boolean | `true` | Run the invisible-byte gate. |
| `size_check` | boolean | `false` | Run the file-size gate. **Opt-in** — see below. |
| `node_version` | string | `20` | Node version for both gates. |
| `byte_text_exts` | string | `.ts,.tsx,.js,.mjs,.cjs,.css,.md,.sql,.json,.yml,.yaml,.sh,.prisma` | Extensions scanned for control bytes / BOM. |
| `byte_code_exts` | string | `.ts,.tsx,.js,.mjs,.cjs` | Code extensions *additionally* scanned for U+2028/U+2029. |
| `byte_paths` | string | `''` (whole repo) | Comma-separated path prefixes to limit the scan. |
| `size_baseline` | string | `scripts/size-limit-baseline.json` | Grandfather baseline, relative to repo root. |
| `size_include` | string | `src/:.ts:.tsx,scripts/:.ts,prisma/:.ts` | `dir:ext[:ext]` rules for what the size gate measures. |
| `size_warn_at` | number | `600` | Warn threshold in lines (never fails). |
| `size_fail_at` | number | `800` | Hard-fail threshold in lines. |
| `runner` | string | `''` | Runner override. Empty = ADR-010 ARC bootstrap fallback. |

Both gates measure **tracked source only** (`git ls-files`) — never build output,
`node_modules`, generated clients, or fixtures.

### Why `size_check` defaults to false

The file-size gate is **grandfathered**: over `size_fail_at` fails, but files that
already exceeded it when the gate landed are recorded in a committed baseline at
their exact size, tolerated there, and fail only if they **grow**. A baselined file
refactored back under the limit must be dropped from the baseline deliberately, so
it can never silently climb back over.

That baseline is per-repo, so enabling this gate without one would turn CI red on
every pre-existing large file at once. The workflow **fails closed** with an
explanatory message if `size_check: true` and the baseline file is missing.

Policy thresholds: **>600 warn / >800 fail**.

## Visibility requirement — do not make this repo private

A **private** repo cannot host a reusable workflow that other repos call. GitHub
rejects the caller's run *before scheduling any job*: 0 jobs, 0 seconds, and a red X
that looks like a failing gate but is a gate that **never ran**. This org has already
been bitten — `internal-devops` is private, and its `stripe-key-segregation.yml`
recorded **93 of 93 invocations failing in 0s with zero jobs**, which read as
enforcement while enforcing nothing.

The shape proven to work here: private repos (`nauta`) successfully call the public
`madfam-org/enclii/.github/workflows/build-publish.yml`. So this home repo must stay
**public or internal**.

The gate scripts are checked out at `github.workflow_sha`, pinning them to the exact
commit of the reusable workflow being run — workflow and scripts can never drift.

## Adoption status

| Repo | `byte_check` | `size_check` |
|---|---|---|
| `kalya` | ✅ adopting | ❌ (no baseline yet) |

One repository still runs local copies of these gates, which were generalized from it;
moving it onto this shared workflow is deliberate follow-up, not part of the rollout
that introduced this repo.
