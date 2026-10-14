import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { runValidate } from '../src/commands/validate.js';
import { buildProgram } from '../src/program.js';
import { commitAll, makeRepo, writeFiles } from './helpers/repo.js';
import { runVerify } from './helpers/verify.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXAMPLES = join(ROOT, 'spec', 'examples');
const noStdin = async () => {
  throw new Error('stdin must not be read');
};
const stdin = (text: string) => async () => text;

describe('runValidate', () => {
  it('reports a valid file with exit 0', async () => {
    expect(await runValidate({ file: join(EXAMPLES, 'valid', 'warn.json'), readStdin: noStdin })).toEqual({ stdout: 'valid\n', stderr: '', exitCode: 0 });
  });

  it('lists schema errors with their JSON path and exits 1', async () => {
    const r = await runValidate({ file: join(EXAMPLES, 'invalid', 'bad-finding-id.json'), readStdin: noStdin });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('error: /findings/0/id: must be a core finding id or a namespaced id (<namespace>/<id>)\ninvalid (1 error)\n');
  });

  it('fails a verdict that contradicts the findings', async () => {
    const r = await runValidate({ file: join(EXAMPLES, 'invalid', 'verdict-mismatch.json'), readStdin: noStdin });
    expect(r).toMatchObject({ exitCode: 1, stdout: "error: /verdict: must be 'warn' for these findings (got 'pass')\ninvalid (1 error)\n" });
  });

  it('prints warnings but still exits 0', async () => {
    const receipt = { specVersion: '1.0', producer: { name: 't', version: '1' }, subject: { base: 'a', head: 'b' }, verdict: 'fail', findings: [{ id: 'test-skipped', severity: 'fail', title: 'Test skipped' }] };
    const r = await runValidate({ readStdin: stdin(JSON.stringify(receipt)) });
    expect(r).toEqual({ stdout: "warning: /findings/0/severity: 'test-skipped' has default severity 'warn' (got 'fail')\nvalid (1 warning)\n", stderr: '', exitCode: 0 });
  });

  it("reads stdin when the file is '-' or omitted", async () => {
    const text = await readFile(join(EXAMPLES, 'valid', 'pass.json'), 'utf8');
    expect((await runValidate({ file: '-', readStdin: stdin(text) })).exitCode).toBe(0);
    expect((await runValidate({ readStdin: stdin(text) })).exitCode).toBe(0);
  });

  it('prints a JSON result with --json', async () => {
    const r = await runValidate({ file: join(EXAMPLES, 'invalid', 'missing-verdict.json'), json: true, readStdin: noStdin });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ valid: false, errors: [{ path: '/', message: "must have required property 'verdict'" }], warnings: [] });
  });

  it('exits 2 when the input cannot be read or is not JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ar-validate-'));
    const missing = join(dir, 'nope.json');
    const notJson = join(dir, 'r.json');
    await writeFile(notJson, '## Receipt: PASS\n');
    const read = await runValidate({ file: missing, readStdin: noStdin });
    expect(read).toMatchObject({ exitCode: 2, stdout: '' });
    expect(read.stderr).toMatch(new RegExp(`^trustbut: couldn't read ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: .+\\n$`));
    const bad = await runValidate({ file: notJson, readStdin: noStdin });
    expect(bad).toMatchObject({ exitCode: 2, stdout: '' });
    expect(bad.stderr).toMatch(/^trustbut: .*r\.json is not valid JSON: .+\n$/);
    expect(await runValidate({ readStdin: stdin('  \n') })).toEqual({ stdout: '', stderr: 'trustbut: no receipt given (pass a file, or pipe JSON on stdin)\n', exitCode: 2 });
    expect((await runValidate({ readStdin: stdin('{') })).stderr).toMatch(/^trustbut: stdin is not valid JSON: /);
  });

  it('with --json, also prints the exit-2 problem as a JSON result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ar-validate-'));
    const missing = join(dir, 'nope.json');
    const read = await runValidate({ file: missing, json: true, readStdin: noStdin });
    expect(read.exitCode).toBe(2);
    const message = read.stderr.replace(/^trustbut: /, '').replace(/\n$/, '');
    expect(message).toMatch(/^couldn't read /);
    expect(read.stdout).toBe(`${JSON.stringify({ valid: false, errors: [{ path: '/', message }], warnings: [] }, null, 2)}\n`);
    for (const text of ['  \n', '{']) {
      const r = await runValidate({ json: true, readStdin: stdin(text) });
      expect(r.exitCode).toBe(2);
      expect(JSON.parse(r.stdout)).toEqual({ valid: false, errors: [{ path: '/', message: r.stderr.slice('trustbut: '.length, -1) }], warnings: [] });
    }
  });

  it('accepts the receipt trustbut itself writes', async () => {
    const { dir } = await makeRepo({ 'README.md': '# a\n' });
    await writeFiles(dir, { 'README.md': '# b\n' });
    await commitAll(dir, 'change');
    const out = join(await mkdtemp(join(tmpdir(), 'ar-validate-')), 'receipt.json');
    await runVerify({ cwd: dir, base: 'HEAD~1', receiptJson: out });
    expect(await runValidate({ file: out, readStdin: noStdin })).toMatchObject({ exitCode: 0 });
  });
});

describe('trustbut validate (CLI)', () => {
  it('registers the validate command', () => {
    expect(buildProgram().commands.map((c) => c.name())).toContain('validate');
  });

  it('validates a receipt piped on stdin and exits with its code', async () => {
    const valid = await readFile(join(EXAMPLES, 'valid', 'fail.json'), 'utf8');
    const ok = await execa('node', ['--import', 'tsx', 'src/cli.ts', 'validate'], { cwd: ROOT, input: valid, reject: false });
    expect(ok).toMatchObject({ exitCode: 0, stdout: 'valid' });
    const bad = await execa('node', ['--import', 'tsx', 'src/cli.ts', 'validate', join(EXAMPLES, 'invalid', 'bad-spec-version.json')], { cwd: ROOT, reject: false });
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout).toMatch(/^error: \/specVersion: must match pattern/);
  }, 60_000);

  it('waits for the end of piped input, however slow the producer is', async () => {
    const valid = await readFile(join(EXAMPLES, 'valid', 'pass.json'), 'utf8');
    const child = execa('node', ['--import', 'tsx', 'src/cli.ts', 'validate'], { cwd: ROOT, reject: false });
    await new Promise((r) => setTimeout(r, 6000));
    child.stdin!.end(valid);
    expect(await child).toMatchObject({ exitCode: 0, stdout: 'valid' });
  }, 60_000);
});
