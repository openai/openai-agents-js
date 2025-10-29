const BYTE_PREVIEW_LIMIT = 20;

export function toSmartString(value: unknown): string {
  // Produce a human-friendly string representation while preserving enough detail for debugging workflows.
  if (value === null || value === undefined) {
    return String(value);
  }

  if (isArrayBufferLike(value)) {
    return formatByteArray(new Uint8Array(value));
  }

  if (isArrayBufferView(value)) {
    const view = value as ArrayBufferView;
    return formatByteArray(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, smartStringReplacer);
    } catch (_e) {
      return '[object with circular references]';
    }
  }

  return String(value);
}

export function isArrayBufferLike(value: unknown): value is ArrayBufferLike {
  // Detect raw ArrayBuffer-backed payloads so callers can generate full previews rather than truncated hashes.
  if (value instanceof ArrayBuffer) {
    return true;
  }

  const sharedArrayBufferCtor = (
    globalThis as {
      SharedArrayBuffer?: { new (...args: any[]): ArrayBufferLike };
    }
  ).SharedArrayBuffer;

  return Boolean(
    sharedArrayBufferCtor && value instanceof sharedArrayBufferCtor,
  );
}

export function isArrayBufferView(value: unknown): value is ArrayBufferView {
  // Treat typed array views as binary data for consistent serialization.
  return typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value);
}

export function isSerializedBufferSnapshot(
  value: unknown,
): value is { type: 'Buffer'; data: number[] } {
  // Support serialized Buffer snapshots (e.g., from JSON.parse) emitted by some tool outputs.
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((value as { data?: unknown }).data)
  );
}

export function isNodeBuffer(
  value: unknown,
): value is Uint8Array & { toString(encoding: string): string } {
  // Detect runtime Buffers without importing node-specific shims, handling browser builds gracefully.
  const bufferCtor = (
    globalThis as {
      Buffer?: { isBuffer(input: unknown): boolean };
    }
  ).Buffer;
  return Boolean(
    bufferCtor &&
      typeof bufferCtor.isBuffer === 'function' &&
      bufferCtor.isBuffer(value),
  );
}

function formatByteArray(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return '[byte array (0 bytes)]';
  }

  const previewLength = Math.min(bytes.length, BYTE_PREVIEW_LIMIT);
  const previewParts: string[] = [];

  for (let i = 0; i < previewLength; i++) {
    previewParts.push(formatByte(bytes[i]));
  }

  const ellipsis = bytes.length > BYTE_PREVIEW_LIMIT ? ' …' : '';
  const preview = previewParts.join(' ');

  return `[byte array ${preview}${ellipsis} (${bytes.length} bytes)]`;
}

function formatByte(byte: number): string {
  return `0x${byte.toString(16).padStart(2, '0')}`;
}

function smartStringReplacer(_key: string, nestedValue: unknown): unknown {
  if (isArrayBufferLike(nestedValue)) {
    return formatByteArray(new Uint8Array(nestedValue));
  }

  if (isArrayBufferView(nestedValue)) {
    const view = nestedValue as ArrayBufferView;
    return formatByteArray(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
  }

  if (isSerializedBufferSnapshot(nestedValue)) {
    return formatByteArray(Uint8Array.from(nestedValue.data));
  }

  return nestedValue;
}
