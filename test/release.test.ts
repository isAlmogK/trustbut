import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs without types
import { checkVersions } from '../scripts/release/check-versions.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p: string) => readFile(join(ROOT, p), 'utf8');

describe('release: check-versions', () => {
  const ok = { tag: 'v0.3.0', pkg: '0.3.0', cli: '0.3.0', plugin: '0.3.0' };

  it('passes when everything agrees', () => {
    expect(checkVersions(ok)).toEqual([]);
    expect(checkVersions({ tag: 'v1.0.0-rc.1', pkg: '1.0.0-rc.1', cli: '1.0.0-rc.1', plugin: '1.0.0-rc.1' })).toEqual([]);
  });

  it.each([
    ['package.json', { pkg: '0.3.1' }],
    ['trustbut --version', { cli: '0.0.1' }],
    ['plugin.json', { plugin: '0.2.0' }],
  ])('names %s when it disagrees', (name, patch) => {
    const problems = checkVersions({ ...ok, ...patch });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(name);
  });

  it('rejects a tag without the v prefix or that is not semver', () => {
    expect(checkVersions({ ...ok, tag: '0.3.0' }).join()).toContain('vX.Y.Z');
    expect(checkVersions({ ...ok, tag: 'vnext' }).join()).toContain('not a valid semver');
  });

  it('agrees on the repository right now (package.json and plugin.json)', async () => {
    const pkg = JSON.parse(await read('package.json')).version;
    const plugin = JSON.parse(await read('integrations/claude-code/.claude-plugin/plugin.json')).version;
    expect(checkVersions({ tag: `v${pkg}`, pkg, cli: pkg, plugin })).toEqual([]);
  });
});

describe('release: release.yml', () => {
  it('is least-privilege, tokenless, and uses trusted publishing', async () => {
    const y = await read('.github/workflows/release.yml');
    expect(y).toMatch(/on:\s+release:\s+types: \[published\]/);
    expect(y).toMatch(/^permissions: \{\}/m);
    expect(y).toMatch(/environment: npm\b/);
    expect(y).toMatch(/runs-on: ubuntu-latest/);
    expect(y).not.toMatch(/self-hosted/);
    const npmJob = y.slice(y.indexOf('  npm:'), y.indexOf('  major-tag:'));
    expect(npmJob).toMatch(/contents: read/);
    expect(npmJob).toMatch(/id-token: write/);
    expect(npmJob).not.toMatch(/contents: write/);
    expect(npmJob).toMatch(/persist-credentials: false/);
    expect(y).toMatch(/node-version: 24/);
    expect(y).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
    expect(y).not.toMatch(/--provenance/);
  });

  it('installs npm 11 before publishing, and publishes prereleases under next', async () => {
    const y = await read('.github/workflows/release.yml');
    const install = y.indexOf('npm install -g npm@11');
    expect(install).toBeGreaterThan(-1);
    expect(y.indexOf('npm publish')).toBeGreaterThan(install);
    expect(y).toMatch(/npm publish --tag next/);
    expect(y).toMatch(/TRUSTBUT_NO_TOOLCHAIN_E2E: '1'/);
  });

  it('skips publishing when the version already exists on npm, but still lets major-tag run', async () => {
    const y = await read('.github/workflows/release.yml');
    expect(y).toMatch(/npm view "trustbut@\$\{VERSION#v\}" version/);
    expect((y.match(/steps\.exists\.outputs\.published != 'true'/g) ?? []).length).toBe(2);
    expect(y).toMatch(/needs: npm/);
    expect(y).toMatch(/fetch-depth: 0/);
    expect(y).toMatch(/sort -V/);
    expect(y).toMatch(/npm 11\.5\.1|< 11\.5\.1/);
  });

  it('runs check-versions with the release tag, before publishing', async () => {
    const y = await read('.github/workflows/release.yml');
    expect(y).toMatch(/node scripts\/release\/check-versions\.mjs "\$TAG"/);
    expect(y).toMatch(/TAG: \$\{\{ github\.event\.release\.tag_name \}\}/);
    expect(y.indexOf('check-versions.mjs')).toBeLessThan(y.indexOf('npm publish'));
  });

  it('moves the major tag only for stable releases, with contents: write only there', async () => {
    const y = await read('.github/workflows/release.yml');
    const job = y.slice(y.indexOf('  major-tag:'));
    expect(job).toMatch(/needs: npm/);
    expect(job).toMatch(/!github\.event\.release\.prerelease/);
    expect(job).toMatch(/contents: write/);
    expect((y.match(/contents: write/g) ?? []).length).toBe(1);
  });

  it('RELEASING.md documents the same minimums and the key steps', async () => {
    const doc = await read('RELEASING.md');
    const y = await read('.github/workflows/release.yml');
    expect(doc).toContain('npm >= 11.5.1');
    expect(doc).toContain('Node >= 22.14');
    expect(y).toContain('npm@11');
    for (const s of ['release.yml', 'environment `npm`', 'npm publish --access public', '48 h', 'npm deprecate', 'trustbut receipt']) {
      expect(doc).toContain(s);
    }
  });
});
