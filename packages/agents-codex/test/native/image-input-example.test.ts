import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { imageMessage } from '../../../../examples/codex/image-input';
import { nativeInput } from '../../src/runtime/input';

describe('image input example without an addon', () => {
  it('converts the actual message in order with default image detail', () => {
    const message = imageMessage();
    expect(message).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'What is the dominant color in this image?',
        },
        { type: 'input_image', detail: 'auto' },
      ],
    });
    const input = nativeInput(message);
    expect(input).toEqual([
      { type: 'text', text: 'What is the dominant color in this image?' },
      {
        type: 'image',
        image_url: expect.stringMatching(/^data:image\/png;base64,/),
      },
    ]);
    // Decode the fixed fixture independently of the message constructor.
    const image = input[1];
    if (!image || typeof image !== 'object' || Array.isArray(image))
      throw new Error('Expected an image input object');
    const png = Buffer.from(String(image.image_url).split(',')[1], 'base64');
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(png.subarray(12, 16).toString()).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(1);
    expect(png.readUInt32BE(20)).toBe(1);
    expect(png.subarray(24, 29)).toEqual(Buffer.from([8, 2, 0, 0, 0]));
    const chunks: Buffer[] = [];
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      if (png.subarray(offset + 4, offset + 8).toString() === 'IDAT')
        chunks.push(png.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    expect(inflateSync(Buffer.concat(chunks))).toEqual(
      Buffer.from([0, 255, 0, 0]),
    );
  });
});
