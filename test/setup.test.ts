import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startSetup } from '../src/setup.js';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Waits up to 3 s for `pid` to disappear (an orphan is reaped by init shortly after it dies). */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 60 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
}

const tmp = () => mkdtemp(join(tmpdir(), 'ar-setup-'));

describe('startSetup', () => {
  it('starts as soon as the ready pattern appears and kills the whole process group on stop', async () => {
    const dir = await tmp();
    const start = Date.now();
    const setup = await startSetup({
      command: 'sleep 300 & echo $! > child.pid; echo "booting"; echo "All emulators ready"; wait',
      cwd: dir,
      waitMs: 20_000,
      readyPattern: 'emulators ready',
    });
    expect(Date.now() - start).toBeLessThan(5_000);
    const child = Number(await readFile(join(dir, 'child.pid'), 'utf8'));
    expect(alive(child)).toBe(true);
    expect(alive(setup.pid)).toBe(true);
    await setup.stop();
    expect(await gone(child)).toBe(true);
    expect(await gone(setup.pid)).toBe(true);
  });

  it('matches the ready pattern on stderr too', async () => {
    const setup = await startSetup({ command: 'echo ready >&2; exec sleep 300', cwd: await tmp(), waitMs: 20_000, readyPattern: '^ready$' });
    await setup.stop();
    expect(await gone(setup.pid)).toBe(true);
  });

  it('waits waitMs when there is no ready pattern (or it never matches)', async () => {
    for (const readyPattern of [undefined, 'never printed']) {
      const start = Date.now();
      const setup = await startSetup({ command: 'exec sleep 300', cwd: await tmp(), waitMs: 400, readyPattern });
      expect(Date.now() - start).toBeGreaterThanOrEqual(350);
      await setup.stop();
      expect(await gone(setup.pid)).toBe(true);
    }
  });

  it('continues right away when the setup command finishes successfully', async () => {
    const dir = await tmp();
    const start = Date.now();
    const setup = await startSetup({ command: 'echo done > marker', cwd: dir, waitMs: 20_000, readyPattern: 'never' });
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(existsSync(join(dir, 'marker'))).toBe(true);
    await setup.stop();
  });

  it('fails with its output when the setup command exits non-zero, leaving nothing running', async () => {
    const dir = await tmp();
    await expect(
      startSetup({ command: 'sleep 300 & echo $! > child.pid; echo "port taken" >&2; exit 3', cwd: dir, waitMs: 20_000 }),
    ).rejects.toThrow(/Setup command exited with code 3.*port taken/s);
    const child = Number(await readFile(join(dir, 'child.pid'), 'utf8'));
    expect(await gone(child)).toBe(true);
  });

  it('SIGKILLs a process group that ignores SIGTERM after the grace period', async () => {
    const setup = await startSetup({
      command: "trap '' TERM; echo ready; while :; do sleep 0.1; done",
      cwd: await tmp(),
      waitMs: 20_000,
      readyPattern: 'ready',
      graceMs: 300,
    });
    const start = Date.now();
    await setup.stop();
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(await gone(setup.pid)).toBe(true);
  });

  it('passes env and runs in cwd; stop is idempotent', async () => {
    const dir = await tmp();
    const setup = await startSetup({ command: 'printf "%s" "$MARK" > env.txt', cwd: dir, env: { MARK: 'm1' }, waitMs: 20_000 });
    await setup.stop();
    await setup.stop();
    expect(await readFile(join(dir, 'env.txt'), 'utf8')).toBe('m1');
  });
});
