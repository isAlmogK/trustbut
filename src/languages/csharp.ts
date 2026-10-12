import type { Language } from './types.js';

export const csharp: Language = {
  id: 'csharp',
  extensions: ['.cs'],
  testFile: /(Tests?|Spec)\.cs$|(^|\/)[\w.]*Tests?\//,
  comments: { line: ['//'], block: ['/*', '*/'] },
  strings: ['"""', '"', "'"],
  rules: {},
};
