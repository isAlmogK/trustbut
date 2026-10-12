import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { budgetSec, compareVersions, nodeTooOld, resolveTrustbut } from '../integrations/claude-code/scripts/run.mjs';
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
    expect(compareVersions('10.3.0.1x', '0.3.0')).toBeNaN();
  });

  it('compareVersions orders prereleases below their release', () => {
    expect(compareVersions('0.3.0-beta.1', '0.3.0')).toBeLessThan(0);
    expect(compareVersions('0.3.0', '0.3.0-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('0.3.0-beta.2', '0.3.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('0.3.0-alpha', '0.3.0-beta')).toBeLessThan(0);
    expect(compareVersions('0.3.0-beta', '0.3.0-beta.1')).toBeLessThan(0);
    expect(compareVersions('0.3.0+build5', '0.3.0')).toBe(0);
    expect(compareVersions('0.3.1-rc.1', '0.3.0')).toBeGreaterThan(0);
  });

  it('budgetSec leaves the rest of the 600 s hook timeout, at least 30 s', () => {
    expect(budgetSec(0)).toBe(570);
    expect(budgetSec(20_000)).toBe(550);
    expect(budgetSec(999_000)).toBe(30);
    expect(budgetSec(0, { TRUSTBUT_HOOK_BUDGET_SEC: '100' })).toBe(100);
    expect(budgetSec(0, { TRUSTBUT_HOOK_BUDGET_SEC: 'nope' })).toBe(570);
  });

  it('nodeTooOld is true below Node 22', () => {
    expect([nodeTooOld('18.20.0'), nodeTooOld('20.1.0'), nodeTooOld('22.0.0'), nodeTooOld('24.1.0')]).toEqual([true, true, false, false]);
  });

  it('resolution order: TRUSTBUT_BIN, then PATH trustbut >= the plugin version, else npx pinned to it', () => {
    expect(resolveTrustbut({ TRUSTBUT_BIN: '/x/tb' }, '0.3.0', () => '9.9.9')).toEqual({ command: '/x/tb', args: [] });
    expect(resolveTrustbut({}, '0.3.0', () => '0.3.0')).toEqual({ command: 'trustbut', args: [] });
    expect(resolveTrustbut({}, '0.3.0', () => '1.0.0')).toEqual({ command: 'trustbut', args: [] });
    const npx = { command: 'npx', args: ['--yes', '--quiet', '--prefer-offline', 'trustbut@0.3.0'], env: { npm_config_update_notifier: 'false', npm_config_loglevel: 'error' } };
    expect(resolveTrustbut({}, '0.3.0', () => '0.2.0')).toEqual(npx);
    expect(resolveTrustbut({}, '0.3.0', () => undefined)).toEqual(npx);
  });
});

async function fakeBin(dir: string, name: string, script: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
  return file;
}

// Each run gets its own version-cache dir (a shared one is overwritten by concurrent tests) and a generous probe timeout.
const run = async (env: Record<string, string>, input = '{"session_id":"s"}', agent = 'claude') =>
  execa(process.execPath, [RUN, agent], {
    env: { CLAUDE_PLUGIN_DATA: await mkdtemp(join(tmpdir(), 'tb-data-')), TRUSTBUT_VERSION_PROBE_MS: '60000', ...env },
    extendEnv: false,
    input,
    reject: false,
  });

// Prints what it got so a test can see the arguments, stdin and exit code travel through unchanged.
const ECHO = (version: string, code = 0) =>
  `if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nin=$(cat | tr -d '"')\nprintf '{"systemMessage":"ARGS:%s STDIN:%s"}\\n' "$*" "$in"; printf 'ERR\\n' >&2; exit ${code}`;

describe('run.mjs end to end (fake binaries)', () => {
  it('TRUSTBUT_BIN: stdin in, stdout, stderr and the exit code out, unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-plugin-'));
    const bin = await fakeBin(dir, 'tb', ECHO('0.0.1', 3));
    const r = await run({ TRUSTBUT_BIN: bin, PATH: '/usr/bin:/bin' });
    expect(r).toMatchObject({ exitCode: 3, stdout: '{"systemMessage":"ARGS:hook claude STDIN:{session_id:s}"}', stderr: 'ERR' });
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
    expect(r.stdout).toContain(`ARGS:--yes --quiet --prefer-offline trustbut@${pkg.version} hook claude`);
  });

  it('runs npx without update notices or npm log noise', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-plugin-'));
    await fakeBin(dir, 'npx', 'printf \'{"systemMessage":"%s %s"}\\n\' "$npm_config_update_notifier" "$npm_config_loglevel"');
    const r = await run({ PATH: `${dir}:/usr/bin:/bin` });
    expect(JSON.parse(r.stdout).systemMessage).toBe('false error');
  });

  it('does not set npm variables for a trustbut binary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-plugin-'));
    const bin = await fakeBin(dir, 'tb', 'printf \'{"systemMessage":"[%s]"}\\n\' "$npm_config_loglevel"');
    const r = await run({ TRUSTBUT_BIN: bin, PATH: '/usr/bin:/bin' });
    expect(JSON.parse(r.stdout).systemMessage).toBe('[]');
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

describe('run.mjs hardening (fake binaries)', () => {
  const BLOCK = JSON.stringify({ decision: 'block', reason: 'fix it', systemMessage: 'FAIL' });
  const withNpx = async (script: string) => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-plugin-'));
    await fakeBin(dir, 'npx', script);
    return { dir, env: { PATH: `${dir}:/usr/bin:/bin`, CLAUDE_PLUGIN_DATA: dir } };
  };

  it('a block survives wrapper noise before the JSON line (noise goes to stderr)', async () => {
    const { env } = await withNpx(`echo 'npm notice new version available'\necho '${BLOCK}'`);
    const r = await run(env);
    expect(r.stdout).toBe(BLOCK);
    expect(r.stderr).toContain('npm notice');
    expect(r.exitCode).toBe(0);
  });

  it('exactly one JSON object passes through unchanged; empty stdout stays empty', async () => {
    const one = await withNpx(`echo '${BLOCK}'`);
    expect((await run(one.env)).stdout).toBe(BLOCK);
    const none = await withNpx('exit 0');
    expect(await run(none.env)).toMatchObject({ stdout: '', exitCode: 0 });
  });

  it('stdout without any JSON object becomes a couldn\'t-verify message', async () => {
    const { env } = await withNpx(`echo 'npm notice garbage'`);
    const r = await run(env);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/^trustbut couldn't verify: unexpected output from trustbut\./);
  });

  it('a failing npx (exit 1, no stdout) says so with the stderr tail and does not block', async () => {
    const { env } = await withNpx(`echo 'npm error 404 Not Found - trustbut' >&2\nexit 1`);
    const r = await run(env);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/^trustbut couldn't verify: npx exited with code 1 \(npm error 404 Not Found - trustbut\)\. Install with/);
  });

  it.each(['codex', 'gemini'])('%s: a trustbut FAIL (exit 2, feedback on stderr) is passed through, not rewritten', async (agent) => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-plugin-'));
    const bin = await fakeBin(dir, 'tb', "printf 'trustbut verdict: FAIL\\n\\nfix it\\n' >&2\nexit 2");
    const r = await run({ TRUSTBUT_BIN: bin, PATH: '/usr/bin:/bin' }, undefined, agent);
    expect(r).toMatchObject({ exitCode: 2, stdout: '', stderr: 'trustbut verdict: FAIL\n\nfix it' });
  });

  // e.g. an old trustbut without `hook`, or a wrapper's usage error: exit 2 means "block" to the agent.
  const UNKNOWN = "echo \"error: unknown command 'hook'\" >&2\nexit 2";

  it.each(['codex', 'gemini'])("%s: exit 2 that isn't a trustbut FAIL becomes a couldn't-verify message and exit 0", async (agent) => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-plugin-'));
    const bin = await fakeBin(dir, 'tb', UNKNOWN);
    const r = await run({ TRUSTBUT_BIN: bin, PATH: '/usr/bin:/bin' }, undefined, agent);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/trustbut couldn't verify: .*tb exited with code 2 \(error: unknown command 'hook'\)\. Install with/);
  });

  it("claude: exit 2 without a block JSON becomes a couldn't-verify message and exit 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-plugin-'));
    const bin = await fakeBin(dir, 'tb', UNKNOWN);
    const r = await run({ TRUSTBUT_BIN: bin, PATH: '/usr/bin:/bin' });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/^trustbut couldn't verify: .*tb exited with code 2 \(error: unknown command 'hook'\)\. Install with/);
    const json = await fakeBin(dir, 'tb2', `echo '{"systemMessage":"not a block"}'\nexit 2`);
    const r2 = await run({ TRUSTBUT_BIN: json, PATH: '/usr/bin:/bin' });
    expect(r2.exitCode).toBe(0);
    expect(JSON.parse(r2.stdout).systemMessage).toMatch(/^trustbut couldn't verify: .*tb2 exited with code 2\. Install with/);
  });

  it('claude: exit 2 with a block JSON is passed through', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-plugin-'));
    const bin = await fakeBin(dir, 'tb', `echo '${BLOCK}'\nexit 2`);
    const r = await run({ TRUSTBUT_BIN: bin, PATH: '/usr/bin:/bin' });
    expect(r).toMatchObject({ exitCode: 2, stdout: BLOCK });
  });

  it('passes the remaining time budget to trustbut as TRUSTBUT_HOOK_TIMEOUT_SEC', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-plugin-'));
    const bin = await fakeBin(dir, 'tb', 'echo "{\\"systemMessage\\":\\"$TRUSTBUT_HOOK_TIMEOUT_SEC\\"}"');
    const r = await run({ TRUSTBUT_BIN: bin, PATH: '/usr/bin:/bin' });
    const n = Number(JSON.parse(r.stdout).systemMessage);
    expect(n).toBeGreaterThan(540);
    expect(n).toBeLessThanOrEqual(570);
  });

  it('probes PATH trustbut --version once per binary (cached in CLAUDE_PLUGIN_DATA)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-plugin-'));
    const data = await mkdtemp(join(tmpdir(), 'tb-plugin-data-'));
    const pkg = await json(join(ROOT, 'package.json'));
    const log = join(dir, 'probes');
    await fakeBin(dir, 'trustbut', `if [ "$1" = "--version" ]; then echo probe >> ${log}; echo ${pkg.version}; exit 0; fi\nexit 0`);
    const env = { PATH: `${dir}:/usr/bin:/bin`, CLAUDE_PLUGIN_DATA: data };
    await run(env);
    await run(env);
    await run(env);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(1);
  });
});
