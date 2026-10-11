# M1 Core Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npx trustbut verify` compares base and head, reruns tests in clean worktrees, proves which new tests fail before and pass after, flags test tampering and type escapes, ranks risky files, and prints a PASS/WARN/FAIL receipt. Everything works with git alone, so it applies to any coding agent's output.

**Architecture:** A pipeline of small pure modules (diff parser → static checks → risk → receipt/render) plus two side-effecting modules (the git layer and test-runner adapters) coordinated by a proof engine. All test runs happen in throwaway `git worktree`s with dependencies symlinked from the main checkout. Runners report through JUnit XML.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥ 22, commander, execa, parse-diff, fast-xml-parser, Vitest, tsup.

## Global Constraints

- Node ≥ 22, `"type": "module"`, imports use `.js` extensions.
- Package name `trustbut`, binary `trustbut`, license Apache-2.0.
- No LLM calls anywhere in M1.
- Never modify the user's working tree; every worktree is removed in a `finally`.
- Must work with git 2.17+ (no `git init -b`).
- Findings state facts, never intent ("passes without the change", not "cheated").
- Exit codes: 0 = PASS or WARN, 1 = FAIL (or WARN with `--strict`), 2 = usage/runtime error.

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore
src/
  cli.ts              entry (shebang), runs program
  program.ts          commander program definition
  version.ts          VERSION constant
  types.ts            shared types (Finding, ChangedFile, RunResult, Receipt…)
  git.ts              git wrappers: refs, diff, show, worktrees, dirty check
  classify.ts         path → FileKind
  diff.ts             unified diff → ChangedFile[]
  checks/
    test-integrity.ts skips, focus, removed tests/assertions, snapshots, test config
    escapes.ts        type/lint/coverage escapes in source
  runners/
    types.ts          Runner interface
    env.ts            clean child env
    junit.ts          JUnit XML → TestCaseResult[]
    vitest.ts         Vitest adapter
    pytest.ts         pytest adapter
    detect.ts         detectRunner / getRunner
  proof.ts            worktrees + fail-before/pass-after
  risk.ts             risk ranking
  receipt.ts          derived findings, verdict, buildReceipt
  render.ts           Markdown renderer
  commands/verify.ts   runVerify orchestration
test/
  helpers/repo.ts     fixture git repos
  *.test.ts
.github/workflows/ci.yml
README.md
```

---

### Task 1: Scaffold, shared types, CLI skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/version.ts`, `src/types.ts`, `src/program.ts`, `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Produces: `buildProgram(): Command` from `src/program.ts`; `VERSION` from `src/version.ts`; all types in `src/types.ts` (used by every later task).

- [ ] **Step 1: Create package.json and install dependencies**

```json
{
  "name": "trustbut",
  "version": "0.0.1",
  "description": "Verifiable receipts for code written by AI coding agents",
  "type": "module",
  "bin": { "trustbut": "dist/cli.js" },
  "files": ["dist"],
  "engines": { "node": ">=22" },
  "license": "Apache-2.0",
  "scripts": {
    "build": "tsup src/cli.ts --format esm --target node22 --clean",
    "dev": "tsx src/cli.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

Run:
```bash
npm install commander execa parse-diff fast-xml-parser
npm install -D typescript tsup tsx vitest @types/node
```

- [ ] **Step 2: Create config files**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
```

`.gitignore`:
```
node_modules
dist
```

- [ ] **Step 3: Write the failing test** — `test/cli.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/program.js';

describe('cli', () => {
  it('reports its version', () => {
    let out = '';
    const program = buildProgram()
      .exitOverride()
      .configureOutput({ writeOut: (s) => { out += s; } });
    expect(() => program.parse(['node', 'trustbut', '--version'])).toThrow();
    expect(out.trim()).toBe('0.0.1');
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL, cannot resolve `../src/program.js`.

- [ ] **Step 5: Implement**

`src/version.ts`:
```ts
export const VERSION = '0.0.1';
```

`src/types.ts`:
```ts
export type Severity = 'info' | 'warn' | 'fail';

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  file?: string;
  line?: number;
  detail?: string;
}

export type FileKind = 'test' | 'test-config' | 'snapshot' | 'source' | 'other';
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface AddedLine {
  line: number;
  text: string;
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  kind: FileKind;
  added: AddedLine[];
  removed: string[];
}

export type TestOutcome = 'pass' | 'fail' | 'error' | 'skip';

export interface TestCaseResult {
  id: string;
  file: string;
  name: string;
  outcome: TestOutcome;
}

export interface RunResult {
  exitCode: number;
  cases: TestCaseResult[];
  durationMs: number;
  output: string;
}

export type ProofVerdict = 'proves-change' | 'does-not-constrain' | 'failing' | 'skipped';

export interface TestProof {
  id: string;
  file: string;
  name: string;
  before: TestOutcome | 'missing';
  after: TestOutcome;
  verdict: ProofVerdict;
  weak: boolean;
}

export interface RiskItem {
  file: string;
  score: number;
  reasons: string[];
}

export type Verdict = 'pass' | 'warn' | 'fail';

export interface Receipt {
  version: 1;
  base: string;
  head: string;
  runner: string | null;
  verdict: Verdict;
  after?: RunResult;
  before?: RunResult;
  proofs: TestProof[];
  findings: Finding[];
  risks: RiskItem[];
}
```

`src/program.ts`:
```ts
import { Command } from 'commander';
import { VERSION } from './version.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('trustbut')
    .description('Verifiable receipts for code written by AI coding agents')
    .version(VERSION);
  return program;
}
```

`src/cli.ts`:
```ts
#!/usr/bin/env node
import { buildProgram } from './program.js';

await buildProgram().parseAsync(process.argv);
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/cli.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src test
git commit -m "feat: scaffold trustbut CLI and shared types"
```

---

### Task 2: Git layer and fixture-repo helper

**Files:**
- Create: `src/git.ts`, `test/helpers/repo.ts`
- Test: `test/git.test.ts`

**Interfaces:**
- Produces (`src/git.ts`):
  - `git(cwd: string, args: string[]): Promise<string>`
  - `repoRoot(cwd: string): Promise<string>`
  - `resolveRef(cwd: string, ref: string): Promise<string | null>` (full SHA or null)
  - `mergeBase(cwd: string, a: string, b: string): Promise<string>`
  - `diffText(cwd: string, base: string, head: string): Promise<string>`
  - `showFile(cwd: string, ref: string, path: string): Promise<string>` (keeps trailing newline)
  - `addWorktree(cwd: string, ref: string): Promise<string>` (returns temp dir)
  - `removeWorktree(cwd: string, dir: string): Promise<void>`
  - `isDirty(cwd: string): Promise<boolean>`
- Produces (`test/helpers/repo.ts`):
  - `makeRepo(files: Record<string, string>): Promise<{ dir: string; base: string }>` (on branch `main`)
  - `writeFiles(dir: string, files: Record<string, string | null>): Promise<void>` (null deletes)
  - `commitAll(dir: string, message: string): Promise<string>` (returns SHA)
  - `branch(dir: string, name: string): Promise<void>`
  - `linkNodeModules(dir: string): Promise<void>` (symlinks this project's node_modules)

- [ ] **Step 1: Write the fixture helper** — `test/helpers/repo.ts`

```ts
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const PROJECT_NODE_MODULES = fileURLToPath(new URL('../../node_modules', import.meta.url));

export async function writeFiles(dir: string, files: Record<string, string | null>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    if (content === null) {
      await rm(full, { force: true });
      continue;
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

export async function commitAll(dir: string, message: string): Promise<string> {
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', ['commit', '-q', '-m', message], { cwd: dir });
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

export async function branch(dir: string, name: string): Promise<void> {
  await execa('git', ['checkout', '-q', '-b', name], { cwd: dir });
}

export async function makeRepo(files: Record<string, string>): Promise<{ dir: string; base: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'trustbut-fixture-'));
  await execa('git', ['init', '-q'], { cwd: dir });
  await execa('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await writeFiles(dir, files);
  const base = await commitAll(dir, 'base');
  return { dir, base };
}

export async function linkNodeModules(dir: string): Promise<void> {
  await symlink(PROJECT_NODE_MODULES, join(dir, 'node_modules'), 'dir');
}
```

- [ ] **Step 2: Write the failing test** — `test/git.test.ts`

```ts
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addWorktree, diffText, isDirty, mergeBase, removeWorktree, repoRoot, resolveRef, showFile,
} from '../src/git.js';
import { branch, commitAll, makeRepo, writeFiles } from './helpers/repo.js';

describe('git', () => {
  it('resolves refs and merge bases', async () => {
    const { dir, base } = await makeRepo({ 'a.txt': 'one\n' });
    await branch(dir, 'feature');
    await writeFiles(dir, { 'a.txt': 'two\n' });
    const head = await commitAll(dir, 'change');
    expect(await resolveRef(dir, 'main')).toBe(base);
    expect(await resolveRef(dir, 'HEAD')).toBe(head);
    expect(await resolveRef(dir, 'does-not-exist')).toBeNull();
    expect(await mergeBase(dir, 'main', 'HEAD')).toBe(base);
    expect(await repoRoot(join(dir))).toContain('trustbut-fixture-');
  });

  it('diffs commits, shows files, and round-trips a worktree', async () => {
    const { dir, base } = await makeRepo({ 'a.txt': 'one\n' });
    await writeFiles(dir, { 'a.txt': 'two\n' });
    const head = await commitAll(dir, 'change');

    const diff = await diffText(dir, base, head);
    expect(diff).toContain('-one');
    expect(diff).toContain('+two');
    expect(await showFile(dir, base, 'a.txt')).toBe('one\n');

    const wt = await addWorktree(dir, base);
    expect(await readFile(join(wt, 'a.txt'), 'utf8')).toBe('one\n');
    await removeWorktree(dir, wt);
    expect(existsSync(wt)).toBe(false);
  });

  it('detects a dirty working tree', async () => {
    const { dir } = await makeRepo({ 'a.txt': 'one\n' });
    expect(await isDirty(dir)).toBe(false);
    await writeFiles(dir, { 'a.txt': 'changed\n' });
    expect(await isDirty(dir)).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/git.test.ts`
Expected: FAIL, cannot resolve `../src/git.js`.

- [ ] **Step 4: Implement** — `src/git.ts`

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd });
  return stdout;
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

export async function resolveRef(cwd: string, ref: string): Promise<string | null> {
  const r = await execa('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, reject: false });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string> {
  return (await git(cwd, ['merge-base', a, b])).trim();
}

export async function diffText(cwd: string, base: string, head: string): Promise<string> {
  return git(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', base, head]);
}

export async function showFile(cwd: string, ref: string, path: string): Promise<string> {
  const { stdout } = await execa('git', ['show', `${ref}:${path}`], { cwd, stripFinalNewline: false });
  return stdout;
}

export async function addWorktree(cwd: string, ref: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'trustbut-wt-'));
  await git(cwd, ['worktree', 'add', '--detach', dir, ref]);
  return dir;
}

export async function removeWorktree(cwd: string, dir: string): Promise<void> {
  await execa('git', ['worktree', 'remove', '--force', dir], { cwd, reject: false });
  await rm(dir, { recursive: true, force: true });
  await execa('git', ['worktree', 'prune'], { cwd, reject: false });
}

export async function isDirty(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain', '--untracked-files=no'])).trim().length > 0;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/git.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/git.ts test/helpers/repo.ts test/git.test.ts
git commit -m "feat: git layer with worktrees and fixture repo helper"
```

---

### Task 3: Diff parsing and file classification

**Files:**
- Create: `src/classify.ts`, `src/diff.ts`
- Test: `test/diff.test.ts`

**Interfaces:**
- Consumes: `FileKind`, `ChangedFile` from `src/types.ts`.
- Produces: `classify(path: string): FileKind`; `parseChanges(diff: string): ChangedFile[]`.

- [ ] **Step 1: Write the failing test** — `test/diff.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { classify } from '../src/classify.js';
import { parseChanges } from '../src/diff.js';

describe('classify', () => {
  it.each([
    ['src/sum.ts', 'source'],
    ['app/models/user.py', 'source'],
    ['test/sum.test.ts', 'test'],
    ['src/sum.spec.tsx', 'test'],
    ['src/__tests__/a.js', 'test'],
    ['tests/test_api.py', 'test'],
    ['pkg/api_test.py', 'test'],
    ['conftest.py', 'test'],
    ['src/__snapshots__/a.test.ts.snap', 'snapshot'],
    ['vitest.config.ts', 'test-config'],
    ['jest.config.js', 'test-config'],
    ['pytest.ini', 'test-config'],
    ['.coveragerc', 'test-config'],
    ['tests/fixtures/data.json', 'other'],
    ['README.md', 'other'],
  ])('%s → %s', (path, kind) => {
    expect(classify(path)).toBe(kind);
  });
});

describe('parseChanges', () => {
  it('parses modified and added files with line numbers', () => {
    const diff = [
      'diff --git a/src/sum.ts b/src/sum.ts',
      'index 1111111..2222222 100644',
      '--- a/src/sum.ts',
      '+++ b/src/sum.ts',
      '@@ -1,3 +1,3 @@',
      ' export function sum(a: number, b: number) {',
      '-  return a - b;',
      '+  return a + b;',
      ' }',
      'diff --git a/test/sum.test.ts b/test/sum.test.ts',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/test/sum.test.ts',
      '@@ -0,0 +1,2 @@',
      "+import { it } from 'vitest';",
      "+it('adds', () => {});",
      '',
    ].join('\n');

    const files = parseChanges(diff);
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({
      path: 'src/sum.ts',
      oldPath: undefined,
      status: 'modified',
      kind: 'source',
      added: [{ line: 2, text: '  return a + b;' }],
      removed: ['  return a - b;'],
    });
    expect(files[1].status).toBe('added');
    expect(files[1].kind).toBe('test');
    expect(files[1].added.map((a) => a.line)).toEqual([1, 2]);
  });

  it('parses deleted files', () => {
    const diff = [
      'diff --git a/test/old.test.ts b/test/old.test.ts',
      'deleted file mode 100644',
      'index 4444444..0000000',
      '--- a/test/old.test.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      "-it('old', () => {});",
      '',
    ].join('\n');
    const [file] = parseChanges(diff);
    expect(file.path).toBe('test/old.test.ts');
    expect(file.status).toBe('deleted');
    expect(file.removed).toEqual(["it('old', () => {});"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/diff.test.ts`
Expected: FAIL, cannot resolve `../src/classify.js`.

- [ ] **Step 3: Implement**

`src/classify.ts`:
```ts
import type { FileKind } from './types.js';

const SNAPSHOT = /(^|\/)__snapshots__\/|\.snap$/;
const TEST_CONFIG =
  /(^|\/)(vitest\.config|vitest\.workspace|jest\.config)\.[cm]?[jt]s$|(^|\/)(pytest\.ini|tox\.ini|setup\.cfg|\.coveragerc|codecov\.ya?ml|\.nycrc(\.json)?|\.c8rc(\.json)?)$/;
const TEST =
  /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/;
const SOURCE = /\.([cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|swift|scala|vue|svelte)$/;

export function classify(path: string): FileKind {
  if (SNAPSHOT.test(path)) return 'snapshot';
  if (TEST_CONFIG.test(path)) return 'test-config';
  if (SOURCE.test(path)) return TEST.test(path) ? 'test' : 'source';
  return 'other';
}
```

`src/diff.ts`:
```ts
import parseDiff from 'parse-diff';
import { classify } from './classify.js';
import type { AddedLine, ChangedFile, FileStatus } from './types.js';

const NULL = '/dev/null';

export function parseChanges(diff: string): ChangedFile[] {
  return parseDiff(diff).map((f) => {
    const path = (f.to && f.to !== NULL ? f.to : f.from) ?? '';
    const status: FileStatus = f.new
      ? 'added'
      : f.deleted
        ? 'deleted'
        : f.from && f.to && f.from !== f.to
          ? 'renamed'
          : 'modified';
    const added: AddedLine[] = [];
    const removed: string[] = [];
    for (const chunk of f.chunks) {
      for (const change of chunk.changes) {
        if (change.type === 'add') added.push({ line: change.ln, text: change.content.slice(1) });
        else if (change.type === 'del') removed.push(change.content.slice(1));
      }
    }
    return {
      path,
      oldPath: status === 'renamed' ? f.from : undefined,
      status,
      kind: classify(path),
      added,
      removed,
    };
  });
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/diff.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/classify.ts src/diff.ts test/diff.test.ts
git commit -m "feat: parse diffs into classified changed files"
```

---

### Task 4: Static checks (test integrity and escapes)

**Files:**
- Create: `src/checks/test-integrity.ts`, `src/checks/escapes.ts`
- Test: `test/checks.test.ts`

**Interfaces:**
- Consumes: `ChangedFile`, `Finding` from `src/types.ts`.
- Produces: `checkTestIntegrity(files: ChangedFile[]): Finding[]`; `checkEscapes(files: ChangedFile[]): Finding[]`.
- Finding ids produced: `test-focused` (fail), `test-skipped`, `tests-removed`, `assertions-removed`, `snapshot-changed`, `test-config-changed`, `escape-added` (all warn).

- [ ] **Step 1: Write the failing test** — `test/checks.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { checkEscapes } from '../src/checks/escapes.js';
import { checkTestIntegrity } from '../src/checks/test-integrity.js';
import type { ChangedFile } from '../src/types.js';

function file(partial: Partial<ChangedFile> & { path: string }): ChangedFile {
  return { status: 'modified', kind: 'test', added: [], removed: [], ...partial };
}

const ids = (fs: { id: string }[]) => fs.map((f) => f.id);

describe('checkTestIntegrity', () => {
  it('flags newly skipped tests with their line', () => {
    const findings = checkTestIntegrity([
      file({ path: 'test/a.test.ts', added: [{ line: 7, text: "  it.skip('rejects expired', () => {" }] }),
      file({ path: 'tests/test_a.py', added: [{ line: 3, text: '@pytest.mark.skip(reason="flaky")' }] }),
    ]);
    expect(findings).toMatchObject([
      { id: 'test-skipped', severity: 'warn', file: 'test/a.test.ts', line: 7 },
      { id: 'test-skipped', severity: 'warn', file: 'tests/test_a.py', line: 3 },
    ]);
  });

  it('does not flag a skip that was only moved', () => {
    const line = "  it.skip('legacy', () => {";
    expect(checkTestIntegrity([file({ path: 't.test.ts', added: [{ line: 1, text: line }], removed: [line] })])).toEqual([]);
  });

  it('fails on focused tests', () => {
    const findings = checkTestIntegrity([file({ path: 'a.test.ts', added: [{ line: 2, text: "it.only('x', () => {" }] })]);
    expect(findings[0]).toMatchObject({ id: 'test-focused', severity: 'fail' });
  });

  it('flags net removed tests and assertions', () => {
    const findings = checkTestIntegrity([
      file({
        path: 'test/a.test.ts',
        removed: ["it('one', () => {", '  expect(a).toBe(1);', "it('two', () => {", '  expect(b).toBe(2);'],
        added: [{ line: 1, text: "it('one', () => {" }],
      }),
    ]);
    expect(ids(findings)).toEqual(['tests-removed', 'assertions-removed']);
    expect(findings[0].title).toBe('1 test removed');
  });

  it('flags snapshots and test config changes', () => {
    const findings = checkTestIntegrity([
      file({ path: 'src/__snapshots__/a.snap', kind: 'snapshot' }),
      file({ path: 'vitest.config.ts', kind: 'test-config' }),
    ]);
    expect(ids(findings)).toEqual(['snapshot-changed', 'test-config-changed']);
  });
});

describe('checkEscapes', () => {
  it('flags new escapes in source files only', () => {
    const findings = checkEscapes([
      file({
        path: 'src/a.ts',
        kind: 'source',
        added: [
          { line: 4, text: '  const x = y as any;' },
          { line: 9, text: '  // @ts-ignore' },
          { line: 10, text: '  return x;' },
        ],
      }),
      file({ path: 'src/b.py', kind: 'source', added: [{ line: 2, text: 'import foo  # type: ignore' }] }),
      file({ path: 'test/a.test.ts', kind: 'test', added: [{ line: 1, text: 'const m = {} as any;' }] }),
    ]);
    expect(findings.map((f) => [f.file, f.line, f.title])).toEqual([
      ['src/a.ts', 4, 'cast to any'],
      ['src/a.ts', 9, 'TypeScript check suppressed'],
      ['src/b.py', 2, 'type check suppressed'],
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/checks.test.ts`
Expected: FAIL, cannot resolve `../src/checks/escapes.js`.

- [ ] **Step 3: Implement**

`src/checks/test-integrity.ts`:
```ts
import type { ChangedFile, Finding } from '../types.js';

const TEST_DEF = /^\s*(?:(?:it|test)(?:\.\w+)*\s*\(|(?:async\s+)?def\s+test_\w*)/;
const SKIP =
  /\b(?:it|test|describe)\.(?:skip|todo)\b|\bx(?:it|test|describe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.skip\s*\(/;
const FOCUS = /\b(?:it|test|describe)\.only\b|\bf(?:it|describe)\s*\(/;
const ASSERT = /\bexpect\s*\(|\bassert\b|\.should\b/;

const count = (lines: string[], re: RegExp) => lines.filter((l) => re.test(l)).length;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function checkTestIntegrity(files: ChangedFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (f.kind === 'snapshot' && f.status !== 'added') {
      findings.push({ id: 'snapshot-changed', severity: 'warn', title: 'Snapshot rewritten', file: f.path });
    }
    if (f.kind === 'test-config') {
      findings.push({ id: 'test-config-changed', severity: 'warn', title: 'Test or coverage config changed', file: f.path });
    }
    if (f.kind !== 'test') continue;

    const removedSet = new Set(f.removed.map((l) => l.trim()));
    for (const a of f.added) {
      if (removedSet.has(a.text.trim())) continue;
      if (FOCUS.test(a.text)) {
        findings.push({ id: 'test-focused', severity: 'fail', title: 'Test focused (other tests will not run)', file: f.path, line: a.line, detail: a.text.trim() });
      } else if (SKIP.test(a.text)) {
        findings.push({ id: 'test-skipped', severity: 'warn', title: 'Test skipped', file: f.path, line: a.line, detail: a.text.trim() });
      }
    }

    const addedText = f.added.map((a) => a.text);
    const removedTests = count(f.removed, TEST_DEF) - count(addedText, TEST_DEF);
    if (removedTests > 0) {
      findings.push({ id: 'tests-removed', severity: 'warn', title: `${plural(removedTests, 'test')} removed`, file: f.path });
    }
    const removedAsserts = count(f.removed, ASSERT) - count(addedText, ASSERT);
    if (removedAsserts > 0) {
      findings.push({ id: 'assertions-removed', severity: 'warn', title: `${plural(removedAsserts, 'assertion')} removed`, file: f.path });
    }
  }
  return findings;
}
```

`src/checks/escapes.ts`:
```ts
import type { ChangedFile, Finding } from '../types.js';

const ESCAPES: [RegExp, string][] = [
  [/\bas\s+any\b/, 'cast to any'],
  [/:\s*any\b/, 'explicit any'],
  [/@ts-(?:ignore|nocheck|expect-error)/, 'TypeScript check suppressed'],
  [/eslint-disable/, 'lint rule disabled'],
  [/#\s*type:\s*ignore/, 'type check suppressed'],
  [/#\s*noqa/, 'lint rule disabled'],
  [/(?:istanbul|c8|v8)\s+ignore|pragma:\s*no\s*cover/, 'coverage exclusion'],
];

export function checkEscapes(files: ChangedFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (f.kind !== 'source') continue;
    const removedSet = new Set(f.removed.map((l) => l.trim()));
    for (const a of f.added) {
      if (removedSet.has(a.text.trim())) continue;
      const hit = ESCAPES.find(([re]) => re.test(a.text));
      if (hit) {
        findings.push({ id: 'escape-added', severity: 'warn', title: hit[1], file: f.path, line: a.line, detail: a.text.trim() });
      }
    }
  }
  return findings;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/checks.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/checks test/checks.test.ts
git commit -m "feat: static checks for test integrity and type/lint escapes"
```

---

### Task 5: Test runner adapters (JUnit, Vitest, pytest, detection)

**Files:**
- Create: `src/runners/types.ts`, `src/runners/env.ts`, `src/runners/junit.ts`, `src/runners/vitest.ts`, `src/runners/pytest.ts`, `src/runners/detect.ts`
- Modify: `test/helpers/repo.ts` (no change needed; uses `linkNodeModules` from Task 2)
- Test: `test/runners.test.ts`

**Interfaces:**
- Consumes: `RunResult`, `TestCaseResult` from `src/types.ts`; `makeRepo`, `linkNodeModules` from `test/helpers/repo.ts`.
- Produces:
  - `interface RunOptions { cwd: string; files?: string[] }`
  - `interface Runner { name: 'vitest' | 'pytest'; run(opts: RunOptions): Promise<RunResult> }`
  - `parseJUnit(xml: string): TestCaseResult[]`. Each case's `file` is the testsuite name if it looks like a path, else the testcase `file` attribute, else `classname`. `id` is `${file}::${name}`.
  - `vitest: Runner`, `pytest: Runner`
  - `detectRunner(cwd: string): Promise<Runner | null>`; `getRunner(name: 'vitest' | 'pytest'): Runner`

- [ ] **Step 1: Write the failing test** — `test/runners.test.ts`

```ts
import { execaSync } from 'execa';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectRunner } from '../src/runners/detect.js';
import { parseJUnit } from '../src/runners/junit.js';
import { pytest } from '../src/runners/pytest.js';
import { vitest } from '../src/runners/vitest.js';
import { linkNodeModules, makeRepo } from './helpers/repo.js';

const hasPytest = execaSync('python3', ['-m', 'pytest', '--version'], { reject: false }).exitCode === 0;

describe('parseJUnit', () => {
  it('parses vitest-style output', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3">
  <testsuite name="test/sum.test.ts" tests="3">
    <testcase classname="test/sum.test.ts" name="adds" time="0.001"></testcase>
    <testcase classname="test/sum.test.ts" name="math &gt; subtracts" time="0.001">
      <failure message="expected 1 to be 2" type="AssertionError">trace</failure>
    </testcase>
    <testcase classname="test/sum.test.ts" name="later" time="0"><skipped/></testcase>
  </testsuite>
</testsuites>`;
    expect(parseJUnit(xml)).toEqual([
      { id: 'test/sum.test.ts::adds', file: 'test/sum.test.ts', name: 'adds', outcome: 'pass' },
      { id: 'test/sum.test.ts::math > subtracts', file: 'test/sum.test.ts', name: 'math > subtracts', outcome: 'fail' },
      { id: 'test/sum.test.ts::later', file: 'test/sum.test.ts', name: 'later', outcome: 'skip' },
    ]);
  });

  it('parses pytest-style output', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" tests="2">
<testcase classname="tests.test_sum" name="test_adds" time="0.001" />
<testcase classname="tests.test_sum" name="test_err" time="0.001"><error message="boom">x</error></testcase>
</testsuite></testsuites>`;
    expect(parseJUnit(xml).map((c) => [c.id, c.outcome])).toEqual([
      ['tests.test_sum::test_adds', 'pass'],
      ['tests.test_sum::test_err', 'error'],
    ]);
  });
});

describe('detectRunner', () => {
  it('detects vitest, pytest, or nothing', async () => {
    const js = await mkdtemp(join(tmpdir(), 'ar-detect-'));
    await writeFile(join(js, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^3' } }));
    expect((await detectRunner(js))?.name).toBe('vitest');

    const py = await mkdtemp(join(tmpdir(), 'ar-detect-'));
    await writeFile(join(py, 'pyproject.toml'), '[tool.pytest.ini_options]\naddopts = "-q"\n');
    expect((await detectRunner(py))?.name).toBe('pytest');

    const none = await mkdtemp(join(tmpdir(), 'ar-detect-'));
    expect(await detectRunner(none)).toBeNull();
  });
});

describe('vitest runner', () => {
  it('runs selected files and reports per-test outcomes', async () => {
    const { dir } = await makeRepo({
      '.gitignore': 'node_modules\n',
      'package.json': JSON.stringify({ name: 'fx', private: true, type: 'module', devDependencies: { vitest: '*' } }),
      'test/a.test.js': "import { it, expect } from 'vitest';\nit('passes', () => expect(1).toBe(1));\nit('fails', () => expect(1).toBe(2));\n",
      'test/b.test.js': "import { it } from 'vitest';\nit('other', () => {});\n",
    });
    await linkNodeModules(dir);
    const result = await vitest.run({ cwd: dir, files: ['test/a.test.js'] });
    expect(result.exitCode).not.toBe(0);
    expect(result.cases.map((c) => [c.name, c.outcome])).toEqual([
      ['passes', 'pass'],
      ['fails', 'fail'],
    ]);
  });
});

describe.skipIf(!hasPytest)('pytest runner', () => {
  it('runs selected files and reports per-test outcomes', async () => {
    const { dir } = await makeRepo({
      'pytest.ini': '[pytest]\n',
      'tests/test_a.py': 'def test_ok():\n    assert 1 == 1\n\ndef test_bad():\n    assert 1 == 2\n',
    });
    const result = await pytest.run({ cwd: dir, files: ['tests/test_a.py'] });
    expect(result.cases.map((c) => [c.name, c.outcome])).toEqual([
      ['test_ok', 'pass'],
      ['test_bad', 'fail'],
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/runners.test.ts`
Expected: FAIL, cannot resolve `../src/runners/detect.js`.

- [ ] **Step 3: Implement**

`src/runners/types.ts`:
```ts
import type { RunResult } from '../types.js';

export interface RunOptions {
  cwd: string;
  files?: string[];
}

export interface Runner {
  name: 'vitest' | 'pytest';
  run(opts: RunOptions): Promise<RunResult>;
}
```

`src/runners/env.ts`:
```ts
// Strip variables that make a nested test runner think it is a worker of ours.
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('VITEST') || key === 'NODE_ENV' || key === 'TEST') continue;
    env[key] = value;
  }
  env.CI = '1';
  return env;
}

export const tail = (s: string | undefined, max = 4000) => (s ?? '').slice(-max);
```

`src/runners/junit.ts`:
```ts
import { XMLParser } from 'fast-xml-parser';
import type { TestCaseResult, TestOutcome } from '../types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => name === 'testsuite' || name === 'testcase',
});

const LOOKS_LIKE_PATH = /\.[cm]?[jt]sx?$|\.py$/;

interface JUnitCase {
  name?: string | number;
  classname?: string;
  file?: string;
  failure?: unknown;
  error?: unknown;
  skipped?: unknown;
}
interface JUnitSuite {
  name?: string;
  testcase?: JUnitCase[];
  testsuite?: JUnitSuite[];
}

export function parseJUnit(xml: string): TestCaseResult[] {
  const doc = parser.parse(xml) as { testsuites?: { testsuite?: JUnitSuite[] }; testsuite?: JUnitSuite[] };
  const suites = doc.testsuites?.testsuite ?? doc.testsuite ?? [];
  const out: TestCaseResult[] = [];

  const walk = (suite: JUnitSuite) => {
    for (const tc of suite.testcase ?? []) {
      const outcome: TestOutcome =
        tc.failure !== undefined ? 'fail' : tc.error !== undefined ? 'error' : tc.skipped !== undefined ? 'skip' : 'pass';
      const suiteName = suite.name ?? '';
      const file = LOOKS_LIKE_PATH.test(suiteName) ? suiteName : (tc.file ?? tc.classname ?? '');
      const name = String(tc.name ?? '');
      out.push({ id: `${file}::${name}`, file, name, outcome });
    }
    for (const child of suite.testsuite ?? []) walk(child);
  };

  for (const suite of suites) walk(suite);
  return out;
}
```

`src/runners/vitest.ts`:
```ts
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { childEnv, tail } from './env.js';
import { parseJUnit } from './junit.js';
import type { Runner } from './types.js';

export const vitest: Runner = {
  name: 'vitest',
  async run({ cwd, files }) {
    const dir = await mkdtemp(join(tmpdir(), 'trustbut-junit-'));
    const out = join(dir, 'junit.xml');
    const start = Date.now();
    try {
      const res = await execa(
        'npx',
        ['--no-install', 'vitest', 'run', '--reporter=junit', `--outputFile=${out}`, '--passWithNoTests', ...(files ?? [])],
        { cwd, reject: false, all: true, extendEnv: false, env: childEnv() },
      );
      const xml = existsSync(out) ? await readFile(out, 'utf8') : '';
      return { exitCode: res.exitCode ?? 1, cases: xml ? parseJUnit(xml) : [], durationMs: Date.now() - start, output: tail(res.all) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
```

`src/runners/pytest.ts`:
```ts
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { childEnv, tail } from './env.js';
import { parseJUnit } from './junit.js';
import type { Runner } from './types.js';

function pythonFor(cwd: string): string {
  for (const venv of ['.venv', 'venv']) {
    const bin = join(cwd, venv, 'bin', 'python');
    if (existsSync(bin)) return bin;
  }
  return process.env.TRUSTBUT_PYTHON ?? 'python3';
}

export const pytest: Runner = {
  name: 'pytest',
  async run({ cwd, files }) {
    const dir = await mkdtemp(join(tmpdir(), 'trustbut-junit-'));
    const out = join(dir, 'junit.xml');
    const start = Date.now();
    try {
      const res = await execa(
        pythonFor(cwd),
        ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', `--junitxml=${out}`, ...(files ?? [])],
        { cwd, reject: false, all: true, extendEnv: false, env: childEnv() },
      );
      const xml = existsSync(out) ? await readFile(out, 'utf8') : '';
      return { exitCode: res.exitCode ?? 1, cases: xml ? parseJUnit(xml) : [], durationMs: Date.now() - start, output: tail(res.all) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
```

`src/runners/detect.ts`:
```ts
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pytest } from './pytest.js';
import type { Runner } from './types.js';
import { vitest } from './vitest.js';

export function getRunner(name: 'vitest' | 'pytest'): Runner {
  return name === 'vitest' ? vitest : pytest;
}

export async function detectRunner(cwd: string): Promise<Runner | null> {
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (pkg.dependencies?.vitest || pkg.devDependencies?.vitest) return vitest;
  }
  if (['pytest.ini', 'conftest.py', 'tox.ini'].some((f) => existsSync(join(cwd, f)))) return pytest;
  const pyproject = join(cwd, 'pyproject.toml');
  if (existsSync(pyproject) && (await readFile(pyproject, 'utf8')).includes('[tool.pytest')) return pytest;
  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/runners.test.ts && npm run typecheck`
Expected: PASS. The pytest block is skipped if pytest isn't installed; run `python3 -m pip install pytest` to exercise it.

- [ ] **Step 5: Commit**

```bash
git add src/runners test/runners.test.ts
git commit -m "feat: vitest and pytest runner adapters via JUnit XML"
```

---

### Task 6: Proof engine (clean rerun + fail-before/pass-after)

**Files:**
- Create: `src/proof.ts`
- Test: `test/proof.test.ts`

**Interfaces:**
- Consumes: `addWorktree`, `removeWorktree`, `showFile` (Task 2); `Runner` (Task 5); `ChangedFile`, `Finding`, `RunResult`, `TestCaseResult`, `TestProof` (Task 1); `makeRepo`, `writeFiles`, `commitAll`, `linkNodeModules` (Task 2 helpers).
- Produces:
  - `caseInFile(c: TestCaseResult, file: string): boolean`
  - `buildProofs(testFiles: string[], before: RunResult, after: RunResult): TestProof[]`
  - `interface ProofInput { repo: string; base: string; head: string; changes: ChangedFile[]; runner: Runner; quick?: boolean }`
  - `interface ProofOutput { after?: RunResult; before?: RunResult; proofs: TestProof[]; findings: Finding[] }`
  - `proveTests(input: ProofInput): Promise<ProofOutput>`. Finding ids: `suite-failing` (fail), `deps-changed` (info).

- [ ] **Step 1: Write the failing test** — `test/proof.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { parseChanges } from '../src/diff.js';
import { diffText } from '../src/git.js';
import { buildProofs, caseInFile, proveTests } from '../src/proof.js';
import { vitest } from '../src/runners/vitest.js';
import type { RunResult, TestCaseResult } from '../src/types.js';
import { commitAll, linkNodeModules, makeRepo, writeFiles } from './helpers/repo.js';

const tc = (file: string, name: string, outcome: TestCaseResult['outcome']): TestCaseResult => ({
  id: `${file}::${name}`, file, name, outcome,
});
const run = (cases: TestCaseResult[], exitCode = 0): RunResult => ({ exitCode, cases, durationMs: 1, output: '' });

describe('caseInFile', () => {
  it('matches path-style and python module-style files', () => {
    expect(caseInFile(tc('test/a.test.ts', 'x', 'pass'), 'test/a.test.ts')).toBe(true);
    expect(caseInFile(tc('tests.test_a', 'x', 'pass'), 'tests/test_a.py')).toBe(true);
    expect(caseInFile(tc('tests.test_a.TestX', 'x', 'pass'), 'tests/test_a.py')).toBe(true);
    expect(caseInFile(tc('test/b.test.ts', 'x', 'pass'), 'test/a.test.ts')).toBe(false);
  });
});

describe('buildProofs', () => {
  it('classifies each changed test by its before/after outcome', () => {
    const f = 'test/a.test.ts';
    const before = run([tc(f, 'proves', 'fail'), tc(f, 'loose', 'pass'), tc(f, 'broken', 'fail')], 1);
    const after = run([
      tc(f, 'proves', 'pass'),
      tc(f, 'loose', 'pass'),
      tc(f, 'broken', 'fail'),
      tc(f, 'new-import', 'pass'),
      tc(f, 'later', 'skip'),
      tc('test/untouched.test.ts', 'other', 'pass'),
    ]);
    expect(buildProofs([f], before, after).map((p) => [p.name, p.verdict, p.weak])).toEqual([
      ['proves', 'proves-change', false],
      ['loose', 'does-not-constrain', false],
      ['broken', 'failing', false],
      ['new-import', 'proves-change', true],
      ['later', 'skipped', false],
    ]);
  });
});

describe('proveTests (vitest fixture)', () => {
  it('proves a real fix and catches a test that passes without it', async () => {
    const { dir, base } = await makeRepo({
      '.gitignore': 'node_modules\n',
      'package.json': JSON.stringify({ name: 'fx', private: true, type: 'module', devDependencies: { vitest: '*' } }),
      'src/sum.js': 'export const sum = (a, b) => a - b;\n',
      'test/old.test.js': "import { it, expect } from 'vitest';\nit('truth', () => expect(1).toBe(1));\n",
    });
    await linkNodeModules(dir);
    await writeFiles(dir, {
      'src/sum.js': 'export const sum = (a, b) => a + b;\n',
      'test/sum.test.js': [
        "import { it, expect } from 'vitest';",
        "import { sum } from '../src/sum.js';",
        "it('adds', () => expect(sum(2, 3)).toBe(5));",
        "it('zero', () => expect(sum(0, 0)).toBe(0));",
        '',
      ].join('\n'),
    });
    const head = await commitAll(dir, 'fix sum');
    const changes = parseChanges(await diffText(dir, base, head));

    const result = await proveTests({ repo: dir, base, head, changes, runner: vitest });

    expect(result.after?.exitCode).toBe(0);
    expect(result.proofs.map((p) => [p.name, p.verdict])).toEqual([
      ['adds', 'proves-change'],
      ['zero', 'does-not-constrain'],
    ]);
    expect(result.findings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/proof.test.ts`
Expected: FAIL, cannot resolve `../src/proof.js`.

- [ ] **Step 3: Implement** — `src/proof.ts`

```ts
import { existsSync } from 'node:fs';
import { lstat, mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { addWorktree, removeWorktree, showFile } from './git.js';
import type { Runner } from './runners/types.js';
import type { ChangedFile, Finding, RunResult, TestCaseResult, TestProof } from './types.js';

const DEP_DIRS = ['node_modules', '.venv', 'venv'];
const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|requirements[^/]*\.txt)$/;

export interface ProofInput {
  repo: string;
  base: string;
  head: string;
  changes: ChangedFile[];
  runner: Runner;
  quick?: boolean;
}

export interface ProofOutput {
  after?: RunResult;
  before?: RunResult;
  proofs: TestProof[];
  findings: Finding[];
}

export function caseInFile(c: TestCaseResult, file: string): boolean {
  if (c.file === file || c.file.endsWith(`/${file}`)) return true;
  const mod = file.replace(/\.py$/, '').split('/').join('.');
  return c.file === mod || c.file.startsWith(`${mod}.`);
}

export function buildProofs(testFiles: string[], before: RunResult, after: RunResult): TestProof[] {
  const beforeById = new Map(before.cases.map((c) => [c.id, c.outcome]));
  return after.cases
    .filter((c) => testFiles.some((f) => caseInFile(c, f)))
    .map((c) => {
      const prior = beforeById.get(c.id) ?? 'missing';
      const verdict: TestProof['verdict'] =
        c.outcome === 'skip' ? 'skipped' : c.outcome !== 'pass' ? 'failing' : prior === 'pass' ? 'does-not-constrain' : 'proves-change';
      const weak = verdict === 'proves-change' && (prior === 'missing' || prior === 'error');
      return { id: c.id, file: c.file, name: c.name, before: prior, after: c.outcome, verdict, weak };
    });
}

async function linkDeps(repo: string, dir: string): Promise<void> {
  for (const name of DEP_DIRS) {
    if (existsSync(join(repo, name)) && !existsSync(join(dir, name))) {
      await symlink(join(repo, name), join(dir, name), 'dir');
    }
  }
}

// Remove our dependency symlinks before deleting a worktree so nothing can follow them.
async function unlinkDeps(dir: string): Promise<void> {
  for (const name of DEP_DIRS) {
    const p = join(dir, name);
    try {
      if ((await lstat(p)).isSymbolicLink()) await unlink(p);
    } catch {
      // not present
    }
  }
}

export async function proveTests({ repo, base, head, changes, runner, quick }: ProofInput): Promise<ProofOutput> {
  const testFiles = changes.filter((c) => c.kind === 'test' && c.status !== 'deleted').map((c) => c.path);
  const findings: Finding[] = [];
  if (changes.some((c) => LOCKFILE.test(c.path))) {
    findings.push({ id: 'deps-changed', severity: 'info', title: 'Dependencies changed; both runs use the currently installed dependencies' });
  }

  const headDir = await addWorktree(repo, head);
  let baseDir: string | undefined;
  try {
    await linkDeps(repo, headDir);
    const after = await runner.run({ cwd: headDir, files: quick && testFiles.length ? testFiles : undefined });
    if (after.exitCode !== 0) {
      findings.push({ id: 'suite-failing', severity: 'fail', title: 'Test suite fails at head (clean checkout)', detail: `exit code ${after.exitCode}` });
    }
    if (!testFiles.length) return { after, proofs: [], findings };

    baseDir = await addWorktree(repo, base);
    await linkDeps(repo, baseDir);
    for (const path of testFiles) {
      const target = join(baseDir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await showFile(repo, head, path));
    }
    const before = await runner.run({ cwd: baseDir, files: testFiles });
    return { after, before, proofs: buildProofs(testFiles, before, after), findings };
  } finally {
    await unlinkDeps(headDir);
    await removeWorktree(repo, headDir);
    if (baseDir) {
      await unlinkDeps(baseDir);
      await removeWorktree(repo, baseDir);
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/proof.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proof.ts test/proof.test.ts
git commit -m "feat: proof engine with clean rerun and fail-before/pass-after"
```

---

### Task 7: Risk ranking, verdict, receipt, and Markdown rendering

**Files:**
- Create: `src/risk.ts`, `src/receipt.ts`, `src/render.ts`
- Test: `test/receipt.test.ts`

**Interfaces:**
- Consumes: types from Task 1.
- Produces:
  - `rankRisks(changes: ChangedFile[], findings: Finding[]): RiskItem[]` (score > 0 only, sorted by score desc then path)
  - `proofFindings(proofs: TestProof[]): Finding[]` (`test-passes-without-change` warn, `test-failing` fail)
  - `coverageFindings(changes: ChangedFile[]): Finding[]` (`no-tests-changed` warn)
  - `decideVerdict(findings: Finding[]): Verdict`
  - `interface ReceiptInput { base: string; head: string; runner: string | null; after?: RunResult; before?: RunResult; proofs: TestProof[]; findings: Finding[]; changes: ChangedFile[] }`
  - `buildReceipt(input: ReceiptInput): Receipt`
  - `renderMarkdown(r: Receipt): string`

- [ ] **Step 1: Write the failing test** — `test/receipt.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { buildReceipt, coverageFindings, decideVerdict, proofFindings } from '../src/receipt.js';
import { renderMarkdown } from '../src/render.js';
import { rankRisks } from '../src/risk.js';
import type { ChangedFile, TestProof } from '../src/types.js';

const file = (path: string, kind: ChangedFile['kind'], size = 1): ChangedFile => ({
  path, status: 'modified', kind, added: Array.from({ length: size }, (_, i) => ({ line: i + 1, text: 'x' })), removed: [],
});

const proof = (name: string, verdict: TestProof['verdict'], weak = false): TestProof => ({
  id: `t.test.ts::${name}`, file: 't.test.ts', name, before: 'fail', after: 'pass', verdict, weak,
});

describe('rankRisks', () => {
  it('scores risky paths, findings and size; ignores test paths for path rules', () => {
    const risks = rankRisks(
      [
        file('src/auth/session.ts', 'source'),
        file('package.json', 'other'),
        file('src/util.ts', 'source', 250),
        file('test/auth.test.ts', 'test'),
        file('src/plain.ts', 'source'),
      ],
      [{ id: 'escape-added', severity: 'warn', title: 'cast to any', file: 'src/auth/session.ts' }],
    );
    expect(risks).toEqual([
      { file: 'src/auth/session.ts', score: 5, reasons: ['auth/permissions', 'has findings'] },
      { file: 'package.json', score: 2, reasons: ['dependencies'] },
      { file: 'src/util.ts', score: 1, reasons: ['large change (250 lines)'] },
    ]);
  });
});

describe('derived findings and verdict', () => {
  it('turns proofs into findings', () => {
    expect(proofFindings([proof('a', 'proves-change'), proof('b', 'does-not-constrain'), proof('c', 'failing')]).map((f) => [f.id, f.severity])).toEqual([
      ['test-passes-without-change', 'warn'],
      ['test-failing', 'fail'],
    ]);
  });

  it('warns when source changes without tests', () => {
    expect(coverageFindings([file('src/a.ts', 'source')]).map((f) => f.id)).toEqual(['no-tests-changed']);
    expect(coverageFindings([file('src/a.ts', 'source'), file('test/a.test.ts', 'test')])).toEqual([]);
  });

  it('decides the verdict from the worst finding', () => {
    expect(decideVerdict([])).toBe('pass');
    expect(decideVerdict([{ id: 'x', severity: 'info', title: '' }])).toBe('pass');
    expect(decideVerdict([{ id: 'x', severity: 'warn', title: '' }])).toBe('warn');
    expect(decideVerdict([{ id: 'x', severity: 'warn', title: '' }, { id: 'y', severity: 'fail', title: '' }])).toBe('fail');
  });
});

describe('renderMarkdown', () => {
  it('renders the verdict, test summary, findings and review list', () => {
    const receipt = buildReceipt({
      base: '3f2a91c0000000000000000000000000000000000',
      head: '8be04d10000000000000000000000000000000000',
      runner: 'vitest',
      after: {
        exitCode: 0, durationMs: 10, output: '',
        cases: [
          { id: 'a', file: 't.test.ts', name: 'a', outcome: 'pass' },
          { id: 'b', file: 't.test.ts', name: 'b', outcome: 'pass' },
          { id: 'c', file: 't.test.ts', name: 'c', outcome: 'skip' },
        ],
      },
      proofs: [proof('a', 'proves-change'), proof('b', 'does-not-constrain')],
      findings: [{ id: 'escape-added', severity: 'warn', title: 'cast to any', file: 'src/auth/session.ts', line: 41 }],
      changes: [file('src/auth/session.ts', 'source'), file('t.test.ts', 'test')],
    });
    const md = renderMarkdown(receipt);
    expect(receipt.verdict).toBe('warn');
    expect(md).toContain('## 🧾 Receipt: WARN');
    expect(md).toContain('`3f2a91c` → `8be04d1` · runner: vitest');
    expect(md).toContain('**Tests (clean checkout):** 2 passed · 0 failed · 1 skipped');
    expect(md).toContain('**New/changed tests:** 1 prove the change · 1 pass without it');
    expect(md).toContain('- ⚠ **cast to any** · `src/auth/session.ts:41`');
    expect(md).toContain('- ⚠ **Test passes without the change** · `t.test.ts`: b');
    expect(md).toContain('1. `src/auth/session.ts`: auth/permissions, has findings');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/receipt.test.ts`
Expected: FAIL, cannot resolve `../src/receipt.js`.

- [ ] **Step 3: Implement**

`src/risk.ts`:
```ts
import type { ChangedFile, Finding, RiskItem } from './types.js';

const RULES: [RegExp, number, string][] = [
  [/auth|login|session|permission|acl|rbac|oauth|jwt|password/i, 3, 'auth/permissions'],
  [/(^|\/)migrations?\//i, 3, 'database migration'],
  [/(^|\/)\.github\/workflows\/|\.gitlab-ci\.yml$|(^|\/)Jenkinsfile$/, 3, 'CI pipeline'],
  [/(^|\/)(\.env[^/]*|secrets?[^/]*|credentials?[^/]*)$/i, 3, 'secrets/env'],
  [/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock)$/, 2, 'dependencies'],
  [/(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml)$|\.tf$|(^|\/)(infra|terraform|k8s|helm)\//, 2, 'infrastructure'],
  [/(^|\/)(\.claude|\.codex|\.gemini|\.cursor)\/|(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$/, 2, 'agent config'],
];

export function rankRisks(changes: ChangedFile[], findings: Finding[]): RiskItem[] {
  return changes
    .map((c) => {
      let score = 0;
      const reasons: string[] = [];
      if (c.kind !== 'test') {
        for (const [re, weight, why] of RULES) {
          if (re.test(c.path)) {
            score += weight;
            reasons.push(why);
          }
        }
      }
      if (findings.some((f) => f.file === c.path && f.severity !== 'info')) {
        score += 2;
        reasons.push('has findings');
      }
      const size = c.added.length + c.removed.length;
      if (size > 200) {
        score += 1;
        reasons.push(`large change (${size} lines)`);
      }
      return { file: c.path, score, reasons };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}
```

`src/receipt.ts`:
```ts
import { rankRisks } from './risk.js';
import type { ChangedFile, Finding, Receipt, RunResult, TestProof, Verdict } from './types.js';

export interface ReceiptInput {
  base: string;
  head: string;
  runner: string | null;
  after?: RunResult;
  before?: RunResult;
  proofs: TestProof[];
  findings: Finding[];
  changes: ChangedFile[];
}

export function proofFindings(proofs: TestProof[]): Finding[] {
  const out: Finding[] = [];
  for (const p of proofs) {
    if (p.verdict === 'does-not-constrain') {
      out.push({ id: 'test-passes-without-change', severity: 'warn', title: 'Test passes without the change', file: p.file, detail: p.name });
    } else if (p.verdict === 'failing') {
      out.push({ id: 'test-failing', severity: 'fail', title: 'Test fails at head', file: p.file, detail: p.name });
    }
  }
  return out;
}

export function coverageFindings(changes: ChangedFile[]): Finding[] {
  const sourceChanged = changes.some((c) => c.kind === 'source' && c.status !== 'deleted');
  const testsChanged = changes.some((c) => c.kind === 'test');
  return sourceChanged && !testsChanged
    ? [{ id: 'no-tests-changed', severity: 'warn', title: 'Source changed but no tests were added or changed' }]
    : [];
}

export function decideVerdict(findings: Finding[]): Verdict {
  if (findings.some((f) => f.severity === 'fail')) return 'fail';
  if (findings.some((f) => f.severity === 'warn')) return 'warn';
  return 'pass';
}

export function buildReceipt(input: ReceiptInput): Receipt {
  const findings = [...input.findings, ...proofFindings(input.proofs), ...coverageFindings(input.changes)];
  return {
    version: 1,
    base: input.base,
    head: input.head,
    runner: input.runner,
    verdict: decideVerdict(findings),
    after: input.after,
    before: input.before,
    proofs: input.proofs,
    findings,
    risks: rankRisks(input.changes, findings),
  };
}
```

`src/render.ts`:
```ts
import type { Finding, Receipt, RunResult } from './types.js';

const ICON = { fail: '✖', warn: '⚠', info: 'ℹ' } as const;

function tally(run: RunResult) {
  const t = { pass: 0, fail: 0, error: 0, skip: 0 };
  for (const c of run.cases) t[c.outcome] += 1;
  return t;
}

function findingLine(f: Finding): string {
  const where = f.file ? ` · \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
  const detail = f.detail ? `: ${f.detail}` : '';
  return `- ${ICON[f.severity]} **${f.title}**${where}${detail}`;
}

export function renderMarkdown(r: Receipt): string {
  const lines: string[] = [];
  lines.push(`## 🧾 Receipt: ${r.verdict.toUpperCase()}`, '');
  lines.push(`\`${r.base.slice(0, 7)}\` → \`${r.head.slice(0, 7)}\`${r.runner ? ` · runner: ${r.runner}` : ''}`, '');

  if (r.after) {
    const t = tally(r.after);
    lines.push(`**Tests (clean checkout):** ${t.pass} passed · ${t.fail + t.error} failed · ${t.skip} skipped`);
  } else {
    lines.push('**Tests:** not run');
  }
  if (r.proofs.length) {
    const proves = r.proofs.filter((p) => p.verdict === 'proves-change');
    const weak = proves.filter((p) => p.weak).length;
    const loose = r.proofs.filter((p) => p.verdict === 'does-not-constrain').length;
    lines.push(`**New/changed tests:** ${proves.length} prove the change${weak ? ` (${weak} only because the code didn't exist yet)` : ''} · ${loose} pass without it`);
  }

  lines.push('', '### Findings');
  if (!r.findings.length) lines.push('None.');
  for (const f of r.findings) lines.push(findingLine(f));

  if (r.risks.length) {
    lines.push('', '### Review these first');
    r.risks.slice(0, 5).forEach((risk, i) => lines.push(`${i + 1}. \`${risk.file}\`: ${risk.reasons.join(', ')}`));
  }
  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/receipt.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/risk.ts src/receipt.ts src/render.ts test/receipt.test.ts
git commit -m "feat: risk ranking, verdict, receipt builder and markdown renderer"
```

---

### Task 8: `verify` command and end-to-end scenarios

**Files:**
- Create: `src/commands/verify.ts`
- Modify: `src/program.ts` (register `verify`)
- Test: `test/e2e.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `interface VerifyOptions { cwd?: string; base?: string; head?: string; runner?: 'vitest' | 'pytest'; quick?: boolean; strict?: boolean; json?: boolean }`
  - `interface VerifyResult { receipt: Receipt; output: string; exitCode: number }`
  - `runVerify(opts?: VerifyOptions): Promise<VerifyResult>`. Throws `Error` with a user-facing message on bad refs or empty diffs.
  - Extra finding ids: `uncommitted-changes` (info), `no-runner` (warn).

- [ ] **Step 1: Write the failing test** — `test/e2e.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { runVerify } from '../src/commands/verify.js';
import { buildProgram } from '../src/program.js';
import { branch, commitAll, linkNodeModules, makeRepo, writeFiles } from './helpers/repo.js';

const BASE_FILES = {
  '.gitignore': 'node_modules\n',
  'package.json': JSON.stringify({ name: 'fx', private: true, type: 'module', devDependencies: { vitest: '*' } }),
  'src/sum.js': 'export const sum = (a, b) => a - b;\n',
  'test/old.test.js': "import { it, expect } from 'vitest';\nit('truth', () => expect(1).toBe(1));\n",
};

async function scenario(head: Record<string, string | null>) {
  const { dir } = await makeRepo(BASE_FILES);
  await linkNodeModules(dir);
  await branch(dir, 'agent-change');
  await writeFiles(dir, head);
  await commitAll(dir, 'agent change');
  return dir;
}

const sumTest = (body: string) =>
  `import { it, expect } from 'vitest';\nimport { sum } from '../src/sum.js';\n${body}\n`;

describe('trustbut verify (end to end)', () => {
  it('PASS: honest fix with a test that fails before and passes after', async () => {
    const dir = await scenario({
      'src/sum.js': 'export const sum = (a, b) => a + b;\n',
      'test/sum.test.js': sumTest("it('adds', () => expect(sum(2, 3)).toBe(5));"),
    });
    const { receipt, exitCode, output } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('pass');
    expect(exitCode).toBe(0);
    expect(output).toContain('1 prove the change');
  });

  it('WARN: new test passes without the change', async () => {
    const dir = await scenario({
      'src/sum.js': 'export const sum = (a, b) => a + b;\n',
      'test/sum.test.js': sumTest("it('zero', () => expect(sum(0, 0)).toBe(0));"),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('warn');
    expect(receipt.findings.map((f) => f.id)).toContain('test-passes-without-change');
  });

  it('WARN: existing test skipped; exit 1 with --strict', async () => {
    const dir = await scenario({
      'test/old.test.js': "import { it, expect } from 'vitest';\nit.skip('truth', () => expect(1).toBe(1));\n",
    });
    const { receipt, exitCode } = await runVerify({ cwd: dir, strict: true });
    expect(receipt.verdict).toBe('warn');
    expect(receipt.findings.map((f) => f.id)).toContain('test-skipped');
    expect(exitCode).toBe(1);
  });

  it('FAIL: focused test', async () => {
    const dir = await scenario({
      'test/old.test.js': "import { it, expect } from 'vitest';\nit.only('truth', () => expect(1).toBe(1));\n",
    });
    const { receipt, exitCode } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('fail');
    expect(receipt.findings.map((f) => f.id)).toContain('test-focused');
    expect(exitCode).toBe(1);
  });

  it('FAIL: suite is red at head', async () => {
    const dir = await scenario({
      'test/old.test.js': "import { it, expect } from 'vitest';\nit('truth', () => expect(1).toBe(2));\n",
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('fail');
    expect(receipt.findings.map((f) => f.id)).toEqual(expect.arrayContaining(['suite-failing', 'test-failing']));
  });

  it('errors clearly when there is nothing to compare', async () => {
    const { dir } = await makeRepo(BASE_FILES);
    await expect(runVerify({ cwd: dir })).rejects.toThrow(/No changes between base and head/);
  });

  it('prints JSON with --json', async () => {
    const dir = await scenario({ 'README.md': '# hi\n' });
    const { output } = await runVerify({ cwd: dir, json: true });
    expect(JSON.parse(output)).toMatchObject({ version: 1, verdict: 'pass' });
  });

  it('registers the verify command', () => {
    expect(buildProgram().commands.map((c) => c.name())).toContain('verify');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/e2e.test.ts`
Expected: FAIL, cannot resolve `../src/commands/verify.js`.

- [ ] **Step 3: Implement**

`src/commands/verify.ts`:
```ts
import { checkEscapes } from '../checks/escapes.js';
import { checkTestIntegrity } from '../checks/test-integrity.js';
import { parseChanges } from '../diff.js';
import { diffText, isDirty, mergeBase, repoRoot, resolveRef } from '../git.js';
import { proveTests, type ProofOutput } from '../proof.js';
import { buildReceipt } from '../receipt.js';
import { renderMarkdown } from '../render.js';
import { detectRunner, getRunner } from '../runners/detect.js';
import type { Finding, Receipt } from '../types.js';

export interface VerifyOptions {
  cwd?: string;
  base?: string;
  head?: string;
  runner?: 'vitest' | 'pytest';
  quick?: boolean;
  strict?: boolean;
  json?: boolean;
}

export interface VerifyResult {
  receipt: Receipt;
  output: string;
  exitCode: number;
}

const DEFAULT_BASES = ['origin/main', 'main', 'origin/master', 'master'];

async function resolveBase(repo: string, head: string, explicit?: string): Promise<string> {
  if (explicit) {
    const sha = await resolveRef(repo, explicit);
    if (!sha) throw new Error(`Unknown base ref: ${explicit}`);
    return sha;
  }
  for (const ref of DEFAULT_BASES) {
    const sha = await resolveRef(repo, ref);
    if (sha) return mergeBase(repo, sha, head);
  }
  throw new Error('Could not find a base branch (main/master). Pass --base <ref>.');
}

export async function runVerify(opts: VerifyOptions = {}): Promise<VerifyResult> {
  const repo = await repoRoot(opts.cwd ?? process.cwd());
  const headRef = opts.head ?? 'HEAD';
  const head = await resolveRef(repo, headRef);
  if (!head) throw new Error(`Unknown head ref: ${headRef}`);
  const base = await resolveBase(repo, head, opts.base);
  if (base === head) throw new Error('No changes between base and head. Commit your changes or pass --base <ref>.');

  const changes = parseChanges(await diffText(repo, base, head));
  const findings: Finding[] = [...checkTestIntegrity(changes), ...checkEscapes(changes)];
  if (await isDirty(repo)) {
    findings.push({ id: 'uncommitted-changes', severity: 'info', title: 'Uncommitted changes are not included in this receipt' });
  }

  const runner = opts.runner ? getRunner(opts.runner) : await detectRunner(repo);
  let proof: ProofOutput = { proofs: [], findings: [] };
  if (runner) {
    proof = await proveTests({ repo, base, head, changes, runner, quick: opts.quick });
  } else {
    findings.push({ id: 'no-runner', severity: 'warn', title: 'No supported test runner detected (Vitest or pytest); tests were not rerun' });
  }

  const receipt = buildReceipt({
    base,
    head,
    runner: runner?.name ?? null,
    after: proof.after,
    before: proof.before,
    proofs: proof.proofs,
    findings: [...findings, ...proof.findings],
    changes,
  });
  const output = opts.json ? `${JSON.stringify(receipt, null, 2)}\n` : renderMarkdown(receipt);
  const exitCode = receipt.verdict === 'fail' || (opts.strict && receipt.verdict === 'warn') ? 1 : 0;
  return { receipt, output, exitCode };
}
```

`src/program.ts` (replace whole file):
```ts
import { Command } from 'commander';
import { runVerify, type VerifyOptions } from './commands/verify.js';
import { VERSION } from './version.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('trustbut')
    .description('Verifiable receipts for code written by AI coding agents')
    .version(VERSION);

  program
    .command('verify')
    .description('Produce a receipt for the changes between base and head')
    .option('-b, --base <ref>', 'base ref (default: merge-base with main/master)')
    .option('--head <ref>', 'head ref', 'HEAD')
    .option('--runner <name>', 'force a test runner: vitest | pytest')
    .option('--quick', 'at head, rerun only new/changed test files')
    .option('--strict', 'exit 1 on WARN as well as FAIL')
    .option('--json', 'print the receipt as JSON')
    .action(async (opts: VerifyOptions) => {
      try {
        const result = await runVerify(opts);
        process.stdout.write(result.output);
        process.exitCode = result.exitCode;
      } catch (err) {
        process.stderr.write(`trustbut: ${(err as Error).message}\n`);
        process.exitCode = 2;
      }
    });

  return program;
}
```

- [ ] **Step 4: Run the full suite, typecheck, build, and try the binary**

Run: `npm test && npm run typecheck && npm run build && node dist/cli.js --help`
Expected: all tests PASS; help lists the `verify` command.

- [ ] **Step 5: Commit**

```bash
git add src/commands src/program.ts test/e2e.test.ts
git commit -m "feat: trustbut verify command with end-to-end scenarios"
```

---

### Task 9: CI with self-receipt, and README

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes: `dist/cli.js` built by `npm run build`.

- [ ] **Step 1: Create the workflow** — `.github/workflows/ci.yml`

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - name: Receipt for this PR (dogfood)
        if: github.event_name == 'pull_request'
        run: node dist/cli.js verify --base origin/${{ github.base_ref }} | tee receipt.md >> "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 2: Create the README** — `README.md`

````markdown
# trustbut

**Your agent said it's done and the tests pass. Here's what's actually true.**

`trustbut` produces a short, deterministic evidence report for code written by AI coding agents (Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Copilot). It works with git alone, runs locally, and sends nothing anywhere.

```bash
npx trustbut verify
```

What it checks:
- **Clean rerun:** runs your test suite in a fresh worktree at HEAD instead of trusting the agent's run.
- **Fail-before / pass-after:** every new or changed test is run against the base commit too. Tests that pass without the change are flagged.
- **Test integrity:** skipped, focused or deleted tests; removed assertions; rewritten snapshots; test config edits.
- **Escapes:** new `as any`, `@ts-ignore`, `eslint-disable`, `# type: ignore`, coverage ignores.
- **Review these first:** risky files (auth, migrations, CI, dependencies, secrets, agent config) ranked.

Supported runners: Vitest, pytest (Jest, Go, Cargo next).

Options: `--base <ref>`, `--head <ref>`, `--runner vitest|pytest`, `--quick`, `--strict`, `--json`.

License: Apache-2.0.
````

- [ ] **Step 3: Verify the dogfood command locally on a branch**

```bash
git checkout -b chore/ci
git add .github README.md
git commit -m "ci: run tests and trustbut on every PR; add README"
node dist/cli.js verify --base main
```
Expected: a receipt prints. `README.md`/CI changes with no source change give PASS, with `.github/workflows/ci.yml` listed under "Review these first" (CI pipeline).

- [ ] **Step 4: Merge to main**

```bash
git checkout main
git merge --ff-only chore/ci
```
