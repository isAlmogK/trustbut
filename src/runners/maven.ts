import { anyExists } from './detect.js';
import { runJvm, casesInJvmFile, type JvmTool } from './jvm.js';
import type { Runner } from './types.js';

/** The `mvn` arguments (without the executable) for one run. */
export function mavenArgs(classes: string[], args: string[]): string[] {
  return [
    '-q',
    '-B',
    'test',
    ...(classes.length ? [`-Dtest=${classes.flatMap((c) => [c, `${c}$*`]).join(',')}`] : []),
    '-Dmaven.test.failure.ignore=true',
    '-DfailIfNoTests=false',
    '-Dsurefire.failIfNoSpecifiedTests=false',
    ...args,
  ];
}

const tool: JvmTool = { name: 'maven', wrapper: 'mvnw', bin: 'mvn', kind: 'surefire', ignoresTestFailures: true, skipsIntegrationTests: true, buildArgs: mavenArgs };

export const maven: Runner = {
  name: 'maven',
  async detect(root) {
    return anyExists(root, ['pom.xml']) ? 10 : 0;
  },
  run: (opts) => runJvm(tool, opts),
  casesInFile: casesInJvmFile,
};
