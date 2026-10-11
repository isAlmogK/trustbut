import type { ChangedFile, Finding, RiskItem } from './types.js';

const RULES: [RegExp, number, string][] = [
  [/auth|login|session|permission|acl|rbac|oauth|jwt|password/i, 3, 'auth/permissions'],
  [/(^|\/)migrations?\//i, 3, 'database migration'],
  [/(^|\/)\.github\/workflows\/|\.gitlab-ci\.yml$|(^|\/)Jenkinsfile$/, 3, 'CI pipeline'],
  [/(^|\/)(\.env[^/]*|secrets?[^/]*|credentials?[^/]*)$/i, 3, 'secrets/env'],
  [/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock)$/, 2, 'dependencies'],
  [/(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml)$|\.tf$|(^|\/)(infra|terraform|k8s|helm)\//, 2, 'infrastructure'],
  [/(^|\/)(\.claude|\.codex|\.gemini|\.cursor)\/|(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$/, 2, 'agent config'],
];

export function rankRisks(changes: ChangedFile[], findings: Finding[]): RiskItem[] {
  return changes
    .map((c) => {
      let score = 0;
      const reasons: string[] = [];
      if (c.kind !== 'test') {
        for (const [re, weight, why] of RULES) {
          if (re.test(c.path)) {
            score += weight;
            reasons.push(why);
          }
        }
      }
      if (findings.some((f) => f.file === c.path && f.severity !== 'info')) {
        score += 2;
        reasons.push('has findings');
      }
      const size = c.added.length + c.removed.length;
      if (size > 200) {
        score += 1;
        reasons.push(`large change (${size} lines)`);
      }
      return { file: c.path, score, reasons };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}
