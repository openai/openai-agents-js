import type { StandardSchemaWithJSON } from '@openai/agents-core';
import type { SandboxSkillLease } from './sandbox-skills';
import { isZodObject } from '@openai/agents-core/utils';
import {
  getSchemaAndParserFromInputType,
  stripStrictNullsForZodSchema,
} from '@openai/agents-core/utils/internal';
import type { ApprovedArguments } from './manual';
import {
  decisionBinding,
  withDecisionSignal,
  type BoundDecide,
} from './decisions';
import { captureToolPart, mediaRecord } from './media';
import type { FileReference, ImageDetail } from './media';
import { z } from 'zod';
import {
  isBackgroundResult,
  markBackgroundToolResponse,
  type BackgroundResult,
} from './background-result';
import { handoffResultTarget, withHandoffResultTarget } from './handoff-result';
import {
  decode,
  encode,
  jsonValue,
  losslessJsonObjectSchema,
  losslessJsonValueSchema,
  type JsonValue,
  type JsonObject,
} from './binding';
import type { Turn } from './session';
import { usageReportBinding, type UsageReporter } from './run-events';
import type { WebSearch } from './web-search';
import type { HostedTool, ClientToolSearchExecutor } from './hosted-tools';
import type { ChildInvocation, NativeAgents } from './native-agents';
import type { HttpMCP, StdioMCP } from './mcp';
import {
  assembleManualTool,
  copyApprovalInput,
  type ManualTool,
} from './manual';
import type { NativeGoals } from './goals';
import { terminalCallInfo, type ToolCallInfo } from './call-metadata';
import type { ToolBatchResult } from './model-callbacks';
import { hostedMcpBinding } from './hosted-mcp-binding';

const toolContentSchema = z.unknown().transform((value, context) => {
  try {
    return captureToolPart(value);
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Invalid tool content',
    });
    return z.NEVER;
  }
});

export const toolOutputSchema = z.object({
  success: z.boolean(),
  contentItems: z.array(toolContentSchema),
});

export type ToolResponse = z.infer<typeof toolOutputSchema>;
export type ToolImageReference = { detail?: ImageDetail | null } & (
  { imageUrl: string; fileId?: never } | { fileId: string; imageUrl?: never }
);

/** Explicit native content. Current native owners retain all admission decisions. */
export class ToolOutput {
  declare private readonly toolOutputBrand: void;

  /** Application-only JSON; never part of provider content or tracing. */
  declare readonly applicationData?: JsonObject;

  constructor(
    readonly contentItems: z.infer<typeof toolOutputSchema>['contentItems'],
    readonly success = true,
    applicationData?: JsonObject | null,
  ) {
    if (applicationData != null) {
      const captured = losslessJsonObjectSchema.parse(applicationData);
      if (Object.keys(captured).length) this.applicationData = captured;
    }
  }

  /** Preserve legacy string construction and allow an explicit provider reference. */
  static image(reference: string | ToolImageReference): ToolOutput {
    const part =
      typeof reference === 'string'
        ? { imageUrl: reference }
        : mediaRecord(reference);
    return new ToolOutput([captureToolPart({ type: 'inputImage', ...part })]);
  }

  /** Exactly one opaque ID, inline data or HTTPS URL; never read a host path. */
  static file(reference: FileReference): ToolOutput {
    return new ToolOutput([
      captureToolPart({ type: 'inputFile', ...mediaRecord(reference) }),
    ]);
  }
}

/** @internal Detached canonical results; call metadata grants no tool authority. */
export function captureToolBatchResults(
  owner: Pick<
    ToolCallInfo,
    'sessionId' | 'turnId' | 'childId' | 'childIncarnation'
  >,
  model: string,
  value: unknown,
): readonly ToolBatchResult[] {
  try {
    const results = z
      .array(
        z.object({
          call_id: z.string(),
          name: z.string(),
          namespace: z.string().nullable().optional(),
          arguments: z.string(),
          output: z.unknown(),
          succeeded: z.boolean(),
        }),
      )
      .nonempty()
      .parse(value);
    if (
      new Set(results.map((result) => result.call_id)).size !== results.length
    )
      throw new TypeError('Duplicate settled tool identity');
    return Object.freeze(
      results.map((result) => {
        const content =
          typeof result.output === 'string'
            ? [{ type: 'inputText' as const, text: result.output }]
            : z
                .array(z.record(z.string(), z.unknown()))
                .parse(result.output)
                .map((part) => {
                  if (part.type === 'input_text')
                    return captureToolPart({
                      type: 'inputText',
                      text: part.text,
                    });
                  if (part.type === 'input_image')
                    return captureToolPart({
                      type: 'inputImage',
                      ...(part.image_url != null
                        ? { imageUrl: part.image_url }
                        : {}),
                      ...(part.file_id != null ? { fileId: part.file_id } : {}),
                      ...(part.detail != null ? { detail: part.detail } : {}),
                    });
                  if (part.type === 'input_file') {
                    const { type: _type, ...file } = part;
                    return captureToolPart({ type: 'inputFile', ...file });
                  }
                  if (part.type === 'input_audio')
                    return captureToolPart({
                      type: 'inputAudio',
                      audioUrl: part.audio_url,
                    });
                  throw new TypeError('Unsupported settled tool content');
                });
        return Object.freeze({
          call: Object.freeze({
            ...terminalCallInfo(owner, { ...result, final_output: null }),
            model,
          }),
          arguments: result.arguments,
          output: new ToolOutput(content, result.succeeded),
        });
      }),
    );
  } catch {
    throw new TypeError('Invalid settled tool batch');
  }
}

// This transient carrier never survives JSON or structuredClone into native replies.
const applicationDataBinding = Symbol('application tool output');
type ApplicationToolResponse = ToolResponse & {
  readonly [applicationDataBinding]?: JsonObject;
};

/** @internal Read detached passive data after the native result has been accepted. */
export function toolApplicationData(response: object): JsonObject | undefined {
  const data = (response as ApplicationToolResponse)[applicationDataBinding];
  return data === undefined ? undefined : losslessJsonObjectSchema.parse(data);
}

/** @internal Carry passive data across an owned callback without serializing it. */
export function withToolApplicationData<T extends object>(
  value: T,
  data: JsonObject | null | undefined,
): T {
  if (data != null) {
    const captured = losslessJsonObjectSchema.parse(data);
    if (Object.keys(captured).length)
      Object.defineProperty(value, applicationDataBinding, { value: captured });
  }
  return value;
}

function captureToolResponse(value: ToolResponse | ToolOutput): ToolResponse {
  const response = toolOutputSchema.parse(value);
  const data =
    value instanceof ToolOutput
      ? value.applicationData
      : toolApplicationData(value);
  const captured = withToolApplicationData(response, data);
  const target = handoffResultTarget(value);
  return target === undefined
    ? captured
    : withHandoffResultTarget(captured, target);
}

/** An elapsed native function callback deadline; effects are not rolled back. */
export class ToolTimeoutError extends Error {
  constructor(
    readonly toolName: string,
    readonly timeoutSeconds: number,
  ) {
    super(`Tool ${toolName} exceeded its callback timeout`);
    this.name = 'ToolTimeoutError';
  }
}

type FunctionToolCaller = ToolCallInfo['route'];

export type FunctionToolTimeoutBehavior = 'raise_exception' | 'error_as_result';

class FunctionBodyError extends Error {
  constructor(readonly original: unknown) {
    super('Function callback failed');
  }
}

/** Admitted callback-body exception formatting into a failed model-visible result. */
export type ToolErrorFunction<Context = unknown> = (
  context: ToolContext<Context>,
  error: unknown,
) => string | Promise<string>;

/** Context for a live Session's function argument or body failure. */
export interface ToolErrorContext<Context = unknown> {
  readonly context: Context;
  readonly call: ToolCallInfo;
  /** Cancellation of the owning invocation; formatting joins its cleanup. */
  readonly signal: AbortSignal;
  readonly phase: 'arguments' | 'execution';
  readonly defaultMessage: string;
  readonly error: unknown;
}

/** Undefined or a failed formatter uses the safe default; empty text is valid. */
export type ToolErrorFormatter<Context = unknown> = (
  context: ToolErrorContext<Context>,
) => string | undefined | Promise<string | undefined>;

/** @internal Live Session callback; never persisted or supplied by tool declarations. */
export const toolErrorFormatterBinding = Symbol('toolErrorFormatter');

export type ToolTimeoutErrorFunction<Context = unknown> = (
  context: ToolContext<Context>,
  error: ToolTimeoutError,
) => string | Promise<string>;

/** Context available to a function declaration's direct input error handler. */
export interface ToolInvocationInputContext<Context = unknown> {
  readonly context: Context;
  readonly signal: AbortSignal;
}

/** Application-owned callback context usable inside or outside a native Session. */
export interface ToolInvocationContext<
  Context = unknown,
  Arguments = Record<string, unknown>,
> extends ToolInvocationInputContext<Context> {
  /** Detached snapshot of the original arguments. */
  readonly originalArguments: Readonly<JsonObject>;
  /** Read-only view of the validated callback arguments. */
  readonly effectiveArguments: Readonly<Arguments>;
}

export interface ToolCallContext<
  Context = unknown,
> extends ToolInvocationInputContext<Context> {
  /** Exact JSON text of an admitted direct function call, before input policy. */
  readonly rawArguments?: string;
  /** Provider conversation snapshot captured when this Realtime call was issued. */
  readonly history?: readonly Readonly<Record<string, unknown>>[];
  /** Detached speech usage at callback creation; excludes backend thread usage. */
  readonly realtimeUsage?: import('./realtime-usage').NativeRealtimeUsage;
  readonly decide?: BoundDecide;
  /** @internal */
  readonly [decisionBinding]?: (signal: AbortSignal) => BoundDecide;
  /** Exact issuing native span, when native tracing has an active context. */
  readonly traceContext?: import('./trace-context').TraceContext;
  /** SDK-issued contexts include frozen observed metadata. */
  readonly call?: ToolCallInfo;
  /** @internal Captured Session formatter. */
  readonly [toolErrorFormatterBinding]?: ToolErrorFormatter<any>;
  readonly submission: Turn<unknown> | ChildInvocation;
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
}
type ClientToolSearchInvocation = (
  argumentsValue: JsonValue,
  context: ToolCallContext,
  execute: ClientToolSearchExecutor<any> | undefined,
  admit: () => void,
) => Promise<ToolResponse>;
const toolSessionOwners = new WeakMap<
  object,
  {
    owner: object;
    clientToolSearch?: ClientToolSearchInvocation;
    skillLease?: SandboxSkillLease;
    configuredAgent?: (input: string) => Promise<string>;
  }
>();

/** @internal Bind SDK-issued callback contexts to their opaque Session identity. */
export function registerToolSessionOwner(
  context: ToolCallContext,
  owner: object,
  clientToolSearch?: ClientToolSearchInvocation,
  skillLease?: SandboxSkillLease,
  configuredAgent?: (input: string) => Promise<string>,
): void {
  toolSessionOwners.set(context, {
    owner,
    clientToolSearch,
    skillLease,
    configuredAgent,
  });
}

/** @internal Only the original admitted declaration has been installing this owner. */
export function invokeConfiguredAgentTool(
  context: ToolCallContext,
  input: string,
): Promise<string> {
  const invoke = toolSessionOwners.get(context)?.configuredAgent;
  if (!invoke)
    throw new TypeError('Configured child has no admitted parent tool owner');
  return invoke(input);
}

// Private extension hook; retained in declarations for the sibling package.
export function _nativeToolSessionOwner(context: ToolCallContext): object {
  const owner = toolSessionOwners.get(context);
  if (!owner) throw new TypeError('Tool context has no native Session owner');
  return owner.owner;
}

/** @internal Current resource authority on an SDK-issued callback context. */
export function _nativeSandboxSkillLease(
  context: ToolCallContext,
): SandboxSkillLease | undefined {
  const owner = toolSessionOwners.get(context);
  if (!owner) throw new TypeError('Tool context has no native Session owner');
  return owner.skillLease;
}

function inheritToolSessionOwner<T extends object>(
  context: T,
  source: object,
): T {
  const owner = toolSessionOwners.get(source);
  if (owner) toolSessionOwners.set(context, owner);
  return context;
}

export interface ToolContext<
  Context = unknown,
  Arguments = Record<string, unknown>,
>
  extends ToolCallContext<Context>, ToolInvocationContext<Context, Arguments> {
  readonly decide: BoundDecide;
  /** Explicitly report trusted measured usage while this native invocation is admitted. */
  readonly reportUsage: UsageReporter;
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
  readonly strict?: boolean;
  readonly outputSchema?: JsonObject;
}

const prepareInvocation = Symbol('function tool binding');
const inputRecovery = Symbol('original input recovery');

/** @internal Recovery belongs to the captured function declaration. */
export function supportsInputErrorRecovery(tool: SessionTool): boolean {
  const source = managedApproval(tool)?.function ?? tool;
  return source.kind !== 'manual' && source[inputRecovery] === true;
}

const nativeCallbackDeclaration = Symbol('native computer declaration');
const clientToolSearchDeclaration = Symbol(
  'native client tool search declaration',
);
const shellDeclaration = Symbol('native shell declaration');

/** @internal The plan route admits only direct local function declarations. */
export function isDirectFunctionTool(tool: SessionTool): boolean {
  return (
    tool.kind !== 'manual' &&
    !tool.deferLoading &&
    tool.allowedCallers?.includes('direct') !== false &&
    !tool[nativeCallbackDeclaration] &&
    !tool[clientToolSearchDeclaration] &&
    !hostedMcpBinding(tool) &&
    !tool[shellDeclaration]
  );
}
type Invocation<Context> = (
  args: JsonValue,
  context: ToolCallContext<Context>,
  onTimeout: (error: Error) => void,
  admit: () => void,
  effectiveArgs?: JsonValue,
  approved?: ApprovedArguments,
  argumentError?: string,
  beforeExecute?: () => Promise<boolean>,
  onBodyEntry?: () => void,
) => Promise<ToolResponse>;

/** A tool-local decision made before its execution callback runs. */
export type ToolDecision<Arguments = unknown> =
  | { readonly action: 'allow' }
  | { readonly action: 'deny'; readonly reason: string }
  | { readonly action: 'replaceArguments'; readonly arguments: Arguments };

const approvalDefinition = Symbol('managed function approval');
interface ManagedApproval<Context = unknown> {
  readonly portable?: { readonly key: string; readonly policy: JsonValue };
  prepareOriginalInput?: (
    args: JsonValue,
    context: ToolCallContext<Context>,
    admit: () => void,
    argumentError?: string,
  ) => Promise<{ value: unknown } | { failure: string } | undefined>;
  readonly function: FunctionTool<Context>;
  readonly resultSchema: JsonValue;
  parseInput(args: JsonValue): unknown;
  prepare(
    args: JsonValue,
    context: ToolCallContext<Context>,
    admit: () => void,
    skipPredicate?: boolean,
    effectiveArgs?: JsonValue,
  ): Promise<{
    required: boolean;
    effective?: JsonValue;
    validated?: unknown;
    denial?: string;
  }>;
}
/** @internal Captured declarations share the existing manual owner before callback admission. */
export function managedApproval(
  tool: SessionTool,
): ManagedApproval | undefined {
  return (tool as SessionTool & { [approvalDefinition]?: ManagedApproval })[
    approvalDefinition
  ];
}

export interface FunctionTool<Context = unknown> extends ToolDeclaration {
  /** Restrict this tool to direct model calls, Code Mode calls, or both. */
  readonly allowedCallers?: readonly FunctionToolCaller[];
  /** Complete the turn from an accepted direct result; captured outside the schema. */
  readonly finishTurn?: boolean;
  readonly namespace?: string;
  readonly namespaceDescription?: string;
  readonly callbackTimeout?: number;
  readonly timeoutBehavior?: FunctionToolTimeoutBehavior;
  readonly timeoutErrorFunction?: ToolTimeoutErrorFunction<Context>;
  readonly errorFunction?: ToolErrorFunction<Context> | null;
  readonly kind?: 'function';
  readonly [nativeCallbackDeclaration]?: JsonObject;
  readonly [clientToolSearchDeclaration]?: JsonObject;
  readonly [shellDeclaration]?: JsonObject;
  readonly [prepareInvocation]: Invocation<Context>;
  readonly [inputRecovery]?: boolean;
}

/** A declared function that can also run with application-owned context. */
export interface StandaloneFunctionTool<
  Context,
  Result,
> extends FunctionTool<Context> {
  /** Run the declaration's validators, policies, and callback directly. */
  invoke(
    argumentsValue: JsonObject | string,
    options?: { context?: Context; signal?: AbortSignal },
  ): Promise<Result | ToolOutput>;
}
/** @internal The native receipt preserves the declared namespace, including null. */
export function toolNamespace(tool: SessionTool): string | null {
  if (hostedMcpBinding(tool)) return 'hosted_mcp';
  return tool.kind === 'manual' ? null : (tool.namespace ?? null);
}

/** @internal Core treats unnamespaced functions as the functions namespace. */
export function toolIdentity(tool: SessionTool): {
  name: string;
  namespace: string;
} {
  return { name: tool.name, namespace: toolNamespace(tool) ?? 'functions' };
}

/** @internal Executable slot for an already captured provider declaration. */
export function createClientToolSearchTool<Context>(
  declaration: JsonObject,
  execute?: ClientToolSearchExecutor<Context>,
): FunctionTool<Context> {
  return Object.freeze({
    name: 'tool_search',
    description: 'Load tools selected by the application',
    parameters: {},
    [clientToolSearchDeclaration]: declaration,
    async [prepareInvocation](
      args: JsonValue,
      context: ToolCallContext<Context>,
      _reportFailure: (error: Error) => void,
      admit: () => void,
    ) {
      admit();
      const invoke = toolSessionOwners.get(context)?.clientToolSearch;
      if (!invoke)
        throw new TypeError(
          'Client tool search has no admitted callback owner',
        );
      return invoke(args, context, execute, admit);
    },
  });
}

/** @internal Distinguish the internal slot from an application function of the same name. */
export function isClientToolSearchTool(tool: SessionTool): boolean {
  return (
    tool.kind !== 'manual' && tool[clientToolSearchDeclaration] !== undefined
  );
}

/** @internal Bind a real computer declaration to the current callback owner. */
export function createComputerTool<Context>(
  declaration: JsonObject,
  execute: (
    args: JsonValue,
    context: ToolCallContext<Context>,
    admit: () => void,
    reportFailure: (error: Error) => void,
  ) => Promise<ToolResponse>,
): FunctionTool<Context> {
  return createNativeCallbackTool(
    'computer',
    "Operate the application's computer",
    declaration,
    execute,
  );
}

/** @internal Bind a typed native declaration to the existing callback owner. */
export function createNativeCallbackTool<Context>(
  name: 'computer' | 'apply_patch',
  description: string,
  declaration: JsonObject,
  execute: (
    args: JsonValue,
    context: ToolCallContext<Context>,
    admit: () => void,
    reportFailure: (error: Error) => void,
    enterBody: () => void,
  ) => Promise<ToolResponse>,
): FunctionTool<Context> {
  return Object.freeze({
    name,
    description,
    parameters: {},
    [nativeCallbackDeclaration]: declaration,
    async [prepareInvocation](
      args: JsonValue,
      context: ToolCallContext<Context>,
      reportFailure: (error: Error) => void,
      admit: () => void,
      _effectiveArgs?: JsonValue,
      _approved?: ApprovedArguments,
      _argumentError?: string,
      _beforeExecute?: () => Promise<boolean>,
      onBodyEntry?: () => void,
    ) {
      admit();
      return execute(
        args,
        context,
        admit,
        reportFailure,
        onBodyEntry ?? (() => {}),
      );
    },
  });
}

/** @internal Preserve the ordinary callback and approval owners for typed edits. */
export function createApplyPatchTool<T extends z.ZodType, Context>(
  declaration: JsonObject,
  options: Parameters<typeof tool<T, Context>>[0],
): FunctionTool<Context> {
  const captured = {
    ...options,
    [nativeCallbackDeclaration]: structuredClone(declaration),
  };
  return tool(captured);
}

function liveToolContext<Context>(
  context: ToolInvocationInputContext<Context>,
): ToolCallContext<Context> | undefined {
  // Only SDK-owned contexts reach the bound invocation.
  return Object.hasOwn(context, 'submission')
    ? (context as ToolCallContext<Context>)
    : undefined;
}

async function recoverRunToolError<Context>(
  phase: ToolErrorContext['phase'],
  error: unknown,
  context: ToolInvocationInputContext<Context>,
  admit: () => void,
  name: string,
  errorFunction: ToolErrorFunction<Context> | null | undefined,
): Promise<string> {
  const live = liveToolContext(context);
  const formatter = live?.[toolErrorFormatterBinding];
  if (errorFunction === null || !formatter || !live?.call) throw error;
  const defaultMessage =
    phase === 'arguments'
      ? `Invalid arguments for function '${name}'.`
      : `Function '${name}' failed.`;
  admit();
  let formatted: unknown;
  try {
    formatted = await formatter(
      Object.freeze({
        context: context.context,
        call: live.call,
        signal: context.signal,
        phase,
        defaultMessage,
        error,
      }),
    );
  } catch (failure) {
    // Cancellation cleanup keeps its original exception and existing owner.
    try {
      admit();
    } catch {
      throw failure;
    }
    return defaultMessage;
  }
  admit();
  return typeof formatted === 'string' ? formatted : defaultMessage;
}

async function recoverFunctionBodyError<
  Context extends ToolInvocationContext<any>,
>(
  error: unknown,
  context: Context,
  admit: () => void,
  name: string,
  errorFunction:
    | ((context: Context, error: unknown) => string | Promise<string>)
    | null
    | undefined,
): Promise<string> {
  try {
    admit();
  } catch {
    throw error;
  }
  const text = errorFunction
    ? await errorFunction(context, error)
    : await recoverRunToolError(
        'execution',
        error,
        context,
        admit,
        name,
        errorFunction,
      );
  admit();
  if (typeof text !== 'string')
    throw new TypeError('errorFunction must return a string');
  return text;
}

function captureFunctionContext<Context, Arguments>(
  context: ToolCallContext<Context>,
  originalArguments: Readonly<JsonObject>,
  effectiveArguments: Readonly<Arguments>,
): ToolContext<Context, Arguments> {
  const callContext: ToolContext<Context, Arguments> = {
    ...context,
    reportUsage: (usage, options) => {
      const reporter = (
        context as ToolCallContext<Context> & {
          [usageReportBinding]?: UsageReporter;
        }
      )[usageReportBinding];
      if (!reporter)
        throw new Error(
          'Usage reporting requires an admitted native ToolContext',
        );
      context.signal.throwIfAborted();
      reporter(usage, options);
    },
    decide:
      context.decide ??
      ((() =>
        Promise.reject(
          new Error('Decision helper requires an admitted callback'),
        )) as BoundDecide),
    originalArguments,
    effectiveArguments,
  };
  return inheritToolSessionOwner(callContext, context);
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
    recover: (error: unknown) => Promise<ToolOutput>,
  ) => Promise<ToolOutput>;
}): FunctionTool<Context> {
  const { namespace, name, description, parameters, execute } = options;
  return Object.freeze({
    name,
    description,
    parameters,
    namespace: namespace.name,
    namespaceDescription: namespace.description,
    errorFunction: undefined as ToolErrorFunction<Context> | null | undefined,
    async [prepareInvocation](
      args: JsonValue,
      context: ToolCallContext<Context>,
      onTimeout: (error: Error) => void,
      admit: () => void,
    ) {
      admit();
      if (
        this.errorFunction != null &&
        typeof this.errorFunction !== 'function'
      )
        throw new TypeError('errorFunction must be a function');
      const parsed = losslessJsonObjectSchema.parse(args);
      const original = Object.freeze(structuredClone(parsed));
      const effective = Object.freeze(structuredClone(parsed));
      const result = await invokeWithTimeout(
        (signal) => {
          const callbackContext = inheritToolSessionOwner(
            withDecisionSignal(context, signal),
            context,
          );
          return execute(
            parsed,
            callbackContext,
            () => {
              signal.throwIfAborted();
              admit();
            },
            async (error) => {
              const text = await recoverFunctionBodyError(
                error,
                captureFunctionContext(callbackContext, original, effective),
                admit,
                name,
                this.errorFunction,
              );
              return new ToolOutput([{ type: 'inputText', text }], false);
            },
          );
        },
        context.signal,
        undefined,
        name,
        onTimeout,
      );
      admit();
      return captureToolResponse(result);
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
  | HostedTool
  | NativeGoals
  | Checklist;

type ToolParameters = z.ZodType | StandardSchemaWithJSON;
type ToolParameterInput<T extends ToolParameters> = T extends z.ZodType
  ? z.input<T>
  : T extends StandardSchemaWithJSON<infer Input, unknown>
    ? Input
    : never;
type ToolParameterOutput<T extends ToolParameters> = T extends z.ZodType
  ? z.output<T>
  : T extends StandardSchemaWithJSON<unknown, infer Output>
    ? Output
    : never;
type ToolContextArguments<T extends ToolParameters> = T extends z.ZodType
  ? Record<string, unknown>
  : ToolParameterOutput<T>;

type FunctionToolOptions<
  T extends ToolParameters,
  Context,
  Result extends z.ZodType,
  Standalone extends boolean = false,
  InputContext = Standalone extends true
    ? ToolInvocationInputContext<Context>
    : ToolCallContext<Context>,
  CallbackContext = Standalone extends true
    ? ToolInvocationContext<Context, ToolContextArguments<T>>
    : ToolContext<Context, ToolContextArguments<T>>,
  ErrorContext = Standalone extends true
    ? ToolInvocationContext<Context>
    : ToolContext<Context>,
> = {
  /** Complete from this direct function result after output validation and persistence. */
  finishTurn?: boolean;
  /** Defer selected schema presentation; does not change execution admission. */
  deferLoading?: boolean;
  /** Restrict this tool to direct model calls, Code Mode calls, or both. */
  allowedCallers?: readonly FunctionToolCaller[];
  /** Opt into strict Responses input schema generation. */
  strict?: boolean;
  /** Describe the JSON object encoded in string results for a native Responses request or ResponsesModel. */
  outputSchema?: JsonObject;
  /**
   * Callback-body deadline in seconds, at most 2_147_483.647.
   * Aborts the callback signal and joins entered work; effects are not rolled back.
   */
  callbackTimeout?: number;
  /** Fail the turn by default, or send a failed textual result after cleanup. */
  timeoutBehavior?: FunctionToolTimeoutBehavior;
  /** Format timeout failure text; bypasses result validation and after. */
  timeoutErrorFunction?: (
    context: ErrorContext,
    error: ToolTimeoutError,
  ) => string | Promise<string>;
  /** Callback-body failures only; cancellation, policy and validation handling unchanged. */
  errorFunction?:
    | ((context: ErrorContext, error: unknown) => string | Promise<string>)
    | null;
  /**
   * Original JSON syntax or initial Zod validation failure text.
   * Native SyntaxError with the exact raw string, or ZodError with detached JSON.
   * Unvalidated call context; no policy, approval, or execution on recovery.
   * Default schema-validation turn failure; native failed result for malformed JSON.
   * Replacement/restored inputs, output validation, and arbitrary errors excluded.
   */
  inputErrorFunction?: (
    context: InputContext,
    error: z.ZodError | SyntaxError,
    originalArguments: JsonValue,
  ) => string | Promise<string>;
  needsApproval?:
    | boolean
    | ((
        context: ToolContext<Context, ToolContextArguments<T>>,
      ) => boolean | Promise<boolean>);
  /** Run the input policy before approval and again before callback execution. */
  runBeforeApproval?: boolean;
  /**
   * Stable application-owned permission identity for trusted portable remembered decisions.
   * Restore has been requiring the same current key, profile, schema and approval policy.
   * A new key for changes to callback meaning, resources or permission scope.
   * Unkeyed decisions have been remaining within the current Session.
   */
  approvalKey?: string;
  name: string;
  /** Publish this function under a captured native namespace. */
  namespace?: string;
  namespaceDescription?: string;
  description?: string;
  /**
   * Standard Schema requires strict mode and synchronous validation.
   * Input policy and approval require detachable values such as plain objects,
   * arrays, and dates. Execution-only tools may also receive opaque values.
   */
  parameters: T;
  /** Validate the callback result before converting it to model-visible content. */
  result?: Result;
  /** Allow, deny, or replace validated arguments before the callback runs. */
  before?: (
    context: CallbackContext,
  ) =>
    | ToolDecision<ToolParameterInput<T>>
    | Promise<ToolDecision<ToolParameterInput<T>>>;
  /**
   * Transform validated content. Returning the same output preserves background
   * intent; a replacement is foreground unless wrapped in backgroundResult().
   */
  after?: (
    output: ToolOutput,
    context: CallbackContext,
  ) =>
    | ToolOutput
    | BackgroundResult<ToolOutput>
    | Promise<ToolOutput | BackgroundResult<ToolOutput>>;
  execute: (
    args: ToolParameterOutput<T>,
    context: CallbackContext,
  ) =>
    | z.input<Result>
    | BackgroundResult<z.input<Result>>
    | Promise<z.input<Result> | BackgroundResult<z.input<Result>>>;
};

type DefaultFunctionResult = z.ZodType<
  JsonValue | ToolOutput,
  JsonValue | ToolOutput
>;
type StandaloneToolOptions<
  T extends ToolParameters,
  Context,
  Result extends z.ZodType,
> = FunctionToolOptions<T, Context, Result, true> & {
  needsApproval?: false;
};

export function tool<
  T extends ToolParameters,
  Context = unknown,
  Result extends z.ZodType = DefaultFunctionResult,
>(options: FunctionToolOptions<T, Context, Result>): FunctionTool<Context> {
  return createFunctionTool<T, Context, Result>(options, false);
}

/** Declare a native function that can also run directly with application context. */
export function standaloneTool<
  T extends ToolParameters,
  Context = unknown,
  Result extends z.ZodType = DefaultFunctionResult,
>(
  options: StandaloneToolOptions<T, Context, Result> & {
    result: Result;
  },
): StandaloneFunctionTool<Context, z.output<Result>>;
export function standaloneTool<T extends ToolParameters, Context = unknown>(
  options: StandaloneToolOptions<T, Context, DefaultFunctionResult> & {
    result?: undefined;
  },
): StandaloneFunctionTool<Context, JsonValue | ToolOutput>;
export function standaloneTool<
  T extends ToolParameters,
  Context,
  Result extends z.ZodType,
>(
  options: StandaloneToolOptions<T, Context, Result>,
): StandaloneFunctionTool<Context, z.input<Result> | z.output<Result>> {
  return createFunctionTool<T, Context, Result>(
    options,
    true,
  ) as StandaloneFunctionTool<Context, z.input<Result> | z.output<Result>>;
}

function createFunctionTool<
  T extends ToolParameters,
  Context,
  Result extends z.ZodType,
>(
  options:
    | FunctionToolOptions<T, Context, Result>
    | StandaloneToolOptions<T, Context, Result>,
  standalone: boolean,
): FunctionTool<Context> {
  if (
    options.finishTurn !== undefined &&
    typeof options.finishTurn !== 'boolean'
  )
    throw new TypeError('finishTurn must be a boolean');
  if (
    options.deferLoading !== undefined &&
    typeof options.deferLoading !== 'boolean'
  )
    throw new TypeError('deferLoading must be a boolean');
  const allowedCallers = options.allowedCallers;
  if (
    allowedCallers !== undefined &&
    (!Array.isArray(allowedCallers) ||
      allowedCallers.length === 0 ||
      [...allowedCallers].some(
        (route) => route !== 'direct' && route !== 'code',
      ) ||
      new Set(allowedCallers).size !== allowedCallers.length)
  ) {
    throw new TypeError(
      'allowedCallers must select distinct direct or code routes',
    );
  }
  const capturedCallers =
    allowedCallers === undefined
      ? undefined
      : Object.freeze<FunctionToolCaller[]>(
          allowedCallers.length === 2
            ? ['direct', 'code']
            : [...allowedCallers],
        );
  if (
    options.callbackTimeout !== undefined &&
    (!Number.isFinite(options.callbackTimeout) ||
      options.callbackTimeout <= 0 ||
      options.callbackTimeout > 2_147_483_647 / 1000)
  )
    throw new TypeError('callbackTimeout must be in (0, 2147483.647] seconds');
  if (
    options.namespaceDescription !== undefined &&
    options.namespace === undefined
  )
    throw new TypeError('namespaceDescription requires namespace');
  if (
    options.needsApproval !== undefined &&
    typeof options.needsApproval !== 'boolean' &&
    typeof options.needsApproval !== 'function'
  )
    throw new TypeError('needsApproval must be a boolean or function');
  const approvalKey = options.approvalKey;
  if (
    approvalKey !== undefined &&
    (typeof approvalKey !== 'string' || !approvalKey)
  )
    throw new TypeError('approvalKey must be a nonempty string');
  if (
    options.runBeforeApproval !== undefined &&
    typeof options.runBeforeApproval !== 'boolean'
  )
    throw new TypeError('runBeforeApproval must be a boolean');
  if (options.needsApproval && options.namespace !== undefined)
    throw new TypeError('Managed approvals require an unnamespaced function');
  if (options.runBeforeApproval && !options.needsApproval)
    throw new TypeError('runBeforeApproval requires needsApproval');
  const {
    name,
    parameters,
    execute,
    result,
    before,
    after,
    callbackTimeout,
    timeoutBehavior = 'raise_exception',
    timeoutErrorFunction,
    inputErrorFunction,
    errorFunction,
  } = options as FunctionToolOptions<T, Context, Result, true>;
  if (
    inputErrorFunction !== undefined &&
    typeof inputErrorFunction !== 'function'
  )
    throw new TypeError('inputErrorFunction must be a function');
  if (errorFunction != null && typeof errorFunction !== 'function')
    throw new TypeError('errorFunction must be a function');
  const strict = options.strict ?? false;
  if (options.strict !== undefined && typeof options.strict !== 'boolean')
    throw new TypeError('strict must be a boolean');
  const outputSchema =
    options.outputSchema === undefined
      ? undefined
      : losslessJsonObjectSchema.parse(options.outputSchema);
  if (outputSchema !== undefined && outputSchema.type !== 'object')
    throw new TypeError('outputSchema must define a JSON object');
  let inputSchema: unknown;
  let parseInput: (value: unknown) => ToolParameterOutput<T>;
  const standardSchema =
    !isZodObject(parameters) && !(parameters instanceof z.ZodType);
  const requireDetachedArguments =
    before !== undefined || Boolean(options.needsApproval);
  if (!standardSchema) {
    const zodParameters = parameters as z.ZodType;
    if (strict) {
      if (!isZodObject(parameters))
        throw new TypeError('Strict tool parameters must be a Zod object');
      inputSchema = getSchemaAndParserFromInputType(parameters, name, {
        strict,
      }).schema;
    } else {
      inputSchema = z.toJSONSchema(zodParameters, { io: 'input' });
    }
    parseInput = (value) =>
      zodParameters.parse(
        strict ? stripStrictNullsForZodSchema(zodParameters, value) : value,
      ) as ToolParameterOutput<T>;
  } else {
    const prepared = getSchemaAndParserFromInputType(parameters, name, {
      strict,
    });
    inputSchema = prepared.schema;
    // The shared Standard Schema parser rejects asynchronous validation.
    parseInput = (value) =>
      copyApprovalInput(
        prepared.parser(JSON.stringify(value)),
        requireDetachedArguments,
      ) as ToolParameterOutput<T>;
  }
  const snapshotEffectiveArguments = (parsed: ToolParameterOutput<T>) => {
    const snapshot = standardSchema
      ? copyApprovalInput(parsed, requireDetachedArguments)
      : { ...(parsed as Record<string, unknown>) };
    return (
      snapshot === parsed ? snapshot : Object.freeze(snapshot)
    ) as Readonly<ToolContextArguments<T>>;
  };
  const recoverRunError = (
    phase: ToolErrorContext['phase'],
    error: unknown,
    context: ToolInvocationInputContext<Context>,
    admit: () => void,
  ) => recoverRunToolError(phase, error, context, admit, name, errorFunction);
  const recoverOriginalInput = async (
    error: z.ZodError | SyntaxError,
    original: JsonValue,
    context: ToolInvocationInputContext<Context>,
    admit: () => void,
  ): Promise<string> => {
    if (!inputErrorFunction) {
      if (!liveToolContext(context))
        throw new TypeError('Tool arguments failed validation');
      return recoverRunError('arguments', error, context, admit);
    }
    admit();
    const text = await inputErrorFunction(
      context,
      error,
      structuredClone(original),
    );
    admit();
    if (typeof text !== 'string')
      throw new TypeError('inputErrorFunction must return a string');
    return text;
  };
  const needsApproval = options.needsApproval;
  const runBeforeApproval = options.runBeforeApproval ?? false;
  const shell = (
    options as typeof options & {
      [shellDeclaration]?: {
        readonly spec: JsonObject;
        readonly portableResult: z.ZodType;
      };
    }
  )[shellDeclaration];
  const portableResult = shell?.portableResult ?? result;
  const native = (
    options as typeof options & { [nativeCallbackDeclaration]?: JsonObject }
  )[nativeCallbackDeclaration];
  if (standalone && (needsApproval || shell || native))
    throw new TypeError(
      'Standalone invocation requires an application function without approval',
    );

  async function invokeStandalone(
    argumentsValue: JsonObject | string,
    options?: { context?: Context; signal?: AbortSignal },
  ): Promise<z.input<Result> | z.output<Result> | ToolOutput> {
    const context: ToolInvocationInputContext<Context> = Object.freeze({
      context: options?.context as Context,
      signal: options?.signal ?? new AbortController().signal,
    });
    const admit = () => context.signal.throwIfAborted();
    admit();
    let args: JsonValue = argumentsValue;
    let argumentError: SyntaxError | undefined;
    if (typeof argumentsValue === 'string') {
      try {
        args = JSON.parse(argumentsValue);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        argumentError = error;
      }
    } else {
      args = losslessJsonValueSchema.parse(argumentsValue);
    }
    return invokeBound(
      args,
      context,
      () => {},
      admit,
      undefined,
      undefined,
      argumentError,
    ) as Promise<z.input<Result> | z.output<Result> | ToolOutput>;
  }

  async function invokeBound(
    args: JsonValue,
    context: ToolInvocationInputContext<Context>,
    onTimeout: (error: Error) => void,
    admit: () => void,
    effectiveArgs?: JsonValue,
    approved?: ApprovedArguments,
    argumentError?: string | SyntaxError,
    beforeExecute?: () => Promise<boolean>,
    onBodyEntry?: () => void,
  ): Promise<ToolResponse | ToolOutput | z.input<Result> | z.output<Result>> {
    admit();
    const live = liveToolContext(context);
    const failed = (text: string) => {
      const contentItems = [{ type: 'inputText' as const, text }];
      return live
        ? { success: false, contentItems }
        : new ToolOutput(contentItems, false);
    };
    if (argumentError !== undefined) {
      if (approved || effectiveArgs !== undefined)
        throw new TypeError(
          'Original input recovery cannot replace approved arguments',
        );
      const text = await recoverOriginalInput(
        typeof argumentError === 'string'
          ? new SyntaxError(argumentError)
          : argumentError,
        args,
        context,
        admit,
      );
      return failed(text);
    }
    const originalArguments = Object.freeze(
      structuredClone(args) as JsonObject,
    );
    let parsed: ToolParameterOutput<T>;
    if (approved) parsed = approved.value as ToolParameterOutput<T>;
    else if (effectiveArgs !== undefined) parsed = parseInput(effectiveArgs);
    else {
      try {
        parsed = parseInput(args);
      } catch (error) {
        if (!(error instanceof z.ZodError)) throw error;
        const text = await recoverOriginalInput(
          error,
          originalArguments,
          context,
          admit,
        );
        return failed(text);
      }
    }
    const effectiveArguments = snapshotEffectiveArguments(parsed);
    let callContext = live
      ? captureFunctionContext(live, originalArguments, effectiveArguments)
      : { ...context, originalArguments, effectiveArguments };
    admit();
    if (before) {
      const decision = await before(callContext);
      admit();
      if (decision?.action === 'deny') {
        if (typeof decision.reason !== 'string')
          throw new TypeError('Tool denial requires a reason');
        return failed(decision.reason);
      }
      if (decision?.action === 'replaceArguments') {
        if (shell)
          throw new TypeError(
            'Shell before policies only allow or deny execution',
          );
        parsed = parseInput(decision.arguments);
        callContext = {
          ...callContext,
          effectiveArguments: snapshotEffectiveArguments(parsed),
        };
        inheritToolSessionOwner(callContext, context);
      } else if (decision?.action !== 'allow') {
        throw new TypeError(
          'Tool before must allow, deny, or replace arguments',
        );
      }
    }
    admit();
    if (approved && !approved.matches(parsed))
      return failed('Tool input policy changed approved arguments');
    if (approved) {
      parsed = approved.value as typeof parsed;
      callContext = {
        ...callContext,
        effectiveArguments: snapshotEffectiveArguments(parsed),
      };
    }
    if (before && beforeExecute) {
      const enabled = await beforeExecute();
      admit();
      if (!enabled) return failed(`Tool ${name} not found`);
    }
    const timeoutError =
      callbackTimeout === undefined
        ? undefined
        : new ToolTimeoutError(name, callbackTimeout);
    let value: z.input<Result> | BackgroundResult<z.input<Result>>;
    const invoke = (signal: AbortSignal) =>
      execute(
        parsed,
        inheritToolSessionOwner(
          withDecisionSignal(callContext, signal),
          context,
        ),
      );
    try {
      value = await invokeWithTimeout(
        invoke,
        context.signal,
        callbackTimeout,
        name,
        timeoutBehavior === 'raise_exception' ? onTimeout : () => {},
        timeoutError,
        timeoutBehavior,
        errorFunction ||
          (errorFunction !== null && live?.[toolErrorFormatterBinding])
          ? (error) => new FunctionBodyError(error)
          : undefined,
        (signal) => {
          signal.throwIfAborted();
          admit();
          onBodyEntry?.();
        },
      );
    } catch (error) {
      if (error instanceof FunctionBodyError) {
        const text = await recoverFunctionBodyError(
          error.original,
          callContext,
          admit,
          name,
          errorFunction,
        );
        return failed(text);
      }
      if (
        timeoutBehavior !== 'error_as_result' ||
        !timeoutError ||
        error !== timeoutError
      )
        throw error;
      admit();
      const text = timeoutErrorFunction
        ? await timeoutErrorFunction(callContext, timeoutError)
        : timeoutError.message;
      admit();
      return failed(text);
    }
    admit();
    let background = isBackgroundResult(value);
    const content = isBackgroundResult(value) ? value.content : value;
    let response: ToolResponse;
    let validated: z.input<Result> | z.output<Result>;
    try {
      validated = result ? result.parse(content) : content;
      admit();
      response = outputOf(validated);
    } catch {
      admit();
      throw new TypeError('Tool result failed validation');
    }
    admit();
    if (after) {
      const original = new ToolOutput(
        response.contentItems,
        response.success,
        toolApplicationData(response),
      );
      const accepted = await after(original, callContext);
      admit();
      background =
        isBackgroundResult(accepted) || (background && accepted === original);
      const output = isBackgroundResult<ToolOutput>(accepted)
        ? accepted.content
        : accepted;
      if (!(output instanceof ToolOutput))
        throw new TypeError('Tool after must return ToolOutput');
      try {
        response = captureToolResponse(output);
      } catch {
        throw new TypeError('Tool result failed validation');
      }
    }
    admit();
    if (!live)
      return after
        ? new ToolOutput(
            response.contentItems,
            response.success,
            toolApplicationData(response),
          )
        : validated;
    return background ? markBackgroundToolResponse(response) : response;
  }
  const declaration = Object.freeze<FunctionTool<Context>>({
    ...(shell === undefined ? {} : { [shellDeclaration]: shell.spec }),
    ...(native === undefined ? {} : { [nativeCallbackDeclaration]: native }),
    finishTurn: options.finishTurn ?? false,
    [inputRecovery]: inputErrorFunction !== undefined,
    name: options.name,
    namespace: options.namespace,
    namespaceDescription: options.namespaceDescription,
    description: options.description ?? '',
    callbackTimeout,
    timeoutBehavior,
    timeoutErrorFunction,
    errorFunction,
    deferLoading: options.deferLoading ?? false,
    ...(capturedCallers === undefined
      ? {}
      : { allowedCallers: capturedCallers }),
    ...(strict ? { strict } : {}),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    parameters: decode(losslessJsonValueSchema, JSON.stringify(inputSchema)),
    ...(standalone ? { invoke: invokeStandalone } : {}),
    [prepareInvocation]: (
      args,
      context,
      onTimeout,
      admit,
      effectiveArgs,
      approved,
      argumentError,
      beforeExecute,
      onBodyEntry,
    ) =>
      invokeBound(
        args,
        context,
        onTimeout,
        admit,
        effectiveArgs,
        approved,
        argumentError,
        beforeExecute,
        onBodyEntry,
      ) as Promise<ToolResponse>,
  });
  if (!needsApproval) return declaration;
  const approval: ManagedApproval<Context> = {
    ...(errorFunction !== null || inputErrorFunction
      ? {
          async prepareOriginalInput(
            args: JsonValue,
            context: ToolCallContext<Context>,
            admit: () => void,
            argumentError?: string,
          ) {
            if (!inputErrorFunction && !context[toolErrorFormatterBinding])
              return undefined;
            admit();
            if (argumentError !== undefined)
              return {
                failure: await recoverOriginalInput(
                  new SyntaxError(argumentError),
                  args,
                  context,
                  admit,
                ),
              };
            try {
              return { value: parseInput(structuredClone(args)) };
            } catch (error) {
              if (!(error instanceof z.ZodError)) throw error;
              return {
                failure: await recoverOriginalInput(
                  error,
                  args,
                  context,
                  admit,
                ),
              };
            }
          },
        }
      : {}),
    function: declaration,
    resultSchema: portableResult
      ? decode(
          jsonValue,
          // Managed results retain their callback validator; this portable
          // metadata need not represent non-JSON instance validators.
          JSON.stringify(
            z.toJSONSchema(portableResult, {
              io: 'input',
              unrepresentable: 'any',
            }),
          ),
        )
      : {},
    parseInput: (args) => parseInput(structuredClone(args)),
    async prepare(args, context, admit, skipPredicate = false, effectiveArgs) {
      admit();
      let parsed = parseInput(
        structuredClone(effectiveArgs === undefined ? args : effectiveArgs),
      );
      let effective = effectiveArgs;
      let callContext: ToolContext<Context, ToolContextArguments<T>> = {
        ...context,
        reportUsage: (usage, options) => {
          const reporter = (
            context as ToolCallContext<Context> & {
              [usageReportBinding]?: UsageReporter;
            }
          )[usageReportBinding];
          if (!reporter)
            throw new Error(
              'Usage reporting requires an admitted native ToolContext',
            );
          context.signal.throwIfAborted();
          reporter(usage, options);
        },
        decide:
          context.decide ??
          ((() =>
            Promise.reject(
              new Error('Decision helper requires an admitted callback'),
            )) as BoundDecide),
        originalArguments: Object.freeze(structuredClone(args) as JsonObject),
        effectiveArguments: snapshotEffectiveArguments(parsed),
      };
      inheritToolSessionOwner(callContext, context);
      admit();
      if (
        runBeforeApproval &&
        before &&
        !(skipPredicate && effectiveArgs !== undefined)
      ) {
        const decision = await before(callContext);
        admit();
        if (decision.action === 'deny') {
          if (typeof decision.reason !== 'string')
            throw new TypeError('Tool denial requires a reason');
          return { required: false, denial: decision.reason };
        }
        if (decision.action === 'replaceArguments') {
          if (shell)
            throw new TypeError(
              'Shell before policies only allow or deny execution',
            );
          effective = losslessJsonValueSchema.parse(decision.arguments);
          parsed = parseInput(structuredClone(effective));
          callContext = {
            ...callContext,
            effectiveArguments: snapshotEffectiveArguments(parsed),
          };
          inheritToolSessionOwner(callContext, context);
        } else if (decision.action !== 'allow')
          throw new TypeError(
            'Tool before must allow, deny, or replace arguments',
          );
      }
      const required = skipPredicate
        ? true
        : typeof needsApproval === 'function'
          ? await needsApproval(callContext)
          : needsApproval;
      admit();
      if (typeof required !== 'boolean')
        throw new TypeError('needsApproval must return a boolean');
      return { required, effective, validated: parsed };
    },
  };
  if (approvalKey !== undefined)
    Object.defineProperty(approval, 'portable', {
      value: Object.freeze({
        key: approvalKey,
        policy: structuredClone([
          declaration.name,
          declaration.namespace ?? null,
          declaration.description,
          declaration.parameters,
          approval.resultSchema,
          typeof needsApproval === 'function' ? 'predicate' : needsApproval,
          runBeforeApproval,
          before !== undefined,
          after !== undefined,
          declaration.finishTurn ?? false,
        ]),
      }),
    });
  return Object.freeze({ ...declaration, [approvalDefinition]: approval });
}

export function outputOf(value: unknown): ToolResponse {
  if (value instanceof ToolOutput) return captureToolResponse(value);
  return {
    success: true,
    contentItems: [
      {
        type: 'inputText',
        text:
          typeof value === 'string'
            ? value
            : JSON.stringify(losslessJsonValueSchema.parse(value)),
      },
    ],
  };
}

/** @internal Preserve the ordinary tool callback and approval owners for local shell. */
export function createShellTool<
  T extends z.ZodType,
  Context,
  Result extends z.ZodType,
>(
  declaration: JsonObject,
  options: Parameters<typeof tool<T, Context, Result>>[0],
  portableResult: z.ZodType,
): FunctionTool<Context> {
  const captured = {
    ...options,
    // Keep SDK-only result metadata out of the stored approval contract.
    [shellDeclaration]: { spec: structuredClone(declaration), portableResult },
  };
  return tool(captured);
}

export interface ToolCatalog<T extends SessionTool = SessionTool> {
  readonly generation: bigint;
  readonly tools: readonly T[];
  readonly specsJson: string;
}
/** @internal Protocol schemas never carry current application caller authority. */
export function protocolToolSpecs(catalog: ToolCatalog): JsonObject[] {
  const specs = decode(z.array(losslessJsonObjectSchema), catalog.specsJson);
  for (const spec of specs) delete spec.allowedCallers;
  return specs;
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
    if (
      tool.kind !== 'manual' &&
      typeof tool[prepareInvocation] !== 'function'
    ) {
      throw new TypeError(
        'Native function tools must use tool() from @openai/agents in the same loaded SDK instance as the Session. Use @openai/agents/classic for Classic tools.',
      );
    }
    if (
      tool.kind !== 'manual' &&
      tool.finishTurn !== undefined &&
      typeof tool.finishTurn !== 'boolean'
    )
      throw new TypeError('finishTurn must be a boolean');
    const shell = (
      tool as SessionTool & { readonly [shellDeclaration]?: JsonObject }
    )[shellDeclaration];
    if (
      tool.kind !== 'manual' &&
      shell &&
      (tool.name !== 'shell' ||
        tool.namespace !== undefined ||
        tool.deferLoading ||
        tool.finishTurn ||
        tool.strict ||
        tool.outputSchema !== undefined)
    )
      throw new TypeError(
        'Shell declarations retain their native identity and policies',
      );
    const approval = managedApproval(tool);
    const native = (
      tool as SessionTool & { [nativeCallbackDeclaration]?: JsonObject }
    )[nativeCallbackDeclaration];
    const source = approval
      ? Object.freeze({
          ...assembleManualTool(tool, {
            resultSchema: approval.resultSchema,
            parseInput: approval.parseInput,
            parseResult: () => {
              throw new TypeError('Use an approval decision');
            },
          }),
          [approvalDefinition]: approval,
        })
      : tool;
    const binding = Object.freeze({
      ...source,
      ...(shell === undefined ? {} : { [shellDeclaration]: shell }),
      ...(native === undefined ? {} : { [nativeCallbackDeclaration]: native }),
      ...(tool.kind === 'manual'
        ? {}
        : { finishTurn: tool.finishTurn ?? false }),
      parameters: losslessJsonValueSchema.parse(tool.parameters),
      ...(tool.outputSchema === undefined
        ? {}
        : { outputSchema: losslessJsonObjectSchema.parse(tool.outputSchema) }),
      ...(tool.strict ? { strict: true } : {}),
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
    if (tool.kind !== 'manual' && tool[clientToolSearchDeclaration]) {
      if (
        tool.name !== 'tool_search' ||
        tool.namespace !== undefined ||
        tool.deferLoading ||
        tool.finishTurn ||
        tool.callbackTimeout !== undefined
      )
        throw new TypeError(
          'Client search declarations retain their native identity and policies',
        );
      return {
        type: 'toolSearch',
        declaration: losslessJsonObjectSchema.parse(
          tool[clientToolSearchDeclaration],
        ),
      };
    }
    const mcp = hostedMcpBinding(tool);
    if (mcp) {
      if (
        tool.name !== mcp.serverLabel ||
        tool.deferLoading ||
        (tool.kind !== 'manual' &&
          (tool.namespace !== 'hosted_mcp' || tool.finishTurn))
      )
        throw new TypeError(
          'Hosted MCP declarations retain their server identity',
        );
      return { type: 'hostedMcp', serverLabel: mcp.serverLabel };
    }
    if (tool[shellDeclaration])
      return losslessJsonObjectSchema.parse(tool[shellDeclaration]);
    const native = (
      tool as SessionTool & { [nativeCallbackDeclaration]?: JsonObject }
    )[nativeCallbackDeclaration];
    if (native) {
      const declaration = losslessJsonObjectSchema.parse(native);
      const expectedName =
        declaration.type === 'computer'
          ? 'computer'
          : declaration.type === 'applyPatch'
            ? 'apply_patch'
            : undefined;
      if (
        expectedName === undefined ||
        tool.name !== expectedName ||
        (tool.kind !== 'manual' && tool.namespace !== undefined) ||
        tool.deferLoading ||
        tool.finishTurn ||
        (tool.kind !== 'manual' && tool.callbackTimeout !== undefined)
      )
        throw new TypeError(
          'Computer declarations retain their native identity and policies',
        );
      return declaration;
    }
    const spec = {
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      deferLoading: tool.deferLoading ?? false,
      ...(tool.strict ? { strict: true } : {}),
      ...(tool.outputSchema === undefined
        ? {}
        : { outputSchema: tool.outputSchema }),
    };
    const namespace = tool.kind === 'manual' ? undefined : tool.namespace;
    const declaration =
      namespace !== undefined
        ? {
            type: 'namespace',
            name: namespace,
            description:
              tool.kind === 'manual' ? '' : (tool.namespaceDescription ?? ''),
            tools: [spec],
          }
        : spec;
    const source = managedApproval(tool)?.function ?? tool;
    return source.kind === 'manual' || source.allowedCallers === undefined
      ? declaration
      : { ...declaration, allowedCallers: [...source.allowedCallers] };
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
  effectiveArgs?: JsonValue,
  approved?: ApprovedArguments,
  argumentError?: string,
  beforeExecute?: () => Promise<boolean>,
  onBodyEntry?: () => void,
): Promise<ToolResponse> {
  const admit = () => {
    context.signal.throwIfAborted();
    checkAdmission?.();
  };
  return tool[prepareInvocation](
    args,
    context,
    onTimeout,
    admit,
    effectiveArgs,
    approved,
    argumentError,
    beforeExecute,
    onBodyEntry,
  );
}

/** @internal A callback deadline revokes publication; the caller still joins physical work. */
export async function invokeWithTimeout<T>(
  invoke: (signal: AbortSignal) => T | Promise<T>,
  parentSignal: AbortSignal,
  timeoutSeconds: number | undefined,
  name: string,
  onTimeout: (error: Error) => void,
  timeoutError?: Error,
  timeoutBehavior: FunctionToolTimeoutBehavior = 'raise_exception',
  wrapBodyError?: (error: unknown) => unknown,
  enterBody?: (signal: AbortSignal) => void,
): Promise<T> {
  if (timeoutSeconds === undefined) {
    enterBody?.(parentSignal);
    if (!wrapBodyError) return invoke(parentSignal);
    try {
      return await invoke(parentSignal);
    } catch (error) {
      throw wrapBodyError(error);
    }
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  const timeout =
    timeoutError ?? new Error(`Tool ${name} exceeded its callback timeout`);
  if (!timeoutError) timeout.name = 'TimeoutError';
  const deadline = performance.now() + timeoutSeconds * 1000;
  const expire = () => {
    if (controller.signal.aborted || parentSignal.aborted) return;
    controller.abort(timeout);
    onTimeout(timeout);
  };
  const timer = setTimeout(expire, timeoutSeconds * 1000);
  try {
    enterBody?.(signal);
    let value: T;
    try {
      const result = invoke(signal);
      // Check synchronous completion before unrelated queued work can delay us.
      value =
        result && typeof (result as Promise<T>).then === 'function'
          ? await result
          : (result as T);
    } catch (error) {
      if (timeoutError) {
        if (performance.now() >= deadline) expire();
        if (timeoutBehavior !== 'error_as_result' || !parentSignal.aborted)
          controller.signal.throwIfAborted();
      }
      throw wrapBodyError ? wrapBodyError(error) : error;
    }
    if (performance.now() >= deadline) expire();
    signal.throwIfAborted();
    return value;
  } finally {
    clearTimeout(timer);
    if (!timeoutError && performance.now() >= deadline) expire();
  }
}
