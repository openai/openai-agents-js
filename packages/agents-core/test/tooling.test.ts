import { describe, expect, it } from 'vitest';

import {
  getToolCallDisplayName,
  getToolSearchExecution,
  getToolSearchMatchKey,
  getToolSearchOutputReplacementKey,
  getToolSearchProviderCallId,
  isClientToolSearchCall,
  resolveToolSearchCallId,
  shouldQueuePendingToolSearchCall,
  takePendingToolSearchCallId,
  toolDisplayName,
  toolQualifiedName,
} from '../src/tooling';

describe('tooling', () => {
  it('formats qualified and display names defensively', () => {
    expect(toolQualifiedName(undefined, 'search')).toBeUndefined();
    expect(toolQualifiedName('lookup', 'search')).toBe('search.lookup');
    expect(toolDisplayName('lookup', undefined)).toBe('lookup');
    expect(toolDisplayName('lookup', 'lookup')).toBe('lookup');
    expect(
      getToolCallDisplayName({ name: 'lookup', namespace: 'search' }),
    ).toBe('search.lookup');
  });

  it('prefers provider call ids over top-level ids', () => {
    const value = {
      id: 'item-1',
      call_id: 'top-level',
      providerData: {
        call_id: 'provider-call-id',
      },
    };

    expect(getToolSearchProviderCallId(value)).toBe('provider-call-id');
    expect(getToolSearchMatchKey(value)).toBe('provider-call-id');
    expect(getToolSearchOutputReplacementKey(value)).toBe(
      'call:provider-call-id',
    );
  });

  it('supports camelCase provider ids and falls back to the item id', () => {
    expect(
      getToolSearchProviderCallId({
        providerData: {
          callId: 'provider-call-id',
        },
      }),
    ).toBe('provider-call-id');
    expect(getToolSearchMatchKey({ id: 'item-2' })).toBe('item-2');
    expect(getToolSearchOutputReplacementKey({ id: 'item-2' })).toBe(
      'item:item-2',
    );
  });

  it('derives execution mode from top-level or provider data', () => {
    expect(getToolSearchExecution({ execution: 'client' })).toBe('client');
    expect(
      getToolSearchExecution({
        providerData: { execution: 'server' },
      }),
    ).toBe('server');
    expect(isClientToolSearchCall({ execution: 'client' })).toBe(true);
    expect(shouldQueuePendingToolSearchCall({ execution: 'server' })).toBe(
      false,
    );
    expect(shouldQueuePendingToolSearchCall({})).toBe(true);
  });

  it('resolves tool search call ids from explicit values or fallback generators', () => {
    expect(
      resolveToolSearchCallId(
        {
          callId: 'call-123',
        },
        () => 'generated-id',
      ),
    ).toBe('call-123');
    expect(resolveToolSearchCallId({}, () => 'generated-id')).toBe(
      'generated-id',
    );
    expect(() => resolveToolSearchCallId({})).toThrow(
      'Tool search item is missing both call_id and id.',
    );
  });

  it('consumes pending ids for client-side items and removes matched explicit ids', () => {
    const pendingCallIds = ['pending-1', 'pending-2'];

    expect(
      takePendingToolSearchCallId(
        {
          providerData: { call_id: 'pending-2' },
        },
        pendingCallIds,
      ),
    ).toBe('pending-2');
    expect(pendingCallIds).toEqual(['pending-1']);

    expect(
      takePendingToolSearchCallId(
        {
          execution: 'client',
        },
        pendingCallIds,
        () => 'generated-client-id',
      ),
    ).toBe('pending-1');
    expect(pendingCallIds).toEqual([]);
  });

  it('uses explicit or generated ids for server-side items without consuming the queue', () => {
    const pendingCallIds = ['pending-1'];

    expect(
      takePendingToolSearchCallId(
        {
          execution: 'server',
          id: 'server-item-id',
        },
        pendingCallIds,
        () => 'generated-server-id',
      ),
    ).toBe('server-item-id');
    expect(pendingCallIds).toEqual(['pending-1']);

    expect(
      takePendingToolSearchCallId(
        {
          execution: 'client',
        },
        pendingCallIds,
        () => 'generated-client-id',
      ),
    ).toBe('pending-1');
    expect(
      takePendingToolSearchCallId(
        {
          execution: 'client',
        },
        [],
        () => 'generated-client-id',
      ),
    ).toBe('generated-client-id');
  });
});
