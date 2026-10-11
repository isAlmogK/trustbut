# trustbut

**Your agent said it's done and the tests pass. Here's what's actually true.**

`trustbut` produces a short, deterministic evidence report for code written by AI coding agents (Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Copilot). It works with git alone, runs locally, and sends nothing anywhere.

```bash
npx trustbut verify
```

What it checks:
- **Clean rerun:** runs your test suite in a fresh worktree at HEAD instead of trusting the agent's run.
- **Fail-before / pass-after:** every new or changed test is run against the base commit too. Tests that pass without the change are flagged.
- **Test integrity:** skipped, focused or deleted tests; removed assertions; rewritten snapshots; test config edits.
- **Escapes:** new `as any`, `@ts-ignore`, `eslint-disable`, `# type: ignore`, coverage ignores.
- **Review these first:** risky files (auth, migrations, CI, dependencies, secrets, agent config) ranked.

Supported runners: Vitest, pytest (Jest, Go, Cargo next).

Options: `--base <ref>` (compared from its merge-base with head), `--head <ref>`, `--runner vitest|pytest`, `--quick`, `--strict`, `--json`.

License: Apache-2.0.
