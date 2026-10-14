import { readFile } from 'node:fs/promises';
import { validateAgentReceipt, type ValidationResult } from '../spec/validate.js';

export interface ValidateOptions {
  /** Receipt file; '-' or undefined reads stdin. */
  file?: string;
  json?: boolean;
  readStdin: () => Promise<string>;
}

export interface ValidateRun {
  stdout: string;
  stderr: string;
  exitCode: 0 | 1 | 2;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Node's JSON.parse message quotes the input, which can span lines; keep the diagnostic to one line. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const asJson = (r: ValidationResult) => `${JSON.stringify(r, null, 2)}\n`;
/** Exit 2 with the message on stderr; with --json, also as a JSON result on stdout. */
const fatal = (message: string, json: boolean | undefined): ValidateRun => ({
  stdout: json ? asJson({ valid: false, errors: [{ path: '/', message }], warnings: [] }) : '',
  stderr: `trustbut: ${message}\n`,
  exitCode: 2,
});

/** `trustbut validate`: checks one receipt against agent receipts v1. Exit 0 valid, 1 invalid, 2 unreadable input. */
export async function runValidate(opts: ValidateOptions): Promise<ValidateRun> {
  const fromStdin = opts.file === undefined || opts.file === '-';
  let text: string;
  try {
    text = fromStdin ? await opts.readStdin() : await readFile(opts.file!, 'utf8');
  } catch (err) {
    return fatal(`couldn't read ${opts.file ?? 'stdin'}: ${(err as Error).message}`, opts.json);
  }
  if (!text.trim()) return fatal('no receipt given (pass a file, or pipe JSON on stdin)', opts.json);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return fatal(`${fromStdin ? 'stdin' : opts.file} is not valid JSON: ${oneLine((err as Error).message)}`, opts.json);
  }
  const checked = validateAgentReceipt(value);
  const exitCode = checked.valid ? 0 : 1;
  if (opts.json) return { stdout: asJson(checked), stderr: '', exitCode };
  const lines = [
    ...checked.errors.map((e) => `error: ${e.path}: ${e.message}`),
    ...checked.warnings.map((w) => `warning: ${w.path}: ${w.message}`),
    checked.valid
      ? checked.warnings.length ? `valid (${plural(checked.warnings.length, 'warning')})` : 'valid'
      : `invalid (${plural(checked.errors.length, 'error')})`,
  ];
  return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode };
}
