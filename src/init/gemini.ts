import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeHook, runnerFiles, runsRunner, RUNNER_NAME, type InitContext, type InitPlan } from './core.js';

export const GEMINI_HOOK_NAME = 'trustbut-verify';

/** `.gemini/settings.json` AfterAgent hook; Gemini's timeout is in milliseconds (its default is only 60 s). */
export function planGemini(ctx: InitContext): InitPlan {
  const base = ctx.user ? join(ctx.home, '.gemini') : join(ctx.root, '.gemini');
  const file = join(base, 'settings.json');
  const script = ctx.user ? join(base, 'hooks', RUNNER_NAME) : `$GEMINI_PROJECT_DIR/.gemini/hooks/${RUNNER_NAME}`;
  const hook = { name: GEMINI_HOOK_NAME, type: 'command', command: `node "${script}" gemini`, timeout: 600000 };
  const text = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  const ours = (h: Record<string, unknown>) => h.name === GEMINI_HOOK_NAME || runsRunner(h);
  return {
    files: [...runnerFiles(join(base, 'hooks')), { path: file, content: mergeHook(file, text, 'AfterAgent', ours, { matcher: '*' }, hook) }],
    notes: ['Project hooks run only in trusted folders: trust this folder in Gemini CLI if the hook does not fire. Needs Gemini CLI 0.35 or later.'],
  };
}
