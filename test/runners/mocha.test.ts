import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVerify } from '../helpers/verify.js';
import { mocha, parseMochaJson } from '../../src/runners/mocha.js';
import { detectRunner } from '../../src/runners/registry.js';
import { branch, commitAll, linkNodeModules, makeRepo, writeFiles } from '../helpers/repo.js';
import { hasTool, requiredTools } from '../helpers/toolchain.js';

async function pkg(json: object, files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ar-mocha-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify(json));
  for (const [f, c] of Object.entries(files)) await writeFile(join(dir, f), c);
  return dir;
}

describe('mocha detection', () => {
  it('scores 9 for the mocha dependency or a .mocharc file', async () => {
    expect(await mocha.detect(await pkg({ devDependencies: { mocha: '^11' } }))).toBe(9);
    for (const rc of ['.mocharc.json', '.mocharc.yml', '.mocharc.cjs', '.mocharc.js', '.mocharc.yaml']) {
      expect(await mocha.detect(await pkg({}, { [rc]: '{}' })), rc).toBe(9);
    }
    expect(await mocha.detect(await pkg({ name: 'x' }))).toBe(0);
    expect(await mocha.detect('/nonexistent/dir')).toBe(0);
  });

  it('beats node --test but loses to vitest and jest', async () => {
    const withNode = await pkg({ scripts: { test: 'node --test' }, devDependencies: { mocha: '*' } });
    expect((await detectRunner(withNode))?.name).toBe('mocha');
    const withVitest = await pkg({ devDependencies: { mocha: '*', vitest: '*' } });
    expect((await detectRunner(withVitest))?.name).toBe('vitest');
  });
});

// Real `mocha --reporter json --reporter-option output=...` output (mocha 12), abbreviated.
const REPORT = JSON.stringify({
  stats: { suites: 3, tests: 4, passes: 2, pending: 1, failures: 2 },
  tests: [],
  pending: [{ title: 'skipped', fullTitle: 'suite skipped', file: '/private/tmp/wt/pkg/test/a.spec.js', currentRetry: 0, err: {} }],
  failures: [
    {
      title: 'bad',
      fullTitle: 'suite bad',
      file: '/private/tmp/wt/pkg/test/a.spec.js',
      err: { message: '1 == 2', name: 'AssertionError' },
    },
    {
      title: '"before all" hook for "never"',
      fullTitle: 'hooked "before all" hook for "never"',
      file: '/private/tmp/wt/pkg/test/c.spec.js',
      err: { message: 'boom' },
    },
  ],
  passes: [
    { title: 'ok', fullTitle: 'suite ok', file: '/private/tmp/wt/pkg/test/a.spec.js', speed: 'fast', err: {} },
    { title: 'deep', fullTitle: 'suite nested deep', file: '/private/tmp/wt/pkg/test/a.spec.js', speed: 'fast', err: {} },
  ],
});

describe('parseMochaJson', () => {
  it('maps passes/failures/pending to relative ids and hook failures to error', () => {
    const got = parseMochaJson(REPORT, '/private/tmp/wt/pkg').map((c) => [c.id, c.outcome]);
    expect(got).toEqual([
      ['test/a.spec.js::suite ok', 'pass'],
      ['test/a.spec.js::suite nested deep', 'pass'],
      ['test/a.spec.js::suite skipped', 'skip'],
      ['test/a.spec.js::suite bad', 'fail'],
      ['test/c.spec.js::hooked "before all" hook for "never"', 'error'],
    ]);
  });
});

const run = hasTool('node') || requiredTools().has('node');
describe.skipIf(!run)('trustbut verify with mocha (end to end)', () => {
  const BASE = {
    '.gitignore': 'node_modules\n',
    'package.json': JSON.stringify({ name: 'fx', private: true, devDependencies: { mocha: '*' } }),
    '.mocharc.json': JSON.stringify({ spec: 'test/**/*.spec.js' }),
    'src/sum.js': 'exports.sum = (a, b) => a - b;\n',
    'test/old.spec.js': "describe('old', () => { it('truth', () => {}); });\n",
  };
  const sumTest = (body: string) =>
    `const assert = require('assert');\nconst { sum } = require('../src/sum');\ndescribe('sum', () => {\n${body}\n});\n`;
  async function scenario(head: Record<string, string>) {
    const { dir } = await makeRepo(BASE);
    await linkNodeModules(dir);
    await branch(dir, 'agent-change');
    await writeFiles(dir, head);
    await commitAll(dir, 'agent change');
    return dir;
  }

  it('PASS: a fix proven by a new mocha test', async () => {
    const dir = await scenario({
      'src/sum.js': 'exports.sum = (a, b) => a + b;\n',
      'test/sum.spec.js': sumTest("it('adds', () => assert.strictEqual(sum(2, 3), 5));"),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.runner).toBe('mocha');
    expect(receipt.proofs.map((p) => [p.file, p.name, p.before, p.verdict])).toEqual([
      ['test/sum.spec.js', 'sum adds', 'fail', 'proves-change'],
    ]);
    expect(receipt.verdict).toBe('pass');
  }, 120_000);

  it('WARN: a new test that passes without the change', async () => {
    const dir = await scenario({
      'src/sum.js': 'exports.sum = (a, b) => a + b;\n',
      'test/sum.spec.js': sumTest("it('zero', () => assert.strictEqual(sum(0, 0), 0));"),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('warn');
    expect(receipt.proofs.map((p) => p.verdict)).toContain('does-not-constrain');
  }, 120_000);
});
