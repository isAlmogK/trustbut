import { js } from '../languages/js.js';
import { languageOf } from '../languages/index.js';
import { splitLine } from '../lex.js';
import type { ChangedFile, Finding } from '../types.js';

const matchesAny = (res: RegExp[] | undefined, text: string) => !!res?.some((re) => re.test(text));

const count = (lines: string[], res: RegExp[] | undefined) => lines.filter((l) => matchesAny(res, l)).length;
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

    // Test files of languages not in the registry yet keep the JS rules they always had.
    const lang = languageOf(f.path) ?? js;
    const { focus, skip, testDef, assert } = lang.rules;
    const code = (line: string) => splitLine(line, lang).code;
    const removedSet = new Set(f.removed.map((l) => l.trim()));
    for (const a of f.added) {
      if (removedSet.has(a.text.trim())) continue;
      const c = code(a.text);
      if (matchesAny(focus, c)) {
        findings.push({ id: 'test-focused', severity: 'fail', title: 'Test focused (other tests will not run)', file: f.path, line: a.line, detail: a.text.trim() });
      } else if (matchesAny(skip, c)) {
        findings.push({ id: 'test-skipped', severity: 'warn', title: 'Test skipped', file: f.path, line: a.line, detail: a.text.trim() });
      }
    }

    const addedCode = f.added.map((a) => code(a.text));
    const removedCode = f.removed.map(code);
    const removedTests = count(removedCode, testDef) - count(addedCode, testDef);
    if (removedTests > 0) {
      findings.push({ id: 'tests-removed', severity: 'warn', title: `${plural(removedTests, 'test')} removed`, file: f.path });
    }
    const removedAsserts = count(removedCode, assert) - count(addedCode, assert);
    if (removedAsserts > 0) {
      findings.push({ id: 'assertions-removed', severity: 'warn', title: `${plural(removedAsserts, 'assertion')} removed`, file: f.path });
    }
  }
  return findings;
}
