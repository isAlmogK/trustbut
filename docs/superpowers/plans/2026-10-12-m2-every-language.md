# M2 Every Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** trustbut verifies agent changes in every mainstream language and test framework, works in monorepo subfolders and with custom setup (e.g. a Firebase emulator), can verify uncommitted work, and verifies its own development on every task and pull request.

**Architecture:** Two registries replace today's hard-coded JS/Python handling: a **language registry** (file extensions, test-file patterns, comment/string syntax, and focus/skip/test-definition/assertion/escape rules per language) used by classify, the lexer and the static checks; and a **runner registry** (detection with priority, command construction, result parsing) used by detection and the proof engine. A `.trustbut.json` config (or `--config <file>`) adds a package root, runner override, generic command, setup/teardown commands, env, extra args and timeout. Every runner normalises results to the existing `TestCaseResult` so the proof engine, receipt and renderer stay unchanged.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥ 22, commander, execa, parse-diff, fast-xml-parser, Vitest, tsup. No new runtime dependencies unless a task says so.

**Plan style:** v0.1's plan carried full code. This plan specifies exact interfaces, commands, output formats and acceptance tests per task; implementers write the code test-first. Where a runner's real toolchain is installed locally (Go, Java, Ruby, Dart/Flutter, Swift, Node, Python without pytest), its integration test must run for real; otherwise it is `skipIf(!has<Tool>)` locally and runs in CI (Task 16).

## Global Constraints

- Node ≥ 22, `"type": "module"`, imports use `.js` extensions; TypeScript strict.
- No LLM calls in the core. Deterministic output.
- Never modify the user's working tree, index or HEAD; every worktree and temp file is removed in a `finally`.
- Must work with git 2.17+.
- Findings state facts, never intent. Existing finding ids stay stable; new ids are kebab-case and listed in `docs/SPEC.md`.
- Exit codes: 0 = PASS or WARN, 1 = FAIL (or WARN with `--strict`), 2 = usage/runtime error.
- All existing tests keep passing; existing JS/TS and Python behaviour is unchanged unless a task says otherwise.
- Every task ends with `npm test`, `npm run typecheck`, `npm run build`, **and `npm run receipt`** (added in Task 1); the receipt is pasted into the task report. A FAIL receipt caused by the task's own changes blocks the task.
- Run every shell command with `export PATH=/usr/bin:$PATH &&` first on this machine (old git 2.17 shadows 2.50).

## Shared interfaces (introduced in Task 2, used by all later tasks)

```ts
// src/languages/types.ts
export interface CommentSyntax { line: string[]; block?: [open: string, close: string] }
export interface LanguageRules {
  focus?: RegExp[];        // matched against lexed code; FAIL "test-focused"
  skip?: RegExp[];         // matched against lexed code; WARN "test-skipped"
  testDef?: RegExp[];      // counts test definitions for "tests-removed"
  assert?: RegExp[];       // counts assertions for "assertions-removed"
  escapes?: { part: 'code' | 'comment'; re: RegExp; title: string }[]; // WARN "escape-added"
}
export interface Language {
  id: string;                         // 'js' | 'py' | 'go' | 'rust' | 'java' | 'kotlin' | 'csharp' | 'ruby' | 'php' | 'dart' | 'swift'
  extensions: string[];               // e.g. ['.go']
  testFile: RegExp;                   // e.g. /_test\.go$/
  comments: CommentSyntax;
  strings: string[];                  // string delimiters, longest first, e.g. ['"""', "'''", '"', "'"]
  rules: LanguageRules;
}
// src/languages/index.ts
export function languageOf(path: string): Language | undefined;
export const LANGUAGES: Language[];

// src/runners/types.ts (extended)
export interface RunOptions {
  cwd: string;              // the package root inside the worktree
  files?: string[];         // test files relative to cwd; undefined = full suite
  args?: string[];          // extra args from config, appended to the runner's command
  env?: Record<string, string>;
  timeoutMs?: number;
}
export interface Runner {
  name: string;                                   // 'vitest' | 'pytest' | 'jest' | 'node-test' | 'mocha' | 'go' | 'cargo' | 'maven' | 'gradle' | 'dotnet' | 'rspec' | 'phpunit' | 'dart' | 'flutter' | 'swift' | 'command'
  detect(root: string): Promise<number>;          // 0 = not this runner; higher = more specific match
  run(opts: RunOptions): Promise<RunResult>;
  /** Optional: map a changed test file to the case ids it contains, when the runner's ids don't carry file paths (e.g. Go, JVM). */
  casesInFile?(c: TestCaseResult, file: string): boolean;
}
// src/runners/registry.ts
export const RUNNERS: Runner[];
export function getRunner(name: string): Runner;            // throws "Unknown runner: X. Supported: …"
export async function detectRunner(root: string): Promise<Runner | null>; // highest detect() score wins

// src/config.ts
export interface TrustbutConfig {
  root?: string;            // package folder relative to repo root, default '.'
  runner?: string;
  command?: string;         // generic runner: shell command; `{files}` is replaced with the quoted test files (or nothing for a full run)
  junit?: string;           // generic runner: path (relative to root) of the JUnit XML the command writes
  setup?: string;           // shell command run in the root before both runs (e.g. start an emulator); killed after
  env?: Record<string, string>;
  args?: string[];
  timeoutSec?: number;      // default 900
}
export async function loadConfig(repo: string, explicitPath?: string): Promise<TrustbutConfig>; // `.trustbut.json` at repo root, or --config
```

---

### Task 1: Dogfooding — trustbut verifies its own development

**Files:** `package.json`, `.github/workflows/ci.yml`, `README.md`, `AGENTS.md`

- [ ] Add npm script `"receipt": "npm run build && node dist/cli.js verify"` (defaults to comparing with the merge-base of `main`).
- [ ] CI: keep the job-summary receipt; additionally, for pull requests from this repository (`github.event.pull_request.head.repo.full_name == github.repository`), post or update **one sticky PR comment** containing the receipt, identified by the marker `<!-- trustbut-receipt -->`. Use `gh api` with `GH_TOKEN: ${{ github.token }}` and job-level `permissions: contents: read, pull-requests: write`. The step that runs trustbut must still fail the job on exit 1/2 (keep `shell: bash`); post the comment in a following step with `if: always() && <same-repo condition>` so a FAIL receipt is still posted. Fork PRs get only the job summary.
- [ ] README: add a "Verified by trustbut" line under the badges and a short section in Contributing: every PR gets a receipt comment; run `npm run receipt` locally before opening a PR.
- [ ] AGENTS.md: add the rule "Before reporting a task done, run `npm run receipt` and include the receipt; a FAIL caused by your change blocks the task."
- [ ] Acceptance: `npm run receipt` prints a receipt on this branch; YAML reviewed for exit-code propagation and permissions. Commit `ci: post trustbut receipt as a sticky PR comment; add npm run receipt`.

### Task 2: Language and runner registries + config + package root

**Files:** create `src/languages/{types,index,js,python}.ts`, `src/runners/registry.ts`, `src/config.ts`; modify `src/classify.ts`, `src/lex.ts`, `src/checks/*.ts`, `src/runners/{types,detect,vitest,pytest}.ts`, `src/proof.ts`, `src/commands/verify.ts`, `src/program.ts`, `docs/SPEC.md`; tests alongside.

- [ ] Language registry with `js` (`.js .jsx .ts .tsx .mjs .cjs .mts .cts`) and `py` entries holding exactly today's patterns; `classify`, the lexer (driven by `comments`/`strings` instead of the `'js' | 'py'` switch) and both checks read from the registry. All existing check tests pass unchanged.
- [ ] Runner registry with `detect()` scores; vitest and pytest converted (vitest: dep or config file → 10; pytest: ini/conftest/pyproject `[tool.pytest` → 10). `--runner` accepts any registered name (validate against the registry; drop the hard-coded commander `.choices`, keep the clear error and exit 2).
- [ ] `loadConfig`: reads `.trustbut.json` from the repo root at **head** (via `git show head:.trustbut.json` if present, else the working tree file) or `--config <path>`; validates types; unknown keys → error exit 2 listing allowed keys.
- [ ] Package root: proof engine runs the runner with `cwd = <worktree>/<root>`; changed test files are filtered to those under `root` and passed relative to it; `linkDeps` also links `<repo>/<root>/node_modules`, `<repo>/<root>/.venv` and `<repo>/<root>/venv`; receipt file paths stay repo-relative.
- [ ] `setup`: run via shell in the package root of each worktree before its test run, in the background; wait `setupWaitSec` (config, default 5) or until the process prints a line matching `setupReadyPattern` (config, optional regex); always kill its process group after the run (also on error). `env`, `args` and `timeoutSec` passed to every run.
- [ ] Generic `command` runner (`src/runners/command.ts`): requires `command`; replaces `{files}` with shell-quoted files or empty string; runs via `sh -c` in the root with env; parses JUnit XML from `junit` path (relative to root) if set, else from stdout if it starts with `<?xml` or `<testsuite`; exit-code semantics like other runners.
- [ ] CLI: add `--config <path>` and `--root <dir>` (overrides config root).
- [ ] SPEC.md: document `.trustbut.json` keys.
- [ ] Acceptance tests: config validation; subfolder fixture (vitest project inside `packages/app/` of a fixture repo) proves a fix; generic runner with a shell script that writes JUnit XML; setup command that writes a marker file and is killed afterwards.

### Task 3: Verify uncommitted work (`--working`)

**Files:** `src/git.ts`, `src/commands/verify.ts`, `src/program.ts`, tests.

- [ ] `snapshotWorkingTree(repo): Promise<string>` returns a commit SHA representing HEAD plus all tracked modifications and untracked, non-ignored files, built with a **temporary index file** (`GIT_INDEX_FILE=<tmp> git read-tree HEAD && git add -A && git write-tree && git commit-tree <tree> -p HEAD -m "trustbut working snapshot"`), never touching the real index, HEAD or refs. Git 2.17-compatible.
- [ ] `--working`: head = that snapshot; receipt `headRef` label "working tree"; the `uncommitted-changes` info finding is not emitted in this mode.
- [ ] Acceptance: fixture with an uncommitted fix + untracked new test → PASS; `git status --porcelain` identical before/after; real index unchanged (compare `git ls-files -s`).

### Task 4: Jest

**Files:** `src/runners/jest.ts`, registry, tests (Jest available via `npm i -D jest` in fixtures? No: install `jest` as a devDependency of this repo for fixtures only).

- [ ] Detect: `jest` in deps, or `jest.config.*`, or `"jest"` key in package.json, or preset `jest-expo`/`react-native` → 10 (higher than vitest only if vitest absent).
- [ ] Run: `node_modules/.bin/jest --ci --json --outputFile=<tmp> --testLocationInResults --watchman=false [--runTestsByPath files…] [args]`; parse `testResults[].assertionResults[]` (`fullName`, `status`: passed/failed/pending/todo/skipped), `testResults[].name` (absolute → relative to cwd) as file; id `${file}::${fullName}`. A suite that fails to run (`testResults[].status === 'failed'` with zero assertionResults) → one error case named after the file.
- [ ] Acceptance: real Jest fixture (TypeScript via `ts-jest` is NOT required — use plain JS tests) proves a fix and flags a non-constraining test; DogBase-like layout check: detection picks jest for a package with `jest-expo` preset.

### Task 5: node:test

- [ ] Detect: package.json `scripts.test` matches `node (--[a-z-]+ )*--test` or `tsx --test` → 8.
- [ ] Run: `node --test --test-reporter=junit --test-reporter-destination=<tmp> [files]` (Node ≥ 22 has the built-in junit reporter); parse with existing JUnit parser; file attribute → relative path.
- [ ] Acceptance: real fixture (node is installed) proves a fix.

### Task 6: Mocha

- [ ] Detect: `mocha` dep or `.mocharc.*` → 9.
- [ ] Run: `node_modules/.bin/mocha --reporter json --reporter-option output=<tmp> [files]`; parse `passes/failures/pending` arrays (`fullTitle`, `file`).
- [ ] Acceptance: skipIf mocha not installable offline? Install `mocha` as a devDependency for fixtures; real test.

### Task 7: Go

**Files:** `src/runners/go.ts`, `src/languages/go.ts` (language entry may land in Task 15; minimal test-file pattern `_test\.go$` needed here).

- [ ] Detect: `go.mod` at root → 10.
- [ ] Run: `go test -json [args] <pkgs>` where pkgs = `./...` for a full run, else the unique package dirs of the changed `_test.go` files (`./path/to/pkg`). Parse test2json lines: events with `Test` set and `Action` ∈ pass/fail/skip → cases `{ id: "${Package}::${Test}", file: <package dir relative to module root>, name: Test }`; build failures (`Action: "fail"` with no Test and output containing `[build failed]` or `FAIL … [setup failed]`) → one error case per package.
- [ ] `casesInFile(c, file)`: true when the case's package dir equals `dirname(file)` AND (the test name is defined in that file — parse `func (Test\w+)\(` / `func (Benchmark\w+)` / `func (Fuzz\w+)` from the head version of the file, passed via a lookup the proof engine provides) — implement by letting the proof engine pass head file contents; subtests `TestX/sub` belong to `TestX`.
- [ ] Config `args` example for DogBase: `["-p", "1"]`.
- [ ] Acceptance: real Go fixture (go is installed): module with a buggy func + new `_test.go` proves the fix; a subtest; a `t.Skip` added at head shows as skipped.

### Task 8: Rust (Cargo)

- [ ] Detect: `Cargo.toml` → 10.
- [ ] Run: if `cargo nextest` is available (`cargo nextest --version` exit 0): `cargo nextest run --no-fail-fast --message-format libtest-json-plus` with env `NEXTEST_EXPERIMENTAL_LIBTEST_JSON=1`, parse `{"type":"test","event":"ok|failed|ignored","name":"crate::path::test"}`; else `cargo test --no-fail-fast [args] -- --test-threads=1` and parse stdout lines `^test (\S+) \.\.\. (ok|FAILED|ignored)`. File mapping via `casesInFile`: test path segments vs file module path (`src/foo/bar.rs` → `foo::bar`, `tests/x.rs` → crate `x`).
- [ ] Acceptance: unit tests for both parsers with captured sample output; integration test skipIf no cargo (runs in CI).

### Task 9: JVM — Maven and Gradle

- [ ] Detect: `pom.xml` → maven 10; `build.gradle(.kts)`/`settings.gradle(.kts)` → gradle 10. Prefer wrappers `./mvnw` / `./gradlew` when present.
- [ ] Run: Maven `-q -B test [-Dtest=Class1,Class2] -DfailIfNoTests=false -Dsurefire.failIfNoSpecifiedTests=false`, read `target/surefire-reports/TEST-*.xml` (all modules: glob `**/target/surefire-reports/TEST-*.xml`); Gradle `test [--tests Class…] --continue`, read `**/build/test-results/test/*.xml`. Delete stale report dirs before running. Class names from changed files: `src/test/java/com/x/FooTest.java` → `com.x.FooTest` (same for Kotlin `.kt`).
- [ ] `casesInFile`: classname equals the file's FQCN (or starts with `FQCN$` for nested).
- [ ] Acceptance: JUnit-XML parsing of a captured surefire report and gradle report; integration test skipIf no mvn/gradle (CI).

### Task 10: .NET

- [ ] Detect: `*.sln`, `*.csproj`, `*.fsproj` at root → 10.
- [ ] Run: `dotnet test --nologo --logger "trx;LogFileName=<tmp>.trx" [--filter "FullyQualifiedName~Ns.Class|…"]`; parse TRX XML (`UnitTestResult@testName`, `@outcome` Passed/Failed/NotExecuted; class from `TestDefinitions/UnitTest/TestMethod@className`).
- [ ] Acceptance: TRX parser unit test with a captured sample; integration skipIf no dotnet (CI).

### Task 11: Ruby — RSpec

- [ ] Detect: `.rspec` or `spec/` dir with `rspec` in `Gemfile`/`Gemfile.lock` → 10.
- [ ] Run: `bundle exec rspec --format json --out <tmp> [files]` (fall back to `rspec` if no Gemfile); parse `examples[]` (`full_description`, `status` passed/failed/pending, `file_path` → normalise `./`).
- [ ] Acceptance: parser unit test; integration skipIf rspec missing (CI).

### Task 12: PHP — PHPUnit

- [ ] Detect: `phpunit.xml(.dist)` or `phpunit/phpunit` in `composer.json` → 10.
- [ ] Run: `vendor/bin/phpunit --log-junit <tmp> [files]`; JUnit parse (testcase `file` attribute present).
- [ ] Acceptance: parser test with captured sample; integration skipIf no php (CI).

### Task 13: Dart and Flutter

- [ ] Detect: `pubspec.yaml` with `flutter:` sdk dependency → flutter 10; else with `test:` dev dependency → dart 10.
- [ ] Run: `flutter test --machine [files]` / `dart test --reporter json [files]`; parse JSON lines: `testStart {test: {id, name, url|root_url, suiteID}}`, `suite {suite: {id, path}}`, `testDone {testID, result: success|failure|error, skipped, hidden}`; ignore `hidden` tests (setUpAll/loading); file = suite path relative to root.
- [ ] Acceptance: real Dart fixture (dart is installed, `dart test` needs `package:test` — create with `dart pub get` offline? If offline install fails, use a captured JSON sample for the parser and skipIf for integration).

### Task 14: Swift

- [ ] Detect: `Package.swift` → 10.
- [ ] Run: `swift test --parallel --xunit-output <tmp>` (with `--filter` built from changed test files' class names when files given); JUnit parse.
- [ ] Acceptance: parser test with captured xunit sample; real integration if `swift test` works locally (Xcode toolchain present), else skipIf.

### Task 15: Language-aware static checks for all languages

**Files:** `src/languages/{go,rust,java,kotlin,csharp,ruby,php,dart,swift}.ts`, tests.

Rules (all matched on lexed code unless "comment"):

| Language | Test file | focus | skip | testDef | assert | escapes |
|---|---|---|---|---|---|---|
| Go | `_test\.go$` | — | `\bt\.Skip(Now|f)?\(` | `^func (Test|Benchmark|Fuzz)\w*\(` | `\b(t\.(Error|Errorf|Fatal|Fatalf)\|assert\.\w+\|require\.\w+)\(` | comment `//\s*nolint`, code `//go:build ignore` (comment) |
| Rust | `tests/.*\.rs$` or file containing `#[cfg(test)]` (treat `.rs` under `tests/` as test) | — | `#\[ignore` | `#\[(tokio::)?test\]` | `\b(assert|assert_eq|assert_ne|debug_assert)!\(` | code `#!?\[allow\(`, code `\bunsafe\s*\{`, code `\.unwrap\(\)` NOT flagged |
| Java | `(src/test/.*\|Test\.java$\|Tests\.java$\|IT\.java$)` | — | `@(Disabled\|Ignore)\b` | `@(Test\|ParameterizedTest\|RepeatedTest)\b` | `\b(assert\w*\|verify)\(` | code `@SuppressWarnings\(` |
| Kotlin | same with `.kt` | — | `@(Disabled\|Ignore)\b` | `@Test\b` | `\b(assert\w*\|verify)\(` | code `@Suppress\(` |
| C# | `(Tests?\.cs$\|\.Tests?/)` | — | `\[(Ignore\|Fact\(Skip\|Theory\(Skip)` incl. `Skip\s*=` | `\[(Fact\|Theory\|Test\|TestMethod\|TestCase)` | `\b(Assert\.\w+\|Should\(\))` | comment `#pragma warning disable` (treat `#pragma` line as code), code `!\s*;` no |
| Ruby | `(_spec\.rb$\|_test\.rb$\|spec/\|test/)` | `\b(fit\|fdescribe\|fcontext)\b`, `:focus\b`, `focus:\s*true` | `\b(xit\|xdescribe\|xcontext\|skip\|pending)\b` | `^\s*(it\|specify\|test)\b` | `\b(expect\|assert\w*\|should)\b` | comment `rubocop:disable` |
| PHP | `(Test\.php$\|tests/)` | — | `markTestSkipped\|markTestIncomplete\|#\[Group\('skip` | `function test\w*\(\|#\[Test\]\|@test\b` | `\$this->assert\w+\(\|self::assert\w+\(` | comment `@phpstan-ignore\|@psalm-suppress\|phpcs:ignore` |
| Dart | `_test\.dart$` | `\bsolo:\s*true` | `\bskip:\s*(true\|'\|")` | `^\s*(test\|testWidgets\|group)\(` | `\bexpect\(` | comment `//\s*ignore(_for_file)?:` |
| Swift | `Tests?\.swift$\|Tests/` | — | `\bXCTSkip\|throw XCTSkip\|\.disabled\(` | `func test\w*\(\|@Test\b` | `\b(XCTAssert\w*\|#expect\|#require)\(` | comment `swiftlint:disable` |

- [ ] Each language: comment syntax (`//` + `/* */` for Go/Rust/Java/Kotlin/C#/PHP(+`#`)/Dart/Swift; `#` for Ruby with `=begin/=end` ignored), string delimiters (Go/Rust/Java/C#/Dart/Swift `"`, `'` where applicable; Go raw `` ` ``; Kotlin/Swift/Dart/Python triple quotes; Ruby `"`/`'`).
- [ ] Fix-ups at the same time: escape title grammar consistent ("lint rule disabled", "warnings suppressed", "test ignored" etc. per table), risk rules unchanged.
- [ ] Acceptance: per language, positive and negative fixtures (including the "string literal that mentions the pattern" case).

### Task 16: CI matrix for real toolchains

- [ ] `.github/workflows/ci.yml`: keep the main job; add a matrix job `adapters` with one entry per toolchain (go, rust+nextest, java-maven, java-gradle, dotnet, ruby, php, dart, flutter, swift on `macos-latest`) installing it with the official setup action (`actions/setup-go`, `dtolnay/rust-toolchain` + `taiki-e/install-action` for nextest, `actions/setup-java` + maven/gradle, `actions/setup-dotnet`, `ruby/setup-ruby`, `shivammathur/setup-php` + composer phpunit, `dart-lang/setup-dart`, `subosito/flutter-action`) and running only that adapter's integration tests with env `TRUSTBUT_REQUIRE=<tool>`; tests read `TRUSTBUT_REQUIRE` and **fail instead of skip** when the required tool is missing.
- [ ] Acceptance: workflow YAML reviewed; locally `TRUSTBUT_REQUIRE=go npx vitest run test/runners/go.test.ts` passes.

### Task 17: Receipt fields for multi-language + docs

- [ ] Receipt adds `languages: string[]` (languages of changed files) and `root` (package root) — JSON only, `version` stays 1 (additive). Renderer shows `runner: X · root: Y` when root ≠ '.'.
- [ ] README: Install/Usage tables list every runner with detection rules and its config example; `.trustbut.json` reference; DogBase-style examples (Go with emulator setup and `-p 1`; Expo/Jest app; Vitest in `functions/`).
- [ ] SPEC.md: runner registry, language registry, new finding ids.

### Task 18: Field validation on real repos (controller-run, no code unless fixes are needed)

- [ ] Run `trustbut verify` (and `--working` where relevant) against the DogBase repos with configs kept **outside** those repos (`--config ~/Desktop/trustbut-private/configs/<repo>.json`), read-only: web-app-v2 (vitest), firebase-functions (`root: "functions"`, vitest), mobile-app-v2 (jest-expo), core-backend / ai-engine / insights (go, `args: ["-p","1"]`, `setup: "firebase emulators:start --only firestore"` with a ready pattern). Record receipts, false positives and crashes; every defect becomes a fixture + fix task.
