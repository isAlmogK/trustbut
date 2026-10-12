// Strip variables that make a nested test runner think it is a worker of ours.
// `extra` (config env) is applied last.
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('VITEST') || key === 'NODE_ENV' || key === 'NODE_TEST_CONTEXT' || key === 'TEST') continue;
    env[key] = value;
  }
  env.CI = '1';
  return { ...env, ...extra };
}

/** `{ timedOut: true }` when any of the runs hit the time limit, else nothing (keeps receipts unchanged). */
export const timedOutFlag = (...runs: { timedOut: boolean }[]): { timedOut?: true } => (runs.some((r) => r.timedOut) ? { timedOut: true } : {});

export const tail = (s: string | undefined, max = 4000) => (s ?? '').slice(-max);

// Combined output, plus the execa error text when the process never produced an exit code
// (failed spawn, e.g. ENOENT), so "runner can't start" is distinguishable from "tests failed".
export function runOutput(res: { all?: string; failed: boolean; exitCode?: number; shortMessage?: string }): string {
  const startupError = res.failed && !res.exitCode ? res.shortMessage : undefined;
  return tail([res.all, startupError].filter(Boolean).join('\n'));
}
