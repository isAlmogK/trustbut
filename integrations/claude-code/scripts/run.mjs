// Runs `trustbut hook <agent>` for the trustbut Claude Code plugin. No dependencies and Node >= 18
// syntax, so even an old default `node` can parse it. Finds trustbut (TRUSTBUT_BIN, else `trustbut` on
// PATH at least this plugin's version, else `npx trustbut@<plugin version>`), pipes stdin through and
// passes stdout, stderr and the exit code through. If trustbut can't be found or started, or answers
// with something that isn't a trustbut answer (e.g. a usage error's exit 2, which agents read as "block"),
// it says so and exits 0: the hook never blocks because of a missing or wrong tool.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN_NODE = 22;
const STARTED = Date.now();
/**
 * The agent allows the hook 600 s; what is left after our own start-up goes to trustbut as its time budget.
 * TRUSTBUT_HOOK_BUDGET_SEC overrides the 570 s starting point (for an agent with a shorter timeout).
 */
export const budgetSec = (elapsedMs = Date.now() - STARTED, env = process.env) => {
  const base = Number(env.TRUSTBUT_HOOK_BUDGET_SEC);
  return Math.max(30, Math.floor((Number.isFinite(base) && base > 0 ? base : 570) - elapsedMs / 1000));
};

/** The plugin's version; a copy made by `trustbut init` has no plugin.json and reads trustbut-run.json next to it. */
export function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  } catch (err) {
    try {
      return JSON.parse(readFileSync(join(HERE, 'trustbut-run.json'), 'utf8')).version;
    } catch {
      throw err;
    }
  }
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const parseVersion = (v) => {
  for (const token of String(v).trim().split(/\s+/)) {
    const m = SEMVER.exec(token);
    if (m) return { nums: m.slice(1, 4).map(Number), pre: m[4] === undefined ? undefined : m[4].split('.') };
  }
  return undefined;
};

/** Semver order (a prerelease is lower than its release). Returns <0, 0 or >0, or NaN if either is not a version. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export const nodeTooOld = (version = process.versions.node) => Number(String(version).split('.')[0]) < MIN_NODE;

/** npm settings for the npx fallback: no update notice or npm log lines in the hook output. */
const NPX_ENV = { npm_config_update_notifier: 'false', npm_config_loglevel: 'error' };

/** `{ command, args, env? }` to run trustbut with (`env`: extra variables). `versionOf` is injectable for tests. */
export function resolveTrustbut(env = process.env, version = pluginVersion(), versionOf = pathVersion) {
  if (env.TRUSTBUT_BIN) return { command: env.TRUSTBUT_BIN, args: [] };
  const onPath = versionOf(env);
  if (onPath !== undefined && !(compareVersions(onPath, version) < 0)) return { command: 'trustbut', args: [] };
  // The version is pinned, so a cached copy is the right one: don't ask the registry each time.
  return { command: 'npx', args: ['--yes', '--quiet', '--prefer-offline', `trustbut@${version}`], env: { ...NPX_ENV } };
}

/** The first line trustbut writes to stderr when it sends a FAIL back (renderForAgent in src/render.ts). */
const FAIL_HEADER = 'trustbut verdict: FAIL';

function findOnPath(env) {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, 'trustbut');
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** How long the `trustbut --version` probe may take (TRUSTBUT_VERSION_PROBE_MS, default 10 s; a cold first start can be slow). */
const probeMs = (env) => (Number(env.TRUSTBUT_VERSION_PROBE_MS) > 0 ? Number(env.TRUSTBUT_VERSION_PROBE_MS) : 10000);

/**
 * The version `trustbut --version` prints, or undefined if there is no working `trustbut` on PATH.
 * Cached per binary path and mtime in CLAUDE_PLUGIN_DATA (else the temp dir), so Stop doesn't probe every time.
 */
export function pathVersion(env) {
  const file = findOnPath(env);
  if (!file) return undefined;
  const cacheFile = join(env.CLAUDE_PLUGIN_DATA || tmpdir(), 'trustbut-version-cache.json');
  let key;
  let cache = {};
  try {
    key = `${file}:${statSync(file).mtimeMs}`;
    cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (typeof cache[key] === 'string') return cache[key];
  } catch {
    // no cache yet
  }
  try {
    const r = spawnSync(file, ['--version'], { env, encoding: 'utf8', timeout: probeMs(env) });
    if (r.status !== 0) return undefined;
    const version = r.stdout.trim();
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ [key]: version }));
    } catch {
      // cache is best effort
    }
    return version;
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
  // Claude's stdout is validated; OpenCode's carries the feedback (exit 1), which must not look like a crash.
  const captured = agent === 'claude' || agent === 'opencode';
  const childEnv = { ...env, ...(target.env || {}), TRUSTBUT_HOOK_TIMEOUT_SEC: String(budgetSec(undefined, env)) };
  await new Promise((done) => {
    let child;
    try {
      child = spawn(target.command, [...target.args, 'hook', agent], { env: childEnv, stdio: ['pipe', captured ? 'pipe' : 'inherit', 'pipe'] });
    } catch (err) {
      couldNotVerify(agent, `could not start ${target.command}: ${err instanceof Error ? err.message : err}`);
      return done();
    }
    // Agent timeouts and Ctrl-C reach trustbut itself, which cleans up its worktrees.
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
    let failed = false;
    let out = '';
    // Buffered: whether stderr is a FAIL's feedback (pass exit 2 through) is only known at the end.
    let err = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      failed = true;
      process.stderr.write(err);
      couldNotVerify(agent, e.code === 'ENOENT' ? `${target.command} not found` : `could not start ${target.command}: ${e.message}`);
      done();
    });
    child.on('close', (code) => {
      if (failed) return done();
      process.stderr.write(err);
      if (code === null) return done(); // killed by a signal: don't block
      const quiet = out.trim() === '';
      // Exit 2 blocks the agent, so it passes only as trustbut's own block: Claude's block JSON, or the FAIL feedback on stderr.
      const notTrustbutBlock = code === 2 && (agent === 'claude' ? !hasBlockJson(out) : agent !== 'opencode' && !err.startsWith(FAIL_HEADER));
      if ((code !== 0 && code !== 2 && quiet) || notTrustbutBlock) {
        // e.g. npx could not fetch trustbut, or an old trustbut without `hook`: say so instead of failing silently or blocking.
        const detail = err.trim().split(/\r?\n/).slice(-3).join(' | ').slice(-300);
        couldNotVerify(agent, `${target.command} exited with code ${code}${detail ? ` (${detail})` : ''}`);
        return done();
      }
      process.exitCode = code;
      if (agent === 'claude') emitClaudeStdout(out);
      else if (captured) process.stdout.write(out);
      done();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const isJsonObject = (text) => {
  try {
    const v = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
};

/** True when a line of `out` is Claude's block answer: a JSON object with `decision: "block"`. */
const hasBlockJson = (out) =>
  out.split(/\r?\n/).some((l) => {
    try {
      const v = JSON.parse(l.trim());
      return typeof v === 'object' && v !== null && v.decision === 'block';
    } catch {
      return false;
    }
  });

/** Claude Code must get exactly one JSON object: wrapper noise (e.g. `npm notice`) before it would make the hook output unparseable. */
export function emitClaudeStdout(out) {
  const text = out.trim();
  if (text === '' || isJsonObject(text)) return void process.stdout.write(out);
  const lines = text.split(/\r?\n/);
  const at = lines.findLastIndex((l) => isJsonObject(l.trim()));
  if (at === -1) {
    process.exitCode = 0;
    return couldNotVerify('claude', 'unexpected output from trustbut');
  }
  process.stderr.write(`${lines.filter((_, i) => i !== at).join('\n')}\n`);
  process.stdout.write(`${lines[at].trim()}\n`);
}

/** True when this file is the script being run; compares real paths, since a symlinked project dir (macOS /tmp, /var) makes the two differ. */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
}

if (isEntryPoint()) await main();
