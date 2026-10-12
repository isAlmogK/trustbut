import type { Language } from './types.js';

export const ruby: Language = {
  id: 'ruby',
  extensions: ['.rb'],
  testFile: /_(spec|test)\.rb$|(^|\/)(spec|test)\/.*\.rb$/,
  comments: { line: ['#'], block: ['=begin', '=end'] },
  strings: ['"', "'"],
  rules: {},
};
