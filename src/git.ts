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

export async function diffText(cwd: string, base: string, head: string): Promise<string> {
  return git(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', base, head]);
}

export async function showFile(cwd: string, ref: string, path: string): Promise<string> {
  const { stdout } = await execa('git', ['show', `${ref}:${path}`], { cwd, stripFinalNewline: false });
  return stdout;
}

export async function addWorktree(cwd: string, ref: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'trustbut-wt-'));
  await git(cwd, ['worktree', 'add', '--detach', dir, ref]);
  return dir;
}

export async function removeWorktree(cwd: string, dir: string): Promise<void> {
  await execa('git', ['worktree', 'remove', '--force', dir], { cwd, reject: false });
  await rm(dir, { recursive: true, force: true });
  await execa('git', ['worktree', 'prune'], { cwd, reject: false });
}

export async function isDirty(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain', '--untracked-files=no'])).trim().length > 0;
}
