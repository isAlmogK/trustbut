import { command } from './command.js';
import { go } from './go.js';
import { jest } from './jest.js';
import { mocha } from './mocha.js';
import { nodeTest } from './node-test.js';
import { pytest } from './pytest.js';
import type { Runner } from './types.js';
import { vitest } from './vitest.js';

/**
 * Every supported runner. To add one: create `src/runners/<name>.ts` exporting a `Runner` and list
 * it here. On equal detection scores the earlier entry wins.
 */
export const RUNNERS: Runner[] = [vitest, jest, mocha, nodeTest, pytest, go, command];

export const runnerNames = (): string[] => RUNNERS.map((r) => r.name);

export function getRunner(name: string): Runner {
  const runner = RUNNERS.find((r) => r.name === name);
  if (!runner) throw new Error(`Unknown runner: ${name}. Supported: ${runnerNames().join(', ')}`);
  return runner;
}

/** The runner with the highest `detect()` score for the package at `root`, or null if none matches. */
export async function detectRunner(root: string): Promise<Runner | null> {
  let best: Runner | null = null;
  let bestScore = 0;
  for (const runner of RUNNERS) {
    const score = await runner.detect(root);
    if (score > bestScore) {
      best = runner;
      bestScore = score;
    }
  }
  return best;
}
