import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs helper without types
import { buildBody, findComment, markerFor, LEGACY_MARKER, run, truncateBytes } from '../scripts/action/comment.mjs';

const yml = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

/** Split the `steps:` list into blocks (each starts at "    - "). */
const steps = yml.slice(yml.indexOf('\nruns:')).split(/\n(?=    - )/).slice(1);
/** The text of every `run:` value in a step (inline or block scalar). */
function runBodies(step: string): string[] {
  const out: string[] = [];
  const lines = step.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s+run:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    if (/^[|>]/.test(m[1]!)) {
      const body: string[] = [];
      for (i++; i < lines.length && (lines[i]!.startsWith('          ') || lines[i]!.trim() === ''); i++) body.push(lines[i]!);
      i--;
      out.push(body.join('\n'));
    } else out.push(m[1]!);
  }
  return out;
}

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
    for (const b of bodies) expect(b).not.toMatch(/\$\{\{/);
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

describe('comment.mjs', () => {
  const bot = (id: number, body: string) => ({ id, login: 'github-actions[bot]', type: 'Bot', body });
  const human = (id: number, body: string) => ({ id, login: 'mallory', type: 'User', body });

  it('finds only bot-authored comments with the keyed marker', () => {
    const m = markerFor('default');
    expect(findComment([human(1, `${m}\nplanted`), bot(2, `${m}\nreal`)], 'default').id).toBe(2);
    expect(findComment([human(1, `${m}\nplanted`)], 'default')).toBeUndefined();
    expect(findComment([bot(3, markerFor('other'))], 'default')).toBeUndefined();
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
    expect(body.split('\n').filter((l) => l.startsWith('```')).length % 2).toBe(0);
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
