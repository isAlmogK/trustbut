import { describe, expect, it } from 'vitest';
import { LANGUAGES, languageById, languageOf } from '../src/languages/index.js';
import type { Language } from '../src/languages/types.js';
import { splitLine } from '../src/lex.js';

describe('language registry', () => {
  it('registers js, py, go and rust', () => {
    expect(LANGUAGES.map((l) => l.id)).toEqual(['js', 'py', 'go', 'rust']);
  });

  it.each([
    ['src/a.js', 'js'],
    ['src/a.jsx', 'js'],
    ['src/a.ts', 'js'],
    ['src/a.tsx', 'js'],
    ['src/a.mjs', 'js'],
    ['src/a.cjs', 'js'],
    ['src/a.mts', 'js'],
    ['src/a.cts', 'js'],
    ['app/models/user.py', 'py'],
  ])('%s → %s', (path, id) => {
    expect(languageOf(path)?.id).toBe(id);
  });

  it('returns undefined for unregistered files', () => {
    expect(languageOf('README.md')).toBeUndefined();
    expect(languageOf('main.scala')).toBeUndefined();
    expect(languageOf('src/a.tsbuildinfo')).toBeUndefined();
  });

  it('looks languages up by id and rejects unknown ids', () => {
    expect(languageById('py').id).toBe('py');
    expect(() => languageById('cobol')).toThrow(/Unknown language: cobol/);
  });

  it('marks test files per language', () => {
    const js = languageById('js');
    const py = languageById('py');
    expect(js.testFile.test('src/sum.spec.tsx')).toBe(true);
    expect(js.testFile.test('src/__tests__/a.js')).toBe(true);
    expect(js.testFile.test('src/sum.ts')).toBe(false);
    expect(py.testFile.test('pkg/api_test.py')).toBe(true);
    expect(py.testFile.test('conftest.py')).toBe(true);
    expect(py.testFile.test('app/user.py')).toBe(false);
  });
});

describe('splitLine driven by a language definition', () => {
  // A made-up language: `--` line comments, `{- -}` block comments, `"` strings.
  const toy: Language = {
    id: 'toy',
    extensions: ['.toy'],
    testFile: /_test\.toy$/,
    comments: { line: ['--'], block: ['{-', '-}'] },
    strings: ['"'],
    rules: {},
  };

  it('uses the comment and string syntax of the language', () => {
    expect(splitLine('x = "-- not a comment" -- real', toy)).toEqual({ code: 'x = "" ', comment: '-- real' });
    expect(splitLine('a {- note -} b', toy)).toEqual({ code: 'a   b', comment: '{- note -}' });
    expect(splitLine('a {- open', toy)).toEqual({ code: 'a ', comment: '{- open' });
  });

  it('treats `/` as plain code in a language without regex literals', () => {
    expect(splitLine('x = a / b / c', toy)).toEqual({ code: 'x = a / b / c', comment: '' });
  });

  it('does not treat `* text` as a block continuation without C-style block comments', () => {
    expect(splitLine('  * args', languageById('py'))).toEqual({ code: '  * args', comment: '' });
  });
});
