import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { execa } from 'execa';
import { runInGroup } from '../process.js';
import { anyExists, fileContains } from './detect.js';
import { childEnv, runOutput, timedOutFlag } from './env.js';
import { parseJUnit } from './junit.js';
import type { Runner } from './types.js';

/** Folders from `cwd` up to `top` (inclusive); just `cwd` when `top` is unset or not above it. */
function upTo(cwd: string, top: string | undefined): string[] {
  if (top === undefined) return [cwd];
  const rel = relative(top, cwd);
  if (rel.startsWith('..') || isAbsolute(rel)) return [cwd];
  const dirs = [cwd];
  for (let dir = cwd; dir !== top && dirname(dir) !== dir; ) dirs.push((dir = dirname(dir)));
  return dirs;
}

// The nearest .venv/venv from the package root up to the worktree top (uv workspaces keep one at the top).
function pythonFor(cwd: string, top: string | undefined): string {
  for (const dir of upTo(cwd, top)) {
    for (const venv of ['.venv', 'venv']) {
      const bin = join(dir, venv, 'bin', 'python');
      if (existsSync(bin)) return bin;
    }
  }
  return process.env.TRUSTBUT_PYTHON ?? 'python3';
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// The checkout's own code must win over an editable install of the user's checkout in a
// symlinked .venv, so put the worktree (and its src/ layout dir) first on PYTHONPATH, then
// `extra` (checkout paths mapped onto the worktree, minus those already first), then the inherited entries.
function pythonPath(cwd: string, inherited: string | undefined, extra: string[] = []): string {
  const lead = [existsSync(join(cwd, 'src')) ? join(cwd, 'src') : '', cwd].filter(Boolean);
  const leadReal = lead.map(real);
  return [...lead, ...extra.filter((p) => !leadReal.includes(real(p))), inherited ?? ''].filter(Boolean).join(delimiter);
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

/** sys.path entries inside `checkout` (not inside `worktree`) mapped to the same place in `worktree`, if they exist there. */
export function mapCheckoutPaths(sysPath: string[], checkout: string, worktree: string, exists: (p: string) => boolean = existsSync): string[] {
  if (worktree === checkout) return [];
  const out: string[] = [];
  for (const p of sysPath) {
    if (!p || !isAbsolute(p) || inside(p, worktree) || !inside(p, checkout)) continue;
    const mapped = join(worktree, relative(checkout, p));
    if (exists(mapped) && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/** The interpreter's sys.path (with this env), or [] when it can't be read. */
async function sysPathOf(python: string, cwd: string, env: Record<string, string>): Promise<string[]> {
  try {
    // Only the built-in `sys`: with the worktree first on PYTHONPATH, a repo's own `json.py` would shadow `json`.
    const { stdout } = await execa(python, ['-c', "import sys; print('\\0'.join(sys.path))"], { cwd, env, extendEnv: false, timeout: 30_000, stdin: 'ignore' });
    return (stdout.split('\n').pop() ?? '').split('\0');
  } catch {
    return [];
  }
}

// An editable install of a workspace member (a .pth line such as `<checkout>/packages/lib/src`) points into
// the checkout trustbut was started in, so a base run would import head code; map such entries onto the worktree.
async function checkoutPathsFor(python: string, cwd: string, env: Record<string, string>, worktree?: string, checkout?: string): Promise<string[]> {
  if (!worktree || !checkout) return [];
  const top = real(checkout);
  // Only absolute entries: '' (and any relative one) is the probe's working directory, and realpathing it here
  // would resolve it against trustbut's own working directory, often inside the checkout.
  const entries = (await sysPathOf(python, cwd, env)).filter((p) => p && isAbsolute(p)).map(real);
  // A mapped path that resolves back into the checkout (the symlinked .venv's site-packages) changes nothing,
  // and on PYTHONPATH it would sit ahead of the standard library.
  return mapCheckoutPaths(entries, top, real(worktree)).filter((p) => !inside(real(p), top));
}

export const pytest: Runner = {
  name: 'pytest',
  async detect(root) {
    return anyExists(root, ['pytest.ini', 'conftest.py', 'tox.ini']) || (await fileContains(root, 'pyproject.toml', '[tool.pytest')) ? 10 : 0;
  },
  async run({ cwd, worktree, checkout, files, args = [], env: extraEnv, timeoutMs }) {
    const dir = await mkdtemp(join(tmpdir(), 'trustbut-junit-'));
    const out = join(dir, 'junit.xml');
    const start = Date.now();
    try {
      const env = childEnv(extraEnv);
      const inherited = env.PYTHONPATH;
      const python = pythonFor(cwd, worktree);
      env.PYTHONPATH = pythonPath(cwd, inherited);
      const mapped = await checkoutPathsFor(python, cwd, env, worktree, checkout);
      if (mapped.length) env.PYTHONPATH = pythonPath(cwd, inherited, mapped);
      // --rootdir keeps test ids identical between the head and base checkouts.
      const res = await runInGroup(
        python,
        ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--rootdir', cwd, `--junitxml=${out}`, ...args, ...(files ?? [])],
        { cwd, env, timeoutMs },
      );
      const xml = existsSync(out) ? await readFile(out, 'utf8') : '';
      // pytest exits 5 when no tests are collected; treat as success (vitest uses --passWithNoTests).
      const exitCode = res.exitCode === 5 ? 0 : (res.exitCode ?? 1);
      return { exitCode, cases: xml ? parseJUnit(xml) : [], durationMs: Date.now() - start, output: runOutput(res), ...timedOutFlag(res) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
