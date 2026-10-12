import type { Language } from './types.js';

// Rules arrive with the static-check task; the runner and the proof engine only need file patterns.
// Unit tests live in `#[cfg(test)]` modules inside source files, so only integration-test entry points (`tests/x.rs`, `tests/x/main.rs`) are recognised by name.
export const rust: Language = {
  id: 'rust',
  extensions: ['.rs'],
  testFile: /^(?!(?:.*\/)?src\/)(?:.*\/)?tests\/([^/]+|[^/]+\/main)\.rs$/,
  comments: { line: ['//'], block: ['/*', '*/'] },
  // Raw strings (r"…", r#"…"#, br"…") have no escapes; `'` opens a char literal only when it closes as one, so lifetimes
  // (`'a`, `'static`) and loop labels stay code. Up to three `#`s are recognised.
  strings: [
    ...['###', '##', '#', ''].flatMap((h) => [`br${h}"`, `r${h}"`].map((open) => ({ open, close: `"${h}`, raw: true }))),
    '"',
    { open: "'", close: "'", char: true },
  ],
  rules: {},
};
