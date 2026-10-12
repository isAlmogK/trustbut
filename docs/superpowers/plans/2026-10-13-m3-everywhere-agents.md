# M3 Everywhere Agents Finish Work — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** trustbut runs wherever agents finish work. The agent can't say "done" while the receipt is FAIL (Claude Code, Codex, Gemini CLI), OpenCode gets the receipt back as a follow-up prompt, every pull request gets a receipt through a reusable GitHub Action, and `npx trustbut verify` works from npm.

**Architecture:** One new CLI subcommand, `trustbut hook <agent>`, owns all agent protocols: it reads the agent's hook JSON on stdin, applies loop and skip rules, runs the verify pipeline (default `--working --quick`), and translates the verdict into that agent's exit-code/JSON contract. Thin integrations call it: a Claude Code plugin published from this repo's marketplace, and `trustbut init <agent>`, which writes project-level config for Claude Code, Codex, Gemini CLI and OpenCode. A composite GitHub Action at the repo root runs `npx trustbut@<action version>` and posts the sticky comment; this repo's CI dogfoods it with `uses: ./`. A release workflow publishes to npm with trusted publishing.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥ 22, commander, execa, Vitest, tsup; GitHub Actions (composite); npm trusted publishing (OIDC).

**Decisions (approved by the user, 2026-10-13):** repo stays `isAlmogK/trustbut`; author credit "Almog Koren (https://almog.io)"; hooks default to `--working --quick`, block only on FAIL, show WARN to the user, max 3 automatic retries per session, then allow stop with a message.

## Research summary (sources in trustbut-private/research_notes/agent-hooks-v03.md and action-and-npm-v03.md)

| Agent | Event | Block "done" | Feedback channel | Loop guard | Timeout unit/default |
|---|---|---|---|---|---|
| Claude Code | `Stop` (hooks.json in a plugin, or `.claude/settings.json`) | exit 0 + stdout `{"decision":"block","reason":…}` (or exit 2 + stderr) | `reason` → Claude; `systemMessage` → user only | `stop_hook_active`; built-in cap 8 | seconds, 600 |
| Codex CLI ≥ 0.124 | `Stop` (`.codex/hooks.json` or `config.toml [[hooks.Stop]]`) | exit 2 + stderr (or `{"decision":"block","reason"}`) | reason becomes a new user prompt | `stop_hook_active`, no cap | seconds, 600 |
| Gemini CLI ≥ 0.35 | `AfterAgent` (`.gemini/settings.json` `hooks`) | exit 2 + stderr with **empty stdout** (or `{"decision":"deny","reason"}`) | reason becomes a new prompt | `stop_hook_active`, cap 100 | **milliseconds**, 60000 |
| OpenCode V1 (`opencode-ai` 1.x) | plugin event `session.idle` | cannot block | `client.session.prompt({path:{id}, body:{parts:[{type:'text',text}]}})` (don't await) | none — plugin counts | n/a |

Plain stdout with exit 0 on Codex `Stop` is treated as invalid; Codex/Gemini receipts over ~2,500 tokens get truncated by the agent — keep agent feedback short. trustbut's own exit 2 (error) must never block an agent.

## Global Constraints

- Node ≥ 22, ESM, `.js` imports, strict TS; git 2.17-compatible; never modify the user's working tree/index/HEAD.
- Deterministic core; findings state facts, never intent.
- CLI exit codes for `verify` unchanged (0 PASS/WARN, 1 FAIL, 2 error). `trustbut hook` exit codes follow each agent's protocol (below), never trustbut's.
- A trustbut error, timeout or "no changes" must never block an agent.
- Agent feedback text ≤ 6,000 characters (verdict, FAIL/WARN findings, failing tests, how to rerun); full receipt available via a path.
- Every task ends with `npm test`, `npm run typecheck`, `npm run build`, `npm run receipt`. Run shell commands with `export PATH=/usr/bin:$PATH &&` first on this machine.
- Docs credit: "Almog Koren (https://almog.io)".

---

### Task 1: Release plumbing in the CLI

**Files:** `package.json`, `src/version.ts` (generated or reads package.json), `src/program.ts`, `src/commands/verify.ts`, tests.

- [ ] `VERSION` comes from package.json (build-time inject via tsup `define`, or `createRequire` read); `trustbut --version` matches package.json; test asserts equality.
- [ ] package.json: version `0.3.0`, `author: "Almog Koren (https://almog.io)"`, `homepage`, `keywords` include `agent-receipts`; keep `prepare: npm run build`.
- [ ] `--receipt-json <path>`: also write the JSON receipt to a file while printing Markdown (or JSON with `--json`). Test.
- [ ] `--receipt-md <path>`: write the Markdown receipt to a file as well (the Action and hooks use these). Test.

### Task 2: `trustbut hook <agent>`

**Files:** `src/commands/hook.ts`, `src/hook/{protocols,state,feedback}.ts`, `src/program.ts`, `src/render.ts` (agent feedback renderer), docs/SPEC.md, tests.

- [ ] `trustbut hook <claude|codex|gemini>`: read stdin JSON (tolerate empty/invalid → treat as `{}`); project dir = `CLAUDE_PROJECT_DIR` | `GEMINI_PROJECT_DIR` | input `cwd` | process cwd.
- [ ] Skip rules (allow stop silently): env `TRUSTBUT_SKIP=1`; not a git repo; no changes (verify's "No changes" error); config `hook.enabled: false`.
- [ ] Run the verify pipeline in-process (reuse `runVerify`) with `working: true`, `quick` per config `hook.mode` (`"quick"` default, `"full"`), plus `--config`/`--root` support via config file only. Respect a hook time budget: config `hook.timeoutSec` (default 540, under the agents' 600 s default); on timeout allow stop with a message.
- [ ] Loop guard: per-session retry counter stored in `os.tmpdir()/trustbut-hook/<sha1(session_id+repo)>.json`; max `hook.maxRetries` (default 3). When the limit is hit, allow stop with a user message "trustbut still FAIL after N attempts — receipt: <path>". Reset the counter on PASS/WARN. Stale files (> 24 h) ignored.
- [ ] Protocol mapping (exact):
  - claude: FAIL → exit 0, stdout `{"decision":"block","reason":<feedback>,"systemMessage":"trustbut FAIL: <one line>"}`; PASS/WARN → exit 0, stdout `{"systemMessage":"trustbut <VERDICT>: <one line>"}` (WARN lists finding titles briefly); error/timeout → exit 0, `{"systemMessage":"trustbut couldn't verify: <reason>"}`; skip → exit 0, no output.
  - codex: FAIL → exit 2, feedback on stderr, nothing on stdout; PASS/WARN → exit 0, stdout `{"systemMessage":…}`; error → exit 0 `{"systemMessage":…}`; skip → exit 0, no output.
  - gemini: FAIL → exit 2, feedback on stderr, **empty stdout**; PASS/WARN/error → exit 0, stdout `{"systemMessage":…}`; skip → exit 0, no output.
- [ ] Feedback renderer `renderForAgent(receipt, receiptPath)`: plain Markdown ≤ 6,000 chars: verdict line, each FAIL finding with file:line, failing tests (≤ 10), WARN findings (≤ 10, one line each), the instruction "Fix these and finish again; run `trustbut verify --working` to check", and the path of the full receipt (written to `<repo>/.git/trustbut/last-receipt.md` — inside .git so it's never committed). Tests per protocol (golden outputs), loop counter, skip rules, timeout path (inject a tiny budget), feedback truncation.
- [ ] Config schema: add `hook` object `{ enabled?, mode?: 'quick'|'full', maxRetries?, timeoutSec? }` to config validation + SPEC + README.

### Task 3: Claude Code plugin + marketplace

**Files:** `.claude-plugin/marketplace.json` (repo root), `integrations/claude-code/.claude-plugin/plugin.json`, `integrations/claude-code/hooks/hooks.json`, `integrations/claude-code/scripts/run.mjs`, tests.

- [ ] marketplace.json: name `trustbut`, owner Almog Koren, one plugin `trustbut` with source `./integrations/claude-code`.
- [ ] plugin.json: name `trustbut`, version = package version, description, author, homepage, repository, keywords.
- [ ] hooks.json: `Stop` → exec form `{"type":"command","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs","claude"],"timeout":600}`.
- [ ] run.mjs (no dependencies, Node ≥ 18 syntax so an old default `node` still parses it): resolve `trustbut` — env `TRUSTBUT_BIN`, else `trustbut` on PATH (≥ the plugin's version), else `npx --yes trustbut@<pinned version>`; spawn `trustbut hook <agent>` with stdin piped through and stdout/stderr/exit code passed through unchanged; if trustbut can't be found/started, print the protocol-appropriate "couldn't verify" message and exit 0 (never block).
- [ ] If the `claude` CLI is available, `claude plugin validate .` in a test (skip otherwise). Unit-test run.mjs resolution with fake binaries.
- [ ] Version sync test: plugin.json version == package.json version.

### Task 4: `trustbut init <agent>`

**Files:** `src/commands/init.ts`, `src/init/{claude,codex,gemini,opencode}.ts`, templates, tests.

- [ ] `trustbut init claude|codex|gemini|opencode [--dry-run] [--user]`: writes project-level config (default) or user-level (`--user`), merging into existing files without removing other hooks; idempotent (a second run changes nothing); prints exactly what it changed; refuses to edit files it can't parse (exit 2 with a clear message).
  - claude: `.claude/settings.json` → `hooks.Stop` entry running `npx --yes trustbut@<version> hook claude` (timeout 600). Print the plugin alternative (`/plugin marketplace add isAlmogK/trustbut`, `/plugin install trustbut@trustbut`).
  - codex: `.codex/hooks.json` → `Stop` entry running `npx --yes trustbut@<version> hook codex` (timeout 600). Print the reminder that Codex requires approving new hooks in `/hooks` and that project hooks load only in trusted projects.
  - gemini: `.gemini/settings.json` → `hooks.AfterAgent` entry with `matcher: "*"`, name `trustbut-verify`, command `npx --yes trustbut@<version> hook gemini`, `timeout: 600000` (ms). Print the trusted-folder note.
  - opencode: `.opencode/plugins/trustbut.js` (V1 plugin API): on `session.idle` (skip subagent sessions; count retries per session, max 3), run `npx --yes trustbut@<version> verify --working --quick --receipt-md <tmp>`; on exit 1 call `client.session.prompt({ path: { id }, body: { parts: [{ type: 'text', text: <feedback> }] } })` without awaiting. Header comment explains V1 vs V2 and links docs. (V2 support is a follow-up.)
- [ ] Tests: each agent's file written correctly into empty and existing configs (golden files), idempotency, `--dry-run` writes nothing, malformed JSON → exit 2.

### Task 5: GitHub Action

**Files:** `action.yml` (repo root), `.github/workflows/ci.yml` (dogfood via `uses: ./`), tests for helper scripts if any.

- [ ] Composite action "trustbut receipt" per the research example (author Almog Koren; branding `check-square` / `green`): inputs `base`, `strict`, `config`, `root`, `working-directory`, `version`, `node-version`, `comment`, `comment-key`, `github-token`; outputs `verdict`, `exit-code`, `receipt-path`, `comment-url`. Version defaults to `$GITHUB_ACTION_PATH/package.json` version. Verdict read from `--receipt-json` (not by grepping Markdown). Only installs Node 22 if the runner's Node is missing or < 22. Sticky comment keyed by `comment-key`, bot-authored only, 60k truncation with fence closing, fork PRs → summary only. Warn under `pull_request_target`. Final step exits with trustbut's code.
- [ ] Until 0.3.0 is on npm, `version: local` (or when `$GITHUB_ACTION_PATH` is this repo) builds and runs the action's own checkout (`npm ci && node dist/cli.js`) so CI can dogfood before release.
- [ ] ci.yml: replace the hand-written receipt + comment steps with `uses: ./` (`version: local`), keeping permissions and the job summary.
- [ ] Validate action.yml structure (a small test that parses it as YAML via a tiny dependency-free check or `node --input-type=module` with a minimal parser already in deps? If none, a structural regex test) and rely on the CI run on the PR to prove it works.

### Task 6: Release workflow + docs for the first publish

**Files:** `.github/workflows/release.yml`, `RELEASING.md`, tests.

- [ ] release.yml per the research example: on `release: published`, GitHub-hosted runner, environment `npm`, permissions `id-token: write` + `contents: read`, Node 24 + npm 11 (≥ 11.5.1), `npm ci`, typecheck, test, tag/package/`--version` agreement check, `npm pack --dry-run`, `npm publish` (`--tag next` for prereleases); second job moves the `v0` tag (plain git tag) after a stable release.
- [ ] RELEASING.md: one-time manual first publish (`npm login`, `npm publish --access public` from a clean checkout of the release tag), then configure the trusted publisher on npmjs.com (repo `isAlmogK/trustbut`, workflow `release.yml`, environment `npm`, allow "npm publish"), create the GitHub environment `npm`, and publish the next version from CI within 48 hours (unvalidated configs expire). Marketplace listing steps for the Action (2FA, Developer Agreement, unique name "trustbut receipt").
- [ ] Test: a script-level check that release.yml references the same Node/npm minimums documented in RELEASING.md (cheap consistency test) — optional.

### Task 7: Docs

**Files:** `README.md`, `docs/SPEC.md`, `docs/ROADMAP.md`.

- [ ] README: new section **"Use it with your agent"** (Claude Code plugin install; `trustbut init codex|gemini|opencode`; what happens on FAIL; `TRUSTBUT_SKIP=1`; `hook` config); CI section uses `uses: isAlmogK/trustbut@v0` with inputs/outputs table; install section switches to `npx trustbut verify` (keep the GitHub install as an alternative); author credit "Almog Koren · almog.io".
- [ ] SPEC: `trustbut hook` protocols table, `--receipt-json/--receipt-md`, `hook` config, `init`.
- [ ] ROADMAP: v0.3 ✅ (in review).

### Task 8: Field validation (controller-run)

- [ ] Build, then in a throwaway repo with a deliberate failing change: run `trustbut hook claude|codex|gemini` with realistic stdin JSON and check outputs/exit codes; if the `claude` CLI is available, run `claude -p` with `--plugin-dir integrations/claude-code` on a scratch repo where the agent's change leaves a failing test, and confirm the Stop hook blocks and Claude receives the receipt. Same for `codex exec`/`gemini -p` if installed (`--dangerously-bypass-hook-trust` for Codex in the scratch repo only).
- [ ] Run `trustbut init` for each agent in a scratch repo and inspect the files.
- [ ] Record results in trustbut-private/field-notes-v03.md; defects become fixtures + fixes.
