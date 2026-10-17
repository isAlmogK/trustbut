import type { RunResult, TestCaseResult } from '../types.js';

export interface RunOptions {
  /** The package root inside the worktree. */
  cwd: string;
  /** Top of the worktree that contains `cwd` (= `cwd` when the package root is the repo root). */
  worktree?: string;
  /** Top of the checkout trustbut was started in. Editable installs may point into it; runners map such paths onto `worktree`. */
  checkout?: string;
  /** Test files relative to `cwd`; undefined = full suite. */
  files?: string[];
  /** Extra args from config, appended to the runner's command (before the files). */
  args?: string[];
  /** Extra environment variables from config, on top of the cleaned parent environment. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Generic `command` runner only: the shell command (`{files}` is replaced with the quoted files). */
  command?: string;
  /** Generic `command` runner only: path (relative to `cwd`) of the JUnit XML the command writes. */
  junit?: string;
}

/** Head contents of a changed test file, by path relative to the package root ('' if unreadable). */
export type ReadHead = (file: string) => string;

/** Runners start their tool with `runInGroup` (src/process.ts) so a timeout stops the whole process tree. */
export interface Runner {
  /** 'vitest' | 'pytest' | 'jest' | 'node-test' | 'mocha' | 'go' | 'cargo' | 'maven' | 'gradle' | 'dotnet' | 'rspec' | 'phpunit' | 'dart' | 'flutter' | 'swift' | 'command' */
  name: string;
  /** 0 = not this runner; higher = more specific match. */
  detect(root: string): Promise<number>;
  run(opts: RunOptions): Promise<RunResult>;
  /**
   * Optional: whether result `c` comes from the changed test `file` (relative to the package root),
   * for runners whose ids don't carry file paths (e.g. Go, JVM). `readHead` gives the head
   * contents of a changed test file. Without this hook the proof engine uses `caseInFile`.
   */
  casesInFile?(c: TestCaseResult, file: string, readHead: ReadHead): boolean;
}
