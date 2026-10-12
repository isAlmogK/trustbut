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
    addCase(cases, index, { id: `${type}::${c.name}`, file: type, name: c.name, outcome: c.outcome, leaf: c.name.replace(/\(.*\)$/s, '') });
  }
  return cases;
}

/** The types and free `@Test` functions a Swift test file declares: what `--filter` (a regex on `Module.Type/test`) selects by. */
export function swiftDeclarations(src: string): { types: string[]; freeTests: string[] } {
  const types = new Set<string>();
  const freeTests = new Set<string>();
  for (const m of src.matchAll(/^[ \t]*(?:@\w+(?:\([^)\n]*\))?[ \t]+)*(?:(?:public|internal|open|final|private|fileprivate)\s+)*(?:class|struct|actor|enum|extension)\s+(\w+)/gm)) types.add(m[1]!);
  for (const m of src.matchAll(/^@Test\b[^\n]*?\bfunc\s+(\w+)|^@Test\b[^\n]*\n\s*(?:(?:public|internal|private|fileprivate)\s+)*(?:async\s+)?func\s+(\w+)/gm)) freeTests.add(m[1] ?? m[2]!);
  return { types: [...types], freeTests: [...freeTests] };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `--filter` regexes selecting the tests of the given test files (empty = no usable names, run everything). */
export function swiftFilters(sources: string[]): string[] {
  const out = new Set<string>();
  for (const src of sources) {
    const { types, freeTests } = swiftDeclarations(src);
    // Only types that hold tests: XCTestCase subclasses and @Suite / types with @Test members, approximated by the file having tests at all.
    if (/XCTestCase|@Test\b|@Suite\b/.test(src)) {
      for (const t of types) out.add(`\\.${escapeRe(t)}/`);
      for (const f of freeTests) out.add(`\\.${escapeRe(f)}\\(`);
    }
  }
  return [...out];
}

/** The `swift` arguments (without the executable) for one run. */
export function swiftArgs(xunit: string, args: string[], filters: string[] = []): string[] {
  return ['test', '--parallel', '--xunit-output', xunit, ...filters.flatMap((f) => ['--filter', f]), ...args];
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
      const res = await runInGroup('swift', swiftArgs(xunit, args, filters), { cwd, env: childEnv(extraEnv), timeoutMs });
      const cases: TestCaseResult[] = [];
      const index = new Map<string, number>();
      for (const path of [xunit, join(dir, 'results-swift-testing.xml')]) {
        if (!existsSync(path)) continue;
        try {
          for (const c of parseSwiftXunit(await readFile(path, 'utf8'))) addCase(cases, index, c);
        } catch {
          // truncated report (killed run): treated like no report below
        }
      }
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
    const { types, freeTests } = swiftDeclarations(readHead(file));
    const segments = c.file.split('.');
    if (segments.length > 1) return segments.slice(1).some((s) => types.includes(s));
    return freeTests.includes(c.leaf ?? c.name.replace(/\(.*\)$/s, ''));
  },
};

function readHeadSync(cwd: string, file: string): string {
  try {
    return readFileSync(join(cwd, file), 'utf8');
  } catch {
    return '';
  }
}
