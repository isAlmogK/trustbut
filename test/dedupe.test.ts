import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProofs } from '../src/proof.js';
import { command } from '../src/runners/command.js';
import { parseTrx } from '../src/runners/dotnet.js';
import { parseGoJson } from '../src/runners/go.js';
import { parseJestJson } from '../src/runners/jest.js';
import { parseJUnit } from '../src/runners/junit.js';
import { parseMochaJson } from '../src/runners/mocha.js';
import { parseNodeTestEvents } from '../src/runners/node-test.js';
import type { ChangedFile, RunResult, TestCaseResult } from '../src/types.js';

const outcomes = (cases: TestCaseResult[]) => cases.map((c) => [c.id, c.outcome]);

describe('repeated ids keep the worst outcome (error > fail > skip > pass)', () => {
  it('parseJUnit', () => {
    const xml = `<testsuites>
      <testsuite name="a"><testcase classname="t" name="x" file="t/a_test.sh"/></testsuite>
      <testsuite name="b"><testcase classname="t" name="x" file="t/a_test.sh"><failure/></testcase></testsuite>
      <testsuite name="c"><testcase classname="t" name="x" file="t/a_test.sh"/></testsuite>
    </testsuites>`;
    expect(outcomes(parseJUnit(xml))).toEqual([['t/a_test.sh::x', 'fail']]);
  });

  it('parseTrx (one result per target framework)', () => {
    const trx = `<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results>
      <UnitTestResult executionId="1" testId="a" testName="Fx.Tests.CalcTests.Adds" outcome="Passed"/>
      <UnitTestResult executionId="2" testId="a" testName="Fx.Tests.CalcTests.Adds" outcome="Failed"/>
    </Results><TestDefinitions><UnitTest id="a"><TestMethod className="Fx.Tests.CalcTests" name="Adds"/></UnitTest></TestDefinitions></TestRun>`;
    expect(outcomes(parseTrx(trx))).toEqual([['Fx.Tests.CalcTests.Adds', 'fail']]);
  });

  it('parseJestJson', () => {
    const json = JSON.stringify({
      testResults: [
        { name: '/r/a.test.js', assertionResults: [{ fullName: 'x', status: 'passed' }, { fullName: 'x', status: 'failed' }, { fullName: 'x', status: 'passed' }] },
      ],
    });
    expect(outcomes(parseJestJson(json, '/r'))).toEqual([['a.test.js::x', 'fail']]);
  });

  it('parseMochaJson', () => {
    const json = JSON.stringify({ passes: [{ fullTitle: 'x', file: '/r/a.js' }], pending: [], failures: [{ title: 'x', fullTitle: 'x', file: '/r/a.js' }] });
    expect(outcomes(parseMochaJson(json, '/r'))).toEqual([['a.js::x', 'fail']]);
  });

  it('parseNodeTestEvents', () => {
    const ev = (type: string) => JSON.stringify({ type, name: 'x', nesting: 0, file: '/r/a.test.js' });
    const jsonl = [ev('test:start'), ev('test:fail'), ev('test:start'), ev('test:pass')].join('\n');
    expect(outcomes(parseNodeTestEvents(jsonl, '/r'))).toEqual([['a.test.js::x', 'fail']]);
  });

  it('parseGoJson', () => {
    const line = (action: string) => JSON.stringify({ Action: action, Package: 'example.com/fx', Test: 'TestX' });
    expect(outcomes(parseGoJson([line('pass'), line('fail')].join('\n')))).toEqual([['example.com/fx::TestX', 'fail']]);
  });

  it('buildProofs looks up the worst base outcome of a repeated id', () => {
    const tc = (outcome: TestCaseResult['outcome']): TestCaseResult => ({ id: 'a.test.js::x', file: 'a.test.js', name: 'x', outcome });
    const run = (cases: TestCaseResult[]): RunResult => ({ exitCode: 0, cases, durationMs: 1, output: '' });
    const file: ChangedFile = { path: 'a.test.js', status: 'added', kind: 'test', added: [], removed: [] };
    expect(buildProofs([file], run([tc('fail'), tc('pass')]), run([tc('pass')])).map((p) => [p.before, p.verdict])).toEqual([['fail', 'proves-change']]);
  });
});

describe('JUnit file paths are made relative to the package root', () => {
  it('parseJUnit(xml, root) relativises absolute paths under the (real) root and keeps relative ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tb-junitroot-'));
    const real = await realpath(root);
    const xml = `<testsuite name="s">
      <testcase name="a" file="${real}/tests/test_a.sh"/>
      <testcase name="b" file="${root}/tests/test_b.sh"/>
      <testcase name="c" file="tests/test_c.sh"/>
    </testsuite>`;
    expect(parseJUnit(xml, root).map((c) => [c.id, c.file])).toEqual([
      ['tests/test_a.sh::a', 'tests/test_a.sh'],
      ['tests/test_b.sh::b', 'tests/test_b.sh'],
      ['tests/test_c.sh::c', 'tests/test_c.sh'],
    ]);
  });

  it('the command runner reports root-relative files when the tool writes absolute ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-cmdabs-'));
    await mkdir(join(dir, 'out'));
    await writeFile(join(dir, 'run.sh'), `#!/bin/sh\necho "<testsuite name=\\"s\\"><testcase name=\\"v\\" file=\\"$PWD/tests/test_v.sh\\"/></testsuite>" > out/junit.xml\n`);
    await chmod(join(dir, 'run.sh'), 0o755);
    const res = await command.run({ cwd: dir, command: './run.sh', junit: 'out/junit.xml' });
    expect(res.cases.map((c) => [c.id, c.file])).toEqual([['tests/test_v.sh::v', 'tests/test_v.sh']]);
  });
});
