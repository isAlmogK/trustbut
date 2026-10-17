# Proof-first receipt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The receipt leads with one PR-level fact (`change-not-proven`: nothing proves the change), stops emitting the noisy per-test `test-passes-without-change` and `no-tests-changed`, and fixes three wrong-fact bugs (moved tests, merged tests, Python workspace members at base).

**Architecture:** Receipt spec 1.2 adds the core id `change-not-proven`. `src/receipt.ts` derives it from the changed files and the proofs. `src/checks/test-integrity.ts` learns cross-file moves and consolidation. The pytest runner maps editable-install paths that point into the user's checkout onto the worktree.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` import suffixes), Node ≥ 22, Vitest, tsup.

**Spec:** `docs/superpowers/specs/2026-10-17-proof-first-receipt-design.md`. Read it first.

## Global Constraints

- Test first: every behavior change starts with a failing test (`AGENTS.md`).
- No LLM calls in the core; checks stay deterministic.
- Findings describe facts, never intent.
- Never touch the user's working tree; worktrees are removed in a `finally`.
- Git compatibility: nothing newer than git 2.17.
- `change-not-proven`: severity `warn`, introduced in spec **1.2**, no `file`, at most one per receipt. Titles/details exactly: title `Nothing proves the change`; detail `no test added or changed`, or `N new or changed tests, none fails without the change` (`1 new or changed test, none fails without the change`).
- `test-passes-without-change` and `no-tests-changed` stay in the catalog, schema and validator; trustbut stops emitting them.
- Commit after each task with a conventional message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands: `npm test`, `npm run typecheck`, `npx vitest run <file>`.

---

### Task 1: Receipt spec 1.2 with `change-not-proven`

**Files:**
- Modify: `src/spec/catalog.ts`, `src/spec/types.ts:4`, `spec/agent-receipt-v1.schema.json:80`, `spec/agent-receipt-v1.md`
- Create: `spec/examples/valid/not-proven.json`, `spec/examples/invalid/not-proven-in-1-1.json`
- Modify: `spec/examples/invalid/bad-finding-id-newer-minor.json` (declares `1.2`, must become `1.3`)
- Test: `test/spec.test.ts`, `test/serialize.test.ts:43`, `test/e2e.test.ts:284`

**Interfaces:**
- Produces: `CORE_FINDINGS['change-not-proven'] === 'warn'`, `CORE_FINDING_SINCE['change-not-proven'] === 2`, `SPEC_VERSION === '1.2'`.

- [ ] **Step 1: Write the failing tests** in `test/spec.test.ts`, next to the `test-regressed (spec 1.1)` block:

```ts
describe('change-not-proven (spec 1.2)', () => {
  const notProven = (specVersion: string) => ({
    specVersion,
    producer: { name: 't', version: '1' },
    subject: { base: 'main', head: 'HEAD' },
    verdict: 'warn',
    findings: [{ id: 'change-not-proven', severity: 'warn', title: 'Nothing proves the change', detail: 'no test added or changed' }],
  });
  it('is a warn core id', () => {
    expect(isCoreFindingId('change-not-proven')).toBe(true);
    expect(CORE_FINDINGS['change-not-proven']).toBe('warn');
  });
  it('is valid in a 1.2 receipt', () => {
    expect(validateAgentReceipt(notProven('1.2'))).toEqual({ valid: true, errors: [], warnings: [] });
  });
  it('is invalid in a 1.1 receipt', () => {
    expect(validateAgentReceipt(notProven('1.1'))).toEqual({
      valid: false,
      errors: [{ path: '/findings/0/id', message: "'change-not-proven' is a core id since 1.2 (the receipt declares 1.1)" }],
      warnings: [],
    });
  });
});
```

Add to `INVALID`: `'not-proven-in-1-1.json': { path: '/findings/0/id', message: "'change-not-proven' is a core id since 1.2 (the receipt declares 1.1)" },`.

In the existing "newer minor" tests of `test/spec.test.ts`: the test named `is invalid when it declares exactly 1.1, the newest known minor` becomes `… exactly 1.2 …` with `future('1.2')`; any test that uses `'1.2'` as a minor *newer than known* uses `'1.3'` instead (read the file: the `future(...)` callers and their names say which). Change `test/serialize.test.ts:43` to `'1.2'` and `test/e2e.test.ts:284` to `specVersion: '1.2'`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/spec.test.ts test/serialize.test.ts`
Expected: FAIL (`change-not-proven` unknown; examples file missing; version 1.1).

- [ ] **Step 3: Implement**

`src/spec/catalog.ts`: add `'change-not-proven': 'warn',` right after `'no-tests-changed': 'warn',`; set `CORE_FINDING_SINCE = { 'test-regressed': 1, 'change-not-proven': 2 }`.
`src/spec/types.ts:4`: `export const SPEC_VERSION = '1.2';`
`spec/agent-receipt-v1.schema.json`: add `"change-not-proven"` to the finding id enum on line 80 after `"no-tests-changed"`.

`spec/examples/valid/not-proven.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/isAlmogK/trustbut/main/spec/agent-receipt-v1.schema.json",
  "specVersion": "1.2",
  "producer": { "name": "trustbut", "version": "0.7.0" },
  "subject": { "base": "main", "head": "HEAD" },
  "verdict": "warn",
  "tests": { "passed": 12, "failed": 0, "errored": 0, "skipped": 0, "scope": "full" },
  "findings": [{ "id": "change-not-proven", "severity": "warn", "title": "Nothing proves the change", "detail": "2 new or changed tests, none fails without the change" }]
}
```

`spec/examples/invalid/not-proven-in-1-1.json`:

```json
{
  "specVersion": "1.1",
  "producer": { "name": "trustbut", "version": "0.6.0" },
  "subject": { "base": "main", "head": "HEAD" },
  "verdict": "warn",
  "findings": [{ "id": "change-not-proven", "severity": "warn", "title": "Nothing proves the change" }]
}
```

`spec/examples/invalid/bad-finding-id-newer-minor.json`: `"specVersion": "1.3"`.

`spec/agent-receipt-v1.md`:
- the top example: `"specVersion": "1.2"`, producer version `"0.7.0"`;
- field table: `This document is \`1.2\`.`;
- catalog: after the `no-tests-changed` row add `| \`change-not-proven\` | \`warn\` | The change's code is not proven by any new or changed test: no test changed, or none of the new or changed tests fails without the change. |`;
- Validating paragraph: `(this document is \`1.2\`)`;
- invalid examples table: add `| \`invalid/not-proven-in-1-1.json\` | \`/findings/0/id\`: 'change-not-proven' is a core id since 1.2 (the receipt declares 1.1) |`;
- Changes: `- **1.2** (trustbut 0.7.0): adds the core id \`change-not-proven\`.` above the 1.1 line.

- [ ] **Step 4: Run**

Run: `npx vitest run test/spec.test.ts test/spec-doc.test.ts test/serialize.test.ts test/validate.test.ts`
Expected: PASS. Then `npm run typecheck`: PASS.

- [ ] **Step 5: Commit** `feat: receipt spec 1.2 adds the change-not-proven core id`

---

### Task 2: `change-not-proven` replaces per-test and no-tests findings

**Files:**
- Modify: `src/receipt.ts`
- Test: `test/receipt.test.ts`, plus the e2e/runner tests listed in Step 5

**Interfaces:**
- Consumes: `CORE_FINDINGS['change-not-proven']` (Task 1).
- Produces: `export function codeChanged(changes: ChangedFile[]): boolean` and `export function changeProofFindings(changes: ChangedFile[], proofs: TestProof[]): Finding[]` in `src/receipt.ts`. `coverageFindings` is removed. `proofFindings` keeps only `test-failing`.

- [ ] **Step 1: Write the failing tests** in `test/receipt.test.ts`. Replace the two tests `turns proofs into findings` and `warns when source changes without tests` with:

```ts
const src = (path: string, added: string[], removed: string[] = [], status: ChangedFile['status'] = 'modified'): ChangedFile => ({
  path, status, kind: 'source', added: added.map((text, i) => ({ line: i + 1, text })), removed,
});

it('turns failing proofs into findings and nothing else', () => {
  expect(proofFindings([proof('a', 'proves-change'), proof('b', 'does-not-constrain'), proof('c', 'failing')]).map((f) => [f.id, f.severity])).toEqual([
    ['test-failing', 'fail'],
  ]);
});

describe('codeChanged', () => {
  it('counts a changed code line', () => expect(codeChanged([src('src/a.ts', ['return a + b;'], ['return a - b;'])])).toBe(true));
  it('ignores comment-only and blank-line changes', () => {
    expect(codeChanged([src('src/a.ts', ['// adds two numbers', ''], ['// adds numbers'])])).toBe(false);
    expect(codeChanged([src('src/a.py', ['# note'], [])])).toBe(false);
  });
  it('counts string edits', () => expect(codeChanged([src('src/a.ts', ["const x = 'b';"], ["const x = 'a';"])])).toBe(true));
  it('ignores deleted files and non-source files', () => {
    expect(codeChanged([src('src/a.ts', [], ['return 1;'], 'deleted')])).toBe(false);
    expect(codeChanged([{ ...src('README.md', ['text']), kind: 'other' }])).toBe(false);
  });
  it('counts any line of a source file in a language outside the registry', () => {
    expect(codeChanged([src('src/App.vue', ['<!-- note -->'])])).toBe(true);
  });
});

describe('changeProofFindings', () => {
  const NOT_PROVEN = { id: 'change-not-proven', severity: 'warn', title: 'Nothing proves the change' };
  const test = file('test/a.test.ts', 'test');
  it('fires when code changed and no test changed', () => {
    expect(changeProofFindings([src('src/a.ts', ['x();'])], [])).toEqual([{ ...NOT_PROVEN, detail: 'no test added or changed' }]);
  });
  it('fires when tests changed and none proves the change', () => {
    expect(changeProofFindings([src('src/a.ts', ['x();']), test], [proof('a', 'does-not-constrain'), proof('b', 'does-not-constrain')])).toEqual([
      { ...NOT_PROVEN, detail: '2 new or changed tests, none fails without the change' },
    ]);
    expect(changeProofFindings([src('src/a.ts', ['x();']), test], [proof('a', 'skipped')])).toEqual([
      { ...NOT_PROVEN, detail: '1 new or changed test, none fails without the change' },
    ]);
  });
  it('does not fire when a test proves the change, weakly or not', () => {
    expect(changeProofFindings([src('src/a.ts', ['x();']), test], [proof('a', 'does-not-constrain'), proof('b', 'proves-change')])).toEqual([]);
    expect(changeProofFindings([src('src/a.ts', ['x();']), test], [proof('a', 'proves-change', true)])).toEqual([]);
  });
  it('does not fire when tests changed but there are no proofs', () => {
    expect(changeProofFindings([src('src/a.ts', ['x();']), test], [])).toEqual([]);
  });
  it('does not fire when only comments changed', () => {
    expect(changeProofFindings([src('src/a.ts', ['// doc'])], [])).toEqual([]);
  });
});

it('buildReceipt emits change-not-proven, never test-passes-without-change or no-tests-changed', () => {
  const r = buildReceipt({
    base: 'a'.repeat(40), head: 'b'.repeat(40), runner: 'vitest', findings: [],
    changes: [src('src/a.ts', ['x();']), file('test/a.test.ts', 'test')],
    proofs: [proof('a', 'does-not-constrain')],
  });
  expect(r.findings.map((f) => f.id)).toEqual(['change-not-proven']);
  expect(r.verdict).toBe('warn');
});
```

Update the import line to `import { buildReceipt, changeProofFindings, codeChanged, decideVerdict, proofFindings } from '../src/receipt.js';`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/receipt.test.ts`
Expected: FAIL (`changeProofFindings`/`codeChanged` not exported).

- [ ] **Step 3: Implement** in `src/receipt.ts`:

```ts
import { languageOf } from './languages/index.js';
import { splitLine } from './lex.js';
// …existing imports…

export function proofFindings(proofs: TestProof[]): Finding[] {
  return proofs
    .filter((p) => p.verdict === 'failing')
    .map((p) => ({ id: 'test-failing', severity: 'fail' as const, title: 'Test fails at head', file: p.file, detail: p.name }));
}

/** Whether a source file (not deleted) has an added or removed line with code on it, not just comments or blanks. */
export function codeChanged(changes: ChangedFile[]): boolean {
  return changes.some((c) => {
    if (c.kind !== 'source' || c.status === 'deleted') return false;
    const lines = [...c.added.map((a) => a.text), ...c.removed];
    const lang = languageOf(c.path);
    if (!lang) return lines.length > 0;
    return lines.some((l) => splitLine(l, lang).code.trim() !== '');
  });
}

const plural = (n: number) => `${n} new or changed test${n === 1 ? '' : 's'}`;

/** `change-not-proven`: code changed, and no test changed or none of the new or changed tests fails without the change. */
export function changeProofFindings(changes: ChangedFile[], proofs: TestProof[]): Finding[] {
  if (!codeChanged(changes)) return [];
  const finding = (detail: string): Finding[] => [{ id: 'change-not-proven', severity: 'warn', title: 'Nothing proves the change', detail }];
  if (!changes.some((c) => c.kind === 'test')) return finding('no test added or changed');
  if (!proofs.length || proofs.some((p) => p.verdict === 'proves-change')) return [];
  return finding(`${plural(proofs.length)}, none fails without the change`);
}
```

Delete `coverageFindings`. In `buildReceipt`: `const findings = [...input.findings, ...proofFindings(input.proofs), ...changeProofFindings(input.changes, input.proofs)];`

Check `grep -rn coverageFindings src test` returns nothing else.

- [ ] **Step 4: Run**

Run: `npx vitest run test/receipt.test.ts` → PASS.

- [ ] **Step 5: Update tests that asserted the retired ids.** Each of these asserts `toContain('test-passes-without-change')` on a scenario where a new test passes at base; assert the proof instead:

```ts
expect(receipt.proofs.map((p) => p.verdict)).toContain('does-not-constrain');
```

Files and lines: `test/e2e.test.ts:55`, `test/jest.test.ts:102`, `test/runners/rspec.test.ts:162`, `test/runners/node-test.test.ts:115`, `test/runners/swift.test.ts:212`, `test/runners/cargo.test.ts:301`, `test/runners/dart.test.ts:197` and `:216`, `test/runners/dotnet.test.ts:187`, `test/runners/go.test.ts:179`, `test/runners/mocha.test.ts:114`, `test/runners/phpunit.test.ts:191`, `test/runners/jvm.test.ts:370`.
`test/runners/go.test.ts:242` (`not.toContain('test-passes-without-change')`) becomes `expect(receipt.proofs.map((p) => p.verdict)).not.toContain('does-not-constrain');`.
`test/e2e.test.ts:164` filters findings by `test-passes-without-change`: read the test, and filter `receipt.proofs` by `verdict === 'does-not-constrain'` instead, keeping what it checks (files/names).
`test/e2e.test.ts:219`: same, `expect(receipt.proofs.map((p) => p.verdict)).not.toContain('does-not-constrain')`.
`test/e2e.test.ts:140` lists `no-tests-changed` among ids that must be absent; keep it (still true) and add `'change-not-proven'` only if that scenario's PR has a test that proves the change (read it; if not, leave the list unchanged).
Where an e2e scenario asserts `receipt.verdict` `'warn'` because of a passes-without test, it is now `'warn'` because of `change-not-proven` (no test proves); if a scenario has one proving test and one non-constraining test and expected `'warn'`, it now expects `'pass'` — update and say so in the commit message.

Run: `npm test` → PASS (toolchain e2e may skip locally). `npm run typecheck` → PASS.

- [ ] **Step 6: Commit** `feat: change-not-proven replaces test-passes-without-change and no-tests-changed`

---

### Task 3: Receipt output leads with proof

**Files:**
- Modify: `src/render.ts:62-68`, `src/hook/feedback.ts:24-28`
- Test: `test/receipt.test.ts` (renderMarkdown block), `test/hook-feedback.test.ts:15-25,115-130`

**Interfaces:**
- Consumes: findings with id `change-not-proven` (Task 2).

- [ ] **Step 1: Write the failing tests.** In the `renderMarkdown` describe of `test/receipt.test.ts`:

```ts
it('leads with the proof line', () => {
  const proving = buildReceipt({
    base: 'a'.repeat(40), head: 'b'.repeat(40), runner: 'vitest', findings: [],
    after: { exitCode: 0, durationMs: 1, output: '', cases: [] },
    changes: [src('src/a.ts', ['x();']), file('test/a.test.ts', 'test')],
    proofs: [proof('a', 'proves-change'), proof('b', 'proves-change'), proof('c', 'does-not-constrain')],
  });
  expect(renderMarkdown(proving)).toContain('**Tests (clean checkout):** 0 passed · 0 failed · 0 skipped\n**Proof:** 2 new/changed tests prove the change ✅\n');
  const unproven = buildReceipt({
    base: 'a'.repeat(40), head: 'b'.repeat(40), runner: 'vitest', findings: [],
    after: { exitCode: 0, durationMs: 1, output: '', cases: [] },
    changes: [src('src/a.ts', ['x();'])], proofs: [],
  });
  expect(renderMarkdown(unproven)).toContain('**Proof:** nothing proves this change ⚠\n');
  const neither = buildReceipt({
    base: 'a'.repeat(40), head: 'b'.repeat(40), runner: 'vitest', findings: [],
    after: { exitCode: 0, durationMs: 1, output: '', cases: [] }, changes: [], proofs: [],
  });
  expect(renderMarkdown(neither)).not.toContain('**Proof:**');
});
```

(`src` is the helper added in Task 2; if it is scoped inside a describe, move it to the top of the file.) A single proving test reads `**Proof:** 1 new/changed test proves the change ✅` — add that case.

In `test/hook-feedback.test.ts`, the FAIL-summary test around lines 115-130 that builds two `test-passes-without-change` warnings and expects `2 tests pass without the change`: replace those two findings with one `{ id: 'change-not-proven', severity: 'warn', title: 'Nothing proves the change' }` and expect the part `change not proven` in place of `2 tests pass without the change`. Read the test's full expected string and keep its other parts. The fixture at line 20 (a `test-passes-without-change` finding in a receipt fixture): replace with `{ id: 'change-not-proven', severity: 'warn', title: 'Nothing proves the change', detail: '1 new or changed test, none fails without the change' }` and update that test's expected feedback text to show this warning line (the feedback renders warnings as one line each; run the test to see the exact text and check it reads correctly before accepting it).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/receipt.test.ts test/hook-feedback.test.ts` → FAIL.

- [ ] **Step 3: Implement.** `src/render.ts`, right after the tests line block and before `if (r.proofs.length) {`:

```ts
const proving = r.proofs.filter((p) => p.verdict === 'proves-change').length;
if (proving) lines.push(`**Proof:** ${proving} new/changed test${proving === 1 ? ' proves' : 's prove'} the change ✅`);
else if (r.findings.some((f) => f.id === 'change-not-proven')) lines.push('**Proof:** nothing proves this change ⚠');
```

`src/hook/feedback.ts` in `failParts`, replace the `loose` lines:

```ts
const warns = r.findings.filter((f) => f.severity === 'warn');
const notProven = warns.some((f) => f.id === 'change-not-proven');
if (notProven) parts.push('change not proven');
const other = warns.length - (notProven ? 1 : 0);
if (other) parts.push(count(other, 'other warning'));
```

- [ ] **Step 4: Run** `npx vitest run test/receipt.test.ts test/hook-feedback.test.ts test/hook.test.ts` → PASS; `npm run typecheck` → PASS.

- [ ] **Step 5: Docs.** `docs/SPEC.md`:
- the sample receipt (lines 32-45): replace `New/changed tests        2 prove the change · 1 passes without it` with `Proof                    2 new/changed tests prove the change ✅` followed by the existing New/changed tests line, and drop the `⚠ test passes without the change` finding line;
- §3 table: replace the row `Source changed, no tests changed | WARN |` with `Nothing proves the change (code changed, and no test changed or no new/changed test fails without it; comment-only and blank-line changes don't count) | WARN |`;
- §4: the bullet `passes at base and at head → **passes without the change** ⚠` becomes `… → **passes without the change** (reported in proofs; the receipt warns only when no test proves the change)`;
- §6 "When trustbut emits each id": delete the `no-tests-changed` and `test-passes-without-change` rows, add `| \`change-not-proven\` | Source code changed (a non-deleted source file has an added or removed line with code, not only comments or blanks; any line for a language outside the registry) and either no test file changed (detail \`no test added or changed\`) or test files changed, the proof run produced proofs and none is \`proves-change\` (detail \`N new or changed tests, none fails without the change\`). Not emitted when test files changed but there are no proofs. |`, and add a sentence after the table: `trustbut no longer emits \`no-tests-changed\` or \`test-passes-without-change\` (0.7.0); both stay in the spec catalog.`;
- §6 Markdown: add `- **Proof line:** under the tests line, \`**Proof:** N new/changed tests prove the change ✅\` when any test proves it, \`**Proof:** nothing proves this change ⚠\` with \`change-not-proven\`, otherwise none.`;
- §7 `systemMessage`: the FAIL example becomes `trustbut FAIL: 2 failing tests, change not proven — sent back to the agent (attempt 1/3)`;
- §6 Format: `specVersion: "1.2"` wherever `1.1` is named as what trustbut writes.

`README.md`: in the sample receipt (lines 30-47) add `**Proof:** 1 new/changed test proves the change ✅` after the tests line and replace the finding `- ⚠ **Test passes without the change** · \`test/auth.test.ts\`: rejects expired token` with nothing (the receipt then shows the skipped test and the cast); line 196 WARN description: `a change no test proves, a skipped test, a silenced check`; line 424 row: `Nothing proves the change (code changed, no test fails without it) | ⚠️ WARN`. Grep README for `1.1` / `specVersion` and update to `1.2` where it states what trustbut writes.

Run: `npx vitest run test/spec-doc.test.ts` → PASS.

- [ ] **Step 6: Commit** `feat: the receipt leads with the proof line`

---

### Task 4: Moved and merged tests are not removed

**Files:**
- Modify: `src/checks/test-integrity.ts:13-55`
- Test: `test/checks.test.ts`

**Interfaces:**
- `checkTestIntegrity(files: ChangedFile[]): Finding[]` keeps its signature.

- [ ] **Step 1: Write the failing tests** in the `checkTestIntegrity` describe of `test/checks.test.ts`:

```ts
it('does not count tests and assertions moved to another test file', () => {
  const block = ["describe('export', () => {", "  it('writes the file', () => {", '    expect(out).toBe(1);', '  });', '});'];
  const findings = checkTestIntegrity([
    file({ path: 'test/export.test.ts', removed: block }),
    file({ path: 'test/export-ollama.test.ts', status: 'added', added: block.map((text, i) => ({ line: i + 1, text: `  ${text}` })) }),
  ]);
  expect(findings).toEqual([]);
});

it('still counts tests removed when no other file adds them', () => {
  const findings = checkTestIntegrity([
    file({ path: 'test/a.test.ts', removed: ["it('one', () => {", '  expect(a).toBe(1);'] }),
    file({ path: 'test/b.test.ts', added: [{ line: 1, text: "it('other', () => {" }, { line: 2, text: '  expect(b).toBe(2);' }] }),
  ]);
  expect(ids(findings)).toEqual(['tests-removed', 'assertions-removed']);
});

it('does not report tests removed when tests were merged and kept their assertions', () => {
  const findings = checkTestIntegrity([
    file({
      path: 'test/badge.test.tsx',
      removed: ["it('renders 1', () => {", "it('renders 2', () => {", "it('renders 3', () => {"],
      added: [{ line: 1, text: "it('renders counts', () => {" }],
    }),
  ]);
  expect(findings).toEqual([]);
});

it('reports both when merged tests also lost an assertion', () => {
  const findings = checkTestIntegrity([
    file({
      path: 'test/badge.test.tsx',
      removed: ["it('renders 1', () => {", '  expect(one).toBe(1);', "it('renders 2', () => {", '  expect(two).toBe(2);'],
      added: [{ line: 1, text: "it('renders counts', () => {" }, { line: 2, text: '  expect(one).toBe(1);' }],
    }),
  ]);
  expect(ids(findings)).toEqual(['tests-removed', 'assertions-removed']);
});
```

Also check the Rust inline-test case still reports `tests-removed` (Rust has no `assert` rule on inline source files, so the merge rule must not apply there). If `test/checks.test.ts` has no such test, add:

```ts
it('still reports removed Rust inline tests (no assertion count there)', () => {
  const findings = checkTestIntegrity([
    file({ path: 'src/lib.rs', kind: 'source', removed: ['    #[test]', '    fn adds() {'] }),
  ]);
  expect(ids(findings)).toEqual(['tests-removed']);
});
```

(Read `src/languages/rust.ts` for its `testDef` rule; adjust the removed lines so they match it, and confirm this test passes **before** your change — it pins existing behavior.)

- [ ] **Step 2: Run to verify** the moved and merged tests FAIL and the others pass: `npx vitest run test/checks.test.ts`.

- [ ] **Step 3: Implement** in `src/checks/test-integrity.ts`:

Before the loop:

```ts
// A removed line that another changed test file adds (same trimmed text) moved; it was not removed.
const addedBy = new Map<string, Set<string>>();
for (const f of files) {
  if (f.kind !== 'test') continue;
  for (const a of f.added) {
    const t = a.text.trim();
    if (!t) continue;
    if (!addedBy.has(t)) addedBy.set(t, new Set());
    addedBy.get(t)!.add(f.path);
  }
}
const movedOut = (f: ChangedFile, line: string) => [...(addedBy.get(line.trim()) ?? [])].some((p) => p !== f.path);
```

Replace the counting block with:

```ts
const addedParts = f.added.map((a) => split(a.text));
const removedParts = f.removed.filter((l) => !movedOut(f, l)).map(split);
const removedTests = count(removedParts, testDef) - count(addedParts, testDef);
const removedAsserts = count(removedParts, assert) - count(addedParts, assert);
// Tests merged into fewer blocks keep their assertions: no check was lost. Needs an assertion count to judge.
const merged = assert !== undefined && removedAsserts <= 0;
if (removedTests > 0 && !merged) {
  findings.push({ id: 'tests-removed', severity: 'warn', title: `${plural(removedTests, 'test')} removed`, file: f.path });
}
if (removedAsserts > 0) {
  findings.push({ id: 'assertions-removed', severity: 'warn', title: `${plural(removedAsserts, 'assertion')} removed`, file: f.path });
}
```

Note `assert` may be an empty array for a language without assertion rules; treat `undefined` or `[]` alike: `const merged = !!assert?.length && removedAsserts <= 0;`.

- [ ] **Step 4: Run** `npx vitest run test/checks.test.ts test/language-rules.test.ts` → PASS. Then `npm test` → PASS.

- [ ] **Step 5: Docs.** `docs/SPEC.md` §3 table rows: `Test definitions removed (net)` → `Test definitions removed (net; lines another changed test file adds count as moved; not reported when the file's assertions did not drop, i.e. tests were merged)`; `Assertions removed (net)` → `Assertions removed (net; lines another changed test file adds count as moved)`. §6 rows for `tests-removed` / `assertions-removed`: add the same two rules. `README.md` §3 table: `Tests removed (net count; moved or merged tests don't count)` and `Assertions removed (net count, including \`self.assertEqual\` style; moved assertions don't count)`.

- [ ] **Step 6: Commit** `fix: tests moved to another file or merged with their assertions are not removed`

---

### Task 5: Python base runs use the base's workspace packages

**Files:**
- Modify: `src/runners/types.ts` (RunOptions), `src/runners/pytest.ts`, `src/proof.ts:263-340` (pass `checkout`)
- Test: `test/runners.test.ts` (unit, pure function), `test/e2e.test.ts` (pytest e2e block, line ~337)

**Interfaces:**
- Produces: `RunOptions.checkout?: string` ("Top of the checkout trustbut was started in; editable installs may point into it."); `export function mapCheckoutPaths(sysPath: string[], checkout: string, worktree: string, exists?: (p: string) => boolean): string[]` in `src/runners/pytest.ts`.

- [ ] **Step 1: Write the failing unit test** (add to `test/runners.test.ts`, with `import { mapCheckoutPaths } from '../src/runners/pytest.js';`):

```ts
describe('mapCheckoutPaths', () => {
  it('maps sys.path entries inside the checkout onto the worktree, keeping order, dropping missing ones', () => {
    const exists = (p: string) => p !== '/tmp/wt/packages/gone/src';
    expect(
      mapCheckoutPaths(
        ['', '/usr/lib/python3.12', '/repo/packages/lib/src', '/repo/packages/gone/src', '/tmp/wt/src', '/repo', '/repo2/x'],
        '/repo', '/tmp/wt', exists,
      ),
    ).toEqual(['/tmp/wt/packages/lib/src', '/tmp/wt']);
  });
  it('maps nothing when the worktree is the checkout', () => {
    expect(mapCheckoutPaths(['/repo/src'], '/repo', '/repo', () => true)).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the failing e2e test** in the `trustbut verify with pytest (end to end)` describe of `test/e2e.test.ts`. It needs the `venv` module (stdlib), so gate it like the block (`hasPytest`). Imports to add if missing: `execa` from `'execa'`, `writeFile`/`readdir` from `node:fs/promises`, `join` from `node:path`, `mkdtemp`, `tmpdir`.

```ts
it('PASS: a workspace member installed editable from the checkout is imported from the base worktree at base', async () => {
  const { dir } = await makeRepo({
    'pyproject.toml': '[tool.pytest.ini_options]\n',
    'packages/lib/src/wslib/__init__.py': 'def double(x):\n    return x + x + 1\n',
    'tests/test_old.py': 'def test_truth():\n    assert True\n',
  });
  await branch(dir, 'agent-change');
  await writeFiles(dir, {
    'packages/lib/src/wslib/__init__.py': 'def double(x):\n    return x + x\n',
    'tests/test_double.py': 'from wslib import double\n\ndef test_double():\n    assert double(2) == 4\n',
  });
  await commitAll(dir, 'fix double');
  // An editable install of the workspace member from the user's checkout, as uv/pip -e would write it.
  const venv = await mkdtemp(join(tmpdir(), 'trustbut-venv-'));
  await execa('python3', ['-m', 'venv', '--system-site-packages', venv]);
  const { stdout: site } = await execa(join(venv, 'bin', 'python'), ['-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])']);
  await writeFile(join(site.trim(), '_wslib.pth'), `${join(dir, 'packages/lib/src')}\n`);
  const prev = process.env.TRUSTBUT_PYTHON;
  process.env.TRUSTBUT_PYTHON = join(venv, 'bin', 'python');
  try {
    const { receipt } = await runVerify({ cwd: dir });
    expect(receipt.proofs.map((p) => [p.file, p.name, p.before, p.verdict])).toEqual([
      ['tests/test_double.py', 'test_double', 'fail', 'proves-change'],
    ]);
  } finally {
    if (prev === undefined) delete process.env.TRUSTBUT_PYTHON;
    else process.env.TRUSTBUT_PYTHON = prev;
    await rm(venv, { recursive: true, force: true });
  }
}, 120_000);
```

(`dir` from `makeRepo` is a `mkdtemp` path; on macOS `/var/...` resolves to `/private/var/...`. If the test fails for that reason after the implementation, compare `realpath`s in `mapCheckoutPaths`' caller, not in the test.)

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/runners.test.ts -t mapCheckoutPaths` → FAIL (not exported).
Run: `npx vitest run test/e2e.test.ts -t "workspace member"` → FAIL with `before: 'pass'`, `verdict: 'does-not-constrain'` (this reproduces the harbor bug; if it passes already, stop and report — the cause is elsewhere).

- [ ] **Step 4: Implement.**

`src/runners/types.ts` RunOptions: add

```ts
  /** Top of the checkout trustbut was started in. Editable installs may point into it; runners map such paths onto `worktree`. */
  checkout?: string;
```

`src/proof.ts`: in `proveTests`, pass `checkout: repo` in every `runWithSetup(runner, { ...runOptions, … })` call (head, base, and both reruns), e.g. `{ ...runOptions, checkout: repo, cwd: headRoot, worktree: headDir, files: … }`.

`src/runners/pytest.ts`:

```ts
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { execa } from 'execa';

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

/** sys.path entries inside `checkout` (not inside `worktree`) mapped to the same place in `worktree`, if they exist there. */
export function mapCheckoutPaths(sysPath: string[], checkout: string, worktree: string, exists: (p: string) => boolean = existsSync): string[] {
  if (worktree === checkout) return [];
  const out: string[] = [];
  for (const p of sysPath) {
    if (!p || !isAbsolute(p) || inside(p, worktree) || !inside(p, checkout)) continue;
    const mapped = join(worktree, relative(checkout, p));
    if (exists(mapped) && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The interpreter's sys.path (with this env), or [] when it can't be read. */
async function sysPathOf(python: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  try {
    const { stdout } = await execa(python, ['-c', 'import json,sys; print(json.dumps(sys.path))'], { cwd, env, timeout: 30_000, extendEnv: false });
    const parsed: unknown = JSON.parse(stdout.trim().split('\n').pop() ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
```

In `run`, after `env.PYTHONPATH = pythonPath(cwd, env.PYTHONPATH);` and before running pytest (reuse one `python` variable for both):

```ts
const python = pythonFor(cwd, worktree);
if (checkout && worktree) {
  const top = real(worktree);
  const mapped = mapCheckoutPaths((await sysPathOf(python, cwd, env)).map(real), real(checkout), top);
  if (mapped.length) {
    const [first, ...rest] = (env.PYTHONPATH ?? '').split(delimiter);
    // After the worktree root and src/ that pythonPath() put first, before the inherited entries.
    const lead = existsSync(join(cwd, 'src')) ? [first, rest.shift()!] : [first];
    env.PYTHONPATH = [...lead, ...mapped, ...rest].filter(Boolean).join(delimiter);
  }
}
```

Destructure `checkout` from the run options: `async run({ cwd, worktree, checkout, files, args = [], env: extraEnv, timeoutMs })`, and use `python` in the `runInGroup` call. Check how `childEnv` builds env and whether execa needs `extendEnv: false` to use exactly it (keep consistent with `runInGroup`; read `src/process.ts`). Simplify the `lead` logic if `pythonPath` is refactored to return its parts — e.g. change `pythonPath(cwd, inherited, extra: string[] = [])` to place `extra` between the worktree entries and `inherited`, and call it once with the mapped paths. Prefer that refactor; it is cleaner than splitting the string.

- [ ] **Step 5: Run** `npx vitest run test/runners.test.ts -t mapCheckoutPaths` → PASS; `npx vitest run test/e2e.test.ts -t pytest` → PASS (both pytest e2e tests); `npm test` → PASS; `npm run typecheck` → PASS.

- [ ] **Step 6: Docs.** `docs/SPEC.md` §1 Git layer (after the symlink sentence) or §4: add `- **Python editable installs:** the pytest runner puts the worktree root and its \`src/\` first on \`PYTHONPATH\`, then every entry of the interpreter's \`sys.path\` that points into the checkout trustbut was started in (an editable install of a workspace member such as \`packages/lib/src\`), mapped to the same path in the worktree when it exists there. So a base run imports the base's code. Import-hook editable installs (setuptools \`__editable___*_finder.py\`) are not mapped, and a JS package whose tests import its own build output (\`dist/\`) runs that build at base.`

- [ ] **Step 7: Commit** `fix: pytest base runs import workspace members from the worktree, not the checkout`

---

### Task 6: Release 0.7.0 and finish the spec

**Files:**
- Modify: `CHANGELOG.md`, `package.json`, `package-lock.json`, `integrations/claude-code/.claude-plugin/plugin.json`, `docs/superpowers/specs/2026-10-17-proof-first-receipt-design.md`

- [ ] **Step 1:** `npm version 0.7.0 --no-git-tag-version` (updates package.json and the lock), set `"version": "0.7.0"` in `integrations/claude-code/.claude-plugin/plugin.json`. Run `npm run check:versions` and `npm run check:plugin-version` → PASS.

- [ ] **Step 2:** `CHANGELOG.md`, above `## 0.6.0`:

```markdown
## 0.7.0

**Proof first.** The trustbut-index pilot labels found that trustbut's facts were mostly true but rarely worth a reviewer's time; the useful signal was whether anything proves the change.

- New finding `change-not-proven` (warn): code changed, and either no test changed or none of the new or changed tests fails without the change. Comment-only and blank-line changes don't count as code. It replaces `no-tests-changed` and the per-test `test-passes-without-change`, which trustbut no longer emits; tests that pass without the change are still listed in `proofs`.
- The Markdown receipt opens with a proof line: `Proof: N new/changed tests prove the change ✅` or `Proof: nothing proves this change ⚠`. The hook summary says `change not proven`.
- Receipt spec **1.2**: adds the core id `change-not-proven`. trustbut writes `specVersion: "1.2"`; `trustbut validate` rejects `change-not-proven` in a receipt that declares 1.1 or older.
- `tests-removed` and `assertions-removed` no longer count lines another changed test file adds (tests moved to a new file), and `tests-removed` is not reported when the file's assertions did not drop (tests merged into one).
- pytest: base runs import workspace members installed in editable mode from the checkout (for example `packages/lib/src`) from the base worktree, so a test no longer passes at base on head's code.
```

- [ ] **Step 3:** In the spec: status line `**Status:** Implemented (2026-10-17)` and fill `## As built` with every difference from the spec (or "none").

- [ ] **Step 4:** `npm test`, `npm run typecheck`, `npm run build` → PASS. `npm run receipt` → no FAIL caused by this change; keep the receipt for the PR.

- [ ] **Step 5: Commit** `chore: release 0.7.0`
