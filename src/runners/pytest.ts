import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execa } from 'execa';
import { childEnv, runOutput } from './env.js';
import { parseJUnit } from './junit.js';
import type { Runner } from './types.js';

function pythonFor(cwd: string): string {
  for (const venv of ['.venv', 'venv']) {
    const bin = join(cwd, venv, 'bin', 'python');
    if (existsSync(bin)) return bin;
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
  async run({ cwd, files }) {
    const dir = await mkdtemp(join(tmpdir(), 'trustbut-junit-'));
    const out = join(dir, 'junit.xml');
    const start = Date.now();
    try {
      const env = childEnv();
      env.PYTHONPATH = pythonPath(cwd, env.PYTHONPATH);
      // --rootdir keeps test ids identical between the head and base checkouts.
      const res = await execa(
        pythonFor(cwd),
        ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--rootdir', cwd, `--junitxml=${out}`, ...(files ?? [])],
        { cwd, reject: false, all: true, extendEnv: false, env },
      );
      const xml = existsSync(out) ? await readFile(out, 'utf8') : '';
      // pytest exits 5 when no tests are collected; treat as success (vitest uses --passWithNoTests).
      const exitCode = res.exitCode === 5 ? 0 : (res.exitCode ?? 1);
      return { exitCode, cases: xml ? parseJUnit(xml) : [], durationMs: Date.now() - start, output: runOutput(res) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
