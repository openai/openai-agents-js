const BYTE_PREVIEW_LIMIT = 20;

export function toSmartString(value: unknown): string {
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

function isArrayBufferLike(value: unknown): value is ArrayBufferLike {
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

function isArrayBufferView(value: unknown): value is ArrayBufferView {
  return typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value);
}

function isSerializedBufferSnapshot(
  value: unknown,
): value is { type: 'Buffer'; data: number[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((value as { data?: unknown }).data)
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
