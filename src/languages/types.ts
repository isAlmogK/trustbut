export interface CommentSyntax {
  /** Line comment markers, e.g. ['//'] or ['#']. */
  line: string[];
  /** Block comment delimiters, e.g. ['/*', '*' + '/']. */
  block?: [open: string, close: string];
}

/** Patterns for the static checks. All but `escapes` with part 'comment' run on lexed code (strings and comments removed). */
export interface LanguageRules {
  /** FAIL `test-focused`. */
  focus?: RegExp[];
  /** WARN `test-skipped`. */
  skip?: RegExp[];
  /** Counts test definitions for `tests-removed`. */
  testDef?: RegExp[];
  /** Counts assertions for `assertions-removed`. */
  assert?: RegExp[];
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
  comments: CommentSyntax;
  /** String delimiters, longest first, e.g. ['"""', "'''", '"', "'"]. A backslash escapes the next character. */
  strings: string[];
  /** JavaScript-style `/regex/` literals: a `/` where an expression may start begins a regex. */
  regexLiterals?: boolean;
  rules: LanguageRules;
}
