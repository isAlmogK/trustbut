// `trustbut hook <agent>`: run from an agent's turn-end hook. Verifies the working tree and answers
// in that agent's hook protocol: a FAIL keeps the agent working (up to `hook.maxRetries` times in a
// row), anything else lets it finish. trustbut's own errors, timeouts and "nothing to verify" never block.
import { resolve } from 'node:path';
import { execa } from 'execa';
import { hookSettings, loadConfig } from '../config.js';
import { summarize } from '../hook/feedback.js';
import { respond, type Agent, type HookOutcome, type HookResponse } from '../hook/protocols.js';
import { DEFAULT_STATE_DIR, readAttempts, resetAttempts, stateFile, writeAttempts } from '../hook/state.js';
import { renderForAgent } from '../render.js';
import { runVerify, type VerifyResult } from './verify.js';

export interface HookOptions {
  agent: Agent;
  /** The hook's stdin (JSON from the agent); empty or invalid is treated as `{}`. */
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  /** Fallback project directory when neither the environment nor the input names one. */
  cwd?: string;
  /** Where retry counters live; default `os.tmpdir()/trustbut-hook`. */
  stateDir?: string;
  /** How long a timed-out verify run gets to stop its processes and remove its worktrees; default 8000 ms. */
  stopGraceMs?: number;
}

export interface HookResult extends HookResponse {
  /** The verify run did not stop within the grace period after the time budget ran out; exit now. */
  forceExit?: boolean;
}

const DEFAULT_STOP_GRACE_MS = 8000;
const NO_CHANGES = 'No changes between base and head';
const MAX_REASON = 300;

interface Decision {
  outcome: HookOutcome;
  forceExit?: boolean;
}

/** Never throws: any failure becomes a "couldn't verify" message that lets the agent finish. */
export async function runHook(opts: HookOptions): Promise<HookResult> {
  try {
    const { outcome, forceExit } = await decide(opts);
    return { ...respond(opts.agent, outcome), ...(forceExit ? { forceExit } : {}) };
  } catch (err) {
    return respond(opts.agent, couldNotVerify(err));
  }
}

function couldNotVerify(err: unknown): HookOutcome {
  const text = (err instanceof Error ? err.message : String(err)).split(/\r?\n/)[0]?.trim() || 'unknown error';
  return { kind: 'allow', message: `trustbut couldn't verify: ${text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text}` };
}

function parseInput(stdin: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(stdin ?? '');
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

async function gitTop(dir: string): Promise<string | null> {
  const r = await execa('git', ['rev-parse', '--show-toplevel'], { cwd: dir, reject: false });
  return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** `<git dir>/trustbut/last-receipt.md`: inside .git so it is never committed; per worktree for linked worktrees. */
async function receiptLocation(repo: string): Promise<string | undefined> {
  const r = await execa('git', ['rev-parse', '--git-dir'], { cwd: repo, reject: false });
  return r.exitCode === 0 && r.stdout.trim() ? resolve(repo, r.stdout.trim(), 'trustbut', 'last-receipt.md') : undefined;
}

type Settled = { ok: true; value: VerifyResult } | { ok: false; error: unknown };

async function decide(opts: HookOptions): Promise<Decision> {
  const env = opts.env ?? process.env;
  if (env.TRUSTBUT_SKIP === '1' || env.TRUSTBUT_SKIP === 'true') return { outcome: { kind: 'skip' } };
  const input = parseInput(opts.stdin);
  const dir = str(env.CLAUDE_PROJECT_DIR) ?? str(env.GEMINI_PROJECT_DIR) ?? str(input.cwd) ?? opts.cwd ?? process.cwd();
  const repo = await gitTop(dir);
  if (!repo) return { outcome: { kind: 'skip' } };
  // As committed at HEAD (else the working-tree file), so an uncommitted edit can't switch the hook off.
  const settings = hookSettings(await loadConfig(repo));
  if (!settings.enabled) return { outcome: { kind: 'skip' } };

  const counter = stateFile(opts.stateDir ?? DEFAULT_STATE_DIR, str(input.session_id) ?? str(env.GEMINI_SESSION_ID) ?? '', repo);
  // Letting the agent finish ends its continuation chain, so the next stop starts counting from 0.
  const allow = async (outcome: HookOutcome, extra: Omit<Decision, 'outcome'> = {}): Promise<Decision> => {
    await resetAttempts(counter).catch(() => {});
    return { outcome, ...extra };
  };
  const receiptPath = await receiptLocation(repo);

  const ctl = new AbortController();
  const budgetMs = settings.timeoutSec * 1000;
  const verifying: Promise<Settled> = runVerify({ cwd: repo, working: true, quick: settings.mode === 'quick', receiptMd: receiptPath, signal: ctl.signal }).then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
  let timer: NodeJS.Timeout | undefined;
  const first = await Promise.race([verifying, new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), budgetMs)))]);
  clearTimeout(timer);

  if (first === 'timeout') {
    ctl.abort(new Error(`timed out after ${settings.timeoutSec} s`));
    let grace: NodeJS.Timeout | undefined;
    const stopped = await Promise.race([verifying.then(() => true), new Promise<boolean>((r) => (grace = setTimeout(() => r(false), opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS)))]);
    clearTimeout(grace);
    const message = `trustbut couldn't verify: timed out after ${settings.timeoutSec} s (hook.timeoutSec); not blocking`;
    return allow({ kind: 'allow', message }, stopped ? {} : { forceExit: true });
  }
  if (!first.ok) {
    if (first.error instanceof Error && first.error.message.startsWith(NO_CHANGES)) return allow({ kind: 'skip' });
    return allow(couldNotVerify(first.error));
  }

  const { receipt, writeErrors } = first.value;
  const written = writeErrors.length ? undefined : receiptPath;
  const where = written ? `receipt: ${written}` : 'receipt not written';
  const summary = summarize(receipt);
  if (receipt.verdict === 'pass') return allow({ kind: 'allow', message: `trustbut PASS: ${summary}` });
  if (receipt.verdict === 'warn') return allow({ kind: 'allow', message: `trustbut WARN: ${summary} — ${where}` });

  const attempts = await readAttempts(counter);
  const max = settings.maxRetries;
  if (max === 0) return allow({ kind: 'allow', message: `trustbut FAIL: ${summary} — not sent back to the agent (hook.maxRetries is 0); ${where}` });
  if (attempts >= max) return allow({ kind: 'allow', message: `trustbut still FAIL after ${attempts} attempt${attempts === 1 ? '' : 's'} — ${where}` });
  try {
    await writeAttempts(counter, attempts + 1);
  } catch (err) {
    // Without a counter the agent could loop forever (Codex has no cap): fall back to one retry per chain.
    if (input.stop_hook_active === true) {
      const reason = err instanceof Error ? err.message : String(err);
      return allow({ kind: 'allow', message: `trustbut FAIL: ${summary} — not sent back again: couldn't save the retry counter (${reason}); ${where}` });
    }
  }
  const message = `trustbut FAIL: ${summary} — sent back to the agent (attempt ${attempts + 1}/${max})`;
  return { outcome: { kind: 'block', feedback: renderForAgent(receipt, written), message } };
}
