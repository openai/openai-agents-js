/**
 * Encode a Uint8Array into a base64 string in both Node and browser environments.
 */
export function encodeUint8ArrayToBase64(data: Uint8Array): string {
  if (data.length === 0) {
    return '';
  }

  const globalBuffer =
    typeof globalThis !== 'undefined' && (globalThis as any).Buffer
      ? (globalThis as any).Buffer
      : undefined;

  if (globalBuffer) {
    return globalBuffer.from(data).toString('base64');
  }

  let binary = '';
  for (let i = 0; i < data.length; i += 1) {
    binary += String.fromCharCode(data[i]);
  }

  if (typeof (globalThis as any).btoa === 'function') {
    return (globalThis as any).btoa(binary);
  }

  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let result = '';
  let i = 0;

  while (i < binary.length) {
    const c1 = binary.charCodeAt(i++);
    const c2 = binary.charCodeAt(i++);
    const c3 = binary.charCodeAt(i++);

    const enc1 = c1 >> 2;
    const enc2 = ((c1 & 0x3) << 4) | (c2 >> 4);
    const enc3 = isNaN(c2) ? 64 : ((c2 & 0xf) << 2) | (c3 >> 6);
    const enc4 = isNaN(c3) ? 64 : c3 & 0x3f;

    result +=
      chars.charAt(enc1) +
      chars.charAt(enc2) +
      chars.charAt(enc3) +
      chars.charAt(enc4);
  }

  return result;
}

/**
 * Decode a base64 string into a Uint8Array in both Node and browser environments.
 */
export function decodeBase64ToUint8Array(value: string): Uint8Array {
  if (value.length === 0) {
    return new Uint8Array();
  }

  const globalBuffer =
    typeof globalThis !== 'undefined' && (globalThis as any).Buffer
      ? (globalThis as any).Buffer
      : undefined;

  if (globalBuffer) {
    return Uint8Array.from(globalBuffer.from(value, 'base64'));
  }

  if (typeof (globalThis as any).atob === 'function') {
    const binary = (globalThis as any).atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const normalized = value.replace(/[\t\n\f\r ]/g, '');
  if (normalized.length % 4 === 1) {
    throw new TypeError('Invalid base64 string.');
  }

  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  );
  const padding = padded.endsWith('==') ? 2 : padded.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((padded.length / 4) * 3 - padding);
  let outputIndex = 0;

  for (let index = 0; index < padded.length; index += 4) {
    const enc1 = chars.indexOf(padded[index]);
    const enc2 = chars.indexOf(padded[index + 1]);
    const enc3 =
      padded[index + 2] === '=' ? 64 : chars.indexOf(padded[index + 2]);
    const enc4 =
      padded[index + 3] === '=' ? 64 : chars.indexOf(padded[index + 3]);
    const isFinalGroup = index + 4 === padded.length;

    if (
      enc1 < 0 ||
      enc2 < 0 ||
      enc3 < 0 ||
      enc4 < 0 ||
      (!isFinalGroup && (enc3 === 64 || enc4 === 64)) ||
      (enc3 === 64 && enc4 !== 64)
    ) {
      throw new TypeError('Invalid base64 string.');
    }

    bytes[outputIndex++] = (enc1 << 2) | (enc2 >> 4);
    if (enc3 !== 64) {
      bytes[outputIndex++] = ((enc2 & 0xf) << 4) | (enc3 >> 2);
    }
    if (enc4 !== 64) {
      bytes[outputIndex++] = ((enc3 & 0x3) << 6) | enc4;
    }
  }

  return bytes;
}
