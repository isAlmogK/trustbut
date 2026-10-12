import type { Language } from './types.js';

export const kotlin: Language = {
  id: 'kotlin',
  extensions: ['.kt', '.kts'],
  testFile: /(^|\/)(src\/[^/]*[tT]est[^/]*|tests?|__tests__)\/|Tests?\.kt$/,
  comments: { line: ['//'], block: ['/*', '*/'] },
  strings: ['"""', '"', "'"],
  rules: {},
};
