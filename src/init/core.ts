// Shared pieces of `trustbut init <agent>`: the planned file set, JSON hook merging, and the hardened runner copy.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';

/** Refuses to edit a file it can't understand; the CLI maps it to exit 2. */
export class InitError extends Error {}

export interface PlannedFile {
  path: string;
  content: string | Buffer;
}

export interface InitPlan {
  files: PlannedFile[];
  /** Printed after the changes (alternatives, approval and trust reminders). */
  notes: string[];
}

export interface InitContext {
  /** Git top level (or the current directory): where project-level files go. */
  root: string;
  /** The home directory, for `--user`. */
  home: string;
  user: boolean;
}

export const RUNNER_NAME = 'trustbut-run.mjs';
export const RUNNER_VERSION_FILE = 'trustbut-run.json';

/** The plugin's hardened runner: the single source, shipped in the npm package (`files` in package.json). */
export function runnerSource(): Buffer {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++, dir = dirname(dir)) {
    const file = join(dir, 'integrations', 'claude-code', 'scripts', 'run.mjs');
    if (existsSync(file)) return readFileSync(file);
  }
  throw new InitError("can't find the runner script (integrations/claude-code/scripts/run.mjs) in the trustbut package");
}

/** The runner plus the version file it reads (a copy has no plugin.json next to it). */
export function runnerFiles(dir: string): PlannedFile[] {
  return [
    { path: join(dir, RUNNER_NAME), content: runnerSource() },
    { path: join(dir, RUNNER_VERSION_FILE), content: `${JSON.stringify({ version: VERSION })}\n` },
  ];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The indent of the first indented line ("\t" or 2/4/other spaces); two spaces when there is none. */
export function detectIndent(text: string): string {
  const m = /^([ \t]+)\S/m.exec(text);
  return m ? m[1] : '  ';
}

const COMMENT = /^\s*\/\/|\/\*|[,{[]\s*\/\//m;

/**
 * Puts `hook` under `hooks[event]` of the JSON config in `text` (undefined or blank = new file), replacing in place
 * the hook `isOurs` recognises (idempotent), else adding `group`. Every other hook is left alone and the file's
 * indent is kept. Returns the new text. Refuses (InitError) a file it can't parse, with the snippet to add by hand
 * when the cause is comments (JSONC), which can't be preserved.
 */
export function mergeHook(path: string, text: string | undefined, event: string, isOurs: (hook: Json) => boolean, group: Json, hook: Json): string {
  const indent = text ? detectIndent(text) : '  ';
  let config: Json = {};
  if (text !== undefined && text.trim() !== '') {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (err) {
      if (COMMENT.test(text)) {
        const snippet = JSON.stringify({ hooks: { [event]: [{ ...group, hooks: [hook] }] } }, null, 2);
        throw new InitError(`${path} has comments, which init can't preserve. Nothing was changed. Add this to it by hand (merge it into any existing "hooks"):\n${snippet}`);
      }
      throw new InitError(`${path} is not valid JSON (${(err as Error).message}); fix or remove it, then run init again. Nothing was changed.`);
    }
    if (!isObject(value)) throw new InitError(`${path} is not a JSON object; nothing was changed.`);
    config = value;
  }
  const hooks = config.hooks ?? {};
  if (!isObject(hooks)) throw new InitError(`${path}: "hooks" is not an object; nothing was changed.`);
  const groups = hooks[event] ?? [];
  if (!Array.isArray(groups)) throw new InitError(`${path}: "hooks.${event}" is not an array; nothing was changed.`);
  let replaced = false;
  for (const g of groups) {
    if (!isObject(g) || !Array.isArray(g.hooks)) continue;
    g.hooks = g.hooks.map((h: unknown) => {
      if (!isObject(h) || !isOurs(h)) return h;
      replaced = true;
      return hook;
    });
  }
  if (!replaced) groups.push({ ...group, hooks: [hook] });
  return `${JSON.stringify({ ...config, hooks: { ...hooks, [event]: groups } }, null, indent)}\n`;
}

/** True when the hook runs our runner (command string or exec-form args). */
export const runsRunner = (h: Json): boolean =>
  (typeof h.command === 'string' && h.command.includes(RUNNER_NAME)) ||
  (Array.isArray(h.args) && h.args.some((a) => typeof a === 'string' && a.includes(RUNNER_NAME)));
