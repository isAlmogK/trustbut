import { langOf, splitLine } from '../lex.js';
import type { ChangedFile, Finding } from '../types.js';

// All patterns run against the code part of a line (string contents and comments removed).
const TEST_DEF = /^\s*(?:(?:it|test)(?:\.\w+)*\s*\(|(?:async\s+)?def\s+test_\w*)/;
const SKIP = new RegExp(
  [
    /^\s*(?:it|test|describe|suite)(?:\.\w+)*\.(?:skip|todo)\b/.source,
    /^\s*x(?:it|test|describe)\s*\(/.source,
    /^\s*@(?:pytest\.mark\.(?:skip|skipif|xfail)|unittest\.(?:skip|skipIf|skipUnless|expectedFailure))\b/.source,
    /\bself\.skipTest\s*\(/.source,
    /\bpytest\.skip\s*\(/.source,
  ].join('|'),
);
const FOCUS = /^\s*(?:(?:it|test|describe|suite)(?:\.\w+)*\.only\b|f(?:it|describe)\s*\()/;
const ASSERT = /\bexpect\s*\(|\bassert\b|\.should\b|\bself\.assert\w*\(|\bassert[A-Z]\w*\(/;

const count = (lines: string[], re: RegExp) => lines.filter((l) => re.test(l)).length;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function checkTestIntegrity(files: ChangedFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (f.kind === 'snapshot' && f.status !== 'added') {
      const title = f.status === 'deleted' ? 'Snapshot deleted' : 'Snapshot changed';
      findings.push({ id: 'snapshot-changed', severity: 'warn', title, file: f.path });
    }
    if (f.kind === 'test-config') {
      findings.push({ id: 'test-config-changed', severity: 'warn', title: 'Test or coverage config changed', file: f.path });
    }
    if (f.kind !== 'test') continue;

    const lang = langOf(f.path);
    const code = (line: string) => splitLine(line, lang).code;
    const removedSet = new Set(f.removed.map((l) => l.trim()));
    for (const a of f.added) {
      if (removedSet.has(a.text.trim())) continue;
      const c = code(a.text);
      if (FOCUS.test(c)) {
        findings.push({ id: 'test-focused', severity: 'fail', title: 'Test focused (other tests will not run)', file: f.path, line: a.line, detail: a.text.trim() });
      } else if (SKIP.test(c)) {
        findings.push({ id: 'test-skipped', severity: 'warn', title: 'Test skipped', file: f.path, line: a.line, detail: a.text.trim() });
      }
    }

    const addedCode = f.added.map((a) => code(a.text));
    const removedCode = f.removed.map(code);
    const removedTests = count(removedCode, TEST_DEF) - count(addedCode, TEST_DEF);
    if (removedTests > 0) {
      findings.push({ id: 'tests-removed', severity: 'warn', title: `${plural(removedTests, 'test')} removed`, file: f.path });
    }
    const removedAsserts = count(removedCode, ASSERT) - count(addedCode, ASSERT);
    if (removedAsserts > 0) {
      findings.push({ id: 'assertions-removed', severity: 'warn', title: `${plural(removedAsserts, 'assertion')} removed`, file: f.path });
    }
  }
  return findings;
}
