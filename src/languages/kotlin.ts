import type { Language } from './types.js';
import { JVM_ASSERT, JVM_SKIP, JVM_TEST_DEF, jvmTestFile, jvmTestFileName } from './jvm-rules.js';

export const kotlin: Language = {
  id: 'kotlin',
  extensions: ['.kt', '.kts'],
  testFile: jvmTestFile('kt'),
  testFileName: jvmTestFileName('kt'),
  comments: { line: ['//'], block: ['/*', '*/'] },
  // Triple-quoted strings are raw in Kotlin.
  strings: [{ open: '"""', close: '"""', raw: true }, '"', "'"],
  rules: {
    skip: JVM_SKIP,
    testDef: JVM_TEST_DEF,
    // MockK `verify { }` / `coVerify { }` and Kotest `shouldBe`-style infix matchers too.
    assert: [...JVM_ASSERT, /\b(?:co)?[vV]erify\s*\{/, /\bshould[A-Z]\w*\b/],
    escapes: [
      { part: 'code', re: /@(?:file:)?Suppress\s*\(/, title: 'warnings suppressed' },
      { part: 'code', re: /@SuppressLint\s*\(/, title: 'lint rule disabled' },
      { part: 'comment', re: /ktlint-disable|ktlint:disable/, title: 'lint rule disabled' },
    ],
  },
};
