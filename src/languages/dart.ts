import type { Language } from './types.js';

export const dart: Language = {
  id: 'dart',
  extensions: ['.dart'],
  testFile: /_test\.dart$/,
  comments: { line: ['//'], block: ['/*', '*/'] },
  // r'…' strings are raw.
  strings: [
    ...["r'''", 'r"""', "r'", 'r"'].map((open) => ({ open, close: open.slice(1), raw: true })),
    "'''",
    '"""',
    '"',
    "'",
  ],
  rules: {},
};
