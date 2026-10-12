import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChanges } from '../src/diff.js';
import { diffText } from '../src/git.js';
import { buildProofs, caseInFile, proveTests } from '../src/proof.js';
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
function stubRunner(head: RunResult, base?: RunResult): Runner {
  let calls = 0;
  return { name: 'vitest', detect: async () => 0, run: async () => (calls++ === 0 ? head : (base ?? run([]))) };
}

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

  it('keeps the plain suite-failing finding when tests ran and failed', async () => {
    const { dir, base, head, changes } = await repoWithNewTest();
    const runner = stubRunner(run([tc('test/a.test.js', 'a', 'fail')], 1), run([tc('test/a.test.js', 'a', 'fail')], 1));
    const result = await proveTests({ repo: dir, base, head, changes, runner });
    expect(result.findings).toEqual([
      { id: 'suite-failing', severity: 'fail', title: 'Test suite fails at head (clean checkout)', detail: 'exit code 1' },
    ]);
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
    expect(result.findings).toEqual([]);
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
