// `trustbut hook <agent>`: run from an agent's turn-end hook. Verifies the working tree and answers
// in that agent's hook protocol: a FAIL keeps the agent working (up to `hook.maxRetries` times in a
// row), anything else lets it finish. trustbut's own errors, timeouts and "nothing to verify" never block.
import { resolve } from 'node:path';
import { execa } from 'execa';
import { hookSettings, loadConfig } from '../config.js';
import { summarize } from '../hook/feedback.js';
import { respond, type Agent, type HookOutcome, type HookResponse } from '../hook/protocols.js';
import { resolveHookBase, verifyDefaultBase } from '../hook/base.js';
import { DEFAULT_STATE_DIR, hookSettingsKey, readState, stateFile, writeState, type HookState } from '../hook/state.js';
import { resolveRef, snapshotWorkingTree } from '../git.js';
import { shellQuote } from '../runners/command.js';
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
  /** Aborting (e.g. on SIGTERM) stops the verify run's processes and removes its worktrees. */
  signal?: AbortSignal;
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

// `^`, `~`, `{` and `}` are special to some shells (zsh globbing, brace expansion, `~` home): quote them.
const SAFE_ARG = /^[\w./@:-]+$/;
export const recheckArg = (s: string): string => (SAFE_ARG.test(s) ? s : shellQuote(s));

/** `<snapshot tree>:<merge-base commit>`, or undefined when the base doesn't resolve. */
async function fingerprint(repo: string, snapshot: string, baseRef: string): Promise<string | undefined> {
  const tree = await resolveTree(repo, snapshot);
  const base = await resolveRef(repo, baseRef);
  if (!tree || !base) return undefined;
  const r = await execa('git', ['merge-base', base, snapshot], { cwd: repo, reject: false });
  return r.exitCode === 0 ? `${tree}:${r.stdout.trim()}` : undefined;
}

async function resolveTree(repo: string, commit: string): Promise<string | undefined> {
  const r = await execa('git', ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`], { cwd: repo, reject: false });
  return r.exitCode === 0 ? r.stdout.trim() : undefined;
}

async function decide(opts: HookOptions): Promise<Decision> {
  const env = opts.env ?? process.env;
  if (env.TRUSTBUT_SKIP === '1' || env.TRUSTBUT_SKIP === 'true') return { outcome: { kind: 'skip' } };
  opts.signal?.throwIfAborted();
  const input = parseInput(opts.stdin);
  const dir = str(env.CLAUDE_PROJECT_DIR) ?? str(env.GEMINI_PROJECT_DIR) ?? str(input.cwd) ?? opts.cwd ?? process.cwd();
  const repo = await gitTop(dir);
  if (!repo) return { outcome: { kind: 'skip' } };
  // As committed at HEAD (else the working-tree file), so an uncommitted edit can't switch the hook off.
  const settings = hookSettings(await loadConfig(repo));
  if (!settings.enabled) return { outcome: { kind: 'skip' } };

  const counter = stateFile(opts.stateDir ?? DEFAULT_STATE_DIR, str(input.session_id) ?? str(env.GEMINI_SESSION_ID) ?? '', repo);
  const read = await readState(counter);
  // stop_hook_active false: the user's new turn, so a new chain. Missing or true: keep counting.
  const attempts = input.stop_hook_active === false ? 0 : read.state.attempts;
  // Mid-chain with an unreadable counter, a block could repeat forever: never block then.
  const noBlock = input.stop_hook_active === true && read.error ? `couldn't read the retry counter (${read.error})` : undefined;
  const save = (state: HookState) => writeState(counter, state);
  const base = await resolveHookBase(repo, settings.base);
  const withNote = (outcome: HookOutcome): HookOutcome =>
    !base.note || outcome.kind === 'skip' ? outcome : { ...outcome, message: `${outcome.message} — ${base.note}` };
  // Letting the agent finish ends its continuation chain, so the next stop starts counting from 0.
  const allow = async (outcome: HookOutcome, state: HookState = { attempts: 0 }, extra: Omit<Decision, 'outcome'> = {}): Promise<Decision> => {
    await save(state).catch(() => {});
    return { outcome: withNote(outcome), ...extra };
  };

  const snapshot = await snapshotWorkingTree(repo);
  const treeKey = await fingerprint(repo, snapshot, base.ref);
  const print = treeKey === undefined ? undefined : `${treeKey}:${hookSettingsKey(settings)}`;
  const receiptPath = await receiptLocation(repo);
  const where = (path: string | undefined) => (path ? `receipt: ${path}` : 'receipt not written');

  // Nothing changed since the last check: don't rerun. A FAIL is not sent back again on a new turn
  // (e.g. the user only asked a question); within a chain the normal retry logic applies below.
  const last = print !== undefined && read.state.tree === print ? read.state.verdict : undefined;
  if (last === 'pass' || last === 'warn') return allow({ kind: 'skip' }, { attempts: 0, tree: print, verdict: last });
  if (last === 'fail' && attempts === 0) {
    return allow({ kind: 'allow', message: `trustbut FAIL (unchanged since last check) — ${where(receiptPath)}` }, { attempts: 0, tree: print, verdict: 'fail' });
  }

  // The plugin launcher passes what is left of the agent's hook timeout after its own start-up.
  const cap = Number(env.TRUSTBUT_HOOK_TIMEOUT_SEC);
  const capped = Number.isFinite(cap) && cap > 0 && cap < settings.timeoutSec;
  const budgetSec = capped ? cap : settings.timeoutSec;
  const budgetName = capped ? 'TRUSTBUT_HOOK_TIMEOUT_SEC' : 'hook.timeoutSec';
  const ctl = new AbortController();
  const signal = opts.signal ? AbortSignal.any([ctl.signal, opts.signal]) : ctl.signal;
  const quick = settings.mode === 'quick';
  const verifying: Promise<Settled> = runVerify({ cwd: repo, working: true, snapshot, base: base.ref, quick, receiptMd: receiptPath, signal }).then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
  let timer: NodeJS.Timeout | undefined;
  const first = await Promise.race([verifying, new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), budgetSec * 1000)))]);
  clearTimeout(timer);

  if (first === 'timeout') {
    ctl.abort(new Error(`timed out after ${budgetSec} s`));
    let grace: NodeJS.Timeout | undefined;
    const stopped = await Promise.race([verifying.then(() => true), new Promise<boolean>((r) => (grace = setTimeout(() => r(false), opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS)))]);
    clearTimeout(grace);
    const message = `trustbut couldn't verify: timed out after ${budgetSec} s (${budgetName}); not blocking`;
    return allow({ kind: 'allow', message }, undefined, stopped ? {} : { forceExit: true });
  }
  if (!first.ok) {
    if (first.error instanceof Error && first.error.message.startsWith(NO_CHANGES)) return allow({ kind: 'skip' });
    return allow(couldNotVerify(first.error));
  }

  const { receipt, writeErrors } = first.value;
  const written = writeErrors.length ? undefined : receiptPath;
  const summary = summarize(receipt);
  const verified: HookState = { attempts: 0, ...(print ? { tree: print } : {}), verdict: receipt.verdict };
  if (receipt.verdict === 'pass') return allow({ kind: 'allow', message: `trustbut PASS: ${summary}` }, verified);
  if (receipt.verdict === 'warn') return allow({ kind: 'allow', message: `trustbut WARN: ${summary} — ${where(written)}` }, verified);

  const max = settings.maxRetries;
  if (max === 0) return allow({ kind: 'allow', message: `trustbut FAIL: ${summary} — not sent back to the agent (hook.maxRetries is 0); ${where(written)}` }, verified);
  if (attempts >= max) return allow({ kind: 'allow', message: `trustbut still FAIL after ${attempts} attempt${attempts === 1 ? '' : 's'} — ${where(written)}` }, verified);
  if (noBlock) return allow({ kind: 'allow', message: `trustbut FAIL: ${summary} — not sent back again: ${noBlock}; ${where(written)}` }, verified);
  try {
    await save({ ...verified, attempts: attempts + 1 });
  } catch (err) {
    // Without a counter the agent could loop forever (Codex has no cap): fall back to one retry per chain.
    if (input.stop_hook_active === true) {
      const reason = err instanceof Error ? err.message : String(err);
      return allow({ kind: 'allow', message: `trustbut FAIL: ${summary} — not sent back again: couldn't save the retry counter (${reason}); ${where(written)}` }, verified);
    }
  }
  const defaultBase = await verifyDefaultBase(repo);
  const recheck = `trustbut verify --working${quick ? ' --quick' : ''}${base.ref !== defaultBase ? ` --base ${recheckArg(base.ref)}` : ''}`;
  const message = `trustbut FAIL: ${summary} — sent back to the agent (attempt ${attempts + 1}/${max})`;
  return { outcome: withNote({ kind: 'block', feedback: renderForAgent(receipt, written, { recheck }), message }) };
}
