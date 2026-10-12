import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runInGroup } from '../src/process.js';

describe('runInGroup', () => {
  it("throws \"Couldn't start\" when the program cannot be spawned", async () => {
    const cwd = await mkdtemp(`${tmpdir()}/tb-proc-`);
    await expect(runInGroup('no-such-tool-xyz', ['test'], { cwd, env: { PATH: '/nonexistent' } })).rejects.toThrow(
      /^Couldn't start no-such-tool-xyz: /,
    );
  });

  it('does not treat a program killed by a signal as a start-up failure', async () => {
    const cwd = await mkdtemp(`${tmpdir()}/tb-proc-`);
    const res = await runInGroup('sh', ['-c', 'kill -9 $$'], { cwd, env: { PATH: '/bin:/usr/bin' } });
    expect(res.exitCode).toBeUndefined();
    expect(res.failed).toBe(true);
    expect(res.timedOut).toBe(false);
  });
});
