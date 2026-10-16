# Changelog

## Unreleased

**Less noise from the trustbut-index pilot.** Fixes for findings that were true only by accident, or not at all.

- `test-regressed` is now confirmed by a rerun. A test that fails at head and passed at base is rerun with the base run's files at head, then at base; it is reported only when it fails again at head and passes again at base. Otherwise trustbut adds the info finding `trustbut/regression-not-reproduced` with the rerun outcomes. This drops failures that happen only in the full suite or only once. "(passed at base)" in Markdown and agent feedback follows the confirmed findings.
- Type-test files are tests: `test-d/`, `test-dts/`, `__typetests__/`, `*.test-d.ts`, `*.spec-d.ts`, `*.d-test.ts`. Adding one no longer gives `no-tests-changed`, and its `@ts-expect-error` lines are no longer `escape-added`. They are never passed to a test runner.
- `escape-added` no longer reports a JS directive mentioned in comment prose (`@ts-…`, `eslint-disable`, coverage ignores count only right after a comment marker), `any` in a generic constraint (`T extends (...args: any[]) => R`), or anything in files `.gitattributes` marks `linguist-generated`. `any` in a type signature and suppressions with a rule code or a written reason are still reported.

## 0.5.0

**Regressed tests.** A red suite no longer looks the same whether the change broke a test or the test was already failing.

- New finding `test-regressed` (fail): a test that passes at base and fails at head. The base run now also gets the files of tests failing at head (pytest module names map to their `.py` file), and runs even when no tests changed if something fails at head. Markdown and agent feedback mark these tests "(passed at base)", and the hook summary counts them.
- Receipt spec **1.1**: adds the core id `test-regressed`. trustbut writes `specVersion: "1.1"`. `trustbut validate` accepts 1.1, treats only minors newer than 1.1 leniently, and rejects `test-regressed` in a receipt that declares `1.0`.
- New: `verify --output-tail` adds the end of each failed run's output (last 50 lines, at most 4,000 characters) under `x-trustbut` in JSON receipts. Off by default; receipts stay output-free without it.

## 0.4.0

**Agent receipts, spec v1.** trustbut's receipt is now an open, versioned format that any tool can produce or read: [`spec/agent-receipt-v1.md`](spec/agent-receipt-v1.md), with a JSON Schema and examples.

- **Breaking:** `verify --json` and `--receipt-json` now write an agent receipt v1. `version: 1` is replaced by `specVersion: "1.0"` and `producer`. `base`/`head`/`headRef` move under `subject`. The top-level `scope` moves to `tests.scope`, and `tests` is absent when tests didn't run. `proofs[].id` and `proofs[].weak` are dropped. trustbut-only detail (`runner`, `languages`, `root`, the `after`/`before` runs) moves under `x-trustbut`, and the raw runner `output` is no longer written to JSON. `verdict` stays at the top level, so the GitHub Action is unaffected.
- New: `tests` holds test counts (`passed`, `failed`, `errored`, `skipped`) taken from the head run.
- New: `trustbut validate [file]` checks any receipt against the spec (stdin for `-`; exit 0 valid, 1 invalid, 2 unreadable). `--json` prints the result as JSON, for unreadable input too. A receipt that declares a newer `1.x` minor is accepted: fields and core ids unknown to 1.0 are warnings. A malformed finding id (`Not_Valid`: neither shaped like a core id nor a valid namespaced id) is an error whatever the version.
- Fixed: a new test was wrongly reported as passing without the change when the change added source under a test folder inside a source tree (`src/spec/`): that source was copied into the base run. It no longer is; test helpers elsewhere (`spec/helpers/`) and code fixtures under `fixtures/` or `testdata/` are still copied.
- Fixed: test helpers in a workspace package named like a source folder (`packages/app/spec/`, `apps/app/test/`) weren't copied into the base run, so new tests that use them couldn't prove the change there. A folder directly under `packages/` or `apps/` now counts as a package, not a source tree; source under `app/models/spec/` or `src/app/test/` stays out of the base run.
- Fixed: changed Go test-support packages (`internal/test/`, `internal/testutil/`, `testhelpers/`, `testing/`) are copied into the base run when, at head, only tests and other test-support packages import them and their own folder has no changed tests. A package that production code imports, or that is itself under test, still stays out.
- The npm package now ships `spec/`.

## 0.3.1

First release published from CI through npm trusted publishing, with a provenance attestation. No changes to the CLI.

- Tests: the CLI tests start trustbut with `node` instead of `npx`, so npm's own config warnings on stderr no longer break the release workflow.

## 0.3.0

First npm release. It includes everything built so far:

- **v0.1, core engine:** `trustbut verify` reruns your tests in clean temporary worktrees, proves new and changed tests fail before and pass after the change, checks test integrity and type/lint escapes, ranks risks and prints a PASS/WARN/FAIL receipt (Vitest, pytest).
- **v0.2, every language:** a runner registry and `.trustbut.json` config (package root, custom test command, setup command, env, extra args), with runners for Jest, node:test, Mocha, Go, Rust, Maven/Gradle (Java/Kotlin), .NET, RSpec, PHPUnit, Dart/Flutter, Swift and any command that writes JUnit XML, language-aware tamper and escape checks, and `--working` for uncommitted changes.
- **v0.3, everywhere agents finish work:**
  - `trustbut hook <claude|codex|gemini|opencode>`: a turn-end hook that verifies the agent's work and sends a FAIL back to the agent (up to `hook.maxRetries` times in a row), with the runner's failure messages and the test output tail in the feedback; trustbut's own errors and timeouts never block.
  - `trustbut init <claude|codex|gemini|opencode> [--user] [--dry-run]`: installs the hook into the agent's config without touching other hooks.
  - Claude Code plugin and marketplace (`/plugin marketplace add isAlmogK/trustbut`).
  - Reusable GitHub Action (`isAlmogK/trustbut@v0`) with a sticky PR comment and a job summary.
  - `--receipt-json <file>` / `--receipt-md <file>` to write the receipt to files.
  - npm release workflow with trusted publishing and provenance.
