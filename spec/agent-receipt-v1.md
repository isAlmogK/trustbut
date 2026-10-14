# Agent receipts, spec v1

**Status:** v1.0, stable. **Schema:** [`agent-receipt-v1.schema.json`](agent-receipt-v1.schema.json) (JSON Schema draft 2020-12), `$id` `https://raw.githubusercontent.com/isAlmogK/trustbut/main/spec/agent-receipt-v1.schema.json`. **Reference producer and validator:** [trustbut](../README.md) (`trustbut verify --json`, `trustbut validate`).

An **agent receipt** is a small JSON document with deterministic evidence about one code change, usually one made by an AI coding agent: what was compared, what the tests showed, and which facts a reviewer should look at. Any tool can produce receipts and any tool can read them. This document is the contract between them.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Principles

- **Evidence, not opinions.** Findings state facts ("this test passes without the change"), never intent.
- **Deterministic core.** The core fields and standard sections have no fields for timestamps, durations or logs. A finding's `detail` MAY quote a short line of tool output, so it can vary between runs; producers SHOULD keep everything else stable for the same repository state and test results.
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

Every object MAY carry extra keys that match `^x-[a-z0-9][a-z0-9-]*$`, conventionally `x-<producer name>`. That's where timing, raw runner detail and tool-specific data go. Consumers MUST ignore `x-` keys they don't understand. Any other unknown key makes a `1.0` receipt invalid; in a receipt that declares a newer minor it is a field from that revision (see Versioning).

## Versioning

`1.x` revisions only add optional fields or core ids. A consumer of v1 MUST accept any `specVersion` matching `1.<minor>`. When a receipt's minor is newer than the consumer knows, the consumer MUST ignore fields it doesn't know and MUST handle unknown core ids by their `severity`; a 1.0 validator reports those as warnings, not errors. Receipts that declare `1.0` are validated strictly. Removing or changing the meaning of anything requires `2.0`.

## Validating

```bash
trustbut validate receipt.json         # or: some-tool --json | trustbut validate
```

Validation checks the schema first, then the verdict rule. Warnings don't make a receipt invalid: a core id with a non-default severity, and, in a receipt that declares a minor newer than `1.0`, unknown fields and unknown non-namespaced ids. Exit code: 0 valid (warnings allowed), 1 invalid, 2 unreadable input.

| Example | Expected error |
|---|---|
| `invalid/missing-verdict.json` | `/`: must have required property 'verdict' |
| `invalid/bad-finding-id.json` | `/findings/0/id`: must be a core finding id or a namespaced id (<namespace>/<id>) |
| `invalid/unknown-field.json` | `/`: must not have additional property 'durationMs' |
| `invalid/bad-spec-version.json` | `/specVersion`: must match pattern "^1\.(0\|[1-9][0-9]*)$" |
| `invalid/verdict-mismatch.json` | `/verdict`: must be 'warn' for these findings (got 'pass') |

## Changes

- **1.0** (trustbut 0.4.0): first version.
