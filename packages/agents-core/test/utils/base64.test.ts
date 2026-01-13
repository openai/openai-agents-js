import { describe, it, expect, vi, afterEach } from 'vitest';

import { encodeUint8ArrayToBase64 } from '../../src/utils/base64';

describe('encodeUint8ArrayToBase64', () => {
  const originalBuffer = (globalThis as any).Buffer;
  const originalBtoa = (globalThis as any).btoa;

  afterEach(() => {
    (globalThis as any).Buffer = originalBuffer;
    (globalThis as any).btoa = originalBtoa;
  });

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

  it('uses btoa when Buffer is unavailable', () => {
    (globalThis as any).Buffer = undefined;
    const btoaSpy = vi.fn((input: string) =>
      (originalBuffer as typeof Buffer)
        .from(input, 'binary')
        .toString('base64'),
    );
    (globalThis as any).btoa = btoaSpy;

    const bytes = new Uint8Array([1, 2, 3]);
    const result = encodeUint8ArrayToBase64(bytes);

    expect(result).toBe('AQID');
    expect(btoaSpy).toHaveBeenCalledWith('\u0001\u0002\u0003');
  });

  it('falls back to manual encoding when Buffer and btoa are unavailable', () => {
    (globalThis as any).Buffer = undefined;
    (globalThis as any).btoa = undefined;

    const bytes = new Uint8Array([255, 254, 253]);
    const result = encodeUint8ArrayToBase64(bytes);

    expect(result).toBe(
      (originalBuffer as typeof Buffer).from(bytes).toString('base64'),
    );
  });
});
