import { describe, expect, test } from 'vitest';
import { formatInlineData, getInlineMediaType } from '../src/utils/inlineData';

describe('inline data utilities', () => {
  test('reads current and legacy media type fields', () => {
    expect(getInlineMediaType({ mediaType: 'image/png' })).toBe('image/png');
    expect(getInlineMediaType({ mimeType: 'image/jpeg' })).toBe('image/jpeg');
    expect(
      getInlineMediaType({
        mediaType: 'image/png',
        mimeType: 'image/jpeg',
      }),
    ).toBe('image/png');
  });

  test('formats strings and bytes without double-encoding data URLs', () => {
    expect(formatInlineData('YWJj', 'image/png')).toBe(
      'data:image/png;base64,YWJj',
    );
    expect(formatInlineData(new Uint8Array([97, 98, 99]), 'image/png')).toBe(
      'data:image/png;base64,YWJj',
    );
    expect(formatInlineData('data:image/png;base64,YWJj', 'image/jpeg')).toBe(
      'data:image/png;base64,YWJj',
    );
  });
});
