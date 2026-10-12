import { anyExists } from './detect.js';
import { runJvm, casesInJvmFile, type JvmTool } from './jvm.js';
import type { Runner } from './types.js';

/** The `gradle` arguments (without the executable) for one run. Nested classes (`Outer$Inner`) are selected too. */
export function gradleArgs(classes: string[], args: string[], init?: string): string[] {
  return ['test', ...classes.flatMap((c) => ['--tests', c, '--tests', `${c}$*`]), '--continue', '--console=plain', '--no-daemon', '--no-build-cache', ...(init ? ['-I', init] : []), ...args];
}

// Modules without a matching class must not fail the build when `--tests` selects classes.
export const GRADLE_INIT = 'allprojects { tasks.withType(Test).configureEach { filter.failOnNoMatchingTests = false } }\n';

const tool: JvmTool = { initScript: GRADLE_INIT, name: 'gradle', wrapper: 'gradlew', bin: 'gradle', kind: 'gradle', buildArgs: gradleArgs };

export const gradle: Runner = {
  name: 'gradle',
  async detect(root) {
    return anyExists(root, ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']) ? 10 : 0;
  },
  run: (opts) => runJvm(tool, opts),
  casesInFile: casesInJvmFile,
};
