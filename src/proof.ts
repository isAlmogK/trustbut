import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { checkDepsInstalled } from './deps.js';
import { addWorktree, removeWorktree, showFileBuffer } from './git.js';
import { SEVERITY } from './runners/cases.js';
import { detectRunner } from './runners/registry.js';
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
  /** The runner to use; when omitted it is detected in the head checkout of the package root. */
  runner?: Runner;
  /** Runner detection for a package root (default: the registry's `detectRunner`). */
  detect?: (root: string) => Promise<Runner | null>;
  quick?: boolean;
  /** Package root relative to the repo ('.' default): the runner runs in `<worktree>/<root>`. */
  root?: string;
  /** Config options passed to every run. */
  runOptions?: Omit<RunOptions, 'cwd' | 'files'>;
  /** Started in the package root before each run and killed after it; gets `runOptions.env`. */
  setup?: Omit<SetupOptions, 'cwd' | 'env'>;
}

export interface ProofOutput {
  /** The runner used; null when none was given and none was detected at head (nothing was run). */
  runner?: Runner | null;
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
  // A repeated id keeps its worst outcome (error > fail > skip > pass).
  const beforeById = new Map<string, TestCaseResult['outcome']>();
  for (const c of before.cases) {
    const prev = beforeById.get(c.id);
    if (prev === undefined || SEVERITY[c.outcome] > SEVERITY[prev]) beforeById.set(c.id, c.outcome);
  }
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

/** A placeholder the runner reports when its tool failed before any test ran (`[cargo]::[build]`, `[phpunit]::[run]`). */
export const isSynthetic = (c: TestCaseResult): boolean => c.file.startsWith('[');

/** Whether the run reported nothing but placeholders for a failed build or start-up. */
const onlySynthetic = (r: RunResult): boolean => r.cases.length > 0 && r.cases.every(isSynthetic);

/** `timed out after N s` for a run stopped at the time limit. */
const timeoutDetail = (r: RunResult, timeoutMs: number | undefined): string | undefined =>
  r.timedOut ? `timed out after ${timeoutMs !== undefined ? `${Math.round(timeoutMs / 1000)} s` : 'the time limit'}` : undefined;

function headRunFinding(after: RunResult, timeoutMs: number | undefined): Finding | undefined {
  if (after.exitCode === 0) return undefined;
  const timedOut = timeoutDetail(after, timeoutMs);
  if (after.cases.length === 0 || onlySynthetic(after)) {
    const detail = timedOut ?? lastLine(after.output);
    return { id: 'suite-failing', severity: 'fail', title: 'Test runner failed without reporting any test results', ...(detail ? { detail } : {}) };
  }
  return { id: 'suite-failing', severity: 'fail', title: 'Test suite fails at head (clean checkout)', detail: timedOut ?? `exit code ${after.exitCode}` };
}

// Base gets the changed tests, snapshots, and files under a test or fixture folder (Go `testdata/`, RSpec `spec/`, SwiftPM `Tests/`, .NET `X.Tests/`).
// Source-kind files there are copied too (test helpers), unless the folder sits inside a source tree (`src/spec/`) and isn't a fixtures/testdata folder.
const FIXTURE_DIR = /(^|\/)(fixtures?|testdata)\//;
const TEST_DATA_DIR = /(^|\/)(tests?|__tests__|fixtures?|testdata|spec|Tests|[\w.-]+\.Tests?)\//;
// A folder directly under `packages/` or `apps/` is a workspace package (`packages/app`), not a source tree, so its
// own top-level `test/` is treated like the repo's; `packages/web/app/models/spec/` is still a source tree.
const SOURCE_TREE_DATA = /(^|\/)(?<!(?:^|\/)(?:packages|apps)\/)(src|lib|app|pkg|internal)\/(.*\/)?(spec|tests?|__tests__|Tests)\//;

/** Whether a changed file is copied from head into the base checkout before the base run. */
export function copiedToBase(c: ChangedFile): boolean {
  if (c.status === 'deleted') return false;
  if (c.kind === 'test' || c.kind === 'snapshot') return true;
  return TEST_DATA_DIR.test(c.path) && (c.kind !== 'source' || FIXTURE_DIR.test(c.path) || !SOURCE_TREE_DATA.test(c.path));
}

/** Writes the head version of `path` into `dir`, refusing targets that resolve outside `dir`. */
async function copyFromHead(repo: string, head: string, dir: string, path: string): Promise<void> {
  const target = join(dir, path);
  const root = await realpath(dir);
  const inside = (p: string) => p === root || p.startsWith(root + sep);
  // Check the nearest existing ancestor first, so `mkdir -p` can't create folders through a symlink that leads out.
  let ancestor = dirname(target);
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  if (!inside(await realpath(ancestor))) return;
  try {
    await mkdir(dirname(target), { recursive: true });
  } catch {
    return; // a file or dangling symlink is in the way at base
  }
  if (!inside(await realpath(dirname(target)))) return;
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

const SHOWN_OUTSIDE = 3;

export async function proveTests(input: ProofInput): Promise<ProofOutput> {
  const { repo, base, head, changes, quick, runOptions = {}, setup } = input;
  const root = input.root ?? '.';
  const prefix = root === '.' ? '' : `${root}/`;
  /** Path relative to the package root. */
  const rel = (path: string) => path.slice(prefix.length);
  const liveTests = changes.filter((c) => c.kind === 'test' && c.status !== 'deleted');
  const changedTests = liveTests.filter((c) => c.path.startsWith(prefix));
  const testFiles = changedTests.map((c) => rel(c.path));
  const findings: Finding[] = [];
  if (changes.some((c) => LOCKFILE.test(c.path))) {
    findings.push({ id: 'deps-changed', severity: 'info', title: 'Dependencies changed; both runs use the currently installed dependencies' });
  }
  const outside = liveTests.filter((c) => !c.path.startsWith(prefix)).map((c) => c.path);
  if (outside.length) {
    const n = outside.length;
    const more = n > SHOWN_OUTSIDE ? ` and ${n - SHOWN_OUTSIDE} more` : '';
    findings.push({
      id: 'tests-outside-root',
      severity: 'info',
      title: `${n} changed test file${n === 1 ? ' is' : 's are'} outside the package root ${root} and ${n === 1 ? 'was' : 'were'} not run: ${outside.slice(0, SHOWN_OUTSIDE).join(', ')}${more}`,
    });
  }

  const headDir = await addWorktree(repo, head);
  let baseDir: string | undefined;
  try {
    const headRoot = join(headDir, root);
    if (!existsSync(headRoot)) throw new Error(`Package root "${root}" does not exist at head`);
    // Detected from head's files, which may differ from the checked-out working tree (--head, --working).
    const runner = input.runner ?? (await (input.detect ?? detectRunner)(headRoot));
    if (!runner) return { runner: null, scope: 'full', proofs: [], findings };
    const notInstalled = checkDepsInstalled(repo, root, runner.name);
    if (notInstalled) findings.push(notInstalled);
    await linkDeps(repo, headDir, root);
    const scope: RunScope = quick && testFiles.length ? 'changed' : 'full';
    const after = await runWithSetup(runner, { ...runOptions, cwd: headRoot, worktree: headDir, files: scope === 'changed' ? testFiles : undefined }, setup);
    const headFinding = headRunFinding(after, runOptions.timeoutMs);
    if (headFinding) findings.push(headFinding);
    if (after.exitCode === 0 && after.cases.length === 0) {
      findings.push({ id: 'no-test-results', severity: 'warn', title: 'The test runner reported no test results' });
    }
    if (!testFiles.length) return { runner, scope, after, proofs: [], findings };

    baseDir = await addWorktree(repo, base);
    await linkDeps(repo, baseDir, root);
    const toCopy = changes.filter(copiedToBase).map((c) => c.path);
    for (const path of toCopy) await copyFromHead(repo, head, baseDir, path);
    const before = await runWithSetup(runner, { ...runOptions, cwd: join(baseDir, root), worktree: baseDir, files: testFiles }, setup);
    if (before.exitCode !== 0 && before.cases.length === 0) {
      const detail = timeoutDetail(before, runOptions.timeoutMs);
      findings.push({
        id: 'base-run-failed',
        severity: 'warn',
        title: `Changed tests could not run at base; fail-before evidence unavailable (exit ${before.exitCode})`,
        ...(detail ? { detail } : {}),
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
    // Nothing ran (exit 0, no results) counts; a build or start-up failure is already reported by suite-failing.
    const ran = after.exitCode === 0 ? !onlySynthetic(after) : after.cases.some((c) => !isSynthetic(c));
    if (namedTests.length && ran && !after.cases.some((c) => namedTests.some((f) => inFile(c, f)))) {
      findings.push({
        id: 'proofs-unmatched',
        severity: 'warn',
        title: 'No test results matched the changed test files; fail-before/pass-after evidence unavailable',
      });
    }
    return { runner, scope, after, before, proofs: buildProofs(changedTests, before, after, inFile), findings };
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
