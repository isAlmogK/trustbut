import { checkEscapes } from '../checks/escapes.js';
import { checkTestIntegrity } from '../checks/test-integrity.js';
import { parseChanges } from '../diff.js';
import { diffText, isDirty, mergeBase, repoRoot, resolveRef } from '../git.js';
import { proveTests, type ProofOutput } from '../proof.js';
import { buildReceipt } from '../receipt.js';
import { renderMarkdown } from '../render.js';
import { detectRunner, getRunner } from '../runners/detect.js';
import type { Finding, Receipt } from '../types.js';

export interface VerifyOptions {
  cwd?: string;
  base?: string;
  head?: string;
  runner?: 'vitest' | 'pytest';
  quick?: boolean;
  strict?: boolean;
  json?: boolean;
}

export interface VerifyResult {
  receipt: Receipt;
  output: string;
  exitCode: number;
}

const DEFAULT_BASES = ['origin/main', 'main', 'origin/master', 'master'];

async function resolveBase(repo: string, head: string, explicit?: string): Promise<string> {
  if (explicit) {
    const sha = await resolveRef(repo, explicit);
    if (!sha) throw new Error(`Unknown base ref: ${explicit}`);
    return mergeBase(repo, sha, head);
  }
  for (const ref of DEFAULT_BASES) {
    const sha = await resolveRef(repo, ref);
    if (sha) return mergeBase(repo, sha, head);
  }
  throw new Error('Could not find a base branch (main/master). Pass --base <ref>.');
}

export async function runVerify(opts: VerifyOptions = {}): Promise<VerifyResult> {
  if (opts.runner !== undefined && opts.runner !== 'vitest' && opts.runner !== 'pytest') {
    throw new Error(`Unknown runner: ${String(opts.runner)}. Supported: vitest, pytest`);
  }
  const repo = await repoRoot(opts.cwd ?? process.cwd());
  const headRef = opts.head ?? 'HEAD';
  const head = await resolveRef(repo, headRef);
  if (!head) throw new Error(`Unknown head ref: ${headRef}`);
  const base = await resolveBase(repo, head, opts.base);
  if (base === head) throw new Error('No changes between base and head. Commit your changes or pass --base <ref>.');

  const changes = parseChanges(await diffText(repo, base, head));
  const findings: Finding[] = [...checkTestIntegrity(changes), ...checkEscapes(changes)];
  if (await isDirty(repo)) {
    findings.push({ id: 'uncommitted-changes', severity: 'info', title: 'Uncommitted changes are not included in this receipt' });
  }

  const runner = opts.runner ? getRunner(opts.runner) : await detectRunner(repo);
  let proof: ProofOutput = { scope: 'full', proofs: [], findings: [] };
  if (runner) {
    proof = await proveTests({ repo, base, head, changes, runner, quick: opts.quick });
  } else {
    findings.push({ id: 'no-runner', severity: 'warn', title: 'No supported test runner detected (Vitest or pytest); tests were not rerun' });
  }

  const receipt = buildReceipt({
    base,
    head,
    runner: runner?.name ?? null,
    scope: proof.scope,
    after: proof.after,
    before: proof.before,
    proofs: proof.proofs,
    findings: [...findings, ...proof.findings],
    changes,
  });
  const output = opts.json ? `${JSON.stringify(receipt, null, 2)}\n` : renderMarkdown(receipt);
  const exitCode = receipt.verdict === 'fail' || (opts.strict && receipt.verdict === 'warn') ? 1 : 0;
  return { receipt, output, exitCode };
}
