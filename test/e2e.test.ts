import { mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa, execaSync } from 'execa';
import { describe, expect, it } from 'vitest';
import { runVerify } from '../src/commands/verify.js';
import { buildProgram } from '../src/program.js';
import { branch, commitAll, linkNodeModules, makeRepo, writeFiles } from './helpers/repo.js';

const hasPytest = execaSync('python3', ['-m', 'pytest', '--version'], { reject: false }).exitCode === 0;

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
    const { receipt, exitCode } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('warn');
    expect(exitCode).toBe(0);
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

  it('WARN only for the new test when an existing test file gains one test', async () => {
    const dir = await scenario({
      'test/old.test.js': [
        "import { it, expect } from 'vitest';",
        "it('truth', () => expect(1).toBe(1));",
        "it('also true', () => expect(2).toBe(2));",
        '',
      ].join('\n'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    const loose = receipt.findings.filter((f) => f.id === 'test-passes-without-change');
    expect(loose.map((f) => [f.file, f.detail])).toEqual([['test/old.test.js', 'also true']]);
    expect(receipt.proofs.map((p) => p.name)).not.toContain('truth');
  });

  it('copies changed fixtures and snapshots into the base checkout', async () => {
    const dir = await scenario({
      'src/sum.js': 'export const sum = (a, b) => a + b;\n',
      'test/fixtures/v.json': '{ "v": 2 }\n',
      'test/fixture.test.js': [
        "import { it, expect } from 'vitest';",
        "import { readFileSync } from 'node:fs';",
        "it('reads fixture', () => expect(JSON.parse(readFileSync(new URL('./fixtures/v.json', import.meta.url), 'utf8')).v).toBe(2));",
        '',
      ].join('\n'),
      'test/snap.test.js': "import { it, expect } from 'vitest';\nit('snap', () => expect({ a: 1 }).toMatchSnapshot());\n",
      'test/__snapshots__/snap.test.js.snap': [
        '// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html',
        '',
        'exports[`snap 1`] = `',
        '{',
        '  "a": 1,',
        '}',
        '`;',
        '',
      ].join('\n'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.after?.exitCode).toBe(0);
    expect(receipt.proofs.map((p) => [p.name, p.before, p.verdict])).toEqual([
      ['reads fixture', 'pass', 'does-not-constrain'],
      ['snap', 'pass', 'does-not-constrain'],
    ]);
  });

  it('--quick reruns only changed test files and says so', async () => {
    const dir = await scenario({
      'src/sum.js': 'export const sum = (a, b) => a + b;\n',
      'test/sum.test.js': sumTest("it('adds', () => expect(sum(2, 3)).toBe(5));"),
    });
    const { receipt, output } = await runVerify({ cwd: dir, quick: true });
    expect(receipt.scope).toBe('changed');
    expect(receipt.after?.cases.map((c) => c.name)).toEqual(['adds']);
    expect(output).toContain('**Tests (clean checkout, changed files only):** 1 passed');
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

  it('rejects an unknown runner', async () => {
    const dir = await scenario({ 'README.md': '# hi\n' });
    await expect(runVerify({ cwd: dir, runner: 'nope' })).rejects.toThrow(/Unknown runner: nope/);
  });

  it('uses the merge-base for an explicit --base on a diverged branch', async () => {
    const { dir, base: branchPoint } = await makeRepo(BASE_FILES);
    await linkNodeModules(dir);
    await branch(dir, 'agent-change');
    await writeFiles(dir, { 'README.md': '# hi\n' });
    await commitAll(dir, 'agent change');
    await execa('git', ['checkout', '-q', 'main'], { cwd: dir });
    await writeFiles(dir, { 'later.js': 'export const later = 1;\n' });
    await commitAll(dir, 'main advances');
    await execa('git', ['checkout', '-q', 'agent-change'], { cwd: dir });
    const { receipt, output } = await runVerify({ cwd: dir, base: 'main', json: true });
    expect(receipt.base).toBe(branchPoint);
    expect(output).not.toContain('later.js');
  });

  it('CLI exits 2 with a message on a bad base', async () => {
    const dir = await scenario({ 'README.md': '# hi\n' });
    const cwd = process.cwd();
    const prev = process.exitCode;
    process.chdir(dir);
    try {
      await buildProgram().parseAsync(['node', 'trustbut', 'verify', '--base', 'does-not-exist']);
      expect(process.exitCode).toBe(2);
    } finally {
      process.chdir(cwd);
      process.exitCode = prev;
    }
  });
});

describe.skipIf(!hasPytest)('trustbut verify with pytest (end to end)', () => {
  it('PASS: src-layout package fix proven by a pytest test, reported by repo path', async () => {
    const { dir } = await makeRepo({
      'pyproject.toml': '[tool.pytest.ini_options]\n',
      'src/calc/__init__.py': 'def add(a, b):\n    return a - b\n',
      'tests/test_old.py': 'def test_truth():\n    assert True\n',
    });
    await branch(dir, 'agent-change');
    await writeFiles(dir, {
      'src/calc/__init__.py': 'def add(a, b):\n    return a + b\n',
      'tests/test_add.py': 'from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n',
    });
    await commitAll(dir, 'fix add');
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.runner).toBe('pytest');
    expect(receipt.after?.exitCode).toBe(0);
    expect(receipt.proofs.map((p) => [p.file, p.name, p.before, p.verdict])).toEqual([
      ['tests/test_add.py', 'test_add', 'fail', 'proves-change'],
    ]);
    expect(receipt.verdict).toBe('pass');
  }, 120_000);
});

describe('trustbut verify with a package root', () => {
  const APP = {
    'package.json': JSON.stringify({ name: 'app', private: true, type: 'module', devDependencies: { vitest: '*' } }),
    'src/sum.js': 'export const sum = (a, b) => a - b;\n',
    'test/old.test.js': "import { it, expect } from 'vitest';\nit('truth', () => expect(1).toBe(1));\n",
  };
  const prefixed = (prefix: string, files: Record<string, string>) =>
    Object.fromEntries(Object.entries(files).map(([k, v]) => [`${prefix}${k}`, v]));

  async function monorepo(extra: Record<string, string> = {}) {
    const { dir } = await makeRepo({ '.gitignore': 'node_modules\n', 'README.md': '# mono\n', ...prefixed('packages/app/', APP), ...extra });
    // Dependencies installed only inside the package, as in a workspace without hoisting.
    await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(dir, 'packages/app/node_modules'), 'dir');
    await branch(dir, 'agent-change');
    await writeFiles(dir, {
      'packages/app/src/sum.js': 'export const sum = (a, b) => a + b;\n',
      'packages/app/test/sum.test.js': sumTest("it('adds', () => expect(sum(2, 3)).toBe(5));"),
    });
    await commitAll(dir, 'fix sum');
    return dir;
  }

  it('PASS: proves a fix in packages/app configured through .trustbut.json', async () => {
    const dir = await monorepo({ '.trustbut.json': JSON.stringify({ root: 'packages/app' }) });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.runner).toBe('vitest');
    expect(receipt.after?.exitCode).toBe(0);
    expect(receipt.proofs.map((p) => [p.file, p.name, p.before, p.verdict])).toEqual([
      ['packages/app/test/sum.test.js', 'adds', 'fail', 'proves-change'],
    ]);
    expect(receipt.verdict).toBe('pass');
  }, 120_000);

  it('--root overrides the config root', async () => {
    const dir = await monorepo({ '.trustbut.json': JSON.stringify({ root: 'elsewhere' }) });
    const { receipt } = await runVerify({ cwd: dir, root: 'packages/app/' });
    expect(receipt.proofs.map((p) => [p.file, p.verdict])).toEqual([['packages/app/test/sum.test.js', 'proves-change']]);
  }, 120_000);
});

describe('trustbut verify with the generic command runner', () => {
  // A toy test runner: each test file names the value it expects in src/value.txt.
  const RUN_SH = [
    'files="$*"',
    '[ -n "$files" ] || files=$(ls tests/test_*.py)',
    '[ -f setup-ran ] || { echo "setup did not run" >&2; exit 2; }',
    'status=0',
    '{',
    '  echo \'<?xml version="1.0"?><testsuites><testsuite name="toy">\'',
    '  for f in $files; do',
    '    want=$(sed -n \'s/.*EXPECT=//p\' "$f")',
    '    if [ "$(cat src/value.txt)" = "$want" ]; then echo "<testcase name=\\"value\\" file=\\"$f\\"/>";',
    '    else echo "<testcase name=\\"value\\" file=\\"$f\\"><failure/></testcase>"; status=1; fi',
    '  done',
    '  echo "</testsuite></testsuites>"',
    '} > out/junit.xml',
    'exit $status',
    '',
  ].join('\n');

  it('PASS: proves a change through JUnit XML written by a shell script, with a setup that is killed afterwards', async () => {
    const marks = await mkdtemp(join(tmpdir(), 'ar-marks-'));
    const { dir } = await makeRepo({
      'run.sh': RUN_SH,
      'out/.keep': '',
      'src/value.txt': 'old\n',
      'tests/test_existing.py': '# EXPECT=old-or-new\n',
      '.trustbut.json': JSON.stringify({
        command: 'sh run.sh {files}',
        junit: 'out/junit.xml',
        setup: 'echo $$ >> "$MARKS/pids"; touch setup-ran; echo listening; exec sleep 300',
        setupReadyPattern: 'listening',
        setupWaitSec: 30,
        env: { MARKS: marks },
      }),
    });
    await branch(dir, 'agent-change');
    await writeFiles(dir, { 'src/value.txt': 'new\n', 'tests/test_existing.py': '# EXPECT=new\n', 'tests/test_value.py': '# EXPECT=new\n' });
    await commitAll(dir, 'change value');

    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.runner).toBe('command');
    expect(receipt.after?.exitCode).toBe(0);
    expect(receipt.proofs.map((p) => [p.file, p.before, p.verdict])).toEqual([
      ['tests/test_existing.py', 'fail', 'proves-change'],
      ['tests/test_value.py', 'fail', 'proves-change'],
    ]);
    const pids = (await readFile(join(marks, 'pids'), 'utf8')).trim().split('\n').map(Number);
    expect(pids).toHaveLength(2);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(pids.filter(alive)).toEqual([]);
  }, 120_000);

  it('errors when runner is "command" without a command', async () => {
    const dir = await scenario({ '.trustbut.json': JSON.stringify({ runner: 'command' }) });
    await expect(runVerify({ cwd: dir })).rejects.toThrow(/needs a "command"/);
  });
});

describe('trustbut verify config errors', () => {
  it('rejects unknown keys in .trustbut.json', async () => {
    const dir = await scenario({ '.trustbut.json': JSON.stringify({ rooot: 'x' }) });
    await expect(runVerify({ cwd: dir })).rejects.toThrow(/Unknown keys in \.trustbut\.json: rooot\. Allowed keys: root, runner/);
  });

  it('rejects an unknown runner from config', async () => {
    const dir = await scenario({ '.trustbut.json': JSON.stringify({ runner: 'nope' }) });
    await expect(runVerify({ cwd: dir })).rejects.toThrow(/Unknown runner: nope/);
  });

  it('reads --config relative to cwd', async () => {
    const dir = await scenario({ 'README.md': '# hi\n' });
    await writeFiles(dir, { 'cfg/bad.json': JSON.stringify({ timeoutSec: -1 }) });
    await expect(runVerify({ cwd: dir, config: 'cfg/bad.json' })).rejects.toThrow(/"timeoutSec" must be a positive number/);
  });
});
