// Helpers for runner `detect()` functions.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

/** The parsed package.json in `root`, or undefined when there is none. Throws a clear error if it is malformed. */
export async function readPackageJson(root: string): Promise<PackageJson | undefined> {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return undefined;
  try {
    const pkg = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return pkg && typeof pkg === 'object' ? (pkg as PackageJson) : {};
  } catch (err) {
    throw new Error(`Could not read package.json: ${(err as Error).message}`);
  }
}

export const hasDep = (pkg: PackageJson | undefined, name: string): boolean =>
  !!(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]);

export const anyExists = (root: string, files: string[]): boolean => files.some((f) => existsSync(join(root, f)));

/** Whether `root/file` exists and contains `text`. */
export async function fileContains(root: string, file: string, text: string): Promise<boolean> {
  const path = join(root, file);
  return existsSync(path) && (await readFile(path, 'utf8')).includes(text);
}
