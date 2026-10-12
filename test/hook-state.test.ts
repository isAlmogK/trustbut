import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE_DIR, readState, stateFile, STALE_MS, writeState } from '../src/hook/state.js';

const dir = () => mkdtemp(join(tmpdir(), 'tb-state-'));

describe('hook state', () => {
  it('lives in os.tmpdir()/trustbut-hook, named by sha1 of session id and repo', async () => {
    expect(DEFAULT_STATE_DIR).toBe(join(tmpdir(), 'trustbut-hook'));
    const d = await dir();
    const sha = createHash('sha1').update('s1\0/repo').digest('hex');
    expect(stateFile(d, 's1', '/repo')).toBe(join(d, `${sha}.json`));
    expect(stateFile(d, 's1', '/repo')).not.toBe(stateFile(d, 's2', '/repo'));
    expect(stateFile(d, 's1', '/repo')).not.toBe(stateFile(d, 's1', '/other'));
  });

  it('a missing file is an empty state, not an error', async () => {
    expect(await readState(stateFile(await dir(), 's', '/r'))).toEqual({ state: { attempts: 0 } });
  });

  it.each(['{ nope', JSON.stringify({ attempts: 'x', updatedAt: 1 }), JSON.stringify({ attempts: -2, updatedAt: 1 }), 'null'])(
    'a corrupt file (%s) counts 0 and reports an error',
    async (text) => {
      const file = stateFile(await dir(), 's', '/r');
      await writeFile(file, text);
      const read = await readState(file, 1);
      expect(read.state).toEqual({ attempts: 0 });
      expect(read.error).toMatch(/^corrupt state file /);
    },
  );

  it('an unreadable file reports an error', async () => {
    const file = stateFile(await dir(), 's', '/r');
    await mkdir(file);
    expect((await readState(file)).error).toBeTruthy();
  });

  it('writes atomically (creating the folder) and reads back', async () => {
    const d = join(await dir(), 'nested');
    const file = stateFile(d, 's', '/r');
    await writeState(file, { attempts: 2, tree: 't:b', verdict: 'fail' }, 1_000);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ attempts: 2, tree: 't:b', verdict: 'fail', updatedAt: 1_000 });
    expect(await readState(file, 1_000)).toEqual({ state: { attempts: 2, tree: 't:b', verdict: 'fail' } });
    expect(readdirSync(d)).toEqual([file.split('/').pop()]);
  });

  it('ignores a file older than 24 h', async () => {
    const file = stateFile(await dir(), 's', '/r');
    await writeState(file, { attempts: 3, tree: 't', verdict: 'pass' }, 0);
    expect(STALE_MS).toBe(24 * 60 * 60 * 1000);
    expect((await readState(file, STALE_MS)).state.attempts).toBe(3);
    expect(await readState(file, STALE_MS + 1)).toEqual({ state: { attempts: 0 } });
  });
});
