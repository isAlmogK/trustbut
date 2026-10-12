import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { addWorktree, removeWorktree, showFileBuffer } from './git.js';
import { isNamedTestFile } from './languages/index.js';
import type { ReadHead, RunOptions, Runner } from './runners/types.js';
import { startSetup, type SetupOptions } from './setup.js';
import type { ChangedFile, Finding, RunResult, RunScope, TestCaseResult, TestProof } from './types.js';

const DEP_DIRS = ['node_modules', '.venv', 'venv'];
const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|composer\.lock|Cargo\.lock|packages\.lock\.json|Gemfile\.lock|go\.sum|pubspec\.lock|Package\.resolved|requirements[^/]*\.txt)$/;

export interface ProofInput {
  repo: string;
  base: string;
  head: string;
  changes: ChangedFile[];
  runner: Runner;
  quick?: boolean;
  /** Package root relative to the repo ('.' default): the runner runs in `<worktree>/<root>`. */
  root?: string;
  /** Config options passed to every run. */
  runOptions?: Omit<RunOptions, 'cwd' | 'files'>;
  /** Started in the package root before each run and killed after it; gets `runOptions.env`. */
  setup?: Omit<SetupOptions, 'cwd' | 'env'>;
}

export interface ProofOutput {
  scope: RunScope;
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

/** Whether result `c` comes from changed test file `f`. */
export type CaseMatcher = (c: TestCaseResult, f: ChangedFile) => boolean;

/** The test's own name: vitest's last ` > ` segment, without pytest `[params]`. */
function leafName(name: string): string {
  return (name.split(' > ').pop() ?? name).replace(/\[.*\]$/, '');
}

/**
 * Pairs each head result in a changed test file with its base result. In a modified (not added)
 * file, a case that passed at base, still passes at head, and whose name is on no added line is
 * an untouched existing test, so it is not evidence about this change and is left out.
 */
export function buildProofs(
  testFiles: ChangedFile[],
  before: RunResult,
  after: RunResult,
  inFile: CaseMatcher = (c, f) => caseInFile(c, f.path),
): TestProof[] {
  const beforeById = new Map(before.cases.map((c) => [c.id, c.outcome]));
  const proofs: TestProof[] = [];
  for (const c of after.cases) {
    const file = testFiles.find((f) => inFile(c, f));
    if (!file) continue;
    const prior = beforeById.get(c.id) ?? 'missing';
    if (file.status !== 'added' && prior === 'pass' && (c.outcome === 'pass' || c.outcome === 'skip')) {
      const leaf = c.leaf ?? leafName(c.name);
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

// Dependency folders are linked at the repo root and, for a package root, inside it too.
const depFolders = (root: string): string[] => (root === '.' ? DEP_DIRS : [...DEP_DIRS, ...DEP_DIRS.map((d) => join(root, d))]);

async function linkDeps(repo: string, dir: string, root: string): Promise<void> {
  for (const rel of depFolders(root)) {
    const target = join(dir, rel);
    if (existsSync(join(repo, rel)) && existsSync(dirname(target)) && !existsSync(target)) {
      await symlink(join(repo, rel), target, 'dir');
    }
  }
}

// Remove our dependency symlinks before deleting a worktree so nothing can follow them.
async function unlinkDeps(dir: string, root: string): Promise<void> {
  for (const rel of depFolders(root)) {
    const p = join(dir, rel);
    try {
      if ((await lstat(p)).isSymbolicLink()) await unlink(p);
    } catch {
      // not present
    }
  }
}

async function runWithSetup(runner: Runner, opts: RunOptions, setup: ProofInput['setup']): Promise<RunResult> {
  const proc = setup ? await startSetup({ ...setup, cwd: opts.cwd, env: opts.env }) : undefined;
  try {
    return await runner.run(opts);
  } finally {
    await proc?.stop();
  }
}

export async function proveTests(input: ProofInput): Promise<ProofOutput> {
  const { repo, base, head, changes, runner, quick, runOptions = {}, setup } = input;
  const root = input.root ?? '.';
  const prefix = root === '.' ? '' : `${root}/`;
  /** Path relative to the package root. */
  const rel = (path: string) => path.slice(prefix.length);
  const changedTests = changes.filter((c) => c.kind === 'test' && c.status !== 'deleted' && c.path.startsWith(prefix));
  const testFiles = changedTests.map((c) => rel(c.path));
  const findings: Finding[] = [];
  if (changes.some((c) => LOCKFILE.test(c.path))) {
    findings.push({ id: 'deps-changed', severity: 'info', title: 'Dependencies changed; both runs use the currently installed dependencies' });
  }

  const headDir = await addWorktree(repo, head);
  let baseDir: string | undefined;
  try {
    const headRoot = join(headDir, root);
    if (!existsSync(headRoot)) throw new Error(`Package root "${root}" does not exist at head`);
    await linkDeps(repo, headDir, root);
    const scope: RunScope = quick && testFiles.length ? 'changed' : 'full';
    const after = await runWithSetup(runner, { ...runOptions, cwd: headRoot, worktree: headDir, files: scope === 'changed' ? testFiles : undefined }, setup);
    const headFinding = headRunFinding(after);
    if (headFinding) findings.push(headFinding);
    if (!testFiles.length) return { scope, after, proofs: [], findings };

    baseDir = await addWorktree(repo, base);
    await linkDeps(repo, baseDir, root);
    const toCopy = changes
      .filter((c) => c.status !== 'deleted' && (c.kind === 'test' || c.kind === 'snapshot' || TEST_DATA_DIR.test(c.path)))
      .map((c) => c.path);
    for (const path of toCopy) await copyFromHead(repo, head, baseDir, path);
    const before = await runWithSetup(runner, { ...runOptions, cwd: join(baseDir, root), worktree: baseDir, files: testFiles }, setup);
    if (before.exitCode !== 0 && before.cases.length === 0) {
      findings.push({
        id: 'base-run-failed',
        severity: 'warn',
        title: `Changed tests could not run at base; fail-before evidence unavailable (exit ${before.exitCode})`,
      });
    }

    const headCache = new Map<string, string>();
    const readHead: ReadHead = (file) => {
      if (!headCache.has(file)) {
        let text = '';
        try {
          text = readFileSync(join(headRoot, file), 'utf8');
        } catch {
          // unreadable: no contents
        }
        headCache.set(file, text);
      }
      return headCache.get(file) ?? '';
    };
    const hook = runner.casesInFile?.bind(runner);
    const inFile: CaseMatcher = hook ? (c, f) => hook(c, rel(f.path), readHead) : (c, f) => caseInFile(c, rel(f.path));

    // Only files whose name says they define tests (helpers under test dirs produce no results of their own).
    const namedTests = changedTests.filter((f) => isNamedTestFile(f.path));
    if (namedTests.length && after.cases.length && !after.cases.some((c) => namedTests.some((f) => inFile(c, f)))) {
      findings.push({
        id: 'proofs-unmatched',
        severity: 'warn',
        title: 'No test results matched the changed test files; fail-before/pass-after evidence unavailable',
      });
    }
    return { scope, after, before, proofs: buildProofs(changedTests, before, after, inFile), findings };
  } finally {
    // Nested so a failure cleaning up head cannot skip cleaning up base.
    try {
      await unlinkDeps(headDir, root);
      await removeWorktree(repo, headDir);
    } finally {
      if (baseDir) {
        await unlinkDeps(baseDir, root);
        await removeWorktree(repo, baseDir);
      }
    }
  }
}
