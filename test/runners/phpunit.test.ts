import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runVerify } from '../helpers/verify.js';
import { detectRunner } from '../../src/runners/registry.js';
import { declaredPhpClasses, parsePhpunitJUnit, phpunit, phpunitArgs } from '../../src/runners/phpunit.js';
import { branch, commitAll, makeRepo, writeFiles } from '../helpers/repo.js';
import { hasTool, requiredTools } from '../helpers/toolchain.js';

const fixturePath = fileURLToPath(new URL('../fixtures/runners/phpunit/junit-phpunit11.xml', import.meta.url));

describe('parsePhpunitJUnit', () => {
  it('maps nested suites, data sets, skipped/failure/error, with files relative to the root', async () => {
    const cases = parsePhpunitJUnit(await readFile(fixturePath, 'utf8'), '/work/fx');
    expect(cases.map((c) => [c.file, c.name, c.outcome])).toEqual([
      ['tests/CalcTest.php', 'testAdds', 'pass'],
      ['tests/CalcTest.php', 'testSubtracts', 'fail'],
      ['tests/CalcTest.php', 'testLater', 'skip'],
      ['tests/CalcTest.php', 'testBoom', 'error'],
      ['tests/CalcTest.php', 'testSum with data set #0', 'pass'],
      ['tests/CalcTest.php', 'testSum with data set "zero"', 'pass'],
      ['tests/Sub/ShapeTest.php', 'testArea', 'skip'],
    ]);
    expect(cases[0]!.id).toBe('tests/CalcTest.php::testAdds');
    expect(cases.map((c) => c.leaf).slice(4, 6)).toEqual(['testSum', 'testSum']);
  });

  it('gives the same ids for two checkouts of the same project', async () => {
    const xml = await readFile(fixturePath, 'utf8');
    const other = xml.replaceAll('/work/fx', '/tmp/base-wt');
    expect(parsePhpunitJUnit(other, '/tmp/base-wt').map((c) => c.id)).toEqual(parsePhpunitJUnit(xml, '/work/fx').map((c) => c.id));
  });
});

describe('phpunit helpers', () => {
  it('builds the command line', () => {
    expect(phpunitArgs('/t/j.xml', ['--testsuite', 'unit'], 'tests/A.php')).toEqual(['--log-junit', '/t/j.xml', '--testsuite', 'unit', 'tests/A.php']);
    expect(phpunitArgs('/t/j.xml', [])).toEqual(['--log-junit', '/t/j.xml']);
  });

  it('finds namespaced classes', () => {
    expect(declaredPhpClasses('<?php\nnamespace Tests\\Sub;\n\nfinal class ShapeTest extends TestCase {}\nabstract class Base {}\n')).toEqual(['Tests\\Sub\\ShapeTest', 'Tests\\Sub\\Base']);
    expect(declaredPhpClasses('<?php\nclass Plain {}')).toEqual(['Plain']);
  });
});

describe('phpunit casesInFile', () => {
  const c = (file: string) => ({ id: `${file}::t`, file, name: 't', outcome: 'pass' as const });
  const head = () => '<?php\nnamespace Tests;\nclass CalcTest {}\n';
  it('compares the relative path, then falls back to the class', () => {
    expect(phpunit.casesInFile!(c('tests/CalcTest.php'), 'tests/CalcTest.php', head)).toBe(true);
    expect(phpunit.casesInFile!(c('tests/Other.php'), 'tests/CalcTest.php', head)).toBe(false);
    expect(phpunit.casesInFile!(c('pkg/tests/CalcTest.php'), 'tests/CalcTest.php', head)).toBe(true);
    expect(phpunit.casesInFile!(c('Tests.CalcTest'), 'tests/CalcTest.php', head)).toBe(true);
    expect(phpunit.casesInFile!(c('Tests.Other'), 'tests/CalcTest.php', head)).toBe(false);
  });
});

describe('phpunit detection', () => {
  it('scores 10 with phpunit.xml(.dist) or a phpunit/phpunit dependency, 0 otherwise', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-php-'));
    expect(await phpunit.detect(dir)).toBe(0);
    await writeFile(join(dir, 'composer.json'), '{"require":{"monolog/monolog":"^3"}}');
    expect(await phpunit.detect(dir)).toBe(0);
    await writeFile(join(dir, 'composer.json'), '{"require-dev":{"phpunit/phpunit":"^10"}}');
    expect(await phpunit.detect(dir)).toBe(10);
    expect((await detectRunner(dir))?.name).toBe('phpunit');
    const a = await mkdtemp(join(tmpdir(), 'tb-php-'));
    await writeFile(join(a, 'phpunit.xml.dist'), '<phpunit/>');
    expect(await phpunit.detect(a)).toBe(10);
    expect(await phpunit.detect(join(dir, 'missing'))).toBe(0);
  });
});

describe('phpunit runner with a fake vendor/bin/phpunit', () => {
  // The fake writes the sample report (paths rewritten to the project dir) to the --log-junit path.
  async function project(exit: number): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'tb-phpproj-'));
    await mkdir(join(dir, 'vendor', 'bin'), { recursive: true });
    await mkdir(join(dir, 'tests'), { recursive: true });
    await writeFile(join(dir, 'tests', 'CalcTest.php'), '<?php\n');
    await writeFile(join(dir, 'tests', 'OtherTest.php'), '<?php\n');
    const bin = join(dir, 'vendor', 'bin', 'phpunit');
    await writeFile(
      bin,
      `#!/bin/sh\necho "ARGS: $*" >&2\nwhile [ $# -gt 0 ]; do if [ "$1" = --log-junit ]; then sed 's#/work/fx#'"$PWD"'#g' '${fixturePath}' > "$2"; fi; shift; done\nexit ${exit}\n`,
    );
    await chmod(bin, 0o755);
    return dir;
  }

  it('passes --log-junit, config args and one file per run; ids are relative', async () => {
    const dir = await project(2);
    const res = await phpunit.run({ cwd: dir, files: ['tests/CalcTest.php', 'tests/OtherTest.php'], args: ['--testsuite', 'unit'] });
    expect(res.output).toMatch(/ARGS: --log-junit \S+junit-0\.xml --testsuite unit tests\/CalcTest\.php/);
    expect(res.output).toMatch(/ARGS: --log-junit \S+junit-1\.xml --testsuite unit tests\/OtherTest\.php/);
    expect(res.exitCode).toBe(2);
    expect(res.cases.map((c) => c.id)).toContain('tests/CalcTest.php::testAdds');
    expect(res.cases).toHaveLength(7); // the duplicate ids from the second run are dropped
  });

  it('passes only *Test.php files; helpers alone mean a full run', async () => {
    const dir = await project(0);
    await writeFile(join(dir, 'tests', 'TestCase.php'), '<?php\n');
    const mixed = await phpunit.run({ cwd: dir, files: ['tests/TestCase.php', 'tests/CalcTest.php'] });
    expect(mixed.output).toMatch(/ARGS: --log-junit \S+ tests\/CalcTest\.php/);
    expect(mixed.output).not.toContain('TestCase.php');
    const helpers = await phpunit.run({ cwd: dir, files: ['tests/TestCase.php', 'tests/Pest.php'] });
    expect(helpers.output).toMatch(/ARGS: --log-junit \S+\n?$/m);
    expect(helpers.output).not.toContain('.php');
  });

  it('a failing composer install is one error case with its output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-phpcomposer-'));
    const bin = await mkdtemp(join(tmpdir(), 'tb-fakecomposer-'));
    await writeFile(join(dir, 'composer.json'), '{}');
    await writeFile(join(bin, 'composer'), '#!/bin/sh\necho "Your requirements could not be resolved" >&2\nexit 2\n');
    await chmod(join(bin, 'composer'), 0o755);
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev}`;
    try {
      const res = await phpunit.run({ cwd: dir });
      expect(res.exitCode).toBe(2);
      expect(res.cases.map((c) => c.outcome)).toEqual(['error']);
      expect(res.output).toContain('could not be resolved');
    } finally {
      process.env.PATH = prev;
    }
  });

  it('a full run passes no file; a crash without a report is one error case', async () => {
    const dir = await project(0);
    const res = await phpunit.run({ cwd: dir });
    expect(res.output).not.toContain('tests/CalcTest.php');
    const crash = await mkdtemp(join(tmpdir(), 'tb-phpcrash-'));
    await mkdir(join(crash, 'vendor', 'bin'), { recursive: true });
    await writeFile(join(crash, 'vendor', 'bin', 'phpunit'), '#!/bin/sh\necho "PHP Fatal error" >&2\nexit 255\n');
    await chmod(join(crash, 'vendor', 'bin', 'phpunit'), 0o755);
    const bad = await phpunit.run({ cwd: crash });
    expect(bad.exitCode).toBe(255);
    expect(bad.cases.map((c) => c.outcome)).toEqual(['error']);
  });
});

const runPhp = hasTool('php') || requiredTools().has('php');

describe.skipIf(!runPhp)('trustbut verify with phpunit (end to end)', () => {
  const BASE = {
    '.gitignore': 'vendor\n.phpunit.result.cache\n',
    'composer.json': JSON.stringify(
      { require: { php: '>=8.1' }, 'require-dev': { 'phpunit/phpunit': '^10.5' }, autoload: { 'psr-4': { 'Fx\\': 'src/' } }, config: { 'allow-plugins': false } },
      null,
      2,
    ),
    'phpunit.xml':
      '<?xml version="1.0" encoding="UTF-8"?>\n<phpunit bootstrap="vendor/autoload.php" colors="false">\n  <testsuites>\n    <testsuite name="default"><directory>tests</directory></testsuite>\n  </testsuites>\n</phpunit>\n',
    'src/Calc.php': '<?php\nnamespace Fx;\n\nfinal class Calc\n{\n    public static function sum(int $a, int $b): int\n    {\n        return $a - $b;\n    }\n}\n',
    'tests/OldTest.php': '<?php\nuse PHPUnit\\Framework\\TestCase;\n\nfinal class OldTest extends TestCase\n{\n    public function testTruth(): void\n    {\n        $this->assertSame(0, \\Fx\\Calc::sum(0, 0));\n    }\n}\n',
  };
  const FIXED = BASE['src/Calc.php'].replace('$a - $b', '$a + $b');
  const test = (cls: string, body: string) =>
    `<?php\nuse PHPUnit\\Framework\\TestCase;\n\nfinal class ${cls} extends TestCase\n{\n${body}\n}\n`;
  async function scenario(head: Record<string, string | null>) {
    const { dir } = await makeRepo(BASE);
    await branch(dir, 'agent-change');
    await writeFiles(dir, head);
    await commitAll(dir, 'agent change');
    return dir;
  }

  it('PASS: a fix proven by a new test', async () => {
    const dir = await scenario({
      'src/Calc.php': FIXED,
      'tests/CalcTest.php': test('CalcTest', '    public function testAdds(): void\n    {\n        $this->assertSame(5, \\Fx\\Calc::sum(2, 3));\n    }'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.runner).toBe('phpunit');
    expect(receipt.proofs.map((p) => [p.file, p.name, p.before, p.verdict])).toEqual([['tests/CalcTest.php', 'testAdds', 'fail', 'proves-change']]);
    expect(receipt.verdict).toBe('pass');
  }, 600_000);

  it('WARN: a new test that passes without the change', async () => {
    const dir = await scenario({
      'src/Calc.php': FIXED,
      'tests/ZeroTest.php': test('ZeroTest', '    public function testZero(): void\n    {\n        $this->assertSame(0, \\Fx\\Calc::sum(0, 0));\n    }'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('warn');
    expect(receipt.proofs.map((p) => p.verdict)).toContain('does-not-constrain');
  }, 600_000);

  it('shows a skipped test as a skipped proof', async () => {
    const dir = await scenario({
      'src/Calc.php': FIXED,
      'tests/LaterTest.php': test('LaterTest', '    public function testLater(): void\n    {\n        $this->markTestSkipped("later");\n    }'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.proofs.map((p) => [p.name, p.verdict])).toEqual([['testLater', 'skipped']]);
  }, 600_000);

  it('a test file with a fatal error is an error, not a proof', async () => {
    const dir = await scenario({
      'src/Calc.php': FIXED,
      'tests/BrokenTest.php': test('BrokenTest', '    public function testBroken(): void\n    {\n        undefined_fn();\n    }'),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('fail');
  }, 600_000);
});
