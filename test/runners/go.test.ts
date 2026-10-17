import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVerify } from '../helpers/verify.js';
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

  it('sets the top-level test as the leaf', () => {
    expect(parseGoJson(SAMPLE).slice(0, 2).map((c) => c.leaf)).toEqual(['TestSum', 'TestSum']);
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
    expect(receipt.proofs.map((p) => p.verdict)).toContain('does-not-constrain');
  }, 180_000);

  it('shows a t.Skip test as a skipped proof', async () => {
    const dir = await scenario({
      'sum.go': FIXED,
      'sum_test.go': sumTest('func TestLater(t *testing.T) {\n\tt.Skip("later")\n}'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.proofs.map((p) => [p.name, p.verdict])).toEqual([['TestLater', 'skipped']]);
  }, 180_000);

  it('WARN: args that filter out every test (no results, exit 0) are not a silent PASS', async () => {
    const { dir } = await makeRepo({ ...BASE, '.trustbut.json': JSON.stringify({ args: ['-run', '^$'] }) });
    await branch(dir, 'agent-change');
    await writeFiles(dir, {
      'sub.go': 'package fx\n\nfunc Sub(a, b int) int { return a + b }\n',
      'sub_test.go': sumTest('func TestSub(t *testing.T) {\n\tif Sub(3, 2) != 1 {\n\t\tt.Fatal("bad")\n\t}\n}'),
    });
    await commitAll(dir, 'agent change');
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.after?.cases).toEqual([]);
    expect(receipt.verdict).toBe('warn');
    expect(receipt.findings.map((f) => f.id)).toEqual(expect.arrayContaining(['no-test-results', 'proofs-unmatched']));
  }, 180_000);

  it('a golden file under testdata/ is copied to base, so a test that passes without the change is caught (comment-only source change: PASS)', async () => {
    const dir = await scenario({
      'sum.go': 'package fx\n\n// Sum subtracts (comment-only change).\nfunc Sum(a, b int) int { return a - b }\n',
      'testdata/want.txt': '1\n',
      'golden_test.go': sumTest(
        'func TestGolden(t *testing.T) {\n\tb, err := os.ReadFile("testdata/want.txt")\n\tif err != nil {\n\t\tt.Fatal(err)\n\t}\n\tif strings.TrimSpace(string(b)) != strconv.Itoa(Sum(3, 2)) {\n\t\tt.Fatal("bad")\n\t}\n}',
      ).replace('import "testing"', 'import (\n\t"os"\n\t"strconv"\n\t"strings"\n\t"testing"\n)'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.proofs.map((p) => [p.name, p.before, p.verdict, p.weak])).toEqual([['TestGolden', 'pass', 'does-not-constrain', false]]);
    expect(receipt.verdict).toBe('pass');
  }, 180_000);

  const helperUser = (imports: string[], body: string) =>
    `package fx\n\nimport (\n\t"testing"\n${imports.map((i) => `\n\t"example.com/fx/${i}"`).join('')}\n)\n\n${body}\n`;

  it('copies changed test-helper packages under internal/test/ and internal/testutil/ to base', async () => {
    const dir = await scenario({
      'internal/test/two.go': 'package test\n\nimport "testing"\n\nfunc Two(t testing.TB) int {\n\tt.Helper()\n\treturn 2\n}\n',
      'internal/testutil/three.go': 'package testutil\n\nfunc Three() int { return 3 }\n',
      'helpers_test.go': helperUser(
        ['internal/test', 'internal/testutil'],
        'func TestFive(t *testing.T) {\n\tif test.Two(t)+testutil.Three() != 5 {\n\t\tt.Fatal("bad")\n\t}\n}',
      ),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.proofs.map((p) => [p.name, p.before, p.verdict])).toEqual([['TestFive', 'pass', 'does-not-constrain']]);
  }, 180_000);

  it('does not copy a package under internal/test/ that non-test code imports', async () => {
    const dir = await scenario({
      'internal/test/double.go': 'package test\n\nfunc Double(n int) int { return n * 2 }\n',
      'quad.go': 'package fx\n\nimport "example.com/fx/internal/test"\n\nfunc Quad(n int) int { return test.Double(test.Double(n)) }\n',
      'double_test.go': helperUser(['internal/test'], 'func TestDouble(t *testing.T) {\n\tif test.Double(2) != 4 {\n\t\tt.Fatal("bad")\n\t}\n}'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.proofs.map((p) => [p.name, p.verdict])).toEqual([['TestDouble', 'proves-change']]);
    expect(receipt.proofs.map((p) => p.verdict)).not.toContain('does-not-constrain');
  }, 180_000);

  it('does not copy a package under internal/testutil/ whose own tests changed', async () => {
    const dir = await scenario({
      'internal/testutil/clock.go': 'package testutil\n\nfunc Now() int { return 7 }\n',
      'internal/testutil/clock_test.go': 'package testutil\n\nimport "testing"\n\nfunc TestNow(t *testing.T) {\n\tif Now() != 7 {\n\t\tt.Fatal("bad")\n\t}\n}\n',
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.proofs.map((p) => [p.name, p.verdict])).toEqual([['TestNow', 'proves-change']]);
  }, 180_000);

  it("a go that can't be started is a runtime error, not a failing suite", async () => {
    const { dir } = await makeRepo({ ...BASE, '.trustbut.json': JSON.stringify({ env: { PATH: '/nonexistent' } }) });
    await branch(dir, 'agent-change');
    await writeFiles(dir, { 'sum.go': FIXED });
    await commitAll(dir, 'agent change');
    await expect(runVerify({ cwd: dir })).rejects.toThrow(/^Couldn't start go: /);
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
