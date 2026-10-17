import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/program.js';
import { VERSION } from '../src/version.js';
import { makeRepo, writeFiles } from './helpers/repo.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const cli = (...args: string[]) => execa('node', ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: ROOT, reject: false });
const hookCli = (agent: string, input: string, env: Record<string, string> = {}) =>
  execa('node', ['--import', 'tsx', 'src/cli.ts', 'hook', agent], { cwd: ROOT, reject: false, input, env: { ...env, TRUSTBUT_SKIP: '' } });

describe('cli', () => {
  it('reports its version', () => {
    let out = '';
    const program = buildProgram()
      .exitOverride()
      .configureOutput({ writeOut: (s) => { out += s; } });
    expect(() => program.parse(['node', 'trustbut', '--version'])).toThrow();
    expect(out.trim()).toBe(PKG_VERSION);
    expect(VERSION).toBe(PKG_VERSION);
  });

  it('subcommands inherit exitOverride, so usage errors reach the caller', async () => {
    const program = buildProgram();
    program.commands.forEach((c) => c.configureOutput({ writeErr: () => {} }));
    await expect(program.parseAsync(['node', 'trustbut', 'verify', '--runner', 'nope'])).rejects.toMatchObject({
      code: 'commander.invalidArgument',
    });
  });
});

describe('cli process exit codes', () => {
  it('exits 2 on a usage error', async () => {
    const r = await cli('verify', '--runner', 'nope');
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/Unknown runner: nope/);
  }, 60_000);

  it('exits 2 on an invalid config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ar-cli-'));
    await writeFile(join(dir, 'bad.json'), JSON.stringify({ nope: 1 }));
    const r = await cli('verify', '--config', join(dir, 'bad.json'));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Unknown keys in');
    expect(r.stderr).toContain('Allowed keys: root, runner, command');
  }, 60_000);

  it('exits 2 on an unknown option', async () => {
    const r = await cli('verify', '--nope');
    expect(r.exitCode).toBe(2);
  }, 60_000);

  it('exits 0 and prints for --help and --version', async () => {
    const help = await cli('--help');
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('Usage: trustbut');
    const version = await cli('--version');
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toBe(PKG_VERSION);
    const sub = await cli('verify', '--help');
    expect(sub.exitCode).toBe(0);
    expect(sub.stdout).toContain('--strict');
    expect(sub.stdout).toContain('--config <path>');
    expect(sub.stdout).toContain('--root <dir>');
    expect(sub.stdout).toContain('--output-tail');
  }, 60_000);
});

describe('version injection', () => {
  it('tsup config defines __TRUSTBUT_VERSION__ as package.json version, and version.ts uses it', async () => {
    const config = (await import('../tsup.config.js')).default as { define?: Record<string, string> };
    expect(config.define?.__TRUSTBUT_VERSION__).toBe(JSON.stringify(PKG_VERSION));
    expect(readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8')).toContain('__TRUSTBUT_VERSION__');
  });
});

describe('cli: trustbut hook', () => {
  it('exits 1 (never 2, which agents read as "block") on an unknown agent', async () => {
    const r = await hookCli('cursor', '{}');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/'cursor' is invalid for argument 'agent'\. Allowed choices are claude, codex, gemini/);
  }, 60_000);

  it('allows the stop silently outside a git repository, reading the input from stdin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ar-hook-'));
    const r = await hookCli('codex', JSON.stringify({ session_id: 's', cwd: dir, hook_event_name: 'Stop', stop_hook_active: false }));
    expect(r).toMatchObject({ exitCode: 0, stdout: '', stderr: '' });
  }, 60_000);

  it('blocks a FAIL in the Claude Code protocol', async () => {
    const { dir } = await makeRepo({
      '.trustbut.json': JSON.stringify({ command: 'echo \'<testsuite name="s"><testcase name="works" file="test/a.test.js"><failure/></testcase></testsuite>\'; exit 1' }),
      'src/a.js': 'export const a = 1;\n',
    });
    await writeFiles(dir, { 'src/a.js': 'export const a = 2;\n', 'test/a.test.js': "it('works', () => {});\n" });
    const r = await hookCli('claude', JSON.stringify({ session_id: `cli-${Date.now()}`, cwd: dir, hook_event_name: 'Stop', stop_hook_active: false }));
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    const out = JSON.parse(r.stdout) as { decision: string; reason: string; systemMessage: string };
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('trustbut verdict: FAIL');
    expect(out.systemMessage).toMatch(/^trustbut FAIL: 1 failing test, 1 other warning — sent back to the agent \(attempt 1\/3\)$/);
  }, 60_000);

  it('documents the hook in --help', async () => {
    const r = await cli('hook', '--help');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Usage: trustbut hook [options] <agent>');
    expect(r.stdout).toContain('(enabled, mode, maxRetries, timeoutSec, base)');
  }, 60_000);
});

describe('cli: trustbut hook interrupted', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('on %s stops the tests, removes its worktrees and exits without blocking', async (signal) => {
    const { dir } = await makeRepo({ '.trustbut.json': JSON.stringify({ command: 'sleep 60' }), 'src/a.js': 'export const a = 1;\n' });
    await writeFiles(dir, { 'src/a.js': 'export const a = 2;\n', 'test/a.test.js': "it('a', () => {});\n" });
    const worktrees = async () => (await execa('git', ['worktree', 'list', '--porcelain'], { cwd: dir })).stdout.split('\n').filter((l) => l.startsWith('worktree ')).length;
    // node directly (not npx), so the signal reaches trustbut itself.
    const sub = execa('node', ['--import', 'tsx', 'src/cli.ts', 'hook', 'codex'], {
      cwd: ROOT,
      reject: false,
      input: JSON.stringify({ session_id: `int-${signal}-${Date.now()}`, cwd: dir }),
      env: { TRUSTBUT_SKIP: '' },
    });
    for (let i = 0; i < 400 && (await worktrees()) < 2; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await worktrees()).toBe(2);
    const sent = Date.now();
    sub.kill(signal);
    const r = await sub;
    expect(Date.now() - sent).toBeLessThan(5000);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ systemMessage: `trustbut couldn't verify: interrupted by ${signal}` });
    expect(await worktrees()).toBe(1);
  }, 60_000);
});
