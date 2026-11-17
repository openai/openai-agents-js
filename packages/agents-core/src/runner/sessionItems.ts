import type { AgentInputItem } from '../types';
import {
  type FunctionCallResultItem,
  type ToolCallStructuredOutput,
} from '../types/protocol';
import { projectStructuredToolOutput } from './toolOutputNormalization';
import { toSmartString } from '../utils/smartString';
import {
  decodeBase64ToUint8Array,
  encodeUint8ArrayToBase64,
} from '../utils/base64';
import { toUint8ArrayFromBinary } from '../utils/binary';
import {
  deduplicateAgentInputItemsPreferringLatest,
  stripReasoningItemIdForPolicy,
} from './items';
import {
  getToolResultCorrelationForCall,
  getToolResultCorrelationForResult,
  getToolResultCorrelationKey,
} from './toolResultCorrelation';
import type {
  Session,
  OpenAIResponsesCompactionAwareSession,
} from '../memory/session';

/** Return model-visible representations only when every stored occurrence is covered in order. */
export function getModelVisibleSessionItems(
  session: Session,
  stored: AgentInputItem[],
  exchange: NonNullable<
    Parameters<OpenAIResponsesCompactionAwareSession['runCompaction']>[3]
  >,
): AgentInputItem[] | undefined {
  const comparable = (items: AgentInputItem[]) => {
    // Normalize each record separately: persistence's whole-array deduplication would lose counts.
    const normalized = items.map(
      (item) => normalizeItemsForSessionPersistence([item])[0],
    );
    return (
      session.prepareHistoryItemsForPersistenceComparison?.(
        structuredClone(normalized),
      ) ?? normalized
    );
  };
  const history = comparable(stored);
  const modelItems = comparable(exchange.items);
  if (
    history.length !== stored.length ||
    modelItems.length !== exchange.items.length
  ) {
    return undefined;
  }
  const visible: AgentInputItem[] = [];
  let cursor = 0;
  for (const item of history) {
    const replayItem = stripReasoningItemIdForPolicy(
      item,
      exchange.reasoningItemIdPolicy,
    );
    while (
      cursor < modelItems.length &&
      !sessionItemArraysMatch([item], [modelItems[cursor]]) &&
      !sessionItemArraysMatch([replayItem], [modelItems[cursor]]) &&
      !sessionItemArraysMatch(
        [item],
        [
          stripReasoningItemIdForPolicy(
            modelItems[cursor],
            exchange.reasoningItemIdPolicy,
          ),
        ],
      )
    ) {
      cursor++;
    }
    if (cursor === modelItems.length) return undefined;
    visible.push(exchange.items[cursor++]);
  }
  return visible;
}

/** Check the covered history before automatically compacting an approval group. */
export function hasCompleteApprovalGroups(items: AgentInputItem[]): boolean {
  const pending = new Map<string, number>();
  for (const item of items) {
    if (
      item.type !== 'function_call' &&
      item.type !== 'function_call_result' &&
      item.type !== 'hosted_tool_call'
    ) {
      continue;
    }
    const call = getToolResultCorrelationForCall(item);
    const correlation = call ?? getToolResultCorrelationForResult(item);
    if (!correlation) continue;

    const key = getToolResultCorrelationKey(correlation);
    const count = pending.get(key) ?? 0;
    if (call) {
      pending.set(key, count + 1);
    } else if (count === 0) {
      return false;
    } else if (count === 1) {
      pending.delete(key);
    } else {
      pending.set(key, count - 1);
    }
  }
  return pending.size === 0;
}

export function normalizeItemsForSessionPersistence(
  items: AgentInputItem[],
): AgentInputItem[] {
  return deduplicateAgentInputItemsPreferringLatest(
    items.map((item) => sanitizeValueForSession(stripTransientCallIds(item))),
  );
}

/** Verifies a terminal string against the model-visible result retained by the Session. */
export function storedToolOutputMatches(
  selected: FunctionCallResultItem['output'],
  stored: FunctionCallResultItem['output'],
  finalOutput: string,
  isMcpTool: boolean,
  hasOutputSchema: boolean,
): boolean {
  if (!Array.isArray(stored)) {
    if (Array.isArray(selected)) return false;
    const text =
      typeof stored === 'string'
        ? stored
        : stored.type === 'text'
          ? stored.text
          : undefined;
    if (text === undefined) return false;
    if (!hasOutputSchema) return text === finalOutput;
    // Schema-backed results store JSON. Apply the same terminal formatter to its value.
    try {
      return toSmartString(JSON.parse(text)) === finalOutput;
    } catch {
      return false;
    }
  }

  if (
    !Array.isArray(selected) ||
    !sessionValuesMatch(
      selected.map(canonicalStoredBlock),
      stored.map(canonicalStoredBlock),
    )
  )
    return false;

  let original: unknown;
  try {
    original = JSON.parse(finalOutput);
  } catch {
    return false;
  }
  if (toSmartString(original) !== finalOutput) return false;
  // The MCP adapter returns content[0] for a single block. Generic function tools can
  // return either a single block or a one-element list with the same model-visible content.
  if (isMcpTool && stored.length === 1 && Array.isArray(original)) return false;
  const blocks: unknown[] = Array.isArray(original) ? original : [original];
  if (!blocks.length || blocks.length !== stored.length) return false;
  return blocks.every((block, index) =>
    structuredBlockMatches(block, stored[index]),
  );
}

function structuredBlockMatches(
  block: unknown,
  stored: ToolCallStructuredOutput,
): boolean {
  const projection = projectStructuredToolOutput(block, (data) => {
    // The SDK string contains a byte preview. Only Session bytes can witness that preview.
    if (!data.startsWith('[byte array ')) return data;
    const inline =
      stored.type === 'input_image'
        ? stored.image
        : stored.type === 'input_file'
          ? stored.file
          : undefined;
    if (typeof inline === 'string' && inline !== data) {
      try {
        const bytes = decodeBase64ToUint8Array(
          inline.replace(/^data:[^,]*;base64,/, ''),
        );
        if (toSmartString(bytes) === data)
          return encodeUint8ArrayToBase64(bytes);
      } catch {
        // The prefix can also occur in literal data.
      }
    }
    return data;
  });
  return (
    projection !== null &&
    !projection.hasUnrepresentedFields &&
    sessionValuesMatch(
      canonicalStoredBlock(projection.item),
      canonicalStoredBlock(stored),
    )
  );
}

// Conversations reads HTTP file URLs back as { url }. Preserve the exact URL and all metadata.
function canonicalStoredBlock(
  block: ToolCallStructuredOutput,
): ToolCallStructuredOutput {
  if (
    block.type === 'input_file' &&
    typeof block.file === 'string' &&
    (block.file.startsWith('https://') || block.file.startsWith('http://'))
  ) {
    return { ...block, file: { url: block.file } };
  }
  return block;
}

function sessionValuesMatch(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(sortSessionReconciliationValue(left)) ===
    JSON.stringify(sortSessionReconciliationValue(right))
  );
}

export function sessionItemArraysMatch(
  items: AgentInputItem[],
  expected: AgentInputItem[],
): boolean {
  return (
    items.length === expected.length &&
    agentItemRangeMatches(items, expected, 0)
  );
}

export function agentItemRangeMatches(
  items: AgentInputItem[],
  expected: AgentInputItem[],
  start: number,
): boolean {
  if (start < 0 || start + expected.length > items.length) {
    return false;
  }
  return expected.every((item, offset) =>
    sessionValuesMatch(items[start + offset], item),
  );
}

type SessionBinaryContext = {
  mediaType?: string;
};

function sanitizeValueForSession(
  value: AgentInputItem,
  context?: SessionBinaryContext,
): AgentInputItem;
function sanitizeValueForSession(
  value: unknown,
  context?: SessionBinaryContext,
): unknown;
function sanitizeValueForSession(
  value: unknown,
  context: SessionBinaryContext = {},
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  const binary = toUint8ArrayFromBinary(value);
  if (binary) {
    return toDataUrlFromBytes(binary, context.mediaType);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValueForSession(entry, context));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const mediaType =
    typeof record.mediaType === 'string' && record.mediaType.length > 0
      ? record.mediaType
      : context.mediaType;

  for (const [key, entry] of Object.entries(record)) {
    const nextContext =
      key === 'data' || key === 'fileData' ? { mediaType } : context;
    result[key] = sanitizeValueForSession(entry, nextContext);
  }

  return result;
}

function toDataUrlFromBytes(bytes: Uint8Array, mediaType?: string): string {
  const base64 = encodeUint8ArrayToBase64(bytes);
  const type =
    mediaType && !mediaType.startsWith('data:') ? mediaType : 'text/plain';
  return `data:${type};base64,${base64}`;
}

function stripTransientCallIds(value: AgentInputItem): AgentInputItem;
function stripTransientCallIds(value: unknown): unknown;
function stripTransientCallIds(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripTransientCallIds(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const isProtocolItem =
    typeof record.type === 'string' && record.type.length > 0;
  const shouldStripId = isProtocolItem && shouldStripIdForProtocolItem(record);
  for (const [key, entry] of Object.entries(record)) {
    if (shouldStripId && key === 'id') {
      continue;
    }
    result[key] = stripTransientCallIds(entry);
  }
  return result;
}

function shouldStripIdForProtocolItem(
  record: Record<string, unknown>,
): boolean {
  switch (record.type) {
    case 'function_call':
    case 'function_call_result':
      return true;
    case 'tool_search_call':
    case 'tool_search_output':
      return hasToolSearchCallId(record);
    default:
      return false;
  }
}

function hasToolSearchCallId(record: Record<string, unknown>): boolean {
  const topLevelCallId = record.call_id ?? record.callId;
  if (typeof topLevelCallId === 'string' && topLevelCallId.length > 0) {
    return true;
  }

  const providerData = isPlainObject(record.providerData)
    ? record.providerData
    : undefined;
  const providerCallId = providerData?.call_id ?? providerData?.callId;
  return typeof providerCallId === 'string' && providerCallId.length > 0;
}

function sortSessionReconciliationValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortSessionReconciliationValue);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortSessionReconciliationValue(value[key])]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
