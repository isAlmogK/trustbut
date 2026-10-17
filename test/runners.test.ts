import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNNERS, detectRunner, getRunner } from '../src/runners/registry.js';
import { parseJUnit } from '../src/runners/junit.js';
import { mapCheckoutPaths, pytest } from '../src/runners/pytest.js';
import { vitest } from '../src/runners/vitest.js';
import { linkNodeModules, makeRepo } from './helpers/repo.js';
import { hasTool, requiredTools } from './helpers/toolchain.js';

const hasPytest = hasTool('python3', ['-m', 'pytest', '--version']) || requiredTools().has('pytest');

describe('parseJUnit', () => {
  it('parses vitest-style output', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3">
  <testsuite name="test/sum.test.ts" tests="3">
    <testcase classname="test/sum.test.ts" name="adds" time="0.001"></testcase>
    <testcase classname="test/sum.test.ts" name="math &gt; subtracts" time="0.001">
      <failure message="expected 1 to be 2" type="AssertionError">trace</failure>
    </testcase>
    <testcase classname="test/sum.test.ts" name="later" time="0"><skipped/></testcase>
  </testsuite>
</testsuites>`;
    expect(parseJUnit(xml)).toEqual([
      { id: 'test/sum.test.ts::adds', file: 'test/sum.test.ts', name: 'adds', outcome: 'pass' },
      { id: 'test/sum.test.ts::math > subtracts', file: 'test/sum.test.ts', name: 'math > subtracts', outcome: 'fail', message: 'expected 1 to be 2' },
      { id: 'test/sum.test.ts::later', file: 'test/sum.test.ts', name: 'later', outcome: 'skip' },
    ]);
  });

  it('parses pytest-style output', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" tests="2">
<testcase classname="tests.test_sum" name="test_adds" time="0.001" />
<testcase classname="tests.test_sum" name="test_err" time="0.001"><error message="boom">x</error></testcase>
</testsuite></testsuites>`;
    expect(parseJUnit(xml).map((c) => [c.id, c.outcome])).toEqual([
      ['tests.test_sum::test_adds', 'pass'],
      ['tests.test_sum::test_err', 'error'],
    ]);
  });
});

describe('detectRunner', () => {
  it('detects vitest, pytest, or nothing', async () => {
    const js = await mkdtemp(join(tmpdir(), 'ar-detect-'));
    await writeFile(join(js, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^3' } }));
    expect((await detectRunner(js))?.name).toBe('vitest');

    const py = await mkdtemp(join(tmpdir(), 'ar-detect-'));
    await writeFile(join(py, 'pyproject.toml'), '[tool.pytest.ini_options]\naddopts = "-q"\n');
    expect((await detectRunner(py))?.name).toBe('pytest');

    const none = await mkdtemp(join(tmpdir(), 'ar-detect-'));
    expect(await detectRunner(none)).toBeNull();
  });
});

describe('runner registry', () => {
  it('registers vitest, jest, mocha, node-test, pytest, go, cargo, dotnet, phpunit, maven, gradle, rspec, dart, flutter, swift and the generic command runner', () => {
    expect(RUNNERS.map((r) => r.name)).toEqual(['vitest', 'jest', 'mocha', 'node-test', 'pytest', 'go', 'cargo', 'dotnet', 'phpunit', 'maven', 'gradle', 'rspec', 'dart', 'flutter', 'swift', 'command']);
  });

  it('looks runners up by name and lists the supported ones for an unknown name', () => {
    expect(getRunner('pytest')).toBe(pytest);
    expect(() => getRunner('nope')).toThrow('Unknown runner: nope. Supported: vitest, jest, mocha, node-test, pytest, go, cargo, dotnet, phpunit, maven, gradle, rspec, dart, flutter, swift, command');
  });

  it('scores detection: 10 for a vitest dependency or config, 10 for pytest config, 0 otherwise', async () => {
    const js = await mkdtemp(join(tmpdir(), 'ar-detect-'));
    await writeFile(join(js, 'package.json'), JSON.stringify({ dependencies: { vitest: '^3' } }));
    expect(await vitest.detect(js)).toBe(10);
    expect(await pytest.detect(js)).toBe(0);

    for (const f of ['pytest.ini', 'conftest.py', 'tox.ini']) {
      const py = await mkdtemp(join(tmpdir(), 'ar-detect-'));
      await writeFile(join(py, f), '');
      expect(await pytest.detect(py)).toBe(10);
      expect(await vitest.detect(py)).toBe(0);
    }
    const noPytest = await mkdtemp(join(tmpdir(), 'ar-detect-'));
    await writeFile(join(noPytest, 'pyproject.toml'), '[tool.black]\n');
    expect(await pytest.detect(noPytest)).toBe(0);
    expect(await getRunner('command').detect(noPytest)).toBe(0);
  });

  it('prefers the first registered runner on a tie', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ar-detect-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^3' } }));
    await writeFile(join(dir, 'pytest.ini'), '[pytest]\n');
    expect((await detectRunner(dir))?.name).toBe('vitest');
  });
});

describe('detectRunner robustness', () => {
  it('detects vitest from a config file without a dependency', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ar-detect-'));
    await writeFile(join(dir, 'package.json'), '{}');
    await writeFile(join(dir, 'vitest.config.mts'), 'export default {};');
    expect((await detectRunner(dir))?.name).toBe('vitest');
  });

  it('gives a friendly error for a malformed package.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ar-detect-'));
    await writeFile(join(dir, 'package.json'), '{ nope');
    await expect(detectRunner(dir)).rejects.toThrow(/Could not read package\.json: /);
  });
});

describe('vitest runner', () => {
  it('runs selected files and reports per-test outcomes', async () => {
    const { dir } = await makeRepo({
      '.gitignore': 'node_modules\n',
      'package.json': JSON.stringify({ name: 'fx', private: true, type: 'module', devDependencies: { vitest: '*' } }),
      'test/a.test.js': "import { it, expect } from 'vitest';\nit('passes', () => expect(1).toBe(1));\nit('fails', () => expect(1).toBe(2));\n",
      'test/b.test.js': "import { it } from 'vitest';\nit('other', () => {});\n",
    });
    await linkNodeModules(dir);
    const result = await vitest.run({ cwd: dir, files: ['test/a.test.js'] });
    expect(result.exitCode).not.toBe(0);
    expect(result.cases.map((c) => [c.name, c.outcome])).toEqual([
      ['passes', 'pass'],
      ['fails', 'fail'],
    ]);
  });
});

describe('mapCheckoutPaths', () => {
  it('maps sys.path entries inside the checkout onto the worktree, keeping order, dropping missing ones', () => {
    const exists = (p: string) => p !== '/tmp/wt/packages/gone/src';
    expect(
      mapCheckoutPaths(
        ['', '/usr/lib/python3.12', '/repo/packages/lib/src', '/repo/packages/gone/src', '/tmp/wt/src', '/repo', '/repo2/x'],
        '/repo', '/tmp/wt', exists,
      ),
    ).toEqual(['/tmp/wt/packages/lib/src', '/tmp/wt']);
  });
  it('maps nothing when the worktree is the checkout', () => {
    expect(mapCheckoutPaths(['/repo/src'], '/repo', '/repo', () => true)).toEqual([]);
  });
});

describe.skipIf(!hasPytest)('pytest runner', () => {
  it('runs selected files and reports per-test outcomes', async () => {
    const { dir } = await makeRepo({
      'pytest.ini': '[pytest]\n',
      'tests/test_a.py': 'def test_ok():\n    assert 1 == 1\n\ndef test_bad():\n    assert 1 == 2\n',
    });
    const result = await pytest.run({ cwd: dir, files: ['tests/test_a.py'] });
    expect(result.cases.map((c) => [c.name, c.outcome])).toEqual([
      ['test_ok', 'pass'],
      ['test_bad', 'fail'],
    ]);
  });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 60 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
}

describe('pytest adapter without pytest installed', () => {
  const saved = process.env.TRUSTBUT_PYTHON;
  const savedPath = process.env.PYTHONPATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.TRUSTBUT_PYTHON;
    else process.env.TRUSTBUT_PYTHON = saved;
    if (savedPath === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = savedPath;
  });

  /** A fake python that records its arguments and PYTHONPATH, then exits 5 (no tests). */
  async function recordingPython(dir: string): Promise<string> {
    const fake = join(dir, 'fake-python');
    await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\nprintf '%s' "$PYTHONPATH" > "${dir}/pythonpath"\nexit 5\n`);
    await chmod(fake, 0o755);
    return fake;
  }

  it('pins --rootdir and puts the checkout (and src/) first on PYTHONPATH', async () => {
    const tools = await mkdtemp(join(tmpdir(), 'ar-py-'));
    const cwd = await mkdtemp(join(tmpdir(), 'ar-py-'));
    await mkdir(join(cwd, 'src'));
    process.env.TRUSTBUT_PYTHON = await recordingPython(tools);
    process.env.PYTHONPATH = '/user/site';
    await pytest.run({ cwd, files: ['tests/test_a.py'] });
    const args = (await readFile(join(tools, 'args'), 'utf8')).trim().split('\n');
    expect(args).toEqual(expect.arrayContaining(['--rootdir', cwd, 'tests/test_a.py']));
    expect(args[args.indexOf('--rootdir') + 1]).toBe(cwd);
    expect(await readFile(join(tools, 'pythonpath'), 'utf8')).toBe([join(cwd, 'src'), cwd, '/user/site'].join(delimiter));
  });

  /** A fake python that answers the sys.path probe with `sysPath` (NUL-separated) and records PYTHONPATH for the run, then exits 5. */
  async function probingPython(dir: string, sysPath: string[]): Promise<string> {
    const fake = join(dir, 'fake-python');
    await writeFile(fake, `#!/bin/sh\nif [ "$1" = "-c" ]; then printf '${sysPath.join('\\000')}\\n'; exit 0; fi\nprintf '%s' "$PYTHONPATH" > "${dir}/pythonpath"\nexit 5\n`);
    await chmod(fake, 0o755);
    return fake;
  }

  async function checkoutAndWorktree(...dirs: string[]) {
    const checkout = await mkdtemp(join(tmpdir(), 'ar-py-'));
    const worktree = await mkdtemp(join(tmpdir(), 'ar-py-'));
    for (const top of [checkout, worktree]) for (const d of dirs) await mkdir(join(top, d), { recursive: true });
    return { checkout, worktree };
  }

  it('puts sys.path entries that point into the checkout, mapped onto the worktree, after the worktree entries', async () => {
    const tools = await mkdtemp(join(tmpdir(), 'ar-py-'));
    const { checkout, worktree } = await checkoutAndWorktree('packages/lib/src');
    // The worktree's .venv is a symlink to the checkout's, so its site-packages already is the checkout's.
    await mkdir(join(checkout, '.venv/lib/site-packages'), { recursive: true });
    await symlink(join(checkout, '.venv'), join(worktree, '.venv'), 'dir');
    // An editable install of a workspace member in the checkout.
    process.env.TRUSTBUT_PYTHON = await probingPython(tools, ['/usr/lib/python3.12', join(checkout, '.venv/lib/site-packages'), join(checkout, 'packages/lib/src')]);
    process.env.PYTHONPATH = '/user/site';
    await pytest.run({ cwd: worktree, worktree, checkout, files: ['tests/test_a.py'] });
    const mapped = await realpath(join(worktree, 'packages/lib/src'));
    expect(await readFile(join(tools, 'pythonpath'), 'utf8')).toBe([worktree, mapped, '/user/site'].join(delimiter));
  });

  it("ignores the probe's relative sys.path entries, wherever trustbut was started", async () => {
    const tools = await mkdtemp(join(tmpdir(), 'ar-py-'));
    const { checkout, worktree } = await checkoutAndWorktree('packages/lib/src', 'sub');
    // `python -c` puts '' (its working directory) first on sys.path.
    process.env.TRUSTBUT_PYTHON = await probingPython(tools, ['', 'rel/dir', join(checkout, 'packages/lib/src')]);
    process.env.PYTHONPATH = '/user/site';
    const prevCwd = process.cwd();
    process.chdir(join(checkout, 'sub'));
    try {
      await pytest.run({ cwd: worktree, worktree, checkout, files: ['tests/test_a.py'] });
    } finally {
      process.chdir(prevCwd);
    }
    const mapped = await realpath(join(worktree, 'packages/lib/src'));
    expect(await readFile(join(tools, 'pythonpath'), 'utf8')).toBe([worktree, mapped, '/user/site'].join(delimiter));
  });

  it('does not repeat the worktree src/ for a src-layout editable install', async () => {
    const tools = await mkdtemp(join(tmpdir(), 'ar-py-'));
    const { checkout, worktree } = await checkoutAndWorktree('src');
    process.env.TRUSTBUT_PYTHON = await probingPython(tools, [join(checkout, 'src')]);
    process.env.PYTHONPATH = '/user/site';
    await pytest.run({ cwd: worktree, worktree, checkout, files: ['tests/test_a.py'] });
    expect(await readFile(join(tools, 'pythonpath'), 'utf8')).toBe([join(worktree, 'src'), worktree, '/user/site'].join(delimiter));
  });

  it('appends config args before the files and passes config env', async () => {
    const tools = await mkdtemp(join(tmpdir(), 'ar-py-'));
    const cwd = await mkdtemp(join(tmpdir(), 'ar-py-'));
    const fake = join(tools, 'fake-python');
    await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${tools}/args"\nprintf '%s' "$EXTRA" > "${tools}/extra"\nexit 5\n`);
    await chmod(fake, 0o755);
    process.env.TRUSTBUT_PYTHON = fake;
    await pytest.run({ cwd, files: ['tests/test_a.py'], args: ['-x', '--tb=short'], env: { EXTRA: 'yes' } });
    const args = (await readFile(join(tools, 'args'), 'utf8')).trim().split('\n');
    expect(args.slice(-3)).toEqual(['-x', '--tb=short', 'tests/test_a.py']);
    expect(await readFile(join(tools, 'extra'), 'utf8')).toBe('yes');
  });

  it('stops a run that exceeds the timeout, including processes it started', { retry: 2 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ar-py-'));
    const fake = join(dir, 'fake-python');
    // Not exec: sleep is a grandchild that holds the output pipe open.
    await writeFile(fake, `#!/bin/sh\n[ "$PREWARM" = 1 ] && exit 0\nsleep 31 &\necho $! > "${dir}/child.pid"\nsleep 30\ntrue\n`);
    await chmod(fake, 0o755);
    // Pre-warm: the first run of a fresh executable can be slow (scanners); do it before the timed run.
    spawnSync(fake, [], { env: { ...process.env, PREWARM: '1' }, stdio: 'ignore' });
    process.env.TRUSTBUT_PYTHON = fake;
    const start = Date.now();
    // Long enough for the fresh script to start (macOS checks new executables on first run).
    const result = await pytest.run({ cwd: dir, timeoutMs: 8000 });
    expect(Date.now() - start).toBeLessThan(20_000);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/timed out/i);
    expect(result.timedOut).toBe(true);
    expect(await gone(Number(await readFile(join(dir, 'child.pid'), 'utf8')))).toBe(true);
  });

  it('finds a workspace venv above the package root, up to the worktree top', async () => {
    const top = await mkdtemp(join(tmpdir(), 'ar-py-'));
    await mkdir(join(top, '.venv', 'bin'), { recursive: true });
    await mkdir(join(top, 'packages', 'api'), { recursive: true });
    const fake = join(top, '.venv', 'bin', 'python');
    await writeFile(fake, `#!/bin/sh\npwd > "${top}/ran-in"\nexit 5\n`);
    await chmod(fake, 0o755);
    process.env.TRUSTBUT_PYTHON = join(top, 'no-such-python');
    const result = await pytest.run({ cwd: join(top, 'packages', 'api'), worktree: top });
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(top, 'ran-in'), 'utf8')).toContain('packages/api');
  });

  it('does not look for a venv above the worktree top', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'ar-py-'));
    await mkdir(join(outer, '.venv', 'bin'), { recursive: true });
    await writeFile(join(outer, '.venv', 'bin', 'python'), '#!/bin/sh\nexit 5\n');
    await chmod(join(outer, '.venv', 'bin', 'python'), 0o755);
    await mkdir(join(outer, 'wt', 'pkg'), { recursive: true });
    process.env.TRUSTBUT_PYTHON = join(outer, 'no-such-python');
    await expect(pytest.run({ cwd: join(outer, 'wt', 'pkg'), worktree: join(outer, 'wt') })).rejects.toThrow(/Couldn't start .*no-such-python/);
  });

  it('uses just the checkout on PYTHONPATH without src/ or an inherited PYTHONPATH', async () => {
    const tools = await mkdtemp(join(tmpdir(), 'ar-py-'));
    const cwd = await mkdtemp(join(tmpdir(), 'ar-py-'));
    process.env.TRUSTBUT_PYTHON = await recordingPython(tools);
    delete process.env.PYTHONPATH;
    await pytest.run({ cwd });
    expect(await readFile(join(tools, 'pythonpath'), 'utf8')).toBe(cwd);
  });

  it('throws a start-up error when python cannot be started', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ar-py-'));
    process.env.TRUSTBUT_PYTHON = join(dir, 'no-such-python');
    await expect(pytest.run({ cwd: dir })).rejects.toThrow(/^Couldn't start .*no-such-python: /);
  });

  it('normalizes exit code 5 (no tests collected) to 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ar-py-'));
    const fake = join(dir, 'fake-python');
    await writeFile(fake, '#!/bin/sh\nexit 5\n');
    await chmod(fake, 0o755);
    process.env.TRUSTBUT_PYTHON = fake;
    const result = await pytest.run({ cwd: dir });
    expect(result.exitCode).toBe(0);
    expect(result.cases).toEqual([]);
  });
});
