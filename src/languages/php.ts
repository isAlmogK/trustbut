import type { Language } from './types.js';

export const php: Language = {
  id: 'php',
  extensions: ['.php'],
  testFile: /Test\.php$/,
  comments: { line: ['//', '#'], block: ['/*', '*/'] },
  strings: ['"', "'"],
  rules: {},
};
