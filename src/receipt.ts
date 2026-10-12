import { rankRisks } from './risk.js';
import type { ChangedFile, Finding, Receipt, RunResult, RunScope, TestProof, Verdict } from './types.js';

export interface ReceiptInput {
  base: string;
  head: string;
  headRef?: string;
  runner: string | null;
  scope?: RunScope;
  after?: RunResult;
  before?: RunResult;
  proofs: TestProof[];
  findings: Finding[];
  changes: ChangedFile[];
}

export function proofFindings(proofs: TestProof[]): Finding[] {
  const out: Finding[] = [];
  for (const p of proofs) {
    if (p.verdict === 'does-not-constrain') {
      out.push({ id: 'test-passes-without-change', severity: 'warn', title: 'Test passes without the change', file: p.file, detail: p.name });
    } else if (p.verdict === 'failing') {
      out.push({ id: 'test-failing', severity: 'fail', title: 'Test fails at head', file: p.file, detail: p.name });
    }
  }
  return out;
}

export function coverageFindings(changes: ChangedFile[]): Finding[] {
  const sourceChanged = changes.some((c) => c.kind === 'source' && c.status !== 'deleted');
  const testsChanged = changes.some((c) => c.kind === 'test');
  return sourceChanged && !testsChanged
    ? [{ id: 'no-tests-changed', severity: 'warn', title: 'Source changed but no tests were added or changed' }]
    : [];
}

export function decideVerdict(findings: Finding[]): Verdict {
  if (findings.some((f) => f.severity === 'fail')) return 'fail';
  if (findings.some((f) => f.severity === 'warn')) return 'warn';
  return 'pass';
}

export function buildReceipt(input: ReceiptInput): Receipt {
  const findings = [...input.findings, ...proofFindings(input.proofs), ...coverageFindings(input.changes)];
  return {
    version: 1,
    base: input.base,
    head: input.head,
    ...(input.headRef ? { headRef: input.headRef } : {}),
    runner: input.runner,
    scope: input.scope ?? 'full',
    verdict: decideVerdict(findings),
    after: input.after,
    before: input.before,
    proofs: input.proofs,
    findings,
    risks: rankRisks(input.changes, findings),
  };
}
