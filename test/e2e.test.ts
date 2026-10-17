import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { runVerify } from './helpers/verify.js';
import { buildProgram } from '../src/program.js';
import { renderMarkdown } from '../src/render.js';
import { toAgentReceipt } from '../src/spec/serialize.js';
import { VERSION } from '../src/version.js';
import { branch, commitAll, linkNodeModules, makeRepo, writeFiles } from './helpers/repo.js';
import { hasTool, requiredTools } from './helpers/toolchain.js';

const hasPytest = hasTool('python3', ['-m', 'pytest', '--version']) || requiredTools().has('pytest');

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
    expect(receipt.proofs.map((p) => p.verdict)).toContain('does-not-constrain');
    expect(receipt.findings.filter((f) => f.id === 'change-not-proven')).toEqual([
      { id: 'change-not-proven', severity: 'warn', title: 'Nothing proves the change', detail: '1 new or changed test, none fails without the change' },
    ]);
    expect(renderMarkdown(receipt)).toContain('**Proof:** nothing proves this change ⚠');
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

  it('INFO, not FAIL-regressed: a test that failed once at head and passed on the rerun', async () => {
    // The marker file outside the repo makes the test fail on its first run only, wherever it runs.
    const mark = join(await mkdtemp(join(tmpdir(), 'trustbut-flaky-')), 'ran');
    const { dir } = await makeRepo({
      ...BASE_FILES,
      'test/flaky.test.js': [
        "import { it } from 'vitest';",
        "import { existsSync, writeFileSync } from 'node:fs';",
        `const mark = ${JSON.stringify(mark)};`,
        "it('fails once', () => {",
        "  if (!existsSync(mark)) { writeFileSync(mark, ''); throw new Error('first run'); }",
        '});',
        '',
      ].join('\n'),
    });
    await linkNodeModules(dir);
    await branch(dir, 'agent-change');
    await writeFiles(dir, { 'src/sum.js': 'export const sum = (a, b) => a + b;\n' });
    await commitAll(dir, 'agent change');
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.findings.map((f) => f.id)).not.toContain('test-regressed');
    expect(receipt.findings.filter((f) => f.id === 'trustbut/regression-not-reproduced').map((f) => [f.severity, f.file, f.detail])).toEqual([
      ['info', 'test/flaky.test.js', 'fails once (rerun: pass at head, not run at base)'],
    ]);
  });

  it('a type-test file counts as a changed test, and its @ts-expect-error is not an escape', async () => {
    const dir = await scenario({
      'src/sum.js': 'export const sum = (a, b) => a + b;\n',
      'test-dts/sum.d-test.ts': "import { sum } from '../src/sum.js';\n// @ts-expect-error -- sum takes numbers\nsum('a', 1);\n",
    });
    const { receipt } = await runVerify({ cwd: dir });
    const ids = receipt.findings.map((f) => f.id);
    for (const id of ['escape-added', 'base-run-failed', 'proofs-unmatched']) expect(ids, id).not.toContain(id);
    // The type test is a changed test file, so the detail is not "no test added or changed"; no runner runs it, so it proves nothing.
    expect(receipt.proofs).toEqual([]);
    expect(receipt.findings).toEqual([
      { id: 'change-not-proven', severity: 'warn', title: 'Nothing proves the change', detail: 'test files changed, but no new or changed test that ran was found in them' },
    ]);
    expect(receipt.verdict).toBe('warn');
  });

  it('no escape-added in files .gitattributes marks linguist-generated', async () => {
    const dir = await scenario({
      '.gitattributes': 'gen/** linguist-generated=true\n',
      'gen/client.ts': 'export const c = {} as any;\n',
      'src/client.ts': 'export const d = {} as any;\n',
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.findings.filter((f) => f.id === 'escape-added').map((f) => f.file)).toEqual(['src/client.ts']);
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
    const loose = receipt.proofs.filter((p) => p.verdict === 'does-not-constrain');
    expect(loose.map((p) => [p.file, p.name])).toEqual([['test/old.test.js', 'also true']]);
    expect(receipt.proofs.map((p) => p.name)).not.toContain('truth');
  });

  it('WARN: a changed .trustbut.json is flagged and ranked as verification config', async () => {
    const dir = await scenario({ '.trustbut.json': JSON.stringify({ timeoutSec: 600 }) });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.findings).toContainEqual({ id: 'test-config-changed', severity: 'warn', title: 'Test or coverage config changed', file: '.trustbut.json' });
    expect(receipt.risks[0]).toEqual({ file: '.trustbut.json', score: 5, reasons: ['verification config', 'has findings'] });
    expect(receipt.verdict).toBe('warn');
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

  it('does not copy changed source code under a spec/ folder into the base checkout', async () => {
    const dir = await scenario({
      'src/spec/double.js': 'export const double = (n) => n * 2;\n',
      'test/double.test.js': [
        "import { it, expect } from 'vitest';",
        "import { double } from '../src/spec/double.js';",
        "it('doubles', () => expect(double(2)).toBe(4));",
        '',
      ].join('\n'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.proofs.map((p) => [p.name, p.verdict])).toEqual([['doubles', 'proves-change']]);
    expect(receipt.proofs.map((p) => p.verdict)).not.toContain('does-not-constrain');
  });

  it('still copies changed code fixtures under fixtures/ into the base checkout', async () => {
    const dir = await scenario({
      'fixtures/data.js': 'export const value = 2;\n',
      'test/data.test.js': [
        "import { it, expect } from 'vitest';",
        "import { value } from '../fixtures/data.js';",
        "it('reads data', () => expect(value).toBe(2));",
        '',
      ].join('\n'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.proofs.map((p) => [p.name, p.verdict])).toEqual([['reads data', 'does-not-constrain']]);
  });

  it('still copies changed test helpers under spec/ into the base checkout', async () => {
    const dir = await scenario({
      'spec/helpers/make.js': 'export const make = () => 2;\n',
      'test/make.test.js': [
        "import { it, expect } from 'vitest';",
        "import { make } from '../spec/helpers/make.js';",
        "it('makes two', () => expect(make()).toBe(2));",
        '',
      ].join('\n'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.proofs.map((p) => [p.name, p.verdict])).toEqual([['makes two', 'does-not-constrain']]);
  });

  it('WARN: a declared dependency is not installed', async () => {
    const dir = await scenario({
      'package.json': JSON.stringify({ name: 'fx', private: true, type: 'module', devDependencies: { vitest: '*' }, dependencies: { 'not-installed-zzz': '1' } }),
      'src/sum.js': 'export const sum = (a, b) => a + b;\n',
    });
    const { receipt, output } = await runVerify({ cwd: dir });
    const f = receipt.findings.find((x) => x.id === 'deps-not-installed');
    expect(f?.severity).toBe('warn');
    expect(output).toContain('not-installed-zzz');
    expect(output).toContain('Declared dependencies');
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
    await expect(runVerify({ cwd: dir })).rejects.toThrow(
      /No changes between base and head \(this branch may already be merged into main\)\. Try --base HEAD~1.*--working/,
    );
  });

  it('prints JSON with --json: an agent receipt v1', async () => {
    const dir = await scenario({ 'README.md': '# hi\n' });
    const { output } = await runVerify({ cwd: dir, json: true });
    const json = JSON.parse(output);
    expect(json).toMatchObject({ specVersion: '1.2', producer: { name: 'trustbut', version: VERSION }, verdict: 'pass' });
    expect(json).not.toHaveProperty('version');
    expect(output).not.toContain('"output"');
  });

  it('--output-tail puts the end of a failed head run in the JSON receipt', async () => {
    const dir = await scenario({ 'test/old.test.js': "import { it, expect } from 'vitest';\nit('truth', () => expect(1).toBe(2));\n" });
    const { output } = await runVerify({ cwd: dir, json: true, outputTail: true });
    const json = JSON.parse(output);
    expect(json['x-trustbut'].after.outputTail).toContain('JUNIT report written');
    const plain = JSON.parse((await runVerify({ cwd: dir, json: true })).output);
    expect(plain['x-trustbut'].after).not.toHaveProperty('outputTail');
  });

  it('registers the verify command', () => {
    expect(buildProgram().commands.map((c) => c.name())).toContain('verify');
  });

  it('rejects an unknown runner', async () => {
    const dir = await scenario({ 'README.md': '# hi\n' });
    await expect(runVerify({ cwd: dir, runner: 'nope' })).rejects.toThrow(/Unknown runner: nope\. Supported: .*\bcommand\b/);
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

  it('PASS: a workspace member installed editable from the checkout is imported from the base worktree at base', async () => {
    const { dir } = await makeRepo({
      'pyproject.toml': '[tool.pytest.ini_options]\n',
      'packages/lib/src/wslib/__init__.py': 'def double(x):\n    return x + x + 1\n',
      'tests/test_old.py': 'def test_truth():\n    assert True\n',
    });
    await branch(dir, 'agent-change');
    await writeFiles(dir, {
      'packages/lib/src/wslib/__init__.py': 'def double(x):\n    return x + x\n',
      'tests/test_double.py': 'from wslib import double\n\ndef test_double():\n    assert double(2) == 4\n',
    });
    await commitAll(dir, 'fix double');
    // An editable install of the workspace member from the user's checkout, as uv/pip -e would write it.
    const venv = await mkdtemp(join(tmpdir(), 'trustbut-venv-'));
    await execa('python3', ['-m', 'venv', '--system-site-packages', venv]);
    const { stdout: site } = await execa(join(venv, 'bin', 'python'), ['-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])']);
    await writeFile(join(site.trim(), '_wslib.pth'), `${join(dir, 'packages/lib/src')}\n`);
    const prev = process.env.TRUSTBUT_PYTHON;
    process.env.TRUSTBUT_PYTHON = join(venv, 'bin', 'python');
    try {
      const { receipt } = await runVerify({ cwd: dir });
      expect(receipt.proofs.map((p) => [p.file, p.name, p.before, p.verdict])).toEqual([
        ['tests/test_double.py', 'test_double', 'fail', 'proves-change'],
      ]);
    } finally {
      if (prev === undefined) delete process.env.TRUSTBUT_PYTHON;
      else process.env.TRUSTBUT_PYTHON = prev;
      await rm(venv, { recursive: true, force: true });
    }
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

  it('errors (exit 2) when the package root does not exist at head, instead of a no-runner WARN', async () => {
    const dir = await monorepo();
    await expect(runVerify({ cwd: dir, root: 'packages/nope' })).rejects.toThrow('Package root "packages/nope" does not exist at head');
    const cfg = await monorepo({ '.trustbut.json': JSON.stringify({ root: 'packages/typo' }) });
    await expect(runVerify({ cwd: cfg })).rejects.toThrow('Package root "packages/typo" does not exist at head');
  });

  it('reports a changed test outside the package root as not run (info)', async () => {
    const dir = await monorepo({ '.trustbut.json': JSON.stringify({ root: 'packages/app' }) });
    await writeFiles(dir, { 'packages/other/test/x.test.js': "it('x', () => {});\n", 'tools/a.test.js': "it('a', () => {});\n" });
    await commitAll(dir, 'tests elsewhere');
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.findings).toContainEqual({
      id: 'tests-outside-root',
      severity: 'info',
      title: '2 changed test files are outside the package root packages/app and were not run: packages/other/test/x.test.js, tools/a.test.js',
    });
  }, 120_000);

  it('copies changed test helpers under a package named app into the base checkout', async () => {
    const dir = await monorepo({ '.trustbut.json': JSON.stringify({ root: 'packages/app' }) });
    await writeFiles(dir, {
      'packages/app/spec/helpers/make.js': 'export const make = () => 2;\n',
      'packages/app/test/make.test.js': [
        "import { it, expect } from 'vitest';",
        "import { make } from '../spec/helpers/make.js';",
        "it('makes two', () => expect(make()).toBe(2));",
        '',
      ].join('\n'),
    });
    await commitAll(dir, 'helper');
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.proofs.map((p) => [p.name, p.verdict])).toEqual([
      ['makes two', 'does-not-constrain'],
      ['adds', 'proves-change'],
    ]);
    expect(receipt.findings.map((f) => f.id)).not.toContain('base-run-failed');
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

  it('PASS: absolute JUnit file paths still pair base and head results (the new test is recorded as passing at base; no code changed)', async () => {
    const script = 'echo "<testsuite name=\\"s\\"><testcase name=\\"v\\" file=\\"$PWD/tests/test_v.py\\"/></testsuite>"';
    const { dir } = await makeRepo({ 'src/value.txt': 'old\n', 'tests/test_old.py': '# old\n', '.trustbut.json': JSON.stringify({ command: script }) });
    await branch(dir, 'agent-change');
    await writeFiles(dir, { 'src/value.txt': 'new\n', 'tests/test_v.py': '# always passes\n' });
    await commitAll(dir, 'change value');
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.proofs.map((p) => [p.file, p.before, p.verdict, p.weak])).toEqual([['tests/test_v.py', 'pass', 'does-not-constrain', false]]);
    expect(receipt.verdict).toBe('pass');
  });

  it('WARN: the command exits 0 without writing results (no-test-results), even though tests changed', async () => {
    const { dir } = await makeRepo({ 'src/value.txt': 'old\n', 'tests/test_existing.py': '# EXPECT=old\n', '.trustbut.json': JSON.stringify({ command: 'true', junit: 'out/junit.xml' }) });
    await branch(dir, 'agent-change');
    await writeFiles(dir, { 'src/value.txt': 'new\n', 'tests/test_value.py': '# EXPECT=new\n' });
    await commitAll(dir, 'change value');
    const { receipt, exitCode } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('warn');
    expect(exitCode).toBe(0);
    expect(receipt.findings.map((f) => [f.id, f.severity])).toEqual(
      expect.arrayContaining([['no-test-results', 'warn'], ['proofs-unmatched', 'warn']]),
    );
  });

  it('errors when runner is "command" without a command', async () => {
    const dir = await scenario({ '.trustbut.json': JSON.stringify({ runner: 'command' }) });
    await expect(runVerify({ cwd: dir })).rejects.toThrow(/needs a "command"/);
  });
});

describe('trustbut verify runner detection', () => {
  it('detects the runner from the head commit, not the checked-out working tree', async () => {
    const { dir } = await makeRepo({ '.gitignore': 'node_modules\n', 'src/sum.js': 'export const sum = (a, b) => a - b;\n' });
    await linkNodeModules(dir);
    await branch(dir, 'agent-change');
    await writeFiles(dir, {
      'package.json': BASE_FILES['package.json'],
      'src/sum.js': 'export const sum = (a, b) => a + b;\n',
      'test/sum.test.js': sumTest("it('adds', () => expect(sum(2, 3)).toBe(5));"),
    });
    await commitAll(dir, 'add vitest and a fix');
    await execa('git', ['checkout', '-q', 'main'], { cwd: dir });
    const { receipt } = await runVerify({ cwd: dir, base: 'main', head: 'agent-change' });
    expect(receipt.runner).toBe('vitest');
    expect(receipt.findings.map((f) => f.id)).not.toContain('no-runner');
    expect(receipt.proofs.map((p) => [p.file, p.verdict])).toEqual([['test/sum.test.js', 'proves-change']]);
  }, 120_000);

  it('still warns no-runner when head has no runner files', async () => {
    const dir = await scenario({ 'package.json': JSON.stringify({ name: 'fx', private: true }), 'README.md': '# x\n' });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.runner).toBeNull();
    expect(receipt.findings.map((f) => f.id)).toContain('no-runner');
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

describe('trustbut verify --working', () => {
  it('PASS: uncommitted fix + untracked test, repo state untouched', async () => {
    const { dir } = await makeRepo(BASE_FILES);
    await linkNodeModules(dir);
    await branch(dir, 'agent-change');
    await writeFiles(dir, { 'src/sum.js': 'export const sum = (a, b) => a + b;\n', 'test/sum.test.js': sumTest("it('adds', () => expect(sum(2, 3)).toBe(5));") });
    const snapshot = async () => ({
      status: (await execa('git', ['status', '--porcelain'], { cwd: dir })).stdout,
      index: (await execa('git', ['ls-files', '-s'], { cwd: dir })).stdout,
    });
    const before = await snapshot();
    const { receipt, output } = await runVerify({ cwd: dir, base: 'main', working: true });
    expect(receipt.verdict).toBe('pass');
    expect(receipt.headRef).toBe('working tree');
    expect(receipt.findings.map((f) => f.id)).not.toContain('uncommitted-changes');
    expect(output).toContain('→ working tree');
    expect(await snapshot()).toEqual(before);
  });

  it('errors (exit 2) when the working tree has nothing to verify', async () => {
    const { dir } = await makeRepo(BASE_FILES);
    await branch(dir, 'agent-change');
    await expect(runVerify({ cwd: dir, base: 'main', working: true })).rejects.toThrow(/^No changes between base and head/);
  });

  it('errors when head differs from base by commits but not by content', async () => {
    const { dir } = await makeRepo(BASE_FILES);
    await branch(dir, 'agent-change');
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'empty'], { cwd: dir });
    await expect(runVerify({ cwd: dir })).rejects.toThrow(/^No changes between base and head/);
  });

  it('rejects --working together with --head', async () => {
    const { dir } = await makeRepo(BASE_FILES);
    await expect(runVerify({ cwd: dir, working: true, head: 'main' })).rejects.toThrow(/--working.*--head/);
  });
});

describe('--receipt-json / --receipt-md', () => {
  it('writes both receipts (creating parent dirs) alongside normal output', async () => {
    const dir = await scenario({
      'src/sum.js': 'export const sum = (a, b) => a + b;\n',
      'test/sum.test.js': sumTest("it('adds', () => expect(sum(2, 3)).toBe(5));"),
    });
    const out = await mkdtemp(join(tmpdir(), 'ar-out-'));
    const jsonPath = join(out, 'a/b/receipt.json');
    const mdPath = join(out, 'c/receipt.md');
    const { receipt, output } = await runVerify({ cwd: dir, receiptJson: jsonPath, receiptMd: mdPath });
    expect(JSON.parse(await readFile(jsonPath, 'utf8'))).toEqual(JSON.parse(JSON.stringify(toAgentReceipt(receipt))));
    expect(await readFile(mdPath, 'utf8')).toBe(output);
  });

  it('writes the markdown file even with --json, and still writes on FAIL', async () => {
    const dir = await scenario({
      'test/old.test.js': "import { it, expect } from 'vitest';\nit.only('truth', () => expect(1).toBe(1));\n",
    });
    const out = await mkdtemp(join(tmpdir(), 'ar-out-'));
    const mdPath = join(out, 'r.md');
    const jsonPath = join(out, 'r.json');
    const r = await runVerify({ cwd: dir, json: true, receiptMd: mdPath, receiptJson: jsonPath });
    expect(r.exitCode).toBe(1);
    expect(r.receipt.verdict).toBe('fail');
    expect(await readFile(mdPath, 'utf8')).toContain('FAIL');
    expect(JSON.parse(await readFile(jsonPath, 'utf8')).verdict).toBe('fail');
  });

  it('does not write files on a usage error', async () => {
    const out = await mkdtemp(join(tmpdir(), 'ar-out-'));
    const jsonPath = join(out, 'r.json');
    const { dir } = await makeRepo(BASE_FILES);
    await expect(runVerify({ cwd: dir, base: 'nope', receiptJson: jsonPath })).rejects.toThrow();
    await expect(readFile(jsonPath, 'utf8')).rejects.toThrow();
  });

  it('reports write failures in writeErrors, keeping the receipt and verdict exit code', async () => {
    const dir = await scenario({
      'src/sum.js': 'export const sum = (a, b) => a + b;\n',
      'test/sum.test.js': sumTest("it('adds', () => expect(sum(2, 3)).toBe(5));"),
    });
    const out = await mkdtemp(join(tmpdir(), 'ar-out-'));
    await writeFile(join(out, 'file'), 'x');
    const bad = join(out, 'file', 'r.json');
    const r = await runVerify({ cwd: dir, receiptJson: bad });
    expect(r.exitCode).toBe(0);
    expect(r.receipt.verdict).toBe('pass');
    expect(r.writeErrors).toHaveLength(1);
    expect(r.writeErrors[0]!.path).toBe(bad);
  });

  it('CLI: verify --receipt-json writes the file; a failed write prints the receipt first, then exits 2', async () => {
    const dir = await scenario({
      'src/sum.js': 'export const sum = (a, b) => a + b;\n',
      'test/sum.test.js': sumTest("it('adds', () => expect(sum(2, 3)).toBe(5));"),
    });
    const out = await mkdtemp(join(tmpdir(), 'ar-out-'));
    const good = join(out, 'sub/r.json');
    await writeFile(join(out, 'file'), 'x');
    const bad = join(out, 'file', 'r.json');
    const cap = { out: '', err: '' };
    const so = process.stdout.write.bind(process.stdout);
    const se = process.stderr.write.bind(process.stderr);
    const prevCwd = process.cwd();
    const prevCode = process.exitCode;
    process.chdir(dir);
    process.stdout.write = ((c: string) => ((cap.out += c), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: string) => ((cap.err += c), true)) as typeof process.stderr.write;
    try {
      await buildProgram().parseAsync(['node', 'trustbut', 'verify', '--receipt-json', good, '--receipt-md', bad]);
      expect(process.exitCode).toBe(2);
    } finally {
      process.stdout.write = so;
      process.stderr.write = se;
      process.chdir(prevCwd);
      process.exitCode = prevCode;
    }
    expect(cap.out).toContain('Receipt: PASS');
    expect(cap.err).toContain(`trustbut: couldn't write receipt to ${bad}:`);
    expect(JSON.parse(await readFile(good, 'utf8')).verdict).toBe('pass');
  });

  it('CLI flags are registered on verify', () => {
    const verify = buildProgram().commands.find((c) => c.name() === 'verify')!;
    const flags = verify.options.map((o) => o.long);
    expect(flags).toContain('--receipt-json');
    expect(flags).toContain('--receipt-md');
  });
});
