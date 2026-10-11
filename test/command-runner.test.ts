import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { command, shellQuote } from '../src/runners/command.js';

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites><testsuite name="suite">
<testcase classname="t" name="ok" file="t/a_test.sh"/>
<testcase classname="t" name="bad" file="t/a_test.sh"><failure message="no"/></testcase>
</testsuite></testsuites>`;

async function dirWithScript(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ar-cmd-'));
  await writeFile(join(dir, 'run.sh'), `#!/bin/sh\n${body}\n`);
  await chmod(join(dir, 'run.sh'), 0o755);
  return dir;
}

describe('shellQuote', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('command runner', () => {
  it('never detects itself', async () => {
    expect(await command.detect(await mkdtemp(join(tmpdir(), 'ar-cmd-')))).toBe(0);
  });

  it('requires a command', async () => {
    await expect(command.run({ cwd: tmpdir() })).rejects.toThrow(/"command"/);
  });

  it('reads JUnit XML from the configured junit path, relative to the root', async () => {
    const dir = await dirWithScript(`mkdir -p out\ncat > out/junit.xml <<'X'\n${JUNIT}\nX\nexit 1`);
    const result = await command.run({ cwd: dir, command: './run.sh', junit: 'out/junit.xml' });
    expect(result.exitCode).toBe(1);
    expect(result.cases.map((c) => [c.file, c.name, c.outcome])).toEqual([
      ['t/a_test.sh', 'ok', 'pass'],
      ['t/a_test.sh', 'bad', 'fail'],
    ]);
  });

  it('ignores a stale junit file left from before the run', async () => {
    const dir = await dirWithScript('exit 0');
    await writeFile(join(dir, 'junit.xml'), JUNIT);
    const result = await command.run({ cwd: dir, command: './run.sh', junit: 'junit.xml' });
    expect(result.cases).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it('parses JUnit XML printed on stdout when no junit path is set', async () => {
    const dir = await dirWithScript(`cat <<'X'\n${JUNIT}\nX`);
    const result = await command.run({ cwd: dir, command: './run.sh' });
    expect(result.exitCode).toBe(0);
    expect(result.cases.map((c) => c.outcome)).toEqual(['pass', 'fail']);
  });

  it('reports no cases when stdout is not JUnit', async () => {
    const dir = await dirWithScript('echo hello');
    const result = await command.run({ cwd: dir, command: './run.sh' });
    expect(result.cases).toEqual([]);
    expect(result.output).toContain('hello');
  });

  it('kills the whole process tree on timeout, not just the shell', async () => {
    const dir = await dirWithScript('exit 0');
    const start = Date.now();
    const result = await command.run({ cwd: dir, command: 'sleep 31 & echo $! > child.pid; sleep 30; true', timeoutMs: 500 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(4_000);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/timed out after 500 ms/);
    const child = Number(await readFile(join(dir, 'child.pid'), 'utf8'));
    let dead = false;
    for (let i = 0; i < 60 && !dead; i += 1) {
      try {
        process.kill(child, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        dead = true;
      }
    }
    expect(dead).toBe(true);
  });

  it('cleans up processes left behind by a command that finished', async () => {
    const dir = await dirWithScript('exit 0');
    const start = Date.now();
    await command.run({ cwd: dir, command: '(sleep 30 > /dev/null 2>&1 &) ; echo $$ > sh.pid', timeoutMs: 20_000 });
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('replaces {files} with quoted files (or nothing), appends args, and passes env', async () => {
    const dir = await dirWithScript(`printf '%s\\n' "$@" > args.txt\nprintf '%s' "$GREETING" > env.txt`);
    await command.run({
      cwd: dir,
      command: './run.sh {files}',
      files: ['t/a b.sh', "t/it's.sh"],
      args: ['--flag', 'x y'],
      env: { GREETING: 'hi' },
    });
    expect((await readFile(join(dir, 'args.txt'), 'utf8')).trim().split('\n')).toEqual(['t/a b.sh', "t/it's.sh", '--flag', 'x y']);
    expect(await readFile(join(dir, 'env.txt'), 'utf8')).toBe('hi');

    await command.run({ cwd: dir, command: './run.sh {files}' });
    expect(await readFile(join(dir, 'args.txt'), 'utf8')).toBe('\n');
  });
});
