import { Command, InvalidArgumentError, Option } from 'commander';
import { runVerify, type VerifyOptions } from './commands/verify.js';
import { getRunner } from './runners/registry.js';
import { VERSION } from './version.js';

/** Validates --runner against the runner registry; commander reports the error and cli.ts exits 2. */
function parseRunner(name: string): string {
  try {
    return getRunner(name).name;
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('trustbut')
    .description('Verifiable receipts for code written by AI coding agents')
    .version(VERSION)
    // Throw instead of exiting so cli.ts can map usage errors to exit code 2. Set before
    // .command() so subcommands inherit it.
    .exitOverride();

  program
    .command('verify')
    .description('Produce a receipt for the changes between base and head')
    .option('-b, --base <ref>', 'base ref (compared from its merge-base with head; default: main/master)')
    .option('--head <ref>', 'head ref (default: HEAD)')
    .option('--working', 'verify uncommitted work: tracked edits plus untracked files (not with --head)')
    .addOption(new Option('--runner <name>', 'force a test runner').argParser(parseRunner))
    .option('--config <path>', 'config file to use instead of .trustbut.json at head')
    .option('--root <dir>', 'package folder to run the tests in, relative to the repo root (overrides config root)')
    .option('--quick', 'at head, rerun only new/changed test files')
    .option('--strict', 'exit 1 on WARN as well as FAIL')
    .option('--json', 'print the receipt as JSON')
    .option('--receipt-json <path>', 'also write the JSON receipt to this file (relative to the current directory)')
    .option('--receipt-md <path>', 'also write the Markdown receipt to this file (relative to the current directory)')
    .action(async (opts: VerifyOptions) => {
      try {
        const result = await runVerify(opts);
        process.stdout.write(result.output);
        for (const e of result.writeErrors) process.stderr.write(`trustbut: couldn't write receipt to ${e.path}: ${e.message}\n`);
        // 2 = a requested artifact was not written (the receipt was still printed).
        process.exitCode = result.writeErrors.length > 0 ? 2 : result.exitCode;
      } catch (err) {
        process.stderr.write(`trustbut: ${(err as Error).message}\n`);
        process.exitCode = 2;
      }
    });

  return program;
}
