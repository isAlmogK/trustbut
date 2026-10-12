import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { runVerify } from '../src/commands/verify.js';
import { groupAlive, runInGroup, withAbort } from '../src/process.js';
import { startSetup } from '../src/setup.js';
import { makeRepo, writeFiles } from './helpers/repo.js';

const ENV = { PATH: '/bin:/usr/bin' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(file: string): Promise<number> {
  for (let i = 0; i < 200 && !existsSync(file); i++) await sleep(25);
  return Number(readFileSync(file, 'utf8').trim());
}

describe('withAbort + runInGroup', () => {
  it('stops the whole process group and rejects with the abort reason', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tb-abort-'));
    const ctl = new AbortController();
    const started = Date.now();
    const run = withAbort(ctl.signal, () => runInGroup('sh', ['-c', 'sleep 30 & echo $! > child.pid; wait'], { cwd, env: ENV, graceMs: 500 }));
    const child = await waitFor(join(cwd, 'child.pid'));
    ctl.abort(new Error('budget used up'));
    await expect(run).rejects.toThrow('budget used up');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(groupAlive(child)).toBe(false);
  });

  it('does not start anything once aborted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tb-abort-'));
    const ctl = new AbortController();
    ctl.abort(new Error('too late'));
    await expect(withAbort(ctl.signal, () => runInGroup('sh', ['-c', 'touch ran'], { cwd, env: ENV }))).rejects.toThrow('too late');
    expect(existsSync(join(cwd, 'ran'))).toBe(false);
  });

  it('leaves runs outside the scope alone', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tb-abort-'));
    const res = await runInGroup('sh', ['-c', 'exit 3'], { cwd, env: ENV });
    expect(res.exitCode).toBe(3);
  });
});

describe('withAbort + startSetup', () => {
  it('stops a setup that is still being waited for', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tb-abort-'));
    const ctl = new AbortController();
    const start = withAbort(ctl.signal, () => startSetup({ command: 'echo $$ > setup.pid; sleep 30', cwd, waitMs: 30_000, graceMs: 500 }));
    const pid = await waitFor(join(cwd, 'setup.pid'));
    ctl.abort(new Error('budget used up'));
    await expect(start).rejects.toThrow('budget used up');
    expect(groupAlive(pid)).toBe(false);
  });
});

describe('runVerify with a signal', () => {
  it('rejects with the reason and removes its worktrees', async () => {
    const { dir } = await makeRepo({
      '.trustbut.json': JSON.stringify({ command: 'sleep 30' }),
      'src/a.js': 'export const a = 1;\n',
    });
    await writeFiles(dir, { 'src/a.js': 'export const a = 2;\n', 'test/a.test.js': "it('a', () => {});\n" });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new Error('budget used up')), 1500);
    const started = Date.now();
    await expect(runVerify({ cwd: dir, working: true, signal: ctl.signal })).rejects.toThrow('budget used up');
    expect(Date.now() - started).toBeLessThan(15_000);
    const wt = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: dir });
    expect(wt.stdout.split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
  });
});
