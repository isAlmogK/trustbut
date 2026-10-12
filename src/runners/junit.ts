import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { languageOf } from '../languages/index.js';
import type { TestCaseResult, TestOutcome } from '../types.js';
import { addCase } from './cases.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => name === 'testsuite' || name === 'testcase',
});

interface JUnitCase {
  name?: string | number;
  classname?: string;
  file?: string;
  failure?: unknown;
  error?: unknown;
  skipped?: unknown;
}
interface JUnitSuite {
  name?: string;
  testcase?: JUnitCase[];
  testsuite?: JUnitSuite[];
}

/** `file` relative to `root` (its real path first) when it is an absolute path below it; otherwise unchanged. */
function underRoot(file: string, root: string | undefined, real: string | undefined): string {
  if (!root || !isAbsolute(file)) return file;
  for (const base of [real, root]) {
    if (!base) continue;
    const rel = relative(base, file);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  }
  return file;
}

/**
 * Parses JUnit XML. With `root` (the package root the tool ran in), absolute `file` paths below it are made
 * relative to it, so ids are identical between the base and head checkouts. A repeated id keeps the worst outcome.
 */
export function parseJUnit(xml: string, root?: string): TestCaseResult[] {
  const doc = parser.parse(xml) as { testsuites?: { testsuite?: JUnitSuite[] }; testsuite?: JUnitSuite[] };
  const suites = doc.testsuites?.testsuite ?? doc.testsuite ?? [];
  const out: TestCaseResult[] = [];
  const index = new Map<string, number>();
  const real = root && existsSync(root) ? realpathSync(root) : undefined;

  const walk = (suite: JUnitSuite) => {
    for (const tc of suite.testcase ?? []) {
      const outcome: TestOutcome =
        tc.failure !== undefined ? 'fail' : tc.error !== undefined ? 'error' : tc.skipped !== undefined ? 'skip' : 'pass';
      const suiteName = suite.name ?? '';
      const file = underRoot(languageOf(suiteName) !== undefined ? suiteName : (tc.file ?? tc.classname ?? ''), root, real);
      const name = String(tc.name ?? '');
      addCase(out, index, { id: `${file}::${name}`, file, name, outcome });
    }
    for (const child of suite.testsuite ?? []) walk(child);
  };

  for (const suite of suites) walk(suite);
  return out;
}
