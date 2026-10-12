// Child processes that run in their own process group, so that a timeout or a stop reaches
// everything they started (test workers, servers), not just the direct child.
import { execa } from 'execa';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Default time between SIGTERM and SIGKILL. */
export const GRACE_MS = 3000;

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // already gone
  }
}

/** Waits up to `ms` for every process in the group to exit; true if they did. */
export async function waitGone(pgid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= until) return false;
    await sleep(25);
  }
  return true;
}

/** SIGTERM the group, then SIGKILL whatever is left after `graceMs`. */
export async function killGroup(pgid: number, graceMs = GRACE_MS): Promise<void> {
  if (!groupAlive(pgid)) return;
  signalGroup(pgid, 'SIGTERM');
  if (!(await waitGone(pgid, graceMs))) {
    signalGroup(pgid, 'SIGKILL');
    await waitGone(pgid, 2000);
  }
}

/**
 * Until the returned release function is called, SIGKILLs the group when trustbut exits or is
 * interrupted. The group is not ours, so a terminal's Ctrl-C would not reach it otherwise.
 */
export function guardGroup(pgid: number): () => void {
  const killNow = () => signalGroup(pgid, 'SIGKILL');
  const onSignal = (signal: NodeJS.Signals) => {
    killNow();
    release();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  const release = () => {
    process.off('exit', killNow);
    for (const s of SIGNALS) process.off(s, onSignal);
  };
  process.on('exit', killNow);
  for (const s of SIGNALS) process.on(s, onSignal);
  return release;
}

export interface GroupRunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  graceMs?: number;
}

export interface GroupRunResult {
  exitCode?: number;
  stdout: string;
  stderr: string;
  all: string;
  failed: boolean;
  timedOut: boolean;
  shortMessage?: string;
}

/**
 * Runs `file args` in its own process group with combined output. On timeout the whole group is
 * stopped (SIGTERM, then SIGKILL); processes left behind after a normal exit are stopped too.
 */
export async function runInGroup(
  file: string,
  args: string[],
  { cwd, env, timeoutMs, graceMs = GRACE_MS }: GroupRunOptions,
): Promise<GroupRunResult> {
  const sub = execa(file, args, { cwd, env, extendEnv: false, reject: false, all: true, detached: true, stdin: 'ignore' });
  const pid = sub.pid;
  const release = pid !== undefined ? guardGroup(pid) : () => {};
  let timedOut = false;
  let killing: Promise<void> | undefined;
  const timer =
    pid !== undefined && timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          killing = killGroup(pid, graceMs);
        }, timeoutMs)
      : undefined;
  try {
    const res = await sub;
    clearTimeout(timer);
    await killing;
    return {
      exitCode: timedOut ? undefined : res.exitCode,
      stdout: String(res.stdout ?? ''),
      stderr: String(res.stderr ?? ''),
      all: String(res.all ?? ''),
      failed: timedOut || res.failed,
      timedOut,
      shortMessage: timedOut ? `Command timed out after ${timeoutMs} ms` : res.shortMessage,
    };
  } finally {
    clearTimeout(timer);
    // Anything the tool left running (workers, servers) goes with it.
    if (pid !== undefined) await killGroup(pid, graceMs);
    release();
  }
}
