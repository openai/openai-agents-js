import { runInNewContext } from 'node:vm';
import { types } from 'node:util';
import * as workers from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { applyCallModelInputFilter } from '../../src/runner/conversation';
import { createSessionPersistenceTracker } from '../../src/runner/sessionPersistence';
import type { AgentInputItem } from '../../src/types';
import {
  Agent,
  RunContext,
  Runner,
  RunState,
  assistant,
  system,
  user,
} from '../../src';
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
  it('falls back before calling a replaced weak dereference', async () => {
    const input = history();
    const model = new ScriptedModel([[assistantMessage('ok')]]);
    const agent = new Agent({ name: 'Weak history', model });
    await new Runner({ tracingDisabled: true }).run(agent, input);
    const context = new RunContext();
    const original = WeakRef.prototype.deref;
    let calls = 0;
    let copied: unknown;
    try {
      WeakRef.prototype.deref = () => {
        calls++;
        throw new Error('Unexpected weak dereference');
      };
      copied = new RunState(context, input, agent, null)._originalInput;
    } finally {
      WeakRef.prototype.deref = original;
    }
    expect(calls).toBe(0);
    expect(copied).toStrictEqual(input);
  });

  it('keeps the native kind of a replacement in a previously copied history', () => {
    const input = history();
    const first = begin(input);
    const replacement = Object.assign(new Date(123), {
      type: 'output_text' as const,
      text: '0',
    });
    Object.setPrototypeOf(replacement, Object.prototype);
    Object.assign(input[0], { content: [replacement] });
    expect(begin(input).getItemsForPersistence()![0]).toStrictEqual({
      role: 'assistant',
      content: [new Date(123)],
      status: 'completed',
    });
    expect(first.getItemsForPersistence()![0]).toStrictEqual(message('0'));
  });

  it.skipIf(!('markAsUncloneable' in workers))(
    'observes a new clone restriction on an existing text part',
    () => {
      const part = { type: 'output_text' as const, text: 'original' };
      const input = [assistant([part]), ...history()];
      const first = begin(input);
      workers.markAsUncloneable(part);
      expect(() => begin(input)).toThrow(
        expect.objectContaining({ name: 'DataCloneError' }),
      );
      expect(first.getItemsForPersistence()![0]).toStrictEqual(input[0]);
    },
  );

  it.skipIf(!('markAsUncloneable' in workers))(
    'rejects a new clone restriction on public run state before dispatch',
    async () => {
      const runner = new Runner({ tracingDisabled: true });
      const model = new ScriptedModel([[assistantMessage('ok')]]);
      runner.on('agent_start', (_context, _agent, items) => {
        workers.markAsUncloneable(Object.freeze(items![0]));
      });
      const input = history();
      await expect(
        runner.run(new Agent({ name: 'History', model }), input),
      ).rejects.toMatchObject({ name: 'DataCloneError' });
      expect(model.calls).toHaveLength(0);
      expect(structuredClone(input)).toStrictEqual(input);
    },
  );

  it.skipIf(!('markAsUncloneable' in workers))(
    'preserves shared nested state before a late clone restriction',
    async () => {
      const annotations: [] = [];
      const input = history();
      const left = { type: 'output_text' as const, text: 'first', annotations };
      const right = {
        type: 'output_text' as const,
        text: 'second',
        annotations,
      };
      input[0] = assistant([left]);
      input[1] = assistant([right]);
      const model = new ScriptedModel([[assistantMessage('ok')]]);
      const runner = new Runner({ tracingDisabled: true });
      const agent = new Agent({ name: 'Shared history', model });
      const first = await runner.run(agent, input);
      let observed = false;
      runner.on('agent_start', (_context, _agent, items) => {
        const firstItem = items![0];
        const secondItem = items![1];
        if (!('content' in firstItem) || !('content' in secondItem))
          throw new Error('Missing shared messages');
        const left = firstItem.content;
        const right = secondItem.content;
        if (typeof left === 'string' || typeof right === 'string')
          throw new Error('Missing shared content');
        const leftPart = left[0];
        const rightPart = right[0];
        if (
          !('annotations' in leftPart) ||
          !('annotations' in rightPart) ||
          !Array.isArray(leftPart.annotations) ||
          !Array.isArray(rightPart.annotations)
        )
          throw new Error('Missing shared annotations');
        expect(leftPart.annotations).toBe(rightPart.annotations);
        expect(leftPart.annotations).not.toBe(annotations);
        workers.markAsUncloneable(Object.freeze(leftPart));
        observed = true;
      });
      await expect(runner.run(agent, input)).rejects.toMatchObject({
        name: 'DataCloneError',
      });
      expect(observed).toBe(true);
      expect(model.calls).toHaveLength(1);
      expect(first.input).toStrictEqual(input);
      expect(structuredClone(input)).toStrictEqual(input);
    },
  );

  it('keeps saved messages and their owners when the model input changes before the first read', async () => {
    const input = history();
    const tracker = begin(input);
    const processed = structuredClone(input);
    const first = processed[0];
    tracker.setPreparedTurnItems(processed.slice(), processed);
    const prepared = await applyCallModelInputFilter(
      new Agent({ name: 'History' }),
      undefined,
      new RunContext(),
      processed,
      undefined,
      tracker.orderedInput,
    );
    processed[0] = message('replacement');
    prepared.modelInput.input[0] = message('model edit');
    const saved = prepared.persistedItems;
    expect(saved[0]).toStrictEqual(input[0]);
    saved[0] = message('saved edit');
    expect(prepared.persistedItems).toBe(saved);
    tracker.recordTurnItems([first, processed[0]], [saved[0], processed[0]]);
    expect(tracker.getItemsForPersistence()).toStrictEqual([
      message('saved edit'),
    ]);
  });

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

  it('preserves reordered text fields and noncanonical public metadata', async () => {
    const input = history();
    input[20] = {
      content: 'reordered',
      role: 'user',
      providerData: { trace: 'kept' },
    };
    const expected = structuredClone(input);
    const model = new ScriptedModel([[assistantMessage('ok')]]);
    const result = await new Runner({ tracingDisabled: true }).run(
      new Agent({ name: 'Noncanonical history', model }),
      input,
    );
    expect(result.finalOutput).toBe('ok');
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].request.input).toStrictEqual(expected);
    expect(input).toStrictEqual(expected);
  });

  it('preserves recovery rows when state inherits a removed own field', async () => {
    const input = Array.from({ length: 40 }, (_, i) => ({
      role: 'user' as const,
      content: `note ${i}`,
      sourceLabel: 'saved',
    }));
    const model = new ScriptedModel([[assistantMessage('done')]]);
    const runner = new Runner({ tracingDisabled: true });
    const prior = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'sourceLabel',
    );
    const restore = () => {
      if (prior) Object.defineProperty(Object.prototype, 'sourceLabel', prior);
      else Reflect.deleteProperty(Object.prototype, 'sourceLabel');
    };
    const agent = new Agent({
      name: 'History',
      model,
      instructions: () => {
        restore();
        return 'Test';
      },
    });
    runner.on('agent_start', (_context, _agent, items) => {
      Object.defineProperty(Object.prototype, 'sourceLabel', {
        value: 'saved',
        writable: true,
        configurable: true,
        enumerable: true,
      });
      Reflect.deleteProperty(items![1], 'sourceLabel');
    });
    try {
      const result = await runner.run(agent, input, { stream: true });
      await result.completed;
      expect(
        result.state._currentTurnSessionHistoryTransactionInputItems,
      ).toStrictEqual(input.filter((_, i) => i !== 1));
      expect(
        Object.prototype.hasOwnProperty.call(input[1], 'sourceLabel'),
      ).toBe(true);
      expect(result.finalOutput).toBe('done');
    } finally {
      restore();
    }
  });

  it('does not observe an inherited matching getter during capture', async () => {
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'matching');
    let reads = 0;
    const model = new ScriptedModel([[assistantMessage('ok')]]);
    const agent = new Agent({ name: 'Matching observer', model });
    const runner = new Runner({ tracingDisabled: true });
    Object.defineProperty(Object.prototype, 'matching', {
      configurable: true,
      get() {
        reads++;
        throw new Error('Unexpected matching lookup');
      },
    });
    try {
      const result = await runner.run(agent, history());
      expect(result.finalOutput).toBe('ok');
      expect(reads).toBe(0);
      expect(model.calls).toHaveLength(1);
    } finally {
      delete (Object.prototype as { matching?: unknown }).matching;
      if (prior) Object.defineProperty(Object.prototype, 'matching', prior);
    }
  });

  it('preserves hidden content-array serialization getter errors while matching', async () => {
    const error = new Error('hidden content hook');
    let reads = 0;
    const model = new ScriptedModel([[assistantMessage('unused')]]);
    const runner = new Runner({ tracingDisabled: true });
    runner.on('agent_start', (_context, _agent, items) => {
      const first = items![0];
      if (!('content' in first) || !Array.isArray(first.content))
        throw new Error('Missing content array');
      Object.defineProperty(first.content, 'toJSON', {
        configurable: true,
        get() {
          reads++;
          throw error;
        },
      });
    });
    await expect(
      runner.run(new Agent({ name: 'Hidden lookup', model }), history()),
    ).rejects.toBe(error);
    expect(reads).toBe(1);
    expect(model.calls).toHaveLength(0);
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
});
