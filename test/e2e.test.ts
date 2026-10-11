import { execa } from 'execa';
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
    await expect(runVerify({ cwd: dir, runner: 'jest' as never })).rejects.toThrow(/Unknown runner: jest/);
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
