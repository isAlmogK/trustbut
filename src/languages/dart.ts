import type { Language } from './types.js';

export const dart: Language = {
  id: 'dart',
  extensions: ['.dart'],
  // `*_test.dart`, and helpers under test/, integration_test/ or test_driver/ (not inside lib/).
  testFile: /_test\.dart$|^(?:(?!lib\/)[^/]*\/)*(?:test|integration_test|test_driver)\/.*\.dart$/,
  testFileName: /_test\.dart$/,
  comments: { line: ['//'], block: ['/*', '*/'] },
  // r'…' strings are raw. `${…}` interpolations containing quotes are not recognised.
  strings: [
    ...["r'''", 'r"""', "r'", 'r"'].map((open) => ({ open, close: open.slice(1), raw: true })),
    "'''",
    '"""',
    '"',
    "'",
  ],
  rules: {
    focus: [/\bsolo:\s*true\b/],
    skip: [/\bskip:\s*(?!false\b|null\b)[^\s,)]/, /^\s*@Skip\b/],
    // `group(` is not a test.
    testDef: [/^\s*(?:test|testWidgets|testGoldens|blocTest|patrolTest)\s*[<(]/],
    assert: [/\b(?:expect|expectLater|verify|verifyNever)\s*\(/],
    escapes: [
      { part: 'comment', re: /\/\/\s*ignore(?:_for_file)?:/, title: 'lint rule disabled' },
      { part: 'comment', re: /coverage:ignore-(?:line|start|file)/, title: 'coverage exclusion' },
    ],
  },
};
