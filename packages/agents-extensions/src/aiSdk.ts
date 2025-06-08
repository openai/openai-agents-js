import type {
  JSONSchema7,
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1FunctionTool,
  LanguageModelV1Message,
  LanguageModelV1Prompt,
  LanguageModelV1ProviderDefinedTool,
  LanguageModelV1ToolCallPart,
  LanguageModelV1ToolResultPart,
} from '@ai-sdk/provider';
import {
  createGenerationSpan,
  Model,
  ModelRequest,
  ModelResponse,
  protocol,
  resetCurrentSpan,
  ResponseStreamEvent,
  SerializedHandoff,
  SerializedOutputType,
  SerializedTool,
  setCurrentSpan,
  Usage,
  UserError,
  withGenerationSpan,
} from '@openai/agents';
import { isZodObject } from '@openai/agents/utils';

/**
 * @internal
 * Converts a list of model items to a list of language model v1 messages.
 *
 * @param model - The model to use.
 * @param items - The items to convert.
 * @returns The list of language model v1 messages.
 */
export function itemsToLanguageV1Messages(
  model: LanguageModelV1,
  items: protocol.ModelItem[],
): LanguageModelV1Message[] {
  const messages: LanguageModelV1Message[] = [];
  let currentAssistantMessage: LanguageModelV1Message | undefined;

  for (const item of items) {
    if (item.type === 'message' || typeof item.type === 'undefined') {
      const { role, content, providerData } = item;
      if (role === 'system') {
        messages.push({
          role: 'system',
          content: content,
          providerMetadata: {
            [model.provider]: {
              ...(providerData ?? {}),
            },
          },
        });
        continue;
      }

      if (role === 'user') {
        messages.push({
          role,
          content:
            typeof content === 'string'
              ? [{ type: 'text', text: content }]
              : content.map((c) => {
                  if (c.type === 'input_text') {
                    return { type: 'text', text: c.text };
                  }
                  if (c.type === 'input_image') {
                    const url = new URL(c.image);
                    return { type: 'image', image: url as unknown as URL };
                  }
                  if (c.type === 'input_file') {
                    if (typeof c.file !== 'string') {
                      throw new UserError('File ID is not supported');
                    }
                    return {
                      type: 'file',
                      file: c.file,
                      mimeType: 'application/octet-stream',
                      data: c.file,
                    };
                  }
                  throw new UserError(`Unknown content type: ${c.type}`);
                }),
          providerMetadata: {
            [model.provider]: {
              ...(providerData ?? {}),
            },
          },
        });
        continue;
      }

      if (role === 'assistant') {
        if (currentAssistantMessage) {
          messages.push(currentAssistantMessage);
          currentAssistantMessage = undefined;
        }

        messages.push({
          role,
          content: content
            .filter((c) => c.type === 'input_text' || c.type === 'output_text')
            .map((c) => {
              if (c.type === 'output_text') {
                return { type: 'text', text: c.text };
              }
              if (c.type === 'input_text') {
                return { type: 'text', text: c.text };
              }
              const exhaustiveCheck = c satisfies never;
              throw new UserError(`Unknown content type: ${exhaustiveCheck}`);
            }),
          providerMetadata: {
            [model.provider]: {
              ...(providerData ?? {}),
            },
          },
        });
        continue;
      }

      const exhaustiveMessageTypeCheck = item satisfies never;
      throw new Error(`Unknown message type: ${exhaustiveMessageTypeCheck}`);
    } else if (item.type === 'function_call') {
      if (!currentAssistantMessage) {
        currentAssistantMessage = {
          role: 'assistant',
          content: [],
          providerMetadata: {
            [model.provider]: {
              ...(item.providerData ?? {}),
            },
          },
        };
      }

      if (
        Array.isArray(currentAssistantMessage.content) &&
        currentAssistantMessage.role === 'assistant'
      ) {
        const content: LanguageModelV1ToolCallPart = {
          type: 'tool-call',
          toolCallId: item.callId,
          toolName: item.name,
          args: JSON.parse(item.arguments),
        };
        currentAssistantMessage.content.push(content);
      }
      continue;
    } else if (item.type === 'function_call_result') {
      if (currentAssistantMessage) {
        messages.push(currentAssistantMessage);
        currentAssistantMessage = undefined;
      }
      const toolResult: LanguageModelV1ToolResultPart = {
        type: 'tool-result',
        toolCallId: item.callId,
        toolName: item.name,
        result: item.output,
      };
      messages.push({
        role: 'tool',
        content: [toolResult],
        providerMetadata: {
          [model.provider]: {
            ...(item.providerData ?? {}),
          },
        },
      });
      continue;
    }

    if (item.type === 'hosted_tool_call') {
      throw new UserError('Hosted tool calls are not supported');
    }

    if (item.type === 'computer_call') {
      throw new UserError('Computer calls are not supported');
    }

    if (item.type === 'computer_call_result') {
      throw new UserError('Computer call results are not supported');
    }

    if (
      item.type === 'reasoning' &&
      item.content.length > 0 &&
      typeof item.content[0].text === 'string'
    ) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'reasoning', text: item.content[0].text }],
        providerMetadata: {
          [model.provider]: {
            ...(item.providerData ?? {}),
          },
        },
      });
      continue;
    }

    if (item.type === 'unknown') {
      messages.push({ ...(item.providerData ?? {}) } as LanguageModelV1Message);
      continue;
    }

    if (item) {
      throw new UserError(`Unknown item type: ${item.type}`);
    }

    const itemType = item satisfies never;
    throw new UserError(`Unknown item type: ${itemType}`);
  }

  if (currentAssistantMessage) {
    messages.push(currentAssistantMessage);
  }

  return messages;
}

/**
 * @internal
 * Converts a handoff to a language model v1 tool.
 *
 * @param model - The model to use.
 * @param handoff - The handoff to convert.
 */
function handoffToLanguageV1Tool(
  model: LanguageModelV1,
  handoff: SerializedHandoff,
): LanguageModelV1FunctionTool {
  return {
    type: 'function',
    name: handoff.toolName,
    description: handoff.toolDescription,
    parameters: handoff.inputJsonSchema as JSONSchema7,
  };
}

/**
 * @internal
 * Converts a tool to a language model v1 tool.
 *
 * @param model - The model to use.
 * @param tool - The tool to convert.
 */
export function toolToLanguageV1Tool(
  model: LanguageModelV1,
  tool: SerializedTool,
): LanguageModelV1FunctionTool | LanguageModelV1ProviderDefinedTool {
  if (tool.type === 'function') {
    return {
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as JSONSchema7,
    };
  }

  if (tool.type === 'hosted_tool') {
    return {
      type: 'provider-defined',
      id: `${model.provider}.${tool.name}`,
      name: tool.name,
      args: tool.providerData?.args ?? {},
    };
  }

  if (tool.type === 'computer') {
    return {
      type: 'provider-defined',
      id: `${model.provider}.${tool.name}`,
      name: tool.name,
      args: {
        environment: tool.environment,
        display_width: tool.dimensions[0],
        display_height: tool.dimensions[1],
      },
    };
  }

  const exhaustiveCheck: never = tool;
  throw new Error(`Unsupported tool type: ${exhaustiveCheck}`);
}

/**
 * @internal
 * Converts an output type to a language model v1 response format.
 *
 * @param outputType - The output type to convert.
 * @returns The language model v1 response format.
 */
export function getResponseFormat(
  outputType: SerializedOutputType,
): LanguageModelV1CallOptions['responseFormat'] {
  if (outputType === 'text') {
    return {
      type: 'text',
    };
  }

  return {
    type: 'json',
    name: outputType.name,
    schema: outputType.schema,
  };
}

/**
 * Wraps a model from the AI SDK that adheres to the LanguageModelV1 spec to be used used as a model
 * in the OpenAI Agents SDK to use other models.
 *
 * While you can use this with the OpenAI models, it is recommended to use the default OpenAI model
 * provider instead.
 *
 * If tracing is enabled, the model will send generation spans to your traces processor.
 *
 * ```ts
 * import { aisdk } from '@openai/agents-extensions';
 * import { openai } from '@ai-sdk/openai';
 *
 * const model = aisdk(openai('gpt-4o'));
 *
 * const agent = new Agent({
 *   name: 'My Agent',
 *   model
 * });
 * ```
 *
 * @param model - The Vercel AI SDK model to wrap.
 * @returns The wrapped model.
 */
export class AiSdkModel implements Model {
  #model: LanguageModelV1;
  constructor(model: LanguageModelV1) {
    this.#model = model;
  }

  async getResponse(request: ModelRequest) {
    return withGenerationSpan(async (span) => {
      try {
        span.spanData.model = this.#model.provider + ':' + this.#model.modelId;
        span.spanData.model_config = {
          provider: this.#model.provider,
          model_impl: 'ai-sdk',
        };

        let input: LanguageModelV1Prompt =
          typeof request.input === 'string'
            ? [
                {
                  role: 'user',
                  content: [{ type: 'text', text: request.input }],
                },
              ]
            : itemsToLanguageV1Messages(this.#model, request.input);

        if (request.systemInstructions) {
          input = [
            {
              role: 'system',
              content: request.systemInstructions,
            },
            ...input,
          ];
        }

        const tools = request.tools.map((tool) =>
          toolToLanguageV1Tool(this.#model, tool),
        );

        request.handoffs.forEach((handoff) => {
          tools.push(handoffToLanguageV1Tool(this.#model, handoff));
        });

        if (span && request.tracing === true) {
          span.spanData.input = input;
        }

        if (isZodObject(request.outputType)) {
          throw new UserError('Zod output type is not yet supported');
        }

        const responseFormat: LanguageModelV1CallOptions['responseFormat'] =
          getResponseFormat(request.outputType);

        const result = await this.#model.doGenerate({
          inputFormat: 'messages',
          mode: {
            type: 'regular',
            tools,
          },
          prompt: input,
          temperature: request.modelSettings.temperature,
          topP: request.modelSettings.topP,
          frequencyPenalty: request.modelSettings.frequencyPenalty,
          presencePenalty: request.modelSettings.presencePenalty,
          maxTokens: request.modelSettings.maxTokens,
          responseFormat,
          abortSignal: request.signal,

          ...(request.modelSettings.providerData ?? {}),
        });

        const output: ModelResponse['output'] = [];

        result.toolCalls?.forEach((toolCall) => {
          output.push({
            type: 'function_call',
            callId: toolCall.toolCallId,
            name: toolCall.toolName,
            arguments: toolCall.args,
            status: 'completed',
            providerData: !result.text
              ? result.providerMetadata?.[this.#model.provider]
              : undefined,
          });
        });

        // Some of other platforms may return both tool calls and text.
        // Putting a text message here will let the agent loop to complete,
        // so adding this item only when the tool calls are empty.
        // Note that the same support is not available for streaming mode.
        if (!result.toolCalls && result.text) {
          output.push({
            type: 'message',
            content: [{ type: 'output_text', text: result.text }],
            role: 'assistant',
            status: 'completed',
            providerData: result.providerMetadata?.[this.#model.provider],
          });
        }

        if (span && request.tracing === true) {
          span.spanData.output = output;
        }

        return {
          responseId: result.response?.id ?? 'FAKE_ID',
          usage: new Usage({
            inputTokens: result.usage.promptTokens,
            outputTokens: result.usage.completionTokens,
            totalTokens:
              result.usage.promptTokens + result.usage.completionTokens,
          }),
          output,
        };
      } catch (error) {
        if (error instanceof Error) {
          span.setError({
            message: request.tracing === true ? error.message : 'Unknown error',
            data: {
              error:
                request.tracing === true
                  ? String(error)
                  : error instanceof Error
                    ? error.name
                    : undefined,
            },
          });
        } else {
          span.setError({
            message: 'Unknown error',
            data: {
              error:
                request.tracing === true
                  ? String(error)
                  : error instanceof Error
                    ? error.name
                    : undefined,
            },
          });
        }
        throw error;
      }
    });
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<ResponseStreamEvent> {
    const span = request.tracing ? createGenerationSpan() : undefined;
    try {
      if (span) {
        span.start();
        setCurrentSpan(span);
      }

      if (span?.spanData) {
        span.spanData.model = this.#model.provider + ':' + this.#model.modelId;
        span.spanData.model_config = {
          provider: this.#model.provider,
          model_impl: 'ai-sdk',
        };
      }

      let input: LanguageModelV1Prompt =
        typeof request.input === 'string'
          ? [
              {
                role: 'user',
                content: [{ type: 'text', text: request.input }],
              },
            ]
          : itemsToLanguageV1Messages(this.#model, request.input);

      if (request.systemInstructions) {
        input = [
          {
            role: 'system',
            content: request.systemInstructions,
          },
          ...input,
        ];
      }

      const tools = request.tools.map((tool) =>
        toolToLanguageV1Tool(this.#model, tool),
      );

      request.handoffs.forEach((handoff) => {
        tools.push(handoffToLanguageV1Tool(this.#model, handoff));
      });

      if (span && request.tracing === true) {
        span.spanData.input = input;
      }

      const responseFormat: LanguageModelV1CallOptions['responseFormat'] =
        getResponseFormat(request.outputType);

      const { stream } = await this.#model.doStream({
        inputFormat: 'messages',
        mode: {
          type: 'regular',
          tools,
        },
        prompt: input,
        temperature: request.modelSettings.temperature,
        topP: request.modelSettings.topP,
        frequencyPenalty: request.modelSettings.frequencyPenalty,
        presencePenalty: request.modelSettings.presencePenalty,
        maxTokens: request.modelSettings.maxTokens,
        responseFormat,
        abortSignal: request.signal,
        ...(request.modelSettings.providerData ?? {}),
      });

      let started = false;
      let responseId: string | undefined;
      let usagePromptTokens = 0;
      let usageCompletionTokens = 0;
      const functionCalls: Record<string, protocol.FunctionCallItem> = {};
      let textOutput: protocol.OutputText | undefined;

      for await (const part of stream) {
        if (!started) {
          started = true;
          yield { type: 'response_started' };
        }

        yield { type: 'model', event: part };

        switch (part.type) {
          case 'text-delta': {
            if (!textOutput) {
              textOutput = { type: 'output_text', text: '' };
            }
            textOutput.text += part.textDelta;
            yield { type: 'output_text_delta', delta: part.textDelta };
            break;
          }
          case 'tool-call': {
            if (part.toolCallType === 'function') {
              functionCalls[part.toolCallId] = {
                type: 'function_call',
                callId: part.toolCallId,
                name: part.toolName,
                arguments: part.args,
                status: 'completed',
              };
            }
            break;
          }
          case 'tool-call-delta': {
            if (part.toolCallType === 'function') {
              const fc = functionCalls[part.toolCallId] ?? {
                type: 'function_call',
                callId: part.toolCallId,
                name: '',
                arguments: '',
              };
              fc.name += part.toolName;
              fc.arguments += part.argsTextDelta;
              functionCalls[part.toolCallId] = fc;
            }
            break;
          }
          case 'response-metadata': {
            if (part.id) {
              responseId = part.id;
            }
            break;
          }
          case 'finish': {
            usagePromptTokens = part.usage.promptTokens;
            usageCompletionTokens = part.usage.completionTokens;
            break;
          }
          case 'error': {
            throw part.error;
          }
          default:
            break;
        }
      }

      const outputs: protocol.OutputModelItem[] = [];
      if (textOutput) {
        outputs.push({
          type: 'message',
          role: 'assistant',
          content: [textOutput],
          status: 'completed',
        });
      }
      for (const fc of Object.values(functionCalls)) {
        outputs.push(fc);
      }

      const finalEvent: protocol.StreamEventResponseCompleted = {
        type: 'response_done',
        response: {
          id: responseId ?? 'FAKE_ID',
          usage: {
            inputTokens: usagePromptTokens,
            outputTokens: usageCompletionTokens,
            totalTokens: usagePromptTokens + usageCompletionTokens,
          },
          output: outputs,
        },
      };

      if (span && request.tracing === true) {
        span.spanData.output = outputs;
      }

      yield finalEvent;
    } catch (error) {
      if (span) {
        span.setError({
          message: 'Error streaming response',
          data: {
            error:
              request.tracing === true
                ? String(error)
                : error instanceof Error
                  ? error.name
                  : undefined,
          },
        });
      }
      throw error;
    } finally {
      if (span) {
        span.end();
        resetCurrentSpan();
      }
    }
  }
}

/**
 * Wraps a model from the AI SDK that adheres to the LanguageModelV1 spec to be used used as a model
 * in the OpenAI Agents SDK to use other models.
 *
 * While you can use this with the OpenAI models, it is recommended to use the default OpenAI model
 * provider instead.
 *
 * If tracing is enabled, the model will send generation spans to your traces processor.
 *
 * ```ts
 * import { aisdk } from '@openai/agents-extensions';
 * import { openai } from '@ai-sdk/openai';
 *
 * const model = aisdk(openai('gpt-4o'));
 *
 * const agent = new Agent({
 *   name: 'My Agent',
 *   model
 * });
 * ```
 *
 * @param model - The Vercel AI SDK model to wrap.
 * @returns The wrapped model.
 */
export function aisdk(model: LanguageModelV1) {
  return new AiSdkModel(model);
}
