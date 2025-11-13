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
  getLogger,
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
            ...(providerData ?? {}),
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
                  const { providerData: contentProviderData } = c;
                  if (c.type === 'input_text') {
                    return {
                      type: 'text',
                      text: c.text,
                      providerMetadata: {
                        ...(contentProviderData ?? {}),
                      },
                    };
                  }
                  if (c.type === 'input_image') {
                    if (typeof c.image === 'string') {
                      const url = new URL(c.image);
                      return {
                        type: 'image',
                        image: url,
                      };
                    } else if (c.image instanceof Uint8Array) {
                      return {
                        type: 'image',
                        image: c.image,
                      };
                    } else {
                      throw new UserError(
                        'Image must be a URL string or Uint8Array',
                      );
                    }
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
                      providerMetadata: {
                        ...(contentProviderData ?? {}),
                      },
                    };
                  }
                  throw new UserError(`Unknown content type: ${c.type}`);
                }),
          providerMetadata: {
            ...(providerData ?? {}),
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
            .filter((c) => c.type === 'output_text')
            .map((c) => {
              const { providerData: contentProviderData } = c;
              return {
                type: 'text',
                text: c.text,
                providerMetadata: {
                  ...(contentProviderData ?? {}),
                },
              };
            }),
          providerMetadata: {
            ...(providerData ?? {}),
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
            ...(item.providerData ?? {}),
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
          args: parseArguments(item.arguments),
          providerMetadata: {
            ...(item.providerData ?? {}),
          },
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
        providerMetadata: {
          ...(item.providerData ?? {}),
        },
      };
      messages.push({
        role: 'tool',
        content: [toolResult],
        providerMetadata: {
          ...(item.providerData ?? {}),
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
        content: [
          {
            type: 'reasoning',
            text: item.content[0].text,
            providerMetadata: { ...(item.providerData ?? {}) },
          },
        ],
        providerMetadata: {
          ...(item.providerData ?? {}),
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

  if (tool.type === 'shell' || tool.type === 'apply_patch') {
    throw new UserError(`Unsupported tool type: ${tool.type}`);
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
  #logger = getLogger('openai-agents:extensions:ai-sdk');
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

        const aiSdkRequest: LanguageModelV1CallOptions = {
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
        };

        if (this.#logger.dontLogModelData) {
          this.#logger.debug('Request sent');
        } else {
          this.#logger.debug('Request:', aiSdkRequest);
        }

        const result = await this.#model.doGenerate(aiSdkRequest);

        const output: ModelResponse['output'] = [];

        result.toolCalls?.forEach((toolCall) => {
          output.push({
            type: 'function_call',
            callId: toolCall.toolCallId,
            name: toolCall.toolName,
            arguments: toolCall.args,
            status: 'completed',
            providerData: !result.text ? result.providerMetadata : undefined,
          });
        });

        // Some of other platforms may return both tool calls and text.
        // Putting a text message here will let the agent loop to complete,
        // so adding this item only when the tool calls are empty.
        // Note that the same support is not available for streaming mode.
        if (
          (!result.toolCalls || result.toolCalls.length === 0) &&
          result.text
        ) {
          output.push({
            type: 'message',
            content: [{ type: 'output_text', text: result.text }],
            role: 'assistant',
            status: 'completed',
            providerData: result.providerMetadata,
          });
        }

        if (span && request.tracing === true) {
          span.spanData.output = output;
        }

        const response = {
          responseId: result.response?.id ?? 'FAKE_ID',
          usage: new Usage({
            inputTokens: Number.isNaN(result.usage?.promptTokens)
              ? 0
              : (result.usage?.promptTokens ?? 0),
            outputTokens: Number.isNaN(result.usage?.completionTokens)
              ? 0
              : (result.usage?.completionTokens ?? 0),
            totalTokens:
              (Number.isNaN(result.usage?.promptTokens)
                ? 0
                : (result.usage?.promptTokens ?? 0)) +
              (Number.isNaN(result.usage?.completionTokens)
                ? 0
                : (result.usage?.completionTokens ?? 0)),
          }),
          output,
          providerData: result,
        } as const;

        if (span && request.tracing === true) {
          span.spanData.usage = {
            // Note that tracing supports only input and output tokens for Chat Completions.
            // So, we don't include other properties here.
            input_tokens: response.usage.inputTokens,
            output_tokens: response.usage.outputTokens,
          };
        }

        if (this.#logger.dontLogModelData) {
          this.#logger.debug('Response ready');
        } else {
          this.#logger.debug('Response:', response);
        }

        return response;
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

      const aiSdkRequest: LanguageModelV1CallOptions = {
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
      };

      if (this.#logger.dontLogModelData) {
        this.#logger.debug('Request received (streamed)');
      } else {
        this.#logger.debug('Request (streamed):', aiSdkRequest);
      }

      const { stream } = await this.#model.doStream(aiSdkRequest);

      let started = false;
      let responseId: string | undefined;
      let usagePromptTokens = 0;
      let usageCompletionTokens = 0;
      const functionCalls: Record<string, protocol.FunctionCallItem> = {};
      let textOutput: protocol.OutputText | undefined;

      const reader = stream.getReader();
      try {
        while (true) {
          const { value: part, done } = await reader.read();
          if (done) break;

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
              usagePromptTokens = Number.isNaN(part.usage?.promptTokens)
                ? 0
                : (part.usage?.promptTokens ?? 0);
              usageCompletionTokens = Number.isNaN(part.usage?.completionTokens)
                ? 0
                : (part.usage?.completionTokens ?? 0);
              break;
            }
            case 'error': {
              throw part.error;
            }
            default:
              break;
          }
        }
      } finally {
        reader.releaseLock();
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
        span.spanData.usage = {
          // Note that tracing supports only input and output tokens for Chat Completions.
          // So, we don't include other properties here.
          input_tokens: finalEvent.response.usage.inputTokens,
          output_tokens: finalEvent.response.usage.outputTokens,
        };
      }

      if (this.#logger.dontLogModelData) {
        this.#logger.debug('Response ready (streamed)');
      } else {
        this.#logger.debug('Response (streamed):', finalEvent.response);
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

export function parseArguments(args: string | undefined | null): any {
  if (!args) {
    return {};
  }

  try {
    return JSON.parse(args);
  } catch (_) {
    return {};
  }
}
