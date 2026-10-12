export function pluginVersion(): string;
export function compareVersions(a: string, b: string): number;
export function nodeTooOld(version?: string): boolean;
export function resolveTrustbut(env?: NodeJS.ProcessEnv, version?: string, versionOf?: (env: NodeJS.ProcessEnv) => string | undefined): { command: string; args: string[] };
export function couldNotVerify(agent: string, reason: string): void;
export function main(argv?: string[], env?: NodeJS.ProcessEnv): Promise<void>;
