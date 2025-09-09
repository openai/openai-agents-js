import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
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

export function convertToolChoice(
  toolChoice: 'auto' | 'required' | 'none' | string | undefined | null,
): ChatCompletionToolChoiceOption | undefined {
  if (toolChoice == undefined || toolChoice == null) return undefined;
  if (
    toolChoice === 'auto' ||
    toolChoice === 'required' ||
    toolChoice === 'none'
  )
    return toolChoice;
  return {
    type: 'function',
    function: { name: toolChoice },
  };
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
        ...c.providerData,
      });
    } else if (c.type === 'refusal') {
      out.push({
        type: 'refusal',
        refusal: c.refusal,
        ...c.providerData,
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
      out.push({ type: 'text', text: c.text, ...c.providerData });
    } else if (c.type === 'input_image') {
      if (typeof c.image !== 'string') {
        throw new Error(
          `Only image URLs are supported for input_image: ${JSON.stringify(c)}`,
        );
      }
      const { image_url, ...rest } = c.providerData || {};
      out.push({
        type: 'image_url',
        image_url: {
          url: c.image,
          ...image_url,
        },
        ...rest,
      });
    } else if (c.type === 'input_file') {
      throw new Error(
        `File uploads are not supported for chat completions: ${JSON.stringify(
          c,
        )}`,
      );
    } else if (c.type === 'audio') {
      const { input_audio, ...rest } = c.providerData || {};
      out.push({
        type: 'input_audio',
        input_audio: {
          data: c.audio,
          ...input_audio,
        },
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
      currentAssistantMsg = { role: 'assistant', tool_calls: [] };
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
          ...providerData,
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
          ...providerData,
        });
      } else if (role === 'system') {
        result.push({
          role: 'system',
          content: content,
          ...providerData,
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
              ...argumentData,
            }),
            ...remainingFunctionData,
          },
          ...rest,
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
      item.type === 'computer_call_result'
    ) {
      throw new UserError(
        'Computer use calls are not supported for chat completions. Got item: ' +
          JSON.stringify(item),
      );
    } else if (item.type === 'function_call') {
      const asst = ensureAssistantMessage();
      const toolCalls = asst.tool_calls ?? [];
      const funcCall = item;
      toolCalls.push({
        id: funcCall.callId,
        type: 'function',
        function: {
          name: funcCall.name,
          arguments: funcCall.arguments ?? '{}',
        },
      });
      asst.tool_calls = toolCalls;
    } else if (item.type === 'function_call_result') {
      flushAssistantMessage();
      const funcOutput = item;
      if (funcOutput.output.type !== 'text') {
        throw new UserError(
          'Only text output is supported for chat completions. Got item: ' +
            JSON.stringify(item),
        );
      }

      result.push({
        role: 'tool',
        tool_call_id: funcOutput.callId,
        content: funcOutput.output.text,
        ...funcOutput.providerData,
      });
    } else if (item.type === 'unknown') {
      result.push({
        ...item.providerData,
      } as any);
    } else {
      const exhaustive = item satisfies never; // ensures that the type is exhaustive
      throw new Error(`Unknown item type: ${JSON.stringify(exhaustive)}`);
    }
  }
  flushAssistantMessage();
  return result;
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
