import { describe, expect, it } from 'vitest';
import { splitLine } from '../src/lex.js';

const code = (line: string, lang: string) => splitLine(line, lang).code;
const comment = (line: string, lang: string) => splitLine(line, lang).comment;

describe('lexer: Go', () => {
  it('blanks raw backtick strings without treating backslashes as escapes', () => {
    expect(splitLine('re := `C:\\` + x // nolint', 'go')).toEqual({ code: 're := `` + x ', comment: '// nolint' });
    expect(code('s := `t.Skip("x")` // ok', 'go')).toBe('s := `` ');
  });

  it('treats rune literals as literals, so a quote rune does not open a string', () => {
    expect(splitLine(`if c == '"' { t.Skip() } // why`, 'go')).toEqual({ code: `if c == '' { t.Skip() } `, comment: '// why' });
    expect(code(`r := '\\''; t.Skip()`, 'go')).toBe(`r := ''; t.Skip()`);
  });
});

describe('lexer: Rust', () => {
  it('does not open a string at a lifetime or loop label', () => {
    expect(code(`fn f<'a>(x: &'a str) -> &'static str { "x" }`, 'rust')).toBe(`fn f<'a>(x: &'a str) -> &'static str { "" }`);
    expect(code(`'outer: loop { break 'outer; } // #[ignore]`, 'rust')).toBe(`'outer: loop { break 'outer; } `);
    expect(code(`impl<'de> X for Y<'_> { unsafe { z } }`, 'rust')).toBe(`impl<'de> X for Y<'_> { unsafe { z } }`);
  });

  it('blanks char literals, including escaped and quote chars', () => {
    expect(code(`let q = '"'; let n = '\\n'; let s = '\\''; let u = '\\u{1F600}'; unsafe { }`, 'rust')).toBe(`let q = ''; let n = ''; let s = ''; let u = ''; unsafe { }`);
    expect(code(`let b = b'x'; let e = '😀';`, 'rust')).toBe(`let b = b''; let e = '';`);
  });

  it('blanks raw strings r"…", r#"…"# and br"…" without escapes', () => {
    expect(code(`let p = r"C:\\"; unsafe {}`, 'rust')).toBe(`let p = r""; unsafe {}`);
    expect(code(`let j = r#"{"a": "[allow(x)]"}"#; f()`, 'rust')).toBe(`let j = r#""#; f()`);
    expect(code(`let k = r##"a "# b"##; g()`, 'rust')).toBe(`let k = r##""##; g()`);
    expect(code(`let b = br"\\"; h()`, 'rust')).toBe(`let b = br""; h()`);
  });

  it('does not take an identifier ending in r for a raw-string prefix', () => {
    expect(code(`let x = for_r"#;`, 'rust')).toBe(`let x = for_r""`);
  });
});

describe('lexer: C#', () => {
  it('handles verbatim strings with backslashes and doubled quotes', () => {
    expect(splitLine(`var p = @"C:\\temp\\"; // ReSharper disable`, 'csharp')).toEqual({ code: 'var p = @""; ', comment: '// ReSharper disable' });
    expect(code(`var q = @"say ""[Ignore]"" now"; Assert.True(x);`, 'csharp')).toBe(`var q = @""; Assert.True(x);`);
    expect(code(`var r = $@"{a}\\"; var s = @$"{b}\\"; f();`, 'csharp')).toBe(`var r = $@""; var s = @$""; f();`);
  });

  it('handles raw string literals and char literals', () => {
    expect(code(`var j = """{"a": "\\"}"""; g();`, 'csharp')).toBe(`var j = """"""; g();`);
    expect(code(`if (c == '"') Assert.Fail();`, 'csharp')).toBe(`if (c == '') Assert.Fail();`);
  });

  it('sees preprocessor lines as code', () => {
    expect(splitLine('#pragma warning disable CS0618 // obsolete', 'csharp')).toEqual({ code: '#pragma warning disable CS0618 ', comment: '// obsolete' });
  });
});

describe('lexer: PHP', () => {
  it('treats #[ as an attribute (code), # and // as comments', () => {
    expect(splitLine(`#[Test]`, 'php')).toEqual({ code: '#[Test]', comment: '' });
    expect(splitLine(`    #[DataProvider('cases')] # note`, 'php')).toEqual({ code: `    #[DataProvider('')] `, comment: '# note' });
    expect(splitLine(`$x = 1; # phpcs:ignore`, 'php')).toEqual({ code: '$x = 1; ', comment: '# phpcs:ignore' });
    expect(splitLine(`$y = "#[Test]"; // @phpstan-ignore-line`, 'php')).toEqual({ code: '$y = ""; ', comment: '// @phpstan-ignore-line' });
  });
});

describe('lexer: Ruby', () => {
  it('uses # comments and leaves interpolation inside strings alone', () => {
    expect(splitLine(`x = "#{a} skip" # rubocop:disable Foo`, 'ruby')).toEqual({ code: 'x = "" ', comment: '# rubocop:disable Foo' });
    expect(code(`cmd = \`ls #{dir}\``, 'ruby')).toBe('cmd = ``');
  });

  it('treats =begin/=end lines as comments only at column 0', () => {
    expect(splitLine('=begin', 'ruby')).toEqual({ code: '', comment: '=begin' });
    expect(splitLine('=end of notes', 'ruby')).toEqual({ code: '', comment: '=end of notes' });
    expect(code('if a ==beginning then skip end', 'ruby')).toBe('if a ==beginning then skip end');
    expect(code('=beginning = 1', 'ruby')).toBe('=beginning = 1');
  });
});

describe('lexer: Kotlin, Swift, Dart triple-quoted and raw strings', () => {
  it('Kotlin raw """ strings have no escapes; chars are literals', () => {
    expect(code(`val s = """C:\\"""; assertEquals(1, x)`, 'kotlin')).toBe(`val s = """"""; assertEquals(1, x)`);
    expect(code(`val q = '"'; @Suppress("x") fun f() {}`, 'kotlin')).toBe(`val q = ''; @Suppress("") fun f() {}`);
  });

  it('Swift """ strings and #"…"# raw strings', () => {
    expect(code(`let s = """`, 'swift')).toBe(`let s = """"""`);
    expect(code(`let r = #"\\d+ "XCTSkip" "#; XCTAssertTrue(x)`, 'swift')).toBe(`let r = #""#; XCTAssertTrue(x)`);
    expect(code(`let r2 = ##"a "# b"##; f()`, 'swift')).toBe(`let r2 = ##""##; f()`);
    expect(code(`#expect(x == "#\\"")`, 'swift')).toBe(`#expect(x == "")`);
  });

  it("Dart ''' and r'…' raw strings", () => {
    expect(code(`final s = '''skip: true'''; expect(x, 1);`, 'dart')).toBe(`final s = ''''''; expect(x, 1);`);
    expect(code(`final r = r'C:\\'; expect(y, 2);`, 'dart')).toBe(`final r = r''; expect(y, 2);`);
    expect(code(`final r = r"\\"; f();`, 'dart')).toBe(`final r = r""; f();`);
  });
});

describe('lexer: Java', () => {
  it('handles text blocks, strings and chars', () => {
    expect(splitLine(`String s = "@Disabled"; char c = '"'; // NOPMD`, 'java')).toEqual({ code: `String s = ""; char c = ''; `, comment: '// NOPMD' });
    expect(comment('  /* @SuppressWarnings("x") */ int a;', 'java')).toBe('/* @SuppressWarnings("x") */');
  });
});
