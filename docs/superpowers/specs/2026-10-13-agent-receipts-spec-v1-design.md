# Agent receipts open spec v1 (trustbut v0.4): design

Status: approved 2026-10-13. Milestone: v0.4 in `docs/ROADMAP.md`.

## Goal

Publish the trustbut receipt as an open, versioned format, **agent receipts v1**, that any tool or agent vendor can produce or consume. It has a small required core, optional standard sections, and a clear extension rule. trustbut becomes the reference producer and validator.

## Decisions

| Question | Decision |
|---|---|
| Where the spec lives | In this repo under `spec/`, versioned with the CLI. It moves to its own repo once a second producer adopts it. |
| How much is standard | A small required core plus optional standard sections. Producer-specific data goes under `x-<name>` keys. Third-party findings use namespaced ids. |
| `--json` output | Switches to the spec format: a breaking change, shipped as 0.4.0. No second JSON format. |
| Extras in v0.4 | `trustbut validate`, plus example receipts and conformance tests. No in-toto and no SARIF (later). |

## 1. Files

```
spec/
  agent-receipt-v1.md            normative spec (MUST/SHOULD), finding catalog
  agent-receipt-v1.schema.json   JSON Schema, draft 2020-12
  examples/valid/*.json          pass, warn, fail, minimal, third-party producer with extensions
  examples/invalid/*.json        each breaks exactly one rule; the expected error is named in the spec
```

- `spec/` is added to `files` in `package.json`, so the schema ships in the npm package and `trustbut validate` works offline.
- Schema `$id`: `https://raw.githubusercontent.com/isAlmogK/trustbut/main/spec/agent-receipt-v1.schema.json`.

## 2. Receipt v1

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/isAlmogK/trustbut/main/spec/agent-receipt-v1.schema.json",
  "specVersion": "1.0",
  "producer": { "name": "trustbut", "version": "0.4.0" },
  "subject": { "base": "3f2a91c…", "head": "8be04d1…", "headRef": "working tree" },
  "verdict": "warn",
  "tests": { "passed": 41, "failed": 0, "errored": 0, "skipped": 1, "scope": "full" },
  "proofs": [{ "file": "test/auth.test.ts", "name": "rejects expired token", "before": "pass", "after": "pass", "verdict": "does-not-constrain" }],
  "findings": [{ "id": "test-passes-without-change", "severity": "warn", "title": "Test passes without the change", "file": "test/auth.test.ts", "detail": "rejects expired token" }],
  "risks": [{ "file": "src/auth/session.ts", "score": 5, "reasons": ["auth/permissions"] }],
  "x-trustbut": { "runner": "vitest", "languages": ["js"], "root": ".", "after": { "exitCode": 0, "durationMs": 8123, "cases": [] } }
}
```

**Required fields:**
- `specVersion`: string matching `^1\.\d+$`.
- `producer`: `{ name, version, url? }`.
- `subject`: `{ base, head, headRef? }`. `base` and `head` are commit ids or refs. `headRef` is a human label when the head isn't a plain commit, such as uncommitted work.
- `verdict`: `pass`, `warn` or `fail`.
- `findings`: an array of `{ id, severity, title, file?, line?, detail? }`, where `severity` is `fail`, `warn` or `info`.

**Optional standard sections:**
- `tests`: `{ passed, failed, errored, skipped, scope }`, all integers ≥ 0. `scope` is `full` or `changed`. Omitted when the tests didn't run.
- `proofs`: an array of `{ file, name, before, after, verdict }`.
  - `before` is one of `pass`, `fail`, `error`, `skip`, `missing`.
  - `after` is one of `pass`, `fail`, `error`, `skip`.
  - `verdict` is one of `proves-change`, `does-not-constrain`, `failing`, `skipped`.
- `risks`: an array of `{ file, score, reasons[] }`, ordered by score, highest first.

**Rules:**
- **Verdict rule (normative):** `fail` if any finding has severity `fail`; otherwise `warn` if any has `warn`; otherwise `pass`. Producers MUST emit the verdict this rule gives.
- **Deterministic core:** the core and standard sections hold no timestamps, durations or raw logs. Given the same repository state and the same test results, a producer emits the same core receipt.
- **Unknown keys:** `additionalProperties: false` everywhere, except for keys matching `^x-[a-z0-9][a-z0-9-]*$`, which are allowed in every object.

## 3. Finding ids, extensions, versioning

**Core catalog.** The 19 ids from `docs/SPEC.md` §6, each with a default severity:

| Severity | Ids |
|---|---|
| `fail` | `test-focused`, `suite-failing`, `test-failing` |
| `warn` | `test-skipped`, `tests-removed`, `assertions-removed`, `snapshot-changed`, `test-config-changed`, `escape-added`, `no-tests-changed`, `no-test-results`, `test-passes-without-change`, `no-runner`, `base-run-failed`, `proofs-unmatched`, `deps-not-installed` |
| `info` | `deps-changed`, `tests-outside-root`, `uncommitted-changes` |

- The meaning of each core id is fixed in the spec. Producers SHOULD use the default severity.
- **Namespaced ids:** any other finding uses `<namespace>/<id>`, both parts matching `^[a-z0-9][a-z0-9-]*$` (for example `acme/secret-leak`).
- The schema accepts a core id or a namespaced id, and nothing else.
- Consumers MUST ignore `x-` keys they don't understand, and MUST handle unknown namespaced ids by their `severity`.
- **Versioning:** `1.x` revisions only add optional fields or core ids, so consumers accept any `1.*`. Removing or changing anything requires `2.0`.

## 4. trustbut changes

**Serializer.** `src/spec/serialize.ts` exports `toAgentReceipt(receipt: Receipt): AgentReceiptV1`.
- The internal `Receipt` type stays as it is, so the Markdown rendering and the hooks are unchanged.
- `tests` is counted from `receipt.after.cases` and omitted when `after` is absent. `tests.scope` is `receipt.scope`.
- `proofs` drops the internal `id` and `weak` fields.
- `x-trustbut` holds:
  - `runner`, `languages` and `root`;
  - `after` and `before`, each `{ exitCode, durationMs, timedOut?, cases }`.
- **The raw runner `output` is dropped from JSON:** it can be very large and may contain secrets. Test cases with their one-line `message` remain.

**Output.** `verify --json` and `--receipt-json` emit `toAgentReceipt(receipt)`.

**`trustbut validate [file]`.**
- Reads a receipt from a file, or from stdin when the argument is `-` or omitted.
- Checks run in this order:
  1. JSON parse;
  2. the schema (ajv, draft 2020-12, all errors reported);
  3. the verdict rule;
  4. core ids carrying a non-default severity (reported as a warning, never invalid on its own).
- Prints one line per problem, `<json path>: <message>`, then `valid` or `invalid (N problems)`.
- `--json` prints `{ valid, errors[], warnings[] }` instead.
- Exit codes: 0 valid (warnings allowed), 1 invalid, 2 when the file can't be read or isn't JSON.

**Dependencies.** `ajv` is the only new runtime dependency.

**The GitHub Action** reads only the top-level `verdict`, which is unchanged, so `action.yml` needs no logic change.

**Version** 0.4.0, set with `npm run release:bump 0.4.0`. The CHANGELOG notes the breaking `--json` change.

## 5. Tests

- **Schema tests:** every `spec/examples/valid/*.json` validates. Every `spec/examples/invalid/*.json` fails with the error named in the spec's examples table.
- **Serializer unit tests:**
  - field mapping;
  - `tests` counts;
  - `tests` omitted without `after`;
  - `output` dropped;
  - the verdict is preserved.
- **Conformance:** the e2e fixture suite validates every receipt it produces through `--json` against the schema (a shared test helper), so the CLI and the spec can't drift.
- **`validate` CLI tests:**
  - a valid file gives exit 0;
  - a schema error gives exit 1 with its JSON path;
  - a verdict mismatch gives exit 1;
  - a non-default severity gives a warning and exit 0;
  - non-JSON gives exit 2;
  - reading from stdin works;
  - `--json` output.

## 6. Docs

- **`spec/agent-receipt-v1.md`** is the normative text. `docs/SPEC.md` §6 points to it and keeps only trustbut-specific behavior.
- **README:** a short "The agent receipts format" section (what it is, a link to the spec, `trustbut validate`). The `--json` description is updated.
- **ROADMAP:** v0.4 marked done when released.

## Out of scope

in-toto attestation output, SARIF output, signing, hosted schema URL or website, a separate spec repo, transcript or claim fields.
