import { describe, expect, it } from 'vitest';
import { canMatchInputItemsByPosition } from '../../src/shims/shims-node';
import { canMatchInputItemsByPosition as browserMatch } from '../../src/shims/shims-browser';
import { canMatchInputItemsByPosition as workerdMatch } from '../../src/shims/shims-workerd';
import { canMatchInputItemsByPosition as reactNativeMatch } from '../../src/shims/shims-react-native';

describe('positional input matching runtime support', () => {
  it('recognizes unchanged identical roots while validating every occurrence', () => {
    const first = { role: 'user', content: 'same' };
    const second = { role: 'user', content: 'same' };
    const input = [first, second, first, second];
    expect(canMatchInputItemsByPosition(input, input.slice())).toBe(true);
    expect(
      canMatchInputItemsByPosition(input, [
        second,
        { ...second },
        first,
        second,
      ]),
    ).toBe(false);
    const withGetter = {
      get content() {
        throw new Error('unread input getter');
      },
    };
    expect(
      canMatchInputItemsByPosition(
        [first, withGetter, first],
        [first, withGetter, first],
      ),
    ).toBe(false);
  });

  it('recognizes independent unchanged message trees in Node', () => {
    const prepared = [
      { role: 'user', content: 'hello', providerData: { tags: ['a', 'b'] } },
      { role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
    ];
    expect(
      canMatchInputItemsByPosition(prepared, structuredClone(prepared)),
    ).toBe(true);
  });

  it('leaves JSON hooks unread for the existing matcher', () => {
    let reads = 0;
    const prepared = [{ role: 'user', content: 'hello' }];
    Object.defineProperty(prepared[0], 'toJSON', {
      get() {
        reads++;
        throw new Error('JSON hook');
      },
    });
    expect(
      canMatchInputItemsByPosition(prepared, [
        { role: 'user', content: 'hello' },
      ]),
    ).toBe(false);
    expect(reads).toBe(0);
  });

  it.each([
    ['browser', browserMatch],
    ['workerd', workerdMatch],
    ['react-native', reactNativeMatch],
  ] as const)('keeps the existing matcher on %s', (_runtime, match) => {
    const input = [{ role: 'user', content: 'hello' }];
    expect(match(input, structuredClone(input))).toBe(false);
  });
});
