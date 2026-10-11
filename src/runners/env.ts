// Strip variables that make a nested test runner think it is a worker of ours.
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('VITEST') || key === 'NODE_ENV' || key === 'TEST') continue;
    env[key] = value;
  }
  env.CI = '1';
  return env;
}

export const tail = (s: string | undefined, max = 4000) => (s ?? '').slice(-max);

// Combined output, plus the execa error text when the process never produced an exit code
// (failed spawn, e.g. ENOENT), so "runner can't start" is distinguishable from "tests failed".
export function runOutput(res: { all?: string; failed: boolean; exitCode?: number; shortMessage?: string }): string {
  const startupError = res.failed && !res.exitCode ? res.shortMessage : undefined;
  return tail([res.all, startupError].filter(Boolean).join('\n'));
}
