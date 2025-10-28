import { describe, it, expect } from 'vitest';

import { encodeUint8ArrayToBase64 } from '../../src/utils/base64';

describe('encodeUint8ArrayToBase64', () => {
  it('returns an empty string for empty input', () => {
    expect(encodeUint8ArrayToBase64(new Uint8Array())).toBe('');
  });

  it('encodes ASCII data into base64', () => {
    const bytes = new TextEncoder().encode('hello world');
    expect(encodeUint8ArrayToBase64(bytes)).toBe('aGVsbG8gd29ybGQ=');
  });

  it('encodes arbitrary binary data', () => {
    const bytes = new Uint8Array([0, 255, 34, 17, 128, 64]);
    expect(encodeUint8ArrayToBase64(bytes)).toBe('AP8iEYBA');
  });
});
