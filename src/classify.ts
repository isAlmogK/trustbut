import { languageOf } from './languages/index.js';
import type { FileKind } from './types.js';

const SNAPSHOT = /(^|\/)__snapshots__\/|\.snap$/;
// Test runner, coverage and trustbut config: each decides which tests run and what counts as passing.
const TEST_CONFIG = new RegExp(
  [
    /(^|\/)(vitest\.config|vitest\.workspace|jest\.config|karma\.conf)\.[cm]?[jt]s$/,
    /(^|\/)\.mocharc\.([cm]?js|jsonc?|ya?ml)$/,
    /(^|\/)(jest\.config\.json|pytest\.ini|tox\.ini|setup\.cfg|\.coveragerc|codecov\.ya?ml|\.nycrc(\.json)?|\.c8rc(\.json)?)$/,
    /(^|\/)(phpunit\.xml|phpunit\.xml\.dist|phpunit\.dist\.xml|\.rspec|dart_test\.yaml|xunit\.runner\.json|\.trustbut\.json)$/,
    /(^|\/)\.config\/nextest\.toml$|\.runsettings$/,
  ]
    .map((r) => r.source)
    .join('|'),
);
// Source files of languages that are not (yet) in the registry, and how their tests are recognised.
const OTHER_SOURCE = /\.(rs|java|kt|rb|php|cs|swift|scala|vue|svelte)$/;
const OTHER_TEST = /(^|\/)(tests?|__tests__)\//;

export function classify(path: string): FileKind {
  if (SNAPSHOT.test(path)) return 'snapshot';
  if (TEST_CONFIG.test(path)) return 'test-config';
  if (/\.gradle\.kts$/.test(path)) return 'other'; // build scripts, not Kotlin sources
  if (/\.blade\.php$/.test(path)) return 'other'; // Laravel Blade templates (`@if`, `@csrf`), not PHP sources
  const lang = languageOf(path);
  if (lang) return lang.testFile.test(path) ? 'test' : 'source';
  if (OTHER_SOURCE.test(path)) return OTHER_TEST.test(path) ? 'test' : 'source';
  return 'other';
}
