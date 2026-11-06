import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  nativeEventSchema,
  parseCertifiedRootTextEvent,
} from '../../src/runtime/events';
import { parseCertifiedRootText } from '../../src/runtime/binding';

const baseline = (source: string) =>
  nativeEventSchema.parse(parseCertifiedRootText(source));
const event = {
  id: 'turn',
  msg: {
    type: 'agent_message_content_delta',
    thread_id: 'thread',
    turn_id: 'turn',
    item_id: 'item',
    delta: 'text',
  },
};
const source = JSON.stringify(event);

type Parse = (source: string) => unknown;
function observation(parse: Parse, input: string) {
  try {
    const value = parse(input);
    const root = value as Record<string, unknown>;
    const msg = root?.msg;
    return {
      ok: true,
      value,
      rootKeys: Reflect.ownKeys(root),
      rootDescriptors: Object.getOwnPropertyDescriptors(root),
      messageKeys:
        msg !== null && typeof msg === 'object' ? Reflect.ownKeys(msg) : null,
      messageDescriptors:
        msg !== null && typeof msg === 'object'
          ? Object.getOwnPropertyDescriptors(msg)
          : null,
      idRead: root.id,
      messageRead: msg,
    };
  } catch (error) {
    const failure = error as Error & { issues?: unknown };
    return {
      ok: false,
      name: failure.name,
      message: failure.message,
      issues: failure.issues,
    };
  }
}
function compare(input: string) {
  expect(observation(parseCertifiedRootTextEvent, input)).toEqual(
    observation(baseline, input),
  );
}

// Each observation gets the same initial prototype and restores it before any
// Vitest assertion. Setters may add properties such as the old `late` witness.
function withPrototype(
  parse: Parse,
  input: string,
  install: (read: () => void) => void,
) {
  const saved = Object.getOwnPropertyDescriptors(Object.prototype);
  let reads = 0;
  try {
    install(() => reads++);
    const result = observation(parse, input);
    return { result, reads };
  } finally {
    for (const key of Reflect.ownKeys(Object.prototype))
      if (!Object.hasOwn(saved, key))
        Reflect.deleteProperty(Object.prototype, key);
    Object.defineProperties(Object.prototype, saved);
  }
}
function comparePrototype(install: (read: () => void) => void, input = source) {
  expect(withPrototype(parseCertifiedRootTextEvent, input, install)).toEqual(
    withPrototype(baseline, input, install),
  );
}

it('matches both native message orders, reordered roots, data descriptors and text', () => {
  for (const delta of [
    '',
    'plain',
    'quotes " and \\',
    '\0',
    '雪😀\u2028\u2029',
    '\ud800',
  ]) {
    const msg = { ...event.msg, delta };
    compare(JSON.stringify({ id: 'turn', msg }));
    compare(JSON.stringify({ msg, id: 'turn' }));
    compare(
      JSON.stringify({
        id: 'turn',
        msg: {
          delta,
          item_id: 'item',
          thread_id: 'thread',
          turn_id: 'turn',
          type: msg.type,
        },
      }),
    );
  }
  compare(source.replace('"id"', '"\\u0069d"'));
  compare(source.replace('"type"', '"\\u0074ype"'));
  compare(source.replace('"id":"turn"', '"id":"old","id":"turn"'));
  compare(source.replace('"delta":"text"', '"delta":"old","delta":"text"'));
});

it('keeps malformed, missing, extra, non-string and nested values on the original schema', () => {
  for (const input of [
    '',
    '{',
    'null',
    'true',
    '0',
    '[]',
    '{}',
    '{"id":"turn"}',
  ])
    compare(input);
  for (const key of ['id', 'msg']) {
    const root = { ...event } as Record<string, unknown>;
    delete root[key];
    compare(JSON.stringify(root));
  }
  for (const key of ['type', 'thread_id', 'turn_id', 'item_id', 'delta']) {
    const msg = { ...event.msg } as Record<string, unknown>;
    delete msg[key];
    compare(JSON.stringify({ id: 'turn', msg }));
    for (const value of [null, false, 17, [], { nested: ['value'] }])
      compare(
        JSON.stringify({ id: 'turn', msg: { ...event.msg, [key]: value } }),
      );
  }
  compare(JSON.stringify({ ...event, id: '' }));
  for (const key of ['thread_id', 'turn_id', 'item_id'])
    compare(JSON.stringify({ id: 'turn', msg: { ...event.msg, [key]: '' } }));
  for (const value of [null, true, 17, [], { nested: 'value' }]) {
    compare(JSON.stringify({ ...event, id: value }));
    compare(JSON.stringify({ id: 'turn', msg: value }));
    compare(JSON.stringify({ ...event, extra: value }));
    compare(
      JSON.stringify({ id: 'turn', msg: { ...event.msg, extra: value } }),
    );
  }
  compare(
    source.replace('"id":"turn"', '"__proto__":{"owned":true},"id":"turn"'),
  );
  compare(
    source.replace('"delta":"text"', '"delta":"text","nonce":9007199254740993'),
  );
  compare(
    JSON.stringify({ id: 'turn', msg: { ...event.msg, type: 'warning' } }),
  );
});

const metadata: Record<string, unknown> = {
  subagent_id: 'child',
  subagent_instance_id: '0',
  subagent_incarnation: '1',
  subagent_managed_tools: true,
  subagent_turn_failed: true,
  error_affects_turn_status: true,
};
describe.each(Object.entries(metadata))(
  'optional metadata %s',
  (key, value) => {
    it('preserves own values and errors', () => {
      compare(JSON.stringify({ ...event, [key]: value }));
      compare(JSON.stringify({ ...event, [key]: { invalid: true } }));
    });
    it('preserves inherited getter reads and explicit undefined ownership', () => {
      for (const supplied of [value, undefined])
        comparePrototype((read) =>
          Object.defineProperty(Object.prototype, key, {
            configurable: true,
            get() {
              read();
              return supplied;
            },
          }),
        );
      comparePrototype((read) =>
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          get() {
            read();
            throw new Error('inherited optional field');
          },
        }),
      );
    });
  },
);

it('preserves inherited nativeMarker validation and getter reads', () => {
  for (const marker of [
    { thread: 'thread', generation: '0', slot: 0 },
    { thread: 'thread', generation: '-0', slot: 0 },
    undefined,
  ]) {
    compare(
      JSON.stringify({
        id: 'turn',
        msg: { ...event.msg, _sdk_python_tool: marker },
      }),
    );
    comparePrototype((read) =>
      Object.defineProperty(Object.prototype, '_sdk_python_tool', {
        configurable: true,
        get() {
          read();
          return marker;
        },
      }),
    );
  }
});

it.each(['id', 'msg', 'type', 'thread_id', 'turn_id', 'item_id', 'delta'])(
  'preserves nonenumerable %s setters and getters',
  (key) => {
    comparePrototype(() =>
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        set(value: unknown) {
          Object.defineProperty(this, key, {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
          Object.defineProperty(Object.prototype, 'late', {
            value: 17,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        },
      }),
    );
    comparePrototype((read) =>
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() {
          read();
          return 'inherited';
        },
      }),
    );
  },
);

it('preserves unrelated enumerable getters and ignores nonenumerable constructor getters', () => {
  comparePrototype((read) =>
    Object.defineProperty(Object.prototype, 'late', {
      configurable: true,
      enumerable: true,
      get() {
        read();
        return 'application';
      },
    }),
  );
  comparePrototype((read) =>
    Object.defineProperty(Object.prototype, 'constructor', {
      configurable: true,
      get() {
        read();
        return Object;
      },
    }),
  );
});

it('does not read unrelated nonenumerable leaves and retains marker optional reads', () => {
  for (const key of ['constructor', 'nonce', 'budget']) {
    const install = (read: () => void) =>
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() {
          read();
          throw new Error('unrelated inherited field');
        },
      });
    const expected = withPrototype(baseline, source, install);
    const actual = withPrototype(parseCertifiedRootTextEvent, source, install);
    expect(actual).toEqual(expected);
    expect(actual.reads).toBe(0);
  }
  const markerSource = JSON.stringify({
    id: 'turn',
    msg: {
      ...event.msg,
      _sdk_python_tool: { thread: 'thread', generation: '0', slot: 0 },
    },
  });
  for (const key of ['manual_grant', 'instance'])
    comparePrototype(
      (read) =>
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          get() {
            read();
            return 'marker-value';
          },
        }),
      markerSource,
    );
});

it('keeps formatter paths and exact issues on invalid fallback values', () => {
  const previous = z.config().customError;
  try {
    z.config({
      customError: (issue) =>
        `custom ${issue.code} at ${JSON.stringify(issue.path ?? [])}`,
    });
    compare(source.replace('"delta":"text"', '"delta":"text","extra":1e500'));
    compare(JSON.stringify({ ...event, subagent_managed_tools: 'invalid' }));
    compare(
      JSON.stringify({
        id: 'turn',
        msg: { ...event.msg, _sdk_python_tool: { generation: '-0' } },
      }),
    );
  } finally {
    z.config({ customError: previous });
  }
});

it('preserves input order visible to inherited marker getters', () => {
  const typeLast = JSON.stringify({
    id: 'turn',
    msg: {
      delta: 'text',
      item_id: 'item',
      thread_id: 'thread',
      turn_id: 'turn',
      type: event.msg.type,
    },
  });
  const install = () =>
    Object.defineProperty(Object.prototype, '_sdk_python_tool', {
      configurable: true,
      get() {
        return {
          thread: 'thread',
          generation: Object.keys(this)[0] === 'type' ? '-0' : '0',
          slot: 0,
        };
      },
    });
  const original = withPrototype(baseline, typeLast, install);
  const reordered = withPrototype(baseline, source, install);
  expect(original.result.ok).toBe(true);
  expect(reordered.result.ok).toBe(false);
  expect(withPrototype(parseCertifiedRootTextEvent, typeLast, install)).toEqual(
    original,
  );
  expect(withPrototype(parseCertifiedRootTextEvent, source, install)).toEqual(
    reordered,
  );
});

it('copies an ordinary result retained by a JSON.parse wrapper', () => {
  const descriptor = Object.getOwnPropertyDescriptor(JSON, 'parse')!;
  const originalParse = JSON.parse;
  let retained: unknown;
  let result: ReturnType<typeof parseCertifiedRootTextEvent> | undefined;
  let calls = 0;
  try {
    JSON.parse = (...args: Parameters<typeof originalParse>) => {
      calls++;
      const value = originalParse(...args);
      retained = value;
      return value;
    };
    result = parseCertifiedRootTextEvent(source);
  } finally {
    Object.defineProperty(JSON, 'parse', descriptor);
  }
  if (result === undefined) throw new Error('Missing parser result');
  expect(calls).toBe(1);
  const parsed = retained as typeof event;
  expect(result).not.toBe(parsed);
  expect(result.msg).not.toBe(parsed.msg);
  parsed.id = 'changed-turn';
  parsed.msg.delta = 'changed-text';
  parsed.msg.item_id = 'changed-item';
  expect(result.id).toBe('turn');
  expect(result.msg.delta).toBe('text');
  expect(result.msg.item_id).toBe('item');
});
