#!/usr/bin/env node
import { CommanderError } from 'commander';
import { buildProgram } from './program.js';

// Exit codes: 0 PASS (or WARN without --strict), 1 FAIL, 2 usage/runtime error or a requested receipt file not written.
// `trustbut hook` answers in the agent's protocol instead; its usage errors (e.g. an unknown agent) exit 1,
// because all three agents read exit 2 as "block" and would keep the agent working on a misconfiguration.
const usageExit = process.argv.slice(2).find((a) => !a.startsWith('-')) === 'hook' ? 1 : 2;
try {
  await buildProgram().parseAsync(process.argv);
} catch (e) {
  // Commander has already printed its own message (or help/version, which exit 0).
  process.exitCode = e instanceof CommanderError && e.exitCode === 0 ? 0 : usageExit;
  if (!(e instanceof CommanderError)) process.stderr.write(`trustbut: ${(e as Error).message}\n`);
}
