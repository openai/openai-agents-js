import { z } from 'zod';
import { losslessJsonValueSchema, type JsonValue } from './binding';

/** Sampling presentation only; executable declarations keep their original authority. */
export interface PreparedToolPresentation {
  readonly namespace: string | null;
  readonly name: string;
  readonly kind: 'function';
  readonly strict: boolean;
  readonly deferLoading: boolean | null;
  description: string;
  parameters: { [key: string]: JsonValue };
}
/** Native Responses input items; optional values use native omission, not null. */
export interface PreparedRequestData {
  instructions: string;
  input: JsonValue[];
  tools: PreparedToolPresentation[];
}
const toolSchema = z
  .object({
    namespace: z.string().nullable(),
    name: z.string(),
    kind: z.literal('function'),
    strict: z.boolean(),
    deferLoading: z.boolean().nullable(),
    description: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  })
  .strict();
const requestSchema = z
  .object({
    instructions: z.string(),
    input: z.array(z.unknown()),
    tools: z.array(toolSchema),
  })
  .strict();

/** Validate own keys before mapping so undefined-valued unknown fields cannot vanish. */
function ownKeys(value: unknown, keys: readonly string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Expected a prepared request object');
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || !keys.includes(key),
    )
  )
    throw new TypeError('Unknown prepared request field');
}
export function capturePreparedRequest(value: unknown): string {
  ownKeys(value, ['instructions', 'input', 'tools']);
  const tools = (value as PreparedRequestData).tools;
  if (!Array.isArray(tools)) throw new TypeError('Expected prepared tools');
  for (const tool of tools)
    ownKeys(tool, [
      'namespace',
      'name',
      'kind',
      'strict',
      'deferLoading',
      'description',
      'parameters',
    ]);
  // Copy first: schema parsing alone can drop undefined/non-JSON nested values.
  const captured = requestSchema.parse(
    losslessJsonValueSchema.parse(value),
  ) as PreparedRequestData;
  return JSON.stringify({
    ...captured,
    tools: captured.tools.map(({ deferLoading, ...tool }) => ({
      ...tool,
      defer_loading: deferLoading,
    })),
  });
}
export function preparedRequestFromNative(value: unknown): PreparedRequestData {
  const captured = losslessJsonValueSchema.parse(value) as unknown as {
    instructions: string;
    input: JsonValue[];
    tools: (Omit<PreparedToolPresentation, 'deferLoading'> & {
      defer_loading: boolean | null;
    })[];
  };
  return {
    ...captured,
    tools: captured.tools.map(({ defer_loading, ...tool }) => ({
      ...tool,
      deferLoading: defer_loading,
    })),
  };
}
