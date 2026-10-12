import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { runInGroup } from '../process.js';
import type { TestCaseResult } from '../types.js';
import { addCase } from './cases.js';
import { childEnv, runOutput } from './env.js';
import type { ReadHead, Runner } from './types.js';

const DOC_TESTS = 'doc-tests';

/**
 * The module path of a source file within its crate: `src/lib.rs` and `src/main.rs` are the crate
 * root (''), `src/foo/bar.rs` and `src/foo/bar/mod.rs` are `foo::bar`. Undefined for files outside `src/`.
 */
export function modulePathOf(file: string): string | undefined {
  const m = /(?:^|\/)src\/(.+)\.rs$/.exec(file.split(sep).join('/'));
  if (!m) return undefined;
  const parts = m[1]!.split('/');
  if (parts[0] === 'bin') return '';
  const last = parts[parts.length - 1];
  if (last === 'lib' || last === 'main') return parts.length === 1 ? '' : undefined;
  if (last === 'mod') parts.pop();
  return parts.join('::');
}

/** The integration-test binary a `tests/` file belongs to (`tests/x.rs` and `tests/x/main.rs` -> `x`). */
export function testBinaryOf(file: string): string | undefined {
  const m = /(?:^|\/)tests\/([^/]+?)(?:\.rs|\/.+)$/.exec(file.split(sep).join('/'));
  return m?.[1];
}

/** Test functions declared in a Rust source file. */
export function declaredFns(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/\bfn\s+(r#)?([A-Za-z_]\w*)/g)) names.add(m[2]!);
  return names;
}

const OUTCOMES: Record<string, TestCaseResult['outcome']> = { ok: 'pass', FAILED: 'fail', ignored: 'skip' };

interface Header {
  file: string;
  target: string;
}

/** The target name of a test executable path: `target/debug/deps/fx_core-0123abcd` -> `fx_core`. */
const targetOf = (exe: string): string => (exe.split('/').pop() ?? exe).replace(/-[0-9a-f]{8,}(\.exe)?$/, '');

/** `Running <entry> (<exe>)` / `Doc-tests <crate>` headers, in order. */
function parseHeaders(text: string): Header[] {
  const out: Header[] = [];
  for (const line of text.split('\n')) {
    const run = /^\s+Running (?:unittests )?(.+?) \((.+)\)\s*$/.exec(line);
    if (run) out.push({ file: run[1]!, target: targetOf(run[2]!) });
    else {
      const doc = /^\s+Doc-tests\s+(\S+)/.exec(line);
      if (doc) out.push({ file: DOC_TESTS, target: doc[1]!.replace(/-/g, '_') });
    }
  }
  return out;
}

/** Libtest names minus the ` - should panic` marker, and the test's own short name. */
function libtestName(raw: string): { name: string; leaf: string } {
  const name = raw.replace(/ - should panic$/, '');
  const doc = /^.+? - (.+?) \(line \d+\)$/.exec(name);
  const leaf = doc ? doc[1]! : (name.split('::').pop() ?? name);
  return { name, leaf };
}

/**
 * Parses `cargo test` output. Cargo prints the `Running <entry> (<exe>)` / `Doc-tests` headers on
 * stderr and the libtest blocks (`running N tests` ... `test result:`) on stdout, so the two streams
 * are read separately and paired by position (each binary prints exactly one `running` block).
 * Headers found on stdout are used when stderr has none (combined captures). The case's `file` is the
 * printed entry point (`src/lib.rs`, `tests/api.rs`); ids also carry the target name so same-named
 * tests in different binaries or workspace members stay distinct.
 */
export function parseCargoTest(stdout: string, stderr = ''): TestCaseResult[] {
  let headers = parseHeaders(stderr);
  if (headers.length === 0) headers = parseHeaders(stdout);
  const blocks: { name: string; outcome: TestCaseResult['outcome'] }[][] = [];
  for (const line of stdout.split('\n')) {
    if (/^running \d+ tests?\s*$/.test(line)) {
      blocks.push([]);
      continue;
    }
    const t = /^test (.+?) \.\.\. (ok|FAILED|ignored)\b/.exec(line);
    if (!t) continue;
    if (blocks.length === 0) blocks.push([]);
    blocks[blocks.length - 1]!.push({ name: t[1]!, outcome: OUTCOMES[t[2]!]! });
  }
  const cases: TestCaseResult[] = [];
  const index = new Map<string, number>();
  blocks.forEach((block, i) => {
    const { file, target } = headers[i] ?? { file: '', target: '' };
    for (const t of block) {
      const { name, leaf } = libtestName(t.name);
      addCase(cases, index, { id: `${target ? `${target}:` : ''}${file}::${name}`, file, name, outcome: t.outcome, leaf });
    }
  });
  return cases;
}

interface NextestEvent {
  type?: string;
  event?: string;
  name?: string;
}

/**
 * The entry-point file and target of the test binary a nextest binary id names: `crate` (lib),
 * `crate::bin/name` (binary) or `crate::name` (integration test).
 */
function nextestBinary(binaryId: string): { file: string; target: string } {
  const parts = binaryId.split('::');
  if (parts.length < 2) return { file: 'src/lib.rs', target: (parts[0] ?? '') || 'lib' };
  const second = parts.slice(1).join('::');
  return second.startsWith('bin/') ? { file: 'src/main.rs', target: second.slice(4) } : { file: `tests/${second}.rs`, target: second };
}

/** Parses `cargo nextest run --message-format libtest-json-plus` stdout (one JSON event per line). */
export function parseNextestJson(output: string): TestCaseResult[] {
  const cases: TestCaseResult[] = [];
  const index = new Map<string, number>();
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev: NextestEvent;
    try {
      ev = JSON.parse(line) as NextestEvent;
    } catch {
      continue;
    }
    if (ev.type !== 'test' || !ev.name) continue;
    const outcome = ev.event === 'ok' ? 'pass' : ev.event === 'failed' ? 'fail' : ev.event === 'ignored' ? 'skip' : undefined;
    if (!outcome) continue;
    const dollar = ev.name.indexOf('$');
    const binaryId = dollar < 0 ? '' : ev.name.slice(0, dollar);
    const { name, leaf } = libtestName(dollar < 0 ? ev.name : ev.name.slice(dollar + 1));
    const { file } = nextestBinary(binaryId);
    addCase(cases, index, { id: `${binaryId}:${file}::${name}`, file, name, outcome, leaf });
  }
  return cases;
}

/** The test binary a changed file is the entry point of (`tests/x.rs`, `tests/x/main.rs`); other files are not binaries. */
function entryBinary(file: string): string | undefined {
  return /^(?!(?:.*\/)?src\/)(?:.*\/)?tests\/(?:([^/]+)\.rs|([^/]+)\/main\.rs)$/.exec(file)?.slice(1).find(Boolean);
}

/** The `--test <binary>` selectors for `files`, or undefined when any file is not a test-binary entry point (helpers, `src/`): then everything runs. */
export function testSelectors(files: string[]): string[] | undefined {
  const bins = new Set<string>();
  for (const f of files) {
    const bin = entryBinary(f);
    if (!bin) return undefined;
    bins.add(bin);
  }
  return [...bins].flatMap((b) => ['--test', b]);
}

/** The `cargo test` command line (without the executable). */
export function cargoTestArgs(args: string[], selectors: string[] = []): string[] {
  return ['test', '--no-fail-fast', ...args, ...selectors, '--', '--test-threads=1'];
}

/** The `cargo nextest` command line (without the executable). */
export function nextestArgs(args: string[], selectors: string[] = []): string[] {
  return ['nextest', 'run', '--no-fail-fast', '--message-format', 'libtest-json-plus', ...args, ...selectors];
}

async function hasNextest(cwd: string, env: Record<string, string>): Promise<boolean> {
  const res = await runInGroup('cargo', ['nextest', '--version'], { cwd, env, timeoutMs: 30_000 });
  return res.exitCode === 0;
}

export const cargo: Runner = {
  name: 'cargo',
  async detect(root) {
    try {
      return existsSync(join(root, 'Cargo.toml')) ? 10 : 0;
    } catch {
      return 0;
    }
  },
  async run({ cwd, files, args = [], env: extraEnv, timeoutMs }) {
    const start = Date.now();
    const env = childEnv({ CARGO_TERM_COLOR: 'never', ...extraEnv });
    let selectors: string[] | undefined = [];
    if (files) {
      selectors = testSelectors(files.map((f) => f.split(sep).join('/')));
      selectors ??= []; // a changed source file: unit tests live in it, run everything
    }
    const nextest = await hasNextest(cwd, env);
    const res = nextest
      ? await runInGroup('cargo', nextestArgs(args, selectors), { cwd, env: { ...env, NEXTEST_EXPERIMENTAL_LIBTEST_JSON: '1' }, timeoutMs })
      : await runInGroup('cargo', cargoTestArgs(args, selectors), { cwd, env, timeoutMs });
    const cases = nextest ? parseNextestJson(res.stdout) : parseCargoTest(res.stdout, res.stderr);
    let exitCode = res.exitCode ?? 1;
    // nextest exits 4 when there is nothing to run
    if (nextest && exitCode === 4 && cases.length === 0) exitCode = 0;
    // Compile errors and crashes produce no failing test line: report one error case so the run is not read as "no tests".
    if (exitCode !== 0 && !cases.some((c) => c.outcome === 'fail' || c.outcome === 'error')) {
      cases.push({ id: '[cargo]::[build]', file: '[cargo]', name: '[build or run failed]', outcome: 'error' });
    }
    return { exitCode, cases, durationMs: Date.now() - start, output: runOutput(res) };
  },
  casesInFile(c, file, readHead: ReadHead) {
    const f = file.split(sep).join('/');
    const bin = testBinaryOf(f);
    if (bin !== undefined) return testBinaryOf(c.file) === bin;
    const mod = modulePathOf(f);
    if (mod === undefined || c.file === DOC_TESTS || testBinaryOf(c.file) !== undefined) return false;
    const segments = c.name.split('::');
    const leaf = segments[segments.length - 1]!;
    if (mod !== '' && !c.name.startsWith(`${mod}::`)) return false;
    return declaredFns(readHead(f)).has(leaf);
  },
};

