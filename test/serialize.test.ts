import { describe, expect, it } from 'vitest';
import { toAgentReceipt } from '../src/spec/serialize.js';
import { SCHEMA_URL } from '../src/spec/types.js';
import { validateAgentReceipt } from '../src/spec/validate.js';
import type { Receipt } from '../src/types.js';
import { VERSION } from '../src/version.js';

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  version: 1,
  base: 'aaa',
  head: 'bbb',
  runner: 'vitest',
  languages: ['js'],
  root: '.',
  scope: 'full',
  verdict: 'warn',
  after: {
    exitCode: 1,
    durationMs: 1234,
    output: 'SECRET=hunter2 and a very long log',
    cases: [
      { id: 'a', file: 't.test.ts', name: 'a', outcome: 'pass' },
      { id: 'b', file: 't.test.ts', name: 'b', outcome: 'fail', message: 'expected 1 to be 2' },
      { id: 'c', file: 't.test.ts', name: 'c', outcome: 'error' },
      { id: 'd', file: 't.test.ts', name: 'd', outcome: 'skip' },
      { id: 'e', file: 't.test.ts', name: 'e', outcome: 'pass' },
    ],
  },
  before: { exitCode: 0, durationMs: 50, output: 'base log', cases: [], timedOut: true },
  proofs: [{ id: 't.test.ts::a', file: 't.test.ts', name: 'a', before: 'pass', after: 'pass', verdict: 'does-not-constrain', weak: false }],
  findings: [
    { id: 'test-passes-without-change', severity: 'warn', title: 'Test passes without the change', file: 't.test.ts', detail: 'a' },
    { id: 'deps-changed', severity: 'info', title: 'Dependencies changed' },
  ],
  risks: [{ file: 'src/a.ts', score: 1, reasons: ['large change (250 lines)'] }],
  ...over,
});

describe('toAgentReceipt', () => {
  it('maps the core fields', () => {
    const r = toAgentReceipt(receipt({ headRef: 'working tree' }));
    expect(r.$schema).toBe(SCHEMA_URL);
    expect(r.specVersion).toBe('1.2');
    expect(r.producer).toEqual({ name: 'trustbut', version: VERSION });
    expect(r.subject).toEqual({ base: 'aaa', head: 'bbb', headRef: 'working tree' });
    expect(r.verdict).toBe('warn');
    expect(r.findings).toEqual([
      { id: 'test-passes-without-change', severity: 'warn', title: 'Test passes without the change', file: 't.test.ts', detail: 'a' },
      { id: 'deps-changed', severity: 'info', title: 'Dependencies changed' },
    ]);
    expect(r.risks).toEqual([{ file: 'src/a.ts', score: 1, reasons: ['large change (250 lines)'] }]);
  });

  it('omits headRef for a plain commit', () => {
    expect(toAgentReceipt(receipt()).subject).toEqual({ base: 'aaa', head: 'bbb' });
  });

  it('counts the head run into tests', () => {
    expect(toAgentReceipt(receipt()).tests).toEqual({ passed: 2, failed: 1, errored: 1, skipped: 1, scope: 'full' });
    expect(toAgentReceipt(receipt({ scope: 'changed' })).tests?.scope).toBe('changed');
  });

  it('omits tests when the tests did not run', () => {
    expect(toAgentReceipt(receipt({ after: undefined, before: undefined }))).not.toHaveProperty('tests');
  });

  it('drops the internal proof id and weak flag', () => {
    expect(toAgentReceipt(receipt()).proofs).toEqual([{ file: 't.test.ts', name: 'a', before: 'pass', after: 'pass', verdict: 'does-not-constrain' }]);
  });

  it('keeps trustbut detail under x-trustbut, without the raw runner output', () => {
    const r = toAgentReceipt(receipt());
    expect(r['x-trustbut']).toEqual({
      runner: 'vitest',
      languages: ['js'],
      root: '.',
      after: { exitCode: 1, durationMs: 1234, cases: receipt().after!.cases },
      before: { exitCode: 0, durationMs: 50, timedOut: true, cases: [] },
    });
    expect(JSON.stringify(r)).not.toContain('hunter2');
    expect(JSON.stringify(r)).not.toContain('"output"');
  });

  it('produces a valid agent receipt', () => {
    expect(validateAgentReceipt(JSON.parse(JSON.stringify(toAgentReceipt(receipt()))))).toEqual({ valid: true, errors: [], warnings: [] });
    expect(validateAgentReceipt(JSON.parse(JSON.stringify(toAgentReceipt(receipt({ runner: null, after: undefined, before: undefined, findings: [], verdict: 'pass' })))))).toEqual({ valid: true, errors: [], warnings: [] });
  });
});

describe('toAgentReceipt with outputTail', () => {
  it('adds the end of a failed run only, without colour codes', () => {
    const r = toAgentReceipt(receipt(), { outputTail: true });
    expect(r['x-trustbut']?.after?.outputTail).toBe('SECRET=hunter2 and a very long log');
    expect(r['x-trustbut']?.before).not.toHaveProperty('outputTail');
    const colored = toAgentReceipt(receipt({ after: { exitCode: 1, durationMs: 1, cases: [], output: '\u001b[31mred\u001b[39m\n' } }), { outputTail: true });
    expect(colored['x-trustbut']?.after?.outputTail).toBe('red');
    expect(validateAgentReceipt(JSON.parse(JSON.stringify(r)))).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('keeps the last 50 lines and at most 4,000 characters', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
    const tail = toAgentReceipt(receipt({ after: { exitCode: 1, durationMs: 1, cases: [], output: lines } }), { outputTail: true })['x-trustbut']?.after?.outputTail;
    expect(tail?.split('\n')).toEqual(Array.from({ length: 50 }, (_, i) => `line ${i + 11}`));
    const long = `${'a'.repeat(3000)}${'b'.repeat(3000)}`;
    const cut = toAgentReceipt(receipt({ after: { exitCode: 1, durationMs: 1, cases: [], output: long } }), { outputTail: true })['x-trustbut']?.after?.outputTail;
    expect(cut).toHaveLength(4000);
    expect(cut?.endsWith('b'.repeat(3000))).toBe(true);
  });

  it('writes no output without the option', () => {
    expect(JSON.stringify(toAgentReceipt(receipt()))).not.toContain('outputTail');
  });
});
