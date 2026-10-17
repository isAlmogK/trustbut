import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jest, parseJestJson } from '../src/runners/jest.js';
import { detectRunner } from '../src/runners/registry.js';
import { runVerify } from './helpers/verify.js';
import { branch, commitAll, linkNodeModules, makeRepo, writeFiles } from './helpers/repo.js';
import { hasTool, requiredTools } from './helpers/toolchain.js';

async function pkg(json: object, files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ar-jest-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify(json));
  for (const [f, c] of Object.entries(files)) await writeFile(join(dir, f), c);
  return dir;
}

describe('jest detection', () => {
  it('scores 10 for jest alone, 9 when vitest is also present; vitest wins then', async () => {
    expect(await jest.detect(await pkg({ devDependencies: { jest: '^29' } }))).toBe(10);
    expect(await jest.detect(await pkg({ jest: { testEnvironment: 'node' } }))).toBe(10);
    expect(await jest.detect(await pkg({}, { 'jest.config.js': 'module.exports = {};' }))).toBe(10);
    expect(await jest.detect(await pkg({ name: 'x' }))).toBe(0);
    const both = await pkg({ devDependencies: { jest: '^29', vitest: '^3' } });
    expect(await jest.detect(both)).toBe(9);
    expect((await detectRunner(both))?.name).toBe('vitest');
  });

  it('picks jest for a jest-expo preset without installing it', async () => {
    const dir = await pkg({ name: 'app', jest: { preset: 'jest-expo' } });
    expect((await detectRunner(dir))?.name).toBe('jest');
    const rn = await pkg({ name: 'app', jest: { preset: 'react-native' } });
    expect((await detectRunner(rn))?.name).toBe('jest');
  });
});

describe('parseJestJson', () => {
  it('maps statuses, makes files relative and reports unrunnable suites as errors', () => {
    const json = JSON.stringify({
      testResults: [
        {
          name: '/wt/pkg/test/a.test.js',
          status: 'failed',
          assertionResults: [
            { fullName: 'a works', status: 'passed' },
            { fullName: 'a breaks', status: 'failed' },
            { fullName: 'a later', status: 'pending' },
            { fullName: 'a todo', status: 'todo' },
          ],
        },
        { name: '/wt/pkg/test/b.test.js', status: 'failed', assertionResults: [] },
      ],
    });
    expect(parseJestJson(json, '/wt/pkg').map((c) => [c.id, c.outcome])).toEqual([
      ['test/a.test.js::a works', 'pass'],
      ['test/a.test.js::a breaks', 'fail'],
      ['test/a.test.js::a later', 'skip'],
      ['test/a.test.js::a todo', 'skip'],
      ['test/b.test.js::test/b.test.js', 'error'],
    ]);
  });
});

const runJest = hasTool('node') || requiredTools().has('node');
describe.skipIf(!runJest)('trustbut verify with jest (end to end)', () => {
  const BASE = {
    '.gitignore': 'node_modules\n',
    'package.json': JSON.stringify({ name: 'fx', private: true, devDependencies: { jest: '*' } }),
    'src/sum.js': 'exports.sum = (a, b) => a - b;\n',
    'test/old.test.js': "test('truth', () => expect(1).toBe(1));\n",
  };
  const sumTest = (body: string) => `const { sum } = require('../src/sum');\n${body}\n`;
  async function scenario(head: Record<string, string>) {
    const { dir } = await makeRepo(BASE);
    await linkNodeModules(dir);
    await branch(dir, 'agent-change');
    await writeFiles(dir, head);
    await commitAll(dir, 'agent change');
    return dir;
  }

  it('PASS: a fix proven by a new jest test', async () => {
    const dir = await scenario({
      'src/sum.js': 'exports.sum = (a, b) => a + b;\n',
      'test/sum.test.js': sumTest("test('adds', () => expect(sum(2, 3)).toBe(5));"),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.runner).toBe('jest');
    expect(receipt.proofs.map((p) => [p.file, p.name, p.before, p.verdict])).toEqual([
      ['test/sum.test.js', 'adds', 'fail', 'proves-change'],
    ]);
    expect(receipt.verdict).toBe('pass');
  }, 120_000);

  it('WARN: a new test that passes without the change', async () => {
    const dir = await scenario({
      'src/sum.js': 'exports.sum = (a, b) => a + b;\n',
      'test/sum.test.js': sumTest("test('zero', () => expect(sum(0, 0)).toBe(0));"),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('warn');
    expect(receipt.proofs.map((p) => p.verdict)).toContain('does-not-constrain');
  }, 120_000);
});
