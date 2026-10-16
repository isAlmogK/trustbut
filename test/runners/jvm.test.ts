import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runVerify } from '../helpers/verify.js';
import { gradle, gradleArgs } from '../../src/runners/gradle.js';
import { casesInJvmFile, declaredJvmClasses, findReports, jvmLeaf, jvmTestClasses, parseJvmJUnit } from '../../src/runners/jvm.js';
import { maven, mavenArgs } from '../../src/runners/maven.js';
import { detectRunner } from '../../src/runners/registry.js';
import { branch, commitAll, makeRepo, writeFiles } from '../helpers/repo.js';
import { hasTool, requiredTools } from '../helpers/toolchain.js';

const fx = (name: string) => fileURLToPath(new URL(`../fixtures/runners/jvm/${name}`, import.meta.url));

describe('parseJvmJUnit', () => {
  it('reads a Surefire report: outcomes, parameterized names, nested classes', async () => {
    const cases = parseJvmJUnit(await readFile(fx('surefire-TEST-com.x.CalcTest.xml'), 'utf8'));
    expect(cases.map((c) => [c.id, c.outcome, c.leaf])).toEqual([
      ['com.x.CalcTest::adds', 'pass', 'adds'],
      ['com.x.CalcTest::subtracts', 'fail', 'subtracts'],
      ['com.x.CalcTest::later', 'skip', 'later'],
      ['com.x.CalcTest::boom', 'error', 'boom'],
      ['com.x.CalcTest::sums(int, int)[1]', 'pass', 'sums'],
      ['com.x.CalcTest::sums(int, int)[2]', 'pass', 'sums'],
      ['com.x.CalcTest$Negatives::adds negative numbers', 'pass', 'adds negative numbers'],
    ]);
    expect(cases[0]!.file).toBe('com.x.CalcTest');
  });

  it('reads a Gradle report', async () => {
    const cases = parseJvmJUnit(await readFile(fx('gradle-TEST-com.x.CalcTest.xml'), 'utf8'));
    expect(cases.map((c) => [c.id, c.outcome, c.leaf])).toEqual([
      ['com.x.CalcTest::adds()', 'pass', 'adds'],
      ['com.x.CalcTest::subtracts()', 'fail', 'subtracts'],
      ['com.x.CalcTest::later()', 'skip', 'later'],
      ['com.x.CalcTest::sums(int, int)[1]', 'pass', 'sums'],
    ]);
  });

  it('keeps the worst outcome when a display name repeats, and uses the suite name without a classname', () => {
    const xml = `<testsuite name="a.B"><testcase name="[1] x"/><testcase name="[1] x"><failure/></testcase><testcase name="[1] x"/></testsuite>`;
    const cases = parseJvmJUnit(xml);
    expect(cases.map((c) => [c.id, c.outcome, c.leaf])).toEqual([['a.B::[1] x', 'fail', '[1] x']]);
  });

  it('accepts a <testsuites> wrapper', () => {
    expect(parseJvmJUnit('<testsuites><testsuite name="a.B"><testcase name="t" classname="a.B"/></testsuite></testsuites>')).toHaveLength(1);
  });

  it('strips parameters from method names', () => {
    expect(jvmLeaf('adds(int)[1]')).toBe('adds');
    expect(jvmLeaf('adds()')).toBe('adds');
    expect(jvmLeaf('[2] 3, 4')).toBe('[2] 3, 4');
    expect(jvmLeaf('adds two numbers')).toBe('adds two numbers');
    expect(jvmLeaf('adds (positive) numbers')).toBe('adds (positive) numbers');
  });
});

describe('jvm class names', () => {
  const java = 'package com.x;\n\nimport org.junit.jupiter.api.Test;\n\nclass CalcTest {\n  @Test void adds() {}\n  @Nested class Negatives {}\n}\n';
  it('uses the declared package and the declared classes', () => {
    expect(declaredJvmClasses('src/test/java/com/x/CalcTest.java', java)).toEqual(['com.x.CalcTest']);
    expect(declaredJvmClasses('src/test/kotlin/com/x/CalcTest.kt', 'package com.x\n\nclass CalcTest {\n  @Test fun adds() {}\n}\n')).toEqual(['com.x.CalcTest']);
  });
  it('takes every top-level class, whatever the file is called, and ignores nested ones', () => {
    const kt = 'package com.x\n\nclass CalculatorTest {\n  @Test fun a() {}\n  class Inner\n}\n\ninternal class SecondTest {\n  @Test fun b() {}\n}\nabstract class BaseTest\n';
    expect(declaredJvmClasses('src/test/kotlin/com/x/CalcTests.kt', kt)).toEqual(['com.x.CalculatorTest', 'com.x.SecondTest', 'com.x.BaseTest']);
    expect(declaredJvmClasses('src/test/kotlin/com/x/CalcTests.kt', kt, true)).toEqual(['com.x.CalculatorTest', 'com.x.SecondTest']);
    const c = (file: string) => ({ id: `${file}::t`, file, name: 't', outcome: 'pass' as const });
    expect(casesInJvmFile(c('com.x.SecondTest'), 'src/test/kotlin/com/x/CalcTests.kt', () => kt)).toBe(true);
    expect(casesInJvmFile(c('com.x.Inner'), 'src/test/kotlin/com/x/CalcTests.kt', () => kt)).toBe(false);
  });

  it('falls back to the directory when the head cannot be read', () => {
    expect(declaredJvmClasses('mod/src/test/java/com/x/CalcTest.java', '')).toEqual(['com.x.CalcTest']);
    expect(declaredJvmClasses('src/test/java/CalcTest.java', '')).toEqual(['CalcTest']);
  });

  it('maps cases to the changed file, including nested classes', () => {
    const c = (file: string) => ({ id: `${file}::t`, file, name: 't', outcome: 'pass' as const });
    const f = 'mod/src/test/java/com/x/CalcTest.java';
    expect(casesInJvmFile(c('com.x.CalcTest'), f, () => java)).toBe(true);
    expect(casesInJvmFile(c('com.x.CalcTest$Negatives'), f, () => java)).toBe(true);
    expect(casesInJvmFile(c('com.x.CalcTestExtra'), f, () => java)).toBe(false);
    expect(casesInJvmFile(c('com.y.CalcTest'), f, () => java)).toBe(false);
    expect(casesInJvmFile(c('com.x.CalcTest'), 'README.md', () => '')).toBe(false);
  });
});

describe('jvm test targets', () => {
  it('passes only classes that contain tests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-jvm-'));
    const d = join(dir, 'src', 'test', 'java', 'com', 'x');
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'CalcTest.java'), 'package com.x;\nclass CalcTest { @Test void a() {} }\n');
    await writeFile(join(d, 'TestUtils.java'), 'package com.x;\nclass TestUtils { static int one() { return 1; } }\n');
    await writeFile(join(d, 'BaseTest.java'), 'package com.x;\nabstract class BaseTest { @Test void a() {} }\n');
    const k = join(dir, 'src', 'test', 'kotlin', 'com', 'y');
    await mkdir(k, { recursive: true });
    await writeFile(join(k, 'KtTest.kt'), 'package com.y\nclass KtTest { @Test fun a() {} }\n');
    const files = ['src/test/java/com/x/CalcTest.java', 'src/test/java/com/x/TestUtils.java', 'src/test/java/com/x/BaseTest.java', 'src/test/kotlin/com/y/KtTest.kt', 'src/test/java/com/x/Gone.java', 'src/main/java/A.java'];
    await writeFile(join(k, 'CalcTests.kt'), 'package com.y\nclass CalculatorTest { @Test fun a() {} }\nclass SecondTest { @Test fun b() {} }\n');
    await writeFile(join(d, 'PayIT.java'), 'package com.x;\nclass PayIT { @Test void a() {} }\n');
    await mkdir(join(dir, 'src', 'main', 'java'), { recursive: true });
    await writeFile(join(dir, 'src', 'main', 'java', 'M.java'), 'class M { @Test void a() {} }\n');
    expect(jvmTestClasses(dir, [...files, 'src/test/kotlin/com/y/CalcTests.kt', 'src/test/java/com/x/PayIT.java', 'src/main/java/M.java'], true)).toEqual(['com.x.CalcTest', 'com.y.KtTest', 'com.y.CalculatorTest', 'com.y.SecondTest']);
    expect(jvmTestClasses(dir, ['src/test/java/com/x/TestUtils.java'])).toEqual([]);
    expect(jvmTestClasses(dir, undefined)).toEqual([]);
  });
});

describe('jvm test target edge cases', () => {
  async function srcDir(files: Record<string, string>) {
    const dir = await mkdtemp(join(tmpdir(), 'tb-jvm-'));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(join(dir, rel, '..'), { recursive: true });
      await writeFile(join(dir, rel), text);
    }
    return dir;
  }

  it('drops Failsafe integration tests (*IT, *ITCase) only when asked (Maven), and never ITest/ITokenizerTest', async () => {
    const files = {
      'src/test/java/com/x/PayIT.java': 'package com.x;\nclass PayIT { @Test void a() {} }\n',
      'src/test/java/com/x/PayITCase.java': 'package com.x;\nclass PayITCase { @Test void a() {} }\n',
      'src/test/java/com/x/ITest.java': 'package com.x;\nclass ITest { @Test void a() {} }\n',
      'src/test/java/com/x/ITokenizerTest.java': 'package com.x;\nclass ITokenizerTest { @Test void a() {} }\n',
    };
    const dir = await srcDir(files);
    expect(jvmTestClasses(dir, Object.keys(files), true)).toEqual(['com.x.ITest', 'com.x.ITokenizerTest']);
    expect(jvmTestClasses(dir, Object.keys(files))).toEqual(['com.x.PayIT', 'com.x.PayITCase', 'com.x.ITest', 'com.x.ITokenizerTest']);
  });

  it('falls back to the file name when same-line annotations hide the class, unless the class is abstract', async () => {
    const files = {
      'src/test/java/com/x/TaggedTest.java': 'package com.x;\n\n@Tag("slow") class TaggedTest {\n  @Test void a() {}\n}\n',
      'src/test/kotlin/com/y/KTaggedTest.kt': 'package com.y\n\n@Tag("slow") class KTaggedTest {\n  @Test fun a() {}\n}\n',
      'src/test/java/com/x/BaseTaggedTest.java': 'package com.x;\n@Tag("x") public abstract class BaseTaggedTest {\n  @Test void a() {}\n}\n',
      'src/test/java/com/x/TaggedUtil.java': 'package com.x;\n@Tag("x") class TaggedUtil { static int one() { return 1; } }\n',
    };
    const dir = await srcDir(files);
    expect(jvmTestClasses(dir, Object.keys(files))).toEqual(['com.x.TaggedTest', 'com.y.KTaggedTest']);
  });

  it('ignores nested abstract classes and comments when deciding the file-name fallback', async () => {
    const files = {
      'src/test/java/com/x/OuterTest.java': 'package com.x;\n// an abstract class would not run\n/* abstract class Old {} */\n@Tag("x") class OuterTest {\n  abstract static class Base {}\n  @Test void a() {}\n}\n',
    };
    const dir = await srcDir(files);
    expect(jvmTestClasses(dir, Object.keys(files))).toEqual(['com.x.OuterTest']);
  });
});

describe('command lines', () => {
  it('builds the maven command', () => {
    expect(mavenArgs([], [])).toEqual(['-q', '-B', 'test', '-Dmaven.test.failure.ignore=true', '-DfailIfNoTests=false', '-Dsurefire.failIfNoSpecifiedTests=false']);
    expect(mavenArgs(['com.x.A', 'com.x.B'], ['-pl', 'core'])).toEqual(['-q', '-B', 'test', '-Dtest=com.x.A,com.x.A$*,com.x.B,com.x.B$*', '-Dmaven.test.failure.ignore=true', '-DfailIfNoTests=false', '-Dsurefire.failIfNoSpecifiedTests=false', '-pl', 'core']);
  });
  it('builds the gradle command', () => {
    expect(gradleArgs([], [])).toEqual(['test', '--continue', '--console=plain', '--no-daemon', '--no-build-cache']);
    expect(gradleArgs(['com.x.A'], ['--offline'], '/t/i.gradle')).toEqual(['test', '--tests', 'com.x.A', '--tests', 'com.x.A$*', '--continue', '--console=plain', '--no-daemon', '--no-build-cache', '-I', '/t/i.gradle', '--offline']);
  });
});

describe('detection', () => {
  it('maven: pom.xml; gradle: build/settings scripts', async () => {
    const m = await mkdtemp(join(tmpdir(), 'tb-mvn-'));
    expect(await maven.detect(m)).toBe(0);
    expect(await gradle.detect(m)).toBe(0);
    await writeFile(join(m, 'pom.xml'), '<project/>');
    expect(await maven.detect(m)).toBe(10);
    expect((await detectRunner(m))?.name).toBe('maven');
    for (const f of ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']) {
      const g = await mkdtemp(join(tmpdir(), 'tb-gradle-'));
      await writeFile(join(g, f), '');
      expect(await gradle.detect(g)).toBe(10);
      expect((await detectRunner(g))?.name).toBe('gradle');
    }
    expect(await maven.detect(join(m, 'missing'))).toBe(0);
    expect(await gradle.detect(join(m, 'missing'))).toBe(0);
  });
});

describe('maven and gradle with a fake wrapper', () => {
  // The fake writes the sample report into every module's report directory and echoes its arguments.
  async function project(kind: 'maven' | 'gradle', opts: { exit?: number; executable?: boolean; reports?: boolean } = {}): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'tb-jvmproj-'));
    const sample = fx(kind === 'maven' ? 'surefire-TEST-com.x.CalcTest.xml' : 'gradle-TEST-com.x.CalcTest.xml');
    const out = kind === 'maven' ? 'target/surefire-reports' : 'build/test-results/test';
    const write = opts.reports === false ? '' : `for m in . mod; do mkdir -p "$m/${out}"; cp '${sample}' "$m/${out}/TEST-com.x.CalcTest.xml"; done\n`;
    const name = kind === 'maven' ? 'mvnw' : 'gradlew';
    await writeFile(join(dir, name), `#!/bin/sh\necho "ARGS: $*" >&2\nwhile [ $# -gt 0 ]; do if [ "$1" = -I ]; then echo "INIT-SCRIPT: $(cat "$2")" >&2; fi; shift; done\n${write}exit ${opts.exit ?? 0}\n`);
    await chmod(join(dir, name), opts.executable === false ? 0o644 : 0o755);
    // stale report from an earlier build
    await mkdir(join(dir, out), { recursive: true });
    await writeFile(join(dir, out, 'TEST-stale.Old.xml'), '<testsuite name="stale.Old"><testcase name="old" classname="stale.Old"/></testsuite>');
    // never read: dependency directories
    await mkdir(join(dir, 'node_modules', 'x', out), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'x', out, 'TEST-n.Mod.xml'), '<testsuite name="n.Mod"><testcase name="t" classname="n.Mod"/></testsuite>');
    const t = join(dir, 'src', 'test', 'java', 'com', 'x');
    await mkdir(t, { recursive: true });
    await writeFile(join(t, 'CalcTest.java'), 'package com.x;\nclass CalcTest { @Test void adds() {} }\n');
    await writeFile(join(t, 'TestUtils.java'), 'package com.x;\nclass TestUtils {}\n');
    return dir;
  }

  it('maven: runs ./mvnw with -Dtest, reads every module, drops stale reports', async () => {
    const dir = await project('maven', { exit: 1 });
    const res = await maven.run({ cwd: dir, files: ['src/test/java/com/x/CalcTest.java', 'src/test/java/com/x/TestUtils.java'], args: ['-pl', 'core'] });
    expect(res.output).toContain('ARGS: -q -B test -Dtest=com.x.CalcTest,com.x.CalcTest$* -Dmaven.test.failure.ignore=true -DfailIfNoTests=false -Dsurefire.failIfNoSpecifiedTests=false -pl core');
    expect(res.exitCode).toBe(1);
    expect(res.cases.map((c) => c.id)).not.toContain('stale.Old::old');
    expect(res.cases.map((c) => c.id)).not.toContain('n.Mod::t');
    expect(res.cases).toHaveLength(7); // the same report in two modules is one set of ids
    expect(existsSync(join(dir, 'target', 'surefire-reports', 'TEST-stale.Old.xml'))).toBe(false);
  });

  it('maven: exit 0 with failing tests in the reports is exit 1; a non-zero exit stays as is', async () => {
    const failing = await maven.run({ cwd: await project('maven', { exit: 0 }) });
    expect(failing.exitCode).toBe(1);
    const built = await maven.run({ cwd: await project('maven', { exit: 3 }) });
    expect(built.exitCode).toBe(3);
    const dir = await project('maven', { exit: 0, reports: false });
    expect((await maven.run({ cwd: dir })).exitCode).toBe(0);
  });

  it('maven: a full run passes no -Dtest, and a non-executable wrapper runs through sh', async () => {
    const dir = await project('maven', { executable: false });
    const res = await maven.run({ cwd: dir, files: ['src/test/java/com/x/TestUtils.java'] });
    expect(res.output).not.toContain('-Dtest');
    expect(res.cases.length).toBeGreaterThan(0);
  });

  it('maven: a build failure without reports is one error case', async () => {
    const dir = await project('maven', { exit: 1, reports: false });
    const res = await maven.run({ cwd: dir });
    expect(res.exitCode).toBe(1);
    expect(res.cases.map((c) => c.outcome)).toEqual(['error']);
  });

  it("maven: a missing mvn is a start-up error, not \"no tests\"", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-nomvn-'));
    await expect(maven.run({ cwd: dir, env: { PATH: '/nonexistent' } })).rejects.toThrow(/^Couldn't start mvn: /);
  });

  it('gradle: runs ./gradlew with --tests and reads build/test-results/test', async () => {
    const dir = await project('gradle', { exit: 1 });
    const res = await gradle.run({ cwd: dir, files: ['src/test/java/com/x/CalcTest.java'] });
    expect(res.output).toMatch(/ARGS: test --tests com\.x\.CalcTest --tests com\.x\.CalcTest\$\* --continue --console=plain --no-daemon --no-build-cache -I \S+trustbut\.init\.gradle/);
    expect(res.output).toContain('failOnNoMatchingTests = false');
    expect(res.output).toContain('INIT-SCRIPT');
    expect(res.cases.map((c) => c.id)).toEqual(['com.x.CalcTest::adds()', 'com.x.CalcTest::subtracts()', 'com.x.CalcTest::later()', 'com.x.CalcTest::sums(int, int)[1]']);
    expect(findReports(dir, 'gradle').map((p) => p.endsWith('TEST-stale.Old.xml'))).not.toContain(true);
  });

  it('gradle: reads reports of every test task (Android variants such as testDebugUnitTest)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-gradlevariant-'));
    const report = (cls: string) => `<testsuite name="${cls}"><testcase name="t" classname="${cls}"/></testsuite>`;
    await mkdir(join(dir, 'app/build/test-results/testDebugUnitTest'), { recursive: true });
    await mkdir(join(dir, 'app/build/test-results/testReleaseUnitTest'), { recursive: true });
    await writeFile(join(dir, 'app/build/test-results/testDebugUnitTest/TEST-a.Debug.xml'), report('a.Debug'));
    await writeFile(join(dir, 'app/build/test-results/testReleaseUnitTest/TEST-a.Release.xml'), report('a.Release'));
    await writeFile(join(dir, 'gradlew'), '#!/bin/sh\nexit 0\n');
    await chmod(join(dir, 'gradlew'), 0o755);
    expect(findReports(dir, 'gradle').map((p) => p.slice(dir.length + 1))).toEqual([
      'app/build/test-results/testDebugUnitTest/TEST-a.Debug.xml',
      'app/build/test-results/testReleaseUnitTest/TEST-a.Release.xml',
    ]);
    // A fake build that writes a variant report: the run reads it.
    await writeFile(join(dir, 'gradlew'), `#!/bin/sh\nmkdir -p app/build/test-results/testDebugUnitTest\necho '${report('a.Fresh')}' > app/build/test-results/testDebugUnitTest/TEST-a.Fresh.xml\n`);
    const res = await gradle.run({ cwd: dir });
    expect(res.cases.map((c) => c.id)).toEqual(['a.Fresh::t']);
  });

  it('gradle: a build failure without reports is one error case', async () => {
    const dir = await project('gradle', { exit: 1, reports: false });
    const res = await gradle.run({ cwd: dir });
    expect(res.cases.map((c) => c.outcome)).toEqual(['error']);
  });
});

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>fx</groupId>
  <artifactId>fx</artifactId>
  <version>1.0</version>
  <properties>
    <maven.compiler.source>11</maven.compiler.source>
    <maven.compiler.target>11</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
      </plugin>
    </plugins>
  </build>
</project>
`;
const BUILD_GRADLE = `plugins { id 'java' }
repositories { mavenCentral() }
dependencies {
  testImplementation 'org.junit.jupiter:junit-jupiter:5.10.2'
  testRuntimeOnly 'org.junit.platform:junit-platform-launcher'
}
test { useJUnitPlatform() }
`;
const CALC = (op: string) => `package fx;\n\npublic final class Calc {\n  public static int sum(int a, int b) {\n    return a ${op} b;\n  }\n}\n`;
const JTEST = (cls: string, body: string) =>
  `package fx;\n\nimport static org.junit.jupiter.api.Assertions.assertEquals;\nimport org.junit.jupiter.api.Test;\n\nclass ${cls} {\n${body}\n}\n`;

function suite(build: Record<string, string>) {
  const BASE = {
    '.gitignore': 'target\nbuild\n.gradle\n',
    ...build,
    'src/main/java/fx/Calc.java': CALC('-'),
    'src/test/java/fx/OldTest.java': JTEST('OldTest', '  @Test\n  void truth() {\n    assertEquals(0, Calc.sum(0, 0));\n  }'),
  };
  async function scenario(head: Record<string, string | null>) {
    const { dir } = await makeRepo(BASE);
    await branch(dir, 'agent-change');
    await writeFiles(dir, head);
    await commitAll(dir, 'agent change');
    return dir;
  }
  const fixed = { 'src/main/java/fx/Calc.java': CALC('+') };
  return { scenario, fixed };
}

for (const [tool, build] of [
  ['mvn', { 'pom.xml': POM }],
  ['gradle', { 'build.gradle': BUILD_GRADLE, 'settings.gradle': "rootProject.name = 'fx'\n" }],
] as const) {
  const run = hasTool(tool) || requiredTools().has(tool);
  const name = tool === 'mvn' ? 'maven' : 'gradle';
  describe.skipIf(!run)(`trustbut verify with ${name} (end to end)`, () => {
    const { scenario, fixed } = suite(build);

    it('PASS: a fix proven by a new test', async () => {
      const dir = await scenario({
        ...fixed,
        'src/test/java/fx/CalcTest.java': JTEST('CalcTest', '  @Test\n  void adds() {\n    assertEquals(5, Calc.sum(2, 3));\n  }'),
      });
      const { receipt } = await runVerify({ cwd: dir });
      expect(receipt.runner).toBe(name);
      expect(receipt.proofs.map((p) => [p.name.replace(/\(\)$/, ''), p.before, p.verdict])).toEqual([['adds', 'fail', 'proves-change']]);
      expect(receipt.verdict).toBe('pass');
    }, 900_000);

    it('WARN: a new test that passes without the change', async () => {
      const dir = await scenario({
        ...fixed,
        'src/test/java/fx/ZeroTest.java': JTEST('ZeroTest', '  @Test\n  void zero() {\n    assertEquals(0, Calc.sum(0, 0));\n  }'),
      });
      const { receipt } = await runVerify({ cwd: dir });
      expect(receipt.verdict).toBe('warn');
      expect(receipt.findings.map((f) => f.id)).toContain('test-passes-without-change');
    }, 900_000);

    it('a test that does not compile is an error, not a proof', async () => {
      const dir = await scenario({
        ...fixed,
        'src/test/java/fx/BrokenTest.java': JTEST('BrokenTest', '  @Test\n  void broken() {\n    undefinedFn();\n  }'),
      });
      const { receipt } = await runVerify({ cwd: dir });
      expect(receipt.verdict).toBe('fail');
    }, 900_000);
  });
}
