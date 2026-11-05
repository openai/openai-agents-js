// Schema validation shared by deferred declarations and their captured codecs.
import { z } from 'zod-deferred';
import * as core from 'zod-deferred/v4/core';
import type { JsonValue } from '../runtime/binding';

type Scalar = null | boolean | number | string;
type Direction = 'input' | 'result';
const parseOptions = { error: () => 'Invalid deferred JSON value' };
const defaults = new WeakMap<object, { inner: z.ZodType; value: Scalar }>();

/** Record an ordinary Zod scalar default for deterministic deferred input. */
export function deferredDefault<T extends z.ZodType<Scalar>>(
  schema: T,
  value: NoInfer<z.output<T>>,
): z.ZodDefault<T> {
  if (!isScalar(value)) fail();
  const wrapper = schema.default(value as core.util.NoUndefined<z.output<T>>);
  defaults.set(wrapper, { inner: schema, value });
  return wrapper;
}

function fail(): never {
  throw new TypeError('Unsupported deferred schema or non-lossless JSON value');
}
function isScalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      !Object.is(value, -0))
  );
}

// All three length checks use the module-shared _whenHasLength in Zod 4.6.7.
// Compare its identity; never call or inspect an application-supplied callback.
const lengthWhen = new core.$ZodCheckMinLength({
  check: 'min_length',
  minimum: 0,
})._zod.def.when;
const lengthChecks = new Map<unknown, string>([
  [core.$ZodCheckMinLength, 'min_length'],
  [core.$ZodCheckMaxLength, 'max_length'],
  [core.$ZodCheckLengthEquals, 'length_equals'],
]);
const numericChecks = new Map<unknown, string>([
  [core.$ZodCheckLessThan, 'less_than'],
  [core.$ZodCheckGreaterThan, 'greater_than'],
  [core.$ZodCheckMultipleOf, 'multiple_of'],
  [core.$ZodCheckNumberFormat, 'number_format'],
  [z.ZodNumberFormat, 'number_format'],
  [core.$ZodNumberFormat, 'number_format'],
]);
const stringChecks = new Map<unknown, string>([
  [core.$ZodCheckRegex, 'regex'],
  [core.$ZodCheckLowerCase, 'lowercase'],
  [core.$ZodCheckUpperCase, 'uppercase'],
  [core.$ZodCheckIncludes, 'includes'],
  [core.$ZodCheckStartsWith, 'starts_with'],
  [core.$ZodCheckEndsWith, 'ends_with'],
]);
const formats = new Map<unknown, string>([
  [z.ZodEmail, 'email'],
  [core.$ZodEmail, 'email'],
  [z.ZodUUID, 'uuid'],
  [core.$ZodUUID, 'uuid'],
  [z.ZodGUID, 'guid'],
  [core.$ZodGUID, 'guid'],
  [z.ZodISODate, 'date'],
  [core.$ZodISODate, 'date'],
  [z.ZodISODateTime, 'datetime'],
  [core.$ZodISODateTime, 'datetime'],
  [z.ZodISOTime, 'time'],
  [core.$ZodISOTime, 'time'],
  [z.ZodISODuration, 'duration'],
  [core.$ZodISODuration, 'duration'],
]);

// Access to the supported Zod version/layout stays in this visitor. These are
// trusted declarations, not a sandbox for proxies or modified parser internals.
function recognize(
  schema: core.$ZodType,
  direction: Direction,
  pendingDefaults: { inner: z.ZodType; value: Scalar }[],
  ancestors = new Set<core.$ZodType>(),
): void {
  const { major, minor, patch } = schema._zod.version;
  if (major !== 4 || minor !== 6 || patch !== 7 || ancestors.has(schema))
    fail();
  const def = schema._zod.def as core.$ZodTypes['_zod']['def'];
  definitionData(def, defaults.has(schema));
  if (('coerce' in def && def.coerce) || def.error !== undefined) fail();
  for (const check of [
    ...(schema._zod.traits.has('$ZodCheck')
      ? [schema as unknown as core.$ZodCheck]
      : []),
    ...dataArray(def.checks ?? []),
  ])
    recognizeCheck(check, def.type);
  ancestors.add(schema);
  const visit = (child: core.$ZodType) =>
    recognize(child, direction, pendingDefaults, ancestors);
  switch (def.type) {
    case 'object': {
      if (!def.catchall) fail();
      definitionData(def.catchall._zod.def);
      if (def.catchall._zod.def.type !== 'never') fail();
      // Declaration conversion must materialize shapes before codec admission.
      // Never read a fresh Zod shape getter: it may execute application fields.
      const shape = Object.getOwnPropertyDescriptor(def, 'shape');
      if (!shape || !('value' in shape)) fail();
      for (const key of Reflect.ownKeys(shape.value)) {
        const property = Object.getOwnPropertyDescriptor(shape.value, key)!;
        if (
          typeof key !== 'string' ||
          !property.enumerable ||
          !('value' in property)
        )
          fail();
        visit(property.value);
      }
      break;
    }
    case 'array':
      visit(def.element);
      break;
    case 'nullable':
      visit(def.innerType);
      break;
    case 'default': {
      const record = defaults.get(schema);
      if (direction !== 'input' || !record || record.inner !== def.innerType)
        fail();
      visit(record.inner);
      pendingDefaults.push(record);
      break;
    }
    case 'union':
      if (direction !== 'input' || !def.options.length) fail();
      dataArray(def.options).forEach(visit);
      break;
    case 'literal':
      if (direction !== 'input') fail();
      assertFiniteJson(def.values);
      if (!def.values.length || !def.values.every(isScalar)) fail();
      break;
    case 'enum':
      if (direction !== 'input') fail();
      assertFiniteJson(def.entries);
      if (!Object.values(def.entries).every(isScalar)) fail();
      break;
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
      break;
    default:
      fail();
  }
  ancestors.delete(schema);
}

// Zod retains caller-owned metadata arrays. Inspect every slot before traversal;
// reading an accessor again can run code even after manualTool construction.
function dataArray<T>(options: readonly T[]): T[] {
  if (
    !Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Array.prototype ||
    Reflect.ownKeys(options).length !== options.length + 1
  )
    fail();
  const values: T[] = [];
  for (let index = 0; index < options.length; index++) {
    const property = Object.getOwnPropertyDescriptor(options, String(index));
    if (!property || !property.enumerable || !('value' in property)) fail();
    values.push(property.value);
  }
  return values;
}

// Core constructors retain their definition object. Refuse accessors before any
// field read; only our exact recorded wrapper may keep its unread default getter.
function definitionData(def: object, recordedDefault = false): void {
  const prototype = Object.getPrototypeOf(def);
  if (prototype !== Object.prototype && prototype !== null) fail();
  for (const key of Reflect.ownKeys(def)) {
    const property = Object.getOwnPropertyDescriptor(def, key)!;
    if (!('value' in property) && !(recordedDefault && key === 'defaultValue'))
      fail();
  }
}

function recognizeCheck(check: core.$ZodCheck, type: string): void {
  const def = check._zod.def as core.$ZodChecks['_zod']['def'];
  definitionData(def);
  const ctor = (check._zod as core.$ZodCheck['_zod'] & { constr: unknown })
    .constr;
  const when = Object.getOwnPropertyDescriptor(def, 'when');
  if (def.error !== undefined || (when && !('value' in when))) fail();
  const length = lengthChecks.get(ctor);
  if (length) {
    if (
      !['string', 'array'].includes(type) ||
      def.check !== length ||
      when?.value !== lengthWhen
    )
      fail();
    const bound =
      'minimum' in def
        ? def.minimum
        : 'maximum' in def
          ? def.maximum
          : 'length' in def
            ? def.length
            : undefined;
    if (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound < 0)
      fail();
    return;
  }
  if (when?.value !== undefined) fail();
  const numeric = numericChecks.get(ctor);
  if (numeric) {
    if (type !== 'number' || def.check !== numeric) fail();
    if (def.check === 'number_format') {
      if (
        !['safeint', 'int32', 'uint32', 'float32', 'float64'].includes(
          def.format,
        )
      )
        fail();
    } else {
      if (
        !('value' in def) ||
        typeof def.value !== 'number' ||
        !Number.isFinite(def.value)
      )
        fail();
      if (def.check === 'multiple_of' && def.value <= 0) fail();
      if ('inclusive' in def && typeof def.inclusive !== 'boolean') fail();
    }
    return;
  }
  const format = formats.get(ctor) ?? stringChecks.get(ctor);
  if (
    type !== 'string' ||
    def.check !== 'string_format' ||
    def.format !== format ||
    !format
  )
    fail();
  if (
    def.pattern !== undefined &&
    (Object.getPrototypeOf(def.pattern) !== RegExp.prototype ||
      Reflect.ownKeys(def.pattern).some((key) => key !== 'lastIndex'))
  )
    fail();
  if (
    ('includes' in def && typeof def.includes !== 'string') ||
    ('prefix' in def && typeof def.prefix !== 'string') ||
    ('suffix' in def && typeof def.suffix !== 'string') ||
    ('position' in def &&
      def.position !== undefined &&
      (typeof def.position !== 'number' ||
        !Number.isSafeInteger(def.position) ||
        def.position < 0))
  )
    fail();
}

/** Reject values JSON.stringify would drop, normalize or serialize through code. */
function assertFiniteJson(
  value: unknown,
  ancestors = new Set<object>(),
): asserts value is JsonValue {
  if (isScalar(value)) return;
  if (typeof value !== 'object' || value === null || ancestors.has(value))
    fail();
  const array = Array.isArray(value);
  if (
    array
      ? Object.getPrototypeOf(value) !== Array.prototype
      : Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
  )
    fail();
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) fail();
  for (const key of keys) {
    if (array && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      typeof key !== 'string' ||
      !property.enumerable ||
      !('value' in property) ||
      (array &&
        (!/^(0|[1-9][0-9]*)$/.test(key) ||
          Number(key) >= (value as unknown[]).length))
    )
      fail();
    assertFiniteJson(property.value, ancestors);
  }
  ancestors.delete(value);
}

// Defaults may add fields; they must never hide or change a provider's fields,
// including when Zod selects the first matching branch of a closed union.
function preservesFields(original: JsonValue, parsed: JsonValue): boolean {
  if (original === null || typeof original !== 'object')
    return Object.is(original, parsed);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(original) !== Array.isArray(parsed)
  )
    return false;
  if (
    Array.isArray(original) &&
    original.length !== (parsed as JsonValue[]).length
  )
    return false;
  return Object.keys(original).every(
    (key) =>
      Object.hasOwn(parsed, key) &&
      preservesFields(
        (original as Record<string, JsonValue>)[key],
        (parsed as Record<string, JsonValue>)[key],
      ),
  );
}

/** Recognize both declarations before any validation of helper-recorded defaults. */
export function createDeferredCodec<P extends z.ZodType, R extends z.ZodType>(
  parameters: P,
  result: R,
) {
  const pendingDefaults: { inner: z.ZodType; value: Scalar }[] = [];
  recognize(parameters, 'input', pendingDefaults);
  recognize(result, 'result', pendingDefaults);
  for (const { inner, value } of pendingDefaults) {
    const checked = inner.parse(value, parseOptions);
    if (!Object.is(checked, value)) fail();
  }
  const parse = <T extends z.ZodType>(
    schema: T,
    value: unknown,
  ): z.output<T> => {
    assertFiniteJson(value);
    const parsed = schema.parse(value, parseOptions);
    assertFiniteJson(parsed);
    if (!preservesFields(value, parsed)) fail();
    return parsed;
  };
  return {
    parseInput: (value: unknown): z.output<P> => parse(parameters, value),
    parseResult: (value: unknown): z.output<R> => parse(result, value),
  };
}

/** Sort object keys only for input digests; arrays keep their original order. */
export function canonicalDeferredInput(value: unknown): string {
  assertFiniteJson(value);
  const sorted = (item: JsonValue): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return '[' + item.map(sorted).join(',') + ']';
    return (
      '{' +
      Object.keys(item)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + sorted(item[key]))
        .join(',') +
      '}'
    );
  };
  return sorted(value);
}
