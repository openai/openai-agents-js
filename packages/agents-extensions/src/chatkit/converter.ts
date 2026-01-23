import type {
  ChatKitAnnotation,
  ChatKitAssistantMessageContent,
  ChatKitAssistantMessageItem,
  ChatKitTextMessageOptions,
  ChatKitThreadItemDoneEvent,
} from './types';
import { createId, normalizeCreatedAt } from './utils';

export class ChatKitResponseStreamConverter {
  readonly partialImages?: number;

  constructor(options: { partialImages?: number } = {}) {
    this.partialImages = options.partialImages;
  }

  async base64ImageToUrl(
    base64Image: string,
    _partialImageIndex?: number | null,
  ): Promise<string> {
    return `data:image/png;base64,${base64Image}`;
  }

  partialImageIndexToProgress(partialImageIndex: number): number {
    if (!this.partialImages || this.partialImages <= 0) {
      return 0;
    }
    return Math.min(1, (partialImageIndex + 1) / this.partialImages);
  }

  async fileCitationToAnnotation(raw: {
    filename?: string | null;
    index?: number | null;
  }): Promise<ChatKitAnnotation | null> {
    if (!raw.filename) {
      return null;
    }
    return {
      type: 'annotation',
      source: {
        type: 'file',
        filename: raw.filename,
        title: raw.filename,
      },
      index: raw.index ?? null,
    };
  }

  async containerFileCitationToAnnotation(raw: {
    filename?: string | null;
    end_index?: number | null;
  }): Promise<ChatKitAnnotation | null> {
    if (!raw.filename) {
      return null;
    }
    return {
      type: 'annotation',
      source: {
        type: 'file',
        filename: raw.filename,
        title: raw.filename,
      },
      index: raw.end_index ?? null,
    };
  }

  async urlCitationToAnnotation(raw: {
    url?: string | null;
    title?: string | null;
    end_index?: number | null;
  }): Promise<ChatKitAnnotation | null> {
    if (!raw.url) {
      return null;
    }
    return {
      type: 'annotation',
      source: {
        type: 'url',
        url: raw.url,
        title: raw.title ?? raw.url,
      },
      index: raw.end_index ?? null,
    };
  }
}

const defaultConverter = new ChatKitResponseStreamConverter();

export function getConverter(
  converter?: ChatKitResponseStreamConverter,
): ChatKitResponseStreamConverter {
  return converter ?? defaultConverter;
}

export async function convertAnnotation(
  raw: unknown,
  converter: ChatKitResponseStreamConverter,
): Promise<ChatKitAnnotation | null> {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const type = (raw as { type?: unknown }).type;
  if (type === 'file_citation') {
    return converter.fileCitationToAnnotation(raw as any);
  }
  if (type === 'container_file_citation') {
    return converter.containerFileCitationToAnnotation(raw as any);
  }
  if (type === 'url_citation') {
    return converter.urlCitationToAnnotation(raw as any);
  }
  return null;
}

export async function convertContentPart(
  raw: unknown,
  converter: ChatKitResponseStreamConverter,
): Promise<ChatKitAssistantMessageContent | null> {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const type = (raw as { type?: unknown }).type;
  if (type === 'output_text') {
    const text =
      typeof (raw as { text?: unknown }).text === 'string'
        ? ((raw as { text?: string }).text ?? '')
        : '';
    const annotationsRaw = Array.isArray(
      (raw as { annotations?: unknown }).annotations,
    )
      ? ((raw as { annotations?: unknown }).annotations as unknown[])
      : [];
    const annotations: ChatKitAnnotation[] = [];
    for (const annotation of annotationsRaw) {
      const converted = await convertAnnotation(annotation, converter);
      if (converted) {
        annotations.push(converted);
      }
    }
    return {
      type: 'output_text',
      text,
      annotations,
    };
  }
  if (type === 'refusal') {
    const refusal =
      typeof (raw as { refusal?: unknown }).refusal === 'string'
        ? ((raw as { refusal?: string }).refusal ?? '')
        : '';
    return {
      type: 'output_text',
      text: refusal,
      annotations: [],
    };
  }
  return null;
}

export async function convertContentArray(
  raw: unknown,
  converter: ChatKitResponseStreamConverter,
): Promise<ChatKitAssistantMessageContent[]> {
  if (!Array.isArray(raw)) {
    return [];
  }
  const output: ChatKitAssistantMessageContent[] = [];
  for (const part of raw) {
    const converted = await convertContentPart(part, converter);
    if (converted) {
      output.push(converted);
      continue;
    }
    // Preserve positional indices so streaming content_index values stay aligned.
    output.push({ type: 'output_text', text: '', annotations: [] });
  }
  return output;
}

function buildAssistantItem(
  content: ChatKitAssistantMessageContent[],
  options: ChatKitTextMessageOptions,
): ChatKitAssistantMessageItem {
  const threadId = options.threadId ?? createId('thread');
  const itemId = options.itemId ?? createId('message');
  const createdAt = normalizeCreatedAt(options.createdAt);
  return {
    type: 'assistant_message',
    id: itemId,
    thread_id: threadId,
    created_at: createdAt,
    content,
  };
}

export function createChatKitTextMessageItem(
  text: string,
  options: ChatKitTextMessageOptions = {},
): ChatKitAssistantMessageItem {
  return buildAssistantItem(
    [
      {
        type: 'output_text',
        text,
        annotations: options.annotations ?? [],
      },
    ],
    options,
  );
}

export function createChatKitTextMessageDoneEvent(
  text: string,
  options: ChatKitTextMessageOptions = {},
): ChatKitThreadItemDoneEvent {
  return {
    type: 'thread.item.done',
    item: createChatKitTextMessageItem(text, options),
  };
}
