import { describe, expect, it } from 'vitest';
import { checkEscapes } from '../src/checks/escapes.js';
import { checkTestIntegrity } from '../src/checks/test-integrity.js';
import { splitLine } from '../src/lex.js';
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

  it('does not count tests and assertions moved to another test file', () => {
    const block = ["describe('export', () => {", "  it('writes the file', () => {", '    expect(out).toBe(1);', '  });', '});'];
    const findings = checkTestIntegrity([
      file({ path: 'test/export.test.ts', removed: block }),
      file({ path: 'test/export-ollama.test.ts', status: 'added', added: block.map((text, i) => ({ line: i + 1, text: `  ${text}` })) }),
    ]);
    expect(findings).toEqual([]);
  });

  it('still counts tests removed when no other file adds them', () => {
    const findings = checkTestIntegrity([
      file({ path: 'test/a.test.ts', removed: ["it('one', () => {", '  expect(a).toBe(1);'] }),
      file({ path: 'test/b.test.ts', added: [{ line: 1, text: "it('other', () => {" }, { line: 2, text: '  expect(b).toBe(2);' }] }),
    ]);
    expect(ids(findings)).toEqual(['tests-removed', 'assertions-removed']);
  });

  it('does not report tests removed when tests were merged and kept their assertions', () => {
    const findings = checkTestIntegrity([
      file({
        path: 'test/badge.test.tsx',
        removed: ["it('renders 1', () => {", "it('renders 2', () => {", "it('renders 3', () => {"],
        added: [{ line: 1, text: "it('renders counts', () => {" }],
      }),
    ]);
    expect(findings).toEqual([]);
  });

  it('reports both when merged tests also lost an assertion', () => {
    const findings = checkTestIntegrity([
      file({
        path: 'test/badge.test.tsx',
        removed: ["it('renders 1', () => {", '  expect(one).toBe(1);', "it('renders 2', () => {", '  expect(two).toBe(2);'],
        added: [{ line: 1, text: "it('renders counts', () => {" }, { line: 2, text: '  expect(one).toBe(1);' }],
      }),
    ]);
    expect(ids(findings)).toEqual(['tests-removed', 'assertions-removed']);
  });

  it('still reports removed Rust inline tests (no assertion count there)', () => {
    const findings = checkTestIntegrity([file({ path: 'src/lib.rs', kind: 'source', removed: ['    #[test]', '    fn adds() {'] })]);
    expect(ids(findings)).toEqual(['tests-removed']);
  });

  it('a moved line cancels at most as many removals as were added elsewhere', () => {
    const line = '    expect(x).toBe(true);';
    const findings = checkTestIntegrity([
      file({ path: 'test/a.test.ts', removed: [line, line, line] }),
      file({ path: 'test/b.test.ts', added: [{ line: 1, text: line }] }),
    ]);
    expect(findings).toMatchObject([{ id: 'assertions-removed', title: '2 assertions removed', file: 'test/a.test.ts' }]);
  });

  it('reports removed Rust inline tests even when one test is added back', () => {
    const findings = checkTestIntegrity([
      file({
        path: 'src/lib.rs',
        kind: 'source',
        removed: ['    #[test]', '    fn a() {', '    #[test]', '    fn b() {', '    #[test]', '    fn c() {'],
        added: [{ line: 1, text: '    #[test]' }, { line: 2, text: '    fn d() {' }],
      }),
    ]);
    expect(ids(findings)).toEqual(['tests-removed']);
  });

  it('reports tests deleted outright with no assertion lines', () => {
    const findings = checkTestIntegrity([file({ path: 'test/a.test.ts', removed: ["it('one', () => {", "it('two', () => {"] })]);
    expect(ids(findings)).toEqual(['tests-removed']);
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

describe('checkTestIntegrity regressions', () => {
  it('does not treat ordinary .fit( calls as focused tests', () => {
    const findings = checkTestIntegrity([
      file({
        path: 'test/model.test.ts',
        added: [
          { line: 3, text: '    model.fit(X, y)' },
          { line: 4, text: '  fitAddon.fit();' },
        ],
      }),
    ]);
    expect(findings).toEqual([]);
  });

  it('still fails on jasmine-style fit and fdescribe at statement start', () => {
    const findings = checkTestIntegrity([
      file({
        path: 'test/focus.test.ts',
        added: [
          { line: 5, text: "  fit('x', () => {" },
          { line: 9, text: "fdescribe('y', () => {" },
        ],
      }),
    ]);
    expect(findings).toMatchObject([
      { id: 'test-focused', severity: 'fail', line: 5 },
      { id: 'test-focused', severity: 'fail', line: 9 },
    ]);
  });

  it('counts removed unittest assertions', () => {
    const findings = checkTestIntegrity([
      file({
        path: 'tests/test_math.py',
        removed: ['        self.assertEqual(add(1, 2), 3)', '        self.assertEqual(add(0, 0), 0)'],
      }),
    ]);
    expect(findings).toMatchObject([{ id: 'assertions-removed', severity: 'warn', title: '2 assertions removed' }]);
  });

  it('detects added unittest skips', () => {
    const findings = checkTestIntegrity([
      file({
        path: 'tests/test_math.py',
        added: [
          { line: 4, text: '@unittest.skip("flaky")' },
          { line: 8, text: '        self.skipTest("later")' },
        ],
      }),
    ]);
    expect(findings).toMatchObject([
      { id: 'test-skipped', severity: 'warn', file: 'tests/test_math.py', line: 4 },
      { id: 'test-skipped', severity: 'warn', file: 'tests/test_math.py', line: 8 },
    ]);
  });
});

describe('splitLine', () => {
  it('blanks JS/TS string, template and regex contents and splits comments', () => {
    expect(splitLine(`const a = "it.only(" + 'x' + \`y\`; // note`, 'js')).toEqual({
      code: `const a = "" + '' + \`\`; `,
      comment: '// note',
    });
    expect(splitLine('  [/eslint-disable/, \'lint rule disabled\'],', 'js')).toEqual({ code: "  [//, ''],", comment: '' });
    expect(splitLine('x = a / b / c; /* @ts-ignore */ y as any', 'js')).toEqual({
      code: 'x = a / b / c;   y as any',
      comment: '/* @ts-ignore */',
    });
    expect(splitLine('   * accepts values such as any', 'js')).toEqual({ code: '', comment: '* accepts values such as any' });
  });

  it('handles Python strings, triple quotes and # comments', () => {
    expect(splitLine('x = "# not a comment"  # type: ignore', 'py')).toEqual({ code: 'x = ""  ', comment: '# type: ignore' });
    expect(splitLine('s = """it.only(""" + \'a\\\'b\'', 'py')).toEqual({ code: 's = """""" + \'\'', comment: '' });
  });
});

describe('static checks ignore strings, regex literals and comments (self-receipt regressions)', () => {
  it('does not flag focus/skip calls inside string literals in test data', () => {
    const findings = checkTestIntegrity([
      file({
        path: 'test/checks.test.ts',
        added: [
          { line: 15, text: `      file({ path: 'test/a.test.ts', added: [{ line: 7, text: "  it.skip('rejects expired', () => {" }] }),` },
          { line: 25, text: `    const line = "  it.skip('legacy', () => {";` },
          { line: 30, text: `    const findings = checkTestIntegrity([file({ path: 'a.test.ts', added: [{ line: 2, text: "it.only('x', () => {" }] })]);` },
          { line: 50, text: `      'test/old.test.js': "import { it, expect } from 'vitest';\\nit.only('truth', () => expect(1).toBe(1));\\n",` },
          { line: 51, text: `  // TODO: it.only( would focus; pytest.skip( would skip` },
          { line: 52, text: `  expect(x).only;` },
        ],
      }),
      file({ path: 'tests/test_doc.py', added: [{ line: 1, text: `    msg = "@pytest.mark.skip is not used here"  # self.skipTest( too` }] }),
    ]);
    expect(findings).toEqual([]);
  });

  it('does not flag escapes in regex literals, strings, Python any() or comment prose', () => {
    const findings = checkEscapes([
      file({
        path: 'src/checks/escapes.ts',
        kind: 'source',
        added: [
          { line: 7, text: `  [/eslint-disable/, 'lint rule disabled'],` },
          { line: 8, text: `  const msg = 'use as any sparingly: any';` },
          { line: 9, text: `  // accepts values such as any of the above` },
          { line: 10, text: `  const t = \`@ts-ignore\`;` },
        ],
      }),
      file({ path: 'src/pick.py', kind: 'source', added: [{ line: 3, text: `check = lambda x: any(xs)` }, { line: 4, text: `s = "# noqa"` }] }),
    ]);
    expect(findings).toEqual([]);
  });

  it('still flags directives in comments and casts in code', () => {
    const findings = checkEscapes([
      file({
        path: 'src/a.tsx',
        kind: 'source',
        added: [
          { line: 1, text: '  // eslint-disable-next-line no-console' },
          { line: 2, text: '  /* istanbul ignore next */' },
          { line: 3, text: '  function f(x: any) {}' },
          { line: 4, text: '  const y = x as any; // fine' },
        ],
      }),
      file({ path: 'src/b.py', kind: 'source', added: [{ line: 1, text: 'import os  # noqa: F401' }, { line: 2, text: 'def f():  # pragma: no cover' }] }),
    ]);
    expect(findings.map((f) => [f.file, f.line, f.title, f.id])).toEqual([
      ['src/a.tsx', 1, 'lint rule disabled', 'escape-added'],
      ['src/a.tsx', 2, 'coverage exclusion', 'escape-added'],
      ['src/a.tsx', 3, 'explicit any', 'escape-added'],
      ['src/a.tsx', 4, 'cast to any', 'escape-added'],
      ['src/b.py', 1, 'lint rule disabled', 'escape-added'],
      ['src/b.py', 2, 'coverage exclusion', 'escape-added'],
    ]);
  });

  it('does not flag a directive mentioned in comment prose, or any in a generic constraint', () => {
    const lines = [
      '  // should NOT type-check (use @ts-expect-error to assert this).',
      "  // we don't add eslint-disable here",
      '  /* see the istanbul ignore docs */',
      '  findComponent<T extends (...args: any[]) => VNode>(',
      'type C<T extends new (...args: any[]) => object> = T;',
      'function f<A, B extends (...a: any[]) => any>() {}',
    ];
    const findings = checkEscapes([file({ path: 'src/a.ts', kind: 'source', added: lines.map((text, i) => ({ line: i + 1, text })) })]);
    expect(findings).toEqual([]);
  });

  it('still flags directives right after a comment marker, any outside constraints and justified suppressions', () => {
    const lines = [
      '  // @ts-expect-error -- reason',
      '  /* @ts-ignore */',
      '  /** @ts-ignore */',
      '  {/* @ts-expect-error */}',
      '   * @ts-ignore',
      '/// @ts-nocheck',
      'foo(); // eslint-disable-line',
      '/* c8 ignore next */',
      '  renderGraphiQL?: (options?: any) => string;',
      'function f<T>(x: any): T {}',
    ];
    const findings = checkEscapes([
      file({ path: 'src/a.tsx', kind: 'source', added: lines.map((text, i) => ({ line: i + 1, text })) }),
      file({ path: 'src/b.py', kind: 'source', added: [{ line: 1, text: 'except Exception:  # noqa: BLE001  # a row that fails is passed through' }] }),
    ]);
    expect(findings.map((f) => [f.file, f.line, f.title])).toEqual([
      ['src/a.tsx', 1, 'TypeScript check suppressed'],
      ['src/a.tsx', 2, 'TypeScript check suppressed'],
      ['src/a.tsx', 3, 'TypeScript check suppressed'],
      ['src/a.tsx', 4, 'TypeScript check suppressed'],
      ['src/a.tsx', 5, 'TypeScript check suppressed'],
      ['src/a.tsx', 6, 'TypeScript check suppressed'],
      ['src/a.tsx', 7, 'lint rule disabled'],
      ['src/a.tsx', 8, 'coverage exclusion'],
      ['src/a.tsx', 9, 'explicit any'],
      ['src/a.tsx', 10, 'explicit any'],
      ['src/b.py', 1, 'lint rule disabled'],
    ]);
  });

  it('skips generated files', () => {
    const gen = file({ path: 'seed/a.rb', kind: 'source', added: [{ line: 1, text: 'value # rubocop:disable Lint/Void' }] });
    expect(checkEscapes([gen], new Set(['seed/a.rb']))).toEqual([]);
    expect(checkEscapes([gen]).map((f) => f.title)).toEqual(['lint rule disabled']);
  });

  it('applies TS escapes only to JS/TS files and Python escapes only to .py files', () => {
    const findings = checkEscapes([
      file({ path: 'src/a.go', kind: 'source', added: [{ line: 1, text: 'var x = y // eslint-disable as any' }] }),
      file({ path: 'src/a.ts', kind: 'source', added: [{ line: 1, text: 'const x = 1; // noqa' }] }),
      file({ path: 'src/a.py', kind: 'source', added: [{ line: 1, text: 'x = y  # @ts-ignore' }] }),
    ]);
    expect(findings).toEqual([]);
  });

  it('detects chained focus/skip forms at statement start', () => {
    const findings = checkTestIntegrity([
      file({
        path: 'test/chain.test.ts',
        added: [
          { line: 1, text: "  it.concurrent.only('a', () => {});" },
          { line: 2, text: "  test.only.each([1])('b', () => {});" },
          { line: 3, text: "  suite.only('c', () => {});" },
          { line: 4, text: "  it.concurrent.skip('d', () => {});" },
          { line: 5, text: "  describe.todo('e');" },
          { line: 6, text: "  xit('f', () => {});" },
        ],
      }),
      file({
        path: 'tests/test_x.py',
        added: [
          { line: 1, text: '@pytest.mark.xfail(reason="later")' },
          { line: 2, text: '    pytest.skip("no db")' },
        ],
      }),
    ]);
    expect(findings.map((f) => [f.line, f.id])).toEqual([
      [1, 'test-focused'],
      [2, 'test-focused'],
      [3, 'test-focused'],
      [4, 'test-skipped'],
      [5, 'test-skipped'],
      [6, 'test-skipped'],
      [1, 'test-skipped'],
      [2, 'test-skipped'],
    ]);
  });
});

describe('snapshot wording', () => {
  it('says deleted for deleted snapshots and changed otherwise', () => {
    const findings = checkTestIntegrity([
      file({ path: 'src/__snapshots__/a.snap', kind: 'snapshot', status: 'deleted' }),
      file({ path: 'src/__snapshots__/b.snap', kind: 'snapshot', status: 'modified' }),
      file({ path: 'src/__snapshots__/c.snap', kind: 'snapshot', status: 'added' }),
    ]);
    expect(findings.map((f) => [f.id, f.title, f.file])).toEqual([
      ['snapshot-changed', 'Snapshot deleted', 'src/__snapshots__/a.snap'],
      ['snapshot-changed', 'Snapshot changed', 'src/__snapshots__/b.snap'],
    ]);
  });
});
