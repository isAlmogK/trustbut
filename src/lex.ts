// A per-line lexer for static checks. It does not see surrounding lines, so it cannot know
// whether a line sits inside a multi-line string or block comment; it handles the common cases.

export type Lang = 'js' | 'py';

export interface SplitLine {
  /** The line with the contents of string, template and regex literals removed (delimiters kept), comments removed. */
  code: string;
  /** Comment text on the line, including its marker. Several comments are joined with a space. */
  comment: string;
}

const JS_FILE = /\.[cm]?[jt]sx?$/;

export const isJsFile = (path: string): boolean => JS_FILE.test(path);
export const isPyFile = (path: string): boolean => path.endsWith('.py');
/** Lexing rules for a file: Python for .py, C-style for everything else. */
export const langOf = (path: string): Lang => (isPyFile(path) ? 'py' : 'js');

export function splitLine(text: string, lang: Lang): SplitLine {
  return lang === 'py' ? splitPy(text) : splitJs(text);
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

// Continuation lines of a block comment (`* text`, `*/`).
const BLOCK_CONTINUATION = /^\*(?:\s|\/|$)/;

function splitJs(text: string): SplitLine {
  const trimmed = text.trimStart();
  if (BLOCK_CONTINUATION.test(trimmed)) return { code: '', comment: trimmed };

  let code = '';
  const comments: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      comments.push(text.slice(i));
      break;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) {
        comments.push(text.slice(i));
        break;
      }
      comments.push(text.slice(i, end + 2));
      code += ' ';
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      code += ch + ch;
      i = skipQuoted(text, i + 1, ch);
      continue;
    }
    if (ch === '/' && regexAllowed(code)) {
      const end = skipRegex(text, i);
      if (end > 0) {
        code += `//${text.slice(i, end).match(/[a-z]*$/i)?.[0] ?? ''}`;
        i = end;
        continue;
      }
    }
    code += ch;
    i += 1;
  }
  return { code, comment: comments.join(' ') };
}

function splitPy(text: string): SplitLine {
  let code = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '#') return { code, comment: text.slice(i) };
    if (ch === '"' || ch === "'") {
      const quote = text.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      code += quote + quote;
      i = skipQuoted(text, i + quote.length, quote);
      continue;
    }
    code += ch;
    i += 1;
  }
  return { code, comment: '' };
}
