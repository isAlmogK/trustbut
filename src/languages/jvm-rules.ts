// Shared by the Java and Kotlin entries: JUnit 4/5, TestNG-style annotations, AssertJ/Hamcrest/Mockito.

/**
 * Test files of a JVM language with extension `ext`: test source sets (`src/test/`, `src/androidTest/`, `src/jvmTest/`),
 * root `test/`/`tests/` dirs and `*Test`/`*Tests`/`*IT` files (`FooIT`, not `JIT`), but nothing in a main source set (`src/main/`,
 * `src/commonMain/`), where a `test` package or an `ABTest` class is production code.
 */
export const jvmTestFile = (ext: string) =>
  new RegExp(String.raw`^(?!(?:.*/)?src/(?:main|\w+Main)/)(?:(?:^|.*/)(?:src/[^/]*[tT]est[^/]*|tests?|__tests__)/|.*(?:Tests?|[a-z\d]IT)\.${ext}$)`);

/** Files whose name says they hold tests (for `proofs-unmatched`). */
export const jvmTestFileName = (ext: string) => new RegExp(String.raw`^(?!(?:.*/)?src/(?:main|\w+Main)/).*Tests?\.${ext}$`);

export const JVM_SKIP = [/@(?:Disabled\w*|Ignore)\b/];
export const JVM_TEST_DEF = [/@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/];
export const JVM_ASSERT = [/\b(?:assert\w*|verify)\s*\(/, /^\s*assert\b/];
