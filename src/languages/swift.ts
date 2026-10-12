import type { Language } from './types.js';

export const swift: Language = {
  id: 'swift',
  extensions: ['.swift'],
  testFile: /Tests?\.swift$|(^|\/)Tests\/.*\.swift$/,
  comments: { line: ['//'], block: ['/*', '*/'] },
  strings: ['"""', '"'],
  rules: {},
};
