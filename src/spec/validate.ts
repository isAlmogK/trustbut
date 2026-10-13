import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import schema from '../../spec/agent-receipt-v1.schema.json' with { type: 'json' };
import { CORE_FINDINGS, isCoreFindingId } from './catalog.js';

export interface ValidationProblem {
  /** JSON Pointer to the offending value; '/' is the receipt itself. */
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationProblem[];
  warnings: ValidationProblem[];
}

const ID_MESSAGE = 'must be a core finding id or a namespaced id (<namespace>/<id>)';
const FINDING_ID_PATH = /^\/findings\/\d+\/id$/;

const checkSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function describe(e: ErrorObject): string {
  if (e.keyword === 'required') return `must have required property '${(e.params as { missingProperty: string }).missingProperty}'`;
  if (e.keyword === 'additionalProperties') return `must not have additional property '${(e.params as { additionalProperty: string }).additionalProperty}'`;
  return e.message ?? e.keyword;
}

/** ajv errors as problems: one message per bad finding id instead of the enum/pattern/anyOf triple, no duplicates. */
function schemaProblems(errors: ErrorObject[]): ValidationProblem[] {
  const idPaths = new Set(errors.filter((e) => e.keyword === 'anyOf' && FINDING_ID_PATH.test(e.instancePath)).map((e) => e.instancePath));
  const seen = new Set<string>();
  const out: ValidationProblem[] = [];
  for (const e of errors) {
    if (idPaths.has(e.instancePath) && e.keyword !== 'anyOf') continue;
    const problem = { path: e.instancePath || '/', message: idPaths.has(e.instancePath) ? ID_MESSAGE : describe(e) };
    const key = `${problem.path}\n${problem.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(problem);
    }
  }
  return out;
}

interface CheckedFinding {
  id: string;
  severity: 'fail' | 'warn' | 'info';
}

/** Checks a parsed receipt against agent receipts v1: the JSON Schema, then the verdict rule; non-default core severities are warnings. */
export function validateAgentReceipt(value: unknown): ValidationResult {
  if (!checkSchema(value)) return { valid: false, errors: schemaProblems(checkSchema.errors ?? []), warnings: [] };
  const receipt = value as { verdict: string; findings: CheckedFinding[] };
  const errors: ValidationProblem[] = [];
  const expected = receipt.findings.some((f) => f.severity === 'fail') ? 'fail' : receipt.findings.some((f) => f.severity === 'warn') ? 'warn' : 'pass';
  if (receipt.verdict !== expected) errors.push({ path: '/verdict', message: `must be '${expected}' for these findings (got '${receipt.verdict}')` });
  const warnings = receipt.findings.flatMap((f, i) =>
    isCoreFindingId(f.id) && f.severity !== CORE_FINDINGS[f.id]
      ? [{ path: `/findings/${i}/severity`, message: `'${f.id}' has default severity '${CORE_FINDINGS[f.id]}' (got '${f.severity}')` }]
      : [],
  );
  return { valid: errors.length === 0, errors, warnings };
}
