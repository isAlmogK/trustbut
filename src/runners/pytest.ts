import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { childEnv, tail } from './env.js';
import { parseJUnit } from './junit.js';
import type { Runner } from './types.js';

function pythonFor(cwd: string): string {
  for (const venv of ['.venv', 'venv']) {
    const bin = join(cwd, venv, 'bin', 'python');
    if (existsSync(bin)) return bin;
  }
  return process.env.TRUSTBUT_PYTHON ?? 'python3';
}

export const pytest: Runner = {
  name: 'pytest',
  async run({ cwd, files }) {
    const dir = await mkdtemp(join(tmpdir(), 'trustbut-junit-'));
    const out = join(dir, 'junit.xml');
    const start = Date.now();
    try {
      const res = await execa(
        pythonFor(cwd),
        ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', `--junitxml=${out}`, ...(files ?? [])],
        { cwd, reject: false, all: true, extendEnv: false, env: childEnv() },
      );
      const xml = existsSync(out) ? await readFile(out, 'utf8') : '';
      return { exitCode: res.exitCode ?? 1, cases: xml ? parseJUnit(xml) : [], durationMs: Date.now() - start, output: tail(res.all) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
