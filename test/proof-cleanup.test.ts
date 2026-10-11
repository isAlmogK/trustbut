import { execa } from 'execa';
import { describe, expect, it, vi } from 'vitest';
import { parseChanges } from '../src/diff.js';
import { diffText } from '../src/git.js';
import { proveTests } from '../src/proof.js';
import { vitest } from '../src/runners/vitest.js';
import { commitAll, linkNodeModules, makeRepo, writeFiles } from './helpers/repo.js';

// The first removeWorktree call (head) removes the worktree and then throws, as rm could.
const calls: string[] = [];
vi.mock('../src/git.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/git.js')>();
  return {
    ...real,
    removeWorktree: async (cwd: string, dir: string) => {
      calls.push(dir);
      await real.removeWorktree(cwd, dir);
      if (calls.length === 1) throw new Error('head cleanup failed');
    },
  };
});

describe('proveTests cleanup', () => {
  it('still removes the base worktree when head cleanup throws', async () => {
    const { dir, base } = await makeRepo({
      '.gitignore': 'node_modules\n',
      'package.json': JSON.stringify({ name: 'fx', private: true, type: 'module', devDependencies: { vitest: '*' } }),
      'test/old.test.js': "import { it, expect } from 'vitest';\nit('truth', () => expect(1).toBe(1));\n",
    });
    await linkNodeModules(dir);
    await writeFiles(dir, { 'test/new.test.js': "import { it, expect } from 'vitest';\nit('new', () => expect(1).toBe(1));\n" });
    const head = await commitAll(dir, 'add test');
    const changes = parseChanges(await diffText(dir, base, head));

    await expect(proveTests({ repo: dir, base, head, changes, runner: vitest })).rejects.toThrow('head cleanup failed');

    expect(calls).toHaveLength(2);
    const wt = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: dir });
    expect(wt.stdout.split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
  }, 120_000);
});
