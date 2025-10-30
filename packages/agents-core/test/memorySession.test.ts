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
});
