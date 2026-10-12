import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVerify } from '../../src/commands/verify.js';
import { declaredTests, go, goTestArgs, packageDir, parseGoJson, parseModulePath } from '../../src/runners/go.js';
import { detectRunner } from '../../src/runners/registry.js';
import { branch, commitAll, makeRepo, writeFiles } from '../helpers/repo.js';
import { hasTool, requiredTools } from '../helpers/toolchain.js';

// Captured from `go test -json ./...` (Go 1.26) on a small module.
const SAMPLE = [
  '{"Time":"2026-10-12T10:00:00Z","Action":"start","Package":"example.com/fx"}',
  '{"Time":"2026-10-12T10:00:00Z","Action":"run","Package":"example.com/fx","Test":"TestSum"}',
  '{"Time":"2026-10-12T10:00:00Z","Action":"output","Package":"example.com/fx","Test":"TestSum","Output":"=== RUN   TestSum\\n"}',
  '{"Time":"2026-10-12T10:00:00Z","Action":"run","Package":"example.com/fx","Test":"TestSum/neg"}',
  '{"Time":"2026-10-12T10:00:00Z","Action":"pass","Package":"example.com/fx","Test":"TestSum/neg","Elapsed":0}',
  '{"Time":"2026-10-12T10:00:00Z","Action":"fail","Package":"example.com/fx","Test":"TestSum","Elapsed":0}',
  '{"Time":"2026-10-12T10:00:00Z","Action":"run","Package":"example.com/fx","Test":"TestLater"}',
  '{"Time":"2026-10-12T10:00:00Z","Action":"skip","Package":"example.com/fx","Test":"TestLater","Elapsed":0}',
  '{"Time":"2026-10-12T10:00:00Z","Action":"output","Package":"example.com/fx","Output":"FAIL\\n"}',
  '{"Time":"2026-10-12T10:00:00Z","Action":"fail","Package":"example.com/fx","Elapsed":0.2}',
  '{"Time":"2026-10-12T10:00:00Z","Action":"pass","Package":"example.com/fx/pkg/sum","Test":"TestAdd","Elapsed":0}',
  '{"Time":"2026-10-12T10:00:00Z","Action":"pass","Package":"example.com/fx/pkg/sum","Elapsed":0.1}',
  '{"Time":"2026-10-12T10:00:00Z","Action":"output","Package":"example.com/fx/broken","Output":"FAIL\\texample.com/fx/broken [build failed]\\n"}',
  '{"Time":"2026-10-12T10:00:00Z","Action":"fail","Package":"example.com/fx/broken","Elapsed":0}',
  '{"Time":"2026-10-12T10:00:00Z","Action":"skip","Package":"example.com/fx/empty","Output":"?   \\texample.com/fx/empty\\t[no test files]\\n"}',
].join('\n');

describe('parseGoJson', () => {
  it('maps tests and subtests, and reports a build failure as one error case', () => {
    const dirOf = (p: string) => packageDir(p, 'example.com/fx');
    expect(parseGoJson(SAMPLE, dirOf).map((c) => [c.id, c.file, c.name, c.outcome])).toEqual([
      ['example.com/fx::TestSum/neg', '.', 'TestSum/neg', 'pass'],
      ['example.com/fx::TestSum', '.', 'TestSum', 'fail'],
      ['example.com/fx::TestLater', '.', 'TestLater', 'skip'],
      ['example.com/fx/pkg/sum::TestAdd', 'pkg/sum', 'TestAdd', 'pass'],
      ['example.com/fx/broken::[package]', 'broken', '[build failed]', 'error'],
    ]);
  });

  it('parses a real Go 1.26 build failure (build-output events have no Package)', () => {
    const real = [
      '{"ImportPath":"example.com/fx [example.com/fx.test]","Action":"build-output","Output":"./a_test.go:3:27: undefined: undefinedFn\\n"}',
      '{"ImportPath":"example.com/fx [example.com/fx.test]","Action":"build-fail"}',
      '{"Action":"start","Package":"example.com/fx"}',
      '{"Action":"output","Package":"example.com/fx","Output":"FAIL\\texample.com/fx [build failed]\\n"}',
      '{"Action":"fail","Package":"example.com/fx","Elapsed":0,"FailedBuild":"example.com/fx [example.com/fx.test]"}',
    ].join('\n');
    expect(parseGoJson(real, (p) => packageDir(p, 'example.com/fx')).map((c) => [c.id, c.file, c.outcome])).toEqual([
      ['example.com/fx::[package]', '.', 'error'],
    ]);
  });

  it('ignores non-JSON lines and a package that fails with a failed test', () => {
    expect(parseGoJson('go: downloading x\nnot json\n{bad')).toEqual([]);
  });
});

describe('go helpers', () => {
  it('reads the module path and derives package dirs', () => {
    expect(parseModulePath('// c\nmodule example.com/fx\n\ngo 1.21\n')).toBe('example.com/fx');
    expect(parseModulePath('module "example.com/q"\n')).toBe('example.com/q');
    expect(parseModulePath('go 1.21')).toBeUndefined();
    expect(packageDir('example.com/fx', 'example.com/fx')).toBe('.');
    expect(packageDir('example.com/fx/pkg/sum', 'example.com/fx')).toBe('pkg/sum');
  });

  it('finds top-level test functions but not methods', () => {
    const src = 'func TestA(t *testing.T) {}\nfunc BenchmarkB(b *testing.B) {}\nfunc FuzzC(f *testing.F) {}\nfunc ExampleD() {}\nfunc (s *S) TestMethod() {}\nfunc helper() {}\n';
    expect([...declaredTests(src)].sort()).toEqual(['BenchmarkB', 'ExampleD', 'FuzzC', 'TestA']);
  });

  it('builds the command with config args before the packages', () => {
    expect(goTestArgs(['-p', '1'], ['./a', './b'])).toEqual(['test', '-json', '-count=1', '-p', '1', './a', './b']);
  });
});

describe('go casesInFile', () => {
  const head = (src: string) => () => src;
  const c = (file: string, name: string) => ({ id: `m/${file}::${name}`, file, name, outcome: 'pass' as const });
  it('requires the same dir and a top-level name declared in the file', () => {
    const src = 'func TestSum(t *testing.T) {}\n';
    expect(go.casesInFile!(c('pkg/sum', 'TestSum'), 'pkg/sum/sum_test.go', head(src))).toBe(true);
    expect(go.casesInFile!(c('pkg/sum', 'TestSum/neg'), 'pkg/sum/sum_test.go', head(src))).toBe(true);
    expect(go.casesInFile!(c('pkg/sum', 'TestOther'), 'pkg/sum/sum_test.go', head(src))).toBe(false);
    expect(go.casesInFile!(c('pkg/other', 'TestSum'), 'pkg/sum/sum_test.go', head(src))).toBe(false);
    expect(go.casesInFile!(c('.', 'TestSum'), 'sum_test.go', head(src))).toBe(true);
  });
});

describe('go detection', () => {
  it('scores 10 with a go.mod and 0 without', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-go-'));
    expect(await go.detect(dir)).toBe(0);
    await writeFile(join(dir, 'go.mod'), 'module example.com/fx\n\ngo 1.21\n');
    expect(await go.detect(dir)).toBe(10);
    expect((await detectRunner(dir))?.name).toBe('go');
    expect(await go.detect(join(dir, 'missing'))).toBe(0);
  });
});

const runGo = hasTool('go', ['version']) || requiredTools().has('go');

describe.skipIf(!runGo)('go runner passes config args through', () => {
  it('puts config args on the go command line (fake go on PATH)', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'tb-fakego-'));
    const dir = await mkdtemp(join(tmpdir(), 'tb-gomod-'));
    await writeFile(join(dir, 'go.mod'), 'module example.com/fx\n');
    await writeFile(join(bin, 'go'), '#!/bin/sh\necho "ARGS: $*" >&2\nexit 0\n');
    await chmod(join(bin, 'go'), 0o755);
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev}`;
    try {
      const res = await go.run({ cwd: dir, args: ['-p', '1'] });
      expect(res.output).toContain('ARGS: test -json -count=1 -p 1 ./...');
    } finally {
      process.env.PATH = prev;
    }
  });
});

describe.skipIf(!runGo)('trustbut verify with go (end to end)', () => {
  const BASE = {
    'go.mod': 'module example.com/fx\n\ngo 1.21\n',
    'sum.go': 'package fx\n\nfunc Sum(a, b int) int { return a - b }\n',
    'old_test.go': 'package fx\n\nimport "testing"\n\nfunc TestTruth(t *testing.T) {\n\tif 1 != 1 {\n\t\tt.Fatal("no")\n\t}\n}\n',
  };
  const FIXED = 'package fx\n\nfunc Sum(a, b int) int { return a + b }\n';
  const sumTest = (body: string) => `package fx\n\nimport "testing"\n\n${body}\n`;
  async function scenario(head: Record<string, string | null>) {
    const { dir } = await makeRepo(BASE);
    await branch(dir, 'agent-change');
    await writeFiles(dir, head);
    await commitAll(dir, 'agent change');
    return dir;
  }

  it('PASS: a fix proven by a new test with a subtest', async () => {
    const dir = await scenario({
      'sum.go': FIXED,
      'sum_test.go': sumTest('func TestSum(t *testing.T) {\n\tt.Run("pos", func(t *testing.T) {\n\t\tif Sum(2, 3) != 5 {\n\t\t\tt.Fatal("bad")\n\t\t}\n\t})\n}'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.runner).toBe('go');
    expect(receipt.proofs.map((p) => [p.file, p.name, p.before, p.verdict])).toEqual([
      ['sum_test.go', 'TestSum/pos', 'fail', 'proves-change'],
      ['sum_test.go', 'TestSum', 'fail', 'proves-change'],
    ]);
    expect(receipt.verdict).toBe('pass');
  }, 180_000);

  it('PASS: a package in a subdirectory', async () => {
    const { dir } = await makeRepo({ ...BASE, 'pkg/sum/sum.go': 'package sum\n\nfunc Add(a, b int) int { return a - b }\n' });
    await branch(dir, 'agent-change');
    await writeFiles(dir, {
      'pkg/sum/sum.go': 'package sum\n\nfunc Add(a, b int) int { return a + b }\n',
      'pkg/sum/sum_test.go': 'package sum\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("bad")\n\t}\n}\n',
    });
    await commitAll(dir, 'agent change');
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.proofs.map((p) => [p.file, p.name, p.before, p.verdict])).toEqual([
      ['pkg/sum/sum_test.go', 'TestAdd', 'fail', 'proves-change'],
    ]);
    expect(receipt.verdict).toBe('pass');
  }, 180_000);

  it('WARN: a new test that passes without the change', async () => {
    const dir = await scenario({
      'sum.go': FIXED,
      'sum_test.go': sumTest('func TestZero(t *testing.T) {\n\tif Sum(0, 0) != 0 {\n\t\tt.Fatal("bad")\n\t}\n}'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('warn');
    expect(receipt.findings.map((f) => f.id)).toContain('test-passes-without-change');
  }, 180_000);

  it('shows a t.Skip test as a skipped proof', async () => {
    const dir = await scenario({
      'sum.go': FIXED,
      'sum_test.go': sumTest('func TestLater(t *testing.T) {\n\tt.Skip("later")\n}'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.proofs.map((p) => [p.name, p.verdict])).toEqual([['TestLater', 'skipped']]);
  }, 180_000);

  it('a test file that does not compile is an error, not a proof', async () => {
    const dir = await scenario({
      'sum.go': FIXED,
      'sum_test.go': sumTest('func TestBroken(t *testing.T) {\n\tundefinedFn()\n}'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('fail');
  }, 180_000);
});
