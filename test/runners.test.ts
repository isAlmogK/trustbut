import { execaSync } from 'execa';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectRunner } from '../src/runners/detect.js';
import { parseJUnit } from '../src/runners/junit.js';
import { pytest } from '../src/runners/pytest.js';
import { vitest } from '../src/runners/vitest.js';
import { linkNodeModules, makeRepo } from './helpers/repo.js';

const hasPytest = execaSync('python3', ['-m', 'pytest', '--version'], { reject: false }).exitCode === 0;

describe('parseJUnit', () => {
  it('parses vitest-style output', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3">
  <testsuite name="test/sum.test.ts" tests="3">
    <testcase classname="test/sum.test.ts" name="adds" time="0.001"></testcase>
    <testcase classname="test/sum.test.ts" name="math &gt; subtracts" time="0.001">
      <failure message="expected 1 to be 2" type="AssertionError">trace</failure>
    </testcase>
    <testcase classname="test/sum.test.ts" name="later" time="0"><skipped/></testcase>
  </testsuite>
</testsuites>`;
    expect(parseJUnit(xml)).toEqual([
      { id: 'test/sum.test.ts::adds', file: 'test/sum.test.ts', name: 'adds', outcome: 'pass' },
      { id: 'test/sum.test.ts::math > subtracts', file: 'test/sum.test.ts', name: 'math > subtracts', outcome: 'fail' },
      { id: 'test/sum.test.ts::later', file: 'test/sum.test.ts', name: 'later', outcome: 'skip' },
    ]);
  });

  it('parses pytest-style output', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" tests="2">
<testcase classname="tests.test_sum" name="test_adds" time="0.001" />
<testcase classname="tests.test_sum" name="test_err" time="0.001"><error message="boom">x</error></testcase>
</testsuite></testsuites>`;
    expect(parseJUnit(xml).map((c) => [c.id, c.outcome])).toEqual([
      ['tests.test_sum::test_adds', 'pass'],
      ['tests.test_sum::test_err', 'error'],
    ]);
  });
});

describe('detectRunner', () => {
  it('detects vitest, pytest, or nothing', async () => {
    const js = await mkdtemp(join(tmpdir(), 'ar-detect-'));
    await writeFile(join(js, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^3' } }));
    expect((await detectRunner(js))?.name).toBe('vitest');

    const py = await mkdtemp(join(tmpdir(), 'ar-detect-'));
    await writeFile(join(py, 'pyproject.toml'), '[tool.pytest.ini_options]\naddopts = "-q"\n');
    expect((await detectRunner(py))?.name).toBe('pytest');

    const none = await mkdtemp(join(tmpdir(), 'ar-detect-'));
    expect(await detectRunner(none)).toBeNull();
  });
});

describe('vitest runner', () => {
  it('runs selected files and reports per-test outcomes', async () => {
    const { dir } = await makeRepo({
      '.gitignore': 'node_modules\n',
      'package.json': JSON.stringify({ name: 'fx', private: true, type: 'module', devDependencies: { vitest: '*' } }),
      'test/a.test.js': "import { it, expect } from 'vitest';\nit('passes', () => expect(1).toBe(1));\nit('fails', () => expect(1).toBe(2));\n",
      'test/b.test.js': "import { it } from 'vitest';\nit('other', () => {});\n",
    });
    await linkNodeModules(dir);
    const result = await vitest.run({ cwd: dir, files: ['test/a.test.js'] });
    expect(result.exitCode).not.toBe(0);
    expect(result.cases.map((c) => [c.name, c.outcome])).toEqual([
      ['passes', 'pass'],
      ['fails', 'fail'],
    ]);
  });
});

describe.skipIf(!hasPytest)('pytest runner', () => {
  it('runs selected files and reports per-test outcomes', async () => {
    const { dir } = await makeRepo({
      'pytest.ini': '[pytest]\n',
      'tests/test_a.py': 'def test_ok():\n    assert 1 == 1\n\ndef test_bad():\n    assert 1 == 2\n',
    });
    const result = await pytest.run({ cwd: dir, files: ['tests/test_a.py'] });
    expect(result.cases.map((c) => [c.name, c.outcome])).toEqual([
      ['test_ok', 'pass'],
      ['test_bad', 'fail'],
    ]);
  });
});
