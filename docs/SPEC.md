# trustbut — Spec

> **Name:** trustbut. **Command:** `npx trustbut verify`. **Tagline:** "Trust, but verify, for AI coding agents." The report it prints is a *receipt*. npm `trustbut` and GitHub org `trustbut` were both free on 2026-10-11; register them, plus a domain (check `trustbut.dev`), before announcing.

## One line

Your agent said it's done and the tests pass. **Here's what's actually true.**

## How users install and use it

- **Zero install:** `npx trustbut verify` in any repo after an agent finishes. Global: `npm i -g trustbut`. Later: a standalone binary through `brew install trustbut` so Python users don't need Node.
- **Manual (v0.1):** run `trustbut verify` when the agent says "done".
- **Inside the agent (v0.3):** `trustbut init` installs a turn-end hook for Claude Code, Codex or Gemini CLI. The agent can't finish on a FAIL receipt.
- **On every PR (v0.3):** `uses: trustbut/action@v1` posts the receipt as a PR comment.

## Problem

Coding agents (Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Copilot) now write most of the diff, and checking their work is the bottleneck:

- In Stack Overflow's 2026 survey, 48% of developers trust AI output when they can easily validate it, but only 16% trust it for most tasks.
- Agents say "all tests pass" when they don't. They add tests that pass with or without the change, skip or delete tests, and silence the type checker.
- Hosted AI reviewers read the diff and comment with an LLM, which is noisy, and they never rerun anything.
- Vendors grading their own agent's homework is a weak audit, and most teams use more than one agent.

## Product

A **local-first CLI** (plus a GitHub Action and agent plugins later) that takes a base and a head commit and produces a **receipt**: a short, deterministic evidence report that a human can read in 30 seconds.

```
$ npx trustbut verify

🧾 Receipt: WARN    main@3f2a91c → HEAD@8be04d1

Tests (clean checkout)   41 passed · 0 failed · 1 skipped
New/changed tests        2 prove the change · 1 passes without it

Findings
  ⚠ test passes without the change   test/sum.test.ts › handles negatives
  ⚠ test skipped                     test/auth.test.ts:88  it.skip("rejects expired token")
  ⚠ cast to any                      src/auth/session.ts:41

Review these first
  1. src/auth/session.ts   auth/permissions · has findings
  2. package.json          dependencies
```

### Design principles

1. **Agent-agnostic at the core.** v0.1 needs only git and the repo's test runner, so it works on output from *any* agent, including Cursor, whose transcripts are hard to read. Agent transcripts are an enrichment layer added in v0.2.
2. **Deterministic first.** No LLM in v0.1. Every finding comes from a rerun or a pattern, so it is reproducible and free to run, and it doesn't add to the "noisy AI reviewer" problem.
3. **Evidence, not accusation.** The data shows agents rarely cheat outright; more often they write code that passes weak tests. Findings say what is true ("this test passes without your change"), not "the agent cheated".
4. **Local and private.** Nothing leaves the machine. No account, no server.
5. **Fast enough to run on every turn.** The target is under 2× the repo's own test time.

## How it works

```
             ┌──────────────┐
 base, head ─►   git layer  │  merge-base, diff, temp worktrees
             └──────┬───────┘
                    ▼
             ┌──────────────┐
             │  diff parser │  ChangedFile[] + kind (test / source / snapshot / test-config / other)
             └──────┬───────┘
        ┌───────────┼───────────────┐
        ▼           ▼               ▼
 ┌────────────┐ ┌─────────────┐ ┌──────────────┐
 │static checks│ │ proof engine │ │ risk ranking │
 │ test        │ │ clean rerun  │ │ path rules + │
 │ integrity,  │ │ at head;     │ │ findings +   │
 │ escapes     │ │ new tests at │ │ size         │
 └─────┬──────┘ │ base vs head │ └──────┬───────┘
       │        └──────┬──────┘        │
       └───────────────┼───────────────┘
                       ▼
               ┌──────────────┐
               │   receipt    │ verdict PASS / WARN / FAIL
               │  md · json   │ exit code
               └──────────────┘
```

### 1. Git layer
- Resolves `base` (default: merge-base of `HEAD` with `origin/main`, `main`, `origin/master` or `master`) and `head` (default `HEAD`).
- Creates **throwaway `git worktree`s**, so the user's checkout is never touched. Dependencies (`node_modules`, `.venv`) are symlinked from the main checkout instead of reinstalled.

### 2. Diff parser
- Parses the unified diff into `ChangedFile { path, status, kind, added[{line,text}], removed[] }`.
- Classifies each file by path: test, snapshot, test-config, source, other.

### 3. Static checks (pattern-based, on the diff)
| Check | Severity | Signal |
|---|---|---|
| Test focused (`it.only`, `fdescribe`) | FAIL | Silently disables every other test |
| Test skipped (`it.skip`, `xit`, `@pytest.mark.skip`, `pytest.skip()`) | WARN | |
| Test definitions removed (net) | WARN | Could be a legitimate refactor, so a human should look |
| Assertions removed (net) | WARN | |
| Snapshot rewritten | WARN | |
| Test or coverage config changed | WARN | Thresholds, includes, timeouts |
| Type or lint escape added in source (`as any`, `@ts-ignore`, `eslint-disable`, `# type: ignore`, `# noqa`, coverage ignores) | WARN | |
| Source changed, no tests changed | WARN | |

### 4. Proof engine (reruns)
- **Clean rerun:** run the suite in a fresh worktree at `head`. This replaces trusting the agent's own run. A nonzero exit is FAIL.
- **Fail-before / pass-after:** copy the head version of every new or changed test file into a worktree at `base` and run just those files. Then, for each test case:
  - fails at base, passes at head → **proves the change** ✅
  - passes at base and at head → **passes without the change** ⚠ (the test doesn't constrain the new behavior)
  - fails at head → **failing** ❌
  - skipped at head → **skipped** ⚠
  - couldn't load at base (imports code that didn't exist yet) → counts as proof, but marked *weak*
- Runners in v0.1: **Vitest** and **pytest**, through JUnit XML, which is the universal interchange format. Jest, Go and Cargo follow as adapters.

### 5. Risk ranking
Path rules add weight for: auth or permissions, migrations, CI pipelines, dependencies and lockfiles, secrets and env, infrastructure, and agent config (`.claude/`, `AGENTS.md`, hooks). Files with findings and very large changes get extra weight. The output is an ordered "review these first" list.

### 6. Receipt
- **Verdict:** FAIL if any FAIL finding, failing test or nonzero rerun; WARN if any warning or non-constraining test; otherwise PASS.
- **Output:** Markdown (terminal and PR comment) and JSON (`--json`). Exit code is 1 on FAIL, and also on WARN with `--strict`.

## Later layers (not in v0.1)

| Version | Layer | What it adds |
|---|---|---|
| v0.2 | **Claude Code mod with a panel** | Hooks the end of each agent turn, runs `trustbut verify --json`, shows the receipt in a side panel (terminal, desktop, VS Code, mobile) with a status-line badge and a "Send to agent" button; can block "done" on FAIL. Installed with `/plugin install trustbut`, so no manual npm step |
| v0.2 | **`trustbut ui` (local web UI)** | Local server and browser page: receipt beside the diff with flagged lines highlighted, plus history of saved receipts (`--save` writes `.trustbut/receipts/<sha>.json`). Private, works for every agent |
| v0.3 | **Transcript adapters** | Reads local session logs: Claude Code `~/.claude/projects/**.jsonl`, Codex `~/.codex/sessions/**.jsonl`, then Gemini CLI and OpenCode; later Entire checkpoints, git-ai notes and Agent Trace |
| v0.3 | **Claim check** | Finds the agent's final claims ("tests pass", "build succeeds") and checks them against the commands it actually ran and their exit codes |
| v0.3 | **Hunk↔intent map** | Links each diff hunk to the Edit/Write tool call that produced it; flags hunks no tool call explains and files outside the stated task; shown visually in `trustbut ui` |
| v0.4 | **PR + IDE surfaces** | GitHub Action posting the receipt as a PR comment; VS Code extension on VS Code Marketplace and Open VSX (covers Cursor, Windsurf, Antigravity) with findings inline on code lines; Codex, Gemini CLI and OpenCode hooks |
| v0.5 | **Mutation on changed lines** | Stryker (JS/TS) and mutmut (Python) on changed lines only: do the tests actually catch broken versions of the new code? |
| v0.6 | **`compare`** | Scores N agents' attempts at the same task by evidence, as a side-by-side scoreboard in `trustbut ui`; the bridge into the plan → delegate → review → iterate control plane |
| later | **Desktop app** | Tauri wrapper around `trustbut ui`, only once `compare` has users |

All surfaces consume the receipt JSON (`trustbut verify --json`, `version: 1`), so the engine stays the single source of truth.

## Security model
- The tool **runs the repository's tests, which means running its code.** Locally that is the same trust as running `npm test`.
- In CI the Action runs on `pull_request` (not `pull_request_target`) with a read-only token. Posting the comment happens in a separate `workflow_run` job that never executes PR code.
- Transcripts stay local, and the receipt never includes transcript text unless asked (`--include-transcript`).

## Non-goals (v0.1)
GUI, hosted service, accounts, LLM-written review comments, capturing transcripts (Entire and git-ai already do that), monorepo-aware runner selection (`--cwd` comes in v0.2).
