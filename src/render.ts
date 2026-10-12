import type { Finding, Receipt, RunResult } from './types.js';

const ICON = { fail: '✖', warn: '⚠', info: 'ℹ' } as const;

// Characters that would start Markdown syntax, HTML, entities, or @mentions in plain text.
const MD_SPECIAL = /[\\`*_[\]<>|#&~@]/g;

function oneLine(s: string): string {
  return s.replace(/\r\n|\r|\n/g, ' ');
}

/** Plain user text: single line, Markdown punctuation and @mentions escaped. */
function text(s: string): string {
  return oneLine(s).replace(MD_SPECIAL, '\\$&');
}

/** Inline code span whose fence is longer than any backtick run inside the content. */
function code(s: string): string {
  const flat = oneLine(s);
  const longest = (flat.match(/`+/g) ?? []).reduce((m, run) => Math.max(m, run.length), 0);
  if (longest === 0) return `\`${flat}\``;
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${flat} ${fence}`;
}

function tally(run: RunResult) {
  const t = { pass: 0, fail: 0, error: 0, skip: 0 };
  for (const c of run.cases) t[c.outcome] += 1;
  return t;
}

function findingLine(f: Finding): string {
  const where = f.file ? ` · ${code(`${f.file}${f.line ? `:${f.line}` : ''}`)}` : '';
  const detail = f.detail ? `: ${text(f.detail)}` : '';
  return `- ${ICON[f.severity]} **${text(f.title)}**${where}${detail}`;
}

export function renderMarkdown(r: Receipt): string {
  const lines: string[] = [];
  lines.push(`## 🧾 Receipt: ${r.verdict.toUpperCase()}`, '');
  lines.push(`${code(r.base.slice(0, 7))} → ${r.headRef ? text(r.headRef) : code(r.head.slice(0, 7))}${r.runner ? ` · runner: ${text(r.runner)}${r.root && r.root !== '.' ? ` · root: ${code(r.root)}` : ''}` : ''}`, '');

  if (r.after) {
    const t = tally(r.after);
    const where = r.scope === 'changed' ? 'clean checkout, changed files only' : 'clean checkout';
    lines.push(`**Tests (${where}):** ${t.pass} passed · ${t.fail + t.error} failed · ${t.skip} skipped`);
  } else {
    lines.push('**Tests:** not run');
  }
  if (r.proofs.length) {
    const proves = r.proofs.filter((p) => p.verdict === 'proves-change');
    const weak = proves.filter((p) => p.weak).length;
    const loose = r.proofs.filter((p) => p.verdict === 'does-not-constrain').length;
    lines.push(`**New/changed tests:** ${proves.length} prove the change${weak ? ` (${weak} couldn't run at base)` : ''} · ${loose} pass without it`);
  }

  lines.push('', '### Findings');
  if (!r.findings.length) lines.push('None.');
  for (const f of r.findings) lines.push(findingLine(f));

  if (r.risks.length) {
    lines.push('', '### Review these first');
    r.risks.slice(0, 5).forEach((risk, i) => lines.push(`${i + 1}. ${code(risk.file)}: ${risk.reasons.join(', ')}`));
  }
  return `${lines.join('\n')}\n`;
}
