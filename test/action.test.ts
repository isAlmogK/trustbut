import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain .mjs helper without types
import { buildBody, findComment, markerFor, LEGACY_MARKER, run, truncateBytes } from '../scripts/action/comment.mjs';

const yml = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

/** Split the `steps:` list into blocks (each starts at "    - "). */
const steps = yml.slice(yml.indexOf('\nruns:')).split(/\n(?=    - )/).slice(1);
/** The text of every `run:` value in a step (inline or block scalar); the body is whatever is indented deeper than `run:`. */
function runBodies(step: string): string[] {
  const out: string[] = [];
  const lines = step.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s+)run:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.length;
    if (/^[|>]/.test(m[2]!)) {
      const body: string[] = [];
      for (i++; i < lines.length && (lines[i]!.trim() === '' || /^\s*/.exec(lines[i]!)![0].length > indent); i++) body.push(lines[i]!);
      i--;
      out.push(body.join('\n'));
    } else out.push(m[2]!);
  }
  return out;
}

const INJECTION = /\$\{\{/;

describe('action.yml structure', () => {
  it('has metadata, branding, and composite runs', () => {
    expect(yml).toMatch(/^name: trustbut receipt$/m);
    expect(yml).toMatch(/^author: Almog Koren$/m);
    expect(yml).toMatch(/icon: check-square/);
    expect(yml).toMatch(/color: green/);
    expect(yml).toMatch(/using: composite/);
  });

  it('declares every input and output', () => {
    const section = (name: string) => yml.slice(yml.indexOf(`\n${name}:`), yml.indexOf('\n\n', yml.indexOf(`\n${name}:`)));
    for (const i of ['base', 'strict', 'config', 'root', 'working-directory', 'version', 'node-version', 'comment', 'comment-key', 'github-token'])
      expect(section('inputs')).toMatch(new RegExp(`^  ${i}:`, 'm'));
    for (const o of ['verdict', 'exit-code', 'receipt-path', 'comment-url'])
      expect(section('outputs')).toMatch(new RegExp(`^  ${o}:`, 'm'));
  });

  it('has clearly named steps with the ids the outputs reference', () => {
    expect(steps.length).toBeGreaterThanOrEqual(6);
    for (const s of steps) expect(s).toMatch(/^    - name: trustbut - /);
    expect(yml).toMatch(/^\s+id: verify$/m);
    expect(yml).toMatch(/^\s+id: comment$/m);
    expect(yml).toMatch(/steps\.verify\.outputs\.verdict/);
  });

  it('every run step sets a shell', () => {
    for (const s of steps.filter((x) => /^\s+run:/m.test(x))) expect(s).toMatch(/^\s+shell: bash$/m);
  });

  it('never interpolates ${{ }} expressions inside run: bodies (injection-safe)', () => {
    const bodies = steps.flatMap(runBodies);
    expect(bodies.length).toBeGreaterThan(3);
    expect(bodies.some((b) => b.includes('--receipt-json'))).toBe(true); // multi-line bodies are really collected
    for (const b of bodies) expect(b).not.toMatch(INJECTION);
  });

  it('the injection check detects an interpolated input (mutation)', () => {
    const mutated = yml.replace('base="${INPUT_BASE:-', 'base="${{ inputs.base }}${INPUT_BASE:-');
    expect(mutated).not.toBe(yml);
    const mSteps = mutated.slice(mutated.indexOf('\nruns:')).split(/\n(?=    - )/).slice(1);
    expect(mSteps.flatMap(runBodies).some((b) => INJECTION.test(b))).toBe(true);
  });

  it('reads the verdict from the JSON receipt, not Markdown, and ends with trustbut\'s exit code', () => {
    expect(yml).toMatch(/--receipt-json/);
    expect(yml).not.toMatch(/grep[^\n]*Receipt:/);
    expect(yml).toMatch(/exit "\$\{CODE:-2\}"/);
  });

  it('only installs Node when missing, old, or requested', () => {
    expect(yml).toMatch(/steps\.node\.outputs\.setup == 'true'/);
    expect(yml).toMatch(/-lt 22/);
  });
});

describe('ci.yml dogfoods the action', () => {
  it('uses ./ with version local and keeps permissions and checkout settings', () => {
    expect(ci).toMatch(/uses: \.\/\n\s+with:[\s\S]*version: local/);
    expect(ci).toMatch(/contents: read\n\s+pull-requests: write/);
    expect(ci).toMatch(/fetch-depth: 0/);
    expect(ci).toMatch(/persist-credentials: false/);
    expect(ci).not.toMatch(/trustbut-receipt -->/);
  });
});

describe('verify step script under bash -e -o pipefail', () => {
  const verify = steps.find((x) => /^\s+id: verify$/m.test(x))!;
  const script = runBodies(verify)[0]!;

  it('captures a failing exit code and still writes outputs and the summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-verify-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // stub `node`: `-p` goes to the real node; otherwise behave like a failing `trustbut verify`
    writeFileSync(
      join(bin, 'node'),
      `#!/bin/sh
if [ "$1" = "-p" ]; then exec "${process.execPath}" "$@"; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --receipt-json) echo '{"verdict":"fail"}' > "$2"; shift ;;
    --receipt-md) echo '## Receipt: FAIL' > "$2"; shift ;;
  esac
  shift
done
exit 1
`,
    );
    chmodSync(join(bin, 'node'), 0o755);
    const out = join(dir, 'out');
    const summary = join(dir, 'summary');
    writeFileSync(out, '');
    writeFileSync(summary, '');
    const env = {
      PATH: `${bin}:${process.env.PATH}`, HOME: dir, RUNNER_TEMP: dir, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary,
      GITHUB_ACTION_PATH: dir, INPUT_VERSION: 'local', INPUT_BASE: 'main', INPUT_STRICT: 'false', INPUT_CONFIG: '', INPUT_ROOT: '',
      PR_BASE: '', DEFAULT_BRANCH: '', KEY: 'default',
    };
    const r = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], { cwd: dir, env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const o = readFileSync(out, 'utf8');
    expect(o).toContain('exit-code=1');
    expect(o).toContain('verdict=fail');
    expect(o).toMatch(/receipt-path=.*trustbut-receipt-default\.md/);
    expect(readFileSync(summary, 'utf8')).toContain('Receipt: FAIL');
  });

  it('errors clearly when there is no base branch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-verify-'));
    const out = join(dir, 'out');
    writeFileSync(out, '');
    const env = { PATH: process.env.PATH!, RUNNER_TEMP: dir, GITHUB_OUTPUT: out, GITHUB_ACTION_PATH: dir, INPUT_VERSION: 'local', INPUT_BASE: '', PR_BASE: '', DEFAULT_BRANCH: '', INPUT_STRICT: 'false', INPUT_CONFIG: '', INPUT_ROOT: '', KEY: 'default' };
    const r = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], { cwd: dir, env, encoding: 'utf8' });
    expect(r.stdout).toContain('::error title=trustbut::No base branch');
    expect(readFileSync(out, 'utf8')).toContain('exit-code=2');
  });
});

describe('comment.mjs', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  const bot = (id: number, body: string) => ({ id, login: 'github-actions[bot]', type: 'Bot', body });
  const human = (id: number, body: string) => ({ id, login: 'mallory', type: 'User', body });

  it('finds only bot-authored comments with the keyed marker', () => {
    const m = markerFor('default');
    expect(findComment([human(1, `${m}\nplanted`), bot(2, `${m}\nreal`)], 'default').id).toBe(2);
    expect(findComment([human(1, `${m}\nplanted`)], 'default')).toBeUndefined();
    expect(findComment([bot(3, markerFor('other'))], 'default')).toBeUndefined();
  });

  it('only trusts github-actions[bot] by default, and the comment-author input for PAT/App tokens', () => {
    const m = markerFor('default');
    const other = { id: 5, login: 'some-app[bot]', type: 'Bot', body: `${m}\nx` };
    expect(findComment([other], 'default')).toBeUndefined();
    expect(findComment([other], 'default', 'some-app[bot]').id).toBe(5);
  });

  it('sanitizes the comment key inside the HTML marker', () => {
    expect(markerFor('a--> <b <!--c\nd')).toBe('<!-- trustbut-receipt:a <b cd -->');
  });

  it('adopts the legacy marker for the default key only, preferring the keyed one', () => {
    expect(findComment([bot(1, `${LEGACY_MARKER}\nold`)], 'default').id).toBe(1);
    expect(findComment([bot(1, `${LEGACY_MARKER}\nold`)], 'pkg-a')).toBeUndefined();
    expect(findComment([bot(1, `${LEGACY_MARKER}\nold`), bot(2, `${markerFor('default')}\nnew`)], 'default').id).toBe(2);
  });

  it('truncates by bytes, never splits a character, and closes an open fence', () => {
    expect(truncateBytes('héllo', 2).text).toBe('h');
    const receipt = `# R\n\n\`\`\`\n${'é'.repeat(40_000)}`;
    const body = buildBody({ receipt, marker: markerFor('k'), runUrl: 'https://x/run/1' });
    expect(Buffer.byteLength(body)).toBeLessThan(65_000);
    expect(body.startsWith(markerFor('k'))).toBe(true);
    expect(body).not.toContain('�');
    expect(body.split('\n').filter((l: string) => l.startsWith('```')).length % 2).toBe(0);
    expect(body).toContain('full receipt is in the job summary');
  });

  it('leaves a small receipt untouched', () => {
    const body = buildBody({ receipt: '# ok\n', marker: markerFor('d'), runUrl: 'u' });
    expect(body).not.toContain('truncated');
    expect(body).toContain('# ok');
  });

  function setup(extra: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'tb-'));
    const receipt = join(dir, 'r.md');
    writeFileSync(receipt, '## Receipt: PASS\n');
    const out = join(dir, 'out');
    writeFileSync(out, '');
    const env = {
      EVENT_NAME: 'pull_request', REPO: 'o/r', HEAD_REPO: 'o/r', PR: '7', RECEIPT: receipt, COMMENT_KEY: 'default',
      SERVER_URL: 'https://github.com', RUN_ID: '9', RUNNER_TEMP: dir, GITHUB_OUTPUT: out, ...extra,
    };
    return { env, out };
  }

  it('creates a comment when none exists, then reports the url', () => {
    const { env, out } = setup();
    const calls: string[][] = [];
    const gh = (args: string[]) => { calls.push(args); return args.includes('--paginate') ? '' : 'https://c/1\n'; };
    expect(run(env, gh)).toBe(0);
    expect(calls[1]).toContain('POST');
    expect(readFileSync(out, 'utf8')).toBe('url=https://c/1\n');
  });

  it('updates the legacy bot comment in place', () => {
    const { env } = setup();
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      return args.includes('--paginate') ? `${JSON.stringify(bot(42, `${LEGACY_MARKER}\nold`))}\n` : 'https://c/42\n';
    };
    run(env, gh);
    expect(calls[1]).toContain('PATCH');
    expect(calls[1]!.join(' ')).toContain('issues/comments/42');
  });

  it('posts a new comment when updating the adopted one is forbidden or gone', () => {
    const { env } = setup();
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      if (args.includes('--paginate')) return `${JSON.stringify(bot(42, `${LEGACY_MARKER}\nold`))}\n`;
      if (args.includes('PATCH')) throw new Error('gh: Not Found (HTTP 404)');
      return 'https://c/new\n';
    };
    run(env, gh);
    expect(calls.at(-1)).toContain('POST');
  });

  it('skips fork PRs and non-PR events without calling gh', () => {
    const gh = () => { throw new Error('should not be called'); };
    expect(run(setup({ HEAD_REPO: 'fork/r' }).env, gh)).toBe(0);
    expect(run(setup({ EVENT_NAME: 'push' }).env, gh)).toBe(0);
  });

  it('downgrades API failures to a warning', () => {
    const { env } = setup();
    const gh = () => { throw new Error('HTTP 403'); };
    expect(run(env, gh)).toBe(0);
  });
});
