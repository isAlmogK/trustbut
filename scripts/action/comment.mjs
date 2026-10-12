#!/usr/bin/env node
// Sticky PR comment for the trustbut GitHub Action. Dependency-free; talks to GitHub through the `gh` CLI.
// All inputs arrive through environment variables (never interpolated into a shell script).
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_BYTES = 60_000; // GitHub rejects comment bodies over 65,536 characters
export const LEGACY_MARKER = '<!-- trustbut-receipt -->';
export const markerFor = (key) => `<!-- trustbut-receipt:${key} -->`;

/** Cut `text` to at most `max` bytes of UTF-8 without leaving a broken trailing character. */
export function truncateBytes(text, max) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return { text, truncated: false };
  const cut = buf.subarray(0, max).toString('utf8').replace(/�+$/, '');
  return { text: cut, truncated: true };
}

export function buildBody({ receipt, marker, runUrl, max = MAX_BYTES }) {
  const { text, truncated } = truncateBytes(receipt, max);
  const parts = [marker, text.replace(/\n+$/, '')];
  if (truncated) {
    const fences = text.split('\n').filter((l) => l.startsWith('```')).length;
    if (fences % 2 === 1) parts.push('```'); // the cut fell inside a code block: close it
    parts.push(`_Receipt truncated: the full receipt is in the job summary of the [run](${runUrl})._`);
  }
  parts.push(`<sub>Posted by trustbut · [run log](${runUrl})</sub>`);
  return `${parts.join('\n\n')}\n`;
}

/**
 * Pick the comment to update: bot-authored only (a human cannot plant a marker we then overwrite) and
 * starting with our marker. The pre-keyed legacy marker is adopted for the default key only.
 */
export function findComment(comments, key) {
  const markers = [markerFor(key), ...(key === 'default' ? [LEGACY_MARKER] : [])];
  const mine = comments.filter(
    (c) => (c.type === 'Bot' || c.login === 'github-actions[bot]') && markers.some((m) => (c.body ?? '').startsWith(m)),
  );
  return mine.find((c) => (c.body ?? '').startsWith(markers[0])) ?? mine[0];
}

export function defaultGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

const notice = (msg) => console.log(`::notice title=trustbut::${msg}`);
const warning = (msg) => console.log(`::warning title=trustbut::${msg}`);

export function run(env, gh = defaultGh) {
  const key = env.COMMENT_KEY || 'default';
  if (env.EVENT_NAME !== 'pull_request') return 0;
  if (env.HEAD_REPO && env.HEAD_REPO !== env.REPO) {
    notice('Fork PR: the token is read-only, so the receipt is in the job summary only.');
    return 0;
  }
  let receipt;
  try {
    receipt = readFileSync(env.RECEIPT, 'utf8');
  } catch {
    receipt = '';
  }
  if (!receipt.trim()) {
    notice('Receipt is missing or empty; not commenting.');
    return 0;
  }
  const runUrl = `${env.SERVER_URL}/${env.REPO}/actions/runs/${env.RUN_ID}`;
  const body = buildBody({ receipt, marker: markerFor(key), runUrl });
  const bodyFile = join(env.RUNNER_TEMP || tmpdir(), `trustbut-comment-${process.pid}.md`);
  writeFileSync(bodyFile, body);
  try {
    const listing = gh([
      'api', '--paginate', `repos/${env.REPO}/issues/${env.PR}/comments`,
      '--jq', '.[] | {id, login: .user.login, type: .user.type, body}',
    ]);
    const comments = listing.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const existing = findComment(comments, key);
    const url = (existing
      ? gh(['api', '-X', 'PATCH', `repos/${env.REPO}/issues/comments/${existing.id}`, '-F', `body=@${bodyFile}`, '--jq', '.html_url'])
      : gh(['api', '-X', 'POST', `repos/${env.REPO}/issues/${env.PR}/comments`, '-F', `body=@${bodyFile}`, '--jq', '.html_url'])
    ).trim();
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `url=${url}\n`);
    console.log(`${existing ? 'Updated' : 'Created'} receipt comment: ${url}`);
  } catch (err) {
    warning(`Could not post the PR comment (needs pull-requests: write; Dependabot needs it granted explicitly): ${String(err.message).split('\n')[0]}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run(process.env));
}
