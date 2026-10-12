// How each agent's turn-end hook reads our answer (see docs/SPEC.md, "Agent hooks").
//   Claude Code `Stop`:  exit 0 + JSON {decision:"block", reason} keeps the agent working; systemMessage is shown to the user.
//   Codex `Stop`:        exit 2 + reason on stderr keeps it working; on exit 0, stdout must be JSON or empty.
//   Gemini `AfterAgent`: exit 2 + reason on stderr retries; stdout must stay empty (it would replace the reason).
// Any other answer lets the agent finish. Exit 2 means "block" to all three, so it is used only for a FAIL.

//   OpenCode plugin:     no hook protocol; the plugin runs `trustbut hook opencode`: exit 1 + feedback on stdout is a FAIL to send back,
//                        exit 0 means nothing to send (a status message, if any, is on stderr).
export const AGENTS = ['claude', 'codex', 'gemini', 'opencode'] as const;
export type Agent = (typeof AGENTS)[number];

export type HookOutcome =
  /** Let the agent finish without saying anything. */
  | { kind: 'skip' }
  /** Let the agent finish and show `message` to the user. */
  | { kind: 'allow'; message: string }
  /** Keep the agent working: `feedback` goes to the agent, `message` (where the agent supports it) to the user. */
  | { kind: 'block'; feedback: string; message: string };

export interface HookResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

export function respond(agent: Agent, outcome: HookOutcome): HookResponse {
  if (agent === 'opencode') {
    if (outcome.kind === 'skip') return { exitCode: 0, stdout: '', stderr: '' };
    if (outcome.kind === 'allow') return { exitCode: 0, stdout: '', stderr: `${outcome.message}\n` };
    return { exitCode: 1, stdout: outcome.feedback, stderr: `${outcome.message}\n` };
  }
  switch (outcome.kind) {
    case 'skip':
      return { exitCode: 0, stdout: '', stderr: '' };
    case 'allow':
      return { exitCode: 0, stdout: json({ systemMessage: outcome.message }), stderr: '' };
    case 'block':
      if (agent === 'claude') {
        return { exitCode: 0, stdout: json({ decision: 'block', reason: outcome.feedback, systemMessage: outcome.message }), stderr: '' };
      }
      return { exitCode: 2, stdout: '', stderr: outcome.feedback };
  }
}
