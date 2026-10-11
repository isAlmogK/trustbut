import { describe, expect, it } from 'vitest';
import { classify } from '../src/classify.js';
import { parseChanges } from '../src/diff.js';

describe('classify', () => {
  it.each([
    ['src/sum.ts', 'source'],
    ['app/models/user.py', 'source'],
    ['test/sum.test.ts', 'test'],
    ['src/sum.spec.tsx', 'test'],
    ['src/__tests__/a.js', 'test'],
    ['tests/test_api.py', 'test'],
    ['pkg/api_test.py', 'test'],
    ['conftest.py', 'test'],
    ['src/__snapshots__/a.test.ts.snap', 'snapshot'],
    ['vitest.config.ts', 'test-config'],
    ['jest.config.js', 'test-config'],
    ['pytest.ini', 'test-config'],
    ['.coveragerc', 'test-config'],
    ['tests/fixtures/data.json', 'other'],
    ['README.md', 'other'],
  ])('%s → %s', (path, kind) => {
    expect(classify(path)).toBe(kind);
  });
});

describe('parseChanges', () => {
  it('parses modified and added files with line numbers', () => {
    const diff = [
      'diff --git a/src/sum.ts b/src/sum.ts',
      'index 1111111..2222222 100644',
      '--- a/src/sum.ts',
      '+++ b/src/sum.ts',
      '@@ -1,3 +1,3 @@',
      ' export function sum(a: number, b: number) {',
      '-  return a - b;',
      '+  return a + b;',
      ' }',
      'diff --git a/test/sum.test.ts b/test/sum.test.ts',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/test/sum.test.ts',
      '@@ -0,0 +1,2 @@',
      "+import { it } from 'vitest';",
      "+it('adds', () => {});",
      '',
    ].join('\n');

    const files = parseChanges(diff);
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({
      path: 'src/sum.ts',
      oldPath: undefined,
      status: 'modified',
      kind: 'source',
      added: [{ line: 2, text: '  return a + b;' }],
      removed: ['  return a - b;'],
    });
    expect(files[1].status).toBe('added');
    expect(files[1].kind).toBe('test');
    expect(files[1].added.map((a) => a.line)).toEqual([1, 2]);
  });

  it('parses deleted files', () => {
    const diff = [
      'diff --git a/test/old.test.ts b/test/old.test.ts',
      'deleted file mode 100644',
      'index 4444444..0000000',
      '--- a/test/old.test.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      "-it('old', () => {});",
      '',
    ].join('\n');
    const [file] = parseChanges(diff);
    expect(file.path).toBe('test/old.test.ts');
    expect(file.status).toBe('deleted');
    expect(file.removed).toEqual(["it('old', () => {});"]);
  });
});
