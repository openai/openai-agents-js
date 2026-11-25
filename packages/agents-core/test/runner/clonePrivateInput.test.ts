import { describe, expect, it } from 'vitest';
import { captureInputOccurrence } from '../../src/runner/clonePrivateInput';

const clonePrivateInput = <T>(input: T) => captureInputOccurrence(input)();

describe('captureInputOccurrence', () => {
  it('captures the input once and isolates every later read', () => {
    const source = { content: [{ text: 'original' }] };
    const read = captureInputOccurrence(source);
    source.content[0].text = 'caller edit';
    const first = read();
    expect(first.content[0].text).toBe('original');
    first.content[0].text = 'first edit';
    const second = read();
    expect(second.content[0].text).toBe('original');
    second.content[0].text = 'second edit';
    expect(read().content[0].text).toBe('original');
  });

  it('creates own array indices without invoking inherited numeric setters', () => {
    const input = structuredClone([1, 2, 3, 4, { value: 'text' }, 6]);
    let writes = 0;
    let output: typeof input;
    Object.defineProperty(Array.prototype, '4', {
      configurable: true,
      set() {
        writes++;
      },
    });
    try {
      output = clonePrivateInput(input);
    } finally {
      delete (Array.prototype as unknown as Record<string, unknown>)['4'];
    }
    expect(writes).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(output!, '4')).toBe(true);
    expect(output!).toEqual(input);
    expect(output![4]).not.toBe(input[4]);
  });

  it('detaches common text and provider metadata without fixing key order', () => {
    const input = structuredClone({
      providerData: { extra: true, count: 2, optional: undefined },
      content: [{ text: 'hello', annotations: [], type: 'output_text' }],
      role: 'assistant',
      status: 'completed',
    });
    const output = clonePrivateInput(input);
    expect(output).toEqual(structuredClone(input));
    expect(Object.keys(output)).toEqual(Object.keys(input));
    output.content[0].text = 'changed';
    output.providerData.count = 3;
    expect(input.content[0].text).toBe('hello');
    expect(input.providerData.count).toBe(2);
  });

  it('preserves aliases and cycles through native fallback', () => {
    const shared = { value: 'same' };
    const input = structuredClone({ first: shared, second: shared }) as {
      first: typeof shared;
      second: typeof shared;
      self?: unknown;
    };
    input.self = input;
    const output = clonePrivateInput(input);
    expect(output).not.toBe(input);
    expect(output.first).toBe(output.second);
    expect(output.self).toBe(output);
    output.first.value = 'changed';
    expect(input.first.value).toBe('same');
  });

  it('preserves sparse arrays and special provider values through fallback', () => {
    const sparse = Object.assign(new Array(3), { 2: 'last', extra: 'field' });
    const input = structuredClone({
      date: new Date(0),
      map: new Map([['key', { value: 'text' }]]),
      data: new Uint8Array([1, 2]),
      sparse,
    });
    const output = clonePrivateInput(input);
    expect(output).toEqual(structuredClone(input));
    expect(0 in output.sparse).toBe(false);
    output.data[0] = 9;
    expect(input.data[0]).toBe(1);
  });

  it('preserves own __proto__, scalar values and exceptional numbers', () => {
    const input = structuredClone(
      JSON.parse(
        '{"__proto__":{"value":"own"},"role":"user","content":"text"}',
      ),
    );
    const output = clonePrivateInput(input);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(output, '__proto__')).toBe(
      true,
    );
    expect(output).toEqual(input);
    const scalars = structuredClone({
      zero: -0,
      nan: NaN,
      infinity: Infinity,
      big: 1n,
      nil: null,
    });
    expect(clonePrivateInput(scalars)).toEqual(structuredClone(scalars));
    expect(Object.is(clonePrivateInput({ zero: -0 }).zero, -0)).toBe(true);
  });
});
