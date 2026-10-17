import { describe, expect, it } from 'vitest';
import { summarize } from '../src/hook/feedback.js';
import { buildReceipt } from '../src/receipt.js';
import { AGENT_FEEDBACK_MAX, renderForAgent } from '../src/render.js';
import type { Finding, RunResult, TestCaseResult } from '../src/types.js';

const tc = (name: string, outcome: TestCaseResult['outcome'], file = 'test/lib.test.js'): TestCaseResult => ({ id: `${file}::${name}`, file, name, outcome });
const run = (cases: TestCaseResult[], exitCode = cases.some((c) => c.outcome === 'fail') ? 1 : 0): RunResult => ({ exitCode, cases, durationMs: 1, output: '' });

function receipt(findings: Finding[], after?: RunResult, scope: 'full' | 'changed' = 'full') {
  return buildReceipt({ base: 'a'.repeat(40), head: 'b'.repeat(40), headRef: 'working tree', runner: 'command', scope, after, proofs: [], findings, changes: [] });
}

const failReceipt = () =>
  receipt(
    [
      { id: 'suite-failing', severity: 'fail', title: 'Test suite fails at head (clean checkout)', detail: 'exit code 1' },
      { id: 'test-failing', severity: 'fail', title: 'Test fails at head', file: 'test/lib.test.js', detail: 'lib > works' },
      { id: 'test-focused', severity: 'fail', title: 'Test focused (other tests will not run)', file: 'test/a.test.js', line: 3, detail: "it.only('x', () => {})" },
      { id: 'change-not-proven', severity: 'warn', title: 'Nothing proves the change', detail: '1 new or changed test, none fails without the change' },
      { id: 'uncommitted-changes', severity: 'info', title: 'ignored info' },
    ],
    run([tc('lib > works', 'fail'), tc('lib > other', 'error'), tc('ok', 'pass')]),
    'changed',
  );

describe('renderForAgent', () => {
  it('lists what to fix, the failing tests, warnings, how to recheck and where the receipt is', () => {
    expect(renderForAgent(failReceipt(), '/repo/.git/trustbut/last-receipt.md')).toBe(
      [
        'trustbut verdict: FAIL',
        '',
        'Tests (clean checkout of your work, changed test files only): 1 passed · 2 failed · 0 skipped',
        '',
        '### Must fix',
        '- Test suite fails at head (clean checkout): exit code 1',
        "- Test focused (other tests will not run) · `test/a.test.js:3`: it.only('x', () => {})",
        '',
        '### Failing tests',
        '- `test/lib.test.js` › lib > works',
        '- `test/lib.test.js` › lib > other',
        '',
        '### Warnings',
        '- Nothing proves the change: 1 new or changed test, none fails without the change',
        '',
        'Fix these and finish again; run `trustbut verify --working` to check.',
        'Full receipt: `/repo/.git/trustbut/last-receipt.md`',
        '',
      ].join('\n'),
    );
  });

  it('caps failing tests and warnings at 10 each', () => {
    const cases = Array.from({ length: 13 }, (_, i) => tc(`t${i}`, 'fail'));
    const warns: Finding[] = Array.from({ length: 12 }, (_, i) => ({ id: 'escape-added', severity: 'warn', title: `Escape ${i}`, file: 'src/x.ts', line: i + 1 }));
    const out = renderForAgent(receipt([{ id: 'suite-failing', severity: 'fail', title: 'Test suite fails at head (clean checkout)' }, ...warns], run(cases)), '/r.md');
    expect(out).toContain('- `test/lib.test.js` › t9\n- and 3 more failing tests\n');
    expect(out).not.toContain('› t10');
    expect(out).toContain('- Escape 9 · `src/x.ts:10`\n- and 2 more warnings\n');
  });

  it('flattens newlines and clips very long lines', () => {
    const out = renderForAgent(receipt([{ id: 'test-failing', severity: 'fail', title: 'Test fails at head', file: 'test/a.test.js', detail: `a\nb${'x'.repeat(1000)}` }]), '/r.md');
    const line = out.split('\n').find((l) => l.startsWith('- Test fails at head'))!;
    expect(line).toMatch(/^- Test fails at head · `test\/a\.test\.js`: a bxxx/);
    expect(line.length).toBeLessThanOrEqual(400);
    expect(line.endsWith('…')).toBe(true);
  });

  it(`stays within ${AGENT_FEEDBACK_MAX} characters, keeping the instruction and the receipt path`, () => {
    expect(AGENT_FEEDBACK_MAX).toBe(6000);
    const fails: Finding[] = Array.from({ length: 60 }, (_, i) => ({ id: 'test-focused', severity: 'fail', title: `Test focused ${i}`, file: 'test/a.test.js', line: i, detail: 'y'.repeat(150) }));
    const out = renderForAgent(receipt(fails), '/repo/.git/trustbut/last-receipt.md', {});
    expect(out.length).toBeLessThanOrEqual(AGENT_FEEDBACK_MAX);
    expect(out).toMatch(/\n- … \d+ more lines not shown; see the full receipt\n\nFix these and finish again; run `trustbut verify --working` to check\.\nFull receipt: `\/repo\/\.git\/trustbut\/last-receipt\.md`\n$/);
    expect(out).toContain('Test focused 0 ');
    expect(out).not.toContain('Test focused 59 ');
  });

  it("adds the runner's failure messages and the end of the test output, in a safe fence", () => {
    const output = [...Array.from({ length: 30 }, (_, i) => `line ${i}`), '\u001b[31m```danger```\u001b[0m', ''].join('\n');
    const r = receipt(
      [{ id: 'suite-failing', severity: 'fail', title: 'Test suite fails at head (clean checkout)', detail: 'exit code 1' }],
      { exitCode: 1, durationMs: 1, output, cases: [{ ...tc('adds', 'fail'), message: 'expected 5, got -1' }] },
    );
    const out = renderForAgent(r, '/r.md');
    expect(out).toContain('### Failing tests\n- `test/lib.test.js` › adds: expected 5, got -1\n');
    expect(out).toContain('### Test output (last lines)\n````\nline 11\n');
    expect(out).toContain('line 29\n```danger```\n````\n');
    expect(out).not.toContain('line 10\n');
  });

  it('caps the output tail at 1,500 characters', () => {
    const output = Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(200, 'z')).join('\n');
    const r = receipt([{ id: 'suite-failing', severity: 'fail', title: 'Test suite fails at head (clean checkout)' }], { exitCode: 1, durationMs: 1, output, cases: [] });
    const block = renderForAgent(r, '/r.md').split('```\n')[1]!;
    expect(block.length).toBeLessThanOrEqual(1500);
    expect(block.startsWith('13')).toBe(true);
  });

  it('uses the given recheck command', () => {
    const out = renderForAgent(failReceipt(), undefined, { recheck: 'trustbut verify --working --quick --base origin/develop' });
    expect(out).toContain('\nFix these and finish again; run `trustbut verify --working --quick --base origin/develop` to check.\n');
    expect(out).toContain('\nFull receipt: not written (run `trustbut verify --working --quick --base origin/develop` to see it)\n');
  });

  it('says when the full receipt could not be written', () => {
    expect(renderForAgent(failReceipt(), undefined)).toContain('\nFull receipt: not written (run `trustbut verify --working` to see it)\n');
  });
});

describe('summarize (one line for systemMessage)', () => {
  it('FAIL: counts failing tests, focus markers and a change nothing proves', () => {
    expect(summarize(failReceipt())).toBe('2 failing tests, 1 focused test, change not proven');
  });

  it('FAIL: a runner that reported nothing, other FAIL findings and other warnings', () => {
    const r = receipt([
      { id: 'suite-failing', severity: 'fail', title: 'Test runner failed without reporting any test results' },
      { id: 'something-new', severity: 'fail', title: 'Something new' },
      { id: 'change-not-proven', severity: 'warn', title: 'Nothing proves the change' },
      { id: 'escape-added', severity: 'warn', title: 'x' },
    ], run([], 1));
    expect(summarize(r)).toBe('test runner failed without reporting any test results, something new, change not proven, 1 other warning');
  });

  it('WARN: finding titles, grouped, at most 3', () => {
    const w = (title: string): Finding => ({ id: 'w', severity: 'warn', title });
    expect(summarize(receipt([w('Test skipped'), w('Test skipped'), w('Cast to any')], run([tc('a', 'pass')])))).toBe('Test skipped (×2); Cast to any');
    expect(summarize(receipt([w('A'), w('B'), w('C'), w('D'), w('E')]))).toBe('A; B; C; and 2 more');
  });

  it('WARN: a change nothing proves is never the title cut', () => {
    const w = (title: string): Finding => ({ id: 'w', severity: 'warn', title });
    const r = buildReceipt({
      base: 'a'.repeat(40), head: 'b'.repeat(40), runner: 'command', proofs: [], findings: [w('A'), w('B'), w('C')],
      changes: [{ path: 'src/a.ts', status: 'modified', kind: 'source', added: [{ line: 1, text: 'x();' }], removed: [] }],
    });
    expect(summarize(r)).toBe('Nothing proves the change; A; B; and 1 more');
  });

  it('PASS: what ran and what the new tests prove', () => {
    const r = buildReceipt({
      base: 'a', head: 'b', runner: 'command', after: run([tc('a', 'pass'), tc('b', 'pass')]), changes: [], findings: [],
      proofs: [{ id: 'x', file: 'test/lib.test.js', name: 'a', before: 'fail', after: 'pass', verdict: 'proves-change', weak: false }],
    });
    expect(summarize(r)).toBe('2 tests passed, 1 new/changed test proves the change');
    expect(summarize(receipt([]))).toBe('tests not run');
  });
});

describe('regressed tests', () => {
  const regressedReceipt = () =>
    buildReceipt({
      base: 'a'.repeat(40), head: 'b'.repeat(40), runner: 'vitest', scope: 'full', proofs: [], changes: [],
      after: run([tc('lib > works', 'fail'), tc('lib > old', 'fail'), tc('ok', 'pass')]),
      before: run([tc('lib > works', 'pass'), tc('lib > old', 'fail')]),
      findings: [
        { id: 'suite-failing', severity: 'fail', title: 'Test suite fails at head (clean checkout)', detail: 'exit code 1' },
        { id: 'test-regressed', severity: 'fail', title: 'Test passes at base and fails at head', file: 'test/lib.test.js', detail: 'lib > works' },
      ],
    });

  it('marks the failing tests that passed at base and does not repeat them under Must fix', () => {
    const out = renderForAgent(regressedReceipt(), undefined);
    expect(out).toContain('- `test/lib.test.js` › lib > works (passed at base)');
    expect(out).toContain('- `test/lib.test.js` › lib > old\n');
    expect(out).not.toContain('Test passes at base and fails at head');
  });

  it('says how many failing tests passed at base in the one-line summary', () => {
    expect(summarize(regressedReceipt())).toBe('2 failing tests, 1 passed at base');
  });

  it('still counts tests that passed at base when no failing test is counted', () => {
    const r = regressedReceipt();
    const noCases = { ...r, after: run([tc('ok', 'pass')]) };
    expect(summarize(noCases)).toBe('test suite fails at head (clean checkout), 1 test passed at base and fails at head');
    const two = { ...noCases, findings: [...noCases.findings, { ...noCases.findings[1]!, detail: 'lib > other' }] };
    expect(summarize(two)).toBe('test suite fails at head (clean checkout), 2 tests passed at base and fail at head');
  });
});
