import { describe, expect, test, vi } from 'vitest';

import { MemorySession } from '../src/memory/memorySession';
import type { Logger } from '../src/logger';
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
  test.each([
    [true, false],
    [false, true],
    [true, true],
  ])(
    'redacts item contents when model=%s or tool=%s logging is disabled',
    async (dontLogModelData, dontLogToolData) => {
      const debug = vi.fn();
      const logger: Logger = {
        namespace: 'memory-session-test',
        debug,
        error: vi.fn(),
        warn: vi.fn(),
        dontLogModelData,
        dontLogToolData,
      };
      const secret = 'SECRET_MEMORY_SESSION_VALUE_123';
      const session = new MemorySession({
        sessionId: 'session-redacted',
        logger,
        initialItems: [createUserMessage(secret)],
      });

      expect(await session.getItems()).toEqual([createUserMessage(secret)]);
      await session.addItems([createUserMessage(`${secret}-added`)]);
      expect(await session.popItem()).toEqual(
        createUserMessage(`${secret}-added`),
      );

      expect(JSON.stringify(debug.mock.calls)).not.toContain(secret);
    },
  );

  test('preserves item diagnostics when model and tool logging are enabled', async () => {
    const debug = vi.fn();
    const logger: Logger = {
      namespace: 'memory-session-test',
      debug,
      error: vi.fn(),
      warn: vi.fn(),
      dontLogModelData: false,
      dontLogToolData: false,
    };
    const secret = 'SECRET_MEMORY_SESSION_DIAGNOSTIC_123';
    const session = new MemorySession({
      sessionId: 'session-diagnostic',
      logger,
      initialItems: [createUserMessage(secret)],
    });

    await session.getItems();

    expect(JSON.stringify(debug.mock.calls)).toContain(secret);
  });

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
