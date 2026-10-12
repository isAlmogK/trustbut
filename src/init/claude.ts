import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeHook, runnerFiles, runsRunner, RUNNER_NAME, type InitContext, type InitPlan } from './core.js';

/** `.claude/settings.json` Stop hook running the copied runner in exec form (no shell quoting). */
export function planClaude(ctx: InitContext): InitPlan {
  const base = ctx.user ? join(ctx.home, '.claude') : join(ctx.root, '.claude');
  const runner = join(base, 'hooks', RUNNER_NAME);
  const settings = join(base, 'settings.json');
  const hook = {
    type: 'command',
    command: 'node',
    args: [ctx.user ? runner : `\${CLAUDE_PROJECT_DIR}/.claude/hooks/${RUNNER_NAME}`, 'claude'],
    timeout: 600,
  };
  const text = existsSync(settings) ? readFileSync(settings, 'utf8') : undefined;
  return {
    files: [...runnerFiles(join(base, 'hooks')), { path: settings, content: mergeHook(settings, text, 'Stop', runsRunner, {}, hook) }],
    notes: ['Or install it as a plugin instead: /plugin marketplace add isAlmogK/trustbut, then /plugin install trustbut@trustbut'],
  };
}
