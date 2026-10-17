# Proof-first receipt

**Status:** Implemented (2026-10-17)

**Repos:** trustbut (this spec) · [trustbut-index](https://github.com/isAlmogK/trustbut-index) (the study's counted families and success bar, specified there)

## Why

The pilot labels of trustbut 0.6.0 (trustbut-index `labels/pilot-2026-10-17`, 71 findings from 36 merged PRs) found:

- 62 of 71 findings state a true fact (87%), but only 5 are worth a reviewer's time (7%).
- All 5 real findings say the same thing: nothing in the PR proves the change. A test named for a fix that never exercises it, a PR body that claims a test the diff lacks, 355 new lines with no test, two bug fixes with no regression test.
- Most noise is the per-test `test-passes-without-change` on guard and characterization tests that sit next to a test that does prove the change.
- 9 findings state a wrong fact, from three causes: tests moved to a new file count as removed; tests merged into one (assertions kept) count as removed; a Python base run imported head code.

The receipt should lead with one PR-level fact, whether anything proves the change, and every fact it states should be true.

## Changes

### 1. `change-not-proven` (new core id, spec 1.2)

A new core finding id, severity `warn`, added to agent receipts as spec version **1.2** ("introduced in 1.2"; a 1.1 receipt that uses it is invalid, as with `test-regressed` in 1.0).

Meaning: *the change's code is not proven by any new or changed test.*

trustbut emits it (at most once per receipt, no `file`, first in the receipt's findings) when the code changed and:

- **no test file was added, changed or deleted.** Detail: `no test added or changed`. Or
- **test files changed but the proof run produced no proofs**, and the receipt has none of `no-runner`, `base-run-failed`, `proofs-unmatched`, `tests-outside-root`, `suite-failing`, `no-test-results` (those already say there is no evidence either way). This covers a change to a test helper only (kind `test`, not a named test file), a type-test-only change, and an existing test file edited without a test-definition line (`buildProofs` keeps no proof for it). Detail: `test files changed, but no new or changed test was found in them`. Or
- **test files changed, the proof run produced at least one proof, no proof is `proves-change` and none is `failing`** (a weak proof, a test that could not load at base, counts as proving). Detail: `N new or changed tests, none fails without the change` (`1 new or changed test, …` for one).

It is not emitted while a new or changed test fails at head: `test-failing` (fail) already reports it, and whether the test proves the change is undecided until it passes.

It is listed first among the findings, so it is never the item cut from the WARN `systemMessage` (3 titles), the agent feedback's warnings (`AGENT_MAX_WARN`) or length-trimmed feedback.

**The code changed** means: at least one file of kind `source` that is not deleted has an added or removed line whose lexed code part (`splitLine(line, lang).code`, comments and string contents removed) is not blank. The lexer reads one line at a time, so a line inside a Python docstring (a string) counts as code. A source file in a language outside the registry counts as changed when it has any added or removed line. So comment-only, blank-line-only and pure-rename changes do not count. String edits still count, because the lexer keeps string delimiters in the code part (`x = ''` is not blank).

trustbut **stops emitting** `test-passes-without-change` and `no-tests-changed`. Both stay in the catalog, the schema and the validator (other producers and older receipts remain valid). The per-test facts stay in `proofs` (`verdict: does-not-constrain`), and the Markdown line `New/changed tests` keeps counting them.

### 2. Moved tests and assertions are not removed

`tests-removed` and `assertions-removed` count, per test file, the test definitions (or assertions) on removed lines minus those on added lines. A removed line now **does not count** when the same trimmed text is an added line of another changed test file in the PR. One finding per file stays.

### 3. Merged tests are not removed

`tests-removed` is not emitted for a file whose assertions did not drop on net (after rule 2). Tests consolidated into fewer `it` blocks keep their assertions and lose no checks. A file that loses assertions still gets both findings.

### 4. Python base runs use the base's own workspace packages

The pytest runner already puts the worktree root and `<worktree>/src` first on `PYTHONPATH`, so they win over an editable install of the user's checkout. A workspace member installed in editable mode from elsewhere in the checkout (harbor: `packages/rewardkit/src`) is not covered, so the base run imported head code and head's tests passed at base.

New rule: before a run, the pytest runner asks the interpreter it will use for its `sys.path` (`python -c "import json,sys; print(json.dumps(sys.path))"`, with the same env, 30 s limit; on any failure the rule is skipped). Every entry that lies inside the **checkout trustbut was started in** (the repo top of the user's checkout, passed to runners as a new optional `RunOptions.checkout`) and not inside the worktree is mapped to the same relative path in the worktree; mapped paths that exist there are put on `PYTHONPATH` after the worktree root and `src/`, before the inherited `PYTHONPATH`. Import-hook editable installs (setuptools `__editable___*_finder.py`) are out of scope.

Not in scope: a JS package whose tests import its own build output (`dist/`) runs head's build at base. In the labeled sample this did not change a result.

### 5. Output

- Markdown: the line right under the tests line is the proof line: `**Proof:** N new/changed tests prove the change ✅` when any proves; `**Proof:** nothing proves this change ⚠` when `change-not-proven` is present; omitted otherwise. The existing `New/changed tests` line stays.
- Hook `systemMessage` (FAIL parts): `change not proven` replaces the `N tests pass without the change` part. Agent feedback lists `change-not-proven` like any warning.
- `docs/SPEC.md`, `spec/agent-receipt-v1.md` (catalog, version 1.2, changelog), the JSON schema enum, `CORE_FINDINGS`, `CORE_FINDING_SINCE` (`change-not-proven: 2`) and `SPEC_VERSION` (`1.2`) are updated.

### Left unchanged on purpose

`escape-added`, `test-config-changed`, `test-skipped`, `test-focused`, `snapshot-changed` keep their behavior and severities. They state true facts; the study counts them as context.

## Testing

Test first, one scenario per behavior:

- `change-not-proven`: source changed and no tests changed → emitted; new test that fails at base → not emitted; new tests that all pass at base → emitted with count; tests changed but base run failed (no proofs) → not emitted; comment-only source change and no tests → not emitted; weak proof → not emitted.
- Receipts no longer contain `test-passes-without-change` or `no-tests-changed`.
- Moved: a describe block moved to a new test file → no `tests-removed` / `assertions-removed`.
- Merged: three `it` blocks merged into one with all assertions → no `tests-removed`; same with one assertion dropped → both findings.
- Python workspace member: a fixture repo with `packages/lib/src/lib`, installed editable into a venv from the user's checkout, a base bug fixed at head, and a new test → `proves-change` (fails today with `does-not-constrain`). Real-toolchain e2e, gated like the other pytest e2e tests.
- Spec: the 1.2 validator accepts `change-not-proven` in a 1.2 receipt and rejects it in a 1.1 receipt; spec-doc tests stay in sync.
- Hook summary and Markdown proof line.

## Release

0.7.0. Then trustbut-index pins 0.7.0, reruns the same pilot manifest and relabels it.

## As built

Differences from the design above:

- **Merge rule (3).** `tests-removed` is suppressed only when the file also adds a test definition and its assertions did not drop on net. Without the added-test condition, plain deletions of tests that have no assertion lines were suppressed. Rust inline tests (no assertion count) are never treated as merged.
- **Move rule (2).** A removed line counts as moved only by consuming an identical trimmed line added in another changed test file, so a move cancels at most as many removals as were added elsewhere (the spec implied any match).
- **pytest mapping (4).** The probe is `import sys; print('\0'.join(sys.path))` (not json). Relative and empty `sys.path` entries are ignored before `realpath`. Mapped paths that resolve back into the checkout (for example a symlinked `.venv`'s site-packages) are dropped, and mapped entries already on `PYTHONPATH` (worktree root, `src/`) are not repeated.
- **Markdown proof line (5).** For one test it reads `**Proof:** 1 new/changed test proves the change ✅`.
- **`change-not-proven` with a failing test (1).** The first build fired it when a new test failed at head (a `failing` proof is not `proves-change`), with the untrue detail `… none fails without the change`. It is now not emitted when any proof is `failing`.
- **`change-not-proven` with no proofs (1).** The design left it out whenever test files changed and there were no proofs, on the assumption that another finding always says so. A helper-only, type-test-only or test-definition-free test change had no such finding, so the receipt passed silently. It now fires (detail `test files changed, but no new or changed test was found in them`) unless one of `no-runner`, `base-run-failed`, `proofs-unmatched`, `tests-outside-root`, `suite-failing`, `no-test-results` is present. `changeProofFindings` takes the receipt's other findings as a third argument.
- **Order (1).** `change-not-proven` is the first finding in the receipt, before the static and proof-engine findings and `test-failing`.
- **Docstrings.** `codeChanged` counts Python docstring edits as code (the per-line lexer sees them as strings). Stated in docs/SPEC.md and the changelog.

## Needs

[trustbut-index](https://github.com/isAlmogK/trustbut-index) counts receipts by family in `src/aggregate/families.ts`. Its `FAMILY_OF` maps only `test-passes-without-change` (proof gap) and `no-tests-changed` (untested change), so a 0.7.0 receipt counts 0 in both. Its own spec, written in that repo, must cover:

- **Map `change-not-proven`.** With detail `no test added or changed` → untested change; otherwise → proof gap. Or merge both into one family.
- **Version gate.** A family group never mixes 0.6 receipts (per-test `test-passes-without-change`, `no-tests-changed`) with 0.7 receipts (one `change-not-proven` per receipt): counts are per receipt in 0.7 and per test in 0.6.
- **Preregistration.** Record the mapping and the gate in `PREREGISTRATION.md` as a deviation.
