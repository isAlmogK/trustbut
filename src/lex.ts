// A per-line lexer for static checks, driven by a language's comment and string syntax. It does
// not see surrounding lines, so it cannot know whether a line sits inside a multi-line string or
// block comment; it handles the common cases.

import { languageById } from './languages/index.js';
import type { Language, StringSyntax } from './languages/types.js';

export interface SplitLine {
  /** The line with the contents of string (and regex) literals removed (delimiters kept), comments removed. */
  code: string;
  /** Comment text on the line, including its marker. Several comments are joined with a space. */
  comment: string;
}

const syntaxOf = (d: string | StringSyntax): StringSyntax => (typeof d === 'string' ? { open: d, close: d } : d);

/**
 * Index just past the literal whose body starts at `from`, or the line length if it does not close on this line. For a
 * character literal that does not close as one (a Rust lifetime), -1.
 */
function skipString(text: string, from: number, s: StringSyntax): number {
  if (s.char) {
    let j = from;
    if (text[j] === '\\') {
      const end = text.indexOf(s.close, j + 2);
      return end >= 0 && end - j <= 12 ? end + s.close.length : -1;
    }
    const cp = text.codePointAt(j);
    if (cp === undefined || text.startsWith(s.close, j)) return -1;
    j += cp > 0xffff ? 2 : 1;
    return text.startsWith(s.close, j) ? j + s.close.length : -1;
  }
  const escapes = !s.raw && !s.doubled;
  let j = from;
  while (j < text.length) {
    if (escapes && text[j] === '\\') j += 2;
    else if (text.startsWith(s.close, j)) {
      if (s.doubled && text.startsWith(s.close, j + s.close.length)) j += 2 * s.close.length;
      else return j + s.close.length;
    } else j += 1;
  }
  return text.length;
}

/** The string delimiter opening at `i`, if any. Letter-prefixed delimiters (`r"`) do not count right after an identifier character. */
function stringAt(text: string, i: number, lang: Language): StringSyntax | undefined {
  for (const d of lang.strings) {
    const s = syntaxOf(d);
    if (!text.startsWith(s.open, i)) continue;
    if (/^[A-Za-z_]/.test(s.open) && i > 0 && /[\w$]/.test(text[i - 1]!)) continue;
    return s;
  }
  return undefined;
}

// A `/` starts a regex literal (not a division) after these characters or keywords.
const REGEX_AFTER_CHAR = /[(,=:[!&|?{};+\-*%<>~^]$/;
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|instanceof|yield|await)$/;

function regexAllowed(codeSoFar: string): boolean {
  const before = codeSoFar.trimEnd();
  return before === '' || REGEX_AFTER_CHAR.test(before) || REGEX_AFTER_WORD.test(before);
}

/** Index just past a regex literal (including flags) starting at `from`, or -1 if it does not close on this line. */
function skipRegex(text: string, from: number): number {
  let inClass = false;
  for (let j = from + 1; j < text.length; j += 1) {
    const c = text[j];
    if (c === '\\') j += 1;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '/') {
      let end = j + 1;
      while (end < text.length && /[a-z]/i.test(text[end])) end += 1;
      return end;
    }
  }
  return -1;
}

// Continuation lines of a C-style block comment (`* text`, `*/`).
const BLOCK_CONTINUATION = /^\*(?:\s|\/|$)/;

/** Splits one line into code and comments using the syntax of `language` (a Language or its id). */
export function splitLine(text: string, language: Language | string): SplitLine {
  const lang = typeof language === 'string' ? languageById(language) : language;
  const { line: lineMarkers, block, lineBlock, notComment = [] } = lang.comments;
  const trimmed = text.trimStart();
  if (block?.[0] === '/*' && BLOCK_CONTINUATION.test(trimmed)) return { code: '', comment: trimmed };
  if (lineBlock?.some((m) => text.startsWith(m) && (text.length === m.length || /\s/.test(text[m.length]!)))) return { code: '', comment: text };

  let code = '';
  const comments: string[] = [];
  let i = 0;
  while (i < text.length) {
    const notMarker = notComment.find((p) => text.startsWith(p, i));
    if (notMarker) {
      code += notMarker;
      i += notMarker.length;
      continue;
    }
    if (lineMarkers.some((m) => text.startsWith(m, i))) {
      comments.push(text.slice(i));
      break;
    }
    if (block && text.startsWith(block[0], i)) {
      const end = text.indexOf(block[1], i + block[0].length);
      if (end < 0) {
        comments.push(text.slice(i));
        break;
      }
      comments.push(text.slice(i, end + block[1].length));
      code += ' ';
      i = end + block[1].length;
      continue;
    }
    const str = stringAt(text, i, lang);
    if (str) {
      const end = skipString(text, i + str.open.length, str);
      if (end >= 0) {
        code += str.open + str.close;
        i = end;
        continue;
      }
    }
    if (lang.regexLiterals && text[i] === '/' && regexAllowed(code)) {
      const end = skipRegex(text, i);
      if (end > 0) {
        code += `//${text.slice(i, end).match(/[a-z]*$/i)?.[0] ?? ''}`;
        i = end;
        continue;
      }
    }
    code += text[i];
    i += 1;
  }
  return { code, comment: comments.join(' ') };
}
