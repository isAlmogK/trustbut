import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { runHook, type HookOptions } from '../src/commands/hook.js';
import { AGENTS, type Agent } from '../src/hook/protocols.js';
import { readState, stateFile, writeState } from '../src/hook/state.js';
import { branch, commitAll, makeRepo, writeFiles } from './helpers/repo.js';

const readAttempts = async (file: string) => (await readState(file)).state.attempts;
const writeAttempts = (file: string, attempts: number) => writeState(file, { attempts });

// A fake test suite for the `command` runner: test/lib.test.js › works passes when src/lib.js says "good".
const RUN_SH = `if grep -q good src/lib.js; then o=pass; else o=fail; fi
printf '<?xml version="1.0"?><testsuite name="s"><testcase classname="lib" name="works" file="test/lib.test.js">'
if [ $o = fail ]; then printf '<failure message="expected good"/>'; fi
printf '</testcase></testsuite>\\n'
[ $o = pass ]
`;

type Scenario = 'pass' | 'warn' | 'fail' | 'error' | 'no-changes';

interface Fixture {
  dir: string;
  stateDir: string;
  receipt: string;
  hook: (agent: Agent, input?: Record<string, unknown> | string, extra?: Partial<HookOptions>) => ReturnType<typeof runHook>;
}

async function fixture(scenario: Scenario, config: Record<string, unknown> = {}): Promise<Fixture> {
  const baseLib = scenario === 'warn' ? 'good v1' : 'none';
  const cfg = scenario === 'error' ? { runner: 'command', ...config } : { command: 'sh run.sh', ...config };
  const made = await makeRepo({ '.trustbut.json': JSON.stringify(cfg), 'run.sh': RUN_SH, 'src/lib.js': `export const v = '${baseLib}';\n` });
  const dir = await realpath(made.dir);
  const lib = { pass: 'good', warn: 'good v2', fail: 'bad', error: 'good', 'no-changes': null }[scenario];
  if (lib !== null) await writeFiles(dir, { 'src/lib.js': `export const v = '${lib}';\n`, 'test/lib.test.js': "it('works', () => {});\n" });
  const stateDir = await mkdtemp(join(tmpdir(), 'tb-hook-state-'));
  const hook: Fixture['hook'] = (agent, input = { session_id: 'sess-1', cwd: dir, stop_hook_active: false }, extra = {}) =>
    runHook({ agent, stdin: typeof input === 'string' ? input : JSON.stringify(input), env: {}, cwd: tmpdir(), stateDir, ...extra });
  return { dir, stateDir, receipt: join(dir, '.git', 'trustbut', 'last-receipt.md'), hook };
}

const FAIL_FEEDBACK = (receipt: string) =>
  [
    'trustbut verdict: FAIL',
    '',
    'Tests (clean checkout of your work, changed test files only): 0 passed · 1 failed · 0 skipped',
    '',
    '### Must fix',
    '- Test suite fails at head (clean checkout): exit code 1',
    '',
    '### Failing tests',
    '- `test/lib.test.js` › works: expected good',
    '',
    '### Test output (last lines)',
    '```',
    '<?xml version="1.0"?><testsuite name="s"><testcase classname="lib" name="works" file="test/lib.test.js"><failure message="expected good"/></testcase></testsuite>',
    '```',
    '',
    'Fix these and finish again; run `trustbut verify --working --quick` to check.',
    `Full receipt: \`${receipt}\``,
    '',
  ].join('\n');

const msg = (text: string) => `${JSON.stringify({ systemMessage: text })}\n`;

describe.concurrent('trustbut hook: protocol golden outputs', () => {
  describe.each(AGENTS)('%s', (agent) => {
    it('FAIL: sends the feedback back to the agent', async () => {
      const f = await fixture('fail');
      const r = await f.hook(agent);
      const summary = 'trustbut FAIL: 1 failing test — sent back to the agent (attempt 1/3)';
      if (agent === 'claude') {
        expect(r).toMatchObject({ exitCode: 0, stderr: '' });
        expect(JSON.parse(r.stdout)).toEqual({ decision: 'block', reason: FAIL_FEEDBACK(f.receipt), systemMessage: summary });
        expect(r.stdout.endsWith('}\n')).toBe(true);
      } else {
        expect(r).toMatchObject({ exitCode: 2, stdout: '', stderr: FAIL_FEEDBACK(f.receipt) });
      }
      expect(await readFile(f.receipt, 'utf8')).toMatch(/^## 🧾 Receipt: FAIL/);
    });

    it('FAIL at the retry limit: lets the agent finish and tells the user', async () => {
      const f = await fixture('fail', { hook: { maxRetries: 2 } });
      expect((await f.hook(agent)).exitCode).toBe(agent === 'claude' ? 0 : 2);
      const second = await f.hook(agent, { session_id: 'sess-1', cwd: f.dir, stop_hook_active: true });
      if (agent === 'claude') expect(JSON.parse(second.stdout).systemMessage).toBe('trustbut FAIL: 1 failing test — sent back to the agent (attempt 2/2)');
      else expect(second.exitCode).toBe(2);
      const third = await f.hook(agent, { session_id: 'sess-1', cwd: f.dir, stop_hook_active: true });
      expect(third).toEqual({ exitCode: 0, stdout: msg(`trustbut still FAIL after 2 attempts — receipt: ${f.receipt}`), stderr: '' });
      // Letting the agent finish ends the chain: the next turn starts counting again.
      expect(await readAttempts(stateFile(f.stateDir, 'sess-1', f.dir))).toBe(0);
    });

    it('PASS: tells the user', async () => {
      const f = await fixture('pass');
      expect(await f.hook(agent)).toEqual({
        exitCode: 0,
        stdout: msg('trustbut PASS: 1 test passed (changed test files only), 1 new/changed test proves the change'),
        stderr: '',
      });
    });

    it('WARN: lists the finding titles and the receipt path', async () => {
      const f = await fixture('warn');
      expect(await f.hook(agent)).toEqual({ exitCode: 0, stdout: msg(`trustbut WARN: Test passes without the change — receipt: ${f.receipt}`), stderr: '' });
    });

    it("error: says it couldn't verify and never blocks", async () => {
      const f = await fixture('error');
      expect(await f.hook(agent)).toEqual({
        exitCode: 0,
        stdout: msg(`trustbut couldn't verify: The command runner needs a "command" in .trustbut.json`),
        stderr: '',
      });
    });

    it('no changes: allows silently', async () => {
      const f = await fixture('no-changes');
      expect(await f.hook(agent)).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    });
  });
});

describe.concurrent('trustbut hook: input and skip rules', () => {
  it.each(['', '   ', '{ not json', '[1,2]', 'null'])('tolerates stdin %j (treated as {})', async (stdin) => {
    const f = await fixture('fail');
    const r = await f.hook('codex', stdin, { cwd: f.dir });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('trustbut verdict: FAIL');
  });

  it('keeps blocking on stop_hook_active: true until the retry budget is used', async () => {
    const f = await fixture('fail', { hook: { maxRetries: 1 } });
    const input = { session_id: 's', cwd: f.dir, stop_hook_active: true };
    expect((await f.hook('gemini', input)).exitCode).toBe(2);
    expect((await f.hook('gemini', input)).exitCode).toBe(0);
  });

  it('counts retries per session', async () => {
    const f = await fixture('fail', { hook: { maxRetries: 1 } });
    expect((await f.hook('codex', { session_id: 'a', cwd: f.dir })).exitCode).toBe(2);
    expect((await f.hook('codex', { session_id: 'b', cwd: f.dir })).exitCode).toBe(2);
    expect((await f.hook('codex', { session_id: 'a', cwd: f.dir })).exitCode).toBe(0);
  });

  it('finds the project from CLAUDE_PROJECT_DIR, then GEMINI_PROJECT_DIR, then the input cwd, then the process cwd', async () => {
    const f = await fixture('fail');
    const elsewhere = await mkdtemp(join(tmpdir(), 'tb-not-git-'));
    // A fresh session each time, so the retry budget never runs out here.
    expect((await f.hook('codex', { session_id: '1' }, { env: { CLAUDE_PROJECT_DIR: f.dir, GEMINI_PROJECT_DIR: elsewhere }, cwd: elsewhere })).exitCode).toBe(2);
    expect((await f.hook('codex', { session_id: '2' }, { env: { GEMINI_PROJECT_DIR: f.dir }, cwd: elsewhere })).exitCode).toBe(2);
    expect((await f.hook('codex', { session_id: '3', cwd: elsewhere }, { env: { GEMINI_PROJECT_DIR: f.dir } })).exitCode).toBe(2);
    expect((await f.hook('codex', { session_id: '4', cwd: f.dir }, { cwd: elsewhere })).exitCode).toBe(2);
    expect((await f.hook('codex', { session_id: '5' }, { cwd: f.dir })).exitCode).toBe(2);
    expect((await f.hook('codex', { session_id: '6', cwd: elsewhere }, { cwd: f.dir })).exitCode).toBe(0);
  });

  it('skips outside a git repository', async () => {
    const f = await fixture('fail');
    const elsewhere = await mkdtemp(join(tmpdir(), 'tb-not-git-'));
    for (const agent of AGENTS) expect(await f.hook(agent, { cwd: elsewhere })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it.each(['1', 'true'])('skips with TRUSTBUT_SKIP=%s', async (value) => {
    const f = await fixture('fail');
    for (const agent of AGENTS) expect(await f.hook(agent, undefined, { env: { TRUSTBUT_SKIP: value } })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(existsSync(f.receipt)).toBe(false);
  });

  it('skips with hook.enabled: false', async () => {
    const f = await fixture('fail', { hook: { enabled: false } });
    for (const agent of AGENTS) expect(await f.hook(agent)).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('reads hook settings as committed, so an uncommitted edit cannot switch the hook off', async () => {
    const f = await fixture('fail');
    await writeFiles(f.dir, { '.trustbut.json': JSON.stringify({ command: 'sh run.sh', hook: { enabled: false } }) });
    expect((await f.hook('codex')).exitCode).toBe(2);
  });

  it("an invalid config is a couldn't-verify message, not a block", async () => {
    const f = await fixture('fail', { hook: { mode: 'fast' } });
    const r = await f.hook('gemini');
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).systemMessage).toBe(`trustbut couldn't verify: Invalid .trustbut.json: "hook.mode" must be "quick" or "full"`);
  });
});

describe.concurrent('trustbut hook: settings', () => {
  it('mode "full" reruns the whole suite', async () => {
    const f = await fixture('pass', { hook: { mode: 'full' } });
    const r = await f.hook('claude');
    expect(JSON.parse(r.stdout).systemMessage).toBe('trustbut PASS: 1 test passed, 1 new/changed test proves the change');
  });

  it('maxRetries: 0 reports a FAIL without sending it back', async () => {
    const f = await fixture('fail', { hook: { maxRetries: 0 } });
    expect(await f.hook('codex')).toEqual({
      exitCode: 0,
      stdout: msg(`trustbut FAIL: 1 failing test — not sent back to the agent (hook.maxRetries is 0); receipt: ${f.receipt}`),
      stderr: '',
    });
  });

  it('a PASS resets the retry counter', async () => {
    const f = await fixture('pass');
    const file = stateFile(f.stateDir, 'sess-1', f.dir);
    await writeAttempts(file, 2);
    await f.hook('claude');
    expect((await readState(file)).state).toMatchObject({ attempts: 0, verdict: 'pass' });
  });

  it('the retry counter is stored atomically under the state dir', async () => {
    const f = await fixture('fail');
    await f.hook('claude');
    expect(await readAttempts(stateFile(f.stateDir, 'sess-1', f.dir))).toBe(1);
    expect(readdirSync(f.stateDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('times out within the budget, stops the tests, removes worktrees and allows the stop', async () => {
    const f = await fixture('fail', { command: 'sleep 60', hook: { timeoutSec: 1.5 } });
    await writeAttempts(stateFile(f.stateDir, 'sess-1', f.dir), 1);
    const started = Date.now();
    for (const agent of AGENTS) {
      const r = await f.hook(agent);
      expect(r).toMatchObject({ exitCode: 0, stdout: msg("trustbut couldn't verify: timed out after 1.5 s (hook.timeoutSec); not blocking"), stderr: '' });
      expect(r.forceExit).toBeFalsy();
    }
    expect(Date.now() - started).toBeLessThan(30_000);
    const wt = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: f.dir });
    expect(wt.stdout.split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
    expect(await readAttempts(stateFile(f.stateDir, 'sess-1', f.dir))).toBe(0);
  });

  it('when the state cannot be read or saved, blocks only on a first stop', async () => {
    const f = await fixture('fail');
    const blocked = join(await mkdtemp(join(tmpdir(), 'tb-hook-')), 'file');
    await writeFiles(blocked.replace(/file$/, ''), { file: 'not a folder' });
    const opts = { stateDir: join(blocked, 'state') };
    expect((await f.hook('codex', { session_id: 's', cwd: f.dir, stop_hook_active: false }, opts)).exitCode).toBe(2);
    const r = await f.hook('codex', { session_id: 's', cwd: f.dir, stop_hook_active: true }, opts);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/^trustbut FAIL: 1 failing test — not sent back again: couldn't read the retry counter/);
  });
});

describe.concurrent('trustbut hook: receipt location', () => {
  it('writes the receipt inside the linked worktree’s own git dir', async () => {
    const f = await fixture('no-changes');
    const wt = join(await realpath(await mkdtemp(join(tmpdir(), 'tb-wt-'))), 'wt');
    await execa('git', ['worktree', 'add', '-q', '-b', 'side', wt], { cwd: f.dir });
    await writeFiles(wt, { 'src/lib.js': "export const v = 'bad';\n", 'test/lib.test.js': "it('works', () => {});\n" });
    const r = await f.hook('codex', { session_id: 's', cwd: wt });
    expect(r.exitCode).toBe(2);
    const receipt = join(f.dir, '.git', 'worktrees', 'wt', 'trustbut', 'last-receipt.md');
    expect(r.stderr).toContain(`Full receipt: \`${receipt}\``);
    expect(existsSync(receipt)).toBe(true);
  });
});

// A command runner that also counts its runs in a marker file outside the repo.
async function counted(scenario: Scenario, config: Record<string, unknown> = {}) {
  const marker = join(await mkdtemp(join(tmpdir(), 'tb-marker-')), 'runs');
  const f = await fixture(scenario, { command: `echo run >> '${marker}'; sh run.sh`, ...config });
  const runs = async () => (existsSync(marker) ? (await readFile(marker, 'utf8')).split('\n').filter(Boolean).length : 0);
  return { ...f, runs };
}

describe.concurrent('trustbut hook: unchanged trees', () => {
  it('an unchanged PASS is not rerun, and an edit is', async () => {
    const f = await counted('pass');
    expect(JSON.parse((await f.hook('claude')).stdout).systemMessage).toMatch(/^trustbut PASS: /);
    const after = await f.runs();
    expect(after).toBeGreaterThan(0);
    expect(await f.hook('claude')).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(await f.hook('codex', { session_id: 'sess-1', cwd: f.dir, stop_hook_active: true })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(await f.runs()).toBe(after);
    await writeFiles(f.dir, { 'src/lib.js': "export const v = 'good again';\n" });
    await f.hook('claude');
    expect(await f.runs()).toBeGreaterThan(after);
  });

  it('a question-only turn on a branch with a committed FAIL is not blocked again', async () => {
    const f = await counted('fail');
    await branch(f.dir, 'feature');
    await commitAll(f.dir, 'agent commits the failing change');
    const first = await f.hook('claude');
    expect(JSON.parse(first.stdout).decision).toBe('block');
    const after = await f.runs();
    // Later the user asks a question and the agent answers without editing anything.
    const qa = await f.hook('claude', { session_id: 'sess-1', cwd: f.dir, stop_hook_active: false });
    expect(qa).toEqual({ exitCode: 0, stdout: msg(`trustbut FAIL (unchanged since last check) — receipt: ${f.receipt}`), stderr: '' });
    expect(await f.runs()).toBe(after);
  });

  it('a new turn (stop_hook_active: false) on an unchanged FAIL tree is allowed even mid-count', async () => {
    const f = await counted('fail');
    expect((await f.hook('gemini')).exitCode).toBe(2);
    const r = await f.hook('gemini', { session_id: 'sess-1', cwd: f.dir, stop_hook_active: false });
    expect(JSON.parse(r.stdout).systemMessage).toBe(`trustbut FAIL (unchanged since last check) — receipt: ${f.receipt}`);
  });

  it('within a chain, an unchanged FAIL is verified and blocked again', async () => {
    const f = await counted('fail');
    expect((await f.hook('codex')).exitCode).toBe(2);
    const after = await f.runs();
    expect((await f.hook('codex', { session_id: 'sess-1', cwd: f.dir, stop_hook_active: true })).exitCode).toBe(2);
    expect(await f.runs()).toBeGreaterThan(after);
    expect(await readAttempts(stateFile(f.stateDir, 'sess-1', f.dir))).toBe(2);
  });
});

describe.concurrent('trustbut hook: stop_hook_active and the counter', () => {
  it('stop_hook_active: false starts a new chain at attempt 1', async () => {
    const f = await fixture('fail');
    await writeAttempts(stateFile(f.stateDir, 'sess-1', f.dir), 3);
    const r = await f.hook('claude', { session_id: 'sess-1', cwd: f.dir, stop_hook_active: false });
    expect(JSON.parse(r.stdout).systemMessage).toBe('trustbut FAIL: 1 failing test — sent back to the agent (attempt 1/3)');
  });

  it('a missing stop_hook_active keeps counting', async () => {
    const f = await fixture('fail');
    await writeAttempts(stateFile(f.stateDir, 'sess-1', f.dir), 3);
    const r = await f.hook('claude', { session_id: 'sess-1', cwd: f.dir });
    expect(JSON.parse(r.stdout).systemMessage).toBe(`trustbut still FAIL after 3 attempts — receipt: ${f.receipt}`);
  });

  it('stop_hook_active: true with a corrupt counter never blocks', async () => {
    const f = await fixture('fail');
    const file = stateFile(f.stateDir, 'sess-1', f.dir);
    await writeFiles(f.stateDir, { [file.split('/').pop()!]: '{ corrupt' });
    for (const agent of AGENTS) {
      await writeFiles(f.stateDir, { [file.split('/').pop()!]: '{ corrupt' });
      const r = await f.hook(agent, { session_id: 'sess-1', cwd: f.dir, stop_hook_active: true });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).systemMessage).toMatch(/^trustbut FAIL: 1 failing test — not sent back again: couldn't read the retry counter \(corrupt state file /);
    }
  });
});

describe.concurrent('trustbut hook: base', () => {
  const git = (dir: string, ...args: string[]) => execa('git', args, { cwd: dir });

  it('a repo with only a develop branch verifies the uncommitted changes against HEAD', async () => {
    const f = await fixture('fail');
    await git(f.dir, 'branch', '-m', 'main', 'develop');
    const r = await f.hook('codex');
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('run `trustbut verify --working --quick --base HEAD` to check.');
  });

  it("compares with origin's default branch, not a stale main", async () => {
    const f = await fixture('no-changes');
    // develop (origin's default) has a focused test that a diff from the stale main would flag.
    await branch(f.dir, 'develop');
    await writeFiles(f.dir, { 'test/focus.test.js': "it.only('x', () => {});\n" });
    const develop = await commitAll(f.dir, 'develop work');
    await git(f.dir, 'update-ref', 'refs/remotes/origin/develop', develop);
    await git(f.dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    await branch(f.dir, 'feature');
    await writeFiles(f.dir, { 'src/lib.js': "export const v = 'good';\n", 'test/lib.test.js': "it('works', () => {});\n" });
    const r = await f.hook('claude');
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/^trustbut PASS: /);
  });

  it('hook.base from the config wins', async () => {
    const f = await fixture('fail', { hook: { base: 'HEAD' } });
    await commitAll(f.dir, 'commit the failing change');
    // Compared with HEAD, a clean tree has nothing to verify.
    expect(await f.hook('claude')).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('committing on a feature branch does not hide the change from the default-branch diff', async () => {
    const f = await fixture('no-changes');
    await branch(f.dir, 'feature');
    await writeFiles(f.dir, { 'src/lib.js': "export const v = 'bad';\n", 'test/lib.test.js': "it('works', () => {});\n" });
    await commitAll(f.dir, 'agent commits');
    expect((await f.hook('codex')).exitCode).toBe(2);
  });

  it('known limitation: on a remote-less main, committed work with a clean tree has nothing to verify', async () => {
    const f = await fixture('fail');
    await commitAll(f.dir, 'agent commits on main');
    expect(await f.hook('claude')).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });
});
