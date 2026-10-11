import { languageOf } from './languages/index.js';
import type { FileKind } from './types.js';

const SNAPSHOT = /(^|\/)__snapshots__\/|\.snap$/;
const TEST_CONFIG =
  /(^|\/)(vitest\.config|vitest\.workspace|jest\.config)\.[cm]?[jt]s$|(^|\/)(pytest\.ini|tox\.ini|setup\.cfg|\.coveragerc|codecov\.ya?ml|\.nycrc(\.json)?|\.c8rc(\.json)?)$/;
// Source files of languages that are not (yet) in the registry, and how their tests are recognised.
const OTHER_SOURCE = /\.(go|rs|java|kt|rb|php|cs|swift|scala|vue|svelte)$/;
const OTHER_TEST = /(^|\/)(tests?|__tests__)\//;

export function classify(path: string): FileKind {
  if (SNAPSHOT.test(path)) return 'snapshot';
  if (TEST_CONFIG.test(path)) return 'test-config';
  const lang = languageOf(path);
  if (lang) return lang.testFile.test(path) ? 'test' : 'source';
  if (OTHER_SOURCE.test(path)) return OTHER_TEST.test(path) ? 'test' : 'source';
  return 'other';
}
