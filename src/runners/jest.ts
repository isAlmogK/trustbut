import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { runInGroup } from '../process.js';
import type { TestCaseResult, TestOutcome } from '../types.js';
import { addCase } from './cases.js';
import { anyExists, hasDep, readPackageJson } from './detect.js';
import { childEnv, runOutput } from './env.js';
import type { Runner } from './types.js';
import { vitest } from './vitest.js';

const CONFIGS = ['ts', 'js', 'mjs', 'cjs', 'json'].map((ext) => `jest.config.${ext}`);
const PRESETS = ['jest-expo', 'react-native'];

interface JestAssertion {
  fullName?: string;
  title?: string;
  status?: string;
}
interface JestSuite {
  name: string;
  status?: string;
  message?: string;
  assertionResults?: JestAssertion[];
}

const OUTCOMES: Record<string, TestOutcome> = {
  passed: 'pass',
  failed: 'fail',
  pending: 'skip',
  todo: 'skip',
  skipped: 'skip',
  disabled: 'skip',
};

/** `<cwd>/node_modules/.bin/jest`, walking up to the worktree top (hoisted monorepos). */
function findJest(cwd: string, worktree?: string): string | undefined {
  const top = resolve(worktree ?? cwd);
  let dir = resolve(cwd);
  for (;;) {
    const bin = join(dir, 'node_modules', '.bin', 'jest');
    if (existsSync(bin)) return bin;
    if (dir === top || dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}

export function parseJestJson(json: string, cwd: string): TestCaseResult[] {
  const root = existsSync(cwd) ? realpathSync(cwd) : cwd; // Jest reports real paths (macOS /var -> /private/var)
  const data = JSON.parse(json) as { testResults?: JestSuite[] };
  const cases: TestCaseResult[] = [];
  const index = new Map<string, number>();
  for (const suite of data.testResults ?? []) {
    const file = relative(root, suite.name).split(sep).join('/');
    const assertions = suite.assertionResults ?? [];
    if (assertions.length === 0) {
      if (suite.status === 'failed') addCase(cases, index, { id: `${file}::${file}`, file, name: file, outcome: 'error' });
      continue;
    }
    for (const a of assertions) {
      const name = a.fullName || a.title || '';
      addCase(cases, index, { id: `${file}::${name}`, file, name, outcome: OUTCOMES[a.status ?? ''] ?? 'error' });
    }
  }
  return cases;
}

export const jest: Runner = {
  name: 'jest',
  async detect(root) {
    const pkg = await readPackageJson(root);
    const preset = (pkg?.jest as { preset?: unknown } | undefined)?.preset;
    const isJest =
      hasDep(pkg, 'jest') ||
      pkg?.jest !== undefined ||
      (typeof preset === 'string' && PRESETS.includes(preset)) ||
      anyExists(root, CONFIGS);
    if (!isJest) return 0;
    // Vitest keeps winning when both are present.
    return (await vitest.detect(root)) > 0 ? 9 : 10;
  },
  async run({ cwd, worktree, files, args = [], env, timeoutMs }) {
    const dir = await mkdtemp(join(tmpdir(), 'trustbut-jest-'));
    const out = join(dir, 'jest.json');
    const start = Date.now();
    const bin = findJest(cwd, worktree);
    const [cmd, pre] = bin ? [bin, []] : ['npx', ['--no', 'jest']];
    try {
      const res = await runInGroup(
        cmd,
        [
          ...pre,
          '--ci',
          '--json',
          `--outputFile=${out}`,
          '--testLocationInResults',
          '--watchman=false',
          '--passWithNoTests',
          ...args,
          ...(files ? ['--runTestsByPath', ...files] : []),
        ],
        { cwd, env: childEnv(env), timeoutMs },
      );
      const json = existsSync(out) ? await readFile(out, 'utf8') : '';
      let cases: TestCaseResult[] = [];
      try {
        cases = json ? parseJestJson(json, cwd) : [];
      } catch {
        // unreadable report: leave no cases; exit code and output tell the story
      }
      return { exitCode: res.exitCode ?? 1, cases, durationMs: Date.now() - start, output: runOutput(res) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
