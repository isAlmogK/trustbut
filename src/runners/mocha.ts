import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { runInGroup } from '../process.js';
import type { TestCaseResult } from '../types.js';
import { anyExists, hasDep, readPackageJson } from './detect.js';
import { childEnv, runOutput } from './env.js';
import type { Runner } from './types.js';

const CONFIGS = ['js', 'cjs', 'json', 'yml', 'yaml'].map((ext) => `.mocharc.${ext}`);
const HOOK = /^"(?:before|after) (?:all|each)" hook/;

interface MochaTest {
  title?: string;
  fullTitle?: string;
  file?: string;
}

/** `<cwd>/node_modules/.bin/mocha`, walking up to the worktree top (hoisted monorepos). */
function findMocha(cwd: string, worktree?: string): string | undefined {
  const top = resolve(worktree ?? cwd);
  let dir = resolve(cwd);
  for (;;) {
    const bin = join(dir, 'node_modules', '.bin', 'mocha');
    if (existsSync(bin)) return bin;
    if (dir === top || dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}

export function parseMochaJson(json: string, cwd: string): TestCaseResult[] {
  const root = existsSync(cwd) ? realpathSync(cwd) : cwd;
  const data = JSON.parse(json) as { passes?: MochaTest[]; failures?: MochaTest[]; pending?: MochaTest[] };
  const cases: TestCaseResult[] = [];
  const add = (t: MochaTest, outcome: TestCaseResult['outcome']) => {
    const file = t.file ? relative(root, t.file).split(sep).join('/') : '';
    const name = t.fullTitle ?? t.title ?? '';
    cases.push({ id: `${file}::${name}`, file, name, outcome });
  };
  for (const t of data.passes ?? []) add(t, 'pass');
  for (const t of data.pending ?? []) add(t, 'skip');
  // A failing hook means the tests below it never ran: that is "couldn't run", not a test failure.
  for (const t of data.failures ?? []) add(t, HOOK.test(t.title ?? '') ? 'error' : 'fail');
  return cases;
}

export const mocha: Runner = {
  name: 'mocha',
  async detect(root) {
    try {
      return hasDep(await readPackageJson(root), 'mocha') || anyExists(root, CONFIGS) ? 9 : 0;
    } catch {
      return 0;
    }
  },
  async run({ cwd, worktree, files, args = [], env, timeoutMs }) {
    const dir = await mkdtemp(join(tmpdir(), 'trustbut-mocha-'));
    const out = join(dir, 'mocha.json');
    const start = Date.now();
    const bin = findMocha(cwd, worktree);
    const [cmd, pre] = bin ? [bin, []] : ['npx', ['--no', 'mocha']];
    try {
      const res = await runInGroup(
        cmd,
        [...pre, '--reporter', 'json', '--reporter-option', `output=${out}`, ...args, ...(files ?? [])],
        { cwd, env: childEnv(env), timeoutMs },
      );
      const exitCode = res.exitCode ?? 1;
      let cases: TestCaseResult[] = [];
      if (existsSync(out)) {
        try {
          cases = parseMochaJson(await readFile(out, 'utf8'), cwd);
        } catch {
          // unreadable report: exit code and output tell the story
        }
      } else if (exitCode !== 0 && files) {
        // Mocha aborts without a report when a spec file fails to load (syntax error, bad import).
        cases = files.map((f) => ({ id: `${f}::${f}`, file: f, name: f, outcome: 'error' as const }));
      }
      return { exitCode, cases, durationMs: Date.now() - start, output: runOutput(res) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
