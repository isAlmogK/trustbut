import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runInGroup } from '../process.js';
import type { TestCaseResult } from '../types.js';
import { anyExists, fileContains } from './detect.js';
import { childEnv, runOutput } from './env.js';
import { parseJUnit } from './junit.js';
import type { ReadHead, Runner } from './types.js';

/** `vendor/bin/phpunit` from the package root up to the worktree top, else `phpunit` from PATH. */
function findPhpunit(cwd: string, worktree?: string): string {
  const top = resolve(worktree ?? cwd);
  let dir = resolve(cwd);
  for (;;) {
    const bin = join(dir, 'vendor', 'bin', 'phpunit');
    if (existsSync(bin)) return bin;
    if (dir === top || dirname(dir) === dir) return 'phpunit';
    dir = dirname(dir);
  }
}

/**
 * Parses PHPUnit's JUnit XML (`--log-junit`). The testcase `file` attribute is an absolute path; it is
 * made relative to `root` so ids are identical between the base and head checkouts.
 */
export function parsePhpunitJUnit(xml: string, root: string): TestCaseResult[] {
  const real = existsSync(root) ? realpathSync(root) : root;
  return parseJUnit(xml).map((c) => {
    let file = c.file;
    if (isAbsolute(file)) {
      const rel = relative(real, file);
      file = (rel.startsWith('..') ? relative(root, file) : rel).split(sep).join('/');
    }
    return { ...c, id: `${file}::${c.name}`, file };
  });
}

/** `Ns\Class` names of the classes declared in a PHP file. */
export function declaredPhpClasses(src: string): string[] {
  const out: string[] = [];
  let ns = '';
  for (const m of src.matchAll(/^\s*namespace\s+([\w\\]+)\s*[;{]|^\s*(?:(?:abstract|final|readonly)\s+)*class\s+(\w+)/gm)) {
    if (m[1] !== undefined) ns = m[1];
    else if (m[2] !== undefined) out.push(ns ? `${ns}\\${m[2]}` : m[2]);
  }
  return out;
}

/** The `phpunit` arguments (without the executable) for one run. */
export function phpunitArgs(junit: string, args: string[], file?: string): string[] {
  return ['--log-junit', junit, ...args, ...(file ? [file] : [])];
}

export const phpunit: Runner = {
  name: 'phpunit',
  async detect(root) {
    try {
      return anyExists(root, ['phpunit.xml', 'phpunit.xml.dist', 'phpunit.dist.xml']) || (await fileContains(root, 'composer.json', 'phpunit/phpunit')) ? 10 : 0;
    } catch {
      return 0;
    }
  },
  async run({ cwd, worktree, files, args = [], env: extraEnv, timeoutMs }) {
    const start = Date.now();
    const dir = await mkdtemp(join(tmpdir(), 'trustbut-phpunit-'));
    try {
      const env = childEnv(extraEnv);
      const output: string[] = [];
      // The worktree has no vendor/ (it is not tracked): install from composer.json/composer.lock.
      if (existsSync(join(cwd, 'composer.json')) && !existsSync(join(cwd, 'vendor', 'autoload.php'))) {
        const install = await runInGroup('composer', ['install', '--no-interaction', '--no-progress', '--prefer-dist', '--no-scripts'], { cwd, env, timeoutMs });
        output.push(runOutput(install));
      }
      const bin = findPhpunit(cwd, worktree);
      // PHPUnit takes one path argument: run each changed file on its own and merge the results.
      const targets: (string | undefined)[] = files ? files.filter((f) => existsSync(join(cwd, f))) : [undefined];
      const cases: TestCaseResult[] = [];
      const seen = new Set<string>();
      let exitCode = 0;
      for (const [i, target] of targets.entries()) {
        const out = join(dir, `junit-${i}.xml`);
        const res = await runInGroup(bin, phpunitArgs(out, args, target), { cwd, env, timeoutMs });
        output.push(runOutput(res));
        if (existsSync(out)) {
          for (const c of parsePhpunitJUnit(await readFile(out, 'utf8'), cwd)) {
            if (!seen.has(c.id)) {
              seen.add(c.id);
              cases.push(c);
            }
          }
        }
        if (exitCode === 0) exitCode = res.exitCode ?? 1;
      }
      // A fatal error or bootstrap failure writes no failing test: report one error case instead of "no tests".
      if (exitCode !== 0 && !cases.some((c) => c.outcome === 'fail' || c.outcome === 'error')) {
        cases.push({ id: '[phpunit]::[run]', file: '[phpunit]', name: '[run failed]', outcome: 'error' });
      }
      return { exitCode, cases, durationMs: Date.now() - start, output: output.filter(Boolean).join('\n').slice(-4000) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  casesInFile(c, file, readHead: ReadHead) {
    const f = file.split(sep).join('/');
    if (c.file === f || c.file.endsWith(`/${f}`) || f.endsWith(`/${c.file}`)) return true;
    if (/\.php$/.test(c.file)) return false;
    // No file attribute in the report: fall back to the class (`Tests.CalcTest` / `Tests\CalcTest`).
    const cls = c.file.replace(/[./]/g, '\\');
    return declaredPhpClasses(readHead(f)).includes(cls);
  },
};
