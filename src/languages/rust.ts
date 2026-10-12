import type { Language } from './types.js';

// Integration tests live under `tests/` (outside `src/`); unit tests live in `#[cfg(test)]` modules inside source files, so
// skip and test-definition checks also run on source files (`inlineTests`). Only integration-test entry points
// (`tests/x.rs`, `tests/x/main.rs`) produce results of their own; helpers such as `tests/common/mod.rs` do not.
export const rust: Language = {
  id: 'rust',
  extensions: ['.rs'],
  testFile: /^(?!(?:.*\/)?src\/)(?:.*\/)?tests\/.*\.rs$/,
  testFileName: /^(?!(?:.*\/)?src\/)(?:.*\/)?tests\/([^/]+|[^/]+\/main)\.rs$/,
  inlineTests: true,
  comments: { line: ['//'], block: ['/*', '*/'] },
  // Raw strings (r"…", r#"…"#, br"…") have no escapes; `'` opens a char literal only when it closes as one, so lifetimes
  // (`'a`, `'static`) and loop labels stay code. Up to three `#`s are recognised.
  strings: [
    ...['###', '##', '#', ''].flatMap((h) => [`br${h}"`, `r${h}"`].map((open) => ({ open, close: `"${h}`, raw: true }))),
    '"',
    { open: "'", close: "'", char: true },
  ],
  rules: {
    skip: [/#\[ignore\b/],
    testDef: [/#\[(?:\w+::)*(?:test|rstest|test_case|quickcheck)\b/],
    assert: [/\b(?:debug_)?assert(?:_eq|_ne|_matches)?!\s*[([{]/],
    // `.unwrap()`/`.expect()` are deliberately not flagged: they are ordinary error handling in Rust.
    escapes: [
      { part: 'code', re: /#!?\[(?:allow|expect)\s*\(|#!?\[cfg_attr\(.*\b(?:allow|expect)\s*\(/, title: 'lint rule disabled' },
      { part: 'code', re: /\bunsafe\s*(?:\{|fn\b|impl\b|trait\b|extern\b)/, title: 'unsafe code' },
    ],
  },
};
