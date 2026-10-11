import type { ChangedFile, Finding } from '../types.js';

const TEST_DEF = /^\s*(?:(?:it|test)(?:\.\w+)*\s*\(|(?:async\s+)?def\s+test_\w*)/;
const SKIP =
  /\b(?:it|test|describe)\.(?:skip|todo)\b|\bx(?:it|test|describe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.skip\s*\(|@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|\bself\.skipTest\s*\(/;
const FOCUS = /\b(?:it|test|describe)\.only\b|^\s*f(?:it|describe)\s*\(/;
const ASSERT = /\bexpect\s*\(|\bassert\b|\.should\b|\bself\.assert\w*\(|\bassert[A-Z]\w*\(/;

const count = (lines: string[], re: RegExp) => lines.filter((l) => re.test(l)).length;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function checkTestIntegrity(files: ChangedFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (f.kind === 'snapshot' && f.status !== 'added') {
      findings.push({ id: 'snapshot-changed', severity: 'warn', title: 'Snapshot rewritten', file: f.path });
    }
    if (f.kind === 'test-config') {
      findings.push({ id: 'test-config-changed', severity: 'warn', title: 'Test or coverage config changed', file: f.path });
    }
    if (f.kind !== 'test') continue;

    const removedSet = new Set(f.removed.map((l) => l.trim()));
    for (const a of f.added) {
      if (removedSet.has(a.text.trim())) continue;
      if (FOCUS.test(a.text)) {
        findings.push({ id: 'test-focused', severity: 'fail', title: 'Test focused (other tests will not run)', file: f.path, line: a.line, detail: a.text.trim() });
      } else if (SKIP.test(a.text)) {
        findings.push({ id: 'test-skipped', severity: 'warn', title: 'Test skipped', file: f.path, line: a.line, detail: a.text.trim() });
      }
    }

    const addedText = f.added.map((a) => a.text);
    const removedTests = count(f.removed, TEST_DEF) - count(addedText, TEST_DEF);
    if (removedTests > 0) {
      findings.push({ id: 'tests-removed', severity: 'warn', title: `${plural(removedTests, 'test')} removed`, file: f.path });
    }
    const removedAsserts = count(f.removed, ASSERT) - count(addedText, ASSERT);
    if (removedAsserts > 0) {
      findings.push({ id: 'assertions-removed', severity: 'warn', title: `${plural(removedAsserts, 'assertion')} removed`, file: f.path });
    }
  }
  return findings;
}
