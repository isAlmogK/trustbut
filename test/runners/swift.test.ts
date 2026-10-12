import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVerify } from '../../src/commands/verify.js';
import { detectRunner } from '../../src/runners/registry.js';
import { parseSwiftXunit, swift, swiftArgs, swiftDeclarations, swiftFilters } from '../../src/runners/swift.js';
import { branch, commitAll, makeRepo, writeFiles } from '../helpers/repo.js';
import { hasTool, requiredTools } from '../helpers/toolchain.js';

const fx = (name: string) => new URL(`../fixtures/runners/swift/${name}`, import.meta.url).pathname;

describe('parseSwiftXunit', () => {
  it('parses XCTest xunit: Module.Class::method ids and leaves', async () => {
    const cases = parseSwiftXunit(await readFile(fx('xctest.xml'), 'utf8'));
    expect(cases.map((c) => [c.id, c.outcome, c.leaf])).toEqual([
      ['CalcTests.CalcTests::testAdds', 'pass', 'testAdds'],
      ['CalcTests.CalcTests::testSkipped', 'pass', 'testSkipped'], // swift-corelibs --parallel reports XCTSkip as a plain pass
      ['CalcTests.CalcTests::testFails', 'fail', 'testFails'],
    ]);
    expect(cases[0]!.file).toBe('CalcTests.CalcTests');
  });

  it('parses Swift Testing xunit (<out>-swift-testing.xml): suite and free functions, parameters dropped from the leaf', async () => {
    const cases = parseSwiftXunit(await readFile(fx('swift-testing.xml'), 'utf8'));
    expect(cases.map((c) => [c.id, c.outcome, c.leaf])).toEqual([
      ['CalcTests.MathSuite::fails()', 'fail', 'fails'],
      ['CalcTests.MathSuite::named()', 'pass', 'named'],
      ['CalcTests.MathSuite::param(x:)', 'pass', 'param'],
      ['CalcTests.MathSuite::adds()', 'pass', 'adds'],
      ['CalcTests::topLevel()', 'pass', 'topLevel'],
    ]);
  });

  it('maps skipped and error elements and keeps the worst outcome for repeated ids', () => {
    const xml = `<testsuites><testsuite name="TestResults">
      <testcase classname="M.A" name="a"><skipped/></testcase>
      <testcase classname="M.A" name="b"><error message="x"/></testcase>
      <testcase classname="M.A" name="c"/><testcase classname="M.A" name="c"><failure message="f"/></testcase>
    </testsuite></testsuites>`;
    expect(parseSwiftXunit(xml).map((c) => [c.name, c.outcome])).toEqual([['a', 'skip'], ['b', 'error'], ['c', 'fail']]);
  });
});

describe('swift declarations and filters', () => {
  const src = `import XCTest
import Testing
final class CalcTests: XCTestCase { func testA() {} }
@Suite struct MathSuite {
  @Test func adds() {}
}
@Test func topLevel() {}
@Test("named")
func other() {}
`;
  it('finds types and free @Test functions', () => {
    const d = swiftDeclarations(src);
    expect(d.types).toEqual(['CalcTests', 'MathSuite']);
    expect(d.freeTests).toEqual(['topLevel', 'other']);
  });
  it('builds --filter regexes; none for a helper file', () => {
    expect(swiftFilters([src])).toEqual(['\\.CalcTests/', '\\.MathSuite/', '\\.topLevel\\(', '\\.other\\(']);
    expect(swiftFilters(['struct Helper { }\n'])).toEqual([]);
    expect(swiftArgs('/t/r.xml', ['-c', 'release'], ['\\.A/'])).toEqual(['test', '--parallel', '--xunit-output', '/t/r.xml', '--filter', '\\.A/', '-c', 'release']);
  });
  it('casesInFile matches by declared type or free function', () => {
    const xc = { id: 'CalcTests.CalcTests::testA', file: 'CalcTests.CalcTests', name: 'testA', outcome: 'pass' as const, leaf: 'testA' };
    const st = { id: 'CalcTests.MathSuite::adds()', file: 'CalcTests.MathSuite', name: 'adds()', outcome: 'pass' as const, leaf: 'adds' };
    const free = { id: 'CalcTests::topLevel()', file: 'CalcTests', name: 'topLevel()', outcome: 'pass' as const, leaf: 'topLevel' };
    const other = { id: 'CalcTests.Other::x()', file: 'CalcTests.Other', name: 'x()', outcome: 'pass' as const, leaf: 'x' };
    const read = () => src;
    expect([xc, st, free, other].map((c) => swift.casesInFile!(c, 'Tests/CalcTests/CalcTests.swift', read))).toEqual([true, true, true, false]);
  });
});

describe('swift detection', () => {
  it('Package.swift', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-swift-'));
    expect(await swift.detect(dir)).toBe(0);
    await writeFile(join(dir, 'Package.swift'), '// swift-tools-version:5.9\n');
    expect(await swift.detect(dir)).toBe(10);
    expect((await detectRunner(dir))?.name).toBe('swift');
    expect(await swift.detect(join(dir, 'missing'))).toBe(0);
  });
});

describe('swift runner with a fake swift', () => {
  async function project(exit: number, writeReports: boolean) {
    const dir = await mkdtemp(join(tmpdir(), 'tb-swproj-'));
    const bin = await mkdtemp(join(tmpdir(), 'tb-fakeswift-'));
    // The fake finds --xunit-output, writes the sample XCTest report there and the Swift Testing one next to it.
    const body = `echo "ARGS: $*" >&2\nwhile [ $# -gt 0 ]; do if [ "$1" = --xunit-output ]; then ${
      writeReports ? `cp '${fx('xctest.xml')}' "$2"; cp '${fx('swift-testing.xml')}' "\${2%.xml}-swift-testing.xml"` : ':'
    }; fi; shift; done\nexit ${exit}\n`;
    await writeFile(join(bin, 'swift'), `#!/bin/sh\n${body}`);
    await chmod(join(bin, 'swift'), 0o755);
    await writeFile(join(dir, 'Package.swift'), '');
    await mkdir(join(dir, 'Tests', 'CalcTests'), { recursive: true });
    await writeFile(join(dir, 'Tests', 'CalcTests', 'CalcTests.swift'), 'final class CalcTests: XCTestCase {}\n');
    await writeFile(join(dir, 'Tests', 'CalcTests', 'Helper.swift'), 'struct Helper {}\n');
    return { dir, env: { PATH: `${bin}:${process.env.PATH}` } };
  }

  it('passes --parallel --xunit-output, a filter for the changed files, config args; merges both reports', async () => {
    const { dir, env } = await project(1, true);
    const res = await swift.run({ cwd: dir, env, files: ['Tests/CalcTests/CalcTests.swift'], args: ['-c', 'release'] });
    expect(res.output).toMatch(/ARGS: test --parallel --xunit-output \S+results\.xml --filter \\\.CalcTests\/ -c release/);
    expect(res.exitCode).toBe(1);
    expect(res.cases).toHaveLength(8);
    expect(res.cases.map((c) => c.id)).toContain('CalcTests.MathSuite::fails()');
  });

  it('a helper alone means a full run', async () => {
    const { dir, env } = await project(0, true);
    const res = await swift.run({ cwd: dir, env, files: ['Tests/CalcTests/Helper.swift'] });
    expect(res.output).not.toContain('--filter');
  });

  it('a build failure (no report, non-zero exit) is one error case with its output', async () => {
    const { dir, env } = await project(1, false);
    const res = await swift.run({ cwd: dir, env });
    expect(res.exitCode).toBe(1);
    expect(res.cases.map((c) => c.outcome)).toEqual(['error']);
  });

  it('a missing swift is an error case, not "no tests"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-swnone-'));
    const res = await swift.run({ cwd: dir, env: { PATH: '/nonexistent' } });
    expect(res.exitCode).not.toBe(0);
    expect(res.cases.map((c) => c.outcome)).toEqual(['error']);
  });
});

const run = hasTool('swift') || requiredTools().has('swift');

describe.skipIf(!run)('trustbut verify with swift test (end to end)', () => {
  const CALC = (op: string) => `public func sum(_ a: Int, _ b: Int) -> Int { a ${op} b }\n`;
  const xctest = (cls: string, name: string, body: string) => `import XCTest\n@testable import Calc\n\nfinal class ${cls}: XCTestCase {\n    func ${name}() { ${body} }\n}\n`;
  const modern = (suite: string, name: string, body: string) => `import Testing\n@testable import Calc\n\n@Suite struct ${suite} {\n    @Test func ${name}() { ${body} }\n}\n`;
  const BASE = {
    'Package.swift': '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(\n    name: "Calc",\n    targets: [.target(name: "Calc"), .testTarget(name: "CalcTests", dependencies: ["Calc"])]\n)\n',
    'Sources/Calc/Calc.swift': CALC('-'),
    'Tests/CalcTests/OldTests.swift': xctest('OldTests', 'testZero', 'XCTAssertEqual(sum(0, 0), 0)'),
  };
  async function scenario(head: Record<string, string | null>) {
    const { dir } = await makeRepo(BASE);
    await branch(dir, 'agent-change');
    await writeFiles(dir, head);
    await commitAll(dir, 'agent change');
    return dir;
  }

  it('PASS: a fix proven by a new XCTest and a new Swift Testing test', async () => {
    const dir = await scenario({
      'Sources/Calc/Calc.swift': CALC('+'),
      'Tests/CalcTests/CalcTests.swift': xctest('CalcTests', 'testAdds', 'XCTAssertEqual(sum(2, 3), 5)'),
      'Tests/CalcTests/ModernTests.swift': modern('MathSuite', 'adds', '#expect(sum(2, 3) == 5)'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.runner).toBe('swift');
    expect(receipt.proofs.map((p) => [p.file, p.name, p.before, p.verdict]).sort()).toEqual([
      ['Tests/CalcTests/CalcTests.swift', 'testAdds', 'fail', 'proves-change'],
      ['Tests/CalcTests/ModernTests.swift', 'adds()', 'fail', 'proves-change'],
    ]);
    expect(receipt.verdict).toBe('pass');
  }, 420_000);

  it('WARN: a new test that passes without the change', async () => {
    const dir = await scenario({
      'Sources/Calc/Calc.swift': CALC('+'),
      'Tests/CalcTests/ZeroTests.swift': xctest('ZeroTests', 'testZero2', 'XCTAssertEqual(sum(0, 0), 0)'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('warn');
    expect(receipt.findings.map((f) => f.id)).toContain('test-passes-without-change');
  }, 420_000);

  it('a test file that does not compile is an error, not a proof', async () => {
    const dir = await scenario({ 'Sources/Calc/Calc.swift': CALC('+'), 'Tests/CalcTests/BadTests.swift': xctest('BadTests', 'testX', 'XCTAssertEqual(sumx(1, 2), 3)') });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('fail');
  }, 420_000);
});
