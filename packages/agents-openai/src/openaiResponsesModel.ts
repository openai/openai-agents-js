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
import { z } from 'zod';
import { HEADERS } from './defaults';
import {
  CodeInterpreterStatus,
  FileSearchStatus,
  ImageGenerationStatus,
  WebSearchStatus,
} from './tools';
import { camelOrSnakeToSnakeCase } from './utils/providerData';
import { ProviderData } from '@openai/agents-core/types';

type ToolChoice =
  | ToolChoiceOptions
  | ToolChoiceTypes
  // TOOD: remove this once the underlying ToolChoiceTypes include this
  | { type: 'web_search' }
  | ToolChoiceFunction;

const HostedToolChoice = z.enum([
  'file_search',
  'web_search',
  'web_search_preview',
  'computer_use_preview',
  'code_interpreter',
  'image_generation',
  'mcp',
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
  otherProperties: Record<string, any> | undefined,
): OpenAI.Responses.ResponseTextConfig | undefined {
  if (outputType === 'text') {
    return otherProperties;
  }

  return {
    ...otherProperties,
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
          type: 'web_search',
          user_location: tool.providerData.user_location,
          filters: tool.providerData.filters,
          search_context_size: tool.providerData.search_context_size,
        },
        include: undefined,
      };
    } else if (tool.providerData?.type === 'web_search_preview') {
      return {
        tool: {
          type: 'web_search_preview',
          user_location: tool.providerData.user_location,
          search_context_size: tool.providerData.search_context_size,
        },
        include: undefined,
      };
    } else if (tool.providerData?.type === 'file_search') {
      return {
        tool: {
          type: 'file_search',
          vector_store_ids:
            tool.providerData.vector_store_ids ||
            // for backwards compatibility
            (typeof tool.providerData.vector_store_id === 'string'
              ? [tool.providerData.vector_store_id]
              : tool.providerData.vector_store_id),
          max_num_results: tool.providerData.max_num_results,
          ranking_options: tool.providerData.ranking_options,
          filters: tool.providerData.filters,
        },
        include: tool.providerData.include_search_results
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
          input_fidelity: tool.providerData.input_fidelity,
          input_image_mask: tool.providerData.input_image_mask,
          model: tool.providerData.model,
          moderation: tool.providerData.moderation,
          output_compression: tool.providerData.output_compression,
          output_format: tool.providerData.output_format,
          partial_images: tool.providerData.partial_images,
          quality: tool.providerData.quality,
          size: tool.providerData.size,
        },
        include: undefined,
      };
    } else if (tool.providerData?.type === 'mcp') {
      return {
        tool: {
          type: 'mcp',
          server_label: tool.providerData.server_label,
          server_url: tool.providerData.server_url,
          connector_id: tool.providerData.connector_id,
          authorization: tool.providerData.authorization,
          allowed_tools: tool.providerData.allowed_tools,
          headers: tool.providerData.headers,
          require_approval: convertMCPRequireApproval(
            tool.providerData.require_approval,
          ),
        },
        include: undefined,
      };
    } else if (tool.providerData) {
      return {
        tool: tool.providerData as unknown as OpenAI.Responses.Tool,
        include: undefined,
      };
    }
  }

  throw new Error(`Unsupported tool type: ${JSON.stringify(tool)}`);
}

function convertMCPRequireApproval(
  requireApproval: ProviderData.HostedMCPTool['require_approval'],
): OpenAI.Responses.Tool.Mcp.McpToolApprovalFilter | 'always' | 'never' | null {
  if (requireApproval === 'never' || requireApproval === undefined) {
    return 'never';
  }

  if (requireApproval === 'always') {
    return 'always';
  }

  return {
    never: { tool_names: requireApproval.never?.tool_names },
    always: { tool_names: requireApproval.always?.tool_names },
  };
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
      ...camelOrSnakeToSnakeCase(entry.providerData),
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
      ...camelOrSnakeToSnakeCase(entry.providerData),
    };
  } else if (entry.type === 'input_file') {
    const fileEntry: OpenAI.Responses.ResponseInputFile = {
      type: 'input_file',
    };
    if (typeof entry.file === 'string') {
      if (entry.file.startsWith('data:')) {
        fileEntry.file_data = entry.file;
      } else if (entry.file.startsWith('https://')) {
        fileEntry.file_url = entry.file;
      } else {
        throw new UserError(
          `Unsupported string data for file input. If you're trying to pass an uploaded file's ID, use an object with the ID property instead.`,
        );
      }
    } else if ('id' in entry.file) {
      fileEntry.file_id = entry.file.id;
    } else if ('url' in entry.file) {
      fileEntry.file_url = entry.file.url;
    }
    return {
      ...fileEntry,
      ...camelOrSnakeToSnakeCase(entry.providerData),
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
      ...camelOrSnakeToSnakeCase(entry.providerData),
    };
  }

  if (entry.type === 'refusal') {
    return {
      type: 'refusal',
      refusal: entry.refusal,
      ...camelOrSnakeToSnakeCase(entry.providerData),
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
      ...camelOrSnakeToSnakeCase(item.providerData),
    };
  }

  if (item.role === 'user') {
    if (typeof item.content === 'string') {
      return {
        id: item.id,
        role: 'user',
        content: item.content,
        ...camelOrSnakeToSnakeCase(item.providerData),
      };
    }

    return {
      id: item.id,
      role: 'user',
      content: item.content.map(getInputMessageContent),
      ...camelOrSnakeToSnakeCase(item.providerData),
    };
  }

  if (item.role === 'assistant') {
    const assistantMessage: OpenAI.Responses.ResponseOutputMessage = {
      type: 'message',
      id: item.id!,
      role: 'assistant',
      content: item.content.map(getOutputMessageContent),
      status: item.status,
      ...camelOrSnakeToSnakeCase(item.providerData),
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

function getPrompt(prompt: ModelRequest['prompt']):
  | {
      id: string;
      version?: string;
      variables?: Record<string, any>;
    }
  | undefined {
  if (!prompt) {
    return undefined;
  }

  const transformedVariables: Record<string, any> = {};

  for (const [key, value] of Object.entries(prompt.variables ?? {})) {
    if (typeof value === 'string') {
      transformedVariables[key] = value;
    } else if (typeof value === 'object') {
      transformedVariables[key] = getInputMessageContent(value);
    }
  }

  return {
    id: prompt.promptId,
    version: prompt.version,
    variables: transformedVariables,
  };
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
        ...camelOrSnakeToSnakeCase(item.providerData),
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
        status: item.status,
        ...camelOrSnakeToSnakeCase(item.providerData),
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
          ...camelOrSnakeToSnakeCase(content.providerData),
        })),
        encrypted_content: item.providerData?.encryptedContent,
        ...camelOrSnakeToSnakeCase(item.providerData),
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
        ...camelOrSnakeToSnakeCase(item.providerData),
      };

      return entry;
    }

    if (item.type === 'computer_call_result') {
      const entry: OpenAI.Responses.ResponseInputItem.ComputerCallOutput = {
        type: 'computer_call_output',
        id: item.id,
        call_id: item.callId,
        output: buildResponseOutput(item),
        status: item.providerData?.status,
        acknowledged_safety_checks: item.providerData?.acknowledgedSafetyChecks,
        ...camelOrSnakeToSnakeCase(item.providerData),
      };
      return entry;
    }

    if (item.type === 'hosted_tool_call') {
      if (
        item.providerData?.type === 'web_search_call' ||
        item.providerData?.type === 'web_search' // for backward compatibility
      ) {
        const entry: OpenAI.Responses.ResponseFunctionWebSearch = {
          ...camelOrSnakeToSnakeCase(item.providerData), // place here to prioritize the below fields
          type: 'web_search_call',
          id: item.id!,
          status: WebSearchStatus.parse(item.status ?? 'failed'),
        };

        return entry;
      }

      if (
        item.providerData?.type === 'file_search_call' ||
        item.providerData?.type === 'file_search' // for backward compatibility
      ) {
        const entry: OpenAI.Responses.ResponseFileSearchToolCall = {
          ...camelOrSnakeToSnakeCase(item.providerData), // place here to prioritize the below fields
          type: 'file_search_call',
          id: item.id!,
          status: FileSearchStatus.parse(item.status ?? 'failed'),
          queries: item.providerData?.queries ?? [],
          results: item.providerData?.results,
        };

        return entry;
      }

      if (
        item.providerData?.type === 'code_interpreter_call' ||
        item.providerData?.type === 'code_interpreter' // for backward compatibility
      ) {
        const entry: OpenAI.Responses.ResponseCodeInterpreterToolCall = {
          ...camelOrSnakeToSnakeCase(item.providerData), // place here to prioritize the below fields
          type: 'code_interpreter_call',
          id: item.id!,
          code: item.providerData?.code ?? '',
          // This property used to be results, so keeping both for backward compatibility
          // That said, this property cannot be passed from a user, so it's just API's internal data.
          outputs:
            item.providerData?.outputs ?? item.providerData?.results ?? [],
          status: CodeInterpreterStatus.parse(item.status ?? 'failed'),
          container_id: item.providerData?.container_id,
        };

        return entry;
      }

      if (
        item.providerData?.type === 'image_generation_call' ||
        item.providerData?.type === 'image_generation' // for backward compatibility
      ) {
        const entry: OpenAI.Responses.ResponseInputItem.ImageGenerationCall = {
          ...camelOrSnakeToSnakeCase(item.providerData), // place here to prioritize the below fields
          type: 'image_generation_call',
          id: item.id!,
          result: item.providerData?.result ?? null,
          status: ImageGenerationStatus.parse(item.status ?? 'failed'),
        };

        return entry;
      }

      if (
        item.providerData?.type === 'mcp_list_tools' ||
        item.name === 'mcp_list_tools'
      ) {
        const providerData =
          item.providerData as ProviderData.HostedMCPListTools;
        const entry: OpenAI.Responses.ResponseInputItem.McpListTools = {
          ...camelOrSnakeToSnakeCase(item.providerData),
          type: 'mcp_list_tools',
          id: item.id!,
          tools: camelOrSnakeToSnakeCase(providerData.tools) as any,
          server_label: providerData.server_label,
          error: providerData.error,
        };
        return entry;
      } else if (
        item.providerData?.type === 'mcp_approval_request' ||
        item.name === 'mcp_approval_request'
      ) {
        const providerData =
          item.providerData as ProviderData.HostedMCPApprovalRequest;
        const entry: OpenAI.Responses.ResponseInputItem.McpApprovalRequest = {
          ...camelOrSnakeToSnakeCase(item.providerData), // place here to prioritize the below fields
          type: 'mcp_approval_request',
          id: providerData.id ?? item.id!,
          name: providerData.name,
          arguments: providerData.arguments,
          server_label: providerData.server_label,
        };
        return entry;
      } else if (
        item.providerData?.type === 'mcp_approval_response' ||
        item.name === 'mcp_approval_response'
      ) {
        const providerData =
          item.providerData as ProviderData.HostedMCPApprovalResponse;
        const entry: OpenAI.Responses.ResponseInputItem.McpApprovalResponse = {
          ...camelOrSnakeToSnakeCase(providerData),
          type: 'mcp_approval_response',
          id: providerData.id,
          approve: providerData.approve,
          approval_request_id: providerData.approval_request_id,
          reason: providerData.reason,
        };
        return entry;
      } else if (
        item.providerData?.type === 'mcp_call' ||
        item.name === 'mcp_call'
      ) {
        const providerData = item.providerData as ProviderData.HostedMCPCall;
        const entry: OpenAI.Responses.ResponseInputItem.McpCall = {
          // output, which can be a large text string, is optional here, so we don't include it
          // output: item.output,
          ...camelOrSnakeToSnakeCase(providerData), // place here to prioritize the below fields
          type: 'mcp_call',
          id: providerData.id ?? item.id!,
          name: providerData.name,
          arguments: providerData.arguments,
          server_label: providerData.server_label,
          error: providerData.error,
        };
        return entry;
      }

      throw new UserError(
        `Unsupported built-in tool call type: ${JSON.stringify(item)}`,
      );
    }

    if (item.type === 'unknown') {
      return {
        ...camelOrSnakeToSnakeCase(item.providerData), // place here to prioritize the below fields
        id: item.id,
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
      text,
      ...remainingItem,
    };
  }

  if (item.type === 'refusal') {
    const { type, refusal, ...remainingItem } = item;
    return {
      type,
      refusal,
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
      const { id, type, role, content, status, ...providerData } = item;
      return {
        id,
        type,
        role,
        content: content.map(convertToMessageContentItem),
        status,
        providerData,
      };
    } else if (
      item.type === 'file_search_call' ||
      item.type === 'web_search_call' ||
      item.type === 'image_generation_call' ||
      item.type === 'code_interpreter_call'
    ) {
      const { status, ...remainingItem } = item;
      let outputData = undefined;
      if ('result' in remainingItem && remainingItem.result !== null) {
        // type: "image_generation_call"
        outputData = remainingItem.result;
        delete (remainingItem as any).result;
      }
      const output: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id: item.id!,
        name: item.type,
        status,
        output: outputData,
        providerData: remainingItem,
      };
      return output;
    } else if (item.type === 'function_call') {
      const { call_id, name, status, arguments: args, ...providerData } = item;
      const output: protocol.FunctionCallItem = {
        type: 'function_call',
        id: item.id!,
        callId: call_id,
        name,
        status,
        arguments: args,
        providerData,
      };
      return output;
    } else if (item.type === 'computer_call') {
      const { call_id, status, action, ...providerData } = item;
      const output: protocol.ComputerUseCallItem = {
        type: 'computer_call',
        id: item.id!,
        callId: call_id,
        status,
        action,
        providerData,
      };
      return output;
    } else if (item.type === 'mcp_list_tools') {
      const { ...providerData } = item;
      const output: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id: item.id!,
        name: item.type,
        status: 'completed',
        output: undefined,
        providerData,
      };
      return output;
    } else if (item.type === 'mcp_approval_request') {
      const { ...providerData } = item;
      const output: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id: item.id!,
        name: 'mcp_approval_request',
        status: 'completed',
        output: undefined,
        providerData,
      };
      return output;
    } else if (item.type === 'mcp_call') {
      // Avoiding to duplicate potentially large output data
      const { output: outputData, ...providerData } = item;
      const output: protocol.HostedToolCallItem = {
        type: 'hosted_tool_call',
        id: item.id!,
        name: item.type,
        status: 'completed',
        output: outputData || undefined,
        providerData,
      };
      return output;
    } else if (item.type === 'reasoning') {
      // Avoiding to duplicate potentially large summary data
      const { summary, ...providerData } = item;
      const output: protocol.ReasoningItem = {
        type: 'reasoning',
        id: item.id!,
        content: summary.map((content) => {
          // Avoiding to duplicate potentially large text
          const { text, ...remainingContent } = content;
          return {
            type: 'input_text',
            text,
            providerData: remainingContent,
          };
        }),
        providerData,
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
    const { text, ...restOfProviderData } =
      request.modelSettings.providerData ?? {};
    if (request.modelSettings.reasoning) {
      // Merge top-level reasoning settings with provider data
      restOfProviderData.reasoning = {
        ...request.modelSettings.reasoning,
        ...restOfProviderData.reasoning,
      };
    }
    let mergedText = text;
    if (request.modelSettings.text) {
      // Merge top-level text settings with provider data
      mergedText = { ...request.modelSettings.text, ...text };
    }
    const responseFormat = getResponseFormat(request.outputType, mergedText);

    const prompt = getPrompt(request.prompt);

    let parallelToolCalls: boolean | undefined = undefined;
    if (typeof request.modelSettings.parallelToolCalls === 'boolean') {
      if (request.modelSettings.parallelToolCalls && tools.length === 0) {
        throw new Error('Parallel tool calls are not supported without tools');
      }

      parallelToolCalls = request.modelSettings.parallelToolCalls;
    }

    const requestData = {
      model: this.#model,
      instructions: normalizeInstructions(request.systemInstructions),
      input,
      include,
      tools,
      previous_response_id: request.previousResponseId,
      conversation: request.conversationId,
      prompt,
      temperature: request.modelSettings.temperature,
      top_p: request.modelSettings.topP,
      truncation: request.modelSettings.truncation,
      max_output_tokens: request.modelSettings.maxTokens,
      tool_choice: toolChoice as ToolChoiceOptions,
      parallel_tool_calls: parallelToolCalls,
      stream,
      text: responseFormat,
      store: request.modelSettings.store,
      ...restOfProviderData,
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
        span.spanData._input = request.input;
        span.spanData._response = response;
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
      providerData: response,
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

      if (request.tracing && span && finalResponse) {
        span.spanData.response_id = finalResponse.id;
        span.spanData._response = finalResponse;
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

/**
 * Sending an empty string for instructions can override the prompt parameter.
 * Thus, this method checks if the instructions is an empty string and returns undefined if it is.
 * @param instructions - The instructions to normalize.
 * @returns The normalized instructions.
 */
function normalizeInstructions(
  instructions: string | undefined,
): string | undefined {
  if (typeof instructions === 'string') {
    if (instructions.trim() === '') {
      return undefined;
    }
    return instructions;
  }
  return undefined;
}
