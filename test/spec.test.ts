import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import schema from '../spec/agent-receipt-v1.schema.json' with { type: 'json' };
import { CORE_FINDINGS, isCoreFindingId } from '../src/spec/catalog.js';
import { validateAgentReceipt } from '../src/spec/validate.js';

const EXAMPLES = fileURLToPath(new URL('../spec/examples/', import.meta.url));
const load = (path: string): unknown => JSON.parse(readFileSync(join(EXAMPLES, path), 'utf8'));
const ID_MESSAGE = 'must be a core finding id or a namespaced id (<namespace>/<id>)';

/** Each invalid example and the one error it must produce (also listed in spec/agent-receipt-v1.md). */
const INVALID: Record<string, { path: string; message: string }> = {
  'missing-verdict.json': { path: '/', message: "must have required property 'verdict'" },
  'bad-finding-id.json': { path: '/findings/0/id', message: ID_MESSAGE },
  'bad-finding-id-newer-minor.json': { path: '/findings/0/id', message: ID_MESSAGE },
  'unknown-field.json': { path: '/', message: "must not have additional property 'durationMs'" },
  'bad-spec-version.json': { path: '/specVersion', message: 'must match pattern "^1\\.(0|[1-9][0-9]*)$"' },
  'verdict-mismatch.json': { path: '/verdict', message: "must be 'warn' for these findings (got 'pass')" },
};

const base = () => ({
  specVersion: '1.0',
  producer: { name: 't', version: '1' },
  subject: { base: 'main', head: 'HEAD' },
  verdict: 'pass',
  findings: [] as Record<string, unknown>[],
});

describe('agent receipt v1 examples', () => {
  it.each(readdirSync(join(EXAMPLES, 'valid')))('valid/%s is valid with no warnings', (name) => {
    expect(validateAgentReceipt(load(`valid/${name}`))).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('every invalid example has an expected error', () => {
    expect(readdirSync(join(EXAMPLES, 'invalid')).sort()).toEqual(Object.keys(INVALID).sort());
  });

  it.each(Object.entries(INVALID))('invalid/%s fails with its expected error', (name, expected) => {
    const result = validateAgentReceipt(load(`invalid/${name}`));
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([expected]);
  });
});

describe('validateAgentReceipt', () => {
  it('rejects non-objects at the root', () => {
    for (const value of [null, [], 'receipt', 3]) {
      const result = validateAgentReceipt(value);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.path).toBe('/');
    }
  });

  it('accepts namespaced finding ids and rejects malformed ones', () => {
    const ok = { ...base(), verdict: 'warn', findings: [{ id: 'acme/secret-leak', severity: 'warn', title: 'x' }] };
    expect(validateAgentReceipt(ok).valid).toBe(true);
    for (const id of ['Acme/leak', 'acme/a/b', '/leak', 'acme/', 'not-a-core-id']) {
      const bad = { ...base(), verdict: 'warn', findings: [{ id, severity: 'warn', title: 'x' }] };
      expect(validateAgentReceipt(bad).errors).toEqual([{ path: '/findings/0/id', message: ID_MESSAGE }]);
    }
  });

  it('allows x- keys in every object and rejects other unknown keys', () => {
    const ok = {
      ...base(),
      'x-tool': { any: ['thing'] },
      producer: { name: 't', version: '1', 'x-build': 7 },
      subject: { base: 'main', head: 'HEAD', 'x-pr': 1 },
      tests: { passed: 1, failed: 0, errored: 0, skipped: 0, scope: 'full', 'x-ms': 3 },
      proofs: [{ file: 'a.test.ts', name: 'a', before: 'fail', after: 'pass', verdict: 'proves-change', 'x-id': 'a' }],
      risks: [{ file: 'src/a.ts', score: 1, reasons: ['r'], 'x-k': true }],
    };
    expect(validateAgentReceipt(ok)).toEqual({ valid: true, errors: [], warnings: [] });
    expect(validateAgentReceipt({ ...base(), 'X-Tool': 1 }).errors).toEqual([{ path: '/', message: "must not have additional property 'X-Tool'" }]);
    expect(validateAgentReceipt({ ...base(), subject: { base: 'a', head: 'b', ref: 'c' } }).errors).toEqual([
      { path: '/subject', message: "must not have additional property 'ref'" },
    ]);
  });

  it('applies the verdict rule: fail beats warn beats pass', () => {
    const fail = { id: 'test-focused', severity: 'fail', title: 'Test focused' };
    const warn = { id: 'test-skipped', severity: 'warn', title: 'Test skipped' };
    const info = { id: 'deps-changed', severity: 'info', title: 'Dependencies changed' };
    expect(validateAgentReceipt({ ...base(), verdict: 'fail', findings: [warn, fail, info] }).valid).toBe(true);
    expect(validateAgentReceipt({ ...base(), verdict: 'pass', findings: [info] }).valid).toBe(true);
    expect(validateAgentReceipt({ ...base(), verdict: 'warn', findings: [fail] }).errors).toEqual([
      { path: '/verdict', message: "must be 'fail' for these findings (got 'warn')" },
    ]);
  });

  it('warns, without failing, when a core id carries a non-default severity', () => {
    const r = { ...base(), verdict: 'fail', findings: [{ id: 'test-skipped', severity: 'fail', title: 'Test skipped' }] };
    expect(validateAgentReceipt(r)).toEqual({
      valid: true,
      errors: [],
      warnings: [{ path: '/findings/0/severity', message: "'test-skipped' has default severity 'warn' (got 'fail')" }],
    });
  });

  describe('a receipt from a newer 1.x minor', () => {
    const future = (specVersion: string) => ({
      ...base(),
      specVersion,
      coverage: { lines: 0.8 },
      verdict: 'warn',
      findings: [{ id: 'mutation-survived', severity: 'warn', title: 'A mutant survived' }],
    });

    it('is valid, with unknown fields and unknown core ids as warnings', () => {
      expect(validateAgentReceipt(future('1.1'))).toEqual({
        valid: true,
        errors: [],
        warnings: [
          { path: '/', message: "unknown in spec 1.0: 'coverage' (allowed for a newer 1.x receipt)" },
          { path: '/findings/0/id', message: "'mutation-survived' is not a 1.0 core id (allowed for a newer 1.x receipt)" },
        ],
      });
    });

    it('still applies the verdict rule to unknown ids by their severity', () => {
      const r = { ...future('1.1'), verdict: 'pass' };
      expect(validateAgentReceipt(r).errors).toEqual([{ path: '/verdict', message: "must be 'warn' for these findings (got 'pass')" }]);
    });

    it('is invalid when it declares 1.0', () => {
      const result = validateAgentReceipt(future('1.0'));
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        { path: '/', message: "must not have additional property 'coverage'" },
        { path: '/findings/0/id', message: ID_MESSAGE },
      ]);
    });

    it('is invalid for real type errors and malformed namespaced ids', () => {
      expect(validateAgentReceipt({ ...future('1.1'), verdict: 'nope' }).valid).toBe(false);
      const badNs = { ...future('1.1'), findings: [{ id: 'Acme/leak', severity: 'warn', title: 'x' }] };
      expect(validateAgentReceipt(badNs).errors).toEqual([{ path: '/findings/0/id', message: ID_MESSAGE }]);
    });

    it('is invalid for a malformed id that is neither core-id shaped nor namespaced', () => {
      for (const id of ['Not_Valid', 'Mutation-Survived', '-leading', 'has space', '']) {
        const bad = { ...future('1.1'), findings: [{ id, severity: 'warn', title: 'x' }] };
        const result = validateAgentReceipt(bad);
        expect(result.valid, id).toBe(false);
        expect(result.errors, id).toEqual([{ path: '/findings/0/id', message: ID_MESSAGE }]);
      }
    });
  });

  it('reports every problem, not just the first', () => {
    const r = { specVersion: '1.0', producer: { name: '' }, subject: { base: 'a', head: 'b' }, verdict: 'nope', findings: [] };
    const paths = validateAgentReceipt(r).errors.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['/producer', '/producer/name', '/verdict']));
  });
});

describe('core finding catalog', () => {
  it('matches the schema enum exactly', () => {
    const enumIds = (schema.$defs.findingId.anyOf[0] as { enum: string[] }).enum;
    expect([...enumIds].sort()).toEqual(Object.keys(CORE_FINDINGS).sort());
  });

  it('has 19 ids with their default severities', () => {
    expect(Object.keys(CORE_FINDINGS)).toHaveLength(19);
    expect(Object.entries(CORE_FINDINGS).filter(([, s]) => s === 'fail').map(([id]) => id).sort()).toEqual(['suite-failing', 'test-failing', 'test-focused']);
    expect(Object.entries(CORE_FINDINGS).filter(([, s]) => s === 'info').map(([id]) => id).sort()).toEqual(['deps-changed', 'tests-outside-root', 'uncommitted-changes']);
  });

  it('recognises core ids', () => {
    expect(isCoreFindingId('escape-added')).toBe(true);
    expect(isCoreFindingId('acme/escape-added')).toBe(false);
    expect(isCoreFindingId('toString')).toBe(false);
  });
});
