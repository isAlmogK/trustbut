// Runs the config's `setup` command (e.g. a database emulator) in the background for one test run.
// It gets its own process group so that it and everything it starts can be stopped together.
import { spawn } from 'node:child_process';
import { GRACE_MS, guardGroup, killGroup } from './process.js';
import { childEnv, tail } from './runners/env.js';

export interface SetupOptions {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  /** How long to wait before tests start, unless `readyPattern` matches first. */
  waitMs: number;
  /** Tests start as soon as a line of output (stdout or stderr) matches. */
  readyPattern?: string;
  /** Time between SIGTERM and SIGKILL when stopping; default 3000. */
  graceMs?: number;
}

export interface SetupProcess {
  /** Process id of the shell, which is also the process group id. */
  pid: number;
  /** Kills the whole process group: SIGTERM, then SIGKILL after the grace period. Idempotent. */
  stop(): Promise<void>;
}

export async function startSetup({ command, cwd, env, waitMs, readyPattern, graceMs = GRACE_MS }: SetupOptions): Promise<SetupProcess> {
  const child = spawn('sh', ['-c', command], { cwd, env: childEnv(env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = child.pid;
  if (pid === undefined) {
    const err = await new Promise<Error>((resolve) => child.once('error', resolve));
    throw new Error(`Setup command could not start: ${err.message}`);
  }

  const release = guardGroup(pid);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await killGroup(pid, graceMs);
    release();
    child.stdout?.destroy();
    child.stderr?.destroy();
  };

  // Keep reading output for the whole run so a chatty process never blocks on a full pipe.
  let output = '';
  const pattern = readyPattern !== undefined ? new RegExp(readyPattern) : undefined;
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  for (const stream of [child.stdout, child.stderr]) {
    let partial = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      output = tail(output + chunk);
      if (!pattern) return;
      const lines = (partial + chunk).split(/\r?\n/);
      partial = lines.pop() ?? '';
      if (lines.some((l) => pattern.test(l))) markReady();
    });
  }

  type Outcome = { kind: 'ready' } | { kind: 'failed'; code: number | null; signal: NodeJS.Signals | null } | { kind: 'error'; err: Error };
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race<Outcome>([
    ready.then(() => ({ kind: 'ready' })),
    new Promise<Outcome>((resolve) => (timer = setTimeout(() => resolve({ kind: 'ready' }), waitMs))),
    // Finished and its output closed: a one-shot setup (or one that failed).
    new Promise<Outcome>((resolve) =>
      child.once('close', (code, signal) => resolve(code === 0 ? { kind: 'ready' } : { kind: 'failed', code, signal })),
    ),
    // Failed while something it started still holds the output open.
    new Promise<Outcome>((resolve) => child.once('exit', (code, signal) => code !== 0 && resolve({ kind: 'failed', code, signal }))),
    new Promise<Outcome>((resolve) => child.once('error', (err) => resolve({ kind: 'error', err }))),
  ]);
  clearTimeout(timer);

  if (outcome.kind !== 'ready') {
    await stop();
    if (outcome.kind === 'error') throw new Error(`Setup command could not start: ${outcome.err.message}`);
    const how = outcome.code !== null ? `with code ${outcome.code}` : `on ${outcome.signal}`;
    const last = output.trim() ? `: ${output.trim().split(/\r?\n/).slice(-5).join('\n')}` : '';
    throw new Error(`Setup command exited ${how} before tests started${last}`);
  }
  return { pid, stop };
}
