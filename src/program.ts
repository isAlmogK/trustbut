import { Command } from 'commander';
import { runVerify, type VerifyOptions } from './commands/verify.js';
import { VERSION } from './version.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('trustbut')
    .description('Verifiable receipts for code written by AI coding agents')
    .version(VERSION);

  program
    .command('verify')
    .description('Produce a receipt for the changes between base and head')
    .option('-b, --base <ref>', 'base ref (default: merge-base with main/master)')
    .option('--head <ref>', 'head ref', 'HEAD')
    .option('--runner <name>', 'force a test runner: vitest | pytest')
    .option('--quick', 'at head, rerun only new/changed test files')
    .option('--strict', 'exit 1 on WARN as well as FAIL')
    .option('--json', 'print the receipt as JSON')
    .action(async (opts: VerifyOptions) => {
      try {
        const result = await runVerify(opts);
        process.stdout.write(result.output);
        process.exitCode = result.exitCode;
      } catch (err) {
        process.stderr.write(`trustbut: ${(err as Error).message}\n`);
        process.exitCode = 2;
      }
    });

  return program;
}
