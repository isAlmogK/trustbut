import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, hookSettings, loadConfig, normalizeRoot, validateConfig } from '../src/config.js';
import { commitAll, makeRepo, writeFiles } from './helpers/repo.js';

describe('loadConfig', () => {
  it('returns an empty config when there is no .trustbut.json', async () => {
    const { dir } = await makeRepo({ 'a.txt': 'a\n' });
    expect(await loadConfig(dir)).toEqual({});
  });

  it('reads .trustbut.json from the head commit, not the working tree', async () => {
    const { dir } = await makeRepo({ '.trustbut.json': JSON.stringify({ root: 'pkg' }) });
    await writeFiles(dir, { '.trustbut.json': JSON.stringify({ root: 'edited' }) });
    expect(await loadConfig(dir)).toEqual({ root: 'pkg' });
  });

  it('reads it from a given head ref', async () => {
    const { dir, base } = await makeRepo({ '.trustbut.json': JSON.stringify({ timeoutSec: 10 }) });
    await writeFiles(dir, { '.trustbut.json': JSON.stringify({ timeoutSec: 20 }) });
    await commitAll(dir, 'change');
    expect(await loadConfig(dir, undefined, base)).toEqual({ timeoutSec: 10 });
    expect(await loadConfig(dir)).toEqual({ timeoutSec: 20 });
  });

  it('falls back to the working-tree file when head has none', async () => {
    const { dir } = await makeRepo({ 'a.txt': 'a\n' });
    await writeFiles(dir, { '.trustbut.json': JSON.stringify({ runner: 'pytest' }) });
    expect(await loadConfig(dir)).toEqual({ runner: 'pytest' });
  });

  it('reads an explicit --config path instead', async () => {
    const { dir } = await makeRepo({ '.trustbut.json': JSON.stringify({ root: 'pkg' }) });
    const other = join(await mkdtemp(join(tmpdir(), 'ar-cfg-')), 'mine.json');
    await writeFile(other, JSON.stringify({ args: ['-p', '1'], env: { A: 'b' } }));
    expect(await loadConfig(dir, other)).toEqual({ args: ['-p', '1'], env: { A: 'b' } });
  });

  it('errors on a missing explicit path and on invalid JSON', async () => {
    const { dir } = await makeRepo({ '.trustbut.json': '{ nope' });
    await expect(loadConfig(dir, join(dir, 'missing.json'))).rejects.toThrow(/Config file not found: .*missing\.json/);
    await expect(loadConfig(dir)).rejects.toThrow(/Could not parse \.trustbut\.json: /);
  });
});

describe('validateConfig', () => {
  it('accepts every documented key', () => {
    const config = {
      root: 'functions',
      runner: 'command',
      command: 'make test',
      junit: 'out/junit.xml',
      setup: 'firebase emulators:start',
      setupWaitSec: 30,
      setupReadyPattern: 'All emulators ready',
      env: { FIRESTORE_EMULATOR_HOST: 'localhost:8080' },
      args: ['-p', '1'],
      timeoutSec: 600,
      hook: { enabled: true, mode: 'full', maxRetries: 0, timeoutSec: 300 },
    };
    expect(validateConfig(config, '.trustbut.json')).toEqual(config);
    expect(Object.keys(config).sort()).toEqual([...CONFIG_KEYS].sort());
  });

  it('accepts the largest timeouts and ignores a $schema key', () => {
    expect(validateConfig({ timeoutSec: 2_000_000, setupWaitSec: 2_000_000 }, '.trustbut.json')).toEqual({ timeoutSec: 2_000_000, setupWaitSec: 2_000_000 });
    expect(validateConfig({ $schema: 'https://example.com/trustbut.schema.json', root: 'api' }, '.trustbut.json')).toEqual({ root: 'api' });
  });

  it('rejects unknown keys and lists the allowed ones', () => {
    expect(() => validateConfig({ rot: '.', runer: 'x' }, '.trustbut.json')).toThrow(
      `Unknown keys in .trustbut.json: rot, runer. Allowed keys: ${CONFIG_KEYS.join(', ')}`,
    );
  });

  it.each([
    [[], 'must be a JSON object'],
    [{ root: 1 }, '"root" must be a string'],
    [{ runner: true }, '"runner" must be a string'],
    [{ args: 'x' }, '"args" must be an array of strings'],
    [{ args: [1] }, '"args" must be an array of strings'],
    [{ env: { A: 1 } }, '"env" must be an object of strings'],
    [{ env: ['A'] }, '"env" must be an object of strings'],
    [{ timeoutSec: 0 }, '"timeoutSec" must be a positive number'],
    [{ timeoutSec: '9' }, '"timeoutSec" must be a positive number'],
    [{ setupWaitSec: -1 }, '"setupWaitSec" must be a number >= 0'],
    [{ timeoutSec: 2_000_001 }, '"timeoutSec" must be a positive number up to 2000000'],
    [{ setupWaitSec: 2_000_001 }, '"setupWaitSec" must be a number >= 0 and up to 2000000'],
    [{ setupReadyPattern: '(' }, '"setupReadyPattern" is not a valid regular expression'],
    [{ hook: true }, '"hook" must be an object'],
    [{ hook: [] }, '"hook" must be an object'],
    [{ hook: { enable: false } }, 'Unknown keys in "hook" in .trustbut.json: enable. Allowed keys: enabled, mode, maxRetries, timeoutSec'],
    [{ hook: { enabled: 'no' } }, '"hook.enabled" must be true or false'],
    [{ hook: { mode: 'fast' } }, '"hook.mode" must be "quick" or "full"'],
    [{ hook: { maxRetries: -1 } }, '"hook.maxRetries" must be a whole number from 0 to 100'],
    [{ hook: { maxRetries: 1.5 } }, '"hook.maxRetries" must be a whole number from 0 to 100'],
    [{ hook: { maxRetries: 101 } }, '"hook.maxRetries" must be a whole number from 0 to 100'],
    [{ hook: { timeoutSec: 0 } }, '"hook.timeoutSec" must be a positive number up to 2000000'],
    [{ hook: { timeoutSec: '60' } }, '"hook.timeoutSec" must be a positive number up to 2000000'],
  ])('rejects %j', (value, message) => {
    expect(() => validateConfig(value, '.trustbut.json')).toThrow(message);
  });
});

describe('hookSettings', () => {
  it('fills in the defaults', () => {
    expect(hookSettings({})).toEqual({ enabled: true, mode: 'quick', maxRetries: 3, timeoutSec: 540 });
    expect(hookSettings({ hook: { mode: 'full', maxRetries: 0 } })).toEqual({ enabled: true, mode: 'full', maxRetries: 0, timeoutSec: 540 });
    expect(hookSettings({ hook: { enabled: false, timeoutSec: 0.5 } })).toEqual({ enabled: false, mode: 'quick', maxRetries: 3, timeoutSec: 0.5 });
  });
});

describe('normalizeRoot', () => {
  it.each([
    [undefined, '.'],
    ['', '.'],
    ['.', '.'],
    ['./functions/', 'functions'],
    ['packages//app', 'packages/app'],
    ['a/../b', 'b'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeRoot(input)).toBe(expected);
  });

  it.each(['/abs', '..', '../x', 'a/../../x'])('rejects %j', (input) => {
    expect(() => normalizeRoot(input)).toThrow(/root must be a folder inside the repository/);
  });
});
