# Pilot Noise Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut three sources of noisy findings seen in the trustbut-index pilot: unconfirmed `test-regressed`, type-test files counted as source, and over-broad `escape-added`.

**Architecture:** `proveTests` reruns the base run's files at head (and then at base) when it finds a candidate regression, and reports only reproduced ones; the rest become an info finding `trustbut/regression-not-reproduced`. The JS language gains a `typeTestFile` pattern that `classify` treats as test and the proof engine never runs. `checkEscapes` gets anchored JS directive rules, a generic-constraint exception for `any`, and skips files `.gitattributes` marks `linguist-generated` at head.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` imports), Vitest, execa, git ≥ 2.17.

Spec: [`docs/superpowers/specs/2026-10-17-pilot-noise-fixes-design.md`](../specs/2026-10-17-pilot-noise-fixes-design.md).

## Global Constraints

- No receipt spec change and no version bump or release.
- New finding id: `trustbut/regression-not-reproduced`, severity `info`, title `Test failed at head and passed at base, but a rerun did not reproduce both results`.
- Findings state facts, never intent.
- Git: nothing newer than 2.17 (no `check-attr --source`).
- Test first; commit after each task with a conventional message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands: `npx vitest run <file>`, `npm test`, `npm run typecheck`, `npm run receipt`.

---

### Task 1: Confirm regressions with a rerun

**Files:**
- Modify: `src/proof.ts` (after the base run, where `test-regressed` findings are pushed)
- Test: `test/proof.test.ts` (`recordingRunner`, `stubRunner`, `describe('proveTests regressions')`)

**Interfaces:**
- Produces: `export function confirmRegressions(candidates: TestCaseResult[], headRerun: RunResult, baseRerun: RunResult | undefined): { confirmed: TestCaseResult[]; unconfirmed: { c: TestCaseResult; head: string; base: string }[] }` in `src/proof.ts` (pure; `head`/`base` are an outcome, `no result` or `not run`).

- [ ] **Step 1: Make the test stubs take a sequence of runs.** `recordingRunner(...runs: RunResult[])` returns `runs[min(i, runs.length - 1)]` for call `i`; `stubRunner(...runs)` the same. Existing call sites keep working (two runs → head, then base for every later call).
- [ ] **Step 2: Write failing tests** in `describe('proveTests regressions')`:
  - confirmed: head `old` fail; base `old` pass; head rerun `old` fail; base rerun `old` pass → `calls.map(c => c.files)` is `[undefined, B, B, B]` (B = the base run's files) and findings `[suiteRed, regressed('test/old.test.js', 'old')]`.
  - head rerun passes → 3 calls, finding `notReproduced('test/old.test.js', 'old (rerun: pass at head, not run at base)')`.
  - head rerun fails, base rerun fails → `notReproduced(…, 'old (rerun: fail at head, fail at base)')`.
  - head rerun reports nothing → `'old (rerun: no result at head, not run at base)'`.
  - no regressed candidate (the `flaky` case failing on both sides) → no rerun call.
  - update the existing regression tests to pass the reruns they need (head rerun = the head run, base rerun = the base run) so their expected findings stay.

  ```ts
  const notReproduced = (file: string, detail: string) => ({
    id: 'trustbut/regression-not-reproduced', severity: 'info',
    title: 'Test failed at head and passed at base, but a rerun did not reproduce both results', file, detail,
  });
  ```
- [ ] **Step 3: Run** `npx vitest run test/proof.test.ts` → the new tests fail (no rerun calls, `test-regressed` reported).
- [ ] **Step 4: Implement.** In `proveTests`, replace the loop over `regressedCases(before, after)`:

  ```ts
  const candidates = regressedCases(before, after);
  if (candidates.length) {
    const headRerun = await runWithSetup(runner, { ...runOptions, cwd: headRoot, worktree: headDir, files: baseFiles }, setup);
    const stillFailing = candidates.some((c) => isFailure(outcomeOf(headRerun, c.id)));
    const baseRerun = stillFailing ? await runWithSetup(runner, { ...runOptions, cwd: baseRoot, worktree: baseDir, files: baseFiles }, setup) : undefined;
    const { confirmed, unconfirmed } = confirmRegressions(candidates, headRerun, baseRerun);
    // push test-regressed for confirmed (unchanged shape), regression-not-reproduced for unconfirmed
  }
  ```

  `confirmRegressions` uses `worstById` for each rerun; a case is confirmed when its head rerun outcome is `fail`/`error` and its base rerun outcome is `pass`; otherwise unconfirmed with `head` = outcome or `no result`, `base` = outcome, `no result` (rerun ran, case absent) or `not run` (no base rerun). Keep head order. The file of either finding: `${prefix}${resolveCaseFile(c.file, headRoot) ?? c.file}` (omitted when empty), as today.
- [ ] **Step 5: Run** `npx vitest run test/proof.test.ts` → pass.
- [ ] **Step 6: Commit** `fix: report test-regressed only when a rerun reproduces it`.

### Task 2: Mark "(passed at base)" from findings

**Files:**
- Modify: `src/render.ts` (`regressedIds`)
- Test: `test/receipt.test.ts` (`describe('renderMarkdown')`)

- [ ] **Step 1: Failing test:** a receipt whose `before`/`after` show `x` regressed but whose findings hold only `trustbut/regression-not-reproduced` for `x` renders `- \`t.test.js\` › x\n` without "(passed at base)".
- [ ] **Step 2: Run** `npx vitest run test/receipt.test.ts` → fails.
- [ ] **Step 3: Implement:**

  ```ts
  /** Ids of failing head results that have a `test-regressed` finding (same name, matching file). */
  export function regressedIds(r: Receipt): Set<string> {
    const found = r.findings.filter((f) => f.id === 'test-regressed');
    const failing = (r.after?.cases ?? []).filter((c) => c.outcome === 'fail' || c.outcome === 'error');
    return new Set(failing.filter((c) => found.some((f) => f.detail === c.name && (!f.file || caseInFile(c, f.file)))).map((c) => c.id));
  }
  ```

  Import `caseInFile` from `./proof.js` instead of `regressedCases`.
- [ ] **Step 4: Run** `npx vitest run test/receipt.test.ts test/hook-feedback.test.ts` → pass.
- [ ] **Step 5: Commit** `fix: mark tests as passed at base only when the regression was confirmed`.

### Task 3: e2e scenario for a flaky test

**Files:**
- Test: `test/e2e.test.ts`

- [ ] **Step 1: Write the scenario** (real Vitest): base has `src/sum.js` and `test/flaky.test.js`, whose test throws on its first run and passes afterwards, using a marker file in a fresh `mkdtemp` directory outside the repo whose path is written into the test file. The branch changes only `src/sum.js`. Expect `trustbut/regression-not-reproduced` for `test/flaky.test.js` with detail `fails once (rerun: pass at head, not run at base)` and no `test-regressed`.

  ```ts
  const flaky = (mark: string) => `import { it } from 'vitest';\nimport { existsSync, writeFileSync } from 'node:fs';\nit('fails once', () => {\n  if (!existsSync(${JSON.stringify(mark)})) { writeFileSync(${JSON.stringify(mark)}, ''); throw new Error('first run'); }\n});\n`;
  ```
- [ ] **Step 2: Run** `npx vitest run test/e2e.test.ts -t flaky` → passes on top of Task 1 (it would have failed before Task 1: `test-regressed` was reported). Confirm the existing "reports the test the change broke" scenario still passes.
- [ ] **Step 3: Commit** `test: e2e scenario for a test that fails once at head`.

### Task 4: Type-test files are tests

**Files:**
- Modify: `src/languages/types.ts` (`typeTestFile?: RegExp`), `src/languages/js.ts`, `src/languages/index.ts` (`isTypeTestFile`), `src/proof.ts` (`liveTests`)
- Test: `test/languages.test.ts`, `test/proof.test.ts`, `test/e2e.test.ts`

**Interfaces:**
- Produces: `export function isTypeTestFile(path: string): boolean` in `src/languages/index.ts`.

- [ ] **Step 1: Failing tests:**
  - `languages.test.ts`: `classify(p) === 'test'`, `isTypeTestFile(p)` and `!isNamedTestFile(p)` for `test-dts/genericComponent.d-test.ts`, `test-d/index.ts`, `index.test-d.ts`, `src/a.spec-d.tsx`, `types/__typetests__/a.ts`, `src/x.test-d.mts`; `isTypeTestFile` false for `src/a.test.ts`, `src/types.d.ts`, `src/test-data.ts`.
  - `proof.test.ts`: a change that adds `src/a.js` and `test-dts/a.d-test.ts` with a stub head run passing runs only the head run (no base call) and has no findings; in `quick` mode the head run gets `files: undefined`.
  - `e2e.test.ts`: `scenario({ 'src/sum.js': fixed, 'test-dts/sum.d-test.ts': "import { sum } from '../src/sum.js';\n// @ts-expect-error -- sum takes numbers\nsum('a', 1);\n" })` has no `no-tests-changed`, `escape-added` or `base-run-failed`.
- [ ] **Step 2: Run** those files → fail.
- [ ] **Step 3: Implement.** In `js.ts`:

  ```ts
  const TYPE_TEST = /(^|\/)(test-dts|test-d|__typetests__)\/|\.(test|spec)-d\.[cm]?tsx?$|\.d-test\.[cm]?tsx?$/;
  // testFile: existing source + '|' + TYPE_TEST.source; typeTestFile: TYPE_TEST
  ```

  In `index.ts`: `export function isTypeTestFile(path: string): boolean { return !!languageOf(path)?.typeTestFile?.test(path); }`. In `proveTests`: `const liveTests = changes.filter((c) => c.kind === 'test' && c.status !== 'deleted' && !isTypeTestFile(c.path));`.
- [ ] **Step 4: Run** → pass. Also `npx vitest run test/classify* test/checks.test.ts`.
- [ ] **Step 5: Commit** `feat: recognise type-test files (test-d, test-dts, *.test-d.ts, *.d-test.ts) as tests`.

### Task 5: Anchor JS directives; allow `any` in generic constraints

**Files:**
- Modify: `src/languages/js.ts` (`escapes`)
- Test: `test/checks.test.ts`

- [ ] **Step 1: Failing tests** in `checks.test.ts`:
  - not reported: `// should NOT type-check (use @ts-expect-error to assert this).`, `// we don't add eslint-disable here`, `// see istanbul ignore docs`, `findComponent<T extends (...args: any[]) => VNode>(`, `type C<T extends new (...args: any[]) => object> = T;`, `function f<A, B extends (...a: any[]) => any>() {}`.
  - still reported: `// @ts-expect-error -- reason`, `/* @ts-ignore */`, `/** @ts-ignore */`, `{/* @ts-expect-error */}`, ` * @ts-ignore`, `/// @ts-nocheck`, `// eslint-disable-line`, `/* c8 ignore next */`, `renderGraphiQL?: (options?: any) => string;`, `function f(x: any) {}`, `class A extends B { x: any }` is out of scope (don't test), `except Exception:  # noqa: BLE001  # reason` (py).
- [ ] **Step 2: Run** `npx vitest run test/checks.test.ts` → the "not reported" cases fail.
- [ ] **Step 3: Implement** in `js.ts`:

  ```ts
  // Directives only count right after a comment marker, where TypeScript, ESLint and Istanbul read them.
  const directive = (body: string) => new RegExp(String.raw`(?:^|\s)(?:\/\/\/?|\/\*+|\*)\s*(?:${body})`);
  escapes: [
    { part: 'code', re: /\bas\s+any\b/, title: 'cast to any' },
    // `any` in a generic constraint (`T extends (...args: any[]) => R`) spells "any function", not an unchecked value.
    { part: 'code', re: /(?<![<,]\s*\w+\s+extends\b.*):\s*any\b(?!\s*\()/, title: 'explicit any' },
    { part: 'comment', re: directive('@ts-(?:ignore|nocheck|expect-error)'), title: 'TypeScript check suppressed' },
    { part: 'comment', re: directive('eslint-disable'), title: 'lint rule disabled' },
    { part: 'comment', re: directive(String.raw`(?:istanbul|c8|v8)\s+ignore\b`), title: 'coverage exclusion' },
  ],
  ```
- [ ] **Step 4: Run** `npx vitest run test/checks.test.ts test/languages.test.ts test/lex.test.ts` → pass.
- [ ] **Step 5: Commit** `fix: escape-added ignores directive prose and any in generic constraints`.

### Task 6: Skip generated files in escape-added

**Files:**
- Modify: `src/git.ts` (`generatedPaths`), `src/checks/escapes.ts`, `src/commands/verify.ts`
- Test: `test/git.test.ts`, `test/checks.test.ts`, `test/e2e.test.ts`

**Interfaces:**
- Produces: `export async function generatedPaths(repo: string, ref: string, paths: string[]): Promise<Set<string>>` in `src/git.ts`; `checkEscapes(files: ChangedFile[], generated: ReadonlySet<string> = new Set())`.

- [ ] **Step 1: Failing tests:**
  - `git.test.ts`: a repo whose head commit has `.gitattributes` `seed/** linguist-generated=true`, `gen.ts linguist-generated`, `seed/keep.ts -linguist-generated`, and `sub/.gitattributes` `*.g.ts linguist-generated`; the working tree's `.gitattributes` is then deleted (uncommitted). `generatedPaths(repo, head, ['seed/a.rb', 'seed/keep.ts', 'x/gen.ts', 'sub/a.g.ts', 'src/a.ts'])` → `{'seed/a.rb', 'x/gen.ts', 'sub/a.g.ts'}`; `[]` → empty set without running git.
  - `checks.test.ts`: `checkEscapes([file({ path: 'seed/a.rb', kind: 'source', added: [{ line: 1, text: 'value # rubocop:disable Lint/Void' }] })], new Set(['seed/a.rb']))` → `[]`.
  - `e2e.test.ts`: `scenario({ '.gitattributes': 'gen/** linguist-generated=true\n', 'gen/client.ts': 'export const c = {} as any;\n', 'src/sum.js': fixed, 'test/sum.test.js': test })` has no `escape-added`.
- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement** `generatedPaths`:

  ```ts
  /** Paths that `.gitattributes` at `ref` marks `linguist-generated` (set or true), read through a temporary index. */
  export async function generatedPaths(repo: string, ref: string, paths: string[]): Promise<Set<string>> {
    if (!paths.length) return new Set();
    const dir = await mkdtemp(join(tmpdir(), 'trustbut-index-'));
    try {
      const env = { GIT_INDEX_FILE: join(dir, 'index') };
      await execa('git', ['read-tree', ref], { cwd: repo, env });
      const { stdout } = await execa('git', ['check-attr', '--cached', '-z', '--stdin', 'linguist-generated'], { cwd: repo, env, input: paths.join('\0') });
      const parts = stdout.split('\0');
      const out = new Set<string>();
      for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 2] === 'set' || parts[i + 2] === 'true') out.add(parts[i]!);
      return out;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  ```

  `checkEscapes` skips `generated.has(f.path)`. In `verify.ts`: ask only source files with added lines in a registered language with escape rules:

  ```ts
  const escapable = changes.filter((c) => c.kind === 'source' && c.added.length && languageOf(c.path)?.rules.escapes?.length).map((c) => c.path);
  const findings = [...checkTestIntegrity(changes), ...checkEscapes(changes, await generatedPaths(repo, head, escapable))];
  ```
- [ ] **Step 4: Run** → pass.
- [ ] **Step 5: Commit** `fix: escape-added skips files .gitattributes marks linguist-generated`.

### Task 7: Docs, verification, PR

**Files:**
- Modify: `docs/SPEC.md` (§2 diff parser, §3 escape row, §4 proof engine, §6 "When trustbut emits each id" table + a line for the namespaced id), `CHANGELOG.md` (`## Unreleased`), the spec's status and `## As built`.

- [ ] **Step 1:** Update `docs/SPEC.md` and `CHANGELOG.md` (under `## Unreleased`, no version).
- [ ] **Step 2:** `npm run typecheck && npm test` → all pass.
- [ ] **Step 3:** `npm run receipt` → no FAIL caused by the change; keep the receipt for the PR body.
- [ ] **Step 4:** Spec status `Implemented (2026-10-17)` and `## As built`; commit `docs: …`.
- [ ] **Step 5:** Push the branch and open a PR against `main` with the receipt.
