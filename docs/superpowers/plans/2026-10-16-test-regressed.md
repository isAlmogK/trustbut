# Regressed tests and output tails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** trustbut 0.5.0 reports each test that passes at base and fails at head (`test-regressed`, receipt spec 1.1) and can put the end of a failed run's output in the JSON receipt (`--output-tail`).

**Architecture:** `proveTests` (`src/proof.ts`) adds the files of tests failing at head to its single base run and compares outcomes by case id. Two pure helpers, `resolveCaseFile` and `regressedCases`, carry the logic. The receipt spec gains one core id (minor 1.1), and the validator learns which minor introduced it. The output tail is an opt-in `toAgentReceipt` option wired to a `verify` flag.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` imports), Node >= 22, Vitest, commander, execa.

**Spec:** `docs/superpowers/specs/2026-10-16-test-regressed-design.md`

## Global Constraints

- Imports use `.js` extensions (NodeNext).
- Test first: every behavior change starts with a failing test.
- Every new finding type needs a fixture scenario in `test/fixtures/` or `test/e2e.test.ts`.
- Findings describe facts, never intent.
- Never touch the user's working tree; worktrees are always removed in a `finally` (already true in `proveTests`; keep it).
- Git compatibility: no `git switch`, `git init -b` or other flags newer than git 2.17.
- New finding: id `test-regressed`, severity `fail`, title `Test passes at base and fails at head`.
- Receipt `specVersion` becomes `"1.1"`.
- Output tail in receipts: last 50 lines, at most 4,000 characters, ANSI removed, only with `--output-tail`, only for a run with a non-zero exit code.
- Agent feedback tail keeps 20 lines / 1,500 characters.
- Commit after each task with a conventional message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before reporting done: `npm run receipt` and include the receipt; a FAIL caused by the change blocks.

## File map

| File | Change |
|---|---|
| `src/spec/catalog.ts` | add `test-regressed`; add `CORE_FINDING_SINCE` |
| `src/spec/types.ts` | `SPEC_VERSION = '1.1'`; `TrustbutRun.outputTail?` |
| `src/spec/validate.ts` | known minor 1.1; reject a newer core id in an older declared minor |
| `spec/agent-receipt-v1.schema.json` | core id enum gains `test-regressed` |
| `spec/agent-receipt-v1.md` | catalog row, version 1.1, validating text, invalid example row, Changes |
| `spec/examples/valid/regressed.json` | new |
| `spec/examples/invalid/regressed-in-1-0.json` | new |
| `spec/examples/invalid/bad-finding-id-newer-minor.json` | `specVersion` 1.1 → 1.2 |
| `src/proof.ts` | `resolveCaseFile`, `regressedCases`, base run covers failing files, `test-regressed` findings |
| `src/render.ts` | "(passed at base)" marker; skip `test-regressed` lines next to the failing list; `outputTail` limits |
| `src/hook/feedback.ts` | `N passed at base` in the summary |
| `src/spec/serialize.ts` | `toAgentReceipt(receipt, { outputTail })` |
| `src/commands/verify.ts`, `src/program.ts` | `--output-tail` |
| `test/spec.test.ts`, `test/serialize.test.ts`, `test/proof.test.ts`, `test/e2e.test.ts`, `test/receipt.test.ts`, `test/hook-feedback.test.ts` | tests |
| `docs/SPEC.md`, `CHANGELOG.md`, versions | docs and release prep |

---

### Task 1: Receipt spec 1.1 with the `test-regressed` core id

**Files:**
- Modify: `src/spec/catalog.ts`, `src/spec/types.ts:4`, `src/spec/validate.ts:57-130`, `spec/agent-receipt-v1.schema.json:76-83`, `spec/agent-receipt-v1.md`
- Create: `spec/examples/valid/regressed.json`, `spec/examples/invalid/regressed-in-1-0.json`
- Modify: `spec/examples/invalid/bad-finding-id-newer-minor.json`
- Test: `test/spec.test.ts`, `test/serialize.test.ts:43`, `test/e2e.test.ts:217`

**Interfaces:**
- Produces: `CORE_FINDINGS['test-regressed'] === 'fail'`; `CORE_FINDING_SINCE: Partial<Record<CoreFindingId, number>>` (minor that introduced an id); `SPEC_VERSION === '1.1'`.

- [ ] **Step 1: Write the failing tests**

In `test/spec.test.ts`:

1. Add to `INVALID`:
```ts
  'regressed-in-1-0.json': { path: '/findings/0/id', message: "'test-regressed' is a core id since 1.1 (the receipt declares 1.0)" },
```
2. In `describe('a receipt from a newer 1.x minor')`, replace every `future('1.1')` with `future('1.2')`, and change the two expected warning messages to:
```ts
          { path: '/', message: "unknown in spec 1.1: 'coverage' (allowed for a newer 1.x receipt)" },
          { path: '/findings/0/id', message: "'mutation-survived' is not a 1.1 core id (allowed for a newer 1.x receipt)" },
```
3. Add a new describe at the end of the file:
```ts
describe('test-regressed (spec 1.1)', () => {
  const regressed = (specVersion: string) => ({
    ...base(),
    specVersion,
    verdict: 'fail',
    findings: [{ id: 'test-regressed', severity: 'fail', title: 'Test passes at base and fails at head', file: 'test/a.test.ts', detail: 'adds' }],
  });

  it('is a core id with default severity fail', () => {
    expect(isCoreFindingId('test-regressed')).toBe(true);
    expect(CORE_FINDINGS['test-regressed']).toBe('fail');
  });

  it('is valid with no warnings in a 1.1 receipt', () => {
    expect(validateAgentReceipt(regressed('1.1'))).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('is invalid in a receipt that declares 1.0', () => {
    expect(validateAgentReceipt(regressed('1.0'))).toEqual({
      valid: false,
      errors: [{ path: '/findings/0/id', message: "'test-regressed' is a core id since 1.1 (the receipt declares 1.0)" }],
      warnings: [],
    });
  });
});
```

In `test/serialize.test.ts:43` change `expect(r.specVersion).toBe('1.0');` to `expect(r.specVersion).toBe('1.1');`.
In `test/e2e.test.ts:217` change `specVersion: '1.0'` to `specVersion: '1.1'`.

- [ ] **Step 2: Create the example files**

`spec/examples/valid/regressed.json`:
```json
{
  "$schema": "https://raw.githubusercontent.com/isAlmogK/trustbut/main/spec/agent-receipt-v1.schema.json",
  "specVersion": "1.1",
  "producer": { "name": "trustbut", "version": "0.5.0" },
  "subject": { "base": "main", "head": "HEAD" },
  "verdict": "fail",
  "tests": { "passed": 3, "failed": 1, "errored": 0, "skipped": 0, "scope": "full" },
  "findings": [
    { "id": "suite-failing", "severity": "fail", "title": "Test suite fails at head (clean checkout)", "detail": "exit code 1" },
    { "id": "test-regressed", "severity": "fail", "title": "Test passes at base and fails at head", "file": "test/sum.test.js", "detail": "adds" }
  ]
}
```

`spec/examples/invalid/regressed-in-1-0.json`:
```json
{
  "specVersion": "1.0",
  "producer": { "name": "trustbut", "version": "0.4.0" },
  "subject": { "base": "main", "head": "HEAD" },
  "verdict": "fail",
  "findings": [{ "id": "test-regressed", "severity": "fail", "title": "Test passes at base and fails at head" }]
}
```

In `spec/examples/invalid/bad-finding-id-newer-minor.json` change `"specVersion": "1.1"` to `"specVersion": "1.2"` (it must stay newer than what the validator knows).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/spec.test.ts test/serialize.test.ts`
Expected: FAIL. `regressed.json` is invalid (unknown id in the schema enum), the `regressed-in-1-0.json` message differs, the newer-minor messages still say `1.0`, and `specVersion` is still `'1.0'`.

- [ ] **Step 4: Implement**

`src/spec/catalog.ts`: add `'test-regressed': 'fail',` right after `'test-failing': 'fail',`, and below `CORE_FINDINGS` and `CoreFindingId` add:
```ts
/** The spec minor that introduced a core id; ids not listed are from 1.0. */
export const CORE_FINDING_SINCE: Partial<Record<CoreFindingId, number>> = { 'test-regressed': 1 };
```

`src/spec/types.ts:4`: `export const SPEC_VERSION = '1.1';`

`spec/agent-receipt-v1.schema.json`: in the `findingId` enum, change `"test-focused", "suite-failing", "test-failing",` to `"test-focused", "suite-failing", "test-failing", "test-regressed",`.

`src/spec/validate.ts`:
- Change the import to `import { CORE_FINDINGS, CORE_FINDING_SINCE, isCoreFindingId } from './catalog.js';` and add `import { SPEC_VERSION } from './types.js';` (check the existing imports first; reuse one if present).
- Replace the `NEWER_MINOR` / `isNewerMinor` block with:
```ts
const MINOR = /^1\.(\d+)$/;
/** The newest spec minor this validator knows (`1.1` → 1). */
const KNOWN_MINOR = Number(SPEC_VERSION.split('.')[1]);
/** The shape of a core id (`test-focused`): a newer minor's core ids have it too; anything else is malformed. */
const CORE_ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

/** The 1.x minor a receipt declares, or undefined when it declares none. */
function declaredMinor(value: unknown): number | undefined {
  const version = typeof value === 'object' && value !== null ? (value as { specVersion?: unknown }).specVersion : undefined;
  const match = typeof version === 'string' ? MINOR.exec(version) : null;
  return match ? Number(match[1]) : undefined;
}

/** Whether the receipt declares a 1.x minor newer than this validator knows. */
function isNewerMinor(value: unknown): boolean {
  const minor = declaredMinor(value);
  return minor !== undefined && minor > KNOWN_MINOR;
}
```
- In `splitForNewerMinor`, change the two messages to use `SPEC_VERSION`:
```ts
      warnings.push({ path: p.path, message: `unknown in spec ${SPEC_VERSION}: '${p.unknownProperty}' (allowed for a newer 1.x receipt)` });
```
```ts
      warnings.push({ path: p.path, message: `'${id}' is not a ${SPEC_VERSION} core id (allowed for a newer 1.x receipt)` });
```
- Update the doc comments that say "newer than 1.0" / "unknown to 1.0" to say "newer than this validator knows" / "unknown to this validator".
- In `validateAgentReceipt`, right after `const errors: ValidationProblem[] = [];`, add:
```ts
  const minor = declaredMinor(value) ?? 0;
  receipt.findings.forEach((f, i) => {
    const since = isCoreFindingId(f.id) ? CORE_FINDING_SINCE[f.id] : undefined;
    if (since !== undefined && since > minor) {
      errors.push({ path: `/findings/${i}/id`, message: `'${f.id}' is a core id since 1.${since} (the receipt declares 1.${minor})` });
    }
  });
```
  Make sure this runs before the verdict check, so the id error is listed first. The verdict rule still runs.

`spec/agent-receipt-v1.md`:
- Example JSON: `"specVersion": "1.1"`, `"version": "0.5.0"`.
- Fields table: `This document is \`1.1\`.`
- Catalog: add the row right after `test-failing`:
  `| \`test-regressed\` | \`fail\` | A test passes at base and fails at head. |`
- Versioning: after "Receipts that declare `1.0` are validated strictly.", add: "A receipt that uses a core id introduced in a later minor than it declares is invalid."
- Validating: replace "in a receipt that declares a minor newer than `1.0`" with "in a receipt that declares a minor newer than the validator knows (this document is `1.1`)". Add to the invalid-examples table:
  `| \`invalid/regressed-in-1-0.json\` | \`/findings/0/id\`: 'test-regressed' is a core id since 1.1 (the receipt declares 1.0) |`
- Changes: add above `1.0`:
  `- **1.1** (trustbut 0.5.0): adds the core id \`test-regressed\`.`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/spec.test.ts test/serialize.test.ts test/spec-doc.test.ts test/validate.test.ts`
Expected: PASS. `spec-doc.test.ts` checks the catalog table equals `CORE_FINDINGS` and that every invalid example is documented.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS. If a CLI test prints a validate message containing `spec 1.0` or `1.0 core id`, update the expected text to `1.1`.

- [ ] **Step 7: Commit**

```bash
git add src/spec spec test/spec.test.ts test/serialize.test.ts test/e2e.test.ts
git commit -m "feat: receipt spec 1.1 adds the test-regressed core id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `resolveCaseFile` and `regressedCases`

**Files:**
- Modify: `src/proof.ts` (imports at lines 1-12; new exports after `isSynthetic`, line ~99)
- Test: `test/proof.test.ts`

**Interfaces:**
- Produces:
  - `resolveCaseFile(file: string, root: string): string | undefined`: a runner-reported case file → a path relative to `root` that is a file, or undefined.
  - `regressedCases(before: RunResult, after: RunResult): TestCaseResult[]`: head cases (worst outcome per id, first-seen order) that aren't synthetic, are `fail` or `error`, and whose worst base outcome by id is `pass`.

- [ ] **Step 1: Write the failing tests**

Add `mkdir`, `writeFile` to the `node:fs/promises` import and `regressedCases, resolveCaseFile` to the `../src/proof.js` import in `test/proof.test.ts`. Then add:

```ts
describe('resolveCaseFile', () => {
  async function tree() {
    const root = await mkdtemp(join(tmpdir(), 'resolve-'));
    await mkdir(join(root, 'test'), { recursive: true });
    await mkdir(join(root, 'tests', 'api'), { recursive: true });
    await writeFile(join(root, 'test', 'a.test.js'), '');
    await writeFile(join(root, 'tests', 'api', 'test_x.py'), '');
    return root;
  }

  it('keeps an existing relative path and makes an absolute one under the root relative', async () => {
    const root = await tree();
    expect(resolveCaseFile('test/a.test.js', root)).toBe('test/a.test.js');
    expect(resolveCaseFile(join(root, 'test', 'a.test.js'), root)).toBe('test/a.test.js');
  });

  it('maps a pytest module name, with or without a class, to its .py file', async () => {
    const root = await tree();
    expect(resolveCaseFile('tests.api.test_x', root)).toBe('tests/api/test_x.py');
    expect(resolveCaseFile('tests.api.test_x.TestY', root)).toBe('tests/api/test_x.py');
  });

  it('resolves nothing that is empty, synthetic, missing, outside the root or a folder', async () => {
    const root = await tree();
    for (const file of ['', '[cargo]', 'test/missing.test.js', '../a.test.js', '/etc/hosts', 'tests.api.nope', 'test']) {
      expect(resolveCaseFile(file, root), file).toBeUndefined();
    }
  });
});

describe('regressedCases', () => {
  it('reports head failures and errors that passed at base, once, in head order', () => {
    const before = run([tc('t/a', 'x', 'pass'), tc('t/a', 'y', 'pass'), tc('t/a', 'z', 'fail'), tc('t/a', 'w', 'skip'), tc('t/a', 'v', 'pass'), tc('t/a', 'v', 'fail')]);
    const after = run([
      tc('t/a', 'y', 'error'), tc('t/a', 'x', 'fail'), tc('t/a', 'x', 'fail'),
      tc('t/a', 'z', 'fail'), tc('t/a', 'w', 'fail'), tc('t/a', 'new', 'fail'), tc('t/a', 'v', 'fail'),
      tc('t/a', 'u', 'pass'), tc('t/a', 'u', 'fail'),
    ], 1);
    expect(regressedCases(before, after).map((c) => [c.name, c.outcome])).toEqual([['y', 'error'], ['x', 'fail']]);
  });

  it('counts a head id that passes once and fails once as failing, and ignores synthetic cases', () => {
    const synthetic: TestCaseResult = { id: '[cargo]::[build]', file: '[cargo]', name: '[build or run failed]', outcome: 'error' };
    const before = run([tc('t/a', 'u', 'pass'), { ...synthetic, outcome: 'pass' }]);
    const after = run([tc('t/a', 'u', 'pass'), tc('t/a', 'u', 'fail'), synthetic], 1);
    expect(regressedCases(before, after).map((c) => c.name)).toEqual(['u']);
  });
});
```

Note on the first test: `u` isn't in `before`, so it is not regressed there. `v` has worst base outcome `fail`, so it isn't either.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/proof.test.ts -t "resolveCaseFile|regressedCases"`
Expected: FAIL with "resolveCaseFile is not a function" / "regressedCases is not a function".

- [ ] **Step 3: Implement in `src/proof.ts`**

Imports: change line 1 to `import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';`, change line 3 to `import { dirname, isAbsolute, join, relative, sep } from 'node:path';`, and change line 7 to `import { SEVERITY, addCase } from './runners/cases.js';`.

Add after `isSynthetic` (line ~99):
```ts
const isFileAt = (root: string, rel: string): boolean => statSync(join(root, rel), { throwIfNoEntry: false })?.isFile() === true;
const PY_MODULE = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/;

/**
 * A runner-reported case file as a path relative to `root` that exists as a file there: a relative path,
 * an absolute path under `root`, or a pytest module name (`tests.api.test_x[.TestY]` → `tests/api/test_x.py`).
 */
export function resolveCaseFile(file: string, root: string): string | undefined {
  if (!file || file.startsWith('[')) return undefined;
  let rel = file;
  if (isAbsolute(file)) {
    const roots = [root, realpathSync(root)];
    const under = roots.find((r) => file.startsWith(r + sep));
    if (!under) return undefined;
    rel = relative(under, file);
  }
  if (rel.split(/[\\/]/).includes('..')) return undefined;
  if (isFileAt(root, rel)) return rel;
  if (!PY_MODULE.test(rel)) return undefined;
  const parts = rel.split('.');
  for (let n = parts.length; n >= 1; n--) {
    const candidate = `${parts.slice(0, n).join('/')}.py`;
    if (isFileAt(root, candidate)) return candidate;
  }
  return undefined;
}

/** Each id's worst result (error > fail > skip > pass), in first-seen order. */
function worstById(cases: TestCaseResult[]): TestCaseResult[] {
  const out: TestCaseResult[] = [];
  const index = new Map<string, number>();
  for (const c of cases) addCase(out, index, c);
  return out;
}

/** Head failures and errors (not placeholders) whose test passed at base, matched by id. */
export function regressedCases(before: RunResult, after: RunResult): TestCaseResult[] {
  const base = new Map(worstById(before.cases).map((c) => [c.id, c.outcome]));
  return worstById(after.cases).filter((c) => !isSynthetic(c) && (c.outcome === 'fail' || c.outcome === 'error') && base.get(c.id) === 'pass');
}
```
Leave `buildProofs` as it is (it keeps its own `beforeById`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/proof.test.ts`
Expected: PASS (new and existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/proof.ts test/proof.test.ts
git commit -m "feat: resolve case files and find tests that regressed from base

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The base run covers tests failing at head; emit `test-regressed`

**Files:**
- Modify: `src/proof.ts:227-278` (`proveTests` after the head run)
- Test: `test/proof.test.ts`

**Interfaces:**
- Consumes: `resolveCaseFile`, `regressedCases` (Task 2); `CORE_FINDINGS['test-regressed']` (Task 1).
- Produces: `proveTests` findings may include `{ id: 'test-regressed', severity: 'fail', title: 'Test passes at base and fails at head', file: <repo-relative path>, detail: <case name> }`, placed after `base-run-failed` and before `proofs-unmatched`. `ProofOutput.before` is set whenever a base run happened.

- [ ] **Step 1: Write the failing tests**

Add near `stubRunner` in `test/proof.test.ts`:
```ts
/** A runner that records its calls: the first call is the head run, every later one the base run. */
function recordingRunner(head: RunResult, base: RunResult) {
  const calls: RunOptions[] = [];
  const runner: Runner = { name: 'vitest', detect: async () => 0, run: async (opts) => { calls.push(opts); return calls.length === 1 ? head : base; } };
  return { runner, calls };
}

async function repoWithExistingTests(root = '.') {
  const p = root === '.' ? '' : `${root}/`;
  const { dir, base } = await makeRepo({
    [`${p}src/a.js`]: 'export const a = 1;\n',
    [`${p}test/old.test.js`]: "it('old', () => {});\n",
    [`${p}test/flaky.test.js`]: "it('flaky', () => {});\n",
    [`${p}tests/test_mod.py`]: 'def test_m(): pass\n',
  });
  await writeFiles(dir, { [`${p}src/a.js`]: 'export const a = 2;\n' });
  const head = await commitAll(dir, 'source only');
  return { dir, base, head, changes: parseChanges(await diffText(dir, base, head)) };
}

const regressed = (file: string, name: string) => ({ id: 'test-regressed', severity: 'fail', title: 'Test passes at base and fails at head', file, detail: name });
const suiteRed = { id: 'suite-failing', severity: 'fail', title: 'Test suite fails at head (clean checkout)', detail: 'exit code 1' };
const pyCase = (outcome: TestCaseResult['outcome']): TestCaseResult => ({ id: 'tests.test_mod::test_m', file: 'tests.test_mod', name: 'test_m', outcome });
```

Then:
```ts
describe('proveTests regressions', () => {
  it('reruns the files of tests failing at head at base and reports those that passed there', async () => {
    const { dir, base, head, changes } = await repoWithExistingTests();
    const synthetic: TestCaseResult = { id: '[x]::[y]', file: '[x]', name: '[build]', outcome: 'error' };
    const { runner, calls } = recordingRunner(
      run([tc('test/old.test.js', 'old', 'fail'), tc('test/flaky.test.js', 'flaky', 'fail'), pyCase('error'),
        tc('test/gone.test.js', 'gone', 'fail'), synthetic, tc('test/old.test.js', 'ok', 'pass')], 1),
      run([tc('test/old.test.js', 'old', 'pass'), tc('test/flaky.test.js', 'flaky', 'fail'), pyCase('pass')], 1),
    );
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(calls.map((c) => c.files)).toEqual([undefined, ['test/old.test.js', 'test/flaky.test.js', 'tests/test_mod.py']]);
    expect(result.findings).toEqual([suiteRed, regressed('test/old.test.js', 'old'), regressed('tests/test_mod.py', 'test_m')]);
    expect(result.proofs).toEqual([]);
    expect(result.before?.cases).toHaveLength(3);
  });

  it('does not run base when nothing fails and no tests changed', async () => {
    const { dir, base, head, changes } = await repoWithExistingTests();
    const { runner, calls } = recordingRunner(run([tc('test/old.test.js', 'old', 'pass')]), run([]));
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(calls).toHaveLength(1);
    expect(result.findings).toEqual([]);
  });

  it('reports no base-run-failed when only failing unchanged tests ran at base and reported nothing', async () => {
    const { dir, base, head, changes } = await repoWithExistingTests();
    const { runner } = recordingRunner(run([tc('test/old.test.js', 'old', 'fail')], 1), run([], 1, 'boom'));
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(result.findings).toEqual([suiteRed]);
  });

  it('runs changed tests and failing unchanged tests in one base run', async () => {
    const { dir, base } = await makeRepo({ 'src/a.js': 'export const a = 1;\n', 'test/old.test.js': "it('old', () => {});\n" });
    await writeFiles(dir, { 'src/a.js': 'export const a = 2;\n', 'test/a.test.js': "it('a', () => {});\n" });
    const head = await commitAll(dir, 'change');
    const changes = parseChanges(await diffText(dir, base, head));
    const { runner, calls } = recordingRunner(
      run([tc('test/a.test.js', 'a', 'pass'), tc('test/old.test.js', 'old', 'fail')], 1),
      run([tc('test/a.test.js', 'a', 'fail'), tc('test/old.test.js', 'old', 'pass')], 1),
    );
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(calls[1]?.files).toEqual(['test/a.test.js', 'test/old.test.js']);
    expect(result.proofs.map((p) => [p.file, p.verdict])).toEqual([['test/a.test.js', 'proves-change']]);
    expect(result.findings).toEqual([suiteRed, regressed('test/old.test.js', 'old')]);
  });

  it('reports the repo path of a regressed test in a package root', async () => {
    const { dir, base, head, changes } = await repoWithExistingTests('pkg');
    const { runner, calls } = recordingRunner(run([tc('test/old.test.js', 'old', 'fail')], 1), run([tc('test/old.test.js', 'old', 'pass')]));
    const result = await proveTests({ repo: dir, base, head, changes, runner, root: 'pkg' });
    expect(calls[1]?.files).toEqual(['test/old.test.js']);
    expect(result.findings).toEqual([suiteRed, regressed('pkg/test/old.test.js', 'old')]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/proof.test.ts -t "proveTests regressions"`
Expected: FAIL. With no changed tests the base run never happens (`calls` has length 1), and there are no `test-regressed` findings.

- [ ] **Step 3: Implement in `proveTests`**

Replace the code from `if (!testFiles.length) return { runner, scope, after, proofs: [], findings };` (line 234) through the `base-run-failed` block (line 249) with:
```ts
    // Files of tests failing at head also run at base, so a failure can be told apart from one that was already there.
    const failingFiles = after.cases
      .filter((c) => (c.outcome === 'fail' || c.outcome === 'error') && !isSynthetic(c))
      .map((c) => resolveCaseFile(c.file, headRoot))
      .filter((f): f is string => f !== undefined);
    const baseFiles = [...new Set([...testFiles, ...failingFiles])];
    if (!baseFiles.length) return { runner, scope, after, proofs: [], findings };

    baseDir = await addWorktree(repo, base);
    await linkDeps(repo, baseDir, root);
    const toCopy = new Set([...changes.filter(copiedToBase).map((c) => c.path), ...(await goTestHelpers(changes, headDir))]);
    for (const path of toCopy) await copyFromHead(repo, head, baseDir, path);
    const before = await runWithSetup(runner, { ...runOptions, cwd: join(baseDir, root), worktree: baseDir, files: baseFiles }, setup);
    if (testFiles.length && before.exitCode !== 0 && before.cases.length === 0) {
      const detail = timeoutDetail(before, runOptions.timeoutMs);
      findings.push({
        id: 'base-run-failed',
        severity: 'warn',
        title: `Changed tests could not run at base; fail-before evidence unavailable (exit ${before.exitCode})`,
        ...(detail ? { detail } : {}),
      });
    }
    for (const c of regressedCases(before, after)) {
      findings.push({
        id: 'test-regressed',
        severity: 'fail',
        title: 'Test passes at base and fails at head',
        file: `${prefix}${resolveCaseFile(c.file, headRoot) ?? c.file}`,
        detail: c.name,
      });
    }
    if (!testFiles.length) return { runner, scope, after, before, proofs: [], findings };
```
Keep everything after it (the `headCache`/`readHead`, `proofs-unmatched` and the final `return`) unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/proof.test.ts test/proof-cleanup.test.ts`
Expected: PASS, including the existing `proveTests evidence findings` tests, whose findings must be unchanged.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. If a hook or e2e test now sees an extra base run, check it is the intended "failing at head" rerun before changing any expectation.

- [ ] **Step 6: Commit**

```bash
git add src/proof.ts test/proof.test.ts
git commit -m "feat: rerun tests failing at head at base and report test-regressed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: End-to-end fixture scenario

**Files:**
- Test: `test/e2e.test.ts` (new `it` in `describe('trustbut verify (end to end)')`, after `FAIL: suite is red at head`)

**Interfaces:**
- Consumes: Tasks 1-3. `runVerify` from `test/helpers/verify.ts` already checks every receipt validates as v1 with no warnings, which now covers 1.1.

- [ ] **Step 1: Write the test**

```ts
  it('FAIL: reports the test the change broke, not the one that was already red', async () => {
    const { dir } = await makeRepo({
      '.gitignore': 'node_modules\n',
      'package.json': JSON.stringify({ name: 'fx', private: true, type: 'module', devDependencies: { vitest: '*' } }),
      'src/sum.js': 'export const sum = (a, b) => a + b;\n',
      'test/sum.test.js': sumTest("it('adds', () => expect(sum(2, 3)).toBe(5));"),
      'test/broken.test.js': "import { it, expect } from 'vitest';\nit('already red', () => expect(1).toBe(2));\n",
    });
    await linkNodeModules(dir);
    await branch(dir, 'agent-change');
    await writeFiles(dir, { 'src/sum.js': 'export const sum = (a, b) => a - b;\n' });
    await commitAll(dir, 'agent change');
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('fail');
    const ids = receipt.findings.map((f) => f.id);
    expect(ids).toContain('suite-failing');
    expect(ids).not.toContain('test-failing');
    expect(receipt.findings.filter((f) => f.id === 'test-regressed').map((f) => [f.file, f.detail])).toEqual([['test/sum.test.js', 'adds']]);
  });
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/e2e.test.ts -t "already red"`
Expected: PASS (Tasks 1-3 implement it). If it fails, debug the implementation; don't weaken the test. The test was written after the code because it is the fixture scenario AGENTS.md requires. Its failing-first coverage is the unit tests from Task 3.

- [ ] **Step 3: Commit**

```bash
git add test/e2e.test.ts
git commit -m "test: e2e scenario for test-regressed next to an already-red test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Show regressions in Markdown, agent feedback and the hook summary

**Files:**
- Modify: `src/render.ts` (`renderMarkdown`, `renderForAgent`), `src/hook/feedback.ts` (`failParts`)
- Test: `test/receipt.test.ts`, `test/hook-feedback.test.ts`

**Interfaces:**
- Consumes: `regressedCases(before, after)` from `src/proof.ts` (Task 2).
- Produces: `regressedIds(r: Receipt): Set<string>` exported from `src/render.ts`.

- [ ] **Step 1: Write the failing tests**

In `test/hook-feedback.test.ts` add (it already has `tc`, `run` and `receipt`; `buildReceipt` takes `before`):
```ts
describe('regressed tests', () => {
  const regressedReceipt = () =>
    buildReceipt({
      base: 'a'.repeat(40), head: 'b'.repeat(40), runner: 'vitest', scope: 'full', proofs: [], changes: [],
      after: run([tc('lib > works', 'fail'), tc('lib > old', 'fail'), tc('ok', 'pass')]),
      before: run([tc('lib > works', 'pass'), tc('lib > old', 'fail')]),
      findings: [
        { id: 'suite-failing', severity: 'fail', title: 'Test suite fails at head (clean checkout)', detail: 'exit code 1' },
        { id: 'test-regressed', severity: 'fail', title: 'Test passes at base and fails at head', file: 'test/lib.test.js', detail: 'lib > works' },
      ],
    });

  it('marks the failing tests that passed at base and does not repeat them under Must fix', () => {
    const out = renderForAgent(regressedReceipt(), undefined);
    expect(out).toContain('- `test/lib.test.js` › lib > works (passed at base)');
    expect(out).toContain('- `test/lib.test.js` › lib > old\n');
    expect(out).not.toContain('Test passes at base and fails at head');
  });

  it('says how many failing tests passed at base in the one-line summary', () => {
    expect(summarize(regressedReceipt())).toBe('2 failing tests, 1 passed at base');
  });
});
```

In `test/receipt.test.ts`, inside `describe('renderMarkdown')`, add (import `buildReceipt` and `renderMarkdown` if the file doesn't already):
```ts
  it('marks failing tests that passed at base and lists them once', () => {
    const c = (name: string, outcome: 'pass' | 'fail') => ({ id: `t.test.js::${name}`, file: 't.test.js', name, outcome });
    const r = buildReceipt({
      base: 'a'.repeat(40), head: 'b'.repeat(40), runner: 'vitest', proofs: [], changes: [],
      after: { exitCode: 1, durationMs: 1, output: '', cases: [c('x', 'fail'), c('y', 'fail')] },
      before: { exitCode: 0, durationMs: 1, output: '', cases: [c('x', 'pass')] },
      findings: [
        { id: 'suite-failing', severity: 'fail', title: 'Test suite fails at head (clean checkout)', detail: 'exit code 1' },
        { id: 'test-regressed', severity: 'fail', title: 'Test passes at base and fails at head', file: 't.test.js', detail: 'x' },
      ],
    });
    const md = renderMarkdown(r);
    expect(md).toContain('- `t.test.js` › x (passed at base)');
    expect(md).toContain('- `t.test.js` › y\n');
    expect(md).not.toContain('Test passes at base and fails at head');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/hook-feedback.test.ts test/receipt.test.ts`
Expected: FAIL: no "(passed at base)" marker, the regressed finding appears under Findings / Must fix, and the summary lacks "1 passed at base".

- [ ] **Step 3: Implement**

`src/render.ts`: add `import { regressedCases } from './proof.js';` (check for an import cycle: `proof.ts` must not import `render.ts`; it doesn't today). Below `failingCases` add:
```ts
/** Ids of failing head results that passed at base. */
export function regressedIds(r: Receipt): Set<string> {
  return r.before && r.after ? new Set(regressedCases(r.before, r.after).map((c) => c.id)) : new Set();
}

const atBase = (ids: Set<string>, c: TestCaseResult): string => (ids.has(c.id) ? ' (passed at base)' : '');
```
In `renderMarkdown`:
- Replace `for (const f of r.findings) lines.push(findingLine(f));` with:
```ts
  const failing = failingCases(r);
  // A regressed test is marked in the failing tests below; list it once.
  const listed = r.findings.filter((f) => !(failing.length && f.id === 'test-regressed'));
  if (!listed.length) lines.push('None.');
  for (const f of listed) lines.push(findingLine(f));
```
  and remove the old `if (!r.findings.length) lines.push('None.');` line and the later `const failing = failingCases(r);` line.
- In the failing-tests loop, use `const regressed = regressedIds(r);` before the loop and change the line to:
```ts
    for (const c of failing.slice(0, MAX_FAILING)) lines.push(`- ${c.file ? `${code(c.file)} › ` : ''}${text(c.name)}${atBase(regressed, c)}`);
```
In `renderForAgent`:
- Change the `fails` filter to:
```ts
  const fails = r.findings.filter((f) => f.severity === 'fail' && !(failing.length && (f.id === 'test-failing' || f.id === 'test-regressed')));
```
  and update the comment above it: "A changed or regressed test that fails at head is also in the failing tests below; list it once."
- In the failing-tests loop add `const regressed = regressedIds(r);` before it and put `${atBase(regressed, c)}` right after `${oneLine(c.name)}`, before the message part.

`src/hook/feedback.ts`, in `failParts`:
```ts
  if (failing) parts.push(count(failing, 'failing test'));
  else if (suite) parts.push(lowerFirst(suite.title));
  const regressed = fails.filter((f) => f.id === 'test-regressed').length;
  if (failing && regressed) parts.push(`${regressed} passed at base`);
```
and change `known` to `new Set(['suite-failing', 'test-failing', 'test-regressed', 'test-focused'])`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/hook-feedback.test.ts test/receipt.test.ts && npm test`
Expected: PASS. The existing `renderForAgent` exact-output test is unchanged because its receipt has no `before`.

- [ ] **Step 5: Commit**

```bash
git add src/render.ts src/hook/feedback.ts test/hook-feedback.test.ts test/receipt.test.ts
git commit -m "feat: mark failing tests that passed at base in receipts and hook feedback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Opt-in output tail in JSON receipts (`--output-tail`)

**Files:**
- Modify: `src/render.ts:108-114` (`outputTail` limits), `src/spec/types.ts` (`TrustbutRun`), `src/spec/serialize.ts`, `src/commands/verify.ts:16-35,141`, `src/program.ts:43`
- Test: `test/serialize.test.ts`, `test/e2e.test.ts`

**Interfaces:**
- Produces:
  - `outputTail(output: string, maxLines = 20, maxChars = 1500): string`
  - `toAgentReceipt(receipt: Receipt, opts?: { outputTail?: boolean }): AgentReceiptV1`
  - `TrustbutRun.outputTail?: string`
  - `VerifyOptions.outputTail?: boolean`, CLI `--output-tail`

- [ ] **Step 1: Write the failing tests**

In `test/serialize.test.ts`, add:
```ts
describe('toAgentReceipt with outputTail', () => {
  it('adds the end of a failed run only, without colour codes', () => {
    const r = toAgentReceipt(receipt(), { outputTail: true });
    expect(r['x-trustbut']?.after?.outputTail).toBe('SECRET=hunter2 and a very long log');
    expect(r['x-trustbut']?.before).not.toHaveProperty('outputTail');
    const colored = toAgentReceipt(receipt({ after: { exitCode: 1, durationMs: 1, cases: [], output: '\u001b[31mred\u001b[39m\n' } }), { outputTail: true });
    expect(colored['x-trustbut']?.after?.outputTail).toBe('red');
    expect(validateAgentReceipt(JSON.parse(JSON.stringify(r)))).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('keeps the last 50 lines and at most 4,000 characters', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
    const tail = toAgentReceipt(receipt({ after: { exitCode: 1, durationMs: 1, cases: [], output: lines } }), { outputTail: true })['x-trustbut']?.after?.outputTail;
    expect(tail?.split('\n')).toEqual(Array.from({ length: 50 }, (_, i) => `line ${i + 11}`));
    const long = `${'a'.repeat(3000)}${'b'.repeat(3000)}`;
    const cut = toAgentReceipt(receipt({ after: { exitCode: 1, durationMs: 1, cases: [], output: long } }), { outputTail: true })['x-trustbut']?.after?.outputTail;
    expect(cut).toHaveLength(4000);
    expect(cut?.endsWith('b'.repeat(3000))).toBe(true);
  });

  it('writes no output without the option', () => {
    expect(JSON.stringify(toAgentReceipt(receipt()))).not.toContain('outputTail');
  });
});
```

In `test/e2e.test.ts`, after the `prints JSON with --json` test:
```ts
  it('--output-tail puts the end of a failed head run in the JSON receipt', async () => {
    const dir = await scenario({ 'test/old.test.js': "import { it, expect } from 'vitest';\nit('truth', () => expect(1).toBe(2));\n" });
    const { output } = await runVerify({ cwd: dir, json: true, outputTail: true });
    const json = JSON.parse(output);
    expect(json['x-trustbut'].after.outputTail).toContain('truth');
    const plain = JSON.parse((await runVerify({ cwd: dir, json: true })).output);
    expect(plain['x-trustbut'].after).not.toHaveProperty('outputTail');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/serialize.test.ts && npx vitest run test/e2e.test.ts -t "output-tail"`
Expected: FAIL. There's no `outputTail` in `x-trustbut`, and `outputTail` isn't a `VerifyOptions` key (typecheck error or ignored).

- [ ] **Step 3: Implement**

`src/render.ts`:
```ts
/** The last lines (default at most 20 and 1,500 characters) of a run's output, without colour codes. */
export function outputTail(output: string, maxLines = OUTPUT_LINES, maxChars = OUTPUT_MAX): string {
  const lines = output.replace(ANSI, '').replace(/\s+$/, '').split(/\r?\n/).slice(-maxLines);
  while (lines.length > 1 && lines.join('\n').length > maxChars) lines.shift();
  const text = lines.join('\n');
  return text.length > maxChars ? text.slice(-maxChars) : text;
}
```

`src/spec/types.ts`: update the `TrustbutRun` comment to `/** One test run as trustbut reports it under x-trustbut (raw output only as an opt-in tail). */` and add `outputTail?: string;` after `timedOut?: boolean;`.

`src/spec/serialize.ts`:
```ts
import { outputTail } from '../render.js';
...
/** Receipt tail with `--output-tail`: the last 50 lines, at most 4,000 characters. */
const TAIL_LINES = 50;
const TAIL_MAX = 4000;

export interface AgentReceiptOptions {
  /** Add the end of each failed run's output under x-trustbut (`--output-tail`). */
  outputTail?: boolean;
}

function run(r: RunResult, withTail: boolean): TrustbutRun {
  const tail = withTail && r.exitCode !== 0 ? outputTail(r.output, TAIL_LINES, TAIL_MAX) : '';
  return { exitCode: r.exitCode, durationMs: r.durationMs, ...(r.timedOut ? { timedOut: true } : {}), cases: r.cases, ...(tail ? { outputTail: tail } : {}) };
}
```
Change the signature to `export function toAgentReceipt(receipt: Receipt, opts: AgentReceiptOptions = {}): AgentReceiptV1 {` and the two call sites to `run(receipt.after, opts.outputTail === true)` / `run(receipt.before, opts.outputTail === true)`. Check `render.ts` doesn't import `serialize.ts` (no cycle).

`src/commands/verify.ts`: in `VerifyOptions` add, next to `json`:
```ts
  /** Put the end of each failed run's output in the JSON receipt (`--output-tail`). */
  outputTail?: boolean;
```
and change line 141 to `const json = \`${JSON.stringify(toAgentReceipt(receipt, { outputTail: opts.outputTail }), null, 2)}\n\`;`.

`src/program.ts`, after the `--receipt-json` option:
```ts
    .option('--output-tail', "JSON receipts: include the end of each failed run's output under x-trustbut (off by default: tests can print secrets)")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run test/serialize.test.ts test/e2e.test.ts test/cli.test.ts`
Expected: PASS, including the existing "without the raw runner output" test (no option, so no `hunter2`). If `cli.test.ts` snapshots `verify --help`, update it to show the new option.

- [ ] **Step 5: Commit**

```bash
git add src/render.ts src/spec src/commands/verify.ts src/program.ts test/serialize.test.ts test/e2e.test.ts test/cli.test.ts
git commit -m "feat: --output-tail adds the end of failed runs to JSON receipts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Docs, version 0.5.0 and the spec's as-built record

**Files:**
- Modify: `docs/SPEC.md` (finding table around line 188, base-run description, Output/Validate bullets, CLI options), `CHANGELOG.md`, `package.json`, `package-lock.json`, `integrations/claude-code/.claude-plugin/plugin.json` (via the bump script), `README.md` (only if it lists findings or verify flags; check with `grep -n "test-failing\|--receipt-json" README.md`), `docs/superpowers/specs/2026-10-16-test-regressed-design.md`

- [ ] **Step 1: Update `docs/SPEC.md`**

- Finding table: add after the `test-failing` row:
  `| \`test-regressed\` | A test that fails or errors at head passes at base. The base run gets the changed test files plus the files of tests failing at head (pytest module names map to their \`.py\` file); one finding per test, with the repo path and the test name. |`
- Where `docs/SPEC.md` describes the base run ("Base gets the changed tests…" / §4), add one sentence: "The base run also gets the files of tests that fail at head, so `test-regressed` can tell a test the change broke from one that already failed; it runs even when no tests changed if something fails at head."
- Output bullet: add "`--output-tail` adds `outputTail` (the last 50 lines, at most 4,000 characters) to each failed run under `x-trustbut` in JSON receipts; off by default, since tests can print secrets."
- Validate bullet: replace "newer than `1.0`" with "newer than `1.1`" and add "a core id newer than the receipt's declared minor (`test-regressed` in a `1.0` receipt) is an error."
- Any "spec v1.0" / `specVersion: "1.0"` mention for what trustbut emits → `1.1`.

- [ ] **Step 2: CHANGELOG and version bump**

Run: `npm run release:bump 0.5.0`
Then add at the top of `CHANGELOG.md` (under `# Changelog`):
```markdown
## 0.5.0

**Regressed tests.** A red suite no longer looks the same whether the change broke a test or the test was already failing.

- New finding `test-regressed` (fail): a test that passes at base and fails at head. The base run now also gets the files of tests failing at head (pytest module names map to their `.py` file), and runs even when no tests changed if something fails at head. Markdown and agent feedback mark these tests "(passed at base)", and the hook summary counts them.
- Receipt spec **1.1**: adds the core id `test-regressed`. trustbut writes `specVersion: "1.1"`. `trustbut validate` accepts 1.1, treats only minors newer than 1.1 leniently, and rejects `test-regressed` in a receipt that declares `1.0`.
- New: `verify --output-tail` adds the end of each failed run's output (last 50 lines, at most 4,000 characters) under `x-trustbut` in JSON receipts. Off by default; receipts stay output-free without it.
```
Run: `npm run build && node scripts/release/check-versions.mjs v0.5.0`
Expected: versions consistent.

- [ ] **Step 3: Mark the spec implemented**

In `docs/superpowers/specs/2026-10-16-test-regressed-design.md` set `**Status:** Implemented (YYYY-MM-DD)` (the date of this step) and add at the end:
```markdown
## As built

- <every place the code differs from this spec, or "none">
```
Fill in the list by comparing the spec to the code. Known candidates to check: the validator's "since" rule and the newer-minor messages, the `--output-tail` flag, and Markdown leaving `test-regressed` out of Findings when the failing list is shown.

- [ ] **Step 4: Verify everything**

Run: `npm run typecheck && npm test && npm run receipt`
Expected: all PASS. The receipt verdict must not be FAIL because of this change. Keep the receipt output for the PR description.

- [ ] **Step 5: Commit**

```bash
git add docs CHANGELOG.md README.md package.json package-lock.json integrations/claude-code/.claude-plugin/plugin.json
git commit -m "docs: document test-regressed, spec 1.1 and --output-tail; release 0.5.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Publishing (a GitHub Release `v0.5.0`, which triggers `.github/workflows/release.yml` and npm trusted publishing) is not part of this plan. It needs the merged PR and the user's go-ahead.
