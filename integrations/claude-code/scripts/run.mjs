// Runs `trustbut hook <agent>` for the trustbut Claude Code plugin. No dependencies and Node >= 18
// syntax, so even an old default `node` can parse it. Finds trustbut (TRUSTBUT_BIN, else `trustbut` on
// PATH at least this plugin's version, else `npx trustbut@<plugin version>`), pipes stdin through and
// passes stdout, stderr and the exit code through unchanged. If trustbut can't be found or started,
// it says so and exits 0: the hook never blocks because of a missing tool.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN_NODE = 22;

export function pluginVersion() {
  return JSON.parse(readFileSync(join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
}

/** Compares the numeric x.y.z parts (a prerelease suffix is ignored). Returns <0, 0 or >0, or NaN if either is not a version. */
export function compareVersions(a, b) {
  const parse = (v) => /(\d+)\.(\d+)\.(\d+)/.exec(String(v))?.slice(1, 4).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export const nodeTooOld = (version = process.versions.node) => Number(String(version).split('.')[0]) < MIN_NODE;

/** `{ command, args }` to run trustbut with. `versionOf` is injectable for tests. */
export function resolveTrustbut(env = process.env, version = pluginVersion(), versionOf = pathVersion) {
  if (env.TRUSTBUT_BIN) return { command: env.TRUSTBUT_BIN, args: [] };
  const onPath = versionOf(env);
  if (onPath !== undefined && !(compareVersions(onPath, version) < 0)) return { command: 'trustbut', args: [] };
  return { command: 'npx', args: ['--yes', '--quiet', `trustbut@${version}`] };
}

/** The version `trustbut --version` prints, or undefined if there is no working `trustbut` on PATH. */
function pathVersion(env) {
  try {
    const r = spawnSync('trustbut', ['--version'], { env, encoding: 'utf8', timeout: 15000 });
    return r.status === 0 ? r.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function couldNotVerify(agent, reason) {
  const text = `trustbut couldn't verify: ${reason}. Install with: npm i -g trustbut`;
  // Claude Code reads systemMessage from stdout; Codex and Gemini would misread it, so it goes to stderr there.
  if (agent === 'claude') process.stdout.write(`${JSON.stringify({ systemMessage: text })}\n`);
  else process.stderr.write(`${text}\n`);
}

async function readStdin() {
  const chunks = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk);
  } catch {
    // no usable stdin: run with none
  }
  return Buffer.concat(chunks);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const agent = argv[0] ?? 'claude';
  if (!env.TRUSTBUT_BIN && nodeTooOld()) return couldNotVerify(agent, `trustbut needs Node ${MIN_NODE}+ (this is ${process.version})`);
  let target;
  try {
    target = resolveTrustbut(env);
  } catch (err) {
    return couldNotVerify(agent, err instanceof Error ? err.message : String(err));
  }
  const input = await readStdin();
  await new Promise((done) => {
    let child;
    try {
      child = spawn(target.command, [...target.args, 'hook', agent], { env, stdio: ['pipe', 'inherit', 'inherit'] });
    } catch (err) {
      couldNotVerify(agent, `could not start ${target.command}: ${err instanceof Error ? err.message : err}`);
      return done();
    }
    // Agent timeouts and Ctrl-C reach trustbut itself, which cleans up its worktrees.
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
    let failed = false;
    child.on('error', (err) => {
      failed = true;
      couldNotVerify(agent, err.code === 'ENOENT' ? `${target.command} not found` : `could not start ${target.command}: ${err.message}`);
      done();
    });
    child.on('close', (code) => {
      if (!failed && code !== null) process.exitCode = code; // not started, or killed by a signal: don't block
      done();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
