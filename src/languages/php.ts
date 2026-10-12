import type { Language } from './types.js';

export const php: Language = {
  id: 'php',
  extensions: ['.php'],
  testFile: /Test\.php$/,
  // `#[` starts a PHP 8 attribute, not a comment.
  comments: { line: ['//', '#'], block: ['/*', '*/'], notComment: ['#['] },
  strings: ['"', "'", '`'],
  rules: {},
};
