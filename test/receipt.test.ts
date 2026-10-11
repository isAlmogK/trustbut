import { describe, expect, it } from 'vitest';
import { buildReceipt, coverageFindings, decideVerdict, proofFindings } from '../src/receipt.js';
import { renderMarkdown } from '../src/render.js';
import { rankRisks } from '../src/risk.js';
import type { ChangedFile, TestProof } from '../src/types.js';

const file = (path: string, kind: ChangedFile['kind'], size = 1): ChangedFile => ({
  path, status: 'modified', kind, added: Array.from({ length: size }, (_, i) => ({ line: i + 1, text: 'x' })), removed: [],
});

const proof = (name: string, verdict: TestProof['verdict'], weak = false): TestProof => ({
  id: `t.test.ts::${name}`, file: 't.test.ts', name, before: 'fail', after: 'pass', verdict, weak,
});

describe('rankRisks', () => {
  it('scores risky paths, findings and size; ignores test paths for path rules', () => {
    const risks = rankRisks(
      [
        file('src/auth/session.ts', 'source'),
        file('package.json', 'other'),
        file('src/util.ts', 'source', 250),
        file('test/auth.test.ts', 'test'),
        file('src/plain.ts', 'source'),
      ],
      [{ id: 'escape-added', severity: 'warn', title: 'cast to any', file: 'src/auth/session.ts' }],
    );
    expect(risks).toEqual([
      { file: 'src/auth/session.ts', score: 5, reasons: ['auth/permissions', 'has findings'] },
      { file: 'package.json', score: 2, reasons: ['dependencies'] },
      { file: 'src/util.ts', score: 1, reasons: ['large change (250 lines)'] },
    ]);
  });
});

describe('derived findings and verdict', () => {
  it('turns proofs into findings', () => {
    expect(proofFindings([proof('a', 'proves-change'), proof('b', 'does-not-constrain'), proof('c', 'failing')]).map((f) => [f.id, f.severity])).toEqual([
      ['test-passes-without-change', 'warn'],
      ['test-failing', 'fail'],
    ]);
  });

  it('warns when source changes without tests', () => {
    expect(coverageFindings([file('src/a.ts', 'source')]).map((f) => f.id)).toEqual(['no-tests-changed']);
    expect(coverageFindings([file('src/a.ts', 'source'), file('test/a.test.ts', 'test')])).toEqual([]);
  });

  it('decides the verdict from the worst finding', () => {
    expect(decideVerdict([])).toBe('pass');
    expect(decideVerdict([{ id: 'x', severity: 'info', title: '' }])).toBe('pass');
    expect(decideVerdict([{ id: 'x', severity: 'warn', title: '' }])).toBe('warn');
    expect(decideVerdict([{ id: 'x', severity: 'warn', title: '' }, { id: 'y', severity: 'fail', title: '' }])).toBe('fail');
  });
});

describe('renderMarkdown', () => {
  it('renders the verdict, test summary, findings and review list', () => {
    const receipt = buildReceipt({
      base: '3f2a91c0000000000000000000000000000000000',
      head: '8be04d10000000000000000000000000000000000',
      runner: 'vitest',
      after: {
        exitCode: 0, durationMs: 10, output: '',
        cases: [
          { id: 'a', file: 't.test.ts', name: 'a', outcome: 'pass' },
          { id: 'b', file: 't.test.ts', name: 'b', outcome: 'pass' },
          { id: 'c', file: 't.test.ts', name: 'c', outcome: 'skip' },
        ],
      },
      proofs: [proof('a', 'proves-change'), proof('b', 'does-not-constrain')],
      findings: [{ id: 'escape-added', severity: 'warn', title: 'cast to any', file: 'src/auth/session.ts', line: 41 }],
      changes: [file('src/auth/session.ts', 'source'), file('t.test.ts', 'test')],
    });
    const md = renderMarkdown(receipt);
    expect(receipt.verdict).toBe('warn');
    expect(md).toContain('## 🧾 Receipt: WARN');
    expect(md).toContain('`3f2a91c` → `8be04d1` · runner: vitest');
    expect(md).toContain('**Tests (clean checkout):** 2 passed · 0 failed · 1 skipped');
    expect(md).toContain('**New/changed tests:** 1 prove the change · 1 pass without it');
    expect(md).toContain('- ⚠ **cast to any** · `src/auth/session.ts:41`');
    expect(md).toContain('- ⚠ **Test passes without the change** · `t.test.ts`: b');
    expect(md).toContain('1. `src/auth/session.ts`: auth/permissions, has findings');
  });
});
