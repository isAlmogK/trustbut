import type { Language } from './types.js';
import { JVM_ASSERT, JVM_SKIP, JVM_TEST_DEF, jvmTestFile, jvmTestFileName } from './jvm-rules.js';

export const java: Language = {
  id: 'java',
  extensions: ['.java'],
  testFile: jvmTestFile('java'),
  testFileName: jvmTestFileName('java'),
  comments: { line: ['//'], block: ['/*', '*/'] },
  strings: ['"""', '"', "'"],
  rules: {
    skip: JVM_SKIP,
    testDef: JVM_TEST_DEF,
    assert: JVM_ASSERT,
    escapes: [
      { part: 'code', re: /@SuppressWarnings\s*\(|@SuppressFBWarnings\b/, title: 'warnings suppressed' },
      { part: 'comment', re: /\bNOPMD\b|CHECKSTYLE:OFF|checkstyle:off/, title: 'lint rule disabled' },
    ],
  },
};
