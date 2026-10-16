import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runVerify } from '../helpers/verify.js';
import { dart, dartArgs, flutter, parseDartJson } from '../../src/runners/dart.js';
import { detectRunner } from '../../src/runners/registry.js';
import { branch, commitAll, makeRepo, writeFiles } from '../helpers/repo.js';
import { hasTool, requiredTools } from '../helpers/toolchain.js';

const fx = (name: string) => fileURLToPath(new URL(`../fixtures/runners/dart/${name}`, import.meta.url));

describe('parseDartJson', () => {
  it('parses `dart test --reporter json`: group-prefixed names, leaves, skips, a load error per broken file', async () => {
    const cases = parseDartJson(await readFile(fx('dart.jsonl'), 'utf8'), '/work/pkg');
    expect(cases.map((c) => [c.id, c.outcome, c.leaf])).toEqual([
      ['test/calc_test.dart::top level', 'pass', 'top level'],
      ['test/calc_test.dart::Calc adds', 'pass', 'adds'],
      ['test/calc_test.dart::Calc fails', 'fail', 'fails'],
      ['test/calc_test.dart::Calc skipped', 'skip', 'skipped'],
      ['test/calc_test.dart::Calc nested deep', 'pass', 'deep'],
      ['test/broken_test.dart::[load error]', 'error', undefined],
    ]);
    expect(cases[0]!.file).toBe('test/calc_test.dart');
  });

  it('parses `flutter test --machine`: skips non-JSON lines, makes absolute suite paths relative, ignores a spurious loading error when tests ran', async () => {
    const cases = parseDartJson(await readFile(fx('flutter.jsonl'), 'utf8'), '/work/pkg');
    expect(cases.map((c) => [c.id, c.outcome])).toEqual([
      ['test/calc_test.dart::top level', 'pass'],
      ['test/calc_test.dart::Calc adds', 'pass'],
      ['test/calc_test.dart::Calc fails', 'fail'],
      ['test/calc_test.dart::Calc skipped', 'skip'],
      ['test/calc_test.dart::widget', 'pass'],
      ['test/broken_test.dart::[load error]', 'error'],
    ]);
  });

  it('keeps tests named "loading …", reports a failing setUpAll as an error, a failing test as fail (captured sample)', async () => {
    const cases = parseDartJson(await readFile(fx('dart-hooks.jsonl'), 'utf8'), '/work/pkg');
    expect(cases.map((c) => [c.id, c.outcome])).toEqual([
      ['test/setup_test.dart::G (setUpAll)', 'error'],
      ['test/setup_test.dart::loading spinner shows', 'fail'],
      ['test/setup_test.dart::loading cache works', 'pass'],
    ]);
  });

  it('keeps the worst outcome for a repeated name and maps a thrown exception (result error) in a test to fail', () => {
    const ev = (o: object) => JSON.stringify(o);
    const text = [
      ev({ type: 'suite', suite: { id: 0, platform: 'vm', path: 'test/a_test.dart' } }),
      ev({ type: 'testStart', test: { id: 2, name: 'x', suiteID: 0, groupIDs: [] } }),
      ev({ type: 'testDone', testID: 2, result: 'success', hidden: false }),
      ev({ type: 'testStart', test: { id: 3, name: 'x', suiteID: 0, groupIDs: [] } }),
      ev({ type: 'testDone', testID: 3, result: 'error', hidden: false }),
      ev({ type: 'done', success: false }),
    ].join('\n');
    expect(parseDartJson(text, '/nonexistent').map((c) => [c.id, c.outcome])).toEqual([['test/a_test.dart::x', 'fail']]);
  });

  it('builds the command lines', () => {
    expect(dartArgs(false, ['-n', 'x'], ['test/a_test.dart'])).toEqual(['test', '--reporter', 'json', '-n', 'x', 'test/a_test.dart']);
    expect(dartArgs(true, [])).toEqual(['test', '--machine']);
  });
});

describe('dart/flutter detection', () => {
  async function pkg(pubspec?: string) {
    const dir = await mkdtemp(join(tmpdir(), 'tb-dart-'));
    if (pubspec !== undefined) await writeFile(join(dir, 'pubspec.yaml'), pubspec);
    return dir;
  }
  it('flutter sdk dependency means flutter; a test dev dependency means dart; otherwise none', async () => {
    const f = await pkg('name: app\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n  test: ^1.0.0\n');
    expect([await flutter.detect(f), await dart.detect(f)]).toEqual([10, 0]);
    expect((await detectRunner(f))?.name).toBe('flutter');
    const d = await pkg('name: lib\ndev_dependencies:\n  test: ^1.24.0\n');
    expect([await flutter.detect(d), await dart.detect(d)]).toEqual([0, 10]);
    expect((await detectRunner(d))?.name).toBe('dart');
    const none = await pkg('name: lib\ndependencies:\n  path: ^1.0.0\n');
    expect([await flutter.detect(none), await dart.detect(none)]).toEqual([0, 0]);
    expect([await flutter.detect(await pkg()), await dart.detect(join(none, 'missing'))]).toEqual([0, 0]);
    const misplaced = await pkg('name: lib\ndependencies:\n  test: ^1.0.0\n');
    expect(await dart.detect(misplaced)).toBe(0);
    const later = await pkg('name: lib\ndev_dependencies:\n  lints: ^3.0.0\nflutter:\n  test: x\n');
    expect(await dart.detect(later)).toBe(0);
  });
});

describe('dart runner with fake tools', () => {
  async function project(exit: number, jsonl: string) {
    const dir = await mkdtemp(join(tmpdir(), 'tb-dartproj-'));
    const bin = await mkdtemp(join(tmpdir(), 'tb-fakedart-'));
    await writeFile(join(bin, 'dart'), `#!/bin/sh\nif [ "$1" = pub ]; then mkdir -p .dart_tool; echo '{}' > .dart_tool/package_config.json; echo PUBGET >&2; exit 0; fi\necho "ARGS: $*" >&2\ncat '${fx(jsonl)}'\nexit ${exit}\n`);
    await chmod(join(bin, 'dart'), 0o755);
    await mkdir(join(dir, 'test'), { recursive: true });
    for (const f of ['calc_test.dart', 'other_test.dart', 'helper.dart']) await writeFile(join(dir, 'test', f), '');
    await writeFile(join(dir, 'pubspec.yaml'), 'name: x\ndev_dependencies:\n  test: ^1.0.0\n');
    return { dir, env: { PATH: `${bin}:${process.env.PATH}` } };
  }

  it('runs pub get, passes the json reporter, args and only *_test.dart files; keeps stdout and stderr apart', async () => {
    const { dir, env } = await project(1, 'dart.jsonl');
    const res = await dart.run({ cwd: dir, env, files: ['test/calc_test.dart', 'test/helper.dart', 'test/gone_test.dart'], args: ['-n', 'x'] });
    expect(res.output).toContain('PUBGET');
    expect(res.output).toContain('ARGS: test --reporter json -n x test/calc_test.dart');
    expect(res.output).not.toContain('helper.dart');
    expect(res.exitCode).toBe(1);
    expect(res.cases.map((c) => c.id)).toContain('test/calc_test.dart::Calc fails');
  });

  it('helpers alone mean a full run', async () => {
    const { dir, env } = await project(0, 'dart.jsonl');
    const res = await dart.run({ cwd: dir, env, files: ['test/helper.dart'] });
    expect(res.output).toContain('ARGS: test --reporter json');
    expect(res.output).not.toContain('.dart\n');
  });

  it('exit 79 (no test matched) is a pass; a crash without events is one error case', async () => {
    const a = await project(79, 'dart.jsonl');
    expect((await dart.run({ cwd: a.dir, env: a.env })).exitCode).toBe(0);
    const dir = await mkdtemp(join(tmpdir(), 'tb-dartcrash-'));
    const bin = await mkdtemp(join(tmpdir(), 'tb-fakedart-'));
    await mkdir(join(dir, '.dart_tool'));
    await writeFile(join(dir, '.dart_tool', 'package_config.json'), '{}');
    await writeFile(join(bin, 'dart'), '#!/bin/sh\necho "boom" >&2\nexit 7\n');
    await chmod(join(bin, 'dart'), 0o755);
    const res = await dart.run({ cwd: dir, env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(res.exitCode).toBe(7);
    expect(res.cases.map((c) => c.outcome)).toEqual(['error']);
    expect(res.output).toContain('boom');
  });

  it('flutter exit 1 with a successful done event and no cases ("No tests were found") is a pass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-flempty-'));
    const bin = await mkdtemp(join(tmpdir(), 'tb-fakefl-'));
    await writeFile(join(bin, 'flutter'), `#!/bin/sh\necho '{"success":true,"type":"done","time":1}'\necho 'No tests were found.' >&2\nexit 1\n`);
    await chmod(join(bin, 'flutter'), 0o755);
    const res = await flutter.run({ cwd: dir, env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(res.exitCode).toBe(0);
    expect(res.cases).toEqual([]);
  });

  it('a failing pub get is one error case', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-dartpub-'));
    const bin = await mkdtemp(join(tmpdir(), 'tb-fakedart-'));
    await writeFile(join(bin, 'dart'), '#!/bin/sh\necho "version solving failed" >&2\nexit 65\n');
    await chmod(join(bin, 'dart'), 0o755);
    const res = await dart.run({ cwd: dir, env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(res.exitCode).toBe(65);
    expect(res.cases.map((c) => [c.name, c.outcome])).toEqual([['[pub get failed]', 'error']]);
  });

  it("a missing tool is a start-up error, not \"no tests\"", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-dartnone-'));
    await expect(flutter.run({ cwd: dir, env: { PATH: '/nonexistent' } })).rejects.toThrow(/^Couldn't start flutter: /);
  });
});

const CALC = (op: string) => `int sum(int a, int b) => a ${op} b;\n`;

function suite(pkg: string, flutterTest: boolean, name: string, expectation: string): string {
  const imp = flutterTest ? 'flutter_test/flutter_test' : 'test/test';
  return `import 'package:${imp}.dart';\nimport 'package:${pkg}/calc.dart';\n\nvoid main() {\n  group('Calc', () {\n    test('${name}', () => expect(${expectation}));\n  });\n}\n`;
}

function scenarios(flutterTest: boolean) {
  const pubspec = flutterTest
    ? 'name: calc\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n'
    : 'name: calc\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndev_dependencies:\n  test: ^1.24.0\n';
  const BASE = { 'pubspec.yaml': pubspec, 'lib/calc.dart': CALC('-'), 'test/old_test.dart': suite('calc', flutterTest, 'is zero', 'sum(0, 0), 0') };
  return async (head: Record<string, string | null>) => {
    const { dir } = await makeRepo(BASE);
    await branch(dir, 'agent-change');
    await writeFiles(dir, head);
    await commitAll(dir, 'agent change');
    return dir;
  };
}

describe.skipIf(!(hasTool('dart') || requiredTools().has('dart')))('trustbut verify with dart test (end to end)', () => {
  const scenario = scenarios(false);

  it('PASS: a fix proven by a new test', async () => {
    const dir = await scenario({ 'lib/calc.dart': CALC('+'), 'test/calc_test.dart': suite('calc', false, 'adds', 'sum(2, 3), 5') });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.runner).toBe('dart');
    expect(receipt.proofs.map((p) => [p.file, p.name, p.before, p.verdict])).toEqual([['test/calc_test.dart', 'Calc adds', 'fail', 'proves-change']]);
    expect(receipt.verdict).toBe('pass');
  }, 240_000);

  it('WARN: a new test that passes without the change', async () => {
    const dir = await scenario({ 'lib/calc.dart': CALC('+'), 'test/zero_test.dart': suite('calc', false, 'zero', 'sum(0, 0), 0') });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('warn');
    expect(receipt.findings.map((f) => f.id)).toContain('test-passes-without-change');
  }, 240_000);
});

describe.skipIf(!(hasTool('flutter') || requiredTools().has('flutter')))('trustbut verify with flutter test (end to end)', () => {
  const scenario = scenarios(true);

  it('PASS: a fix proven by a new test', async () => {
    const dir = await scenario({ 'lib/calc.dart': CALC('+'), 'test/calc_test.dart': suite('calc', true, 'adds', 'sum(2, 3), 5') });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.runner).toBe('flutter');
    expect(receipt.proofs.map((p) => [p.file, p.name, p.before, p.verdict])).toEqual([['test/calc_test.dart', 'Calc adds', 'fail', 'proves-change']]);
    expect(receipt.verdict).toBe('pass');
  }, 300_000);

  it('WARN: a new test that passes without the change', async () => {
    const dir = await scenario({ 'lib/calc.dart': CALC('+'), 'test/zero_test.dart': suite('calc', true, 'zero', 'sum(0, 0), 0') });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('warn');
    expect(receipt.findings.map((f) => f.id)).toContain('test-passes-without-change');
  }, 300_000);
});
