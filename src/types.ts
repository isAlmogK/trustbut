export type Severity = 'info' | 'warn' | 'fail';

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  file?: string;
  line?: number;
  detail?: string;
}

export type FileKind = 'test' | 'test-config' | 'snapshot' | 'source' | 'other';
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface AddedLine {
  line: number;
  text: string;
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  kind: FileKind;
  added: AddedLine[];
  removed: string[];
}

export type TestOutcome = 'pass' | 'fail' | 'error' | 'skip';

export interface TestCaseResult {
  id: string;
  file: string;
  name: string;
  outcome: TestOutcome;
  /** The test's own short name (e.g. the method), for matching against added lines; defaults to the last segment of `name`. */
  leaf?: string;
}

export interface RunResult {
  exitCode: number;
  cases: TestCaseResult[];
  durationMs: number;
  output: string;
}

export type ProofVerdict = 'proves-change' | 'does-not-constrain' | 'failing' | 'skipped';

export interface TestProof {
  id: string;
  file: string;
  name: string;
  before: TestOutcome | 'missing';
  after: TestOutcome;
  verdict: ProofVerdict;
  weak: boolean;
}

export interface RiskItem {
  file: string;
  score: number;
  reasons: string[];
}

export type Verdict = 'pass' | 'warn' | 'fail';

/** Which tests the head rerun covered: the whole suite, or only the changed test files (--quick). */
export type RunScope = 'full' | 'changed';

export interface Receipt {
  version: 1;
  base: string;
  head: string;
  /** Human label for head when it is not a plain commit (e.g. "working tree"). */
  headRef?: string;
  runner: string | null;
  scope: RunScope;
  verdict: Verdict;
  after?: RunResult;
  before?: RunResult;
  proofs: TestProof[];
  findings: Finding[];
  risks: RiskItem[];
}
