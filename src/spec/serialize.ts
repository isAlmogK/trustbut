import type { Receipt, RunResult, TestOutcome } from '../types.js';
import { VERSION } from '../version.js';
import { SCHEMA_URL, SPEC_VERSION, type AgentReceiptV1, type TrustbutRun } from './types.js';

function run(r: RunResult): TrustbutRun {
  return { exitCode: r.exitCode, durationMs: r.durationMs, ...(r.timedOut ? { timedOut: true } : {}), cases: r.cases };
}

/** trustbut's internal receipt as an agent receipt v1 (what `--json` and `--receipt-json` write). */
export function toAgentReceipt(receipt: Receipt): AgentReceiptV1 {
  const cases = receipt.after?.cases ?? [];
  const count = (outcome: TestOutcome) => cases.filter((c) => c.outcome === outcome).length;
  return {
    $schema: SCHEMA_URL,
    specVersion: SPEC_VERSION,
    producer: { name: 'trustbut', version: VERSION },
    subject: { base: receipt.base, head: receipt.head, ...(receipt.headRef ? { headRef: receipt.headRef } : {}) },
    verdict: receipt.verdict,
    ...(receipt.after
      ? { tests: { passed: count('pass'), failed: count('fail'), errored: count('error'), skipped: count('skip'), scope: receipt.scope } }
      : {}),
    proofs: receipt.proofs.map(({ file, name, before, after, verdict }) => ({ file, name, before, after, verdict })),
    findings: receipt.findings.map(({ id, severity, title, file, line, detail }) => ({
      id,
      severity,
      title,
      ...(file !== undefined ? { file } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(detail !== undefined ? { detail } : {}),
    })),
    risks: receipt.risks,
    'x-trustbut': {
      runner: receipt.runner,
      languages: receipt.languages,
      root: receipt.root,
      ...(receipt.after ? { after: run(receipt.after) } : {}),
      ...(receipt.before ? { before: run(receipt.before) } : {}),
    },
  };
}
