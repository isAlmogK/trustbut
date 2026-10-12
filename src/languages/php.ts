import type { Language } from './types.js';

export const php: Language = {
  id: 'php',
  extensions: ['.php'],
  testFile: /Test\.php$|(^|\/)tests\//,
  testFileName: /Test\.php$/,
  // `#[` starts a PHP 8 attribute, not a comment. Heredoc/nowdoc bodies span lines and are not recognised.
  comments: { line: ['//', '#'], block: ['/*', '*/'], notComment: ['#['] },
  strings: ['"', "'", '`'],
  rules: {
    // PHPUnit runtime skips and Pest `->skip()`/`->todo()` chained on a test (not Laravel's collection `->skip(n)`).
    skip: [/\bmarkTest(?:Skipped|Incomplete)\s*\(/, /^\s*(?:(?:test|it|describe)\s*\(.*\)|\}\s*\))\s*->(?:skip|todo)\s*\(/],
    testDef: [/\bfunction\s+test\w*\s*\(/, /#\[\s*(?:\\?PHPUnit\\Framework\\Attributes\\)?Test\b/, /^\s*(?:test|it)\s*\(/, { part: 'comment', re: /@test\b/ }],
    assert: [/(?:\$this->|self::|static::|\bAssert::)(?:assert|expect)[A-Z]\w*\s*\(/, /\bexpect\s*\(/],
    escapes: [
      { part: 'comment', re: /@phpstan-ignore|@psalm-suppress/, title: 'type check suppressed' },
      { part: 'comment', re: /phpcs:(?:ignore|disable)|@codingStandardsIgnore/, title: 'lint rule disabled' },
      { part: 'comment', re: /@codeCoverageIgnore/, title: 'coverage exclusion' },
      // In PHP code (strings and comments removed) `@` is only the error-suppression operator.
      { part: 'code', re: /@\s*[$\w]/, title: 'errors suppressed' },
    ],
  },
};
