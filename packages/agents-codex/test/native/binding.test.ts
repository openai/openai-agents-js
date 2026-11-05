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
  it('rejects malformed receipt integers before dispatch', () => {
    expect(() =>
      parseEvent(
        '{"id":"c","msg":{"type":"dynamic_tool_call_request","_sdk_python_tool":{"thread":"t","generation":-1,"slot":0}}}',
      ),
    ).toThrow('Invalid native receipt');
  });
});
