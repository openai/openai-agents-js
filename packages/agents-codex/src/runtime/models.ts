import {
  captureModelProviderMetadata,
  replayModelProviderMetadata,
  retainModelProviderMetadata,
  retainModelProviderStreamFrame,
  mergeModelProviderMetadata,
  hasModelProviderMetadata,
  modelTextPartMetadata,
  modelTextPartMetadataKey,
} from './model-provider-metadata';
import type { TokenUsage } from './run-events';
import {
  modelErrorHeader,
  modelErrorField,
  type ModelRetryAdvice,
  type ModelRetryAdviceRequest,
} from './model-retry';
import { randomUUID } from 'node:crypto';
import { APIUserAbortError } from 'openai';
import type {
  ChatCompletion,
  ChatCompletionChunk,
} from 'openai/resources/chat';
import { z } from 'zod';
import { applyPatchOperationSchema } from './apply-patch';
import {
  captureFile,
  captureImage,
  inlineAudioSource,
  type FileReference,
} from './media';
import {
  copyJsonValue,
  losslessJsonObjectSchema,
  type JsonObject,
} from './binding';

function selectedFunctionName(
  choice: unknown,
  offered: readonly unknown[],
  workspacePatchOffered = false,
): string {
  if (!choice || typeof choice !== 'object' || Array.isArray(choice))
    throw new TypeError('Named tool choice must select an offered function');
  const declaration = choice as Record<string, unknown>;
  const selected = (declaration.function ?? declaration) as Record<
    string,
    unknown
  >;
  const workspacePatchChoice =
    workspacePatchOffered &&
    declaration.type === 'custom' &&
    declaration.function == null &&
    declaration.name === 'apply_patch';
  if (
    (declaration.type !== 'function' && !workspacePatchChoice) ||
    (declaration.namespace != null && declaration.namespace !== 'functions') ||
    !selected ||
    typeof selected !== 'object' ||
    Array.isArray(selected) ||
    (selected.namespace != null && selected.namespace !== 'functions') ||
    typeof selected.name !== 'string' ||
    !offered.includes(selected.name)
  )
    throw new TypeError(
      'Named tool choice must select an offered default-namespace function',
    );
  return selected.name;
}

const originalResponsesUsage = Symbol('original Responses usage');
const borrowedResponsesStreams = new WeakMap<
  AsyncIterable<JsonObject>,
  { upstreamRequestId?: string; abort: () => void }
>();

/** @internal Transport identity from the built-in borrowed Responses stream. */
export function borrowedResponsesRequestId(
  stream: AsyncIterable<JsonObject>,
): string | undefined {
  return borrowedResponsesStreams.get(stream)?.upstreamRequestId;
}
const receivedCacheWriteUsage = Symbol('received cache-write usage');
const rawProviderRequest = Symbol('raw provider observation');
const rawChatCompletion = Symbol('original Chat Completion');
const chatModelStreams = new WeakSet<AsyncIterable<JsonObject>>();
const rawChatChunks = new WeakSet<JsonObject>();
// The adapter assembles items before Core sees them, including tool-only chunks.
const maxChatStreamBytes = 8 * 1024 * 1024;

/** @internal Existing native turn opt-in, without provider request fields. */
export function markRawProviderRequest(request: ModelRequest): void {
  Object.defineProperty(request, rawProviderRequest, { value: true });
}

export function isChatModelStream(stream: AsyncIterable<JsonObject>): boolean {
  return chatModelStreams.has(stream);
}

export function isRawChatChunk(event: JsonObject): boolean {
  return rawChatChunks.has(event);
}

type OriginalResponsesUsage = {
  usage: unknown;
  responseId: unknown;
  upstreamRequestId: unknown;
};

/** Detached native provider input; Core retains canonical history and tool execution. */
export interface ModelRequest {
  readonly body: JsonObject;
  readonly context: unknown;
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal: AbortSignal;
  /** Opaque native logical-attempt identity, when the route negotiates attempts. */
  readonly attemptId?: string;
  readonly attempt?: number;
  /** Native replay/budget directive; adapters apply it after request options. */
  readonly disableProviderRetries?: boolean;
  /** Measured usage for this admitted attempt; cleanup can report before physical release. */
  readonly reportUsage?: (usage: TokenUsage) => void;
}
/** One completed response; output items use Responses JSON including function calls. */
export interface ModelResponse {
  readonly output: readonly JsonObject[];
  readonly responseId?: string;
  readonly usage?: Readonly<
    Partial<
      Record<
        | 'input_tokens'
        | 'cached_input_tokens'
        | 'cache_write_input_tokens'
        | 'output_tokens'
        | 'reasoning_output_tokens'
        | 'total_tokens',
        number
      >
    >
  >;
}
/** Application-owned producer. Cancellation joins admitted work and discards late output. */
export interface NativeModel {
  getRetryAdvice?(
    request: ModelRetryAdviceRequest,
  ): ModelRetryAdvice | undefined | Promise<ModelRetryAdvice | undefined>;
  complete(request: ModelRequest): ModelResponse | Promise<ModelResponse>;
  /** Responses wire events; native execution admits tool calls only after a single terminal and iterator completion. */
  stream?(
    request: ModelRequest,
  ): AsyncIterable<JsonObject> | Promise<AsyncIterable<JsonObject>>;
}
/** Resolve a native model for each effective request model name. */
export interface ModelProvider {
  getModel(modelName: string): NativeModel;
}
/** @internal Pump borrowed model events while the caller retains admission and native replies. */
export async function pumpModelStream(
  stream: AsyncIterable<JsonObject>,
  sink: {
    check(): void;
    start(): void;
    push(event: string, original: JsonObject): Promise<boolean>;
    finish(): void;
  },
): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  let finished = false;
  try {
    sink.check();
    sink.start();
    while (true) {
      sink.check();
      const next = await iterator.next();
      sink.check();
      if (next.done) {
        finished = true;
        break;
      }
      const continuing = await sink.push(
        JSON.stringify(losslessJsonObjectSchema.parse(next.value)),
        next.value,
      );
      sink.check();
      if (!continuing) break;
    }
  } finally {
    if (!finished) {
      try {
        await iterator.return?.();
      } finally {
        borrowedResponsesStreams.get(stream)?.abort();
      }
    }
  }
  sink.finish();
}

/** @internal Capture on settlement, before the application can change retained values. */
export function captureModelResponse(
  response: ModelResponse,
  captureRawUsage = false,
  captureRawProviderEvents = false,
): JsonObject {
  if (!response || !Array.isArray(response.output))
    throw new TypeError('NativeModel.complete must return ModelResponse');
  const responseId = response.responseId ?? `resp_${randomUUID()}`;
  if (typeof responseId !== 'string' || !responseId.trim())
    throw new TypeError('ModelResponse requires a nonempty responseId');
  const fields = [
    'input_tokens',
    'cached_input_tokens',
    'cache_write_input_tokens',
    'output_tokens',
    'reasoning_output_tokens',
    'total_tokens',
  ];
  let usage: Record<string, number> | null = null;
  if (response.usage !== undefined) {
    if (
      !response.usage ||
      typeof response.usage !== 'object' ||
      Object.entries(response.usage).some(
        ([key, value]) =>
          !fields.includes(key) || !Number.isSafeInteger(value) || value < 0,
      )
    )
      throw new TypeError(
        'ModelResponse usage requires nonnegative native token counters',
      );
    usage = Object.fromEntries(
      fields.map((field) => [
        field,
        response.usage?.[field as keyof typeof response.usage] ?? 0,
      ]),
    );
    if (response.usage.total_tokens === undefined)
      usage.total_tokens = usage.input_tokens + usage.output_tokens;
  }
  const cacheWriteUsage = (
    response as ModelResponse & {
      [receivedCacheWriteUsage]?: { count: number | null };
    }
  )[receivedCacheWriteUsage];
  const raw = captureRawProviderEvents
    ? (response as ModelResponse & { [rawChatCompletion]?: JsonObject })[
        rawChatCompletion
      ]
    : undefined;
  const original = captureRawUsage
    ? (
        response as ModelResponse & {
          [originalResponsesUsage]?: OriginalResponsesUsage;
        }
      )[originalResponsesUsage]
    : undefined;
  if (
    original &&
    (typeof original.responseId !== 'string' ||
      !original.responseId.trim() ||
      original.responseId !== responseId)
  )
    throw new TypeError(
      'Original Responses usage requires its unchanged provider response ID',
    );
  // Core rejects the entire refusal before any output can own a continuation.
  const providerMetadata = hasResponsesRefusal(response.output)
    ? undefined
    : captureModelProviderMetadata(response);
  return copyJsonValue({
    ...(providerMetadata === undefined
      ? {}
      : { provider_metadata: providerMetadata }),
    response_id: responseId,
    output: response.output,
    usage,
    ...(cacheWriteUsage === undefined
      ? {}
      : { received_cache_write_usage: cacheWriteUsage }),
    ...(raw ? { raw_chat_completion: raw } : {}),
    ...(original
      ? {
          original_usage: {
            response_id: original.responseId,
            upstream_request_id:
              typeof original.upstreamRequestId === 'string'
                ? original.upstreamRequestId
                : null,
            usage: original.usage,
          },
        }
      : {}),
  }) as JsonObject;
}
/** HTTP options for one borrowed OpenAI client request; native cancellation is retained. */
export interface ModelRequestOptions {
  /** null removes a header inherited from the client. */
  readonly headers?: Readonly<Record<string, string | null>>;
  readonly query?: Readonly<JsonObject>;
  /** Per HTTP attempt, excluding the client's retry backoff. */
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}
export type ModelRequestOptionsFactory = (
  request: ModelRequest,
) => ModelRequestOptions | undefined | Promise<ModelRequestOptions | undefined>;

/** Captured cache affinity and HTTP options for a borrowed OpenAI adapter. */
export interface ModelAdapterOptions {
  promptCacheKey?: string;
  /** Captured once; a factory supplies a detached snapshot per native model request. */
  requestOptions?: ModelRequestOptions | ModelRequestOptionsFactory;
}

export interface ChatCompletionsModelOptions extends ModelAdapterOptions {
  /** Use the provider's streaming API. Defaults to false. */
  stream?: boolean;
  /** Request terminal usage when streaming. Defaults to true. */
  includeUsage?: boolean;
}

export interface ResponsesModelOptions extends ModelAdapterOptions {
  /** Use the provider's streaming API. Defaults to false. */
  stream?: boolean;
}

type CapturedRequestOptions =
  ModelRequestOptions | ModelRequestOptionsFactory | undefined;

function captureRequestOptions(value: unknown): ModelRequestOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('requestOptions must be an HTTP options object');
  if (
    Object.keys(value).some(
      (key) => !['headers', 'query', 'timeoutMs', 'maxRetries'].includes(key),
    )
  )
    throw new TypeError('Unsupported model request option');
  const options = copyJsonValue(
    Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined),
    ),
  ) as JsonObject;
  if (
    options.headers !== undefined &&
    (!options.headers ||
      typeof options.headers !== 'object' ||
      Array.isArray(options.headers) ||
      Object.values(options.headers).some(
        (item) => item !== null && typeof item !== 'string',
      ))
  )
    throw new TypeError('requestOptions.headers must contain strings or null');
  if (
    options.query !== undefined &&
    (!options.query ||
      typeof options.query !== 'object' ||
      Array.isArray(options.query))
  )
    throw new TypeError('requestOptions.query must be an object');
  if (
    options.timeoutMs !== undefined &&
    (typeof options.timeoutMs !== 'number' || options.timeoutMs <= 0)
  )
    throw new TypeError('requestOptions.timeoutMs must be positive and finite');
  if (
    options.maxRetries !== undefined &&
    (typeof options.maxRetries !== 'number' ||
      !Number.isSafeInteger(options.maxRetries) ||
      options.maxRetries < 0)
  )
    throw new TypeError(
      'requestOptions.maxRetries must be a nonnegative integer',
    );
  return options as unknown as ModelRequestOptions;
}

function captureRequestOptionsSource(
  options: ModelAdapterOptions,
): CapturedRequestOptions {
  const value = options.requestOptions;
  return value === undefined || typeof value === 'function'
    ? value
    : captureRequestOptions(value);
}

const modelRequestTransport = new WeakMap<ModelRequest, ModelRequestOptions>();

/** @internal Bind transport preferences to the exact native producer request. */
export function markModelRequestTransport(
  request: ModelRequest,
  value: unknown,
): void {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid native model transport options');
  const { headers, query } = value as { headers?: unknown; query?: unknown };
  modelRequestTransport.set(
    request,
    captureRequestOptions({
      ...(headers == null ? {} : { headers }),
      ...(query == null ? {} : { query }),
    }),
  );
}

async function clientRequestOptions(
  source: CapturedRequestOptions,
  request: ModelRequest,
) {
  request.signal.throwIfAborted();
  const disableProviderRetries = request.disableProviderRetries === true;
  const pending =
    typeof source === 'function'
      ? source(
          Object.freeze({
            ...request,
            body: copyJsonValue(request.body) as JsonObject,
          }),
        )
      : source;
  const value =
    pending &&
    typeof (pending as Promise<ModelRequestOptions>).then === 'function'
      ? await pending
      : pending;
  request.signal.throwIfAborted();
  const selected = value === undefined ? {} : captureRequestOptions(value);
  const scoped = modelRequestTransport.get(request);
  let headers = selected.headers;
  if (scoped?.headers !== undefined) {
    const overridden = new Set(
      Object.keys(scoped.headers).map((name) => name.toLowerCase()),
    );
    headers = {
      ...Object.fromEntries(
        Object.entries(headers ?? {}).filter(
          ([name]) => !overridden.has(name.toLowerCase()),
        ),
      ),
      ...scoped.headers,
    };
  }
  const query =
    scoped?.query === undefined
      ? selected.query
      : { ...selected.query, ...scoped.query };
  return {
    ...(headers === undefined ? {} : { headers }),
    ...(query === undefined ? {} : { query }),
    ...(selected.timeoutMs === undefined
      ? {}
      : { timeout: selected.timeoutMs }),
    ...(selected.maxRetries === undefined
      ? {}
      : { maxRetries: selected.maxRetries }),
    ...(disableProviderRetries ? { maxRetries: 0 } : {}),
    signal: request.signal,
  };
}

function capturePromptCacheKey(
  options: ModelAdapterOptions,
): string | undefined {
  const key = options.promptCacheKey;
  if (key !== undefined && typeof key !== 'string')
    throw new TypeError('promptCacheKey must be a string');
  return key;
}

function openAIRetryAdvice({
  request,
  error,
}: ModelRetryAdviceRequest): ModelRetryAdvice | undefined {
  if (
    error &&
    typeof error === 'object' &&
    modelErrorField(error, 'unsafeToReplay') === true
  )
    return { suggested: false, replaySafety: 'unsafe' };
  const hint = modelErrorHeader(error, 'x-should-retry')?.trim().toLowerCase();
  if (hint === 'true') return { suggested: true, replaySafety: 'safe' };
  if (hint === 'false') return { suggested: false };
  const status =
    modelErrorField(error, 'statusCode') ?? modelErrorField(error, 'status');
  if (
    !request.body.previous_response_id &&
    !request.body.conversation &&
    (status === 408 ||
      status === 409 ||
      status === 429 ||
      (typeof status === 'number' && status >= 500))
  )
    return { suggested: true };
  return undefined;
}
type ApplyPatchWire = 'workspace' | 'editor';

const editorPatchParameters = z.object({
  operation: applyPatchOperationSchema,
});

function patchWireForTool(tool: JsonObject): ApplyPatchWire | undefined {
  if (tool.type === 'apply_patch') return 'editor';
  if (tool.type === 'custom' && tool.name === 'apply_patch') return 'workspace';
}

function workspacePatchFunction(wire: ApplyPatchWire) {
  const editorParameters = z.toJSONSchema(editorPatchParameters, {
    io: 'input',
  });
  if (wire === 'editor')
    return {
      name: 'apply_patch',
      description:
        "Apply an operation with the application's workspace editor.",
      parameters: editorParameters,
      strict: false,
    };
  return {
    name: 'apply_patch',
    description:
      'Apply a freeform patch or one structured operation in the workspace.',
    parameters: {
      ...editorParameters,
      properties: {
        ...editorParameters.properties,
        patch: {
          type: 'string',
          description: 'An apply_patch patch beginning with *** Begin Patch.',
        },
      },
      required: [],
      oneOf: [{ required: ['patch'] }, { required: ['operation'] }],
      additionalProperties: false,
    },
    strict: false,
  };
}

function isWorkspacePatchPath(path: string): boolean {
  return (
    path !== '' &&
    !/\p{White_Space}$/u.test(path) &&
    !['\r', '\n', '\0'].some((control) => path.includes(control))
  );
}

function workspaceOperationPatch(value: unknown): string {
  const parsed = applyPatchOperationSchema.safeParse(value);
  if (!parsed.success) return '';
  const operation = parsed.data;
  if (!isWorkspacePatchPath(operation.path)) return '';

  const begin = '*** Begin Patch';
  const end = '*** End Patch';
  if (operation.type === 'delete_file') {
    return [begin, '*** Delete File: ' + operation.path, end].join('\n');
  }

  const lines = [begin];
  const diff = operation.diff.replaceAll('\r\n', '\n').replace(/\n$/, '');
  const changes = diff === '' ? [] : diff.split('\n');
  if (operation.type === 'create_file') {
    if (!changes.every((line) => line.startsWith('+'))) return '';
    lines.push('*** Add File: ' + operation.path);
  } else {
    lines.push('*** Update File: ' + operation.path);
    if (operation.move_to !== undefined) {
      if (!isWorkspacePatchPath(operation.move_to)) return '';
      lines.push('*** Move to: ' + operation.move_to);
    }
    // Keep raw hunk and environment directives out of this single operation.
    if (
      !changes.every(
        (line) =>
          line === '' ||
          line === '@@' ||
          line.startsWith('@@ ') ||
          line === '*** End of File' ||
          line.startsWith(' ') ||
          line.startsWith('+') ||
          line.startsWith('-'),
      )
    ) {
      return '';
    }
  }
  return lines.concat(changes, end).join('\n');
}

function workspacePatchInput(argumentsText: unknown): string {
  if (typeof argumentsText !== 'string') return '';
  try {
    const envelope = JSON.parse(argumentsText) as
      { patch?: unknown; operation?: unknown } | string | null;
    if (typeof envelope === 'string') return envelope;
    return typeof envelope?.patch === 'string'
      ? envelope.patch
      : workspaceOperationPatch(envelope?.operation);
  } catch {
    return argumentsText;
  }
}

function patchCallReplay(item: JsonObject) {
  if (item.type === 'apply_patch_call')
    return { wire: 'editor' as const, args: { operation: item.operation } };
  if (item.type === 'custom_tool_call' && item.name === 'apply_patch')
    return { wire: 'workspace' as const, args: { patch: item.input } };
}

function matchesPatchOutput(
  item: JsonObject,
  calls: ReadonlyMap<string, ApplyPatchWire>,
): boolean {
  const wire = calls.get(item.call_id as string);
  return (
    (wire === 'editor' && item.type === 'apply_patch_call_output') ||
    (wire === 'workspace' && item.type === 'custom_tool_call_output')
  );
}

function functionToolOutput(
  item: JsonObject,
  applyPatchWire: ApplyPatchWire | undefined,
): JsonObject {
  if (!applyPatchWire || item.name !== 'apply_patch') return item;
  const { arguments: args, name, ...call } = item;
  if (applyPatchWire === 'editor') {
    try {
      const { operation } = editorPatchParameters.parse(
        JSON.parse(String(args)),
      );
      return {
        ...call,
        type: 'apply_patch_call',
        status: call.status ?? 'completed',
        operation,
      };
    } catch {
      throw new TypeError('apply_patch requires a valid editor operation');
    }
  }
  return {
    ...call,
    type: 'custom_tool_call',
    name,
    input: workspacePatchInput(args),
  };
}

/**
 * An injected async Chat Completions client. Core owns tool execution and history.
 * Native workspace ApplyPatch uses a function declaration on the provider wire.
 */
export class ChatCompletionsModel implements NativeModel {
  readonly stream?: (request: ModelRequest) => AsyncIterable<JsonObject>;
  readonly #includeUsage: boolean;
  readonly #promptCacheKey: string | undefined;
  readonly #requestOptions: CapturedRequestOptions;

  constructor(
    readonly client: any,
    readonly model?: string,
    options: ChatCompletionsModelOptions = {},
  ) {
    this.#promptCacheKey = capturePromptCacheKey(options);
    this.#requestOptions = captureRequestOptionsSource(options);
    this.#includeUsage = options.includeUsage ?? true;
    if (options.stream === true)
      this.stream = (request) => {
        const stream = this.#streamResponse(request);
        chatModelStreams.add(stream);
        return stream;
      };
  }
  getRetryAdvice(
    request: ModelRetryAdviceRequest,
  ): ModelRetryAdvice | undefined {
    return openAIRetryAdvice(request);
  }
  #parameters(request: ModelRequest, stream: boolean) {
    const messages: Record<string, unknown>[] = [];
    const nativeTools = [...((request.body.tools ?? []) as JsonObject[])];
    const applyPatchCalls = new Map<string, ApplyPatchWire>();
    let applyPatchWire: ApplyPatchWire | undefined;
    for (const raw of request.body.input as JsonObject[]) {
      const patchCall = patchCallReplay(raw);
      if (raw.type === 'additional_tools') {
        nativeTools.push(...(raw.tools as JsonObject[]));
        continue;
      }
      if (raw.type === 'message') {
        const content = (raw.content as JsonObject[]).map((part) => {
          if (part.type === 'input_text' || part.type === 'output_text')
            return { type: 'text', text: part.text };
          if (part.type === 'input_audio') {
            const audio = inlineAudioSource(part.audio_url);
            const mediaType = audio.mediaType.split(';', 1)[0].toLowerCase();
            const format = [
              'audio/wav',
              'audio/x-wav',
              'audio/wave',
              'audio/vnd.wave',
            ].includes(mediaType)
              ? 'wav'
              : ['audio/mpeg', 'audio/mp3'].includes(mediaType)
                ? 'mp3'
                : undefined;
            if (!format)
              throw new TypeError('Chat audio requires WAV or MP3 input');
            return {
              type: 'input_audio',
              input_audio: { data: audio.data, format },
            };
          }
          if (part.type === 'input_image' && part.image_url)
            return {
              type: 'image_url',
              image_url: {
                url: part.image_url,
                ...(part.detail ? { detail: part.detail } : {}),
              },
            };
          throw new TypeError(
            'ChatCompletionsModel received unsupported message content',
          );
        });
        const previous = messages.at(-1);
        if (raw.role === 'assistant' && previous?.role === 'assistant')
          previous.content = [
            ...((previous.content as unknown[]) ?? []),
            ...content,
          ];
        else messages.push({ role: raw.role, content });
      } else if (raw.type === 'function_call' || patchCall) {
        if (raw.namespace != null && raw.namespace !== 'functions')
          throw new TypeError(
            'ChatCompletionsModel supports the default function namespace',
          );
        let assistant = messages.at(-1);
        if (assistant?.role !== 'assistant') {
          assistant = { role: 'assistant', tool_calls: [] };
          messages.push(assistant);
        }
        const calls = (assistant.tool_calls ??= []) as Record<
          string,
          unknown
        >[];
        if (patchCall)
          applyPatchCalls.set(raw.call_id as string, patchCall.wire);
        calls.push({
          id: raw.call_id,
          type: 'function',
          function: {
            name: patchCall ? 'apply_patch' : raw.name,
            arguments: patchCall
              ? JSON.stringify(patchCall.args)
              : raw.arguments,
          },
        });
      } else if (
        raw.type === 'function_call_output' ||
        matchesPatchOutput(raw, applyPatchCalls)
      ) {
        const output =
          raw.type === 'apply_patch_call_output'
            ? JSON.stringify({ status: raw.status, output: raw.output })
            : (raw.output as string | JsonObject[]);
        if (
          typeof output !== 'string' &&
          (!Array.isArray(output) ||
            output.some(
              (part) =>
                part?.type !== 'input_text' || typeof part.text !== 'string',
            ))
        )
          throw new TypeError(
            'ChatCompletionsModel supports only text tool outputs',
          );
        messages.push({
          role: 'tool',
          tool_call_id: raw.call_id,
          content:
            typeof output === 'string'
              ? output
              : output.map((part) => part.text).join(''),
        });
      } else if (
        raw.type !== 'reasoning' &&
        raw.type !== 'configuration_update'
      )
        throw new TypeError(
          'ChatCompletionsModel received an unsupported native input item',
        );
    }
    const tools = nativeTools.flatMap((declaration) => {
      if (declaration.type === 'namespace' && declaration.name !== 'functions')
        throw new TypeError(
          'ChatCompletionsModel supports the default function namespace',
        );
      const leaves =
        declaration.type === 'namespace'
          ? (declaration.tools as JsonObject[])
          : [declaration];
      return leaves.map((declaration) => {
        const { type, ...tool } = declaration;
        if (tool.namespace != null && tool.namespace !== 'functions')
          throw new TypeError(
            'Chat adapters support the default function namespace',
          );
        const patchWire = patchWireForTool(declaration);
        if (patchWire) {
          applyPatchWire = patchWire;
          return {
            type: 'function',
            function: workspacePatchFunction(patchWire),
          };
        }
        if (type !== 'function')
          throw new TypeError(
            'ChatCompletionsModel supports native function tools',
          );
        if (tool.output_schema != null)
          throw new TypeError('Tool output schemas require the Responses API');
        return {
          type: 'function',
          function: Object.fromEntries(
            Object.entries(tool).filter(([key]) =>
              ['name', 'description', 'parameters', 'strict'].includes(key),
            ),
          ),
        };
      });
    });
    const options: Record<string, unknown> = Object.fromEntries(
      [
        'temperature',
        'top_p',
        'parallel_tool_calls',
        'tool_choice',
        'metadata',
        'store',
        'frequency_penalty',
        'presence_penalty',
        'service_tier',
        'prompt_cache_retention',
        'prompt_cache_options',
        'seed',
        'stop',
        'logit_bias',
        'user',
        'safety_identifier',
        'prediction',
        'logprobs',
        'response_format',
        'prompt_cache_key',
      ]
        .filter((key) => key in request.body)
        .map((key) => [key, request.body[key]]),
    );
    if (this.#promptCacheKey !== undefined)
      options.prompt_cache_key = this.#promptCacheKey;
    if (
      Object.keys(request.body).some(
        (key) =>
          !Object.hasOwn(options, key) &&
          ![
            'model',
            'input',
            'tools',
            'stream',
            'stream_options',
            'reasoning',
            'text',
            'include',
            'client_metadata',
            'access_programs',
            'max_output_tokens',
            'top_logprobs',
            'prompt',
            'truncation',
            'context_management',
          ].includes(key),
      )
    )
      throw new TypeError(
        'ChatCompletionsModel received unsupported request controls',
      );
    const text = (request.body.text ?? {}) as JsonObject;
    if (text.verbosity != null) options.verbosity = text.verbosity;
    const format = (text.format ?? {}) as JsonObject;
    if (format.type === 'json_schema') {
      const { type: _type, ...jsonSchema } = format;
      options.response_format = {
        type: 'json_schema',
        json_schema: jsonSchema,
      };
    }
    const reasoning = (request.body.reasoning ?? {}) as JsonObject;
    if (reasoning.effort != null) options.reasoning_effort = reasoning.effort;
    if (
      'top_logprobs' in request.body ||
      ((request.body.include ?? []) as string[]).includes(
        'message.output_text.logprobs',
      )
    ) {
      options.logprobs = true;
      if ('top_logprobs' in request.body)
        options.top_logprobs = request.body.top_logprobs;
    }
    if (
      ['prompt', 'truncation', 'context_management'].some(
        (key) => key in request.body,
      )
    )
      throw new TypeError(
        'Responses-only request controls require a Responses provider or custom NativeModel',
      );
    if ('max_output_tokens' in request.body)
      options.max_completion_tokens = request.body.max_output_tokens;
    if (
      options.tool_choice != null &&
      typeof options.tool_choice === 'object'
    ) {
      options.tool_choice = {
        type: 'function',
        function: {
          name: selectedFunctionName(
            options.tool_choice,
            tools.map((tool: any) => tool.function.name),
            applyPatchWire === 'workspace',
          ),
        },
      };
    }
    if (tools.length) options.tools = tools;
    else {
      delete options.tool_choice;
      delete options.parallel_tool_calls;
    }
    return {
      applyPatchWire,
      body: {
        model: this.model ?? request.body.model,
        messages,
        stream,
        ...options,
        ...(stream && this.#includeUsage
          ? { stream_options: { include_usage: true } }
          : {}),
      },
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { body, applyPatchWire } = this.#parameters(request, false);
    const value = await this.client.chat.completions.create(
      body,
      await clientRequestOptions(this.#requestOptions, request),
    );
    const response = chatCompletionResult(value, applyPatchWire);
    if (
      !request.signal.aborted &&
      (request as ModelRequest & { [rawProviderRequest]?: boolean })[
        rawProviderRequest
      ]
    )
      Object.defineProperty(response, rawChatCompletion, {
        value: copyJsonValue(value),
      });
    return response;
  }

  async *#streamResponse(request: ModelRequest): AsyncIterable<JsonObject> {
    const { body, applyPatchWire } = this.#parameters(request, true);
    const chunks: AsyncIterable<ChatCompletionChunk> =
      await this.client.chat.completions.create(
        body,
        await clientRequestOptions(this.#requestOptions, request),
      );
    const messageId = 'msg_chat_' + randomUUID();
    const observeRaw = (
      request as ModelRequest & { [rawProviderRequest]?: boolean }
    )[rawProviderRequest];
    let responseId: string | undefined;
    let finishReason:
      | NonNullable<ChatCompletionChunk['choices'][number]['finish_reason']>
      | undefined;
    let text: string | undefined;
    let refusal: string | undefined;
    let usage: ChatCompletion['usage'];
    let bufferedBytes = 0;
    let logprobs:
      | NonNullable<NonNullable<ChatCompletion.Choice['logprobs']>['content']>
      | undefined;
    const calls = new Map<
      number,
      {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }
    >();
    for await (const chunk of chunks) {
      const opening = responseId === undefined;
      if (opening) {
        if (typeof chunk.id !== 'string' || !chunk.id.trim())
          throw new TypeError(
            'ChatCompletionsModel stream requires a response ID',
          );
        responseId = chunk.id;
      }
      if (chunk.id !== responseId)
        throw new TypeError('ChatCompletionsModel stream changed response ID');
      if (chunk.usage != null) {
        usage = chunk.usage;
        const measured = chatCompletionUsage(usage);
        // The borrowed iterator may fail or be cancelled during its next advance.
        request.reportUsage?.({
          inputTokens: measured.input_tokens,
          cachedInputTokens: measured.cached_input_tokens,
          cacheWriteInputTokens: 0,
          outputTokens: measured.output_tokens,
          reasoningOutputTokens: measured.reasoning_output_tokens,
          totalTokens: measured.total_tokens,
        });
      }
      request.signal.throwIfAborted();
      if (observeRaw) {
        const original = copyJsonValue(chunk) as JsonObject;
        rawChatChunks.add(original);
        yield original;
      }
      if (opening)
        yield { type: 'response.created', response: { id: responseId } };
      if (chunk.choices.length === 0) continue;
      const [choice] = chunk.choices;
      if (chunk.choices.length !== 1 || choice.index !== 0)
        throw new TypeError(
          'ChatCompletionsModel requires exactly one response choice',
        );
      if (finishReason !== undefined)
        throw new TypeError(
          'ChatCompletionsModel stream continued after its final choice',
        );
      const { delta } = choice;
      bufferedBytes += Buffer.byteLength(
        JSON.stringify({
          content: delta.content,
          refusal: delta.refusal,
          toolCalls: delta.tool_calls,
          logprobs: choice.logprobs?.content,
        }),
      );
      if (bufferedBytes > maxChatStreamBytes)
        throw new TypeError(
          'ChatCompletionsModel stream exceeded its buffer limit',
        );
      if (delta.content != null) {
        if (text === undefined)
          yield {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              content: [],
            },
          };
        text = (text ?? '') + delta.content;
        yield {
          type: 'response.output_text.delta',
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta: delta.content,
          ...(choice.logprobs?.content == null
            ? {}
            : { logprobs: copyJsonValue(choice.logprobs.content) }),
        };
      }
      if (delta.refusal != null) refusal = (refusal ?? '') + delta.refusal;
      if (choice.logprobs?.content != null)
        (logprobs ??= []).push(...choice.logprobs.content);
      for (const fragment of delta.tool_calls ?? []) {
        if (
          !Number.isSafeInteger(fragment.index) ||
          fragment.index < 0 ||
          (fragment.type != null && fragment.type !== 'function')
        )
          throw new TypeError(
            'ChatCompletionsModel received an unsupported tool call',
          );
        let call = calls.get(fragment.index);
        if (!call) {
          call = {
            id: '',
            type: 'function',
            function: { name: '', arguments: '' },
          };
          calls.set(fragment.index, call);
        }
        if (fragment.id != null) {
          if (call.id && call.id !== fragment.id)
            throw new TypeError(
              'ChatCompletionsModel stream changed a tool call ID',
            );
          call.id = fragment.id;
        }
        call.function.name += fragment.function?.name ?? '';
        call.function.arguments += fragment.function?.arguments ?? '';
      }
      finishReason = choice.finish_reason ?? undefined;
    }
    request.signal.throwIfAborted();
    if (responseId === undefined || finishReason === undefined)
      throw new TypeError(
        'ChatCompletionsModel stream ended without a completed choice',
      );
    const toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);
    if (
      toolCalls.some(
        ({ id, function: { name } }) => !id.trim() || !name.trim(),
      ) ||
      new Set(toolCalls.map(({ id }) => id)).size !== toolCalls.length
    )
      throw new TypeError(
        'ChatCompletionsModel stream requires a name and a unique ID for each tool call',
      );
    const result = chatCompletionResult(
      {
        id: responseId,
        usage,
        choices: [
          {
            index: 0,
            finish_reason: finishReason,
            logprobs:
              logprobs === undefined
                ? null
                : { content: logprobs, refusal: null },
            message: {
              role: 'assistant',
              content: text ?? null,
              refusal: refusal ?? null,
              tool_calls: toolCalls,
            },
          },
        ],
      },
      applyPatchWire,
    );
    const output = result.output.map((item) => ({
      ...item,
      id: item.type === 'message' ? messageId : 'item_chat_' + randomUUID(),
    }));
    for (const [index, item] of output.entries())
      yield { type: 'response.output_item.done', output_index: index, item };
    yield {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        output,
        ...(result.usage === undefined
          ? {}
          : {
              usage: {
                input_tokens: result.usage.input_tokens ?? 0,
                output_tokens: result.usage.output_tokens ?? 0,
                total_tokens: result.usage.total_tokens ?? 0,
                input_tokens_details: {
                  cached_tokens: result.usage.cached_input_tokens ?? 0,
                },
                output_tokens_details: {
                  reasoning_tokens: result.usage.reasoning_output_tokens ?? 0,
                },
              },
            }),
      },
    };
  }
}

function chatCompletionUsage(usage: NonNullable<ChatCompletion['usage']>) {
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
    cached_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    reasoning_output_tokens:
      usage.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

function chatCompletionResult(
  value: Pick<ChatCompletion, 'id' | 'choices' | 'usage'>,
  applyPatchWire: ApplyPatchWire | undefined,
): ModelResponse {
  if (!Array.isArray(value.choices) || value.choices.length !== 1)
    throw new TypeError(
      'ChatCompletionsModel requires exactly one response choice',
    );
  const choice = value.choices[0];
  const message = choice.message;
  if (
    !['stop', 'tool_calls'].includes(choice.finish_reason) &&
    message.refusal == null
  ) {
    const reason =
      choice.finish_reason === 'length'
        ? 'length'
        : choice.finish_reason === 'content_filter'
          ? 'content_filter'
          : 'unsupported';
    throw new TypeError(
      `ChatCompletionsModel cannot complete finish_reason=${reason}`,
    );
  }
  const output: JsonObject[] = [];
  const content: JsonObject[] = [];
  if (message.content != null) {
    const part: JsonObject = { type: 'output_text', text: message.content };
    const probabilities = value.choices[0].logprobs?.content;
    if (probabilities != null) part.logprobs = copyJsonValue(probabilities);
    content.push(part);
  }
  if (message.refusal != null)
    content.push({ type: 'refusal', refusal: message.refusal });
  if (content.length)
    output.push({ type: 'message', role: 'assistant', content });
  for (const call of message.tool_calls ?? []) {
    if (call.type !== 'function')
      throw new TypeError(
        'ChatCompletionsModel received an unsupported tool call',
      );
    output.push(
      functionToolOutput(
        {
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        },
        applyPatchWire,
      ),
    );
  }
  const usage =
    value.usage == null ? undefined : chatCompletionUsage(value.usage);
  return { responseId: value.id, output, usage };
}

/** Borrow a Responses client; Core retains the turn, tool and history owners. */
export class ResponsesModel implements NativeModel {
  readonly stream?: (
    request: ModelRequest,
  ) => Promise<AsyncIterable<JsonObject>>;
  readonly #promptCacheKey: string | undefined;
  readonly #requestOptions: CapturedRequestOptions;

  constructor(
    readonly client: any,
    readonly model?: string,
    options: ResponsesModelOptions = {},
  ) {
    this.#promptCacheKey = capturePromptCacheKey(options);
    this.#requestOptions = captureRequestOptionsSource(options);
    if (options.stream === true)
      this.stream = (request) => this.#create(request, true);
  }

  getRetryAdvice(
    request: ModelRetryAdviceRequest,
  ): ModelRetryAdvice | undefined {
    return openAIRetryAdvice(request);
  }
  async #create(request: ModelRequest, stream: boolean): Promise<any> {
    try {
      const pending = this.client.responses.create(
        {
          ...request.body,
          model: this.model ?? request.body.model,
          ...(this.#promptCacheKey !== undefined
            ? { prompt_cache_key: this.#promptCacheKey }
            : {}),
          stream,
        },
        await clientRequestOptions(this.#requestOptions, request),
      );
      if (!stream) return await pending;
      const response =
        typeof pending.withResponse === 'function'
          ? await pending.withResponse()
          : { data: await pending };
      const events = response.data;
      borrowedResponsesStreams.set(events, {
        ...(typeof response.request_id === 'string'
          ? { upstreamRequestId: response.request_id }
          : {}),
        abort: () => events.controller?.abort(),
      });
      return events;
    } catch (error) {
      // Borrowed ESM clients can throw the other OpenAI module graph's class.
      if (
        request.signal.aborted &&
        (error instanceof APIUserAbortError ||
          (error instanceof Error &&
            error.constructor?.name === 'APIUserAbortError' &&
            'status' in error &&
            error.status === undefined))
      )
        request.signal.throwIfAborted();
      throw error;
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return projectResponsesResponse(await this.#create(request, false));
  }
}

function hasResponsesRefusal(output: readonly JsonObject[]): boolean {
  return output.some(
    (item) =>
      item?.type === 'message' &&
      Array.isArray(item.content) &&
      item.content.some(
        (part) =>
          part !== null &&
          typeof part === 'object' &&
          !Array.isArray(part) &&
          part.type === 'refusal' &&
          typeof part.refusal === 'string',
      ),
  );
}

function projectResponsesResponse(response: any): ModelResponse {
  const output = (response.output ?? []) as JsonObject[];
  const refusal = hasResponsesRefusal(output);
  if (response.status !== 'completed' && !refusal)
    throw new TypeError('Responses adapter requires a completed response');
  const usage = response.usage;
  const cacheWrite =
    usage?.input_tokens_details?.cache_write_tokens ?? undefined;
  const projected: ModelResponse = {
    output,
    ...(response.id ? { responseId: response.id } : {}),
    ...(usage
      ? {
          usage: {
            input_tokens: usage.input_tokens ?? 0,
            output_tokens: usage.output_tokens ?? 0,
            total_tokens: usage.total_tokens ?? 0,
            cached_input_tokens: usage.input_tokens_details?.cached_tokens ?? 0,
            cache_write_input_tokens: cacheWrite ?? 0,
            reasoning_output_tokens:
              usage.output_tokens_details?.reasoning_tokens ?? 0,
          },
        }
      : {}),
  };
  Object.defineProperty(projected, receivedCacheWriteUsage, {
    value: Object.freeze({ count: cacheWrite ?? null }),
  });
  if (
    response.status === 'completed' &&
    typeof response.id === 'string' &&
    response.id.trim().length > 0 &&
    usage &&
    typeof usage === 'object' &&
    !Array.isArray(usage)
  )
    Object.defineProperty(projected, originalResponsesUsage, {
      value: {
        usage,
        responseId: response.id,
        upstreamRequestId: response._request_id,
      },
    });
  return projected;
}

/** AI SDK language models are borrowed; optional provider packages remain application-owned. */
export interface AiSdkLanguageModel {
  readonly specificationVersion: 'v2' | 'v3' | 'v4';
  readonly modelId: string;
  readonly provider: string;
  doGenerate(options: any): PromiseLike<any> | any;
  doStream?(
    options: any,
  ):
    | PromiseLike<{ stream: ReadableStream<any> }>
    | { stream: ReadableStream<any> };
}

function aiSdkImageSource(source: string): {
  data: string | URL;
  mediaType: string;
} {
  captureImage({ image_url: source });
  const comma = source.startsWith('data:') ? source.indexOf(',') : -1;
  return comma < 0
    ? { data: new URL(source), mediaType: 'image/*' }
    : {
        data: source.slice(comma + 1),
        mediaType: source.slice(5, comma).split(';')[0],
      };
}

type AiSdkFileOptionsResolver = (
  file: Readonly<FileReference>,
) =>
  | { readonly mediaType?: string; readonly providerOptions?: JsonObject }
  | undefined;

function aiSdkFilePart(
  part: JsonObject,
  version: AiSdkLanguageModel['specificationVersion'],
  resolveOptions?: AiSdkFileOptionsResolver,
) {
  const reference = { ...part };
  delete reference.type;
  const file = captureFile(reference);
  const source = file.file_data ?? file.file_url;
  if (source === undefined)
    throw new TypeError('AiSdkModel does not support provider file IDs');

  const url = file.file_url ? new URL(file.file_url) : undefined;
  const comma = /^data:/i.test(source) ? source.indexOf(',') : -1;
  const options = resolveOptions?.(Object.freeze(file));
  const hasPdfName = [file.filename, url?.pathname].some((name) =>
    name?.toLowerCase().endsWith('.pdf'),
  );
  const mediaType =
    comma >= 0
      ? source.slice(5, comma).split(';')[0]?.trim()
      : (options?.mediaType ?? (hasPdfName ? 'application/pdf' : undefined));
  if (typeof mediaType !== 'string' || !mediaType.trim())
    throw new TypeError('AiSdkModel file inputs require a media type');

  const data = url ?? source.slice(comma + 1);
  return {
    type: 'file',
    mediaType,
    data:
      version !== 'v4'
        ? data
        : typeof data === 'string'
          ? { type: 'data', data }
          : { type: 'url', url: data },
    ...(file.filename ? { filename: file.filename } : {}),
    ...(options?.providerOptions == null
      ? {}
      : { providerOptions: copyJsonValue(options.providerOptions) }),
  };
}

type AiSdkReasoningMetadata = {
  itemId?: string;
  reasoningEncryptedContent?: string;
};

function aiSdkReasoningMetadata(part: any): AiSdkReasoningMetadata {
  const metadata = part.providerMetadata?.openai;
  const id = metadata?.itemId;
  const encrypted = metadata?.reasoningEncryptedContent;
  if (
    (id != null && (typeof id !== 'string' || id.length === 0)) ||
    (encrypted != null && typeof encrypted !== 'string')
  )
    throw new TypeError(
      'AiSdkModel received invalid Responses reasoning metadata',
    );
  return {
    ...(id == null ? {} : { itemId: id }),
    ...(encrypted == null ? {} : { reasoningEncryptedContent: encrypted }),
  };
}

const aiSdkStreamTextParts = Symbol('aiSdkStreamTextParts');

type AiSdkTextPart = {
  text: string;
  providerMetadata?: JsonObject;
};

type AiSdkStreamText = {
  type: 'text';
  [aiSdkStreamTextParts]: AiSdkTextPart[];
};

type AiSdkStreamTextBlock = {
  metadata?: JsonObject;
  active?: {
    message: AiSdkStreamText;
    part: AiSdkTextPart;
    index: number;
    signedDelta: boolean;
  };
};

const googleThoughtSignatureOptions = ['google', 'googleVertex', 'vertex'];

function hasAiSdkThoughtSignature(metadata: JsonObject | undefined): boolean {
  return googleThoughtSignatureOptions.some(
    (provider) =>
      typeof (metadata?.[provider] as JsonObject | undefined)
        ?.thoughtSignature === 'string',
  );
}

const aiSdkStreamReasoningBlocks = Symbol('aiSdkStreamReasoningBlocks');

type AiSdkStreamReasoning = {
  type: 'reasoning';
  providerMetadata: JsonObject & { openai: AiSdkReasoningMetadata };
  [aiSdkStreamReasoningBlocks]: { text: string }[];
};

type AiSdkStreamReasoningBlock = {
  text: string;
  ended: boolean;
  item?: AiSdkStreamReasoning;
  metadata?: JsonObject;
};

function aiSdkToolArguments(input: unknown, schema: any): string | undefined {
  const type = schema?.type;
  const object =
    type === 'object' ||
    (Array.isArray(type) && type.includes('object')) ||
    (type === undefined &&
      Boolean(schema?.properties || schema?.additionalProperties));
  if ((input === '' || input === undefined) && object) return '{}';
  return typeof input === 'string' ? input : JSON.stringify(input);
}

/** AI SDK generation within the native Core turn and tool loop.
 * Streaming: new AiSdkModel(model, {}, {stream: true}).
 * Renamed OpenAI factories: new AiSdkModel(model, {}, {providerFamily: 'openai'}).
 */
export class AiSdkModel implements NativeModel {
  readonly stream?: (request: ModelRequest) => AsyncIterable<JsonObject>;
  readonly #providerOptions: JsonObject;
  readonly #openai: boolean;
  readonly #openaiChat: boolean;
  readonly #openaiResponses: boolean;
  readonly #resolveFileOptions: AiSdkFileOptionsResolver | undefined;

  constructor(
    readonly model: AiSdkLanguageModel,
    providerOptions: JsonObject = {},
    adapterOptions: {
      readonly providerFamily?: 'openai';
      readonly stream?: boolean;
      /** Supply media type hints and provider options for an admitted file. */
      readonly resolveFileOptions?: AiSdkFileOptionsResolver;
    } = {},
  ) {
    if (!['v2', 'v3', 'v4'].includes(model.specificationVersion))
      throw new TypeError('AiSdkModel supports AI SDK v2, v3 and v4 models');
    if (adapterOptions.stream === true) {
      if (typeof model.doStream !== 'function')
        throw new TypeError('AiSdkModel streaming requires doStream');
      this.stream = (request) => this.#streamResponse(request);
    }
    this.#providerOptions = copyJsonValue(providerOptions) as JsonObject;
    this.#resolveFileOptions = adapterOptions.resolveFileOptions;
    this.#openai =
      adapterOptions.providerFamily === 'openai' ||
      model.provider.startsWith('openai.');
    this.#openaiResponses =
      this.#openai && model.provider.endsWith('.responses');
    this.#openaiChat = this.#openai && model.provider.endsWith('.chat');
  }

  getRetryAdvice({
    error,
  }: ModelRetryAdviceRequest): ModelRetryAdvice | undefined {
    const retryable = modelErrorField(error, 'isRetryable');
    return typeof retryable === 'boolean'
      ? { suggested: retryable }
      : undefined;
  }
  #parameters(request: ModelRequest) {
    const body = request.body;
    const admitted = new Set([
      'model',
      'input',
      'tools',
      'stream',
      'stream_options',
      'client_metadata',
      'access_programs',
      'store',
      'text',
      'include',
      'tool_choice',
      'parallel_tool_calls',
      'temperature',
      'top_p',
      'max_output_tokens',
      'frequency_penalty',
      'presence_penalty',
      'reasoning',
      'prompt_cache_key',
    ]);
    if (
      Object.keys(body).some((key) => !admitted.has(key)) ||
      body.store === true
    )
      throw new TypeError('AiSdkModel received unsupported request controls');
    const reasoning = (body.reasoning ?? {}) as JsonObject;
    const text = (body.text ?? {}) as JsonObject;
    const providerOptions = copyJsonValue(this.#providerOptions) as JsonObject;
    const thinking = (providerOptions.anthropic as JsonObject | undefined)
      ?.thinking as JsonObject | undefined;
    if (thinking != null && thinking.type !== 'disabled')
      throw new TypeError(
        'AiSdkModel does not support configured Anthropic thinking',
      );
    if (this.#openai) {
      const openaiOptions = (providerOptions.openai ?? {}) as JsonObject;
      providerOptions.openai = {
        ...openaiOptions,
        store: false,
        ...(body.prompt_cache_key != null &&
        !Object.hasOwn(openaiOptions, 'promptCacheKey')
          ? { promptCacheKey: body.prompt_cache_key }
          : {}),
        ...(body.parallel_tool_calls != null
          ? { parallelToolCalls: body.parallel_tool_calls }
          : {}),
        ...(text.verbosity != null ? { textVerbosity: text.verbosity } : {}),
        ...(reasoning.effort != null
          ? { reasoningEffort: reasoning.effort }
          : {}),
        ...(reasoning.summary != null
          ? { reasoningSummary: reasoning.summary }
          : {}),
      };
    } else if (reasoning.effort != null) {
      throw new TypeError(
        'AiSdkModel requires provider options for provider-specific reasoning',
      );
    }
    if (reasoning.summary != null && reasoning.summary !== 'auto')
      throw new TypeError('AiSdkModel received unsupported reasoning controls');
    if (
      (text.verbosity != null && !this.#openai) ||
      ((body.include ?? []) as string[]).some(
        (key) => key !== 'reasoning.encrypted_content',
      )
    )
      throw new TypeError('AiSdkModel received unsupported request controls');
    const prompt: any[] = [];
    const declarations = [...((body.tools ?? []) as JsonObject[])];
    const names = new Map<string, string>();
    const patchCalls = new Map<string, ApplyPatchWire>();
    for (const [inputIndex, item] of (body.input as JsonObject[]).entries()) {
      const providerMetadata = replayModelProviderMetadata(
        request,
        inputIndex,
        item,
        this.model.provider,
        this.model.modelId,
      );
      if (item.type === 'additional_tools') {
        declarations.push(...(item.tools as JsonObject[]));
        continue;
      }
      if (item.type === 'configuration_update') continue;
      if (item.type === 'message') {
        const parts = (item.content ?? []) as JsonObject[];
        const scopedMetadata = providerMetadata?.[modelTextPartMetadataKey];
        const messageMetadata =
          scopedMetadata === undefined ? providerMetadata : undefined;
        const content = parts.map((part, index) => {
          if (part.type === 'input_text' || part.type === 'output_text') {
            const metadata =
              messageMetadata ??
              (Array.isArray(scopedMetadata) &&
              scopedMetadata.length === parts.length
                ? scopedMetadata[index]
                : undefined);
            return {
              type: 'text',
              text: part.text,
              ...(metadata &&
              typeof metadata === 'object' &&
              !Array.isArray(metadata)
                ? { providerOptions: metadata }
                : {}),
            };
          }
          if (part.type === 'input_file')
            return aiSdkFilePart(
              part,
              this.model.specificationVersion,
              this.#resolveFileOptions,
            );
          if (part.type === 'input_audio') {
            const audio = inlineAudioSource(part.audio_url);
            return {
              type: 'file',
              mediaType: audio.mediaType,
              data:
                this.model.specificationVersion === 'v4'
                  ? { type: 'data', data: audio.data }
                  : audio.data,
            };
          }
          if (part.type === 'input_image' && part.image_url) {
            const { data: image, mediaType } = aiSdkImageSource(
              part.image_url as string,
            );
            const openai = this.#openai;
            if (part.detail != null && part.detail !== 'auto' && !openai)
              throw new TypeError(
                'AiSdkModel requires an OpenAI provider for explicit image detail',
              );
            const imageOptions =
              part.detail != null && openai
                ? { providerOptions: { openai: { imageDetail: part.detail } } }
                : {};
            return {
              type: 'file',
              mediaType,
              data:
                this.model.specificationVersion === 'v4'
                  ? typeof image === 'string'
                    ? { type: 'data', data: image }
                    : { type: 'url', url: image }
                  : image,
              ...imageOptions,
            };
          }
          throw new TypeError(
            'AiSdkModel received unsupported message content',
          );
        });
        if (item.role === 'system' || item.role === 'developer') {
          prompt.push({
            role: 'system',
            content: content
              .map((part) => {
                if (part.type !== 'text' || !('text' in part))
                  throw new TypeError('AiSdkModel requires text instructions');
                return part.text;
              })
              .join(''),
          });
        } else
          prompt.push({
            role: item.role,
            content,
            ...(messageMetadata ? { providerOptions: messageMetadata } : {}),
          });
      } else if (
        item.type === 'function_call' ||
        item.type === 'apply_patch_call' ||
        (item.type === 'custom_tool_call' && item.name === 'apply_patch')
      ) {
        const patchCall = patchCallReplay(item);
        if (item.namespace != null && item.namespace !== 'functions')
          throw new TypeError(
            'AiSdkModel supports the default function namespace',
          );
        const name = patchCall ? 'apply_patch' : (item.name as string);
        names.set(item.call_id as string, name);
        if (patchCall) patchCalls.set(item.call_id as string, patchCall.wire);
        const previous =
          providerMetadata || prompt.at(-1)?.providerOptions
            ? undefined
            : prompt.at(-1);
        const content = previous?.role === 'assistant' ? previous.content : [];
        content.push({
          type: 'tool-call',
          toolCallId: item.call_id,
          toolName: name,
          input: patchCall
            ? patchCall.args
            : JSON.parse(item.arguments as string),
          ...(providerMetadata ? { providerOptions: providerMetadata } : {}),
        });
        if (previous?.role !== 'assistant')
          prompt.push({
            role: 'assistant',
            content,
            ...(providerMetadata ? { providerOptions: providerMetadata } : {}),
          });
      } else if (item.type === 'reasoning') {
        if (!this.#openaiResponses)
          throw new TypeError(
            'AiSdkModel supports native reasoning replay only with OpenAI Responses',
          );
        const summary = (item.summary ?? []) as JsonObject[];
        if (
          summary.some(
            (part) =>
              part.type !== 'summary_text' || typeof part.text !== 'string',
          )
        )
          throw new TypeError(
            'AiSdkModel received unsupported reasoning summary',
          );
        const metadata =
          providerMetadata === undefined &&
          hasModelProviderMetadata(request, inputIndex, item)
            ? {}
            : {
                ...(item.id != null ? { itemId: item.id } : {}),
                ...(item.encrypted_content != null
                  ? { reasoningEncryptedContent: item.encrypted_content }
                  : {}),
              };
        const previous =
          providerMetadata || prompt.at(-1)?.providerOptions
            ? undefined
            : prompt.at(-1);
        const content = previous?.role === 'assistant' ? previous.content : [];
        for (const text of summary.length
          ? summary.map((part) => part.text)
          : [''])
          content.push({
            type: 'reasoning',
            text,
            providerOptions: mergeModelProviderMetadata(providerMetadata, {
              openai: metadata,
            }),
          });
        if (previous?.role !== 'assistant')
          prompt.push({
            role: 'assistant',
            content,
            ...(providerMetadata ? { providerOptions: providerMetadata } : {}),
          });
      } else if (
        item.type === 'function_call_output' ||
        matchesPatchOutput(item, patchCalls)
      ) {
        const value =
          item.type === 'apply_patch_call_output'
            ? JSON.stringify({ status: item.status, output: item.output })
            : item.output;
        let output: any;
        if (typeof value !== 'string') {
          if (!Array.isArray(value))
            throw new TypeError('AiSdkModel received unsupported tool output');
          const content = value.map((part: any) => {
            if (part.type === 'input_text' && typeof part.text === 'string')
              return { type: 'text', text: part.text };
            if (
              part.type === 'input_image' &&
              typeof part.image_url === 'string'
            ) {
              const { data, mediaType } = aiSdkImageSource(part.image_url);
              if (this.model.specificationVersion === 'v4')
                return {
                  type: 'file',
                  mediaType: data instanceof URL ? 'image' : mediaType,
                  data:
                    typeof data === 'string'
                      ? { type: 'data', data }
                      : { type: 'url', url: data },
                };
              if (this.model.specificationVersion === 'v3')
                return typeof data === 'string'
                  ? { type: 'image-data', data, mediaType }
                  : { type: 'image-url', url: data.toString() };
              if (data instanceof URL)
                throw new TypeError(
                  'AiSdkModel v2 does not support remote image tool outputs',
                );
              return { type: 'media', data, mediaType };
            }
            throw new TypeError('AiSdkModel received unsupported tool output');
          });
          output = value.some((part: any) => part.type === 'input_image')
            ? { type: 'content', value: content }
            : {
                type: 'text',
                value: content.map((part: any) => part.text).join(''),
              };
        } else output = { type: 'text', value };
        prompt.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: item.call_id,
              toolName: names.get(item.call_id as string),
              output,
            },
          ],
        });
      } else
        throw new TypeError('AiSdkModel received unsupported native input');
    }
    const tools: any[] = [];
    let applyPatchWire: ApplyPatchWire | undefined;
    const addTool = (item: JsonObject): void => {
      const patchWire = patchWireForTool(item);
      if (item.namespace != null && item.namespace !== 'functions')
        throw new TypeError(
          'AiSdkModel supports the default function namespace',
        );
      if (item.type === 'namespace') {
        if (item.name !== 'functions')
          throw new TypeError(
            'AiSdkModel supports the default function namespace',
          );
        for (const tool of item.tools as JsonObject[]) addTool(tool);
      } else if (patchWire) {
        applyPatchWire = patchWire;
        const declaration = workspacePatchFunction(patchWire);
        tools.push({
          type: 'function',
          name: declaration.name,
          description: declaration.description,
          inputSchema: declaration.parameters,
          strict: declaration.strict,
        });
      } else if (item.type === 'function') {
        if (item.output_schema != null)
          throw new TypeError(
            'AiSdkModel does not support tool output schemas',
          );
        tools.push({
          type: 'function',
          name: item.name,
          description: item.description,
          inputSchema: item.parameters,
          ...(item.strict == null ? {} : { strict: item.strict }),
        });
      } else throw new TypeError('AiSdkModel supports function tools');
    };
    for (const declaration of declarations) addTool(declaration);
    const choice = body.tool_choice;
    let toolChoice: any;
    if (typeof choice === 'string') toolChoice = { type: choice };
    else if (choice != null) {
      toolChoice = {
        type: 'tool',
        toolName: selectedFunctionName(
          choice,
          tools.map((tool: any) => tool.name),
          applyPatchWire === 'workspace',
        ),
      };
    }
    const format = (text.format ?? {}) as JsonObject;
    if (this.#openai && format.type === 'json_schema' && format.strict != null)
      (providerOptions.openai as JsonObject).strictJsonSchema = format.strict;
    if (!this.#openai && body.parallel_tool_calls === false)
      throw new TypeError(
        'AiSdkModel received unsupported parallel tool controls',
      );
    const responseFormat =
      format.type === 'json_schema'
        ? {
            type: 'json',
            schema: format.schema,
            name: format.name,
            description: format.description,
          }
        : { type: 'text' };
    const options: any = {
      prompt,
      ...(tools.length ? { tools, toolChoice } : {}),
      responseFormat,
      temperature: body.temperature,
      topP: body.top_p,
      maxOutputTokens: body.max_output_tokens,
      frequencyPenalty: body.frequency_penalty,
      presencePenalty: body.presence_penalty,
      providerOptions,
      abortSignal: request.signal,
    };
    return { options, tools, applyPatchWire };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { options, tools, applyPatchWire } = this.#parameters(request);
    let result: any;
    try {
      result = await this.model.doGenerate(options);
    } catch (error) {
      // AI SDK Responses schema compatibility for valid refusal parts.
      // Core whole-response refusal admission for successful HTTP responses.
      const failure = error as {
        name?: string;
        message?: string;
        statusCode?: number;
        responseBody?: string;
      } | null;
      if (
        this.#openaiResponses &&
        failure?.name === 'AI_APICallError' &&
        failure.message === 'Invalid JSON response' &&
        failure.statusCode === 200 &&
        typeof failure.responseBody === 'string'
      ) {
        let response: any;
        try {
          response = JSON.parse(failure.responseBody);
        } catch {
          /* Original parse error retention. */
        }
        if (
          Array.isArray(response?.output) &&
          hasResponsesRefusal(response.output)
        )
          return projectResponsesResponse(response);
      }
      throw error;
    }
    return this.#projectResponse(result, tools, applyPatchWire);
  }

  async *#streamResponse(request: ModelRequest): AsyncIterable<JsonObject> {
    const { options, tools, applyPatchWire } = this.#parameters(request);
    request.signal.throwIfAborted();
    const { stream } = await this.model.doStream!(options);
    const reader = stream.getReader();
    let cancellation: Promise<void> | undefined;
    const cancel = () =>
      (cancellation ??= reader.cancel(request.signal.reason));
    const abort = () => {
      void cancel().catch(() => {});
    };
    request.signal.addEventListener('abort', abort, { once: true });
    let responseId = 'resp_aisdk_' + randomUUID();
    let started = false;
    let finished = false;
    let finishReason: any;
    let usage: any;
    let bytes = 0;
    const content: any[] = [];
    const messageIds = new Map<number, string>();
    const pendingInputs = new Set<string>();
    const toolInputMetadata = new Map<string, JsonObject>();
    const calls = new Set<string>();
    const reasoningBlocks = new Map<string, AiSdkStreamReasoningBlock>();
    const reasoningItems = new Map<string, AiSdkStreamReasoning>();
    let text: AiSdkStreamText | undefined;
    const textBlocks = new Map<string, AiSdkStreamTextBlock>();
    const googleTextChunks = /^(google|vertex)(?:\.|$)/.test(
      this.model.provider,
    );
    let responseProviderMetadata: JsonObject | undefined;
    try {
      request.signal.throwIfAborted();
      while (true) {
        const next = await reader.read();
        request.signal.throwIfAborted();
        if (next.done) break;
        const part = next.value;
        bytes += Buffer.byteLength(JSON.stringify(part));
        if (bytes > maxChatStreamBytes)
          throw new TypeError('AiSdkModel stream exceeded its buffer limit');
        if (part.type === 'error') throw part.error;
        if (finished && part.type !== 'response-metadata')
          throw new TypeError('AiSdkModel stream continued after finish');
        if (part.type === 'response-metadata') {
          responseProviderMetadata = mergeModelProviderMetadata(
            responseProviderMetadata,
            part.providerMetadata,
          );
          if (!started && typeof part.id === 'string' && part.id.trim())
            responseId = part.id;
          continue;
        }
        if (
          !started &&
          ['text-delta', 'tool-call', 'reasoning-start', 'finish'].includes(
            part.type,
          )
        ) {
          started = true;
          yield { type: 'response.created', response: { id: responseId } };
        }
        switch (part.type) {
          case 'text-delta': {
            if (typeof part.delta !== 'string')
              throw new TypeError(
                'AiSdkModel received unsupported output content',
              );
            const metadata = mergeModelProviderMetadata(
              undefined,
              part.providerMetadata,
            );
            const signedDelta = hasAiSdkThoughtSignature(metadata);
            if (!text) {
              text = { type: 'text', [aiSdkStreamTextParts]: [] };
              content.push(text);
              const id = 'msg_aisdk_' + randomUUID();
              messageIds.set(content.length - 1, id);
              yield {
                type: 'response.output_item.added',
                output_index: content.length - 1,
                item: { id, type: 'message', role: 'assistant', content: [] },
              };
            }
            const block = textBlocks.get(part.id) ?? {};
            textBlocks.set(part.id, block);
            let active = block.active;
            // Google can sign an earlier delta with a later empty chunk.
            // Preserve each wire text part even if the AI SDK reuses its block ID.
            if (
              active?.message !== text ||
              active.index !== text[aiSdkStreamTextParts].length - 1 ||
              (part.delta !== '' &&
                active.part.text !== '' &&
                (googleTextChunks || signedDelta || active.signedDelta))
            ) {
              const parts = text[aiSdkStreamTextParts];
              const textPart: AiSdkTextPart = {
                text: '',
                providerMetadata: active ? undefined : block.metadata,
              };
              active = {
                message: text,
                part: textPart,
                index: parts.length,
                signedDelta: false,
              };
              block.active = active;
              parts.push(textPart);
            }
            active.part.providerMetadata = mergeModelProviderMetadata(
              active.part.providerMetadata,
              metadata,
            );
            active.part.text += part.delta;
            active.signedDelta ||= signedDelta;
            yield {
              type: 'response.output_text.delta',
              item_id: messageIds.get(content.length - 1)!,
              output_index: content.length - 1,
              content_index: active.index,
              delta: part.delta,
            };
            break;
          }
          case 'reasoning-start':
          case 'reasoning-delta':
          case 'reasoning-end': {
            if (!this.#openaiResponses)
              throw new TypeError(
                'AiSdkModel supports native reasoning replay only with OpenAI Responses',
              );
            const id = part.id;
            if (typeof id !== 'string' || !id)
              throw new TypeError('AiSdkModel requires a reasoning block ID');
            let block = reasoningBlocks.get(id);
            if (part.type === 'reasoning-start') {
              if (block)
                throw new TypeError(
                  'AiSdkModel received a duplicate reasoning block',
                );
              block = { text: '', ended: false };
              reasoningBlocks.set(id, block);
            }
            if (!block || block.ended)
              throw new TypeError(
                'AiSdkModel received an inactive reasoning block',
              );
            block.metadata = mergeModelProviderMetadata(
              block.metadata,
              part.providerMetadata,
            );
            const metadata = aiSdkReasoningMetadata(part);
            if (part.type === 'reasoning-delta') {
              if (typeof part.delta !== 'string')
                throw new TypeError(
                  'AiSdkModel received invalid reasoning text',
                );
              block.text += part.delta;
            }
            const itemId = metadata.itemId;
            const existingItem =
              itemId == null ? undefined : reasoningItems.get(itemId);
            const currentId = block.item?.providerMetadata.openai.itemId;
            if (
              (existingItem && block.item && existingItem !== block.item) ||
              (currentId != null && itemId != null && currentId !== itemId)
            )
              throw new TypeError(
                'AiSdkModel received conflicting Responses reasoning IDs',
              );
            if (
              !block.item &&
              (block.text !== '' ||
                itemId != null ||
                metadata.reasoningEncryptedContent != null)
            ) {
              let item = existingItem;
              if (!item) {
                item = {
                  type: 'reasoning',
                  providerMetadata: { openai: {} },
                  [aiSdkStreamReasoningBlocks]: [],
                };
                content.push(item);
                text = undefined;
              }
              block.item = item;
              item[aiSdkStreamReasoningBlocks].push(block);
            }
            if (block.item) {
              block.item.providerMetadata = {
                ...mergeModelProviderMetadata(
                  block.item.providerMetadata,
                  block.metadata,
                ),
                openai: {
                  ...block.item.providerMetadata.openai,
                  ...(block.metadata?.openai as JsonObject),
                  ...metadata,
                },
              };
              Object.assign(block.item.providerMetadata.openai, metadata);
              if (itemId != null) reasoningItems.set(itemId, block.item);
            }
            block.ended = part.type === 'reasoning-end';
            // Keep the provider's live block IDs on the raw observation path.
            // Continuation metadata belongs to the completed reasoning item.
            yield part.type === 'reasoning-delta'
              ? { type: part.type, id, delta: part.delta }
              : { type: part.type, id };
            break;
          }
          case 'tool-input-start':
            if (
              typeof part.id !== 'string' ||
              !part.id ||
              pendingInputs.has(part.id) ||
              calls.has(part.id)
            )
              throw new TypeError(
                'AiSdkModel stream requires unique tool call IDs',
              );
            pendingInputs.add(part.id);
            if (part.providerMetadata != null)
              toolInputMetadata.set(
                part.id,
                mergeModelProviderMetadata(undefined, part.providerMetadata)!,
              );
            break;
          case 'tool-call':
            if (
              typeof part.toolCallId !== 'string' ||
              !part.toolCallId ||
              calls.has(part.toolCallId)
            )
              throw new TypeError(
                'AiSdkModel stream requires unique tool call IDs',
              );
            calls.add(part.toolCallId);
            pendingInputs.delete(part.toolCallId);
            text = undefined;
            content.push({
              ...(copyJsonValue(part) as JsonObject),
              ...(toolInputMetadata.has(part.toolCallId)
                ? {
                    providerMetadata: mergeModelProviderMetadata(
                      toolInputMetadata.get(part.toolCallId),
                      part.providerMetadata,
                    ),
                  }
                : {}),
            });
            toolInputMetadata.delete(part.toolCallId);
            break;
          case 'finish':
            responseProviderMetadata = mergeModelProviderMetadata(
              responseProviderMetadata,
              part.providerMetadata,
            );
            finished = true;
            finishReason = part.finishReason;
            usage = part.usage;
            if (usage) {
              const measured = this.#projectResponse(
                { content: [], finishReason: 'stop', usage },
                tools,
                applyPatchWire,
              ).usage!;
              request.reportUsage?.({
                inputTokens: measured.input_tokens ?? 0,
                cachedInputTokens: measured.cached_input_tokens ?? 0,
                cacheWriteInputTokens: measured.cache_write_input_tokens ?? 0,
                outputTokens: measured.output_tokens ?? 0,
                reasoningOutputTokens: measured.reasoning_output_tokens ?? 0,
                totalTokens: measured.total_tokens ?? 0,
              });
            }
            break;
          case 'stream-start':
            responseProviderMetadata = mergeModelProviderMetadata(
              responseProviderMetadata,
              part.providerMetadata,
            );
            break;
          case 'text-start':
            textBlocks.set(part.id, {
              metadata: mergeModelProviderMetadata(
                undefined,
                part.providerMetadata,
              ),
            });
            break;
          case 'text-end': {
            const active = textBlocks.get(part.id)?.active;
            if (active)
              active.part.providerMetadata = mergeModelProviderMetadata(
                active.part.providerMetadata,
                part.providerMetadata,
              );
            textBlocks.delete(part.id);
            break;
          }
          case 'tool-input-delta':
          case 'tool-input-end':
            if (part.providerMetadata != null) {
              if (typeof part.id !== 'string' || !pendingInputs.has(part.id))
                throw new TypeError(
                  'AI SDK tool metadata requires its active input block',
                );
              toolInputMetadata.set(
                part.id,
                mergeModelProviderMetadata(
                  toolInputMetadata.get(part.id),
                  part.providerMetadata,
                )!,
              );
            }
            break;
          default:
            throw new TypeError(
              'AiSdkModel received unsupported output content',
            );
        }
      }
      if (
        !finished ||
        pendingInputs.size ||
        Array.from(reasoningBlocks.values()).some((block) => !block.ended)
      )
        throw new TypeError(
          'AiSdkModel stream ended without a completed response',
        );
      const result = this.#projectResponse(
        {
          content,
          finishReason,
          usage,
          providerMetadata: responseProviderMetadata,
          response: { id: responseId },
        },
        tools,
        applyPatchWire,
      );
      const output = result.output.map((item, index) => ({
        ...item,
        id: item.id ?? messageIds.get(index) ?? 'item_aisdk_' + randomUUID(),
      }));
      for (const [index, item] of output.entries()) {
        const event = {
          type: 'response.output_item.done',
          output_index: index,
          item,
        };
        retainModelProviderStreamFrame(event, result, index);
        yield event;
      }
      yield {
        type: 'response.completed',
        response: {
          id: responseId,
          status: 'completed',
          output,
          ...(result.usage
            ? {
                usage: {
                  input_tokens: result.usage.input_tokens ?? 0,
                  output_tokens: result.usage.output_tokens ?? 0,
                  total_tokens: result.usage.total_tokens ?? 0,
                  input_tokens_details: {
                    cached_tokens: result.usage.cached_input_tokens ?? 0,
                    ...(usage?.inputTokens?.cacheWrite == null
                      ? {}
                      : {
                          cache_write_tokens:
                            result.usage.cache_write_input_tokens,
                        }),
                  },
                  output_tokens_details: {
                    reasoning_tokens: result.usage.reasoning_output_tokens ?? 0,
                  },
                },
              }
            : {}),
        },
      };
    } finally {
      request.signal.removeEventListener('abort', abort);
      try {
        await cancel();
      } catch {
        /* Original stream failure retention. */
      }
      reader.releaseLock();
    }
  }

  #projectResponse(
    result: any,
    tools: any[],
    applyPatchWire: ApplyPatchWire | undefined,
  ): ModelResponse {
    const finishReason =
      typeof result.finishReason === 'string'
        ? result.finishReason
        : result.finishReason?.unified;
    const raw = result.response?.body;
    const refusal = this.#openaiChat
      ? raw?.choices?.[0]?.message?.refusal
      : this.#openaiResponses
        ? raw?.output
            ?.flatMap((item: any) =>
              item.type === 'message' ? item.content : [],
            )
            ?.find((part: any) => part.type === 'refusal')?.refusal
        : undefined;
    if (
      finishReason !== 'stop' &&
      finishReason !== 'tool-calls' &&
      refusal == null
    )
      throw new TypeError('AiSdkModel requires a completed response');
    if (this.#openaiResponses && raw?.status != null) {
      const projected = projectResponsesResponse({
        ...raw,
        output: raw.output?.map((item: any) =>
          item.type === 'function_call'
            ? functionToolOutput(
                {
                  ...item,
                  arguments: aiSdkToolArguments(
                    item.arguments,
                    tools.find((tool) => tool.name === item.name)?.inputSchema,
                  ),
                },
                applyPatchWire,
              )
            : item,
        ),
      });
      const values = projected.output.flatMap((item, outputIndex) => {
        const matching = (result.content ?? []).filter(
          (part: any) =>
            (typeof item.call_id === 'string' &&
              part.type === 'tool-call' &&
              part.toolCallId === item.call_id) ||
            (typeof item.id === 'string' &&
              part.providerMetadata?.openai?.itemId === item.id),
        );
        if (
          item.type === 'message' &&
          Array.isArray(item.content) &&
          item.content.length > 1
        ) {
          const texts = matching.filter((part: any) => part.type === 'text');
          const value =
            texts.length === item.content.length &&
            item.content.every(
              (part: any, index) =>
                part.type === 'output_text' && part.text === texts[index].text,
            )
              ? modelTextPartMetadata(
                  texts.map((part: any) => part.providerMetadata),
                )
              : undefined;
          return value === undefined ? [] : [{ outputIndex, value }];
        }
        let value: JsonObject | undefined;
        for (const part of matching)
          value = mergeModelProviderMetadata(value, part.providerMetadata);
        value ??= mergeModelProviderMetadata(
          undefined,
          result.providerMetadata,
        );
        return value === undefined ? [] : [{ outputIndex, value }];
      });
      retainModelProviderMetadata(
        projected,
        this.model.provider,
        this.model.modelId,
        values,
      );
      return projected;
    }
    const output: JsonObject[] = [];
    const providerMetadata = new Map<number, JsonObject>();
    const retainMetadata = (index: number, value: unknown) => {
      const merged = mergeModelProviderMetadata(
        providerMetadata.get(index),
        value,
      );
      if (merged !== undefined) providerMetadata.set(index, merged);
    };
    const reasoningItems = new Map<
      string,
      {
        type: 'reasoning';
        id: string;
        summary: { type: 'summary_text'; text: string }[];
        encrypted_content?: string;
      }
    >();
    let pendingTextParts: AiSdkTextPart[] = [];
    const flushText = (streamed = false) => {
      if (pendingTextParts.length) {
        // Keep ordinary buffered text coalesced. Preserve explicit part
        // metadata and the content indexes already emitted by streaming.
        if (
          !streamed &&
          pendingTextParts.every((part) => part.providerMetadata == null)
        ) {
          pendingTextParts = [
            { text: pendingTextParts.map((part) => part.text).join('') },
          ];
        }
        output.push({
          type: 'message',
          role: 'assistant',
          content: pendingTextParts.map(({ text }) => ({
            type: 'output_text',
            text,
          })),
        });
        retainMetadata(
          output.length - 1,
          pendingTextParts.length === 1
            ? (pendingTextParts[0].providerMetadata ?? result.providerMetadata)
            : modelTextPartMetadata(
                pendingTextParts.map((part) => part.providerMetadata),
              ),
        );
        pendingTextParts = [];
      }
    };
    for (const part of result.content ?? []) {
      if (part.type === 'text') {
        const streamed = part[aiSdkStreamTextParts] as
          AiSdkTextPart[] | undefined;
        if (streamed) {
          flushText();
          pendingTextParts = streamed;
          flushText(true);
        } else {
          if (typeof part.text !== 'string')
            throw new TypeError(
              'AiSdkModel received unsupported output content',
            );
          pendingTextParts.push(part);
        }
        continue;
      }
      if (part.type === 'reasoning' && this.#openaiResponses) {
        const metadata = aiSdkReasoningMetadata(part);
        const texts = (part as AiSdkStreamReasoning)[
          aiSdkStreamReasoningBlocks
        ]?.map((block) => block.text) ?? [part.text];
        if (texts.some((text) => typeof text !== 'string'))
          throw new TypeError('AiSdkModel received invalid reasoning text');
        const summary = texts
          .filter((text) => text !== '')
          .map((text) => ({ type: 'summary_text' as const, text }));
        const { itemId, reasoningEncryptedContent } = metadata;
        if (
          !summary.length &&
          itemId == null &&
          reasoningEncryptedContent == null
        )
          continue;
        flushText();
        const previous =
          itemId == null ? undefined : reasoningItems.get(itemId);
        if (previous) {
          retainMetadata(
            output.indexOf(previous),
            part.providerMetadata ?? result.providerMetadata,
          );
          previous.summary.push(...summary);
          if (reasoningEncryptedContent != null)
            previous.encrypted_content = reasoningEncryptedContent;
        } else {
          const item = {
            type: 'reasoning' as const,
            id: itemId ?? 'rs_aisdk_' + randomUUID(),
            summary,
            ...(reasoningEncryptedContent == null
              ? {}
              : { encrypted_content: reasoningEncryptedContent }),
          };
          output.push(item);
          retainMetadata(
            output.length - 1,
            part.providerMetadata ?? result.providerMetadata,
          );
          if (itemId != null) reasoningItems.set(itemId, item);
        }
        continue;
      }
      flushText();
      if (part.type === 'tool-call' && !part.providerExecuted) {
        const args = aiSdkToolArguments(
          part.input,
          tools.find((tool) => tool.name === part.toolName)?.inputSchema,
        );
        output.push(
          functionToolOutput(
            {
              type: 'function_call',
              call_id: part.toolCallId,
              name: part.toolName,
              ...(args === undefined ? {} : { arguments: args }),
            },
            applyPatchWire,
          ),
        );
        retainMetadata(
          output.length - 1,
          part.providerMetadata ?? result.providerMetadata,
        );
      } else
        throw new TypeError('AiSdkModel received unsupported output content');
    }
    flushText();
    if (refusal != null)
      output.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'refusal', refusal }],
      });
    const usage = result.usage;
    const input =
      typeof usage?.inputTokens === 'number'
        ? usage.inputTokens
        : (usage?.inputTokens?.total ?? 0);
    const out =
      typeof usage?.outputTokens === 'number'
        ? usage.outputTokens
        : (usage?.outputTokens?.total ?? 0);
    const projected: ModelResponse = {
      output,
      ...(result.response?.id ? { responseId: result.response.id } : {}),
      ...(usage
        ? {
            usage: {
              input_tokens: input,
              output_tokens: out,
              total_tokens: input + out,
              cached_input_tokens:
                usage.inputTokens?.cacheRead ?? usage.cachedInputTokens ?? 0,
              cache_write_input_tokens: usage.inputTokens?.cacheWrite ?? 0,
              reasoning_output_tokens:
                usage.outputTokens?.reasoning ?? usage.reasoningTokens ?? 0,
            },
          }
        : {}),
    };
    retainModelProviderMetadata(
      projected,
      this.model.provider,
      this.model.modelId,
      [...providerMetadata].map(([outputIndex, value]) => ({
        outputIndex,
        value,
      })),
    );
    return projected;
  }
}
