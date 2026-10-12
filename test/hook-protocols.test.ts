import { describe, expect, it } from 'vitest';
import { AGENTS, respond } from '../src/hook/protocols.js';

const block = { kind: 'block', feedback: 'trustbut verdict: FAIL\n\nfix it\n', message: 'trustbut FAIL: 1 failing test — sent back to the agent (attempt 1/3)' } as const;
const allow = { kind: 'allow', message: 'trustbut PASS: 2 tests passed' } as const;

describe('hook protocols', () => {
  it('knows claude, codex and gemini', () => {
    expect(AGENTS).toEqual(['claude', 'codex', 'gemini']);
  });

  it('claude: blocks with exit 0 and a JSON decision; systemMessage goes to the user', () => {
    expect(respond('claude', block)).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify({ decision: 'block', reason: block.feedback, systemMessage: block.message })}\n`,
      stderr: '',
    });
  });

  it.each(['codex', 'gemini'] as const)('%s: blocks with exit 2, the feedback on stderr and an empty stdout', (agent) => {
    expect(respond(agent, block)).toEqual({ exitCode: 2, stdout: '', stderr: block.feedback });
  });

  it.each(AGENTS)('%s: allows with exit 0 and a systemMessage', (agent) => {
    expect(respond(agent, allow)).toEqual({ exitCode: 0, stdout: '{"systemMessage":"trustbut PASS: 2 tests passed"}\n', stderr: '' });
  });

  it.each(AGENTS)('%s: skips with exit 0 and no output', (agent) => {
    expect(respond(agent, { kind: 'skip' })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });
});
