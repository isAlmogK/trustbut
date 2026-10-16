import type { Receipt, RunResult, TestOutcome } from '../types.js';
import { outputTail } from '../render.js';
import { VERSION } from '../version.js';
import { SCHEMA_URL, SPEC_VERSION, type AgentReceiptV1, type TrustbutRun } from './types.js';

/** Receipt tail with `--output-tail`: the last 50 lines, at most 4,000 characters. */
const TAIL_LINES = 50;
const TAIL_MAX = 4000;

export interface AgentReceiptOptions {
  /** Add the end of each failed run's output under x-trustbut (`--output-tail`). */
  outputTail?: boolean;
}

function run(r: RunResult, withTail: boolean): TrustbutRun {
  const tail = withTail && r.exitCode !== 0 ? outputTail(r.output, TAIL_LINES, TAIL_MAX) : '';
  return { exitCode: r.exitCode, durationMs: r.durationMs, ...(r.timedOut ? { timedOut: true } : {}), cases: r.cases, ...(tail ? { outputTail: tail } : {}) };
}

/** trustbut's internal receipt as an agent receipt v1 (what `--json` and `--receipt-json` write). */
export function toAgentReceipt(receipt: Receipt, opts: AgentReceiptOptions = {}): AgentReceiptV1 {
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
      ...(receipt.after ? { after: run(receipt.after, opts.outputTail === true) } : {}),
      ...(receipt.before ? { before: run(receipt.before, opts.outputTail === true) } : {}),
    },
  };
}
