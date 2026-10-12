# Releasing trustbut

Minimums used by `.github/workflows/release.yml` (a test keeps this in sync): **Node >= 22.14**, **npm >= 11.5.1** (the workflow installs `npm@11`; do not move to npm 12 for publishing yet), GitHub-hosted runners only.

## 1. One-time: manual first publish of 0.3.0

Trusted publishing cannot create a package, so the very first version is published by hand, by the maintainer.

```sh
git clone https://github.com/isAlmogK/trustbut.git trustbut-release && cd trustbut-release
git checkout v0.3.0                 # a clean checkout of the release tag
npm ci                              # `prepare` builds dist/
npm test && npm run typecheck
node scripts/release/check-versions.mjs v0.3.0
npm login                           # account with 2FA enabled
npm publish --access public --provenance=false   # provenance is only available from CI
npx trustbut@0.3.0 --version        # verify: prints 0.3.0
```

0.3.0 has no provenance attestation; every CI-published version after it does.

## 2. Configure the trusted publisher (do this right before the first CI release)

A new trusted-publisher config **expires 48 hours after creation** unless a publish through it succeeds in that time (48 h window). Create it only when you are ready to cut the next release (step 3).

1. npmjs.com, package `trustbut`, Settings, Trusted Publisher, GitHub Actions:
   - Owner `isAlmogK`, repository `trustbut`, workflow filename `release.yml`, environment `npm`.
   - **Allowed actions: tick "npm publish".** New configs are staging-only by default (since 2026-09-03); without the tick the workflow's `npm publish` is refused. (Alternative: leave staging-only, change the workflow to `npm stage publish`, and approve each release with 2FA on npmjs.com.)
   - Configs cannot be edited: a typo means delete and recreate (which restarts the 48 h clock).
2. GitHub, repo Settings, Environments, New environment: environment `npm`. Optionally add a required reviewer and restrict deployment to tags `v*`.
3. After a release succeeded from CI: npm Settings, Publishing access, "Require two-factor authentication and disallow tokens", and revoke old automation tokens.

## 3. Cut every later release

1. `npm run release:bump <version>` (updates `package.json`, `package-lock.json`, and `integrations/claude-code/.claude-plugin/plugin.json`).
2. Add a `CHANGELOG.md` entry.
3. `npm run build && node scripts/release/check-versions.mjs v<version>` locally, commit, open a PR, merge to `main`.
4. GitHub, Releases, Draft a new release: create the tag `v<version>` on `main`, write the notes, **Publish release**. Tick "pre-release" for a prerelease: it publishes under the `next` dist-tag and does not move `v0`. For the Action Marketplace box see step 4.
5. The `release` workflow runs typecheck, tests, the version-agreement check, `npm pack --dry-run`, then `npm publish` (with automatic provenance), then moves the `v0` tag to the new release (stable releases only).
6. Verify: `npx trustbut@<version> --version` and the provenance badge on npmjs.com.

For the first CI release (e.g. 0.3.1) this must happen **within 48 h of creating the trusted publisher**.

## 4. GitHub Marketplace listing for the Action

One-time, by the maintainer, in the browser:

1. Enable 2FA on the GitHub account. The repo must be public with `action.yml` at the root (it is).
2. Accept the GitHub Marketplace Developer Agreement (prompted on the release page).
3. Draft a release, tick "Publish this Action to the GitHub Marketplace", set the action name to a unique value (`trustbut receipt`; the UI rejects taken names), choose a primary category (for example Code quality) and optionally a second one, then publish from the release page. Later releases keep the listing updated.

## 5. Claude Code marketplace

Nothing to publish: `.claude-plugin/marketplace.json` in this repo is the marketplace. Users run `/plugin marketplace add isAlmogK/trustbut`. Just keep the `plugin.json` version equal to `package.json` (the release check enforces it).

## 6. Rollback

- Never `npm unpublish` after 72 hours (and avoid it before: it breaks lockfiles). Instead run `npm deprecate trustbut@<version> "reason; use <good version>"`, then release a fixed patch version.
- If `latest` points at a bad version: ship the fix, or `npm dist-tag add trustbut@<good version> latest` (needs a normal 2FA login).
- A bad `v0` tag: re-point it manually to the last good release tag and push it (the workflow does the same on the next stable release).
