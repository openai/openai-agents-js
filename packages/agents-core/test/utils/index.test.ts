import { describe, it, expect } from 'vitest';
import * as Utils from '../../src/utils/index';
import { formatInlineData, getInlineMediaType } from '../../src/utils/internal';

describe('utils/index', () => {
  it('toSmartString', () => {
    expect(Utils.toSmartString('foo')).toBe('foo');
  });

  it('keeps inline-data helpers on the internal surface', () => {
    expect('formatInlineData' in Utils).toBe(false);
    expect('getInlineMediaType' in Utils).toBe(false);
    expect(formatInlineData('YWJj', 'image/png')).toBe(
      'data:image/png;base64,YWJj',
    );
    expect(getInlineMediaType({ mimeType: 'image/png' })).toBe('image/png');
  });
});
