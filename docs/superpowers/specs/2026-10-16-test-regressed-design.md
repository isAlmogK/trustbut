# Regressed tests and output tails

**Status:** Draft (2026-10-16)
**Feature:** [pilot measurement fixes](https://github.com/isAlmogK/trustbut-index/blob/main/docs/superpowers/specs/2026-10-16-pilot-measurement-fixes-design.md) in trustbut-index. This spec covers the trustbut part only, including the receipt contract the index reads.

## Problem

The first pilot of the agent test-honesty index (trustbut-index, results `pilot-2026-10-15`) ran trustbut 0.4.0 on 201 merged pull requests. 74% of the PRs that ran had a red-at-head finding (`suite-failing` or `test-failing`). Merged PRs passed their own CI, so most of that red comes from the run environment, not from the PRs:

- Of 529 failing new or changed tests, 513 failed the same way with and without the change (`fail>fail` or `error>error` in `proofs`). Only 8 were new tests that failed.
- 40 of 93 PRs that ran had `suite-failing` from tests the PR did not touch. trustbut runs those tests only at head, so nothing says whether they already failed at base.

A receipt can't tell "the change broke this test" from "this test was already red". That matters to the index, and to an agent reading the hook feedback, which today says "fix these" about failures it didn't cause.

The pilot also couldn't explain most setup failures. Receipts carry the last line of output only when the runner reported no test (`suite-failing` detail), and the `x-trustbut` runs carry no output at all.

## Goals

1. Report each test that passes at base and fails at head, for every failing test, not just changed ones.
2. Carry the end of the runner's output in the receipt when a run fails.
3. Change nothing about existing findings' meaning.

## Design

### Base run also covers tests failing at head

Today `proveTests` (`src/proof.ts`) runs the full suite at head and, only when tests changed, runs the changed test files at base.

New behavior, after the head run:

1. **Failing files.** Collect the head cases with outcome `fail` or `error` that are not synthetic placeholders (`isSynthetic`). Their files are the *failing files*: each case's `file`, kept only if `<head package root>/<file>` exists as a file. A case whose `file` doesn't resolve (a pytest module name, a runner-specific label) gets no base result, so it is never reported as regressed.
2. **One base run.** The base run's files are the changed test files plus the failing files, deduplicated, in that order. The base run now happens when either set is non-empty; before, it happened only for changed tests. In `quick` scope the failing files are already changed test files, so nothing extra runs.
3. **What base runs.** Unchanged: the base worktree gets the changed tests, snapshots and test data copied from head (`copiedToBase`). A failing file the change didn't touch is run as it exists at base.
4. **Existing findings keep their rules.** `base-run-failed` still means "the changed tests could not run at base" and is emitted only when there are changed test files. `proofs` and `proofs-unmatched` still cover only changed test files.

A runner that ignores `files` (`command`, some build-tool runners) runs its whole suite at base, which is correct but slower.

### New finding `test-regressed`

| Id | Default severity | Meaning |
|---|---|---|
| `test-regressed` | `fail` | A test passes at base and fails at head. |

One finding per head case whose outcome is `fail` or `error` and whose base outcome, matched by case `id`, is `pass`. A repeated id keeps its worst outcome on each side (the rule `buildProofs` already uses). `file` is the repo-relative path (package-root prefix added), `detail` is the case name, title `Test passes at base and fails at head`.

A changed test that fails at head and passed at base gets both `test-failing` and `test-regressed`: each is a separate fact. A test that failed at base too gets no `test-regressed`. That's how a red suite caused by the environment shows up: `suite-failing` with no `test-regressed`.

Output:

- **Markdown and agent feedback** list a regressed test once, in "Failing tests", with ` (passed at base)` after its name. `test-regressed` findings are not repeated under "Must fix", the same way `test-failing` isn't.
- **Hook summary** (`src/hook/feedback.ts`) adds `N passed at base` after the failing-test count when N > 0.

### Output tail in `x-trustbut`

`x-trustbut.after` and `x-trustbut.before` gain an optional `outputTail` string when that run's exit code is non-zero and its output isn't empty. It reuses `outputTail` from `src/render.ts`, which gains optional limits (its defaults stay 20 lines and 1,500 characters for agent feedback). The receipt keeps the last 50 lines, ANSI escape codes removed, at most 4,000 characters (the end is kept). Output is not part of the core receipt. The spec's extension rule already allows it under `x-trustbut`, and consumers ignore `x-` keys they don't know.

Output tails can quote whatever the tests print. trustbut writes receipts only where the caller asks, so the caller decides whether to publish them.

### Receipt spec 1.1

Adding a core id is a minor revision under the spec's Versioning rule. trustbut 0.5.0:

- adds `test-regressed` to `spec/agent-receipt-v1.md` (catalog row, Changes entry **1.1**), the schema's core id list and `CORE_FINDINGS`;
- emits `specVersion: "1.1"` on every receipt;
- validates `test-regressed` as a known core id. A 1.0 validator (trustbut 0.4.x) accepts a 1.1 receipt with a warning for the unknown id, as the spec already requires.

### Contract for consumers (trustbut-index)

- `findings[].id === "test-regressed"`: a test that passed at base and fails at head. Absence means no failing test passed at base, or no base result was available for it.
- `x-trustbut.after.outputTail`, `x-trustbut.before.outputTail`: optional strings, present only for a run that exited non-zero.
- `specVersion` is `"1.1"`.

## Testing

- **Unit (`test/proof.test.ts` or a new focused file):** failing-file selection (synthetic cases skipped, unresolvable files skipped, dedupe with changed files); the base run happens with no changed tests when head fails; the regression rule (pass→fail and pass→error reported; fail→fail, missing→fail and skip→fail not reported; repeated ids keep the worst outcome).
- **Fixture scenario (`test/fixtures/`, e2e):** a repo where one unchanged test already fails at base and the change breaks another unchanged test. Expected: `suite-failing`, one `test-regressed` (the broken test), none for the already-failing one.
- **Serialize:** `outputTail` present only for a non-zero exit; the 50-line and 4,000-character caps; ANSI removed; `specVersion` `1.1`.
- **Spec examples:** a valid 1.1 example with `test-regressed`; `trustbut validate` accepts it with no warnings.
- **Render and hook:** the "(passed at base)" marker and the hook summary count.

## Out of scope

- Running the full suite at base.
- Changing `suite-failing`, `test-failing` or `base-run-failed`.
- Any study-specific logic; the index decides which findings it counts.
