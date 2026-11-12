import { copyJsonValue, type JsonObject } from './binding';
import type { ModelRequestContext } from './model-callbacks';

/** A provider-stored prompt reference. Variables remain detached JSON. */
export interface HostedPromptReference {
  readonly id: string;
  readonly version?: string;
  readonly variables?: Readonly<JsonObject>;
}

/** Resolved at the admitted model-context boundary, including native children. */
export type HostedPromptSource<Context = unknown> =
  | HostedPromptReference
  | ((
      context: ModelRequestContext<Context>,
    ) => HostedPromptReference | Promise<HostedPromptReference>);

/** @internal Capture references before returning control to caller code. */
export function captureHostedPromptReference(
  value: unknown,
): HostedPromptReference {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Expected a hosted prompt reference');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('Expected a plain hosted prompt reference');
  const captured = copyJsonValue(
    Object.fromEntries(
      Object.entries(value).filter(
        ([key, item]) =>
          item !== undefined || (key !== 'version' && key !== 'variables'),
      ),
    ),
  ) as JsonObject;
  if (typeof captured.id !== 'string' || !captured.id.trim())
    throw new TypeError('A hosted prompt requires a nonempty id');
  if (captured.version !== undefined && typeof captured.version !== 'string')
    throw new TypeError('Hosted prompt version must be a string');
  if (
    captured.variables !== undefined &&
    (!captured.variables ||
      typeof captured.variables !== 'object' ||
      Array.isArray(captured.variables))
  )
    throw new TypeError('Hosted prompt variables must be a JSON object');
  if (
    Object.keys(captured).some(
      (key) => !['id', 'version', 'variables'].includes(key),
    )
  )
    throw new TypeError('Unknown hosted prompt reference field');
  return captured as unknown as HostedPromptReference;
}

/** @internal Callables remain on the existing captured declaration owner. */
export function captureHostedPromptSource<Context>(
  source: HostedPromptSource<Context> | undefined,
): HostedPromptSource<Context> | undefined {
  return source === undefined || typeof source === 'function'
    ? source
    : captureHostedPromptReference(source);
}

/** @internal Presence belongs to the captured declaration, not resolved defaults. */
export function hostedPromptControls<Context>(
  source: HostedPromptSource<Context> | undefined,
  declaration: {
    model?: string;
    instructions?: string;
    toolsProvided: boolean;
    extraBody?: Readonly<JsonObject> | null;
  },
): JsonObject | undefined {
  if (source === undefined) return undefined;
  if (declaration.extraBody && Object.hasOwn(declaration.extraBody, 'prompt'))
    throw new TypeError(
      'hostedPrompt conflicts with modelSettings.extraBody.prompt',
    );
  const captured = captureHostedPromptSource(source)!;
  return {
    ...(typeof captured === 'function'
      ? {}
      : { reference: copyJsonValue(captured) }),
    omit_model: declaration.model === undefined,
    omit_instructions: declaration.instructions === undefined,
    omit_tools: !declaration.toolsProvided,
  };
}
