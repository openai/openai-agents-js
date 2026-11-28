import { runInNewContext } from 'node:vm';
import { types } from 'node:util';
import * as workers from 'node:worker_threads';
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

function userWithTextPart(text: string): AgentInputItem {
  return { role: 'user', content: [{ type: 'input_text', text }] };
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

const blobCloneKey = Object.getOwnPropertySymbols(Blob.prototype).find(
  (key) => {
    const value = Object.getOwnPropertyDescriptor(Blob.prototype, key)?.value;
    return (
      typeof value === 'function' &&
      Function.prototype.toString.call(value).includes('deserializeInfo')
    );
  },
);

describe('ownership of a complete input history', () => {
  it('preserves native rejection after transient clone registration', async () => {
    const input = history();
    let live: AgentInputItem[] = [];
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'WeakMap')!;
    const NativeWeakMap = WeakMap;
    const restore = () => Object.defineProperty(globalThis, 'WeakMap', saved);
    const model = new ScriptedModel([[assistantMessage('ok')]]);
    const runner = new Runner({ tracingDisabled: true });
    runner.on('agent_start', (_context, _agent, items) => {
      live = items!;
    });
    const agent = new Agent({
      name: 'Registration',
      model,
      instructions() {
        Object.defineProperty(globalThis, 'WeakMap', {
          configurable: true,
          get() {
            restore();
            return class extends NativeWeakMap<object, unknown> {
              set(key: object, value: unknown) {
                if (value === live[0]) workers.markAsUncloneable(live[1]);
                return super.set(key, value);
              }
            };
          },
        });
        return 'Reply';
      },
    });
    try {
      await expect(runner.run(agent, input)).rejects.toThrow(/clone/i);
      expect(model.calls).toHaveLength(0);
      expect(() => structuredClone(input)).not.toThrow();
    } finally {
      restore();
    }
  });

  it.skipIf(!blobCloneKey)('preserves inherited clone hook reads', async () => {
    const key = blobCloneKey!;
    const clone = Object.getOwnPropertyDescriptor(Blob.prototype, key)!.value;
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, key);
    const input = history();
    const host = new Blob(['host']);
    for (const key of Object.getOwnPropertySymbols(host))
      Reflect.deleteProperty(host, key);
    Object.setPrototypeOf(host, Object.prototype);
    Object.assign(host, { role: 'user', content: 'host' });
    const pristine = new Blob(['pristine']);
    let live: AgentInputItem[] = [];
    let reads = 0;
    const runner = new Runner({ tracingDisabled: true });
    const model = new ScriptedModel([[assistantMessage('ok')]]);
    runner.on('agent_start', (_context, _agent, items) => {
      live = items!;
    });
    const agent = new Agent({
      name: 'Native clone',
      model,
      instructions() {
        live[5] = host as unknown as AgentInputItem;
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          get() {
            reads++;
            return () => Reflect.apply(clone, pristine, []);
          },
        });
        const part = (live[35] as ReturnType<typeof assistant>).content[0];
        Object.defineProperty(part, 'text', {
          enumerable: true,
          configurable: true,
          get: () => '35',
        });
        return 'Reply';
      },
    });
    try {
      const result = await runner.run(agent, input, { stream: true });
      await result.completed;
      expect(result.finalOutput).toBe('ok');
      expect(reads).toBe(1);
      expect(input[5]).toStrictEqual(message('5'));
    } finally {
      if (prior) Object.defineProperty(Object.prototype, key, prior);
      else Reflect.deleteProperty(Object.prototype, key);
    }
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

  it.each([message, assistant, userWithTextPart])(
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

  it('preserves reordered roots and independent copies', async () => {
    for (const rotate of [false, true, false]) {
      const annotated = {
        type: 'output_text' as const,
        text: 'annotated',
        annotations: [],
      };
      const roots = [
        userWithTextPart(rotate ? 'updated part' : 'part'),
        {
          role: rotate ? ('system' as const) : ('user' as const),
          content: rotate ? 'updated' : 'plain',
        },
        { role: 'system' as const, content: 'plain rule' },
        user('helper'),
        system('helper rule'),
        message('reply'),
        assistant('helper reply'),
        assistant([annotated]),
      ].map((item) => {
        const entries = Object.entries(item);
        return Object.fromEntries(
          rotate ? [...entries.slice(1), entries[0]] : entries.reverse(),
        ) as AgentInputItem;
      });
      const input = [...roots, roots[0], ...history()];
      const expected = structuredClone(input);
      const check = (items: AgentInputItem[]) => {
        expect(items.slice(0, roots.length + 1)).toStrictEqual(
          expected.slice(0, roots.length + 1),
        );
        for (let i = 0; i <= roots.length; i++) {
          expect(Object.keys(items[i])).toEqual(Object.keys(input[i]));
          expect(items[i]).not.toBe(input[i]);
          for (const descriptor of Object.values(
            Object.getOwnPropertyDescriptors(items[i]),
          )) {
            expect(descriptor).toMatchObject({
              writable: true,
              enumerable: true,
              configurable: true,
            });
          }
        }
        expect(items[0]).not.toBe(items[roots.length]);
        const first = items[0];
        if ('content' in first && Array.isArray(first.content))
          Object.assign(first.content[0], { text: 'edited' });
        expect(items[roots.length]).toStrictEqual(expected[0]);
        expect(input).toStrictEqual(expected);
      };
      const model = new ScriptedModel([
        modelResponder(({ request }) => {
          if (typeof request.input === 'string')
            throw new Error('Expected a list');
          check(request.input);
          return [assistantMessage('ok')];
        }),
      ]);
      const result = await new Runner({ tracingDisabled: true }).run(
        new Agent({ name: 'History order', model }),
        input,
      );
      check(result.state._currentTurnSessionHistoryTransactionInputItems!);
      expect(result.input).toStrictEqual(expected);
      expect(result.input[roots.length]).toBe(result.input[0]);
    }
  });

  it('copies tagged user strings independently with optional metadata', async () => {
    for (const metadata of [false, true]) {
      const tagged = {
        type: 'message' as const,
        role: 'user' as const,
        content: 'question',
        ...(metadata ? { providerData: undefined } : {}),
      };
      const input = [
        tagged,
        user('helper'),
        system('rule'),
        assistant('reply'),
        ...history(),
      ];
      input.push(tagged);
      const expected = structuredClone(input);
      const check = (items: AgentInputItem[]) => {
        expect(items).toStrictEqual(expected);
        expect(Object.keys(items[0])).toEqual(Object.keys(tagged));
        expect(
          Object.prototype.hasOwnProperty.call(items[0], 'providerData'),
        ).toBe(metadata);
        expect(items[0]).not.toBe(items[items.length - 1]);
        Object.assign(items[0], {
          content: 'edited',
          providerData: { edited: true },
        });
        expect(items[items.length - 1]).toStrictEqual(expected[0]);
        expect(input).toStrictEqual(expected);
      };
      const model = new ScriptedModel([
        modelResponder(({ request }) => {
          if (typeof request.input === 'string')
            throw new Error('Expected a list');
          check(request.input);
          return [assistantMessage('ok')];
        }),
      ]);
      const result = await new Runner({ tracingDisabled: true }).run(
        new Agent({ name: 'Tagged history', model }),
        input,
      );
      check(result.state._currentTurnSessionHistoryTransactionInputItems!);
      expect(result.input).toStrictEqual(expected);
      tagged.content = 'caller edit';
      expect(result.input).toStrictEqual(expected);
    }
  });

  it('keeps nested text order and interim copies independent', async () => {
    for (const status of ['completed', 'in_progress', 'incomplete'] as const) {
      for (const reverse of [false, true, false]) {
        const part = reverse
          ? { annotations: [], text: 'reply', type: 'output_text' as const }
          : { type: 'output_text' as const, text: 'reply', annotations: [] };
        const inputPart = reverse
          ? { text: 'question', type: 'input_text' as const }
          : { type: 'input_text' as const, text: 'question' };
        const roots: AgentInputItem[] = [
          {
            role: 'assistant' as const,
            content: [part],
            status,
            providerData: undefined,
          },
          Object.assign(assistant([part]), { status }),
          {
            role: 'user' as const,
            content: [inputPart],
            providerData: undefined,
          },
        ].map((item) =>
          reverse
            ? (Object.fromEntries(
                Object.entries(item).reverse(),
              ) as AgentInputItem)
            : item,
        );
        const input = [...roots, roots[0], ...history()];
        const expected = structuredClone(input);
        const check = (items: AgentInputItem[]) => {
          expect(items).toStrictEqual(expected);
          for (let i = 0; i < roots.length + 1; i++) {
            expect(Object.keys(items[i])).toEqual(Object.keys(expected[i]));
            const item = items[i],
              saved = expected[i];
            if (
              'content' in item &&
              Array.isArray(item.content) &&
              'content' in saved &&
              Array.isArray(saved.content)
            )
              expect(Object.keys(item.content[0])).toEqual(
                Object.keys(saved.content[0]),
              );
          }
          const first = items[0];
          if ('content' in first && Array.isArray(first.content))
            Object.assign(first.content[0], { text: 'edited' });
          Object.assign(first, { providerData: { edited: true } });
          expect(items[1]).toStrictEqual(expected[1]);
          expect(items[roots.length]).toStrictEqual(expected[0]);
          expect(input).toStrictEqual(expected);
        };
        const model = new ScriptedModel([
          modelResponder(({ request }) => {
            if (typeof request.input === 'string')
              throw new Error('Expected a list');
            check(request.input);
            return [assistantMessage('ok')];
          }),
        ]);
        const result = await new Runner({ tracingDisabled: true }).run(
          new Agent({ name: 'Nested history', model }),
          input,
        );
        check(result.state._currentTurnSessionHistoryTransactionInputItems!);
        expect(result.input).toStrictEqual(expected);
        Object.assign(input[0], { status: 'incomplete' });
        expect(result.input).toStrictEqual(expected);
      }
    }
  });

  it.each(['edit', 'mark-before', 'mark-after', 'mark-first'] as const)(
    'preserves late getter copy order: %s',
    async (action) => {
      const input = Array.from({ length: 40 }, (_, i) => ({
        role: 'user' as const,
        content: String(i),
      }));
      let live: AgentInputItem[] = [];
      let reads = 0;
      const runner = new Runner({ tracingDisabled: true });
      runner.on('agent_start', (_context, _agent, items) => {
        live = items!;
      });
      const model = new ScriptedModel([[assistantMessage('ok')]]);
      const agent = new Agent({
        name: 'Copy order',
        model,
        instructions() {
          if (action === 'mark-first') workers.markAsUncloneable(live[1]);
          Object.defineProperty(live[35], 'content', {
            enumerable: true,
            configurable: true,
            get() {
              reads++;
              Object.assign(live[1], { content: 'earlier' });
              Object.assign(live[39], { content: 'later' });
              if (action === 'mark-before') workers.markAsUncloneable(live[1]);
              if (action === 'mark-after') workers.markAsUncloneable(live[39]);
              return '35';
            },
          });
          return 'Reply';
        },
      });
      const result = await runner.run(agent, input, { stream: true });
      if (action === 'mark-first' || action === 'mark-after') {
        await expect(result.completed).rejects.toThrow(/clone/i);
        expect(model.calls).toHaveLength(0);
        expect(reads).toBe(action === 'mark-first' ? 0 : 1);
      } else {
        await result.completed;
        const expected = input.map((item, i) =>
          i === 39 ? { ...item, content: 'later' } : item,
        );
        expect(model.calls[0].request.input).toStrictEqual(expected);
        expect(
          result.state._currentTurnSessionHistoryTransactionInputItems,
        ).toStrictEqual(expected);
        expect(reads).toBe(1);
      }
      expect(live).toHaveLength(40);
      expect(input[1].content).toBe('1');
      expect(input[39].content).toBe('39');
    },
  );

  it('preserves one native getter read after instructions', async () => {
    const input = [{ role: 'user' as const, content: 'before' }, ...history()];
    let reads = 0;
    let live: AgentInputItem[] = [];
    const model = new ScriptedModel([[assistantMessage('ok')]]);
    const runner = new Runner({ tracingDisabled: true });
    runner.on('agent_start', (_context, _agent, items) => {
      live = items!;
    });
    const result = await runner.run(
      new Agent({
        name: 'Getter history',
        model,
        instructions: () => {
          Object.defineProperty(live[0], 'content', {
            enumerable: true,
            configurable: true,
            get() {
              reads++;
              return 'before';
            },
          });
          return 'Reply';
        },
      }),
      input,
    );
    expect(reads).toBe(1);
    expect(model.calls[0].request.input).toStrictEqual(input);
    expect(
      result.state._currentTurnSessionHistoryTransactionInputItems,
    ).toStrictEqual(input);
    expect(result.input).toStrictEqual(input);
  });

  it('preserves restored helper fields and independent copies', async () => {
    const held: {
      items: string | AgentInputItem[];
      expected: AgentInputItem[];
    }[] = [];
    for (const hidden of [false, true]) {
      const input = JSON.parse(
        JSON.stringify([
          user('question'),
          system('rule'),
          assistant('reply'),
          ...history(),
        ]),
      ) as AgentInputItem[];
      input.push(input[0]);
      let metadataReads = 0;
      if (hidden)
        Object.defineProperty(input[0], 'providerData', {
          configurable: true,
          get() {
            metadataReads++;
            return undefined;
          },
        });
      expect(Object.keys(input[0])).not.toContain('providerData');
      expect(
        Object.prototype.hasOwnProperty.call(input[0], 'providerData'),
      ).toBe(hidden);
      expect('providerData' in input[0]).toBe(hidden);
      const expected = structuredClone(input);
      const check = (items: AgentInputItem[]) => {
        expect(items).toStrictEqual(expected);
        for (let i = 0; i < items.length; i++) {
          expect(Object.keys(items[i])).toEqual(Object.keys(expected[i]));
          expect(
            Object.prototype.hasOwnProperty.call(items[i], 'providerData'),
          ).toBe(false);
          expect('providerData' in items[i]).toBe(false);
        }
        const first = items[0];
        if ('content' in first && Array.isArray(first.content))
          Object.assign(first.content[0], { text: 'edited' });
        Object.assign(first, { providerData: { edited: true } });
        expect(items[items.length - 1]).toStrictEqual(expected[0]);
        expect(input).toStrictEqual(expected);
      };
      const model = new ScriptedModel([
        modelResponder(({ request }) => {
          if (typeof request.input === 'string')
            throw new Error('Expected a list');
          check(request.input);
          return [assistantMessage('ok')];
        }),
      ]);
      const result = await new Runner({ tracingDisabled: true }).run(
        new Agent({ name: 'Restored history', model }),
        input,
      );
      check(result.state._currentTurnSessionHistoryTransactionInputItems!);
      expect(result.input).toStrictEqual(expected);
      expect(metadataReads).toBe(0);
      for (const prior of held)
        expect(prior.items).toStrictEqual(prior.expected);
      held.push({ items: result.input, expected });
    }
  });

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
