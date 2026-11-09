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
    for (const raw of request.body.input as JsonObject[]) {
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
        messages.push({ role: raw.role, content });
      } else if (raw.type === 'function_call') {
        messages.push({
          role: 'assistant',
          tool_calls: [
            {
              id: raw.call_id,
              type: 'function',
              function: { name: raw.name, arguments: raw.arguments },
            },
          ],
        });
      } else if (raw.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: raw.call_id,
          content:
            typeof raw.output === 'string'
              ? raw.output
              : JSON.stringify(raw.output),
        });
      } else if (raw.type !== 'reasoning')
        throw new TypeError(
          'ChatCompletionsModel received an unsupported native input item',
        );
    }
    const tools = ((request.body.tools ?? []) as JsonObject[]).map(
      ({ type, ...tool }) => {
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
      },
    );
    const options: Record<string, unknown> = Object.fromEntries(
      [
        'temperature',
        'top_p',
        'parallel_tool_calls',
        'tool_choice',
        'metadata',
        'store',
      ]
        .filter((key) => key in request.body)
        .map((key) => [key, request.body[key]]),
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
    const message = value.choices[0].message;
    const output: JsonObject[] = [];
    if (message.content != null)
      output.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: message.content }],
      });
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
