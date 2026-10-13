import type { Severity } from '../types.js';

/** Core finding ids of agent receipts v1 with their default severity (spec/agent-receipt-v1.md, "Finding catalog"). */
export const CORE_FINDINGS = {
  'test-focused': 'fail',
  'suite-failing': 'fail',
  'test-failing': 'fail',
  'test-skipped': 'warn',
  'tests-removed': 'warn',
  'assertions-removed': 'warn',
  'snapshot-changed': 'warn',
  'test-config-changed': 'warn',
  'escape-added': 'warn',
  'no-tests-changed': 'warn',
  'no-test-results': 'warn',
  'test-passes-without-change': 'warn',
  'no-runner': 'warn',
  'base-run-failed': 'warn',
  'proofs-unmatched': 'warn',
  'deps-not-installed': 'warn',
  'deps-changed': 'info',
  'tests-outside-root': 'info',
  'uncommitted-changes': 'info',
} as const satisfies Record<string, Severity>;

export type CoreFindingId = keyof typeof CORE_FINDINGS;

export function isCoreFindingId(id: string): id is CoreFindingId {
  return Object.hasOwn(CORE_FINDINGS, id);
}
