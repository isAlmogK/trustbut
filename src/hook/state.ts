// Per-session hook state: how many times in a row a FAIL was sent back to the agent, and which
// working tree (plus base) was last verified with which verdict, so an unchanged tree isn't rerun.
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Verdict } from '../types.js';

/** `os.tmpdir()/trustbut-hook-<uid>`, so users sharing a temp dir (Linux `/tmp`) never share state; `trustbut-hook` without a uid (Windows). */
export const defaultStateDir = (uid: number | null = process.getuid?.() ?? null): string => join(tmpdir(), uid === null ? 'trustbut-hook' : `trustbut-hook-${uid}`);
export const DEFAULT_STATE_DIR = defaultStateDir();
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

/** Creates `dir` with mode 0700; refuses one owned by another user and tightens one others can read. */
async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  const st = await lstat(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory()) throw new Error(`hook state dir ${dir} is not a directory`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`hook state dir ${dir} belongs to another user`);
  if ((st.mode & 0o077) !== 0) await chmod(dir, 0o700);
}

/** Writes a temp file next to it and renames it into place, so a reader never sees half a file. */
export async function writeState(file: string, state: HookState, now = Date.now()): Promise<void> {
  await ensurePrivateDir(dirname(file));
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
