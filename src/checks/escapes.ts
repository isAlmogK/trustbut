import { languageOf } from '../languages/index.js';
import { splitLine } from '../lex.js';
import type { ChangedFile, Finding } from '../types.js';

export function checkEscapes(files: ChangedFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (f.kind !== 'source') continue;
    const lang = languageOf(f.path);
    const rules = lang?.rules.escapes ?? [];
    if (!lang || !rules.length) continue;
    const removedSet = new Set(f.removed.map((l) => l.trim()));
    for (const a of f.added) {
      if (removedSet.has(a.text.trim())) continue;
      const parts = splitLine(a.text, lang);
      const hit = rules.find(({ part, re }) => re.test(parts[part]));
      if (hit) {
        findings.push({ id: 'escape-added', severity: 'warn', title: hit.title, file: f.path, line: a.line, detail: a.text.trim() });
      }
    }
  }
  return findings;
}
