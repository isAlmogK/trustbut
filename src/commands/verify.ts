import { resolve } from 'node:path';
import { checkEscapes } from '../checks/escapes.js';
import { checkTestIntegrity } from '../checks/test-integrity.js';
import { DEFAULT_SETUP_WAIT_SEC, DEFAULT_TIMEOUT_SEC, loadConfig, normalizeRoot } from '../config.js';
import { parseChanges } from '../diff.js';
import { diffText, isDirty, mergeBase, objectType, repoRoot, resolveRef, snapshotWorkingTree } from '../git.js';
import { proveTests, type ProofOutput } from '../proof.js';
import { buildReceipt } from '../receipt.js';
import { renderMarkdown } from '../render.js';
import { getRunner, runnerNames } from '../runners/registry.js';
import type { Finding, Receipt } from '../types.js';

export interface VerifyOptions {
  cwd?: string;
  base?: string;
  head?: string;
  /** Verify the working tree (tracked edits + untracked files) instead of a committed head. */
  working?: boolean;
  runner?: string;
  /** Config file path (relative to cwd) instead of `.trustbut.json` at head. */
  config?: string;
  /** Package root relative to the repo; overrides the config's `root`. */
  root?: string;
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
  const forced = opts.runner !== undefined ? getRunner(opts.runner) : undefined;
  const cwd = opts.cwd ?? process.cwd();
  const repo = await repoRoot(cwd);
  if (opts.working && opts.head) throw new Error('--working and --head cannot be used together.');
  const headRef = opts.head ?? 'HEAD';
  const head = opts.working ? await snapshotWorkingTree(repo) : await resolveRef(repo, headRef);
  if (!head) throw new Error(`Unknown head ref: ${headRef}`);
  const config = await loadConfig(repo, opts.config ? resolve(cwd, opts.config) : undefined, head);
  const root = normalizeRoot(opts.root ?? config.root);
  const configRunner = config.runner ?? (config.command ? 'command' : undefined);
  const chosen = forced ?? (configRunner ? getRunner(configRunner) : undefined);
  if (chosen?.name === 'command' && !config.command) throw new Error('The command runner needs a "command" in .trustbut.json');
  if (root !== '.' && (await objectType(repo, head, root)) !== 'tree') throw new Error(`Package root "${root}" does not exist at head`);
  const base = await resolveBase(repo, head, opts.base);
  const noChanges = async (): Promise<Error> => {
    let baseName = opts.base;
    for (const ref of baseName ? [] : DEFAULT_BASES) {
      if (await resolveRef(repo, ref)) {
        baseName = ref;
        break;
      }
    }
    return new Error(
      `No changes between base and head (this branch may already be merged into ${baseName ?? 'the base branch'}). Try --base HEAD~1 to verify the latest commit, or --working for uncommitted changes.`,
    );
  };
  if (base === head) throw await noChanges();

  const changes = parseChanges(await diffText(repo, base, head));
  // Different commits with the same content (an empty commit, or --working with nothing changed): nothing to verify.
  if (changes.length === 0) throw await noChanges();
  const findings: Finding[] = [...checkTestIntegrity(changes), ...checkEscapes(changes)];
  if (!opts.working && (await isDirty(repo))) {
    findings.push({ id: 'uncommitted-changes', severity: 'info', title: 'Uncommitted changes are not included in this receipt' });
  }

  // Without a forced runner, proveTests detects one from head's files in the package root.
  const proof: ProofOutput = await proveTests({
    repo,
    base,
    head,
    changes,
    runner: chosen,
    quick: opts.quick,
    root,
    runOptions: {
      args: config.args,
      env: config.env,
      timeoutMs: (config.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000,
      command: config.command,
      junit: config.junit,
    },
    setup: config.setup
      ? { command: config.setup, waitMs: (config.setupWaitSec ?? DEFAULT_SETUP_WAIT_SEC) * 1000, readyPattern: config.setupReadyPattern }
      : undefined,
  });
  const runner = proof.runner ?? null;
  if (!runner) {
    findings.push({ id: 'no-runner', severity: 'warn', title: `No supported test runner detected (supported: ${runnerNames().join(', ')}); tests were not rerun` });
  }

  const receipt = buildReceipt({
    base,
    head,
    headRef: opts.working ? 'working tree' : undefined,
    runner: runner?.name ?? null,
    root,
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
