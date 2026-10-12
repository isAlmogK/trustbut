import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/program.js';
import { VERSION } from '../src/version.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const cli = (...args: string[]) => execa('npx', ['--no-install', 'tsx', 'src/cli.ts', ...args], { cwd: ROOT, reject: false });

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
  }, 60_000);
});

describe('version injection', () => {
  it('tsup config defines __TRUSTBUT_VERSION__ as package.json version, and version.ts uses it', async () => {
    const config = (await import('../tsup.config.js')).default as { define?: Record<string, string> };
    expect(config.define?.__TRUSTBUT_VERSION__).toBe(JSON.stringify(PKG_VERSION));
    expect(readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8')).toContain('__TRUSTBUT_VERSION__');
  });
});
