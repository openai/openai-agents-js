import { randomUUID } from 'node:crypto';
import { copyJsonValue, type JsonObject } from './binding';

/** Detached native provider input; Core retains canonical history and tool execution. */
export interface ModelRequest {
  readonly body: JsonObject;
  readonly context: unknown;
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal: AbortSignal;
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
  complete(request: ModelRequest): ModelResponse | Promise<ModelResponse>;
}
/** Resolve a native model for each effective request model name. */
export interface ModelProvider {
  getModel(modelName: string): NativeModel;
}
/** @internal Capture on settlement, before the application can change retained values. */
export function captureModelResponse(response: ModelResponse): JsonObject {
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
  return copyJsonValue({
    response_id: responseId,
    output: response.output,
    usage,
  }) as JsonObject;
}
/** An injected async Chat Completions client; Core continues tools and conversation history. */
export class ChatCompletionsModel implements NativeModel {
  constructor(
    readonly client: any,
    readonly model?: string,
  ) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const messages: Record<string, unknown>[] = [];
    const nativeTools = [...((request.body.tools ?? []) as JsonObject[])];
    for (const raw of request.body.input as JsonObject[]) {
      if (raw.type === 'additional_tools') {
        nativeTools.push(...(raw.tools as JsonObject[]));
        continue;
      }
      if (raw.type === 'message') {
        const content = (raw.content as JsonObject[]).map((part) => {
          if (part.type === 'input_text' || part.type === 'output_text')
            return { type: 'text', text: part.text };
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
      } else if (raw.type === 'function_call') {
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
        calls.push({
          id: raw.call_id,
          type: 'function',
          function: { name: raw.name, arguments: raw.arguments },
        });
      } else if (raw.type === 'function_call_output') {
        const output = raw.output as string | JsonObject[];
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
      return leaves.map(({ type, ...tool }) => {
        if (type !== 'function')
          throw new TypeError(
            'ChatCompletionsModel supports native function tools',
          );
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
      ]
        .filter((key) => key in request.body)
        .map((key) => [key, request.body[key]]),
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
    if (tools.length) options.tools = tools;
    else {
      delete options.tool_choice;
      delete options.parallel_tool_calls;
    }
    const value = await this.client.chat.completions.create(
      {
        model: this.model ?? request.body.model,
        messages,
        stream: false,
        ...options,
      },
      { signal: request.signal },
    );
    if (!Array.isArray(value.choices) || value.choices.length !== 1)
      throw new TypeError(
        'ChatCompletionsModel requires exactly one response choice',
      );
    const choice = value.choices[0];
    const message = choice.message;
    if (
      ['length', 'content_filter'].includes(choice.finish_reason) &&
      message.refusal == null
    )
      throw new TypeError(
        `ChatCompletionsModel cannot complete finish_reason=${choice.finish_reason}`,
      );
    const output: JsonObject[] = [];
    const content: JsonObject[] = [];
    if (message.content != null) {
      const part: JsonObject = { type: 'output_text', text: message.content };
      const probabilities = value.choices[0].logprobs?.content;
      if (probabilities != null) part.logprobs = probabilities;
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
      output.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
    const usage =
      value.usage == null
        ? undefined
        : {
            input_tokens: value.usage.prompt_tokens ?? 0,
            output_tokens: value.usage.completion_tokens ?? 0,
            total_tokens: value.usage.total_tokens ?? 0,
            cached_input_tokens:
              value.usage.prompt_tokens_details?.cached_tokens ?? 0,
            reasoning_output_tokens:
              value.usage.completion_tokens_details?.reasoning_tokens ?? 0,
          };
    return { responseId: value.id, output, usage };
  }
}
