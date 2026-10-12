import type { Language } from './types.js';

export const csharp: Language = {
  id: 'csharp',
  extensions: ['.cs'],
  testFile: /(Tests?|Spec)\.cs$|(^|\/)[\w.]*Tests?\//,
  comments: { line: ['//'], block: ['/*', '*/'] },
  // Raw `"""…"""` strings have no escapes; verbatim `@"…"` (also `$@"`/`@$"`) doubles quotes instead of escaping.
  strings: [
    { open: '"""', close: '"""', raw: true },
    { open: '@$"', close: '"', doubled: true },
    { open: '@"', close: '"', doubled: true },
    '"',
    "'",
  ],
  rules: {},
};
