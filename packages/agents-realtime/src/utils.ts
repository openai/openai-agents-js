import {
  RealtimeItem,
  RealtimeMcpCallApprovalRequestItem,
  RealtimeMessageItem,
} from './items';
import type { InputAudioTranscriptionCompletedEvent } from './transportLayerEvents';
import METADATA from './metadata';
import { RunToolApprovalItem } from '@openai/agents-core';
import { RealtimeAgent } from './realtimeAgent';

/**
 * Converts a base64 string to an ArrayBuffer
 * @param {string} base64
 * @returns {ArrayBuffer}
 */
export function base64ToArrayBuffer(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Converts an ArrayBuffer to a base64 string
 * @param {ArrayBuffer} arrayBuffer
 * @returns {string}
 */
export function arrayBufferToBase64(arrayBuffer: ArrayBuffer) {
  const binaryString = String.fromCharCode(...new Uint8Array(arrayBuffer));
  return btoa(binaryString);
}

/**
 * Get the last text from an audio output message
 * @param item
 * @returns
 */
export function getLastTextFromAudioOutputMessage(
  item: unknown,
): string | undefined {
  if (
    typeof item === 'undefined' ||
    item === null ||
    typeof item !== 'object' ||
    !('type' in item) ||
    typeof item.type !== 'string' ||
    !item.type
  ) {
    return undefined;
  }

  if (item.type !== 'message') {
    return undefined;
  }

  if (
    !('content' in item) ||
    !Array.isArray(item.content) ||
    item.content.length < 1
  ) {
    return undefined;
  }

  const lastContentItem = item.content[item.content.length - 1];

  if (
    !('type' in lastContentItem) ||
    typeof lastContentItem.type !== 'string'
  ) {
    return undefined;
  }

  if (lastContentItem.type === 'output_text') {
    return typeof lastContentItem.text === 'string'
      ? lastContentItem.text
      : undefined;
  }

  if (lastContentItem.type === 'output_audio') {
    return typeof lastContentItem.transcript === 'string'
      ? lastContentItem.transcript
      : undefined;
  }

  return undefined;
}

export type RealtimeHistoryDiff = {
  removals: RealtimeItem[];
  additions: RealtimeItem[];
  updates: RealtimeItem[];
};

/**
 * Compare two conversation histories to determine the removals, additions, and updates.
 * @param oldHistory - The old history.
 * @param newHistory - The new history.
 * @returns A diff of the two histories.
 */
export function diffRealtimeHistory(
  oldHistory: RealtimeItem[],
  newHistory: RealtimeItem[],
): RealtimeHistoryDiff {
  const removals = oldHistory.filter(
    (item) => !newHistory.some((newItem) => newItem.itemId === item.itemId),
  );
  const additions = newHistory.filter(
    (item) => !oldHistory.some((oldItem) => oldItem.itemId === item.itemId),
  );
  const updates = newHistory.filter((item) =>
    oldHistory.some(
      (oldItem) =>
        oldItem.itemId === item.itemId &&
        JSON.stringify(oldItem) !== JSON.stringify(item),
    ),
  );
  return {
    removals,
    additions,
    updates,
  };
}

/**
 * Check if the browser supports WebRTC.
 * @returns True if WebRTC is supported, false otherwise.
 */
export function hasWebRTCSupport(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return typeof window['RTCPeerConnection'] !== 'undefined';
}

/**
 * Removes the audio data from all content in a message by setting it to null.
 * @param item
 * @returns
 */
export function removeAudioFromContent(
  item: RealtimeMessageItem,
): RealtimeMessageItem {
  if (item.role === 'system') {
    return item;
  }

  if (item.role === 'assistant') {
    return {
      ...item,
      content: item.content.map((entry) => {
        if ((entry as any).type === 'output_audio') {
          return {
            ...entry,
            audio: null,
          };
        }
        return entry;
      }),
    };
  }

  if (item.role === 'user') {
    return {
      ...item,
      content: item.content.map((entry) => {
        if (entry.type === 'input_audio') {
          return {
            ...entry,
            audio: null,
          };
        }
        return entry;
      }),
    };
  }

  return item;
}

// Realtime can resend truncated assistant items without transcripts after an
// interrupt/retrieve cycle. This helper merges those updates with the latest
// known transcript so UIs retain the portion of the message the user already
// heard.
function preserveAssistantAudioTranscripts(
  existing: RealtimeMessageItem,
  incoming: RealtimeMessageItem,
): RealtimeMessageItem {
  if (existing.role !== 'assistant' || incoming.role !== 'assistant') {
    return incoming;
  }

  const mergedContent = incoming.content.map((entry, index) => {
    if (entry.type !== 'output_audio') {
      return entry;
    }

    const transcriptMissing =
      typeof entry.transcript !== 'string' || entry.transcript.length === 0;
    if (!transcriptMissing) {
      return entry;
    }

    const previousEntry = existing.content[index];
    if (
      previousEntry &&
      previousEntry.type === 'output_audio' &&
      typeof previousEntry.transcript === 'string' &&
      previousEntry.transcript.length > 0
    ) {
      return {
        ...entry,
        transcript: previousEntry.transcript,
      };
    }

    return entry;
  });

  return {
    ...incoming,
    content: mergedContent,
  };
}

/**
 * Updates the realtime history array based on the incoming event and options.
 * @param history - The current history array.
 * @param event - The event to process (RealtimeItem).
 * @param shouldIncludeAudioData - Whether to include audio data in message items.
 * @returns The updated history array.
 */
export function updateRealtimeHistory(
  history: RealtimeItem[],
  event: RealtimeItem | InputAudioTranscriptionCompletedEvent,
  shouldIncludeAudioData: boolean,
): RealtimeItem[] {
  // Merge transcript into placeholder input_audio message
  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    return history.map((item) => {
      if (
        item.itemId === event.item_id &&
        item.type === 'message' &&
        'role' in item &&
        item.role === 'user'
      ) {
        const updatedContent = item.content.map((entry: any) => {
          if (entry.type === 'input_audio') {
            return {
              ...entry,
              transcript: event.transcript,
            };
          }
          return entry;
        });

        return {
          ...item,
          content: updatedContent,
          status: 'completed',
        };
      }
      return item;
    });
  }
  const newEvent =
    !shouldIncludeAudioData && event.type === 'message'
      ? removeAudioFromContent(event as any)
      : event;

  const existingIndex = history.findIndex(
    (item) => item.itemId === event.itemId,
  );

  if (existingIndex !== -1) {
    const existingItem = history[existingIndex];
    const mergedEvent =
      newEvent.type === 'message' && existingItem.type === 'message'
        ? preserveAssistantAudioTranscripts(existingItem, newEvent)
        : newEvent;
    // Update existing item
    return history.map((item, idx) => {
      if (idx === existingIndex) {
        return mergedEvent;
      }
      if (!shouldIncludeAudioData && item.type === 'message') {
        return removeAudioFromContent(item as any);
      }
      return item;
    });
  } else if ((event as any).previousItemId) {
    // Insert after previousItemId if found, else at end
    const prevIndex = history.findIndex(
      (item) => item.itemId === (event as any).previousItemId,
    );
    if (prevIndex !== -1) {
      return [
        ...history.slice(0, prevIndex + 1),
        newEvent,
        ...history.slice(prevIndex + 1),
      ];
    } else {
      return [...history, newEvent];
    }
  } else {
    return [...history, newEvent];
  }
}

/**
 * The headers to use for the Realtime API.
 */
export const HEADERS = {
  'User-Agent': `Agents/JavaScript ${METADATA.version}`,
  'X-OpenAI-Agents-SDK': `openai-agents-sdk.${METADATA.version}`,
};

/**
 * Browser websocket header
 */
export const WEBSOCKET_META = `openai-agents-sdk.${METADATA.version}`;

export function realtimeApprovalItemToApprovalItem(
  agent: RealtimeAgent<any>,
  item: RealtimeMcpCallApprovalRequestItem,
): RunToolApprovalItem {
  const { name, arguments: args, ...rest } = item;
  return new RunToolApprovalItem(
    {
      type: 'hosted_tool_call',
      name,
      arguments: JSON.stringify(args),
      status: 'in_progress',
      providerData: {
        ...rest,
      },
    },
    agent,
  );
}

export function approvalItemToRealtimeApprovalItem(
  item: RunToolApprovalItem,
): RealtimeMcpCallApprovalRequestItem {
  if (
    item.rawItem.type !== 'function_call' &&
    item.rawItem.type !== 'hosted_tool_call'
  ) {
    throw new Error(
      'Invalid approval item type for Realtime MCP approval request',
    );
  }

  const { name, arguments: args, providerData } = item.rawItem;
  const { itemId, serverLabel, ...rest } = providerData ?? {};
  if (!itemId || !serverLabel) {
    throw new Error('Invalid approval item for Realtime MCP approval request');
  }

  return {
    type: 'mcp_approval_request',
    itemId,
    serverLabel,
    ...rest,
    name,
    arguments: args ? JSON.parse(args) : {},
    approved: null,
  } as RealtimeMcpCallApprovalRequestItem;
}
