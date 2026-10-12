import type { Language } from './types.js';

// `t`, `b`, `tb` and `f` are the conventional *testing.T/B/TB/F names; `s.T()` is a testify suite.
const TB = String.raw`(?:\b(?:t|b|tb|f)|\.T\(\))`;

export const go: Language = {
  id: 'go',
  extensions: ['.go'],
  testFile: /_test\.go$/,
  comments: { line: ['//'], block: ['/*', '*/'] },
  // Backtick strings are raw; runes ('"') are literals.
  strings: ['"', { open: '`', close: '`', raw: true }, "'"],
  rules: {
    skip: [new RegExp(String.raw`${TB}\.Skip(?:Now|f)?\s*\(`)],
    // Top-level test functions (not TestMain) and testify suite methods.
    testDef: [/^func\s+(?:Test(?!Main\s*\()|Benchmark|Fuzz)\w*\s*\(/, /^func\s+\([^)]*\)\s+Test\w*\s*\(/],
    assert: [
      new RegExp(String.raw`${TB}\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(`),
      /\b(?:assert|require)\.\w+\s*\(/,
      /\.(?:Require|Assert)\(\)\.\w+\s*\(/,
      /\bExpect\s*\(/,
    ],
    escapes: [
      { part: 'comment', re: /\/\/\s*nolint\b/, title: 'lint rule disabled' },
      { part: 'comment', re: /\/\/lint:(?:ignore|file-ignore)\b/, title: 'lint rule disabled' },
      { part: 'comment', re: /^\/\/(?:go:build|\s*\+build)\s+ignore\b/, title: 'file excluded from build' },
      { part: 'code', re: /\bunsafe\.\w+/, title: 'unsafe code' },
    ],
  },
};
