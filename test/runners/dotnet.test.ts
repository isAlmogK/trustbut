import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVerify } from '../../src/commands/verify.js';
import { classFilter, declaredClasses, dotnet, dotnetTestArgs, parseTrx } from '../../src/runners/dotnet.js';
import { detectRunner } from '../../src/runners/registry.js';
import { branch, commitAll, makeRepo, writeFiles } from '../helpers/repo.js';
import { hasTool, requiredTools } from '../helpers/toolchain.js';

const fixture = (name: string) => readFile(new URL(`../fixtures/runners/dotnet/${name}`, import.meta.url), 'utf8');

describe('parseTrx', () => {
  it('reads the namespaced TRX: class from TestDefinitions, outcomes, theory data and nested classes', async () => {
    const cases = parseTrx(await fixture('sample.trx'));
    expect(cases.map((c) => [c.file, c.name, c.outcome])).toEqual([
      ['Fx.Tests.CalcTests', 'Fx.Tests.CalcTests.Adds', 'pass'],
      ['Fx.Tests.CalcTests', 'Fx.Tests.CalcTests.Subtracts', 'fail'],
      ['Fx.Tests.CalcTests', 'Fx.Tests.CalcTests.Later', 'skip'],
      ['Fx.Tests.CalcTests', 'Fx.Tests.CalcTests.Multiplies(a: 2, b: 3)', 'pass'],
      ['Fx.Tests.Nested+Inner', 'Fx.Tests.Nested+Inner.Run', 'fail'],
    ]);
    expect(cases[0]!.id).toBe('Fx.Tests.CalcTests.Adds');
  });

  it('handles a TRX with a single result and no definitions, and an empty run', () => {
    const one =
      '<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results><UnitTestResult testId="x" testName="A.B.C.M(1)" outcome="Error"/></Results></TestRun>';
    expect(parseTrx(one).map((c) => [c.file, c.name, c.outcome])).toEqual([['A.B.C', 'A.B.C.M(1)', 'error']]);
    expect(parseTrx('<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results/></TestRun>')).toEqual([]);
  });

  it('skips the parent of data-driven rows', () => {
    const xml =
      '<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results>' +
      '<UnitTestResult executionId="p" testId="t" testName="M" outcome="Failed" resultType="DataDrivenTest"/>' +
      '<UnitTestResult executionId="c1" parentExecutionId="p" testId="t" testName="M (1)" outcome="Passed"/>' +
      '</Results><TestDefinitions><UnitTest id="t"><TestMethod className="N.C" name="M"/></UnitTest></TestDefinitions></TestRun>';
    expect(parseTrx(xml).map((c) => [c.name, c.outcome])).toEqual([['N.C.M (1)', 'pass']]);
  });
});

describe('declaredClasses', () => {
  it('reads block namespaces, file-scoped namespaces and nested classes', () => {
    expect(declaredClasses('using Xunit;\nnamespace Fx.Tests\n{\n  public class A { class B {} }\n  public class C<T> where T : class { }\n}\n')).toEqual([
      'Fx.Tests.A',
      'Fx.Tests.A+B',
      'Fx.Tests.C',
    ]);
    expect(declaredClasses('namespace Fx.Tests;\n\npublic class A {}\npublic sealed class B {}\n')).toEqual(['Fx.Tests.A', 'Fx.Tests.B']);
    expect(declaredClasses('namespace Outer { namespace Inner { class X {} } class Y {} }')).toEqual(['Outer.Inner.X', 'Outer.Y']);
    expect(declaredClasses('class Global {}')).toEqual(['Global']);
  });

  it('ignores classes in comments and strings', () => {
    expect(declaredClasses('namespace N;\n// class Fake\nvar s = "class Nope {"; /* class Nope2 */\npublic class Real {}\n')).toEqual(['N.Real']);
  });
});

describe('dotnet command line', () => {
  it('builds the trx logger command, with filter and config args', () => {
    expect(dotnetTestArgs('/r', ['-c', 'Release'], classFilter(['N.A', 'N.B', 'N.A']))).toEqual([
      'test', '--nologo', '--logger', 'trx', '--results-directory', '/r',
      '--filter', 'FullyQualifiedName~N.A|FullyQualifiedName~N.B', '-c', 'Release',
    ]);
    expect(dotnetTestArgs('/r', [], undefined, 'x.sln').slice(0, 2)).toEqual(['test', 'x.sln']);
    expect(classFilter([])).toBeUndefined();
  });
});

describe('dotnet casesInFile', () => {
  const c = (file: string) => ({ id: `${file}.M`, file, name: `${file}.M`, outcome: 'pass' as const });
  const head = () => 'namespace Fx.Tests;\npublic class CalcTests {}\n';
  it('matches the class declared in the file, including nested ones', () => {
    expect(dotnet.casesInFile!(c('Fx.Tests.CalcTests'), 'CalcTests.cs', head)).toBe(true);
    expect(dotnet.casesInFile!(c('Fx.Tests.CalcTests+Inner'), 'CalcTests.cs', head)).toBe(true);
    expect(dotnet.casesInFile!(c('Fx.Tests.Other'), 'CalcTests.cs', head)).toBe(false);
    expect(dotnet.casesInFile!(c('Fx.Tests.CalcTestsExtra'), 'CalcTests.cs', head)).toBe(false);
  });
});

describe('dotnet detection', () => {
  it('scores 10 with a solution or project file and 0 without', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-dotnet-'));
    expect(await dotnet.detect(dir)).toBe(0);
    await writeFile(join(dir, 'Fx.csproj'), '<Project Sdk="Microsoft.NET.Sdk"/>');
    expect(await dotnet.detect(dir)).toBe(10);
    expect((await detectRunner(dir))?.name).toBe('dotnet');
    expect(await dotnet.detect(join(dir, 'missing'))).toBe(0);
    const sln = await mkdtemp(join(tmpdir(), 'tb-dotnet-'));
    await writeFile(join(sln, 'Fx.sln'), '');
    expect(await dotnet.detect(sln)).toBe(10);
  });
});

describe('dotnet runner with a fake dotnet on PATH', () => {
  async function withFake<T>(script: string, fn: (dir: string) => Promise<T>): Promise<T> {
    const bin = await mkdtemp(join(tmpdir(), 'tb-fakedotnet-'));
    const dir = await mkdtemp(join(tmpdir(), 'tb-proj-'));
    await writeFile(join(dir, 'Fx.csproj'), '<Project Sdk="Microsoft.NET.Sdk"/>');
    await writeFile(join(dir, 'CalcTests.cs'), 'namespace Fx.Tests;\npublic class CalcTests {}\n');
    await writeFile(join(bin, 'dotnet'), script);
    await chmod(join(bin, 'dotnet'), 0o755);
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev}`;
    try {
      return await fn(dir);
    } finally {
      process.env.PATH = prev;
    }
  }
  // Writes the sample TRX into the --results-directory the runner passed.
  const sample = new URL('../fixtures/runners/dotnet/sample.trx', import.meta.url).pathname;
  const script = (exit: number) =>
    `#!/bin/sh\necho "ARGS: $*" >&2\nwhile [ $# -gt 0 ]; do if [ "$1" = --results-directory ]; then cp '${sample}' "$2/run.trx"; fi; shift; done\nexit ${exit}\n`;

  it('passes the logger, results dir, class filter and config args, then parses the TRX', async () => {
    await withFake(script(1), async (dir) => {
      const res = await dotnet.run({ cwd: dir, files: ['CalcTests.cs'], args: ['-c', 'Release'] });
      expect(res.output).toMatch(/ARGS: test --nologo --logger trx --results-directory \S+ --filter FullyQualifiedName~Fx\.Tests\.CalcTests -c Release/);
      expect(res.exitCode).toBe(1);
      expect(res.cases).toHaveLength(5);
    });
  });

  it('runs the whole suite when no class can be found in the changed files', async () => {
    await withFake(script(0), async (dir) => {
      await writeFile(join(dir, 'Empty.cs'), '// nothing\n');
      const res = await dotnet.run({ cwd: dir, files: ['Empty.cs'] });
      expect(res.output).not.toContain('--filter');
    });
  });

  it('reports a failed build (no TRX) as one error case', async () => {
    await withFake('#!/bin/sh\necho "error CS0103" >&2\nexit 1\n', async (dir) => {
      const res = await dotnet.run({ cwd: dir });
      expect(res.cases.map((c) => c.outcome)).toEqual(['error']);
    });
  });
});

const runDotnet = hasTool('dotnet') || requiredTools().has('dotnet');

describe.skipIf(!runDotnet)('trustbut verify with dotnet (end to end)', () => {
  const csproj =
    '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <IsPackable>false</IsPackable>\n  </PropertyGroup>\n' +
    '  <ItemGroup>\n    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />\n    <PackageReference Include="xunit" Version="2.9.2" />\n' +
    '    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />\n  </ItemGroup>\n</Project>\n';
  const BASE = {
    '.gitignore': 'bin\nobj\n',
    'Fx.Tests.csproj': csproj,
    'Calc.cs': 'namespace Fx;\n\npublic static class Calc\n{\n    public static int Sum(int a, int b) => a - b;\n}\n',
    'OldTests.cs': 'using Xunit;\nnamespace Fx.Tests;\n\npublic class OldTests\n{\n    [Fact]\n    public void Truth() => Assert.Equal(0, Fx.Calc.Sum(0, 0));\n}\n',
  };
  const FIXED = 'namespace Fx;\n\npublic static class Calc\n{\n    public static int Sum(int a, int b) => a + b;\n}\n';
  const tests = (cls: string, body: string) => `using Xunit;\nnamespace Fx.Tests;\n\npublic class ${cls}\n{\n${body}\n}\n`;
  async function scenario(head: Record<string, string | null>) {
    const { dir } = await makeRepo(BASE);
    await branch(dir, 'agent-change');
    await writeFiles(dir, head);
    await commitAll(dir, 'agent change');
    return dir;
  }

  it('PASS: a fix proven by a new test class', async () => {
    const dir = await scenario({
      'Calc.cs': FIXED,
      'CalcTests.cs': tests('CalcTests', '    [Fact]\n    public void Adds() => Assert.Equal(5, Fx.Calc.Sum(2, 3));'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.runner).toBe('dotnet');
    expect(receipt.proofs.map((p) => [p.file, p.name, p.before, p.verdict])).toEqual([
      ['CalcTests.cs', 'Fx.Tests.CalcTests.Adds', 'fail', 'proves-change'],
    ]);
    expect(receipt.verdict).toBe('pass');
  }, 600_000);

  it('WARN: a new test that passes without the change', async () => {
    const dir = await scenario({
      'Calc.cs': FIXED,
      'ZeroTests.cs': tests('ZeroTests', '    [Fact]\n    public void Zero() => Assert.Equal(0, Fx.Calc.Sum(0, 0));'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('warn');
    expect(receipt.findings.map((f) => f.id)).toContain('test-passes-without-change');
  }, 600_000);

  it('shows a skipped test as a skipped proof', async () => {
    const dir = await scenario({
      'Calc.cs': FIXED,
      'LaterTests.cs': tests('LaterTests', '    [Fact(Skip = "later")]\n    public void Later() { }'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.proofs.map((p) => [p.name, p.verdict])).toEqual([['Fx.Tests.LaterTests.Later', 'skipped']]);
  }, 600_000);

  it('a test file that does not compile is an error, not a proof', async () => {
    const dir = await scenario({
      'Calc.cs': FIXED,
      'BrokenTests.cs': tests('BrokenTests', '    [Fact]\n    public void Broken() => UndefinedFn();'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('fail');
  }, 600_000);
});
