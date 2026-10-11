# AGENTS.md

trustbut is a local CLI that produces a deterministic evidence report ("receipt") for code written by AI coding agents. Read `docs/SPEC.md` before changing behavior; read the active plan in `docs/superpowers/plans/` before starting a task.

## Stack
- TypeScript, ESM, Node >= 22. Imports use `.js` extensions (NodeNext).
- `commander` (CLI), `execa` (processes), `parse-diff`, `fast-xml-parser` (JUnit).
- Tests: Vitest. Build: tsup.

## Commands
- `npm test` — all tests (unit + fixture e2e)
- `npm run typecheck`
- `npm run build` — outputs `dist/cli.js`
- `npm run dev -- check` — run the CLI from source

## Rules
- Test first. Every behavior change starts with a failing test; every new finding type needs a fixture scenario in `test/fixtures/` or `test/e2e.test.ts`.
- No LLM calls in the core. Checks must be deterministic and reproducible.
- Never touch the user's working tree: all runs happen in temporary `git worktree`s that are always removed in a `finally`.
- Keep files focused: one check per file in `src/checks/`, one runner per file in `src/runners/`.
- Findings describe facts ("test passes without the change"), never intent ("agent cheated").
- Git compatibility: don't rely on `git init -b` or other flags newer than git 2.17.
- Commit after each plan task with a conventional message (`feat:`, `fix:`, `test:`, `docs:`).
