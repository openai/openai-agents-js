import { describe, expect, it } from 'vitest';
import { imageOutputFromBytes } from '../src/sandbox/internal';

const SVG_BODY = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

function encodeUtf16(source: string): Uint8Array {
  const bytes = new Uint8Array(2 + source.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < source.length; index += 1) {
    const codeUnit = source.charCodeAt(index);
    const offset = 2 + index * 2;
    bytes[offset] = codeUnit & 0xff;
    bytes[offset + 1] = codeUnit >> 8;
  }
  return bytes;
}

describe('sandbox image output boundary', () => {
  it('rejects non-image bytes with a raster image extension', () => {
    expect(() =>
      imageOutputFromBytes(
        'images/fake.png',
        new TextEncoder().encode('not an image'),
      ),
    ).toThrow('Unsupported image format for view_image: images/fake.png');
  });

  it('accepts complete PNG signature bytes with an unrelated extension', () => {
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    expect(imageOutputFromBytes('images/payload.bin', bytes)).toEqual({
      type: 'image',
      image: {
        data: bytes,
        mediaType: 'image/png',
      },
    });
  });

  it.each([
    ['GIF87a', [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]],
    ['GIF89a', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  ])('accepts complete %s signature bytes', (_name, header) => {
    const bytes = Uint8Array.from(header);
    const output = imageOutputFromBytes('images/payload.bin', bytes);

    expect(output.type).toBe('image');
    expect(output.image).toMatchObject({ mediaType: 'image/gif' });
  });

  it.each([
    ['truncated PNG signature', [0x89, 0x50, 0x4e, 0x47]],
    [
      'invalid PNG signature',
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00],
    ],
    ['truncated GIF signature', [0x47, 0x49, 0x46, 0x38]],
    ['invalid GIF version', [0x47, 0x49, 0x46, 0x38, 0x38, 0x61]],
  ])('rejects %s', (_name, header) => {
    expect(() =>
      imageOutputFromBytes('images/payload.bin', Uint8Array.from(header)),
    ).toThrow('Unsupported image format for view_image: images/payload.bin');
  });

  it.each([
    [
      'little-endian BigTIFF',
      [0x49, 0x49, 0x2b, 0x00, 0x08, 0x00, 0x00, 0x00],
    ],
    [
      'big-endian BigTIFF',
      [0x4d, 0x4d, 0x00, 0x2b, 0x00, 0x08, 0x00, 0x00],
    ],
  ])('accepts %s bytes without relying on the filename', (_name, header) => {
    const bytes = Uint8Array.from(header);
    const output = imageOutputFromBytes('images/payload.bin', bytes);

    expect(output.type).toBe('image');
    expect(output.image).toMatchObject({ mediaType: 'image/tiff' });
  });

  it.each([
    ['truncated little-endian header', [0x49, 0x49, 0x2b, 0x00]],
    ['truncated big-endian header', [0x4d, 0x4d, 0x00, 0x2b]],
    [
      'invalid little-endian offset size',
      [0x49, 0x49, 0x2b, 0x00, 0x04, 0x00, 0x00, 0x00],
    ],
    [
      'invalid big-endian reserved field',
      [0x4d, 0x4d, 0x00, 0x2b, 0x00, 0x08, 0x00, 0x01],
    ],
  ])('rejects %s as BigTIFF', (_name, header) => {
    expect(() =>
      imageOutputFromBytes('images/payload.bin', Uint8Array.from(header)),
    ).toThrow('Unsupported image format for view_image: images/payload.bin');
  });

  it.each([
    [
      'comment',
      new TextEncoder().encode(`<!-- generated -->\n${SVG_BODY}`),
    ],
    [
      'doctype',
      new TextEncoder().encode(
        `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd">\n${SVG_BODY}`,
      ),
    ],
    [
      'long comment',
      new TextEncoder().encode(`<!--${'x'.repeat(4096)}-->\n${SVG_BODY}`),
    ],
    ['utf16', encodeUtf16(SVG_BODY)],
  ])('preserves SVG filename compatibility for %s content', (_name, bytes) => {
    const output = imageOutputFromBytes('images/vector.svg', bytes);

    expect(output.type).toBe('image');
    expect(output.image).toMatchObject({ mediaType: 'image/svg+xml' });
  });

  it('preserves compressed SVGZ filename compatibility', () => {
    const gzipBytes = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]);

    const output = imageOutputFromBytes('images/vector.svgz', gzipBytes);

    expect(output.type).toBe('image');
    expect(output.image).toMatchObject({ mediaType: 'image/svg+xml' });
  });
});
