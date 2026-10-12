import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInGroup } from '../process.js';
import { childEnv, runOutput } from './env.js';
import { parseJUnit } from './junit.js';
import type { Runner } from './types.js';

/** Quotes `s` as one POSIX shell word. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const LOOKS_LIKE_JUNIT = /^\s*(?:<\?xml|<testsuite)/;

/**
 * Generic runner for any toolchain that can produce JUnit XML: runs the configured shell command
 * (`sh -c`) in the package root. Chosen only through config (`runner: "command"` or `command`).
 */
export const command: Runner = {
  name: 'command',
  async detect() {
    return 0;
  },
  async run({ cwd, files, args = [], env, timeoutMs, command: cmd, junit }) {
    if (!cmd) throw new Error('The command runner needs a "command" in .trustbut.json');
    const script = [cmd.split('{files}').join((files ?? []).map(shellQuote).join(' ')), ...args.map(shellQuote)].join(' ');
    const junitPath = junit ? resolve(cwd, junit) : undefined;
    // A report committed or left over from an earlier run must not be read as this run's results.
    if (junitPath) await rm(junitPath, { force: true });
    const start = Date.now();
    const res = await runInGroup('sh', ['-c', script], { cwd, env: childEnv(env), timeoutMs });
    let xml = '';
    if (junitPath) xml = existsSync(junitPath) ? await readFile(junitPath, 'utf8') : '';
    else if (LOOKS_LIKE_JUNIT.test(res.stdout)) xml = res.stdout;
    return { exitCode: res.exitCode ?? 1, cases: xml ? parseJUnit(xml, cwd) : [], durationMs: Date.now() - start, output: runOutput(res) };
  },
};
