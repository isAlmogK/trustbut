# Releasing trustbut

Minimums used by `.github/workflows/release.yml` (a test keeps this in sync): **Node >= 22.14**, **npm >= 11.5.1** (the workflow installs `npm@11` and asserts the version; do not move to npm 12 for publishing yet), GitHub-hosted runners only.

Two facts shape the whole process:

- Trusted publishing cannot create a package, so **0.3.0 is published by hand**, once.
- A new trusted-publisher config **expires 48 hours after creation** unless a CI publish succeeds through it, so it is configured only immediately before the first CI release (0.3.1).

## 1. First release (0.3.0): one explicit sequence

1. Merge the M3 branch to `main` (version already 0.3.0 in `package.json`, `package-lock.json`, `plugin.json`).
2. **Manual publish** from a clean checkout of `main` (the maintainer, with npm 2FA):

   ```sh
   git clone https://github.com/isAlmogK/trustbut.git trustbut-release && cd trustbut-release
   npm ci                              # `prepare` builds dist/
   TRUSTBUT_NO_TOOLCHAIN_E2E=1 npm test && npm run typecheck
   node scripts/release/check-versions.mjs v0.3.0
   npm login
   npm publish --access public --provenance=false   # provenance only exists for CI publishes
   npx trustbut@0.3.0 --version        # verify: prints 0.3.0
   ```

   0.3.0 has no provenance attestation; every CI-published version after it does.
3. **Create the GitHub Release `v0.3.0`** on `main` (this creates the tag; tick the Marketplace box here, see section 4). Publishing the Release triggers `release.yml`. It sees `trustbut@0.3.0` already on npm, skips publishing, and still runs `major-tag`, which creates the `v0` tag.
4. Only now does `uses: isAlmogK/trustbut@v0` resolve: **the Action is not usable via `@v0` until `v0` exists** (after step 3's workflow run is green). Until then use the full tag `@v0.3.0`.
5. Continue with section 2, then cut 0.3.1 from CI (section 3).

## 2. Trusted publisher + environment (immediately before cutting 0.3.1)

Order matters because of the 48 h window. Do these in sequence, all in one sitting:

1. **Have the bump PR merged first**: `npm run release:bump 0.3.1`, changelog entry, PR merged to `main` (section 3 steps 1-3). Nothing else should be pending.
2. Create or configure the GitHub environment `npm`: repo Settings, Environments (the first `release.yml` run, for v0.3.0, auto-creates it if it doesn't exist yet, so by now it usually does). Optionally add a required reviewer and restrict deployment to tags `v*`. Note that required reviewers hold a run until approved: if you added them before the v0.3.0 Release, that run waits for approval before the `v0` tag is created.
3. Create the npm trusted publisher (the 48 h clock starts here): npmjs.com, package `trustbut`, Settings, Trusted Publisher, GitHub Actions:
   - Owner `isAlmogK`, repository `trustbut`, workflow filename `release.yml`, environment `npm`.
   - **Allowed actions: tick "npm publish".** New configs are staging-only by default (since 2026-09-03); without the tick the workflow's `npm publish` is refused. (Alternative: leave staging-only, change the workflow to `npm stage publish`, and approve each release with 2FA on npmjs.com.)
   - **Every field is case-sensitive and npm does not check it on save.** The owner must be `isAlmogK` exactly: `isalmogk` saves fine and then every publish fails with `E404 … you do not have permission`, the same error as a missing "npm publish" permission.
   - npm's docs say configs can't be edited (the page shows an Edit button anyway): to fix a field, delete the entry and recreate it, which restarts the 48 h clock. A failed publish can be retried without a new release: `gh run rerun <run-id> --failed`.
4. **Create the GitHub Release `v0.3.1`** immediately (section 3 step 4) and watch the workflow.
5. **Verify** (section 3 step 6) within 48 h. If the window lapses, delete and recreate the config.
6. Hardening: npm Settings, Publishing access, "Require two-factor authentication and disallow tokens", and revoke old automation tokens.

## 3. Cut every later release

1. `npm run release:bump <version>` (updates `package.json`, `package-lock.json`, and `integrations/claude-code/.claude-plugin/plugin.json`).
2. Add a `CHANGELOG.md` entry.
3. `npm run build && node scripts/release/check-versions.mjs v<version>` locally, commit, open a PR, merge to `main`.
4. GitHub, Releases, Draft a new release: create the tag `v<version>` on `main`, write the notes, **Publish release**. Tick "pre-release" for a prerelease: it publishes under the `next` dist-tag and does not move `v0`.
5. The `release` workflow runs typecheck, tests, the version-agreement check, `npm pack --dry-run`, then `npm publish` (with automatic provenance; skipped if that exact version is already on npm). Then, for stable releases only, it moves `v0` to the new release, but only if it is the highest stable `v0.x.y` tag.
6. Verify: `npx trustbut@<version> --version` and the provenance badge on npmjs.com.

**Tag protection caveat.** If a repository ruleset or tag protection covers `v*`, the workflow's `GITHUB_TOKEN` cannot force-move `v0` and the `major-tag` job fails. In that ruleset, allow force updates for `v0` (or exclude `v0` from the rule), or add the GitHub Actions app as a bypass actor. Version tags `vX.Y.Z` can stay protected.

## 4. GitHub Marketplace listing for the Action

One-time, by the maintainer, in the browser, on the `v0.3.0` Release (section 1 step 3):

1. Enable 2FA on the GitHub account. The repo must be public with `action.yml` at the root (it is).
2. Accept the GitHub Marketplace Developer Agreement (prompted on the release page).
3. Tick "Publish this Action to the GitHub Marketplace", set the action name to a unique value (`trustbut receipt`; the UI rejects taken names), choose a primary category (for example Code quality) and optionally a second one, then publish from the release page. Later releases keep the listing updated.

## 5. Claude Code marketplace

Nothing to publish: `.claude-plugin/marketplace.json` in this repo is the marketplace. Users run `/plugin marketplace add isAlmogK/trustbut`. Just keep the `plugin.json` version equal to `package.json` (the release check enforces it).

## 6. Rollback

- Prefer `npm deprecate trustbut@<version> "reason; use <good version>"` and release a fixed patch version. `npm unpublish` is only allowed in limited cases (within 72 hours of publishing, and subject to npm's policy on dependents) and it breaks lockfiles, so do not rely on it; after 72 hours deprecate instead.
- If `latest` points at a bad version: ship the fix, or `npm dist-tag add trustbut@<good version> latest` (needs a normal 2FA login).
- A bad `v0` tag: re-point it manually to the last good release tag and push it (the workflow does the same on the next stable release).
