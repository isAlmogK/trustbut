import type { Finding, Receipt, RunResult } from './types.js';

const ICON = { fail: '✖', warn: '⚠', info: 'ℹ' } as const;

function tally(run: RunResult) {
  const t = { pass: 0, fail: 0, error: 0, skip: 0 };
  for (const c of run.cases) t[c.outcome] += 1;
  return t;
}

function findingLine(f: Finding): string {
  const where = f.file ? ` · \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
  const detail = f.detail ? `: ${f.detail}` : '';
  return `- ${ICON[f.severity]} **${f.title}**${where}${detail}`;
}

export function renderMarkdown(r: Receipt): string {
  const lines: string[] = [];
  lines.push(`## 🧾 Receipt: ${r.verdict.toUpperCase()}`, '');
  lines.push(`\`${r.base.slice(0, 7)}\` → \`${r.head.slice(0, 7)}\`${r.runner ? ` · runner: ${r.runner}` : ''}`, '');

  if (r.after) {
    const t = tally(r.after);
    lines.push(`**Tests (clean checkout):** ${t.pass} passed · ${t.fail + t.error} failed · ${t.skip} skipped`);
  } else {
    lines.push('**Tests:** not run');
  }
  if (r.proofs.length) {
    const proves = r.proofs.filter((p) => p.verdict === 'proves-change');
    const weak = proves.filter((p) => p.weak).length;
    const loose = r.proofs.filter((p) => p.verdict === 'does-not-constrain').length;
    lines.push(`**New/changed tests:** ${proves.length} prove the change${weak ? ` (${weak} only because the code didn't exist yet)` : ''} · ${loose} pass without it`);
  }

  lines.push('', '### Findings');
  if (!r.findings.length) lines.push('None.');
  for (const f of r.findings) lines.push(findingLine(f));

  if (r.risks.length) {
    lines.push('', '### Review these first');
    r.risks.slice(0, 5).forEach((risk, i) => lines.push(`${i + 1}. \`${risk.file}\`: ${risk.reasons.join(', ')}`));
  }
  return `${lines.join('\n')}\n`;
}
