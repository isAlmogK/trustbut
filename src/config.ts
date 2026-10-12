import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { execa } from 'execa';

export interface TrustbutConfig {
  /** Package folder relative to the repo root; default '.'. */
  root?: string;
  runner?: string;
  /** Generic runner: shell command; `{files}` is replaced with the quoted test files (or nothing for a full run). */
  command?: string;
  /** Generic runner: path (relative to root) of the JUnit XML the command writes. */
  junit?: string;
  /** Shell command run in the root before each run (e.g. start an emulator); its process group is killed after. */
  setup?: string;
  /** Seconds to wait for `setup` before running tests (or until `setupReadyPattern` matches); default 5. */
  setupWaitSec?: number;
  /** Regex: tests start as soon as `setup` prints a matching line (stdout or stderr). */
  setupReadyPattern?: string;
  env?: Record<string, string>;
  args?: string[];
  /** Per test run; default 900. */
  timeoutSec?: number;
  /** `trustbut hook <agent>` settings. */
  hook?: HookConfig;
}

export type HookMode = 'quick' | 'full';

export interface HookConfig {
  /** false: the hook allows every stop without verifying. Default true. */
  enabled?: boolean;
  /** 'quick' (default) reruns only changed test files at head; 'full' reruns the whole suite. */
  mode?: HookMode;
  /** How many times in a row a FAIL is sent back to the agent before the stop is allowed. Default 3. */
  maxRetries?: number;
  /** Time budget for the whole verify run in the hook; default 540 (under the agents' 600 s hook timeout). */
  timeoutSec?: number;
}

export const HOOK_KEYS = ['enabled', 'mode', 'maxRetries', 'timeoutSec'] as const satisfies readonly (keyof HookConfig)[];
export const DEFAULT_HOOK_TIMEOUT_SEC = 540;
export const DEFAULT_HOOK_MAX_RETRIES = 3;
export const MAX_HOOK_RETRIES = 100;

/** Hook settings with defaults applied. */
export function hookSettings(config: TrustbutConfig): Required<HookConfig> {
  const hook = config.hook ?? {};
  return {
    enabled: hook.enabled ?? true,
    mode: hook.mode ?? 'quick',
    maxRetries: hook.maxRetries ?? DEFAULT_HOOK_MAX_RETRIES,
    timeoutSec: hook.timeoutSec ?? DEFAULT_HOOK_TIMEOUT_SEC,
  };
}

export const CONFIG_FILE = '.trustbut.json';
export const DEFAULT_TIMEOUT_SEC = 900;
export const DEFAULT_SETUP_WAIT_SEC = 5;
/** Largest accepted timeout in seconds (timers overflow at 2^31-1 ms, about 2,147,483 s). */
export const MAX_SECONDS = 2_000_000;
/** Editor hint for a JSON schema: accepted and ignored. */
const IGNORED_KEYS = ['$schema'];

export const CONFIG_KEYS = [
  'root',
  'runner',
  'command',
  'junit',
  'setup',
  'setupWaitSec',
  'setupReadyPattern',
  'env',
  'args',
  'timeoutSec',
  'hook',
] as const satisfies readonly (keyof TrustbutConfig)[];

const STRING_KEYS = ['root', 'runner', 'command', 'junit', 'setup', 'setupReadyPattern'] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks the shape of a parsed config; `source` names it in error messages. */
export function validateConfig(value: unknown, source: string): TrustbutConfig {
  const fail = (msg: string): never => {
    throw new Error(`Invalid ${source}: ${msg}`);
  };
  if (!isObject(value)) return fail('must be a JSON object');
  const unknown = Object.keys(value).filter((k) => !(CONFIG_KEYS as readonly string[]).includes(k) && !IGNORED_KEYS.includes(k));
  if (unknown.length) {
    throw new Error(`Unknown keys in ${source}: ${unknown.join(', ')}. Allowed keys: ${CONFIG_KEYS.join(', ')}`);
  }
  for (const key of STRING_KEYS) {
    if (key in value && typeof value[key] !== 'string') fail(`"${key}" must be a string`);
  }
  if ('args' in value && !(Array.isArray(value.args) && value.args.every((a) => typeof a === 'string'))) {
    fail('"args" must be an array of strings');
  }
  if ('env' in value && !(isObject(value.env) && Object.values(value.env).every((v) => typeof v === 'string'))) {
    fail('"env" must be an object of strings');
  }
  if ('timeoutSec' in value && !(typeof value.timeoutSec === 'number' && value.timeoutSec > 0 && value.timeoutSec <= MAX_SECONDS)) {
    fail(`"timeoutSec" must be a positive number up to ${MAX_SECONDS}`);
  }
  if ('setupWaitSec' in value && !(typeof value.setupWaitSec === 'number' && value.setupWaitSec >= 0 && value.setupWaitSec <= MAX_SECONDS)) {
    fail(`"setupWaitSec" must be a number >= 0 and up to ${MAX_SECONDS}`);
  }
  if (typeof value.setupReadyPattern === 'string') {
    try {
      new RegExp(value.setupReadyPattern);
    } catch {
      fail('"setupReadyPattern" is not a valid regular expression');
    }
  }
  if ('hook' in value) validateHook(value.hook, fail, source);
  const config = { ...value };
  for (const k of IGNORED_KEYS) delete config[k];
  return config as TrustbutConfig;
}

function validateHook(hook: unknown, fail: (msg: string) => never, source: string): void {
  if (!isObject(hook)) fail('"hook" must be an object');
  const h = hook as Record<string, unknown>;
  const unknown = Object.keys(h).filter((k) => !(HOOK_KEYS as readonly string[]).includes(k));
  if (unknown.length) throw new Error(`Unknown keys in "hook" in ${source}: ${unknown.join(', ')}. Allowed keys: ${HOOK_KEYS.join(', ')}`);
  if ('enabled' in h && typeof h.enabled !== 'boolean') fail('"hook.enabled" must be true or false');
  if ('mode' in h && h.mode !== 'quick' && h.mode !== 'full') fail('"hook.mode" must be "quick" or "full"');
  if ('maxRetries' in h && !(Number.isInteger(h.maxRetries) && (h.maxRetries as number) >= 0 && (h.maxRetries as number) <= MAX_HOOK_RETRIES)) {
    fail(`"hook.maxRetries" must be a whole number from 0 to ${MAX_HOOK_RETRIES}`);
  }
  if ('timeoutSec' in h && !(typeof h.timeoutSec === 'number' && h.timeoutSec > 0 && h.timeoutSec <= MAX_SECONDS)) {
    fail(`"hook.timeoutSec" must be a positive number up to ${MAX_SECONDS}`);
  }
}

/** A package root as a normalized repo-relative POSIX path ('.' for the repo root). */
export function normalizeRoot(root: string | undefined): string {
  if (root === undefined || root === '') return '.';
  const norm = posix.normalize(root.replace(/\\/g, '/')).replace(/\/+$/, '');
  if (posix.isAbsolute(norm) || norm === '..' || norm.startsWith('../')) {
    throw new Error(`Invalid root "${root}": root must be a folder inside the repository`);
  }
  return norm === '' ? '.' : norm;
}

function parse(text: string, source: string): TrustbutConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`Could not parse ${source}: ${(err as Error).message}`);
  }
  return validateConfig(value, source);
}

/**
 * The config for a run: `explicitPath` (--config) if given, else `.trustbut.json` at the repo root
 * as committed at `head`, else the working-tree file, else an empty config.
 */
export async function loadConfig(repo: string, explicitPath?: string, head = 'HEAD'): Promise<TrustbutConfig> {
  if (explicitPath) {
    if (!existsSync(explicitPath)) throw new Error(`Config file not found: ${explicitPath}`);
    return parse(await readFile(explicitPath, 'utf8'), explicitPath);
  }
  const atHead = await execa('git', ['cat-file', 'blob', `${head}:${CONFIG_FILE}`], { cwd: repo, reject: false });
  if (atHead.exitCode === 0) return parse(atHead.stdout, CONFIG_FILE);
  const local = join(repo, CONFIG_FILE);
  if (existsSync(local)) return parse(await readFile(local, 'utf8'), CONFIG_FILE);
  return {};
}
