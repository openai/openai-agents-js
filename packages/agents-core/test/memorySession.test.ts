import { describe, expect, test } from 'vitest';

import { MemorySession } from '../src/memory/memorySession';
import type { AgentInputItem } from '../src/types';

const createUserMessage = (text: string): AgentInputItem => ({
  role: 'user',
  content: [
    {
      type: 'input_text',
      text,
    },
  ],
});

describe('MemorySession', () => {
  test('stores and retrieves items in memory', async () => {
    const initialItems = [createUserMessage('hello')];
    const session = new MemorySession({
      sessionId: 'session-1',
      initialItems,
    });

    expect(await session.getSessionId()).toBe('session-1');
    expect(await session.getItems()).toEqual(initialItems);

    const newItems = [createUserMessage('one'), createUserMessage('two')];
    await session.addItems(newItems);
    expect(await session.getItems()).toEqual([...initialItems, ...newItems]);

    expect(await session.getItems(2)).toEqual(newItems);

    expect(await session.popItem()).toEqual(newItems[1]);
    expect(await session.getItems()).toEqual([...initialItems, newItems[0]]);

    await session.clearSession();
    expect(await session.getItems()).toEqual([]);
    expect(await session.getItems(3)).toEqual([]);
    expect(await session.popItem()).toBeUndefined();
  });

  test('returns clones so external mutations do not persist', async () => {
    const initial = createUserMessage('start');
    const session = new MemorySession({
      sessionId: 'session-2',
      initialItems: [initial],
    });

    const items = await session.getItems();
    expect(items[0]).not.toBe(initial);
    (items[0] as any).content = 'mutated';
    expect(await session.getItems()).toEqual([createUserMessage('start')]);

    const next = createUserMessage('next');
    await session.addItems([next]);
    (next as any).content = 'mutated';
    expect(await session.getItems()).toEqual([
      createUserMessage('start'),
      createUserMessage('next'),
    ]);

    const popped = await session.popItem();
    expect(popped).toEqual(createUserMessage('next'));
    if (popped) {
      (popped as any).content = 'mutated';
    }
    expect(await session.getItems()).toEqual([createUserMessage('start')]);
  });

  test('applies history mutations atomically', async () => {
    const session = new MemorySession({
      sessionId: 'session-3',
      initialItems: [
        createUserMessage('start'),
        {
          type: 'function_call',
          id: 'call-old-1',
          callId: 'call-1',
          name: 'lookup',
          status: 'completed',
          arguments: '{"ok":false}',
        },
        {
          type: 'function_call',
          id: 'call-old-2',
          callId: 'call-1',
          name: 'lookup',
          status: 'completed',
          arguments: '{"duplicate":true}',
        },
      ],
    });
    const replacement = {
      type: 'function_call',
      id: 'call-new',
      callId: 'call-1',
      name: 'lookup',
      status: 'completed',
      arguments: '{"ok":true}',
    } satisfies AgentInputItem;

    await session.applyHistoryMutations({
      mutations: [
        {
          type: 'replace_function_call',
          callId: 'call-1',
          replacement,
        },
      ],
    });

    expect(await session.getItems()).toEqual([
      createUserMessage('start'),
      replacement,
    ]);
  });
});
