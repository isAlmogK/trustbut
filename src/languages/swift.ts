import type { Language } from './types.js';

export const swift: Language = {
  id: 'swift',
  extensions: ['.swift'],
  testFile: /Tests?\.swift$|(^|\/)Tests\/.*\.swift$/,
  comments: { line: ['//'], block: ['/*', '*/'] },
  // `#"…"#` (and `##"…"##`, `#"""`) are raw: a backslash only escapes when followed by the `#`s.
  strings: [
    ...['###', '##', '#'].flatMap((h) => [`${h}"""`, `${h}"`].map((open) => ({ open, close: `${open.slice(h.length)}${h}`, raw: true }))),
    '"""',
    '"',
  ],
  rules: {},
};
