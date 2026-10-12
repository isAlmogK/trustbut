// Which base the hook compares the working tree against. `verify` only tries main/master (and
// errors without one); a hook must always have an answer, so it tries more and ends at HEAD.
import { execa } from 'execa';
import { DEFAULT_BASES, resolveRef } from '../git.js';

export type BaseSource = 'config' | 'origin-head' | 'default' | 'upstream' | 'head';

export interface HookBase {
  ref: string;
  source: BaseSource;
}

async function output(repo: string, args: string[]): Promise<string | undefined> {
  const r = await execa('git', args, { cwd: repo, reject: false });
  return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/**
 * In order: `hook.base` from the config; origin's default branch (`refs/remotes/origin/HEAD`);
 * origin/main, main, origin/master, master; the current branch's upstream; else `HEAD`, which
 * verifies only the uncommitted changes. The whole branch is compared, so committing never hides work.
 */
export async function resolveHookBase(repo: string, configured?: string): Promise<HookBase> {
  if (configured) return { ref: configured, source: 'config' };
  const originHead = await output(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead && (await resolveRef(repo, originHead))) return { ref: originHead, source: 'origin-head' };
  for (const ref of DEFAULT_BASES) {
    if (await resolveRef(repo, ref)) return { ref, source: 'default' };
  }
  const upstream = await output(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (upstream && (await resolveRef(repo, upstream))) return { ref: upstream, source: 'upstream' };
  return { ref: 'HEAD', source: 'head' };
}

/** The base `trustbut verify` picks by itself (first of main/master that exists), if any. */
export async function verifyDefaultBase(repo: string): Promise<string | undefined> {
  for (const ref of DEFAULT_BASES) {
    if (await resolveRef(repo, ref)) return ref;
  }
  return undefined;
}
