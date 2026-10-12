import { spawnSync } from 'node:child_process';

/** Whether `cmd args…` starts and exits 0 (e.g. `hasTool('go', ['version'])`). */
export function hasTool(cmd: string, args: string[] = ['--version']): boolean {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/** Tools CI insists on (env `TRUSTBUT_REQUIRE`, comma-separated): their tests fail instead of skipping. */
export function requiredTools(): Set<string> {
  return new Set(
    (process.env.TRUSTBUT_REQUIRE ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
