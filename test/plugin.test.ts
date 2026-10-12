import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { compareVersions, nodeTooOld, resolveTrustbut } from '../integrations/claude-code/scripts/run.mjs';
import { hasTool, requiredTools } from './helpers/toolchain.js';

const ROOT = resolve(import.meta.dirname, '..');
const PLUGIN = join(ROOT, 'integrations', 'claude-code');
const RUN = join(PLUGIN, 'scripts', 'run.mjs');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

describe('claude plugin: manifests', () => {
  it('plugin.json matches package.json (name, version, metadata)', async () => {
    const pkg = await json(join(ROOT, 'package.json'));
    const plugin = await json(join(PLUGIN, '.claude-plugin', 'plugin.json'));
    expect(plugin.name).toBe('trustbut');
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.homepage).toBe(pkg.homepage);
    expect(plugin.description).toBeTruthy();
  });

  it('the marketplace lists the plugin at a relative source without ..', async () => {
    const m = await json(join(ROOT, '.claude-plugin', 'marketplace.json'));
    expect(m).toMatchObject({ name: 'trustbut', owner: { name: 'Almog Koren' } });
    expect(m.plugins).toHaveLength(1);
    expect(m.plugins[0]).toMatchObject({ name: 'trustbut', source: './integrations/claude-code' });
    expect(m.plugins[0].source).not.toContain('..');
  });

  it('hooks.json runs run.mjs from the plugin root on Stop, in exec form', async () => {
    const h = await json(join(PLUGIN, 'hooks', 'hooks.json'));
    expect(h).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs', 'claude'], timeout: 600 }] }] },
    });
  });
});

const claudeAvailable = hasTool('claude');
const mustHaveClaude = requiredTools().has('claude');
describe.skipIf(!claudeAvailable && !mustHaveClaude)('claude plugin: claude plugin validate', () => {
  it.each([
    ['the plugin directory', PLUGIN],
    ['the repo root (marketplace)', ROOT],
  ])('passes for %s', async (_name, dir) => {
    const r = await execa('claude', ['plugin', 'validate', dir], { reject: false });
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
  }, 60_000);
});

describe('run.mjs helpers', () => {
  it('compareVersions compares x.y.z numerically', () => {
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.9', '0.3.0')).toBeLessThan(0);
    expect(compareVersions('trustbut 1.0.0\n', '0.3.0')).toBeGreaterThan(0);
    expect(compareVersions('nope', '0.3.0')).toBeNaN();
  });

  it('nodeTooOld is true below Node 22', () => {
    expect([nodeTooOld('18.20.0'), nodeTooOld('20.1.0'), nodeTooOld('22.0.0'), nodeTooOld('24.1.0')]).toEqual([true, true, false, false]);
  });

  it('resolution order: TRUSTBUT_BIN, then PATH trustbut >= the plugin version, else npx pinned to it', () => {
    expect(resolveTrustbut({ TRUSTBUT_BIN: '/x/tb' }, '0.3.0', () => '9.9.9')).toEqual({ command: '/x/tb', args: [] });
    expect(resolveTrustbut({}, '0.3.0', () => '0.3.0')).toEqual({ command: 'trustbut', args: [] });
    expect(resolveTrustbut({}, '0.3.0', () => '1.0.0')).toEqual({ command: 'trustbut', args: [] });
    expect(resolveTrustbut({}, '0.3.0', () => '0.2.0')).toEqual({ command: 'npx', args: ['--yes', '--quiet', 'trustbut@0.3.0'] });
    expect(resolveTrustbut({}, '0.3.0', () => undefined)).toEqual({ command: 'npx', args: ['--yes', '--quiet', 'trustbut@0.3.0'] });
  });
});

async function fakeBin(dir: string, name: string, script: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
  return file;
}

const run = (env: Record<string, string>, input = '{"session_id":"s"}') =>
  execa(process.execPath, [RUN, 'claude'], { env, extendEnv: false, input, reject: false });

// Prints what it got so a test can see the arguments, stdin and exit code travel through unchanged.
const ECHO = (version: string, code = 0) =>
  `if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nprintf 'ARGS:%s\\n' "$*"; printf 'STDIN:'; cat; printf 'ERR\\n' >&2; exit ${code}`;

describe('run.mjs end to end (fake binaries)', () => {
  it('TRUSTBUT_BIN: stdin in, stdout, stderr and the exit code out, unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-plugin-'));
    const bin = await fakeBin(dir, 'tb', ECHO('0.0.1', 2));
    const r = await run({ TRUSTBUT_BIN: bin, PATH: '/usr/bin:/bin' });
    expect(r).toMatchObject({ exitCode: 2, stdout: 'ARGS:hook claude\nSTDIN:{"session_id":"s"}', stderr: 'ERR' });
  });

  it('uses trustbut from PATH when its version is at least the plugin version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-plugin-'));
    const pkg = await json(join(ROOT, 'package.json'));
    await fakeBin(dir, 'trustbut', ECHO(pkg.version));
    const r = await run({ PATH: `${dir}:/usr/bin:/bin` });
    expect(r.stdout).toContain('ARGS:hook claude');
    expect(r.exitCode).toBe(0);
  });

  it('falls back to npx pinned to the plugin version when PATH trustbut is older', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-plugin-'));
    const pkg = await json(join(ROOT, 'package.json'));
    await fakeBin(dir, 'trustbut', ECHO('0.0.1'));
    await fakeBin(dir, 'npx', ECHO('x'));
    const r = await run({ PATH: `${dir}:/usr/bin:/bin` });
    expect(r.stdout).toContain(`ARGS:--yes --quiet trustbut@${pkg.version} hook claude`);
  });

  it('says it could not verify (and exits 0) when neither trustbut nor npx can be found', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-plugin-'));
    const r = await run({ PATH: dir });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ systemMessage: "trustbut couldn't verify: npx not found. Install with: npm i -g trustbut" });
  });

  it('says it could not verify when TRUSTBUT_BIN does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-plugin-'));
    const r = await run({ TRUSTBUT_BIN: join(dir, 'missing'), PATH: '/usr/bin:/bin' });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/^trustbut couldn't verify: .*missing not found\. Install with: npm i -g trustbut$/);
  });
});
