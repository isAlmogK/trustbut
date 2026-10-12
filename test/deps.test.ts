import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDepsInstalled } from '../src/deps.js';

const dirs: string[] = [];
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'trustbut-deps-'));
  dirs.push(dir);
  for (const [p, c] of Object.entries(files)) {
    await mkdir(join(dir, p, '..'), { recursive: true });
    await writeFile(join(dir, p), c);
  }
  return dir;
}
const pkg = (o: object) => JSON.stringify(o);
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('checkDepsInstalled', () => {
  it('names declared dependencies missing from node_modules', async () => {
    const dir = await repo({
      'package.json': pkg({ dependencies: { 'flag-icons': '^7', a: '1' }, devDependencies: { '@s/x': '1', ws: 'workspace:*', l: 'link:../l', f: 'file:../f' }, optionalDependencies: { opt: '1' } }),
      'node_modules/a/package.json': '{}',
    });
    const f = checkDepsInstalled(dir, '.', 'vitest');
    expect(f?.id).toBe('deps-not-installed');
    expect(f?.severity).toBe('warn');
    expect(f?.title).toContain("Declared dependencies aren't installed: @s/x, flag-icons;");
    expect(f?.title).toContain("run your package manager's install");
    expect(f?.title).not.toMatch(/ws|opt/);
  });

  it('passes when installed, including scoped and hoisted packages', async () => {
    const dir = await repo({
      'package.json': pkg({ workspaces: ['web'] }),
      'web/package.json': pkg({ dependencies: { '@s/x': '1', hoisted: '1' } }),
      'web/node_modules/@s/x/package.json': '{}',
      'node_modules/hoisted/package.json': '{}',
    });
    expect(checkDepsInstalled(dir, 'web', 'vitest')).toBeUndefined();
  });

  it('truncates to 5 names and "and N more"', async () => {
    const deps = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`p${i}`, '1']));
    const dir = await repo({ 'package.json': pkg({ dependencies: deps }), 'node_modules/.keep': '' });
    expect(checkDepsInstalled(dir, '.', 'jest')?.title).toContain('p0, p1, p2, p3, p4 and 3 more;');
  });

  it('says node_modules is missing when there is none', async () => {
    const dir = await repo({ 'package.json': pkg({ dependencies: { a: '1' } }) });
    expect(checkDepsInstalled(dir, '.', 'vitest')?.title).toContain('node_modules is missing');
  });

  it('skips Yarn PnP projects', async () => {
    const files = { 'package.json': pkg({ dependencies: { a: '1' } }) };
    expect(checkDepsInstalled(await repo({ ...files, '.pnp.cjs': '' }), '.', 'vitest')).toBeUndefined();
    expect(checkDepsInstalled(await repo({ ...files, '.yarnrc.yml': 'nodeLinker: pnp\n' }), '.', 'vitest')).toBeUndefined();
    const hoisted = await repo({ ...files, '.pnp.cjs': '', 'web/package.json': pkg({ dependencies: { a: '1' } }) });
    expect(checkDepsInstalled(hoisted, 'web', 'vitest')).toBeUndefined();
    expect(checkDepsInstalled(await repo({ ...files, '.yarnrc.yml': 'nodeLinker: node-modules\n' }), '.', 'vitest')?.id).toBe('deps-not-installed');
  });

  it('tolerates malformed dependency fields', async () => {
    expect(checkDepsInstalled(await repo({ 'package.json': pkg({ dependencies: ['a'], devDependencies: 'x' }) }), '.', 'vitest')).toBeUndefined();
  });

  it('ignores non-JS runners, no package.json and no declared deps', async () => {
    const dir = await repo({ 'package.json': pkg({ dependencies: { a: '1' } }) });
    expect(checkDepsInstalled(dir, '.', 'pytest')).toBeUndefined();
    // The generic command runner may run anything (make, a shell script); a package.json is not a reason to warn.
    expect(checkDepsInstalled(dir, '.', 'command')).toBeUndefined();
    expect(checkDepsInstalled(await repo({ 'x.txt': '' }), '.', 'vitest')).toBeUndefined();
    expect(checkDepsInstalled(await repo({ 'package.json': pkg({}) }), '.', 'vitest')).toBeUndefined();
  });
});
