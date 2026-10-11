# Roadmap

trustbut produces a deterministic, local receipt for code written by AI coding agents. The CLI is the engine; every visual surface renders the same receipt JSON (`trustbut verify --json`, `version: 1`).

## Milestones

| Version | Milestone | What it adds |
|---|---|---|
| **v0.1** | **Core engine** ✅ | `npx trustbut verify`: clean rerun in temporary worktrees, fail-before/pass-after proof for new and changed tests, test-integrity and type/lint-escape checks, risk ranking, PASS/WARN/FAIL receipt. Vitest and pytest. |
| v0.2 | **Visual review** | Claude Code mod with a panel (runs `trustbut verify` when the agent finishes a turn, status-line badge, "Send to agent"). `trustbut ui`: a local web page with the receipt beside the diff and a history of saved receipts (`--save`). |
| v0.3 | **Agent transcripts** | Claude Code and Codex session adapters; checks the agent's claims ("tests pass") against the commands it actually ran; links each diff hunk to the agent action that produced it. |
| v0.4 | **PR and IDE** | GitHub Action posting the receipt as a PR comment; VS Code extension on VS Code Marketplace and Open VSX (Cursor, Windsurf, Antigravity); Codex, Gemini CLI and OpenCode hooks; Jest adapter. |
| v0.5 | **Mutation on changed lines** | Stryker (JS/TS) and mutmut (Python) on changed lines only: do the tests catch broken versions of the new code? |
| v0.6 | **`compare`** | Scores several agents' attempts at the same task by evidence, as a side-by-side scoreboard in `trustbut ui`. |
| later | **Desktop app** | A wrapper around `trustbut ui`, only once `compare` has real users. |

## Principles

- **Agent-agnostic at the core.** Git plus your test runner is enough; transcripts only enrich the receipt.
- **Deterministic.** No LLM in the core. Every finding is reproducible.
- **Evidence, not accusation.** Findings state what is true ("this test passes without the change"), never intent.
- **Local and private.** No server, no account; code never leaves the machine. The GitHub Action covers "runs without installing anything" for PRs.

## How this project is built

trustbut is built with AI coding agents and verified by itself:

1. **Spec** (`docs/SPEC.md`) → **plan** (`docs/superpowers/plans/`) with tests and code per task.
2. **Build** task by task: one agent per task, tests first, a review between tasks.
3. **Review** with a second model from a different vendor, so the generator never grades itself.
4. **Dogfood:** every PR gets its own trustbut receipt in CI. Anything the receipt misses that a reviewer catches becomes a new test scenario and a new check.

## Test scenarios

The product is only as good as its scenarios: tiny git repos that each reproduce one real agent behavior.

- honest fix with a test that fails before and passes after → PASS
- new test that passes without the change → WARN
- `it.skip` / `@pytest.mark.skip` added → WARN
- `it.only` added → FAIL
- test deleted to make the suite green → WARN
- assertion removed or threshold loosened → WARN
- `as any` / `@ts-ignore` added to silence an error → WARN
- suite red at head while the agent claimed green → FAIL

Seen an agent do something the receipt should have caught? Open an issue with a minimal repro; it becomes a scenario before it gets a fix.
