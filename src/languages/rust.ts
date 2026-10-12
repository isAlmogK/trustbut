import type { Language } from './types.js';

// Rules arrive with the static-check task; the runner and the proof engine only need file patterns.
// Unit tests live in `#[cfg(test)]` modules inside source files, so only `tests/` is recognised by name.
export const rust: Language = {
  id: 'rust',
  extensions: ['.rs'],
  testFile: /(^|\/)tests\/.*\.rs$/,
  comments: { line: ['//'], block: ['/*', '*/'] },
  strings: ['"'],
  rules: {},
};
