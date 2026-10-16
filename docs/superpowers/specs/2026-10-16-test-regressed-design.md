# Regressed tests and output tails

**Status:** Implemented (2026-10-16)
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

1. **Failing files.** Collect the head cases with outcome `fail` or `error` that are not synthetic placeholders (`isSynthetic`). Each case's `file` is resolved to a path relative to the package root that exists as a file at head:
   - a relative path that exists is used as is;
   - an absolute path inside the head package root becomes relative;
   - a dotted module name (pytest reports `tests.api.test_x` or `tests.api.test_x.TestY`) becomes the longest prefix that exists as a `.py` file (`tests/api/test_x.py`);
   - anything else (empty, `..` segments, a path outside the package root, a runner-specific label) doesn't resolve.

   The resolved paths, deduplicated, are the *failing files*. A case whose file doesn't resolve isn't added to the base run.
2. **One base run.** The base run's files are the changed test files plus the failing files, deduplicated, in that order. The base run now happens when either set is non-empty; before, it happened only for changed tests. In `quick` scope the failing files are already changed test files, so nothing extra runs.
3. **What base runs.** Unchanged: the base worktree gets the changed tests, snapshots and test data copied from head (`copiedToBase`). A failing file the change didn't touch is run as it exists at base.
4. **Existing findings keep their rules.** `base-run-failed` still means "the changed tests could not run at base" and is emitted only when there are changed test files. `proofs` and `proofs-unmatched` still cover only changed test files.

A runner that ignores `files` (`command`, some build-tool runners) runs its whole suite at base, which is correct but slower.

### New finding `test-regressed`

| Id | Default severity | Meaning |
|---|---|---|
| `test-regressed` | `fail` | A test passes at base and fails at head. |

One finding per head case that isn't synthetic, whose outcome is `fail` or `error`, and whose base outcome, matched by case `id`, is `pass`. A repeated id keeps its worst outcome on each side (the rule `buildProofs` already uses) and is reported once. The rule reads only the two runs, so a runner that runs its whole suite at base can report a case whose file didn't resolve. `file` is the repo-relative path: the package-root prefix plus the resolved path, or plus the runner's `file` when it didn't resolve. `detail` is the case name, title `Test passes at base and fails at head`.

A changed test that fails at head and passed at base gets both `test-failing` and `test-regressed`: each is a separate fact. A test that failed at base too gets no `test-regressed`. That's how a red suite caused by the environment shows up: `suite-failing` with no `test-regressed`.

Output:

- **Markdown and agent feedback** list a regressed test once, in "Failing tests", with ` (passed at base)` after its name. `test-regressed` findings are not repeated under "Must fix", the same way `test-failing` isn't.
- **Hook summary** (`src/hook/feedback.ts`) adds `N passed at base` after the failing-test count when N > 0.

### Output tail in `x-trustbut`

Receipts have carried no raw output since 0.4.0, on purpose: tests can print secrets. So the tail is opt-in. With `trustbut verify --output-tail` (JSON output only: `--json` or `--receipt-json`), `x-trustbut.after` and `x-trustbut.before` gain an optional `outputTail` string when that run's exit code is non-zero and its output isn't empty. Without the flag, receipts are unchanged. It reuses `outputTail` from `src/render.ts`, which gains optional limits (its defaults stay 20 lines and 1,500 characters for agent feedback). The receipt keeps the last 50 lines, ANSI escape codes removed, at most 4,000 characters (the end is kept). Output is not part of the core receipt. The spec's extension rule already allows it under `x-trustbut`, and consumers ignore `x-` keys they don't know.

Output tails can quote whatever the tests print. trustbut writes receipts only where the caller asks, so the caller decides whether to publish them.

### Receipt spec 1.1

Adding a core id is a minor revision under the spec's Versioning rule. trustbut 0.5.0:

- adds `test-regressed` to `spec/agent-receipt-v1.md` (catalog row, Changes entry **1.1**), the schema's core id list and `CORE_FINDINGS`;
- emits `specVersion: "1.1"` on every receipt;
- validates `test-regressed` as a known core id in a receipt that declares `1.1` or later. A receipt that declares `1.0` and uses it is invalid (`'test-regressed' is a core id since 1.1 (the receipt declares 1.0)`), because 1.0 receipts are validated strictly;
- treats only minors newer than `1.1` as newer: their unknown fields and core-shaped ids are warnings, and the messages name `1.1` (`unknown in spec 1.1`, `is not a 1.1 core id`).

A 1.0 validator (trustbut 0.4.x) accepts a 1.1 receipt with a warning for the unknown id, as the spec already requires.

### Contract for consumers (trustbut-index)

- `findings[].id === "test-regressed"`: a test that passed at base and fails at head. Absence means no failing test passed at base, or no base result was available for it.
- Which runners can compare an unchanged failing test with base: those whose case `file` resolves to a file in the package root, so its file can be rerun at base: vitest, jest, mocha, node-test, pytest, RSpec, PHPUnit, Dart, Cargo (the test binary's source file, e.g. `tests/api.rs`; not doc-tests), and `command` when its JUnit report names files. Go (the case `file` is the package directory), Maven, Gradle and .NET (class names) and Swift (type names) get no base result for an unchanged failing test, so never a `test-regressed` for one. A changed test file is run at base with every runner.
- Detecting "not compared": a head case in `x-trustbut.after.cases` with outcome `fail` or `error` whose `id` is absent from `x-trustbut.before.cases`, or any such case when `x-trustbut.before` is absent, had no base result. Its missing `test-regressed` says nothing about base.
- `x-trustbut.before` can exist when no tests changed; it then holds only the results of the failing unchanged files.
- `x-trustbut.after.outputTail`, `x-trustbut.before.outputTail`: optional strings, present only with `--output-tail` and only for a run that exited non-zero.
- `outputTail` quotes the runner's output as printed, including local paths (temporary worktree folders, home folders), so it differs between machines and runs and isn't deterministic. Consumers that publish receipts should scrub it.
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

## As built

- The e2e `--output-tail` test asserts the tail contains "JUNIT report written", not a test name. trustbut runs vitest with `--reporter=junit`, so failure text lives in `cases[].message`, not in the run's output.
- Markdown leaves `test-regressed` findings out of Findings only when the Failing tests list is shown (the head run has `suite-failing`). Without it, they stay in Findings. The spec says "listed once" without that condition.
- The validator rejects a core id newer than the declared minor (`test-regressed` in a `1.0` receipt) through a `CORE_FINDING_SINCE` table, and treats only minors newer than 1.1 as lenient. The `since` message reads `'test-regressed' is a core id since 1.1 (the receipt declares 1.0)`.
- With `--quick` and no changed tests, the scope falls back to full, so the failing files are not already changed test files. A red suite then also triggers a base run. This includes the agent hook's default quick mode: with no changed tests, a red suite also creates a base worktree and runs at base. If the head and base runs together exceed the hook budget (`hook.timeoutSec`, or the agent's remaining hook timeout), the hook reports `trustbut couldn't verify: timed out …; not blocking` and lets the agent finish.
- Failing files are kept only when they exist as a file in the base checkout, checked after the head test files are copied in. A failing file that exists only at head and isn't copied (a pytest-django `app/tests.py`, which is classified as source) would make the runner error out and hide the changed tests' base results. When no changed test and no failing file is left, base is not run.
- Resolved failing files are normalized (`./spec/x_spec.rb` → `spec/x_spec.rb`), so they dedupe against the changed test files.
- A `test-regressed` finding has no `file` when the runner reported none (the spec said the package-root prefix plus the runner's `file`, which gave `""` or `pkg/`).
- The hook summary adds `N passed at base` after a failing-test count. When no failing test is counted, it adds `N test(s) passed at base and fail(s) at head` instead, so the regressions aren't dropped.
- Known limitation: changed tests and failing unchanged files share one base run. pytest has no option to continue past collection errors, so a collection error in a failing unchanged file at base stops the whole base run and hides the changed tests' base results (`base-run-failed`).
- `--output-tail` is accepted with any output mode; it only changes JSON receipts (stdout with `--json`, and `--receipt-json` files).
- Docs touched beyond the spec: `spec/agent-receipt-v1.md` (Status v1.1, Extensions, Versioning and Changes wording, `outputTail`), `docs/SPEC.md`, README (flag row, 20 core ids).
