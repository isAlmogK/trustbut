import type { Language } from './types.js';

// Example-defining calls, for metadata such as `it 'x', :focus` or `describe X, skip: 'why'`.
const EXAMPLE = String.raw`^\s*(?:RSpec\.)?(?:it|specify|example|scenario|describe|context|feature|test)\b.*,\s*`;
// Not a call: an assignment, predicate, bang or method call on a local of the same name.
const NOT_CALL = String.raw`(?!\s*=[^=~>]|[?!.:])`;

export const ruby: Language = {
  id: 'ruby',
  extensions: ['.rb'],
  // `*_spec.rb`/`*_test.rb` anywhere, and anything under a spec/ or test/ directory that is not inside lib/ (a gem's
  // `lib/gem/test/` is library code).
  testFile: /_(spec|test)\.rb$|^(?:(?!lib\/)[^/]*\/)*(?:spec|test)\/.*\.rb$/,
  testFileName: /_(?:spec|test)\.rb$/,
  // `=begin`/`=end` marker lines are comments; lines between them are not recognised (per-line lexer).
  comments: { line: ['#'], lineBlock: ['=begin', '=end'] },
  strings: ['"', "'", '`'],
  rules: {
    focus: [
      new RegExp(String.raw`^\s*(?:RSpec\.)?f(?:it|specify|example|scenario|describe|context|feature)\b${NOT_CALL}`),
      new RegExp(String.raw`${EXAMPLE}(?::focus\b|focus:\s*true\b)`),
    ],
    skip: [
      new RegExp(String.raw`^\s*(?:RSpec\.)?x(?:it|specify|example|scenario|describe|context|feature)\b${NOT_CALL}`),
      new RegExp(String.raw`^\s*(?:skip|pending)\b${NOT_CALL}`),
      new RegExp(String.raw`${EXAMPLE}(?::(?:skip|pending)\b|(?:skip|pending):\s*(?!false\b|nil\b)\S)`),
    ],
    testDef: [/^\s*(?:it|specify|example|scenario|test)\b(?=\s*(?:\(|['"]|do\b|\{|$))/, /^\s*def\s+test_\w*/],
    assert: [/\b(?:expect|is_expected|assert\w*|refute\w*|should(?:_not)?)\b/],
    escapes: [
      { part: 'comment', re: /rubocop:(?:disable|todo)\b/, title: 'lint rule disabled' },
      { part: 'comment', re: /:nocov:/, title: 'coverage exclusion' },
    ],
  },
};
