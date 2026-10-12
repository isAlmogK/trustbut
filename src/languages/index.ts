
import { csharp } from './csharp.js';
import { go } from './go.js';
import { js } from './js.js';
import { php } from './php.js';
import { py } from './python.js';
import { rust } from './rust.js';
import type { Language } from './types.js';

/** Every supported language. To add one: create `src/languages/<id>.ts` and list it here. */
export const LANGUAGES: Language[] = [js, py, go, rust, csharp, php];

/** The language of a file, by extension. */
export function languageOf(path: string): Language | undefined {
  return LANGUAGES.find((l) => l.extensions.some((ext) => path.endsWith(ext)));
}

export function languageById(id: string): Language {
  const lang = LANGUAGES.find((l) => l.id === id);
  if (!lang) throw new Error(`Unknown language: ${id}. Supported: ${LANGUAGES.map((l) => l.id).join(', ')}`);
  return lang;
}
