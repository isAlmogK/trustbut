import type { ChangedFile, Finding, RiskItem } from './types.js';

// Whole path words (lowercased) that signal auth/permission code.
const AUTH_WORDS = new Set([
  'auth', 'authn', 'authz', 'authentication', 'authorization', 'login', 'session', 'sessions',
  'permission', 'permissions', 'acl', 'acls', 'rbac', 'oauth', 'jwt', 'password', 'passwords',
]);

// Basename-only secret files. `.env.example`, `.env.sample`, `.env.template`, `.env.dist` are not secrets.
const SECRET_BASENAME = /^(\.env(?!\.(example|sample|template|dist)$)(\..*)?|secrets?(\..*)?|credentials?(\..*)?)$/i;

/** Splits a path into lowercase words on separators and camelCase boundaries. */
function pathWords(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

interface Rule {
  weight: number;
  why: string;
  hits: (path: string) => boolean;
}

const RULES: Rule[] = [
  { weight: 3, why: 'auth/permissions', hits: (p) => pathWords(p).some((w) => AUTH_WORDS.has(w)) },
  { weight: 3, why: 'database migration', hits: (p) => /(^|\/)migrations?\//i.test(p) },
  { weight: 3, why: 'CI pipeline', hits: (p) => /(^|\/)\.github\/workflows\/|\.gitlab-ci\.yml$|(^|\/)Jenkinsfile$/.test(p) },
  { weight: 3, why: 'secrets/env', hits: (p) => SECRET_BASENAME.test(basename(p)) },
  {
    weight: 2,
    why: 'dependencies',
    hits: (p) => /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock)$/.test(p),
  },
  { weight: 2, why: 'infrastructure', hits: (p) => /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml)$|\.tf$|(^|\/)(infra|terraform|k8s|helm)\//.test(p) },
  { weight: 2, why: 'agent config', hits: (p) => /(^|\/)(\.claude|\.codex|\.gemini|\.cursor)\/|(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$/.test(p) },
];

export function rankRisks(changes: ChangedFile[], findings: Finding[]): RiskItem[] {
  return changes
    .map((c) => {
      let score = 0;
      const reasons: string[] = [];
      if (c.kind !== 'test') {
        for (const rule of RULES) {
          if (rule.hits(c.path)) {
            score += rule.weight;
            reasons.push(rule.why);
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
    // Code-unit comparison: deterministic and independent of the host locale.
    .sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
