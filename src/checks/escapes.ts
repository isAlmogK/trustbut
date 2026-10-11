import type { ChangedFile, Finding } from '../types.js';

const ESCAPES: [RegExp, string][] = [
  [/\bas\s+any\b/, 'cast to any'],
  [/:\s*any\b/, 'explicit any'],
  [/@ts-(?:ignore|nocheck|expect-error)/, 'TypeScript check suppressed'],
  [/eslint-disable/, 'lint rule disabled'],
  [/#\s*type:\s*ignore/, 'type check suppressed'],
  [/#\s*noqa/, 'lint rule disabled'],
  [/(?:istanbul|c8|v8)\s+ignore|pragma:\s*no\s*cover/, 'coverage exclusion'],
];

export function checkEscapes(files: ChangedFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (f.kind !== 'source') continue;
    const removedSet = new Set(f.removed.map((l) => l.trim()));
    for (const a of f.added) {
      if (removedSet.has(a.text.trim())) continue;
      const hit = ESCAPES.find(([re]) => re.test(a.text));
      if (hit) {
        findings.push({ id: 'escape-added', severity: 'warn', title: hit[1], file: f.path, line: a.line, detail: a.text.trim() });
      }
    }
  }
  return findings;
}
