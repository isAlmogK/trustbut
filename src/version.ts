import { readFileSync } from 'node:fs';

/** Replaced with a string literal by tsup `define` (see tsup.config.ts) in the published build. */
declare const __TRUSTBUT_VERSION__: string | undefined;

function readPackageVersion(): string {
  // Dev/test fallback (tsx, Vitest): src/version.ts sits one level below package.json.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

export const VERSION: string = typeof __TRUSTBUT_VERSION__ === 'string' ? __TRUSTBUT_VERSION__ : readPackageVersion();
