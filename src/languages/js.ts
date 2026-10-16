import type { Language } from './types.js';

// Type tests: tsd (`test-d/`, `*.test-d.ts`), Vitest typecheck (`*.test-d.ts`, `*.spec-d.ts`), Vue (`test-dts/`, `*.d-test.ts`),
// jest-runner-tsd (`__typetests__/`).
const TYPE_TEST = /(^|\/)(test-dts|test-d|__typetests__)\/|\.(test|spec)-d\.[cm]?tsx?$|\.d-test\.[cm]?tsx?$/;

// Directives count only right after a comment marker (`//`, `///`, `/*`, `/**`, a `*` continuation), where TypeScript,
// ESLint and Istanbul read them; a comment that mentions one in prose doesn't count.
const directive = (body: string): RegExp => new RegExp(String.raw`(?:^|\s)(?:\/\/\/?|\/\*+|\*)\s*(?:${body})`);

export const js: Language = {
  id: 'js',
  extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'],
  testFile: new RegExp(`(^|\\/)(tests?|__tests__)\\/|\\.(test|spec)\\.[cm]?[jt]sx?$|${TYPE_TEST.source}`),
  typeTestFile: TYPE_TEST,
  testFileName: /\.(test|spec)\.[^/]*$/,
  comments: { line: ['//'], block: ['/*', '*/'] },
  strings: ['"', "'", '`'],
  regexLiterals: true,
  rules: {
    focus: [/^\s*(?:(?:it|test|describe|suite)(?:\.\w+)*\.only\b|f(?:it|describe)\s*\()/],
    skip: [/^\s*(?:it|test|describe|suite)(?:\.\w+)*\.(?:skip|todo)\b/, /^\s*x(?:it|test|describe)\s*\(/],
    testDef: [/^\s*(?:it|test)(?:\.\w+)*\s*\(/],
    assert: [/\bexpect\s*\(/, /\bassert\b/, /\.should\b/, /\bassert[A-Z]\w*\(/],
    escapes: [
      { part: 'code', re: /\bas\s+any\b/, title: 'cast to any' },
      // Not in a generic constraint: `T extends (...args: any[]) => R` is how TypeScript spells "any function".
      { part: 'code', re: /(?<![<,]\s*\w+\s+extends\b.*):\s*any\b(?!\s*\()/, title: 'explicit any' },
      { part: 'comment', re: directive('@ts-(?:ignore|nocheck|expect-error)'), title: 'TypeScript check suppressed' },
      { part: 'comment', re: directive('eslint-disable'), title: 'lint rule disabled' },
      { part: 'comment', re: directive(String.raw`(?:istanbul|c8|v8)\s+ignore\b`), title: 'coverage exclusion' },
    ],
  },
};
