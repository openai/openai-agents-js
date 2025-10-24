import type {
  JSONSchema7,
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2FunctionTool,
  LanguageModelV2Message,
  LanguageModelV2Prompt,
  LanguageModelV2ProviderDefinedTool,
  LanguageModelV2ToolCallPart,
  LanguageModelV2ToolChoice,
  LanguageModelV2ToolResultPart,
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
  ModelSettingsToolChoice,
} from '@openai/agents';
import { isZodObject } from '@openai/agents/utils';
import { encodeUint8ArrayToBase64 } from '@openai/agents/utils';

/**
 * @internal
 * Converts a list of model items to a list of language model V2 messages.
 *
 * @param model - The model to use.
 * @param items - The items to convert.
 * @returns The list of language model V2 messages.
 */
export function itemsToLanguageV2Messages(
  model: LanguageModelV2,
  items: protocol.ModelItem[],
): LanguageModelV2Message[] {
  const messages: LanguageModelV2Message[] = [];
  let currentAssistantMessage: LanguageModelV2Message | undefined;

  for (const item of items) {
    if (item.type === 'message' || typeof item.type === 'undefined') {
      const { role, content, providerData } = item;
      if (role === 'system') {
        messages.push({
          role: 'system',
          content: content,
          providerOptions: {
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
                      providerOptions: {
                        ...(contentProviderData ?? {}),
                      },
                    };
                  }
                  if (c.type === 'input_image') {
                    const imageSource =
                      typeof c.image === 'string'
                        ? c.image
                        : typeof (c as any).imageUrl === 'string'
                          ? (c as any).imageUrl
                          : undefined;

                    if (!imageSource) {
                      throw new UserError(
                        'Only image URLs are supported for user inputs.',
                      );
                    }

                    const url = new URL(imageSource);
                    return {
                      type: 'file',
                      data: url.toString(),
                      mediaType: 'image/*',
                      providerOptions: {
                        ...(contentProviderData ?? {}),
                      },
                    };
                  }
                  if (c.type === 'input_file') {
                    throw new UserError('File inputs are not supported.');
                  }
                  throw new UserError(`Unknown content type: ${c.type}`);
                }),
          providerOptions: {
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
                providerOptions: {
                  ...(contentProviderData ?? {}),
                },
              };
            }),
          providerOptions: {
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
          providerOptions: {
            ...(item.providerData ?? {}),
          },
        };
      }

      if (
        Array.isArray(currentAssistantMessage.content) &&
        currentAssistantMessage.role === 'assistant'
      ) {
        const content: LanguageModelV2ToolCallPart = {
          type: 'tool-call',
          toolCallId: item.callId,
          toolName: item.name,
          input: parseArguments(item.arguments),
          providerOptions: {
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
      const toolResult: LanguageModelV2ToolResultPart = {
        type: 'tool-result',
        toolCallId: item.callId,
        toolName: item.name,
        output: convertToAiSdkOutput(item.output),
        providerOptions: {
          ...(item.providerData ?? {}),
        },
      };
      messages.push({
        role: 'tool',
        content: [toolResult],
        providerOptions: {
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
            providerOptions: { ...(item.providerData ?? {}) },
          },
        ],
        providerOptions: {
          ...(item.providerData ?? {}),
        },
      });
      continue;
    }

    if (item.type === 'unknown') {
      messages.push({ ...(item.providerData ?? {}) } as LanguageModelV2Message);
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
 * Converts a handoff to a language model V2 tool.
 *
 * @param model - The model to use.
 * @param handoff - The handoff to convert.
 */
function handoffToLanguageV2Tool(
  model: LanguageModelV2,
  handoff: SerializedHandoff,
): LanguageModelV2FunctionTool {
  return {
    type: 'function',
    name: handoff.toolName,
    description: handoff.toolDescription,
    inputSchema: handoff.inputJsonSchema as JSONSchema7,
  };
}

function convertToAiSdkOutput(
  output: protocol.FunctionCallResultItem['output'],
): LanguageModelV2ToolResultPart['output'] {
  if (typeof output === 'string') {
    return { type: 'text', value: output };
  }
  if (Array.isArray(output)) {
    return convertStructuredOutputsToAiSdkOutput(output);
  }
  if (isRecord(output) && typeof output.type === 'string') {
    if (output.type === 'text' && typeof output.text === 'string') {
      return { type: 'text', value: output.text };
    }
    if (output.type === 'image' || output.type === 'file') {
      const structuredOutputs = convertLegacyToolOutputContent(
        output as protocol.ToolCallOutputContent,
      );
      return convertStructuredOutputsToAiSdkOutput(structuredOutputs);
    }
  }
  return { type: 'text', value: String(output) };
}

/**
 * Normalises legacy ToolOutput* objects into the protocol `input_*` shapes so that the AI SDK
 * bridge can treat all tool results uniformly.
 */
function convertLegacyToolOutputContent(
  output: protocol.ToolCallOutputContent,
): protocol.ToolCallStructuredOutput[] {
  if (output.type === 'text') {
    const structured: protocol.InputText = {
      type: 'input_text',
      text: output.text,
    };
    if (output.providerData) {
      structured.providerData = output.providerData;
    }
    return [structured];
  }

  if (output.type === 'image') {
    const structured: protocol.InputImage = { type: 'input_image' };

    if (output.detail) {
      structured.detail = output.detail;
    }

    if (typeof output.image === 'string' && output.image.length > 0) {
      structured.image = output.image;
    } else if (isRecord(output.image)) {
      const imageObj = output.image as Record<string, any>;
      const inlineMediaType = getImageInlineMediaType(imageObj);
      if (typeof imageObj.url === 'string' && imageObj.url.length > 0) {
        structured.image = imageObj.url;
      } else if (
        typeof imageObj.data === 'string' &&
        imageObj.data.length > 0
      ) {
        structured.image = formatInlineData(imageObj.data, inlineMediaType);
      } else if (
        imageObj.data instanceof Uint8Array &&
        imageObj.data.length > 0
      ) {
        structured.image = formatInlineData(imageObj.data, inlineMediaType);
      } else {
        const referencedId =
          (typeof imageObj.fileId === 'string' &&
            imageObj.fileId.length > 0 &&
            imageObj.fileId) ||
          (typeof imageObj.id === 'string' && imageObj.id.length > 0
            ? imageObj.id
            : undefined);
        if (referencedId) {
          structured.image = { id: referencedId };
        }
      }
    }
    if (output.providerData) {
      structured.providerData = output.providerData;
    }
    return [structured];
  }

  if (output.type === 'file') {
    return [];
  }
  throw new UserError(
    `Unsupported tool output type: ${JSON.stringify(output)}`,
  );
}

/**
 * Maps the protocol-level structured outputs into the Language Model V2 result primitives.
 * The AI SDK expects either plain text or content parts (text + media), so we merge multiple
 * items accordingly.
 */
function convertStructuredOutputsToAiSdkOutput(
  outputs: protocol.ToolCallStructuredOutput[],
): LanguageModelV2ToolResultPart['output'] {
  const textParts: string[] = [];
  const mediaParts: Array<{ type: 'media'; data: string; mediaType: string }> =
    [];

  for (const item of outputs) {
    if (item.type === 'input_text') {
      textParts.push(item.text);
      continue;
    }
    if (item.type === 'input_image') {
      const imageValue =
        typeof item.image === 'string'
          ? item.image
          : isRecord(item.image) && typeof item.image.id === 'string'
            ? `openai-file:${item.image.id}`
            : typeof (item as any).imageUrl === 'string'
              ? (item as any).imageUrl
              : undefined;

      const legacyFileId = (item as any).fileId;
      if (!imageValue && typeof legacyFileId === 'string') {
        textParts.push(`[image file_id=${legacyFileId}]`);
        continue;
      }
      if (!imageValue) {
        textParts.push('[image]');
        continue;
      }
      try {
        const url = new URL(imageValue);
        mediaParts.push({
          type: 'media',
          data: url.toString(),
          mediaType: 'image/*',
        });
      } catch {
        textParts.push(imageValue);
      }
      continue;
    }

    if (item.type === 'input_file') {
      textParts.push('[file output skipped]');
      continue;
    }
  }

  if (mediaParts.length === 0) {
    return { type: 'text', value: textParts.join('') };
  }

  const value: Array<
    | { type: 'text'; text: string }
    | { type: 'media'; data: string; mediaType: string }
  > = [];

  if (textParts.length > 0) {
    value.push({ type: 'text', text: textParts.join('') });
  }
  value.push(...mediaParts);
  return { type: 'content', value };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function getImageInlineMediaType(
  source: Record<string, any>,
): string | undefined {
  if (typeof source.mediaType === 'string' && source.mediaType.length > 0) {
    return source.mediaType;
  }
  return undefined;
}

function formatInlineData(
  data: string | Uint8Array,
  mediaType?: string,
): string {
  const base64 =
    typeof data === 'string' ? data : encodeUint8ArrayToBase64(data);
  return mediaType ? `data:${mediaType};base64,${base64}` : base64;
}

/**
 * @internal
 * Converts a tool to a language model V2 tool.
 *
 * @param model - The model to use.
 * @param tool - The tool to convert.
 */
export function toolToLanguageV2Tool(
  model: LanguageModelV2,
  tool: SerializedTool,
): LanguageModelV2FunctionTool | LanguageModelV2ProviderDefinedTool {
  if (tool.type === 'function') {
    return {
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as JSONSchema7,
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
 * Converts an output type to a language model V2 response format.
 *
 * @param outputType - The output type to convert.
 * @returns The language model V2 response format.
 */
export function getResponseFormat(
  outputType: SerializedOutputType,
): LanguageModelV2CallOptions['responseFormat'] {
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
 * Wraps a model from the AI SDK that adheres to the LanguageModelV2 spec to be used used as a model
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
  #model: LanguageModelV2;
  #logger = getLogger('openai-agents:extensions:ai-sdk');
  constructor(model: LanguageModelV2) {
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

        let input: LanguageModelV2Prompt =
          typeof request.input === 'string'
            ? [
                {
                  role: 'user',
                  content: [{ type: 'text', text: request.input }],
                },
              ]
            : itemsToLanguageV2Messages(this.#model, request.input);

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
          toolToLanguageV2Tool(this.#model, tool),
        );

        request.handoffs.forEach((handoff) => {
          tools.push(handoffToLanguageV2Tool(this.#model, handoff));
        });

        if (span && request.tracing === true) {
          span.spanData.input = input;
        }

        if (isZodObject(request.outputType)) {
          throw new UserError('Zod output type is not yet supported');
        }

        const responseFormat: LanguageModelV2CallOptions['responseFormat'] =
          getResponseFormat(request.outputType);

        const aiSdkRequest: LanguageModelV2CallOptions = {
          tools,
          toolChoice: toolChoiceToLanguageV2Format(
            request.modelSettings.toolChoice,
          ),
          prompt: input,
          temperature: request.modelSettings.temperature,
          topP: request.modelSettings.topP,
          frequencyPenalty: request.modelSettings.frequencyPenalty,
          presencePenalty: request.modelSettings.presencePenalty,
          maxOutputTokens: request.modelSettings.maxTokens,
          responseFormat,
          abortSignal: request.signal,

          ...(request.modelSettings.providerData ?? {}),
        };

        if (this.#logger.dontLogModelData) {
          this.#logger.debug('Request sent');
        } else {
          this.#logger.debug('Request:', JSON.stringify(aiSdkRequest, null, 2));
        }

        const result = await this.#model.doGenerate(aiSdkRequest);

        const output: ModelResponse['output'] = [];

        const resultContent = (result as any).content ?? [];
        const toolCalls = resultContent.filter(
          (c: any) => c && c.type === 'tool-call',
        );
        const hasToolCalls = toolCalls.length > 0;
        for (const toolCall of toolCalls) {
          output.push({
            type: 'function_call',
            callId: toolCall.toolCallId,
            name: toolCall.toolName,
            arguments:
              typeof toolCall.input === 'string'
                ? toolCall.input
                : JSON.stringify(toolCall.input ?? {}),
            status: 'completed',
            providerData: hasToolCalls ? result.providerMetadata : undefined,
          });
        }

        // Some of other platforms may return both tool calls and text.
        // Putting a text message here will let the agent loop to complete,
        // so adding this item only when the tool calls are empty.
        // Note that the same support is not available for streaming mode.
        if (!hasToolCalls) {
          const textItem = resultContent.find(
            (c: any) => c && c.type === 'text' && typeof c.text === 'string',
          );
          if (textItem) {
            output.push({
              type: 'message',
              content: [{ type: 'output_text', text: textItem.text }],
              role: 'assistant',
              status: 'completed',
              providerData: (result as any).providerMetadata,
            });
          }
        }

        if (span && request.tracing === true) {
          span.spanData.output = output;
        }

        const response = {
          responseId: (result as any).response?.id ?? 'FAKE_ID',
          usage: new Usage({
            inputTokens: Number.isNaN((result as any).usage?.inputTokens)
              ? 0
              : ((result as any).usage?.inputTokens ?? 0),
            outputTokens: Number.isNaN((result as any).usage?.outputTokens)
              ? 0
              : ((result as any).usage?.outputTokens ?? 0),
            totalTokens:
              (Number.isNaN((result as any).usage?.inputTokens)
                ? 0
                : ((result as any).usage?.inputTokens ?? 0)) +
                (Number.isNaN((result as any).usage?.outputTokens)
                  ? 0
                  : ((result as any).usage?.outputTokens ?? 0)) || 0,
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
          this.#logger.debug('Response:', JSON.stringify(response, null, 2));
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

      let input: LanguageModelV2Prompt =
        typeof request.input === 'string'
          ? [
              {
                role: 'user',
                content: [{ type: 'text', text: request.input }],
              },
            ]
          : itemsToLanguageV2Messages(this.#model, request.input);

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
        toolToLanguageV2Tool(this.#model, tool),
      );

      request.handoffs.forEach((handoff) => {
        tools.push(handoffToLanguageV2Tool(this.#model, handoff));
      });

      if (span && request.tracing === true) {
        span.spanData.input = input;
      }

      const responseFormat: LanguageModelV2CallOptions['responseFormat'] =
        getResponseFormat(request.outputType);

      const aiSdkRequest: LanguageModelV2CallOptions = {
        tools,
        prompt: input,
        temperature: request.modelSettings.temperature,
        topP: request.modelSettings.topP,
        frequencyPenalty: request.modelSettings.frequencyPenalty,
        presencePenalty: request.modelSettings.presencePenalty,
        maxOutputTokens: request.modelSettings.maxTokens,
        responseFormat,
        abortSignal: request.signal,
        ...(request.modelSettings.providerData ?? {}),
      };

      if (this.#logger.dontLogModelData) {
        this.#logger.debug('Request received (streamed)');
      } else {
        this.#logger.debug(
          'Request (streamed):',
          JSON.stringify(aiSdkRequest, null, 2),
        );
      }

      const { stream } = await this.#model.doStream(aiSdkRequest);

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
            textOutput.text += (part as any).delta;
            yield { type: 'output_text_delta', delta: (part as any).delta };
            break;
          }
          case 'tool-call': {
            const toolCallId = (part as any).toolCallId;
            if (toolCallId) {
              functionCalls[toolCallId] = {
                type: 'function_call',
                callId: toolCallId,
                name: (part as any).toolName,
                arguments: (part as any).input ?? '',
                status: 'completed',
              };
            }
            break;
          }
          case 'response-metadata': {
            if ((part as any).id) {
              responseId = (part as any).id;
            }
            break;
          }
          case 'finish': {
            usagePromptTokens = Number.isNaN((part as any).usage?.inputTokens)
              ? 0
              : ((part as any).usage?.inputTokens ?? 0);
            usageCompletionTokens = Number.isNaN(
              (part as any).usage?.outputTokens,
            )
              ? 0
              : ((part as any).usage?.outputTokens ?? 0);
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
        this.#logger.debug(
          'Response (streamed):',
          JSON.stringify(finalEvent.response, null, 2),
        );
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
 * Wraps a model from the AI SDK that adheres to the LanguageModelV2 spec to be used used as a model
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
export function aisdk(model: LanguageModelV2) {
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

export function toolChoiceToLanguageV2Format(
  toolChoice: ModelSettingsToolChoice | undefined,
): LanguageModelV2ToolChoice | undefined {
  if (!toolChoice) {
    return undefined;
  }
  switch (toolChoice) {
    case 'auto':
      return { type: 'auto' };
    case 'required':
      return { type: 'required' };
    case 'none':
      return { type: 'none' };
    default:
      return { type: 'tool', toolName: toolChoice };
  }
}
