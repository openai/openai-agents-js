import { deepStrictEqual } from 'node:assert';
import { describe, expect, it } from 'vitest';
import {
  decode,
  decodePlainRunObject,
  jsonObject,
} from '../src/runtime/binding';

function outcome(read: () => unknown) {
  try {
    return { accepted: true, value: read() };
  } catch (error) {
    const fault = error as Error & { issues?: unknown };
    return {
      accepted: false,
      name: fault.name,
      message: fault.message,
      issues: fault.issues,
    };
  }
}

const canonical = (source: string) => decode(jsonObject, source);

describe('private plain-run eager JSON decoding', () => {
  it.each([
    '{}',
    '{"nested":{"values":[null,true,false,0,1.5,"text"]}}',
    '{"unicode":"\\u2603\\ud800","escaped":"line\\nnext"}',
    '{"key":1,"key":2,"3":"three","1":"one"}',
    '{"number":-0,"exponent":1e100}',
    '{"__proto__":{"hidden":1},"visible":2}',
    '{"nested":{"__proto__":{"hidden":1e400},"visible":2}}',
    '{"constructor":{"prototype":{"value":1}},"prototype":3}',
    '{"toString":"text","hasOwnProperty":false,"values":[{"__proto__":null}]}',
    '{"nested":[{"constructor":null},{"prototype":{"constructor":7}}]}',
  ])('matches canonical owned data and key normalization: %s', (source) => {
    const expected = canonical(source);
    const actual = decodePlainRunObject(source);
    deepStrictEqual(canonical(source), expected);
    deepStrictEqual(actual, expected);
    expect(Reflect.ownKeys(actual)).toStrictEqual(Reflect.ownKeys(expected));
    expect(Object.getPrototypeOf(actual)).toBe(Object.prototype);
  });

  it.each([
    '{',
    '{"x":1} trailing',
    'null',
    '[]',
    '"text"',
    '7',
    'true',
    '{"overflow":1e400}',
    '{"nested":[-1e400]}',
    '1e400',
  ])('preserves eager canonical errors: %s', (source) => {
    const expected = outcome(() => canonical(source));
    expect(expected.accepted).toBe(false);
    expect(outcome(() => decodePlainRunObject(source))).toStrictEqual(expected);
  });

  it('preserves negative zero and independent fresh nested ownership', () => {
    const source = '{"zero":-0,"nested":{"value":1,"items":[2]}}';
    const first = decodePlainRunObject(source);
    const second = decodePlainRunObject(source);
    expect(Object.is(first.zero, -0)).toBe(true);
    expect(first).not.toBe(second);
    expect(first.nested).not.toBe(second.nested);
    const nested = first.nested as { value: number; items: number[] };
    const independent = second.nested as { value: number; items: number[] };
    expect(nested.items).not.toBe(independent.items);
    nested.value = 3;
    nested.items.push(4);
    expect(independent).toStrictEqual({ value: 1, items: [2] });
  });

  it('ignores an inherited enumerable addition like the canonical own-key record', () => {
    const key = '__plainRunInheritedFixture';
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
    let expected: unknown;
    let actual: unknown;
    try {
      Object.defineProperty(Object.prototype, key, {
        value: 'inherited',
        enumerable: true,
        configurable: true,
      });
      expected = canonical('{"visible":1}');
      actual = decodePlainRunObject('{"visible":1}');
    } finally {
      if (previous) Object.defineProperty(Object.prototype, key, previous);
      else Reflect.deleteProperty(Object.prototype, key);
    }
    expect(actual).toStrictEqual(expected);
    expect(Object.hasOwn(actual as object, key)).toBe(false);
  });
});
