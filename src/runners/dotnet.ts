import { readdirSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { runInGroup } from '../process.js';
import type { TestCaseResult, TestOutcome } from '../types.js';
import { childEnv, runOutput } from './env.js';
import type { ReadHead, Runner } from './types.js';

const PROJECT = /\.(sln|slnx|csproj|fsproj)$/;

// TRX is namespaced (xmlns=".../VisualStudio/TeamTest/2010"); removeNSPrefix makes that irrelevant.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  isArray: (name) => name === 'UnitTestResult' || name === 'UnitTest',
});

interface TrxResult {
  executionId?: string;
  parentExecutionId?: string;
  testId?: string;
  testName?: string;
  outcome?: string;
  resultType?: string;
}
interface TrxDefinition {
  id?: string;
  TestMethod?: { className?: string; name?: string };
}

const OUTCOMES: Record<string, TestOutcome> = {
  Passed: 'pass',
  Failed: 'fail',
  NotExecuted: 'skip',
  Inconclusive: 'skip',
  Pending: 'skip',
  Timeout: 'fail',
  Error: 'error',
  Aborted: 'error',
  NotRunnable: 'error',
  Disconnected: 'error',
};

/** `Ns.Class` from `Ns.Class.Method(args)` when the TRX has no definition for a result. */
function classFromName(testName: string): string {
  const head = testName.split('(')[0]!;
  const dot = head.lastIndexOf('.');
  return dot < 0 ? '' : head.slice(0, dot);
}

/**
 * Parses a TRX file. The class comes from `TestDefinitions/UnitTest/TestMethod@className`; the case's
 * `file` is that class name and its name is `Class.Method` (plus theory arguments), whichever form the
 * adapter used for `testName` (xunit: fully qualified, MSTest/NUnit: the bare method).
 */
export function parseTrx(xml: string): TestCaseResult[] {
  const doc = parser.parse(xml) as {
    TestRun?: { Results?: { UnitTestResult?: TrxResult[] }; TestDefinitions?: { UnitTest?: TrxDefinition[] } };
  };
  const run = doc.TestRun;
  const classOf = new Map<string, string>();
  for (const def of run?.TestDefinitions?.UnitTest ?? []) {
    if (def.id && def.TestMethod?.className) classOf.set(def.id, def.TestMethod.className);
  }
  const results = run?.Results?.UnitTestResult ?? [];
  const parents = new Set(results.map((r) => r.parentExecutionId).filter(Boolean));
  const cases: TestCaseResult[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.executionId && parents.has(r.executionId)) continue; // data-driven parent; its rows are reported
    const testName = String(r.testName ?? '');
    const className = (r.testId ? classOf.get(r.testId) : undefined) ?? classFromName(testName);
    const name = className && !testName.startsWith(`${className}.`) ? `${className}.${testName}` : testName;
    const outcome = OUTCOMES[r.outcome ?? ''] ?? 'error';
    const id = name;
    if (seen.has(id)) continue;
    seen.add(id);
    const leaf = (className && name.startsWith(`${className}.`) ? name.slice(className.length + 1) : name).split('(')[0]!.trim();
    cases.push({ id, file: className, name, outcome, leaf });
  }
  return cases;
}

/** Strips comments and string/char literals so declarations can be scanned. */
function stripNoise(src: string): string {
  return src.replace(
    /"""[\s\S]*?"""|@"(?:""|[^"])*"|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    ' ',
  );
}

/**
 * Fully qualified names (`Ns.Class`, nested `Ns.Outer+Inner`) of the classes declared in a C# file,
 * for block (`namespace X { }`) and file-scoped (`namespace X;`) namespaces.
 */
export function declaredClasses(src: string): string[] {
  const out: string[] = [];
  type Frame = { kind: 'ns' | 'class' | 'other'; name: string };
  const stack: Frame[] = [];
  let fileNs = '';
  let pending: Frame | undefined;
  const re = /\bnamespace\s+([\w.]+)\s*([;{])|\bclass\s+(\w+)|([{}])/g;
  for (const m of stripNoise(src).matchAll(re)) {
    if (m[1] !== undefined) {
      if (m[2] === ';') fileNs = m[1];
      else {
        // Block namespace: the `{` is part of this match, so push it right away.
        stack.push({ kind: 'ns', name: m[1] });
      }
    } else if (m[3] !== undefined) {
      if (m[3] !== 'where') pending = { kind: 'class', name: m[3] };
    } else if (m[4] === '{') {
      const frame = pending ?? { kind: 'other', name: '' };
      pending = undefined;
      stack.push(frame);
      if (frame.kind === 'class') {
        const ns = [fileNs, ...stack.filter((f) => f.kind === 'ns').map((f) => f.name)].filter(Boolean).join('.');
        const outer = stack.filter((f) => f.kind === 'class').map((f) => f.name).join('+');
        out.push(ns ? `${ns}.${outer}` : outer);
      }
    } else if (m[4] === '}') {
      stack.pop();
    }
  }
  return out;
}

/** The `dotnet test` command line (without the executable). */
export function dotnetTestArgs(resultsDir: string, args: string[], filter?: string, target?: string): string[] {
  return [
    'test',
    ...(target ? [target] : []),
    '--nologo',
    '--logger',
    'trx',
    '--results-directory',
    resultsDir,
    ...(filter ? ['--filter', filter] : []),
    ...args,
  ];
}

/** `FullyQualifiedName~A|FullyQualifiedName~B` for the classes declared in `files`; undefined when none are found. */
export function classFilter(classes: string[]): string | undefined {
  const unique = [...new Set(classes)];
  return unique.length ? unique.map((c) => `FullyQualifiedName~${c}`).join('|') : undefined;
}

function projectEntries(root: string): string[] {
  try {
    return readdirSync(root).filter((f) => PROJECT.test(f)).sort();
  } catch {
    return [];
  }
}

export const dotnet: Runner = {
  name: 'dotnet',
  async detect(root) {
    return projectEntries(root).length > 0 ? 10 : 0;
  },
  async run({ cwd, files, args = [], env: extraEnv, timeoutMs }) {
    const start = Date.now();
    const dir = await mkdtemp(join(tmpdir(), 'trustbut-trx-'));
    try {
      let filter: string | undefined;
      if (files) {
        const classes: string[] = [];
        for (const f of files) {
          try {
            classes.push(...declaredClasses(await readFile(join(cwd, f), 'utf8')));
          } catch {
            // unreadable: contributes no filter
          }
        }
        filter = classFilter(classes); // undefined = could not tell, so the whole suite runs
      }
      const entries = projectEntries(cwd);
      // `dotnet test` refuses a folder with more than one project/solution file; prefer a solution.
      const target = entries.length > 1 ? (entries.find((e) => /\.slnx?$/.test(e)) ?? entries[0]) : undefined;
      const env = childEnv({ DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', ...extraEnv });
      const res = await runInGroup('dotnet', dotnetTestArgs(dir, args, filter, target), { cwd, env, timeoutMs });
      const cases: TestCaseResult[] = [];
      for (const f of (await readdir(dir)).filter((n) => n.endsWith('.trx')).sort()) {
        cases.push(...parseTrx(await readFile(join(dir, f), 'utf8')));
      }
      const exitCode = res.exitCode ?? 1;
      // A build/restore failure writes no results: surface it as one error case instead of "no tests".
      if (exitCode !== 0 && !cases.some((c) => c.outcome === 'fail' || c.outcome === 'error')) {
        cases.push({ id: '[dotnet]::[build]', file: '[dotnet]', name: '[build or run failed]', outcome: 'error' });
      }
      return { exitCode, cases, durationMs: Date.now() - start, output: runOutput(res) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  casesInFile(c, file, readHead: ReadHead) {
    const classes = declaredClasses(readHead(file.split(sep).join('/')));
    return classes.some((k) => c.file === k || c.file.startsWith(`${k}+`));
  },
};
