import { readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { git } from './git.js';
import { findModuleRoot, parseModulePath } from './runners/go.js';
import type { ChangedFile } from './types.js';

// A folder named for test support (`internal/test/`, `internal/testutil/`, `pkg/testing/`) anywhere above the file.
const SUPPORT_DIR = /(^|\/)(tests?|testutils?|testhelpers?|testing)\//;
const GO_SOURCE = /(?<!_test)\.go$/;

/**
 * Changed Go helpers to copy into the base checkout: non-test `.go` files in a test-support package that, at head,
 * no Go code outside test files and test-support folders imports, and whose own folder has no changed tests (then
 * the package is the code under test). Such a package only exists to support tests, so copying it plants none of
 * the change; anything else stays at base so new tests can't pass there on the new code.
 */
export async function goTestHelpers(changes: ChangedFile[], headDir: string): Promise<string[]> {
  const live = changes.filter((c) => c.status !== 'deleted');
  const testedDirs = new Set(live.filter((c) => c.path.endsWith('_test.go')).map((c) => posix.dirname(c.path)));
  const candidates = live.filter(
    (c) => c.kind === 'source' && GO_SOURCE.test(c.path) && SUPPORT_DIR.test(c.path) && !testedDirs.has(posix.dirname(c.path)),
  );
  if (!candidates.length) return [];
  const production = (await git(headDir, ['ls-files', '-z', '--', '*.go']))
    .split('\0')
    .filter((p) => GO_SOURCE.test(p) && !SUPPORT_DIR.test(p) && !/(^|\/)testdata\//.test(p))
    .map((p) => {
      try {
        return readFileSync(join(headDir, p), 'utf8');
      } catch {
        return '';
      }
    });
  return candidates
    .filter((c) => {
      const pkg = importPath(headDir, posix.dirname(c.path));
      return pkg !== undefined && !production.some((src) => src.includes(`"${pkg}"`) || src.includes(`\`${pkg}\``));
    })
    .map((c) => c.path);
}

/** The import path of package folder `dir` (relative to the worktree), from the nearest go.mod; undefined if none. */
function importPath(headDir: string, dir: string): string | undefined {
  const modRoot = findModuleRoot(join(headDir, dir), headDir);
  if (!modRoot) return undefined;
  let modulePath: string | undefined;
  try {
    modulePath = parseModulePath(readFileSync(join(modRoot, 'go.mod'), 'utf8'));
  } catch {
    return undefined;
  }
  if (!modulePath) return undefined;
  const sub = relative(modRoot, join(headDir, dir)).split(sep).join('/');
  return sub ? `${modulePath}/${sub}` : modulePath;
}
