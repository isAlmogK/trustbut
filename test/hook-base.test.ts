import { realpath } from 'node:fs/promises';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { resolveHookBase } from '../src/hook/base.js';
import { branch, commitAll, makeRepo, writeFiles } from './helpers/repo.js';

const git = (dir: string, ...args: string[]) => execa('git', args, { cwd: dir });

async function repoOn(name: string) {
  const { dir, base } = await makeRepo({ 'a.txt': 'a\n' });
  if (name !== 'main') await git(dir, 'branch', '-m', 'main', name);
  return { dir: await realpath(dir), base };
}

describe('resolveHookBase', () => {
  it('1. uses hook.base from the config first', async () => {
    const { dir } = await repoOn('main');
    await git(dir, 'branch', 'release');
    expect(await resolveHookBase(dir, 'release')).toEqual({ ref: 'release', source: 'config' });
  });

  it('1b. a configured base that does not exist falls through to the auto-resolver and says so', async () => {
    const { dir, base } = await repoOn('main');
    await git(dir, 'update-ref', 'refs/remotes/origin/develop', base);
    await git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    expect(await resolveHookBase(dir, 'nope')).toEqual({ ref: 'origin/develop', source: 'origin-head', note: 'hook.base "nope" not found; used origin/develop' });
    const lone = await repoOn('develop');
    expect(await resolveHookBase(lone.dir, 'nope')).toMatchObject({ ref: 'HEAD', source: 'head', note: 'hook.base "nope" not found; used HEAD' });
  });

  it("2. then origin's default branch (refs/remotes/origin/HEAD), even when a stale main exists", async () => {
    const { dir, base } = await repoOn('main');
    await git(dir, 'update-ref', 'refs/remotes/origin/develop', base);
    await git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    expect(await resolveHookBase(dir)).toEqual({ ref: 'origin/develop', source: 'origin-head' });
  });

  it('3. then origin/main, main, origin/master, master', async () => {
    const { dir, base } = await repoOn('master');
    expect(await resolveHookBase(dir)).toEqual({ ref: 'master', source: 'default' });
    await git(dir, 'update-ref', 'refs/remotes/origin/master', base);
    expect(await resolveHookBase(dir)).toEqual({ ref: 'origin/master', source: 'default' });
    await git(dir, 'branch', 'main');
    expect(await resolveHookBase(dir)).toEqual({ ref: 'main', source: 'default' });
  });

  it("4. then the branch's upstream", async () => {
    const { dir } = await repoOn('develop');
    await branch(dir, 'feature');
    await writeFiles(dir, { 'b.txt': 'b\n' });
    const sha = await commitAll(dir, 'feature');
    await git(dir, 'update-ref', 'refs/remotes/fork/feature', sha);
    await git(dir, 'config', 'remote.fork.url', '/nonexistent');
    await git(dir, 'config', 'remote.fork.fetch', '+refs/heads/*:refs/remotes/fork/*');
    await git(dir, 'config', 'branch.feature.remote', 'fork');
    await git(dir, 'config', 'branch.feature.merge', 'refs/heads/feature');
    expect(await resolveHookBase(dir)).toEqual({ ref: 'fork/feature', source: 'upstream' });
  });

  it('5. else HEAD (verifies the uncommitted changes)', async () => {
    const { dir } = await repoOn('develop');
    expect(await resolveHookBase(dir)).toEqual({ ref: 'HEAD', source: 'head' });
  });
});
