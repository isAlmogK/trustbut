import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { runInGroup } from '../process.js';
import type { RunResult, TestCaseResult } from '../types.js';
import { addCase } from './cases.js';
import { childEnv, runOutput, timedOutFlag } from './env.js';
import type { Runner } from './types.js';

interface DartEvent {
  type?: string;
  suite?: { id: number; path?: string; platform?: string };
  success?: boolean;
  group?: { id: number; name?: string };
  test?: { id: number; name: string; suiteID: number; groupIDs?: number[] };
  testID?: number;
  result?: string;
  skipped?: boolean;
  hidden?: boolean;
}

/** A suite path as a repo-style path relative to the package root (`flutter test` reports absolute paths). */
function relFile(path: string, roots: string[]): string {
  if (!isAbsolute(path)) return path.split(sep).join('/').replace(/^\.\//, '');
  for (const root of roots) {
    const rel = relative(root, path);
    if (!rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  }
  return path;
}

/**
 * Parses the `package:test` JSON reporter (`dart test --reporter json`, `flutter test --machine`): one JSON object
 * per line; anything else (flutter prints pub output and a JSON array first) is skipped. Hidden tests (setUpAll,
 * tearDownAll, successful `loading …`) are ignored. A failed `loading <file>` becomes one `[load error]` case for the
 * file, unless tests of that file did run (flutter can report a loading error and still run them). Ids are
 * `file::name`, the file relative to `root`.
 */
export function parseDartJson(text: string, root: string): TestCaseResult[] {
  return parseDartRun(text, root).cases;
}

/** `parseDartJson` plus whether the reporter's final `done` event said success (false when absent). */
export function parseDartRun(text: string, root: string): { cases: TestCaseResult[]; success: boolean } {
  let success = false;
  const roots = [root];
  try {
    roots.unshift(realpathSync(root));
  } catch {
    // root vanished: use it as given
  }
  const suites = new Map<number, { file: string; key: string }>();
  const groups = new Map<number, string>();
  const tests = new Map<number, { name: string; file: string; key: string; leaf: string; loading: boolean }>();
  const cases: TestCaseResult[] = [];
  const index = new Map<string, number>();
  const ran = new Set<string>();
  const loadErrors: { file: string; key: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let ev: DartEvent;
    try {
      ev = JSON.parse(line) as DartEvent;
    } catch {
      continue;
    }
    if (ev.type === 'done') success = ev.success === true;
    else if (ev.type === 'suite' && ev.suite) {
      const file = relFile(ev.suite.path ?? '', roots);
      suites.set(ev.suite.id, { file, key: `${ev.suite.platform ?? ''}\0${file}` });
    }
    else if (ev.type === 'group' && ev.group) groups.set(ev.group.id, ev.group.name ?? '');
    else if (ev.type === 'testStart' && ev.test) {
      const t = ev.test;
      // The test name already carries its groups' names; the leaf is what remains after the innermost named group.
      const enclosing = [...(t.groupIDs ?? [])].reverse().map((g) => groups.get(g) ?? '').find((n) => n !== '') ?? '';
      const leaf = enclosing && t.name.startsWith(enclosing) ? t.name.slice(enclosing.length).trim() : t.name;
      const suite = suites.get(t.suiteID) ?? { file: '', key: '' };
      // The pseudo-test that loads a suite sits outside every group; a user's `test('loading …')` does not.
      const loading = (t.groupIDs ?? []).length === 0 && t.name.startsWith('loading ');
      tests.set(t.id, { name: t.name, file: suite.file, key: suite.key, leaf: leaf || t.name, loading });
    } else if (ev.type === 'testDone' && ev.testID !== undefined) {
      const t = tests.get(ev.testID);
      if (!t) continue;
      const bad = ev.result === 'error' || ev.result === 'failure';
      if (t.loading) {
        if (bad) loadErrors.push({ file: t.file, key: t.key });
        continue;
      }
      if (ev.hidden) continue;
      // `error` is a failure outside the test body (a setUpAll/tearDownAll hook); a thrown exception inside a test is a failing test.
      const hook = /\((?:setUpAll|tearDownAll)\)$/.test(t.name);
      const outcome: TestCaseResult['outcome'] = bad ? (hook ? 'error' : 'fail') : ev.skipped ? 'skip' : 'pass';
      ran.add(t.key);
      addCase(cases, index, { id: `${t.file}::${t.name}`, file: t.file, name: t.name, leaf: t.leaf, outcome });
    }
  }
  for (const { file, key } of loadErrors) {
    if (!ran.has(key)) addCase(cases, index, { id: `${file}::[load error]`, file, name: '[load error]', outcome: 'error' });
  }
  return { cases, success };
}

/** The error messages of failing tests, one block per test, for the run output (the raw JSON stream is too noisy to keep). */
export function dartFailureDigest(text: string): string {
  const names = new Map<number, string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; test?: { id: number; name: string }; testID?: number; error?: string };
      if (ev.type === 'testStart' && ev.test) names.set(ev.test.id, ev.test.name);
      else if (ev.type === 'error' && ev.testID !== undefined) out.push(`${names.get(ev.testID) ?? ev.testID}: ${(ev.error ?? '').slice(0, 600)}`);
    } catch {
      // not an event
    }
  }
  return out.join('\n');
}

/** The arguments (without the executable) for one run. */
export function dartArgs(flutter: boolean, args: string[], files: string[] = []): string[] {
  return flutter ? ['test', '--machine', ...args, ...files] : ['test', '--reporter', 'json', ...args, ...files];
}

async function readPubspec(root: string): Promise<string> {
  try {
    return await readFile(join(root, 'pubspec.yaml'), 'utf8');
  } catch {
    return '';
  }
}

const isFlutter = (pubspec: string): boolean => /^[ \t]+sdk:[ \t]*flutter\b/m.test(pubspec);
/** A `test:` entry in the `dev_dependencies:` block. */
function hasTestDep(pubspec: string): boolean {
  const block = /^dev_dependencies:[^\n]*\n((?:[ \t]+[^\n]*\n?|[ \t]*\n)*)/m.exec(pubspec)?.[1];
  return block !== undefined && /^[ \t]+test:/m.test(block);
}

function makeRunner(name: 'dart' | 'flutter'): Runner {
  const flutter = name === 'flutter';
  return {
    name,
    async detect(root) {
      try {
        const pubspec = await readPubspec(root);
        if (flutter) return isFlutter(pubspec) ? 10 : 0;
        return !isFlutter(pubspec) && hasTestDep(pubspec) ? 10 : 0;
      } catch {
        return 0;
      }
    },
    async run({ cwd, files, args = [], env: extraEnv, timeoutMs }): Promise<RunResult> {
      const start = Date.now();
      const env = childEnv(extraEnv);
      const output: string[] = [];
      const joined = () => output.filter(Boolean).join('\n').slice(-4000);
      // The worktree has no .dart_tool/ (untracked): resolve packages first. `flutter test` does this itself.
      if (!flutter && !existsSync(join(cwd, '.dart_tool', 'package_config.json'))) {
        const pub = await runInGroup('dart', ['pub', 'get'], { cwd, env, timeoutMs });
        output.push(runOutput(pub));
        if (pub.timedOut || pub.exitCode !== 0) {
          const cases: TestCaseResult[] = [{ id: '[dart]::[pub get]', file: '[dart]', name: '[pub get failed]', outcome: 'error' }];
          return { exitCode: pub.exitCode || 1, cases, durationMs: Date.now() - start, output: joined(), ...timedOutFlag(pub) };
        }
      }
      // Only *_test.dart files are targets (helpers under test/ are not): if just helpers changed, run everything.
      const targets = files?.filter((f) => /_test\.dart$/.test(f) && existsSync(join(cwd, f)));
      const res = await runInGroup(name, dartArgs(flutter, args, targets?.length ? targets : undefined), { cwd, env, timeoutMs });
      // stdout is the JSON event stream: keep stderr (tool messages) and the failure messages instead.
      output.push(runOutput({ ...res, all: res.stderr }), dartFailureDigest(res.stdout));
      const { cases, success } = parseDartRun(res.stdout, cwd);
      // `package:test` exits 79 when no test matched the filters: nothing to run, not a failure.
      // `flutter test` exits 1 with `done: success` for a file without tests ("No tests were found").
      let exitCode = res.exitCode === 79 ? 0 : (res.exitCode ?? 1);
      if (exitCode !== 0 && res.exitCode !== undefined && success && !cases.some((c) => c.outcome === 'fail' || c.outcome === 'error')) exitCode = 0;
      // A crash before any event, or a failing hook (hidden test), leaves no failing case: report one error case.
      if (exitCode !== 0 && !cases.some((c) => c.outcome === 'fail' || c.outcome === 'error')) {
        cases.push({ id: `[${name}]::[run failed]`, file: `[${name}]`, name: '[run failed]', outcome: 'error' });
      }
      return { exitCode, cases, durationMs: Date.now() - start, output: joined(), ...timedOutFlag(res) };
    },
  };
}

export const dart: Runner = makeRunner('dart');
export const flutter: Runner = makeRunner('flutter');
