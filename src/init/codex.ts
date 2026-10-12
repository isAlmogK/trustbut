import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeHook, parseConfig, runnerFiles, runsRunner, RUNNER_NAME, type InitContext, type InitPlan } from './core.js';

/** `.codex/hooks.json` Stop hook. Codex runs commands in the session cwd, so a project hook resolves the git root. */
export function planCodex(ctx: InitContext): InitPlan {
  const base = ctx.user ? join(ctx.home, '.codex') : join(ctx.root, '.codex');
  const file = join(base, 'hooks.json');
  const script = ctx.user ? join(base, 'hooks', RUNNER_NAME) : `$(git rev-parse --show-toplevel)/.codex/hooks/${RUNNER_NAME}`;
  const hook = { type: 'command', command: `node "${script}" codex`, timeout: 600, statusMessage: 'trustbut verify' };
  const config = parseConfig(file, existsSync(file) ? readFileSync(file, 'utf8') : undefined);
  return {
    files: [...runnerFiles(join(base, 'hooks')), { path: file, content: mergeHook(file, config, 'Stop', runsRunner, {}, hook) }],
    notes: ['Codex asks you to approve new hooks: open /hooks and approve "trustbut verify" (needs Codex 0.129 or later).', ...(ctx.user ? [] : ['Project hooks load only in trusted projects.'])],
  };
}
