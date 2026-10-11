import type { Language } from './types.js';

export const py: Language = {
  id: 'py',
  extensions: ['.py'],
  testFile: /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/,
  comments: { line: ['#'] },
  strings: ['"""', "'''", '"', "'"],
  rules: {
    skip: [
      /^\s*@(?:pytest\.mark\.(?:skip|skipif|xfail)|unittest\.(?:skip|skipIf|skipUnless|expectedFailure))\b/,
      /\bself\.skipTest\s*\(/,
      /\bpytest\.skip\s*\(/,
    ],
    testDef: [/^\s*(?:async\s+)?def\s+test_\w*/],
    // `expect(` covers Playwright for Python.
    assert: [/\bassert\b/, /\bself\.assert\w*\(/, /\bassert[A-Z]\w*\(/, /\bexpect\s*\(/],
    escapes: [
      { part: 'comment', re: /#\s*type:\s*ignore/, title: 'type check suppressed' },
      { part: 'comment', re: /#\s*noqa\b/, title: 'lint rule disabled' },
      { part: 'comment', re: /pragma:\s*no\s*cover/, title: 'coverage exclusion' },
    ],
  },
};
