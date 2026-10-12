// Shared by the Maven and Gradle runners: JUnit XML parsing, report discovery, class names, wrappers.
import { accessSync, constants, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { runInGroup } from '../process.js';
import type { RunResult, TestCaseResult } from '../types.js';
import { childEnv, runOutput } from './env.js';
import type { ReadHead, RunOptions } from './types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => name === 'testsuite' || name === 'testcase',
});

interface Case {
  name?: string | number;
  classname?: string;
  failure?: unknown;
  error?: unknown;
  skipped?: unknown;
}
interface Suite {
  name?: string;
  testcase?: Case[];
  testsuite?: Suite[];
}

const SEVERITY: Record<TestCaseResult['outcome'], number> = { pass: 0, skip: 1, fail: 2, error: 3 };

/** Adds `c`; if the id repeats (parameterized display names, one class listed twice) the worst outcome wins. */
export function addCase(cases: TestCaseResult[], index: Map<string, number>, c: TestCaseResult): void {
  const at = index.get(c.id);
  if (at === undefined) {
    index.set(c.id, cases.length);
    cases.push(c);
  } else if (SEVERITY[c.outcome] > SEVERITY[cases[at]!.outcome]) cases[at] = c;
}

/** The method name of a JUnit test name: `adds(int)[1]` -> `adds`; a pure display name (`[1] 2, 3`) stays as is. */
export function jvmLeaf(name: string): string {
  const leaf = name.replace(/[([{].*$/s, '').trim();
  return leaf || name;
}

/**
 * Parses one Surefire (`TEST-<class>.xml`) or Gradle (`TEST-<class>.xml`) JUnit report. Ids are `classname::name`;
 * `file` carries the class name (the report has no file path), see `casesInJvmFile`.
 */
export function parseJvmJUnit(xml: string): TestCaseResult[] {
  const doc = parser.parse(xml) as { testsuites?: { testsuite?: Suite[] }; testsuite?: Suite[] };
  const suites = doc.testsuites?.testsuite ?? doc.testsuite ?? [];
  const cases: TestCaseResult[] = [];
  const index = new Map<string, number>();
  const walk = (suite: Suite) => {
    for (const tc of suite.testcase ?? []) {
      const cls = String(tc.classname ?? suite.name ?? '');
      const name = String(tc.name ?? '');
      const outcome = tc.failure !== undefined ? 'fail' : tc.error !== undefined ? 'error' : tc.skipped !== undefined ? 'skip' : 'pass';
      addCase(cases, index, { id: `${cls}::${name}`, file: cls, name, outcome, leaf: jvmLeaf(name) });
    }
    for (const child of suite.testsuite ?? []) walk(child);
  };
  for (const suite of suites) walk(suite);
  return cases;
}

/** Package declared in a Java/Kotlin source (`package com.x;` / `package com.x`). */
export function jvmPackage(src: string): string | undefined {
  return /^\s*package\s+([\w.`]+)/m.exec(src)?.[1]?.replaceAll('`', '');
}

/** Directory of a source file below `src/<set>/(java|kotlin)/`, as a package name. */
function packageFromPath(file: string): string {
  const m = /(?:^|\/)src\/[^/]+\/(?:java|kotlin)\/(.+)$/.exec(file);
  const rel = m ? m[1]! : file;
  const dir = rel.split('/').slice(0, -1).join('.');
  return dir;
}

/** Fully qualified names of the classes a source file declares (its own name first; nested classes are matched by `Outer$`). */
export function declaredJvmClasses(file: string, src: string): string[] {
  const f = file.split(sep).join('/');
  const pkg = jvmPackage(src) ?? packageFromPath(f);
  const base = (f.split('/').pop() ?? f).replace(/\.(java|kt|kts)$/, '');
  const names = new Set([base]);
  for (const m of src.matchAll(/^[^\S\n]*(?:(?:public|internal|private|protected|abstract|final|open|data|sealed|static)\s+)*(?:class|object)\s+(\w+)/gm)) names.add(m[1]!);
  return [...names].map((n) => (pkg ? `${pkg}.${n}` : n));
}

/** Whether result `c` (file = class name) comes from the changed source `file`. */
export function casesInJvmFile(c: TestCaseResult, file: string, readHead: ReadHead): boolean {
  const f = file.split(sep).join('/');
  if (!/\.(java|kt)$/.test(f)) return false;
  return declaredJvmClasses(f, readHead(f)).some((fq) => c.file === fq || c.file.startsWith(`${fq}$`));
}

const SOURCE_SET_FILE = /(?:^|\/)src\/[^/]+\/(?:java|kotlin)\/.+\.(?:java|kt)$/;
const TEST_MARKER = /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|Nested)\b|extends\s+TestCase\b/;

/** Fully qualified names of the test classes among `files`; helpers without tests are left out (empty = run everything). */
export function jvmTestClasses(cwd: string, files: string[] | undefined): string[] {
  const out: string[] = [];
  for (const file of files ?? []) {
    const f = file.split(sep).join('/');
    if (!SOURCE_SET_FILE.test(f) || !existsSync(join(cwd, f))) continue;
    const src = readFileSync(join(cwd, f), 'utf8');
    if (!TEST_MARKER.test(src) || /\babstract\s+class\b/.test(src)) continue;
    const fq = declaredJvmClasses(f, src)[0]!;
    if (!out.includes(fq)) out.push(fq);
  }
  return out;
}

export type ReportKind = 'surefire' | 'gradle';

/** Report directories of every module below `root` (never inside node_modules, .git or other build output). */
export function findReportDirs(root: string, kind: ReportKind): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git' || e.isSymbolicLink()) continue;
      const path = join(dir, e.name);
      if (kind === 'surefire' && e.name === 'target') {
        const reports = join(path, 'surefire-reports');
        if (existsSync(reports)) found.push(reports);
      } else if (kind === 'gradle' && e.name === 'build') {
        const reports = join(path, 'test-results', 'test');
        if (existsSync(reports)) found.push(reports);
      } else walk(path);
    }
  };
  walk(root);
  return found;
}

/** `TEST-*.xml` files in every report directory below `root`. */
export function findReports(root: string, kind: ReportKind): string[] {
  const out: string[] = [];
  for (const dir of findReportDirs(root, kind)) {
    for (const name of readdirSync(dir).sort()) if (/^TEST-.*\.xml$/.test(name)) out.push(join(dir, name));
  }
  return out;
}

/** `./mvnw` / `./gradlew` from the package root up to the worktree top, else the tool from PATH. A non-executable wrapper runs through `sh`. */
export function resolveLauncher(cwd: string, worktree: string | undefined, wrapper: string, bin: string): { cmd: string; prefix: string[] } {
  const top = resolve(worktree ?? cwd);
  let dir = resolve(cwd);
  for (;;) {
    const path = join(dir, wrapper);
    if (existsSync(path)) {
      try {
        accessSync(path, constants.X_OK);
        return { cmd: path, prefix: [] };
      } catch {
        return { cmd: 'sh', prefix: [path] };
      }
    }
    if (dir === top || dirname(dir) === dir) return { cmd: bin, prefix: [] };
    dir = dirname(dir);
  }
}

export interface JvmTool {
  name: 'maven' | 'gradle';
  wrapper: string;
  bin: string;
  kind: ReportKind;
  /** Arguments after the executable, for the given test classes (empty = all) and config args. */
  buildArgs(classes: string[], args: string[]): string[];
}

export async function runJvm(tool: JvmTool, { cwd, worktree, files, args = [], env: extraEnv, timeoutMs }: RunOptions): Promise<RunResult> {
  const start = Date.now();
  // Reports left over from an earlier build must not pass for this run.
  for (const dir of findReportDirs(cwd, tool.kind)) rmSync(dir, { recursive: true, force: true });
  const classes = jvmTestClasses(cwd, files);
  const { cmd, prefix } = resolveLauncher(cwd, worktree, tool.wrapper, tool.bin);
  const res = await runInGroup(cmd, [...prefix, ...tool.buildArgs(classes, args)], { cwd, env: childEnv(extraEnv), timeoutMs });
  const cases: TestCaseResult[] = [];
  const index = new Map<string, number>();
  for (const report of findReports(cwd, tool.kind)) {
    for (const c of parseJvmJUnit(readFileSync(report, 'utf8'))) addCase(cases, index, c);
  }
  const exitCode = res.exitCode ?? 1;
  // A compile or configuration failure writes no failing test: report one error case instead of "no tests".
  if (exitCode !== 0 && !cases.some((c) => c.outcome === 'fail' || c.outcome === 'error')) {
    cases.push({ id: `[${tool.name}]::[build failed]`, file: `[${tool.name}]`, name: '[build failed]', outcome: 'error' });
  }
  return { exitCode, cases, durationMs: Date.now() - start, output: runOutput(res) };
}
