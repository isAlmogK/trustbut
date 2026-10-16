import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

/** Bases `verify` tries, in order, when none is given. */
export const DEFAULT_BASES = ['origin/main', 'main', 'origin/master', 'master'];

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

/** Object type (`tree`, `blob`, …) of `path` at `ref`, or null when it does not exist there. */
export async function objectType(cwd: string, ref: string, path: string): Promise<string | null> {
  const r = await execa('git', ['cat-file', '-t', `${ref}:${path}`], { cwd, reject: false });
  return r.exitCode === 0 ? r.stdout.trim() : null;
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

/**
 * The `paths` that `.gitattributes` at `ref` marks `linguist-generated` (set or `true`). Reads the attributes through a
 * temporary index of `ref` (`check-attr --source` needs git 2.40), so nested `.gitattributes` files and git's own pattern
 * rules apply and the working tree is never read.
 */
export async function generatedPaths(repo: string, ref: string, paths: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!paths.length) return out;
  const dir = await mkdtemp(join(tmpdir(), 'trustbut-index-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    await execa('git', ['read-tree', ref], { cwd: repo, env });
    const { stdout } = await execa('git', ['check-attr', '--cached', '-z', '--stdin', 'linguist-generated'], { cwd: repo, env, input: paths.join('\0') });
    // Records of path NUL attribute NUL value NUL.
    const parts = stdout.split('\0');
    for (let i = 0; i + 2 < parts.length; i += 3) {
      if (parts[i + 2] === 'set' || parts[i + 2] === 'true') out.add(parts[i]!);
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Commit SHA for HEAD plus every tracked modification and untracked, non-ignored file.
 * Built with a temporary index, so the real index, HEAD and refs are never touched. The commit
 * is unreferenced (git gc will collect it).
 */
export async function snapshotWorkingTree(repo: string): Promise<string> {
  const head = await resolveRef(repo, 'HEAD');
  if (!head) throw new Error('This repository has no commits yet; --working needs a HEAD to compare against.');
  const dir = await mkdtemp(join(tmpdir(), 'trustbut-index-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    await execa('git', ['read-tree', 'HEAD'], { cwd: repo, env });
    await execa('git', ['add', '-A'], { cwd: repo, env });
    const tree = (await execa('git', ['write-tree'], { cwd: repo, env })).stdout.trim();
    const identity = {
      GIT_AUTHOR_NAME: 'trustbut', GIT_AUTHOR_EMAIL: 'trustbut@localhost',
      GIT_COMMITTER_NAME: 'trustbut', GIT_COMMITTER_EMAIL: 'trustbut@localhost',
    };
    return (await execa('git', ['commit-tree', tree, '-p', head, '-m', 'trustbut working snapshot'], { cwd: repo, env: identity })).stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
