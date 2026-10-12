import { describe, expect, it } from 'vitest';
import { parseJestJson } from '../src/runners/jest.js';
import { parseJUnit } from '../src/runners/junit.js';

const suite = (cases: string) => `<?xml version="1.0"?><testsuites><testsuite name="s">${cases}</testsuite></testsuites>`;

describe('failure messages on test cases', () => {
  it('JUnit: the failure or error message attribute, else the first line of its text', () => {
    const cases = parseJUnit(
      suite(
        [
          '<testcase name="a" file="t/a.test.js"><failure message="expected 5, got -1" type="AssertionError">at x.js:1</failure></testcase>',
          '<testcase name="b" file="t/a.test.js"><error message="boom"/></testcase>',
          '<testcase name="c" file="t/a.test.js"><failure>\n  AssertionError: nope\n  at y.js:2\n</failure></testcase>',
          '<testcase name="d" file="t/a.test.js"><failure/></testcase>',
          '<testcase name="e" file="t/a.test.js"/>',
        ].join(''),
      ),
    );
    expect(cases.map((c) => [c.name, c.outcome, c.message])).toEqual([
      ['a', 'fail', 'expected 5, got -1'],
      ['b', 'error', 'boom'],
      ['c', 'fail', 'AssertionError: nope'],
      ['d', 'fail', undefined],
      ['e', 'pass', undefined],
    ]);
    expect(Object.keys(cases[4]!)).not.toContain('message');
  });

  it('flattens and clips messages to 300 characters', () => {
    const [c] = parseJUnit(suite(`<testcase name="a" file="t/a.test.js"><failure message="line one\nline two ${'x'.repeat(400)}"/></testcase>`));
    expect(c!.message!.startsWith('line one line two xxx')).toBe(true);
    expect(c!.message!.length).toBe(300);
    expect(c!.message!.endsWith('…')).toBe(true);
  });

  it('Jest: the first failure message without colour codes, and a suite error message', () => {
    const json = JSON.stringify({
      testResults: [
        { name: '/r/t/a.test.js', assertionResults: [{ fullName: 'a works', status: 'failed', failureMessages: ['\u001b[31mError: expect(received).toBe(expected)\u001b[39m\n\nExpected: 5\nReceived: -1\n    at Object.<anonymous>'] }] },
        { name: '/r/t/b.test.js', status: 'failed', message: 'Cannot find module ./x', assertionResults: [] },
      ],
    });
    const cases = parseJestJson(json, '/r');
    expect(cases.map((c) => c.message)).toEqual(['Error: expect(received).toBe(expected) Expected: 5 Received: -1 at Object.<anonymous>', 'Cannot find module ./x']);
  });
});
