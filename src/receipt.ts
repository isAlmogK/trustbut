import { languageOf } from './languages/index.js';
import { splitLine } from './lex.js';
import { rankRisks } from './risk.js';
import type { ChangedFile, Finding, Receipt, RunResult, RunScope, TestProof, Verdict } from './types.js';

export interface ReceiptInput {
  base: string;
  head: string;
  headRef?: string;
  runner: string | null;
  /** Package root relative to the repo; default '.'. */
  root?: string;
  scope?: RunScope;
  after?: RunResult;
  before?: RunResult;
  proofs: TestProof[];
  findings: Finding[];
  changes: ChangedFile[];
}

export function proofFindings(proofs: TestProof[]): Finding[] {
  return proofs
    .filter((p) => p.verdict === 'failing')
    .map((p) => ({ id: 'test-failing', severity: 'fail' as const, title: 'Test fails at head', file: p.file, detail: p.name }));
}

/** Whether a source file (not deleted) has an added or removed line with code on it, not just comments or blanks. */
export function codeChanged(changes: ChangedFile[]): boolean {
  return changes.some((c) => {
    if (c.kind !== 'source' || c.status === 'deleted') return false;
    const lines = [...c.added.map((a) => a.text), ...c.removed];
    const lang = languageOf(c.path);
    if (!lang) return lines.length > 0;
    return lines.some((l) => splitLine(l, lang).code.trim() !== '');
  });
}

const plural = (n: number) => `${n} new or changed test${n === 1 ? '' : 's'}`;

/** Findings that already say there is no fail-before/pass-after evidence either way, so an empty proof list is not reported again. */
const NO_EVIDENCE = new Set(['no-runner', 'base-run-failed', 'proofs-unmatched', 'tests-outside-root', 'suite-failing', 'no-test-results']);

/**
 * `change-not-proven`: code changed, and no test changed, or test files changed but no new or changed test that ran
 * was found in them, or none of the new or changed tests fails without the change. `others` are the receipt's other findings.
 */
export function changeProofFindings(changes: ChangedFile[], proofs: TestProof[], others: Finding[]): Finding[] {
  if (!codeChanged(changes)) return [];
  const finding = (detail: string): Finding[] => [{ id: 'change-not-proven', severity: 'warn', title: 'Nothing proves the change', detail }];
  if (!changes.some((c) => c.kind === 'test')) return finding('no test added or changed');
  if (!proofs.length) {
    if (others.some((f) => NO_EVIDENCE.has(f.id))) return [];
    return finding('test files changed, but no new or changed test that ran was found in them');
  }
  // A test failing at head is reported by `test-failing`; whether it proves the change is undecided until it passes.
  if (proofs.some((p) => p.verdict === 'proves-change' || p.verdict === 'failing')) return [];
  return finding(`${plural(proofs.length)}, none fails without the change`);
}

export function decideVerdict(findings: Finding[]): Verdict {
  if (findings.some((f) => f.severity === 'fail')) return 'fail';
  if (findings.some((f) => f.severity === 'warn')) return 'warn';
  return 'pass';
}

/** Registry ids of the languages of the changed files, sorted and unique. */
export function changedLanguages(changes: ChangedFile[]): string[] {
  const ids = new Set<string>();
  for (const c of changes) {
    const lang = languageOf(c.path);
    if (lang) ids.add(lang.id);
  }
  return [...ids].sort();
}

export function buildReceipt(input: ReceiptInput): Receipt {
  // `change-not-proven` leads, so it is never the finding cut from a shortened summary or feedback.
  const findings = [...changeProofFindings(input.changes, input.proofs, input.findings), ...input.findings, ...proofFindings(input.proofs)];
  return {
    version: 1,
    base: input.base,
    head: input.head,
    ...(input.headRef ? { headRef: input.headRef } : {}),
    runner: input.runner,
    languages: changedLanguages(input.changes),
    root: input.root ?? '.',
    scope: input.scope ?? 'full',
    verdict: decideVerdict(findings),
    after: input.after,
    before: input.before,
    proofs: input.proofs,
    findings,
    risks: rankRisks(input.changes, findings),
  };
}
