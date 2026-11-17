import {
  UserError,
  type AgentInputItem,
  type AssistantMessageItem,
  type FunctionCallItem,
  type FunctionCallResultItem,
} from '@openai/agents-core';
import { formatInlineData } from '@openai/agents-core/utils/internal';

type ImageDetail = 'auto' | 'low' | 'high' | 'original';
type ImageContent = {
  type: 'input_image';
  image_url: string;
  detail?: ImageDetail;
};
type UserContent = { type: 'input_text'; text: string } | ImageContent;
type HistoryItem =
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
  | { type: 'image'; url: string; detail?: ImageDetail };

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
              if (part.type === 'input_text') {
                return { type: 'input_text', text: part.text };
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

export function prepareCodexHistory(input: string | AgentInputItem[]): {
  history: HistoryItem[];
  turnInput: TurnInput[];
} {
  const pending = new Map<string, FunctionCallItem>();
  const items: AgentInputItem[] =
    typeof input === 'string' ? [{ role: 'user', content: input }] : input;
  const history = items.map((item): HistoryItem => {
    if (item.type === 'function_call') {
      if (pending.has(item.callId)) {
        throw new UserError('CodexProvider received a duplicate tool call.');
      }
      pending.set(item.callId, item);
      return {
        type: 'function_call',
        name: item.name,
        ...(item.namespace !== undefined && { namespace: item.namespace }),
        call_id: item.callId,
        arguments: item.arguments,
      };
    }
    if (item.type === 'function_call_result') {
      const call = pending.get(item.callId);
      if (
        !call ||
        call.name !== item.name ||
        call.namespace !== item.namespace ||
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
    return item.content.map((part) =>
      part.type === 'input_text'
        ? { type: 'text', text: part.text, text_elements: [] }
        : {
            type: 'image',
            url: part.image_url,
            ...(part.detail && { detail: part.detail }),
          },
    );
  });
  if (!turnInput.some((item) => item.type === 'image' || item.text.trim())) {
    throw new UserError('CodexProvider requires user text or a local image.');
  }
  return { history: history.slice(0, tail), turnInput };
}
