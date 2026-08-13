import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
  StandardTypedV1,
} from '@standard-schema/spec';
import { UserError } from '../errors';

/** A Standard Schema that supports validation and JSON Schema conversion. */
export interface StandardSchemaWithJSON<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output> &
    StandardJSONSchemaV1.Props<Input, Output>;
}

export type StandardSchemaOutput<T extends StandardTypedV1> =
  StandardTypedV1.InferOutput<T>;

const asyncStandardSchemaValidationErrors = new WeakSet<object>();

/** @internal */
export class AsyncStandardSchemaValidationError extends UserError {
  constructor(message: string) {
    super(message);
    asyncStandardSchemaValidationErrors.add(this);
  }
}

/** @internal */
export function isAsyncStandardSchemaValidationError(
  error: unknown,
): error is AsyncStandardSchemaValidationError {
  return (
    (typeof error === 'object' || typeof error === 'function') &&
    error !== null &&
    asyncStandardSchemaValidationErrors.has(error)
  );
}

export function hasStandardSchemaMarker(schema: unknown): boolean {
  try {
    return (
      (typeof schema === 'object' || typeof schema === 'function') &&
      schema !== null &&
      '~standard' in schema
    );
  } catch {
    return false;
  }
}

export function isStandardSchemaWithJSON(
  schema: unknown,
): schema is StandardSchemaWithJSON {
  try {
    if (!hasStandardSchemaMarker(schema)) {
      return false;
    }
    const standard = (schema as Partial<StandardSchemaWithJSON>)['~standard'];
    return (
      standard?.version === 1 &&
      typeof standard.validate === 'function' &&
      typeof standard.jsonSchema?.input === 'function' &&
      typeof standard.jsonSchema?.output === 'function'
    );
  } catch {
    return false;
  }
}

export function unsupportedStandardSchemaError(): UserError {
  return new UserError(
    'Standard Schema values must provide both `~standard.validate` and `~standard.jsonSchema` conversion. Upgrade the schema library or use its Standard JSON Schema adapter.',
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function standardSchemaToJsonSchema(
  schema: StandardSchemaWithJSON,
  io: 'input' | 'output',
): Record<string, unknown> {
  try {
    return schema['~standard'].jsonSchema[io]({ target: 'draft-2020-12' });
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    throw new UserError(
      `Unable to convert the provided Standard Schema to JSON Schema.${detail}`,
    );
  }
}

export function assertStandardSchemaObjectRoot(
  schema: Record<string, unknown>,
  surface: string,
): void {
  if (schema.type !== 'object') {
    throw new UserError(
      `${surface} Standard Schema must produce a JSON Schema with \`type: "object"\` at the root. Wrap the schema in an object schema.`,
    );
  }
}

function formatIssue(issue: StandardSchemaV1.Issue): string {
  const path = issue.path
    ?.map((segment) =>
      String(
        typeof segment === 'object' && segment !== null ? segment.key : segment,
      ),
    )
    .join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

function validationError(issues: ReadonlyArray<StandardSchemaV1.Issue>): Error {
  return new Error(issues.map(formatIssue).join(', '));
}

export function validateStandardSchema<T extends StandardSchemaWithJSON>(
  schema: T,
  value: unknown,
): StandardSchemaOutput<T> {
  const result = schema['~standard'].validate(value);
  if (isPromiseLike(result)) {
    void Promise.resolve(result).catch(() => {});
    throw new AsyncStandardSchemaValidationError(
      'Standard Schema validation returned a Promise. Async Standard Schema validation is not supported.',
    );
  }
  if (result.issues) {
    throw validationError(result.issues);
  }
  return result.value as StandardSchemaOutput<T>;
}
