import { describe, expect, it } from 'vitest';
import { LANGUAGES, isNamedTestFile, languageById, languageOf } from '../src/languages/index.js';
import type { Language } from '../src/languages/types.js';
import { splitLine } from '../src/lex.js';

describe('language registry', () => {
  it('registers js, py, go, rust, csharp, php, java, kotlin, ruby, dart and swift', () => {
    expect(LANGUAGES.map((l) => l.id)).toEqual(['js', 'py', 'go', 'rust', 'csharp', 'php', 'java', 'kotlin', 'ruby', 'dart', 'swift']);
  });

  it.each([
    ['src/a.js', 'js'],
    ['src/a.jsx', 'js'],
    ['src/a.ts', 'js'],
    ['src/a.tsx', 'js'],
    ['src/a.mjs', 'js'],
    ['src/a.cjs', 'js'],
    ['src/a.mts', 'js'],
    ['src/a.cts', 'js'],
    ['app/models/user.py', 'py'],
  ])('%s → %s', (path, id) => {
    expect(languageOf(path)?.id).toBe(id);
  });

  it('returns undefined for unregistered files', () => {
    expect(languageOf('README.md')).toBeUndefined();
    expect(languageOf('main.scala')).toBeUndefined();
    expect(languageOf('src/a.tsbuildinfo')).toBeUndefined();
  });

  it('looks languages up by id and rejects unknown ids', () => {
    expect(languageById('py').id).toBe('py');
    expect(() => languageById('cobol')).toThrow(/Unknown language: cobol/);
  });

  it('marks test files per language', () => {
    const js = languageById('js');
    const py = languageById('py');
    expect(js.testFile.test('src/sum.spec.tsx')).toBe(true);
    expect(js.testFile.test('src/__tests__/a.js')).toBe(true);
    expect(js.testFile.test('src/sum.ts')).toBe(false);
    expect(py.testFile.test('pkg/api_test.py')).toBe(true);
    expect(py.testFile.test('conftest.py')).toBe(true);
    expect(py.testFile.test('app/user.py')).toBe(false);
  });
});

describe('splitLine driven by a language definition', () => {
  // A made-up language: `--` line comments, `{- -}` block comments, `"` strings.
  const toy: Language = {
    id: 'toy',
    extensions: ['.toy'],
    testFile: /_test\.toy$/,
    comments: { line: ['--'], block: ['{-', '-}'] },
    strings: ['"'],
    rules: {},
  };

  it('uses the comment and string syntax of the language', () => {
    expect(splitLine('x = "-- not a comment" -- real', toy)).toEqual({ code: 'x = "" ', comment: '-- real' });
    expect(splitLine('a {- note -} b', toy)).toEqual({ code: 'a   b', comment: '{- note -}' });
    expect(splitLine('a {- open', toy)).toEqual({ code: 'a ', comment: '{- open' });
  });

  it('treats `/` as plain code in a language without regex literals', () => {
    expect(splitLine('x = a / b / c', toy)).toEqual({ code: 'x = a / b / c', comment: '' });
  });

  it('does not treat `* text` as a block continuation without C-style block comments', () => {
    expect(splitLine('  * args', languageById('py'))).toEqual({ code: '  * args', comment: '' });
  });

  it('classifies Ruby, Java and Kotlin tests, including Minitest and root test/ layouts', async () => {
    const { classify } = await import('../src/classify.js');
    for (const p of ['spec/a_spec.rb', 'spec/spec_helper.rb', 'test/models/user_test.rb', 'test/test_helper.rb', 'app/user_test.rb', 'src/test/java/a/FooTest.java', 'test/a/Foo.java', 'src/test/kotlin/a/FooTest.kt', 'test/a/Foo.kt']) expect(classify(p), p).toBe('test');
    for (const p of ['app/models/user.rb', 'src/main/java/a/Foo.java', 'src/main/kotlin/a/Foo.kt']) expect(classify(p), p).toBe('source');
    for (const p of ['build.gradle.kts', 'settings.gradle.kts', 'mod/build.gradle.kts']) expect(classify(p), p).toBe('other');
  });

  it('does not classify test directories inside main source trees or a gem\'s lib/ as tests', async () => {
    const { classify } = await import('../src/classify.js');
    for (const p of ['src/main/java/org/x/test/Foo.java', 'src/main/java/org/x/ABTest.java', 'mod/src/main/kotlin/a/test/Helpers.kt', 'src/commonMain/kotlin/test/X.kt', 'src/main/java/JIT.java', 'lib/JIT.java', 'lib/gem/test/helpers.rb', 'lib/gem/spec/support.rb', 'lib/test/fake.dart', 'src/tests/x.rs', 'src/Calc.php']) expect(classify(p), p).toBe('source');
    for (const p of ['src/test/java/a/FooIT.java', 'src/integrationTest/java/a/X.java', 'src/androidTest/kotlin/a/X.kt', 'src/jvmTest/kotlin/a/X.kt', 'test/a/Foo.java', 'app/FooIT.java', 'spec/lib/foo_spec.rb', 'spec/lib/helpers.rb', 'test/test_helper.rb', 'app/user_test.rb', 'tests/common/mod.rs', 'crates/a/tests/it.rs', 'tests/TestCase.php', 'tests/bootstrap.php', 'test/helpers.dart', 'integration_test/app_test.dart', 'packages/a/test/fakes.dart']) expect(classify(p), p).toBe('test');
  });
});

describe('files whose name says they define tests (proofs-unmatched)', () => {
  it.each([
    'src/a.test.ts', 'src/__tests__/a.spec.js', 'tests/test_api.py', 'pkg/api_test.py', 'pkg/calc_test.go', 'tests/api.rs', 'tests/api/main.rs',
    'Calc.Tests/CalcTests.cs', 'tests/Unit/CalcTest.php', 'src/test/java/a/CalcTest.java', 'src/test/kotlin/a/CalcTests.kt',
    'spec/models/user_spec.rb', 'test/models/user_test.rb', 'test/calc_test.dart', 'Tests/CalcTests/CalcTests.swift', 'src/Button.test.vue',
  ])('%s is a named test file', (p) => expect(isNamedTestFile(p)).toBe(true));
  it.each([
    'src/__tests__/helpers.js', 'tests/conftest.py', 'tests/helpers.py', 'tests/common/mod.rs', 'src/lib.rs', 'tests/TestCase.php', 'tests/bootstrap.php',
    'src/test/java/a/TestUtils.java', 'src/main/java/a/ABTest.java', 'spec/spec_helper.rb', 'test/test_helper.rb', 'test/helpers.dart',
    'Tests/CalcTests/Fixtures.swift', 'src/calc.ts', 'README.md',
  ])('%s is not a named test file', (p) => expect(isNamedTestFile(p)).toBe(false));
});
