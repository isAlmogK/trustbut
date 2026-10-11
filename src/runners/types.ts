import type { RunResult } from '../types.js';

export interface RunOptions {
  cwd: string;
  files?: string[];
}

export interface Runner {
  name: 'vitest' | 'pytest';
  run(opts: RunOptions): Promise<RunResult>;
}
