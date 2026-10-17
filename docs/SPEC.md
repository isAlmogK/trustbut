# trustbut — Spec

> **Name:** trustbut. **Command:** `npx trustbut verify`. **Tagline:** "Trust, but verify, for AI coding agents." The report it prints is a *receipt*.

## One line

Your agent said it's done and the tests pass. **Here's what's actually true.**

## How users install and use it

- **Zero install:** `npx trustbut verify` in any repo after an agent finishes (until the first npm release: `npx github:isAlmogK/trustbut verify`). Global: `npm i -g trustbut`. Later: a standalone binary through `brew install trustbut` so Python users don't need Node.
- **Manual (v0.1):** run `trustbut verify` when the agent says "done".
- **Inside the agent (v0.3):** `trustbut init claude|codex|gemini|opencode` installs a turn-end hook (Claude Code also ships as a plugin). The agent can't finish on a FAIL receipt (OpenCode gets the receipt as a follow-up prompt instead).
- **On every PR (v0.3):** `uses: isAlmogK/trustbut@v0` posts the receipt as a sticky PR comment and in the job summary.

## Problem

Coding agents (Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Copilot) now write most of the diff, and checking their work is the bottleneck:

- In Stack Overflow's 2026 survey, 48% of developers trust AI output when they can easily validate it, but only 16% trust it for most tasks.
- Agents say "all tests pass" when they don't. They add tests that pass with or without the change, skip or delete tests, and silence the type checker.
- Hosted AI reviewers read the diff and comment with an LLM, which is noisy, and they never rerun anything.
- Vendors grading their own agent's homework is a weak audit, and most teams use more than one agent.

## Product

A **local-first CLI** (plus a GitHub Action and agent hooks) that takes a base and a head commit and produces a **receipt**: a short, deterministic evidence report that a human can read in 30 seconds.

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
- Creates **throwaway `git worktree`s**, so the user's checkout is never touched. Dependencies (`node_modules`, `.venv`, `venv`) are symlinked from the main checkout instead of reinstalled, both at the repo root and inside the package root (see Configuration).

### 2. Diff parser
- Parses the unified diff into `ChangedFile { path, status, kind, added[{line,text}], removed[] }`.
- Classifies each file by path: test, snapshot, test-config, source, other. Test-config covers test runner and coverage config (`vitest.config.*`, `jest.config.*`, `karma.conf.*`, `.mocharc.*`, `pytest.ini`, `tox.ini`, `setup.cfg`, `.coveragerc`, `codecov.yml`, `.nycrc`, `.c8rc`, `phpunit.xml(.dist)`, `phpunit.dist.xml`, `.rspec`, `dart_test.yaml`, `.config/nextest.toml`, `*.runsettings`, `xunit.runner.json`) and trustbut's own `.trustbut.json`. Source and test files are recognised through the **language registry** (`src/languages/`): each `Language` declares its file extensions, a test-file pattern (test helpers under test dirs included; nothing in a main source set such as `src/main/` or a Ruby/Dart `lib/`), an optional narrower test-file-name pattern (files that define tests, used for `proofs-unmatched`), its comment and string syntax (which drives the per-line lexer the static checks run on: raw, verbatim and character literals, Rust lifetimes, PHP `#[` attributes; one line at a time, so lines inside multi-line strings or block comments are not recognised), and its check rules (focus, skip, test definitions, assertions, escapes; a rule matches lexed code unless it names the comment part). Rust also runs the skip and test-definition checks on source files, where `#[cfg(test)]` modules live. Registered: `js` (`.js .jsx .ts .tsx .mjs .cjs .mts .cts`), `py`, `go`, `rust`, `csharp`, `php` (Blade `*.blade.php` templates are `other`), `java`, `kotlin` (`.kt .kts`; `*.gradle.kts` is `other`), `ruby`, `dart` and `swift`. Adding a language means adding one file and listing it in `src/languages/index.ts`. A language may also declare **type-test files**, tests the type checker checks and no runner runs; JS does: `test-d/` (tsd), `test-dts/` (Vue), `__typetests__/` (jest-runner-tsd), `*.test-d.ts` and `*.spec-d.ts` (tsd, Vitest typecheck) and `*.d-test.ts` (each also `.tsx`, `.mts`, `.cts`). They are test files for every static check and for `no-tests-changed`, but the proof engine never passes them to a runner (they would match no runtime test file) and they are not named test files for `proofs-unmatched`.

### 3. Static checks (pattern-based, on the diff)
| Check | Severity | Signal |
|---|---|---|
| Test focused (`it.only`, `fdescribe`) | FAIL | Silently disables every other test |
| Test skipped (`it.skip`, `xit`, `@pytest.mark.skip`, `pytest.skip()`) | WARN | |
| Test definitions removed (net) | WARN | Could be a legitimate refactor, so a human should look |
| Assertions removed (net) | WARN | |
| Snapshot changed or deleted | WARN | |
| Test or coverage config changed | WARN | Thresholds, includes, timeouts |
| Type or lint escape added in source (`as any`, `@ts-ignore`, `eslint-disable`, `# type: ignore`, `# noqa`, coverage ignores; per language e.g. `//nolint`, `#[allow(…)]`, `unsafe`, `@SuppressWarnings`, `@Suppress`, `#pragma warning disable`, `rubocop:disable`, `@phpstan-ignore`, `// ignore:`, `swiftlint:disable`, `@unchecked Sendable`) | WARN | Rust `.unwrap()`, Kotlin `!!`, C# `x!` and Swift `as!`/`try!` are not escapes. JS directives (`@ts-…`, `eslint-disable`, `istanbul`/`c8`/`v8 ignore`) count only right after a comment marker (`//`, `///`, `/*`, `/**`, a `*` continuation), where the tools read them, not when a comment mentions them in prose. `: any` in a generic constraint (`T extends (...args: any[]) => R`, after `<Name extends` or `, Name extends` on the line) is not counted; `any` elsewhere, in a type signature too, is. Suppressions with a rule code or a written reason (`# noqa: BLE001  # reason`) still count. Files that the head commit's `.gitattributes` marks `linguist-generated` (set or `true`; read through a temporary index, so nested `.gitattributes` apply) get none |
| Source changed, no tests changed | WARN | |

### 4. Proof engine (reruns)
- **Clean rerun:** run the suite in a fresh worktree at `head`. This replaces trusting the agent's own run. A nonzero exit is FAIL; an exit 0 without any test result is WARN (`no-test-results`). A test tool that can't be started at all (not on `PATH`, not executable) is a runtime error, `Couldn't start <tool>: …` (exit 2).
- **Fail-before / pass-after:** copy the head version of every new or changed test file into a worktree at `base` and run those files, plus the files of tests failing at head that exist at base (below), in one run. Then, for each test case:
  - fails at base, passes at head → **proves the change** ✅
  - passes at base and at head → **passes without the change** ⚠ (the test doesn't constrain the new behavior)
  - fails at head → **failing** ❌
  - skipped at head → **skipped** ⚠
  - couldn't load at base (imports code that didn't exist yet) → counts as proof, but marked *weak*
- The base run also gets the files of tests that fail at head, when they exist at base, so `test-regressed` can tell a test the change broke from one that already failed; it runs even when no tests changed if something fails at head. Then `x-trustbut.before` holds only the results of those failing unchanged files.
- **Confirming a regression:** when a test fails or errors at head and passed at base, the base run's files are run again at head, and then, if any such test failed again, at base (each with `setup`). A test is `test-regressed` only when it fails or errors again at head and passes again at base; otherwise it gets the info finding `trustbut/regression-not-reproduced`. Running the same files on both sides drops failures that only happen in the full suite (load, shared state, ordering) and one-off flakes. The reruns are not in the receipt's `x-trustbut` runs; `after` and `before` stay the first runs.
- Runners come from the **runner registry** (`src/runners/registry.ts`). Each `Runner` has a `detect(root)` score (0 = not this runner; the highest score wins, ties go to the earlier entry; detection runs on the package root of the head checkout, so it sees head's files, not the working tree's), a `run({ cwd, files, args, env, timeoutMs })` that returns per-test results, and an optional `casesInFile(c, file, readHead)` hook. Registered, in tie-break order (score in parentheses):

| Runner | Language | Detected by |
|---|---|---|
| `vitest` | JS/TS | `vitest` dependency, `vitest.config.*` / `vitest.workspace.*` (10) |
| `jest` | JS/TS | `jest` dependency, `jest` key, `jest.config.*`, `jest-expo` / `react-native` preset (10; 9 when Vitest also matches) |
| `mocha` | JS/TS | `mocha` dependency or `.mocharc.*` (9) |
| `node-test` | JS/TS | `scripts.test` runs `node --test` (8) |
| `pytest` | Python | `pytest.ini`, `conftest.py`, `tox.ini`, `[tool.pytest` in `pyproject.toml` (10) |
| `go` | Go | `go.mod` (10) |
| `cargo` | Rust | `Cargo.toml` (10); uses `cargo nextest` when installed, else `cargo test` |
| `dotnet` | C# | `.sln`, `.slnx`, `.csproj` or `.fsproj` in the root (10) |
| `phpunit` | PHP | `phpunit.xml(.dist)` or `phpunit/phpunit` in `composer.json` (10); runs `composer install` in the temporary checkout |
| `maven` | Java/Kotlin | `pom.xml` (10) |
| `gradle` | Java/Kotlin | `build.gradle(.kts)` or `settings.gradle(.kts)` (10) |
| `rspec` | Ruby | `.rspec`, or `spec/` plus `rspec` in `Gemfile` / `Gemfile.lock` (10) |
| `dart` | Dart | `pubspec.yaml` with a `test` dev dependency and no Flutter SDK (10); runs `dart pub get` when needed |
| `flutter` | Dart | `pubspec.yaml` with the Flutter SDK (10) |
| `swift` | Swift | `Package.swift` (10) |
| `command` | any | never detected; chosen through config (`command`) |

 `--runner <name>` accepts any registered name; an unknown name exits 2 and lists the supported ones. Adding a runner means adding one file and listing it in the registry.
- **Matching results to changed test files.** By default a result belongs to a changed test file when its reported file equals the path, is a path suffix of it, or (pytest) is its dotted module name. Runners whose results don't carry file paths (Go, JVM) implement `casesInFile(c, file, readHead)`: `file` is the changed test file relative to the package root, and `readHead(path)` returns the head contents of a changed test file (relative to the package root; `''` if unreadable), read from the head worktree and cached, e.g. to find which `func TestX` a Go file defines. Results may carry an optional `leaf` (the test's own short name, e.g. the .NET method without parameters or the last Rust path segment); the proof engine looks for it on added lines to tell new tests from untouched ones, defaulting to the last segment of `name`. Proofs and findings report repo-relative paths; the raw test cases in `after` / `before` keep the runner's own `file`, which is relative to the package root (or a class/package name for runners without file paths).

- **Nothing to verify:** when base and head are the same commit, or their trees don't differ (an empty commit, `--working` with no edits), `verify` exits 2 with a hint (`--base HEAD~1`, `--working`).
- **`--working`** verifies uncommitted work: the tracked edits plus untracked, non-ignored files are snapshotted into an unreferenced commit on top of `HEAD`, built with a temporary index (the real index, HEAD and working tree are never touched), which is used as `head`. It is rejected together with `--head`; the receipt's `subject.headRef` is `"working tree"`.

### Configuration (`.trustbut.json`)

Optional. Read from the repo root **as committed at head** (`git cat-file blob <head>:.trustbut.json`); if head has none, from the working-tree file; `--config <path>` (relative to the current directory) replaces both. Unknown keys and wrong types are errors (exit 2) that list the allowed keys; a `$schema` key (editor hint) is accepted and ignored.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `root` | string | `"."` | Package folder relative to the repo root; it must exist at head (else exit 2). Runner detection looks there, in the head checkout, the runner runs in `<worktree>/<root>`, only changed test files under it are rerun and they are passed relative to it, and `node_modules`/`.venv`/`venv` are linked from `<repo>/<root>` too. `--root <dir>` overrides it. Must stay inside the repo. |
| `runner` | string | detected | Force a registered runner. `--runner` overrides it. |
| `command` | string | — | Generic runner: shell command run with `sh -c` in the root. `{files}` is replaced with the shell-quoted test files (nothing for a full run). Setting `command` without `runner` selects the `command` runner. |
| `junit` | string | — | Generic runner: JUnit XML file the command writes, relative to the root (deleted before each run). Without it, stdout is parsed when it starts with `<?xml` or `<testsuite`. Exit code semantics are the same as for other runners. |
| `setup` | string | — | Shell command started in the background in the root of **each** worktree before its test run (e.g. a database emulator). It runs in its own process group, which is always killed after the run (SIGTERM, then SIGKILL after 3 s), also on errors and when trustbut is interrupted. If it exits non-zero before tests start, the run stops with exit 2; if it exits 0, tests start immediately. It gets `env`. |
| `setupWaitSec` | number, 0 to 2,000,000 | `5` | How long to wait for `setup` before starting the tests. With `setupReadyPattern` this is the maximum wait, so raise it for slow services. |
| `setupReadyPattern` | regex string | — | Tests start as soon as `setup` prints a matching line (stdout or stderr). |
| `env` | object of strings | — | Extra environment for every test run and for `setup`. |
| `args` | string[] | — | Extra arguments added to the runner's command: before the test files (or packages, selectors) for most runners; for Maven, Gradle and .NET at the end; for `swift` after the `--filter` options; for the `command` runner appended (shell-quoted) at the very end of the command. |
| `timeoutSec` | number, > 0 and ≤ 2,000,000 | `900` | Time limit per test run. A run that hits it is stopped (its whole process group) and the finding says `timed out after N s`. |
| `hook` | object | — | Settings for `trustbut hook <agent>` (see [Agent hooks](#7-agent-hooks-trustbut-hook-agent)): `enabled` (boolean, default `true`), `mode` (`"quick"` default: rerun only changed test files at head; `"full"`: the whole suite), `maxRetries` (whole number 0–100, default `3`), `timeoutSec` (number > 0, default `540`), `base` (ref name; default: see [Agent hooks](#7-agent-hooks-trustbut-hook-agent)). Unknown keys inside `hook` are errors too. |

Example (Go service with a Firestore emulator in a subfolder):

```json
{
  "root": "services/api",
  "args": ["-p", "1"],
  "setup": "firebase emulators:start --only firestore",
  "setupReadyPattern": "All emulators ready",
  "setupWaitSec": 60,
  "env": { "FIRESTORE_EMULATOR_HOST": "127.0.0.1:8080" }
}
```

### 5. Risk ranking
Path rules add weight for: auth or permissions, migrations, CI pipelines, verification config (`.trustbut.json`), dependencies and lockfiles (npm/pnpm/yarn, Python, `go.mod`, `Cargo.toml`, `pom.xml`, Gradle build/settings scripts, `Gemfile`, `composer.json`, `pubspec.yaml`, `Package.swift`, `*.csproj`, `Directory.Packages.props` and their lockfiles), secrets and env, infrastructure, and agent config (`.claude/`, `AGENTS.md`, hooks). Files with findings and very large changes get extra weight. The output is an ordered "review these first" list.

### 6. Receipt
- **Format:** the JSON receipt is an **agent receipt v1**: [`spec/agent-receipt-v1.md`](../spec/agent-receipt-v1.md), with the schema in `spec/agent-receipt-v1.schema.json`. The spec is the source of truth for the fields, the 21 core finding ids and their severities, the verdict rule, `x-` extensions and versioning. trustbut's own detail goes under `x-trustbut`: `runner`, `languages`, `root`, and `after`/`before` runs (`exitCode`, `durationMs`, `timedOut?`, `cases`). A test case in those runs may carry `leaf`, the test's own short name used to tell new tests from untouched ones, and a failing case may carry `message`, the runner's failure message (one line, up to 300 characters). The raw runner output is not written to JSON by default; `--output-tail` adds `outputTail` (the last 50 lines, at most 4,000 characters) to each failed run under `x-trustbut` in JSON receipts. It is off by default, since tests can print secrets. Internally (Markdown, hooks), trustbut keeps the richer `Receipt` type; `toAgentReceipt()` in `src/spec/serialize.ts` maps it.
- **Markdown header:** reads `runner: X`, plus ` · root: Y` when `root` is not `.`.
- **When trustbut emits each id** (meanings and severities: the spec's [finding catalog](../spec/agent-receipt-v1.md#finding-catalog)):

  | Id | trustbut emits it when |
  |---|---|
  | `test-focused` | The diff adds a focus marker (§3: `.only`, `fit`, `solo: true`, …). |
  | `test-skipped` | The diff adds a skip marker (§3). |
  | `tests-removed` | A file loses test definitions on net; one finding per file. |
  | `assertions-removed` | A file loses assertions on net; one finding per file. |
  | `snapshot-changed` | A snapshot file is changed or deleted. |
  | `test-config-changed` | A test or coverage config file changes, `.trustbut.json` included. |
  | `escape-added` | An added line carries a type, lint, coverage, warning or safety escape (§3). |
  | `no-tests-changed` | Source changed and no test file was added or changed. |
  | `suite-failing` | The head run exits nonzero. When the runner reported no test (a build or start-up failure), the detail is the last output line, or `timed out after N s`; otherwise `exit code N`. |
  | `no-test-results` | The head run exits 0 with no results, e.g. args that filter out every test, a `junit` path the command never writes, a test task whose reports trustbut doesn't read. |
  | `test-failing` | A new or changed test fails at head. |
  | `test-regressed` | A test that fails or errors at head passes at base, and a rerun of the base run's files reproduces both results (§4). The base run gets the changed test files plus the files of tests failing at head (pytest module names map to their `.py` file); one finding per test, with the repo path and the test name. |
  | `test-passes-without-change` | A new or changed test also passes at base (§4). |
  | `no-runner` | No runner is detected; the title lists the supported runners. |
  | `base-run-failed` | The base run of the changed tests reports nothing and exits nonzero. |
  | `proofs-unmatched` | The suite ran (or exited 0 with no results) but no result matched the changed test files. Not emitted when the head run only reports a build or start-up failure. |
  | `deps-not-installed` | JS runners only (vitest, jest, mocha, node-test; not Python or `command`), skipped for Yarn PnP. `package.json` declares dependencies (not optional; `workspace:`/`link:`/`file:` ignored) missing from the installed `node_modules`, or `node_modules` is missing. Lists up to 5 names. Read from the working-tree `package.json` (what is linked), so a `--head` ref that adds a dependency isn't flagged. |
  | `deps-changed` | A lockfile or requirements file changes (`package-lock.json`, `yarn.lock`, `go.sum`, `requirements*.txt`, …); both runs use the installed dependencies. |
  | `tests-outside-root` | Changed test files outside the package root were not run; gives the count and the first 3 paths. |
  | `uncommitted-changes` | The working tree has uncommitted work. Not emitted with `--working`. |

  trustbut also emits one namespaced id (severity `info`, so it never changes the verdict):

  | Id | trustbut emits it when |
  |---|---|
  | `trustbut/regression-not-reproduced` | A test failed or errored at head and passed at base, but the reruns (§4) did not reproduce both results. Title `Test failed at head and passed at base, but a rerun did not reproduce both results`; `file` as for `test-regressed`; `detail` is the test name and the rerun outcomes, e.g. `adds (rerun: pass at head, not run at base)` (`no result` when a rerun reported nothing for the test, `not run` when there was no base rerun). |
- **Which failing tests are compared with base:** an unchanged failing test gets a base result only when its runner reports a case `file` that resolves to a file in the package root: vitest, jest, mocha, node-test, pytest, RSpec, PHPUnit, Dart, Cargo (the test binary's source file; not doc-tests), and `command` when its JUnit report names files. Go (package directory), Maven, Gradle, .NET (class names) and Swift (type names) don't, so an unchanged failing test there never gets `test-regressed`. To tell "not compared" from "already failing": a head `fail` or `error` case whose `id` is absent from `x-trustbut.before.cases` (or `before` is absent) had no base result. A head failure that passed in `before` but has no `test-regressed` has a `trustbut/regression-not-reproduced` finding instead. Markdown and agent feedback mark a failing test "(passed at base)" only when it has a `test-regressed` finding. `x-trustbut.before` can exist when no tests changed; it then holds only the failing unchanged files' results.
- **Validate:** `trustbut validate [file]` (stdin for `-` or no argument; `--json` for a machine-readable result) checks any receipt: schema, then the verdict rule; a core id with a non-default severity is a warning, and so are unknown fields and unknown ids shaped like a core id (`[a-z0-9][a-z0-9-]*`) in a receipt that declares a minor newer than `1.2`; a core id newer than the receipt's declared minor (`test-regressed` in a `1.0` receipt, `change-not-proven` in a `1.1` receipt) is an error; a malformed id is an error in every version. Exit 0 valid, 1 invalid, 2 unreadable input (with `--json`, also printed as `{ "valid": false, "errors": [{ "path": "/", "message": … }], "warnings": [] }`).

- **Verdict:** FAIL if any FAIL finding, failing test or nonzero rerun; WARN if any warning or non-constraining test; otherwise PASS.
- **Output:** Markdown (terminal and PR comment) and JSON (`--json`, an agent receipt v1). Exit code is 1 on FAIL, and also on WARN with `--strict`; 2 on a usage or runtime error. `trustbut hook` follows the agent's protocol instead (see below).
- **Receipt files:** `--receipt-json <path>` and `--receipt-md <path>` also write the JSON (pretty-printed) and the Markdown receipt to a file, in addition to what is printed (with `--json`, stdout is the JSON and `--receipt-md` still gets the Markdown). Paths are relative to the current directory, parent folders are created, and a file that can't be written is reported on stderr (`trustbut: couldn't write receipt to <path>: <reason>`) and makes the exit code **2** (the receipt is still printed). The Action uses them to read the verdict and post the comment.

### 7. Agent hooks (`trustbut hook <agent>`)

`trustbut init <claude|codex|gemini|opencode> [--dry-run] [--user]` installs the hook. It copies the hardened runner (`integrations/claude-code/scripts/run.mjs`, shipped in the npm package) to `<agent dir>/hooks/trustbut-run.mjs` with a `trustbut-run.json` holding the version, and merges one entry into the agent's config without touching other hooks: Claude `.claude/settings.json` `hooks.Stop` (exec form, `${CLAUDE_PROJECT_DIR}`), Codex `.codex/hooks.json` `Stop`, Gemini `.gemini/settings.json` `hooks.AfterAgent` (name `trustbut-verify`, `timeout` 600000 ms), OpenCode `.opencode/plugins/trustbut.js` (V1 plugin API: on `session.idle` it runs the runner as `hook opencode` and sends a FAIL back with `client.session.prompt`, up to `hook.maxRetries` times in a row (default 3); V2 is a follow-up). `--user` writes the user-level equivalents with absolute runner paths (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.config/opencode`). A rerun updates our entry in place and changes nothing else; `--dry-run` prints the diff and writes nothing; an unparsable config is refused with exit 2. `trustbut hook opencode` answers with exit 1 and the feedback on stdout for a FAIL, else exit 0 with nothing on stdout. Project files go at the git root, while agents read project settings from the directory they are launched in, so launch from the root. A settings file with comments (JSONC: `//` or `/*` outside a string) is refused with exit 2 and the snippet to add by hand; writes are atomic (temp file next to the real file, then rename), keep the file's indent and mode, and go through a symlinked config to its target, leaving the link in place. The OpenCode plugin finds its runner next to itself (`../hooks`), skips the idle after a user abort, and passes `stop_hook_active` so `hook.maxRetries` governs. `TRUSTBUT_VERSION_PROBE_MS` caps the runner's PATH version probe (default 10 s). The runner's budget starts at 570 s (`TRUSTBUT_HOOK_BUDGET_SEC` overrides).

`trustbut hook claude|codex|gemini` is the command an agent's turn-end hook runs (Claude Code `Stop`, Codex CLI ≥ 0.124 `Stop`, Gemini CLI ≥ 0.35 `AfterAgent`). It reads the hook input (JSON) on stdin, runs the same pipeline as `trustbut verify --working --base <hook base>` in-process (`--quick` too in the default mode: only new/changed test files are rerun at head, and the whole suite when no test file changed), and answers in that agent's protocol, so a FAIL keeps the agent working instead of letting it say "done".

- **Input:** stdin JSON; empty, invalid or non-object input is treated as `{}` (a terminal is not read; an open stdin is read for at most 5 s). Fields used: `session_id` (falls back to `GEMINI_SESSION_ID`, then `""`), `cwd`, `stop_hook_active`.
- **Project:** `CLAUDE_PROJECT_DIR`, else `GEMINI_PROJECT_DIR`, else the input's `cwd`, else the process cwd; the repo is its `git rev-parse --show-toplevel`.
- **Settings:** `hook` in `.trustbut.json`, read **as committed at `HEAD`** (else the working-tree file), so an uncommitted edit can't switch the hook off. The verify run itself reads the config like `verify --working` (at the working-tree snapshot), including `root`; there are no `--config`/`--root` flags.
- **Base:** the first that exists of: `hook.base` (a configured ref that doesn't exist is skipped, and the stop message adds `hook.base "x" not found; used <ref>`); origin's default branch (`git symbolic-ref refs/remotes/origin/HEAD`, e.g. `origin/develop`, so a stale local `main` isn't used); `origin/main`, `main`, `origin/master`, `master`; the current branch's upstream (`@{upstream}`); else `HEAD`, which verifies only the uncommitted changes. A missing base is never a "couldn't verify". As in `verify`, the comparison is from the merge-base, so the whole branch is verified and committing doesn't hide work. **Limitation:** working directly on a base branch without a remote (e.g. a local-only `main`), committed work with a clean tree compares `HEAD` with itself, so there is nothing to verify and the stop is allowed silently; set `hook.base` (e.g. a tag or `HEAD~1`) or work on a branch. `verify` itself is unchanged (main/master only, else an error).
- **Skip (allow the stop, print nothing):** `TRUSTBUT_SKIP=1` (or `true`); not inside a git repo; `hook.enabled: false`; nothing to verify (verify's "No changes" error).
- **Time budget:** `hook.timeoutSec` (default 540 s, under the agents' 600 s default; Gemini's own default is 60 s, so its hook entry needs `"timeout": 600000`). When it runs out, the verify run is aborted: every test and setup process group is stopped (SIGTERM, then SIGKILL) and the worktrees are removed by the usual `finally` blocks; the hook then allows the stop with a "couldn't verify: timed out" message. If the run has not stopped 8 s later, the process exits anyway (leftover process groups are SIGKILLed on exit). When the agent kills the hook (SIGTERM or SIGINT), the run is aborted the same way and gets up to 2 s to clean up; the hook then exits 0 with `trustbut couldn't verify: interrupted by <signal>`.
- **State:** per session and repo in `os.tmpdir()/trustbut-hook-<uid>/<sha1(session_id NUL repo)>.json` (the directory is created with mode 0700; one owned by another user is refused; `trustbut-hook` where there is no uid, e.g. Windows): `{attempts, tree, verdict, updatedAt}`, written to a temp file and renamed. `tree` is `<snapshot tree id>:<merge-base commit>:<hash of mode, maxRetries, base, timeoutSec>` of the last verified run, so changing a hook setting invalidates the unchanged-tree skip. A missing file or one older than 24 h is an empty state; an unreadable or corrupt one counts 0 and is reported as a read error.
- **Loop guard:** `attempts` counts FAILs sent back in a row. `stop_hook_active: false` (the user's new turn) starts a new chain at 0; when it is missing or `true`, counting continues. A FAIL blocks while `attempts < hook.maxRetries` and increments it; at the limit the stop is allowed with "trustbut still FAIL after N attempts — receipt: <path>". Every allowed stop (PASS, WARN, error, timeout, nothing to verify, limit reached) resets it, since it ends the agent's continuation chain. `maxRetries: 0` reports a FAIL without ever blocking. With `stop_hook_active: true`, a FAIL is never sent back when the state couldn't be read (not a missing file) or the counter couldn't be saved, so an agent can never loop forever.
- **Unchanged trees:** the working tree is snapshotted first (cheap; no worktree). If its `tree` equals the last verified one: a PASS/WARN is not rerun (the stop is allowed silently); a FAIL is never rerun or sent back twice. At the start of a chain (`attempts` 0, e.g. the user only asked a question) the user sees `trustbut FAIL (unchanged since last check) — receipt: <path>`; within a chain (`attempts` > 0: the agent stopped again without changing anything) the stop is allowed with `trustbut FAIL (no changes since the receipt was sent back) — receipt: <path>`. Both reset `attempts` to 0. A tree that changed is verified again and the normal retry logic applies.
- **Full receipt:** the Markdown receipt is written to `<git dir>/trustbut/last-receipt.md` (`git rev-parse --git-dir`: `.git/trustbut/…` in a normal checkout, `.git/worktrees/<name>/trustbut/…` in a linked worktree), inside `.git` so it is never committed.
- **Feedback to the agent (FAIL):** plain Markdown of at most 6,000 characters (Codex and Gemini cut hook output at about 2,500 tokens): the verdict, the tests line, each FAIL finding with `file:line` (a failing changed test is listed once, under failing tests), failing tests (up to 10) with the runner's failure message when it reports one (`TestCaseResult.message`, up to 300 characters: JUnit `<failure>`/`<error>` `message`, else the first line of its text; Jest's first `failureMessages` entry), on `suite-failing` the last 20 lines (at most 1,500 characters) of the head run's output in a fenced block, warnings (up to 10, one line each), "Fix these and finish again; run `<recheck>` to check." and the receipt path. `<recheck>` matches the hook: `trustbut verify --working`, plus `--quick` in quick mode and `--base <ref>` when the hook's base isn't the one `verify` would pick. Lines are flattened and clipped at 400 characters; when the whole text is still too long, items are dropped from the end (the output block as a whole) with "… N more lines not shown; see the full receipt", keeping the instruction and the path.
- **Message to the user (`systemMessage`):** one line. FAIL: counts, e.g. `trustbut FAIL: 2 failing tests, 1 test passes without the change — sent back to the agent (attempt 1/3)`. WARN: up to 3 finding titles and the receipt path. PASS: tests passed and how many new/changed tests prove the change. Errors: `trustbut couldn't verify: <first line of the error>`.

| Outcome | `claude` (Stop) | `codex` (Stop) | `gemini` (AfterAgent) | `opencode` (plugin) |
|---|---|---|---|---|
| FAIL, within `maxRetries` | exit 0, stdout `{"decision":"block","reason":<feedback>,"systemMessage":"trustbut FAIL: …"}` | exit 2, feedback on stderr, empty stdout | exit 2, feedback on stderr, **empty stdout** | exit 1, feedback on stdout, message on stderr; the plugin sends the feedback as a follow-up prompt |
| FAIL at the limit, PASS, WARN | exit 0, stdout `{"systemMessage":"…"}` | same | same | exit 0, empty stdout, message on stderr |
| Error, timeout or interrupt | exit 0, stdout `{"systemMessage":"trustbut couldn't verify: …"}` | same | same | exit 0, empty stdout, message on stderr |
| Skip, unchanged PASS/WARN | exit 0, no output | same | same | same |
| Unchanged FAIL (new turn, or mid-chain with no edits) | exit 0, stdout `{"systemMessage":"trustbut FAIL (unchanged since last check) — receipt: …"}` (mid-chain: `(no changes since the receipt was sent back)`) | same | same | exit 0, empty stdout, message on stderr |

(The `trustbut-run.mjs` runner that `init` and the Claude plugin install adds one case in front: when it can't find or start trustbut, or trustbut's answer isn't one of the above, it exits 0 with `trustbut couldn't verify: <reason>. Install with: npm i -g trustbut`, as a `systemMessage` on stdout for `claude` and on stderr for the other agents. Since exit 2 means "block" to the agents, the runner passes it through only as trustbut's own block: for `claude` when stdout holds a `{"decision":"block",…}` object, for `codex`/`gemini` when stderr starts with `trustbut verdict: FAIL`; any other exit 2 (e.g. an old trustbut without `hook` failing with "unknown command") becomes `couldn't verify`. The npx fallback runs with `--prefer-offline`, `npm_config_update_notifier=false` and `npm_config_loglevel=error`.)

Exit 2 means "block" to Claude Code, Codex and Gemini CLI, so `trustbut hook` uses it only for a FAIL on Codex and Gemini. Its own usage errors (an unknown agent name, an unknown option) exit **1**, which those three treat as a non-blocking hook error, not trustbut's usual 2.

**Environment variables** (all optional):

| Variable | Read by | Meaning |
|---|---|---|
| `TRUSTBUT_SKIP` | `trustbut hook` | `1` or `true`: allow every stop without verifying and print nothing |
| `TRUSTBUT_HOOK_TIMEOUT_SEC` | `trustbut hook` | A positive number of seconds that caps `hook.timeoutSec` when smaller (never raises it). The runner sets it to what is left of its own budget; the timeout message then names this variable |
| `TRUSTBUT_HOOK_BUDGET_SEC` | the runner (`trustbut-run.mjs`) | Starting point of the runner's time budget, default `570` (the agents' 600 s hook timeout minus a margin); the budget handed to trustbut is this minus the runner's own start-up time, at least 30 s. Set it lower for an agent with a shorter hook timeout |
| `TRUSTBUT_VERSION_PROBE_MS` | the runner | How long the `trustbut --version` probe of the `trustbut` on PATH may take, default `10000` |
| `TRUSTBUT_BIN` | the runner | Path of the trustbut executable to run, instead of looking on PATH and falling back to `npx --yes --quiet --prefer-offline trustbut@<runner version>` |
| `TRUSTBUT_NO_TOOLCHAIN_E2E` | trustbut's own test suite | `1` skips the real-toolchain end-to-end tests (Go, Cargo, Maven, …). This repo's `.trustbut.json` sets it through `env` so its own receipt doesn't need those toolchains; the CI matrix runs them (with `TRUSTBUT_REQUIRE=<tools>` making a missing tool a failure instead of a skip) |

### 8. GitHub Action (`isAlmogK/trustbut@v0`)

A composite action (`action.yml` at the repo root) that runs `trustbut verify --base origin/<base> --receipt-json … --receipt-md …` on the pull request, appends the Markdown receipt to the job summary, posts or updates one **sticky comment**, and fails the job on a FAIL (or on WARN with `strict`). `@v0` is a moving tag that exists after the first release workflow has run; before that, pin `@v0.3.0` or use `@main` with `version: local` (before the npm release the action can only run its own checkout).

| Input | Default | Meaning |
|---|---|---|
| `base` | PR base branch, else the repo default branch | Base branch to compare against; compared as `origin/<base>` |
| `strict` | `false` | Exit 1 on WARN as well as FAIL |
| `config` | none | Path to a trustbut config file (`--config`) |
| `root` | none | Package folder to run tests in (`--root`) |
| `working-directory` | `.` | Directory to run trustbut from |
| `version` | the version matching the action's ref | npm version of trustbut to run (`npx trustbut@<version>`), or `local` to build and run the action's own checkout |
| `node-version` | none | Force a Node version; by default Node 22 is installed only if the runner has no Node ≥ 22 (none, or older) |
| `comment` | `true` | Post or update the sticky PR comment |
| `comment-key` | `default` | Tells several comments on one PR apart (monorepo packages); part of the hidden marker |
| `github-token` | `${{ github.token }}` | Token for the comment (needs `pull-requests: write`) |
| `comment-author` | `github-actions[bot]` | Login whose comment is updated in place; set it when `github-token` is a PAT or GitHub App token |

| Output | Meaning |
|---|---|
| `verdict` | `pass`, `warn`, `fail` or `error` |
| `exit-code` | trustbut's exit code (`0`, `1` for FAIL or strict WARN, `2` for an error) |
| `receipt-path` | Path of the Markdown receipt (set when one was written) |
| `comment-url` | URL of the sticky comment (empty if none was posted) |

- The comment is found by a hidden marker (`<!-- trustbut-receipt:<key> -->`) at its start **and** its author, so a human can't plant a marker the action then overwrites. Bodies over 60,000 bytes are truncated with a pointer to the job summary.
- Fork PRs: the token is read-only, so no comment is posted (a notice says so) and the receipt is in the job summary only. A comment that can't be posted (missing `pull-requests: write`, Dependabot) is a warning, never a failure.
- The action warns when used under `pull_request_target`; use `pull_request`. It needs the full history for the merge-base: use `fetch-depth: 0` (a shallow clone is unshallowed with a notice).
- The last step fails the job with trustbut's exit code, so the comment and summary are written even on a FAIL.

## Later layers

What comes next, and in which version, is in [ROADMAP.md](ROADMAP.md). All surfaces consume the agent receipt JSON (`trustbut verify --json`, agent receipts v1, `specVersion: "1.2"`), so the engine stays the single source of truth.

## Security model
- The tool **runs the repository's tests, which means running its code.** Locally that is the same trust as running `npm test`. The same holds for `.trustbut.json`, which is read from the head commit: its `command` and `setup` run as shell commands, just as a changed `package.json` test script would.
- **Agent hooks run outside the agent's sandbox.** `trustbut hook` is started by the agent's turn-end hook, so the tests (including ones the agent just wrote) and `.trustbut.json` commands run with the user's permissions and network, not inside whatever sandbox the agent's own tool calls had. Where that matters, set `hook.enabled: false` or `TRUSTBUT_SKIP=1` and run `trustbut verify` in a sandbox instead.
- In CI the Action runs on `pull_request` (not `pull_request_target`; it warns if it is). The comment step needs `pull-requests: write`, which GitHub withholds from fork PRs, so those get the job summary only; no job holding a write token ever runs a fork's code.
- Transcripts stay local, and the receipt never includes transcript text unless asked (`--include-transcript`).

## Non-goals (v0.1)
GUI, hosted service, accounts, LLM-written review comments, capturing transcripts (Entire and git-ai already do that), automatic monorepo package discovery (set `root` or `--root` per package).
