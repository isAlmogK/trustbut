import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pytest } from './pytest.js';
import type { Runner } from './types.js';
import { vitest } from './vitest.js';

export function getRunner(name: 'vitest' | 'pytest'): Runner {
  return name === 'vitest' ? vitest : pytest;
}

export async function detectRunner(cwd: string): Promise<Runner | null> {
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    } catch (err) {
      throw new Error(`Could not read package.json: ${(err as Error).message}`);
    }
    if (pkg?.dependencies?.vitest || pkg?.devDependencies?.vitest) return vitest;
  }
  const vitestConfigs = ['config', 'workspace'].flatMap((kind) =>
    ['ts', 'js', 'mjs', 'cjs', 'mts', 'cts'].map((ext) => `vitest.${kind}.${ext}`),
  );
  if (vitestConfigs.some((f) => existsSync(join(cwd, f)))) return vitest;
  if (['pytest.ini', 'conftest.py', 'tox.ini'].some((f) => existsSync(join(cwd, f)))) return pytest;
  const pyproject = join(cwd, 'pyproject.toml');
  if (existsSync(pyproject) && (await readFile(pyproject, 'utf8')).includes('[tool.pytest')) return pytest;
  return null;
}
