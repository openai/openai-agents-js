import { ModelItem, type AgentInputItem } from '@openai/agents-core/types';
import { inlineImageURL } from './input';

function reject(): never {
  throw new TypeError(
    'Migration requires completed text or inline-image history and complete function pairs; pending or unknown effects require MIG.8',
  );
}

function keys(value: object, allowed: readonly string[]) {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    if (key === 'providerData') {
      const record = value as Record<string, unknown>;
      const data = record.providerData;
      // Classic factories retain undefined; Responses retains empty envelopes,
      // duplicate item identity and text presentation data. None may override
      // an item's identity or introduce execution/approval state.
      if (data === undefined) continue;
      if (!data || typeof data !== 'object' || Array.isArray(data)) reject();
      for (const [field, entry] of Object.entries(data)) {
        if (['id', 'type', 'phase'].includes(field) && entry === record[field])
          continue;
        if (
          record.type === 'output_text' &&
          (field === 'annotations' || field === 'logprobs') &&
          Array.isArray(entry)
        )
          continue;
        reject();
      }
      continue;
    }
    reject();
  }
}

/** Snapshot completed classic history without executing or persisting any item. */
export function captureCompletedHistory(
  history: readonly AgentInputItem[],
): AgentInputItem[] {
  if (!Array.isArray(history)) reject();
  const calls = new Map<string, { name: string; namespace?: string }>();
  const seen = new Set<string>();
  const snapshot = Array.from(history, (source) => {
    if (!source || typeof source !== 'object') reject();
    const raw = source as unknown as Record<string, unknown>;
    if (raw.status !== undefined && raw.status !== 'completed') reject();
    const parsed = ModelItem.safeParse(source);
    if (!parsed.success) reject();
    const item = parsed.data;
    if (item.type === undefined || item.type === 'message') {
      keys(
        source,
        item.role === 'assistant'
          ? ['id', 'type', 'role', 'content', 'status', 'phase']
          : ['id', 'type', 'role', 'content'],
      );
      if (calls.size && item.role !== 'assistant') reject();
      if (item.role === 'assistant' && item.status !== 'completed') reject();
      if (Array.isArray(item.content)) {
        for (const [index, part] of item.content.entries()) {
          // Validate original fields too: protocol parsing strips unknown keys.
          const original = (raw.content as object[])[index];
          if (part.type === 'input_image' && item.role === 'user') {
            inlineImageURL(part.image);
            if (part.detail !== undefined && part.detail !== 'auto') reject();
            keys(original, ['type', 'image', 'detail']);
          } else {
            if (part.type !== 'input_text' && part.type !== 'output_text')
              reject();
            keys(original, ['type', 'text']);
          }
        }
      }
      return structuredClone(item);
    }
    if (item.type === 'function_call' || item.type === 'function_call_result') {
      keys(source, [
        'id',
        'type',
        'callId',
        'name',
        'namespace',
        'status',
        item.type === 'function_call' ? 'arguments' : 'output',
      ]);
      if (
        !item.callId ||
        !item.name ||
        (item.namespace !== undefined && item.namespace !== 'functions') ||
        (item.status !== undefined && item.status !== 'completed')
      )
        reject();
      if (item.type === 'function_call') {
        if (seen.has(item.callId)) reject();
        seen.add(item.callId);
        calls.set(item.callId, { name: item.name, namespace: item.namespace });
      } else {
        const call = calls.get(item.callId);
        if (
          !call ||
          call.name !== item.name ||
          call.namespace !== item.namespace
        )
          reject();
        if (typeof item.output !== 'string') {
          const parts = Array.isArray(item.output)
            ? item.output
            : [item.output];
          for (const part of parts) {
            if (part.type !== 'text' && part.type !== 'input_text') reject();
          }
          const original = raw.output;
          for (const part of (Array.isArray(original)
            ? original
            : [original]) as object[])
            keys(part, ['type', 'text']);
        }
        calls.delete(item.callId);
      }
      return structuredClone(item);
    }
    return reject();
  });
  if (calls.size) reject();
  return snapshot;
}
