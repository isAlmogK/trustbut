import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INIT_AGENTS, InitError, runInit, type InitAgent } from '../src/init/index.js';
import { VERSION } from '../src/version.js';

const ROOT = resolve(import.meta.dirname, '..');
const RUN = join(ROOT, 'integrations', 'claude-code', 'scripts', 'run.mjs');
const GOLDEN = join(ROOT, 'test', 'fixtures', 'init');

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trustbut-init-'));
  home = mkdtempSync(join(tmpdir(), 'trustbut-home-'));
});
afterEach(() => {
  delete process.env.TRUSTBUT_BIN;
});

const init = (agent: InitAgent, o: { dryRun?: boolean; user?: boolean } = {}) => runInit({ agent, cwd: dir, home, ...o });
const write = (base: string, rel: string, text: string) => {
  mkdirSync(join(base, rel, '..'), { recursive: true });
  writeFileSync(join(base, rel), text);
};
const read = (base: string, rel: string) => readFileSync(join(base, rel), 'utf8');
const tree = (base: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name).slice(base.length + 1)));
  };
  walk(base);
  return out.sort();
};

const CONFIG: Record<InitAgent, string | undefined> = {
  claude: '.claude/settings.json',
  codex: '.codex/hooks.json',
  gemini: '.gemini/settings.json',
  opencode: undefined,
};
const RUNNER_AT: Record<InitAgent, string> = {
  claude: '.claude/hooks',
  codex: '.codex/hooks',
  gemini: '.gemini/hooks',
  opencode: '.opencode/hooks',
};
const JSON_AGENTS = ['claude', 'codex', 'gemini'] as const;

describe('init: empty project', () => {
  it.each(JSON_AGENTS)('%s: writes the golden config', async (agent) => {
    await init(agent);
    expect(read(dir, CONFIG[agent]!)).toBe(readFileSync(join(GOLDEN, `${agent}.json`), 'utf8'));
  });

  it('claude entry is exec form with the project-dir placeholder', async () => {
    await init('claude');
    expect(JSON.parse(read(dir, '.claude/settings.json')).hooks.Stop[0].hooks[0]).toEqual({
      type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/trustbut-run.mjs', 'claude'], timeout: 600,
    });
  });

  it.each(INIT_AGENTS)('%s: the copied runner is byte-identical to the plugin runner, with its version file', async (agent) => {
    await init(agent);
    expect(readFileSync(join(dir, RUNNER_AT[agent], 'trustbut-run.mjs')).equals(readFileSync(RUN))).toBe(true);
    expect(JSON.parse(read(dir, `${RUNNER_AT[agent]}/trustbut-run.json`))).toEqual({ version: VERSION });
  });

  it('the copied runner finds its version without a plugin.json', async () => {
    await init('claude');
    const mod = await import(join(dir, '.claude/hooks/trustbut-run.mjs'));
    expect(mod.pluginVersion()).toBe(VERSION);
  });

  it('opencode: writes a plugin that passes node --check', async () => {
    await init('opencode');
    const plugin = join(dir, '.opencode/plugins/trustbut.js');
    expect(() => execFileSync('node', ['--check', plugin])).not.toThrow();
    expect(read(dir, '.opencode/plugins/trustbut.js')).toContain('V1');
  });
});

describe('init: existing configs keep other hooks', () => {
  it('claude', async () => {
    write(dir, '.claude/settings.json', JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }));
    await init('claude');
    const cfg = JSON.parse(read(dir, '.claude/settings.json'));
    expect(cfg.model).toBe('x');
    expect(cfg.hooks.PreToolUse).toHaveLength(1);
    expect(cfg.hooks.Stop).toHaveLength(2);
    expect(cfg.hooks.Stop[0].hooks[0].command).toBe('echo done');
    expect(cfg.hooks.Stop[1].hooks[0].args[1]).toBe('claude');
  });

  it('codex', async () => {
    write(dir, '.codex/hooks.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }], SessionStart: [{ hooks: [{ type: 'command', command: 's' }] }] } }));
    await init('codex');
    const cfg = JSON.parse(read(dir, '.codex/hooks.json'));
    expect(cfg.hooks.SessionStart).toHaveLength(1);
    expect(cfg.hooks.Stop.map((g: { hooks: { command: string }[] }) => g.hooks[0].command)).toEqual([
      'other',
      'node "$(git rev-parse --show-toplevel)/.codex/hooks/trustbut-run.mjs" codex',
    ]);
    expect(cfg.hooks.Stop[1].hooks[0].timeout).toBe(600);
  });

  it('gemini', async () => {
    write(dir, '.gemini/settings.json', JSON.stringify({ theme: 'dark', hooks: { AfterAgent: [{ matcher: '*', hooks: [{ name: 'mine', type: 'command', command: 'x' }] }] } }));
    await init('gemini');
    const cfg = JSON.parse(read(dir, '.gemini/settings.json'));
    expect(cfg.theme).toBe('dark');
    expect(cfg.hooks.AfterAgent).toHaveLength(2);
    expect(cfg.hooks.AfterAgent[1]).toEqual({
      matcher: '*',
      hooks: [{ name: 'trustbut-verify', type: 'command', command: 'node "$GEMINI_PROJECT_DIR/.gemini/hooks/trustbut-run.mjs" gemini', timeout: 600000 }],
    });
  });

  it('a stale trustbut entry is updated in place, not duplicated', async () => {
    write(dir, '.codex/hooks.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node old/trustbut-run.mjs codex', timeout: 5 }, { type: 'command', command: 'keep' }] }] } }));
    await init('codex');
    const hooks = JSON.parse(read(dir, '.codex/hooks.json')).hooks.Stop[0].hooks;
    expect(hooks).toHaveLength(2);
    expect(hooks[0].timeout).toBe(600);
    expect(hooks[1].command).toBe('keep');
  });
});

describe('init: idempotency and dry run', () => {
  it.each(INIT_AGENTS)('%s: a second run changes nothing', async (agent) => {
    await init(agent);
    const snapshot = Object.fromEntries(tree(dir).map((f) => [f, read(dir, f)]));
    const second = await init(agent);
    expect(second).toContain('Nothing to change');
    expect(Object.fromEntries(tree(dir).map((f) => [f, read(dir, f)]))).toEqual(snapshot);
  });

  it.each(INIT_AGENTS)('%s: --dry-run prints the change and writes nothing', async (agent) => {
    const out = await init(agent, { dryRun: true });
    expect(out).toContain('create ');
    expect(out).toContain('Dry run: nothing was written.');
    expect(tree(dir)).toEqual([]);
  });

  it('--dry-run on an existing config shows the diff and leaves the file alone', async () => {
    write(dir, '.claude/settings.json', '{"model":"x"}');
    const out = await init('claude', { dryRun: true });
    expect(out).toContain('update ');
    expect(out).toContain('+  "hooks"');
    expect(read(dir, '.claude/settings.json')).toBe('{"model":"x"}');
    expect(existsSync(join(dir, '.claude/hooks'))).toBe(false);
  });
});

describe('init: unparsable config', () => {
  it.each(JSON_AGENTS)('%s: refuses malformed JSON and writes nothing else', async (agent) => {
    write(dir, CONFIG[agent]!, '{ not json');
    await expect(init(agent)).rejects.toBeInstanceOf(InitError);
    expect(read(dir, CONFIG[agent]!)).toBe('{ not json');
    expect(tree(dir)).toEqual([CONFIG[agent]]);
  });

  it('refuses a hooks value of the wrong shape', async () => {
    write(dir, '.claude/settings.json', '{"hooks":{"Stop":"x"}}');
    await expect(init('claude')).rejects.toThrow(/not an array/);
  });

  it('the CLI exits 2 with a clear message', async () => {
    write(dir, '.claude/settings.json', '{ nope');
    const r = await execa(join(ROOT, 'node_modules/.bin/tsx'), [join(ROOT, 'src/cli.ts'), 'init', 'claude'], { cwd: dir, reject: false });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('not valid JSON');
  });
});

describe('init: comments, indent, atomic writes', () => {
  it('refuses a settings file with comments (exit 2 path) and prints the snippet to add by hand', async () => {
    write(dir, '.claude/settings.json', '{\n  // my notes\n  "model": "x"\n}\n');
    await expect(init('claude')).rejects.toThrow(/has comments, which init can't preserve[\s\S]*"Stop"[\s\S]*trustbut-run\.mjs/);
    expect(tree(dir)).toEqual(['.claude/settings.json']);
  });

  it.each([['\t'], ['    '], ['  ']])('keeps the existing indent %j', async (indent) => {
    write(dir, '.gemini/settings.json', JSON.stringify({ theme: 'dark' }, null, indent));
    await init('gemini');
    expect(read(dir, '.gemini/settings.json')).toContain(`\n${indent}"theme"`);
  });

  it('leaves no temp files behind', async () => {
    await init('codex');
    expect(tree(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('says where project files went and that agents read them from their launch dir', async () => {
    expect(await init('claude', { dryRun: true })).toMatch(/git root[\s\S]*launched in/);
  });
});

describe('init --user', () => {
  it('claude: user settings with an absolute runner path', async () => {
    await init('claude', { user: true });
    const hook = JSON.parse(read(home, '.claude/settings.json')).hooks.Stop[0].hooks[0];
    expect(hook.args).toEqual([join(home, '.claude/hooks/trustbut-run.mjs'), 'claude']);
    expect(existsSync(join(home, '.claude/hooks/trustbut-run.mjs'))).toBe(true);
    expect(tree(dir)).toEqual([]);
  });

  it('codex and gemini reference the runner by absolute path', async () => {
    await init('codex', { user: true });
    await init('gemini', { user: true });
    expect(JSON.parse(read(home, '.codex/hooks.json')).hooks.Stop[0].hooks[0].command).toBe(`node "${join(home, '.codex/hooks/trustbut-run.mjs')}" codex`);
    expect(JSON.parse(read(home, '.gemini/settings.json')).hooks.AfterAgent[0].hooks[0].command).toBe(`node "${join(home, '.gemini/hooks/trustbut-run.mjs')}" gemini`);
  });

  it('opencode: plugin under ~/.config/opencode/plugins', async () => {
    await init('opencode', { user: true });
    expect(existsSync(join(home, '.config/opencode/plugins/trustbut.js'))).toBe(true);
    expect(read(home, '.config/opencode/plugins/trustbut.js')).toContain("new URL('../hooks/trustbut-run.mjs', import.meta.url)");
    expect(existsSync(join(home, '.config/opencode/hooks/trustbut-run.mjs'))).toBe(true);
  });
});

describe('init: printed notes', () => {
  it('mentions the plugin alternative, /hooks approval and the trusted-folder note', async () => {
    expect(await init('claude', { dryRun: true })).toContain('/plugin install trustbut@trustbut');
    expect(await init('codex', { dryRun: true })).toMatch(/\/hooks[\s\S]*trusted projects/);
    expect(await init('gemini', { dryRun: true })).toContain('trusted folders');
  });
});

describe('opencode plugin behaviour (fake client, fake trustbut)', () => {
  /** A fake `trustbut`: prints FEEDBACK and exits 1 for `hook opencode` while FAILS lasts, else exits 0. */
  const fakeTrustbut = (verdicts: string[]) => {
    const bin = join(dir, 'fake-trustbut');
    const state = join(dir, 'fake-state');
    writeFileSync(state, '0');
    writeFileSync(
      bin,
      `#!/bin/sh\nn=$(cat "${state}"); echo $((n+1)) > "${state}"\nv=$(echo "${verdicts.join(' ')}" | cut -d' ' -f$((n+1)))\n[ "$1 $2" = "hook opencode" ] || exit 9\nif [ "$v" = fail ]; then echo "FEEDBACK $((n+1))"; exit 1; fi\nexit 0\n`,
    );
    chmodSync(bin, 0o755);
    process.env.TRUSTBUT_BIN = bin;
  };
  const load = async (fromSubdir = false) => {
    await init('opencode');
    const sub = join(dir, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    const mod = await import(`${join(dir, '.opencode/plugins/trustbut.js')}?${Math.random()}`);
    const prompts: { path: { id: string }; body: { parts: { type: string; text: string }[] } }[] = [];
    const client = {
      session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: path.id.startsWith('child') ? { parentID: 'p' } : {} }),
        prompt: async (arg: (typeof prompts)[number]) => void prompts.push(arg),
      },
    };
    const hooks = await mod.Trustbut({ client, directory: fromSubdir ? sub : dir });
    const idle = (sessionID: string) => hooks.event({ event: { type: 'session.idle', properties: { sessionID } } });
    return { prompts, idle, hooks, mod, sub: fromSubdir ? sub : undefined };
  };

  it('exports a single plugin function', async () => {
    fakeTrustbut(['pass']);
    const { mod } = await load();
    expect(Object.keys(mod)).toEqual(['Trustbut']);
  });

  it('sends the feedback back on a FAIL, via client.session.prompt', async () => {
    fakeTrustbut(['fail']);
    const { prompts, idle } = await load();
    await idle('s1');
    expect(prompts).toEqual([{ path: { id: 's1' }, body: { parts: [{ type: 'text', text: 'FEEDBACK 1\n' }] } }]);
  });

  it('does nothing on a pass, ignores other events and skips child sessions', async () => {
    fakeTrustbut(['pass', 'fail']);
    const { prompts, idle, hooks } = await load();
    await hooks.event({ event: { type: 'session.error', properties: { sessionID: 's1' } } });
    await idle('child-1');
    await idle('s1');
    expect(prompts).toEqual([]);
  });

  it('has a defensive cap of 10 in a row and resets on a pass (hook.maxRetries governs below that)', async () => {
    fakeTrustbut([...Array(12).fill('fail'), 'pass', 'fail']);
    const { prompts, idle } = await load();
    for (let i = 0; i < 12; i++) await idle('s1');
    expect(prompts).toHaveLength(10);
    await idle('s1'); // pass: counter resets
    await idle('s1'); // fail again
    expect(prompts).toHaveLength(11);
  });

  it('works when OpenCode runs from a subdirectory of the repo', async () => {
    fakeTrustbut(['fail']);
    const { prompts, hooks, sub } = await load(true);
    expect(sub).toBeTruthy();
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
    expect(prompts).toHaveLength(1);
  });

  it('skips the idle that follows a user abort', async () => {
    fakeTrustbut(['fail']);
    const { prompts, idle, hooks } = await load();
    await hooks.event({ event: { type: 'session.error', properties: { sessionID: 's1', error: { name: 'MessageAbortedError' } } } });
    await idle('s1');
    expect(prompts).toEqual([]);
    await idle('s1'); // only that one idle is skipped
    expect(prompts).toHaveLength(1);
  });

  it('tells trustbut whether this is a retry via stop_hook_active', async () => {
    const bin = join(dir, 'fake-trustbut');
    const log = join(dir, 'stdin.log');
    writeFileSync(bin, `#!/bin/sh\ncat >> "${log}"; echo >> "${log}"\necho FB; exit 1\n`);
    chmodSync(bin, 0o755);
    process.env.TRUSTBUT_BIN = bin;
    const { idle } = await load();
    await idle('s1');
    await idle('s1');
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.stop_hook_active)).toEqual([false, true]);
    expect(lines[0].session_id).toBe('s1');
  });

  it('never throws or prompts when trustbut is missing', async () => {
    process.env.TRUSTBUT_BIN = join(dir, 'does-not-exist');
    const { prompts, idle } = await load();
    await idle('s1');
    expect(prompts).toEqual([]);
  });
});
