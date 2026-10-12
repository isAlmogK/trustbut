import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInGroup } from '../process.js';
import { anyExists, hasDep, readPackageJson } from './detect.js';
import { childEnv, runOutput, timedOutFlag } from './env.js';
import { parseJUnit } from './junit.js';
import type { Runner } from './types.js';

const CONFIGS = ['config', 'workspace'].flatMap((kind) =>
  ['ts', 'js', 'mjs', 'cjs', 'mts', 'cts'].map((ext) => `vitest.${kind}.${ext}`),
);

export const vitest: Runner = {
  name: 'vitest',
  async detect(root) {
    return hasDep(await readPackageJson(root), 'vitest') || anyExists(root, CONFIGS) ? 10 : 0;
  },
  async run({ cwd, files, args = [], env, timeoutMs }) {
    const dir = await mkdtemp(join(tmpdir(), 'trustbut-junit-'));
    const out = join(dir, 'junit.xml');
    const start = Date.now();
    try {
      const res = await runInGroup(
        'npx',
        ['--no-install', 'vitest', 'run', '--reporter=junit', `--outputFile=${out}`, '--passWithNoTests', ...args, ...(files ?? [])],
        { cwd, env: childEnv(env), timeoutMs },
      );
      const xml = existsSync(out) ? await readFile(out, 'utf8') : '';
      return { exitCode: res.exitCode ?? 1, cases: xml ? parseJUnit(xml) : [], durationMs: Date.now() - start, output: runOutput(res), ...timedOutFlag(res) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
