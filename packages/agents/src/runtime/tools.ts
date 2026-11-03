import { z } from 'zod';
import {
  decode,
  encode,
  jsonValue,
  jsonObject,
  type JsonValue,
  type JsonObject,
} from './binding';
import type { Turn } from './session';
import type { WebSearch } from './web-search';
import type { ChildInvocation, NativeAgents } from './native-agents';
import type { HttpMCP, StdioMCP } from './mcp';
import type { ManualTool } from './manual';
import type { NativeGoals } from './goals';
import type { ToolCallInfo } from './call-metadata';

export const toolOutputSchema = z.object({
  success: z.boolean(),
  contentItems: z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('inputText'), text: z.string() }),
      z.object({ type: z.literal('inputImage'), imageUrl: z.string() }),
      z.object({ type: z.literal('inputAudio'), audioUrl: z.string() }),
    ]),
  ),
});

export type ToolResponse = z.infer<typeof toolOutputSchema>;

/** Explicit native content, including images, audio, or a failed tool result. */
export class ToolOutput {
  declare private readonly toolOutputBrand: void;

  constructor(
    readonly contentItems: z.infer<typeof toolOutputSchema>['contentItems'],
    readonly success = true,
  ) {}

  /** Return an inline image after checking its data URL envelope. */
  static image(imageUrl: string): ToolOutput {
    if (
      typeof imageUrl !== 'string' ||
      !/^data:image\/[^,]*;base64,[\s\S]+$/.test(imageUrl)
    ) {
      throw new TypeError(
        'ToolOutput.image requires a base64 image data URL with a nonempty payload.',
      );
    }
    return new ToolOutput([{ type: 'inputImage', imageUrl }]);
  }
}

export interface ToolCallContext<Context = unknown> {
  /** SDK-issued contexts include frozen observed metadata. */
  readonly call?: ToolCallInfo;
  readonly context: Context;
  readonly submission: Turn<unknown> | ChildInvocation;
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly signal: AbortSignal;
}
export interface ToolContext<
  Context = unknown,
> extends ToolCallContext<Context> {
  /** Detached snapshot of the model's arguments. */
  readonly originalArguments: Readonly<JsonObject>;
  /** Shallow read-only view of the validated callback arguments. */
  readonly effectiveArguments: Readonly<Record<string, unknown>>;
}

/** A name resolves only to a binding admitted when the Session opened. */
export interface ToolRef {
  readonly kind: 'tool_ref';
  readonly name: string;
  /** Native tool namespace; omitted or null references use the function namespace. */
  readonly namespace?: string | null;
}
export function toolRef(name: string, namespace?: string | null): ToolRef {
  return Object.freeze({
    kind: 'tool_ref',
    name,
    ...(namespace === undefined ? {} : { namespace }),
  });
}
export type ToolSelector<Context = any> = SessionTool<Context> | ToolRef;

const declarationOwners = new WeakMap<object, object>();
/** @internal Compare an admitted declaration without trusting caller schemas. */
export function toolDeclarationIdentity(tool: SessionTool): object {
  return declarationOwners.get(tool) ?? tool;
}

export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonValue;
  /** Discover this selected schema natively when the model supports discovery. */
  readonly deferLoading?: boolean;
}

const prepareInvocation = Symbol('function tool binding');
const namespaceBinding = Symbol('function tool namespace');
type Invocation<Context> = (
  args: JsonValue,
  context: ToolCallContext<Context>,
  onTimeout: (error: Error) => void,
  admit: () => void,
) => Promise<ToolResponse>;

/** A tool-local decision made before its execution callback runs. */
export type ToolDecision<Arguments = unknown> =
  | { readonly action: 'allow' }
  | { readonly action: 'deny'; readonly reason: string }
  | { readonly action: 'replaceArguments'; readonly arguments: Arguments };

export interface FunctionTool<Context = unknown> extends ToolDeclaration {
  readonly callbackTimeout?: number;
  readonly kind?: 'function';
  readonly [prepareInvocation]: Invocation<Context>;
  readonly [namespaceBinding]?: Readonly<{
    name: string;
    description?: string;
  }>;
}
/** @internal The native receipt preserves the declared namespace, including null. */
export function toolNamespace(tool: SessionTool): string | null {
  return tool.kind === 'manual' ? null : (tool[namespaceBinding]?.name ?? null);
}

/** @internal Core treats unnamespaced functions as the functions namespace. */
export function toolIdentity(tool: SessionTool): {
  name: string;
  namespace: string;
} {
  return { name: tool.name, namespace: toolNamespace(tool) ?? 'functions' };
}

/** @internal Bind one borrowed MCP tool to the existing managed callback owner. */
export function createNamespacedFunctionTool<Context>(options: {
  namespace: Readonly<{ name: string; description?: string }>;
  name: string;
  description: string;
  parameters: JsonValue;
  execute: (
    args: JsonObject,
    context: ToolCallContext<Context>,
    admit: () => void,
  ) => Promise<ToolOutput>;
}): FunctionTool<Context> {
  const { namespace, name, description, parameters, execute } = options;
  return Object.freeze({
    name,
    description,
    parameters,
    [namespaceBinding]: namespace,
    async [prepareInvocation](
      args: JsonValue,
      context: ToolCallContext<Context>,
      onTimeout: (error: Error) => void,
      admit: () => void,
    ) {
      admit();
      const parsed = jsonObject.parse(args);
      const result = await invokeWithTimeout(
        (signal) =>
          execute(parsed, { ...context, signal }, () => {
            signal.throwIfAborted();
            admit();
          }),
        context.signal,
        undefined,
        name,
        onTimeout,
      );
      admit();
      return toolOutputSchema.parse(result);
    },
  });
}

/** Grant Core's update_plan when the Session opens. */
export interface Checklist {
  readonly kind: 'checklist';
}

/** Capture native checklist authority at opening; saved data grants no updates. */
export function checklist(): Checklist {
  return Object.freeze({ kind: 'checklist' });
}

export type SessionTool<Context = any> = FunctionTool<Context> | ManualTool;
export type Tool<Context = any> =
  | SessionTool<Context>
  | HttpMCP<Context>
  | StdioMCP<Context>
  | NativeAgents<Context>
  | WebSearch
  | NativeGoals
  | Checklist;

export function tool<
  T extends z.ZodType,
  Context = unknown,
  Result extends z.ZodType = z.ZodType<
    JsonValue | ToolOutput,
    JsonValue | ToolOutput
  >,
>(options: {
  /** Defer selected schema presentation; does not change execution admission. */
  deferLoading?: boolean;
  callbackTimeout?: number;
  name: string;
  description?: string;
  parameters: T;
  /** Validate the callback result before converting it to model-visible content. */
  result?: Result;
  /** Allow, deny, or replace validated arguments before the callback runs. */
  before?: (
    context: ToolContext<Context>,
  ) => ToolDecision<z.input<T>> | Promise<ToolDecision<z.input<T>>>;
  /** Transform validated, normalized content before it is sent to the model. */
  after?: (
    output: ToolOutput,
    context: ToolContext<Context>,
  ) => ToolOutput | Promise<ToolOutput>;
  execute: (
    args: z.output<T>,
    context: ToolContext<Context>,
  ) => z.input<Result> | Promise<z.input<Result>>;
}): FunctionTool<Context> {
  if (
    options.deferLoading !== undefined &&
    typeof options.deferLoading !== 'boolean'
  )
    throw new TypeError('deferLoading must be a boolean');
  if (
    options.callbackTimeout !== undefined &&
    (!Number.isFinite(options.callbackTimeout) || options.callbackTimeout <= 0)
  )
    throw new TypeError('callbackTimeout must be positive and finite');
  const { name, parameters, execute, result, before, after, callbackTimeout } =
    options;
  return Object.freeze({
    name: options.name,
    description: options.description ?? '',
    callbackTimeout: options.callbackTimeout,
    deferLoading: options.deferLoading ?? false,
    parameters: decode(
      jsonValue,
      JSON.stringify(z.toJSONSchema(parameters, { io: 'input' })),
    ),
    async [prepareInvocation](
      args: JsonValue,
      context: ToolCallContext<Context>,
      onTimeout: (error: Error) => void,
      admit: () => void,
    ) {
      admit();
      const originalArguments = Object.freeze(
        structuredClone(args) as JsonObject,
      );
      let parsed = parameters.parse(args);
      let callContext: ToolContext<Context> = {
        ...context,
        originalArguments,
        effectiveArguments: Object.freeze({
          ...(parsed as Record<string, unknown>),
        }),
      };
      admit();
      if (before) {
        const decision = await before(callContext);
        admit();
        if (decision?.action === 'deny') {
          if (typeof decision.reason !== 'string')
            throw new TypeError('Tool denial requires a reason');
          return {
            contentItems: [
              { type: 'inputText' as const, text: decision.reason },
            ],
            success: false,
          };
        }
        if (decision?.action === 'replaceArguments') {
          parsed = parameters.parse(decision.arguments);
          callContext = {
            ...callContext,
            effectiveArguments: Object.freeze({
              ...(parsed as Record<string, unknown>),
            }),
          };
        } else if (decision?.action !== 'allow') {
          throw new TypeError(
            'Tool before must allow, deny, or replace arguments',
          );
        }
      }
      admit();
      const value = await invokeWithTimeout(
        (signal) => execute(parsed, { ...callContext, signal }),
        context.signal,
        callbackTimeout,
        name,
        onTimeout,
      );
      admit();
      let response: ToolResponse;
      try {
        const validated = result ? result.parse(value) : value;
        admit();
        response = outputOf(validated);
      } catch {
        admit();
        throw new TypeError('Tool result failed validation');
      }
      admit();
      if (after) {
        const output = await after(
          new ToolOutput(response.contentItems, response.success),
          callContext,
        );
        admit();
        if (!(output instanceof ToolOutput))
          throw new TypeError('Tool after must return ToolOutput');
        try {
          response = toolOutputSchema.parse(output);
        } catch {
          throw new TypeError('Tool result failed validation');
        }
      }
      admit();
      return response;
    },
  });
}

export function outputOf(value: unknown): ToolResponse {
  if (value instanceof ToolOutput) return toolOutputSchema.parse(value);
  return {
    success: true,
    contentItems: [
      {
        type: 'inputText',
        text: typeof value === 'string' ? value : encode(value),
      },
    ],
  };
}

export interface ToolCatalog<T extends SessionTool = SessionTool> {
  readonly generation: bigint;
  readonly tools: readonly T[];
  readonly specsJson: string;
}
export function captureTools(
  tools: readonly FunctionTool[],
  generation?: bigint,
): ToolCatalog<FunctionTool>;
export function captureTools(
  tools: readonly SessionTool[],
  generation?: bigint,
): ToolCatalog;
export function captureTools(
  tools: readonly SessionTool[],
  generation = 0n,
): ToolCatalog {
  const captured = tools.map((tool) => {
    const binding = Object.freeze({
      ...tool,
      parameters: jsonValue.parse(tool.parameters),
    });
    declarationOwners.set(binding, declarationOwners.get(tool) ?? tool);
    return binding;
  });
  const names = new Set<string>();
  const specs = captured.map((tool) => {
    const identity = toolIdentity(tool);
    const key = JSON.stringify([identity.namespace, identity.name]);
    if (names.has(key))
      throw new TypeError(`Duplicate tool ${identity.namespace}.${tool.name}`);
    names.add(key);
    const spec = {
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      deferLoading: tool.deferLoading ?? false,
    };
    const namespace =
      tool.kind === 'manual' ? undefined : tool[namespaceBinding];
    return namespace
      ? {
          type: 'namespace',
          name: namespace.name,
          description: namespace.description ?? '',
          tools: [spec],
        }
      : spec;
  });
  return Object.freeze({
    generation,
    tools: Object.freeze(captured),
    specsJson: encode(specs),
  });
}

/** @internal A deadline revokes publication, but cleanup still joins the entered callback. */
export async function invokeFunctionTool(
  tool: FunctionTool<any>,
  args: JsonValue,
  context: ToolCallContext<any>,
  onTimeout: (error: Error) => void,
  checkAdmission?: () => void,
): Promise<ToolResponse> {
  const admit = () => {
    context.signal.throwIfAborted();
    checkAdmission?.();
  };
  return tool[prepareInvocation](args, context, onTimeout, admit);
}

/** @internal A callback deadline revokes publication; the caller still joins physical work. */
export async function invokeWithTimeout<T>(
  invoke: (signal: AbortSignal) => T | Promise<T>,
  parentSignal: AbortSignal,
  timeoutSeconds: number | undefined,
  name: string,
  onTimeout: (error: Error) => void,
): Promise<T> {
  if (timeoutSeconds === undefined) return invoke(parentSignal);
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  const timeout = new Error(`Tool ${name} exceeded its callback timeout`);
  timeout.name = 'TimeoutError';
  const deadline = performance.now() + timeoutSeconds * 1000;
  const expire = () => {
    if (controller.signal.aborted || parentSignal.aborted) return;
    controller.abort(timeout);
    onTimeout(timeout);
  };
  const timer = setTimeout(expire, timeoutSeconds * 1000);
  try {
    const value = await invoke(signal);
    if (performance.now() >= deadline) expire();
    signal.throwIfAborted();
    return value;
  } finally {
    clearTimeout(timer);
    if (performance.now() >= deadline) expire();
  }
}

/** @internal Adapt an admitted classic invoker without another parameter parser. */
export function migrationTool<Context, Prepared = undefined>(
  declaration: ToolDeclaration,
  invoke: (
    argumentsText: string,
    context: ToolCallContext<Context>,
    prepared: Prepared | undefined,
    checkNative: () => void,
  ) => Promise<unknown>,
  admit: () => void,
  beforeInvoke?: (
    argumentsText: string,
    context: ToolCallContext<Context>,
  ) => Promise<Prepared>,
): FunctionTool<Context> {
  return Object.freeze({
    ...declaration,
    async [prepareInvocation](
      args: JsonValue,
      context: ToolCallContext<Context>,
      _onTimeout: (error: Error) => void,
      nativeAdmit: () => void,
    ): Promise<ToolResponse> {
      if (args === null || Array.isArray(args) || typeof args !== 'object')
        throw new TypeError(
          'Migration function arguments must be a JSON object',
        );
      const argumentsText = encode(args);
      admit();
      nativeAdmit();
      let prepared: Prepared | undefined;
      if (beforeInvoke) {
        prepared = await beforeInvoke(argumentsText, context);
        admit();
        nativeAdmit();
      }
      const value = await invoke(argumentsText, context, prepared, nativeAdmit);
      admit();
      nativeAdmit();
      return outputOf(jsonValue.parse(value));
    },
  });
}
