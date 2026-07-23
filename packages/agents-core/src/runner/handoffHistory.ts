import type { HandoffHistoryMapper, HandoffInputData } from '../handoff';
import type { RunItem } from '../items';
import type { AgentInputItem } from '../types';
import { toAgentInputList } from './items';

const CONVERSATION_HISTORY_START = '<CONVERSATION HISTORY>';
const CONVERSATION_HISTORY_END = '</CONVERSATION HISTORY>';
const CONVERSATION_HISTORY_PREAMBLE =
  'For context, here is the conversation so far between the user and the previous agent:';
const SUMMARY_ONLY_TYPES = new Set([
  'function_call',
  'function_call_result',
  'reasoning',
]);

/**
 * Compacts a handoff transcript into one readable assistant message.
 */
export function defaultHandoffHistoryMapper(
  transcript: AgentInputItem[],
): AgentInputItem[] {
  const records = transcript.length
    ? transcript.map(
        (item, index) => `${index + 1}. ${formatTranscriptItem(item)}`,
      )
    : ['(no previous turns recorded)'];

  return [
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: [
            CONVERSATION_HISTORY_PREAMBLE,
            CONVERSATION_HISTORY_START,
            ...records,
            CONVERSATION_HISTORY_END,
          ].join('\n'),
        },
      ],
    },
  ];
}

/**
 * Builds compact next-agent history while preserving complete session run items.
 */
export function nestHandoffHistory(
  handoffInputData: HandoffInputData,
  options: { historyMapper?: HandoffHistoryMapper } = {},
): HandoffInputData {
  const history = toAgentInputList(handoffInputData.inputHistory).flatMap(
    (item) => flattenNestedHistoryItem(item),
  );
  const preItems = normalizeRunItems(handoffInputData.preHandoffItems);
  const newItems = normalizeRunItems(handoffInputData.newItems);

  if (options.historyMapper) {
    const transcript = [...history, ...preItems, ...newItems].map((item) =>
      structuredClone(item),
    );
    return {
      ...handoffInputData,
      inputHistory: options
        .historyMapper(transcript)
        .map((item) => structuredClone(item)),
      preHandoffItems: [],
      inputItems: [],
    };
  }

  const nestedHistory: AgentInputItem[] = [];
  let pendingSummary = [...history];

  for (const [items, isNew] of [
    [preItems, false],
    [newItems, true],
  ] as const) {
    for (const item of items) {
      if (!shouldForwardVerbatim(item, isNew)) {
        pendingSummary.push(item);
        continue;
      }

      if (pendingSummary.length > 0 || nestedHistory.length === 0) {
        nestedHistory.push(...defaultHandoffHistoryMapper(pendingSummary));
        pendingSummary = [];
      }
      nestedHistory.push(structuredClone(item));
    }
  }

  if (pendingSummary.length > 0 || nestedHistory.length === 0) {
    nestedHistory.push(...defaultHandoffHistoryMapper(pendingSummary));
  }

  return {
    ...handoffInputData,
    inputHistory: nestedHistory,
    preHandoffItems: [],
    inputItems: [],
  };
}

function normalizeRunItems(items: RunItem[]): AgentInputItem[] {
  return items
    .filter((item) => item.type !== 'tool_approval_item')
    .map((item) => structuredClone(item.rawItem as AgentInputItem));
}

function shouldForwardVerbatim(item: AgentInputItem, isNew: boolean): boolean {
  if (isProgrammaticTranscriptItem(item)) {
    return false;
  }

  const record = item as Record<string, unknown>;
  if (typeof record.role === 'string') {
    return isNew || record.role !== 'assistant';
  }

  return !SUMMARY_ONLY_TYPES.has(String(record.type ?? ''));
}

function isProgrammaticTranscriptItem(item: AgentInputItem): boolean {
  const record = item as Record<string, unknown>;
  if (record.type === 'program' || record.type === 'program_output') {
    return true;
  }

  const caller = record.caller;
  return (
    typeof caller === 'object' &&
    caller !== null &&
    (caller as { type?: unknown }).type === 'program'
  );
}

function formatTranscriptItem(item: AgentInputItem): string {
  const record = item as Record<string, unknown>;
  const { providerData: _providerData, ...safeRecord } = record;
  const role = safeRecord.role;
  const content = safeRecord.content;

  if (typeof role === 'string' && Array.isArray(content)) {
    const textParts = content
      .filter(
        (part): part is { text: string } =>
          typeof part === 'object' &&
          part !== null &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => part.text);
    if (textParts.length === content.length && textParts.length > 0) {
      const text = textParts.join('');
      if (!/[\r\n]/.test(text)) {
        return `${role}: ${text}`;
      }
    }
  }

  if (
    typeof role === 'string' &&
    (typeof content === 'string' || content === undefined)
  ) {
    return typeof content === 'string' && content.length > 0
      ? `${role}: ${content}`
      : role;
  }

  return JSON.stringify(safeRecord);
}

function flattenNestedHistoryItem(item: AgentInputItem): AgentInputItem[] {
  if (item.type !== 'message' || item.role !== 'assistant') {
    return [structuredClone(item)];
  }

  const firstContent = item.content[0];
  if (firstContent?.type !== 'output_text') {
    return [structuredClone(item)];
  }

  const lines = firstContent.text.split('\n');
  if (
    lines[0] !== CONVERSATION_HISTORY_PREAMBLE ||
    lines[1] !== CONVERSATION_HISTORY_START ||
    lines[lines.length - 1] !== CONVERSATION_HISTORY_END
  ) {
    return [structuredClone(item)];
  }

  const parsed: AgentInputItem[] = [];
  for (const line of lines.slice(2, -1)) {
    const record = line.match(/^\d+\.\s(.+)$/)?.[1];
    if (!record) {
      continue;
    }

    if (record.startsWith('{')) {
      try {
        parsed.push(JSON.parse(record) as AgentInputItem);
      } catch {
        return [structuredClone(item)];
      }
      continue;
    }

    const separator = record.indexOf(': ');
    if (separator < 0) {
      return [structuredClone(item)];
    }
    const role = record.slice(0, separator);
    const content = record.slice(separator + 2);
    if (role === 'assistant') {
      parsed.push({
        type: 'message',
        role,
        status: 'completed',
        content: [{ type: 'output_text', text: content }],
      });
    } else if (role === 'user' || role === 'system') {
      parsed.push({ type: 'message', role, content });
    } else {
      return [structuredClone(item)];
    }
  }

  return parsed;
}
