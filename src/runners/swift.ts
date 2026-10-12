import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInGroup } from '../process.js';
import type { TestCaseResult } from '../types.js';
import { addCase } from './cases.js';
import { anyExists } from './detect.js';
import { childEnv, runOutput } from './env.js';
import { parseJUnit } from './junit.js';
import type { ReadHead, Runner } from './types.js';

/**
 * Parses SwiftPM's xunit output. `swift test --xunit-output f.xml` writes XCTest results to `f.xml` and Swift Testing
 * results to `f-swift-testing.xml`. Ids are `Module.Type::name` (XCTest: `CalcTests.CalcTests::testAdds`; Swift Testing:
 * `CalcTests.MathSuite::adds()`, a free `@Test func` has the module alone as its type). `file` holds the `Module.Type`
 * (there is no source path in the report); `leaf` is the method/function name without parameters.
 */
export function parseSwiftXunit(xml: string): TestCaseResult[] {
  const cases: TestCaseResult[] = [];
  const index = new Map<string, number>();
  for (const c of parseJUnit(xml)) {
    const type = c.file;
    addCase(cases, index, { id: `${type}::${c.name}`, file: type, name: c.name, outcome: c.outcome, leaf: c.name.replace(/\(.*\)$/s, '').replace(/^`|`$/g, '') });
  }
  return cases;
}

const unquote = (n: string): string => n.replace(/^`|`$/g, '');

/**
 * What a Swift test file declares: its types, its `func` names, its free (top-level) `@Test` functions, and whether it
 * defines tests at all (an `@Test` function, or a `func test…` next to XCTest). Base classes and `extension XCTestCase`
 * helpers define none.
 */
export function swiftDeclarations(src: string): { types: string[]; funcs: string[]; freeTests: string[]; hasTests: boolean } {
  const types = new Set<string>();
  const funcs = new Set<string>();
  const freeTests = new Set<string>();
  for (const m of src.matchAll(/^[ \t]*(?:@\w+(?:\([^)\n]*\))?[ \t]+)*(?:(?:public|internal|open|final|private|fileprivate)\s+)*(?:class|struct|actor|enum|extension)\s+(\w+)/gm)) types.add(m[1]!);
  for (const m of src.matchAll(/\bfunc\s+(`[^`\n]+`|\w+)/g)) funcs.add(unquote(m[1]!));
  // A top-level attribute list (one or more lines) ending in a func; the list says whether it is a test.
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith('@')) continue;
    let text = lines[i]!;
    let k = i;
    while (!/\bfunc\s/.test(text) && /^\s*@/.test(lines[k]!) && k + 1 < lines.length && !/[{]\s*$/.test(lines[k]!) && k - i < 6) text += `\n${lines[++k]}`;
    const m = /@Test\b[\s\S]*?\bfunc\s+(`[^`\n]+`|\w+)/.exec(text);
    if (m) freeTests.add(unquote(m[1]!));
  }
  const hasTests = /(^|[\s)])@Test\b/m.test(src) || (/XCTestCase/.test(src) && /\bfunc\s+test\w*\s*\(/.test(src));
  return { types: [...types], funcs: [...funcs], freeTests: [...freeTests], hasTests };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `--filter` regexes selecting the tests of the given test files (empty = no file defines tests, run everything). */
export function swiftFilters(sources: string[]): string[] {
  const out = new Set<string>();
  for (const src of sources) {
    const { types, freeTests, hasTests } = swiftDeclarations(src);
    if (!hasTests) continue;
    for (const t of types) if (t !== 'XCTestCase') out.add(`\\.${escapeRe(t)}/`);
    for (const f of freeTests) out.add(`\\.\`?${escapeRe(f)}\`?\\(`);
  }
  return [...out];
}

/**
 * Tests XCTest reports as skipped on stdout (`swift test --verbose`). The xunit file lists an `XCTSkip`ped test as a
 * plain pass under `--parallel`. macOS prints `Test Case '-[Module.Class method]' skipped`, Linux `Test Case 'Class.method' skipped`.
 */
export function parseSwiftSkips(stdout: string): { module?: string; type: string; method: string }[] {
  const out: { module?: string; type: string; method: string }[] = [];
  for (const m of stdout.matchAll(/^Test Case '-\[(?:(\w+)\.)?([\w.]+?) (\w+)\]' skipped/gm)) out.push({ ...(m[1] ? { module: m[1] } : {}), type: m[2]!, method: m[3]! });
  for (const m of stdout.matchAll(/^Test Case '([\w.]+)\.(\w+)' skipped/gm)) out.push({ type: m[1]!, method: m[2]! });
  return out;
}

/** The `swift` arguments (without the executable) for one run. */
export function swiftArgs(xunit: string, args: string[], filters: string[] = []): string[] {
  return ['test', '--parallel', '--verbose', '--xunit-output', xunit, ...filters.flatMap((f) => ['--filter', f]), ...args];
}

export const swift: Runner = {
  name: 'swift',
  async detect(root) {
    try {
      return anyExists(root, ['Package.swift']) ? 10 : 0;
    } catch {
      return 0;
    }
  },
  async run({ cwd, files, args = [], env: extraEnv, timeoutMs }) {
    const start = Date.now();
    const dir = await mkdtemp(join(tmpdir(), 'trustbut-swift-'));
    try {
      const xunit = join(dir, 'results.xml');
      // Only test files that declare tests are targets (helpers under Tests/ are not): if just helpers changed, run everything.
      const sources = (files ?? []).filter((f) => f.endsWith('.swift') && existsSync(join(cwd, f))).map((f) => readHeadSync(cwd, f));
      const filters = swiftFilters(sources);
      const execute = async (selected: string[]) => {
        const res = await runInGroup('swift', swiftArgs(xunit, args, selected), { cwd, env: childEnv(extraEnv), timeoutMs });
        const cases: TestCaseResult[] = [];
        const index = new Map<string, number>();
        for (const path of [xunit, join(dir, 'results-swift-testing.xml')]) {
          if (!existsSync(path)) continue;
          try {
            for (const c of parseSwiftXunit(await readFile(path, 'utf8'))) addCase(cases, index, c);
          } catch {
            // truncated report (killed run): treated like no report below
          }
          await rm(path, { force: true });
        }
        // XCTSkip shows as a pass in the xunit: take it from the verbose log.
        for (const sk of parseSwiftSkips(res.stdout)) {
          for (const c of cases) {
            if (c.outcome === 'pass' && c.leaf === sk.method && (c.file === `${sk.module}.${sk.type}` || (!sk.module && (c.file === sk.type || c.file.endsWith(`.${sk.type}`))))) c.outcome = 'skip';
          }
        }
        return { res, cases };
      };
      let { res, cases } = await execute(filters);
      // Filters that selected nothing (exit 0, no results) mean the names were not tests: run everything.
      if (filters.length > 0 && res.exitCode === 0 && cases.length === 0) ({ res, cases } = await execute([]));
      const exitCode = res.exitCode ?? 1;
      // A build failure writes no report: report one error case instead of "no tests".
      if (exitCode !== 0 && !cases.some((c) => c.outcome === 'fail' || c.outcome === 'error')) {
        cases.push({ id: '[swift]::[build or run failed]', file: '[swift]', name: '[build or run failed]', outcome: 'error' });
      }
      return { exitCode, cases, durationMs: Date.now() - start, output: runOutput(res) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  casesInFile(c, file, readHead: ReadHead) {
    const { types, funcs, freeTests } = swiftDeclarations(readHead(file));
    const leaf = unquote(c.leaf ?? c.name.replace(/\(.*\)$/s, ''));
    const segments = c.file.split('.');
    // The type must be declared here and so must the test function (an extension file does not claim the whole type).
    if (segments.length > 1) return segments.slice(1).some((s) => types.includes(s)) && funcs.includes(leaf);
    return freeTests.includes(leaf);
  },
};

function readHeadSync(cwd: string, file: string): string {
  try {
    return readFileSync(join(cwd, file), 'utf8');
  } catch {
    return '';
  }
}
