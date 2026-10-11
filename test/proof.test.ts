import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
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

    const wt = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: dir });
    expect(wt.stdout.split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
  }, 120_000);
});
