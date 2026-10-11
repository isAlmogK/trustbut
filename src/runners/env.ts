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
