import { describe, test, expect } from 'vitest';
import { toSmartString } from '../../src/utils/smartString';

describe('toSmartString()', () => {
  test('should convert null to string', () => {
    expect(toSmartString(null)).toBe('null');
  });
  test('should convert undefined to string', () => {
    expect(toSmartString(undefined)).toBe('undefined');
  });
  test('should convert string to string', () => {
    expect(toSmartString('test')).toBe('test');
  });

  test('should convert number to string', () => {
    expect(toSmartString(123)).toBe('123');
  });

  test('should convert boolean to string', () => {
    expect(toSmartString(true)).toBe('true');
  });

  test('should convert an array to string', () => {
    expect(toSmartString([1, 2, 3])).toBe('[1,2,3]');
  });

  test('should convert object to string', () => {
    expect(toSmartString({ foo: 'bar' })).toBe(JSON.stringify({ foo: 'bar' }));
  });

  test('should summarize Uint8Array values', () => {
    const bytes = new Uint8Array(25);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i;
    }

    expect(toSmartString(bytes)).toBe(
      '[byte array 0x00 0x01 0x02 0x03 0x04 0x05 0x06 0x07 0x08 0x09 0x0a 0x0b 0x0c 0x0d 0x0e 0x0f 0x10 0x11 0x12 0x13 … (25 bytes)]',
    );
  });

  test('should handle ArrayBuffer values', () => {
    const buffer = new ArrayBuffer(4);
    const view = new Uint8Array(buffer);
    view.set([0xde, 0xad, 0xbe, 0xef]);

    expect(toSmartString(buffer)).toBe(
      '[byte array 0xde 0xad 0xbe 0xef (4 bytes)]',
    );
  });

  test('should replace serialized Buffer snapshots inside objects', () => {
    const data = Array.from({ length: 25 }, (_, i) => i);
    const preview =
      '[byte array 0x00 0x01 0x02 0x03 0x04 0x05 0x06 0x07 0x08 0x09 0x0a 0x0b 0x0c 0x0d 0x0e 0x0f 0x10 0x11 0x12 0x13 … (25 bytes)]';

    expect(
      toSmartString({
        file: {
          data: { type: 'Buffer', data },
          mediaType: 'application/pdf',
          filename: 'report.pdf',
        },
      }),
    ).toBe(
      `{"file":{"data":"${preview}","mediaType":"application/pdf","filename":"report.pdf"}}`,
    );
  });
});
