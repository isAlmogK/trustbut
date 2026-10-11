import { existsSync } from 'node:fs';
import { lstat, mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { addWorktree, removeWorktree, showFile } from './git.js';
import type { Runner } from './runners/types.js';
import type { ChangedFile, Finding, RunResult, TestCaseResult, TestProof } from './types.js';

const DEP_DIRS = ['node_modules', '.venv', 'venv'];
const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|requirements[^/]*\.txt)$/;

export interface ProofInput {
  repo: string;
  base: string;
  head: string;
  changes: ChangedFile[];
  runner: Runner;
  quick?: boolean;
}

export interface ProofOutput {
  after?: RunResult;
  before?: RunResult;
  proofs: TestProof[];
  findings: Finding[];
}

export function caseInFile(c: TestCaseResult, file: string): boolean {
  if (c.file === file || c.file.endsWith(`/${file}`)) return true;
  const mod = file.replace(/\.py$/, '').split('/').join('.');
  return c.file === mod || c.file.startsWith(`${mod}.`);
}

export function buildProofs(testFiles: string[], before: RunResult, after: RunResult): TestProof[] {
  const beforeById = new Map(before.cases.map((c) => [c.id, c.outcome]));
  return after.cases
    .filter((c) => testFiles.some((f) => caseInFile(c, f)))
    .map((c) => {
      const prior = beforeById.get(c.id) ?? 'missing';
      const verdict: TestProof['verdict'] =
        c.outcome === 'skip' ? 'skipped' : c.outcome !== 'pass' ? 'failing' : prior === 'pass' ? 'does-not-constrain' : 'proves-change';
      const weak = verdict === 'proves-change' && (prior === 'missing' || prior === 'error');
      return { id: c.id, file: c.file, name: c.name, before: prior, after: c.outcome, verdict, weak };
    });
}

async function linkDeps(repo: string, dir: string): Promise<void> {
  for (const name of DEP_DIRS) {
    if (existsSync(join(repo, name)) && !existsSync(join(dir, name))) {
      await symlink(join(repo, name), join(dir, name), 'dir');
    }
  }
}

// Remove our dependency symlinks before deleting a worktree so nothing can follow them.
async function unlinkDeps(dir: string): Promise<void> {
  for (const name of DEP_DIRS) {
    const p = join(dir, name);
    try {
      if ((await lstat(p)).isSymbolicLink()) await unlink(p);
    } catch {
      // not present
    }
  }
}

export async function proveTests({ repo, base, head, changes, runner, quick }: ProofInput): Promise<ProofOutput> {
  const testFiles = changes.filter((c) => c.kind === 'test' && c.status !== 'deleted').map((c) => c.path);
  const findings: Finding[] = [];
  if (changes.some((c) => LOCKFILE.test(c.path))) {
    findings.push({ id: 'deps-changed', severity: 'info', title: 'Dependencies changed; both runs use the currently installed dependencies' });
  }

  const headDir = await addWorktree(repo, head);
  let baseDir: string | undefined;
  try {
    await linkDeps(repo, headDir);
    const after = await runner.run({ cwd: headDir, files: quick && testFiles.length ? testFiles : undefined });
    if (after.exitCode !== 0) {
      findings.push({ id: 'suite-failing', severity: 'fail', title: 'Test suite fails at head (clean checkout)', detail: `exit code ${after.exitCode}` });
    }
    if (!testFiles.length) return { after, proofs: [], findings };

    baseDir = await addWorktree(repo, base);
    await linkDeps(repo, baseDir);
    for (const path of testFiles) {
      const target = join(baseDir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await showFile(repo, head, path));
    }
    const before = await runner.run({ cwd: baseDir, files: testFiles });
    return { after, before, proofs: buildProofs(testFiles, before, after), findings };
  } finally {
    await unlinkDeps(headDir);
    await removeWorktree(repo, headDir);
    if (baseDir) {
      await unlinkDeps(baseDir);
      await removeWorktree(repo, baseDir);
    }
  }
}
