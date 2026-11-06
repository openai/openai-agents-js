import {
  firstNativeBatchWire,
  replaceSingletonNativeBatchEvent,
} from '../fixtures/native-event-batches';
import { describe, expect, it } from 'vitest';
import {
  parseEvent,
  parseEvents,
  parseCertifiedRootTextEvent,
} from '../../src/runtime/events';
import { encodeReceipt, parseNative } from '../../src/runtime/binding';

describe('native passive batch test boundaries', () => {
  const wire = (msg: Record<string, unknown>, tags = {}) =>
    JSON.stringify({ id: 'turn', msg, ...tags });
  const warning = wire({ type: 'warning', message: 'notice' });
  const text = wire({
    type: 'agent_message_content_delta',
    thread_id: 'root',
    turn_id: 'turn',
    item_id: 'item',
    delta: 'α🙂\0',
  });

  it('accepts mixed passive families without replacing their exact wire strings', () => {
    const messages: Record<string, unknown>[] = [
      ...[
        'agent_message',
        'user_message',
        'agent_reasoning',
        'agent_reasoning_raw_content',
        'agent_reasoning_section_break',
        'mcp_startup_complete',
        'thread_settings_applied',
        'token_count',
      ].map((type) => ({ type })),
      { type: 'raw_response_item', item: { type: 'reasoning' } },
      {
        type: 'raw_response_item',
        item: { type: 'message', role: 'assistant' },
      },
      ...['AgentMessage', 'Reasoning'].map((type) => ({
        type: 'item_started',
        thread_id: 'root',
        turn_id: 'turn',
        item: { type },
      })),
    ];
    for (const msg of messages) {
      const batch = { events: [warning, wire(msg), text], rootTextOnly: false };
      const before = [...batch.events];
      expect(firstNativeBatchWire(batch)).toBe(warning);
      expect(batch.events).toEqual(before);
      expect(batch.rootTextOnly).toBe(false);
    }
    const usage =
      '{"id":"turn","msg":{"type":"token_count","info":{"total_token_usage":{"total_tokens":"9007199254740993"}}}}';
    const batch = { events: [warning, text, usage], rootTextOnly: false };
    firstNativeBatchWire(batch);
    expect(parseEvents(JSON.stringify(batch.events))[2].msg.info).toEqual({
      total_token_usage: { total_tokens: '9007199254740993' },
    });
  });

  it('keeps controls singleton in either position and does not hide later controls', () => {
    for (const type of [
      '_sdk_request_metadata',
      '_sdk_prepare_request',
      'raw_response_completed',
      'item_completed',
      'dynamic_tool_call_request',
      'elicitation_request',
      'error',
      'shutdown_complete',
      'sdk_mcp_publication_boundary',
      'task_complete',
      'unknown_future_kind',
    ]) {
      const control = wire({ type });
      expect(
        firstNativeBatchWire({ events: [control], rootTextOnly: false }),
      ).toBe(control);
      for (const events of [
        [warning, control],
        [control, warning],
      ])
        expect(() =>
          firstNativeBatchWire({ events, rootTextOnly: false }),
        ).toThrow();
    }
    expect(() =>
      replaceSingletonNativeBatchEvent(
        { events: [warning, text], rootTextOnly: false },
        { id: 'turn', msg: { type: 'warning' } },
      ),
    ).toThrow('Projected control must remain a singleton');
  });

  it('rejects foreign roots, turns, threads and every child identity tag', () => {
    const foreign = [
      wire({ type: 'warning' }, { id: 'other' }),
      wire({ type: 'warning' }, { subagent_id: 'child' }),
      wire({ type: 'warning' }, { subagent_incarnation: null }),
      wire({ type: 'warning' }, { subagent_instance_id: '1' }),
      wire({
        type: 'item_started',
        thread_id: 'other',
        turn_id: 'turn',
        item: { type: 'AgentMessage' },
      }),
      wire({
        type: 'item_started',
        thread_id: 'root',
        turn_id: 'other',
        item: { type: 'Reasoning' },
      }),
    ];
    for (const event of foreign)
      expect(() =>
        firstNativeBatchWire({ events: [text, event], rootTextOnly: false }),
      ).toThrow();
  });

  it('rejects effectful raw items and item starts in a passive batch', () => {
    for (const msg of [
      { type: 'raw_response_item', item: { type: 'message', role: 'user' } },
      { type: 'raw_response_item', item: { type: 'function_call' } },
      {
        type: 'item_started',
        thread_id: 'root',
        turn_id: 'turn',
        item: { type: 'WebSearch' },
      },
    ])
      expect(() =>
        firstNativeBatchWire({
          events: [warning, wire(msg)],
          rootTextOnly: false,
        }),
      ).toThrow();
  });

  it('retains UTF-8 byte/count bounds and allows one oversized generic event', () => {
    expect(() =>
      firstNativeBatchWire({ events: [], rootTextOnly: false }),
    ).toThrow();
    expect(() =>
      firstNativeBatchWire({
        events: Array(9).fill(warning),
        rootTextOnly: false,
      }),
    ).toThrow('Native batch count bound');
    const large = wire({ type: 'warning', message: '🙂'.repeat(4096) });
    expect(firstNativeBatchWire({ events: [large], rootTextOnly: false })).toBe(
      large,
    );
    expect(() =>
      firstNativeBatchWire({ events: [warning, large], rootTextOnly: false }),
    ).toThrow('Native batch byte bound');
  });

  it('requires the exact certificate over every entry rather than only slot zero', () => {
    expect(
      firstNativeBatchWire({ events: [text, text], rootTextOnly: true }),
    ).toBe(text);
    const changed = JSON.parse(text);
    changed.msg.extra = 'not certified';
    for (const events of [
      [text, warning],
      [text, JSON.stringify(changed)],
    ])
      expect(() =>
        firstNativeBatchWire({ events, rootTextOnly: true }),
      ).toThrow();
    changed.msg.delta = 7;
    delete changed.msg.extra;
    expect(() =>
      firstNativeBatchWire({
        events: [JSON.stringify(changed)],
        rootTextOnly: true,
      }),
    ).toThrow();
  });
});

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

describe('native-certified root text parsing', () => {
  const text = (itemId: string, delta: string) =>
    JSON.stringify({
      id: 'turn',
      msg: {
        type: 'agent_message_content_delta',
        thread_id: 'root',
        turn_id: 'turn',
        item_id: itemId,
        delta,
      },
    });

  it('preserves every field, changing item IDs, and escaped Unicode text', () => {
    const sources = [
      text('first', 'α🙂'),
      text('second', 'line\nquote"\\slash\0'),
      text('first', ''),
    ];
    const events = sources.map(parseCertifiedRootTextEvent);
    expect(events).toEqual(sources.map(parseEvent));
    expect(events.map((event) => event.msg.item_id)).toEqual([
      'first',
      'second',
      'first',
    ]);
    expect(events.map((event) => event.msg.delta)).toEqual([
      'α🙂',
      'line\nquote"\\slash\0',
      '',
    ]);
    expect(events[0]).not.toBe(events[1]);
    expect(events[0].msg).not.toBe(events[1].msg);
  });

  it('retains ordinary schema validation on the certified path', () => {
    expect(() =>
      parseCertifiedRootTextEvent(
        '{"id":7,"msg":{"type":"agent_message_content_delta"}}',
      ),
    ).toThrow();
    expect(() =>
      parseCertifiedRootTextEvent(
        '{"id":"t","msg":{"type":"agent_message_content_delta","delta":1e500}}',
      ),
    ).toThrow();
    expect(() => parseCertifiedRootTextEvent('{"id":')).toThrow(SyntaxError);
  });

  it('keeps the certificate only while the complete native batch is unchanged', () => {
    const first = text('first', 'α🙂');
    const second = text('second', 'other item');
    expect(
      firstNativeBatchWire({ events: [first, second], rootTextOnly: true }),
    ).toBe(first);
    const original = { events: [first], rootTextOnly: true };
    const projected = replaceSingletonNativeBatchEvent(original, {
      id: 'turn',
      msg: { type: 'warning', message: 'projected' },
    });
    expect(projected.rootTextOnly).toBe(false);
    expect(original).toEqual({ events: [first], rootTextOnly: true });
    expect(parseEvent(projected.events[0]).msg.type).toBe('warning');
  });

  it('keeps generic batch mapping authority-aware at every array index', () => {
    const events = parseEvents(
      JSON.stringify([
        '{"id":"a","nonce":18446744073709551615,"msg":{"type":"warning"}}',
        '{"id":"b","msg":{"type":"dynamic_tool_call_request","_sdk_python_tool":{"thread":"root","generation":18446744073709551614,"slot":0}}}',
      ]),
    );
    expect(events[0].nonce).toBe('18446744073709551615');
    expect(events[1].msg._sdk_python_tool?.generation).toBe(
      '18446744073709551614',
    );
    for (const token of ['-0', '-1', '1e0', '1.0', '1e500'])
      expect(() => parseNative(`{"nonce":${token}}`)).toThrow(
        'Invalid native receipt',
      );
    expect(parseNative('{"arguments":{"nonce":-0,"generation":1e3}}')).toEqual({
      arguments: { nonce: -0, generation: 1000 },
    });
  });

  it('keeps generic restoration reads off certified root text without reading inherited leaves', () => {
    const source = text('first', 'plain text');
    const observe = (parse: (source: string) => unknown) => {
      const trace: string[] = [];
      const savedBudget = Object.getOwnPropertyDescriptor(
        Object.prototype,
        'root_turn_budget',
      );
      const savedGeneration = Object.getOwnPropertyDescriptor(
        Object.prototype,
        'generation',
      );
      try {
        Object.defineProperty(Object.prototype, 'root_turn_budget', {
          configurable: true,
          get() {
            trace.push('budget');
            return {};
          },
        });
        Object.defineProperty(Object.prototype, 'generation', {
          configurable: true,
          get() {
            throw new Error('Inherited authority leaf must not be read');
          },
        });
        return { value: parse(source), trace };
      } finally {
        if (savedBudget)
          Object.defineProperty(
            Object.prototype,
            'root_turn_budget',
            savedBudget,
          );
        else
          delete (Object.prototype as Record<string, unknown>).root_turn_budget;
        if (savedGeneration)
          Object.defineProperty(
            Object.prototype,
            'generation',
            savedGeneration,
          );
        else delete (Object.prototype as Record<string, unknown>).generation;
      }
    };
    const expected = observe(parseEvent);
    expect(expected.trace).not.toHaveLength(0);
    const certified = observe(parseCertifiedRootTextEvent);
    expect(certified.value).toEqual(expected.value);
    expect(certified.trace).toEqual([]);
  });
});
