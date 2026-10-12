import { join } from 'node:path';
import { runnerFiles, RUNNER_NAME, type InitContext, type InitPlan } from './core.js';

/**
 * The plugin text. It stays a thin shell around the copied runner: the runner finds trustbut (TRUSTBUT_BIN,
 * PATH, npx), enforces the time budget and never fails the agent; `trustbut hook opencode` keeps the retry
 * counter and the unchanged-tree check. OpenCode loads every export of a plugin file as a plugin, so there is
 * exactly one export.
 */
export function opencodePluginSource(runnerPath: string): string {
  return `// trustbut: verifies the working tree whenever an OpenCode session goes idle and, on a FAIL, sends the
// findings back to the agent. Written by \`trustbut init opencode\`; edit freely, rerun init to update.
//
// This targets the OpenCode V1 plugin API (opencode-ai 1.x: \`event\` hook, \`session.idle\`,
// \`client.session.prompt\`); see https://opencode.ai/docs/plugins. OpenCode V2 (@opencode/plugin) has a different
// plugin API and does not run this file; V2 support is a follow-up.
//
// OpenCode cannot veto "done", so a FAIL becomes a follow-up prompt. At most 3 per session in a row (reset
// by a pass); subagent (child) sessions are skipped.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const RUNNER = ${JSON.stringify(runnerPath)};
const MAX_RETRIES = 3;

function runTrustbut(directory, sessionID) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn('node', [resolve(directory, RUNNER), 'opencode'], { cwd: directory, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return done({ code: 0, out: '' });
    }
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => done({ code: 0, out: '' }));
    child.on('close', (code) => done({ code: code ?? 0, out }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ session_id: sessionID, cwd: directory }));
  });
}

export const Trustbut = async ({ client, directory }) => {
  const tries = new Map();
  const busy = new Set();
  return {
    event: async ({ event }) => {
      if (event.type !== 'session.idle') return;
      const id = event.properties.sessionID;
      if (busy.has(id)) return;
      busy.add(id);
      try {
        const session = await client.session.get({ path: { id } }).catch(() => undefined);
        if (session?.data?.parentID) return;
        const { code, out } = await runTrustbut(directory, id);
        if (code !== 1 || out.trim() === '') return void tries.delete(id);
        const n = (tries.get(id) ?? 0) + 1;
        tries.set(id, n);
        if (n > MAX_RETRIES) return;
        // Don't await: the prompt call returns only when the agent has finished answering.
        void client.session.prompt({ path: { id }, body: { parts: [{ type: 'text', text: out }] } }).catch(() => {});
      } finally {
        busy.delete(id);
      }
    },
  };
};
`;
}

export function planOpencode(ctx: InitContext): InitPlan {
  const base = ctx.user ? join(ctx.home, '.config', 'opencode') : join(ctx.root, '.opencode');
  const runnerDir = join(base, 'hooks');
  const runnerPath = ctx.user ? join(runnerDir, RUNNER_NAME) : `.opencode/hooks/${RUNNER_NAME}`;
  return {
    files: [...runnerFiles(runnerDir), { path: join(base, 'plugins', 'trustbut.js'), content: opencodePluginSource(runnerPath) }],
    notes: ['The plugin uses the OpenCode V1 plugin API (opencode-ai 1.x); OpenCode V2 support is a follow-up.'],
  };
}
