import type { Language } from './types.js';

// Type tests: tsd (`test-d/`, `*.test-d.ts`), Vitest typecheck (`*.test-d.ts`, `*.spec-d.ts`), Vue (`test-dts/`, `*.d-test.ts`),
// jest-runner-tsd (`__typetests__/`).
const TYPE_TEST = /(^|\/)(test-dts|test-d|__typetests__)\/|\.(test|spec)-d\.[cm]?tsx?$|\.d-test\.[cm]?tsx?$/;

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
      { part: 'code', re: /:\s*any\b(?!\s*\()/, title: 'explicit any' },
      { part: 'comment', re: /@ts-(?:ignore|nocheck|expect-error)/, title: 'TypeScript check suppressed' },
      { part: 'comment', re: /eslint-disable/, title: 'lint rule disabled' },
      { part: 'comment', re: /\b(?:istanbul|c8|v8)\s+ignore\b/, title: 'coverage exclusion' },
    ],
  },
};
