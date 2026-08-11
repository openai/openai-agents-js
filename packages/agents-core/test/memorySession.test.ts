import { describe, expect, test, vi } from 'vitest';

import { MemorySession } from '../src/memory/memorySession';
import type { Logger } from '../src/logger';
import type { SessionHistoryTransactionArgs } from '../src/memory/session';
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
    const expected = {
      type: 'function_call',
      id: 'call-old-2',
      callId: 'call-1',
      name: 'lookup',
      status: 'completed',
      arguments: '{"duplicate":true}',
    } satisfies AgentInputItem;
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
          expected,
          replacement,
        },
      ],
    });

    expect(await session.getItems()).toEqual([
      createUserMessage('start'),
      {
        type: 'function_call',
        id: 'call-old-1',
        callId: 'call-1',
        name: 'lookup',
        status: 'completed',
        arguments: '{"ok":false}',
      },
      replacement,
    ]);
  });

  test('leaves history unchanged when an expected mutation batch does not match', async () => {
    const firstCall = {
      type: 'function_call',
      callId: 'call-1',
      name: 'lookup',
      status: 'completed',
      arguments: '{"value":1}',
    } satisfies AgentInputItem;
    const secondCall = {
      type: 'function_call',
      callId: 'call-2',
      name: 'lookup',
      status: 'completed',
      arguments: '{"value":2}',
    } satisfies AgentInputItem;
    const initialItems = [createUserMessage('start'), firstCall, secondCall];
    const session = new MemorySession({
      sessionId: 'session-atomic-mismatch',
      initialItems,
    });

    await expect(
      session.applyHistoryMutations({
        mutations: [
          {
            type: 'replace_function_call',
            callId: firstCall.callId,
            expected: firstCall,
            replacement: {
              ...firstCall,
              arguments: '{"value":10}',
            },
          },
          {
            type: 'replace_function_call',
            callId: secondCall.callId,
            expected: {
              ...secondCall,
              arguments: '{"value":999}',
            },
            replacement: {
              ...secondCall,
              arguments: '{"value":20}',
            },
          },
        ],
      }),
    ).rejects.toThrow('Session history items could not be compared safely');

    expect(await session.getItems()).toEqual(initialItems);
  });

  test('validates an expected mutation batch against one history version', async () => {
    const originalCall = {
      type: 'function_call',
      callId: 'call-dependent',
      name: 'lookup',
      status: 'completed',
      arguments: '{"value":1}',
    } satisfies AgentInputItem;
    const intermediateCall = {
      ...originalCall,
      arguments: '{"value":2}',
    };
    const finalCall = {
      ...originalCall,
      arguments: '{"value":3}',
    };
    const session = new MemorySession({
      sessionId: 'session-dependent-mutations',
      initialItems: [originalCall],
    });

    await expect(
      session.applyHistoryMutations({
        mutations: [
          {
            type: 'replace_function_call',
            callId: originalCall.callId,
            expected: originalCall,
            replacement: intermediateCall,
          },
          {
            type: 'replace_function_call',
            callId: originalCall.callId,
            expected: intermediateCall,
            replacement: finalCall,
          },
        ],
      }),
    ).rejects.toThrow('Session history mutation could not find');

    expect(await session.getItems()).toEqual([originalCall]);
  });

  test('applies append transactions idempotently', async () => {
    const session = new MemorySession({
      sessionId: 'session-transaction-append',
      initialItems: [createUserMessage('start')],
    });
    const appended = createUserMessage('committed');
    const args = {
      operationId: 'operation-append-1',
      transaction: {
        type: 'append_items' as const,
        items: [appended],
      },
    };

    await session.applyHistoryTransaction(args);
    (appended as any).content = 'mutated';
    await session.addItems([createUserMessage('later')]);
    await session.applyHistoryTransaction({
      operationId: args.operationId,
      transaction: {
        type: 'append_items',
        items: [createUserMessage('committed')],
      },
    });

    expect(await session.getItems()).toEqual([
      createUserMessage('start'),
      createUserMessage('committed'),
      createUserMessage('later'),
    ]);
  });

  test('replaces an exact history suffix idempotently', async () => {
    const prefix = createUserMessage('start');
    const expected = createUserMessage('blocked');
    const replacement = createUserMessage('accepted');
    const session = new MemorySession({
      sessionId: 'session-transaction-replace',
      initialItems: [prefix, expected],
    });
    const transaction = {
      operationId: 'operation-replace-1',
      transaction: {
        type: 'replace_suffix' as const,
        expectedSuffix: [expected],
        replacement: [replacement],
      },
    };

    await session.applyHistoryTransaction(transaction);
    await session.addItems([createUserMessage('later')]);
    await session.applyHistoryTransaction(transaction);

    expect(await session.getItems()).toEqual([
      prefix,
      replacement,
      createUserMessage('later'),
    ]);
  });

  test('rejects a suffix mismatch without recording the operation', async () => {
    const start = createUserMessage('start');
    const session = new MemorySession({
      sessionId: 'session-transaction-precondition',
      initialItems: [start],
    });

    await expect(
      session.applyHistoryTransaction({
        operationId: 'operation-replace-after-conflict',
        transaction: {
          type: 'replace_suffix',
          expectedSuffix: [createUserMessage('different')],
          replacement: [createUserMessage('accepted')],
        },
      }),
    ).rejects.toThrow('suffix no longer matches');
    expect(await session.getItems()).toEqual([start]);

    await session.applyHistoryTransaction({
      operationId: 'operation-replace-after-conflict',
      transaction: {
        type: 'replace_suffix',
        expectedSuffix: [start],
        replacement: [createUserMessage('accepted')],
      },
    });
    expect(await session.getItems()).toEqual([createUserMessage('accepted')]);
  });

  test('rejects operation ID reuse with different content', async () => {
    const session = new MemorySession({
      sessionId: 'session-transaction-operation-conflict',
    });
    await session.applyHistoryTransaction({
      operationId: 'operation-conflict',
      transaction: {
        type: 'append_items',
        items: [createUserMessage('first')],
      },
    });

    await expect(
      session.applyHistoryTransaction({
        operationId: 'operation-conflict',
        transaction: {
          type: 'append_items',
          items: [createUserMessage('second')],
        },
      }),
    ).rejects.toThrow('already applied with a different transaction');
    expect(await session.getItems()).toEqual([createUserMessage('first')]);
  });

  test('records an empty append transaction', async () => {
    const session = new MemorySession({
      sessionId: 'session-transaction-empty-append',
    });
    await session.applyHistoryTransaction({
      operationId: 'operation-empty',
      transaction: { type: 'append_items', items: [] },
    });

    await expect(
      session.applyHistoryTransaction({
        operationId: 'operation-empty',
        transaction: {
          type: 'append_items',
          items: [createUserMessage('unexpected')],
        },
      }),
    ).rejects.toThrow('already applied with a different transaction');
    expect(await session.getItems()).toEqual([]);
  });

  test('resets transaction identities when the session is cleared', async () => {
    const session = new MemorySession({
      sessionId: 'session-transaction-reset',
    });
    const transaction = {
      operationId: 'operation-after-reset',
      transaction: {
        type: 'append_items' as const,
        items: [createUserMessage('committed')],
      },
    };

    await session.applyHistoryTransaction(transaction);
    await session.clearSession();
    await session.applyHistoryTransaction(transaction);

    expect(await session.getItems()).toEqual([createUserMessage('committed')]);
  });

  test('rejects invalid transaction input before mutation', async () => {
    const start = createUserMessage('start');
    const session = new MemorySession({
      sessionId: 'session-transaction-invalid',
      initialItems: [start],
    });

    await expect(
      session.applyHistoryTransaction({
        operationId: '   ',
        transaction: { type: 'append_items', items: [] },
      }),
    ).rejects.toThrow('operationId must be a non-empty string');
    await expect(
      session.applyHistoryTransaction({
        operationId: 'operation-unknown',
        transaction: { type: 'unknown' } as any,
      }),
    ).rejects.toThrow('Unsupported session history transaction type');
    await expect(
      session.applyHistoryTransaction({
        operationId: 'operation-missing-transaction',
        transaction: null as any,
      }),
    ).rejects.toThrow('transaction must be an object');
    await expect(
      session.applyHistoryTransaction({
        operationId: 'operation-invalid-item',
        transaction: { type: 'append_items', items: [42] } as any,
      }),
    ).rejects.toThrow('items contain invalid or unsupported data');
    expect(await session.getItems()).toEqual([start]);
  });

  test('rejects unsupported transaction metadata before mutation', async () => {
    const start = createUserMessage('start');
    const session = new MemorySession({
      sessionId: 'session-transaction-unsupported',
      initialItems: [start],
    });
    const withDate = createUserMessage('unsupported');
    withDate.providerData = { timestamp: new Date(0) };
    const withCycle = createUserMessage('cyclic');
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    withCycle.providerData = cycle;
    const withBigInt = createUserMessage('bigint');
    withBigInt.providerData = { value: 42n };
    const sparseItems = new Array<AgentInputItem>(1);

    const unsupportedCases: Array<[string, AgentInputItem[]]> = [
      ['operation-date', [withDate]],
      ['operation-cycle', [withCycle]],
      ['operation-bigint', [withBigInt]],
      ['operation-sparse', sparseItems],
    ];
    for (const [operationId, items] of unsupportedCases) {
      await expect(
        session.applyHistoryTransaction({
          operationId,
          transaction: { type: 'append_items', items },
        }),
      ).rejects.toThrow('items contain invalid or unsupported data');
    }

    expect(await session.getItems()).toEqual([start]);
  });

  test('rejects non-enumerable metadata before mutation', async () => {
    const start = createUserMessage('start');
    const session = new MemorySession({
      sessionId: 'session-transaction-non-enumerable',
      initialItems: [start],
    });
    const item = createUserMessage('unsupported');
    Object.defineProperty(item, 'providerData', {
      enumerable: false,
      value: { hidden: true },
    });

    await expect(
      session.applyHistoryTransaction({
        operationId: 'operation-non-enumerable',
        transaction: { type: 'append_items', items: [item] },
      }),
    ).rejects.toThrow('items contain invalid or unsupported data');
    expect(await session.getItems()).toEqual([start]);

    const retryItem = createUserMessage('retry');
    await session.applyHistoryTransaction({
      operationId: 'operation-non-enumerable',
      transaction: { type: 'append_items', items: [retryItem] },
    });
    expect(await session.getItems()).toEqual([start, retryItem]);
  });

  test('rejects unexpected transaction fields before mutation', async () => {
    const start = createUserMessage('start');
    const session = new MemorySession({
      sessionId: 'session-transaction-unexpected-fields',
      initialItems: [start],
    });

    await expect(
      session.applyHistoryTransaction({
        operationId: 'operation-unexpected-append-field',
        transaction: {
          type: 'append_items',
          items: [createUserMessage('unsupported')],
          metadata: { attempt: 1 },
        } as any,
      }),
    ).rejects.toThrow('append transaction fields are invalid');
    await expect(
      session.applyHistoryTransaction({
        operationId: 'operation-unexpected-suffix-field',
        transaction: {
          type: 'replace_suffix',
          expectedSuffix: [start],
          replacement: [createUserMessage('unsupported')],
          metadata: { attempt: 1 },
        } as any,
      }),
    ).rejects.toThrow('suffix transaction fields are invalid');
    expect(await session.getItems()).toEqual([start]);

    const retryItem = createUserMessage('retry');
    await session.applyHistoryTransaction({
      operationId: 'operation-unexpected-append-field',
      transaction: { type: 'append_items', items: [retryItem] },
    });
    expect(await session.getItems()).toEqual([start, retryItem]);
  });

  test('does not expose transaction content in snapshot errors', async () => {
    const session = new MemorySession({
      sessionId: 'session-transaction-error-redaction',
    });
    const item = createUserMessage('unsupported');
    item.providerData = { secret: Symbol('api-key-secret') };

    let error: unknown;
    try {
      await session.applyHistoryTransaction({
        operationId: 'operation-sensitive-invalid',
        transaction: { type: 'append_items', items: [item] },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Session history transaction items contain invalid or unsupported data.',
    );
    expect((error as Error).message).not.toContain('api-key-secret');
    expect(await session.getItems()).toEqual([]);
  });

  test('copies shared-backed binary transaction data', async () => {
    const session = new MemorySession({
      sessionId: 'session-transaction-shared-binary',
    });
    const sharedBytes = new Uint8Array(new SharedArrayBuffer(2));
    sharedBytes.set([3, 7]);
    const item = createUserMessage('binary');
    item.providerData = { bytes: sharedBytes };

    await session.applyHistoryTransaction({
      operationId: 'operation-shared-binary',
      transaction: { type: 'append_items', items: [item] },
    });
    sharedBytes[0] = 9;

    const retryItem = createUserMessage('binary');
    retryItem.providerData = { bytes: new Uint8Array([3, 7]) };
    await session.applyHistoryTransaction({
      operationId: 'operation-shared-binary',
      transaction: { type: 'append_items', items: [retryItem] },
    });

    const [stored] = await session.getItems();
    expect((stored.providerData?.bytes as Uint8Array)[0]).toBe(3);
  });

  test('canonicalizes ordinary object prototypes for retries and suffixes', async () => {
    const session = new MemorySession({
      sessionId: 'session-transaction-canonical-object',
    });
    const appended = createUserMessage('canonical');
    appended.providerData = Object.assign(Object.create(null), {
      source: 'provider',
    });

    await session.applyHistoryTransaction({
      operationId: 'operation-canonical-append',
      transaction: { type: 'append_items', items: [appended] },
    });
    const [roundTripped] = await session.getItems();
    await session.applyHistoryTransaction({
      operationId: 'operation-canonical-append',
      transaction: { type: 'append_items', items: [roundTripped] },
    });
    await session.applyHistoryTransaction({
      operationId: 'operation-canonical-replace',
      transaction: {
        type: 'replace_suffix',
        expectedSuffix: [appended],
        replacement: [createUserMessage('replaced')],
      },
    });

    expect(await session.getItems()).toEqual([createUserMessage('replaced')]);
  });

  test('rejects unsupported cloned values without recording the operation', async () => {
    const typedArrayItem = createUserMessage('unsupported-typed-array');
    typedArrayItem.providerData = { values: new Uint16Array([300]) };
    const proxiedItems = new Proxy([createUserMessage('proxied')], {});
    const session = new MemorySession({
      sessionId: 'session-transaction-unsupported-clones',
    });

    for (const items of [[typedArrayItem], proxiedItems]) {
      await expect(
        session.applyHistoryTransaction({
          operationId: 'operation-rejected-clone',
          transaction: { type: 'append_items', items },
        }),
      ).rejects.toThrow('items contain invalid or unsupported data');
    }

    await session.applyHistoryTransaction({
      operationId: 'operation-rejected-clone',
      transaction: {
        type: 'append_items',
        items: [createUserMessage('accepted-after-rejections')],
      },
    });
    expect(await session.getItems()).toEqual([
      createUserMessage('accepted-after-rejections'),
    ]);
  });

  test('reads the transaction envelope once and redacts accessor errors', async () => {
    const session = new MemorySession({
      sessionId: 'session-transaction-envelope',
    });
    let operationIdReads = 0;
    const args = {
      transaction: {
        type: 'append_items' as const,
        items: [createUserMessage('once')],
      },
    } as SessionHistoryTransactionArgs;
    Object.defineProperty(args, 'operationId', {
      enumerable: true,
      get: () => {
        operationIdReads++;
        return operationIdReads === 1 ? 'operation-read-once' : 'changed';
      },
    });

    await session.applyHistoryTransaction(args);
    expect(operationIdReads).toBe(1);
    operationIdReads = 0;
    await session.applyHistoryTransaction(args);
    expect(operationIdReads).toBe(1);
    expect(await session.getItems()).toEqual([createUserMessage('once')]);

    const throwingArgs = {} as SessionHistoryTransactionArgs;
    Object.defineProperty(throwingArgs, 'operationId', {
      get: () => {
        throw new Error('api-key-secret');
      },
    });
    await expect(session.applyHistoryTransaction(throwingArgs)).rejects.toThrow(
      'Session history transaction arguments are invalid.',
    );
    try {
      await session.applyHistoryTransaction(throwingArgs);
    } catch (error) {
      expect((error as Error).message).not.toContain('api-key-secret');
    }
  });
});
