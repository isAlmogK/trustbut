import { writeSync } from 'node:fs';
import { Argument, Command, InvalidArgumentError, Option } from 'commander';
import { INIT_AGENTS, runInit, type InitAgent } from './init/index.js';
import { runHook } from './commands/hook.js';
import { runValidate } from './commands/validate.js';
import { runVerify, type VerifyOptions } from './commands/verify.js';
import { AGENTS, respond, type Agent } from './hook/protocols.js';
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
    .option('--json', 'print the receipt as JSON (agent receipt v1, see spec/agent-receipt-v1.md)')
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
    .command('validate')
    .description('Check an agent receipt (JSON) against the agent receipts v1 spec')
    .argument('[file]', 'the receipt file; "-" or omitted reads stdin')
    .option('--json', 'print the result as JSON')
    .action(async (file: string | undefined, opts: { json?: boolean }) => {
      // Hooks may hold stdin open, so `hook` times out; a pipe into validate ends when its producer exits.
      const result = await runValidate({ file, json: opts.json, readStdin: () => readStdin(process.stdin, Infinity) });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    });

  program
    .command('init')
    .description("Install trustbut's turn-end hook for an agent (merges into its config; safe to rerun)")
    .addArgument(new Argument('<agent>', 'the agent to set up').choices(INIT_AGENTS))
    .option('--dry-run', 'print what would change; write nothing')
    .option('--user', 'set up the user-level config instead of the project')
    .action(async (agent: InitAgent, opts: { dryRun?: boolean; user?: boolean }) => {
      try {
        process.stdout.write(await runInit({ agent, ...opts }));
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
        'Set TRUSTBUT_SKIP=1 to skip. Settings: "hook" in .trustbut.json (enabled, mode, maxRetries, timeoutSec, base).',
    )
    .action(async (agent: Agent) => {
      // An agent that kills the hook (its own timeout, Ctrl-C) gets the test processes stopped and the
      // worktrees removed first: abort, give cleanup up to 2 s, then exit without blocking.
      const ctl = new AbortController();
      const onSignal = (signal: NodeJS.Signals) => {
        if (ctl.signal.aborted) return;
        ctl.abort(new Error(`interrupted by ${signal}`));
        setTimeout(() => {
          try {
            writeSync(1, respond(agent, { kind: 'allow', message: `trustbut couldn't verify: interrupted by ${signal}` }).stdout);
          } catch {
            // stdout already closed
          }
          process.exit(0);
        }, INTERRUPT_GRACE_MS).unref();
      };
      process.on('SIGTERM', onSignal);
      process.on('SIGINT', onSignal);
      try {
        const result = await runHook({ agent, stdin: await readStdin(), signal: ctl.signal });
        await write(process.stdout, result.stdout);
        await write(process.stderr, result.stderr);
        process.exitCode = result.exitCode;
        // A timed-out verify run that would not stop, or an interrupt: don't linger.
        if (result.forceExit || ctl.signal.aborted) process.exit(result.exitCode);
      } finally {
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
      }
    });

  return program;
}

const STDIN_WAIT_MS = 5000;
const INTERRUPT_GRACE_MS = 2000;

/** All of stdin, or what arrived within waitMs if the agent leaves it open (Infinity: wait for the end); '' for a terminal. */
async function readStdin(stream: NodeJS.ReadStream = process.stdin, waitMs: number = STDIN_WAIT_MS): Promise<string> {
  if (stream.isTTY) return '';
  let text = '';
  await new Promise<void>((done) => {
    const timer = Number.isFinite(waitMs) ? setTimeout(done, waitMs) : undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
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
