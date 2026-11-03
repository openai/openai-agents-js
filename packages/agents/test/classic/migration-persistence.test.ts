import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  Runner,
  RunContext,
  tool,
  type Session,
} from '../../src/classic';
import type { AgentInputItem } from '@openai/agents-core/types';
import {
  assistantMessage,
  functionCall,
  modelResponse,
  ScriptedModel,
} from '../../src/classic/testing';
import {
  loadCompletedSessionInput,
  readCompletedSessionHistory,
  completedSessionInputCallback,
  appendCompletedSessionItems,
} from '../../src/migration/persistence';

// The real classic Runner owns SessionInputCallback and fresh-item classification.
// Only its I/O boundary is routed through the isolated migration helpers.
function boundary(store: Session): Session {
  return {
    getSessionId: store.getSessionId.bind(store),
    getItems: () => readCompletedSessionHistory(store),
    addItems: (items) => appendCompletedSessionItems(store, items),
    popItem: store.popItem.bind(store),
    clearSession: store.clearSession.bind(store),
  };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function workflow() {
  let effects = 0;
  const text = '{"looks":"json"}';
  const model = new ScriptedModel([
    modelResponse([functionCall('effect', {}, { callId: 'actual-call' })]),
    modelResponse([assistantMessage('actual completion')]),
  ]);
  const effect = tool({
    name: 'effect',
    description: 'Record an effect',
    parameters: z.object({}),
    execute: () => {
      effects++;
      return text;
    },
  });
  return {
    agent: new Agent({ name: 'session-seam', model, tools: [effect] }),
    model,
    effects: () => effects,
    text,
  };
}
const runner = () => new Runner({ tracingDisabled: true });

describe('isolated migration Session I/O with the actual classic caller', () => {
  it('reads before callback and stores actual completed items and transformed fresh input', async () => {
    const old: AgentInputItem[] = [
      { role: 'user', content: 'old' },
      assistantMessage('old answer'),
    ];
    const store = new MemorySession({ initialItems: old });
    const events: string[] = [];
    const read = store.getItems.bind(store);
    const append = store.addItems.bind(store);
    vi.spyOn(store, 'getItems').mockImplementation(async () => {
      events.push('read');
      return read();
    });
    vi.spyOn(store, 'addItems').mockImplementation(async (items) => {
      events.push('append');
      await append(items);
    });
    const run = workflow();
    const completed = await runner().run(run.agent, 'private', {
      session: boundary(store),
      sessionInputCallback: completedSessionInputCallback(
        async (history, fresh) => {
          events.push('callback');
          expect(history).toEqual(old);
          expect(fresh).toMatchObject([{ role: 'user', content: 'private' }]);
          const oldUser = history[0];
          if (!oldUser || !('role' in oldUser) || oldUser.role !== 'user')
            throw new Error('missing user');
          oldUser.content = 'changed for replay only';
          return [...history, { role: 'user', content: 'redacted' }];
        },
      ),
    });
    expect(completed.finalOutput).toBe('actual completion');
    expect(events).toEqual(['read', 'callback', 'append']);
    const stored = await read();
    expect(stored).toHaveLength(6);
    expect(stored.slice(0, 2)).toEqual(old);
    expect(stored[2]).toMatchObject({ role: 'user', content: 'redacted' });
    expect(stored[3]).toMatchObject({
      type: 'function_call',
      callId: 'actual-call',
    });
    expect(stored[4]).toMatchObject({
      type: 'function_call_result',
      callId: 'actual-call',
      status: 'completed',
      output: { type: 'text', text: run.text },
    });
    expect(stored[5]).toEqual(assistantMessage('actual completion'));
    expect(run.effects()).toBe(1);
  });

  it.each([
    {
      type: 'function_call',
      callId: 'pending',
      name: 'effect',
      arguments: '{}',
    },
    { type: 'unknown', providerData: { approval: 'pending' } },
  ] as AgentInputItem[])(
    'rejects stored unsettled/unknown items before callback or effects: %j',
    async (item) => {
      const store = new MemorySession({ initialItems: [item] });
      const writes = vi.spyOn(store, 'addItems');
      const callback = vi.fn((history, fresh) => [...history, ...fresh]);
      const run = workflow();
      await expect(
        runner().run(run.agent, 'fresh', {
          session: boundary(store),
          sessionInputCallback: callback,
        }),
      ).rejects.toThrow('MIG.8');
      expect(callback).not.toHaveBeenCalled();
      expect(run.model.calls).toHaveLength(0);
      expect(run.effects()).toBe(0);
      expect(writes).not.toHaveBeenCalled();
    },
  );

  it('keeps callback rejection before append and model work', async () => {
    const store = new MemorySession();
    const writes = vi.spyOn(store, 'addItems');
    const failure = new Error('callback failure');
    let callbackEffects = 0;
    const run = workflow();
    await expect(
      runner().run(run.agent, 'fresh', {
        session: boundary(store),
        sessionInputCallback: completedSessionInputCallback(async () => {
          callbackEffects++;
          throw failure;
        }),
      }),
    ).rejects.toBe(failure);
    expect(writes).not.toHaveBeenCalled();
    expect(callbackEffects).toBe(1);
    expect(run.model.calls).toHaveLength(0);
    expect(run.effects()).toBe(0);
  });

  it('rejects callback-selected unknown effects before model or writes', async () => {
    const store = new MemorySession();
    const writes = vi.spyOn(store, 'addItems');
    const run = workflow();
    const callback = vi.fn(() => [{ type: 'unknown' }] as AgentInputItem[]);
    await expect(
      runner().run(run.agent, 'fresh', {
        session: boundary(store),
        sessionInputCallback: completedSessionInputCallback(callback),
      }),
    ).rejects.toThrow('MIG.8');
    expect(callback).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    expect(run.model.calls).toHaveLength(0);
    expect(run.effects()).toBe(0);
  });

  it.each([false, true])(
    'joins actual append failure after effects and cancellation (committed=%s)',
    async (committed) => {
      const store = new MemorySession();
      const append = store.addItems.bind(store);
      const started = gate();
      const pending = gate();
      const failure = new Error('storage failed');
      const writes = vi
        .spyOn(store, 'addItems')
        .mockImplementation(async (items) => {
          started.release();
          await pending.promise;
          if (committed) await append(items);
          throw failure;
        });
      const controller = new AbortController();
      const run = workflow();
      const outcome = runner()
        .run(run.agent, 'fresh', {
          session: boundary(store),
          signal: controller.signal,
          sessionInputCallback: completedSessionInputCallback(),
        })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      await started.promise;
      controller.abort(new Error('cancel during write'));
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const early = settled;
      pending.release();
      const actual = await outcome;
      expect(early).toBe(false);
      expect(actual).toEqual({ error: failure });
      expect(run.effects()).toBe(1);
      expect(run.model.calls).toHaveLength(2);
      expect(writes).toHaveBeenCalledTimes(1);
      expect(await store.getItems()).toHaveLength(committed ? 4 : 0);
    },
  );

  it('preserves legacy arity, explicit context opt-in and snapshot isolation', async () => {
    const store = new MemorySession({
      initialItems: [{ role: 'user', content: 'old' }],
    });
    const getItems = vi.spyOn(store, 'getItems');
    const addItems = vi.spyOn(store, 'addItems');
    const context = new RunContext({ id: 'caller' });
    const old = await readCompletedSessionHistory(store, context);
    expect(getItems.mock.calls[0]).toEqual([]);
    await appendCompletedSessionItems(
      store,
      [assistantMessage('legacy')],
      context,
    );
    expect(addItems.mock.calls[0]).toHaveLength(1);
    const aware = Object.assign(store, { acceptsRunContext: true as const });
    await readCompletedSessionHistory(aware, context);
    expect(getItems.mock.calls[1]).toEqual([undefined, context]);
    const items: AgentInputItem[] = [assistantMessage('aware')];
    await appendCompletedSessionItems(aware, items, context);
    expect(addItems.mock.calls[1]).toEqual([expect.any(Array), context]);
    expect(addItems.mock.calls[1][0]).not.toBe(items);
    expect(old).toEqual([{ role: 'user', content: 'old' }]);
    const item = { role: 'user' as const, content: 'borrowed' };
    getItems.mockResolvedValue([item]);
    const detached = await readCompletedSessionHistory(aware, context);
    item.content = 'changed';
    expect(detached).toEqual([{ role: 'user', content: 'borrowed' }]);
  });

  it('rejects an unpaired output delta without touching storage', async () => {
    const store = new MemorySession();
    const writes = vi.spyOn(store, 'addItems');
    await expect(
      appendCompletedSessionItems(store, [
        functionCall('effect', {}, { callId: 'unsettled' }),
      ]),
    ).rejects.toThrow('MIG.8');
    expect(writes).not.toHaveBeenCalled();
  });
  it('loads detached history through frozen context-aware stores and bound private replay hooks', async () => {
    const retained: AgentInputItem[] = [
      { type: 'message', role: 'user', content: 'retained original' },
    ];
    const context = new RunContext({ owner: 'caller' });
    class BorrowedStore extends MemorySession {
      readonly acceptsRunContext = true as const;
      #owner = 'original store';
      override getItems = vi.fn(
        async (limit?: number, current?: RunContext) => {
          expect(this.#owner).toBe('original store');
          expect(limit).toBeUndefined();
          expect(current).toBe(context);
          return retained;
        },
      );
      prepareHistoryItemForModelInput(item: AgentInputItem) {
        expect(this.#owner).toBe('original store');
        return item.type === 'message' && item.role === 'user'
          ? { ...item, content: `${item.content} (prepared)` }
          : item;
      }
    }
    const store = Object.freeze(new BorrowedStore());
    const prepared = await loadCompletedSessionInput(
      store,
      'fresh',
      (history, fresh) => {
        const old = history[0];
        if (old.type === 'message') old.content = 'changed for replay';
        return [...history, ...fresh];
      },
      context,
    );
    expect(store.getItems.mock.calls).toEqual([[undefined, context]]);
    expect(retained[0]).toMatchObject({ content: 'retained original' });
    expect(prepared.modelInput[0]).toMatchObject({
      content: 'changed for replay (prepared)',
    });
    expect(prepared.sessionItems).toEqual([
      { type: 'message', role: 'user', content: 'fresh' },
    ]);
  });
});
