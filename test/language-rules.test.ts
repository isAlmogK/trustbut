import { describe, expect, it } from 'vitest';
import { checkEscapes } from '../src/checks/escapes.js';
import { checkTestIntegrity } from '../src/checks/test-integrity.js';
import type { ChangedFile } from '../src/types.js';

const lines = (texts: string[]) => texts.map((text, i) => ({ line: i + 1, text }));

/** [line, id] of the focus/skip findings on added lines of a test file. */
function focusSkip(path: string, added: string[]) {
  const f: ChangedFile = { path, status: 'modified', kind: 'test', added: lines(added), removed: [] };
  return checkTestIntegrity([f]).map((x) => [x.line, x.id]);
}

/** Titles of tests-removed / assertions-removed for lines removed from a test file. */
function removedCounts(path: string, removed: string[], kind: ChangedFile['kind'] = 'test') {
  const f: ChangedFile = { path, status: 'modified', kind, added: [], removed };
  return checkTestIntegrity([f]).map((x) => x.title);
}

/** [line, title] of escape findings on added lines of a source file. */
function escapes(path: string, added: string[]) {
  const f: ChangedFile = { path, status: 'modified', kind: 'source', added: lines(added), removed: [] };
  return checkEscapes([f]).map((x) => [x.line, x.title]);
}

describe('Go rules', () => {
  const t = 'pkg/calc_test.go';
  it('flags skips, not mentions in strings, raw strings or comments', () => {
    expect(focusSkip(t, ['\tt.Skip("flaky")', '\tt.SkipNow()', '\tt.Skipf("x %d", 1)', '\tb.Skip()', '\ts.T().Skip("x")'])).toEqual([1, 2, 3, 4, 5].map((l) => [l, 'test-skipped']));
    expect(focusSkip(t, ['\tmsg := "t.Skip(\\"x\\")"', '\t// t.Skip("later")', '\tx := `t.Skip()`', '\treader.Skip(3)', `\tif c == '"' { return }`])).toEqual([]);
  });
  it('counts removed tests (functions and suite methods, not TestMain) and assertions', () => {
    expect(removedCounts(t, ['func TestAdd(t *testing.T) {', 'func (s *CalcSuite) TestSub() {', 'func BenchmarkAdd(b *testing.B) {', 'func FuzzParse(f *testing.F) {', 'func TestMain(m *testing.M) {', 'func helper() {'])).toEqual(['4 tests removed']);
    expect(removedCounts(t, ['\tif got != 2 { t.Errorf("got %d", got) }', '\tassert.Equal(t, 1, x)', '\trequire.NoError(t, err)', '\ts.Require().Equal(1, x)', '\tt.Fatal(err)', '\t// assert.Equal(t, 1, x)', '\tlog := "t.Errorf("'])).toEqual(['5 assertions removed']);
  });
  it('flags nolint, lint:ignore, go:build ignore and unsafe in source', () => {
    expect(escapes('pkg/calc.go', ['\tx := y() //nolint:errcheck', '\t// nolint', '//go:build ignore', '\t//lint:ignore SA1019 legacy', '\tp := unsafe.Pointer(&x)', '\tmsg := "//nolint"', '\ts := `unsafe.Pointer`', '\t// we use nolint sparingly', '//go:build linux'])).toEqual([
      [1, 'lint rule disabled'],
      [2, 'lint rule disabled'],
      [3, 'file excluded from build'],
      [4, 'lint rule disabled'],
      [5, 'unsafe code'],
    ]);
  });
});

describe('Rust rules', () => {
  const t = 'tests/api.rs';
  it('flags #[ignore], not mentions in strings, raw strings or comments', () => {
    expect(focusSkip(t, ['#[ignore]', '    #[ignore = "slow"]', 'let s = "#[ignore]";', '// #[ignore]', 'let r = r#"#[ignore]"#;'])).toEqual([
      [1, 'test-skipped'],
      [2, 'test-skipped'],
    ]);
  });
  it('counts removed tests and assertions; lifetimes do not hide code', () => {
    expect(removedCounts(t, ['#[test]', '#[tokio::test]', '#[tokio::test(flavor = "multi_thread")]', '#[rstest]', '#[test_case(1)]', '#[cfg(test)]', 'fn helper() {}'])).toEqual(['5 tests removed']);
    expect(removedCounts(t, ['assert!(x);', 'assert_eq!(a, b);', 'assert_ne!(a, b);', 'debug_assert!(x);', 'assert_matches!(x, Some(_));', 'let m = "assert_eq!(a, b)";'])).toEqual(['5 assertions removed']);
    expect(removedCounts(t, [`fn check<'a>(s: &'a str) { assert_eq!(s, "x"); }`, `let q = '"'; assert!(ok);`])).toEqual(['2 assertions removed']);
  });
  it('runs skip and test-definition checks on inline tests in source files, not assertion counts', () => {
    const f: ChangedFile = { path: 'src/lib.rs', status: 'modified', kind: 'source', added: lines(['    #[ignore]']), removed: ['    #[test]', '    #[test]', '        assert!(x);'] };
    expect(checkTestIntegrity([f]).map((x) => [x.id, x.title])).toEqual([
      ['test-skipped', 'Test skipped'],
      ['tests-removed', '2 tests removed'],
    ]);
  });
  it('flags allow/expect attributes and unsafe, not unwrap', () => {
    expect(escapes('src/lib.rs', ['#[allow(dead_code)]', '#![allow(clippy::all)]', '#[expect(unused)]', '#[cfg_attr(test, allow(unused))]', '    unsafe { ptr.read() }', 'unsafe fn raw() {}', 'unsafe impl Send for X {}', 'let v = x.unwrap();', 'let s = "unsafe { }";', '// #[allow(dead_code)]', 'let r = r#"#[allow(x)]"#;', 'fn unsafe_name() {}', '#[cfg(test)]', `fn f<'a>(x: &'a str) {}`])).toEqual([
      [1, 'lint rule disabled'],
      [2, 'lint rule disabled'],
      [3, 'lint rule disabled'],
      [4, 'lint rule disabled'],
      [5, 'unsafe code'],
      [6, 'unsafe code'],
      [7, 'unsafe code'],
    ]);
  });
});

describe('C# rules', () => {
  const t = 'Calc.Tests/CalcTests.cs';
  it('flags skipped and ignored tests, not mentions in strings, verbatim strings or comments', () => {
    expect(focusSkip(t, ['    [Fact(Skip = "flaky")]', '    [Theory(Skip="x")]', '    [Ignore("later")]', '    [TestMethod, Ignore]', '    [Explicit]', '        Assert.Ignore("not yet");', '    var s = "[Fact(Skip = \\"x\\")]";', '    // [Ignore]', '    var v = @"[Ignore]";', '    [Fact]', '    [Fact(DisplayName = "Skip it")]'])).toEqual([1, 2, 3, 4, 5, 6].map((l) => [l, 'test-skipped']));
  });
  it('counts removed tests and assertions', () => {
    expect(removedCounts(t, ['    [Fact]', '    [Theory]', '    [Test]', '    [TestMethod]', '    [TestCase(1, 2)]', '[TestClass]', '[TestFixture]', '    [SetUp]'])).toEqual(['5 tests removed']);
    expect(removedCounts(t, ['        Assert.Equal(1, x);', '        result.Should().Be(1);', '        Assert.That(x, Is.EqualTo(1));', '        CollectionAssert.AreEqual(a, b);', '        mock.Verify(m => m.Run());', '        x.ShouldBe(1);', '        var m = "Assert.Equal(1, x)";'])).toEqual(['6 assertions removed']);
  });
  it('flags pragmas, suppressions, nullable disable and coverage exclusions in source', () => {
    expect(escapes('src/Calc.cs', ['#pragma warning disable CS0618', '[SuppressMessage("Style", "IDE0060")]', '#nullable disable', '// ReSharper disable once UnusedVariable', '[ExcludeFromCodeCoverage]', 'var s = "#pragma warning disable";', '#pragma warning restore CS0618', 'var n = x!;', '// #pragma warning disable is bad'])).toEqual([
      [1, 'warnings suppressed'],
      [2, 'warnings suppressed'],
      [3, 'nullable checks disabled'],
      [4, 'lint rule disabled'],
      [5, 'coverage exclusion'],
    ]);
  });
});

describe('Swift rules', () => {
  const t = 'Tests/CalcTests/CalcTests.swift';
  it('flags XCTSkip and disabled traits, not strings, raw strings or comments', () => {
    expect(focusSkip(t, ['    try XCTSkipIf(true)', '    throw XCTSkip("later")', '    @Test(.disabled("flaky")) func adds() {}', '    try XCTSkipUnless(x)', '    let s = "XCTSkip"', '    // throw XCTSkip()', '    let r = #"XCTSkip"#'])).toEqual([1, 2, 3, 4].map((l) => [l, 'test-skipped']));
  });
  it('counts removed tests and assertions', () => {
    expect(removedCounts(t, ['    func testAdds() {', '    func testAsync() async throws {', '    @Test func adds() {', '    @Test("named") func adds2() {', '    func helper() {', '    @Suite struct S {'])).toEqual(['4 tests removed']);
    expect(removedCounts(t, ['        XCTAssertEqual(1, x)', '        XCTAssertTrue(x)', '        #expect(x == 1)', '        let v = try #require(opt)', '        XCTFail("no")', '        let m = "XCTAssertEqual(1, x)"'])).toEqual(['5 assertions removed']);
  });
  it('flags swiftlint and concurrency-check escapes in source', () => {
    expect(escapes('Sources/Calc/Calc.swift', ['// swiftlint:disable force_cast', 'final class Box: @unchecked Sendable {}', 'nonisolated(unsafe) var cache = [Int: Int]()', 'let s = "swiftlint:disable"', 'let x = y as! Int', 'let z = try! f()'])).toEqual([
      [1, 'lint rule disabled'],
      [2, 'concurrency checks disabled'],
      [3, 'concurrency checks disabled'],
    ]);
  });
});
