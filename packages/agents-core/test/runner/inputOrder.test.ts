import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createSessionPersistenceTracker } from '../../src/runner/sessionPersistence';
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
});
