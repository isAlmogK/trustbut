import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Finding } from './types.js';

// Not `command`: it may run anything (make, a shell script), so a package.json there says nothing about its needs.
const JS_RUNNERS = new Set(['vitest', 'jest', 'node-test', 'mocha']);
const LOCAL_SPEC = /^(workspace|link|file|portal):/;
const SHOWN = 5;

/** Yarn Plug'n'Play has no node_modules; `.yarnrc.yml` with `nodeLinker: pnp`. */
function usesPnp(file: string): boolean {
  try {
    return /^\s*nodeLinker:\s*["']?pnp["']?\s*$/m.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Warns when package.json (in the user's checkout, at the package root) declares dependencies that
 * are not installed in node_modules (this root or any parent up to the repo top). Direct
 * dependencies only. Returns undefined when nothing is wrong or this is not a package.json project.
 */
export function checkDepsInstalled(repo: string, root: string, runnerName: string): Finding | undefined {
  if (!JS_RUNNERS.has(runnerName)) return undefined;
  const top = resolve(repo);
  const pkgDir = resolve(top, root);
  let pkg: { dependencies?: unknown; devDependencies?: unknown };
  try {
    pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const declared = Object.entries({ ...obj(pkg.devDependencies), ...obj(pkg.dependencies) })
    .filter(([, spec]) => typeof spec !== 'string' || !LOCAL_SPEC.test(spec))
    .map(([name]) => name);
  if (!declared.length) return undefined;

  const dirs: string[] = [];
  for (let d = pkgDir; ; d = dirname(d)) {
    if (existsSync(join(d, '.pnp.cjs')) || existsSync(join(d, '.pnp.js')) || usesPnp(join(d, '.yarnrc.yml'))) return undefined;
    dirs.push(join(d, 'node_modules'));
    if (d === top || dirname(d) === d) break;
  }
  const hint = "results use your installed dependencies; run your package manager's install";
  if (!dirs.some((d) => existsSync(d))) {
    return { id: 'deps-not-installed', severity: 'warn', title: `Declared dependencies aren't installed: node_modules is missing; ${hint}` };
  }
  const missing = declared.filter((name) => !dirs.some((d) => existsSync(join(d, name, 'package.json'))));
  if (!missing.length) return undefined;
  const more = missing.length > SHOWN ? ` and ${missing.length - SHOWN} more` : '';
  return {
    id: 'deps-not-installed',
    severity: 'warn',
    title: `Declared dependencies aren't installed: ${missing.slice(0, SHOWN).join(', ')}${more}; ${hint}`,
  };
}
