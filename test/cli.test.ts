import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/program.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cli = (...args: string[]) => execa('npx', ['--no-install', 'tsx', 'src/cli.ts', ...args], { cwd: ROOT, reject: false });

describe('cli', () => {
  it('reports its version', () => {
    let out = '';
    const program = buildProgram()
      .exitOverride()
      .configureOutput({ writeOut: (s) => { out += s; } });
    expect(() => program.parse(['node', 'trustbut', '--version'])).toThrow();
    expect(out.trim()).toBe('0.0.1');
  });

  it('subcommands inherit exitOverride, so usage errors reach the caller', async () => {
    const program = buildProgram();
    program.commands.forEach((c) => c.configureOutput({ writeErr: () => {} }));
    await expect(program.parseAsync(['node', 'trustbut', 'verify', '--runner', 'jest'])).rejects.toMatchObject({
      code: 'commander.invalidArgument',
    });
  });
});

describe('cli process exit codes', () => {
  it('exits 2 on a usage error', async () => {
    const r = await cli('verify', '--runner', 'jest');
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/jest/);
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
    expect(version.stdout.trim()).toBe('0.0.1');
    const sub = await cli('verify', '--help');
    expect(sub.exitCode).toBe(0);
    expect(sub.stdout).toContain('--strict');
  }, 60_000);
});
