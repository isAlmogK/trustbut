# M4: Agent receipts open spec v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish trustbut's receipt as the open "agent receipts v1" format (spec, JSON Schema, examples), make `trustbut verify --json` emit it, and add `trustbut validate`.

**Architecture:**
- **`spec/`** holds the normative spec, the JSON Schema and the example receipts.
- **`src/spec/`** holds the core finding catalog, the validator (ajv, with the schema imported as a JSON module so it is bundled into `dist/cli.js`) and the serializer `toAgentReceipt()`. The serializer maps the unchanged internal `Receipt` to the spec shape.
- **What reads which format:**
  - `verify --json` and `--receipt-json` emit the spec shape.
  - Markdown and hooks keep using the internal `Receipt`.
  - The test helper `test/helpers/verify.ts` validates every receipt the existing e2e and runner suites produce.

**Tech Stack:** TypeScript (ESM, NodeNext, TS 7), Node ≥ 22, commander, Vitest, tsup, ajv 8 (`ajv/dist/2020.js`, draft 2020-12).

Design: `docs/superpowers/specs/2026-10-13-agent-receipts-spec-v1-design.md`.

## Global Constraints

- Imports use `.js` extensions (NodeNext). ESM only.
- `ajv` (`^8.20.0`) is the ONLY new runtime dependency. Import it as `import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';`.
- Import the schema as a JSON module: `import schema from '../../spec/agent-receipt-v1.schema.json' with { type: 'json' };`. This needs `"resolveJsonModule": true` in `tsconfig.json`. Never read the schema from disk by path, because `src/` and `dist/` sit at different depths.
- Schema `$id` and emitted `$schema`: `https://raw.githubusercontent.com/isAlmogK/trustbut/main/spec/agent-receipt-v1.schema.json`.
- Emitted `specVersion`: `"1.0"`. Accepted by the schema: `^1\.(0|[1-9][0-9]*)$`.
- Extension keys: `^x-[a-z0-9][a-z0-9-]*$`, allowed in every object; every other unknown key is rejected (`additionalProperties: false`).
- Namespaced finding id: `^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$`.
- Verdict rule: `fail` if any finding has severity `fail`; else `warn` if any has `warn`; else `pass`.
- No timestamps, durations or raw logs outside `x-` keys. The raw runner `output` is never written to JSON.
- `trustbut validate` exit codes: 0 valid (warnings allowed), 1 invalid, 2 can't read / not JSON / empty input.
- Version for this milestone: `0.4.0`.
- Git: don't use flags newer than git 2.17. On this machine run commands with `export PATH=/Users/Almog/.nvm/versions/node/v22.23.1/bin:/usr/bin:$PATH`.
- Test first. Before reporting a task done, run `npm run typecheck`, `npm test` and `npm run receipt`, and include the receipt in your report. A FAIL caused by your change blocks the task.
- Commit after each task with a conventional message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Finding catalog, JSON Schema, examples and validator

**Files:**
- Modify: `package.json` (add `ajv`), `package-lock.json` (via `npm install`), `tsconfig.json` (`resolveJsonModule`)
- Create: `src/spec/catalog.ts`
- Create: `src/spec/validate.ts`
- Create: `spec/agent-receipt-v1.schema.json`
- Create: `spec/examples/valid/{minimal,pass,warn,fail,third-party}.json`
- Create: `spec/examples/invalid/{missing-verdict,bad-finding-id,unknown-field,bad-spec-version,verdict-mismatch}.json`
- Test: `test/spec.test.ts`

**Interfaces:**
- Produces: `CORE_FINDINGS` (readonly map, id → `'fail' | 'warn' | 'info'`), `type CoreFindingId`, `isCoreFindingId(id: string): id is CoreFindingId` from `src/spec/catalog.ts`.
- Produces: `validateAgentReceipt(value: unknown): ValidationResult`, `interface ValidationProblem { path: string; message: string }`, `interface ValidationResult { valid: boolean; errors: ValidationProblem[]; warnings: ValidationProblem[] }` from `src/spec/validate.ts`. Paths are JSON Pointers with `/` for the root.

- [ ] **Step 1: Install ajv and enable JSON modules**

Run: `npm install ajv@^8.20.0`

In `tsconfig.json`, add `"resolveJsonModule": true` to `compilerOptions`. The result:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test", "vitest.config.ts", "tsup.config.ts"]
}
```

- [ ] **Step 2: Create the schema** at `spec/agent-receipt-v1.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://raw.githubusercontent.com/isAlmogK/trustbut/main/spec/agent-receipt-v1.schema.json",
  "title": "Agent receipt v1",
  "description": "Deterministic evidence about a code change made by an AI coding agent. Spec: spec/agent-receipt-v1.md",
  "type": "object",
  "required": ["specVersion", "producer", "subject", "verdict", "findings"],
  "properties": {
    "$schema": { "type": "string" },
    "specVersion": { "type": "string", "pattern": "^1\\.(0|[1-9][0-9]*)$" },
    "producer": { "$ref": "#/$defs/producer" },
    "subject": { "$ref": "#/$defs/subject" },
    "verdict": { "$ref": "#/$defs/verdict" },
    "tests": { "$ref": "#/$defs/tests" },
    "proofs": { "type": "array", "items": { "$ref": "#/$defs/proof" } },
    "findings": { "type": "array", "items": { "$ref": "#/$defs/finding" } },
    "risks": { "type": "array", "items": { "$ref": "#/$defs/risk" } }
  },
  "patternProperties": { "^x-[a-z0-9][a-z0-9-]*$": true },
  "additionalProperties": false,
  "$defs": {
    "verdict": { "enum": ["pass", "warn", "fail"] },
    "severity": { "enum": ["fail", "warn", "info"] },
    "outcome": { "enum": ["pass", "fail", "error", "skip"] },
    "count": { "type": "integer", "minimum": 0 },
    "producer": {
      "type": "object",
      "required": ["name", "version"],
      "properties": {
        "name": { "type": "string", "minLength": 1 },
        "version": { "type": "string", "minLength": 1 },
        "url": { "type": "string", "minLength": 1 }
      },
      "patternProperties": { "^x-[a-z0-9][a-z0-9-]*$": true },
      "additionalProperties": false
    },
    "subject": {
      "type": "object",
      "required": ["base", "head"],
      "properties": {
        "base": { "type": "string", "minLength": 1 },
        "head": { "type": "string", "minLength": 1 },
        "headRef": { "type": "string", "minLength": 1 }
      },
      "patternProperties": { "^x-[a-z0-9][a-z0-9-]*$": true },
      "additionalProperties": false
    },
    "tests": {
      "type": "object",
      "required": ["passed", "failed", "errored", "skipped", "scope"],
      "properties": {
        "passed": { "$ref": "#/$defs/count" },
        "failed": { "$ref": "#/$defs/count" },
        "errored": { "$ref": "#/$defs/count" },
        "skipped": { "$ref": "#/$defs/count" },
        "scope": { "enum": ["full", "changed"] }
      },
      "patternProperties": { "^x-[a-z0-9][a-z0-9-]*$": true },
      "additionalProperties": false
    },
    "proof": {
      "type": "object",
      "required": ["file", "name", "before", "after", "verdict"],
      "properties": {
        "file": { "type": "string", "minLength": 1 },
        "name": { "type": "string" },
        "before": { "enum": ["pass", "fail", "error", "skip", "missing"] },
        "after": { "$ref": "#/$defs/outcome" },
        "verdict": { "enum": ["proves-change", "does-not-constrain", "failing", "skipped"] }
      },
      "patternProperties": { "^x-[a-z0-9][a-z0-9-]*$": true },
      "additionalProperties": false
    },
    "findingId": {
      "anyOf": [
        {
          "enum": [
            "test-focused", "suite-failing", "test-failing",
            "test-skipped", "tests-removed", "assertions-removed", "snapshot-changed", "test-config-changed",
            "escape-added", "no-tests-changed", "no-test-results", "test-passes-without-change", "no-runner",
            "base-run-failed", "proofs-unmatched", "deps-not-installed",
            "deps-changed", "tests-outside-root", "uncommitted-changes"
          ]
        },
        { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$" }
      ]
    },
    "finding": {
      "type": "object",
      "required": ["id", "severity", "title"],
      "properties": {
        "id": { "$ref": "#/$defs/findingId" },
        "severity": { "$ref": "#/$defs/severity" },
        "title": { "type": "string", "minLength": 1 },
        "file": { "type": "string" },
        "line": { "type": "integer", "minimum": 1 },
        "detail": { "type": "string" }
      },
      "patternProperties": { "^x-[a-z0-9][a-z0-9-]*$": true },
      "additionalProperties": false
    },
    "risk": {
      "type": "object",
      "required": ["file", "score", "reasons"],
      "properties": {
        "file": { "type": "string", "minLength": 1 },
        "score": { "type": "number", "minimum": 0 },
        "reasons": { "type": "array", "items": { "type": "string" } }
      },
      "patternProperties": { "^x-[a-z0-9][a-z0-9-]*$": true },
      "additionalProperties": false
    }
  }
}
```

- [ ] **Step 3: Create the example receipts**

`spec/examples/valid/minimal.json` (a later 1.x minor version, only the required fields):
```json
{
  "specVersion": "1.2",
  "producer": { "name": "example-tool", "version": "1.0.0" },
  "subject": { "base": "main", "head": "HEAD" },
  "verdict": "pass",
  "findings": []
}
```

`spec/examples/valid/pass.json`:
```json
{
  "$schema": "https://raw.githubusercontent.com/isAlmogK/trustbut/main/spec/agent-receipt-v1.schema.json",
  "specVersion": "1.0",
  "producer": { "name": "trustbut", "version": "0.4.0" },
  "subject": { "base": "3f2a91c0d4b6e8a1f2c3d4e5f6a7b8c9d0e1f2a3", "head": "8be04d1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e" },
  "verdict": "pass",
  "tests": { "passed": 42, "failed": 0, "errored": 0, "skipped": 0, "scope": "full" },
  "proofs": [
    { "file": "test/sum.test.ts", "name": "adds negative numbers", "before": "fail", "after": "pass", "verdict": "proves-change" }
  ],
  "findings": [],
  "risks": []
}
```

`spec/examples/valid/warn.json`:
```json
{
  "$schema": "https://raw.githubusercontent.com/isAlmogK/trustbut/main/spec/agent-receipt-v1.schema.json",
  "specVersion": "1.0",
  "producer": { "name": "trustbut", "version": "0.4.0" },
  "subject": { "base": "3f2a91c0d4b6e8a1f2c3d4e5f6a7b8c9d0e1f2a3", "head": "8be04d1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e" },
  "verdict": "warn",
  "tests": { "passed": 41, "failed": 0, "errored": 0, "skipped": 1, "scope": "full" },
  "proofs": [
    { "file": "test/auth.test.ts", "name": "refreshes a token", "before": "fail", "after": "pass", "verdict": "proves-change" },
    { "file": "test/auth.test.ts", "name": "rejects expired token", "before": "pass", "after": "pass", "verdict": "does-not-constrain" }
  ],
  "findings": [
    { "id": "test-passes-without-change", "severity": "warn", "title": "Test passes without the change", "file": "test/auth.test.ts", "detail": "rejects expired token" },
    { "id": "test-skipped", "severity": "warn", "title": "Test skipped", "file": "test/auth.test.ts", "line": 88, "detail": "it.skip('handles clock skew', () => {" },
    { "id": "escape-added", "severity": "warn", "title": "cast to any", "file": "src/auth/session.ts", "line": 41, "detail": "const claims = decoded as any;" }
  ],
  "risks": [
    { "file": "src/auth/session.ts", "score": 5, "reasons": ["auth/permissions", "has findings"] },
    { "file": "package.json", "score": 2, "reasons": ["dependencies"] }
  ],
  "x-trustbut": { "runner": "vitest", "languages": ["js"], "root": ".", "after": { "exitCode": 0, "durationMs": 8123, "cases": [] } }
}
```

`spec/examples/valid/fail.json`:
```json
{
  "$schema": "https://raw.githubusercontent.com/isAlmogK/trustbut/main/spec/agent-receipt-v1.schema.json",
  "specVersion": "1.0",
  "producer": { "name": "trustbut", "version": "0.4.0" },
  "subject": { "base": "3f2a91c0d4b6e8a1f2c3d4e5f6a7b8c9d0e1f2a3", "head": "9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d", "headRef": "working tree" },
  "verdict": "fail",
  "tests": { "passed": 12, "failed": 1, "errored": 0, "skipped": 0, "scope": "changed" },
  "proofs": [
    { "file": "test/a.test.js", "name": "works", "before": "missing", "after": "fail", "verdict": "failing" }
  ],
  "findings": [
    { "id": "test-focused", "severity": "fail", "title": "Test focused", "file": "test/a.test.js", "line": 3, "detail": "it.only('works', () => {" },
    { "id": "test-failing", "severity": "fail", "title": "Test fails at head", "file": "test/a.test.js", "detail": "works" }
  ]
}
```

`spec/examples/valid/third-party.json` (another producer, a namespaced finding, extensions):
```json
{
  "specVersion": "1.0",
  "producer": { "name": "acme-guard", "version": "2.1.0", "url": "https://example.com/acme-guard" },
  "subject": { "base": "origin/main", "head": "feature/login", "x-acme": { "pr": 42 } },
  "verdict": "warn",
  "findings": [
    { "id": "acme/secret-leak", "severity": "warn", "title": "Possible secret in a test fixture", "file": "test/fixtures/env.json", "line": 3, "x-acme": { "rule": "aws-access-key" } },
    { "id": "deps-changed", "severity": "info", "title": "Dependencies changed" }
  ],
  "x-acme": { "scanMs": 120 }
}
```

`spec/examples/invalid/missing-verdict.json`:
```json
{
  "specVersion": "1.0",
  "producer": { "name": "trustbut", "version": "0.4.0" },
  "subject": { "base": "main", "head": "HEAD" },
  "findings": []
}
```

`spec/examples/invalid/bad-finding-id.json`:
```json
{
  "specVersion": "1.0",
  "producer": { "name": "trustbut", "version": "0.4.0" },
  "subject": { "base": "main", "head": "HEAD" },
  "verdict": "warn",
  "findings": [{ "id": "Escape_Added", "severity": "warn", "title": "cast to any" }]
}
```

`spec/examples/invalid/unknown-field.json` (a duration belongs under an `x-` key):
```json
{
  "specVersion": "1.0",
  "producer": { "name": "trustbut", "version": "0.4.0" },
  "subject": { "base": "main", "head": "HEAD" },
  "verdict": "pass",
  "findings": [],
  "durationMs": 812
}
```

`spec/examples/invalid/bad-spec-version.json`:
```json
{
  "specVersion": "2.0",
  "producer": { "name": "trustbut", "version": "0.4.0" },
  "subject": { "base": "main", "head": "HEAD" },
  "verdict": "pass",
  "findings": []
}
```

`spec/examples/invalid/verdict-mismatch.json` (schema-valid, breaks the verdict rule):
```json
{
  "specVersion": "1.0",
  "producer": { "name": "trustbut", "version": "0.4.0" },
  "subject": { "base": "main", "head": "HEAD" },
  "verdict": "pass",
  "findings": [{ "id": "test-skipped", "severity": "warn", "title": "Test skipped", "file": "test/a.test.js", "line": 9 }]
}
```

- [ ] **Step 4: Write the failing tests** in `test/spec.test.ts`

```ts
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
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run test/spec.test.ts`
Expected: FAIL. The modules `../src/spec/catalog.js` and `../src/spec/validate.js` can't be found.

- [ ] **Step 6: Create `src/spec/catalog.ts`**

```ts
import type { Severity } from '../types.js';

/** Core finding ids of agent receipts v1 with their default severity (spec/agent-receipt-v1.md, "Finding catalog"). */
export const CORE_FINDINGS = {
  'test-focused': 'fail',
  'suite-failing': 'fail',
  'test-failing': 'fail',
  'test-skipped': 'warn',
  'tests-removed': 'warn',
  'assertions-removed': 'warn',
  'snapshot-changed': 'warn',
  'test-config-changed': 'warn',
  'escape-added': 'warn',
  'no-tests-changed': 'warn',
  'no-test-results': 'warn',
  'test-passes-without-change': 'warn',
  'no-runner': 'warn',
  'base-run-failed': 'warn',
  'proofs-unmatched': 'warn',
  'deps-not-installed': 'warn',
  'deps-changed': 'info',
  'tests-outside-root': 'info',
  'uncommitted-changes': 'info',
} as const satisfies Record<string, Severity>;

export type CoreFindingId = keyof typeof CORE_FINDINGS;

export function isCoreFindingId(id: string): id is CoreFindingId {
  return Object.hasOwn(CORE_FINDINGS, id);
}
```

- [ ] **Step 7: Create `src/spec/validate.ts`**

```ts
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import schema from '../../spec/agent-receipt-v1.schema.json' with { type: 'json' };
import { CORE_FINDINGS, isCoreFindingId } from './catalog.js';

export interface ValidationProblem {
  /** JSON Pointer to the offending value; '/' is the receipt itself. */
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationProblem[];
  warnings: ValidationProblem[];
}

const ID_MESSAGE = 'must be a core finding id or a namespaced id (<namespace>/<id>)';
const FINDING_ID_PATH = /^\/findings\/\d+\/id$/;

const checkSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function describe(e: ErrorObject): string {
  if (e.keyword === 'required') return `must have required property '${(e.params as { missingProperty: string }).missingProperty}'`;
  if (e.keyword === 'additionalProperties') return `must not have additional property '${(e.params as { additionalProperty: string }).additionalProperty}'`;
  return e.message ?? e.keyword;
}

/** ajv errors as problems: one message per bad finding id instead of the enum/pattern/anyOf triple, no duplicates. */
function schemaProblems(errors: ErrorObject[]): ValidationProblem[] {
  const idPaths = new Set(errors.filter((e) => e.keyword === 'anyOf' && FINDING_ID_PATH.test(e.instancePath)).map((e) => e.instancePath));
  const seen = new Set<string>();
  const out: ValidationProblem[] = [];
  for (const e of errors) {
    if (idPaths.has(e.instancePath) && e.keyword !== 'anyOf') continue;
    const problem = { path: e.instancePath || '/', message: idPaths.has(e.instancePath) ? ID_MESSAGE : describe(e) };
    const key = `${problem.path}\n${problem.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(problem);
    }
  }
  return out;
}

interface CheckedFinding {
  id: string;
  severity: 'fail' | 'warn' | 'info';
}

/** Checks a parsed receipt against agent receipts v1: the JSON Schema, then the verdict rule; non-default core severities are warnings. */
export function validateAgentReceipt(value: unknown): ValidationResult {
  if (!checkSchema(value)) return { valid: false, errors: schemaProblems(checkSchema.errors ?? []), warnings: [] };
  const receipt = value as { verdict: string; findings: CheckedFinding[] };
  const errors: ValidationProblem[] = [];
  const expected = receipt.findings.some((f) => f.severity === 'fail') ? 'fail' : receipt.findings.some((f) => f.severity === 'warn') ? 'warn' : 'pass';
  if (receipt.verdict !== expected) errors.push({ path: '/verdict', message: `must be '${expected}' for these findings (got '${receipt.verdict}')` });
  const warnings = receipt.findings.flatMap((f, i) =>
    isCoreFindingId(f.id) && f.severity !== CORE_FINDINGS[f.id]
      ? [{ path: `/findings/${i}/severity`, message: `'${f.id}' has default severity '${CORE_FINDINGS[f.id]}' (got '${f.severity}')` }]
      : [],
  );
  return { valid: errors.length === 0, errors, warnings };
}
```

If ajv's strict mode rejects something in the schema at compile time, fix the schema, not the strict flag, and say so in your report.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/spec.test.ts`
Expected: PASS, every test. If `bad-spec-version.json` reports the pattern with different escaping, assert ajv's real message: print `result.errors` and copy the exact string into `INVALID`.

- [ ] **Step 9: Full checks and commit**

Run: `npm run typecheck && npm test && npm run receipt`
Expected: typecheck clean, all tests pass, receipt PASS (or WARN only for `deps-changed`, which is info).

```bash
git add package.json package-lock.json tsconfig.json src/spec spec test/spec.test.ts
git commit -m "feat: agent receipts v1 schema, examples and validator"
```

---

### Task 2: Serializer, spec-format `--json`, conformance checks

**Files:**
- Create: `src/spec/types.ts`
- Create: `src/spec/serialize.ts`
- Modify: `src/commands/verify.ts:140-150` (the two `JSON.stringify(receipt, null, 2)` calls)
- Modify: `src/program.ts` (the `--json` option description)
- Create: `test/helpers/verify.ts`
- Modify: the `runVerify` import line in `test/e2e.test.ts`, `test/abort.test.ts`, `test/jest.test.ts`, and every `test/runners/*.test.ts` that imports `runVerify` from `src/commands/verify.js`
- Modify: `test/e2e.test.ts:168-172` (the "prints JSON with --json" test)
- Test: `test/serialize.test.ts`

**Interfaces:**
- Consumes: `validateAgentReceipt(value: unknown): ValidationResult` from `src/spec/validate.ts` (Task 1).
- Consumes: `Receipt`, `RunResult`, `TestCaseResult`, `Verdict`, `Severity`, `RunScope`, `TestOutcome`, `ProofVerdict` from `src/types.ts`; `VERSION` from `src/version.ts`.
- Produces: `SCHEMA_URL`, `SPEC_VERSION`, `interface AgentReceiptV1`, `interface TrustbutExtension`, `interface TrustbutRun` from `src/spec/types.ts`.
- Produces: `toAgentReceipt(receipt: Receipt): AgentReceiptV1` from `src/spec/serialize.ts`.
- Produces: `runVerify(opts?: VerifyOptions)` from `test/helpers/verify.ts`: same signature and result as the real one, and it also asserts conformance.

- [ ] **Step 1: Write the failing serializer tests** in `test/serialize.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { toAgentReceipt } from '../src/spec/serialize.js';
import { SCHEMA_URL } from '../src/spec/types.js';
import { validateAgentReceipt } from '../src/spec/validate.js';
import type { Receipt } from '../src/types.js';
import { VERSION } from '../src/version.js';

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  version: 1,
  base: 'aaa',
  head: 'bbb',
  runner: 'vitest',
  languages: ['js'],
  root: '.',
  scope: 'full',
  verdict: 'warn',
  after: {
    exitCode: 1,
    durationMs: 1234,
    output: 'SECRET=hunter2 and a very long log',
    cases: [
      { id: 'a', file: 't.test.ts', name: 'a', outcome: 'pass' },
      { id: 'b', file: 't.test.ts', name: 'b', outcome: 'fail', message: 'expected 1 to be 2' },
      { id: 'c', file: 't.test.ts', name: 'c', outcome: 'error' },
      { id: 'd', file: 't.test.ts', name: 'd', outcome: 'skip' },
      { id: 'e', file: 't.test.ts', name: 'e', outcome: 'pass' },
    ],
  },
  before: { exitCode: 0, durationMs: 50, output: 'base log', cases: [], timedOut: true },
  proofs: [{ id: 't.test.ts::a', file: 't.test.ts', name: 'a', before: 'pass', after: 'pass', verdict: 'does-not-constrain', weak: false }],
  findings: [
    { id: 'test-passes-without-change', severity: 'warn', title: 'Test passes without the change', file: 't.test.ts', detail: 'a' },
    { id: 'deps-changed', severity: 'info', title: 'Dependencies changed' },
  ],
  risks: [{ file: 'src/a.ts', score: 1, reasons: ['large change (250 lines)'] }],
  ...over,
});

describe('toAgentReceipt', () => {
  it('maps the core fields', () => {
    const r = toAgentReceipt(receipt({ headRef: 'working tree' }));
    expect(r.$schema).toBe(SCHEMA_URL);
    expect(r.specVersion).toBe('1.0');
    expect(r.producer).toEqual({ name: 'trustbut', version: VERSION });
    expect(r.subject).toEqual({ base: 'aaa', head: 'bbb', headRef: 'working tree' });
    expect(r.verdict).toBe('warn');
    expect(r.findings).toEqual([
      { id: 'test-passes-without-change', severity: 'warn', title: 'Test passes without the change', file: 't.test.ts', detail: 'a' },
      { id: 'deps-changed', severity: 'info', title: 'Dependencies changed' },
    ]);
    expect(r.risks).toEqual([{ file: 'src/a.ts', score: 1, reasons: ['large change (250 lines)'] }]);
  });

  it('omits headRef for a plain commit', () => {
    expect(toAgentReceipt(receipt()).subject).toEqual({ base: 'aaa', head: 'bbb' });
  });

  it('counts the head run into tests', () => {
    expect(toAgentReceipt(receipt()).tests).toEqual({ passed: 2, failed: 1, errored: 1, skipped: 1, scope: 'full' });
    expect(toAgentReceipt(receipt({ scope: 'changed' })).tests?.scope).toBe('changed');
  });

  it('omits tests when the tests did not run', () => {
    expect(toAgentReceipt(receipt({ after: undefined, before: undefined }))).not.toHaveProperty('tests');
  });

  it('drops the internal proof id and weak flag', () => {
    expect(toAgentReceipt(receipt()).proofs).toEqual([{ file: 't.test.ts', name: 'a', before: 'pass', after: 'pass', verdict: 'does-not-constrain' }]);
  });

  it('keeps trustbut detail under x-trustbut, without the raw runner output', () => {
    const r = toAgentReceipt(receipt());
    expect(r['x-trustbut']).toEqual({
      runner: 'vitest',
      languages: ['js'],
      root: '.',
      after: { exitCode: 1, durationMs: 1234, cases: receipt().after!.cases },
      before: { exitCode: 0, durationMs: 50, timedOut: true, cases: [] },
    });
    expect(JSON.stringify(r)).not.toContain('hunter2');
    expect(JSON.stringify(r)).not.toContain('"output"');
  });

  it('produces a valid agent receipt', () => {
    expect(validateAgentReceipt(JSON.parse(JSON.stringify(toAgentReceipt(receipt()))))).toEqual({ valid: true, errors: [], warnings: [] });
    expect(validateAgentReceipt(JSON.parse(JSON.stringify(toAgentReceipt(receipt({ runner: null, after: undefined, before: undefined, findings: [], verdict: 'pass' })))))).toEqual({ valid: true, errors: [], warnings: [] });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/serialize.test.ts`
Expected: FAIL. `../src/spec/serialize.js` and `../src/spec/types.js` can't be found.

- [ ] **Step 3: Create `src/spec/types.ts`**

```ts
import type { ProofVerdict, RunScope, Severity, TestCaseResult, TestOutcome, Verdict } from '../types.js';

export const SCHEMA_URL = 'https://raw.githubusercontent.com/isAlmogK/trustbut/main/spec/agent-receipt-v1.schema.json';
export const SPEC_VERSION = '1.0';

/** One test run as trustbut reports it under x-trustbut (no raw output). */
export interface TrustbutRun {
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
  cases: TestCaseResult[];
}

/** trustbut's producer-specific detail (the `x-trustbut` key). */
export interface TrustbutExtension {
  runner: string | null;
  languages: string[];
  root: string;
  after?: TrustbutRun;
  before?: TrustbutRun;
}

/** An agent receipt, spec v1 (spec/agent-receipt-v1.md). */
export interface AgentReceiptV1 {
  $schema: string;
  specVersion: string;
  producer: { name: string; version: string; url?: string };
  subject: { base: string; head: string; headRef?: string };
  verdict: Verdict;
  tests?: { passed: number; failed: number; errored: number; skipped: number; scope: RunScope };
  proofs?: { file: string; name: string; before: TestOutcome | 'missing'; after: TestOutcome; verdict: ProofVerdict }[];
  findings: { id: string; severity: Severity; title: string; file?: string; line?: number; detail?: string }[];
  risks?: { file: string; score: number; reasons: string[] }[];
  'x-trustbut'?: TrustbutExtension;
}
```

- [ ] **Step 4: Create `src/spec/serialize.ts`**

```ts
import type { Receipt, RunResult, TestOutcome } from '../types.js';
import { VERSION } from '../version.js';
import { SCHEMA_URL, SPEC_VERSION, type AgentReceiptV1, type TrustbutRun } from './types.js';

function run(r: RunResult): TrustbutRun {
  return { exitCode: r.exitCode, durationMs: r.durationMs, ...(r.timedOut ? { timedOut: true } : {}), cases: r.cases };
}

/** trustbut's internal receipt as an agent receipt v1 (what `--json` and `--receipt-json` write). */
export function toAgentReceipt(receipt: Receipt): AgentReceiptV1 {
  const cases = receipt.after?.cases ?? [];
  const count = (outcome: TestOutcome) => cases.filter((c) => c.outcome === outcome).length;
  return {
    $schema: SCHEMA_URL,
    specVersion: SPEC_VERSION,
    producer: { name: 'trustbut', version: VERSION },
    subject: { base: receipt.base, head: receipt.head, ...(receipt.headRef ? { headRef: receipt.headRef } : {}) },
    verdict: receipt.verdict,
    ...(receipt.after
      ? { tests: { passed: count('pass'), failed: count('fail'), errored: count('error'), skipped: count('skip'), scope: receipt.scope } }
      : {}),
    proofs: receipt.proofs.map(({ file, name, before, after, verdict }) => ({ file, name, before, after, verdict })),
    findings: receipt.findings.map(({ id, severity, title, file, line, detail }) => ({
      id,
      severity,
      title,
      ...(file !== undefined ? { file } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(detail !== undefined ? { detail } : {}),
    })),
    risks: receipt.risks,
    'x-trustbut': {
      runner: receipt.runner,
      languages: receipt.languages,
      root: receipt.root,
      ...(receipt.after ? { after: run(receipt.after) } : {}),
      ...(receipt.before ? { before: run(receipt.before) } : {}),
    },
  };
}
```

- [ ] **Step 5: Run the serializer tests to verify they pass**

Run: `npx vitest run test/serialize.test.ts`
Expected: PASS.

- [ ] **Step 6: Update the e2e JSON test first, so it fails**

In `test/e2e.test.ts`, replace the body of `it('prints JSON with --json', …)` with:

```ts
  it('prints JSON with --json: an agent receipt v1', async () => {
    const dir = await scenario({ 'README.md': '# hi\n' });
    const { output } = await runVerify({ cwd: dir, json: true });
    const json = JSON.parse(output);
    expect(json).toMatchObject({ specVersion: '1.0', producer: { name: 'trustbut', version: VERSION }, verdict: 'pass' });
    expect(json).not.toHaveProperty('version');
    expect(output).not.toContain('"output"');
  });
```

Add `import { VERSION } from '../src/version.js';` to the imports of `test/e2e.test.ts` if it isn't there.

Run: `npx vitest run test/e2e.test.ts -t "agent receipt v1"`
Expected: FAIL (`specVersion` is missing; the old JSON has `version: 1`).

- [ ] **Step 7: Emit the spec format** in `src/commands/verify.ts`

Add `import { toAgentReceipt } from '../spec/serialize.js';` to the imports. Then replace the output block (currently `const output = opts.json ? \`${JSON.stringify(receipt, null, 2)}\n\` : renderMarkdown(receipt);` and the later `if (opts.receiptJson) await write(opts.receiptJson, \`${JSON.stringify(receipt, null, 2)}\n\`);`) so both use one serialized string:

```ts
  const json = `${JSON.stringify(toAgentReceipt(receipt), null, 2)}\n`;
  const output = opts.json ? json : renderMarkdown(receipt);
```

and

```ts
  if (opts.receiptJson) await write(opts.receiptJson, json);
```

Leave the `receiptMd` line and everything else unchanged. The function still returns the internal `receipt`.

In `src/program.ts`, change the option description to `.option('--json', 'print the receipt as JSON (agent receipt v1, see spec/agent-receipt-v1.md)')`.

Run: `npx vitest run test/e2e.test.ts -t "agent receipt v1"`
Expected: PASS.

- [ ] **Step 8: Add the conformance helper** at `test/helpers/verify.ts`

```ts
import { expect } from 'vitest';
import { runVerify as realRunVerify, type VerifyOptions } from '../../src/commands/verify.js';
import { toAgentReceipt } from '../../src/spec/serialize.js';
import { validateAgentReceipt } from '../../src/spec/validate.js';

/**
 * runVerify, plus spec conformance: every receipt the e2e and runner suites produce must be a valid
 * agent receipt v1 with no warnings, exactly as `--json` would print it.
 */
export async function runVerify(opts?: VerifyOptions): Promise<Awaited<ReturnType<typeof realRunVerify>>> {
  const result = await realRunVerify(opts);
  const printed: unknown = JSON.parse(JSON.stringify(toAgentReceipt(result.receipt)));
  expect(validateAgentReceipt(printed)).toEqual({ valid: true, errors: [], warnings: [] });
  return result;
}
```

Check the real signature first (`grep -n "export async function runVerify" src/commands/verify.ts`). If `opts` isn't optional there, make the helper's parameter match it exactly.

- [ ] **Step 9: Route the suites through the helper**

Find the files: `grep -rln "import { runVerify } from '.*src/commands/verify.js'" test`

In each file found, change only that import line:
- `test/*.test.ts`: `import { runVerify } from './helpers/verify.js';`
- `test/runners/*.test.ts`: `import { runVerify } from '../helpers/verify.js';`

Leave any file that mocks `src/commands/verify.js` (`vi.mock`) or imports other names from it alongside `runVerify`. For the latter, split the import so `runVerify` comes from the helper and the other names still come from `src/commands/verify.js`.

- [ ] **Step 10: Run the whole suite**

Run: `npm test`
Expected: PASS.

If a conformance assertion fails, it means trustbut emits something the spec rejects. Fix the producer side (the serializer, or the finding that has an empty title or `line: 0`), never the helper or the schema, and say what you fixed in the report.

- [ ] **Step 11: Typecheck, receipt, commit**

Run: `npm run typecheck && npm run receipt`

```bash
git add src/spec/types.ts src/spec/serialize.ts src/commands/verify.ts src/program.ts test/helpers/verify.ts test/serialize.test.ts test
git commit -m "feat!: --json and --receipt-json emit agent receipt v1"
```

---

### Task 3: `trustbut validate`

**Files:**
- Create: `src/commands/validate.ts`
- Modify: `src/program.ts` (register the command; reuse the existing `readStdin`)
- Test: `test/validate.test.ts`

**Interfaces:**
- Consumes: `validateAgentReceipt`, `ValidationResult` from `src/spec/validate.ts` (Task 1); `runVerify` from `test/helpers/verify.ts` (Task 2); `makeRepo`, `writeFiles`, `commitAll` from `test/helpers/repo.ts`.
- Produces: `runValidate(opts: ValidateOptions): Promise<ValidateRun>` with `interface ValidateOptions { file?: string; json?: boolean; readStdin: () => Promise<string> }` and `interface ValidateRun { stdout: string; stderr: string; exitCode: 0 | 1 | 2 }`.

Output contract:
- **Text mode:** one line per error, `error: <path>: <message>`, then one per warning, `warning: <path>: <message>`. The last line is `valid`, `valid (1 warning)`, `valid (N warnings)`, `invalid (1 error)` or `invalid (N errors)`.
- **`--json`:** `JSON.stringify({ valid, errors, warnings }, null, 2) + '\n'`.
- **Unreadable input** (exit 2, stdout empty; stderr ends with a newline):

  | Problem | stderr |
  |---|---|
  | file can't be read | `trustbut: couldn't read <file>: <reason>` |
  | input is empty or whitespace | `trustbut: no receipt given (pass a file, or pipe JSON on stdin)` |
  | input isn't JSON | `trustbut: <file or "stdin"> is not valid JSON: <reason>` |

- [ ] **Step 1: Write the failing tests** in `test/validate.test.ts`

```ts
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
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/validate.test.ts`
Expected: FAIL. `../src/commands/validate.js` can't be found.

- [ ] **Step 3: Create `src/commands/validate.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { validateAgentReceipt } from '../spec/validate.js';

export interface ValidateOptions {
  /** Receipt file; '-' or undefined reads stdin. */
  file?: string;
  json?: boolean;
  readStdin: () => Promise<string>;
}

export interface ValidateRun {
  stdout: string;
  stderr: string;
  exitCode: 0 | 1 | 2;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fatal = (message: string): ValidateRun => ({ stdout: '', stderr: `trustbut: ${message}\n`, exitCode: 2 });

/** `trustbut validate`: checks one receipt against agent receipts v1. Exit 0 valid, 1 invalid, 2 unreadable input. */
export async function runValidate(opts: ValidateOptions): Promise<ValidateRun> {
  const fromStdin = opts.file === undefined || opts.file === '-';
  let text: string;
  try {
    text = fromStdin ? await opts.readStdin() : await readFile(opts.file!, 'utf8');
  } catch (err) {
    return fatal(`couldn't read ${opts.file ?? 'stdin'}: ${(err as Error).message}`);
  }
  if (!text.trim()) return fatal('no receipt given (pass a file, or pipe JSON on stdin)');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return fatal(`${fromStdin ? 'stdin' : opts.file} is not valid JSON: ${(err as Error).message}`);
  }
  const result = validateAgentReceipt(value);
  const exitCode = result.valid ? 0 : 1;
  if (opts.json) return { stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '', exitCode };
  const lines = [
    ...result.errors.map((e) => `error: ${e.path}: ${e.message}`),
    ...result.warnings.map((w) => `warning: ${w.path}: ${w.message}`),
    result.valid
      ? result.warnings.length ? `valid (${plural(result.warnings.length, 'warning')})` : 'valid'
      : `invalid (${plural(result.errors.length, 'error')})`,
  ];
  return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode };
}
```

- [ ] **Step 4: Register the command** in `src/program.ts`

Add `import { runValidate } from './commands/validate.js';` to the imports. Insert this block after the `verify` command and before `init`:

```ts
  program
    .command('validate')
    .description('Check an agent receipt (JSON) against the agent receipts v1 spec')
    .argument('[file]', 'the receipt file; "-" or omitted reads stdin')
    .option('--json', 'print the result as JSON')
    .action(async (file: string | undefined, opts: { json?: boolean }) => {
      const result = await runValidate({ file, json: opts.json, readStdin: () => readStdin() });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    });
```

`readStdin` is the function already defined at the bottom of `src/program.ts`. A function declaration is hoisted, so using it here is fine.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/validate.test.ts`
Expected: PASS.

- [ ] **Step 6: Full checks and commit**

Run: `npm run typecheck && npm test && npm run receipt`

```bash
git add src/commands/validate.ts src/program.ts test/validate.test.ts
git commit -m "feat: trustbut validate checks any agent receipt against spec v1"
```

---

### Task 4: The spec document, docs and the 0.4.0 release bump

**Files:**
- Create: `spec/agent-receipt-v1.md`
- Modify: `docs/SPEC.md` (§6 Receipt)
- Modify: `README.md` (new section, nav, `--json` mentions, roadmap bullet)
- Modify: `docs/ROADMAP.md` (v0.4 row)
- Modify: `CHANGELOG.md`
- Modify: `package.json` (`files`, version via bump), `package-lock.json`, `integrations/claude-code/.claude-plugin/plugin.json` (via bump)
- Test: `test/spec-doc.test.ts`

**Interfaces:**
- Consumes: `CORE_FINDINGS` from `src/spec/catalog.ts` (Task 1). The invalid examples and their expected errors come from `test/spec.test.ts` (Task 1).

- [ ] **Step 1: Write the failing drift tests** in `test/spec-doc.test.ts`

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CORE_FINDINGS } from '../src/spec/catalog.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('spec/agent-receipt-v1.md', () => {
  const doc = read('spec/agent-receipt-v1.md');

  it('lists exactly the core finding ids, each with its default severity', () => {
    const rows = [...doc.matchAll(/^\| `([a-z-]+)` \| `(fail|warn|info)` \|/gm)].map((m) => [m[1], m[2]]);
    expect(Object.fromEntries(rows)).toEqual(CORE_FINDINGS);
    expect(rows).toHaveLength(Object.keys(CORE_FINDINGS).length);
  });

  it('documents every invalid example', () => {
    for (const name of readdirSync(new URL('../spec/examples/invalid/', import.meta.url))) expect(doc).toContain(`\`invalid/${name}\``);
  });

  it('names the schema id', () => {
    expect(doc).toContain('https://raw.githubusercontent.com/isAlmogK/trustbut/main/spec/agent-receipt-v1.schema.json');
  });
});

describe('packaging', () => {
  it('ships spec/ in the npm package', () => {
    expect((JSON.parse(read('package.json')) as { files: string[] }).files).toContain('spec');
  });
});
```

Run: `npx vitest run test/spec-doc.test.ts`
Expected: FAIL (`spec/agent-receipt-v1.md` doesn't exist; `spec` is not in `files`).

- [ ] **Step 2: Create `spec/agent-receipt-v1.md`** with exactly this content:

````markdown
# Agent receipts, spec v1

**Status:** v1.0, stable. **Schema:** [`agent-receipt-v1.schema.json`](agent-receipt-v1.schema.json) (JSON Schema draft 2020-12), `$id` `https://raw.githubusercontent.com/isAlmogK/trustbut/main/spec/agent-receipt-v1.schema.json`. **Reference producer and validator:** [trustbut](../README.md) (`trustbut verify --json`, `trustbut validate`).

An **agent receipt** is a small JSON document with deterministic evidence about one code change, usually one made by an AI coding agent: what was compared, what the tests showed, and which facts a reviewer should look at. Any tool can produce receipts and any tool can read them. This document is the contract between them.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Principles

- **Evidence, not opinions.** Findings state facts ("this test passes without the change"), never intent.
- **Deterministic core.** The core fields and standard sections contain no timestamps, durations or raw logs. Given the same repository state and the same test results, a producer MUST emit the same core receipt.
- **Small core, open edges.** Five required fields, three optional standard sections, and `x-` keys for everything else.

## Example

```json
{
  "$schema": "https://raw.githubusercontent.com/isAlmogK/trustbut/main/spec/agent-receipt-v1.schema.json",
  "specVersion": "1.0",
  "producer": { "name": "trustbut", "version": "0.4.0" },
  "subject": { "base": "3f2a91c0d4b6e8a1f2c3d4e5f6a7b8c9d0e1f2a3", "head": "8be04d1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e" },
  "verdict": "warn",
  "tests": { "passed": 41, "failed": 0, "errored": 0, "skipped": 1, "scope": "full" },
  "proofs": [
    { "file": "test/auth.test.ts", "name": "rejects expired token", "before": "pass", "after": "pass", "verdict": "does-not-constrain" }
  ],
  "findings": [
    { "id": "test-passes-without-change", "severity": "warn", "title": "Test passes without the change", "file": "test/auth.test.ts", "detail": "rejects expired token" }
  ],
  "risks": [{ "file": "src/auth/session.ts", "score": 5, "reasons": ["auth/permissions", "has findings"] }],
  "x-trustbut": { "runner": "vitest" }
}
```

More in [`examples/valid/`](examples/valid/).

## Fields

### Required

| Field | Type | Meaning |
|---|---|---|
| `specVersion` | string, `1.<minor>` | The spec version the receipt follows. This document is `1.0`. |
| `producer` | object | The tool that made the receipt: `name` (required), `version` (required), `url` (optional). |
| `subject` | object | What was compared: `base` and `head` (required; commit ids or refs), `headRef` (optional human label when the head isn't a plain commit, e.g. `"working tree"`). |
| `verdict` | `"pass"` \| `"warn"` \| `"fail"` | The overall result, given by the verdict rule below. |
| `findings` | array | The facts found. May be empty. |

`$schema` MAY be present and, when present, SHOULD be the schema `$id` above.

### Finding

| Field | Type | Meaning |
|---|---|---|
| `id` | string | A core id from the catalog below, or a namespaced id `<namespace>/<id>`. |
| `severity` | `"fail"` \| `"warn"` \| `"info"` | How much the finding matters. |
| `title` | string, non-empty | A one-line human summary. |
| `file` | string | Optional. Path relative to the repository root. |
| `line` | integer ≥ 1 | Optional. Line in `file`. |
| `detail` | string | Optional. Extra context, such as the test name or the added line. |

### Optional standard sections

| Field | Type | Meaning |
|---|---|---|
| `tests` | object | Counts from the head test run: `passed`, `failed`, `errored`, `skipped` (integers ≥ 0) and `scope` (`"full"`: the whole suite; `"changed"`: only new and changed test files). Omitted when tests didn't run. |
| `proofs` | array | For each new or changed test: `file`, `name`, `before` (`pass`, `fail`, `error`, `skip` or `missing` at base), `after` (`pass`, `fail`, `error` or `skip` at head) and `verdict`: `proves-change` (fails or is missing before, passes after), `does-not-constrain` (passes before and after), `failing` (fails after), `skipped`. |
| `risks` | array | Files worth reviewing first, highest `score` first: `file`, `score` (number ≥ 0), `reasons` (strings). |

## The verdict rule

`verdict` MUST be `"fail"` if any finding has severity `"fail"`; otherwise `"warn"` if any finding has severity `"warn"`; otherwise `"pass"`. Producers express every reason for a verdict as a finding: a failing suite is a `suite-failing` finding, not just a count.

## Finding catalog

Core ids have a fixed meaning. Producers SHOULD use the default severity; a validator reports a different severity as a warning, not an error.

| Id | Default severity | Meaning |
|---|---|---|
| `test-focused` | `fail` | A focus marker was added (`.only`, `fit`, …), so the rest of the suite stops running. |
| `suite-failing` | `fail` | The suite fails at head, or the runner failed before reporting any test. |
| `test-failing` | `fail` | A new or changed test fails at head. |
| `test-skipped` | `warn` | A skip marker was added. |
| `tests-removed` | `warn` | Test definitions were removed on net. |
| `assertions-removed` | `warn` | Assertions were removed on net. |
| `snapshot-changed` | `warn` | A snapshot was changed or deleted. |
| `test-config-changed` | `warn` | Test or coverage configuration changed. |
| `escape-added` | `warn` | A type, lint, coverage, warning or safety escape was added (`as any`, `@ts-ignore`, `//nolint`, …). |
| `no-tests-changed` | `warn` | Source changed but no tests were added or changed. |
| `no-test-results` | `warn` | The head run exited 0 but reported no test results. |
| `test-passes-without-change` | `warn` | A new or changed test also passes at base, so it doesn't prove the change. |
| `no-runner` | `warn` | No test runner was detected; tests were not rerun. |
| `base-run-failed` | `warn` | The changed tests couldn't run at base, so there is no fail-before evidence. |
| `proofs-unmatched` | `warn` | The suite ran but no result matched the changed test files. |
| `deps-not-installed` | `warn` | Declared dependencies are missing from the installed dependencies the runs used. |
| `deps-changed` | `info` | Dependencies changed. |
| `tests-outside-root` | `info` | Changed test files outside the package root were not run. |
| `uncommitted-changes` | `info` | Uncommitted work is not part of the receipt. |

### Namespaced ids

Any other finding MUST use a namespaced id `<namespace>/<id>`, both parts matching `[a-z0-9][a-z0-9-]*`, for example `acme/secret-leak`. Use your tool or organisation name as the namespace. Consumers MUST handle an unknown namespaced id by its `severity`.

## Extensions

Every object MAY carry extra keys that match `^x-[a-z0-9][a-z0-9-]*$`, conventionally `x-<producer name>`. That's where timing, raw runner detail and tool-specific data go. Any other unknown key makes the receipt invalid. Consumers MUST ignore `x-` keys they don't understand.

## Versioning

`1.x` revisions only add optional fields or core ids. A consumer of v1 MUST accept any `specVersion` matching `1.<minor>`. Removing or changing the meaning of anything requires `2.0`.

## Validating

```bash
trustbut validate receipt.json         # or: some-tool --json | trustbut validate
```

Validation checks the schema first, then the verdict rule. Exit code: 0 valid (warnings allowed), 1 invalid, 2 unreadable input.

| Example | Expected error |
|---|---|
| `invalid/missing-verdict.json` | `/`: must have required property 'verdict' |
| `invalid/bad-finding-id.json` | `/findings/0/id`: must be a core finding id or a namespaced id (<namespace>/<id>) |
| `invalid/unknown-field.json` | `/`: must not have additional property 'durationMs' |
| `invalid/bad-spec-version.json` | `/specVersion`: must match pattern "^1\.(0\|[1-9][0-9]*)$" |
| `invalid/verdict-mismatch.json` | `/verdict`: must be 'warn' for these findings (got 'pass') |

## Changes

- **1.0** (trustbut 0.4.0): first version.
````

If Task 1 had to adjust any expected error message to ajv's real text, use that exact text in the table.

- [ ] **Step 3: Ship `spec/`, then run the drift tests**

In `package.json`, add `"spec"` to `files`:

```json
  "files": [
    "dist",
    "spec",
    "integrations/claude-code/scripts/run.mjs"
  ],
```

Run: `npx vitest run test/spec-doc.test.ts`
Expected: PASS.

- [ ] **Step 4: Point `docs/SPEC.md` §6 at the spec**

In `docs/SPEC.md` under `### 6. Receipt`, replace the `- **Fields (JSON, …` bullet and the `- **Finding ids** …` bullet, including its whole table, with:

```markdown
- **Format:** the JSON receipt is an **agent receipt v1**: [`spec/agent-receipt-v1.md`](../spec/agent-receipt-v1.md), with the schema in `spec/agent-receipt-v1.schema.json`. The spec is the source of truth for the fields, the 19 core finding ids and their severities, the verdict rule, `x-` extensions and versioning. trustbut's own detail goes under `x-trustbut`: `runner`, `languages`, `root`, and `after`/`before` runs (`exitCode`, `durationMs`, `timedOut?`, `cases`). The raw runner output is never written to JSON. Internally (Markdown, hooks), trustbut keeps the richer `Receipt` type; `toAgentReceipt()` in `src/spec/serialize.ts` maps it.
- **Validate:** `trustbut validate [file]` (stdin for `-` or no argument; `--json` for a machine-readable result) checks any receipt: schema, then the verdict rule; a core id with a non-default severity is a warning. Exit 0 valid, 1 invalid, 2 unreadable input.
```

Keep the `- **Verdict:**`, `- **Output:**` and `- **Receipt files:**` bullets. In the `- **Output:**` bullet, change `JSON (\`--json\`)` to `JSON (\`--json\`, an agent receipt v1)`.

- [ ] **Step 5: README**

Make these edits in `README.md`:

1. In the nav line under the badges, insert `[Receipt format](#the-agent-receipts-format) · ` right before `[CI](#use-it-in-ci)`.
2. Insert this section right before `## Use it in CI`:

````markdown
## The agent receipts format

`trustbut verify --json` prints an **agent receipt**: an open, versioned JSON format for evidence about a code change. Any tool can produce one and any tool can read one, and trustbut is just the reference implementation. The [spec](spec/agent-receipt-v1.md) defines a small required core (`specVersion`, `producer`, `subject`, `verdict`, `findings`), optional standard sections (`tests`, `proofs`, `risks`), 19 core finding ids with fixed meanings, namespaced ids like `acme/secret-leak` for everything else, and `x-` keys for tool-specific data.

Check any receipt, from trustbut or anything else, against the spec:

```console
$ trustbut verify --json | trustbut validate
valid
```

The schema is [`spec/agent-receipt-v1.schema.json`](spec/agent-receipt-v1.schema.json), and examples are in [`spec/examples/`](spec/examples/). Building a tool that emits receipts? Open an issue and I'll link it here.
````

3. Find the `--json` row in the Options table (`grep -n -- "--json" README.md`) and set its description to `Print the receipt as JSON: an [agent receipt v1](spec/agent-receipt-v1.md)`. Leave every other `--json` mention alone unless it describes the JSON's shape.
4. In `## Roadmap`, replace the v0.4 bullet with `- **v0.4 (done):** the receipt format as an open spec ([agent receipts v1](spec/agent-receipt-v1.md)) with stable finding ids, and \`trustbut validate\``.

- [ ] **Step 6: ROADMAP and CHANGELOG**

In `docs/ROADMAP.md`, replace the row that starts `| v0.4 | **Agent receipts open spec v1** |` with:

```markdown
| **v0.4** | **Agent receipts open spec v1** ✅ | The receipt format and a catalog of 19 stable finding ids, published as a spec and JSON Schema in [`spec/`](../spec/agent-receipt-v1.md), separate from the CLI internals, so any tool or vendor can produce or consume receipts. `trustbut validate` checks any receipt. |
```

In `CHANGELOG.md`, insert above `## 0.3.1`:

```markdown
## 0.4.0

**Agent receipts, spec v1.** trustbut's receipt is now an open, versioned format that any tool can produce or read: [`spec/agent-receipt-v1.md`](spec/agent-receipt-v1.md), with a JSON Schema and examples.

- **Breaking:** `verify --json` and `--receipt-json` now write an agent receipt v1. `version: 1` is replaced by `specVersion: "1.0"` and `producer`. `base`/`head`/`headRef` move under `subject`, and test counts move to `tests`. trustbut-only detail (`runner`, `languages`, `root`, the `after`/`before` runs) moves under `x-trustbut`, and the raw runner `output` is no longer written to JSON. `verdict` stays at the top level, so the GitHub Action is unaffected.
- New: `trustbut validate [file]` checks any receipt against the spec (stdin for `-`; `--json` result; exit 0 valid, 1 invalid, 2 unreadable).
- The npm package now ships `spec/`.
```

- [ ] **Step 7: Bump the version**

Run: `npm run release:bump 0.4.0 && npm run build && node scripts/release/check-versions.mjs v0.4.0`
Expected: `versions agree: v0.4.0 = package.json = trustbut --version = plugin.json`.

Run: `npm pack --dry-run 2>&1 | grep -E "spec/|total files"`
Expected: the schema, the spec doc and the 10 example files are listed.

- [ ] **Step 8: Full checks and commit**

Run: `npm run typecheck && npm test && npm run receipt`
Expected: all pass; receipt PASS (info `deps-changed` is fine).

```bash
git add spec/agent-receipt-v1.md test/spec-doc.test.ts docs/SPEC.md README.md docs/ROADMAP.md CHANGELOG.md package.json package-lock.json integrations/claude-code/.claude-plugin/plugin.json
git commit -m "docs: agent receipts v1 spec document; release 0.4.0"
```
