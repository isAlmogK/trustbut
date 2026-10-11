import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { parseChanges } from '../src/diff.js';
import {
  addWorktree, diffText, isDirty, mergeBase, removeWorktree, repoRoot, resolveRef, showFile, showFileBuffer,
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

describe('git robustness against user config', () => {
  it('reads non-ASCII paths unquoted', async () => {
    const { dir, base } = await makeRepo({ 'a.txt': 'one\n' });
    await writeFiles(dir, { 'src/é.ts': 'export const e = 1;\n' });
    const head = await commitAll(dir, 'add é');
    const [file] = parseChanges(await diffText(dir, base, head));
    expect(file).toMatchObject({ path: 'src/é.ts', status: 'added', kind: 'source' });
    expect(await showFile(dir, head, 'src/é.ts')).toBe('export const e = 1;\n');
  });

  it.each([
    [{ 'diff.noprefix': 'true', 'color.ui': 'always' }],
    [{ 'diff.mnemonicPrefix': 'true', 'diff.srcPrefix': 'x/', 'diff.dstPrefix': 'y/', 'diff.external': 'false' }],
  ])('parses diffs regardless of repo diff config %o', async (config) => {
    const { dir, base } = await makeRepo({ 'a/b.ts': 'one\n' });
    for (const [k, v] of Object.entries(config)) await execa('git', ['config', k, v], { cwd: dir });
    await writeFiles(dir, { 'a/b.ts': 'two\n' });
    const head = await commitAll(dir, 'change');
    expect(parseChanges(await diffText(dir, base, head))).toMatchObject([
      { path: 'a/b.ts', status: 'modified', added: [{ line: 1, text: 'two' }], removed: ['one'] },
    ]);
  });

  it('shows files byte-for-byte, without textconv', async () => {
    const { dir } = await makeRepo({ '.gitattributes': '*.txt diff=upper\n', 'a.txt': 'lower\n' });
    await execa('git', ['config', 'diff.upper.textconv', 'tr a-z A-Z <'], { cwd: dir });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a]);
    await writeFile(join(dir, 'img.png'), bytes);
    const head = await commitAll(dir, 'binary');
    expect(await showFile(dir, head, 'a.txt')).toBe('lower\n');
    expect(Buffer.compare(Buffer.from(await showFileBuffer(dir, head, 'img.png')), bytes)).toBe(0);
  });
});

describe('worktree cleanup', () => {
  it('does not prune worktrees that are not ours', async () => {
    const { dir, base } = await makeRepo({ 'a.txt': 'one\n' });
    const other = await realpath(await mkdtemp(join(tmpdir(), 'not-ours-')));
    await execa('git', ['worktree', 'add', '--detach', other, base], { cwd: dir });
    await rm(other, { recursive: true, force: true });
    const ours = await realpath(await addWorktree(dir, base));
    await removeWorktree(dir, ours);
    const list = (await execa('git', ['worktree', 'list', '--porcelain'], { cwd: dir })).stdout;
    expect(list).toContain(`worktree ${other}`);
    expect(list).not.toContain(`worktree ${ours}`);
  });

  it('removes its temp dir when git worktree add fails', async () => {
    const { dir } = await makeRepo({ 'a.txt': 'one\n' });
    const scratch = await mkdtemp(join(tmpdir(), 'wt-fail-'));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    try {
      await expect(addWorktree(dir, 'no-such-ref')).rejects.toThrow();
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    expect(await readdir(scratch)).toEqual([]);
  });
});
