import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE_DIR, readAttempts, resetAttempts, stateFile, STALE_MS, writeAttempts } from '../src/hook/state.js';

const dir = () => mkdtemp(join(tmpdir(), 'tb-state-'));

describe('hook retry state', () => {
  it('lives in os.tmpdir()/trustbut-hook, named by sha1 of session id and repo', async () => {
    expect(DEFAULT_STATE_DIR).toBe(join(tmpdir(), 'trustbut-hook'));
    const d = await dir();
    const sha = createHash('sha1').update('s1\0/repo').digest('hex');
    expect(stateFile(d, 's1', '/repo')).toBe(join(d, `${sha}.json`));
    expect(stateFile(d, 's1', '/repo')).not.toBe(stateFile(d, 's2', '/repo'));
    expect(stateFile(d, 's1', '/repo')).not.toBe(stateFile(d, 's1', '/other'));
  });

  it('counts 0 when the file is missing or corrupt', async () => {
    const d = await dir();
    const file = stateFile(d, 's', '/r');
    expect(await readAttempts(file)).toBe(0);
    await writeFile(file, '{ nope');
    expect(await readAttempts(file)).toBe(0);
    await writeFile(file, JSON.stringify({ attempts: 'x', updatedAt: Date.now() }));
    expect(await readAttempts(file)).toBe(0);
    await writeFile(file, JSON.stringify({ attempts: -2, updatedAt: Date.now() }));
    expect(await readAttempts(file)).toBe(0);
  });

  it('writes atomically (creating the folder) and reads back', async () => {
    const d = join(await dir(), 'nested');
    const file = stateFile(d, 's', '/r');
    await writeAttempts(file, 2, 1_000);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ attempts: 2, updatedAt: 1_000 });
    expect(await readAttempts(file, 1_000)).toBe(2);
    expect(readdirSync(d)).toEqual([file.split('/').pop()]);
  });

  it('ignores a file older than 24 h', async () => {
    const d = await dir();
    const file = stateFile(d, 's', '/r');
    await writeAttempts(file, 3, 0);
    expect(STALE_MS).toBe(24 * 60 * 60 * 1000);
    expect(await readAttempts(file, STALE_MS)).toBe(3);
    expect(await readAttempts(file, STALE_MS + 1)).toBe(0);
  });

  it('reset removes the file and tolerates a missing one', async () => {
    const d = await dir();
    const file = stateFile(d, 's', '/r');
    await resetAttempts(file);
    await writeAttempts(file, 1);
    await resetAttempts(file);
    expect(existsSync(file)).toBe(false);
  });
});
