import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runVerify } from '../helpers/verify.js';
import { detectRunner } from '../../src/runners/registry.js';
import { parseRspecJson, rspec, rspecArgs } from '../../src/runners/rspec.js';
import { branch, commitAll, makeRepo, writeFiles } from '../helpers/repo.js';
import { hasTool, requiredTools } from '../helpers/toolchain.js';

const fx = (name: string) => fileURLToPath(new URL(`../fixtures/runners/rspec/${name}`, import.meta.url));
const fixture = fx('rspec.json');

describe('parseRspecJson', () => {
  it('maps statuses, nested groups, normalised files, and a load error per file', async () => {
    const cases = parseRspecJson(await readFile(fixture, 'utf8'));
    expect(cases.map((c) => [c.id, c.outcome, c.leaf])).toEqual([
      ['spec/calc_spec.rb::Calc adds', 'pass', 'adds'],
      ['spec/calc_spec.rb::Calc subtracts', 'fail', 'subtracts'],
      ['spec/calc_spec.rb::Calc multiplies later', 'skip', 'multiplies later'],
      ['spec/calc_spec.rb::Calc when nested handles zero', 'pass', 'handles zero'],
      ['spec/lib/shape_spec.rb::Shape has area', 'pass', 'has area'],
    ]);
    expect(cases[0]!.file).toBe('spec/calc_spec.rb');
  });

  it('turns a load error (no examples ran) into one error case for the named file', async () => {
    const cases = parseRspecJson(await readFile(fx('rspec-load-error.json'), 'utf8'));
    expect(cases.map((c) => [c.id, c.outcome])).toEqual([['spec/broken_spec.rb::[load error]', 'error']]);
  });

  it('attributes shared examples to the including spec (from the id), not the shared file', async () => {
    const cases = parseRspecJson(await readFile(fx('rspec-shared.json'), 'utf8'));
    expect(cases.map((c) => [c.id, c.file])).toEqual([
      ['spec/models/user_spec.rb::User behaves like a record', 'spec/models/user_spec.rb'],
      ['spec/models/post_spec.rb::Post behaves like a record', 'spec/models/post_spec.rb'],
    ]);
  });

  it('reports errors outside of examples that name no file as one generic error case', () => {
    const json = JSON.stringify({ messages: ['An error occurred in an `after(:context)` hook.'], examples: [], summary: { errors_outside_of_examples_count: 1 } });
    expect(parseRspecJson(json).map((c) => [c.id, c.outcome])).toEqual([['[rspec]::[error outside of examples]', 'error']]);
  });

  it('keeps the worst outcome when a full description repeats', () => {
    const ex = (status: string) => ({ description: 'x', full_description: 'A x', status, file_path: './spec/a_spec.rb' });
    const json = JSON.stringify({ examples: [ex('passed'), ex('failed'), ex('passed')], summary: { errors_outside_of_examples_count: 0 } });
    expect(parseRspecJson(json).map((c) => c.outcome)).toEqual(['fail']);
  });

  it('builds the command line', () => {
    expect(rspecArgs('/t/o.json', ['--tag', 'fast'], ['spec/a_spec.rb'])).toEqual(['--format', 'json', '--out', '/t/o.json', '--tag', 'fast', 'spec/a_spec.rb']);
    expect(rspecArgs('/t/o.json', [])).toEqual(['--format', 'json', '--out', '/t/o.json']);
  });
});

describe('rspec detection', () => {
  it('.rspec, or spec/ with rspec in the Gemfile(.lock)', async () => {
    const a = await mkdtemp(join(tmpdir(), 'tb-rb-'));
    expect(await rspec.detect(a)).toBe(0);
    await writeFile(join(a, '.rspec'), '--require spec_helper\n');
    expect(await rspec.detect(a)).toBe(10);
    expect((await detectRunner(a))?.name).toBe('rspec');
    const b = await mkdtemp(join(tmpdir(), 'tb-rb-'));
    await mkdir(join(b, 'spec'));
    await writeFile(join(b, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rails'\n");
    expect(await rspec.detect(b)).toBe(0);
    await writeFile(join(b, 'Gemfile.lock'), '  rspec (3.12.0)\n');
    expect(await rspec.detect(b)).toBe(10);
    const c = await mkdtemp(join(tmpdir(), 'tb-rb-'));
    await writeFile(join(c, 'Gemfile'), "gem 'rspec'\n");
    expect(await rspec.detect(c)).toBe(0); // no spec/ directory
    await mkdir(join(c, 'spec'));
    expect(await rspec.detect(c)).toBe(10);
    expect(await rspec.detect(join(a, 'missing'))).toBe(0);
  });
});

describe('rspec runner with a fake rspec', () => {
  // The fake writes the sample report to the --out path and echoes its arguments.
  async function project(exit: number, gemfile = false): Promise<{ dir: string; env: Record<string, string> }> {
    const dir = await mkdtemp(join(tmpdir(), 'tb-rbproj-'));
    const bin = await mkdtemp(join(tmpdir(), 'tb-fakerspec-'));
    const body = `echo "ARGS: $*" >&2\nwhile [ $# -gt 0 ]; do if [ "$1" = --out ]; then cp '${fixture}' "$2"; fi; shift; done\nexit ${exit}\n`;
    await writeFile(join(bin, 'rspec'), `#!/bin/sh\n${body}`);
    await chmod(join(bin, 'rspec'), 0o755);
    // `bundle exec rspec ...`: the fake bundle drops "exec" and runs the fake rspec.
    await writeFile(join(bin, 'bundle'), '#!/bin/sh\necho "BUNDLE" >&2\nshift\nexec rspec "$@"\n');
    await chmod(join(bin, 'bundle'), 0o755);
    await mkdir(join(dir, 'spec'), { recursive: true });
    for (const f of ['calc_spec.rb', 'other_spec.rb', 'spec_helper.rb']) await writeFile(join(dir, 'spec', f), '');
    if (gemfile) await writeFile(join(dir, 'Gemfile'), "gem 'rspec'\n");
    return { dir, env: { PATH: `${bin}:${process.env.PATH}` } };
  }

  it('passes --format json --out, config args and only *_spec.rb files', async () => {
    const { dir, env } = await project(1);
    const res = await rspec.run({ cwd: dir, env, files: ['spec/calc_spec.rb', 'spec/spec_helper.rb', 'spec/gone_spec.rb'], args: ['--tag', 'fast'] });
    expect(res.output).toMatch(/ARGS: --format json --out \S+rspec\.json --tag fast spec\/calc_spec\.rb\n?$/);
    expect(res.output).not.toContain('BUNDLE');
    expect(res.exitCode).toBe(1);
    expect(res.cases.map((c) => c.id)).toContain('spec/calc_spec.rb::Calc subtracts');
    expect(res.cases).toHaveLength(5);
  });

  it('helpers alone mean a full run; a Gemfile means bundle exec', async () => {
    const { dir, env } = await project(0, true);
    const res = await rspec.run({ cwd: dir, env, files: ['spec/spec_helper.rb'] });
    expect(res.output).toContain('BUNDLE');
    expect(res.output).not.toContain('.rb');
  });

  it('a crash without a report is one error case with its output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-rbcrash-'));
    const bin = await mkdtemp(join(tmpdir(), 'tb-fakerspec-'));
    await writeFile(join(bin, 'rspec'), '#!/bin/sh\necho "Could not find gem x" >&2\nexit 7\n');
    await chmod(join(bin, 'rspec'), 0o755);
    const res = await rspec.run({ cwd: dir, env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(res.exitCode).toBe(7);
    expect(res.cases.map((c) => c.outcome)).toEqual(['error']);
    expect(res.output).toContain('Could not find gem');
  });

  it("a missing rspec is a start-up error, not \"no tests\"", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-rbnone-'));
    await expect(rspec.run({ cwd: dir, env: { PATH: '/nonexistent' } })).rejects.toThrow(/^Couldn't start rspec: /);
  });
});

const run = hasTool('rspec') || requiredTools().has('rspec');

describe.skipIf(!run)('trustbut verify with rspec (end to end)', () => {
  const CALC = (op: string) => `module Calc\n  def self.sum(a, b)\n    a ${op} b\n  end\nend\n`;
  const spec = (name: string, body: string) => `require_relative '../lib/calc'\n\nRSpec.describe Calc do\n  it '${name}' do\n    ${body}\n  end\nend\n`;
  const BASE = {
    '.rspec': '--require spec_helper\n',
    'spec/spec_helper.rb': '',
    'lib/calc.rb': CALC('-'),
    'spec/old_spec.rb': spec('is zero', 'expect(Calc.sum(0, 0)).to eq(0)'),
  };
  async function scenario(head: Record<string, string | null>) {
    const { dir } = await makeRepo(BASE);
    await branch(dir, 'agent-change');
    await writeFiles(dir, head);
    await commitAll(dir, 'agent change');
    return dir;
  }

  it('PASS: a fix proven by a new example', async () => {
    const dir = await scenario({ 'lib/calc.rb': CALC('+'), 'spec/calc_spec.rb': spec('adds', 'expect(Calc.sum(2, 3)).to eq(5)') });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.runner).toBe('rspec');
    expect(receipt.proofs.map((p) => [p.file, p.name, p.before, p.verdict])).toEqual([['spec/calc_spec.rb', 'Calc adds', 'fail', 'proves-change']]);
    expect(receipt.verdict).toBe('pass');
  }, 120_000);

  it('WARN: a new example that passes without the change', async () => {
    const dir = await scenario({ 'lib/calc.rb': CALC('+'), 'spec/zero_spec.rb': spec('zero', 'expect(Calc.sum(0, 0)).to eq(0)') });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('warn');
    expect(receipt.proofs.map((p) => p.verdict)).toContain('does-not-constrain');
  }, 120_000);

  it('a spec file that fails to load is an error, not a proof', async () => {
    const dir = await scenario({ 'lib/calc.rb': CALC('+'), 'spec/broken_spec.rb': "require 'missing_lib_xyz'\n" });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('fail');
  }, 120_000);
});
