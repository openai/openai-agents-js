import type { AgentInputItem } from '../types';
import { encodeUint8ArrayToBase64 } from '../utils/base64';
import { toUint8ArrayFromBinary } from '../utils/binary';
import { deduplicateAgentInputItemsPreferringLatest } from './items';

export function normalizeItemsForSessionPersistence(
  items: AgentInputItem[],
): AgentInputItem[] {
  return deduplicateAgentInputItemsPreferringLatest(
    items.map((item) => sanitizeValueForSession(stripTransientCallIds(item))),
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
  return expected.every(
    (item, offset) =>
      getSessionReconciliationItemKey(items[start + offset]) ===
      getSessionReconciliationItemKey(item),
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

function getSessionReconciliationItemKey(item: AgentInputItem): string {
  return JSON.stringify(sortSessionReconciliationValue(item));
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
