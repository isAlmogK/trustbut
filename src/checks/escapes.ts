import { isJsFile, isPyFile, splitLine, type SplitLine } from '../lex.js';
import type { ChangedFile, Finding } from '../types.js';

type Part = keyof SplitLine;
type Rule = [part: Part, re: RegExp, title: string];

const TS_RULES: Rule[] = [
  ['code', /\bas\s+any\b/, 'cast to any'],
  ['code', /:\s*any\b(?!\s*\()/, 'explicit any'],
  ['comment', /@ts-(?:ignore|nocheck|expect-error)/, 'TypeScript check suppressed'],
  ['comment', /eslint-disable/, 'lint rule disabled'],
  ['comment', /\b(?:istanbul|c8|v8)\s+ignore\b/, 'coverage exclusion'],
];

const PY_RULES: Rule[] = [
  ['comment', /#\s*type:\s*ignore/, 'type check suppressed'],
  ['comment', /#\s*noqa\b/, 'lint rule disabled'],
  ['comment', /pragma:\s*no\s*cover/, 'coverage exclusion'],
];

export function checkEscapes(files: ChangedFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (f.kind !== 'source') continue;
    const rules = isJsFile(f.path) ? TS_RULES : isPyFile(f.path) ? PY_RULES : [];
    if (!rules.length) continue;
    const lang = isPyFile(f.path) ? 'py' : 'js';
    const removedSet = new Set(f.removed.map((l) => l.trim()));
    for (const a of f.added) {
      if (removedSet.has(a.text.trim())) continue;
      const parts = splitLine(a.text, lang);
      const hit = rules.find(([part, re]) => re.test(parts[part]));
      if (hit) {
        findings.push({ id: 'escape-added', severity: 'warn', title: hit[2], file: f.path, line: a.line, detail: a.text.trim() });
      }
    }
  }
  return findings;
}
