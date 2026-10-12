import type { Language } from './types.js';

export const swift: Language = {
  id: 'swift',
  extensions: ['.swift'],
  testFile: /Tests?\.swift$|(^|\/)Tests\/.*\.swift$/,
  testFileName: /Tests?\.swift$/,
  comments: { line: ['//'], block: ['/*', '*/'] },
  // `#"…"#` (and `##"…"##`, `#"""`) are raw: a backslash only escapes when followed by the `#`s.
  strings: [
    ...['###', '##', '#'].flatMap((h) => [`${h}"""`, `${h}"`].map((open) => ({ open, close: `${open.slice(h.length)}${h}`, raw: true }))),
    '"""',
    '"',
  ],
  rules: {
    skip: [/\bXCTSkip(?:If|Unless)?\b/, /\.disabled\s*\(/],
    testDef: [/\bfunc\s+test\w*\s*\(/, /@Test\b/],
    assert: [/\bXCT(?:Assert\w*|Fail|Unwrap)\s*\(/, /#(?:expect|require)\s*\(/],
    // Force unwraps and casts (`!`, `as!`, `try!`) are deliberately not flagged.
    escapes: [
      { part: 'comment', re: /swiftlint:disable/, title: 'lint rule disabled' },
      { part: 'code', re: /@unchecked\s+Sendable\b|\bnonisolated\s*\(\s*unsafe\s*\)/, title: 'concurrency checks disabled' },
    ],
  },
};
