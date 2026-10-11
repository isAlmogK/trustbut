import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd });
  return stdout;
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

export async function resolveRef(cwd: string, ref: string): Promise<string | null> {
  const r = await execa('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, reject: false });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string> {
  return (await git(cwd, ['merge-base', a, b])).trim();
}

// Flags pin the diff format against user config (quoted paths, prefixes, color, external diff tools, textconv).
export async function diffText(cwd: string, base: string, head: string): Promise<string> {
  return git(cwd, [
    '-c', 'core.quotePath=false',
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-M', base, head,
  ]);
}

/** Raw blob bytes of `path` at `ref` (no textconv, no filters). */
export async function showFileBuffer(cwd: string, ref: string, path: string): Promise<Uint8Array> {
  const { stdout } = await execa('git', ['cat-file', 'blob', `${ref}:${path}`], { cwd, encoding: 'buffer', stripFinalNewline: false });
  return stdout;
}

export async function showFile(cwd: string, ref: string, path: string): Promise<string> {
  return Buffer.from(await showFileBuffer(cwd, ref, path)).toString('utf8');
}

export async function addWorktree(cwd: string, ref: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'trustbut-wt-'));
  try {
    await git(cwd, ['worktree', 'add', '--detach', dir, ref]);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return dir;
}

export async function removeWorktree(cwd: string, dir: string): Promise<void> {
  const r = await execa('git', ['worktree', 'remove', '--force', dir], { cwd, reject: false });
  await rm(dir, { recursive: true, force: true });
  // Only when git could not remove it itself (e.g. the directory was already gone); prune then drops the stale entry.
  if (r.exitCode !== 0) await execa('git', ['worktree', 'prune'], { cwd, reject: false });
}

export async function isDirty(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain', '--untracked-files=no'])).trim().length > 0;
}
