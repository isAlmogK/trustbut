// Per-session retry counter for `trustbut hook`: how many times in a row a FAIL was sent back to
// the agent. Any allowed stop ends the agent's continuation chain, so it resets the counter.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_STATE_DIR = join(tmpdir(), 'trustbut-hook');
/** A counter not touched for this long belongs to an old session and is ignored. */
export const STALE_MS = 24 * 60 * 60 * 1000;

interface HookState {
  attempts: number;
  updatedAt: number;
}

/** `<dir>/<sha1(sessionId + NUL + repo)>.json`. */
export function stateFile(dir: string, sessionId: string, repo: string): string {
  return join(dir, `${createHash('sha1').update(`${sessionId}\0${repo}`).digest('hex')}.json`);
}

/** Attempts so far; 0 when the file is missing, unreadable, malformed or stale. */
export async function readAttempts(file: string, now = Date.now()): Promise<number> {
  try {
    const state = JSON.parse(await readFile(file, 'utf8')) as Partial<HookState>;
    const { attempts, updatedAt } = state;
    if (!Number.isInteger(attempts) || (attempts as number) < 0 || typeof updatedAt !== 'number') return 0;
    return now - updatedAt > STALE_MS ? 0 : (attempts as number);
  } catch {
    return 0;
  }
}

/** Writes a temp file next to it and renames it into place, so a reader never sees half a file. */
export async function writeAttempts(file: string, attempts: number, now = Date.now()): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const state: HookState = { attempts, updatedAt: now };
  try {
    await writeFile(tmp, JSON.stringify(state));
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

export async function resetAttempts(file: string): Promise<void> {
  await rm(file, { force: true });
}
