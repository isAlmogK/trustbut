import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVerify } from '../../src/commands/verify.js';
import {
  cargo,
  cargoTestArgs,
  declaredFns,
  modulePathOf,
  nextestArgs,
  parseCargoTest,
  parseNextestJson,
  testBinaryOf,
  testSelectors,
} from '../../src/runners/cargo.js';
import { rust } from '../../src/languages/rust.js';
import { detectRunner } from '../../src/runners/registry.js';
import { branch, commitAll, makeRepo, writeFiles } from '../helpers/repo.js';
import { hasTool, requiredTools } from '../helpers/toolchain.js';

const fixture = (name: string) => readFile(new URL(`../fixtures/runners/cargo/${name}`, import.meta.url), 'utf8');

describe('parseCargoTest', () => {
  it('pairs stderr headers with stdout blocks by position: files, targets, ignored reasons, doctests, should_panic', async () => {
    const cases = parseCargoTest(await fixture('cargo-test.stdout.txt'), await fixture('cargo-test.stderr.txt'));
    expect(cases.map((c) => [c.file, c.name, c.outcome])).toEqual([
      ['src/lib.rs', 'shapes::circle::tests::area', 'pass'],
      ['src/lib.rs', 'tests::adds', 'fail'],
      ['src/lib.rs', 'tests::later', 'skip'],
      ['src/lib.rs', 'tests::later_why', 'skip'],
      ['src/lib.rs', 'util::tests::it_works', 'pass'],
      ['src/main.rs', 'cli::parses', 'pass'],
      ['tests/api.rs', 'sum_works', 'pass'],
      ['tests/api.rs', 'nested::deep', 'pass'],
      ['tests/multi/main.rs', 'multi_ok', 'pass'],
      ['doc-tests', 'src/lib.rs - add (line 3)', 'pass'],
      ['doc-tests', 'src/lib.rs - sub (line 9)', 'pass'],
    ]);
    expect(cases[1]!.id).toBe('fx:src/lib.rs::tests::adds');
    expect(cases.map((c) => c.leaf)).toContain('adds');
    expect(cases.find((c) => c.name.includes('sub'))!.leaf).toBe('sub');
  });

  it('keeps same-named tests of different binaries distinct, and never hides the failing one', () => {
    const stderr = '     Running unittests src/lib.rs (target/debug/deps/a-0123456789abcdef)\n     Running tests/b.rs (target/debug/deps/b-fedcba9876543210)\n';
    const stdout = 'running 1 test\ntest works ... ok\n\ntest result: ok.\n\nrunning 1 test\ntest works ... FAILED\n\ntest result: FAILED.\n';
    const cases = parseCargoTest(stdout, stderr);
    expect(cases.map((c) => [c.id, c.outcome])).toEqual([
      ['a:src/lib.rs::works', 'pass'],
      ['b:tests/b.rs::works', 'fail'],
    ]);
  });

  it('keeps workspace members apart by target and the worst outcome for a truly repeated id', () => {
    const stderr = '     Running unittests src/lib.rs (target/debug/deps/core-0123456789abcdef)\n     Running unittests src/lib.rs (target/debug/deps/util-0123456789abcdef)\n     Running unittests src/lib.rs (target/debug/deps/util-0123456789abcdef)\n';
    const stdout = 'running 1 test\ntest t ... ok\nrunning 1 test\ntest t ... ok\nrunning 1 test\ntest t ... FAILED\n';
    expect(parseCargoTest(stdout, stderr).map((c) => [c.id, c.outcome])).toEqual([
      ['core:src/lib.rs::t', 'pass'],
      ['util:src/lib.rs::t', 'fail'],
    ]);
  });

  it('returns nothing for a build failure', () => {
    expect(parseCargoTest('', "error[E0425]: cannot find value `x` in this scope\n --> src/lib.rs:3:5\n")).toEqual([]);
  });
});

describe('parseNextestJson', () => {
  it('maps ok / failed / ignored events and derives the binary file from the binary id', async () => {
    const cases = parseNextestJson(await fixture('nextest.libtest-json-plus.txt'));
    expect(cases.map((c) => [c.id, c.file, c.name, c.outcome])).toEqual([
      ['fx:src/lib.rs::tests::adds', 'src/lib.rs', 'tests::adds', 'fail'],
      ['fx:src/lib.rs::shapes::circle::tests::area', 'src/lib.rs', 'shapes::circle::tests::area', 'pass'],
      ['fx:src/lib.rs::tests::later', 'src/lib.rs', 'tests::later', 'skip'],
      ['fx::api:tests/api.rs::sum_works', 'tests/api.rs', 'sum_works', 'pass'],
      ['fx::bin/fx:src/main.rs::cli::parses', 'src/main.rs', 'cli::parses', 'pass'],
    ]);
    expect(cases[0]!.leaf).toBe('adds');
  });

  it('accepts names without a binary id and skips garbage', () => {
    const out = '{"type":"test","event":"ok","name":"a::b"}\nnot json\n{"type":"test","event":"started","name":"a::c"}\n';
    expect(parseNextestJson(out).map((c) => [c.file, c.name])).toEqual([['src/lib.rs', 'a::b']]);
  });

  it('keeps the same test name in different crates distinct', () => {
    const out = '{"type":"test","event":"ok","name":"a$t"}\n{"type":"test","event":"failed","name":"b$t"}\n';
    expect(parseNextestJson(out).map((c) => [c.id, c.outcome])).toEqual([
      ['a:src/lib.rs::t', 'pass'],
      ['b:src/lib.rs::t', 'fail'],
    ]);
  });
});

describe('cargo helpers', () => {
  it('derives module paths from source files', () => {
    expect(modulePathOf('src/lib.rs')).toBe('');
    expect(modulePathOf('src/main.rs')).toBe('');
    expect(modulePathOf('src/foo.rs')).toBe('foo');
    expect(modulePathOf('src/foo/bar.rs')).toBe('foo::bar');
    expect(modulePathOf('src/foo/bar/mod.rs')).toBe('foo::bar');
    expect(modulePathOf('crates/a/src/x/y.rs')).toBe('x::y');
    expect(modulePathOf('tests/x.rs')).toBeUndefined();
  });

  it('derives integration-test binaries', () => {
    expect(testBinaryOf('tests/x.rs')).toBe('x');
    expect(testBinaryOf('crates/a/tests/x/main.rs')).toBe('x');
    expect(testBinaryOf('tests/x/helpers.rs')).toBe('x');
    expect(testBinaryOf('src/x.rs')).toBeUndefined();
  });

  it('selects test binaries only when every file is a test-binary entry point', () => {
    expect(testSelectors(['tests/a.rs', 'tests/b/main.rs'])).toEqual(['--test', 'a', '--test', 'b']);
    expect(testSelectors(['tests/a.rs', 'src/lib.rs'])).toBeUndefined();
    expect(testSelectors(['tests/common/mod.rs'])).toBeUndefined();
    expect(testSelectors(['tests/a.rs', 'tests/b/helpers.rs'])).toBeUndefined();
    expect(testSelectors(['src/tests/x.rs'])).toBeUndefined();
  });

  it('treats everything under tests/ as test files, but only test-binary entry points as named test files', () => {
    const t = rust.testFile;
    const named = rust.testFileName!;
    expect([t.test('tests/a.rs'), t.test('crates/x/tests/b/main.rs'), t.test('tests/common/mod.rs'), t.test('tests/b/helpers.rs')]).toEqual([true, true, true, true]);
    expect([t.test('src/tests/x.rs'), t.test('src/lib.rs')]).toEqual([false, false]);
    expect([named.test('tests/a.rs'), named.test('crates/x/tests/b/main.rs')]).toEqual([true, true]);
    expect([named.test('tests/common/mod.rs'), named.test('tests/b/helpers.rs'), named.test('src/tests/x.rs'), named.test('src/lib.rs')]).toEqual([false, false, false, false]);
  });

  it('finds declared functions', () => {
    expect([...declaredFns('#[test]\nfn adds() {}\n pub async fn r#loop() {}')].sort()).toEqual(['adds', 'loop']);
  });

  it('builds both command lines', () => {
    expect(cargoTestArgs(['--features', 'x'], ['--test', 'a'])).toEqual(['test', '--no-fail-fast', '--features', 'x', '--test', 'a', '--', '--test-threads=1']);
    expect(nextestArgs(['-j', '1'])).toEqual(['nextest', 'run', '--no-fail-fast', '--message-format', 'libtest-json-plus', '-j', '1']);
  });
});

describe('cargo casesInFile', () => {
  const c = (file: string, name: string) => ({ id: `${file}::${name}`, file, name, outcome: 'pass' as const });
  const head = (src: string) => () => src;
  it('matches integration tests by binary', () => {
    expect(cargo.casesInFile!(c('tests/x.rs', 'works'), 'tests/x.rs', head(''))).toBe(true);
    expect(cargo.casesInFile!(c('tests/x/main.rs', 'works'), 'tests/x/main.rs', head(''))).toBe(true);
    expect(cargo.casesInFile!(c('tests/y.rs', 'works'), 'tests/x.rs', head(''))).toBe(false);
    expect(cargo.casesInFile!(c('src/lib.rs', 'works'), 'tests/x.rs', head(''))).toBe(false);
  });
  it('matches unit tests by module path and declared function', () => {
    const src = '#[cfg(test)]\nmod tests {\n #[test]\n fn adds() {}\n}\n';
    expect(cargo.casesInFile!(c('src/lib.rs', 'foo::bar::tests::adds'), 'src/foo/bar.rs', head(src))).toBe(true);
    expect(cargo.casesInFile!(c('src/lib.rs', 'foo::bar::tests::adds'), 'src/foo/bar/mod.rs', head(src))).toBe(true);
    expect(cargo.casesInFile!(c('src/lib.rs', 'foo::baz::tests::adds'), 'src/foo/bar.rs', head(src))).toBe(false);
    expect(cargo.casesInFile!(c('src/lib.rs', 'foo::bar::tests::other'), 'src/foo/bar.rs', head(src))).toBe(false);
    expect(cargo.casesInFile!(c('src/lib.rs', 'tests::adds'), 'src/lib.rs', head(src))).toBe(true);
    expect(cargo.casesInFile!(c('tests/x.rs', 'adds'), 'src/lib.rs', head(src))).toBe(false);
    expect(cargo.casesInFile!(c('doc-tests', 'adds'), 'src/lib.rs', head(src))).toBe(false);
  });
});

describe('cargo detection', () => {
  it('scores 10 with a Cargo.toml and 0 without', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-cargo-'));
    expect(await cargo.detect(dir)).toBe(0);
    await writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "fx"\nversion = "0.1.0"\n');
    expect(await cargo.detect(dir)).toBe(10);
    expect((await detectRunner(dir))?.name).toBe('cargo');
    expect(await cargo.detect(join(dir, 'missing'))).toBe(0);
  });
});

describe('cargo command line (fake tools on PATH)', () => {
  async function withFakeCargo<T>(script: string, fn: (dir: string) => Promise<T>): Promise<T> {
    const bin = await mkdtemp(join(tmpdir(), 'tb-fakecargo-'));
    const dir = await mkdtemp(join(tmpdir(), 'tb-crate-'));
    await writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "fx"\nversion = "0.1.0"\n');
    await writeFile(join(bin, 'cargo'), script);
    await chmod(join(bin, 'cargo'), 0o755);
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev}`;
    try {
      return await fn(dir);
    } finally {
      process.env.PATH = prev;
    }
  }

  it('runs cargo test with config args and --test selectors when nextest is missing', async () => {
    await withFakeCargo('#!/bin/sh\nif [ "$1" = nextest ]; then exit 1; fi\necho "ARGS: $*" >&2\nexit 0\n', async (dir) => {
      const res = await cargo.run({ cwd: dir, args: ['--features', 'x'], files: ['tests/api.rs'] });
      expect(res.output).toContain('ARGS: test --no-fail-fast --features x --test api -- --test-threads=1');
      expect(res.exitCode).toBe(0);
    });
  });

  it('runs the whole suite when a changed file is a source file', async () => {
    await withFakeCargo('#!/bin/sh\nif [ "$1" = nextest ]; then exit 1; fi\necho "ARGS: $*" >&2\nexit 0\n', async (dir) => {
      const res = await cargo.run({ cwd: dir, files: ['src/lib.rs', 'tests/api.rs'] });
      expect(res.output).toContain('ARGS: test --no-fail-fast -- --test-threads=1');
    });
  });

  it('reads headers from stderr and blocks from stdout (real cargo split): distinct ids, failure not hidden', async () => {
    const script =
      '#!/bin/sh\nif [ "$1" = nextest ]; then exit 1; fi\n' +
      'echo "     Running unittests src/lib.rs (target/debug/deps/fx-0123456789abcdef)" >&2\n' +
      'echo "     Running tests/b.rs (target/debug/deps/b-fedcba9876543210)" >&2\n' +
      'printf "running 1 test\\ntest works ... ok\\n\\ntest result: ok.\\n\\nrunning 1 test\\ntest works ... FAILED\\n\\ntest result: FAILED.\\n"\nexit 101\n';
    await withFakeCargo(script, async (dir) => {
      const res = await cargo.run({ cwd: dir });
      expect(res.cases.map((c) => [c.id, c.file, c.outcome])).toEqual([
        ['fx:src/lib.rs::works', 'src/lib.rs', 'pass'],
        ['b:tests/b.rs::works', 'tests/b.rs', 'fail'],
      ]);
      expect(cargo.casesInFile!(res.cases[1]!, 'tests/b.rs', () => '')).toBe(true);
      expect(cargo.casesInFile!(res.cases[0]!, 'tests/b.rs', () => '')).toBe(false);
    });
  });

  it('prefers nextest with libtest-json-plus, sets the experimental flag and parses its events', async () => {
    const script =
      '#!/bin/sh\nif [ "$1 $2" = "nextest --version" ]; then exit 0; fi\n' +
      'echo "ARGS: $* FLAG=$NEXTEST_EXPERIMENTAL_LIBTEST_JSON" >&2\n' +
      'echo \'{"type":"test","event":"ok","name":"fx::api$works"}\'\nexit 0\n';
    await withFakeCargo(script, async (dir) => {
      const res = await cargo.run({ cwd: dir, args: ['-j', '1'] });
      expect(res.output).toContain('ARGS: nextest run --no-fail-fast --message-format libtest-json-plus -j 1 FLAG=1');
      expect(res.cases.map((c) => [c.file, c.name, c.outcome])).toEqual([['tests/api.rs', 'works', 'pass']]);
    });
  });

  it('reports a failed build as one error case and nextest "no tests" (exit 4) as success', async () => {
    await withFakeCargo('#!/bin/sh\nif [ "$1" = nextest ]; then exit 1; fi\necho "error[E0425]" >&2\nexit 101\n', async (dir) => {
      const res = await cargo.run({ cwd: dir });
      expect(res.exitCode).toBe(101);
      expect(res.cases.map((c) => c.outcome)).toEqual(['error']);
    });
    await withFakeCargo('#!/bin/sh\nif [ "$2" = "--version" ]; then exit 0; fi\nexit 4\n', async (dir) => {
      const res = await cargo.run({ cwd: dir });
      expect(res.exitCode).toBe(0);
      expect(res.cases).toEqual([]);
    });
  });
});

const runCargo = hasTool('cargo') || requiredTools().has('cargo');

describe.skipIf(!runCargo)('trustbut verify with cargo (end to end)', () => {
  const BASE = {
    '.gitignore': 'target\n',
    'Cargo.toml': '[package]\nname = "fx"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': 'pub fn sum(a: i32, b: i32) -> i32 {\n    a - b\n}\n',
    'tests/old.rs': 'use fx::sum;\n\n#[test]\nfn truth() {\n    assert_eq!(sum(0, 0), 0);\n}\n',
  };
  const FIXED = 'pub fn sum(a: i32, b: i32) -> i32 {\n    a + b\n}\n';
  async function scenario(head: Record<string, string | null>) {
    const { dir } = await makeRepo(BASE);
    await branch(dir, 'agent-change');
    await writeFiles(dir, head);
    await commitAll(dir, 'agent change');
    return dir;
  }

  it('PASS: a fix proven by a new integration test', async () => {
    const dir = await scenario({
      'src/lib.rs': FIXED,
      'tests/sum.rs': 'use fx::sum;\n\n#[test]\nfn adds() {\n    assert_eq!(sum(2, 3), 5);\n}\n',
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.runner).toBe('cargo');
    expect(receipt.proofs.map((p) => [p.file, p.name, p.before, p.verdict])).toEqual([['tests/sum.rs', 'adds', 'fail', 'proves-change']]);
    expect(receipt.verdict).toBe('pass');
  }, 300_000);

  it('WARN: a new test that passes without the change', async () => {
    const dir = await scenario({
      'src/lib.rs': FIXED,
      'tests/zero.rs': 'use fx::sum;\n\n#[test]\nfn zero() {\n    assert_eq!(sum(0, 0), 0);\n}\n',
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('warn');
    expect(receipt.findings.map((f) => f.id)).toContain('test-passes-without-change');
  }, 300_000);

  it('shows an #[ignore] test as a skipped proof', async () => {
    const dir = await scenario({
      'src/lib.rs': FIXED,
      'tests/later.rs': '#[test]\n#[ignore]\nfn later() {}\n',
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.proofs.map((p) => [p.name, p.verdict])).toEqual([['later', 'skipped']]);
  }, 300_000);

  it('a test file that does not compile is an error, not a proof', async () => {
    const dir = await scenario({
      'src/lib.rs': FIXED,
      'tests/broken.rs': '#[test]\nfn broken() {\n    undefined_fn();\n}\n',
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('fail');
  }, 300_000);
});
