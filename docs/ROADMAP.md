# Roadmap

trustbut produces **agent receipts**: deterministic, local evidence for code written by AI coding agents. The CLI is the engine; every surface renders the same receipt JSON (`trustbut verify --json`), and the receipt format is an open spec anyone can implement.

## Milestones

| Version | Milestone | What it adds |
|---|---|---|
| **v0.1** | **Core engine** ✅ | `trustbut verify`: clean rerun in temporary worktrees, fail-before/pass-after proof for new and changed tests, test-integrity and type/lint-escape checks, risk ranking, PASS/WARN/FAIL receipt. Vitest and pytest. |
| **v0.2** | **Every language** ✅ | Runner registry and `.trustbut.json` config (package subfolder, custom test command, setup command such as starting an emulator, env, extra args). Runners: Jest, node:test, Mocha, Go, Rust, Maven/Gradle (Java/Kotlin), .NET, RSpec, PHPUnit, Dart/Flutter, Swift, plus a generic "any command that writes JUnit XML" runner. Language-aware tamper and escape checks for each. `--working` to verify uncommitted changes. |
| **v0.3** | **Everywhere agents finish work** ✅ (on npm since 0.3.0) | `trustbut hook <claude\|codex\|gemini\|opencode>` and `trustbut init`: "can't say done until the receipt is green" for Claude Code (plugin and marketplace), Codex and Gemini CLI, and a follow-up-prompt plugin for OpenCode; the reusable GitHub Action (`isAlmogK/trustbut@v0`) with a sticky PR comment; `--receipt-json` / `--receipt-md`; the npm release workflow. |
| **v0.4** | **Agent receipts open spec v1** ✅ | The receipt format and a catalog of 19 stable finding ids, published as a spec and JSON Schema in [`spec/`](../spec/agent-receipt-v1.md), separate from the CLI internals, so any tool or vendor can produce or consume receipts. `trustbut validate` checks any receipt. |
| v0.5 | **Agent test-honesty index** (study in progress) | A measurement of how often each agent's pull requests change code that no test proves, or weaken tests, against human pull requests from the same projects. A validation study in [trustbut-index](https://github.com/isAlmogK/trustbut-index) runs first; pilot results are in the [README](../README.md#what-weve-measured). A public, refreshed index follows only if the study shows the findings are worth acting on. Releases 0.5 to 0.7 came out of the pilot: `test-regressed`, noise fixes and `change-not-proven`. |
| later | Transcripts, mutation, compare, UI | Check agent claims ("tests pass") against what actually ran; mutation testing on changed lines; `trustbut compare` to score several agents' attempts at one task; a local web UI. |

## Principles

- **Agent-agnostic at the core.** Git plus your test runner is enough; transcripts only enrich the receipt.
- **Deterministic.** No LLM in the core. Every finding is reproducible.
- **Evidence, not accusation.** Findings state what is true ("this test passes without the change"), never intent.
- **Local and private.** No server, no account; code never leaves the machine.
- **Open format.** Receipts follow a published spec with stable finding IDs.

## How this project is built

trustbut is built with AI coding agents and **verified by itself**:

1. **Spec** (`docs/SPEC.md`) → **plan** (`docs/superpowers/plans/`) with tests per task.
2. **Build** task by task: one agent per task, tests first, a review between tasks.
3. **Receipt per task:** every task's commits get a trustbut receipt before review, and every pull request gets one posted by CI.
4. **Review** with a second model, so the generator never grades itself. Anything the receipt misses that a reviewer catches becomes a new test scenario and a new check.

## Test scenarios

The product is only as good as its scenarios: tiny git repos that each reproduce one real agent behavior.

- honest fix with a test that fails before and passes after → PASS
- change with no test that fails without it (for example no test changed, or every new test passes without the change) → WARN
- skipped test (`it.skip`, `t.Skip`, `#[ignore]`, `@Disabled`, …) → WARN
- focused test (`it.only`, `fit`, `fdescribe`) → FAIL
- test deleted to make the suite green → WARN
- assertion removed or threshold loosened → WARN
- `as any`, `@ts-ignore`, `//nolint`, `#[allow(...)]`, `@SuppressWarnings` added to silence an error → WARN
- suite red at head while the agent claimed green → FAIL

Seen an agent do something the receipt should have caught? Open an issue with a minimal repro; it becomes a scenario before it gets a fix.
