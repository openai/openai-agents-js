import { abortable } from '../voice/abortable';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { Agent } from './public-agent';
import { tool, toolRef, type ToolRef, type FunctionTool } from './tools';
import { copyJsonValue, type JsonObject } from './binding';
import {
  serializeRealtimeSettings,
  type NativeRealtimePrompt,
} from './realtime-settings';
import type { NativeRealtimeOutputGuardrail } from './realtime-guardrails';

export interface RealtimeAgentContext<Context = unknown> {
  readonly context: Context;
  readonly signal?: AbortSignal;
  readonly agent: Agent<Context, any>;
}
export interface RealtimeAgentConfig<Context = unknown> {
  readonly instructions?:
    | string
    | ((context: RealtimeAgentContext<Context>) => string | Promise<string>);
  readonly prompt?: NativeRealtimePrompt;
  readonly outputGuardrails?: readonly NativeRealtimeOutputGuardrail[];
  readonly toolEnabled?: (
    context: RealtimeAgentContext<Context>,
    tool: ToolRef,
  ) => boolean | Promise<boolean>;
}
const handoffBrand = Symbol('native Realtime handoff');
export interface RealtimeHandoff<Context = unknown> {
  readonly [handoffBrand]: true;
  readonly agent: Agent<Context, any>;
  readonly name?: string;
  readonly description?: string;
  readonly parameters?: z.ZodType;
  readonly onHandoff?: (
    context: RealtimeAgentContext<Context>,
    input: any,
  ) => unknown | Promise<unknown>;
  readonly isEnabled:
    | boolean
    | ((context: RealtimeAgentContext<Context>) => boolean | Promise<boolean>);
}
export function realtimeHandoff<
  Context,
  T extends z.ZodType = z.ZodObject<Record<string, never>>,
>(
  agent: Agent<Context, any>,
  options: {
    name?: string;
    description?: string;
    parameters?: T;
    onHandoff?: (
      context: RealtimeAgentContext<Context>,
      input: z.output<T>,
    ) => unknown | Promise<unknown>;
    isEnabled?:
      | boolean
      | ((
          context: RealtimeAgentContext<Context>,
        ) => boolean | Promise<boolean>);
  } = {},
): RealtimeHandoff<Context> {
  if (!(agent instanceof Agent))
    throw new TypeError('Realtime handoff target must be a native Agent');
  if (options.name !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(options.name))
    throw new TypeError(
      'Realtime handoff name requires 1 to 64 letters, digits, underscores or hyphens',
    );
  if (
    options.description !== undefined &&
    typeof options.description !== 'string'
  )
    throw new TypeError('Realtime handoff description must be a string');
  if (
    options.parameters !== undefined &&
    (!(options.parameters instanceof z.ZodType) || !options.onHandoff)
  )
    throw new TypeError(
      'Realtime handoff parameters require a Zod schema and onHandoff',
    );
  if (
    options.parameters !== undefined &&
    z.toJSONSchema(options.parameters).type !== 'object'
  )
    throw new TypeError('Realtime handoff parameters must describe an object');
  if (
    options.onHandoff !== undefined &&
    typeof options.onHandoff !== 'function'
  )
    throw new TypeError('Realtime onHandoff must be callable');
  if (
    options.isEnabled !== undefined &&
    typeof options.isEnabled !== 'boolean' &&
    typeof options.isEnabled !== 'function'
  )
    throw new TypeError('Realtime isEnabled must be a boolean or callback');
  return Object.freeze({
    ...options,
    agent,
    isEnabled: options.isEnabled ?? true,
    [handoffBrand]: true as const,
  });
}
export function isRealtimeHandoff(
  value: unknown,
): value is RealtimeHandoff<any> {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as RealtimeHandoff)[handoffBrand] === true
  );
}
export function captureRealtimeConfig<Context>(
  value: RealtimeAgentConfig<Context> | undefined,
): RealtimeAgentConfig<Context> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Realtime defaults must be an object');
  if (
    value.instructions !== undefined &&
    typeof value.instructions !== 'string' &&
    typeof value.instructions !== 'function'
  )
    throw new TypeError('Realtime instructions must be a string or callback');
  if (
    value.toolEnabled !== undefined &&
    typeof value.toolEnabled !== 'function'
  )
    throw new TypeError('Realtime toolEnabled must be callable');
  if (value.prompt !== undefined)
    serializeRealtimeSettings({ prompt: value.prompt });
  if (
    value.outputGuardrails !== undefined &&
    (!Array.isArray(value.outputGuardrails) ||
      value.outputGuardrails.some(
        (check) =>
          !check ||
          typeof check.name !== 'string' ||
          typeof check.callback !== 'function',
      ))
  )
    throw new TypeError('Realtime outputGuardrails require named callbacks');
  return Object.freeze({
    ...value,
    prompt:
      value.prompt === undefined
        ? undefined
        : (copyJsonValue(value.prompt) as NativeRealtimePrompt),
    outputGuardrails:
      value.outputGuardrails === undefined
        ? undefined
        : Object.freeze(
            value.outputGuardrails.map((check) => Object.freeze({ ...check })),
          ),
  });
}
export function realtimeHandoffTool(
  handoff: RealtimeHandoff<any>,
  source: Agent<any, any>,
  name: string,
): FunctionTool<any> {
  return tool({
    name,
    description:
      handoff.description ??
      `Transfer the conversation to ${handoff.agent.name ?? 'the target agent'}.`,
    parameters: handoff.parameters ?? z.object({}).strict(),
    before: async (call) => {
      const context = Object.freeze({ context: call.context, agent: source });
      const enabled =
        typeof handoff.isEnabled === 'function'
          ? await handoff.isEnabled(context)
          : handoff.isEnabled;
      if (typeof enabled !== 'boolean')
        throw new TypeError('Realtime handoff isEnabled must return a boolean');
      return enabled
        ? { action: 'allow' }
        : { action: 'deny', reason: 'Realtime handoff is disabled' };
    },
    execute: async (input, call) => {
      await handoff.onHandoff?.(
        Object.freeze({ context: call.context, agent: source }),
        input,
      );
      return 'Handoff reserved.';
    },
  });
}

export interface RealtimeConfigurationSelection {
  readonly function_tools: readonly JsonObject[];
  readonly selection_id: string;
}
/** Filter only the exact accepted native catalog; application predicates cannot grant tools. */
export async function resolveRealtimeAgentConfiguration<Context>(input: {
  declaration: Agent<Context, any>;
  agent: Agent<Context, any>;
  context: Context;
  selection: RealtimeConfigurationSelection;
  selectedTools?: readonly JsonObject[];
  instructions?: string;
  settings?: JsonObject;
  handoffs?: Readonly<Record<string, RealtimeHandoff<Context>>>;
  signal?: AbortSignal;
  invoke?: <T>(callback: () => T | Promise<T>) => Promise<T>;
}): Promise<{
  instructions?: string;
  settings: JsonObject;
  tools: JsonObject[];
  selectionId: string;
  guardrails: readonly NativeRealtimeOutputGuardrail[];
}> {
  const defaults = input.declaration.realtime;
  input.signal?.throwIfAborted();
  const context = Object.freeze({
    context: input.context,
    agent: input.agent,
    signal: input.signal,
  });
  const invoke = <T>(callback: () => T | Promise<T>) =>
    abortable(
      (input.invoke ?? (async (callback) => callback()))(callback),
      input.signal,
    );
  let instructions = input.instructions;
  if (instructions === undefined && defaults?.instructions !== undefined) {
    instructions =
      typeof defaults.instructions === 'function'
        ? await invoke(() =>
            (
              defaults.instructions as (
                context: RealtimeAgentContext<Context>,
              ) => string | Promise<string>
            )(context),
          )
        : defaults.instructions;
    if (typeof instructions !== 'string')
      throw new TypeError(
        'Realtime instructions callback must return a string',
      );
  }
  const settings = { ...input.settings };
  if (settings.prompt === undefined && defaults?.prompt !== undefined)
    settings.prompt = serializeRealtimeSettings({
      prompt: defaults.prompt,
    }).prompt;
  const handoffs =
    input.handoffs ??
    Object.fromEntries(
      input.declaration.handoffs.filter(isRealtimeHandoff).map((handoff) => [
        handoff.name ??
          `transfer_to_${handoff.agent.name}`
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .toLowerCase()
            .slice(0, 64),
        handoff,
      ]),
    );
  const tools: JsonObject[] = [];
  for (const requested of input.selectedTools ??
    input.selection.function_tools) {
    if (
      !input.selection.function_tools.some((admitted) =>
        isDeepStrictEqual(
          realtimeFunctionDTO(admitted),
          realtimeFunctionDTO(requested),
        ),
      )
    )
      throw new TypeError(
        'Realtime selection contains an unadmitted definition',
      );
    const name = requested.name;
    if (typeof name !== 'string')
      throw new TypeError('Realtime selection lacks a function name');
    if (defaults?.toolEnabled) {
      const enabled = await invoke(() =>
        defaults.toolEnabled!(
          context,
          toolRef(name, requested.namespace as string | undefined),
        ),
      );
      if (typeof enabled !== 'boolean')
        throw new TypeError('Realtime toolEnabled must return a boolean');
      if (!enabled) continue;
    }
    const handoff = handoffs[name];
    if (handoff) {
      const enabled =
        typeof handoff.isEnabled === 'function'
          ? await invoke(() =>
              (
                handoff.isEnabled as (
                  context: RealtimeAgentContext<Context>,
                ) => boolean | Promise<boolean>
              )(context),
            )
          : handoff.isEnabled;
      if (typeof enabled !== 'boolean')
        throw new TypeError('Realtime handoff isEnabled must return a boolean');
      if (!enabled) continue;
    }
    input.signal?.throwIfAborted();
    tools.push(realtimeFunctionDTO(requested));
  }
  input.signal?.throwIfAborted();
  return {
    instructions,
    settings,
    tools,
    selectionId: input.selection.selection_id,
    guardrails: defaults?.outputGuardrails ?? [],
  };
}

export function hasRealtimeAgentConfiguration(
  declaration: Agent<any, any>,
): boolean {
  return (
    declaration.realtime !== undefined ||
    declaration.handoffs.some(isRealtimeHandoff)
  );
}

/** The source snapshot uses provider parameters; the native SDK ABI uses inputSchema. */
function realtimeFunctionDTO(value: JsonObject): JsonObject {
  const schema = Object.hasOwn(value, 'inputSchema')
    ? value.inputSchema
    : value.parameters;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    throw new TypeError('Realtime function selection lacks an input schema');
  return {
    name: value.name,
    description: value.description ?? '',
    inputSchema: copyJsonValue(schema),
  };
}
