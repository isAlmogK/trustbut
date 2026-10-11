import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const PROJECT_NODE_MODULES = fileURLToPath(new URL('../../node_modules', import.meta.url));

export async function writeFiles(dir: string, files: Record<string, string | null>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    if (content === null) {
      await rm(full, { force: true });
      continue;
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

export async function commitAll(dir: string, message: string): Promise<string> {
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', ['commit', '-q', '-m', message], { cwd: dir });
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

export async function branch(dir: string, name: string): Promise<void> {
  await execa('git', ['checkout', '-q', '-b', name], { cwd: dir });
}

export async function makeRepo(files: Record<string, string>): Promise<{ dir: string; base: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'trustbut-fixture-'));
  await execa('git', ['init', '-q'], { cwd: dir });
  await execa('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await writeFiles(dir, files);
  const base = await commitAll(dir, 'base');
  return { dir, base };
}

export async function linkNodeModules(dir: string): Promise<void> {
  await symlink(PROJECT_NODE_MODULES, join(dir, 'node_modules'), 'dir');
}
