import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { childEnv, runOutput } from './env.js';
import { parseJUnit } from './junit.js';
import type { Runner } from './types.js';

export const vitest: Runner = {
  name: 'vitest',
  async run({ cwd, files }) {
    const dir = await mkdtemp(join(tmpdir(), 'trustbut-junit-'));
    const out = join(dir, 'junit.xml');
    const start = Date.now();
    try {
      const res = await execa(
        'npx',
        ['--no-install', 'vitest', 'run', '--reporter=junit', `--outputFile=${out}`, '--passWithNoTests', ...(files ?? [])],
        { cwd, reject: false, all: true, extendEnv: false, env: childEnv() },
      );
      const xml = existsSync(out) ? await readFile(out, 'utf8') : '';
      return { exitCode: res.exitCode ?? 1, cases: xml ? parseJUnit(xml) : [], durationMs: Date.now() - start, output: runOutput(res) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
