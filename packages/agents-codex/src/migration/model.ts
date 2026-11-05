import type { sessionModelInput } from './persistence';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { once } from 'node:events';
import {
  Usage,
  RunToolCallOutputItem,
  type Agent,
  type FunctionTool,
  type FunctionToolResult,
  type AgentOutputType,
  NoopTrace,
  withTrace,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ModelSettings,
  type RunContext,
  type StreamEvent,
} from '@openai/agents-core';
import type { SerializedFunctionTool } from '@openai/agents-core/model';
import type {
  AgentInputItem,
  AgentOutputItem,
} from '@openai/agents-core/types';
import {
  getToolCallOutputItem,
  getResponseWithRetry,
  getStreamedResponseWithRetry,
  validateModelTimeoutMs,
} from '@openai/agents-core/utils/internal';
import {
  decode,
  encode,
  jsonObject,
  jsonValue,
  type JsonObject,
  type JsonValue,
} from '../runtime/binding';
import type {
  SelectedModelRoute,
  SelectedModelTerminal,
} from '../runtime/http-model';
import type { ToolResponse } from '../runtime/tools';
import { inlineImageURL } from './input';
import type { MigrationObservation } from './result';
import type { ToolFinishCandidate } from './finish';
import type { NativeHandoffState } from './handoff';

export const MAX_MODEL_BYTES = 4 * 1024 * 1024;

export function bounded(value: unknown): string {
  // Optional protocol fields may be absent; provider payloads are checked separately.
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > MAX_MODEL_BYTES)
    throw new TypeError('Migration Model payload exceeds 4 MiB');
  decode(jsonValue, text);
  return text;
}

export function validateSettings(settings: ModelSettings): void {
  const numeric = new Set([
    'temperature',
    'topP',
    'frequencyPenalty',
    'presencePenalty',
  ]);
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue;
    if (numeric.has(key) && typeof value === 'number' && Number.isFinite(value))
      continue;
    if (key === 'maxTokens' && Number.isSafeInteger(value) && Number(value) > 0)
      continue;
    if (key === 'timeoutMs') {
      validateModelTimeoutMs({ timeoutMs: value as number });
      continue;
    }
    if (key === 'retry' && value && typeof value === 'object') {
      for (const [field, setting] of Object.entries(value)) {
        if (setting === undefined) continue;
        if (
          field === 'maxRetries' &&
          Number.isSafeInteger(setting) &&
          Number(setting) >= 0
        )
          continue;
        if (field === 'policy' && typeof setting === 'function') continue;
        if (
          field === 'backoff' &&
          setting &&
          typeof setting === 'object' &&
          Object.entries(setting).every(
            ([name, entry]) =>
              entry === undefined ||
              (name === 'jitter'
                ? typeof entry === 'boolean'
                : ['initialDelayMs', 'maxDelayMs', 'multiplier'].includes(
                    name,
                  ) &&
                  typeof entry === 'number' &&
                  Number.isFinite(entry) &&
                  entry >= 0),
          )
        )
          continue;
        throw new TypeError(
          `Migration does not support retry setting ${field}`,
        );
      }
      continue;
    }
    if (key === 'store' && typeof value === 'boolean') continue;
    if (key === 'toolChoice' && typeof value === 'string' && value.length)
      continue;
    throw new TypeError(`Migration does not support model setting ${key}`);
  }
}
/** Responses treats these strings as hosted selectors, independently of function names. */
const hostedChoices = new Set([
  'file_search',
  'web_search',
  'web_search_preview',
  'code_interpreter',
  'image_generation',
  'mcp',
  'programmatic_tool_calling',
  'shell',
  'apply_patch',
  'computer_use_preview',
]);

export function validateToolChoice(
  choice: ModelSettings['toolChoice'],
  names: ReadonlySet<string>,
): void {
  if (choice === undefined || choice === 'auto' || choice === 'none') return;
  if (choice === 'required' && names.size) return;
  if (choice !== 'required' && names.has(choice) && !hostedChoices.has(choice))
    return;
  throw new TypeError(
    'Migration requires an enabled ordinary-function tool choice',
  );
}
function string(value: JsonValue | undefined, name: string): string {
  if (typeof value !== 'string')
    throw new TypeError(`Migration requires ${name}`);
  return value;
}
function textContent(content: JsonValue | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content))
    throw new TypeError('Migration requires text content');
  return content
    .map((part) => {
      const item = jsonObject.parse(part);
      if (!['input_text', 'output_text', 'text'].includes(String(item.type)))
        throw new TypeError('Migration does not support media content');
      return string(item.text, 'text');
    })
    .join('\n');
}
function roster(body: JsonObject, tools: readonly SerializedFunctionTool[]) {
  if (!Array.isArray(body.tools) || body.tools.length !== tools.length)
    throw new TypeError('Migration native tool roster changed');
  const seen = new Set<string>();
  for (const value of body.tools) {
    const tool = jsonObject.parse(value);
    const declaration = tools.find((item) => item.name === tool.name);
    if (
      tool.type !== 'function' ||
      !declaration ||
      seen.has(declaration.name) ||
      (tool.namespace != null && tool.namespace !== 'functions') ||
      tool.strict !== declaration.strict ||
      tool.description !== declaration.description ||
      !isDeepStrictEqual(tool.parameters, declaration.parameters)
    )
      throw new TypeError(
        'Migration requires the captured function declarations',
      );
    seen.add(declaration.name);
  }
}

export function modelRequest(
  body: JsonObject,
  tools: readonly SerializedFunctionTool[],
  settings: ModelSettings,
  signal: AbortSignal,
  outputType: ModelRequest['outputType'] = 'text',
): ModelRequest {
  bounded(body);
  if (
    body.previous_response_id != null ||
    body.conversation != null ||
    body.conversation_id != null
  )
    throw new TypeError(
      'Migration requires full fresh input without response references',
    );
  if (body.tool_choice != null && body.tool_choice !== 'auto')
    throw new TypeError('Migration requires automatic tool choice');
  roster(body, tools);
  if (!Array.isArray(body.input))
    throw new TypeError('Migration requires a full input list');
  const calls = new Map<
    string,
    { name: string; namespace?: string; completed: boolean }
  >();
  const input = body.input.map((value): AgentInputItem => {
    const item = jsonObject.parse(value);
    const id = item.id === undefined ? {} : { id: string(item.id, 'item id') };
    if (
      (item.type == null || item.type === 'message') &&
      ['user', 'assistant', 'system', 'developer'].includes(String(item.role))
    ) {
      const role = item.role === 'developer' ? 'system' : item.role;
      if (role === 'system')
        return {
          ...id,
          type: 'message',
          role,
          content: textContent(item.content),
        };
      if (role === 'user') {
        if (typeof item.content === 'string')
          return { ...id, type: 'message', role, content: item.content };
        if (!Array.isArray(item.content))
          throw new TypeError('Migration requires user message content');
        return {
          ...id,
          type: 'message',
          role,
          content: item.content.map((part) => {
            const content = jsonObject.parse(part);
            if (content.type === 'input_text')
              return {
                type: 'input_text' as const,
                text: string(content.text, 'text'),
              };
            if (
              content.type === 'input_image' &&
              Object.keys(content).every((key) =>
                ['type', 'image_url', 'detail'].includes(key),
              )
            )
              return {
                type: 'input_image' as const,
                image: inlineImageURL(content.image_url),
                ...(content.detail == null
                  ? {}
                  : { detail: string(content.detail, 'image detail') }),
              };
            throw new TypeError(
              'Migration requires user text or inline images',
            );
          }),
        };
      }
      const parts =
        typeof item.content === 'string'
          ? [item.content]
          : Array.isArray(item.content)
            ? item.content.map((part) => {
                const content = jsonObject.parse(part);
                if (content.type !== 'output_text')
                  throw new TypeError(
                    'Migration requires text-only message parts',
                  );
                return string(content.text, 'text');
              })
            : (() => {
                throw new TypeError('Migration requires message content');
              })();
      if (item.status != null && item.status !== 'completed')
        throw new TypeError('Migration requires completed assistant history');
      return {
        ...id,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: parts.map((text) => ({ type: 'output_text', text })),
      };
    }
    if (item.type === 'function_call') {
      const callId = string(item.call_id, 'call_id');
      const name = string(item.name, 'function name');
      if (
        calls.has(callId) ||
        !tools.some((tool) => tool.name === name) ||
        (item.namespace != null && item.namespace !== 'functions')
      )
        throw new TypeError(
          'Migration requires unambiguous captured function calls',
        );
      calls.set(callId, {
        name,
        completed: false,
        ...(item.namespace == null
          ? {}
          : { namespace: string(item.namespace, 'namespace') }),
      });
      return {
        ...id,
        type: 'function_call',
        callId,
        name,
        arguments: string(item.arguments, 'function arguments'),
        ...(item.namespace == null
          ? {}
          : { namespace: String(item.namespace) }),
      };
    }
    if (item.type === 'function_call_output') {
      const callId = string(item.call_id, 'call_id');
      const call = calls.get(callId);
      if (!call || call.completed)
        throw new TypeError('Migration found an unpaired function result');
      call.completed = true;
      return {
        ...id,
        type: 'function_call_result',
        callId,
        name: call.name,
        ...(call.namespace ? { namespace: call.namespace } : {}),
        status: 'completed',
        output: textContent(item.output),
      };
    }
    throw new TypeError(`Migration does not support input item ${item.type}`);
  });
  if ([...calls.values()].some((call) => !call.completed))
    throw new TypeError(
      'Migration requires complete function call/result pairs',
    );
  const effective = { ...settings };
  if (body.max_output_tokens != null) {
    const cap = body.max_output_tokens;
    if (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap <= 0)
      throw new TypeError(
        'Migration requires a positive safe native output cap',
      );
    effective.maxTokens = Math.min(effective.maxTokens ?? cap, cap);
  }
  const request: ModelRequest = {
    ...(body.instructions == null
      ? {}
      : { systemInstructions: string(body.instructions, 'instructions') }),
    input,
    tools: structuredClone([...tools]),
    toolsExplicitlyProvided: true,
    modelSettings: effective,
    outputType: structuredClone(outputType),
    handoffs: [],
    tracing: false,
    signal,
  };
  return request;
}
function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(
      'Migration usage requires nonnegative safe integer counts',
    );
  return value;
}
function usageWire(usage: Usage): JsonObject {
  const input = count(usage.inputTokens),
    output = count(usage.outputTokens),
    total = count(usage.totalTokens);
  if (BigInt(input) + BigInt(output) !== BigInt(total))
    throw new TypeError('Migration usage totals must agree exactly');
  const details = (records: Usage['inputTokensDetails']): JsonObject => {
    if (!Array.isArray(records) || records.length > 1)
      throw new TypeError(
        'Migration cannot represent aggregated token details',
      );
    const record = jsonObject.parse(records[0] ?? {});
    for (const value of Object.values(record)) {
      if (typeof value !== 'number')
        throw new TypeError('Migration usage details require counts');
      count(value);
    }
    return record;
  };
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    input_tokens_details: {
      cached_tokens: 0,
      ...details(usage.inputTokensDetails),
    },
    output_tokens_details: {
      reasoning_tokens: 0,
      ...details(usage.outputTokensDetails),
    },
  };
}

export function modelResponse(
  response: ModelResponse,
  tools: readonly SerializedFunctionTool[],
) {
  bounded(response);
  if (
    (response.responseId !== undefined &&
      typeof response.responseId !== 'string') ||
    (response.requestId !== undefined && typeof response.requestId !== 'string')
  )
    throw new TypeError('Migration response identifiers must be strings');
  const usage = usageWire(response.usage);
  const callIds = new Set<string>();
  const output = response.output.map((item): JsonObject => {
    if (
      (item.type == null || item.type === 'message') &&
      item.role === 'assistant' &&
      item.status === 'completed'
    ) {
      const content = item.content.map((part) => {
        if (part.type !== 'output_text' || typeof part.text !== 'string')
          throw new TypeError('Migration requires completed text output');
        return { type: 'output_text', text: part.text, annotations: [] };
      });
      return {
        type: 'message',
        id: item.id ?? `msg_${randomUUID()}`,
        role: 'assistant',
        status: 'completed',
        content,
      };
    }
    if (
      item.type === 'function_call' &&
      (item.status == null || item.status === 'completed') &&
      tools.some((tool) => tool.name === item.name) &&
      (item.namespace == null || item.namespace === 'functions')
    ) {
      if (callIds.has(item.callId))
        throw new TypeError('Migration requires unique call IDs');
      callIds.add(item.callId);
      decode(jsonObject, item.arguments);
      return {
        type: 'function_call',
        ...(item.id === undefined ? {} : { id: item.id }),
        call_id: item.callId,
        name: item.name,
        arguments: item.arguments,
        ...(item.namespace == null ? {} : { namespace: item.namespace }),
        status: 'completed',
      };
    }
    throw new TypeError(
      'Migration does not support incomplete or non-text/function output',
    );
  });
  const actual: ModelResponse = {
    output: JSON.parse(bounded(response.output)),
    usage: Usage.fromJSON(JSON.parse(bounded(response.usage))),
    ...(response.responseId === undefined
      ? {}
      : { responseId: response.responseId }),
    ...(response.requestId === undefined
      ? {}
      : { requestId: response.requestId }),
    ...(response.providerData === undefined
      ? {}
      : { providerData: jsonObject.parse(response.providerData) }),
    ...(response.rawUsage === undefined
      ? {}
      : { rawUsage: jsonObject.parse(response.rawUsage) }),
  };
  const id = response.responseId ?? `resp_${randomUUID()}`;
  const events: JsonObject[] = [{ type: 'response.created', response: { id } }];
  output.forEach((item, index) => {
    events.push({
      type: 'response.output_item.added',
      output_index: index,
      item,
    });
    if (item.type === 'message') {
      (item.content as JsonObject[]).forEach((part, contentIndex) => {
        events.push({
          type: 'response.output_text.delta',
          item_id: item.id!,
          output_index: index,
          content_index: contentIndex,
          delta: part.text!,
        });
      });
    }
    events.push({
      type: 'response.output_item.done',
      output_index: index,
      item,
    });
  });
  events.push({
    type: 'response.completed',
    response: { id, status: 'completed', output, usage },
  });
  const wire = events.map((event) => `data: ${encode(event)}\n\n`).join('');
  if (Buffer.byteLength(wire) > MAX_MODEL_BYTES)
    throw new TypeError('Migration response SSE exceeds 4 MiB');
  return { actual, wire };
}

/** @internal One invocation owns cancellation, captured context, producers and native receipts. */
export class SelectedModelInvocation<
  Context = unknown,
  Output extends AgentOutputType = 'text',
> implements SelectedModelRoute {
  readonly responses: ModelResponse[] = [];
  private readonly toolResults = new Map<
    string,
    {
      name: string;
      text: string;
      response: ToolResponse;
      value?: JsonValue;
      observedValue?: JsonValue;
    }
  >();
  private readonly toolValues = new Map<
    string,
    { name: string; value: JsonValue }
  >();
  readonly controller = new AbortController();
  readonly inContext = AsyncLocalStorage.snapshot();
  private root?: JsonObject;
  private receipt?: Promise<{ turn_id: string }>;
  private tasks = new Set<Promise<unknown>>();
  private stopped = false;
  readonly cleanupErrors: unknown[] = [];
  failure: unknown;
  failed = false;
  callerSignal?: AbortSignal;
  cancelNative?: () => void;
  inputChecks?: () => Promise<unknown>;
  prepareRequest?: (request: ModelRequest) => Promise<void>;
  toolAccepted?: (name: string) => void;
  finishTools?: () => Promise<ToolFinishCandidate | undefined>;
  readonly finishRequested = Promise.withResolvers<ToolFinishCandidate>();
  nativeTerminal?: SelectedModelTerminal;
  private policyFinish?: ToolFinishCandidate;
  private toolBatch?: {
    response: ModelResponse;
    ready: ReturnType<typeof Promise.withResolvers<void>>;
    handled: boolean;
  };
  rawModelEvent?: (event: StreamEvent) => void;
  validateApprovalResponse?: (response: ModelResponse) => void;
  model?: Model;
  handoff?: NativeHandoffState<Context, Output>;
  constructor(
    readonly tools: readonly SerializedFunctionTool[],
    readonly settings: ModelSettings,
    readonly invocation: 'response' | 'stream',
    private readonly runContext: Pick<RunContext<Context>, 'usage'>,
    readonly outputType: ModelRequest['outputType'] = 'text',
    private readonly sessionInput?: ReturnType<typeof sessionModelInput>,
  ) {}
  bindRoot(root: string): void {
    this.root = decode(jsonObject, root);
  }
  accepted(receipt: Promise<{ turn_id: string }>): void {
    this.receipt = receipt;
  }
  terminal(event: SelectedModelTerminal): void {
    // Only record matched native facts; the run owner also joins terminal cleanup.
    this.nativeTerminal = event;
  }
  getToolCall(callId: string, name: string) {
    const calls = this.responses
      .flatMap((response) => response.output)
      .filter(
        (item) => item.type === 'function_call' && item.callId === callId,
      );
    const call = calls[0];
    if (
      calls.length !== 1 ||
      call?.type !== 'function_call' ||
      call.name !== name
    )
      throw new TypeError('Migration requires one original SDK function call');
    return call;
  }
  getToolResults(
    agent: Agent<any, any>,
    tools: readonly FunctionTool<any, any, any>[],
  ): FunctionToolResult[] {
    return (this.toolBatch?.response.output ?? []).flatMap(
      (call): FunctionToolResult[] => {
        if (call.type !== 'function_call') return [];
        const accepted = this.toolResults.get(call.callId);
        const tool = tools.find((source) => source.name === call.name);
        if (
          !accepted ||
          accepted.value === undefined ||
          !tool ||
          accepted.name !== call.name
        )
          throw new TypeError(
            'Migration requires an accepted checked function result',
          );
        return [
          {
            type: 'function_output',
            tool,
            output: accepted.value,
            runItem: new RunToolCallOutputItem(
              getToolCallOutputItem(call, accepted.text),
              agent,
              accepted.value,
            ),
          },
        ];
      },
    );
  }
  toolValue(callId: string, name: string, value: JsonValue): JsonValue {
    if (this.toolValues.has(callId))
      throw new TypeError('Migration received a duplicate checked tool value');
    const snapshot = structuredClone(value);
    this.toolValues.set(callId, { name, value: snapshot });
    return snapshot;
  }
  toolResult(callId: string, name: string, response: ToolResponse): void {
    const call = this.responses
      .flatMap((result) => result.output)
      .find((item) => item.type === 'function_call' && item.callId === callId);
    if (!call || call.type !== 'function_call' || call.name !== name)
      throw new TypeError('Migration received an unmatched tool result');
    if (this.toolResults.has(callId))
      throw new TypeError('Migration received a duplicate tool result');
    const content = response.contentItems[0];
    if (
      !response.success ||
      response.contentItems.length !== 1 ||
      content?.type !== 'inputText'
    )
      throw new TypeError('Migration requires an accepted text tool result');
    // A true native acknowledgment remains a fact if cancellation arrives later.
    const checked = this.toolValues.get(callId);
    if (checked && checked.name !== name)
      throw new TypeError('Migration received an unmatched checked tool value');
    this.toolResults.set(callId, {
      name,
      text: content.text,
      response: structuredClone(response),
      ...(checked
        ? {
            value: checked.value,
            observedValue: structuredClone(checked.value),
          }
        : {}),
    });
    this.toolValues.delete(callId);
    this.handoff?.accepted(callId, name, response);
    this.toolAccepted?.(name);
    if (
      this.toolBatch?.response.output.every(
        (item) =>
          item.type !== 'function_call' || this.toolResults.has(item.callId),
      )
    )
      this.toolBatch.ready.resolve();
  }
  getOutputItems(): AgentOutputItem[] {
    return this.responses.flatMap((response) => [
      ...response.output,
      ...response.output.flatMap((item) => {
        if (item.type !== 'function_call') return [];
        const result = this.toolResults.get(item.callId);
        if (!result || result.name !== item.name)
          throw new TypeError('Migration is missing an accepted tool result');
        return [getToolCallOutputItem(item, result.text)];
      }),
    ]);
  }
  getObservations(
    responses: readonly ModelResponse[] = this.responses,
  ): MigrationObservation[] {
    return responses.flatMap((response): MigrationObservation[] => [
      { type: 'model', response },
      ...response.output.flatMap((call): MigrationObservation[] => {
        if (call.type !== 'function_call') return [];
        const accepted = this.toolResults.get(call.callId);
        if (
          !accepted ||
          accepted.value === undefined ||
          accepted.name !== call.name
        )
          throw new TypeError(
            'Migration is missing an accepted checked tool value',
          );
        return [
          {
            type: 'tool',
            call,
            value: structuredClone(accepted.observedValue!),
            response: structuredClone(accepted.response),
          },
        ];
      }),
    ]);
  }
  async expected(): Promise<string> {
    this.check();
    const receipt = await this.receipt;
    this.check();
    if (!this.root || !receipt)
      throw new TypeError('Migration root is not bound');
    return encode({
      ...this.root,
      turn: receipt.turn_id,
      model: 'agents-sdk-model',
    });
  }
  check(): void {
    if (this.failed) throw this.failure;
    this.controller.signal.throwIfAborted();
    if (this.stopped) throw new Error('Migration invocation is stopped');
  }
  fail(error: unknown): void {
    if (!this.failed) {
      this.failed = true;
      this.failure = error;
    }
    this.halt();
    this.cancelNative?.();
  }
  halt(): void {
    this.stopped = true;
    if (!this.controller.signal.aborted) this.controller.abort(this.failure);
    this.toolBatch?.ready.reject(this.controller.signal.reason);
  }
  async join(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
    if (this.cleanupErrors.length)
      throw new AggregateError(
        this.cleanupErrors,
        this.handoff
          ? 'Migration Model cleanup failed'
          : 'Migration Model iterator cleanup failed',
        { cause: this.cleanupErrors[0] },
      );
  }
  produce(
    body: JsonObject,
    disconnected: AbortSignal,
    current: () => Promise<void>,
    finish: () => Promise<void>,
  ): Promise<string | undefined> {
    const task = this.inContext(() =>
      withTrace(new NoopTrace(), async () => {
        const signal = AbortSignal.any([this.controller.signal, disconnected]);
        let ownedStop = false;
        const abort = () => {
          if (
            ownedStop &&
            disconnected.aborted &&
            !this.controller.signal.aborted
          )
            return;
          this.fail(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          signal.throwIfAborted();
          await current();
          this.check();
          const batch = this.toolBatch;
          if (batch && !batch.handled) {
            await batch.ready.promise;
            this.check();
          }
          const initial = modelRequest(
            body,
            this.tools,
            this.handoff?.settings ?? this.settings,
            signal,
            this.outputType,
          );
          if (this.sessionInput)
            initial.input = this.sessionInput.request(initial.input);
          let request = initial;
          if (batch && !batch.handled) {
            const transfer = batch.response.output.some(
              (item) =>
                item.type === 'function_call' &&
                item.name === this.handoff?.plan.declaration.name,
            );
            const candidate = transfer ? undefined : await this.finishTools?.();
            this.check();
            batch.handled = true;
            if (candidate) {
              await current();
              this.check();
              this.policyFinish = candidate;
            }
          }
          if (this.policyFinish) {
            ownedStop = true;
            this.finishRequested.resolve(this.policyFinish);
            if (!disconnected.aborted)
              await once(disconnected, 'abort', {
                signal: this.controller.signal,
              });
            this.check();
            return undefined;
          }
          if (this.handoff) {
            try {
              request = await this.handoff.request(initial);
            } catch (error) {
              if (
                this.failed &&
                !Object.is(error, this.failure) &&
                !this.cleanupErrors.some((known) => Object.is(known, error))
              )
                this.cleanupErrors.push(error);
              throw error;
            }
          }
          this.check();
          const inputChecks = this.inputChecks?.();
          void inputChecks?.catch((error) => this.fail(error));
          await this.prepareRequest?.(request);
          this.check();
          bounded(request);
          const handlers = {
            beforeAttempt: this.handoff
              ? () => {
                  this.check();
                  this.handoff?.check();
                }
              : undefined,
            onModelFailureUsage: (usage: Usage) =>
              this.runContext.usage.add(usage),
            onRetryCallback: (pending: Promise<unknown>) => {
              this.tasks.add(pending);
              void pending.then(
                () => this.tasks.delete(pending),
                (error: unknown) => {
                  this.tasks.delete(pending);
                  if (
                    this.failed &&
                    !Object.is(error, this.failure) &&
                    !Object.is(error, this.controller.signal.reason)
                  )
                    this.cleanupErrors.push(error);
                },
              );
            },
            onStreamCleanupFailure: (error: unknown) =>
              this.cleanupErrors.push(error),
          };
          let response: ModelResponse;
          if (this.invocation === 'response') {
            response = await getResponseWithRetry(
              this.model!,
              request,
              handlers,
            );
          } else {
            const iterator = getStreamedResponseWithRetry(
              this.model!,
              request,
              handlers,
            )[Symbol.asyncIterator]();
            let terminal: ModelResponse | undefined;
            let bytes = 0;
            let primary: unknown;
            let failed = false;
            try {
              while (true) {
                const event = await iterator.next();
                signal.throwIfAborted();
                if (event.done) break;
                bytes += Buffer.byteLength(bounded(event.value));
                if (bytes > MAX_MODEL_BYTES)
                  throw new TypeError('Migration stream exceeds 4 MiB');
                if (terminal && event.value.type !== 'model')
                  throw new TypeError(
                    'Migration stream emitted after response_done',
                  );
                this.rawModelEvent?.(event.value);
                if (event.value.type === 'response_done') {
                  const done = event.value.response;
                  terminal = {
                    responseId: done.id,
                    requestId: done.requestId,
                    output: done.output,
                    usage: Usage.fromJSON(done.usage),
                    ...(done.rawUsage === undefined
                      ? {}
                      : { rawUsage: done.rawUsage }),
                    ...(done.providerData === undefined
                      ? {}
                      : { providerData: done.providerData }),
                  };
                }
              }
              if (!terminal)
                throw new TypeError(
                  'Migration stream ended without response_done',
                );
            } catch (error) {
              failed = true;
              primary = error;
              this.fail(error);
            } finally {
              try {
                await iterator.return?.();
              } catch (error) {
                this.cleanupErrors.push(error);
                if (!failed) {
                  failed = true;
                  primary = error;
                  this.fail(error);
                }
              }
            }
            if (failed) throw primary;
            response = terminal!;
          }
          signal.throwIfAborted();
          this.check();
          await inputChecks;
          this.check();
          await current();
          this.check();
          this.handoff?.validateResponse(response);
          const result = modelResponse(
            response,
            this.handoff?.allowedTools ?? this.tools,
          );
          this.validateApprovalResponse?.(result.actual);
          this.sessionInput?.response(result.actual.output);
          await finish();
          this.check();
          this.runContext.usage.add(result.actual.usage);
          this.responses.push(result.actual);
          this.handoff?.observe(result.actual);
          if (
            result.actual.output.some((item) => item.type === 'function_call')
          ) {
            const ready = Promise.withResolvers<void>();
            void ready.promise.catch(() => {});
            this.toolBatch = { response: result.actual, ready, handled: false };
          } else this.toolBatch = undefined;
          return result.wire;
        } catch (error) {
          this.fail(error);
          throw error;
        } finally {
          signal.removeEventListener('abort', abort);
        }
      }),
    );
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }
}
