// Per-session hook state: how many times in a row a FAIL was sent back to the agent, and which
// working tree (plus base) was last verified with which verdict, so an unchanged tree isn't rerun.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Verdict } from '../types.js';

export const DEFAULT_STATE_DIR = join(tmpdir(), 'trustbut-hook');
/** State not touched for this long belongs to an old session and is ignored. */
export const STALE_MS = 24 * 60 * 60 * 1000;

export interface HookState {
  attempts: number;
  /** What was last verified: `<snapshot tree>:<merge-base commit>:<settings hash>`. */
  tree?: string;
  /** The verdict for `tree`. */
  verdict?: Verdict;
}

export interface StateRead {
  state: HookState;
  /** Set when the file exists but could not be read or parsed (a missing or stale file is not an error). */
  error?: string;
}

const VERDICTS: readonly unknown[] = ['pass', 'warn', 'fail'];

/** `<dir>/<sha1(sessionId + NUL + repo)>.json`. */
export function stateFile(dir: string, sessionId: string, repo: string): string {
  return join(dir, `${createHash('sha1').update(`${sessionId}\0${repo}`).digest('hex')}.json`);
}

export async function readState(file: string, now = Date.now()): Promise<StateRead> {
  const empty: HookState = { attempts: 0 };
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { state: empty } : { state: empty, error: (err as Error).message };
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const { attempts, updatedAt, tree, verdict } = raw ?? {};
    if (!Number.isInteger(attempts) || (attempts as number) < 0 || typeof updatedAt !== 'number') throw new Error('unexpected contents');
    if (now - updatedAt > STALE_MS) return { state: empty };
    return {
      state: {
        attempts: attempts as number,
        ...(typeof tree === 'string' ? { tree } : {}),
        ...(VERDICTS.includes(verdict) ? { verdict: verdict as Verdict } : {}),
      },
    };
  } catch (err) {
    return { state: empty, error: `corrupt state file ${file}: ${(err as Error).message}` };
  }
}

/** Writes a temp file next to it and renames it into place, so a reader never sees half a file. */
export async function writeState(file: string, state: HookState, now = Date.now()): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ ...state, updatedAt: now }));
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Hash of the hook settings that change what a run reports or sends back, so changing one invalidates the unchanged-tree cache. */
export function hookSettingsKey(s: { mode: string; maxRetries: number; base?: string; timeoutSec: number }): string {
  const text = JSON.stringify([s.mode, s.maxRetries, s.base ?? null, s.timeoutSec]);
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}
