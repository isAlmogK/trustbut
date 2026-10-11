import { describe, expect, it } from 'vitest';
import { checkEscapes } from '../src/checks/escapes.js';
import { checkTestIntegrity } from '../src/checks/test-integrity.js';
import type { ChangedFile } from '../src/types.js';

function file(partial: Partial<ChangedFile> & { path: string }): ChangedFile {
  return { status: 'modified', kind: 'test', added: [], removed: [], ...partial };
}

const ids = (fs: { id: string }[]) => fs.map((f) => f.id);

describe('checkTestIntegrity', () => {
  it('flags newly skipped tests with their line', () => {
    const findings = checkTestIntegrity([
      file({ path: 'test/a.test.ts', added: [{ line: 7, text: "  it.skip('rejects expired', () => {" }] }),
      file({ path: 'tests/test_a.py', added: [{ line: 3, text: '@pytest.mark.skip(reason="flaky")' }] }),
    ]);
    expect(findings).toMatchObject([
      { id: 'test-skipped', severity: 'warn', file: 'test/a.test.ts', line: 7 },
      { id: 'test-skipped', severity: 'warn', file: 'tests/test_a.py', line: 3 },
    ]);
  });

  it('does not flag a skip that was only moved', () => {
    const line = "  it.skip('legacy', () => {";
    expect(checkTestIntegrity([file({ path: 't.test.ts', added: [{ line: 1, text: line }], removed: [line] })])).toEqual([]);
  });

  it('fails on focused tests', () => {
    const findings = checkTestIntegrity([file({ path: 'a.test.ts', added: [{ line: 2, text: "it.only('x', () => {" }] })]);
    expect(findings[0]).toMatchObject({ id: 'test-focused', severity: 'fail' });
  });

  it('flags net removed tests and assertions', () => {
    const findings = checkTestIntegrity([
      file({
        path: 'test/a.test.ts',
        removed: ["it('one', () => {", '  expect(a).toBe(1);', "it('two', () => {", '  expect(b).toBe(2);'],
        added: [{ line: 1, text: "it('one', () => {" }],
      }),
    ]);
    expect(ids(findings)).toEqual(['tests-removed', 'assertions-removed']);
    expect(findings[0].title).toBe('1 test removed');
  });

  it('flags snapshots and test config changes', () => {
    const findings = checkTestIntegrity([
      file({ path: 'src/__snapshots__/a.snap', kind: 'snapshot' }),
      file({ path: 'vitest.config.ts', kind: 'test-config' }),
    ]);
    expect(ids(findings)).toEqual(['snapshot-changed', 'test-config-changed']);
  });
});

describe('checkEscapes', () => {
  it('flags new escapes in source files only', () => {
    const findings = checkEscapes([
      file({
        path: 'src/a.ts',
        kind: 'source',
        added: [
          { line: 4, text: '  const x = y as any;' },
          { line: 9, text: '  // @ts-ignore' },
          { line: 10, text: '  return x;' },
        ],
      }),
      file({ path: 'src/b.py', kind: 'source', added: [{ line: 2, text: 'import foo  # type: ignore' }] }),
      file({ path: 'test/a.test.ts', kind: 'test', added: [{ line: 1, text: 'const m = {} as any;' }] }),
    ]);
    expect(findings.map((f) => [f.file, f.line, f.title])).toEqual([
      ['src/a.ts', 4, 'cast to any'],
      ['src/a.ts', 9, 'TypeScript check suppressed'],
      ['src/b.py', 2, 'type check suppressed'],
    ]);
  });
});
