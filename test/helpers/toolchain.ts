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

// Isolation: where one test file covers several tools whose binaries a runner image preinstalls
// (jvm.test.ts: mvn and gradle), the CI matrix narrows each entry with `vitest -t "<describe name>"`
// rather than the tests inspecting TRUSTBUT_REQUIRE; TRUSTBUT_REQUIRE only ever turns skips into failures.
