import type { FileKind } from './types.js';

const SNAPSHOT = /(^|\/)__snapshots__\/|\.snap$/;
const TEST_CONFIG =
  /(^|\/)(vitest\.config|vitest\.workspace|jest\.config)\.[cm]?[jt]s$|(^|\/)(pytest\.ini|tox\.ini|setup\.cfg|\.coveragerc|codecov\.ya?ml|\.nycrc(\.json)?|\.c8rc(\.json)?)$/;
const TEST =
  /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/;
const SOURCE = /\.([cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|swift|scala|vue|svelte)$/;

export function classify(path: string): FileKind {
  if (SNAPSHOT.test(path)) return 'snapshot';
  if (TEST_CONFIG.test(path)) return 'test-config';
  if (SOURCE.test(path)) return TEST.test(path) ? 'test' : 'source';
  return 'other';
}
