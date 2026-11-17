import {
  UserError,
  type AgentInputItem,
  type AssistantMessageItem,
  type ModelRequest,
  type ReasoningItem,
  type ToolSearchOutputItem,
  type FunctionCallResultItem,
} from '@openai/agents-core';
import {
  getToolSearchExecution,
  getToolSearchProviderCallId,
} from '@openai/agents-core/utils';
import {
  formatInlineData,
  toOpenAIToolSearchOutputToolPayload,
} from '@openai/agents-core/utils/internal';

import type { CodexAppServer } from './appServer';

type ImageDetail = 'auto' | 'low' | 'high' | 'original';
type ImageContent = {
  type: 'input_image';
  image_url: string;
  detail?: ImageDetail;
};
type UserContent =
  | { type: 'input_text'; text: string }
  | ImageContent
  | { type: 'input_audio'; audio_url: string };
type HistoryItem =
  | {
      type: 'reasoning';
      id?: string;
      summary: { type: 'summary_text'; text: string }[];
      content?: ReasoningItem['rawContent'];
      encrypted_content?: string;
    }
  | {
      type: 'tool_search_call';
      id?: string;
      call_id?: string;
      execution: 'client' | 'server';
      status?: string;
      arguments: unknown;
    }
  | {
      type: 'tool_search_output';
      id?: string;
      call_id?: string;
      execution: 'client' | 'server';
      status: string;
      tools: ToolSearchOutputItem['tools'];
    }
  | {
      type: 'web_search_call';
      id?: string;
      status?: string;
      action?: unknown;
      encrypted_content?: string;
    }
  | { type: 'compaction'; id?: string; encrypted_content: string }
  | { type: 'message'; role: 'user'; content: UserContent[] }
  | {
      type: 'message';
      role: 'assistant';
      phase?: AssistantMessageItem['phase'];
      content: { type: 'output_text'; text: string }[];
    }
  | {
      type: 'function_call';
      name: string;
      namespace?: string;
      call_id: string;
      arguments: string;
    }
  | {
      type: 'function_call_output';
      call_id: string;
      output: string | UserContent[];
    };
type TurnInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'image'; url: string; detail?: ImageDetail }
  | { type: 'audio'; url: string };

function rejectCacheBreakpoint(part: object) {
  if ('promptCacheBreakpoint' in part && part.promptCacheBreakpoint != null) {
    throw new UserError(
      'CodexProvider does not support promptCacheBreakpoint.',
    );
  }
}

function imageContent(image: unknown, detail: unknown): ImageContent {
  if (
    typeof image !== 'string' ||
    !/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(image)
  ) {
    throw new UserError(
      'CodexProvider accepts images as local image data URLs.',
    );
  }
  if (
    detail !== undefined &&
    detail !== 'auto' &&
    detail !== 'low' &&
    detail !== 'high' &&
    detail !== 'original'
  ) {
    throw new UserError('CodexProvider received an unsupported image detail.');
  }
  return { type: 'input_image', image_url: image, ...(detail && { detail }) };
}

function toolOutput(
  output: FunctionCallResultItem['output'],
): string | UserContent[] {
  if (typeof output === 'string') return output;
  return (Array.isArray(output) ? output : [output]).map((part) => {
    rejectCacheBreakpoint(part);
    switch (part.type) {
      case 'text':
      case 'input_text':
        return { type: 'input_text', text: part.text };
      case 'image':
      case 'input_image': {
        const image =
          part.type === 'image' &&
          typeof part.image === 'object' &&
          part.image !== null &&
          'data' in part.image
            ? formatInlineData(part.image.data, part.image.mediaType)
            : part.image;
        return imageContent(image, part.detail ?? part.providerData?.detail);
      }
      default:
        throw new UserError(
          'CodexProvider accepts only text and local images in tool results.',
        );
    }
  });
}

function messageItem(
  item: AgentInputItem,
): Extract<HistoryItem, { type: 'message' }> {
  if (
    (item.type !== 'message' && item.type !== undefined) ||
    !('role' in item)
  ) {
    throw new UserError('CodexProvider received an unsupported history item.');
  }
  if (item.role === 'user') {
    return {
      type: 'message',
      role: 'user',
      content:
        typeof item.content === 'string'
          ? [{ type: 'input_text', text: item.content }]
          : item.content.map((part) => {
              rejectCacheBreakpoint(part);
              if (part.type === 'input_text') {
                return { type: 'input_text', text: part.text };
              }
              if (part.type === 'audio') {
                if (
                  typeof part.audio !== 'string' ||
                  part.transcript != null ||
                  !part.audio
                ) {
                  throw new UserError(
                    'CodexProvider requires inline audio without a transcript or file ID.',
                  );
                }
                const formats: Record<string, string> = {
                  wav: 'wav',
                  mp3: 'mpeg',
                  m4a: 'mp4',
                  ogg: 'ogg',
                  webm: 'webm',
                };
                const embedded =
                  /^data:audio\/(wav|mpeg|mp4|ogg|webm);base64,(.+)$/i.exec(
                    part.audio,
                  );
                const mime = part.format
                  ? formats[part.format.toLowerCase()]
                  : embedded?.[1];
                const bytes = embedded?.[2] ?? part.audio;
                if (
                  !mime ||
                  (embedded && embedded[1].toLowerCase() !== mime) ||
                  !/^[a-z0-9+/]+={0,2}$/i.test(bytes)
                ) {
                  throw new UserError(
                    'CodexProvider requires base64 audio with a supported format.',
                  );
                }
                return {
                  type: 'input_audio',
                  audio_url: `data:audio/${mime};base64,${bytes}`,
                };
              }
              if (part.type === 'input_image') {
                return imageContent(
                  part.image,
                  part.detail ?? part.providerData?.detail,
                );
              }
              throw new UserError(
                'CodexProvider accepts only text and local images in user messages.',
              );
            }),
    };
  }
  if (item.role === 'assistant') {
    return {
      type: 'message',
      role: 'assistant',
      ...(item.phase !== undefined && { phase: item.phase }),
      content: item.content.map((part) => {
        if (part.type !== 'output_text') {
          throw new UserError(
            'CodexProvider accepts only text in assistant history.',
          );
        }
        return { type: 'output_text', text: part.text };
      }),
    };
  }
  throw new UserError(
    'CodexProvider accepts only user and assistant messages in history.',
  );
}

export function prepareCodexHistory(
  input: string | AgentInputItem[],
  tools: ModelRequest['tools'] = [],
): {
  history: HistoryItem[];
  turnInput: TurnInput[];
} {
  const pending = new Map<
    string,
    {
      kind: 'function_call' | 'shell_call' | 'apply_patch_call';
      name: string;
      namespace?: string;
    }
  >();
  const items: AgentInputItem[] =
    typeof input === 'string' ? [{ role: 'user', content: input }] : input;
  const history = items.map((item): HistoryItem => {
    if (
      item.type === 'tool_search_call' ||
      item.type === 'tool_search_output'
    ) {
      const execution = getToolSearchExecution(item);
      if (!execution)
        throw new UserError(
          'CodexProvider requires the execution mode for tool search history.',
        );
      const fields = {
        id: item.id,
        call_id: getToolSearchProviderCallId(item),
        execution,
      };
      if (item.type === 'tool_search_call') {
        return {
          ...fields,
          type: 'tool_search_call',
          status: item.status,
          arguments: item.arguments,
        };
      }
      if (!item.status)
        throw new UserError(
          'CodexProvider requires a status for tool search output.',
        );
      return {
        ...fields,
        type: 'tool_search_output',
        status: item.status,
        tools: item.tools.map(toOpenAIToolSearchOutputToolPayload),
      };
    }
    if (item.type === 'hosted_tool_call' && item.name === 'web_search_call') {
      const data = item.providerData;
      return {
        type: 'web_search_call',
        id: item.id,
        status: item.status,
        ...(data?.action !== undefined && { action: data.action }),
        ...(typeof data?.encrypted_content === 'string' && {
          encrypted_content: data.encrypted_content,
        }),
      };
    }
    if (item.type === 'reasoning') {
      const encryptedContent =
        item.providerData?.encrypted_content ??
        item.providerData?.encryptedContent;
      return {
        type: 'reasoning',
        id: item.id,
        summary: item.content.map((part) => {
          rejectCacheBreakpoint(part);
          return { type: 'summary_text', text: part.text };
        }),
        ...(item.rawContent && {
          content: item.rawContent.map(({ type, text }) => ({ type, text })),
        }),
        ...(typeof encryptedContent === 'string' && {
          encrypted_content: encryptedContent,
        }),
      };
    }
    if (item.type === 'compaction') {
      return {
        type: 'compaction',
        ...(item.id !== undefined && { id: item.id }),
        encrypted_content: item.encrypted_content,
      };
    }
    if (item.type === 'shell_call' || item.type === 'apply_patch_call') {
      if (pending.has(item.callId))
        throw new UserError('CodexProvider received a duplicate tool call.');
      const kind = item.type === 'shell_call' ? 'shell' : 'apply_patch';
      const name =
        typeof item.providerData?.codexToolName === 'string'
          ? item.providerData.codexToolName
          : (tools.find((tool) => tool.type === kind)?.name ?? kind);
      pending.set(item.callId, { kind: item.type, name });
      const args =
        item.type === 'shell_call'
          ? {
              action: {
                commands: item.action.commands,
                timeout_ms: item.action.timeoutMs,
                max_output_length: item.action.maxOutputLength,
              },
            }
          : {
              operation:
                item.operation.type === 'update_file'
                  ? {
                      type: item.operation.type,
                      path: item.operation.path,
                      diff: item.operation.diff,
                      move_to: item.operation.moveTo,
                    }
                  : item.operation,
            };
      return {
        type: 'function_call',
        name,
        namespace: 'agents_sdk',
        call_id: item.callId,
        arguments: JSON.stringify(args),
      };
    }
    if (
      item.type === 'shell_call_output' ||
      item.type === 'apply_patch_call_output'
    ) {
      const expected =
        item.type === 'shell_call_output' ? 'shell_call' : 'apply_patch_call';
      if (pending.get(item.callId)?.kind !== expected)
        throw new UserError(
          'CodexProvider received an unmatched local tool result.',
        );
      pending.delete(item.callId);
      const output =
        item.type === 'shell_call_output'
          ? {
              status: item.status,
              max_output_length: item.maxOutputLength,
              output: item.output.map(({ stdout, stderr, outcome }) => ({
                stdout,
                stderr,
                outcome:
                  outcome.type === 'exit'
                    ? { type: 'exit', exit_code: outcome.exitCode }
                    : { type: 'timeout' },
              })),
            }
          : { status: item.status, output: item.output };
      return {
        type: 'function_call_output',
        call_id: item.callId,
        output: JSON.stringify(output),
      };
    }
    if (item.type === 'function_call') {
      if (pending.has(item.callId)) {
        throw new UserError('CodexProvider received a duplicate tool call.');
      }
      pending.set(item.callId, {
        kind: item.type,
        name: item.name,
        namespace: item.namespace,
      });
      const namespace = item.providerData?.codexToolNamespace ?? item.namespace;
      return {
        type: 'function_call',
        name: item.name,
        ...(typeof namespace === 'string' && { namespace }),
        call_id: item.callId,
        arguments: item.arguments,
      };
    }
    if (item.type === 'function_call_result') {
      const call = pending.get(item.callId);
      // A stored Conversations API output carries only the call ID. The SDK
      // converter uses that ID as its display name when no tool name is present.
      const unnamedStoredOutput =
        item.name === item.callId && item.namespace === undefined;
      if (
        call?.kind !== 'function_call' ||
        (!unnamedStoredOutput &&
          (call.name !== item.name || call.namespace !== item.namespace)) ||
        item.status !== 'completed'
      ) {
        throw new UserError(
          'CodexProvider requires each tool result to match a completed tool call.',
        );
      }
      pending.delete(item.callId);
      return {
        type: 'function_call_output',
        call_id: item.callId,
        output: toolOutput(item.output),
      };
    }
    return messageItem(item);
  });
  if (pending.size !== 0) {
    throw new UserError('CodexProvider cannot replay a pending tool call.');
  }

  let tail = history.length;
  while (tail > 0) {
    const item = history[tail - 1];
    if (item.type !== 'message' || item.role !== 'user') break;
    tail--;
  }
  if (tail === history.length) {
    if (history.length === 0) {
      throw new UserError('CodexProvider requires conversation input.');
    }
    return { history, turnInput: [] };
  }
  const turnInput = history.slice(tail).flatMap((item): TurnInput[] => {
    if (item.type !== 'message' || item.role !== 'user') return [];
    return item.content.map((part): TurnInput => {
      if (part.type === 'input_text')
        return { type: 'text', text: part.text, text_elements: [] };
      if (part.type === 'input_audio')
        return { type: 'audio', url: part.audio_url };
      return {
        type: 'image',
        url: part.image_url,
        ...(part.detail && { detail: part.detail }),
      };
    });
  });
  if (!turnInput.some((item) => item.type !== 'text' || item.text.trim())) {
    throw new UserError(
      'CodexProvider requires user text or a local media input.',
    );
  }
  return { history: history.slice(0, tail), turnInput };
}

// Stock replaces audio with a text placeholder on models that lack audio input.
export async function verifyAudioModel(
  prepared: ReturnType<typeof prepareCodexHistory>,
  model: unknown,
  server: Pick<CodexAppServer, 'request'>,
) {
  const hasAudio =
    prepared.turnInput.some((item) => item.type === 'audio') ||
    prepared.history.some(
      (item) =>
        item.type === 'message' &&
        item.role === 'user' &&
        item.content.some((part) => part.type === 'input_audio'),
    );
  if (!hasAudio) return;
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = (await server.request('model/list', {
      includeHidden: true,
      cursor,
    })) as {
      data?: { id: string; model: string; inputModalities: string[] }[];
      nextCursor?: string;
    } | null;
    const match = page?.data?.find(
      (entry) => entry.model === model || entry.id === model,
    );
    if (match?.inputModalities?.includes('audio')) return;
    cursor = page?.nextCursor;
    if (match || !cursor || seen.has(cursor)) break;
    seen.add(cursor);
  } while (cursor);
  throw new UserError(
    'CodexProvider requires a Codex model that advertises audio input.',
  );
}
