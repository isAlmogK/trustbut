import type { Language } from './types.js';

// Rules (skip, testDef, assert, …) arrive with the static-check task; the runner and the proof
// engine only need the file patterns for now.
export const go: Language = {
  id: 'go',
  extensions: ['.go'],
  testFile: /_test\.go$/,
  comments: { line: ['//'], block: ['/*', '*/'] },
  strings: ['"', '`'],
  rules: {},
};
