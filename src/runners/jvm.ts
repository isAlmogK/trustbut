// Shared by the Maven and Gradle runners: JUnit XML parsing, report discovery, class names, wrappers.
import { accessSync, constants, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { runInGroup } from '../process.js';
import type { RunResult, TestCaseResult } from '../types.js';
import { addCase } from './cases.js';
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

/** The method name of a JUnit test name: `adds(int)[1]` -> `adds`; a pure display name (`[1] 2, 3`) stays as is. */
export function jvmLeaf(name: string): string {
  const leaf = name.replace(/(?:\([^)]*\)|\[[^\]]*\])+$/s, '').trim();
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

const TOP_LEVEL_CLASS = /^((?:(?:public|internal|private|protected|abstract|final|open|data|sealed|static)\s+)*)(?:class|object)\s+(\w+)/gm;

/** Fully qualified top-level classes (declared at column 0) of a source file; nested classes are matched by `Outer$`. */
export function declaredJvmClasses(file: string, src: string, concreteOnly = false): string[] {
  const f = file.split(sep).join('/');
  const pkg = jvmPackage(src) ?? packageFromPath(f);
  const names: string[] = [];
  for (const m of src.matchAll(TOP_LEVEL_CLASS)) if (!(concreteOnly && /\babstract\b/.test(m[1]!))) names.push(m[2]!);
  // Nothing readable (head missing): the file name is the best guess.
  if (!names.length && !concreteOnly) names.push((f.split('/').pop() ?? f).replace(/\.(java|kt|kts)$/, ''));
  return names.map((n) => (pkg ? `${pkg}.${n}` : n));
}

/** Whether result `c` (file = class name) comes from the changed source `file`. */
export function casesInJvmFile(c: TestCaseResult, file: string, readHead: ReadHead): boolean {
  const f = file.split(sep).join('/');
  if (!/\.(java|kt)$/.test(f)) return false;
  return declaredJvmClasses(f, readHead(f)).some((fq) => c.file === fq || c.file.startsWith(`${fq}$`));
}

const SOURCE_SET_FILE = /(?:^|\/)src\/test\/(?:java|kotlin)\/.+\.(?:java|kt)$/;
// Maven Failsafe's default integration-test names (`**/*IT`, `**/*ITCase`); Surefire's `test` phase does not run them.
// (Failsafe's `IT*` prefix is left out: it would drop `ITest` or `ITokenizerTest`, which Surefire does run.)
const INTEGRATION = /(?:IT|ITCase)$/;
const TEST_MARKER = /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|Nested)\b|extends\s+TestCase\b/;
// A top-level abstract class: at column 0, possibly after same-line annotations (nested classes and comments do not count).
const ABSTRACT_CLASS = /^(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|internal|private|protected|sealed|open|static|final)\s+)*abstract\s+(?:\w+\s+)*class\b/m;

/**
 * Fully qualified names of the test classes among `files`; helpers without tests are left out (empty = run everything).
 * `skipIntegration` (Maven) leaves out Failsafe integration tests, which `mvn test` does not run.
 */
export function jvmTestClasses(cwd: string, files: string[] | undefined, skipIntegration = false): string[] {
  const out: string[] = [];
  for (const file of files ?? []) {
    const f = file.split(sep).join('/');
    if (!SOURCE_SET_FILE.test(f) || !existsSync(join(cwd, f))) continue;
    const src = readFileSync(join(cwd, f), 'utf8');
    if (!TEST_MARKER.test(src)) continue;
    let classes = declaredJvmClasses(f, src, true);
    // `@Tag("x") class FooTest` hides the class from the column-0 match: the file name is the class then, unless it is abstract.
    if (!classes.length && !ABSTRACT_CLASS.test(src)) classes = declaredJvmClasses(f, src);
    for (const fq of classes) {
      if (!(skipIntegration && INTEGRATION.test(fq.split('.').pop()!)) && !out.includes(fq)) out.push(fq);
    }
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
        // One folder per test task: `test`, Android `testDebugUnitTest`, custom ones.
        const results = join(path, 'test-results');
        let tasks: string[] = [];
        try {
          tasks = readdirSync(results, { withFileTypes: true }).filter((t) => t.isDirectory()).map((t) => t.name).sort();
        } catch {
          // no test results
        }
        for (const t of tasks) found.push(join(results, t));
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
  buildArgs(classes: string[], args: string[], init?: string): string[];
  /** Content of an init script written to a temporary file and passed as `init`. */
  initScript?: string;
  /** The tool is told to carry on after failing tests; the exit code is then derived from the reports. */
  ignoresTestFailures?: boolean;
  /** Its test task does not run integration tests (`*IT`, `*ITCase`: Maven Failsafe), so they are not selected. */
  skipsIntegrationTests?: boolean;
}

export async function runJvm(tool: JvmTool, { cwd, worktree, files, args = [], env: extraEnv, timeoutMs }: RunOptions): Promise<RunResult> {
  const start = Date.now();
  // Reports left over from an earlier build must not pass for this run.
  for (const dir of findReportDirs(cwd, tool.kind)) rmSync(dir, { recursive: true, force: true });
  const classes = jvmTestClasses(cwd, files, tool.skipsIntegrationTests);
  const { cmd, prefix } = resolveLauncher(cwd, worktree, tool.wrapper, tool.bin);
  const tmp = tool.initScript ? await mkdtemp(join(tmpdir(), 'trustbut-jvm-')) : undefined;
  let res;
  try {
    let init: string | undefined;
    if (tmp) {
      init = join(tmp, 'trustbut.init.gradle');
      await writeFile(init, tool.initScript!);
    }
    res = await runInGroup(cmd, [...prefix, ...tool.buildArgs(classes, args, init)], { cwd, env: childEnv(extraEnv), timeoutMs });
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
  const cases: TestCaseResult[] = [];
  const index = new Map<string, number>();
  for (const report of findReports(cwd, tool.kind)) {
    for (const c of parseJvmJUnit(readFileSync(report, 'utf8'))) addCase(cases, index, c);
  }
  let exitCode = res.exitCode ?? 1;
  // Failing tests did not stop the build: the tool's own non-zero code means a build failure, else the reports decide.
  if (tool.ignoresTestFailures && exitCode === 0) exitCode = cases.some((c) => c.outcome === 'fail' || c.outcome === 'error') ? 1 : 0;
  // A compile or configuration failure writes no failing test: report one error case instead of "no tests".
  if (exitCode !== 0 && !cases.some((c) => c.outcome === 'fail' || c.outcome === 'error')) {
    cases.push({ id: `[${tool.name}]::[build failed]`, file: `[${tool.name}]`, name: '[build failed]', outcome: 'error' });
  }
  return { exitCode, cases, durationMs: Date.now() - start, output: runOutput(res) };
}
