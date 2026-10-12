import type { Language } from './types.js';

export const ruby: Language = {
  id: 'ruby',
  extensions: ['.rb'],
  testFile: /_spec\.rb$|(^|\/)spec\/.*\.rb$/,
  comments: { line: ['#'], block: ['=begin', '=end'] },
  strings: ['"', "'"],
  rules: {},
};
