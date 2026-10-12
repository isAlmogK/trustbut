// `trustbut init <agent>`: installs the turn-end hook for an agent, merging into its existing config.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { execa } from 'execa';
import { planClaude } from './claude.js';
import { planCodex } from './codex.js';
import { InitError, type InitContext, type InitPlan } from './core.js';
import { planGemini } from './gemini.js';
import { planOpencode } from './opencode.js';

export { InitError } from './core.js';
export const INIT_AGENTS = ['claude', 'codex', 'gemini', 'opencode'] as const;
export type InitAgent = (typeof INIT_AGENTS)[number];

export interface InitOptions {
  agent: InitAgent;
  dryRun?: boolean;
  user?: boolean;
  cwd?: string;
  home?: string;
}

const PLANNERS: Record<InitAgent, (ctx: InitContext) => InitPlan> = { claude: planClaude, codex: planCodex, gemini: planGemini, opencode: planOpencode };

async function projectRoot(cwd: string): Promise<string> {
  const r = await execa('git', ['rev-parse', '--show-toplevel'], { cwd, reject: false });
  return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : cwd;
}

/** A small line diff: the lines that differ between the common head and tail. */
function diff(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [...a.slice(start, endA).map((l) => `-${l}`), ...b.slice(start, endB).map((l) => `+${l}`)];
}

/** The file a write to `path` should replace: a symlink's target (followed to the end), else `path` itself. */
function writeTarget(path: string): string {
  try {
    if (!lstatSync(path).isSymbolicLink()) return path;
  } catch {
    return path; // doesn't exist yet
  }
  try {
    return realpathSync(path);
  } catch {
    // A dangling link: create the file it points to, keeping the link.
    let target = path;
    for (let i = 0; i < 40; i++) {
      try {
        if (!lstatSync(target).isSymbolicLink()) break;
      } catch {
        break;
      }
      target = resolve(dirname(target), readlinkSync(target));
    }
    return target;
  }
}

/**
 * Replaces the file atomically (temp file in the same directory, then rename) without breaking a symlink
 * (its target is replaced) or widening permissions (an existing file keeps its mode; a new one gets the default).
 */
function writeAtomic(path: string, content: string | Buffer): void {
  const target = writeTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : undefined;
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: mode ?? 0o666, flag: 'wx' });
    if (mode !== undefined) chmodSync(tmp, mode); // exact, whatever the umask
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Writes (unless dry-run) and returns the text to print. Throws InitError before writing anything if a config can't be parsed. */
export async function runInit(opts: InitOptions): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  const user = opts.user ?? false;
  const ctx: InitContext = { root: user ? cwd : await projectRoot(cwd), home: opts.home ?? homedir(), user };
  const plan = PLANNERS[opts.agent](ctx);
  if (!user) plan.notes.push(`Project files were written at the git root (${ctx.root}). Agents read project settings from the directory they are launched in, so start ${opts.agent} from there.`);
  const lines: string[] = [];
  const pending: { path: string; content: string | Buffer }[] = [];
  for (const file of plan.files) {
    const before = existsSync(file.path) ? readFileSync(file.path) : undefined;
    const after = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content);
    if (before && before.equals(after)) {
      lines.push(`unchanged ${file.path}`);
      continue;
    }
    pending.push(file);
    const isText = !Buffer.isBuffer(file.content);
    lines.push(`${before ? 'update' : 'create'} ${file.path}${opts.dryRun ? ' (dry run)' : ''}`);
    if (isText) lines.push(...diff(before?.toString() ?? '', after.toString()).map((l) => `  ${l}`));
    else lines.push(`  (${after.length} bytes, copy of trustbut's hook runner)`);
  }
  if (!opts.dryRun) {
    for (const file of pending) writeAtomic(file.path, file.content);
  }
  if (pending.length === 0) lines.push('Nothing to change: already set up.');
  else if (opts.dryRun) lines.push('Dry run: nothing was written.');
  return `${[...lines, '', ...plan.notes].join('\n')}\n`;
}
