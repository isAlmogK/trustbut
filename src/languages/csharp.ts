import type { Language } from './types.js';

export const csharp: Language = {
  id: 'csharp',
  extensions: ['.cs'],
  testFile: /(Tests?|Spec)\.cs$|(^|\/)[\w.]*Tests?\//,
  testFileName: /Tests?\.cs$/,
  comments: { line: ['//'], block: ['/*', '*/'] },
  // Raw `"""…"""` strings have no escapes; verbatim `@"…"` (also `$@"`/`@$"`) doubles quotes instead of escaping.
  // Preprocessor lines (`#pragma`, `#nullable`) are code.
  strings: [
    { open: '"""', close: '"""', raw: true },
    { open: '@$"', close: '"', doubled: true },
    { open: '@"', close: '"', doubled: true },
    '"',
    "'",
  ],
  rules: {
    // xUnit `Skip =`, NUnit/MSTest `[Ignore]`, NUnit `[Explicit]`, runtime skips.
    skip: [/\[(?:[^\]]*,\s*)?(?:Ignore|Explicit)\b/, /\[[^\]]*\bSkip\s*=/, /\bAssert\.(?:Ignore|Inconclusive|Skip)\s*\(/],
    testDef: [/\[\s*(?:[^\]]*,\s*)?(?:Fact|Theory|Test|TestMethod|DataTestMethod|TestCase|SkippableFact)\b/],
    // xUnit/NUnit/MSTest asserts, FluentAssertions, Shouldly, Moq verifications.
    assert: [/\b\w*Assert\.\w+\s*\(/, /\.Should\(\)/, /\.Should[A-Z]\w*\s*\(/, /\.Verify\w*\s*\(/],
    // The null-forgiving `x!` is deliberately not flagged.
    escapes: [
      { part: 'code', re: /^\s*#\s*pragma\s+warning\s+disable\b/, title: 'warnings suppressed' },
      { part: 'code', re: /[[,]\s*(?:assembly:\s*|module:\s*)?SuppressMessage\b/, title: 'warnings suppressed' },
      { part: 'code', re: /^\s*#\s*nullable\s+disable\b/, title: 'nullable checks disabled' },
      { part: 'comment', re: /ReSharper\s+disable\b/, title: 'lint rule disabled' },
      { part: 'code', re: /[[,]\s*ExcludeFromCodeCoverage\b/, title: 'coverage exclusion' },
    ],
  },
};
