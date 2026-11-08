import { z } from 'zod';
export type { Engine, NativeThread } from '../../native/index.js';

declare global {
  interface JSON {
    rawJSON(text: string): { readonly rawJSON: string };
  }
}

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
export const jsonObject = z.record(z.string(), jsonValue);
export type JsonObject = z.infer<typeof jsonObject>;

/** @internal Copy finite JSON own values; aliases are data, ancestry cycles are invalid. */
export function copyJsonValue(
  value: unknown,
  parents = new Set<object>(),
): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null)
    throw new TypeError('Expected a finite JSON value');
  if (parents.has(value)) throw new TypeError('Cannot copy cyclic JSON');
  const array = Array.isArray(value);
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new TypeError('Expected a plain JSON object');
  parents.add(value);
  try {
    if (array) {
      const copied: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index))
          throw new TypeError('Expected a dense JSON array');
        copied.push(copyJsonValue(value[index], parents));
      }
      return copied;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        copyJsonValue(item, parents),
      ]),
    );
  } finally {
    parents.delete(value);
  }
}

/** @internal Validate JSON values while preserving every own key without setters. */
export const losslessJsonValueSchema: z.ZodType<JsonValue> = z
  .unknown()
  .transform((value, ctx) => {
    try {
      return copyJsonValue(value);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Invalid JSON value',
      });
      return z.NEVER;
    }
  });
/** @internal Validate plain JSON objects while preserving safe own properties. */
export const losslessJsonObjectSchema: z.ZodType<JsonObject> =
  losslessJsonValueSchema.transform((value, ctx) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      ctx.addIssue({ code: 'custom', message: 'Expected a JSON object' });
      return z.NEVER;
    }
    return value;
  });

/** @internal Canonical positive u64 IDs belong to VM cells, not stored JSON names. */
export const isCellNumber = (value: string) =>
  value.length <= 20 &&
  /^[1-9][0-9]*$/.test(value) &&
  BigInt(value) <= 18446744073709551615n &&
  BigInt(value).toString() === value;

/** @internal Check raw keys before record normalization can discard them. */
export const codeModeCellKeysSchema = z.unknown().superRefine((value, ctx) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return;
  for (const id of Object.keys(value)) {
    if (!isCellNumber(id))
      ctx.addIssue({
        code: 'custom',
        path: [id],
        message: 'Invalid retained cell ID',
      });
  }
});

function checkpointPayload(value: unknown): unknown {
  return typeof value === 'object' &&
    value !== null &&
    'checkpoint' in value &&
    'manual_continuation' in value
    ? value.checkpoint
    : value;
}
function checkpointCodeStates(value: unknown): Record<string, unknown>[] {
  const checkpoint = checkpointPayload(value);
  if (
    typeof checkpoint !== 'object' ||
    checkpoint === null ||
    !('codex_revision' in checkpoint) ||
    !('source_session_id' in checkpoint)
  )
    return [];
  const states: unknown[] = [];
  if ('root_code_mode' in checkpoint) states.push(checkpoint.root_code_mode);
  if ('descendants' in checkpoint && Array.isArray(checkpoint.descendants)) {
    for (const child of checkpoint.descendants) {
      if (typeof child === 'object' && child !== null && 'code_mode' in child)
        states.push(child.code_mode);
    }
  }
  return states.filter(
    (state): state is Record<string, unknown> =>
      typeof state === 'object' && state !== null && !Array.isArray(state),
  );
}

export async function binding() {
  // The loader is shipped as CommonJS, rather than emitted by tsc-multi in each dist format.
  const loader = '../../native/index.js';
  const { default: native }: typeof import('../../native/index.js') =
    await import(loader);
  return native;
}
export function decode<T>(schema: z.ZodType<T>, source: string): T {
  return schema.parse(JSON.parse(source));
}
export function encode(value: unknown): string {
  return JSON.stringify(jsonValue.parse(value));
}

// Convert only an authority's exact integer token; never return a rounded JS number.
export function parseNative(source: string): unknown {
  const tokens = new WeakMap<object, Map<string, string>>();
  const parsed: unknown = JSON.parse(
    source,
    function (
      this: object,
      key: string,
      value: unknown,
      context?: { source?: string },
    ) {
      if (
        (key === 'generation' ||
          key === 'nonce' ||
          key === 'cancel' ||
          key === 'old_nonce' ||
          key === 'delivery' ||
          key === 'subagent_instance_id' ||
          key === 'admitted' ||
          key === 'limit' ||
          key === 'next_cell_id' ||
          key === 'profile_epoch' ||
          key === 'epoch') &&
        typeof value === 'number'
      ) {
        const original = context?.source;
        const fields = tokens.get(this) ?? new Map<string, string>();
        fields.set(key, original ?? '');
        tokens.set(this, fields);
      }
      return value;
    },
  );
  function restore(receipt: unknown, key: string): void {
    if (typeof receipt !== 'object' || receipt === null) return;
    const original = tokens.get(receipt)?.get(key);
    if (original !== undefined) {
      if (!/^(0|[1-9][0-9]*)$/.test(original)) {
        throw new TypeError(
          'Invalid native receipt integer or missing Node.js JSON source access',
        );
      }
      Reflect.set(receipt, key, original);
    }
  }
  // These are native envelope fields. Data inside arguments/output is application JSON.
  restore(parsed, 'nonce');
  restore(parsed, 'cancel');
  restore(parsed, 'old_nonce');
  restore(parsed, 'generation');
  restore(parsed, 'delivery');
  restore(parsed, 'subagent_instance_id');
  restore(parsed, 'profile_epoch');
  const checkpoint = checkpointPayload(parsed);
  if (
    typeof checkpoint === 'object' &&
    checkpoint !== null &&
    'root_turn_budget' in checkpoint
  ) {
    restore(checkpoint.root_turn_budget, 'admitted');
    restore(checkpoint.root_turn_budget, 'limit');
  }
  for (const state of checkpointCodeStates(parsed))
    restore(state, 'next_cell_id');
  if (typeof parsed === 'object' && parsed !== null && 'msg' in parsed) {
    const msg = parsed.msg;
    restore(msg, 'profile_epoch');
    if (typeof msg === 'object' && msg !== null && '_sdk_python_tool' in msg) {
      restore(msg._sdk_python_tool, 'generation');
      restore(msg._sdk_python_tool, 'profile_epoch');
    }
  }
  if (typeof parsed === 'object' && parsed !== null && 'msg' in parsed) {
    const msg = parsed.msg;
    if (
      msg &&
      typeof msg === 'object' &&
      'type' in msg &&
      msg.type === 'realtime_conversation_realtime' &&
      'payload' in msg &&
      msg.payload &&
      typeof msg.payload === 'object'
    ) {
      for (const [kind, value] of Object.entries(msg.payload)) {
        if (value && typeof value === 'object' && 'profile_receipt' in value)
          restore(value.profile_receipt, 'epoch');
        if (
          kind === 'FunctionBatchFinished' &&
          value &&
          typeof value === 'object' &&
          'target' in value
        )
          restore(value.target, 'epoch');
      }
    }
  }
  return parsed;
}

/** Private operation selections use string catalog IDs and a numeric source epoch. */
export function encodeOperationSelection(value: unknown): string {
  const dto = jsonObject.parse(value);
  const source = dto.operation_declaration_source;
  return JSON.stringify(dto, function (key, item: unknown) {
    if (this === source && key === 'epoch' && typeof item === 'string') {
      if (!/^(0|[1-9][0-9]*)$/.test(item))
        throw new TypeError('Invalid native source epoch');
      return JSON.rawJSON(item);
    }
    return item;
  });
}

export function encodeReceipt(value: unknown): string {
  const originals = checkpointCodeStates(value);
  for (const state of originals)
    codeModeCellKeysSchema.parse(state.completed_cells);
  // Validate before the generic normalizer can recurse into a cyclic stored value.
  const storedValues = originals.map((state) =>
    Object.hasOwn(state, 'stored_values')
      ? losslessJsonObjectSchema.parse(state.stored_values)
      : undefined,
  );
  const validated = jsonObject.parse(value);
  // Recover only VM JSON from the original input after envelope normalization.
  const states = checkpointCodeStates(validated);
  for (const [index, state] of states.entries()) {
    const stored = storedValues[index];
    if (stored !== undefined) state.stored_values = stored;
  }
  const codeStates = new Set<object>(states);
  const checkpoint = checkpointPayload(validated);
  const budget =
    typeof checkpoint === 'object' &&
    checkpoint !== null &&
    'root_turn_budget' in checkpoint
      ? checkpoint.root_turn_budget
      : undefined;
  const selection = validated.selection;
  const declarationSource =
    selection && typeof selection === 'object' && !Array.isArray(selection)
      ? selection.operation_declaration_source
      : undefined;
  const request = validated.request;
  const marker =
    typeof request === 'object' && request !== null && !Array.isArray(request)
      ? request._sdk_python_tool
      : validated._sdk_python_tool;
  return JSON.stringify(
    validated,
    function (this: object, key: string, item: unknown) {
      if (
        (((this === validated || this === marker) &&
          (key === 'generation' ||
            key === 'nonce' ||
            key === 'old_nonce' ||
            key === 'delivery' ||
            key === 'subagent_instance_id' ||
            key === 'profile_epoch')) ||
          (this === declarationSource && key === 'epoch') ||
          (this === budget && (key === 'admitted' || key === 'limit')) ||
          (codeStates.has(this) && key === 'next_cell_id')) &&
        typeof item === 'string'
      ) {
        if (!/^(0|[1-9][0-9]*)$/.test(item))
          throw new TypeError('Invalid native receipt ID');
        return JSON.rawJSON(item);
      }
      return item;
    },
  );
}
