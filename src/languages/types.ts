export interface CommentSyntax {
  /** Line comment markers, e.g. ['//'] or ['#']. */
  line: string[];
  /** Block comment delimiters, e.g. ['/*', '*' + '/']. */
  block?: [open: string, close: string];
  /** Block comments whose markers only count at column 0 and make the whole marker line a comment (Ruby `=begin`/`=end`). */
  lineBlock?: [open: string, close: string];
  /** Prefixes that begin with a line-comment marker but are code (PHP 8 attributes `#[`). */
  notComment?: string[];
}

/** A string delimiter with its own close and escape rules. */
export interface StringSyntax {
  open: string;
  close: string;
  /** Backslash is an ordinary character (raw strings: Go backticks, Rust `r#"…"#`, C# `"""…"""`). */
  raw?: boolean;
  /** A doubled close quote stands for one quote (C# verbatim `@"a""b"`); implies no backslash escapes. */
  doubled?: boolean;
  /**
   * A character literal: only one (possibly escaped) character before the close; otherwise the open quote is plain code
   * (Rust lifetimes `'a`, loop labels `'outer:`).
   */
  char?: boolean;
}

/** A pattern matched against lexed code (a plain RegExp), or against the given part of the line. */
export type Rule = RegExp | { part: 'code' | 'comment'; re: RegExp };

/** Patterns for the static checks. A plain RegExp runs on lexed code (string contents and comments removed). */
export interface LanguageRules {
  /** FAIL `test-focused`. */
  focus?: Rule[];
  /** WARN `test-skipped`. */
  skip?: Rule[];
  /** Counts test definitions for `tests-removed`. */
  testDef?: Rule[];
  /** Counts assertions for `assertions-removed`. */
  assert?: Rule[];
  /** WARN `escape-added` in source files; `title` is the finding title. */
  escapes?: { part: 'code' | 'comment'; re: RegExp; title: string }[];
}

export interface Language {
  /** 'js' | 'py' | 'go' | 'rust' | 'java' | 'kotlin' | 'csharp' | 'ruby' | 'php' | 'dart' | 'swift' */
  id: string;
  /** File extensions including the dot, e.g. ['.go']. Matched case-sensitively against the end of the path. */
  extensions: string[];
  /** Matches repo-relative paths of this language's test files (helpers and fixtures under test dirs included). */
  testFile: RegExp;
  /**
   * Files whose name says they define tests: a subset of `testFile` without helpers under test directories (Python
   * `tests/conftest.py`, Ruby `spec/spec_helper.rb`). When changed tests include such a file but no result matches any
   * of them, the proof engine reports `proofs-unmatched`. Defaults to `testFile`.
   */
  testFileName?: RegExp;
  /**
   * Test files checked by the type checker, not run by a test runner (TypeScript `*.test-d.ts`, `test-dts/`): they count
   * as tests for the static checks, but the proof engine never passes them to a runner. A subset of `testFile`.
   */
  typeTestFile?: RegExp;
  /** Tests also live inside source files (Rust `#[cfg(test)]` modules): the skip and test-definition checks run on source files too. */
  inlineTests?: boolean;
  comments: CommentSyntax;
  /**
   * String delimiters, longest first, e.g. ['"""', "'''", '"', "'"]. Inside a plain string delimiter a backslash escapes the
   * next character; a `StringSyntax` can say otherwise. A delimiter that starts with a letter (`r"`) only counts when the
   * character before it is not part of an identifier.
   */
  strings: (string | StringSyntax)[];
  /** JavaScript-style `/regex/` literals: a `/` where an expression may start begins a regex. */
  regexLiterals?: boolean;
  rules: LanguageRules;
}
