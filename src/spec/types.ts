import type { ProofVerdict, RunScope, Severity, TestCaseResult, TestOutcome, Verdict } from '../types.js';

export const SCHEMA_URL = 'https://raw.githubusercontent.com/isAlmogK/trustbut/main/spec/agent-receipt-v1.schema.json';
export const SPEC_VERSION = '1.1';

/** One test run as trustbut reports it under x-trustbut (raw output only as an opt-in tail). */
export interface TrustbutRun {
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
  outputTail?: string;
  cases: TestCaseResult[];
}

/** trustbut's producer-specific detail (the `x-trustbut` key). */
export interface TrustbutExtension {
  runner: string | null;
  languages: string[];
  root: string;
  after?: TrustbutRun;
  before?: TrustbutRun;
}

/** An agent receipt, spec v1 (spec/agent-receipt-v1.md). */
export interface AgentReceiptV1 {
  $schema: string;
  specVersion: string;
  producer: { name: string; version: string; url?: string };
  subject: { base: string; head: string; headRef?: string };
  verdict: Verdict;
  tests?: { passed: number; failed: number; errored: number; skipped: number; scope: RunScope };
  proofs?: { file: string; name: string; before: TestOutcome | 'missing'; after: TestOutcome; verdict: ProofVerdict }[];
  findings: { id: string; severity: Severity; title: string; file?: string; line?: number; detail?: string }[];
  risks?: { file: string; score: number; reasons: string[] }[];
  'x-trustbut'?: TrustbutExtension;
}
