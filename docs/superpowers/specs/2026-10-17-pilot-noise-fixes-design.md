# Pilot noise fixes: unconfirmed regressions, type tests, narrower escapes

**Status:** Draft (2026-10-17)
**Feature:** trustbut-index pilot `results/pilot-2026-10-16` in [trustbut-index](https://github.com/isAlmogK/trustbut-index). This spec covers trustbut changes only. No receipt spec bump: the one new finding uses a namespaced id.

## Problem

The 2026-10-16 pilot ran trustbut 0.5.0 on merged agent and human PRs. A spot-check of its findings showed three sources of noise:

1. **`test-regressed` with no flake guard.** 2 of 3 red-at-head hits look like flaky or environment failures:
   - elizaOS/eliza#34811 changed only `packages/agent/src/runtime/default-documents.ts` and got `test-regressed` for `packages/agent/test/task-trajectory-persistence.test.ts` ("Could not initialize trajectory storage schema"). elizaOS/eliza#36297 hit the same file with the same error.
   - NVIDIA/NemoClaw#11950 got it for a deadline-based e2e test (`test/e2e/support/launch-agent-turn.test.ts`) the PR didn't touch.

   The head run is the whole suite; the base run is only a few files. A test that fails under full-suite load or shared state, then passes alone at base, looks like a regression.
2. **Type-test files aren't tests.** vuejs/test-utils#2934 added `test-dts/genericComponent.d-test.ts` and still got `no-tests-changed`. Its `// @ts-expect-error` lines were also reported as `escape-added`, since the file counted as source.
3. **`escape-added` is too broad.**
   - vuejs/test-utils#2934: a comment that only mentions `@ts-expect-error` in prose ("use @ts-expect-error to assert this") was reported. So was `T extends (...args: any[]) => VNode`, the usual way to write "any function" as a generic constraint.
   - fern-api/fern#17800: `# rubocop:disable` lines in `seed/`, which the repo's `.gitattributes` marks `linguist-generated=true`.
   - BerriAI/litellm#41506 (`# noqa: BLE001  # <reason>`), usestrix/strix#893 (`# noqa: ARG002`), ardatan/graphql-mesh#9627 (`renderGraphiQL?: (options?: any) => …`): suppressions and `any` that are real, some with a written reason.

## Goals

1. Report `test-regressed` only when the result reproduces on a rerun.
2. Recognise common type-test file conventions as tests.
3. Stop reporting escapes that aren't escapes (prose, generic constraints, generated code), and decide which real ones stay.
4. Change no core finding's meaning or severity.

## Design

### 1. Confirm regressions with a rerun

After the base run, `proveTests` (`src/proof.ts`) computes the regressed cases as today (`regressedCases`: fail or error at head, pass at base, by id). When there are none, nothing changes. Otherwise:

1. **Rerun at head.** Run the same files as the base run (`baseFiles`: changed test files plus failing files that exist at base) in the head worktree. These files all exist at head. This makes the comparison symmetric: both sides now ran the same files, so a failure that only happens in the full suite (load, shared state, ordering) drops out.
2. **Rerun at base,** only when at least one regressed case failed or errored again in the head rerun. Same files, in the base worktree (which still has the copied test files).
3. **Decide per case,** matching by id and taking each id's worst outcome:
   - head rerun `fail`/`error` **and** base rerun `pass` → `test-regressed` (unchanged finding).
   - anything else → `trustbut/regression-not-reproduced`, severity `info`:
     - title: `Test failed at head and passed at base, but a rerun did not reproduce both results`
     - `file`: same as `test-regressed` would have had
     - `detail`: `<case name> (rerun: <outcome or "no result"> at head, <outcome, "no result" or "not run"> at base)`

   "not run" means the base rerun was skipped because the head rerun didn't fail.

Each rerun gets the `setup` command like every run. Reruns happen in `quick` mode too (the hook), only when there's a candidate regression, and only over the base run's files, so their cost is bounded by the base run's. A rerun that times out or reports nothing gives "no result" for its cases, which never confirms a regression.

The reruns are not added to the receipt's `x-trustbut` runs: `after` and `before` stay the first runs, so the consumer contract from the 0.5.0 spec ("a head failure whose id is absent from `before.cases` had no base result") still holds. The finding carries the rerun outcomes.

**Markdown and agent feedback** mark a failing test "(passed at base)" only when a `test-regressed` finding exists for it (same name, and its `file` matches the case), instead of recomputing from `before`/`after`. An unconfirmed one is listed as a plain failing test, and its info finding is listed with the other findings.

Why a namespaced id: the receipt spec reserves core ids for fixed meanings and needs a minor bump to add one. An info finding under `trustbut/` needs no spec change, and consumers handle an unknown namespaced id by its severity. `suite-failing` still fires for a red head run: the head run did fail, and this change is only about blaming the PR.

### 2. Type-test files are tests

Add to the JS language (`src/languages/js.ts`) a `typeTestFile` pattern, and include it in `testFile`:

- directories `test-d/` (tsd), `test-dts/` (Vue), `__typetests__/` (jest-runner-tsd);
- files `*.test-d.ts`, `*.spec-d.ts` (tsd, Vitest typecheck), `*.d-test.ts`, each also with `.tsx`, `.mts` and `.cts`.

`Language` gains an optional `typeTestFile?: RegExp` ("test files checked by the type checker, not run by a test runner"), with a helper `isTypeTestFile(path)` in `src/languages/index.ts`.

Effects:

- `classify` returns `test`, so `no-tests-changed` no longer fires when only type tests were added, and `escape-added` (source files only) no longer looks at them. That is what fixes the `@ts-expect-error` lines in vuejs/test-utils#2934: in a type test, `@ts-expect-error` is the assertion.
- The test-integrity checks (skip, focus, removed tests and assertions) run on them with the JS rules, like any test file.
- The proof engine leaves type-test files out of the files it runs (`liveTests` in `proveTests`), at base and in `quick` mode. Passed to Vitest or Jest, a type-test path matches no runtime test file and the run would exit nonzero with nothing reported (a false `base-run-failed`). They are still copied into the base checkout like every test file. They're not in `testFileName`, so they never cause `proofs-unmatched`.

Vitest's typecheck mode can run `*.test-d.ts`. trustbut doesn't rely on it: type tests get no fail-before/pass-after proofs.

### 3. Narrower `escape-added`

**a. JS directives count only where the tool honours them.** TypeScript reads `@ts-ignore`, `@ts-expect-error` and `@ts-nocheck` only at the start of a comment (after `//`, `///`, `/*` or a `*` continuation, and optional spaces). ESLint reads `eslint-disable…` and Istanbul/c8/v8 read `… ignore` the same way. The JS comment rules require the directive right after a comment marker: `(?:^|\s)(?:\/\/\/?|\/\*+|\*)\s*<directive>`. A comment that mentions a directive in prose is no longer reported. Other languages are unchanged (flake8 and Ruff accept `# noqa` anywhere in a comment, and the pilot showed no prose hits there).

**b. `any` in a generic constraint is not an escape.** `T extends (...args: any[]) => R` (and `new (...args: any[]) => T`) is how TypeScript spells "any function" or "any constructor": `unknown[]` doesn't type-check there, because parameters are contravariant. The `explicit any` rule skips a `: any` that comes after `<Name extends` or `, Name extends` on the same line. Every other `: any` still counts, **including `any` in a type signature** such as `renderGraphiQL?: (options?: any) => …` (graphql-mesh#9627): an `any` parameter turns off checking for every caller and implementation, which is what the finding names.

**c. Generated files are skipped.** Files that the head commit's `.gitattributes` marks `linguist-generated` (set or `true`) get no `escape-added`. Generated code isn't written by the agent or a person, and the fix belongs in the generator. Checked with `git check-attr --cached -z --stdin linguist-generated` against a temporary index read from head (`git read-tree <head>` with `GIT_INDEX_FILE`, as `snapshotWorkingTree` does), so nested `.gitattributes` files and git's own pattern rules apply, without `check-attr --source` (git 2.40+). Only changed files with added lines in a registered language are asked. The other checks are unchanged for generated files.

**d. Justified and scoped suppressions still count.** `# noqa: BLE001  # reason` (litellm#41506) and `# noqa: ARG002` (strix#893) stay `escape-added`. A rule code narrows a suppression and a reason explains it, but the check is still off on that line, and a deterministic check can't judge a reason. Agents write such reasons by habit, so exempting them would exempt most agent-written suppressions, the case this check exists for. The finding's `detail` already shows the line with its reason, so a reviewer sees it.

## Testing

Test first, per AGENTS.md.

- **Unit (`test/proof.test.ts`):** rerun calls and files; confirmed regression; head rerun passes → not reproduced with "not run" at base; head rerun fails and base rerun fails → not reproduced; head rerun reports nothing → "no result"; no reruns when nothing regressed. The stub runners take a sequence of runs.
- **Unit (`test/render.test.ts` or the existing render tests):** "(passed at base)" only for a case with a `test-regressed` finding.
- **Unit (classify / language tests):** each type-test convention classifies as `test`, is a type test, isn't a named test file; ordinary files unchanged.
- **Unit (checks / language rules):** prose mentions not reported; directives after `//`, `/*`, `/**`, JSX `{/* … */}`, `*` continuation still reported; `extends (...args: any[]) =>` not reported; `(options?: any) =>` and `x: any` still reported; `# noqa: BLE001  # reason` still reported; generated files skipped.
- **Unit (`test/git.test.ts`):** the `linguist-generated` lookup reads head's `.gitattributes` (root and nested, set, `=true`, `-linguist-generated`, `=false`).
- **e2e (`test/e2e.test.ts`, real Vitest):** a test that fails on its first run and passes afterwards (a marker file outside the repo) gives `trustbut/regression-not-reproduced` and no `test-regressed`; the existing "test the change broke" scenario still gives `test-regressed`; a PR that changes source and adds `test-dts/x.d-test.ts` with `// @ts-expect-error` gets no `no-tests-changed`, no `escape-added`, no `base-run-failed`; an escape in a `linguist-generated` file gets no `escape-added`.

## Out of scope

- Skipping generated files in other checks (`no-tests-changed`, risk ranking).
- Running type tests (`tsc`, `tsd`, Vitest typecheck).
- Receipt spec changes; a version bump or release (the study pins the trustbut version, so the user decides).
