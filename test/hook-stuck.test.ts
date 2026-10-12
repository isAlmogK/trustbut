import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runHook } from '../src/commands/hook.js';
import { makeRepo } from './helpers/repo.js';

// A verify run that ignores the abort signal and never settles, or one that throws something odd.
const behaviour = vi.hoisted(() => ({ mode: 'stuck' as 'stuck' | 'throw-string' }));
vi.mock('../src/commands/verify.js', () => ({
  runVerify: () => {
    if (behaviour.mode === 'throw-string') throw 'not an Error';
    return new Promise(() => {});
  },
}));

async function repo() {
  const { dir } = await makeRepo({ '.trustbut.json': JSON.stringify({ hook: { timeoutSec: 0.2 } }), 'a.txt': 'a\n' });
  return realpath(dir);
}

describe('trustbut hook with a misbehaving verify run', () => {
  it('gives up after the budget plus a grace period and asks the caller to exit', async () => {
    behaviour.mode = 'stuck';
    const dir = await repo();
    const started = Date.now();
    const r = await runHook({ agent: 'codex', stdin: JSON.stringify({ cwd: dir }), env: {}, stateDir: await mkdtemp(join(tmpdir(), 'tb-s-')), stopGraceMs: 100 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify({ systemMessage: "trustbut couldn't verify: timed out after 0.2 s (hook.timeoutSec); not blocking" })}\n`,
      stderr: '',
      forceExit: true,
    });
  });

  it.each(['claude', 'codex', 'gemini'] as const)('%s: an unexpected throw is a non-blocking message', async (agent) => {
    behaviour.mode = 'throw-string';
    const dir = await repo();
    const r = await runHook({ agent, stdin: JSON.stringify({ cwd: dir }), env: {}, stateDir: await mkdtemp(join(tmpdir(), 'tb-s-')) });
    expect(r).toEqual({ exitCode: 0, stdout: `${JSON.stringify({ systemMessage: "trustbut couldn't verify: not an Error" })}\n`, stderr: '' });
  });
});
