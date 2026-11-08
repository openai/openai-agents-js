import { describe, expect, it } from 'vitest';
import { parseEvent } from '../../src/runtime/events';
import { encodeReceipt } from '../../src/runtime/binding';

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
  it('roundtrips exact native tool callback and cancellation generations', () => {
    const marker =
      '{"thread":"root","generation":18446744073709551614,"slot":0}';
    const receipt = `{"kind":"tool","request":{"_sdk_python_tool":${marker},"turnId":"t1","callId":"c1"},"invocation":"1"}`;
    const event = parseEvent(
      `{"id":"c1","msg":{"type":"dynamic_tool_call_request","_sdk_python_tool":${marker},"_sdk_callback":${receipt},"arguments":{"_sdk_callback":{"request":{"_sdk_python_tool":{"generation":7}}}}}}`,
    );
    const expected = {
      kind: 'tool',
      request: {
        _sdk_python_tool: {
          thread: 'root',
          generation: '18446744073709551614',
          slot: 0,
        },
        turnId: 't1',
        callId: 'c1',
      },
      invocation: '1',
    };
    expect(event.msg._sdk_python_tool?.generation).toBe('18446744073709551614');
    expect(event.msg._sdk_callback).toEqual(expected);
    expect(event.msg.arguments).toEqual({
      _sdk_callback: { request: { _sdk_python_tool: { generation: 7 } } },
    });
    expect(encodeReceipt(event.msg._sdk_callback)).toBe(receipt);
    const cancelled = parseEvent(
      `{"id":"t1","msg":{"type":"_sdk_callback_cancel","receipt":${receipt}}}`,
    );
    expect(cancelled.msg.receipt).toEqual(expected);
    expect(encodeReceipt(cancelled.msg.receipt)).toBe(receipt);
  });
  it('rejects malformed receipt integers before dispatch', () => {
    expect(() =>
      parseEvent(
        '{"id":"c","msg":{"type":"dynamic_tool_call_request","_sdk_python_tool":{"thread":"t","generation":-1,"slot":0}}}',
      ),
    ).toThrow('Invalid native receipt');
  });
});
