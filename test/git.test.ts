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
