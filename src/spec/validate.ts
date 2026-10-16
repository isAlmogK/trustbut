import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import schema from '../../spec/agent-receipt-v1.schema.json' with { type: 'json' };
import { CORE_FINDINGS, CORE_FINDING_SINCE, isCoreFindingId } from './catalog.js';
import { SPEC_VERSION } from './types.js';

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

let compiled: ValidateFunction | undefined;
/** The schema validator, compiled on first use: compiling costs ~100 ms that commands other than validate shouldn't pay. */
const schemaValidator = (): ValidateFunction => (compiled ??= new Ajv2020({ allErrors: true, strict: true }).compile(schema));

function describe(e: ErrorObject): string {
  if (e.keyword === 'required') return `must have required property '${(e.params as { missingProperty: string }).missingProperty}'`;
  if (e.keyword === 'additionalProperties') return `must not have additional property '${(e.params as { additionalProperty: string }).additionalProperty}'`;
  return e.message ?? e.keyword;
}

interface SchemaProblem extends ValidationProblem {
  /** The unknown property, for an additionalProperties error. */
  unknownProperty?: string;
  /** A collapsed finding-id error. */
  findingId?: boolean;
}

/** ajv errors as problems: one message per bad finding id instead of the enum/pattern/anyOf triple, no duplicates. */
function schemaProblems(errors: ErrorObject[]): SchemaProblem[] {
  const idPaths = new Set(errors.filter((e) => e.keyword === 'anyOf' && FINDING_ID_PATH.test(e.instancePath)).map((e) => e.instancePath));
  const seen = new Set<string>();
  const out: SchemaProblem[] = [];
  for (const e of errors) {
    if (idPaths.has(e.instancePath) && e.keyword !== 'anyOf') continue;
    const isId = idPaths.has(e.instancePath);
    const problem: SchemaProblem = { path: e.instancePath || '/', message: isId ? ID_MESSAGE : describe(e) };
    if (isId) problem.findingId = true;
    if (e.keyword === 'additionalProperties') problem.unknownProperty = (e.params as { additionalProperty: string }).additionalProperty;
    const key = `${problem.path}\n${problem.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(problem);
    }
  }
  return out;
}

const MINOR = /^1\.(\d+)$/;
/** The newest spec minor this validator knows (`1.1` → 1). */
const KNOWN_MINOR = Number(SPEC_VERSION.split('.')[1]);
/** The shape of a core id (`test-focused`): a newer minor's core ids have it too; anything else is malformed. */
const CORE_ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

/** The 1.x minor a receipt declares, or undefined when it declares none. */
function declaredMinor(value: unknown): number | undefined {
  const version = typeof value === 'object' && value !== null ? (value as { specVersion?: unknown }).specVersion : undefined;
  const match = typeof version === 'string' ? MINOR.exec(version) : null;
  return match ? Number(match[1]) : undefined;
}

/** Whether the receipt declares a 1.x minor newer than this validator knows. */
function isNewerMinor(value: unknown): boolean {
  const minor = declaredMinor(value);
  return minor !== undefined && minor > KNOWN_MINOR;
}

/** The finding id at a `/findings/N/id` path. */
function findingIdAt(value: unknown, path: string): unknown {
  const index = Number(path.split('/')[2]);
  return (value as { findings: { id?: unknown }[] }).findings[index]?.id;
}

/**
 * For a newer 1.x receipt, the problems this validator can't judge become warnings:
 * unknown fields, and unknown ids shaped like a core id (they may be newer core ids).
 * A malformed id (`Not_Valid`, `Acme/leak`) is an error in every version.
 */
function splitForNewerMinor(value: unknown, problems: SchemaProblem[]): { errors: ValidationProblem[]; warnings: ValidationProblem[] } {
  const errors: ValidationProblem[] = [];
  const warnings: ValidationProblem[] = [];
  for (const p of problems) {
    const id = p.findingId ? findingIdAt(value, p.path) : undefined;
    if (p.unknownProperty !== undefined) {
      warnings.push({ path: p.path, message: `unknown in spec ${SPEC_VERSION}: '${p.unknownProperty}' (allowed for a newer 1.x receipt)` });
    } else if (typeof id === 'string' && CORE_ID_SHAPE.test(id)) {
      warnings.push({ path: p.path, message: `'${id}' is not a ${SPEC_VERSION} core id (allowed for a newer 1.x receipt)` });
    } else {
      errors.push({ path: p.path, message: p.message });
    }
  }
  return { errors, warnings };
}

const plain = ({ path, message }: ValidationProblem): ValidationProblem => ({ path, message });

interface CheckedFinding {
  id: string;
  severity: 'fail' | 'warn' | 'info';
}

/**
 * Checks a parsed receipt against agent receipts v1: the JSON Schema, then the verdict rule; non-default core severities are warnings.
 * A receipt declaring a newer 1.x minor may carry fields and core ids unknown to this validator; those are warnings, not errors.
 */
export function validateAgentReceipt(value: unknown): ValidationResult {
  const warnings: ValidationProblem[] = [];
  const checkSchema = schemaValidator();
  if (!checkSchema(value)) {
    const problems = schemaProblems(checkSchema.errors ?? []);
    if (!isNewerMinor(value)) return { valid: false, errors: problems.map(plain), warnings: [] };
    const split = splitForNewerMinor(value, problems);
    if (split.errors.length) return { valid: false, ...split };
    warnings.push(...split.warnings);
  }
  const receipt = value as { verdict: string; findings: CheckedFinding[] };
  const errors: ValidationProblem[] = [];
  const minor = declaredMinor(value) ?? 0;
  receipt.findings.forEach((f, i) => {
    const since = isCoreFindingId(f.id) ? CORE_FINDING_SINCE[f.id] : undefined;
    if (since !== undefined && since > minor) {
      errors.push({ path: `/findings/${i}/id`, message: `'${f.id}' is a core id since 1.${since} (the receipt declares 1.${minor})` });
    }
  });
  const expected = receipt.findings.some((f) => f.severity === 'fail') ? 'fail' : receipt.findings.some((f) => f.severity === 'warn') ? 'warn' : 'pass';
  if (receipt.verdict !== expected) errors.push({ path: '/verdict', message: `must be '${expected}' for these findings (got '${receipt.verdict}')` });
  receipt.findings.forEach((f, i) => {
    if (isCoreFindingId(f.id) && f.severity !== CORE_FINDINGS[f.id]) {
      warnings.push({ path: `/findings/${i}/severity`, message: `'${f.id}' has default severity '${CORE_FINDINGS[f.id]}' (got '${f.severity}')` });
    }
  });
  return { valid: errors.length === 0, errors, warnings };
}
