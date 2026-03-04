import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionContentPartInputAudio,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from 'openai/resources/chat';
import {
  SerializedHandoff,
  SerializedTool,
  ModelRequest,
  protocol,
  UserError,
} from '@openai/agents-core';
import { getProviderDataWithoutReservedKeys } from './utils/providerData';

const CHAT_COMPLETIONS_FUNCTION_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function convertToolChoice(
  toolChoice: 'auto' | 'required' | 'none' | (string & {}) | undefined | null,
): ChatCompletionToolChoiceOption | undefined {
  if (toolChoice == undefined || toolChoice == null) return undefined;
  if (toolChoice === 'auto') return 'auto';
  if (toolChoice === 'required') return 'required';
  if (toolChoice === 'none') return 'none';
  return {
    type: 'function',
    function: { name: toolChoice },
  };
}

export function getCompatibleToolChoice(
  toolChoice: 'auto' | 'required' | 'none' | (string & {}) | undefined | null,
  tools: ChatCompletionTool[],
): ChatCompletionToolChoiceOption | undefined {
  const converted = convertToolChoice(toolChoice);
  if (converted == undefined || converted === 'auto' || converted === 'none') {
    return converted;
  }

  if (converted === 'required') {
    if (tools.length === 0) {
      throw new UserError(
        'modelSettings.toolChoice="required" requires at least one available tool in Chat Completions mode.',
      );
    }
    return converted;
  }

  if (typeof converted !== 'object' || !('function' in converted)) {
    return converted;
  }

  const availableToolNames = new Set(
    tools
      .map((tool) =>
        tool.type === 'function' && 'function' in tool
          ? tool.function.name
          : undefined,
      )
      .filter((name): name is string => typeof name === 'string'),
  );
  if (!availableToolNames.has(converted.function.name)) {
    throw new UserError(
      `modelSettings.toolChoice="${converted.function.name}" does not match any available tool or handoff in Chat Completions mode.`,
    );
  }

  return converted;
}

export function extractAllAssistantContent(
  content: protocol.AssistantMessageItem['content'],
): string | ChatCompletionAssistantMessageParam['content'] {
  if (typeof content === 'string') {
    return content;
  }
  const out: ChatCompletionAssistantMessageParam['content'] = [];
  for (const c of content) {
    if (c.type === 'output_text') {
      out.push({
        type: 'text',
        text: c.text,
        ...getProviderDataWithoutReservedKeys(c.providerData, ['type', 'text']),
      });
    } else if (c.type === 'refusal') {
      out.push({
        type: 'refusal',
        refusal: c.refusal,
        ...getProviderDataWithoutReservedKeys(c.providerData, [
          'type',
          'refusal',
        ]),
      });
    } else if (c.type === 'audio' || c.type === 'image') {
      // ignoring audio as it is handled on the assistant message level
      continue;
    } else {
      const exhaustive = c satisfies never; // ensures that the type is exhaustive
      throw new Error(`Unknown content: ${JSON.stringify(exhaustive)}`);
    }
  }
  return out;
}

export function extractAllUserContent(
  content: protocol.UserMessageItem['content'],
): string | ChatCompletionContentPart[] {
  if (typeof content === 'string') {
    return content;
  }

  const out: ChatCompletionContentPart[] = [];
  for (const c of content) {
    if (c.type === 'input_text') {
      out.push({
        type: 'text',
        text: c.text,
        ...getProviderDataWithoutReservedKeys(c.providerData, ['type', 'text']),
      });
    } else if (c.type === 'input_image') {
      // The Chat Completions API only accepts image URLs. If we see a file reference we reject it
      // early so callers get an actionable error instead of a cryptic API response.
      const imageSource =
        typeof c.image === 'string'
          ? c.image
          : typeof (c as any).imageUrl === 'string'
            ? (c as any).imageUrl
            : undefined;

      if (!imageSource) {
        throw new Error(
          `Only image URLs are supported for input_image: ${JSON.stringify(c)}`,
        );
      }
      const rest = getProviderDataWithoutReservedKeys(c.providerData, [
        'type',
        'image_url',
      ]);
      const imageUrl = getProviderDataWithoutReservedKeys(
        c.providerData?.image_url,
        ['url'],
      );
      out.push({
        type: 'image_url',
        image_url: {
          url: imageSource,
          ...imageUrl,
        },
        ...rest,
      });
    } else if (c.type === 'input_file') {
      // Chat Completions API supports file inputs via the "file" content part type.
      // See: https://platform.openai.com/docs/guides/pdf-files?api-mode=chat
      const file: ChatCompletionContentPart.File['file'] = {};

      if (typeof c.file === 'string') {
        const value = c.file.trim();
        if (value.startsWith('data:')) {
          file.file_data = value;
        } else {
          throw new UserError(
            `Chat Completions only supports data URLs for file input. If you're trying to pass an uploaded file's ID, use an object with the id property instead: ${JSON.stringify(c)}`,
          );
        }
      } else if (c.file && typeof c.file === 'object' && 'id' in c.file) {
        file.file_id = (c.file as { id: string }).id;
      } else {
        throw new UserError(
          `File input requires a data URL or file ID: ${JSON.stringify(c)}`,
        );
      }

      // Handle filename from the content item or providerData
      if (c.filename) {
        file.filename = c.filename;
      } else if (c.providerData?.filename) {
        file.filename = c.providerData.filename;
      }

      const rest = getProviderDataWithoutReservedKeys(c.providerData, [
        'type',
        'file',
        'filename',
      ]);
      out.push({
        type: 'file',
        file,
        ...rest,
      });
    } else if (c.type === 'audio') {
      if (typeof c.audio !== 'string') {
        throw new UserError(
          `Chat Completions only supports inline audio data for input_audio: ${JSON.stringify(c)}`,
        );
      }
      const inputAudioFormat =
        c.format === 'wav' || c.format === 'mp3'
          ? c.format
          : c.providerData?.input_audio?.format === 'wav' ||
              c.providerData?.input_audio?.format === 'mp3'
            ? c.providerData.input_audio.format
            : undefined;
      if (!inputAudioFormat) {
        throw new UserError(
          `Chat Completions input_audio requires format "wav" or "mp3": ${JSON.stringify(c)}`,
        );
      }
      const rest = getProviderDataWithoutReservedKeys(c.providerData, [
        'type',
        'input_audio',
      ]);
      const inputAudio = getProviderDataWithoutReservedKeys(
        c.providerData?.input_audio,
        ['data', 'format'],
      );
      out.push({
        type: 'input_audio',
        input_audio: {
          data: c.audio,
          format: inputAudioFormat,
          ...inputAudio,
        } as ChatCompletionContentPartInputAudio['input_audio'],
        ...rest,
      });
    } else {
      const exhaustive = c satisfies never; // ensures that the type is exhaustive
      throw new Error(`Unknown content: ${JSON.stringify(exhaustive)}`);
    }
  }
  return out;
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

export function itemsToMessages(
  items: ModelRequest['input'],
): ChatCompletionMessageParam[] {
  if (typeof items === 'string') {
    return [{ role: 'user', content: items }];
  }
  const result: ChatCompletionMessageParam[] = [];
  let currentAssistantMsg: ChatCompletionAssistantMessageParam | null = null;
  const flushAssistantMessage = () => {
    if (currentAssistantMsg) {
      if (
        !currentAssistantMsg.tool_calls ||
        currentAssistantMsg.tool_calls.length === 0
      ) {
        delete currentAssistantMsg.tool_calls;
      }
      result.push(currentAssistantMsg);
      currentAssistantMsg = null;
    }
  };
  const ensureAssistantMessage = () => {
    if (!currentAssistantMsg) {
      currentAssistantMsg = {
        role: 'assistant',
        content: null,
        tool_calls: [],
      };
    }
    return currentAssistantMsg;
  };
  for (const item of items) {
    if (isMessageItem(item)) {
      const { content, role, providerData } = item;
      flushAssistantMessage();
      if (role === 'assistant') {
        const assistant: ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: extractAllAssistantContent(content),
          ...getProviderDataWithoutReservedKeys(providerData, [
            'role',
            'content',
            'tool_calls',
            'audio',
          ]),
        };

        if (Array.isArray(content)) {
          const audio = content.find((c) => c.type === 'audio');
          if (audio) {
            assistant.audio = {
              id: '', // setting this to empty ID and expecting that the user sets providerData.id
              ...audio.providerData,
            };
          }
        }

        result.push(assistant);
      } else if (role === 'user') {
        result.push({
          role,
          content: extractAllUserContent(content),
          ...getProviderDataWithoutReservedKeys(providerData, [
            'role',
            'content',
          ]),
        });
      } else if (role === 'system') {
        result.push({
          role: 'system',
          content: content,
          ...getProviderDataWithoutReservedKeys(providerData, [
            'role',
            'content',
          ]),
        });
      }
    } else if (item.type === 'reasoning') {
      const asst = ensureAssistantMessage();
      // @ts-expect-error - reasoning is not supported in the official Chat Completion API spec
      // this is handling third party providers that support reasoning
      asst.reasoning = item.rawContent?.[0]?.text;
      continue;
    } else if (item.type === 'hosted_tool_call') {
      if (item.name === 'file_search_call') {
        const asst = ensureAssistantMessage();
        const toolCalls = asst.tool_calls ?? [];
        const fileSearch = item;
        const { function: functionData, ...rest } =
          fileSearch.providerData ?? {};
        const { arguments: argumentData, ...remainingFunctionData } =
          functionData ?? {};

        toolCalls.push({
          id: fileSearch.id || '',
          type: 'function',
          function: {
            name: 'file_search_call',
            arguments: JSON.stringify({
              queries: fileSearch.providerData?.queries ?? [],
              status: fileSearch.status,
              ...getProviderDataWithoutReservedKeys(argumentData, [
                'queries',
                'status',
              ]),
            }),
            ...getProviderDataWithoutReservedKeys(remainingFunctionData, [
              'name',
              'arguments',
            ]),
          },
          ...getProviderDataWithoutReservedKeys(rest, [
            'id',
            'type',
            'function',
          ]),
        });
        asst.tool_calls = toolCalls;
        continue;
      } else {
        throw new UserError(
          'Hosted tool calls are not supported for chat completions. Got item: ' +
            JSON.stringify(item),
        );
      }
    } else if (
      item.type === 'computer_call' ||
      item.type === 'computer_call_result' ||
      item.type === 'shell_call' ||
      item.type === 'shell_call_output' ||
      item.type === 'apply_patch_call' ||
      item.type === 'apply_patch_call_output'
    ) {
      throw new UserError(
        'Computer use calls are not supported for chat completions. Got item: ' +
          JSON.stringify(item),
      );
    } else if (
      item.type === 'tool_search_call' ||
      item.type === 'tool_search_output'
    ) {
      throw new UserError(
        'Tool search items are not supported for chat completions. Please use the Responses API when replaying tool search history.',
      );
    } else if (item.type === 'function_call') {
      const hasQualifiedOrInvalidName =
        typeof item.name === 'string' &&
        !CHAT_COMPLETIONS_FUNCTION_NAME_PATTERN.test(item.name);
      if (
        hasQualifiedOrInvalidName ||
        (typeof item.namespace === 'string' && item.namespace.trim().length > 0)
      ) {
        throw new UserError(
          'Namespaced function call history is not supported for chat completions. Please use the Responses API when replaying namespaced tool calls.',
        );
      }
      const asst = ensureAssistantMessage();
      const toolCalls = asst.tool_calls ?? [];
      const funcCall = item;
      const toolCallProviderData = getProviderDataWithoutReservedKeys(
        funcCall.providerData,
        ['id', 'type', 'function', 'role', 'content', 'tool_calls', 'audio'],
      );
      const functionProviderData = getProviderDataWithoutReservedKeys(
        funcCall.providerData?.function,
        ['name', 'arguments'],
      );
      toolCalls.push({
        id: funcCall.callId,
        type: 'function',
        function: {
          name: funcCall.name,
          arguments: funcCall.arguments ?? '{}',
          ...functionProviderData,
        },
        ...toolCallProviderData,
      });
      asst.tool_calls = toolCalls;
      Object.assign(
        asst,
        getProviderDataWithoutReservedKeys(funcCall.providerData, [
          'role',
          'content',
          'tool_calls',
          'audio',
          'id',
          'type',
          'function',
        ]),
      );
    } else if (item.type === 'function_call_result') {
      flushAssistantMessage();
      const funcOutput = item;
      const toolContent = normalizeFunctionCallOutputForChat(funcOutput.output);

      result.push({
        role: 'tool',
        tool_call_id: funcOutput.callId,
        content: toolContent,
        ...getProviderDataWithoutReservedKeys(funcOutput.providerData, [
          'role',
          'tool_call_id',
          'content',
        ]),
      });
    } else if (item.type === 'unknown') {
      result.push({
        ...item.providerData,
      } as any);
    } else if (item.type === 'compaction') {
      throw new UserError(
        'Compaction items are not supported for chat completions. Please use the Responses API when working with compaction.',
      );
    } else {
      const exhaustive = item satisfies never; // ensures that the type is exhaustive
      throw new Error(`Unknown item type: ${JSON.stringify(exhaustive)}`);
    }
  }
  flushAssistantMessage();
  return result;
}

function normalizeFunctionCallOutputForChat(
  output: protocol.FunctionCallResultItem['output'],
): string {
  if (typeof output === 'string') {
    return output;
  }

  if (Array.isArray(output)) {
    const textOnly = output.every((item) => item.type === 'input_text');
    if (!textOnly) {
      throw new UserError(
        'Only text tool outputs are supported for chat completions.',
      );
    }
    return output.map((item) => item.text).join('');
  }

  if (
    isRecord(output) &&
    output.type === 'text' &&
    typeof output.text === 'string'
  ) {
    return output.text;
  }

  throw new UserError(
    'Only text tool outputs are supported for chat completions. Got item: ' +
      JSON.stringify(output),
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

export function toolToOpenAI(tool: SerializedTool): ChatCompletionTool {
  if (tool.type === 'function') {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters,
        strict: tool.strict,
      },
    };
  }
  throw new Error(
    `Hosted tools are not supported with the ChatCompletions API. Got tool type: ${
      tool.type
    }, tool: ${JSON.stringify(tool)}`,
  );
}

export function convertHandoffTool(
  handoff: SerializedHandoff,
): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: handoff.toolName,
      description: handoff.toolDescription || '',
      parameters: handoff.inputJsonSchema,
    },
  };
}
