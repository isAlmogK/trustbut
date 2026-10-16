import { languageOf } from '../languages/index.js';
import { splitLine } from '../lex.js';
import type { ChangedFile, Finding } from '../types.js';

/** `generated`: paths of generated files (`linguist-generated` at head), which get no findings. */
export function checkEscapes(files: ChangedFile[], generated: ReadonlySet<string> = new Set()): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (f.kind !== 'source' || generated.has(f.path)) continue;
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
