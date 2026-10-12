import type { Language } from './types.js';

// Rules arrive with the static-check task; the runner and the proof engine only need file patterns.
// Unit tests live in `#[cfg(test)]` modules inside source files, so only integration-test entry points (`tests/x.rs`, `tests/x/main.rs`) are recognised by name.
export const rust: Language = {
  id: 'rust',
  extensions: ['.rs'],
  testFile: /^(?!(?:.*\/)?src\/)(?:.*\/)?tests\/([^/]+|[^/]+\/main)\.rs$/,
  comments: { line: ['//'], block: ['/*', '*/'] },
  strings: ['"'],
  rules: {},
};
