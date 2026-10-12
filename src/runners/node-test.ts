import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { runInGroup } from '../process.js';
import type { TestCaseResult } from '../types.js';
import { addCase } from './cases.js';
import { readPackageJson } from './detect.js';
import { childEnv, runOutput, timedOutFlag } from './env.js';
import type { Runner } from './types.js';

/**
 * Node's built-in JUnit reporter carries no file attribute and drops suite names from testcases,
 * so ids built from it would not be stable or file-scoped. Instead we load a tiny custom reporter
 * (written to the temp dir at run time) that serialises the raw `test:start|pass|fail` events as
 * JSON lines; `parseNodeTestEvents` turns them into cases. A spec reporter still prints to stdout.
 */
export const REPORTER_SOURCE = `export default async function* (source) {
  for await (const e of source) {
    if (e.type !== 'test:start' && e.type !== 'test:pass' && e.type !== 'test:fail') continue;
    const d = e.data;
    yield JSON.stringify({
      type: e.type,
      name: d.name,
      nesting: d.nesting,
      file: d.file,
      skip: d.skip !== undefined && d.skip !== false,
      todo: d.todo !== undefined && d.todo !== false,
      kind: d.details && d.details.type,
    }) + '\\n';
  }
}
`;

interface RawEvent {
  type: 'test:start' | 'test:pass' | 'test:fail';
  name: string;
  nesting: number;
  file?: string;
  skip?: boolean;
  todo?: boolean;
  kind?: string;
}

const SCRIPT = /\b(?:node|tsx)\b[^&|;]*\s--test\b/;

export function parseNodeTestEvents(jsonl: string, cwd: string): TestCaseResult[] {
  const root = existsSync(cwd) ? realpathSync(cwd) : cwd;
  const cases: TestCaseResult[] = [];
  const index = new Map<string, number>();
  const stacks = new Map<string, string[]>(); // per file: names of the open ancestors
  const childCount = new Map<string, number>(); // per "file\0suite path": leaf tests seen below it

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e: RawEvent;
    try {
      e = JSON.parse(line) as RawEvent;
    } catch {
      continue;
    }
    const abs = e.file ?? '';
    const file = abs ? relative(root, abs).split(sep).join('/') : '';
    const stack = stacks.get(file) ?? [];
    stacks.set(file, stack);
    if (e.type === 'test:start') {
      stack.length = e.nesting;
      stack[e.nesting] = e.name;
      continue;
    }
    stack.length = e.nesting;
    const path = [...stack, e.name];
    const full = path.join(' > ');
    if (e.kind === 'suite') {
      // A suite that failed without any test below it (e.g. a failing before-hook) couldn't run.
      if (e.type === 'test:fail' && !childCount.get(`${file}\0${full}`)) {
        addCase(cases, index, { id: `${file}::${full}`, file, name: full, outcome: 'error' });
      }
      continue;
    }
    for (let i = 1; i <= path.length - 1; i++) {
      const key = `${file}\0${path.slice(0, i).join(' > ')}`;
      childCount.set(key, (childCount.get(key) ?? 0) + 1);
    }
    // A file that fails to load or crashes is reported as a top-level "test" named after the file.
    const loadError = e.type === 'test:fail' && e.nesting === 0 && file !== '' && (e.name === file || abs.endsWith(e.name));
    const outcome = loadError ? 'error' : e.type === 'test:fail' ? 'fail' : e.skip || e.todo ? 'skip' : 'pass';
    addCase(cases, index, { id: `${file}::${full}`, file, name: full, outcome });
  }
  return cases;
}

export const nodeTest: Runner = {
  name: 'node-test',
  async detect(root) {
    try {
      const pkg = await readPackageJson(root);
      return typeof pkg?.scripts?.test === 'string' && SCRIPT.test(pkg.scripts.test) ? 8 : 0;
    } catch {
      return 0;
    }
  },
  async run({ cwd, files, args = [], env, timeoutMs }) {
    const dir = await mkdtemp(join(tmpdir(), 'trustbut-nodetest-'));
    const reporter = join(dir, 'reporter.mjs');
    const out = join(dir, 'events.jsonl');
    const start = Date.now();
    try {
      await writeFile(reporter, REPORTER_SOURCE);
      const res = await runInGroup(
        process.execPath,
        [
          '--test',
          `--test-reporter=${reporter}`,
          `--test-reporter-destination=${out}`,
          '--test-reporter=spec',
          '--test-reporter-destination=stdout',
          ...args,
          ...(files ?? []),
        ],
        { cwd, env: childEnv(env), timeoutMs },
      );
      const jsonl = existsSync(out) ? await readFile(out, 'utf8') : '';
      return {
        exitCode: res.exitCode ?? 1,
        cases: parseNodeTestEvents(jsonl, cwd),
        durationMs: Date.now() - start,
        output: runOutput(res),
        ...timedOutFlag(res),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
