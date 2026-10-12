import type { Language } from './types.js';

export const dart: Language = {
  id: 'dart',
  extensions: ['.dart'],
  testFile: /_test\.dart$/,
  comments: { line: ['//'], block: ['/*', '*/'] },
  strings: ["'''", '"""', '"', "'"],
  rules: {},
};
