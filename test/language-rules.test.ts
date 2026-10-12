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

describe('Java rules', () => {
  const t = 'src/test/java/a/CalcTest.java';
  it('flags @Disabled/@Ignore, not mentions in strings or comments', () => {
    expect(focusSkip(t, ['  @Disabled("flaky")', '  @Ignore', '  @DisabledOnOs(OS.WINDOWS)', '  String s = "@Disabled";', '  // @Ignore for now', '  @DisplayName("not @Disabled")', `  char c = '"'; int x = 1;`])).toEqual([
      [1, 'test-skipped'],
      [2, 'test-skipped'],
      [3, 'test-skipped'],
    ]);
  });
  it('counts removed tests and assertions', () => {
    expect(removedCounts(t, ['  @Test', '  @ParameterizedTest', '  @RepeatedTest(3)', '  @Test void adds() {', '  @TestInstance(PER_CLASS)', '  @BeforeEach'])).toEqual(['4 tests removed']);
    expect(removedCounts(t, ['    assertEquals(1, x);', '    assertThat(x).isEqualTo(1);', '    Assertions.assertTrue(x);', '    verify(mock).run();', '    assert x > 0;', '    String m = "assertEquals(1, x)";', '    // verify(mock)'])).toEqual(['5 assertions removed']);
  });
  it('flags warning suppressions and lint markers in source', () => {
    expect(escapes('src/main/java/a/Calc.java', ['@SuppressWarnings("unchecked")', 'int x = 1; // NOPMD', '// CHECKSTYLE:OFF', '@SuppressFBWarnings("EI_EXPOSE_REP")', 'String s = "@SuppressWarnings(x)";', '/* @SuppressWarnings("x") */'])).toEqual([
      [1, 'warnings suppressed'],
      [2, 'lint rule disabled'],
      [3, 'lint rule disabled'],
      [4, 'warnings suppressed'],
    ]);
  });
});

describe('Kotlin rules', () => {
  const t = 'src/test/kotlin/a/CalcTest.kt';
  it('flags @Disabled/@Ignore, not mentions in strings or comments', () => {
    expect(focusSkip(t, ['  @Disabled', '  @Ignore("later")', '  val s = "@Ignore"', '  // @Disabled', '  val r = """@Disabled"""'])).toEqual([
      [1, 'test-skipped'],
      [2, 'test-skipped'],
    ]);
  });
  it('counts removed tests and assertions', () => {
    expect(removedCounts(t, ['  @Test', '  @Test fun adds() {', '  @ParameterizedTest', '  @TestInstance(Lifecycle.PER_CLASS)'])).toEqual(['3 tests removed']);
    expect(removedCounts(t, ['    assertEquals(1, x)', '    verify { mock.run() }', '    x shouldBe 1', '    assertThat(x).isTrue()', '    val m = """assertEquals(1, x)"""'])).toEqual(['4 assertions removed']);
    expect(removedCounts(t, ['    list.shouldContain(3)', '    shouldThrow<IllegalStateException> { run() }', '    val shouldRetry = true', '    if (shouldRun()) go()', '    return shouldSkip', '    val shouldRetry: Boolean', '    return shouldX && y'])).toEqual(['2 assertions removed']);
  });
  it('flags @Suppress and lint markers in source', () => {
    expect(escapes('src/main/kotlin/a/Calc.kt', ['@Suppress("UNCHECKED_CAST")', '@file:Suppress("unused")', '@SuppressLint("NewApi")', 'import a.* // ktlint-disable no-wildcard-imports', 'val s = "@Suppress(x)"', 'val y = x!!'])).toEqual([
      [1, 'warnings suppressed'],
      [2, 'warnings suppressed'],
      [3, 'lint rule disabled'],
      [4, 'lint rule disabled'],
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

describe('Ruby rules', () => {
  const t = 'spec/models/user_spec.rb';
  it('fails on focused examples, not on fit calls, strings or comments', () => {
    expect(focusSkip(t, ["  fit 'works' do", '  fdescribe User do', "  fcontext 'when x' do", "  it 'x', :focus do", '  describe User, focus: true do', '  model.fit(data)', `  msg = "fit 'x' do"`, "  # fit 'later'"])).toEqual([1, 2, 3, 4, 5].map((l) => [l, 'test-focused']));
  });
  it('flags skips and pending, not variables named pending or strings', () => {
    expect(focusSkip(t, ["  xit 'works' do", '  xdescribe User do', "  skip 'not yet'", "  pending 'later'", "  it 'x', skip: 'flaky' do", '    skip', '  pending = orders.select(&:pending?)', '  items.skip_while { |x| x }', `  str = "skip 'x'"`, "  # pending 'later'", '  expect(order.pending?).to be true'])).toEqual([1, 2, 3, 4, 5, 6].map((l) => [l, 'test-skipped']));
  });
  it('recognises RSpec.-prefixed groups and :pending metadata', () => {
    expect(focusSkip(t, ['RSpec.describe User, :focus do', 'RSpec.describe User, focus: true do', 'RSpec.fdescribe User do'])).toEqual([1, 2, 3].map((l) => [l, 'test-focused']));
    expect(focusSkip(t, ['RSpec.xdescribe User do', 'RSpec.describe User, skip: "x" do', '  it "x", :pending do', '  create(:order, :pending)', 'RSpec.describe User do'])).toEqual([1, 2, 3].map((l) => [l, 'test-skipped']));
  });
  it('counts removed tests and assertions (RSpec and Minitest)', () => {
    expect(removedCounts(t, ["  it 'adds' do", '  it { is_expected.to be_valid }', '  specify do', "  test 'adds' do", '  def test_adds', '  items.each { it.save }', '  it.save', "  describe 'x' do", "  context 'y' do"])).toEqual(['5 tests removed', '1 assertion removed']);
    expect(removedCounts('test/models/user_test.rb', ['    expect(x).to eq(1)', '    expect { run }.to raise_error(E)', '    is_expected.to be_valid', '    assert_equal 1, x', '    refute x.nil?', '    x.should eq 1', '    expected = 1', '    msg = "expect(x)"'])).toEqual(['6 assertions removed']);
  });
  it('flags rubocop and nocov markers in source', () => {
    expect(escapes('app/models/user.rb', ['  def x # rubocop:disable Metrics/MethodLength', '# rubocop:todo Style/Foo', '# :nocov:', 's = "# rubocop:disable"', '# we never disable rubocop'])).toEqual([
      [1, 'lint rule disabled'],
      [2, 'lint rule disabled'],
      [3, 'coverage exclusion'],
    ]);
  });
});

describe('PHP rules', () => {
  const t = 'tests/Unit/CalcTest.php';
  it('flags skipped and incomplete tests, not strings or comments', () => {
    expect(focusSkip(t, ["        $this->markTestSkipped('x');", '        $this->markTestIncomplete();', "test('adds')->skip();", "it('x', fn () => 1)->todo();", "        $s = 'markTestSkipped(';", '        // $this->markTestSkipped()', '        # ->skip()'])).toEqual([1, 2, 3, 4].map((l) => [l, 'test-skipped']));
  });
  it('counts removed tests (methods, attributes, @test docblocks, Pest) and assertions', () => {
    expect(removedCounts(t, ['    public function testAdds(): void', '    #[Test]', '    /** @test */', '     * @test', "test('adds', function () {", "it('works', function () {", "    #[DataProvider('cases')]", '    public function setUp(): void', '    /** @testdox Adds */', '    $x = "function testFoo()";'])).toEqual(['6 tests removed']);
    expect(removedCounts(t, ['        $this->assertSame(1, $x);', '        self::assertTrue($x);', '        static::assertCount(2, $a);', '        $this->expectException(E::class);', '    expect($x)->toBe(1);', '        Assert::assertEquals(1, $x);', "        $m = '$this->assertSame(1, $x)';", '        // self::assertTrue($x)'])).toEqual(['6 assertions removed']);
  });
  it('flags only real @ error suppression, not emails, CSS at-rules or Alpine attributes in templates', () => {
    expect(escapes('src/view.php', ['    $c = @file_get_contents($f);', "    $v = @$arr['k'];", '    @unlink($p);', '    $r = @\\Vendor\\fn($x);', 'Contact support@example.com today', '  @media (min-width: 600px) { a { color: red } }', '  @import url(x.css);', '<button @click="open = true">Go</button>', '@font-face { font-family: X; }', '@csrf'])).toEqual([1, 2, 3, 4].map((l) => [l, 'errors suppressed']));
  });
  it('flags phpstan/psalm/phpcs/coverage markers and the @ operator in source', () => {
    expect(escapes('src/Calc.php', ['        // @phpstan-ignore-next-line', '    /** @psalm-suppress MixedAssignment */', '        $x = foo(); // phpcs:ignore', '# phpcs:disable', '    /** @codeCoverageIgnore */', '        $c = @file_get_contents($p);', '        $s = "@phpstan-ignore";', '    #[Pure]', "        $email = 'a@b.c';", '     * @param int $x'])).toEqual([
      [1, 'type check suppressed'],
      [2, 'type check suppressed'],
      [3, 'lint rule disabled'],
      [4, 'lint rule disabled'],
      [5, 'coverage exclusion'],
      [6, 'errors suppressed'],
    ]);
  });
});

describe('Dart rules', () => {
  const t = 'test/calc_test.dart';
  it('fails on solo tests and flags skips, not strings or comments', () => {
    expect(focusSkip(t, ["  test('x', () {}, solo: true);", "  test('x', () {}, skip: true);", "  test('y', () {}, skip: 'flaky');", "  testWidgets('z', (t) async {}, skip: r'raw reason');", "@Skip('not on CI')", "  test('x', () {}, skip: false);", '  testWidgets(\'w\', (t) async {}, skip: isCI);', '  final page = items.sublist(skip: 3);', '  query(skip: offset, take: 10);', "  final s = 'solo: true';", '  final r = "skip: true";', '  // skip: true'])).toEqual([
      [1, 'test-focused'],
      [2, 'test-skipped'],
      [3, 'test-skipped'],
      [4, 'test-skipped'],
      [5, 'test-skipped'],
    ]);
  });
  it('counts removed tests (not groups) and assertions', () => {
    expect(removedCounts(t, ["  test('adds', () {", "  testWidgets('renders', (tester) async {", '  blocTest<CounterCubit, int>(', "  group('calc', () {", '  setUp(() {'])).toEqual(['3 tests removed']);
    expect(removedCounts(t, ['    expect(x, 1);', '    await expectLater(f, completes);', '    verify(mock.run()).called(1);', "    final m = r'expect(x, 1)';"])).toEqual(['3 assertions removed']);
  });
  it('flags analyzer ignores and coverage markers in source', () => {
    expect(escapes('lib/calc.dart', ['  print(x); // ignore: avoid_print', '// ignore_for_file: type=lint', '  // coverage:ignore-line', "  final s = '// ignore: x';", '  // we ignore errors here'])).toEqual([
      [1, 'lint rule disabled'],
      [2, 'lint rule disabled'],
      [3, 'coverage exclusion'],
    ]);
  });
});

describe('Swift rules', () => {
  const t = 'Tests/CalcTests/CalcTests.swift';
  it('flags Swift Testing .disabled traits but not SwiftUI .disabled(Bool)', () => {
    expect(focusSkip(t, ['    @Test(.disabled()) func a() {}', '    @Test(.disabled(if: ci)) func b() {}', '    @Suite(.disabled("later")) struct S {}', '    Button("Go") {}.disabled(true)', '    view.disabled(isLoading)', '    .disabled(false)'])).toEqual([1, 2, 3].map((l) => [l, 'test-skipped']));
  });
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
