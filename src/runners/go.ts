import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { runInGroup } from '../process.js';
import type { TestCaseResult } from '../types.js';
import { addCase } from './cases.js';
import { childEnv, runOutput } from './env.js';
import type { ReadHead, Runner } from './types.js';

/** The module path declared by the `module` line of a go.mod, or undefined. */
export function parseModulePath(gomod: string): string | undefined {
  const m = /^\s*module\s+("[^"]+"|`[^`]+`|\S+)/m.exec(gomod);
  return m?.[1]?.replace(/^["`]|["`]$/g, '');
}

/** The directory holding go.mod, walking up from `cwd` to the worktree top; undefined if none. */
function findModuleRoot(cwd: string, worktree?: string): string | undefined {
  const top = resolve(worktree ?? cwd);
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, 'go.mod'))) return dir;
    if (dir === top || dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}

interface GoEvent {
  Action?: string;
  Package?: string;
  Test?: string;
  Output?: string;
}

/** Package import path -> directory relative to the module root ('.' for the root package). */
export function packageDir(pkg: string, modulePath: string | undefined): string {
  if (modulePath && pkg === modulePath) return '.';
  if (modulePath && pkg.startsWith(`${modulePath}/`)) return pkg.slice(modulePath.length + 1);
  return pkg;
}

/**
 * Parses `go test -json` (test2json) output. `dirOf` maps a package import path to the directory
 * the case's `file` should carry. A package that fails without any failed test (build or setup
 * failure, panic in TestMain) becomes one `error` case.
 */
export function parseGoJson(output: string, dirOf: (pkg: string) => string = (p) => p): TestCaseResult[] {
  const cases: TestCaseResult[] = [];
  const index = new Map<string, number>();
  const pkgs = new Map<string, { failedTest: boolean; failed: boolean; output: string }>();
  const pkgState = (name: string) => {
    let s = pkgs.get(name);
    if (!s) pkgs.set(name, (s = { failedTest: false, failed: false, output: '' }));
    return s;
  };
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev: GoEvent;
    try {
      ev = JSON.parse(line) as GoEvent;
    } catch {
      continue;
    }
    const pkg = ev.Package;
    if (!pkg) continue;
    const state = pkgState(pkg);
    if (!ev.Test) {
      if (ev.Action === 'output') state.output += ev.Output ?? '';
      else if (ev.Action === 'fail') state.failed = true;
      continue;
    }
    const outcome = ev.Action === 'pass' ? 'pass' : ev.Action === 'fail' ? 'fail' : ev.Action === 'skip' ? 'skip' : undefined;
    if (!outcome) continue;
    if (outcome === 'fail') state.failedTest = true;
    addCase(cases, index, { id: `${pkg}::${ev.Test}`, file: dirOf(pkg), name: ev.Test, outcome, leaf: ev.Test.split('/')[0]! });
  }
  for (const [pkg, s] of pkgs) {
    if (s.failed && !s.failedTest) {
      cases.push({ id: `${pkg}::[package]`, file: dirOf(pkg), name: /\[(build|setup) failed\]/.test(s.output) ? '[build failed]' : '[package failed]', outcome: 'error' });
    }
  }
  return cases;
}

/** Top-level test, benchmark, fuzz and example functions declared in a Go file (methods excluded). */
export function declaredTests(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/^func\s+((?:Test|Benchmark|Fuzz|Example)\w*)\s*\(/gm)) names.add(m[1]!);
  return names;
}

/** The `go test` command line (without the executable) for a run. */
export function goTestArgs(args: string[], pkgs: string[]): string[] {
  return ['test', '-json', '-count=1', ...args, ...pkgs];
}

export const go: Runner = {
  name: 'go',
  async detect(root) {
    try {
      return existsSync(join(root, 'go.mod')) ? 10 : 0;
    } catch {
      return 0;
    }
  },
  async run({ cwd, worktree, files, args = [], env, timeoutMs }) {
    const start = Date.now();
    const modRoot = findModuleRoot(cwd, worktree) ?? cwd;
    let modulePath: string | undefined;
    try {
      modulePath = parseModulePath(readFileSync(join(modRoot, 'go.mod'), 'utf8'));
    } catch {
      // no readable go.mod: package paths are used as-is
    }
    const modPrefix = relative(cwd, modRoot).split(sep).join('/'); // '' when cwd is the module root
    const dirOf = (pkg: string): string => {
      const d = packageDir(pkg, modulePath);
      return modPrefix ? posix.normalize(posix.join(modPrefix, d)) : d;
    };

    let pkgs = ['./...'];
    if (files) {
      // A changed test file's package dir may not exist at base (new package): nothing to run there.
      const dirs = [...new Set(files.map((f) => posix.dirname(f.split(sep).join('/'))))].filter((d) => existsSync(join(cwd, d)));
      if (dirs.length === 0) return { exitCode: 0, cases: [], durationMs: Date.now() - start, output: '' };
      pkgs = dirs.map((d) => (d === '.' ? '.' : `./${d}`));
    }
    const res = await runInGroup('go', goTestArgs(args, pkgs), { cwd, env: childEnv(env), timeoutMs });
    return {
      exitCode: res.exitCode ?? 1,
      cases: parseGoJson(res.stdout, dirOf),
      durationMs: Date.now() - start,
      output: runOutput(res),
    };
  },
  casesInFile(c, file, readHead: ReadHead) {
    const dir = posix.dirname(file);
    if (c.file !== dir) return false;
    const top = c.name.split('/')[0]!;
    return declaredTests(readHead(file)).has(top);
  },
};
