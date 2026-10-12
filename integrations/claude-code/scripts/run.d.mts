export function pluginVersion(): string;
export function compareVersions(a: string, b: string): number;
export function nodeTooOld(version?: string): boolean;
export function resolveTrustbut(env?: NodeJS.ProcessEnv, version?: string, versionOf?: (env: NodeJS.ProcessEnv) => string | undefined): { command: string; args: string[] };
export function couldNotVerify(agent: string, reason: string): void;
export function main(argv?: string[], env?: NodeJS.ProcessEnv): Promise<void>;
export function pathVersion(env: NodeJS.ProcessEnv): string | undefined;
export function budgetSec(elapsedMs?: number, env?: NodeJS.ProcessEnv): number;
export function emitClaudeStdout(out: string): void;
