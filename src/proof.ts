import { existsSync } from 'node:fs';
import { lstat, mkdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { addWorktree, removeWorktree, showFileBuffer } from './git.js';
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
  if (!c.file) return false;
  // Runner path equal to, below, or (runner rooted in a subdirectory) a suffix of the repo path.
  if (c.file === file || c.file.endsWith(`/${file}`) || file.endsWith(`/${c.file}`)) return true;
  const mod = file.replace(/\.py$/, '').split('/').join('.');
  return c.file === mod || c.file.startsWith(`${mod}.`);
}

/** The test's own name: vitest's last ` > ` segment, without pytest `[params]`. */
function leafName(name: string): string {
  return (name.split(' > ').pop() ?? name).replace(/\[.*\]$/, '');
}

/**
 * Pairs each head result in a changed test file with its base result. In a modified (not added)
 * file, a case that passed at base, still passes at head, and whose name is on no added line is
 * an untouched existing test, so it is not evidence about this change and is left out.
 */
export function buildProofs(testFiles: ChangedFile[], before: RunResult, after: RunResult): TestProof[] {
  const beforeById = new Map(before.cases.map((c) => [c.id, c.outcome]));
  const proofs: TestProof[] = [];
  for (const c of after.cases) {
    const file = testFiles.find((f) => caseInFile(c, f.path));
    if (!file) continue;
    const prior = beforeById.get(c.id) ?? 'missing';
    if (file.status !== 'added' && prior === 'pass' && (c.outcome === 'pass' || c.outcome === 'skip')) {
      const leaf = leafName(c.name);
      if (!leaf || !file.added.some((a) => a.text.includes(leaf))) continue;
    }
    const verdict: TestProof['verdict'] =
      c.outcome === 'skip' ? 'skipped' : c.outcome !== 'pass' ? 'failing' : prior === 'pass' ? 'does-not-constrain' : 'proves-change';
    const weak = verdict === 'proves-change' && (prior === 'missing' || prior === 'error');
    proofs.push({ id: c.id, file: file.path, name: c.name, before: prior, after: c.outcome, verdict, weak });
  }
  return proofs;
}

const lastLine = (output: string): string =>
  output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';

function headRunFinding(after: RunResult): Finding | undefined {
  if (after.exitCode === 0) return undefined;
  if (after.cases.length === 0) {
    const detail = lastLine(after.output);
    return { id: 'suite-failing', severity: 'fail', title: 'Test runner failed without reporting any test results', ...(detail ? { detail } : {}) };
  }
  return { id: 'suite-failing', severity: 'fail', title: 'Test suite fails at head (clean checkout)', detail: `exit code ${after.exitCode}` };
}

// Test data the changed tests may read at base: snapshots plus anything under a test or fixture directory.
const TEST_DATA_DIR = /(^|\/)(tests?|__tests__|fixtures?)\//;

/** Writes the head version of `path` into `dir`, refusing targets that resolve outside `dir`. */
async function copyFromHead(repo: string, head: string, dir: string, path: string): Promise<void> {
  const target = join(dir, path);
  await mkdir(dirname(target), { recursive: true });
  const root = await realpath(dir);
  const parent = await realpath(dirname(target));
  if (parent !== root && !parent.startsWith(root + sep)) return;
  try {
    if ((await lstat(target)).isSymbolicLink()) await unlink(target);
  } catch {
    // not present at base
  }
  await writeFile(target, await showFileBuffer(repo, head, path));
}

// Files whose name says they define tests (helpers under test/ do not produce results of their own).
const TEST_FILE_NAME = /\.(test|spec)\.[^/]*$|(^|\/)test_[^/]*\.py$|_test\.py$/;

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
  const changedTests = changes.filter((c) => c.kind === 'test' && c.status !== 'deleted');
  const testFiles = changedTests.map((c) => c.path);
  const findings: Finding[] = [];
  if (changes.some((c) => LOCKFILE.test(c.path))) {
    findings.push({ id: 'deps-changed', severity: 'info', title: 'Dependencies changed; both runs use the currently installed dependencies' });
  }

  const headDir = await addWorktree(repo, head);
  let baseDir: string | undefined;
  try {
    await linkDeps(repo, headDir);
    const after = await runner.run({ cwd: headDir, files: quick && testFiles.length ? testFiles : undefined });
    const headFinding = headRunFinding(after);
    if (headFinding) findings.push(headFinding);
    if (!testFiles.length) return { after, proofs: [], findings };

    baseDir = await addWorktree(repo, base);
    await linkDeps(repo, baseDir);
    const toCopy = changes
      .filter((c) => c.status !== 'deleted' && (c.kind === 'test' || c.kind === 'snapshot' || TEST_DATA_DIR.test(c.path)))
      .map((c) => c.path);
    for (const path of toCopy) await copyFromHead(repo, head, baseDir, path);
    const before = await runner.run({ cwd: baseDir, files: testFiles });
    if (before.exitCode !== 0 && before.cases.length === 0) {
      findings.push({
        id: 'base-run-failed',
        severity: 'warn',
        title: `Changed tests could not run at base; fail-before evidence unavailable (exit ${before.exitCode})`,
      });
    }
    const namedTests = testFiles.filter((f) => TEST_FILE_NAME.test(f));
    if (namedTests.length && after.cases.length && !after.cases.some((c) => namedTests.some((f) => caseInFile(c, f)))) {
      findings.push({
        id: 'proofs-unmatched',
        severity: 'warn',
        title: 'No test results matched the changed test files; fail-before/pass-after evidence unavailable',
      });
    }
    return { after, before, proofs: buildProofs(changedTests, before, after), findings };
  } finally {
    // Nested so a failure cleaning up head cannot skip cleaning up base.
    try {
      await unlinkDeps(headDir);
      await removeWorktree(repo, headDir);
    } finally {
      if (baseDir) {
        await unlinkDeps(baseDir);
        await removeWorktree(repo, baseDir);
      }
    }
  }
}
