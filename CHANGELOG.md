# Changelog

## 0.3.1

First release published from CI through npm trusted publishing, with a provenance attestation. No changes to the CLI.

- Tests: the CLI tests start trustbut with `node` instead of `npx`, so npm's own config warnings on stderr no longer break the release workflow.

## 0.3.0

First npm release. It includes everything built so far:

- **v0.1, core engine:** `trustbut verify` reruns your tests in clean temporary worktrees, proves new and changed tests fail before and pass after the change, checks test integrity and type/lint escapes, ranks risks and prints a PASS/WARN/FAIL receipt (Vitest, pytest).
- **v0.2, every language:** a runner registry and `.trustbut.json` config (package root, custom test command, setup command, env, extra args), with runners for Jest, node:test, Mocha, Go, Rust, Maven/Gradle (Java/Kotlin), .NET, RSpec, PHPUnit, Dart/Flutter, Swift and any command that writes JUnit XML, language-aware tamper and escape checks, and `--working` for uncommitted changes.
- **v0.3, everywhere agents finish work:**
  - `trustbut hook <claude|codex|gemini|opencode>`: a turn-end hook that verifies the agent's work and sends a FAIL back to the agent (up to `hook.maxRetries` times in a row), with the runner's failure messages and the test output tail in the feedback; trustbut's own errors and timeouts never block.
  - `trustbut init <claude|codex|gemini|opencode> [--user] [--dry-run]`: installs the hook into the agent's config without touching other hooks.
  - Claude Code plugin and marketplace (`/plugin marketplace add isAlmogK/trustbut`).
  - Reusable GitHub Action (`isAlmogK/trustbut@v0`) with a sticky PR comment and a job summary.
  - `--receipt-json <file>` / `--receipt-md <file>` to write the receipt to files.
  - npm release workflow with trusted publishing and provenance.
