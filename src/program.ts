import { Argument, Command, InvalidArgumentError, Option } from 'commander';
import { runHook } from './commands/hook.js';
import { runVerify, type VerifyOptions } from './commands/verify.js';
import { AGENTS, type Agent } from './hook/protocols.js';
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

  program
    .command('hook')
    .description("Run from an agent's turn-end hook: verify the working tree and keep the agent working on a FAIL")
    .addArgument(new Argument('<agent>', 'the agent whose hook protocol to answer in').choices(AGENTS))
    .addHelpText(
      'after',
      '\nReads the hook input (JSON) on stdin. Exit codes follow the agent\'s protocol, not trustbut\'s:\n' +
        'only a FAIL within hook.maxRetries blocks; errors, timeouts and "nothing to verify" never do.\n' +
        'Set TRUSTBUT_SKIP=1 to skip. Settings: "hook" in .trustbut.json (enabled, mode, maxRetries, timeoutSec).',
    )
    .action(async (agent: Agent) => {
      const result = await runHook({ agent, stdin: await readStdin() });
      await write(process.stdout, result.stdout);
      await write(process.stderr, result.stderr);
      process.exitCode = result.exitCode;
      // The timed-out verify run would not stop: don't let it hold the agent past its own hook timeout.
      if (result.forceExit) process.exit(result.exitCode);
    });

  return program;
}

const STDIN_WAIT_MS = 5000;

/** All of stdin, or what arrived within a few seconds if the agent leaves it open; '' for a terminal. */
async function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stream.isTTY) return '';
  let text = '';
  await new Promise<void>((done) => {
    const timer = setTimeout(done, STDIN_WAIT_MS);
    const finish = () => {
      clearTimeout(timer);
      done();
    };
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => (text += chunk));
    stream.once('end', finish);
    stream.once('error', finish);
  });
  stream.destroy();
  return text;
}

/** Writes and waits until it is flushed; a closed pipe (the agent went away) is ignored. */
function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  if (!text) return Promise.resolve();
  return new Promise((done) => {
    stream.once('error', () => done());
    stream.write(text, () => done());
  });
}
