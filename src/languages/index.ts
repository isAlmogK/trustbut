
import { csharp } from './csharp.js';
import { dart } from './dart.js';
import { go } from './go.js';
import { java } from './java.js';
import { js } from './js.js';
import { kotlin } from './kotlin.js';
import { php } from './php.js';
import { py } from './python.js';
import { ruby } from './ruby.js';
import { rust } from './rust.js';
import { swift } from './swift.js';
import type { Language } from './types.js';

/** Every supported language. To add one: create `src/languages/<id>.ts` and list it here. */
export const LANGUAGES: Language[] = [js, py, go, rust, csharp, php, java, kotlin, ruby, dart, swift];

/** The language of a file, by extension. */
export function languageOf(path: string): Language | undefined {
  return LANGUAGES.find((l) => l.extensions.some((ext) => path.endsWith(ext)));
}

export function languageById(id: string): Language {
  const lang = LANGUAGES.find((l) => l.id === id);
  if (!lang) throw new Error(`Unknown language: ${id}. Supported: ${LANGUAGES.map((l) => l.id).join(', ')}`);
  return lang;
}

// Files of unregistered languages (`.vue`, `.svelte`, ...) whose name says they define tests.
const GENERIC_TEST_NAME = /\.(test|spec)\.[^/]*$/;

/** Whether the file's name says it defines tests (not a helper under a test dir); see `Language.testFileName`. */
export function isNamedTestFile(path: string): boolean {
  const lang = languageOf(path);
  return lang ? (lang.testFileName ?? lang.testFile).test(path) : GENERIC_TEST_NAME.test(path);
}
