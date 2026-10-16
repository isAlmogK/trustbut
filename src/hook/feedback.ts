// One-line summaries of a receipt for an agent's `systemMessage` (shown to the user, not the agent).
import { failingCases } from '../render.js';
import type { Finding, Receipt } from '../types.js';

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const oneLine = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, ' ');
const MAX_TITLES = 3;

function failParts(r: Receipt): string[] {
  const parts: string[] = [];
  const fails = r.findings.filter((f) => f.severity === 'fail');
  const failing = Math.max(failingCases(r).length, fails.filter((f) => f.id === 'test-failing').length);
  const suite = fails.find((f) => f.id === 'suite-failing');
  if (failing) parts.push(count(failing, 'failing test'));
  else if (suite) parts.push(lowerFirst(suite.title));
  const regressed = fails.filter((f) => f.id === 'test-regressed').length;
  if (failing && regressed) parts.push(`${regressed} passed at base`);
  else if (regressed) parts.push(`${count(regressed, 'test')} passed at base and ${regressed === 1 ? 'fails' : 'fail'} at head`);
  const focused = fails.filter((f) => f.id === 'test-focused').length;
  if (focused) parts.push(count(focused, 'focused test'));
  const known = new Set(['suite-failing', 'test-failing', 'test-regressed', 'test-focused']);
  for (const title of new Set(fails.filter((f) => !known.has(f.id)).map((f) => f.title))) parts.push(lowerFirst(title));
  const warns = r.findings.filter((f) => f.severity === 'warn');
  const loose = warns.filter((f) => f.id === 'test-passes-without-change').length;
  if (loose) parts.push(loose === 1 ? '1 test passes without the change' : `${loose} tests pass without the change`);
  const other = warns.length - loose;
  if (other) parts.push(count(other, 'other warning'));
  return parts;
}

function warnTitles(findings: Finding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.title, (counts.get(f.title) ?? 0) + 1);
  const titles = [...counts].map(([title, n]) => (n > 1 ? `${title} (×${n})` : title));
  const shown = titles.slice(0, MAX_TITLES);
  if (titles.length > MAX_TITLES) shown.push(`and ${titles.length - MAX_TITLES} more`);
  return shown.join('; ');
}

function passParts(r: Receipt): string[] {
  if (!r.after) return ['tests not run'];
  const passed = r.after.cases.filter((c) => c.outcome === 'pass').length;
  const parts = [`${count(passed, 'test')} passed${r.scope === 'changed' ? ' (changed test files only)' : ''}`];
  const proves = r.proofs.filter((p) => p.verdict === 'proves-change').length;
  if (proves) parts.push(proves === 1 ? '1 new/changed test proves the change' : `${proves} new/changed tests prove the change`);
  return parts;
}

/** What the receipt found, in one line: counts for FAIL, finding titles for WARN, test counts for PASS. */
export function summarize(r: Receipt): string {
  if (r.verdict === 'fail') return oneLine(failParts(r).join(', '));
  if (r.verdict === 'warn') return oneLine(warnTitles(r.findings.filter((f) => f.severity === 'warn')));
  return passParts(r).join(', ');
}
