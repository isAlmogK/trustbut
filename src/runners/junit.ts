import { XMLParser } from 'fast-xml-parser';
import type { TestCaseResult, TestOutcome } from '../types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => name === 'testsuite' || name === 'testcase',
});

const LOOKS_LIKE_PATH = /\.[cm]?[jt]sx?$|\.py$/;

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

export function parseJUnit(xml: string): TestCaseResult[] {
  const doc = parser.parse(xml) as { testsuites?: { testsuite?: JUnitSuite[] }; testsuite?: JUnitSuite[] };
  const suites = doc.testsuites?.testsuite ?? doc.testsuite ?? [];
  const out: TestCaseResult[] = [];

  const walk = (suite: JUnitSuite) => {
    for (const tc of suite.testcase ?? []) {
      const outcome: TestOutcome =
        tc.failure !== undefined ? 'fail' : tc.error !== undefined ? 'error' : tc.skipped !== undefined ? 'skip' : 'pass';
      const suiteName = suite.name ?? '';
      const file = LOOKS_LIKE_PATH.test(suiteName) ? suiteName : (tc.file ?? tc.classname ?? '');
      const name = String(tc.name ?? '');
      out.push({ id: `${file}::${name}`, file, name, outcome });
    }
    for (const child of suite.testsuite ?? []) walk(child);
  };

  for (const suite of suites) walk(suite);
  return out;
}
