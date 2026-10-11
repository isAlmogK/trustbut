// A per-line lexer for static checks, driven by a language's comment and string syntax. It does
// not see surrounding lines, so it cannot know whether a line sits inside a multi-line string or
// block comment; it handles the common cases.

import { languageById } from './languages/index.js';
import type { Language } from './languages/types.js';

export interface SplitLine {
  /** The line with the contents of string (and regex) literals removed (delimiters kept), comments removed. */
  code: string;
  /** Comment text on the line, including its marker. Several comments are joined with a space. */
  comment: string;
}

/** Index just past the closing `quote` starting the search at `from`, or the line length if unterminated. */
function skipQuoted(text: string, from: number, quote: string): number {
  let j = from;
  while (j < text.length) {
    if (text[j] === '\\') j += 2;
    else if (text.startsWith(quote, j)) return j + quote.length;
    else j += 1;
  }
  return text.length;
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
  const { line: lineMarkers, block } = lang.comments;
  const trimmed = text.trimStart();
  if (block?.[0] === '/*' && BLOCK_CONTINUATION.test(trimmed)) return { code: '', comment: trimmed };

  let code = '';
  const comments: string[] = [];
  let i = 0;
  while (i < text.length) {
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
    const quote = lang.strings.find((q) => text.startsWith(q, i));
    if (quote) {
      code += quote + quote;
      i = skipQuoted(text, i + quote.length, quote);
      continue;
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
