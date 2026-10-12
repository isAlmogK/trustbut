import type { Language } from './types.js';

// Rules arrive with the static-check task; the runner and the proof engine only need file patterns.
export const java: Language = {
  id: 'java',
  extensions: ['.java'],
  testFile: /(^|\/)src\/[^/]*[tT]est[^/]*\/|Tests?\.java$/,
  comments: { line: ['//'], block: ['/*', '*/'] },
  strings: ['"""', '"', "'"],
  rules: {},
};
