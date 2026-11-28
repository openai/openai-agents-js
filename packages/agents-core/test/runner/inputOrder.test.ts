import { runInNewContext } from 'node:vm';
import { types } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createSessionPersistenceTracker } from '../../src/runner/sessionPersistence';
import type { AgentInputItem } from '../../src/types';
import { Agent, Runner, assistant, system, user } from '../../src';
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

function history(): AgentInputItem[] {
  return Array.from({ length: 40 }, (_, i) => message(String(i)));
}

describe('ownership of a complete input history', () => {
  it('keeps each initial occurrence independent when recovery is read late', () => {
    const part = {
      type: 'output_text' as const,
      text: 'before',
      annotations: [],
    };
    const shared = assistant([part]);
    const tracker = begin([shared, shared, ...history()]);
    part.text = 'after';
    const saved = tracker.getItemsForPersistence()!;
    expect(saved[0]).toStrictEqual(assistant([{ ...part, text: 'before' }]));
    Object.assign((saved[0] as typeof shared).content[0], { text: 'edited' });
    expect(saved[1]).toStrictEqual(assistant([{ ...part, text: 'before' }]));
    expect(tracker.getItemsForPersistence()).toBe(saved);
  });

  it('keeps recovery in the local realm with a foreign array allocator', () => {
    const input = history();
    const foreign = runInNewContext('Array.from') as typeof Array.from;
    Object.setPrototypeOf(foreign, Function.prototype);
    const original = Array.from;
    let saved;
    try {
      Array.from = foreign;
      saved = begin(input).getItemsForPersistence();
    } finally {
      Array.from = original;
    }
    expect(Object.getPrototypeOf(saved)).toBe(Array.prototype);
    expect(saved).toStrictEqual(input);
  });

  it('avoids calling an application wrapper for the proxy detector', async () => {
    const original = types.isProxy;
    const runner = new Runner({ tracingDisabled: true });
    const model = new ScriptedModel([[assistantMessage('ok')]]);
    runner.on('agent_start', () => {
      types.isProxy = new Proxy(original, {
        apply() {
          throw new Error('Unexpected classifier call');
        },
      });
    });
    try {
      const result = await runner.run(
        new Agent({ name: 'Classifier', model }),
        history(),
      );
      expect(result.finalOutput).toBe('ok');
      expect(
        result.state._currentTurnSessionHistoryTransactionInputItems?.[0],
      ).toEqual(message('0'));
    } finally {
      types.isProxy = original;
    }
  });

  it.each([message, assistant])(
    'separates repeated input from the request and recovery snapshot',
    async (create) => {
      const shared = create('shared');
      const expected = create('shared');
      const input = [shared, shared, ...history()];
      const model = new ScriptedModel([
        modelResponder(({ request }) => {
          const first = request.input[0] as typeof shared;
          if ('content' in first && Array.isArray(first.content)) {
            Object.assign(first.content[0], { text: 'edited' });
          }
          expect(request.input[1]).toStrictEqual(expected);
          return [assistantMessage('ok')];
        }),
      ]);
      const result = await new Runner({ tracingDisabled: true }).run(
        new Agent({ name: 'History', model }),
        input,
      );
      expect(shared).toStrictEqual(expected);
      expect(result.input[0]).toStrictEqual(expected);
      expect(result.input[1]).toBe(result.input[0]);
      expect(
        result.state._currentTurnSessionHistoryTransactionInputItems?.[0],
      ).toStrictEqual(expected);
    },
  );

  it('preserves a metadata setter installed before saving helper messages', async () => {
    const input = [system('instructions'), user('question'), ...history()];
    const model = new ScriptedModel([[assistantMessage('ok')]]);
    const failure = new Error('metadata write');
    const agent = new Agent({
      name: 'Metadata',
      model,
      instructions() {
        Object.defineProperty(Object.prototype, 'providerData', {
          configurable: true,
          set() {
            throw failure;
          },
        });
        return 'Reply';
      },
    });
    try {
      await expect(
        new Runner({ tracingDisabled: true }).run(agent, input),
      ).rejects.toBe(failure);
      expect(model.calls).toHaveLength(0);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'providerData');
    }
  });

  it('rejects an uncloneable model item after a temporary clone replacement', async () => {
    const clone = globalThis.structuredClone;
    const runner = new Runner({ tracingDisabled: true });
    const model = new ScriptedModel([[assistantMessage('ok')]]);
    let live: AgentInputItem[] = [];
    runner.on('agent_start', (_context, _agent, items) => {
      live = items!;
    });
    const agent = new Agent({
      name: 'Clone observer',
      model,
      instructions: () => {
        Object.defineProperty(live[0], 'content', {
          enumerable: true,
          get() {
            globalThis.structuredClone = <T>(value: T) => {
              globalThis.structuredClone = clone;
              return new Proxy(clone(value) as object, {}) as T;
            };
            return 'before';
          },
        });
        return 'Reply';
      },
    });
    try {
      await expect(
        runner.run(agent, [{ role: 'user', content: 'before' }, ...history()]),
      ).rejects.toMatchObject({ name: 'DataCloneError' });
      expect(model.calls).toHaveLength(0);
    } finally {
      globalThis.structuredClone = clone;
    }
  });

  it.each([false, true])(
    'preserves public Buffer getter edits and errors (throws: %s)',
    async (throws) => {
      const prior = Object.getOwnPropertyDescriptor(globalThis, 'Buffer')!;
      const original = Buffer;
      const error = new Error('Buffer getter');
      const restore = () => Object.defineProperty(globalThis, 'Buffer', prior);
      const model = new ScriptedModel([[assistantMessage('ok')]]);
      const runner = new Runner({ tracingDisabled: true });
      runner.on('agent_start', (_context, _agent, input) => {
        Object.defineProperty(globalThis, 'Buffer', {
          configurable: true,
          get() {
            restore();
            if (throws) throw error;
            Object.assign(input![0], { content: 'edited' });
            return original;
          },
        });
      });
      try {
        const run = runner.run(new Agent({ name: 'Buffer observer', model }), [
          { role: 'user', content: 'before' },
          ...history(),
        ]);
        if (throws) {
          await expect(run).rejects.toBe(error);
          expect(model.calls).toHaveLength(0);
        } else {
          await run;
          expect(model.calls[0].request.input[0]).toMatchObject({
            content: 'edited',
          });
        }
      } finally {
        restore();
      }
    },
  );

  it('preserves an edit made while iterating a map from another realm', async () => {
    const foreign = runInNewContext('Map') as MapConstructor;
    const iterator = foreign.prototype[Symbol.iterator];
    const prototype = Object.getPrototypeOf(new foreign().entries());
    const next = Object.getOwnPropertyDescriptor(prototype, 'next')!.value;
    const local = Map.prototype[Symbol.iterator];
    const restore = () => {
      Map.prototype[Symbol.iterator] = local;
    };
    const model = new ScriptedModel([
      modelResponder(() => {
        restore();
        return [assistantMessage('ok')];
      }),
    ]);
    const runner = new Runner({ tracingDisabled: true });
    runner.on('agent_start', (_context, _agent, input) => {
      Object.defineProperty(prototype, 'next', {
        configurable: true,
        get() {
          restore();
          Object.assign(input![0], { content: 'edited' });
          return next;
        },
      });
      Map.prototype[Symbol.iterator] = iterator;
    });
    try {
      await runner.run(new Agent({ name: 'History observer', model }), [
        { role: 'user', content: 'before' },
        ...history(),
        message('answer'),
        { role: 'user', content: 'last' },
      ]);
      expect(model.calls[0].request.input[0]).toMatchObject({
        content: 'edited',
      });
    } finally {
      restore();
    }
  });

  it('preserves distinct occurrences on a subsequent rewrite', () => {
    const input = [message('equal'), message('equal')];
    const tracker = begin(input);
    const prepared = structuredClone(input);
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
    const input = history();
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

  it('keeps native copy failures on the stream', async ({ skip }) => {
    const blob = new Blob(['native data']);
    for (const symbol of Object.getOwnPropertySymbols(blob)) {
      Reflect.deleteProperty(blob, symbol);
    }
    Object.setPrototypeOf(blob, Object.prototype);
    Object.assign(blob, { role: 'user', content: 'native message' });
    let nativeCopy: unknown;
    try {
      nativeCopy = structuredClone([blob]);
    } catch {
      skip();
      return;
    }
    if (nativeCopy !== undefined) {
      skip();
      return;
    }

    const input = history();
    input[0] = blob as unknown as AgentInputItem;
    const model = new ScriptedModel();
    const runner = new Runner({ tracingDisabled: true });
    const result = await runner.run(
      new Agent({ name: 'Native clone fallback', model }),
      input,
      { stream: true },
    );
    await expect(result.completed).rejects.toThrow(/iterable/);
    expect(model.calls).toHaveLength(0);
  });
});
