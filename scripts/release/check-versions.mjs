#!/usr/bin/env node
// Release guard: the git tag (vX.Y.Z), package.json, `trustbut --version` and the Claude Code plugin.json
// must all name the same version. Dependency-free so it runs before/without a build of anything else.
// Usage: node scripts/release/check-versions.mjs <tag>      (e.g. v0.3.0; defaults to $TAG)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Pure check. Returns a list of human-readable problems (empty = all agree). */
export function checkVersions({ tag, pkg, cli, plugin }) {
  const problems = [];
  if (!/^v/.test(tag ?? '')) problems.push(`tag "${tag}" must look like vX.Y.Z`);
  const fromTag = (tag ?? '').replace(/^v/, '');
  if (!SEMVER.test(fromTag)) problems.push(`tag "${tag}" is not a valid semver version`);
  for (const [name, value] of [['package.json', pkg], ['trustbut --version', cli], ['plugin.json', plugin]]) {
    if (value !== fromTag) problems.push(`${name} is "${value}" but the tag says "${fromTag}"`);
  }
  return problems;
}

export function readVersions(root, tag) {
  const json = (p) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));
  return {
    tag,
    pkg: json('package.json').version,
    cli: execFileSync(process.execPath, [resolve(root, 'dist/cli.js'), '--version'], { encoding: 'utf8' }).trim(),
    plugin: json('integrations/claude-code/.claude-plugin/plugin.json').version,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2] ?? process.env.TAG;
  if (!tag) {
    console.error('::error::usage: check-versions.mjs <tag>   (e.g. v0.3.0)');
    process.exit(2);
  }
  const root = resolve(fileURLToPath(import.meta.url), '../../..');
  let versions;
  try {
    versions = readVersions(root, tag);
  } catch (e) {
    console.error(`::error::could not read versions (did you run "npm run build"?): ${e.message}`);
    process.exit(2);
  }
  const problems = checkVersions(versions);
  if (problems.length) {
    console.error(`::error::version mismatch (tag=${versions.tag} package.json=${versions.pkg} cli=${versions.cli} plugin.json=${versions.plugin})`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`versions agree: ${tag} = package.json = trustbut --version = plugin.json`);
}
