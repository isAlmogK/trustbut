import { expect } from 'vitest';
import { runVerify as realRunVerify, type VerifyOptions } from '../../src/commands/verify.js';
import { toAgentReceipt } from '../../src/spec/serialize.js';
import { validateAgentReceipt } from '../../src/spec/validate.js';

/**
 * runVerify, plus spec conformance: every receipt the e2e and runner suites produce must be a valid
 * agent receipt v1 with no warnings, exactly as `--json` would print it.
 */
export async function runVerify(opts?: VerifyOptions): Promise<Awaited<ReturnType<typeof realRunVerify>>> {
  const result = await realRunVerify(opts);
  const printed: unknown = JSON.parse(JSON.stringify(toAgentReceipt(result.receipt)));
  expect(validateAgentReceipt(printed)).toEqual({ valid: true, errors: [], warnings: [] });
  return result;
}
