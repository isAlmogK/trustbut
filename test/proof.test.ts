import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChanges } from '../src/diff.js';
import { diffText } from '../src/git.js';
import { buildProofs, caseInFile, copiedToBase, proveTests, regressedCases, resolveCaseFile } from '../src/proof.js';
import { vitest } from '../src/runners/vitest.js';
import type { RunOptions, Runner } from '../src/runners/types.js';
import type { ChangedFile, RunResult, TestCaseResult } from '../src/types.js';
import { commitAll, linkNodeModules, makeRepo, writeFiles } from './helpers/repo.js';

const tc = (file: string, name: string, outcome: TestCaseResult['outcome']): TestCaseResult => ({
  id: `${file}::${name}`, file, name, outcome,
});
const run = (cases: TestCaseResult[], exitCode = 0, output = ''): RunResult => ({ exitCode, cases, durationMs: 1, output });
const changed = (path: string, status: ChangedFile['status'] = 'added', added: string[] = []): ChangedFile => ({
  path, status, kind: 'test', added: added.map((text, i) => ({ line: i + 1, text })), removed: [],
});

describe('caseInFile', () => {
  it('matches path-style and python module-style files', () => {
    expect(caseInFile(tc('test/a.test.ts', 'x', 'pass'), 'test/a.test.ts')).toBe(true);
    expect(caseInFile(tc('tests.test_a', 'x', 'pass'), 'tests/test_a.py')).toBe(true);
    expect(caseInFile(tc('tests.test_a.TestX', 'x', 'pass'), 'tests/test_a.py')).toBe(true);
    expect(caseInFile(tc('test/b.test.ts', 'x', 'pass'), 'test/a.test.ts')).toBe(false);
  });

  it('matches a runner path relative to a subdirectory of the repo', () => {
    expect(caseInFile(tc('test/a.test.ts', 'x', 'pass'), 'packages/web/test/a.test.ts')).toBe(true);
    expect(caseInFile(tc('', 'x', 'pass'), 'packages/web/test/a.test.ts')).toBe(false);
  });
});

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

  it('normalizes a ./-prefixed or dotted path to a plain relative path', async () => {
    const root = await tree();
    expect(resolveCaseFile('./test/a.test.js', root)).toBe('test/a.test.js');
    expect(resolveCaseFile('test/../test/./a.test.js', root)).toBe('test/a.test.js');
    expect(resolveCaseFile('test/../../a.test.js', root)).toBeUndefined();
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

describe('copiedToBase', () => {
  const file = (path: string, kind: ChangedFile['kind'] = 'source'): ChangedFile => ({ path, status: 'modified', kind, added: [], removed: [] });
  const copied = (paths: string[]) => paths.filter((p) => copiedToBase(file(p)));

  it('copies helpers in a top-level test folder of a package named after a source root', () => {
    expect(
      copied([
        'packages/app/test/helpers.ts',
        'apps/app/spec/support/make.rb',
        'packages/lib/__tests__/helpers/make.js',
        'packages/app/tests/conftest_helpers.py',
      ]),
    ).toHaveLength(4);
  });

  it('keeps source under a test-named folder inside a source tree in place', () => {
    expect(
      copied([
        'app/models/spec/double.rb',
        'app/test/double.js',
        'src/app/test/double.ts',
        'packages/web/app/models/spec/double.rb',
        'packages/app/app/models/spec/double.rb',
        'packages/app/src/test/double.ts',
        'packages/app/lib/spec/double.rb',
        'src/spec/double.js',
      ]),
    ).toEqual([]);
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
    expect(buildProofs([changed(f)], before, after).map((p) => [p.name, p.verdict, p.weak])).toEqual([
      ['proves', 'proves-change', false],
      ['loose', 'does-not-constrain', false],
      ['broken', 'failing', false],
      ['new-import', 'proves-change', true],
      ['later', 'skipped', false],
    ]);
  });
});

describe('buildProofs with runner-provided leaf names', () => {
  const any = () => true;
  it('keeps a new .NET-style test added to an existing class, and drops untouched ones', () => {
    const f = 'CalcTests.cs';
    const mk = (method: string, args = ''): TestCaseResult => ({
      id: `Ns.CalcTests.${method}${args}`, file: 'Ns.CalcTests', name: `Ns.CalcTests.${method}${args}`, outcome: 'pass', leaf: method,
    });
    const cases = [mk('Old'), mk('NewOne', '(a: 1)')];
    const proofs = buildProofs([changed(f, 'modified', ['    public void NewOne(int a) { }'])], run(cases), run(cases), any);
    expect(proofs.map((p) => [p.name, p.verdict])).toEqual([['Ns.CalcTests.NewOne(a: 1)', 'does-not-constrain']]);
  });

  it('keeps a new Rust-style nested test whose last path segment is on an added line', () => {
    const mk = (name: string): TestCaseResult => ({ id: `fx:src/lib.rs::${name}`, file: 'src/lib.rs', name, outcome: 'pass', leaf: name.split('::').pop()! });
    const cases = [mk('shapes::tests::old'), mk('shapes::tests::fresh')];
    const proofs = buildProofs([changed('src/shapes.rs', 'modified', ['    fn fresh() {'])], run(cases), run(cases), any);
    expect(proofs.map((p) => [p.name, p.verdict])).toEqual([['shapes::tests::fresh', 'does-not-constrain']]);
  });
});

describe('buildProofs on modified test files', () => {
  it('skips untouched cases that already passed at base; keeps edited, fixed and failing ones', () => {
    const f = 'test/a.test.ts';
    const file = changed(f, 'modified', ["  it('edited', () => {", "    it('nested', () => {", '  expect(sum(1, 2)).toBe(3);']);
    const before = run([
      tc(f, 'untouched', 'pass'),
      tc(f, 'edited', 'pass'),
      tc(f, 'fixed', 'fail'),
      tc(f, 'regressed', 'pass'),
      tc(f, 'group > nested', 'pass'),
      tc(f, 'group > other', 'pass'),
    ]);
    const after = run([
      tc(f, 'untouched', 'pass'),
      tc(f, 'edited', 'pass'),
      tc(f, 'fixed', 'pass'),
      tc(f, 'regressed', 'fail'),
      tc(f, 'group > nested', 'pass'),
      tc(f, 'group > other', 'pass'),
      tc(f, 'brand new', 'pass'),
    ]);
    expect(buildProofs([file], before, after).map((p) => [p.name, p.verdict])).toEqual([
      ['edited', 'does-not-constrain'],
      ['fixed', 'proves-change'],
      ['regressed', 'failing'],
      ['group > nested', 'does-not-constrain'],
      ['brand new', 'proves-change'],
    ]);
  });

  it('strips pytest parameters from the leaf name and reports the repo path of the file', () => {
    const file = changed('tests/test_a.py', 'renamed', ['def test_p(x):']);
    const before = run([tc('tests.test_a', 'test_p[1-2]', 'pass'), tc('tests.test_a', 'test_q', 'pass')]);
    const after = run([tc('tests.test_a', 'test_p[1-2]', 'pass'), tc('tests.test_a', 'test_q', 'pass')]);
    expect(buildProofs([file], before, after)).toEqual([
      { id: 'tests.test_a::test_p[1-2]', file: 'tests/test_a.py', name: 'test_p[1-2]', before: 'pass', after: 'pass', verdict: 'does-not-constrain', weak: false },
    ]);
  });
});

/** A runner stub: the first call is the head run, the second the base run. */
/** Call i gets runs[i]; later calls get the last run (an empty run when only the head run is given). */
const nth = (runs: RunResult[], i: number): RunResult => (runs.length === 1 && i > 0 ? run([]) : runs[Math.min(i, runs.length - 1)]!);

function stubRunner(...runs: RunResult[]): Runner {
  let calls = 0;
  return { name: 'vitest', detect: async () => 0, run: async () => nth(runs, calls++) };
}

/** A runner that records its calls: head run, base run, then the head and base reruns (each later call gets the last run given). */
function recordingRunner(...runs: RunResult[]) {
  const calls: RunOptions[] = [];
  const runner: Runner = { name: 'vitest', detect: async () => 0, run: async (opts) => { calls.push(opts); return nth(runs, calls.length - 1); } };
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
const notReproduced = (file: string, detail: string) => ({
  id: 'trustbut/regression-not-reproduced', severity: 'info', title: 'Test failed at head and passed at base, but a rerun did not reproduce both results', file, detail,
});
const suiteRed = { id: 'suite-failing', severity: 'fail', title: 'Test suite fails at head (clean checkout)', detail: 'exit code 1' };
const pyCase = (outcome: TestCaseResult['outcome']): TestCaseResult => ({ id: 'tests.test_mod::test_m', file: 'tests.test_mod', name: 'test_m', outcome });

async function repoWithNewTest() {
  const { dir, base } = await makeRepo({ 'src/a.js': 'export const a = 1;\n' });
  await writeFiles(dir, { 'src/a.js': 'export const a = 2;\n', 'test/a.test.js': "it('a', () => {});\n" });
  const head = await commitAll(dir, 'change');
  return { dir, base, head, changes: parseChanges(await diffText(dir, base, head)) };
}

describe('proveTests evidence findings', () => {
  it('warns when the changed tests could not run at base', async () => {
    const { dir, base, head, changes } = await repoWithNewTest();
    const runner = stubRunner(run([tc('test/a.test.js', 'a', 'pass')]), run([], 1, 'boom'));
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(result.findings).toEqual([
      { id: 'base-run-failed', severity: 'warn', title: 'Changed tests could not run at base; fail-before evidence unavailable (exit 1)' },
    ]);
  });

  it('warns when no test result matches the changed test files', async () => {
    const { dir, base, head, changes } = await repoWithNewTest();
    const runner = stubRunner(run([tc('elsewhere/b.test.js', 'b', 'pass')]), run([tc('elsewhere/b.test.js', 'b', 'pass')]));
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(result.proofs).toEqual([]);
    expect(result.findings.map((f) => [f.id, f.severity])).toEqual([['proofs-unmatched', 'warn']]);
  });

  it('counts Minitest *_test.rb files as named tests, but not helpers, for proofs-unmatched', async () => {
    const { dir, base } = await makeRepo({ 'app/user.rb': 'class User; end\n', 'test/test_helper.rb': '# helper\n' });
    await writeFiles(dir, { 'app/user.rb': 'class User; def a = 1; end\n', 'test/models/user_test.rb': "class UserTest; def test_a; end; end\n" });
    const head = await commitAll(dir, 'minitest');
    const changes = parseChanges(await diffText(dir, base, head));
    const other = run([tc('spec/other_spec.rb', 'x', 'pass')]);
    const unmatched = await proveTests({ repo: dir, base, head, changes, runner: stubRunner(other, other) });
    expect(unmatched.findings.map((f) => f.id)).toEqual(['proofs-unmatched']);

    await writeFiles(dir, { 'test/test_helper.rb': '# helper v2\n' });
    const head2 = await commitAll(dir, 'helper only');
    const helperOnly = parseChanges(await diffText(dir, head, head2));
    const quiet = await proveTests({ repo: dir, base: head, head: head2, changes: helperOnly, runner: stubRunner(other, other) });
    expect(quiet.findings).toEqual([]);
  });

  it('explains a runner that failed without reporting results', async () => {
    const { dir, base, head, changes } = await repoWithNewTest();
    const output = "npm error could not determine executable to run\nError: Cannot find module 'vitest'\n\n";
    const runner = stubRunner(run([], 1, output), run([], 1, output));
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(result.findings[0]).toEqual({
      id: 'suite-failing',
      severity: 'fail',
      title: 'Test runner failed without reporting any test results',
      detail: "Error: Cannot find module 'vitest'",
    });
  });

  it('warns when the head run exits 0 with no test results, and the changed tests matched nothing', async () => {
    const { dir, base, head, changes } = await repoWithNewTest();
    const result = await proveTests({ repo: dir, base, head, changes, runner: stubRunner(run([]), run([])) });
    expect(result.findings).toEqual([
      { id: 'no-test-results', severity: 'warn', title: 'The test runner reported no test results' },
      { id: 'proofs-unmatched', severity: 'warn', title: 'No test results matched the changed test files; fail-before/pass-after evidence unavailable' },
    ]);
  });

  it('warns about no test results even when no tests changed', async () => {
    const { dir, base } = await makeRepo({ 'src/a.js': 'export const a = 1;\n' });
    await writeFiles(dir, { 'src/a.js': 'export const a = 2;\n' });
    const head = await commitAll(dir, 'source only');
    const changes = parseChanges(await diffText(dir, base, head));
    const result = await proveTests({ repo: dir, base, head, changes, runner: stubRunner(run([])) });
    expect(result.findings.map((f) => f.id)).toEqual(['no-test-results']);
  });

  it('treats only synthetic error cases (a build or start-up failure) like no results', async () => {
    const { dir, base, head, changes } = await repoWithNewTest();
    const synthetic: TestCaseResult = { id: '[cargo]::[build]', file: '[cargo]', name: '[build or run failed]', outcome: 'error' };
    const output = 'Compiling fx v0.1.0\nerror: could not compile `fx` due to 1 previous error\n';
    const result = await proveTests({ repo: dir, base, head, changes, runner: stubRunner(run([synthetic], 101, output), run([synthetic], 101, output)) });
    expect(result.findings).toEqual([
      { id: 'suite-failing', severity: 'fail', title: 'Test runner failed without reporting any test results', detail: 'error: could not compile `fx` due to 1 previous error' },
    ]);
  });

  it('says a run timed out, with and without partial results, at head and at base', async () => {
    const { dir, base, head, changes } = await repoWithNewTest();
    const timedOut = (cases: TestCaseResult[]): RunResult => ({ ...run(cases, 1, 'Command timed out after 5000 ms'), timedOut: true });
    const runOptions = { timeoutMs: 5000 };
    const empty = await proveTests({ repo: dir, base, head, changes, runOptions, runner: stubRunner(timedOut([]), timedOut([])) });
    expect(empty.findings).toEqual([
      { id: 'suite-failing', severity: 'fail', title: 'Test runner failed without reporting any test results', detail: 'timed out after 5 s' },
      { id: 'base-run-failed', severity: 'warn', title: 'Changed tests could not run at base; fail-before evidence unavailable (exit 1)', detail: 'timed out after 5 s' },
    ]);
    const partial = await proveTests({ repo: dir, base, head, changes, runOptions, runner: stubRunner(timedOut([tc('test/a.test.js', 'a', 'pass')])) });
    expect(partial.findings).toEqual([
      { id: 'suite-failing', severity: 'fail', title: 'Test suite fails at head (clean checkout)', detail: 'timed out after 5 s' },
    ]);
  });

  it('keeps the plain suite-failing finding when tests ran and failed', async () => {
    const { dir, base, head, changes } = await repoWithNewTest();
    const runner = stubRunner(run([tc('test/a.test.js', 'a', 'fail')], 1), run([tc('test/a.test.js', 'a', 'fail')], 1));
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(result.findings).toEqual([
      { id: 'suite-failing', severity: 'fail', title: 'Test suite fails at head (clean checkout)', detail: 'exit code 1' },
    ]);
  });
});

describe('proveTests regressions', () => {
  it('reruns the files of tests failing at head at base and reports those that passed there', async () => {
    const { dir, base, head, changes } = await repoWithExistingTests();
    const synthetic: TestCaseResult = { id: '[x]::[y]', file: '[x]', name: '[build]', outcome: 'error' };
    const headRun = run([tc('test/old.test.js', 'old', 'fail'), tc('test/flaky.test.js', 'flaky', 'fail'), pyCase('error'),
      tc('test/gone.test.js', 'gone', 'fail'), synthetic, tc('test/old.test.js', 'ok', 'pass')], 1);
    const baseRun = run([tc('test/old.test.js', 'old', 'pass'), tc('test/flaky.test.js', 'flaky', 'fail'), pyCase('pass')], 1);
    const { runner, calls } = recordingRunner(headRun, baseRun, headRun, baseRun);
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    const baseFiles = ['test/old.test.js', 'test/flaky.test.js', 'tests/test_mod.py'];
    expect(calls.map((c) => c.files)).toEqual([undefined, baseFiles, baseFiles, baseFiles]);
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
    const headRun = run([tc('test/a.test.js', 'a', 'pass'), tc('test/old.test.js', 'old', 'fail')], 1);
    const baseRun = run([tc('test/a.test.js', 'a', 'fail'), tc('test/old.test.js', 'old', 'pass')], 1);
    const { runner, calls } = recordingRunner(headRun, baseRun, headRun, baseRun);
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(calls[1]?.files).toEqual(['test/a.test.js', 'test/old.test.js']);
    expect(result.proofs.map((p) => [p.file, p.verdict])).toEqual([['test/a.test.js', 'proves-change']]);
    expect(result.findings).toEqual([suiteRed, regressed('test/old.test.js', 'old')]);
  });

  it('leaves out failing files that exist only at head, keeping the changed tests and their proofs', async () => {
    const { dir, base } = await makeRepo({ 'src/a.js': 'export const a = 1;\n' });
    await writeFiles(dir, { 'src/a.js': 'export const a = 2;\n', 'test/a.test.js': "it('a', () => {});\n", 'app/tests.py': 'def test_v(): assert False\n' });
    const head = await commitAll(dir, 'change');
    const changes = parseChanges(await diffText(dir, base, head));
    expect(changes.find((c) => c.path === 'app/tests.py')?.kind).toBe('source');
    const { runner, calls } = recordingRunner(
      run([tc('test/a.test.js', 'a', 'pass'), tc('app/tests.py', 'test_v', 'fail')], 1),
      run([tc('test/a.test.js', 'a', 'fail')], 1),
    );
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(calls[1]?.files).toEqual(['test/a.test.js']);
    expect(result.findings).toEqual([suiteRed]);
    expect(result.proofs.map((p) => [p.file, p.verdict])).toEqual([['test/a.test.js', 'proves-change']]);
  });

  it('does not run base when no tests changed and the only failing file exists only at head', async () => {
    const { dir, base } = await makeRepo({ 'src/a.js': 'export const a = 1;\n' });
    await writeFiles(dir, { 'src/a.js': 'export const a = 2;\n', 'app/tests.py': 'def test_v(): assert False\n' });
    const head = await commitAll(dir, 'change');
    const changes = parseChanges(await diffText(dir, base, head));
    const { runner, calls } = recordingRunner(run([tc('app/tests.py', 'test_v', 'fail')], 1), run([], 4, 'file or directory not found'));
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(calls).toHaveLength(1);
    expect(result.before).toBeUndefined();
    expect(result.findings).toEqual([suiteRed]);
    const worktrees = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: dir });
    expect(worktrees.stdout.match(/^worktree /gm)).toHaveLength(1);
  });

  it('leaves out the file of a regressed test the runner reported without one', async () => {
    const { dir, base, head, changes } = await repoWithExistingTests('pkg');
    const noFile: TestCaseResult = { id: 'nofile::x', file: '', name: 'x', outcome: 'fail' };
    const headRun = run([tc('test/old.test.js', 'old', 'fail'), noFile], 1);
    const baseRun = run([tc('test/old.test.js', 'old', 'pass'), { ...noFile, outcome: 'pass' }]);
    const { runner } = recordingRunner(headRun, baseRun, headRun, baseRun);
    const result = await proveTests({ repo: dir, base, head, changes, runner, root: 'pkg' });
    expect(result.findings).toEqual([
      suiteRed,
      regressed('pkg/test/old.test.js', 'old'),
      { id: 'test-regressed', severity: 'fail', title: 'Test passes at base and fails at head', detail: 'x' },
    ]);
  });

  it('dedupes a ./-prefixed failing file against the changed test files', async () => {
    const { dir, base, head, changes } = await repoWithNewTest();
    const headRun = run([tc('./test/a.test.js', 'a', 'fail')], 1);
    const baseRun = run([tc('./test/a.test.js', 'a', 'pass')]);
    const { runner, calls } = recordingRunner(headRun, baseRun, headRun, baseRun);
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(calls[1]?.files).toEqual(['test/a.test.js']);
    expect(result.findings).toEqual([suiteRed, regressed('test/a.test.js', 'a')]);
  });

  it('reports the repo path of a regressed test in a package root', async () => {
    const { dir, base, head, changes } = await repoWithExistingTests('pkg');
    const headRun = run([tc('test/old.test.js', 'old', 'fail')], 1);
    const baseRun = run([tc('test/old.test.js', 'old', 'pass')]);
    const { runner, calls } = recordingRunner(headRun, baseRun, headRun, baseRun);
    const result = await proveTests({ repo: dir, base, head, changes, runner, root: 'pkg' });
    expect(calls[1]?.files).toEqual(['test/old.test.js']);
    expect(result.findings).toEqual([suiteRed, regressed('pkg/test/old.test.js', 'old')]);
  });
});

describe('proveTests confirms regressions with a rerun', () => {
  const failing = run([tc('test/old.test.js', 'old', 'fail')], 1);
  const passing = run([tc('test/old.test.js', 'old', 'pass')]);
  const files = ['test/old.test.js'];

  it('reports test-regressed when the head and base reruns give the same results', async () => {
    const { dir, base, head, changes } = await repoWithExistingTests();
    const { runner, calls } = recordingRunner(failing, passing, failing, passing);
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(calls.map((c) => c.files)).toEqual([undefined, files, files, files]);
    expect(calls.map((c) => c.worktree === calls[0]?.worktree)).toEqual([true, false, true, false]);
    expect(result.findings).toEqual([suiteRed, regressed('test/old.test.js', 'old')]);
    expect(result.before?.cases).toEqual(passing.cases);
  });

  it('does not rerun at base when the test passes on a rerun at head', async () => {
    const { dir, base, head, changes } = await repoWithExistingTests();
    const { runner, calls } = recordingRunner(failing, passing, passing);
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(calls).toHaveLength(3);
    expect(result.findings).toEqual([suiteRed, notReproduced('test/old.test.js', 'old (rerun: pass at head, not run at base)')]);
  });

  it('reports a test that fails on the rerun at base too as not reproduced', async () => {
    const { dir, base, head, changes } = await repoWithExistingTests();
    const { runner } = recordingRunner(failing, passing, failing, failing);
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(result.findings).toEqual([suiteRed, notReproduced('test/old.test.js', 'old (rerun: fail at head, fail at base)')]);
  });

  it('says when a rerun reported no result for the test', async () => {
    const { dir, base, head, changes } = await repoWithExistingTests();
    const atHead = await proveTests({ repo: dir, base, head, changes, runner: recordingRunner(failing, passing, run([], 1, 'boom')).runner });
    expect(atHead.findings).toEqual([suiteRed, notReproduced('test/old.test.js', 'old (rerun: no result at head, not run at base)')]);
    const atBase = await proveTests({ repo: dir, base, head, changes, runner: recordingRunner(failing, passing, failing, run([], 1)).runner });
    expect(atBase.findings).toEqual([suiteRed, notReproduced('test/old.test.js', 'old (rerun: fail at head, no result at base)')]);
  });

  it('confirms each test on its own, in head order', async () => {
    const { dir, base, head, changes } = await repoWithExistingTests();
    const two = (a: TestCaseResult['outcome'], b: TestCaseResult['outcome']) =>
      run([tc('test/old.test.js', 'old', a), tc('test/flaky.test.js', 'flaky', b)], a === 'pass' && b === 'pass' ? 0 : 1);
    const { runner } = recordingRunner(two('fail', 'fail'), two('pass', 'pass'), two('fail', 'pass'), two('pass', 'pass'));
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(result.findings).toEqual([
      suiteRed,
      regressed('test/old.test.js', 'old'),
      notReproduced('test/flaky.test.js', 'flaky (rerun: pass at head, pass at base)'),
    ]);
  });

  it('does not rerun when no failing test passed at base', async () => {
    const { dir, base, head, changes } = await repoWithExistingTests();
    const { runner, calls } = recordingRunner(failing, failing);
    await proveTests({ repo: dir, base, head, changes, runner });
    expect(calls).toHaveLength(2);
  });
});

describe('proveTests copying test data into base', () => {
  it('never writes outside the base checkout through a symlinked directory', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    const { dir } = await makeRepo({ 'src/a.js': 'export const a = 1;\n' });
    await symlink(outside, join(dir, 'fixtures'), 'dir');
    const linked = await commitAll(dir, 'link fixtures');
    await rm(join(dir, 'fixtures'));
    await writeFiles(dir, { 'fixtures/x.json': '{}\n', 'test/a.test.js': "it('a', () => {});\n" });
    const head = await commitAll(dir, 'real fixtures');
    const changes = parseChanges(await diffText(dir, linked, head));
    expect(changes.map((c) => c.path)).toContain('fixtures/x.json');
    await proveTests({ repo: dir, base: linked, head, changes, runner: stubRunner(run([tc('test/a.test.js', 'a', 'pass')])) });
    expect(await readdir(outside)).toEqual([]);
  });
});

describe('proveTests copying test data into base (new folders)', () => {
  it('never creates folders outside the base checkout through a symlinked ancestor', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    const { dir } = await makeRepo({ 'src/a.js': 'export const a = 1;\n' });
    await symlink(outside, join(dir, 'fixtures'), 'dir');
    const linked = await commitAll(dir, 'link fixtures');
    await rm(join(dir, 'fixtures'));
    await writeFiles(dir, { 'fixtures/deep/nested/x.json': '{}\n', 'test/a.test.js': "it('a', () => {});\n" });
    const head = await commitAll(dir, 'real fixtures');
    const changes = parseChanges(await diffText(dir, linked, head));
    await proveTests({ repo: dir, base: linked, head, changes, runner: stubRunner(run([tc('test/a.test.js', 'a', 'pass')])) });
    expect(await readdir(outside)).toEqual([]);
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

    const wt = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: dir });
    expect(wt.stdout.split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
  }, 120_000);
});

describe('proveTests in a package root', () => {
  async function monorepo() {
    const { dir, base } = await makeRepo({ 'pkg/src/a.js': 'export const a = 1;\n', 'other/x.js': '1;\n' });
    await writeFiles(dir, {
      'pkg/src/a.js': 'export const a = 2;\n',
      'pkg/test/a.test.js': "// TestA lives here\nit('TestA', () => {});\n",
      'other/test/b.test.js': "it('b', () => {});\n",
    });
    const head = await commitAll(dir, 'change');
    return { dir, base, head, changes: parseChanges(await diffText(dir, base, head)) };
  }

  it('runs in <worktree>/<root> with root-relative files and config options; reports repo paths', async () => {
    const { dir, base, head, changes } = await monorepo();
    const calls: RunOptions[] = [];
    const seen: [string, string][] = [];
    const runner: Runner = {
      name: 'stub',
      detect: async () => 0,
      run: async (opts) => {
        calls.push(opts);
        // Ids that do not carry a file path, as Go or JVM runners report them.
        return run([{ id: 'pkg::TestA', file: 'pkg', name: 'TestA', outcome: calls.length === 1 ? 'pass' : 'fail' }], calls.length === 1 ? 0 : 1);
      },
      casesInFile: (c, file, readHead) => {
        seen.push([file, readHead(file).split('\n')[0]]);
        return readHead(file).includes(`it('${c.name}'`);
      },
    };
    const result = await proveTests({
      repo: dir, base, head, changes, runner, root: 'pkg',
      runOptions: { args: ['-v'], env: { A: 'b' }, timeoutMs: 1234 },
    });
    expect(calls.every((c) => c.worktree !== undefined && c.cwd === join(c.worktree, 'pkg'))).toBe(true);
    expect(calls.map((c) => [c.cwd.endsWith('/pkg'), c.files, c.args, c.env, c.timeoutMs])).toEqual([
      [true, undefined, ['-v'], { A: 'b' }, 1234],
      [true, ['test/a.test.js'], ['-v'], { A: 'b' }, 1234],
    ]);
    expect(seen).toContainEqual(['test/a.test.js', '// TestA lives here']);
    expect(result.proofs.map((p) => [p.file, p.name, p.verdict])).toEqual([['pkg/test/a.test.js', 'TestA', 'proves-change']]);
    expect(result.findings).toEqual([
      { id: 'tests-outside-root', severity: 'info', title: '1 changed test file is outside the package root pkg and was not run: other/test/b.test.js' },
    ]);
  });

  it('lists at most 3 changed tests outside the package root', async () => {
    const { dir, base } = await makeRepo({ 'pkg/src/a.js': 'export const a = 1;\n' });
    await writeFiles(dir, Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [`other/test/${n}.test.js`, `it('${n}', () => {});\n`])));
    const head = await commitAll(dir, 'tests elsewhere');
    const changes = parseChanges(await diffText(dir, base, head));
    const result = await proveTests({ repo: dir, base, head, changes, runner: stubRunner(run([tc('x', 'x', 'pass')])), root: 'pkg' });
    expect(result.findings).toEqual([
      {
        id: 'tests-outside-root',
        severity: 'info',
        title: '5 changed test files are outside the package root pkg and were not run: other/test/a.test.js, other/test/b.test.js, other/test/c.test.js and 2 more',
      },
    ]);
  });

  it('detects the runner in the head checkout of the package root when none is given', async () => {
    const { dir, base } = await makeRepo({ 'pkg/src/a.js': 'export const a = 1;\n' });
    await writeFiles(dir, { 'pkg/go.mod': 'module example.com/fx\n', 'pkg/src/a.js': 'export const a = 2;\n' });
    const head = await commitAll(dir, 'go module');
    const changes = parseChanges(await diffText(dir, base, head));
    const seen: string[] = [];
    const detecting: Runner = { name: 'probe', detect: async (root) => (seen.push(root), existsSync(join(root, 'go.mod')) ? 10 : 0), run: async () => run([tc('x', 'x', 'pass')]) };
    const result = await proveTests({ repo: dir, base, head, changes, root: 'pkg', detect: async (root) => ((await detecting.detect(root)) ? detecting : null) });
    expect(result.runner?.name).toBe('probe');
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(join(dir, 'pkg'));
    expect(seen[0]!.endsWith('/pkg')).toBe(true);
    const none = await proveTests({ repo: dir, base, head, changes, root: 'pkg', detect: async () => null });
    expect(none.runner).toBeNull();
    expect(none.after).toBeUndefined();
  });

  it('passes root-relative files to caseInFile when the runner has no hook', async () => {
    const { dir, base } = await makeRepo({ 'pkg/calc.py': 'x = 1\n' });
    await writeFiles(dir, { 'pkg/calc.py': 'x = 2\n', 'pkg/tests/test_a.py': 'def test_a():\n    pass\n' });
    const head = await commitAll(dir, 'change');
    const changes = parseChanges(await diffText(dir, base, head));
    // pytest reports module names relative to its rootdir (the package root), not the repo.
    const runner = stubRunner(run([tc('tests.test_a', 'test_a', 'pass')]), run([tc('tests.test_a', 'test_a', 'fail')], 1));
    const result = await proveTests({ repo: dir, base, head, changes, runner, root: 'pkg' });
    expect(result.proofs.map((p) => [p.file, p.verdict])).toEqual([['pkg/tests/test_a.py', 'proves-change']]);
  });

  it('errors when the package root does not exist at head', async () => {
    const { dir, base, head, changes } = await monorepo();
    await expect(proveTests({ repo: dir, base, head, changes, runner: stubRunner(run([])), root: 'nope' })).rejects.toThrow(
      'Package root "nope" does not exist at head',
    );
    const wt = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: dir });
    expect(wt.stdout.split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
  });
});

describe('proveTests setup command', () => {
  const pidsIn = async (file: string) => (await readFile(file, 'utf8')).trim().split('\n').map(Number);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('starts setup in each package root before its run and kills it afterwards', async () => {
    const { dir, base, head, changes } = await repoWithNewTest();
    const marks = await mkdtemp(join(tmpdir(), 'ar-marks-'));
    const sawSetup: boolean[] = [];
    let calls = 0;
    const runner: Runner = {
      name: 'stub',
      detect: async () => 0,
      run: async ({ cwd }) => {
        sawSetup.push(existsSync(join(cwd, 'setup-ran')));
        return calls++ === 0 ? run([tc('test/a.test.js', 'a', 'pass')]) : run([tc('test/a.test.js', 'a', 'fail')], 1);
      },
    };
    await proveTests({
      repo: dir, base, head, changes, runner,
      runOptions: { env: { MARKS: marks } },
      setup: { command: 'echo $$ >> "$MARKS/pids"; touch setup-ran; echo up; exec sleep 300', waitMs: 20_000, readyPattern: '^up$' },
    });
    expect(sawSetup).toEqual([true, true]);
    const pids = await pidsIn(join(marks, 'pids'));
    expect(pids).toHaveLength(2);
    expect(pids.filter(alive)).toEqual([]);
  });

  it('kills setup when the run throws', async () => {
    const { dir, base, head, changes } = await repoWithNewTest();
    const marks = await mkdtemp(join(tmpdir(), 'ar-marks-'));
    const runner: Runner = { name: 'stub', detect: async () => 0, run: async () => { throw new Error('runner exploded'); } };
    await expect(
      proveTests({
        repo: dir, base, head, changes, runner,
        runOptions: { env: { MARKS: marks } },
        setup: { command: 'echo $$ >> "$MARKS/pids"; exec sleep 300', waitMs: 200 },
      }),
    ).rejects.toThrow('runner exploded');
    expect((await pidsIn(join(marks, 'pids'))).filter(alive)).toEqual([]);
  });
});
