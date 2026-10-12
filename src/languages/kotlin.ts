import type { Language } from './types.js';

export const kotlin: Language = {
  id: 'kotlin',
  extensions: ['.kt', '.kts'],
  testFile: /(^|\/)src\/[^/]*[tT]est[^/]*\/|Tests?\.kt$/,
  comments: { line: ['//'], block: ['/*', '*/'] },
  strings: ['"""', '"', "'"],
  rules: {},
};
