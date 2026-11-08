import assert from 'node:assert/strict';
import { describe, expect, it, vi } from 'vitest';
import { nativeEventSchema, parseEvent } from '../../src/runtime/events';
import { encodeReceipt, parseNative } from '../../src/runtime/binding';

describe('native receipt identity', () => {
  it('retains the exact managed generation and leaves same-named caller fields unchanged', () => {
    const event = parseEvent(
      '{"id":"c1","msg":{"type":"dynamic_tool_call_request","turnId":"t1","callId":"c1","tool":"work","arguments":{"generation":-2,"nonce":"not-an-id","delivery":1.5},"_sdk_python_tool":{"thread":"root","generation":18446744073709551614,"slot":0}}}',
    );
    expect(event.msg._sdk_python_tool?.generation).toBe('18446744073709551614');
    expect(event.msg.arguments).toEqual({
      generation: -2,
      nonce: 'not-an-id',
      delivery: 1.5,
    });
    const reply = encodeReceipt({
      request: event.msg,
      response: {
        success: true,
        contentItems: [{ type: 'inputText', text: 'recorded' }],
      },
    });
    expect(reply).toContain('"generation":18446744073709551614');
    expect(reply).toContain(
      '"arguments":{"generation":-2,"nonce":"not-an-id","delivery":1.5}',
    );
  });
  it('rejects malformed receipt integers before dispatch', () => {
    expect(() =>
      parseEvent(
        '{"id":"c","msg":{"type":"dynamic_tool_call_request","_sdk_python_tool":{"thread":"t","generation":-1,"slot":0}}}',
      ),
    ).toThrow('Invalid native receipt');
  });
});

describe('exact root text event decoding', () => {
  const text = {
    id: 'turn',
    msg: {
      type: 'agent_message_content_delta',
      thread_id: 'root',
      turn_id: 'turn',
      item_id: 'message',
      delta: 'Hello 雪🙂 "quoted" \\ slash\n',
    },
  };
  const wire = JSON.stringify(text);
  const generic = (source: string) =>
    nativeEventSchema.parse(parseNative(source));
  // Compare prototype data and descriptors, including fresh JSON-derived
  // prototypes, without requiring object key order or clone identity.
  function comparable(value: unknown): unknown {
    if (
      value === null ||
      typeof value !== 'object' ||
      value === Object.prototype ||
      value === Array.prototype
    )
      return value;
    return [
      comparable(Object.getPrototypeOf(value)),
      new Map(
        Reflect.ownKeys(value).map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          return [
            key,
            'value' in descriptor
              ? [
                  'data',
                  descriptor.enumerable,
                  descriptor.configurable,
                  descriptor.writable,
                  comparable(descriptor.value),
                ]
              : [
                  'accessor',
                  descriptor.enumerable,
                  descriptor.configurable,
                  descriptor.get,
                  descriptor.set,
                ],
          ];
        }),
      ),
    ];
  }
  const outcome = (parse: (source: string) => unknown, source: string) => {
    try {
      return { value: parse(source) };
    } catch (error) {
      const failure = error as Error & { issues?: unknown };
      return {
        error: failure.constructor,
        message: failure.message,
        ...(failure.issues === undefined ? {} : { issues: failure.issues }),
      };
    }
  };
  const same = (source: string) =>
    assert.deepStrictEqual(
      comparable(outcome(parseEvent, source)),
      comparable(outcome(generic, source)),
    );

  it.each(['', text.msg.delta, 'generation:18446744073709551615 nonce:1e500'])(
    'preserves exact string values and text chunks: %s',
    (delta) => {
      const source = JSON.stringify({ ...text, msg: { ...text.msg, delta } });
      same(source);
      expect(parseEvent(source).msg.delta).toBe(delta);
    },
  );

  it('keeps reordered, escaped and duplicate JSON fields equivalent', () => {
    same(wire.replace('"delta":', '"delt\\u0061":'));
    same(wire.replace('"id":"turn"', '"id":"ignored","id":"turn"'));
    same(
      JSON.stringify({
        msg: {
          delta: 'reordered',
          item_id: 'i',
          turn_id: 't',
          thread_id: 'r',
          type: text.msg.type,
        },
        id: 't',
      }),
    );
  });

  it('falls back without losing exact authority or unknown payloads', () => {
    const source = wire.replace(
      '"id":',
      '"subagent_id":"child","subagent_instance_id":18446744073709551614,"future_envelope":{"retained":true},"id":',
    );
    same(source);
    expect(parseEvent(source).subagent_instance_id).toBe(
      '18446744073709551614',
    );
    const escaped = wire.replace(
      '"id":',
      '"gener\\u0061tion":18446744073709551615,"id":',
    );
    same(escaped);
    expect(parseEvent(escaped).generation).toBe('18446744073709551615');
  });

  it('parses canonical native child text once and retains its exact instance', () => {
    // Native child metadata follows msg; preserve its numeric wire authority.
    const source =
      '{"id":"turn","msg":' +
      JSON.stringify({
        delta: text.msg.delta,
        item_id: 'message',
        thread_id: 'child',
        turn_id: 'turn',
        type: text.msg.type,
      }) +
      ',"subagent_id":"child","subagent_instance_id":18446744073709551614}';
    const expected = generic(source);
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const actual = parseEvent(source);
      expect(parse).toHaveBeenCalledTimes(1);
      assert.deepStrictEqual(comparable(actual), comparable(expected));
      expect(actual.subagent_instance_id).toBe('18446744073709551614');
    } finally {
      parse.mockRestore();
    }
  });

  it('keeps managed markers and own prototype-named JSON on the original path', () => {
    const source = wire.replace(
      '"delta":',
      '"__proto__":{"polluted":true},"constructor":{"prototype":{"data":1}},"_sdk_python_tool":{"thread":"root","generation":18446744073709551614,"slot":0,"future_marker":"stripped"},"delta":',
    );
    same(source);
    const event = parseEvent(source);
    expect(event.msg._sdk_python_tool?.generation).toBe('18446744073709551614');
    expect(event.msg._sdk_python_tool).not.toHaveProperty('future_marker');
    expect(Object.hasOwn(event.msg, '__proto__')).toBe(false);
    assert.deepStrictEqual(event.msg.constructor, { prototype: { data: 1 } });
  });

  it.each(['-0', '-1', '1.0', '1e0', '1e500'])(
    'retains the exact authority-token error for %s',
    (token) => {
      const source = wire.replace('"id":', `"generation":${token},"id":`);
      same(source);
      expect(() => parseEvent(source)).toThrow(TypeError);
    },
  );

  it.each([
    wire.replace('"delta":' + JSON.stringify(text.msg.delta), '"delta":1e500'),
    wire.replace('"thread_id":"root"', '"thread_id":7'),
    wire.replace(
      '"delta":',
      '"future_payload":{"generation":-2,"delivery":1.5},"delta":',
    ),
    wire.replace('"id":"turn"', '"id":null'),
    wire.slice(0, -2),
  ])('retains generic values or complete errors for nonmatching input', same);

  it('uses the original path when the literal tag is outside the bounded prefix', () => {
    const source = JSON.stringify({
      id: 'turn',
      msg: {
        delta: 'x'.repeat(2048),
        item_id: 'message',
        thread_id: 'root',
        turn_id: 'turn',
        type: text.msg.type,
      },
    });
    same(source);
    expect(parseEvent(source).msg.delta).toHaveLength(2048);
  });
});
