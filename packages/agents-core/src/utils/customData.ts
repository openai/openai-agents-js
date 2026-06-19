import { UserError } from '../errors';

export type ToolOutputCustomData = Record<string, unknown>;

export type MaybePromise<T> = T | Promise<T>;

export type ToolOutputCustomDataExtractor<TContext> = (
  context: TContext,
) => MaybePromise<ToolOutputCustomData | null | undefined>;

export function normalizeToolOutputCustomData(
  value: ToolOutputCustomData | null | undefined,
): ToolOutputCustomData | undefined {
  if (value == null) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new UserError('customDataExtractor must return an object or null.');
  }

  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) {
    throw new UserError(
      'customDataExtractor must return an object with string keys.',
    );
  }

  if (Object.keys(value).length === 0) {
    return undefined;
  }

  assertJsonCompatible(value, 'customDataExtractor result');
  return JSON.parse(JSON.stringify(value)) as ToolOutputCustomData;
}

export async function maybeExtractToolOutputCustomData<TContext>(
  extractor: ToolOutputCustomDataExtractor<TContext> | undefined,
  context: TContext,
): Promise<ToolOutputCustomData | undefined> {
  if (!extractor) {
    return undefined;
  }

  return normalizeToolOutputCustomData(await extractor(context));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function assertJsonCompatible(value: unknown, path: string): void {
  if (value == null) {
    return;
  }

  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'boolean') {
    return;
  }
  if (valueType === 'number') {
    if (!Number.isFinite(value)) {
      throw new UserError(
        'customDataExtractor must return JSON-compatible data.',
      );
    }
    return;
  }
  if (
    valueType === 'undefined' ||
    valueType === 'function' ||
    valueType === 'symbol' ||
    valueType === 'bigint'
  ) {
    throw new UserError(
      'customDataExtractor must return JSON-compatible data.',
    );
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertJsonCompatible(entry, `${path}[${index}]`),
    );
    return;
  }

  if (!isRecord(value)) {
    throw new UserError(
      'customDataExtractor must return JSON-compatible data.',
    );
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new UserError(
        'customDataExtractor must return JSON-compatible data.',
      );
    }
    assertJsonCompatible(value[key], `${path}.${key}`);
  }
}
