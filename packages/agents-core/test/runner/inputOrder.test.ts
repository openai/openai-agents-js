import { describe, expect, it } from 'vitest';
import { createSessionPersistenceTracker } from '../../src/runner/sessionPersistence';
import { matchesOwnedHistory } from '../../src/shims/inputOrder-node';
import type { AgentInputItem } from '../../src/types';
import { Agent, Runner } from '../../src';
import {
  assistantMessage,
  modelResponder,
  ScriptedModel,
} from '../../src/testing';

function message(text: string): AgentInputItem {
  return {
    role: 'assistant',
    content: [{ type: 'output_text', text }],
    status: 'completed',
  };
}

function begin(input: AgentInputItem[]) {
  const tracker = createSessionPersistenceTracker({
    hasCallModelInputFilter: false,
  })!;
  tracker.setPreparedItems(undefined, input);
  return tracker;
}

describe('ownership of a complete input history', () => {
  it.each(['value', 'get'] as const)(
    'declines inherited descriptor %s before reading detectors',
    (key) => {
      const input = [message('prior')];
      const prepared = structuredClone(input);
      const prior = Object.getOwnPropertyDescriptor(Object.prototype, key);
      let reads = 0;
      Object.defineProperty(
        Object.prototype,
        key,
        Object.assign(Object.create(null), {
          configurable: true,
          get() {
            reads++;
            return Function.prototype[Symbol.hasInstance];
          },
        }),
      );
      let accepted = false;
      try {
        accepted = matchesOwnedHistory(input, prepared, prepared);
      } finally {
        Reflect.deleteProperty(Object.prototype, key);
        if (prior) Object.defineProperty(Object.prototype, key, prior);
      }
      expect(accepted).toBe(false);
      expect(reads).toBe(0);
    },
  );

  it.each([false, true])(
    'preserves instance edits with inherited descriptor values (stream: %s)',
    async (stream) => {
      const prior = Object.getOwnPropertyDescriptor(
        ArrayBuffer,
        Symbol.hasInstance,
      );
      const inherited = Object.getOwnPropertyDescriptor(
        Object.prototype,
        'value',
      );
      const method = Function.prototype[Symbol.hasInstance];
      const model = new ScriptedModel([
        modelResponder(() => {
          Reflect.deleteProperty(Object.prototype, 'value');
          return [assistantMessage('ok')];
        }),
      ]);
      const runner = new Runner({ tracingDisabled: true });
      runner.on('agent_start', (_context, _agent, input) => {
        const target = input?.[0];
        let edited = false;
        Object.defineProperty(ArrayBuffer, Symbol.hasInstance, {
          configurable: true,
          get() {
            return function (this: object, value: unknown) {
              if (target && value === target && !edited) {
                edited = true;
                Object.assign(target, { content: 'inherited descriptor edit' });
              }
              return Reflect.apply(method, this, [value]);
            };
          },
        });
        Object.defineProperty(
          Object.prototype,
          'value',
          Object.assign(Object.create(null), {
            configurable: true,
            value: method,
          }),
        );
      });
      try {
        const agent = new Agent({
          name: 'Inherited descriptor observer',
          model,
        });
        const input: AgentInputItem[] = [{ role: 'user', content: 'before' }];
        if (stream) {
          const result = await runner.run(agent, input, { stream: true });
          for await (const event of result) void event;
          await result.completed;
        } else {
          await runner.run(agent, input);
        }
        Reflect.deleteProperty(Object.prototype, 'value');
        expect(model.calls[0].request.input[0]).toMatchObject({
          content: 'inherited descriptor edit',
        });
      } finally {
        Reflect.deleteProperty(Object.prototype, 'value');
        if (inherited)
          Object.defineProperty(Object.prototype, 'value', inherited);
        if (prior)
          Object.defineProperty(ArrayBuffer, Symbol.hasInstance, prior);
        else Reflect.deleteProperty(ArrayBuffer, Symbol.hasInstance);
      }
    },
  );

  it.each(
    (['ArrayBuffer', 'Buffer', 'Uint8Array', 'Array'] as const).flatMap(
      (kind) => [false, true].map((stream) => ({ kind, stream })),
    ),
  )(
    'preserves $kind detector observations before model capture (stream: $stream)',
    async ({ kind, stream }) => {
      const constructor = { ArrayBuffer, Buffer, Uint8Array, Array }[kind]!;
      const key = kind === 'Array' ? 'isArray' : Symbol.hasInstance;
      const prior = Object.getOwnPropertyDescriptor(constructor, key);
      const defaultCheck =
        kind === 'Array'
          ? Array.isArray
          : Function.prototype[Symbol.hasInstance];
      const model = new ScriptedModel([[assistantMessage('ok')]]);
      const runner = new Runner({ tracingDisabled: true });
      runner.on('agent_start', (_context, _agent, input) => {
        if (!input) return;
        const target = input[0];
        let edited = false;
        Object.defineProperty(constructor, key, {
          configurable: true,
          value(value: unknown) {
            if (value === target && !edited) {
              edited = true;
              Object.assign(target, { content: 'instance-test edit' });
            }
            return Reflect.apply(defaultCheck, this, [value]);
          },
        });
      });
      try {
        const agent = new Agent({ name: 'Binary observer', model });
        const input: AgentInputItem[] = [{ role: 'user', content: 'before' }];
        if (stream) {
          const result = await runner.run(agent, input, { stream: true });
          for await (const event of result) void event;
          await result.completed;
        } else {
          await runner.run(agent, input);
        }
        expect(model.calls[0].request.input[0]).toMatchObject({
          content: kind === 'Array' ? 'before' : 'instance-test edit',
        });
      } finally {
        if (prior) Object.defineProperty(constructor, key, prior);
        else Reflect.deleteProperty(constructor, key);
      }
    },
  );

  it.each(['global', 'isView', 'hasInstance', 'isBuffer', 'isArray'] as const)(
    'declines a binary %s accessor without invoking it',
    (kind) => {
      const input = [message('prior')];
      const prepared = structuredClone(input);
      const target =
        kind === 'global'
          ? globalThis
          : kind === 'isBuffer'
            ? Buffer
            : kind === 'isArray'
              ? Array
              : ArrayBuffer;
      const key =
        kind === 'global'
          ? 'ArrayBuffer'
          : kind === 'hasInstance'
            ? Symbol.hasInstance
            : kind;
      const prior = Object.getOwnPropertyDescriptor(target, key);
      let reads = 0;
      Object.defineProperty(target, key, {
        configurable: true,
        get() {
          reads++;
          return prior?.value ?? Function.prototype[Symbol.hasInstance];
        },
      });
      let accepted = false;
      try {
        accepted = matchesOwnedHistory(input, prepared, prepared);
      } finally {
        if (prior) Object.defineProperty(target, key, prior);
        else Reflect.deleteProperty(target, key);
      }
      expect(accepted).toBe(false);
      expect(reads).toBe(0);
    },
  );

  it('declines proxy constructor ancestors before invoking their traps', () => {
    const input = [message('prior')];
    const prepared = structuredClone(input);
    const prior = Object.getPrototypeOf(Buffer);
    const fail = () => {
      throw Error('unexpected constructor read');
    };
    const proxy = new Proxy(prior, {
      getOwnPropertyDescriptor: fail,
      getPrototypeOf: fail,
    });
    try {
      Object.setPrototypeOf(Buffer, proxy);
      expect(matchesOwnedHistory(input, prepared, prepared)).toBe(false);
    } finally {
      Object.setPrototypeOf(Buffer, prior);
    }
  });

  it('preserves distinct occurrences on a subsequent rewrite', () => {
    const input = [message('equal'), message('equal')];
    const tracker = begin(input);
    const prepared = structuredClone(input);
    expect(matchesOwnedHistory(input, prepared, prepared.slice())).toBe(true);
    tracker.setPreparedTurnItems(prepared, prepared.slice());
    tracker.recordTurnItems(prepared, [message('first'), message('second')]);
    const held = tracker.getItemsForPersistence()!;
    held[0] = message('caller edit');
    tracker.recordTurnItems([prepared[1]], [message('updated')]);
    expect(tracker.getItemsForPersistence()).toEqual([
      message('first'),
      message('updated'),
    ]);
    expect(held[0]).toEqual(message('caller edit'));
  });

  it('keeps a reused root ahead of an equal clone', () => {
    const input = [message('equal'), message('equal')];
    const tracker = begin(input);
    const next = [input[1], structuredClone(input[1])];
    tracker.setPreparedTurnItems(next, next.slice());
    tracker.recordTurnItems(next, [message('second'), message('first')]);
    tracker.setPreparedTurnItems(input, input);
    tracker.recordTurnItems([input[1]], [message('updated')]);
    expect(tracker.getItemsForPersistence()).toEqual([
      message('first'),
      message('updated'),
    ]);
  });

  it('rechecks the live originals after preparation', () => {
    const input = [message('prior'), message('other')];
    const tracker = begin(input);
    const prepared = structuredClone(input);
    input[0] = message('later edit');
    tracker.setPreparedTurnItems(prepared, prepared);
    tracker.recordTurnItems(prepared, prepared);
    expect(tracker.getItemsForPersistence()).toEqual([message('other')]);
  });

  it('keeps serialization errors from hidden hooks', () => {
    const input = [message('prior'), message('other')];
    const tracker = begin(input);
    const prepared = structuredClone(input);
    Object.defineProperty(input[0], 'toJSON', {
      value() {
        throw Error('history hook');
      },
    });
    expect(() => tracker.setPreparedTurnItems(prepared, prepared)).toThrow(
      'history hook',
    );
  });

  it('declines getter and proxy inputs before invoking them', () => {
    const fail = () => {
      throw Error('unexpected read');
    };
    const prepared = [{ value: 'value' }];
    expect(
      matchesOwnedHistory(
        [
          {
            get value() {
              return fail();
            },
          },
        ],
        prepared,
        prepared,
      ),
    ).toBe(false);
    expect(
      matchesOwnedHistory(
        [new Proxy({}, { ownKeys: fail })],
        prepared,
        prepared,
      ),
    ).toBe(false);
  });
});
