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

describe('factual receipt wording', () => {
  const after = { exitCode: 0, durationMs: 1, output: '', cases: [{ id: 'a', file: 't.test.ts', name: 'a', outcome: 'pass' as const }] };
  const base = { base: 'a'.repeat(40), head: 'b'.repeat(40), runner: 'vitest', findings: [], changes: [] };

  it('says weak proofs could not run at base', () => {
    const md = renderMarkdown(buildReceipt({ ...base, after, proofs: [proof('a', 'proves-change', true), proof('b', 'proves-change')] }));
    expect(md).toContain("**New/changed tests:** 2 prove the change (1 couldn't run at base) · 0 pass without it");
  });

  it('labels the test run scope', () => {
    const full = buildReceipt({ ...base, after, proofs: [] });
    expect(full.scope).toBe('full');
    expect(renderMarkdown(full)).toContain('**Tests (clean checkout):** 1 passed');
    const changed = buildReceipt({ ...base, after, proofs: [], scope: 'changed' });
    expect(changed.scope).toBe('changed');
    expect(renderMarkdown(changed)).toContain('**Tests (clean checkout, changed files only):** 1 passed');
  });
});

describe('languages and root', () => {
  const after = { exitCode: 0, durationMs: 1, output: '', cases: [] };
  const base = { base: 'a'.repeat(40), head: 'b'.repeat(40), runner: 'go', after, proofs: [], findings: [] };

  it('lists the sorted, unique registry ids of the changed files and defaults root to "."', () => {
    const r = buildReceipt({ ...base, changes: [file('b.go', 'source'), file('a_test.go', 'test'), file('x.ts', 'source'), file('README.md', 'other')] });
    expect(r.languages).toEqual(['go', 'js']);
    expect(r.root).toBe('.');
    expect(renderMarkdown(r)).not.toContain('root:');
  });

  it('shows the root in the header only when it is not the repo root', () => {
    const r = buildReceipt({ ...base, root: 'services/api', changes: [file('services/api/a.go', 'source')] });
    expect(r.root).toBe('services/api');
    expect(renderMarkdown(r)).toContain('· runner: go · root: `services/api`');
  });
});

describe('path-word risk matching', () => {
  const reasonsFor = (path: string, kind: ChangedFile['kind'] = 'source') =>
    rankRisks([file(path, kind)], []).flatMap((r) => r.reasons);

  it('does not match substrings inside unrelated words', () => {
    for (const p of ['src/author.ts', 'lib/oracle.ts', 'src/secretary.ts', 'ui/credentials-form.tsx', '.env.example']) {
      expect(reasonsFor(p), p).toEqual([]);
    }
  });

  it('matches whole words, camelCase words and secret basenames', () => {
    expect(reasonsFor('src/auth/login.ts')).toEqual(['auth/permissions']);
    expect(reasonsFor('config/secrets.yml')).toEqual(['secrets/env']);
    expect(reasonsFor('.env.local')).toEqual(['secrets/env']);
    expect(reasonsFor('src/userSession.ts')).toEqual(['auth/permissions']);
  });
});

describe('markdown escaping', () => {
  it('keeps user text on one line with Markdown and mentions escaped', () => {
    const receipt = buildReceipt({
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      runner: null,
      proofs: [{ ...proof('x', 'does-not-constrain'), name: 'a | b *c* @team\nnext' }],
      findings: [],
      changes: [],
    });
    const md = renderMarkdown(receipt);
    expect(md).toContain('- ⚠ **Test passes without the change** · `t.test.ts`: a \\| b \\*c\\* \\@team next');
    expect(md.split('\n')).not.toContain('next');
  });

  it('renders a path containing a backtick inside a longer code span', () => {
    const receipt = buildReceipt({
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      runner: null,
      proofs: [],
      findings: [{ id: 'x', severity: 'warn', title: 't', file: 'src/a`b.ts' }],
      changes: [],
    });
    expect(renderMarkdown(receipt)).toContain('- ⚠ **t** · `` src/a`b.ts ``');
  });
});
