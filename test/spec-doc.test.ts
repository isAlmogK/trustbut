import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CORE_FINDINGS } from '../src/spec/catalog.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('spec/agent-receipt-v1.md', () => {
  const doc = read('spec/agent-receipt-v1.md');

  it('lists exactly the core finding ids, each with its default severity', () => {
    const rows = [...doc.matchAll(/^\| `([a-z-]+)` \| `(fail|warn|info)` \|/gm)].map((m) => [m[1], m[2]]);
    expect(Object.fromEntries(rows)).toEqual(CORE_FINDINGS);
    expect(rows).toHaveLength(Object.keys(CORE_FINDINGS).length);
  });

  it('documents every invalid example', () => {
    for (const name of readdirSync(new URL('../spec/examples/invalid/', import.meta.url))) expect(doc).toContain(`\`invalid/${name}\``);
  });

  it('names the schema id', () => {
    expect(doc).toContain('https://raw.githubusercontent.com/isAlmogK/trustbut/main/spec/agent-receipt-v1.schema.json');
  });
});

describe('packaging', () => {
  it('ships spec/ in the npm package', () => {
    expect((JSON.parse(read('package.json')) as { files: string[] }).files).toContain('spec');
  });
});
