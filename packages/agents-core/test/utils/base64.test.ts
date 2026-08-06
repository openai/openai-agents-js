import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  decodeBase64ToUint8Array,
  encodeUint8ArrayToBase64,
} from '../../src/utils/base64';

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

describe('decodeBase64ToUint8Array', () => {
  const originalBuffer = (globalThis as any).Buffer;
  const originalAtob = (globalThis as any).atob;

  afterEach(() => {
    (globalThis as any).Buffer = originalBuffer;
    (globalThis as any).atob = originalAtob;
  });

  it('returns an empty array for empty input', () => {
    expect(decodeBase64ToUint8Array('')).toEqual(new Uint8Array());
  });

  it('decodes ASCII data from base64', () => {
    expect(decodeBase64ToUint8Array('aGVsbG8gd29ybGQ=')).toEqual(
      new TextEncoder().encode('hello world'),
    );
  });

  it('decodes arbitrary binary data', () => {
    expect(decodeBase64ToUint8Array('AP8iEYBA')).toEqual(
      new Uint8Array([0, 255, 34, 17, 128, 64]),
    );
  });

  it('uses atob when Buffer is unavailable', () => {
    (globalThis as any).Buffer = undefined;
    const atobSpy = vi.fn((input: string) =>
      (originalBuffer as typeof Buffer)
        .from(input, 'base64')
        .toString('binary'),
    );
    (globalThis as any).atob = atobSpy;

    expect(decodeBase64ToUint8Array('AQID')).toEqual(new Uint8Array([1, 2, 3]));
    expect(atobSpy).toHaveBeenCalledWith('AQID');
  });

  it('falls back to manual decoding when Buffer and atob are unavailable', () => {
    (globalThis as any).Buffer = undefined;
    (globalThis as any).atob = undefined;

    const cases: Array<[string, number[]]> = [
      ['AA==', [0]],
      ['AP8=', [0, 255]],
      ['AP8i', [0, 255, 34]],
      ['AP8iEQ==', [0, 255, 34, 17]],
    ];

    for (const [value, expected] of cases) {
      expect(decodeBase64ToUint8Array(value)).toEqual(new Uint8Array(expected));
    }
  });
});
