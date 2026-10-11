#!/usr/bin/env node
import { CommanderError } from 'commander';
import { buildProgram } from './program.js';

// Exit codes: 0 PASS (or WARN without --strict), 1 FAIL, 2 usage or runtime error.
try {
  await buildProgram().parseAsync(process.argv);
} catch (e) {
  // Commander has already printed its own message (or help/version, which exit 0).
  process.exitCode = e instanceof CommanderError && e.exitCode === 0 ? 0 : 2;
  if (!(e instanceof CommanderError)) process.stderr.write(`trustbut: ${(e as Error).message}\n`);
}
