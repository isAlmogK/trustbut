import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInGroup } from '../process.js';
import type { TestCaseResult } from '../types.js';
import { anyExists, fileContains } from './detect.js';
import { addCase } from './cases.js';
import { childEnv, runOutput, timedOutFlag } from './env.js';
import type { Runner } from './types.js';

const STATUS: Record<string, TestCaseResult['outcome']> = { passed: 'pass', failed: 'fail', pending: 'skip' };

interface RspecJson {
  messages?: string[];
  examples?: { id?: string; description?: string; full_description?: string; status?: string; file_path?: string }[];
  summary?: { errors_outside_of_examples_count?: number };
}

const norm = (p: string): string => p.replace(/^(\.\/)+/, '');

/**
 * Parses RSpec's JSON formatter output. Ids are `file::full_description`, relative to the package root. A spec file
 * that fails to load has no examples: it becomes one error case (named from the "An error occurred while loading" message).
 */
export function parseRspecJson(text: string): TestCaseResult[] {
  const doc = JSON.parse(text) as RspecJson;
  const cases: TestCaseResult[] = [];
  const index = new Map<string, number>();
  const add = (c: TestCaseResult) => addCase(cases, index, c);
  for (const ex of doc.examples ?? []) {
    // Shared examples report the shared file in `file_path`; the including spec is in the id (`./spec/a_spec.rb[1:3:1]`).
    const file = norm(/^(.*)\[[\d:]+\]$/.exec(ex.id ?? '')?.[1] ?? ex.file_path ?? '');
    const name = ex.full_description ?? ex.description ?? '';
    add({ id: `${file}::${name}`, file, name, outcome: STATUS[ex.status ?? ''] ?? 'error', leaf: ex.description ?? name });
  }
  const outside = doc.summary?.errors_outside_of_examples_count ?? 0;
  if (outside > 0) {
    let named = 0;
    for (const message of doc.messages ?? []) {
      const m = /An error occurred while loading (.+?)\.?(?:\r?\n|$)/.exec(message);
      if (!m) continue;
      const file = norm(m[1]!);
      named++;
      add({ id: `${file}::[load error]`, file, name: '[load error]', outcome: 'error' });
    }
    // Errors in hooks outside any example, or whose file could not be named.
    if (named < outside) add({ id: '[rspec]::[error outside of examples]', file: '[rspec]', name: '[error outside of examples]', outcome: 'error' });
  }
  return cases;
}

/** The `rspec` arguments (without the executable) for one run. */
export function rspecArgs(out: string, args: string[], files: string[] = []): string[] {
  return ['--format', 'json', '--out', out, ...args, ...files];
}

export const rspec: Runner = {
  name: 'rspec',
  async detect(root) {
    try {
      if (anyExists(root, ['.rspec'])) return 10;
      if (!existsSync(join(root, 'spec'))) return 0;
      return (await fileContains(root, 'Gemfile', 'rspec')) || (await fileContains(root, 'Gemfile.lock', 'rspec')) ? 10 : 0;
    } catch {
      return 0;
    }
  },
  async run({ cwd, files, args = [], env: extraEnv, timeoutMs }) {
    const start = Date.now();
    const dir = await mkdtemp(join(tmpdir(), 'trustbut-rspec-'));
    try {
      const out = join(dir, 'rspec.json');
      // Only *_spec.rb files are targets (spec_helper.rb, support/ are not): if just helpers changed, run everything.
      const specs = files?.filter((f) => /_spec\.rb$/.test(f) && existsSync(join(cwd, f)));
      const rspecArgv = rspecArgs(out, args, specs?.length ? specs : undefined);
      const bundled = existsSync(join(cwd, 'Gemfile'));
      const res = await runInGroup(bundled ? 'bundle' : 'rspec', bundled ? ['exec', 'rspec', ...rspecArgv] : rspecArgv, { cwd, env: childEnv(extraEnv), timeoutMs });
      let cases: TestCaseResult[] = [];
      if (existsSync(out)) {
        try {
          cases = parseRspecJson(await readFile(out, 'utf8'));
        } catch {
          // truncated report (killed run): treated like no report below
        }
      }
      const exitCode = res.exitCode ?? 1;
      // A crash before the report (bundler, bad flags) writes no failing example: report one error case instead of "no tests".
      if (exitCode !== 0 && !cases.some((c) => c.outcome === 'fail' || c.outcome === 'error')) {
        cases.push({ id: '[rspec]::[run failed]', file: '[rspec]', name: '[run failed]', outcome: 'error' });
      }
      return { exitCode, cases, durationMs: Date.now() - start, output: runOutput(res), ...timedOutFlag(res) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
