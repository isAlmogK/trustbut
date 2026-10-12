#!/usr/bin/env node
// Usage: npm run release:bump <version>   (e.g. 0.3.1) — sets package.json, package-lock.json and plugin.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: npm run release:bump <version>   (plain semver, no leading "v")');
  process.exit(2);
}
const root = resolve(fileURLToPath(import.meta.url), '../../..');
function edit(path, fn) {
  const file = resolve(root, path);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  fn(json);
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`updated ${path} -> ${version}`);
}
edit('package.json', (j) => { j.version = version; });
edit('package-lock.json', (j) => { j.version = version; if (j.packages?.['']) j.packages[''].version = version; });
{
  const path = 'integrations/claude-code/.claude-plugin/plugin.json';
  const file = resolve(root, path);
  const text = readFileSync(file, 'utf8');
  const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (next === text && !text.includes(`"${version}"`)) { console.error('no version field in ' + path); process.exit(1); }
  writeFileSync(file, next);
  console.log(`updated ${path} -> ${version}`);
}
console.log('Next: add a CHANGELOG.md entry, run "npm run build && node scripts/release/check-versions.mjs v' + version + '", commit, merge.');
