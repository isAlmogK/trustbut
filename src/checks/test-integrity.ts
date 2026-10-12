import { js } from '../languages/js.js';
import { languageOf } from '../languages/index.js';
import type { Rule } from '../languages/types.js';
import { splitLine, type SplitLine } from '../lex.js';
import type { ChangedFile, Finding } from '../types.js';

const ruleMatches = (rule: Rule, parts: SplitLine) => (rule instanceof RegExp ? rule.test(parts.code) : rule.re.test(parts[rule.part]));
const matchesAny = (rules: Rule[] | undefined, parts: SplitLine) => !!rules?.some((r) => ruleMatches(r, parts));

const count = (lines: SplitLine[], rules: Rule[] | undefined) => lines.filter((l) => matchesAny(rules, l)).length;
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
    // Languages with tests inside source files (Rust) get the skip and test-definition checks there too.
    const inline = f.kind === 'source' && !!languageOf(f.path)?.inlineTests;
    if (f.kind !== 'test' && !inline) continue;

    // Test files of languages not in the registry keep the JS rules they always had.
    const lang = languageOf(f.path) ?? js;
    const { focus, skip, testDef } = lang.rules;
    const assert = inline ? undefined : lang.rules.assert;
    const split = (line: string) => splitLine(line, lang);
    const removedSet = new Set(f.removed.map((l) => l.trim()));
    for (const a of f.added) {
      if (removedSet.has(a.text.trim())) continue;
      const parts = split(a.text);
      if (matchesAny(focus, parts)) {
        findings.push({ id: 'test-focused', severity: 'fail', title: 'Test focused (other tests will not run)', file: f.path, line: a.line, detail: a.text.trim() });
      } else if (matchesAny(skip, parts)) {
        findings.push({ id: 'test-skipped', severity: 'warn', title: 'Test skipped', file: f.path, line: a.line, detail: a.text.trim() });
      }
    }

    const addedParts = f.added.map((a) => split(a.text));
    const removedParts = f.removed.map(split);
    const removedTests = count(removedParts, testDef) - count(addedParts, testDef);
    if (removedTests > 0) {
      findings.push({ id: 'tests-removed', severity: 'warn', title: `${plural(removedTests, 'test')} removed`, file: f.path });
    }
    const removedAsserts = count(removedParts, assert) - count(addedParts, assert);
    if (removedAsserts > 0) {
      findings.push({ id: 'assertions-removed', severity: 'warn', title: `${plural(removedAsserts, 'assertion')} removed`, file: f.path });
    }
  }
  return findings;
}
