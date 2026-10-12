import { ANSI } from './runners/cases.js';
import type { Finding, Receipt, RunResult, TestCaseResult } from './types.js';

const ICON = { fail: '✖', warn: '⚠', info: 'ℹ' } as const;

const MAX_FAILING = 10;

// Characters that would start Markdown syntax, HTML, entities, or @mentions in plain text.
const MD_SPECIAL = /[\\`*_[\]<>|#&~@]/g;

function oneLine(s: string): string {
  return s.replace(/\r\n|\r|\n/g, ' ');
}

/** Plain user text: single line, Markdown punctuation and @mentions escaped. */
function text(s: string): string {
  return oneLine(s).replace(MD_SPECIAL, '\\$&');
}

/** Inline code span whose fence is longer than any backtick run inside the content. */
function code(s: string): string {
  const flat = oneLine(s);
  const longest = (flat.match(/`+/g) ?? []).reduce((m, run) => Math.max(m, run.length), 0);
  if (longest === 0) return `\`${flat}\``;
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${flat} ${fence}`;
}

function tally(run: RunResult) {
  const t = { pass: 0, fail: 0, error: 0, skip: 0 };
  for (const c of run.cases) t[c.outcome] += 1;
  return t;
}

function findingLine(f: Finding): string {
  const where = f.file ? ` · ${code(`${f.file}${f.line ? `:${f.line}` : ''}`)}` : '';
  const detail = f.detail ? `: ${text(f.detail)}` : '';
  return `- ${ICON[f.severity]} **${text(f.title)}**${where}${detail}`;
}

/** Failing head results, listed when the suite fails at head. */
export function failingCases(r: Receipt): TestCaseResult[] {
  return r.findings.some((f) => f.id === 'suite-failing') ? (r.after?.cases ?? []).filter((c) => c.outcome === 'fail' || c.outcome === 'error') : [];
}

export function renderMarkdown(r: Receipt): string {
  const lines: string[] = [];
  lines.push(`## 🧾 Receipt: ${r.verdict.toUpperCase()}`, '');
  lines.push(`${code(r.base.slice(0, 7))} → ${r.headRef ? text(r.headRef) : code(r.head.slice(0, 7))}${r.runner ? ` · runner: ${text(r.runner)}${r.root && r.root !== '.' ? ` · root: ${code(r.root)}` : ''}` : ''}`, '');

  if (r.after) {
    const t = tally(r.after);
    const where = r.scope === 'changed' ? 'clean checkout, changed files only' : 'clean checkout';
    lines.push(`**Tests (${where}):** ${t.pass} passed · ${t.fail + t.error} failed · ${t.skip} skipped`);
  } else {
    lines.push('**Tests:** not run');
  }
  if (r.proofs.length) {
    const proves = r.proofs.filter((p) => p.verdict === 'proves-change');
    const weak = proves.filter((p) => p.weak).length;
    const loose = r.proofs.filter((p) => p.verdict === 'does-not-constrain').length;
    lines.push(`**New/changed tests:** ${proves.length} prove the change${weak ? ` (${weak} couldn't run at base)` : ''} · ${loose} pass without it`);
  }

  lines.push('', '### Findings');
  if (!r.findings.length) lines.push('None.');
  for (const f of r.findings) lines.push(findingLine(f));

  const failing = failingCases(r);
  if (failing.length) {
    lines.push('', '### Failing tests');
    for (const c of failing.slice(0, MAX_FAILING)) lines.push(`- ${c.file ? `${code(c.file)} › ` : ''}${text(c.name)}`);
    if (failing.length > MAX_FAILING) lines.push(`- and ${failing.length - MAX_FAILING} more`);
  }

  if (r.risks.length) {
    lines.push('', '### Review these first');
    r.risks.slice(0, 5).forEach((risk, i) => lines.push(`${i + 1}. ${code(risk.file)}: ${risk.reasons.join(', ')}`));
  }
  return `${lines.join('\n')}\n`;
}

/** Longest feedback sent to an agent: Codex and Gemini cut hook output at about 2,500 tokens. */
export const AGENT_FEEDBACK_MAX = 6000;
const AGENT_MAX_LINE = 400;
const AGENT_MAX_WARN = 10;
/** The default way to recheck: the same command the hook runs, in the terminal. */
export const DEFAULT_RECHECK = 'trustbut verify --working';
const OUTPUT_LINES = 20;
const OUTPUT_MAX = 1500;

const clip = (s: string, max = AGENT_MAX_LINE): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function agentFinding(f: Finding): string {
  const where = f.file ? ` · ${code(`${f.file}${f.line ? `:${f.line}` : ''}`)}` : '';
  const detail = f.detail ? `: ${oneLine(f.detail)}` : '';
  return clip(`- ${oneLine(f.title)}${where}${detail}`);
}

const more = (n: number, what: string): string => `- and ${n} more ${what}${n === 1 ? '' : 's'}`;

export interface AgentFeedbackOptions {
  /** Command the agent should run to recheck; default `trustbut verify --working`. */
  recheck?: string;
  maxChars?: number;
}

/** The last lines (at most 20 and 1,500 characters) of a run's output, without colour codes. */
export function outputTail(output: string): string {
  const lines = output.replace(ANSI, '').replace(/\s+$/, '').split(/\r?\n/).slice(-OUTPUT_LINES);
  while (lines.length > 1 && lines.join('\n').length > OUTPUT_MAX) lines.shift();
  const text = lines.join('\n');
  return text.length > OUTPUT_MAX ? text.slice(-OUTPUT_MAX) : text;
}

/** A fenced code block whose fence is longer than any backtick run inside. */
function fenced(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((m, run) => Math.max(m, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * Feedback for an agent whose turn-end hook got a FAIL: plain Markdown of at most `maxChars`
 * characters: FAIL findings, failing tests with the runner's messages, the end of the test output
 * when the suite fails, warnings, how to recheck and the full receipt's path. Agent-written text is
 * flattened to one line per item but not escaped: it goes back to the agent, not to a PR.
 */
export function renderForAgent(r: Receipt, receiptPath: string | undefined, opts: AgentFeedbackOptions = {}): string {
  const { recheck = DEFAULT_RECHECK, maxChars = AGENT_FEEDBACK_MAX } = opts;
  const head: string[] = [`trustbut verdict: ${r.verdict.toUpperCase()}`, ''];
  if (r.after) {
    const t = tally(r.after);
    const where = r.scope === 'changed' ? 'clean checkout of your work, changed test files only' : 'clean checkout of your work';
    head.push(`Tests (${where}): ${t.pass} passed · ${t.fail + t.error} failed · ${t.skip} skipped`);
  } else {
    head.push('Tests: not run');
  }

  // Each entry is one item; an item may span lines (the output block) and is kept or dropped whole.
  const body: string[] = [];
  const failing = failingCases(r);
  // A changed test that fails at head is also in the failing tests below; list it once.
  const fails = r.findings.filter((f) => f.severity === 'fail' && !(failing.length && f.id === 'test-failing'));
  if (fails.length) body.push('', '### Must fix', ...fails.map(agentFinding));
  if (failing.length) {
    body.push('', '### Failing tests');
    for (const c of failing.slice(0, MAX_FAILING)) {
      body.push(clip(`- ${c.file ? `${code(c.file)} › ` : ''}${oneLine(c.name)}${c.message ? `: ${oneLine(c.message)}` : ''}`));
    }
    if (failing.length > MAX_FAILING) body.push(more(failing.length - MAX_FAILING, 'failing test'));
  }
  const tail = r.findings.some((f) => f.id === 'suite-failing') && r.after ? outputTail(r.after.output) : '';
  if (tail) body.push('', '### Test output (last lines)', fenced(tail));
  const warns = r.findings.filter((f) => f.severity === 'warn');
  if (warns.length) {
    body.push('', '### Warnings', ...warns.slice(0, AGENT_MAX_WARN).map(agentFinding));
    if (warns.length > AGENT_MAX_WARN) body.push(more(warns.length - AGENT_MAX_WARN, 'warning'));
  }

  const where = receiptPath ? `Full receipt: ${code(receiptPath)}` : `Full receipt: not written (run ${code(recheck)} to see it)`;
  const footer = ['', `Fix these and finish again; run ${code(recheck)} to check.`, clip(where, 1000)];
  const join = (lines: string[]) => `${lines.join('\n')}\n`;
  const full = join([...head, ...body, ...footer]);
  if (full.length <= maxChars) return full;
  // Too long: drop items from the end and say how many lines were left out.
  for (let keep = body.length - 1; keep >= 0; keep--) {
    const cut = body.slice(keep).reduce((n, item) => n + item.split('\n').length, 0);
    const out = join([...head, ...body.slice(0, keep), `- … ${cut} more line${cut === 1 ? '' : 's'} not shown; see the full receipt`, ...footer]);
    if (out.length <= maxChars) return out;
  }
  return join([...head, ...footer]).slice(0, maxChars);
}
