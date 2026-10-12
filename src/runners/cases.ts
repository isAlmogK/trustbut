import type { TestCaseResult } from '../types.js';

export const SEVERITY: Record<TestCaseResult['outcome'], number> = { pass: 0, skip: 1, fail: 2, error: 3 };

/** Adds `c`; if the id repeats the worst outcome wins (error > fail > skip > pass), so a failure is never hidden. */
export function addCase(cases: TestCaseResult[], index: Map<string, number>, c: TestCaseResult): void {
  const at = index.get(c.id);
  if (at === undefined) {
    index.set(c.id, cases.length);
    cases.push(c);
  } else if (SEVERITY[c.outcome] > SEVERITY[cases[at]!.outcome]) cases[at] = c;
}

/** Terminal colour and cursor codes. */
export const ANSI = new RegExp(String.raw`\u001b\[[0-9;]*[A-Za-z]`, 'g');

/** Longest failure message kept on a test case. */
export const MAX_MESSAGE = 300;

/** A runner's failure text as one line without colour codes, clipped; undefined when empty. */
export function cleanMessage(text: unknown): string | undefined {
  if (typeof text !== 'string' && typeof text !== 'number') return undefined;
  const flat = String(text).replace(ANSI, '').replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > MAX_MESSAGE ? `${flat.slice(0, MAX_MESSAGE - 1)}…` : flat;
}

/** `{ message }` when there is one, else nothing (keeps passing cases unchanged). */
export const withMessage = (message: string | undefined): { message?: string } => (message ? { message } : {});
