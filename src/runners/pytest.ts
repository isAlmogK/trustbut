import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { runInGroup } from '../process.js';
import { anyExists, fileContains } from './detect.js';
import { childEnv, runOutput, timedOutFlag } from './env.js';
import { parseJUnit } from './junit.js';
import type { Runner } from './types.js';

/** Folders from `cwd` up to `top` (inclusive); just `cwd` when `top` is unset or not above it. */
function upTo(cwd: string, top: string | undefined): string[] {
  if (top === undefined) return [cwd];
  const rel = relative(top, cwd);
  if (rel.startsWith('..') || isAbsolute(rel)) return [cwd];
  const dirs = [cwd];
  for (let dir = cwd; dir !== top && dirname(dir) !== dir; ) dirs.push((dir = dirname(dir)));
  return dirs;
}

// The nearest .venv/venv from the package root up to the worktree top (uv workspaces keep one at the top).
function pythonFor(cwd: string, top: string | undefined): string {
  for (const dir of upTo(cwd, top)) {
    for (const venv of ['.venv', 'venv']) {
      const bin = join(dir, venv, 'bin', 'python');
      if (existsSync(bin)) return bin;
    }
  }
  return process.env.TRUSTBUT_PYTHON ?? 'python3';
}

// The checkout's own code must win over an editable install of the user's checkout in a
// symlinked .venv, so put the worktree (and its src/ layout dir) first on PYTHONPATH.
function pythonPath(cwd: string, inherited: string | undefined): string {
  return [existsSync(join(cwd, 'src')) ? join(cwd, 'src') : '', cwd, inherited ?? ''].filter(Boolean).join(delimiter);
}

export const pytest: Runner = {
  name: 'pytest',
  async detect(root) {
    return anyExists(root, ['pytest.ini', 'conftest.py', 'tox.ini']) || (await fileContains(root, 'pyproject.toml', '[tool.pytest')) ? 10 : 0;
  },
  async run({ cwd, worktree, files, args = [], env: extraEnv, timeoutMs }) {
    const dir = await mkdtemp(join(tmpdir(), 'trustbut-junit-'));
    const out = join(dir, 'junit.xml');
    const start = Date.now();
    try {
      const env = childEnv(extraEnv);
      env.PYTHONPATH = pythonPath(cwd, env.PYTHONPATH);
      // --rootdir keeps test ids identical between the head and base checkouts.
      const res = await runInGroup(
        pythonFor(cwd, worktree),
        ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--rootdir', cwd, `--junitxml=${out}`, ...args, ...(files ?? [])],
        { cwd, env, timeoutMs },
      );
      const xml = existsSync(out) ? await readFile(out, 'utf8') : '';
      // pytest exits 5 when no tests are collected; treat as success (vitest uses --passWithNoTests).
      const exitCode = res.exitCode === 5 ? 0 : (res.exitCode ?? 1);
      return { exitCode, cases: xml ? parseJUnit(xml) : [], durationMs: Date.now() - start, output: runOutput(res), ...timedOutFlag(res) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
