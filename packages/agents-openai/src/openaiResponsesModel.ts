import {
  Model,
  Usage,
  withResponseSpan,
  createResponseSpan,
  setCurrentSpan,
  resetCurrentSpan,
  protocol,
  UserError,
} from '@openai/agents-core';
import type {
  SerializedHandoff,
  SerializedTool,
  ModelRequest,
  ModelResponse,
  ModelSettingsToolChoice,
  ResponseStreamEvent,
  SerializedOutputType,
} from '@openai/agents-core';
import OpenAI from 'openai';
import type { Stream } from 'openai/streaming';
import logger from './logger';
import {
  ToolChoiceFunction,
  ToolChoiceOptions,
  ToolChoiceTypes,
} from 'openai/resources/responses/responses';
import { z } from '@openai/zod/v3';
import { HEADERS } from './defaults';
import {
  CodeInterpreterStatus,
  FileSearchStatus,
  ImageGenerationStatus,
  WebSearchStatus,
} from './tools';

type ToolChoice = ToolChoiceOptions | ToolChoiceTypes | ToolChoiceFunction;

const HostedToolChoice = z.enum([
  'file_search',
  'web_search_preview',
  'computer_use_preview',
]);

const DefaultToolChoice = z.enum(['auto', 'required', 'none']);

function getToolChoice(
  toolChoice?: ModelSettingsToolChoice,
): ToolChoice | undefined {
  if (typeof toolChoice === 'undefined') {
    return undefined;
  }

  const resultDefaultCheck = DefaultToolChoice.safeParse(toolChoice);
  if (resultDefaultCheck.success) {
    return resultDefaultCheck.data;
  }

  const result = HostedToolChoice.safeParse(toolChoice);
  if (result.success) {
    return { type: result.data };
  }

  return { type: 'function', name: toolChoice };
}

function getResponseFormat(
  outputType: SerializedOutputType,
): OpenAI.Responses.ResponseTextConfig | undefined {
  if (outputType === 'text') {
    return undefined;
  }

  return {
    format: outputType,
  };
}

function getTools<_TContext = unknown>(
  tools: SerializedTool[],
  handoffs: SerializedHandoff[],
): {
  tools: OpenAI.Responses.Tool[];
  include: OpenAI.Responses.ResponseIncludable[];
} {
  const openaiTools: OpenAI.Responses.Tool[] = [];
  const include: OpenAI.Responses.ResponseIncludable[] = [];
  for (const tool of tools) {
    const { tool: openaiTool, include: openaiIncludes } = converTool(tool);
    openaiTools.push(openaiTool);
    if (openaiIncludes && openaiIncludes.length > 0) {
      for (const item of openaiIncludes) {
        include.push(item);
      }
    }
  }

  return {
    tools: [...openaiTools, ...handoffs.map(getHandoffTool)],
    include,
  };
}

function converTool<_TContext = unknown>(
  tool: SerializedTool,
): {
  tool: OpenAI.Responses.Tool;
  include?: OpenAI.Responses.ResponseIncludable[];
} {
  if (tool.type === 'function') {
    return {
      tool: {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict,
      },
      include: undefined,
    };
  } else if (tool.type === 'computer') {
    return {
      tool: {
        type: 'computer_use_preview',
        environment: tool.environment,
        display_width: tool.dimensions[0],
        display_height: tool.dimensions[1],
      },
      include: undefined,
    };
  } else if (tool.type === 'hosted_tool') {
    if (tool.providerData?.type === 'web_search') {
      return {
        tool: {
          type: 'web_search_preview',
          user_location: tool.providerData.userLocation,
          search_context_size: tool.providerData.searchContextSize,
        },
        include: undefined,
      };
    } else if (tool.providerData?.type === 'file_search') {
      return {
        tool: {
          type: 'file_search',
          vector_store_ids: tool.providerData.vectorStoreId,
          max_num_results: tool.providerData.maxNumResults,
          ranking_options: tool.providerData.rankingOptions,
          filters: tool.providerData.filters,
        },
        include: tool.providerData.includeSearchResults
          ? ['file_search_call.results']
          : undefined,
      };
    } else if (tool.providerData?.type === 'code_interpreter') {
      return {
        tool: {
          type: 'code_interpreter',
          container: tool.providerData.container,
        },
        include: undefined,
      };
    } else if (tool.providerData?.type === 'image_generation') {
      return {
        tool: {
          type: 'image_generation',
          background: tool.providerData.background,
          input_image_mask: tool.providerData.inputImageMask,
          model: tool.providerData.model,
          moderation: tool.providerData.moderation,
          output_compression: tool.providerData.outputCompression,
          output_format: tool.providerData.outputFormat,
          partial_images: tool.providerData.partialImages,
          quality: tool.providerData.quality,
          size: tool.providerData.size,
        },
        include: undefined,
      };
    }
  }

  throw new Error(`Unsupported tool type: ${JSON.stringify(tool)}`);
}

function getHandoffTool(handoff: SerializedHandoff): OpenAI.Responses.Tool {
  return {
    name: handoff.toolName,
    description: handoff.toolDescription,
    parameters: handoff.inputJsonSchema,
    strict: handoff.strictJsonSchema,
    type: 'function',
  };
}

function getInputMessageContent(
  entry: protocol.UserContent,
): OpenAI.Responses.ResponseInputContent {
  if (entry.type === 'input_text') {
    return {
      type: 'input_text',
      text: entry.text,
      ...entry.providerData,
    };
  } else if (entry.type === 'input_image') {
    const imageEntry: OpenAI.Responses.ResponseInputImage = {
      type: 'input_image',
      detail: 'auto',
    };
    if (typeof entry.image === 'string') {
      imageEntry.image_url = entry.image;
    } else {
      imageEntry.file_id = entry.image.id;
    }
    return {
      ...imageEntry,
      ...entry.providerData,
    };
  } else if (entry.type === 'input_file') {
    const fileEntry: OpenAI.Responses.ResponseInputFile = {
      type: 'input_file',
    };
    if (typeof entry.file === 'string') {
      fileEntry.file_data = entry.file;
    } else {
      fileEntry.file_id = entry.file.id;
    }
    return {
      ...fileEntry,
      ...entry.providerData,
    };
  }

  throw new UserError(
    `Unsupported input content type: ${JSON.stringify(entry)}`,
  );
}

function getOutputMessageContent(
  entry: protocol.AssistantContent,
): OpenAI.Responses.ResponseOutputMessage['content'][number] {
  if (entry.type === 'output_text') {
    return {
      type: 'output_text',
      text: entry.text,
      annotations: [],
      ...entry.providerData,
    };
  }

  if (entry.type === 'refusal') {
    return {
      type: 'refusal',
      refusal: entry.refusal,
      ...entry.providerData,
    };
  }

  throw new UserError(
    `Unsupported output content type: ${JSON.stringify(entry)}`,
  );
}

function getMessageItem(
  item: protocol.MessageItem,
):
  | OpenAI.Responses.ResponseInputMessageItem
  | OpenAI.Responses.ResponseOutputMessage
  | OpenAI.Responses.EasyInputMessage {
  if (item.role === 'system') {
    return {
      id: item.id,
      role: 'system',
      content: item.content,
      ...item.providerData,
    };
  }

  if (item.role === 'user') {
    if (typeof item.content === 'string') {
      return {
        id: item.id,
        role: 'user',
        content: item.content,
        ...item.providerData,
      };
    }

    return {
      id: item.id,
      role: 'user',
      content: item.content.map(getInputMessageContent),
      ...item.providerData,
    };
  }

  if (item.role === 'assistant') {
    const assistantMessage: OpenAI.Responses.ResponseOutputMessage = {
      type: 'message',
      id: item.id!,
      role: 'assistant',
      content: item.content.map(getOutputMessageContent),
      status: item.status,
      ...item.providerData,
    };
    return assistantMessage;
  }

  throw new UserError(`Unsupported item ${JSON.stringify(item)}`);
}

function isMessageItem(item: protocol.ModelItem): item is protocol.MessageItem {
  if (item.type === 'message') {
    return true;
  }

  if (typeof item.type === 'undefined' && typeof item.role === 'string') {
    return true;
  }

  return false;
}

function getInputItems(
  input: ModelRequest['input'],
): OpenAI.Responses.ResponseInputItem[] {
  if (typeof input === 'string') {
    return [
      {
        role: 'user',
        content: input,
      },
    ];
  }

  return input.map((item) => {
    if (isMessageItem(item)) {
      return getMessageItem(item);
    }

    if (item.type === 'function_call') {
      const entry: OpenAI.Responses.ResponseFunctionToolCall = {
        id: item.id,
        type: 'function_call',
        name: item.name,
        call_id: item.callId,
        arguments: item.arguments,
        status: item.status,
        ...item.providerData,
      };

      return entry;
    }

    if (item.type === 'function_call_result') {
      if (item.output.type !== 'text') {
        throw new UserError(
          `Unsupported tool result type: ${JSON.stringify(item.output)}`,
        );
      }

      const entry: OpenAI.Responses.ResponseInputItem.FunctionCallOutput = {
        type: 'function_call_output',
        id: item.id,
        call_id: item.callId,
        output: item.output.text,
        ...item.providerData,
      };

      return entry;
    }

    if (item.type === 'reasoning') {
      const entry: OpenAI.Responses.ResponseReasoningItem = {
        id: item.id!,
        type: 'reasoning',
        summary: item.content.map((content) => ({
          type: 'summary_text',
          text: content.text,
          ...content.providerData,
        })),
        ...item.providerData,
      };
      return entry;
    }

    if (item.type === 'computer_call') {
      const entry: OpenAI.Responses.ResponseComputerToolCall = {
        type: 'computer_call',
        call_id: item.callId,
        id: item.id!,
        action: item.action,
        status: item.status,
        pending_safety_checks: [],
        ...item.providerData,
      };

      return entry;
    }

    if (item.type === 'computer_call_result') {
      const entry: OpenAI.Responses.ResponseInputItem.ComputerCallOutput = {
        type: 'computer_call_output',
        id: item.id,
        call_id: item.callId,
        output: buildResponseOutput(item),
        ...item.providerData,
      };
      return entry;
    }

    if (item.type === 'hosted_tool_call') {
      if (item.providerData?.type === 'web_search') {
        const entry: OpenAI.Responses.ResponseFunctionWebSearch = {
          type: 'web_search_call',
          id: item.id!,
          status: WebSearchStatus.parse(item.status ?? 'failed'),
          ...item.providerData,
        };

        return entry;
      }

      if (item.providerData?.type === 'file_search') {
        const entry: OpenAI.Responses.ResponseFileSearchToolCall = {
          type: 'file_search_call',
          id: item.id!,
          status: FileSearchStatus.parse(item.status ?? 'failed'),
          queries: item.providerData?.queries ?? [],
          ...item.providerData,
        };

        return entry;
      }

      if (item.providerData?.type === 'code_interpreter') {
        const entry: OpenAI.Responses.ResponseCodeInterpreterToolCall = {
          type: 'code_interpreter_call',
          id: item.id!,
          code: item.providerData?.code ?? '',
          results: item.providerData?.results ?? [],
          status: CodeInterpreterStatus.parse(item.status ?? 'failed'),
          ...item.providerData,
        };

        return entry;
      }

      if (item.providerData?.type === 'image_generation') {
        const entry: OpenAI.Responses.ResponseInputItem.ImageGenerationCall = {
          type: 'image_generation_call',
          id: item.id!,
          result: item.providerData?.result ?? null,
          status: ImageGenerationStatus.parse(item.status ?? 'failed'),
          ...item.providerData,
        };

        return entry;
      }

      throw new UserError(
        `Unsupported built-in tool call type: ${JSON.stringify(item)}`,
      );
    }

    if (item.type === 'unknown') {
      return {
        id: item.id,
        ...item.providerData,
      } as OpenAI.Responses.ResponseItem;
    }

    const exhaustive = item satisfies never;
    throw new UserError(`Unsupported item ${JSON.stringify(exhaustive)}`);
  });
}

// As of May 29, the output is always screenshot putput
function buildResponseOutput(
  item: protocol.ComputerCallResultItem,
): OpenAI.Responses.ResponseComputerToolCallOutputScreenshot {
  return {
    type: 'computer_screenshot',
    image_url: item.output.data,
  };
}

function convertToMessageContentItem(
  item: OpenAI.Responses.ResponseOutputMessage['content'][number],
): protocol.AssistantContent {
  if (item.type === 'output_text') {
    const { type, text, ...remainingItem } = item;
    return {
      type,
      text: text,
      ...remainingItem,
    };
  }

  if (item.type === 'refusal') {
    const { type, refusal, ...remainingItem } = item;
    return {
      type,
      refusal: refusal,
      ...remainingItem,
    };
  }

  throw new Error(`Unsupported message content type: ${JSON.stringify(item)}`);
}

function convertToOutputItem(
  items: OpenAI.Responses.ResponseOutputItem[],
): protocol.OutputModelItem[] {
  return items.map((item) => {
    if (item.type === 'message') {
      const { id, type, role, content, status, ...remainingItem } = item;
      return {
        type,
        id,
        role,
        content: content.map(convertToMessageContentItem),
        status,
        providerData: remainingItem,
      };
    } else if (
      item.type === 'file_search_call' ||
      item.type === 'web_search_call' ||
      item.type === 'image_generation_call' ||
      item.type === 'code_interpreter_call'
    ) {
      const { id, type, status, ...remainingItem } = item;
      const outputData =
        'result' in remainingItem && remainingItem.result !== null
          ? remainingItem.result // type: "image_generation_call"
          : undefined;
      const output: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id,
        name: type,
        status: status,
        output: outputData,
        providerData: remainingItem,
      };
      return output;
    } else if (item.type === 'function_call') {
      const {
        id,
        call_id,
        name,
        status,
        arguments: args,
        ...remainingItem
      } = item;
      const output: protocol.FunctionCallItem = {
        type: 'function_call',
        id: id,
        callId: call_id,
        name: name,
        status: status,
        arguments: args,
        providerData: remainingItem,
      };
      return output;
    } else if (item.type === 'computer_call') {
      const { id, call_id, status, action, ...remainingItem } = item;
      const output: protocol.ComputerUseCallItem = {
        type: 'computer_call',
        id: id,
        callId: call_id,
        status: status,
        action: action,
        providerData: remainingItem,
      };
      return output;
    } else if (item.type === 'reasoning') {
      const { id, summary, ...remainingItem } = item;
      const output: protocol.ReasoningItem = {
        type: 'reasoning',
        id: id,
        content: summary.map((content) => {
          const { text, ...remainingContent } = content;
          return {
            type: 'input_text',
            text: text,
            providerData: remainingContent,
          };
        }),
        providerData: remainingItem,
      };
      return output;
    }

    return {
      type: 'unknown',
      providerData: item,
    };
  });
}

export { getToolChoice, converTool, getInputItems, convertToOutputItem };

/**
 * Model implementation that uses OpenAI's Responses API to generate responses.
 */
export class OpenAIResponsesModel implements Model {
  #client: OpenAI;
  #model: string;
  constructor(client: OpenAI, model: string) {
    this.#client = client;
    this.#model = model;
  }

  /**
   * @internal
   */
  async #fetchResponse(
    request: ModelRequest,
    stream: true,
  ): Promise<Stream<OpenAI.Responses.ResponseStreamEvent>>;
  async #fetchResponse(
    request: ModelRequest,
    stream: false,
  ): Promise<OpenAI.Responses.Response>;
  async #fetchResponse(
    request: ModelRequest,
    stream: boolean,
  ): Promise<
    Stream<OpenAI.Responses.ResponseStreamEvent> | OpenAI.Responses.Response
  > {
    const input = getInputItems(request.input);
    const { tools, include } = getTools(request.tools, request.handoffs);
    const toolChoice = getToolChoice(request.modelSettings.toolChoice);
    const responseFormat = getResponseFormat(request.outputType);

    let parallelToolCalls: boolean | undefined = undefined;
    if (typeof request.modelSettings.parallelToolCalls === 'boolean') {
      if (request.modelSettings.parallelToolCalls && tools.length === 0) {
        throw new Error('Parallel tool calls are not supported without tools');
      }

      parallelToolCalls = request.modelSettings.parallelToolCalls;
    }

    const requestData = {
      instructions: request.systemInstructions,
      model: this.#model,
      input,
      include,
      tools,
      previous_response_id: request.previousResponseId,
      temperature: request.modelSettings.temperature,
      top_p: request.modelSettings.topP,
      truncation: request.modelSettings.truncation,
      max_output_tokens: request.modelSettings.maxTokens,
      tool_choice: toolChoice as ToolChoiceOptions,
      parallel_tool_calls: parallelToolCalls,
      stream,
      text: responseFormat,
      store: request.modelSettings.store,
      ...request.modelSettings.providerData,
    };

    if (logger.dontLogModelData) {
      logger.debug('Calling LLM');
    } else {
      logger.debug(
        `Calling LLM. Request data: ${JSON.stringify(requestData, null, 2)}`,
      );
    }

    const response = await this.#client.responses.create(requestData, {
      headers: HEADERS,
      signal: request.signal,
    });

    if (logger.dontLogModelData) {
      logger.debug('Response received');
    } else {
      logger.debug(`Response received: ${JSON.stringify(response, null, 2)}`);
    }

    return response;
  }

  /**
   * Get a response from the OpenAI model using the Responses API.
   * @param request - The request to send to the model.
   * @returns A promise that resolves to the response from the model.
   */
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const response = await withResponseSpan(async (span) => {
      const response = await this.#fetchResponse(request, false);

      if (request.tracing) {
        span.spanData.response_id = response.id;
        if (request.tracing === true) {
          span.spanData._input = request.input;
        }
      }

      return response;
    });

    const output: ModelResponse = {
      usage: new Usage({
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
        inputTokensDetails: { ...response.usage?.input_tokens_details },
        outputTokensDetails: { ...response.usage?.output_tokens_details },
      }),
      output: convertToOutputItem(response.output),
      responseId: response.id,
    };

    return output;
  }

  /**
   * Get a streamed response from the OpenAI model using the Responses API.
   * @param request - The request to send to the model.
   * @returns An async iterable of the response from the model.
   */
  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<ResponseStreamEvent> {
    const span = request.tracing ? createResponseSpan() : undefined;
    try {
      if (span) {
        span.start();
        setCurrentSpan(span);
        if (request.tracing === true) {
          span.spanData._input = request.input;
        }
      }
      const response = await this.#fetchResponse(request, true);

      let finalResponse: OpenAI.Responses.Response | undefined;
      for await (const event of response) {
        if (event.type === 'response.created') {
          yield {
            type: 'response_started',
            providerData: {
              ...event,
            },
          };
        } else if (event.type === 'response.completed') {
          finalResponse = event.response;
          const { response, ...remainingEvent } = event;
          const { output, usage, id, ...remainingResponse } = response;
          yield {
            type: 'response_done',
            response: {
              id: id,
              output: convertToOutputItem(output),
              usage: {
                inputTokens: usage?.input_tokens ?? 0,
                outputTokens: usage?.output_tokens ?? 0,
                totalTokens: usage?.total_tokens ?? 0,
                inputTokensDetails: {
                  ...usage?.input_tokens_details,
                },
                outputTokensDetails: {
                  ...usage?.output_tokens_details,
                },
              },
              providerData: remainingResponse,
            },
            providerData: remainingEvent,
          };
          yield {
            type: 'model',
            event: event,
          };
        } else if (event.type === 'response.output_text.delta') {
          const { delta, ...remainingEvent } = event;
          yield {
            type: 'output_text_delta',
            delta: delta,
            providerData: remainingEvent,
          };
        }

        yield {
          type: 'model',
          event: event,
        };
      }

      if (span && finalResponse && request.tracing) {
        span.spanData.response_id = finalResponse.id;
      }
    } catch (error) {
      if (span) {
        span.setError({
          message: 'Error streaming response',
          data: {
            error: request.tracing
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
