import { describe, expect, it } from 'vitest';
import { goTestHelpers } from '../src/go-helpers.js';
import type { ChangedFile } from '../src/types.js';
import { makeRepo } from './helpers/repo.js';

const changed = (path: string, status: ChangedFile['status'] = 'added'): ChangedFile => ({
  path, status, kind: path.endsWith('_test.go') ? 'test' : 'source', added: [], removed: [],
});
const GO_MOD = 'module example.com/fx\n\ngo 1.21\n';

describe('goTestHelpers', () => {
  it('picks changed Go files in test-support packages that only tests import', async () => {
    const { dir } = await makeRepo({
      'go.mod': GO_MOD,
      'sum.go': 'package fx\n',
      'internal/test/two.go': 'package test\n',
      'internal/testutil/three.go': 'package testutil\n',
      'pkg/testutils/fake/fake.go': 'package fake\n',
      'internal/testhelpers/h.go': 'package testhelpers\n',
      'x_test.go': 'package fx\n\nimport "example.com/fx/internal/test"\n',
    });
    const changes = ['internal/test/two.go', 'internal/testutil/three.go', 'pkg/testutils/fake/fake.go', 'internal/testhelpers/h.go'].map((p) => changed(p));
    expect(await goTestHelpers(changes, dir)).toEqual(changes.map((c) => c.path));
  });

  it('skips a package that non-test code imports, even through an alias', async () => {
    const { dir } = await makeRepo({
      'go.mod': GO_MOD,
      'internal/test/double.go': 'package test\n',
      'cmd/main.go': 'package main\n\nimport (\n\tt2 "example.com/fx/internal/test"\n)\n',
    });
    expect(await goTestHelpers([changed('internal/test/double.go')], dir)).toEqual([]);
  });

  it('still picks a package imported only by other test-support packages', async () => {
    const { dir } = await makeRepo({
      'go.mod': GO_MOD,
      'internal/testutil/a.go': 'package testutil\n',
      'internal/testutil/fake/b.go': 'package fake\n\nimport "example.com/fx/internal/testutil"\n',
    });
    expect(await goTestHelpers([changed('internal/testutil/a.go')], dir)).toEqual(['internal/testutil/a.go']);
  });

  it('skips a package whose own tests changed (it is the code under test)', async () => {
    const { dir } = await makeRepo({ 'go.mod': GO_MOD, 'internal/testutil/clock.go': 'package testutil\n', 'internal/testutil/clock_test.go': 'package testutil\n' });
    expect(await goTestHelpers([changed('internal/testutil/clock.go'), changed('internal/testutil/clock_test.go')], dir)).toEqual([]);
  });

  it('skips non-Go files, deleted files, production packages, and files outside a module', async () => {
    const { dir } = await makeRepo({
      'go.mod': GO_MOD,
      'internal/parser/p.go': 'package parser\n',
      'internal/testutil/notes.md': '# notes\n',
      'internal/contest/c.go': 'package contest\n',
    });
    const changes = [changed('internal/parser/p.go'), changed('internal/testutil/notes.md'), changed('internal/contest/c.go'), changed('internal/testutil/gone.go', 'deleted')];
    expect(await goTestHelpers(changes, dir)).toEqual([]);
    const { dir: noMod } = await makeRepo({ 'internal/testutil/a.go': 'package testutil\n' });
    expect(await goTestHelpers([changed('internal/testutil/a.go')], noMod)).toEqual([]);
  });

  it('uses the nearest go.mod for the import path', async () => {
    const { dir } = await makeRepo({
      'go.mod': GO_MOD,
      'svc/go.mod': 'module example.com/svc\n',
      'svc/internal/test/h.go': 'package test\n',
      'svc/main.go': 'package main\n\nimport "example.com/svc/internal/test"\n',
    });
    expect(await goTestHelpers([changed('svc/internal/test/h.go')], dir)).toEqual([]);
  });
});
