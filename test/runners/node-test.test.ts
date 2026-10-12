import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVerify } from '../../src/commands/verify.js';
import { nodeTest, parseNodeTestEvents } from '../../src/runners/node-test.js';
import { detectRunner } from '../../src/runners/registry.js';
import { branch, commitAll, makeRepo, writeFiles } from '../helpers/repo.js';
import { hasTool, requiredTools } from '../helpers/toolchain.js';

async function pkg(json: object) {
  const dir = await mkdtemp(join(tmpdir(), 'ar-nodetest-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify(json));
  return dir;
}

describe('node:test detection', () => {
  it('scores 8 for node --test and tsx --test scripts', async () => {
    for (const test of ['node --test', 'node --test test/', 'node --import tsx --test', 'tsx --test', 'node --no-warnings --test src/']) {
      expect(await nodeTest.detect(await pkg({ scripts: { test } })), test).toBe(8);
    }
    expect(await nodeTest.detect(await pkg({ scripts: { test: 'vitest run' } }))).toBe(0);
    expect(await nodeTest.detect(await pkg({ scripts: { test: 'node build.js' } }))).toBe(0);
    expect(await nodeTest.detect(await pkg({}))).toBe(0);
    expect(await nodeTest.detect('/nonexistent/dir')).toBe(0);
  });

  it('loses to explicit frameworks', async () => {
    const dir = await pkg({ scripts: { test: 'node --test' }, devDependencies: { vitest: '*' } });
    expect((await detectRunner(dir))?.name).toBe('vitest');
    expect((await detectRunner(await pkg({ scripts: { test: 'node --test' } })))?.name).toBe('node-test');
  });
});

// Captured from `node --test --test-reporter=<json-lines reporter>` (Node 22.23) on a project with a
// passing test, a describe() with pass/fail/skip, and a file with a syntax error.
const F = '/private/tmp/wt/pkg/test';
const ev = (o: object) => JSON.stringify({ skip: false, todo: false, ...o });
const SAMPLE = [
  ev({ type: 'test:start', name: 'top ok', nesting: 0, file: `${F}/a.test.js` }),
  ev({ type: 'test:pass', name: 'top ok', nesting: 0, file: `${F}/a.test.js`, kind: 'test' }),
  ev({ type: 'test:start', name: 'suite', nesting: 0, file: `${F}/a.test.js` }),
  ev({ type: 'test:start', name: 'inner ok', nesting: 1, file: `${F}/a.test.js` }),
  ev({ type: 'test:pass', name: 'inner ok', nesting: 1, file: `${F}/a.test.js`, kind: 'test' }),
  ev({ type: 'test:start', name: 'inner bad', nesting: 1, file: `${F}/a.test.js` }),
  ev({ type: 'test:fail', name: 'inner bad', nesting: 1, file: `${F}/a.test.js`, kind: 'test' }),
  ev({ type: 'test:start', name: 'skipped', nesting: 1, file: `${F}/a.test.js` }),
  ev({ type: 'test:pass', name: 'skipped', nesting: 1, file: `${F}/a.test.js`, skip: true, kind: 'test' }),
  ev({ type: 'test:fail', name: 'suite', nesting: 0, file: `${F}/a.test.js`, kind: 'suite' }),
  ev({ type: 'test:start', name: 'test/b.test.js', nesting: 0, file: `${F}/b.test.js` }),
  ev({ type: 'test:fail', name: 'test/b.test.js', nesting: 0, file: `${F}/b.test.js`, kind: 'test' }),
  'not json',
].join('\n');

describe('parseNodeTestEvents', () => {
  it('builds relative ids with suite names, skips suites, and maps load failures to error', () => {
    expect(parseNodeTestEvents(SAMPLE, '/private/tmp/wt/pkg').map((c) => [c.id, c.outcome])).toEqual([
      ['test/a.test.js::top ok', 'pass'],
      ['test/a.test.js::suite > inner ok', 'pass'],
      ['test/a.test.js::suite > inner bad', 'fail'],
      ['test/a.test.js::suite > skipped', 'skip'],
      ['test/b.test.js::test/b.test.js', 'error'],
    ]);
  });

  it('reports a suite that failed with no tests under it (failing hook) as an error', () => {
    const f = `${F}/c.test.js`;
    const jsonl = [
      ev({ type: 'test:start', name: 'hooked', nesting: 0, file: f }),
      ev({ type: 'test:fail', name: 'hooked', nesting: 0, file: f, kind: 'suite' }),
    ].join('\n');
    expect(parseNodeTestEvents(jsonl, '/private/tmp/wt/pkg').map((c) => [c.id, c.outcome])).toEqual([
      ['test/c.test.js::hooked', 'error'],
    ]);
  });
});

const run = hasTool('node') || requiredTools().has('node');
describe.skipIf(!run)('trustbut verify with node:test (end to end)', () => {
  const BASE = {
    'package.json': JSON.stringify({ name: 'fx', private: true, scripts: { test: 'node --test' } }),
    'src/sum.js': 'exports.sum = (a, b) => a - b;\n',
    'test/old.test.js': "const { test } = require('node:test');\ntest('truth', () => {});\n",
  };
  const sumTest = (body: string) =>
    `const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('../src/sum');\n${body}\n`;
  async function scenario(head: Record<string, string>) {
    const { dir } = await makeRepo(BASE);
    await branch(dir, 'agent-change');
    await writeFiles(dir, head);
    await commitAll(dir, 'agent change');
    return dir;
  }

  it('PASS: a fix proven by a new node:test test', async () => {
    const dir = await scenario({
      'src/sum.js': 'exports.sum = (a, b) => a + b;\n',
      'test/sum.test.js': sumTest("test('adds', () => assert.strictEqual(sum(2, 3), 5));"),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.runner).toBe('node-test');
    expect(receipt.proofs.map((p) => [p.file, p.name, p.before, p.verdict])).toEqual([
      ['test/sum.test.js', 'adds', 'fail', 'proves-change'],
    ]);
    expect(receipt.verdict).toBe('pass');
  }, 120_000);

  it('WARN: a new test that passes without the change', async () => {
    const dir = await scenario({
      'src/sum.js': 'exports.sum = (a, b) => a + b;\n',
      'test/sum.test.js': sumTest("test('zero', () => assert.strictEqual(sum(0, 0), 0));"),
    });
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.verdict).toBe('warn');
    expect(receipt.findings.map((f) => f.id)).toContain('test-passes-without-change');
  }, 120_000);
});
